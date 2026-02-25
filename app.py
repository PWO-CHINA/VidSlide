"""
影幻智提 (VidSlide) - PPT 幻灯片智能提取工具 (v0.3.2)
=====================================================
基于 Flask 的本地 Web 应用，提供可视化界面来提取、管理和打包 PPT 幻灯片。
支持同时对多个视频进行提取（最多 3 个并行标签页）。

v0.3.2 新特性：
    - SSE (Server-Sent Events) 服务器推送，替代高频轮询
    - 异步后台打包导出，前端实时显示打包进度
    - GPU 硬件加速视频解码（自动检测）
    - 进程优先级自动降低，减少对前台任务的影响
    - 代码 MVC 拆分：extractor.py + exporter.py + app.py
    - 前端 DocumentFragment 批量渲染优化

使用方法：
    python app.py

依赖安装：
    pip install flask opencv-python numpy pillow python-pptx psutil

作者: PWO-CHINA
版本: v0.3.2
"""

import cv2
import json
import os
import queue
import sys
import shutil
import threading
import time
import uuid
import webbrowser
import socket
import traceback
from pathlib import Path

from flask import (Flask, request, jsonify, send_file,
                   send_from_directory, render_template, Response)

# 导入拆分后的功能模块
from extractor import extract_slides
from exporter import package_images

# ============================================================
#  无控制台模式兼容
# ============================================================
if sys.stdout is None:
    sys.stdout = open(os.devnull, 'w', encoding='utf-8')
if sys.stderr is None:
    sys.stderr = open(os.devnull, 'w', encoding='utf-8')

try:
    import psutil
    HAS_PSUTIL = True
except ImportError:
    HAS_PSUTIL = False
    print("⚠️  未安装 psutil，系统资源监控将不可用。安装命令: pip install psutil")


# ============================================================
#  PyInstaller / Nuitka 兼容：资源路径寻路
# ============================================================
def _is_frozen():
    """判断是否以打包后的 exe 运行（PyInstaller 或 Nuitka）"""
    return (getattr(sys, 'frozen', False)
            or hasattr(sys, '_MEIPASS')
            or '__compiled__' in globals())


def get_resource_path(relative_path):
    """获取打包后的资源文件路径"""
    if hasattr(sys, '_MEIPASS'):
        return os.path.join(sys._MEIPASS, relative_path)
    return os.path.join(os.path.abspath(os.path.dirname(__file__)), relative_path)


# ============================================================
#  配置
# ============================================================
TEMPLATE_DIR = get_resource_path('templates')
STATIC_DIR = get_resource_path('static')

if _is_frozen():
    BASE_DIR = os.path.dirname(os.path.abspath(sys.executable))
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))

SESSIONS_ROOT = os.path.join(BASE_DIR, '.vidslide_sessions')

# ── 根据机器配置动态计算最大标签页数量 ──
def _compute_max_sessions():
    """根据 CPU 核数和可用内存动态计算最大并行标签页数量"""
    base = 3  # 默认值
    try:
        if HAS_PSUTIL:
            cpu_count = psutil.cpu_count(logical=True) or 4
            mem = psutil.virtual_memory()
            mem_gb = mem.total / (1024 ** 3)
            # 根据 CPU 核数：每 4 核 +1（基于 2 核起步）
            cpu_budget = max(1, cpu_count // 4 + 1)
            # 根据内存：每 4GB +1（基于 4GB 起步）
            mem_budget = max(1, int(mem_gb // 4))
            # 取两者较小值，但最少 2，最多 8
            base = max(2, min(8, cpu_budget, mem_budget))
            print(f'[配置] CPU {cpu_count} 核, 内存 {mem_gb:.1f} GB → 最大标签页 {base}')
        else:
            base = 3
    except Exception:
        base = 3
    return base

MAX_SESSIONS = _compute_max_sessions()

# 孤儿会话超时时间（秒）：会话无活跃 SSE 连接超过此时间后被视为孤儿
ORPHAN_SESSION_TIMEOUT = 60

app = Flask(__name__, template_folder=TEMPLATE_DIR, static_folder=STATIC_DIR)


# ============================================================
#  全局错误处理 & CORS
# ============================================================
@app.after_request
def after_request(response):
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    return response


@app.errorhandler(Exception)
def handle_error(e):
    traceback.print_exc()
    return jsonify(
        success=False,
        message=f'服务器内部错误: {str(e)}',
        error_type=type(e).__name__,
        hint='如果问题持续出现，请前往 https://github.com/PWO-CHINA/VidSlide/issues 提交 Issue，'
             '并附上此错误信息的截图。'
    ), 500


# ============================================================
#  多会话状态管理 (线程安全)
# ============================================================
_sessions_lock = threading.Lock()
_sessions = {}

CPU_WARN_THRESHOLD = 90
MEMORY_WARN_THRESHOLD = 85
DISK_WARN_THRESHOLD_MB = 500

# ── 后台 CPU 采样 ──
_cpu_cache = {'percent': 0.0}


def _cpu_sampler_loop():
    if not HAS_PSUTIL:
        return
    psutil.cpu_percent(interval=1)
    while True:
        try:
            _cpu_cache['percent'] = psutil.cpu_percent(interval=0)
        except Exception:
            pass
        time.sleep(2)

_cpu_sampler_thread = threading.Thread(target=_cpu_sampler_loop, daemon=True)
_cpu_sampler_thread.start()


# ── 后台 GPU 采样（nvidia-smi 优先，Windows PDH 计数器兜底）──
import subprocess as _subprocess
_gpu_cache = {'available': False, 'name': '', 'util': 0, 'mem_used': 0, 'mem_total': 0, 'temperature': 0}
_CF = 0x08000000 if os.name == 'nt' else 0   # CREATE_NO_WINDOW


def _detect_gpu_name_and_vram():
    """通过 WMI 检测 GPU 名称和显存总量（适用于所有 GPU）"""
    try:
        r = _subprocess.run(
            ['wmic', 'path', 'win32_VideoController', 'get', 'name,AdapterRAM', '/format:csv'],
            capture_output=True, text=True, timeout=10, creationflags=_CF)
        for line in r.stdout.strip().split('\n'):
            parts = [p.strip() for p in line.split(',')]
            if len(parts) >= 3 and parts[2] not in ('Name', '') and 'Virtual' not in parts[2]:
                name = parts[2]
                ram_mb = int(parts[1]) // (1024 * 1024) if parts[1].isdigit() else 0
                return name, ram_mb
    except Exception:
        pass
    return '', 0


def _discover_pdh_counters():
    """检测是否有 GPU PDH 计数器可用（快速探测）"""
    try:
        r = _subprocess.run(['typeperf', '-qx', 'GPU Engine'],
                            capture_output=True, text=True, timeout=10, creationflags=_CF)
        if 'Utilization Percentage' in r.stdout:
            return True
    except Exception:
        pass
    return False


# 持久化的通配符计数器文件路径
_pdh_counter_file = None


def _init_pdh_counter_file():
    """创建包含通配符计数器的临时文件，typeperf 会自动展开匹配所有当前进程"""
    global _pdh_counter_file
    import tempfile
    # 通配符方式：自动匹配所有进程/引擎实例，无需静态发现
    wildcard_counters = [
        r'\GPU Engine(*)\Utilization Percentage',
        r'\GPU Adapter Memory(*)\Dedicated Usage',
        r'\GPU Adapter Memory(*)\Shared Usage',
    ]
    tf = tempfile.NamedTemporaryFile(
        mode='w', suffix='.txt', delete=False,
        encoding='utf-8', prefix='vidslide_gpu_')
    for c in wildcard_counters:
        tf.write(c + '\n')
    tf.close()
    _pdh_counter_file = tf.name
    import atexit
    atexit.register(lambda: _safe_unlink(_pdh_counter_file))
    return _pdh_counter_file


def _safe_unlink(path):
    try:
        os.unlink(path)
    except Exception:
        pass


def _sample_pdh_counters():
    """通过 typeperf -cf 通配符文件 采样 GPU 使用率和显存
    通配符每次采样自动匹配所有当前运行的进程/引擎实例。
    利用率算法：按物理引擎（luid+phys+eng_N）分组 SUM 各进程占用，再取所有引擎的 MAX。
    这与 Windows 任务管理器的计算方式一致。
    """
    import re
    util = 0
    mem_used_mb = 0

    if not _pdh_counter_file:
        return util, mem_used_mb

    try:
        r = _subprocess.run(
            ['typeperf', '-cf', _pdh_counter_file, '-sc', '1'],
            capture_output=True, text=True, timeout=30, creationflags=_CF)
        out_lines = r.stdout.strip().split('\n')
        if len(out_lines) < 2:
            return util, mem_used_mb

        # 解析表头，确定每列的类型
        header_cols = [c.strip('"') for c in out_lines[0].split('","')]
        data_line = None
        for line in out_lines[1:]:
            if line.startswith('"') and not line.startswith('"(PDH'):
                data_line = line
                break
        if not data_line:
            return util, mem_used_mb

        data_vals = [v.strip('" ') for v in data_line.split('","')]

        engine_sum = {}   # "luid_..._phys_N_eng_N" -> sum of utilization
        max_dedicated = 0.0
        max_shared = 0.0

        for i in range(1, len(header_cols)):
            cname = header_cols[i] if i < len(header_cols) else ''
            try:
                fv = float(data_vals[i]) if i < len(data_vals) else 0.0
            except (ValueError, TypeError):
                continue

            if 'GPU Engine' in cname:
                # 提取物理引擎 ID（不含 PID，含 luid+phys+eng_N）
                m = re.search(r'luid_\w+_phys_\d+_eng_\d+', cname)
                eng_key = m.group(0) if m else str(i)
                engine_sum[eng_key] = engine_sum.get(eng_key, 0.0) + fv
            elif 'Dedicated Usage' in cname:
                if fv > max_dedicated:
                    max_dedicated = fv
            elif 'Shared Usage' in cname:
                if fv > max_shared:
                    max_shared = fv

        # 取所有物理引擎中最高的利用率（与任务管理器一致）
        util = min(100, round(max(engine_sum.values()))) if engine_sum else 0
        # 核显 Dedicated≈0，用 Shared；独显 Dedicated>0，用 Dedicated
        best_mem = max_dedicated if max_dedicated > 0 else max_shared
        mem_used_mb = round(best_mem / (1024 * 1024))
    except Exception:
        pass
    return util, mem_used_mb



def _gpu_sampler_loop():
    """GPU 后台采样主循环，优先 nvidia-smi，不可用时回退 Windows PDH"""
    import traceback as _tb
    try:
        _gpu_sampler_loop_inner()
    except Exception:
        print(f'[GPU监控] 线程异常退出:\n{_tb.format_exc()}', flush=True)


def _gpu_sampler_loop_inner():
    # ── 第一优先：nvidia-smi（NVIDIA 独显）──
    use_nvidia = False
    try:
        test = _subprocess.run(
            ['nvidia-smi', '--query-gpu=name', '--format=csv,noheader,nounits'],
            capture_output=True, text=True, timeout=5, creationflags=_CF)
        if test.returncode == 0 and test.stdout.strip():
            _gpu_cache['name'] = test.stdout.strip().split('\n')[0]
            _gpu_cache['available'] = True
            use_nvidia = True
            print(f'[GPU监控] 检测到 NVIDIA GPU: {_gpu_cache["name"]}（使用 nvidia-smi）', flush=True)
    except FileNotFoundError:
        pass
    except Exception as e:
        print(f'[GPU监控] nvidia-smi 检测失败: {e}', flush=True)

    if use_nvidia:
        while True:
            try:
                r = _subprocess.run(
                    ['nvidia-smi',
                     '--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu',
                     '--format=csv,noheader,nounits'],
                    capture_output=True, text=True, timeout=5, creationflags=_CF)
                if r.returncode == 0:
                    parts = r.stdout.strip().split('\n')[0].split(', ')
                    if len(parts) >= 4:
                        _gpu_cache['util'] = int(parts[0].strip())
                        _gpu_cache['mem_used'] = int(parts[1].strip())
                        _gpu_cache['mem_total'] = int(parts[2].strip())
                        _gpu_cache['temperature'] = int(parts[3].strip())
            except Exception:
                pass
            time.sleep(3)
        return  # 不会执行到这里

    # ── 第二优先：Windows PDH 计数器（Intel / AMD / 集成显卡）──
    if os.name != 'nt':
        print('[GPU监控] 非 Windows 系统且无 nvidia-smi，GPU 监控已禁用', flush=True)
        return

    gpu_name, gpu_vram = _detect_gpu_name_and_vram()
    if not gpu_name:
        print('[GPU监控] 未检测到 GPU，GPU 监控已禁用', flush=True)
        return

    has_pdh = _discover_pdh_counters()
    if not has_pdh:
        print(f'[GPU监控] 检测到 {gpu_name}，但无法读取 GPU 性能计数器', flush=True)
        _gpu_cache['name'] = gpu_name
        _gpu_cache['mem_total'] = gpu_vram
        _gpu_cache['available'] = True
        return

    # 初始化通配符计数器文件（自动匹配所有当前及新增进程的 GPU 引擎）
    cf_path = _init_pdh_counter_file()

    _gpu_cache['name'] = gpu_name
    _gpu_cache['mem_total'] = gpu_vram
    _gpu_cache['available'] = True
    print(f'[GPU监控] 检测到 {gpu_name}（{gpu_vram} MB），使用 Windows PDH 通配符计数器', flush=True)
    print(f'[GPU监控] 计数器文件: {cf_path}', flush=True)
    print(f'[GPU监控] 采用通配符模式，自动追踪所有进程的 GPU 引擎使用率', flush=True)

    while True:
        try:
            util, mem_used = _sample_pdh_counters()
            _gpu_cache['util'] = util
            _gpu_cache['mem_used'] = mem_used
            # 核显共享内存可能超过 WMI 报告的 dedicated VRAM，动态校正上限
            if mem_used > _gpu_cache['mem_total']:
                _gpu_cache['mem_total'] = mem_used
        except Exception:
            pass
        time.sleep(5)  # PDH 采样较慢，间隔稍长


_gpu_sampler_thread = threading.Thread(target=_gpu_sampler_loop, daemon=True)
_gpu_sampler_thread.start()


_SESSION_EXCLUDE_KEYS = frozenset({'lock', 'event_queues'})


def _create_session():
    sid = uuid.uuid4().hex[:8]
    cache_dir = os.path.join(SESSIONS_ROOT, sid, 'cache')
    pkg_dir = os.path.join(SESSIONS_ROOT, sid, 'packages')
    os.makedirs(cache_dir, exist_ok=True)
    os.makedirs(pkg_dir, exist_ok=True)

    session = {
        'id': sid,
        'created_at': time.time(),
        'last_active': time.time(),  # 用于孤儿检测
        # ── 提取状态 ──
        'status': 'idle',
        'progress': 0,
        'message': '',
        'saved_count': 0,
        'video_path': '',
        'video_name': '',
        'cancel_flag': False,
        'eta_seconds': -1,
        'elapsed_seconds': 0,
        # ── 打包状态 ──
        'pkg_status': 'idle',
        'pkg_progress': 0,
        'pkg_message': '',
        'pkg_filename': '',
        'pkg_format': '',
        # ── 目录 ──
        'cache_dir': cache_dir,
        'pkg_dir': pkg_dir,
        # ── 同步原语 ──
        'lock': threading.Lock(),
        'event_queues': [],   # SSE 事件队列列表
    }
    with _sessions_lock:
        _sessions[sid] = session
    return sid


def _get_session(sid):
    with _sessions_lock:
        return _sessions.get(sid)


def _get_session_state(sid):
    sess = _get_session(sid)
    if not sess:
        return None
    with sess['lock']:
        return {k: v for k, v in sess.items() if k not in _SESSION_EXCLUDE_KEYS}


def _update_session(sid, **kw):
    sess = _get_session(sid)
    if not sess:
        return
    with sess['lock']:
        sess.update(kw)


def _delete_session(sid):
    with _sessions_lock:
        sess = _sessions.pop(sid, None)
    if sess:
        # 关闭所有 SSE 连接
        with sess['lock']:
            for eq in sess.get('event_queues', []):
                try:
                    eq.put_nowait({'type': 'close'})
                except queue.Full:
                    pass
            sess['event_queues'].clear()
        session_dir = os.path.join(SESSIONS_ROOT, sid)
        if os.path.exists(session_dir):
            shutil.rmtree(session_dir, ignore_errors=True)


def _get_all_sessions_summary():
    with _sessions_lock:
        sids = list(_sessions.keys())
    result = []
    for sid in sids:
        state = _get_session_state(sid)
        if state:
            result.append({
                'id': state['id'],
                'status': state['status'],
                'progress': state['progress'],
                'message': state['message'],
                'saved_count': state['saved_count'],
                'video_path': state['video_path'],
                'video_name': state['video_name'],
                'eta_seconds': state['eta_seconds'],
                'elapsed_seconds': state['elapsed_seconds'],
                'pkg_status': state.get('pkg_status', 'idle'),
                'pkg_progress': state.get('pkg_progress', 0),
            })
    return result


def _count_running():
    with _sessions_lock:
        sids = list(_sessions.keys())
    count = 0
    for sid in sids:
        sess = _get_session(sid)
        if sess:
            with sess['lock']:
                if sess['status'] == 'running':
                    count += 1
    return count


# ============================================================
#  SSE 事件推送
# ============================================================
def _push_event(sid, event_data):
    """向某个会话的所有 SSE 客户端推送事件"""
    sess = _get_session(sid)
    if not sess:
        return
    with sess['lock']:
        queues = sess.get('event_queues', [])[:]
    for eq in queues:
        try:
            eq.put_nowait(event_data)
        except queue.Full:
            pass  # 队列满了就丢弃


# 心跳 — 提高超时容忍度，避免浏览器后台节流导致误判退出
_last_heartbeat = 0.0
_heartbeat_received = False
HEARTBEAT_TIMEOUT = 300  # 5 分钟：浏览器后台标签页会大幅节流 setInterval


# ============================================================
#  路由 — 页面
# ============================================================
@app.route('/')
def index():
    return render_template('index.html')


# ============================================================
#  路由 — 会话管理
# ============================================================
@app.route('/api/sessions', methods=['GET'])
def list_sessions():
    return jsonify(success=True, sessions=_get_all_sessions_summary(), max_sessions=MAX_SESSIONS)


def _cleanup_orphan_sessions():
    """清理孤儿会话：无活跃 SSE 连接的会话。
    当浏览器标签页被关闭时，SSE 连接会断开，event_queues 会被清空。
    此函数在创建新会话前和前端初始化时调用，确保不会因为残留的孤儿会话
    而错误地阻止用户新建标签页。

    清理策略：
    - 空闲会话（无任务、无成果）：立即清理
    - 有成果但无 SSE 超时的会话：超时后清理
    - 正在运行任务但无 SSE 超时的会话：先取消任务再清理
    """
    now = time.time()
    with _sessions_lock:
        sids = list(_sessions.keys())
    orphans = []
    for sid in sids:
        sess = _get_session(sid)
        if not sess:
            continue
        with sess['lock']:
            has_sse = len(sess.get('event_queues', [])) > 0
            is_running = sess['status'] == 'running'
            is_packaging = sess.get('pkg_status') == 'running'
            has_results = sess.get('saved_count', 0) > 0
            age = now - sess.get('last_active', sess['created_at'])

        # 有活跃 SSE 连接 → 不是孤儿
        if has_sse:
            continue

        # 无 SSE 连接的情况：
        if is_running or is_packaging:
            # 正在运行，但没有前端连接且超时 → 取消任务并清理
            if age > ORPHAN_SESSION_TIMEOUT:
                with sess['lock']:
                    sess['cancel_flag'] = True
                orphans.append(sid)
        else:
            # 非运行状态：空闲或已完成
            if not has_results or age > ORPHAN_SESSION_TIMEOUT:
                orphans.append(sid)

    for sid in orphans:
        print(f'[会话清理] 清理孤儿会话: {sid}')
        _delete_session(sid)
    return len(orphans)


@app.route('/api/sessions/cleanup-stale', methods=['POST'])
def cleanup_stale_sessions():
    """前端初始化时调用，清理所有孤儿会话（无活跃前端的残留会话）"""
    cleaned = _cleanup_orphan_sessions()
    with _sessions_lock:
        current_count = len(_sessions)
    return jsonify(success=True, cleaned=cleaned, remaining=current_count, max_sessions=MAX_SESSIONS)


@app.route('/api/session/create', methods=['POST'])
def create_session():
    # 创建前先尝试清理孤儿会话
    _cleanup_orphan_sessions()

    with _sessions_lock:
        current_count = len(_sessions)
    if current_count >= MAX_SESSIONS:
        return jsonify(success=False,
                       message=f'已达到最大标签页数量（{MAX_SESSIONS}个）。请先关闭不需要的标签页。')

    warning = _check_resource_warning()
    if warning:
        return jsonify(success=False, message=f'系统资源不足，无法新建标签页：{warning}')

    sid = _create_session()
    return jsonify(success=True, session_id=sid)


@app.route('/api/session/<sid>/close', methods=['POST'])
def close_session(sid):
    sess = _get_session(sid)
    if not sess:
        return jsonify(success=False, message='会话不存在')
    with sess['lock']:
        is_running = sess['status'] == 'running'
        is_packaging = sess.get('pkg_status') == 'running'
        if is_running:
            sess['cancel_flag'] = True
    # 如果有任务正在执行，不立即删除（让任务自然结束后由孤儿清理回收）
    # 只断开 SSE 连接，让后台孤儿清理线程在任务完成后处理
    if is_running or is_packaging:
        with sess['lock']:
            for eq in sess.get('event_queues', []):
                try:
                    eq.put_nowait({'type': 'close'})
                except queue.Full:
                    pass
            sess['event_queues'].clear()
        return jsonify(success=True, deferred=True)
    # 无活跃任务则直接删除
    _delete_session(sid)
    return jsonify(success=True)


# ============================================================
#  路由 — SSE 服务器推送
# ============================================================
@app.route('/api/session/<sid>/events')
def session_events(sid):
    sess = _get_session(sid)
    if not sess:
        return jsonify(success=False, message='会话不存在'), 404

    event_q = queue.Queue(maxsize=200)

    with sess['lock']:
        sess['event_queues'].append(event_q)
        sess['last_active'] = time.time()  # SSE 连接时更新活跃时间

    def _cleanup():
        try:
            with sess['lock']:
                if event_q in sess['event_queues']:
                    sess['event_queues'].remove(event_q)
        except Exception:
            pass

    def generate():
        try:
            # 推送当前状态（用于 SSE 重连恢复）
            state = _get_session_state(sid)
            if state:
                yield f"data: {json.dumps({'type': 'init', 'state': state}, ensure_ascii=False)}\n\n"

            while True:
                try:
                    event = event_q.get(timeout=15)
                    if event.get('type') == 'close':
                        break
                    # 每次推送事件时更新会话活跃时间
                    try:
                        with sess['lock']:
                            sess['last_active'] = time.time()
                    except Exception:
                        pass
                    yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
                except queue.Empty:
                    # 心跳保持连接
                    yield ": keepalive\n\n"
                    if not _get_session(sid):
                        break
        except GeneratorExit:
            pass
        finally:
            _cleanup()

    resp = Response(generate(), mimetype='text/event-stream')
    resp.headers['Cache-Control'] = 'no-cache'
    resp.headers['X-Accel-Buffering'] = 'no'
    resp.headers['Connection'] = 'keep-alive'
    return resp


# ============================================================
#  路由 — 选择视频
# ============================================================
_video_select_lock = threading.Lock()

@app.route('/api/select-video', methods=['POST'])
def select_video():
    if not _video_select_lock.acquire(blocking=False):
        return jsonify(success=False, message='其他标签页正在选择文件，请先完成或关闭弹窗')
    try:
        try:
            import ctypes
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except Exception:
            try:
                import ctypes
                ctypes.windll.user32.SetProcessDPIAware()
            except Exception:
                pass

        import tkinter as tk
        from tkinter import filedialog
        import queue as stdlib_queue

        result_queue = stdlib_queue.Queue()

        def _pick():
            try:
                root = tk.Tk()
                root.withdraw()
                root.wm_attributes('-topmost', 1)
                root.focus_force()
                path = filedialog.askopenfilename(
                    title="请选择要提取的课程视频",
                    filetypes=[
                        ("视频文件", "*.mp4 *.avi *.mkv *.mov *.flv *.wmv *.webm"),
                        ("所有文件", "*.*"),
                    ],
                )
                root.destroy()
                result_queue.put(path or '')
            except Exception as e:
                print(f'[DEBUG] tkinter 弹窗异常: {e}')
                result_queue.put('')

        t = threading.Thread(target=_pick, daemon=True)
        t.start()
        t.join(timeout=120)

        path = result_queue.get_nowait() if not result_queue.empty() else ''

        if path:
            print(f'[DEBUG] 用户选择了视频: {path}')
            return jsonify(success=True, path=path)
        return jsonify(success=False, message='未选择文件')
    except Exception as e:
        print(f'[ERROR] select_video 异常: {e}')
        return jsonify(success=False, message=str(e))
    finally:
        _video_select_lock.release()


# ============================================================
#  路由 — 开始提取
# ============================================================
@app.route('/api/session/<sid>/extract', methods=['POST'])
def start_extraction(sid):
    sess = _get_session(sid)
    if not sess:
        return jsonify(success=False, message='会话不存在')

    with sess['lock']:
        if sess['status'] == 'running':
            return jsonify(success=False, message='该标签页正在提取中，请等待完成或取消')

    warning = _check_resource_warning()
    if warning:
        return jsonify(success=False, message=f'系统资源不足：{warning}\n请等待其他任务完成或关闭不需要的标签页。')

    data = request.json or {}
    video_path = data.get('video_path', '')
    print(f'[DEBUG][{sid}] 收到提取请求，视频路径: {repr(video_path)}')

    threshold = float(data.get('threshold', 5.0))
    enable_history = bool(data.get('enable_history', False))
    max_history = int(data.get('max_history', 5))
    use_roi = bool(data.get('use_roi', True))
    fast_mode = bool(data.get('fast_mode', True))
    use_gpu = bool(data.get('use_gpu', True))
    speed_mode = data.get('speed_mode', 'eco')  # 'eco' | 'fast' | 'turbo'

    if not video_path:
        return jsonify(success=False, message='未提供视频路径')

    if not os.path.exists(video_path):
        return jsonify(success=False, message=f'视频文件不存在: {video_path}',
                       hint='请检查文件是否已被移动或删除，然后重新选择视频。')

    # ── 视频文件预检测 ──
    try:
        _test_cap = cv2.VideoCapture(video_path)
        if not _test_cap.isOpened():
            _test_cap.release()
            return jsonify(success=False,
                           message='无法打开视频文件，可能文件已损坏或格式不支持。',
                           hint='建议：1) 检查文件是否完整下载；2) 尝试用播放器打开验证；'
                                '3) 如果是 m3u8 格式，请先用猫抓完整下载为 mp4。')
        _test_ok, _test_frame = _test_cap.read()
        _fourcc = int(_test_cap.get(cv2.CAP_PROP_FOURCC))
        _codec = ''.join([chr((_fourcc >> 8 * i) & 0xFF) for i in range(4)]) if _fourcc else 'N/A'
        _total = int(_test_cap.get(cv2.CAP_PROP_FRAME_COUNT))
        _fps = _test_cap.get(cv2.CAP_PROP_FPS) or 0
        _test_cap.release()
        if not _test_ok or _test_frame is None:
            return jsonify(success=False,
                           message=f'视频解码失败（编解码器: {_codec}）。',
                           hint='可能原因：1) 视频编码不被 OpenCV 支持；2) 文件不完整。'
                                '建议：尝试用 FFmpeg 转码为 mp4 后重试。')
        if _total < 10 or _fps <= 0:
            return jsonify(success=False,
                           message=f'视频信息异常：帧数={_total}，FPS={_fps:.1f}。',
                           hint='该文件可能不是有效的视频文件，或已严重损坏。')
        print(f'[DEBUG][{sid}] 视频预检通过: codec={_codec}, frames={_total}, fps={_fps:.1f}')
    except cv2.error as e:
        return jsonify(success=False,
                       message=f'OpenCV 视频检测出错: {str(e)}',
                       hint='可能是视频编码不兼容。建议用 FFmpeg 转码为 H.264 mp4 后重试。')
    except Exception as e:
        return jsonify(success=False,
                       message=f'视频文件预检测失败: {str(e)}',
                       hint='请确认文件路径正确且文件未被其他程序占用。')

    cache_dir = sess['cache_dir']
    if os.path.exists(cache_dir):
        shutil.rmtree(cache_dir)
    os.makedirs(cache_dir, exist_ok=True)

    video_name = Path(video_path).stem or '未命名视频'
    _update_session(sid,
        status='running', progress=0, message='正在初始化…',
        saved_count=0, video_path=video_path, video_name=video_name,
        cancel_flag=False, eta_seconds=-1, elapsed_seconds=0,
    )

    threading.Thread(
        target=_extraction_worker,
        args=(sid, video_path, cache_dir, threshold, enable_history, max_history, use_roi, fast_mode, use_gpu, speed_mode),
        daemon=True,
    ).start()

    return jsonify(success=True)


# ============================================================
#  后台提取 Worker（调用 extractor 模块 + SSE 推送）
# ============================================================
def _extraction_worker(sid, video_path, cache_dir, threshold, enable_history, max_history, use_roi, fast_mode, use_gpu=True, speed_mode='eco'):
    """中间层：将 extractor 的回调桥接到会话管理 + SSE 事件"""

    try:
        def on_progress(saved_count, progress_pct, message, eta_seconds, elapsed_seconds):
            _update_session(sid,
                saved_count=saved_count,
                progress=progress_pct,
                message=message,
                eta_seconds=eta_seconds,
                elapsed_seconds=elapsed_seconds,
            )
            _push_event(sid, {
                'type': 'extraction',
                'status': 'running',
                'saved_count': saved_count,
                'progress': progress_pct,
                'message': message,
                'eta_seconds': eta_seconds,
                'elapsed_seconds': elapsed_seconds,
            })

        def should_cancel():
            s = _get_session(sid)
            if not s:
                return True
            with s['lock']:
                return s['cancel_flag']

        status, message, saved_count = extract_slides(
            video_path, cache_dir, threshold, enable_history, max_history, use_roi, fast_mode,
            use_gpu=use_gpu, speed_mode=speed_mode,
            on_progress=on_progress, should_cancel=should_cancel,
        )

        if status == 'done':
            sess = _get_session(sid)
            elapsed = 0
            if sess:
                with sess['lock']:
                    elapsed = sess.get('elapsed_seconds', 0)
            _update_session(sid,
                status='done', progress=100, eta_seconds=0,
                elapsed_seconds=elapsed, saved_count=saved_count, message=message)
        elif status == 'cancelled':
            _update_session(sid, status='cancelled', message=message, saved_count=saved_count)
        else:
            _update_session(sid, status='error', message=message, saved_count=saved_count)

        _push_event(sid, {
            'type': 'extraction',
            'status': status,
            'saved_count': saved_count,
            'progress': 100 if status == 'done' else 0,
            'message': message,
        })
    except Exception as e:
        # 兜底：捕获所有未知异常，防止线程静默崩溃前端死等
        import traceback as _tb
        err_msg = str(e) or '未知错误'
        print(f'[后台提取致命错误] SID={sid} \n{_tb.format_exc()}', flush=True)
        _update_session(sid, status='error', message=f'系统异常: {err_msg}', cancel_flag=True)
        _push_event(sid, {
            'type': 'extraction',
            'status': 'error',
            'saved_count': 0,
            'progress': 0,
            'message': f'发生致命系统异常: {err_msg}'
        })


# ============================================================
#  路由 — 进度 / 取消（SSE 回退查询）
# ============================================================
@app.route('/api/session/<sid>/progress')
def session_progress(sid):
    state = _get_session_state(sid)
    if not state:
        return jsonify(success=False, message='会话不存在'), 404
    return jsonify(state)


@app.route('/api/session/<sid>/cancel', methods=['POST'])
def session_cancel(sid):
    _update_session(sid, cancel_flag=True)
    return jsonify(success=True)


# ============================================================
#  路由 — 图片列表 / 提供图片
# ============================================================
@app.route('/api/session/<sid>/images')
def session_list_images(sid):
    sess = _get_session(sid)
    if not sess:
        return jsonify(images=[])
    cache_dir = sess['cache_dir']
    if not os.path.exists(cache_dir):
        return jsonify(images=[])
    imgs = sorted(
        f for f in os.listdir(cache_dir)
        if f.lower().endswith(('.jpg', '.jpeg', '.png'))
    )
    return jsonify(images=imgs)


@app.route('/api/session/<sid>/image/<path:filename>')
def session_serve_image(sid, filename):
    sess = _get_session(sid)
    if not sess:
        return jsonify(success=False, message='会话不存在'), 404
    resp = send_from_directory(sess['cache_dir'], filename)
    resp.headers['Cache-Control'] = 'no-store'
    return resp


# ============================================================
#  路由 — 打包导出（异步后台 + SSE 推送）
# ============================================================
@app.route('/api/session/<sid>/package', methods=['POST'])
def session_package(sid):
    sess = _get_session(sid)
    if not sess:
        return jsonify(success=False, message='会话不存在')

    with sess['lock']:
        if sess.get('pkg_status') == 'running':
            return jsonify(success=False, message='正在打包中，请等待完成')

    data = request.json or {}
    fmt = data.get('format', 'pdf')
    files = data.get('files', [])

    if not files:
        return jsonify(success=False, message='没有图片可打包')

    cache_dir = sess['cache_dir']
    pkg_dir = sess['pkg_dir']
    os.makedirs(pkg_dir, exist_ok=True)

    paths = []
    for f in files:
        p = os.path.join(cache_dir, f)
        if os.path.exists(p):
            paths.append(p)
    if not paths:
        return jsonify(success=False, message='图片文件不存在')

    with sess['lock']:
        vname = Path(sess.get('video_path', '') or 'slides').stem or 'slides'

    _update_session(sid,
        pkg_status='running', pkg_progress=0,
        pkg_message='正在准备打包…', pkg_filename='', pkg_format=fmt)

    threading.Thread(
        target=_package_worker,
        args=(sid, fmt, paths, pkg_dir, vname),
        daemon=True,
    ).start()

    return jsonify(success=True, status='packaging')


def _package_worker(sid, fmt, paths, pkg_dir, video_name):
    """后台打包线程：调用 exporter 模块 + SSE 推送进度"""
    try:
        def on_progress(pct, msg):
            _update_session(sid, pkg_progress=pct, pkg_message=msg)
            _push_event(sid, {
                'type': 'packaging',
                'status': 'running',
                'progress': pct,
                'message': msg,
            })

        filename = package_images(paths, pkg_dir, fmt, video_name, on_progress=on_progress)

        _update_session(sid,
            pkg_status='done', pkg_progress=100,
            pkg_message='打包完成', pkg_filename=filename, pkg_format=fmt)
        _push_event(sid, {
            'type': 'packaging',
            'status': 'done',
            'progress': 100,
            'filename': filename,
            'format': fmt,
        })

    except PermissionError:
        msg = '文件写入权限被拒绝'
        hint = '请确保目标目录未被占用，或尝试关闭正在使用导出文件的程序。'
        _update_session(sid, pkg_status='error', pkg_message=msg)
        _push_event(sid, {'type': 'packaging', 'status': 'error', 'message': msg, 'hint': hint})

    except OSError as e:
        if 'No space' in str(e) or 'disk' in str(e).lower():
            msg = '磁盘空间不足，无法导出文件'
            hint = '请清理磁盘空间后重试。'
        else:
            msg = f'文件系统错误: {str(e)}'
            hint = '请检查磁盘状态后重试。'
        _update_session(sid, pkg_status='error', pkg_message=msg)
        _push_event(sid, {'type': 'packaging', 'status': 'error', 'message': msg, 'hint': hint})

    except Exception as e:
        msg = str(e)
        hint = '导出失败，请重试或换一种导出格式。如果持续出错，请提交 Issue。'
        _update_session(sid, pkg_status='error', pkg_message=msg)
        _push_event(sid, {'type': 'packaging', 'status': 'error', 'message': msg, 'hint': hint})


@app.route('/api/session/<sid>/download/<path:filename>')
def session_download(sid, filename):
    sess = _get_session(sid)
    if not sess:
        return jsonify(success=False, message='会话不存在'), 404
    return send_from_directory(sess['pkg_dir'], filename, as_attachment=True)


# ============================================================
#  路由 — 清理
# ============================================================
@app.route('/api/session/<sid>/cleanup', methods=['POST'])
def session_cleanup(sid):
    sess = _get_session(sid)
    if not sess:
        return jsonify(success=False, message='会话不存在')
    for d in [sess['cache_dir'], sess['pkg_dir']]:
        if os.path.exists(d):
            shutil.rmtree(d)
        os.makedirs(d, exist_ok=True)
    _update_session(sid,
        status='idle', progress=0, message='', saved_count=0,
        video_path='', video_name='', cancel_flag=False,
        eta_seconds=-1, elapsed_seconds=0,
        pkg_status='idle', pkg_progress=0, pkg_message='', pkg_filename='')
    return jsonify(success=True)


@app.route('/api/cleanup-all', methods=['POST'])
def cleanup_all():
    with _sessions_lock:
        sids = list(_sessions.keys())
    for sid in sids:
        sess = _get_session(sid)
        if sess:
            with sess['lock']:
                sess['cancel_flag'] = True
    time.sleep(0.3)
    for sid in sids:
        _delete_session(sid)
    return jsonify(success=True)


# ============================================================
#  路由 — 系统资源监控
# ============================================================
@app.route('/api/system/status')
def system_status():
    result = {
        'cpu_percent': 0,
        'memory_percent': 0,
        'memory_used_gb': 0,
        'memory_total_gb': 0,
        'disk_free_gb': 0,
        'disk_total_gb': 0,
        'disk_percent': 0,
        'active_tasks': _count_running(),
        'total_sessions': len(_sessions),
        'max_sessions': MAX_SESSIONS,
        'warning': None,
        'sessions': _get_all_sessions_summary(),
        # GPU 信息
        'gpu_available': _gpu_cache.get('available', False),
        'gpu_name': _gpu_cache.get('name', ''),
        'gpu_util': _gpu_cache.get('util', 0),
        'gpu_mem_used': _gpu_cache.get('mem_used', 0),
        'gpu_mem_total': _gpu_cache.get('mem_total', 0),
        'gpu_temperature': _gpu_cache.get('temperature', 0),
    }

    if HAS_PSUTIL:
        try:
            result['cpu_percent'] = _cpu_cache['percent']
            mem = psutil.virtual_memory()
            result['memory_percent'] = mem.percent
            result['memory_used_gb'] = round(mem.used / (1024**3), 1)
            result['memory_total_gb'] = round(mem.total / (1024**3), 1)

            disk = psutil.disk_usage(BASE_DIR)
            result['disk_free_gb'] = round(disk.free / (1024**3), 1)
            result['disk_total_gb'] = round(disk.total / (1024**3), 1)
            result['disk_percent'] = disk.percent
        except Exception as e:
            print(f'[WARN] 获取系统资源信息失败: {e}')

    warnings = []
    if result['cpu_percent'] > CPU_WARN_THRESHOLD:
        warnings.append(f'CPU 使用率过高 ({result["cpu_percent"]:.0f}%)')
    if result['memory_percent'] > MEMORY_WARN_THRESHOLD:
        warnings.append(f'内存使用率过高 ({result["memory_percent"]:.0f}%)')
    if result['disk_free_gb'] < DISK_WARN_THRESHOLD_MB / 1024:
        warnings.append(f'磁盘空间不足 (仅剩 {result["disk_free_gb"]:.1f} GB)')
    if warnings:
        result['warning'] = '；'.join(warnings)

    return jsonify(result)


def _check_resource_warning():
    if not HAS_PSUTIL:
        return None
    try:
        cpu = _cpu_cache['percent']
        mem = psutil.virtual_memory()
        disk = psutil.disk_usage(BASE_DIR)
        warnings = []
        if cpu > CPU_WARN_THRESHOLD:
            warnings.append(f'CPU 使用率 {cpu:.0f}% 超过 {CPU_WARN_THRESHOLD}%')
        if mem.percent > MEMORY_WARN_THRESHOLD:
            warnings.append(f'内存使用率 {mem.percent:.0f}% 超过 {MEMORY_WARN_THRESHOLD}%')
        if disk.free < DISK_WARN_THRESHOLD_MB * 1024 * 1024:
            warnings.append(f'磁盘空间仅剩 {disk.free / (1024**3):.1f} GB')
        return '；'.join(warnings) if warnings else None
    except Exception:
        return None


# ============================================================
#  路由 — 心跳 & 关闭
# ============================================================
@app.route('/api/heartbeat', methods=['POST'])
def heartbeat():
    global _last_heartbeat, _heartbeat_received
    _last_heartbeat = time.time()
    _heartbeat_received = True
    # 更新请求中携带的会话的活跃时间
    try:
        data = request.get_json(silent=True) or {}
        sids = data.get('active_sessions', [])
        for sid in sids:
            sess = _get_session(sid)
            if sess:
                with sess['lock']:
                    sess['last_active'] = time.time()
    except Exception:
        pass
    return jsonify(ok=True)


@app.route('/api/shutdown', methods=['POST'])
def shutdown():
    _do_cleanup(force=True)
    print('\n  Shutdown requested, exiting...')
    threading.Timer(0.5, lambda: os._exit(0)).start()
    return jsonify(ok=True)


def _do_cleanup(force=False):
    """清理临时文件。force=True 时强制删除所有，否则保留有提取成果的会话。"""
    if force:
        if os.path.exists(SESSIONS_ROOT):
            shutil.rmtree(SESSIONS_ROOT, ignore_errors=True)
    else:
        # 只清理空会话，保留有提取成果的会话用于恢复
        if os.path.exists(SESSIONS_ROOT):
            for name in os.listdir(SESSIONS_ROOT):
                sess_dir = os.path.join(SESSIONS_ROOT, name)
                if not os.path.isdir(sess_dir):
                    continue
                cache_dir = os.path.join(sess_dir, 'cache')
                has_images = False
                if os.path.exists(cache_dir):
                    has_images = any(f.lower().endswith(('.jpg', '.jpeg', '.png'))
                                     for f in os.listdir(cache_dir))
                if not has_images:
                    shutil.rmtree(sess_dir, ignore_errors=True)
    # 清理端口文件
    port_file = os.path.join(BASE_DIR, '.vidslide_port')
    if os.path.exists(port_file):
        try:
            os.remove(port_file)
        except Exception:
            pass


def _has_active_work():
    """检查是否有正在运行的任务或有提取成果的会话"""
    with _sessions_lock:
        for sess in _sessions.values():
            with sess['lock']:
                if sess['status'] == 'running':
                    return True
                if sess.get('saved_count', 0) > 0:
                    return True
    return False


def _heartbeat_watcher():
    while True:
        time.sleep(5)
        # 定期清理孤儿会话（无论心跳是否收到）
        try:
            _cleanup_orphan_sessions()
        except Exception:
            pass
        if not _heartbeat_received:
            continue
        elapsed = time.time() - _last_heartbeat
        if elapsed > HEARTBEAT_TIMEOUT:
            if _has_active_work():
                # 有活跃任务或未导出的成果，延长等待
                print(f'[心跳] 浏览器失联 {int(elapsed)}s，但有活跃任务/成果，继续等待…')
                continue
            print(f'\n  Browser disconnected for {int(elapsed)}s, shutting down...')
            _do_cleanup(force=False)
            print('  Temp files cleaned. Goodbye!')
            time.sleep(0.5)
            os._exit(0)


# ============================================================
#  启动
# ============================================================
def _find_free_port(start=5873):
    # 优先尝试上次使用的端口（方便浏览器刷新恢复）
    port_file = os.path.join(BASE_DIR, '.vidslide_port')
    if os.path.exists(port_file):
        try:
            last_port = int(open(port_file).read().strip())
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.bind(('127.0.0.1', last_port))
            s.close()
            return last_port
        except Exception:
            pass
    for port in range(start, start + 100):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.bind(('127.0.0.1', port))
            s.close()
            return port
        except OSError:
            continue
    return start


def _write_port_file(port):
    """写入端口文件，供浏览器刷新时自动恢复连接"""
    port_file = os.path.join(BASE_DIR, '.vidslide_port')
    try:
        with open(port_file, 'w') as f:
            f.write(str(port))
    except Exception:
        pass


if __name__ == '__main__':
    try:
        os.makedirs(SESSIONS_ROOT, exist_ok=True)
        port = _find_free_port(5873)
        _write_port_file(port)
        url = f'http://127.0.0.1:{port}'

        threading.Timer(1.5, lambda: webbrowser.open(url)).start()

        watcher = threading.Thread(target=_heartbeat_watcher, daemon=True)
        watcher.start()

        print()
        print('=' * 60)
        print('  影幻智提 (VidSlide) v0.3.2 - 性能狂飙版')
        print(f'  浏览器将自动打开: {url}')
        print(f'  临时文件目录: {SESSIONS_ROOT}')
        print(f'  最大并行标签页: {MAX_SESSIONS}')
        print('  ✨ 新特性: SSE 推送 · GPU 加速 · 异步打包')
        print('  浏览器断联 5 分钟后服务自动退出（有任务时延长等待）')
        print('  也可以按 Ctrl+C 手动停止')
        print('=' * 60)
        print()

        import atexit
        atexit.register(lambda: _do_cleanup(force=False))

        app.run(host='127.0.0.1', port=port, debug=False, threaded=True)

    except Exception as e:
        error_detail = traceback.format_exc()
        print(f"！！！发生严重错误！！！\n{error_detail}")
        if sys.stdin is None or not sys.stdout.isatty():
            try:
                import ctypes
                ctypes.windll.user32.MessageBoxW(
                    0,
                    f"影幻智提启动失败！\n\n"
                    f"错误信息：\n{error_detail}\n\n"
                    f"💡 建议操作：\n"
                    f"1. 截图此对话框\n"
                    f"2. 前往 https://github.com/PWO-CHINA/VidSlide/issues 提交 Issue\n"
                    f"3. 在 Issue 中粘贴截图，开发者会尽快修复\n\n"
                    f"常见原因：端口被占用、依赖缺失、杀毒软件拦截",
                    "影幻智提 (VidSlide) - 启动失败",
                    0x10
                )
            except Exception:
                pass
        else:
            print("\n" + "=" * 60)
            print("  💡 建议操作：")
            print("  1. 截图以上错误信息")
            print("  2. 前往 https://github.com/PWO-CHINA/VidSlide/issues 提交 Issue")
            print("  3. 在 Issue 中粘贴截图")
            print("=" * 60)
            input("\n按回车键退出...")
