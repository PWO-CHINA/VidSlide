"""
影幻智提 (VidSlide) - 批量处理调度模块 (三区域重构版)
=====================================================
三区域模型：未选中(unselected) → 处理队列(queue) → 已完成(completed)
回收站：半处理/已完成视频的暂存区，支持断点续传

作者: PWO-CHINA
版本: v0.6.1
"""

import cv2
import gc
import json
import os
import queue
import re
import shutil
import threading
import time
import uuid
from pathlib import Path

from extractor import extract_slides
from exporter import package_images

try:
    import psutil
    HAS_PSUTIL = True
except ImportError:
    HAS_PSUTIL = False

# ============================================================
#  配置
# ============================================================
VIDEO_EXTENSIONS = frozenset({
    '.mp4', '.avi', '.mkv', '.mov', '.flv', '.wmv', '.webm',
    '.m4v', '.ts', '.mpg', '.mpeg', '.3gp',
})

DISK_WARN_THRESHOLD_MB = 500
MAX_SSE_QUEUE_SIZE = 200

_UNSAFE_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')

_INCREMENT_PATTERNS = [
    (re.compile(r'(第)(\d+)([节章课讲部分])'), 'chinese_ordinal'),
    (re.compile(r'([（(])(\d+)([)）])'), 'parenthesized'),
    (re.compile(r'([_\-])(\d+)\s*$'), 'separator_num'),
    (re.compile(r'(\d+)\s*$'), 'trailing'),
]

# ============================================================
#  全局状态
# ============================================================
_batches_lock = threading.Lock()
_batches = {}  # bid -> BatchQueue dict


# ============================================================
#  数据结构
# ============================================================
def _new_video_task(video_path, display_name, output_dir):
    """创建一个视频任务字典（三区域模型）"""
    vid = uuid.uuid4().hex[:8]
    return {
        'id': vid,
        'video_path': video_path,
        'display_name': display_name,
        # 三区域模型
        'zone': 'unselected',     # unselected | queue | completed
        'status': 'idle',         # idle | waiting | running | done | error
        # 处理进度
        'progress': 0,
        'message': '',
        'saved_count': 0,
        'eta_seconds': -1,
        'elapsed_seconds': 0,
        'error_message': '',
        'retry_count': 0,
        'cancel_flag': False,
        '_pending_trash': False,   # 标记：running 视频等待移入回收站
        # 视频元数据
        'total_frames': 0,
        'fps': 0,
        'resolution': (0, 0),     # (width, height)
        'codec': '',              # 编码格式（av1/h264/hevc 等）
        'last_frame_index': 0,
        'resume_from_breakpoint': False,  # 断点续传标记
        # 目录
        'output_dir': output_dir,
        'cache_dir': os.path.join(output_dir, 'cache'),
        'pkg_dir': os.path.join(output_dir, 'packages'),
    }


def _new_batch(base_dir, params, max_workers=1):
    """创建一个批量队列字典（三区域模型）"""
    bid = uuid.uuid4().hex[:8]
    batch_dir = os.path.join(base_dir, f'batch_{bid}')
    os.makedirs(batch_dir, exist_ok=True)
    return {
        'id': bid,
        'status': 'idle',              # idle | processing
        'tasks': [],                    # 所有视频任务（含各 zone）
        'params': dict(params),
        'max_workers': max_workers,
        'created_at': time.time(),
        'batch_dir': batch_dir,
        # 同步原语
        'lock': threading.RLock(),
        'event_queues': [],
        'queue_auto_pause': False,      # 处理完当前视频后暂停
        'worker_semaphore': threading.Semaphore(max_workers),
        'dispatcher_thread': None,
        # 统计
        'completed_count': 0,
        'failed_count': 0,
        'total_images': 0,
        'start_time': 0,
        # 视频回收站
        'trashed_videos': [],
    }


# ============================================================
#  批量队列 CRUD
# ============================================================
def create_batch(sessions_root, params, max_workers=1):
    """创建空批量队列，返回 bid"""
    batch = _new_batch(sessions_root, params, max_workers)
    bid = batch['id']
    with _batches_lock:
        _batches[bid] = batch
    return bid


def get_batch(bid):
    """获取批量队列引用"""
    with _batches_lock:
        return _batches.get(bid)


def get_batch_state(bid):
    """获取批量队列的可序列化状态快照（按 zone 分组）"""
    batch = get_batch(bid)
    if not batch:
        return None
    with batch['lock']:
        zones = {'unselected': [], 'queue': [], 'completed': []}
        for t in batch['tasks']:
            snap = _task_snapshot(t)
            zone = snap['zone']
            if zone in zones:
                zones[zone].append(snap)
            else:
                zones['unselected'].append(snap)
        return {
            'id': batch['id'],
            'status': batch['status'],
            'zones': zones,
            'params': dict(batch['params']),
            'max_workers': batch['max_workers'],
            'created_at': batch['created_at'],
            'completed_count': batch['completed_count'],
            'failed_count': batch['failed_count'],
            'total_images': batch['total_images'],
            'start_time': batch['start_time'],
            'global_progress': _calc_global_progress(batch),
            'trashed_videos_count': len(batch.get('trashed_videos', [])),
        }


def _task_snapshot(t):
    """生成单个任务的可序列化快照"""
    return {
        'id': t['id'],
        'video_path': t['video_path'],
        'display_name': t['display_name'],
        'zone': t['zone'],
        'status': t['status'],
        'progress': t['progress'],
        'message': t['message'],
        'saved_count': t['saved_count'],
        'eta_seconds': t['eta_seconds'],
        'elapsed_seconds': t['elapsed_seconds'],
        'error_message': t['error_message'],
        'retry_count': t['retry_count'],
        'total_frames': t['total_frames'],
        'fps': t.get('fps', 0),
        'resolution': t.get('resolution', (0, 0)),
        'codec': t.get('codec', ''),
        'estimated_time': estimate_processing_time(t),
    }


def _find_task(batch, vid):
    """在 batch 中查找 vid 对应的 task（需在 batch['lock'] 内调用）"""
    for t in batch['tasks']:
        if t['id'] == vid:
            return t
    return None


def _find_task_in_trash(batch, vid):
    """在回收站中查找 vid 对应的快照"""
    for i, s in enumerate(batch['trashed_videos']):
        if s['id'] == vid:
            return i, s
    return -1, None


# ============================================================
#  视频元数据采集
# ============================================================
def get_video_metadata(video_path):
    """用 cv2/PyAV 提取视频的 fps/resolution/total_frames/codec"""
    codec_name = ''
    # 优先用 PyAV 检测编码（更准确）
    try:
        import av as _av
        _c = _av.open(video_path)
        _s = _c.streams.video[0]
        codec_name = _s.codec_context.name or ''
        _c.close()
    except Exception:
        pass
    try:
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            cap.release()
            return 0, (0, 0), 0, codec_name
        fps = cap.get(cv2.CAP_PROP_FPS) or 25
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        # PyAV 检测失败时用 OpenCV fourcc 作为备选
        if not codec_name:
            fourcc_int = int(cap.get(cv2.CAP_PROP_FOURCC))
            codec_name = ''.join(chr((fourcc_int >> (8 * i)) & 0xFF) for i in range(4)).strip('\x00')
        cap.release()
        return fps, (w, h), total_frames, codec_name
    except Exception:
        return 0, (0, 0), 0, codec_name


def estimate_processing_time(task, speed_mode=None):
    """根据 total_frames/fps/resolution 估算处理时间（秒）"""
    total_frames = task.get('total_frames', 0)
    fps = task.get('fps', 0)
    if total_frames <= 0 or fps <= 0:
        return -1
    duration_sec = total_frames / fps
    w, h = task.get('resolution', (0, 0))
    pixels = w * h if w > 0 and h > 0 else 1920 * 1080
    # 基准：1080p 视频约 0.3 秒处理 1 秒视频（fast 模式）
    base_ratio = 0.3
    resolution_factor = pixels / (1920 * 1080)
    estimated = duration_sec * base_ratio * resolution_factor
    return max(1, int(estimated))


# ============================================================
#  视频添加（进入未选中区域）
# ============================================================
def add_videos(bid, entries):
    """
    添加视频到未选中区域。
    entries: [{'path': str, 'name': str}, ...]
    返回添加的 VideoTask 列表快照。
    """
    batch = get_batch(bid)
    if not batch:
        return []

    added = []
    with batch['lock']:
        for entry in entries:
            vpath = entry['path']
            dname = entry.get('name', '') or Path(vpath).stem or '未命名'
            vid_suffix = uuid.uuid4().hex[:4]
            safe_dir = _sanitize_dirname(dname, vid_suffix)
            output_dir = os.path.join(batch['batch_dir'], safe_dir)
            task = _new_video_task(vpath, dname, output_dir)
            # zone 默认就是 unselected, status 默认就是 idle
            os.makedirs(task['cache_dir'], exist_ok=True)
            os.makedirs(task['pkg_dir'], exist_ok=True)
            batch['tasks'].append(task)
            added.append({
                'id': task['id'],
                'display_name': task['display_name'],
                'video_path': task['video_path'],
                'zone': task['zone'],
                'status': task['status'],
            })

    # 在锁外采集视频元数据和生成缩略图（IO 操作）
    for entry, info in zip(entries, added):
        task = None
        with batch['lock']:
            task = _find_task(batch, info['id'])
        if task:
            fps, resolution, total_frames, codec = get_video_metadata(entry['path'])
            with batch['lock']:
                task['fps'] = fps
                task['resolution'] = resolution
                task['total_frames'] = total_frames
                task['codec'] = codec
            info['codec'] = codec
            thumb_path = os.path.join(task['output_dir'], 'thumbnail.jpg')
            _generate_thumbnail(entry['path'], thumb_path)

    _save_batch_meta(bid)
    return added


def remove_video(bid, vid):
    """从未选中区域移除视频（直接删除，不进回收站）"""
    batch = get_batch(bid)
    if not batch:
        return False, '批量队列不存在'
    with batch['lock']:
        task = _find_task(batch, vid)
        if not task:
            return False, '视频不存在'
        if task['zone'] != 'unselected':
            return False, f'只能从未选中区域移除，当前区域: {task["zone"]}'
        batch['tasks'].remove(task)
    # 清理临时文件（不删除原始视频）
    if os.path.exists(task['output_dir']):
        shutil.rmtree(task['output_dir'], ignore_errors=True)
    _save_batch_meta(bid)
    return True, 'ok'


def update_video_name(bid, vid, new_name):
    """更新视频显示名（仅未选中和已完成区域允许）"""
    batch = get_batch(bid)
    if not batch:
        return False
    with batch['lock']:
        task = _find_task(batch, vid)
        if not task:
            return False
        if task['zone'] == 'queue':
            return False  # 队列中不允许重命名
        task['display_name'] = new_name
    _save_batch_meta(bid)
    return True


# ============================================================
#  区域转换：未选中 ↔ 处理队列
# ============================================================
def move_to_queue(bid, video_ids, position=None):
    """
    将视频从未选中区域移入处理队列。
    video_ids: 有序的视频 ID 列表（按用户选择顺序）
    position: 插入位置（None=末尾）
    返回成功移入的数量。
    """
    batch = get_batch(bid)
    if not batch:
        return 0
    moved = 0
    with batch['lock']:
        is_processing = batch['status'] == 'processing'
        # 计算插入位置
        queue_tasks = [t for t in batch['tasks'] if t['zone'] == 'queue']
        if position is not None:
            # 不能插入到 running 视频前面
            running_end = 0
            for i, qt in enumerate(queue_tasks):
                if qt['status'] == 'running':
                    running_end = i + 1
            insert_pos = max(position, running_end)
        else:
            insert_pos = len(queue_tasks)

        # 收集要移动的任务（保持 video_ids 顺序）
        tasks_to_move = []
        for vid in video_ids:
            task = _find_task(batch, vid)
            if task and task['zone'] == 'unselected' and task['status'] == 'idle':
                tasks_to_move.append(task)

        # 执行移动
        for task in tasks_to_move:
            task['zone'] = 'queue'
            task['status'] = 'waiting'
            moved += 1

        # 重排 tasks 列表以反映队列内的顺序
        _reorder_tasks_list(batch)

        # 如果需要插入到特定位置，调整队列内顺序
        if position is not None and tasks_to_move:
            _insert_queue_tasks_at(batch, tasks_to_move, insert_pos)

    if moved > 0:
        _push_batch_event(bid, {
            'type': 'zone_change',
            'action': 'move_to_queue',
            'video_ids': [t['id'] for t in tasks_to_move],
            'count': moved,
        })
        _save_batch_meta(bid)
    return moved


def move_to_unselected(bid, video_ids):
    """
    将视频从处理队列移回未选中区域（仅 waiting 状态可移回）。
    完全重置为 idle 状态。
    """
    batch = get_batch(bid)
    if not batch:
        return 0
    moved = 0
    with batch['lock']:
        for vid in video_ids:
            task = _find_task(batch, vid)
            if task and task['zone'] == 'queue' and task['status'] == 'waiting':
                task['zone'] = 'unselected'
                task['status'] = 'idle'
                task['progress'] = 0
                task['message'] = ''
                task['error_message'] = ''
                task['eta_seconds'] = -1
                task['elapsed_seconds'] = 0
                moved += 1
    if moved > 0:
        _push_batch_event(bid, {
            'type': 'zone_change',
            'action': 'move_to_unselected',
            'video_ids': video_ids,
            'count': moved,
        })
        _save_batch_meta(bid)
    return moved


def _reorder_tasks_list(batch):
    """内部：按 zone 顺序重排 tasks 列表（unselected → queue → completed）"""
    zone_order = {'unselected': 0, 'queue': 1, 'completed': 2}
    # 队列内：running 在前，waiting 在后
    def sort_key(t):
        z = zone_order.get(t['zone'], 0)
        if t['zone'] == 'queue':
            sub = 0 if t['status'] == 'running' else 1
            return (z, sub)
        return (z, 0)
    batch['tasks'].sort(key=sort_key)


def _insert_queue_tasks_at(batch, tasks_to_insert, position):
    """内部：将指定任务插入到队列的特定位置"""
    # 先从 tasks 列表中移除这些任务
    ids_to_insert = {t['id'] for t in tasks_to_insert}
    queue_tasks = [t for t in batch['tasks'] if t['zone'] == 'queue' and t['id'] not in ids_to_insert]
    # 在指定位置插入
    for i, task in enumerate(tasks_to_insert):
        queue_tasks.insert(position + i, task)
    # 重建 tasks 列表
    non_queue = [t for t in batch['tasks'] if t['zone'] != 'queue']
    unselected = [t for t in non_queue if t['zone'] == 'unselected']
    completed = [t for t in non_queue if t['zone'] == 'completed']
    batch['tasks'] = unselected + queue_tasks + completed


# ============================================================
#  队列排序
# ============================================================
def reorder_zone(bid, zone, ordered_vids):
    """按 vid 列表重排指定区域的顺序"""
    batch = get_batch(bid)
    if not batch:
        return False
    with batch['lock']:
        zone_tasks = [t for t in batch['tasks'] if t['zone'] == zone]
        other_tasks = [t for t in batch['tasks'] if t['zone'] != zone]

        if zone == 'queue':
            # running 视频必须在最前面，不参与排序
            running = [t for t in zone_tasks if t['status'] == 'running']
            non_running = [t for t in zone_tasks if t['status'] != 'running']
            task_map = {t['id']: t for t in non_running}
            new_order = []
            for vid in ordered_vids:
                if vid in task_map:
                    new_order.append(task_map.pop(vid))
            # 未在列表中的追加到末尾
            for t in non_running:
                if t['id'] in task_map:
                    new_order.append(t)
            zone_tasks = running + new_order
        else:
            task_map = {t['id']: t for t in zone_tasks}
            new_order = []
            for vid in ordered_vids:
                if vid in task_map:
                    new_order.append(task_map.pop(vid))
            for t in zone_tasks:
                if t['id'] in task_map:
                    new_order.append(t)
            zone_tasks = new_order

        # 重建 tasks 列表
        unselected = [t for t in other_tasks if t['zone'] == 'unselected']
        queue = zone_tasks if zone == 'queue' else [t for t in other_tasks if t['zone'] == 'queue']
        completed = zone_tasks if zone == 'completed' else [t for t in other_tasks if t['zone'] == 'completed']
        if zone == 'unselected':
            batch['tasks'] = zone_tasks + queue + completed
        elif zone == 'queue':
            batch['tasks'] = unselected + zone_tasks + completed
        else:
            batch['tasks'] = unselected + queue + zone_tasks

    _save_batch_meta(bid)
    return True


def prioritize_video(bid, vid):
    """将视频移到队列最前面（仅 waiting 状态）"""
    batch = get_batch(bid)
    if not batch:
        return False
    with batch['lock']:
        task = _find_task(batch, vid)
        if not task or task['zone'] != 'queue' or task['status'] != 'waiting':
            return False
        queue_tasks = [t for t in batch['tasks'] if t['zone'] == 'queue']
        queue_tasks.remove(task)
        # 插入到第一个 waiting 任务之前（running 任务保持在前面）
        insert_idx = 0
        for i, t in enumerate(queue_tasks):
            if t['status'] == 'running':
                insert_idx = i + 1
            else:
                break
        queue_tasks.insert(insert_idx, task)
        # 重建
        non_queue = [t for t in batch['tasks'] if t['zone'] != 'queue']
        unselected = [t for t in non_queue if t['zone'] == 'unselected']
        completed = [t for t in non_queue if t['zone'] == 'completed']
        batch['tasks'] = unselected + queue_tasks + completed
    return True


# ============================================================
#  并发控制
# ============================================================
def set_max_workers(bid, n):
    """动态调整并发数"""
    batch = get_batch(bid)
    if not batch:
        return False
    with batch['lock']:
        old = batch['max_workers']
        batch['max_workers'] = n
        if n > old:
            for _ in range(n - old):
                batch['worker_semaphore'].release()
    return True


def compute_max_batch_workers():
    """根据硬件计算批量处理最大并发数"""
    try:
        if HAS_PSUTIL:
            cpu_count = psutil.cpu_count(logical=True) or 4
            mem_gb = psutil.virtual_memory().total / (1024 ** 3)
            cpu_budget = max(1, cpu_count // 4 + 1)
            mem_budget = max(1, int(mem_gb // 4))
            return max(1, min(3, cpu_budget, mem_budget))
    except Exception:
        pass
    return 2


# ============================================================
#  调度器 & Worker（三区域模型）
# ============================================================
def update_batch_params(bid, params):
    """更新批量队列的全局参数（开始处理前同步最新 UI 设置）。"""
    batch = get_batch(bid)
    if not batch:
        return
    with batch['lock']:
        batch['params'].update(params)


def start_processing(bid):
    """
    启动处理队列。
    只有用户显式点击"开始处理"才会调用此函数。
    """
    batch = get_batch(bid)
    if not batch:
        return False, '批量队列不存在'
    with batch['lock']:
        if batch['status'] == 'processing':
            return False, '已在处理中'
        has_waiting = any(
            t['zone'] == 'queue' and t['status'] == 'waiting'
            for t in batch['tasks']
        )
        if not has_waiting:
            return False, '队列中没有待处理的视频'
        batch['status'] = 'processing'
        batch['queue_auto_pause'] = False
        batch['start_time'] = time.time()
        batch['worker_semaphore'] = threading.Semaphore(batch['max_workers'])

    _push_batch_event(bid, {
        'type': 'batch_status',
        'status': 'processing',
    })

    t = threading.Thread(target=_dispatcher_loop, args=(bid,), daemon=True)
    with batch['lock']:
        batch['dispatcher_thread'] = t
    t.start()
    _save_batch_meta(bid)
    return True, 'ok'


def pause_after_current(bid):
    """
    处理完当前视频后暂停。
    当前 running 的视频会继续完成，但不会启动新的视频。
    """
    batch = get_batch(bid)
    if not batch:
        return False
    with batch['lock']:
        if batch['status'] != 'processing':
            return False
        batch['queue_auto_pause'] = True
    _push_batch_event(bid, {
        'type': 'batch_status',
        'status': 'pausing',  # 前端显示"正在暂停..."
    })
    _save_batch_meta(bid)
    return True


def retry_video(bid, vid):
    """
    重试失败的视频（error 状态）。
    关键：只设 status='waiting'，绝不自动重启 dispatcher。
    用户需要手动点击"开始处理"。
    """
    batch = get_batch(bid)
    if not batch:
        return False, '批量队列不存在'
    with batch['lock']:
        task = _find_task(batch, vid)
        if not task:
            return False, '视频不存在'
        if task['zone'] != 'queue' or task['status'] != 'error':
            return False, f'只能重试队列中 error 状态的视频'
        task['status'] = 'waiting'
        task['progress'] = 0
        task['message'] = ''
        task['error_message'] = ''
        task['cancel_flag'] = False
        task['_pending_trash'] = False
        task['retry_count'] += 1
        task['eta_seconds'] = -1
        task['elapsed_seconds'] = 0
        task['saved_count'] = 0
        task['last_frame_index'] = 0
        task['resume_from_breakpoint'] = False
        # 清理旧的提取结果
        if os.path.exists(task['cache_dir']):
            shutil.rmtree(task['cache_dir'])
            os.makedirs(task['cache_dir'], exist_ok=True)

    _push_batch_event(bid, {
        'type': 'video_status',
        'video_id': vid,
        'zone': 'queue',
        'status': 'waiting',
        'message': '',
    })
    _save_batch_meta(bid)
    return True, 'ok'


def _dispatcher_loop(bid):
    """调度器主循环：从队列中取 waiting 任务，分配给 worker 线程"""
    batch = get_batch(bid)
    if not batch:
        return

    active_workers = []

    try:
        while True:
            # 检查是否需要暂停
            with batch['lock']:
                if batch['queue_auto_pause']:
                    # 等待所有 running 视频完成后再退出
                    has_running = any(
                        t['zone'] == 'queue' and t['status'] == 'running'
                        for t in batch['tasks']
                    )
                    if not has_running:
                        batch['status'] = 'idle'
                        batch['queue_auto_pause'] = False
                        break
                    # 还有 running 的，等一下再检查
                    time.sleep(0.5)
                    continue

            # 找下一个 waiting 任务
            next_task = None
            with batch['lock']:
                for t in batch['tasks']:
                    if t['zone'] == 'queue' and t['status'] == 'waiting':
                        next_task = t
                        break

            if next_task is None:
                # 没有更多 waiting 任务
                break

            # 磁盘空间检查
            if HAS_PSUTIL:
                try:
                    disk = psutil.disk_usage(batch['batch_dir'])
                    if disk.free < DISK_WARN_THRESHOLD_MB * 1024 * 1024:
                        with batch['lock']:
                            next_task['status'] = 'error'
                            next_task['error_message'] = '磁盘空间不足'
                            next_task['message'] = '磁盘空间不足，已跳过'
                            batch['failed_count'] += 1
                        _push_batch_event(bid, {
                            'type': 'video_status',
                            'video_id': next_task['id'],
                            'zone': 'queue',
                            'status': 'error',
                            'message': '磁盘空间不足',
                        })
                        _push_batch_event(bid, {
                            'type': 'disk_warning',
                            'free_mb': int(disk.free / (1024 * 1024)),
                        })
                        continue
                except Exception:
                    pass

            # 获取信号量
            batch['worker_semaphore'].acquire()

            # 再次检查暂停
            with batch['lock']:
                if batch['queue_auto_pause']:
                    batch['worker_semaphore'].release()
                    continue

            # 启动 worker
            wt = threading.Thread(
                target=_video_worker,
                args=(bid, next_task['id']),
                daemon=True,
            )
            active_workers.append(wt)
            wt.start()

            time.sleep(0.1)

    except Exception as e:
        print(f'[批量调度] 调度器异常: {e}')

    # 等待所有 worker 完成
    for wt in active_workers:
        wt.join(timeout=3600)

    # 更新批量状态
    with batch['lock']:
        has_waiting = any(
            t['zone'] == 'queue' and t['status'] == 'waiting'
            for t in batch['tasks']
        )
        has_running = any(
            t['zone'] == 'queue' and t['status'] == 'running'
            for t in batch['tasks']
        )
        if not has_waiting and not has_running:
            batch['status'] = 'idle'
        elapsed = time.time() - batch['start_time'] if batch['start_time'] else 0

    _push_batch_event(bid, {
        'type': 'queue_idle',
        'completed_count': batch['completed_count'],
        'failed_count': batch['failed_count'],
        'total_images': batch['total_images'],
        'elapsed_seconds': elapsed,
    })
    _save_batch_meta(bid)


def _video_worker(bid, vid):
    """单个视频的提取 worker（支持断点续传）"""
    batch = get_batch(bid)
    if not batch:
        return

    task = None
    with batch['lock']:
        task = _find_task(batch, vid)
        if not task:
            batch['worker_semaphore'].release()
            return
        task['status'] = 'running'
        task['progress'] = 0
        task['message'] = '正在初始化…'
        params = dict(batch['params'])

    _push_batch_event(bid, {
        'type': 'video_status',
        'video_id': vid,
        'zone': 'queue',
        'status': 'running',
        'message': '正在初始化…',
    })

    _last_meta_save = [time.time()]

    try:
        os.makedirs(task['cache_dir'], exist_ok=True)

        # 视频预检
        cap = cv2.VideoCapture(task['video_path'])
        if not cap.isOpened():
            cap.release()
            raise RuntimeError(f'无法打开视频: {task["video_path"]}')
        ok, frame = cap.read()
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        fps = cap.get(cv2.CAP_PROP_FPS) or 25
        cap.release()
        if not ok or frame is None:
            raise RuntimeError('视频解码失败')
        if total_frames < 10 or fps <= 0:
            raise RuntimeError(f'视频信息异常: frames={total_frames}, fps={fps:.1f}')

        with batch['lock']:
            task['total_frames'] = total_frames
            task['fps'] = fps

        # 断点续传参数
        start_frame = 0
        saved_offset = 0
        if task.get('resume_from_breakpoint') and task['last_frame_index'] > 0:
            start_frame = task['last_frame_index']
            saved_offset = task['saved_count']
            with batch['lock']:
                task['resume_from_breakpoint'] = False

        def on_progress(saved_count, progress_pct, message, eta_seconds, elapsed_seconds, current_frame=0):
            with batch['lock']:
                task['saved_count'] = saved_count
                task['progress'] = progress_pct
                task['message'] = message
                task['eta_seconds'] = eta_seconds
                task['elapsed_seconds'] = elapsed_seconds
                task['last_frame_index'] = current_frame
            _push_batch_event(bid, {
                'type': 'video_progress',
                'video_id': vid,
                'saved_count': saved_count,
                'progress': progress_pct,
                'message': message,
                'eta_seconds': eta_seconds,
                'elapsed_seconds': elapsed_seconds,
                'global_progress': _calc_global_progress(batch),
            })
            now = time.time()
            if now - _last_meta_save[0] >= 10:
                _last_meta_save[0] = now
                _save_batch_meta(bid)

        def should_cancel():
            with batch['lock']:
                return task.get('cancel_flag', False) or task.get('_pending_trash', False)

        status, message, saved_count = extract_slides(
            task['video_path'],
            task['cache_dir'],
            threshold=float(params.get('threshold', 5.0)),
            enable_history=bool(params.get('enable_history', True)),
            max_history=int(params.get('max_history', 5)),
            use_roi=bool(params.get('use_roi', True)),
            fast_mode=bool(params.get('fast_mode', True)),
            use_gpu=bool(params.get('use_gpu', True)),
            speed_mode=params.get('speed_mode', 'fast'),
            classroom_mode=params.get('classroom_mode', 'ppt'),
            on_progress=on_progress,
            should_cancel=should_cancel,
            start_frame=start_frame,
            saved_offset=saved_offset,
        )

        with batch['lock']:
            task['saved_count'] = saved_count
            if status == 'done':
                # 正常完成 → 移入已完成区域
                task['zone'] = 'completed'
                task['status'] = 'done'
                task['progress'] = 100
                task['message'] = message
                batch['completed_count'] += 1
                batch['total_images'] += saved_count
            elif status == 'cancelled':
                if task.get('_pending_trash'):
                    # 用户取消 running 视频 → 进入回收站
                    task['status'] = 'error'
                    task['message'] = '已取消（半处理）'
                    task['_pending_trash'] = False
                    # trash_video 会在 finally 之后由调用方处理
                else:
                    # 其他取消情况（不应该发生在新模型中）
                    task['status'] = 'error'
                    task['message'] = message
                    batch['failed_count'] += 1
            else:
                task['status'] = 'error'
                task['message'] = message
                task['error_message'] = message
                batch['failed_count'] += 1

        if task['zone'] == 'completed':
            _push_batch_event(bid, {
                'type': 'zone_change',
                'action': 'video_completed',
                'video_id': vid,
                'from_zone': 'queue',
                'to_zone': 'completed',
                'saved_count': task['saved_count'],
                'message': task['message'],
                'global_progress': _calc_global_progress(batch),
            })
        else:
            _push_batch_event(bid, {
                'type': 'video_error',
                'video_id': vid,
                'zone': 'queue',
                'status': task['status'],
                'saved_count': task['saved_count'],
                'message': task['message'],
                'global_progress': _calc_global_progress(batch),
            })

    except Exception as e:
        err_msg = str(e) or '未知错误'
        print(f'[批量Worker] 视频 {vid} 异常: {err_msg}')
        with batch['lock']:
            task['status'] = 'error'
            task['error_message'] = err_msg
            task['message'] = f'处理失败: {err_msg}'
            batch['failed_count'] += 1
        _push_batch_event(bid, {
            'type': 'video_error',
            'video_id': vid,
            'zone': 'queue',
            'status': 'error',
            'message': err_msg,
            'global_progress': _calc_global_progress(batch),
        })

    finally:
        batch['worker_semaphore'].release()
        gc.collect()
        _save_batch_meta(bid)

        # 如果标记了 _pending_trash，自动移入回收站
        should_trash = False
        with batch['lock']:
            if task and task.get('_pending_trash'):
                should_trash = True
                task['_pending_trash'] = False
        if should_trash:
            trash_video(bid, vid)


# ============================================================
#  SSE 事件推送
# ============================================================
def _push_batch_event(bid, event_data):
    """向所有 SSE 订阅者推送事件"""
    batch = get_batch(bid)
    if not batch:
        return
    with batch['lock']:
        queues = list(batch['event_queues'])
    for eq in queues:
        try:
            eq.put_nowait(event_data)
        except queue.Full:
            pass


def generate_batch_sse(bid):
    """SSE 生成器，供 Flask 路由使用。返回 (generator, cleanup_fn)。"""
    batch = get_batch(bid)
    if not batch:
        return None, None

    event_q = queue.Queue(maxsize=MAX_SSE_QUEUE_SIZE)
    with batch['lock']:
        batch['event_queues'].append(event_q)

    def cleanup():
        with batch['lock']:
            try:
                batch['event_queues'].remove(event_q)
            except ValueError:
                pass

    def generate():
        try:
            state = get_batch_state(bid)
            if state:
                yield f'data: {json.dumps({"type": "init", "state": state}, ensure_ascii=False)}\n\n'
            while True:
                try:
                    event = event_q.get(timeout=15)
                except queue.Empty:
                    yield ': keepalive\n\n'
                    if not get_batch(bid):
                        break
                    continue
                if event.get('type') == 'close':
                    break
                yield f'data: {json.dumps(event, ensure_ascii=False)}\n\n'
        except GeneratorExit:
            pass
        finally:
            cleanup()

    return generate, cleanup


# ============================================================
#  全局进度计算
# ============================================================
def _calc_global_progress(batch):
    """加权计算队列区域的全局进度百分比"""
    try:
        queue_tasks = [t for t in batch['tasks'] if t['zone'] == 'queue']
        if not queue_tasks:
            return 0
        total_frames = sum(t.get('total_frames', 0) for t in queue_tasks)
        if total_frames == 0:
            total = len(queue_tasks)
            done = sum(1 for t in queue_tasks if t['status'] in ('done', 'error'))
            running_progress = sum(t['progress'] for t in queue_tasks if t['status'] == 'running')
            return int((done * 100 + running_progress) / total) if total > 0 else 0
        weighted = 0
        for t in queue_tasks:
            tf = t.get('total_frames', 0)
            if tf == 0:
                continue
            weight = tf / total_frames
            if t['status'] in ('done', 'error'):
                weighted += weight * 100
            elif t['status'] == 'running':
                weighted += weight * t['progress']
        return int(weighted)
    except Exception:
        return 0


# ============================================================
#  缩略图生成
# ============================================================
def _generate_thumbnail(video_path, output_path, width=320):
    """从视频提取缩略图"""
    try:
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            cap.release()
            return False
        fps = cap.get(cv2.CAP_PROP_FPS) or 25
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(fps))
        ok, frame = cap.read()
        if not ok or frame is None:
            cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
            ok, frame = cap.read()
        cap.release()
        if not ok or frame is None:
            return False
        h, w_orig = frame.shape[:2]
        if w_orig <= 0 or h <= 0:
            return False
        new_w = width
        new_h = int(h * width / w_orig)
        thumb = cv2.resize(frame, (new_w, new_h))
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        ok, buf = cv2.imencode('.jpg', thumb, [cv2.IMWRITE_JPEG_QUALITY, 80])
        if ok:
            Path(output_path).write_bytes(buf.tobytes())
            return True
        return False
    except Exception as e:
        print(f'[缩略图] 生成失败: {e}')
        return False


def get_thumbnail_path(bid, vid):
    """获取缩略图文件路径"""
    batch = get_batch(bid)
    if not batch:
        return None
    with batch['lock']:
        task = _find_task(batch, vid)
        if not task:
            # 也在回收站中查找
            _, snap = _find_task_in_trash(batch, vid)
            if snap:
                thumb = os.path.join(snap.get('output_dir', ''), 'thumbnail.jpg')
                if os.path.isfile(thumb):
                    return thumb
            return None
        thumb = os.path.join(task['output_dir'], 'thumbnail.jpg')
    if os.path.isfile(thumb):
        return thumb
    return None


# ============================================================
#  智能命名递增
# ============================================================
def auto_increment_name(base_name, count):
    """根据 base_name 中的数字模式自动生成 count 个递增名称。"""
    if count <= 0:
        return []
    if count == 1:
        return [base_name]
    for pattern, ptype in _INCREMENT_PATTERNS:
        m = pattern.search(base_name)
        if m:
            if ptype in ('chinese_ordinal', 'parenthesized'):
                start_num = int(m.group(2))
            elif ptype == 'separator_num':
                start_num = int(m.group(2))
            else:
                start_num = int(m.group(1))
            names = []
            for i in range(count):
                num = start_num + i
                if ptype == 'chinese_ordinal':
                    replacement = f'{m.group(1)}{num}{m.group(3)}'
                elif ptype == 'parenthesized':
                    replacement = f'{m.group(1)}{num}{m.group(3)}'
                elif ptype == 'separator_num':
                    sep = m.group(1)
                    orig_digits = m.group(2)
                    replacement = f'{sep}{str(num).zfill(len(orig_digits))}'
                else:
                    orig_digits = m.group(1)
                    replacement = str(num).zfill(len(orig_digits))
                new_name = base_name[:m.start()] + replacement + base_name[m.end():]
                names.append(new_name)
            return names
    names = [base_name]
    for i in range(2, count + 1):
        names.append(f'{base_name}_{i}')
    return names


# ============================================================
#  文件名安全处理
# ============================================================
def _sanitize_dirname(name, suffix=''):
    """将显示名转为文件系统安全的目录名"""
    safe = _UNSAFE_CHARS.sub('_', name).strip().strip('.')
    if len(safe) > 80:
        safe = safe[:80]
    safe = safe.rstrip('. ')
    if not safe:
        safe = 'unnamed'
    if suffix:
        safe = f'{safe}_{suffix}'
    return safe


# ============================================================
#  持久化（batch.json）
# ============================================================
_META_SAVE_KEYS = (
    'id', 'status', 'params', 'max_workers', 'created_at',
    'completed_count', 'failed_count', 'total_images', 'start_time',
    'trashed_videos',
)

_TASK_SAVE_KEYS = (
    'id', 'video_path', 'display_name', 'zone', 'status', 'progress', 'message',
    'saved_count', 'eta_seconds', 'elapsed_seconds', 'error_message',
    'retry_count', 'total_frames', 'fps', 'resolution', 'last_frame_index',
    'resume_from_breakpoint', 'output_dir', 'cache_dir', 'pkg_dir',
)


def _save_batch_meta(bid):
    """保存批量元数据到 batch.json"""
    batch = get_batch(bid)
    if not batch:
        return
    try:
        with batch['lock']:
            meta = {k: batch[k] for k in _META_SAVE_KEYS if k in batch}
            meta['tasks'] = []
            for t in batch['tasks']:
                task_meta = {k: t[k] for k in _TASK_SAVE_KEYS if k in t}
                # resolution 是 tuple，转为 list 以便 JSON 序列化
                if 'resolution' in task_meta and isinstance(task_meta['resolution'], tuple):
                    task_meta['resolution'] = list(task_meta['resolution'])
                meta['tasks'].append(task_meta)
            meta_path = os.path.join(batch['batch_dir'], 'batch.json')

        with open(meta_path, 'w', encoding='utf-8') as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f'[批量持久化] 保存失败: {e}')


def recover_batches_from_disk(sessions_root):
    """启动时从磁盘恢复批量队列（兼容旧数据迁移）"""
    if not os.path.isdir(sessions_root):
        return
    for name in os.listdir(sessions_root):
        if not name.startswith('batch_'):
            continue
        batch_dir = os.path.join(sessions_root, name)
        meta_path = os.path.join(batch_dir, 'batch.json')
        if not os.path.isfile(meta_path):
            continue
        try:
            with open(meta_path, 'r', encoding='utf-8') as f:
                meta = json.load(f)
            bid = meta.get('id')
            if not bid:
                continue
            # 重建 batch 对象
            old_status = meta.get('status', 'idle')
            # 旧状态映射：running/paused/done/cancelled → idle
            new_status = 'idle'
            batch = {
                'id': bid,
                'status': new_status,
                'tasks': [],
                'params': meta.get('params', {}),
                'max_workers': meta.get('max_workers', 1),
                'created_at': meta.get('created_at', time.time()),
                'batch_dir': batch_dir,
                'lock': threading.RLock(),
                'event_queues': [],
                'queue_auto_pause': False,
                'worker_semaphore': threading.Semaphore(meta.get('max_workers', 1)),
                'dispatcher_thread': None,
                'completed_count': meta.get('completed_count', 0),
                'failed_count': meta.get('failed_count', 0),
                'total_images': meta.get('total_images', 0),
                'start_time': meta.get('start_time', 0),
                'trashed_videos': meta.get('trashed_videos', []),
            }
            # 恢复任务（含旧数据迁移）
            for tm in meta.get('tasks', []):
                old_task_status = tm.get('status', 'queued')
                old_zone = tm.get('zone', '')

                # 迁移旧数据：根据旧 status 推断 zone
                if old_zone in ('unselected', 'queue', 'completed'):
                    zone = old_zone
                    status = tm.get('status', 'idle')
                else:
                    # 旧模型迁移
                    if old_task_status == 'done':
                        zone = 'completed'
                        status = 'done'
                    elif old_task_status in ('queued',):
                        zone = 'queue'
                        status = 'waiting'
                    elif old_task_status == 'running':
                        zone = 'queue'
                        status = 'error'
                        batch['failed_count'] += 1
                    elif old_task_status in ('error', 'cancelled', 'skipped', 'paused'):
                        zone = 'unselected'
                        status = 'idle'
                    else:
                        zone = 'unselected'
                        status = 'idle'

                # running 状态恢复为 error（程序中断了）
                if status == 'running':
                    status = 'error'
                    batch['failed_count'] += 1

                resolution = tm.get('resolution', [0, 0])
                if isinstance(resolution, list):
                    resolution = tuple(resolution)

                task = {
                    'id': tm.get('id', uuid.uuid4().hex[:8]),
                    'video_path': tm.get('video_path', ''),
                    'display_name': tm.get('display_name', ''),
                    'zone': zone,
                    'status': status,
                    'progress': tm.get('progress', 0) if status != 'idle' else 0,
                    'message': tm.get('message', '') if status != 'idle' else '',
                    'saved_count': tm.get('saved_count', 0),
                    'eta_seconds': tm.get('eta_seconds', -1),
                    'elapsed_seconds': tm.get('elapsed_seconds', 0),
                    'error_message': tm.get('error_message', '') if status == 'error' else '',
                    'retry_count': tm.get('retry_count', 0),
                    'cancel_flag': False,
                    '_pending_trash': False,
                    'total_frames': tm.get('total_frames', 0),
                    'fps': tm.get('fps', 0),
                    'resolution': resolution,
                    'last_frame_index': tm.get('last_frame_index', 0),
                    'resume_from_breakpoint': tm.get('resume_from_breakpoint', False),
                    'output_dir': tm.get('output_dir', ''),
                    'cache_dir': tm.get('cache_dir', ''),
                    'pkg_dir': tm.get('pkg_dir', ''),
                }
                # 验证输出目录存在
                if task['output_dir'] and os.path.isdir(task['output_dir']):
                    cache = task.get('cache_dir', '')
                    if cache and os.path.isdir(cache):
                        actual = len([f for f in os.listdir(cache)
                                      if f.lower().endswith(('.jpg', '.jpeg', '.png'))])
                        task['saved_count'] = actual
                batch['tasks'].append(task)

            with _batches_lock:
                _batches[bid] = batch
            print(f'[批量恢复] 恢复批量 {bid}，{len(batch["tasks"])} 个视频')
        except Exception as e:
            print(f'[批量恢复] 恢复 {name} 失败: {e}')


# ============================================================
#  打包导出
# ============================================================
def package_batch_video(bid, vid, fmt):
    """打包单个视频的提取结果"""
    batch = get_batch(bid)
    if not batch:
        return None, '批量队列不存在'
    with batch['lock']:
        task = _find_task(batch, vid)
        if not task:
            return None, '视频不存在'
        if task['zone'] != 'completed' or task['status'] != 'done':
            return None, '视频尚未完成处理'
        cache_dir = task['cache_dir']
        pkg_dir = task['pkg_dir']
        display_name = task['display_name']

    images = sorted([
        os.path.join(cache_dir, f)
        for f in os.listdir(cache_dir)
        if f.lower().endswith(('.jpg', '.jpeg', '.png'))
    ])
    if not images:
        return None, '没有可导出的图片'

    def on_progress(pct, msg):
        _push_batch_event(bid, {
            'type': 'packaging',
            'video_id': vid,
            'progress': pct,
            'message': msg,
        })

    try:
        filename = package_images(images, pkg_dir, fmt, display_name, on_progress)
        _push_batch_event(bid, {
            'type': 'packaging_done',
            'video_id': vid,
            'filename': filename,
            'format': fmt,
        })
        return filename, None
    except Exception as e:
        err = str(e)
        _push_batch_event(bid, {
            'type': 'packaging_error',
            'video_id': vid,
            'message': err,
        })
        return None, err


def package_batch_all(bid, fmt='zip', video_ids=None):
    """
    批量导出已完成视频。
    - fmt='zip': 每个视频的图片放入子文件夹，打包为一个 ZIP
    - fmt='pdf'/'pptx': 每个视频先生成对应格式文件，再打包为一个 ZIP
    video_ids 可选过滤。
    """
    import zipfile as _zipfile

    batch = get_batch(bid)
    if not batch:
        return None, '批量队列不存在'

    with batch['lock']:
        done_tasks = [t for t in batch['tasks']
                      if t['zone'] == 'completed' and t['status'] == 'done' and t['saved_count'] > 0]
        if video_ids:
            vid_set = set(video_ids)
            done_tasks = [t for t in done_tasks if t['id'] in vid_set]
        batch_dir = batch['batch_dir']

    if not done_tasks:
        return None, '没有已完成的视频'

    fmt_label = fmt.upper() if fmt in ('pdf', 'pptx') else 'ZIP'
    output_path = os.path.join(batch_dir, f'批量导出_{fmt_label}_{batch["id"]}.zip')
    total = len(done_tasks)

    # 去重 display_name
    name_counts = {}
    unique_names = {}
    for task in done_tasks:
        dn = task['display_name']
        if dn in name_counts:
            name_counts[dn] += 1
            unique_names[task['id']] = f'{dn}_{name_counts[dn]}'
        else:
            name_counts[dn] = 1
            unique_names[task['id']] = dn
    for dn, cnt in name_counts.items():
        if cnt > 1:
            for task in done_tasks:
                if task['display_name'] == dn and unique_names[task['id']] == dn:
                    unique_names[task['id']] = f'{dn}_1'
                    break

    try:
        if fmt in ('pdf', 'pptx'):
            generated_files = []
            for i, task in enumerate(done_tasks):
                cache_dir = task['cache_dir']
                pkg_dir = task['pkg_dir']
                display_name = unique_names[task['id']]
                images = sorted([
                    os.path.join(cache_dir, f)
                    for f in os.listdir(cache_dir)
                    if f.lower().endswith(('.jpg', '.jpeg', '.png'))
                ])
                if not images:
                    continue
                pct = int(i / total * 80)
                _push_batch_event(bid, {
                    'type': 'batch_packaging',
                    'progress': pct,
                    'message': f'正在生成 {display_name}.{fmt} ({i+1}/{total})',
                })
                filename = package_images(images, pkg_dir, fmt, display_name)
                generated_files.append((os.path.join(pkg_dir, filename), filename))

            _push_batch_event(bid, {
                'type': 'batch_packaging',
                'progress': 85,
                'message': '正在打包为 ZIP…',
            })
            with _zipfile.ZipFile(output_path, 'w', _zipfile.ZIP_DEFLATED) as zf:
                for filepath, arcname in generated_files:
                    zf.write(filepath, arcname)
        else:
            total_images = sum(t['saved_count'] for t in done_tasks)
            processed = 0
            with _zipfile.ZipFile(output_path, 'w', _zipfile.ZIP_DEFLATED) as zf:
                for task in done_tasks:
                    cache_dir = task['cache_dir']
                    folder_name = unique_names[task['id']]
                    images = sorted([
                        f for f in os.listdir(cache_dir)
                        if f.lower().endswith(('.jpg', '.jpeg', '.png'))
                    ])
                    for img_name in images:
                        img_path = os.path.join(cache_dir, img_name)
                        arcname = f'{folder_name}/{img_name}'
                        zf.write(img_path, arcname)
                        processed += 1
                        pct = int(processed / total_images * 95) if total_images > 0 else 0
                        _push_batch_event(bid, {
                            'type': 'batch_packaging',
                            'progress': pct,
                            'message': f'正在打包 {folder_name}/{img_name}',
                        })

        _push_batch_event(bid, {
            'type': 'batch_packaging_done',
            'filename': os.path.basename(output_path),
            'progress': 100,
        })
        return os.path.basename(output_path), None

    except Exception as e:
        err = str(e)
        _push_batch_event(bid, {
            'type': 'batch_packaging_error',
            'message': err,
        })
        return None, err


# ============================================================
#  图片列表
# ============================================================
def get_video_images(bid, vid):
    """获取某个视频的提取图片列表"""
    batch = get_batch(bid)
    if not batch:
        return []
    with batch['lock']:
        task = _find_task(batch, vid)
        if not task:
            # 也在回收站中查找
            _, snap = _find_task_in_trash(batch, vid)
            if snap:
                cache_dir = snap.get('cache_dir', '')
            else:
                return []
        else:
            cache_dir = task['cache_dir']
    if not os.path.isdir(cache_dir):
        return []
    return sorted([
        f for f in os.listdir(cache_dir)
        if f.lower().endswith(('.jpg', '.jpeg', '.png'))
    ])


def get_video_image_path(bid, vid, filename):
    """获取某个视频的某张图片的安全路径"""
    batch = get_batch(bid)
    if not batch:
        return None
    with batch['lock']:
        task = _find_task(batch, vid)
        if not task:
            _, snap = _find_task_in_trash(batch, vid)
            if snap:
                cache_dir = snap.get('cache_dir', '')
            else:
                return None
        else:
            cache_dir = task['cache_dir']
    safe_name = os.path.basename(filename)
    full_path = os.path.join(cache_dir, safe_name)
    if os.path.isfile(full_path):
        return full_path
    return None


def get_download_path(bid, filename):
    """获取批量导出文件的安全下载路径"""
    batch = get_batch(bid)
    if not batch:
        return None
    safe_name = os.path.basename(filename)
    full_path = os.path.join(batch['batch_dir'], safe_name)
    if os.path.isfile(full_path):
        return full_path
    return None


def get_video_download_path(bid, vid, filename):
    """获取单视频导出文件的安全下载路径"""
    batch = get_batch(bid)
    if not batch:
        return None
    with batch['lock']:
        task = _find_task(batch, vid)
        if not task:
            return None
        pkg_dir = task['pkg_dir']
    safe_name = os.path.basename(filename)
    full_path = os.path.join(pkg_dir, safe_name)
    if os.path.isfile(full_path):
        return full_path
    return None


# ============================================================
#  图片软删除 / 恢复
# ============================================================
def trash_image(bid, vid, filename):
    """将图片从 cache/ 移到 .trash/（软删除）"""
    batch = get_batch(bid)
    if not batch:
        return False, '批量队列不存在'
    with batch['lock']:
        task = _find_task(batch, vid)
        if not task:
            return False, '视频不存在'
        cache_dir = task['cache_dir']
    safe_name = os.path.basename(filename)
    src = os.path.join(cache_dir, safe_name)
    if not os.path.isfile(src):
        return False, '图片不存在'
    trash_dir = os.path.join(os.path.dirname(cache_dir), '.trash')
    os.makedirs(trash_dir, exist_ok=True)
    dst = os.path.join(trash_dir, safe_name)
    try:
        shutil.move(src, dst)
        with batch['lock']:
            remaining = len([f for f in os.listdir(cache_dir)
                             if f.lower().endswith(('.jpg', '.jpeg', '.png'))])
            task['saved_count'] = remaining
        _save_batch_meta(bid)
        return True, 'ok'
    except Exception as e:
        return False, str(e)


def restore_image(bid, vid, filename):
    """从 .trash/ 恢复图片到 cache/"""
    batch = get_batch(bid)
    if not batch:
        return False, '批量队列不存在'
    with batch['lock']:
        task = _find_task(batch, vid)
        if not task:
            return False, '视频不存在'
        cache_dir = task['cache_dir']
    safe_name = os.path.basename(filename)
    trash_dir = os.path.join(os.path.dirname(cache_dir), '.trash')
    src = os.path.join(trash_dir, safe_name)
    if not os.path.isfile(src):
        return False, '回收站中无此图片'
    dst = os.path.join(cache_dir, safe_name)
    try:
        shutil.move(src, dst)
        with batch['lock']:
            remaining = len([f for f in os.listdir(cache_dir)
                             if f.lower().endswith(('.jpg', '.jpeg', '.png'))])
            task['saved_count'] = remaining
        _save_batch_meta(bid)
        return True, 'ok'
    except Exception as e:
        return False, str(e)


def restore_all_images(bid, vid):
    """恢复该视频所有已删除图片"""
    batch = get_batch(bid)
    if not batch:
        return 0
    with batch['lock']:
        task = _find_task(batch, vid)
        if not task:
            return 0
        cache_dir = task['cache_dir']
    trash_dir = os.path.join(os.path.dirname(cache_dir), '.trash')
    if not os.path.isdir(trash_dir):
        return 0
    count = 0
    for f in os.listdir(trash_dir):
        if f.lower().endswith(('.jpg', '.jpeg', '.png')):
            try:
                shutil.move(os.path.join(trash_dir, f), os.path.join(cache_dir, f))
                count += 1
            except Exception:
                pass
    with batch['lock']:
        remaining = len([f for f in os.listdir(cache_dir)
                         if f.lower().endswith(('.jpg', '.jpeg', '.png'))])
        task['saved_count'] = remaining
    _save_batch_meta(bid)
    return count


def list_trashed_images(bid, vid):
    """列出回收站中的图片"""
    batch = get_batch(bid)
    if not batch:
        return []
    with batch['lock']:
        task = _find_task(batch, vid)
        if not task:
            return []
        cache_dir = task['cache_dir']
    trash_dir = os.path.join(os.path.dirname(cache_dir), '.trash')
    if not os.path.isdir(trash_dir):
        return []
    return sorted([f for f in os.listdir(trash_dir)
                    if f.lower().endswith(('.jpg', '.jpeg', '.png'))])


def get_trashed_image_path(bid, vid, filename):
    """获取回收站中图片的安全路径"""
    batch = get_batch(bid)
    if not batch:
        return None
    with batch['lock']:
        task = _find_task(batch, vid)
        if not task:
            return None
        cache_dir = task['cache_dir']
    safe_name = os.path.basename(filename)
    trash_dir = os.path.join(os.path.dirname(cache_dir), '.trash')
    full_path = os.path.join(trash_dir, safe_name)
    if os.path.isfile(full_path):
        return full_path
    return None


# ============================================================
#  视频回收站（三区域模型）
# ============================================================
def trash_video(bid, vid):
    """
    将视频移入回收站。
    - queue(running): 设 _pending_trash 标记，worker 完成后自动移入
    - queue(waiting): 不应该走这里（waiting 应该用 move_to_unselected）
    - queue(error): 直接移入回收站
    - completed(done): 直接移入回收站
    """
    batch = get_batch(bid)
    if not batch:
        return False, '批量队列不存在'
    with batch['lock']:
        task = _find_task(batch, vid)
        if not task:
            return False, '视频不存在'

        if task['zone'] == 'queue' and task['status'] == 'running':
            # 标记等待取消后移入回收站
            task['cancel_flag'] = True
            task['_pending_trash'] = True
            task['message'] = '正在取消…'
            _push_batch_event(bid, {
                'type': 'video_status',
                'video_id': vid,
                'zone': 'queue',
                'status': 'running',
                'message': '正在取消…',
            })
            return True, 'pending'

        allowed = (
            (task['zone'] == 'queue' and task['status'] == 'error') or
            (task['zone'] == 'completed' and task['status'] == 'done')
        )
        if not allowed:
            return False, f'zone={task["zone"]}, status={task["status"]} 不可移入回收站'

        # 保存元数据快照
        snap = {k: task[k] for k in _TASK_SAVE_KEYS if k in task}
        if isinstance(snap.get('resolution'), tuple):
            snap['resolution'] = list(snap['resolution'])
        snap['trashed_at'] = time.time()
        snap['trash_reason'] = task['status']  # 'done' 或 'error'
        batch['trashed_videos'].append(snap)
        batch['tasks'].remove(task)
        # 更新统计
        if task['zone'] == 'completed' and task['status'] == 'done':
            batch['completed_count'] = max(0, batch['completed_count'] - 1)
            batch['total_images'] = max(0, batch['total_images'] - task['saved_count'])
        elif task['status'] == 'error':
            batch['failed_count'] = max(0, batch['failed_count'] - 1)

    # 移动文件到 .video_trash/
    video_trash_dir = os.path.join(batch['batch_dir'], '.video_trash')
    os.makedirs(video_trash_dir, exist_ok=True)
    src = task['output_dir']
    dst = os.path.join(video_trash_dir, os.path.basename(src))
    if os.path.isdir(src):
        try:
            shutil.move(src, dst)
        except Exception:
            pass

    _push_batch_event(bid, {
        'type': 'zone_change',
        'action': 'video_trashed',
        'video_id': vid,
        'trash_reason': snap['trash_reason'],
    })
    _save_batch_meta(bid)
    return True, 'ok'


def restore_from_trash(bid, vid, action):
    """
    从回收站恢复视频。
    action:
      - 'to_unselected': 删除提取结果，重置为 idle，回到未选中区域
      - 'resume_to_queue': 断点续传，加入队列末尾（仅半处理视频）
      - 'to_completed': 保留结果，直接回到已完成区域（仅已完成视频）
      - 'permanent_delete': 永久删除
    """
    batch = get_batch(bid)
    if not batch:
        return False, '批量队列不存在'

    idx, snap = None, None
    with batch['lock']:
        idx, snap = _find_task_in_trash(batch, vid)
    if snap is None:
        return False, '回收站中无此视频'

    if action == 'permanent_delete':
        with batch['lock']:
            batch['trashed_videos'].pop(idx)
        # 永久删除文件
        video_trash_dir = os.path.join(batch['batch_dir'], '.video_trash')
        src_dir = os.path.join(video_trash_dir, os.path.basename(snap.get('output_dir', '')))
        if os.path.isdir(src_dir):
            shutil.rmtree(src_dir, ignore_errors=True)
        _save_batch_meta(bid)
        _push_batch_event(bid, {
            'type': 'zone_change',
            'action': 'video_permanently_deleted',
            'video_id': vid,
        })
        return True, 'ok'

    # 恢复文件到原位
    video_trash_dir = os.path.join(batch['batch_dir'], '.video_trash')
    src_dir = os.path.join(video_trash_dir, os.path.basename(snap.get('output_dir', '')))
    dst_dir = snap.get('output_dir', '')
    if os.path.isdir(src_dir) and dst_dir:
        try:
            shutil.move(src_dir, dst_dir)
        except Exception:
            pass

    resolution = snap.get('resolution', [0, 0])
    if isinstance(resolution, list):
        resolution = tuple(resolution)

    if action == 'to_unselected':
        # 删除提取结果，完全重置
        cache_dir = snap.get('cache_dir', '')
        if cache_dir and os.path.isdir(cache_dir):
            shutil.rmtree(cache_dir, ignore_errors=True)
            os.makedirs(cache_dir, exist_ok=True)
        task = {
            'id': snap.get('id'),
            'video_path': snap.get('video_path', ''),
            'display_name': snap.get('display_name', ''),
            'zone': 'unselected',
            'status': 'idle',
            'progress': 0,
            'message': '',
            'saved_count': 0,
            'eta_seconds': -1,
            'elapsed_seconds': 0,
            'error_message': '',
            'retry_count': 0,
            'cancel_flag': False,
            '_pending_trash': False,
            'total_frames': snap.get('total_frames', 0),
            'fps': snap.get('fps', 0),
            'resolution': resolution,
            'last_frame_index': 0,
            'resume_from_breakpoint': False,
            'output_dir': snap.get('output_dir', ''),
            'cache_dir': snap.get('cache_dir', ''),
            'pkg_dir': snap.get('pkg_dir', ''),
        }
        with batch['lock']:
            batch['trashed_videos'].pop(idx)
            batch['tasks'].append(task)
        _push_batch_event(bid, {
            'type': 'zone_change',
            'action': 'restored_to_unselected',
            'video_id': vid,
        })

    elif action == 'resume_to_queue':
        # 断点续传：保留已提取图片，加入队列末尾
        if snap.get('trash_reason') == 'done':
            return False, '已完成的视频不支持断点续传，请使用 to_completed'
        task = {
            'id': snap.get('id'),
            'video_path': snap.get('video_path', ''),
            'display_name': snap.get('display_name', ''),
            'zone': 'queue',
            'status': 'waiting',
            'progress': 0,
            'message': '',
            'saved_count': snap.get('saved_count', 0),
            'eta_seconds': -1,
            'elapsed_seconds': 0,
            'error_message': '',
            'retry_count': snap.get('retry_count', 0),
            'cancel_flag': False,
            '_pending_trash': False,
            'total_frames': snap.get('total_frames', 0),
            'fps': snap.get('fps', 0),
            'resolution': resolution,
            'last_frame_index': snap.get('last_frame_index', 0),
            'resume_from_breakpoint': True,  # 关键：标记断点续传
            'output_dir': snap.get('output_dir', ''),
            'cache_dir': snap.get('cache_dir', ''),
            'pkg_dir': snap.get('pkg_dir', ''),
        }
        # 重新计算 saved_count
        if task['cache_dir'] and os.path.isdir(task['cache_dir']):
            actual = len([f for f in os.listdir(task['cache_dir'])
                          if f.lower().endswith(('.jpg', '.jpeg', '.png'))])
            task['saved_count'] = actual
        with batch['lock']:
            batch['trashed_videos'].pop(idx)
            batch['tasks'].append(task)
        _push_batch_event(bid, {
            'type': 'zone_change',
            'action': 'restored_to_queue',
            'video_id': vid,
        })

    elif action == 'to_completed':
        # 保留结果，直接回到已完成区域
        if snap.get('trash_reason') != 'done':
            return False, '半处理的视频不支持直接恢复到已完成，请使用 resume_to_queue 或 to_unselected'
        task = {
            'id': snap.get('id'),
            'video_path': snap.get('video_path', ''),
            'display_name': snap.get('display_name', ''),
            'zone': 'completed',
            'status': 'done',
            'progress': 100,
            'message': snap.get('message', '已完成'),
            'saved_count': snap.get('saved_count', 0),
            'eta_seconds': -1,
            'elapsed_seconds': snap.get('elapsed_seconds', 0),
            'error_message': '',
            'retry_count': snap.get('retry_count', 0),
            'cancel_flag': False,
            '_pending_trash': False,
            'total_frames': snap.get('total_frames', 0),
            'fps': snap.get('fps', 0),
            'resolution': resolution,
            'last_frame_index': snap.get('last_frame_index', 0),
            'resume_from_breakpoint': False,
            'output_dir': snap.get('output_dir', ''),
            'cache_dir': snap.get('cache_dir', ''),
            'pkg_dir': snap.get('pkg_dir', ''),
        }
        # 重新计算 saved_count
        if task['cache_dir'] and os.path.isdir(task['cache_dir']):
            actual = len([f for f in os.listdir(task['cache_dir'])
                          if f.lower().endswith(('.jpg', '.jpeg', '.png'))])
            task['saved_count'] = actual
        with batch['lock']:
            batch['trashed_videos'].pop(idx)
            batch['tasks'].append(task)
            batch['completed_count'] += 1
            batch['total_images'] += task['saved_count']
        _push_batch_event(bid, {
            'type': 'zone_change',
            'action': 'restored_to_completed',
            'video_id': vid,
        })
    else:
        return False, f'未知操作: {action}'

    _save_batch_meta(bid)
    return True, 'ok'


def list_trashed_videos(bid):
    """列出回收站中的视频"""
    batch = get_batch(bid)
    if not batch:
        return []
    with batch['lock']:
        return [dict(s) for s in batch['trashed_videos']]


def empty_video_trash(bid):
    """永久删除回收站中的所有视频"""
    batch = get_batch(bid)
    if not batch:
        return 0
    with batch['lock']:
        count = len(batch['trashed_videos'])
        batch['trashed_videos'] = []
    video_trash_dir = os.path.join(batch['batch_dir'], '.video_trash')
    if os.path.isdir(video_trash_dir):
        shutil.rmtree(video_trash_dir, ignore_errors=True)
    _save_batch_meta(bid)
    return count


# ============================================================
#  单视频取消（仅用于 running 视频移入回收站）
# ============================================================
def cancel_video(bid, vid):
    """
    取消正在运行的视频（移入回收站）。
    这是 trash_video 对 running 视频的快捷方式。
    """
    return trash_video(bid, vid)


# ============================================================
#  清理
# ============================================================
def cleanup_batch(bid):
    """删除批量队列及所有文件"""
    batch = None
    with _batches_lock:
        batch = _batches.pop(bid, None)
    if not batch:
        return False
    with batch['lock']:
        for eq in batch['event_queues']:
            try:
                eq.put_nowait({'type': 'close'})
            except queue.Full:
                pass
        batch['event_queues'].clear()
        # 标记所有 running 视频取消
        for t in batch['tasks']:
            if t['status'] == 'running':
                t['cancel_flag'] = True
    batch_dir = batch.get('batch_dir', '')
    if batch_dir and os.path.isdir(batch_dir):
        shutil.rmtree(batch_dir, ignore_errors=True)
    return True


def cleanup_all_batches():
    """清理所有批量队列"""
    with _batches_lock:
        bids = list(_batches.keys())
    for bid in bids:
        cleanup_batch(bid)


def list_batches():
    """列出所有批量队列的摘要"""
    with _batches_lock:
        bids = list(_batches.keys())
    result = []
    for bid in bids:
        state = get_batch_state(bid)
        if state:
            total_tasks = sum(len(z) for z in state['zones'].values())
            result.append({
                'id': state['id'],
                'status': state['status'],
                'task_count': total_tasks,
                'completed_count': state['completed_count'],
                'total_images': state['total_images'],
            })
    return result


# ============================================================
#  文件夹扫描
# ============================================================
def scan_folder_for_videos(folder_path):
    """扫描文件夹中的视频文件，返回路径列表"""
    if not os.path.isdir(folder_path):
        return []
    videos = []
    for f in sorted(os.listdir(folder_path)):
        ext = os.path.splitext(f)[1].lower()
        if ext in VIDEO_EXTENSIONS:
            full_path = os.path.join(folder_path, f)
            if os.path.isfile(full_path):
                videos.append(full_path)
    return videos
