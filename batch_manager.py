"""
影幻智提 (VidSlide) - 批量处理调度模块
======================================
管理批量视频队列、并发调度、进度聚合和 SSE 事件推送。
独立于现有 session 系统，直接调用 extractor / exporter。

作者: PWO-CHINA
版本: v0.5.0
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
# 视频文件扩展名白名单
VIDEO_EXTENSIONS = frozenset({
    '.mp4', '.avi', '.mkv', '.mov', '.flv', '.wmv', '.webm',
    '.m4v', '.ts', '.mpg', '.mpeg', '.3gp',
})

DISK_WARN_THRESHOLD_MB = 500
MAX_SSE_QUEUE_SIZE = 200

# 文件名中非法字符（Windows）
_UNSAFE_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')

# 命名递增模式（按优先级排列）
_INCREMENT_PATTERNS = [
    # 第N节 / 第N章 / 第N课 / 第N讲
    (re.compile(r'(第)(\d+)([节章课讲部分])'), 'chinese_ordinal'),
    # （N）或 (N)
    (re.compile(r'([（(])(\d+)([)）])'), 'parenthesized'),
    # xxx_N 或 xxx-N（下划线/连字符+数字）
    (re.compile(r'([_\-])(\d+)\s*$'), 'separator_num'),
    # 尾部数字（如 xxx01, xxx 3）
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
    """创建一个视频任务字典"""
    vid = uuid.uuid4().hex[:8]
    return {
        'id': vid,
        'video_path': video_path,
        'display_name': display_name,
        'status': 'queued',       # queued | running | done | error | cancelled | skipped | paused
        'progress': 0,
        'message': '',
        'saved_count': 0,
        'eta_seconds': -1,
        'elapsed_seconds': 0,
        'error_message': '',
        'retry_count': 0,
        'cancel_flag': False,      # 单视频级别取消标志
        '_pause_intent': False,    # 暂停意图标记（区分暂停和取消）
        'total_frames': 0,
        'last_frame_index': 0,
        'output_dir': output_dir,  # 该视频的输出子目录
        'cache_dir': os.path.join(output_dir, 'cache'),
        'pkg_dir': os.path.join(output_dir, 'packages'),
    }


def _new_batch(base_dir, params, max_workers=1):
    """创建一个批量队列字典"""
    bid = uuid.uuid4().hex[:8]
    batch_dir = os.path.join(base_dir, f'batch_{bid}')
    os.makedirs(batch_dir, exist_ok=True)
    return {
        'id': bid,
        'status': 'idle',         # idle | running | paused | done | cancelled
        'tasks': [],              # VideoTask 列表（有序）
        'params': dict(params),   # 全局提取参数
        'max_workers': max_workers,
        'created_at': time.time(),
        'batch_dir': batch_dir,
        # 同步原语
        'lock': threading.RLock(),
        'event_queues': [],       # SSE 订阅者
        'pause_flag': False,
        'cancel_flag': False,
        'worker_semaphore': threading.Semaphore(max_workers),
        'dispatcher_thread': None,
        # 统计
        'completed_count': 0,
        'failed_count': 0,
        'skipped_count': 0,
        'total_images': 0,
        'start_time': 0,
        # 视频回收站
        'trashed_videos': [],  # 被移除视频的元数据快照
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
    """获取批量队列的可序列化状态快照"""
    batch = get_batch(bid)
    if not batch:
        return None
    with batch['lock']:
        tasks_snap = []
        for t in batch['tasks']:
            tasks_snap.append({
                'id': t['id'],
                'video_path': t['video_path'],
                'display_name': t['display_name'],
                'status': t['status'],
                'progress': t['progress'],
                'message': t['message'],
                'saved_count': t['saved_count'],
                'eta_seconds': t['eta_seconds'],
                'elapsed_seconds': t['elapsed_seconds'],
                'error_message': t['error_message'],
                'retry_count': t['retry_count'],
                'total_frames': t['total_frames'],
            })
        return {
            'id': batch['id'],
            'status': batch['status'],
            'tasks': tasks_snap,
            'params': dict(batch['params']),
            'max_workers': batch['max_workers'],
            'created_at': batch['created_at'],
            'completed_count': batch['completed_count'],
            'failed_count': batch['failed_count'],
            'skipped_count': batch['skipped_count'],
            'total_images': batch['total_images'],
            'start_time': batch['start_time'],
            'global_progress': _calc_global_progress(batch),
            'trashed_videos_count': len(batch.get('trashed_videos', [])),
        }


def _find_task(batch, vid):
    """在 batch 中查找 vid 对应的 task（需在 batch['lock'] 内调用）"""
    for t in batch['tasks']:
        if t['id'] == vid:
            return t
    return None


# ============================================================
#  视频添加 / 移除 / 排序
# ============================================================
def add_videos(bid, entries):
    """
    添加视频到队列。
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
            os.makedirs(task['cache_dir'], exist_ok=True)
            os.makedirs(task['pkg_dir'], exist_ok=True)
            batch['tasks'].append(task)
            added.append({
                'id': task['id'],
                'display_name': task['display_name'],
                'video_path': task['video_path'],
                'status': task['status'],
            })

    # 在锁外生成缩略图（IO 操作）
    for entry, info in zip(entries, added):
        task = None
        with batch['lock']:
            task = _find_task(batch, info['id'])
        if task:
            thumb_path = os.path.join(task['output_dir'], 'thumbnail.jpg')
            _generate_thumbnail(entry['path'], thumb_path)

    _save_batch_meta(bid)
    return added


def remove_video(bid, vid):
    """移除队列中的视频（仅 queued 状态可移除）"""
    batch = get_batch(bid)
    if not batch:
        return False, '批量队列不存在'
    with batch['lock']:
        task = _find_task(batch, vid)
        if not task:
            return False, '视频不存在'
        if task['status'] != 'queued':
            return False, f'无法移除状态为 {task["status"]} 的视频'
        batch['tasks'].remove(task)
    # 清理文件
    if os.path.exists(task['output_dir']):
        shutil.rmtree(task['output_dir'], ignore_errors=True)
    _save_batch_meta(bid)
    return True, 'ok'


def clear_queue(bid):
    """清空所有 queued 状态的视频"""
    batch = get_batch(bid)
    if not batch:
        return 0
    removed = []
    with batch['lock']:
        remaining = []
        for t in batch['tasks']:
            if t['status'] == 'queued':
                removed.append(t)
            else:
                remaining.append(t)
        batch['tasks'] = remaining
    for t in removed:
        if os.path.exists(t['output_dir']):
            shutil.rmtree(t['output_dir'], ignore_errors=True)
    _save_batch_meta(bid)
    return len(removed)


def reorder_queue(bid, ordered_vids):
    """按 vid 列表重排队列顺序"""
    batch = get_batch(bid)
    if not batch:
        return False
    with batch['lock']:
        task_map = {t['id']: t for t in batch['tasks']}
        new_order = []
        for vid in ordered_vids:
            if vid in task_map:
                new_order.append(task_map.pop(vid))
        # 未在列表中的任务追加到末尾
        for t in batch['tasks']:
            if t['id'] in task_map:
                new_order.append(t)
        batch['tasks'] = new_order
    _save_batch_meta(bid)
    return True


def update_video_name(bid, vid, new_name):
    """更新视频显示名"""
    batch = get_batch(bid)
    if not batch:
        return False
    with batch['lock']:
        task = _find_task(batch, vid)
        if not task:
            return False
        task['display_name'] = new_name
    _save_batch_meta(bid)
    return True


def prioritize_video(bid, vid):
    """将视频移到队列最前面（仅 queued 状态）"""
    batch = get_batch(bid)
    if not batch:
        return False
    with batch['lock']:
        task = _find_task(batch, vid)
        if not task or task['status'] != 'queued':
            return False
        batch['tasks'].remove(task)
        # 插入到第一个 queued 任务之前（running 任务保持在前面）
        insert_idx = 0
        for i, t in enumerate(batch['tasks']):
            if t['status'] in ('running',):
                insert_idx = i + 1
            else:
                break
        batch['tasks'].insert(insert_idx, task)
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
        # 调整信号量：增加时释放差值，减少时不做操作（自然收敛）
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
#  调度器 & Worker
# ============================================================
def start_batch(bid):
    """启动批量处理"""
    batch = get_batch(bid)
    if not batch:
        return False, '批量队列不存在'
    with batch['lock']:
        if batch['status'] == 'running':
            return False, '已在运行中'
        has_queued = any(t['status'] == 'queued' for t in batch['tasks'])
        if not has_queued:
            return False, '队列中没有待处理的视频'
        batch['status'] = 'running'
        batch['cancel_flag'] = False
        batch['pause_flag'] = False
        batch['start_time'] = time.time()
        # 重建信号量
        batch['worker_semaphore'] = threading.Semaphore(batch['max_workers'])

    _push_batch_event(bid, {
        'type': 'batch_status',
        'status': 'running',
    })

    t = threading.Thread(target=_dispatcher_loop, args=(bid,), daemon=True)
    with batch['lock']:
        batch['dispatcher_thread'] = t
    t.start()
    _save_batch_meta(bid)
    return True, 'ok'


def pause_batch(bid):
    """暂停队列（当前运行的任务会完成）"""
    batch = get_batch(bid)
    if not batch:
        return False
    with batch['lock']:
        if batch['status'] != 'running':
            return False
        batch['pause_flag'] = True
        batch['status'] = 'paused'
    _push_batch_event(bid, {'type': 'batch_status', 'status': 'paused'})
    _save_batch_meta(bid)
    return True


def resume_batch(bid):
    """恢复暂停的队列"""
    batch = get_batch(bid)
    if not batch:
        return False
    with batch['lock']:
        if batch['status'] != 'paused':
            return False
        batch['pause_flag'] = False
        batch['status'] = 'running'
        # 检查 dispatcher 是否还活着
        dt = batch.get('dispatcher_thread')
        need_restart = dt is None or not dt.is_alive()

    _push_batch_event(bid, {'type': 'batch_status', 'status': 'running'})

    if need_restart:
        t = threading.Thread(target=_dispatcher_loop, args=(bid,), daemon=True)
        with batch['lock']:
            batch['dispatcher_thread'] = t
        t.start()

    _save_batch_meta(bid)
    return True


def cancel_batch(bid):
    """取消整个批量队列"""
    batch = get_batch(bid)
    if not batch:
        return False
    with batch['lock']:
        batch['cancel_flag'] = True
        batch['status'] = 'cancelled'
        # 将所有 queued 任务标记为 cancelled
        for t in batch['tasks']:
            if t['status'] == 'queued':
                t['status'] = 'cancelled'
    _push_batch_event(bid, {'type': 'batch_status', 'status': 'cancelled'})
    _save_batch_meta(bid)
    return True


def retry_video(bid, vid):
    """重试失败/暂停的视频"""
    batch = get_batch(bid)
    if not batch:
        return False, '批量队列不存在'
    with batch['lock']:
        task = _find_task(batch, vid)
        if not task:
            return False, '视频不存在'
        if task['status'] not in ('error', 'skipped', 'cancelled', 'paused'):
            return False, f'状态 {task["status"]} 不支持重试'
        was_paused = task['status'] == 'paused' and task['saved_count'] > 0
        task['status'] = 'queued'
        task['progress'] = 0
        task['message'] = ''
        task['error_message'] = ''
        task['cancel_flag'] = False       # 核心修复：重置取消标志
        task['_pause_intent'] = False     # 重置暂停意图
        task['retry_count'] += 1
        task['eta_seconds'] = -1
        task['elapsed_seconds'] = 0
        # 暂停的视频如果已有图片，保留 cache（重新处理时会覆盖）
        if not was_paused:
            task['saved_count'] = 0
            if os.path.exists(task['cache_dir']):
                shutil.rmtree(task['cache_dir'])
                os.makedirs(task['cache_dir'], exist_ok=True)

        # 如果批量已完成/取消，需要重新启动 dispatcher
        need_restart = batch['status'] in ('done', 'cancelled', 'paused')
        if need_restart:
            batch['status'] = 'running'
            batch['cancel_flag'] = False
            batch['pause_flag'] = False

    _push_batch_event(bid, {
        'type': 'video_status',
        'video_id': vid,
        'status': 'queued',
        'retry_count': task['retry_count'],
    })

    if need_restart:
        _push_batch_event(bid, {'type': 'batch_status', 'status': 'running'})
        t = threading.Thread(target=_dispatcher_loop, args=(bid,), daemon=True)
        with batch['lock']:
            batch['dispatcher_thread'] = t
        t.start()

    _save_batch_meta(bid)
    return True, 'ok'


def retry_all_failed(bid):
    """重试所有失败的视频"""
    batch = get_batch(bid)
    if not batch:
        return 0
    count = 0
    with batch['lock']:
        vids = [t['id'] for t in batch['tasks'] if t['status'] in ('error', 'skipped')]
    for vid in vids:
        ok, _ = retry_video(bid, vid)
        if ok:
            count += 1
    return count


def _dispatcher_loop(bid):
    """调度器主循环：从队列中取任务，分配给 worker 线程"""
    batch = get_batch(bid)
    if not batch:
        return

    active_workers = []

    try:
        while True:
            # 检查取消
            with batch['lock']:
                if batch['cancel_flag']:
                    break

            # 检查暂停
            with batch['lock']:
                if batch['pause_flag']:
                    time.sleep(0.5)
                    continue

            # 找下一个 queued 任务
            next_task = None
            with batch['lock']:
                for t in batch['tasks']:
                    if t['status'] == 'queued':
                        next_task = t
                        break

            if next_task is None:
                # 没有更多 queued 任务，等待所有 worker 完成
                break

            # 磁盘空间检查
            if HAS_PSUTIL:
                try:
                    disk = psutil.disk_usage(batch['batch_dir'])
                    if disk.free < DISK_WARN_THRESHOLD_MB * 1024 * 1024:
                        with batch['lock']:
                            next_task['status'] = 'skipped'
                            next_task['error_message'] = '磁盘空间不足，已跳过'
                            batch['skipped_count'] += 1
                        _push_batch_event(bid, {
                            'type': 'video_status',
                            'video_id': next_task['id'],
                            'status': 'skipped',
                            'message': '磁盘空间不足',
                        })
                        _push_batch_event(bid, {
                            'type': 'disk_warning',
                            'free_mb': int(disk.free / (1024 * 1024)),
                        })
                        continue
                except Exception:
                    pass

            # 获取信号量（阻塞直到有空位）
            batch['worker_semaphore'].acquire()

            # 再次检查取消（可能在等待信号量期间被取消）
            with batch['lock']:
                if batch['cancel_flag']:
                    batch['worker_semaphore'].release()
                    break

            # 启动 worker
            wt = threading.Thread(
                target=_video_worker,
                args=(bid, next_task['id']),
                daemon=True,
            )
            active_workers.append(wt)
            wt.start()

            # 短暂 sleep 避免紧密循环
            time.sleep(0.1)

    except Exception as e:
        print(f'[批量调度] 调度器异常: {e}')

    # 等待所有 worker 完成
    for wt in active_workers:
        wt.join(timeout=3600)  # 最多等 1 小时

    # 更新批量状态
    with batch['lock']:
        if batch['cancel_flag']:
            batch['status'] = 'cancelled'
        else:
            batch['status'] = 'done'
        elapsed = time.time() - batch['start_time'] if batch['start_time'] else 0

    final_status = batch['status']
    _push_batch_event(bid, {
        'type': 'batch_done',
        'status': final_status,
        'completed_count': batch['completed_count'],
        'failed_count': batch['failed_count'],
        'skipped_count': batch['skipped_count'],
        'total_images': batch['total_images'],
        'elapsed_seconds': elapsed,
    })
    _save_batch_meta(bid)


def _video_worker(bid, vid):
    """单个视频的提取 worker"""
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
        'status': 'running',
        'message': '正在初始化…',
    })

    _last_meta_save = [time.time()]

    try:
        # 确保输出目录存在
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
            # 定期保存元数据
            now = time.time()
            if now - _last_meta_save[0] >= 10:
                _last_meta_save[0] = now
                _save_batch_meta(bid)

        def should_cancel():
            with batch['lock']:
                return batch['cancel_flag'] or task.get('cancel_flag', False)

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
            on_progress=on_progress,
            should_cancel=should_cancel,
        )

        with batch['lock']:
            task['saved_count'] = saved_count
            if status == 'done':
                task['status'] = 'done'
                task['progress'] = 100
                task['message'] = message
                batch['completed_count'] += 1
                batch['total_images'] += saved_count
            elif status == 'cancelled':
                if task.get('_pause_intent'):
                    task['status'] = 'paused'
                    task['message'] = '已暂停'
                    task['_pause_intent'] = False
                else:
                    task['status'] = 'cancelled'
                    task['message'] = message
            else:
                task['status'] = 'error'
                task['message'] = message
                task['error_message'] = message
                batch['failed_count'] += 1

        if task['status'] == 'done':
            event_type = 'video_done'
        elif task['status'] == 'paused':
            event_type = 'video_status'
        else:
            event_type = 'video_error'
        _push_batch_event(bid, {
            'type': event_type,
            'video_id': vid,
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
            'status': 'error',
            'message': err_msg,
            'global_progress': _calc_global_progress(batch),
        })

    finally:
        batch['worker_semaphore'].release()
        gc.collect()
        _save_batch_meta(bid)


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
            pass  # 队列满则丢弃


def generate_batch_sse(bid):
    """
    SSE 生成器，供 Flask 路由使用。
    返回 (generator, cleanup_fn)。
    """
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
            # 初始事件：发送完整状态快照
            state = get_batch_state(bid)
            if state:
                yield f'data: {json.dumps({"type": "init", "state": state}, ensure_ascii=False)}\n\n'

            while True:
                try:
                    event = event_q.get(timeout=15)
                except queue.Empty:
                    # 心跳保活
                    yield ': keepalive\n\n'
                    # 检查 batch 是否还存在
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
    """加权计算全局进度百分比（需在 batch['lock'] 外或内均可调用）"""
    try:
        tasks = batch['tasks']
        if not tasks:
            return 0
        total_frames = sum(t.get('total_frames', 0) for t in tasks)
        if total_frames == 0:
            # 无帧数信息时按任务数平均
            total = len(tasks)
            done = sum(1 for t in tasks if t['status'] in ('done', 'error', 'cancelled', 'skipped'))
            running_progress = sum(t['progress'] for t in tasks if t['status'] == 'running')
            running_count = sum(1 for t in tasks if t['status'] == 'running')
            return int((done * 100 + running_progress) / total) if total > 0 else 0
        # 按帧数加权
        weighted = 0
        for t in tasks:
            tf = t.get('total_frames', 0)
            if tf == 0:
                continue
            weight = tf / total_frames
            if t['status'] in ('done',):
                weighted += weight * 100
            elif t['status'] in ('error', 'cancelled', 'skipped'):
                weighted += weight * 100  # 视为已处理
            elif t['status'] == 'running':
                weighted += weight * t['progress']
        return int(weighted)
    except Exception:
        return 0


# ============================================================
#  缩略图生成
# ============================================================
def _generate_thumbnail(video_path, output_path, width=320):
    """从视频提取缩略图（取第 1 秒帧避开黑屏）"""
    try:
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            cap.release()
            return False
        fps = cap.get(cv2.CAP_PROP_FPS) or 25
        # 尝试第 1 秒的帧
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(fps))
        ok, frame = cap.read()
        if not ok or frame is None:
            # 降级到第 0 帧
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
        # 使用 imencode 支持 Unicode 路径
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
            return None
        thumb = os.path.join(task['output_dir'], 'thumbnail.jpg')
    if os.path.isfile(thumb):
        return thumb
    return None


# ============================================================
#  智能命名递增
# ============================================================
def auto_increment_name(base_name, count):
    """
    根据 base_name 中的数字模式自动生成 count 个递增名称。
    例如: "数学_第1节", 3 -> ["数学_第1节", "数学_第2节", "数学_第3节"]
    """
    if count <= 0:
        return []
    if count == 1:
        return [base_name]

    # 尝试匹配已知模式
    for pattern, ptype in _INCREMENT_PATTERNS:
        m = pattern.search(base_name)
        if m:
            if ptype in ('chinese_ordinal', 'parenthesized'):
                start_num = int(m.group(2))
            elif ptype == 'separator_num':
                start_num = int(m.group(2))
            else:  # trailing
                start_num = int(m.group(1))
            names = []
            for i in range(count):
                num = start_num + i
                if ptype == 'chinese_ordinal':
                    replacement = f'{m.group(1)}{num}{m.group(3)}'
                elif ptype == 'parenthesized':
                    replacement = f'{m.group(1)}{num}{m.group(3)}'
                elif ptype == 'separator_num':
                    # 保持分隔符 + 数字位数
                    sep = m.group(1)
                    orig_digits = m.group(2)
                    replacement = f'{sep}{str(num).zfill(len(orig_digits))}'
                else:  # trailing
                    orig_digits = m.group(1)
                    replacement = str(num).zfill(len(orig_digits))
                new_name = base_name[:m.start()] + replacement + base_name[m.end():]
                names.append(new_name)
            return names

    # 无匹配模式：追加 _1, _2, ...
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
    # 截断过长名称
    if len(safe) > 80:
        safe = safe[:80]
    # 去除尾部空格和点
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
    'completed_count', 'failed_count', 'skipped_count', 'total_images', 'start_time',
    'trashed_videos',
)

_TASK_SAVE_KEYS = (
    'id', 'video_path', 'display_name', 'status', 'progress', 'message',
    'saved_count', 'eta_seconds', 'elapsed_seconds', 'error_message',
    'retry_count', 'total_frames', 'last_frame_index', 'output_dir',
    'cache_dir', 'pkg_dir',
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
                meta['tasks'].append(task_meta)
            meta_path = os.path.join(batch['batch_dir'], 'batch.json')

        with open(meta_path, 'w', encoding='utf-8') as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f'[批量持久化] 保存失败: {e}')


def recover_batches_from_disk(sessions_root):
    """启动时从磁盘恢复批量队列"""
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
            batch = {
                'id': bid,
                'status': meta.get('status', 'idle'),
                'tasks': [],
                'params': meta.get('params', {}),
                'max_workers': meta.get('max_workers', 1),
                'created_at': meta.get('created_at', time.time()),
                'batch_dir': batch_dir,
                'lock': threading.RLock(),
                'event_queues': [],
                'pause_flag': False,
                'cancel_flag': False,
                'worker_semaphore': threading.Semaphore(meta.get('max_workers', 1)),
                'dispatcher_thread': None,
                'completed_count': meta.get('completed_count', 0),
                'failed_count': meta.get('failed_count', 0),
                'skipped_count': meta.get('skipped_count', 0),
                'total_images': meta.get('total_images', 0),
                'start_time': meta.get('start_time', 0),
                'trashed_videos': meta.get('trashed_videos', []),
            }
            # 恢复任务
            for tm in meta.get('tasks', []):
                task = {
                    'id': tm.get('id', uuid.uuid4().hex[:8]),
                    'video_path': tm.get('video_path', ''),
                    'display_name': tm.get('display_name', ''),
                    'status': tm.get('status', 'queued'),
                    'progress': tm.get('progress', 0),
                    'message': tm.get('message', ''),
                    'saved_count': tm.get('saved_count', 0),
                    'eta_seconds': tm.get('eta_seconds', -1),
                    'elapsed_seconds': tm.get('elapsed_seconds', 0),
                    'error_message': tm.get('error_message', ''),
                    'retry_count': tm.get('retry_count', 0),
                    'cancel_flag': False,
                    'total_frames': tm.get('total_frames', 0),
                    'last_frame_index': tm.get('last_frame_index', 0),
                    'output_dir': tm.get('output_dir', ''),
                    'cache_dir': tm.get('cache_dir', ''),
                    'pkg_dir': tm.get('pkg_dir', ''),
                }
                # running 状态恢复为 error（中断了）
                if task['status'] == 'running':
                    task['status'] = 'error'
                    task['error_message'] = '程序重启，任务中断'
                    batch['failed_count'] += 1
                    batch['completed_count'] = max(0, batch['completed_count'])
                # 验证输出目录存在
                if task['output_dir'] and os.path.isdir(task['output_dir']):
                    # 重新计算 saved_count
                    cache = task.get('cache_dir', '')
                    if cache and os.path.isdir(cache):
                        actual = len([f for f in os.listdir(cache)
                                      if f.lower().endswith(('.jpg', '.jpeg', '.png'))])
                        task['saved_count'] = actual
                batch['tasks'].append(task)

            # 如果 batch 是 running 状态，标记为 paused（需要用户手动恢复）
            if batch['status'] == 'running':
                batch['status'] = 'paused'
                batch['pause_flag'] = True

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
        if task['status'] != 'done':
            return None, '视频尚未完成处理'
        cache_dir = task['cache_dir']
        pkg_dir = task['pkg_dir']
        display_name = task['display_name']

    # 收集图片
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
        done_tasks = [t for t in batch['tasks'] if t['status'] == 'done' and t['saved_count'] > 0]
        if video_ids:
            vid_set = set(video_ids)
            done_tasks = [t for t in done_tasks if t['id'] in vid_set]
        batch_dir = batch['batch_dir']

    if not done_tasks:
        return None, '没有已完成的视频'

    fmt_label = fmt.upper() if fmt in ('pdf', 'pptx') else 'ZIP'
    output_path = os.path.join(batch_dir, f'批量导出_{fmt_label}_{batch["id"]}.zip')
    total = len(done_tasks)

    # 去重 display_name，防止 ZIP 内文件夹/文件名冲突
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
    # 如果第一个也有重复，补上 _1
    for dn, cnt in name_counts.items():
        if cnt > 1:
            for task in done_tasks:
                if task['display_name'] == dn and unique_names[task['id']] == dn:
                    unique_names[task['id']] = f'{dn}_1'
                    break

    try:
        if fmt in ('pdf', 'pptx'):
            # 先为每个视频生成对应格式文件，再打包进 ZIP
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

            # 打包所有生成的文件
            _push_batch_event(bid, {
                'type': 'batch_packaging',
                'progress': 85,
                'message': '正在打包为 ZIP…',
            })
            with _zipfile.ZipFile(output_path, 'w', _zipfile.ZIP_DEFLATED) as zf:
                for filepath, arcname in generated_files:
                    zf.write(filepath, arcname)
        else:
            # fmt='zip': 原始图片按文件夹打包
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
            return []
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
            return None
        cache_dir = task['cache_dir']
    # 安全检查：防止路径穿越
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
        # 更新 saved_count
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
#  视频回收站（统一：已完成 + 已取消）
# ============================================================
def trash_video(bid, vid):
    """将已完成/已取消的视频移入回收站"""
    batch = get_batch(bid)
    if not batch:
        return False, '批量队列不存在'
    with batch['lock']:
        task = _find_task(batch, vid)
        if not task:
            return False, '视频不存在'
        if task['status'] not in ('done', 'cancelled', 'error', 'skipped'):
            return False, f'状态 {task["status"]} 不可移入回收站'
        # 保存元数据快照
        snap = {k: task[k] for k in _TASK_SAVE_KEYS if k in task}
        snap['trashed_at'] = time.time()
        snap['trash_reason'] = task['status']
        batch['trashed_videos'].append(snap)
        batch['tasks'].remove(task)
        # 更新统计
        if task['status'] == 'done':
            batch['completed_count'] = max(0, batch['completed_count'] - 1)
            batch['total_images'] = max(0, batch['total_images'] - task['saved_count'])
        elif task['status'] in ('error', 'skipped'):
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
            pass  # 文件移动失败不影响逻辑状态
    _save_batch_meta(bid)
    return True, 'ok'


def restore_video(bid, vid):
    """从回收站恢复视频"""
    batch = get_batch(bid)
    if not batch:
        return False, '批量队列不存在'
    snap = None
    with batch['lock']:
        for i, s in enumerate(batch['trashed_videos']):
            if s['id'] == vid:
                snap = batch['trashed_videos'].pop(i)
                break
    if not snap:
        return False, '回收站中无此视频'

    # 恢复文件
    video_trash_dir = os.path.join(batch['batch_dir'], '.video_trash')
    src_dir = os.path.join(video_trash_dir, os.path.basename(snap.get('output_dir', '')))
    dst_dir = snap.get('output_dir', '')
    if os.path.isdir(src_dir) and dst_dir:
        try:
            shutil.move(src_dir, dst_dir)
        except Exception:
            pass

    # 重建 task 对象
    task = {
        'id': snap.get('id', uuid.uuid4().hex[:8]),
        'video_path': snap.get('video_path', ''),
        'display_name': snap.get('display_name', ''),
        'status': snap.get('trash_reason', snap.get('status', 'done')),
        'progress': snap.get('progress', 0),
        'message': snap.get('message', ''),
        'saved_count': snap.get('saved_count', 0),
        'eta_seconds': snap.get('eta_seconds', -1),
        'elapsed_seconds': snap.get('elapsed_seconds', 0),
        'error_message': snap.get('error_message', ''),
        'retry_count': snap.get('retry_count', 0),
        'cancel_flag': False,
        'total_frames': snap.get('total_frames', 0),
        'last_frame_index': snap.get('last_frame_index', 0),
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
        batch['tasks'].append(task)
        # 恢复统计
        if task['status'] == 'done':
            batch['completed_count'] += 1
            batch['total_images'] += task['saved_count']
        elif task['status'] in ('error', 'skipped'):
            batch['failed_count'] += 1

    _save_batch_meta(bid)
    return True, 'ok'


def restore_all_videos(bid):
    """恢复所有回收站中的视频"""
    batch = get_batch(bid)
    if not batch:
        return 0
    with batch['lock']:
        vids = [s['id'] for s in batch['trashed_videos']]
    count = 0
    for vid in vids:
        ok, _ = restore_video(bid, vid)
        if ok:
            count += 1
    return count


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
#  单视频取消（扩展：支持 running 状态）
# ============================================================
def cancel_video(bid, vid, auto_trash=False, skip=False, pause=False):
    """
    取消/跳过/暂停单个视频。
    - queued: 直接标记为 cancelled 或 skipped（skip=True 时）
    - running: 设置 task 级别 cancel_flag，worker 会检测并中断
      - pause=True 时标记暂停意图，worker 完成后状态为 paused 而非 cancelled
    auto_trash=True 时取消后自动移入回收站。
    """
    batch = get_batch(bid)
    if not batch:
        return False, '批量队列不存在'
    with batch['lock']:
        task = _find_task(batch, vid)
        if not task:
            return False, '视频不存在'
        if task['status'] == 'queued':
            task['status'] = 'skipped' if skip else 'cancelled'
            task['message'] = '已跳过' if skip else '已取消'
        elif task['status'] == 'running':
            task['cancel_flag'] = True
            task['_pause_intent'] = pause
            task['message'] = '正在暂停…' if pause else '正在取消…'
            # worker 会在 should_cancel 回调中检测到并中断
        else:
            return False, f'状态 {task["status"]} 不可取消'

    _push_batch_event(bid, {
        'type': 'video_status',
        'video_id': vid,
        'status': task['status'],
        'message': task['message'],
    })
    _save_batch_meta(bid)

    # 如果是 queued 且需要自动移入回收站
    if auto_trash and task['status'] in ('cancelled', 'skipped'):
        trash_video(bid, vid)

    return True, 'ok'


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

    # 通知所有 SSE 客户端关闭
    with batch['lock']:
        for eq in batch['event_queues']:
            try:
                eq.put_nowait({'type': 'close'})
            except queue.Full:
                pass
        batch['event_queues'].clear()
        batch['cancel_flag'] = True

    # 删除文件
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
            result.append({
                'id': state['id'],
                'status': state['status'],
                'task_count': len(state['tasks']),
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
