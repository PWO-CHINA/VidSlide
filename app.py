"""
影幻智提 (VidSlide) - PPT 幻灯片智能提取工具
==============================================
基于 Flask 的本地 Web 应用，提供可视化界面来提取、管理和打包 PPT 幻灯片。

使用方法：
    python app.py

依赖安装：
    pip install flask opencv-python numpy pillow python-pptx

作者: PWO-CHINA
版本: v0.1.1
"""

import cv2
import numpy as np
import os
import sys
import shutil
import threading
import time
import zipfile
import webbrowser
import socket
import traceback
from pathlib import Path

from flask import Flask, request, jsonify, send_file, send_from_directory, render_template
from PIL import Image

# ============================================================
#  无控制台模式兼容：PyInstaller --noconsole 时 stdout/stderr 为 None
# ============================================================
if sys.stdout is None:
    sys.stdout = open(os.devnull, 'w', encoding='utf-8')
if sys.stderr is None:
    sys.stderr = open(os.devnull, 'w', encoding='utf-8')

try:
    from pptx import Presentation
    from pptx.util import Inches
    HAS_PPTX = True
except ImportError:
    HAS_PPTX = False
    print("⚠️  未安装 python-pptx，PPTX 导出将不可用。安装命令: pip install python-pptx")


# ============================================================
#  PyInstaller 兼容：资源路径寻路
# ============================================================
def get_resource_path(relative_path):
    """获取资源的绝对路径，兼容开发环境和 PyInstaller 打包后的环境"""
    if hasattr(sys, '_MEIPASS'):
        # PyInstaller 打包后的临时目录
        return os.path.join(sys._MEIPASS, relative_path)
    # 开发环境的当前目录
    return os.path.join(os.path.abspath(os.path.dirname(__file__)), relative_path)


# ============================================================
#  配置
# ============================================================
# 模板和静态文件目录（兼容打包后的路径）
TEMPLATE_DIR = get_resource_path('templates')

# 临时文件存放目录（始终使用 exe 所在的真实目录，而非 _MEIPASS 临时目录）
if hasattr(sys, '_MEIPASS'):
    BASE_DIR = os.path.dirname(os.path.abspath(sys.executable))
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))

TEMP_CACHE = os.path.join(BASE_DIR, '.temp_cache')
TEMP_PACKAGES = os.path.join(BASE_DIR, '.temp_packages')

app = Flask(__name__, template_folder=TEMPLATE_DIR)


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
    return jsonify(success=False, message=f'服务器内部错误: {str(e)}'), 500


# ============================================================
#  全局提取状态 (线程安全)
# ============================================================
_state_lock = threading.Lock()
_state = {
    'status': 'idle',       # idle | running | done | error | cancelled
    'progress': 0,          # 0-100
    'message': '',
    'saved_count': 0,
    'video_path': '',
    'cancel_flag': False,
    'eta_seconds': -1,      # 预计剩余秒数，-1 表示尚未计算
    'elapsed_seconds': 0,   # 已用时间（秒）
}

# 心跳机制：浏览器定期发送心跳，如果超时未收到则自动关闭服务
_last_heartbeat = 0.0
_heartbeat_received = False   # 是否收到过至少一次心跳
HEARTBEAT_TIMEOUT = 20       # 秒：浏览器断开后多久关闭服务


def _update(**kw):
    with _state_lock:
        _state.update(kw)


def _get_state():
    with _state_lock:
        return dict(_state)


def _ensure_dirs():
    os.makedirs(TEMP_CACHE, exist_ok=True)
    os.makedirs(TEMP_PACKAGES, exist_ok=True)


# ============================================================
#  路由 — 页面
# ============================================================
@app.route('/')
def index():
    return render_template('index.html')


# ============================================================
#  路由 — 选择视频（弹出系统对话框，带格式限制防呆）
# ============================================================
@app.route('/api/select-video', methods=['POST'])
def select_video():
    """弹出系统文件选择框，在独立线程中运行 tkinter 避免阻塞 Flask"""
    try:
        # 修复 Windows 高 DPI 下文件选择对话框模糊问题
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
        import queue

        result_queue = queue.Queue()

        def _pick():
            try:
                root = tk.Tk()
                root.withdraw()
                root.wm_attributes('-topmost', 1)
                root.focus_force()
                # 【防呆】限制只能选视频文件
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
        t.join(timeout=120)  # 最多等待 2 分钟

        path = result_queue.get_nowait() if not result_queue.empty() else ''

        if path:
            print(f'[DEBUG] 用户选择了视频: {path}')
            return jsonify(success=True, path=path)
        return jsonify(success=False, message='未选择文件')
    except Exception as e:
        print(f'[ERROR] select_video 异常: {e}')
        return jsonify(success=False, message=str(e))


# ============================================================
#  路由 — 开始提取
# ============================================================
@app.route('/api/extract', methods=['POST'])
def start_extraction():
    cur = _get_state()
    if cur['status'] == 'running':
        return jsonify(success=False, message='正在提取中，请等待完成或取消')

    data = request.json or {}
    video_path = data.get('video_path', '')
    print(f'[DEBUG] 收到提取请求，视频路径: {repr(video_path)}')

    threshold = float(data.get('threshold', 5.0))
    enable_history = bool(data.get('enable_history', False))
    max_history = int(data.get('max_history', 5))
    use_roi = bool(data.get('use_roi', True))
    fast_mode = bool(data.get('fast_mode', True))

    if not video_path:
        return jsonify(success=False, message='未提供视频路径')

    if not os.path.exists(video_path):
        print(f'[DEBUG] 文件不存在: {video_path}')
        return jsonify(success=False, message=f'视频文件不存在: {video_path}')

    # 清空上次缓存
    if os.path.exists(TEMP_CACHE):
        shutil.rmtree(TEMP_CACHE)
    _ensure_dirs()

    _update(
        status='running', progress=0, message='正在初始化…',
        saved_count=0, video_path=video_path, cancel_flag=False,
        eta_seconds=-1, elapsed_seconds=0,
    )

    threading.Thread(
        target=_extract_worker,
        args=(video_path, TEMP_CACHE, threshold, enable_history, max_history, use_roi, fast_mode),
        daemon=True,
    ).start()

    return jsonify(success=True)


# ============================================================
#  后台提取 Worker（带全局异常捕获）
# ============================================================
def _extract_worker(video_path, output_dir, threshold, enable_history, max_history, use_roi, fast_mode=True):
    try:
        cap = cv2.VideoCapture(video_path)
        ok, prev_frame = cap.read()
        if not ok:
            _update(status='error', message='无法读取视频文件')
            return

        total_frames = max(int(cap.get(cv2.CAP_PROP_FRAME_COUNT)), 1)
        fps = cap.get(cv2.CAP_PROP_FPS) or 30
        frame_step = max(1, int(fps))

        h, w = prev_frame.shape[:2]
        if use_roi:
            y1, y2 = int(h * 0.185), h
            x1, x2 = int(w * 0.208), w
        else:
            y1, y2 = 0, h
            x1, x2 = 0, w

        # ── 快速模式：缩小 ROI 到 ~480px 宽度用于比较，大幅减少计算量 ──
        roi_w = x2 - x1
        COMPARE_WIDTH = 480
        if fast_mode and roi_w > COMPARE_WIDTH:
            _scale = COMPARE_WIDTH / roi_w
        else:
            _scale = 1.0

        def _to_gray(frame):
            """提取 ROI → (可选缩小) → 灰度，用于帧间比较"""
            roi = frame[y1:y2, x1:x2]
            if _scale < 1.0:
                roi = cv2.resize(roi, None, fx=_scale, fy=_scale,
                                 interpolation=cv2.INTER_AREA)
            return cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)

        prev_gray = _to_gray(prev_frame)
        history_pool = [prev_gray] if enable_history else None

        count = 0
        saved = 0
        _extract_start_time = time.time()   # ETA 计时起点

        # 保存第一帧（始终用原始分辨率保存）
        fp = os.path.join(output_dir, f"slide_{saved:04d}.jpg")
        cv2.imencode('.jpg', prev_frame, [cv2.IMWRITE_JPEG_QUALITY, 95])[1].tofile(fp)
        saved += 1
        _update(saved_count=saved, message=f'已提取 {saved} 张')

        # ── 主循环：用 grab() 跳帧代替 set(POS_FRAMES)，避免昂贵的随机 seek ──
        while True:
            if _get_state()['cancel_flag']:
                _update(status='cancelled', message=f'已取消，已保存 {saved} 张')
                cap.release()
                return

            # grab() 只解码帧头不解码像素，比 read() 快很多
            grabbed = True
            for _ in range(frame_step):
                count += 1
                if not cap.grab():
                    grabbed = False
                    break
            if not grabbed:
                break

            # 到达目标帧才 retrieve() 解码像素
            ok, curr_frame = cap.retrieve()
            if not ok:
                break

            pct = min(99, int(count / total_frames * 100))
            elapsed = time.time() - _extract_start_time
            if pct > 2:  # 前 2% 数据不稳定，不计算 ETA
                eta = elapsed / pct * (100 - pct)
            else:
                eta = -1
            _update(progress=pct, eta_seconds=round(eta, 1), elapsed_seconds=round(elapsed, 1))

            curr_gray = _to_gray(curr_frame)
            mean_diff = np.mean(cv2.absdiff(curr_gray, prev_gray))

            if mean_diff > threshold:
                # ── 等待画面稳定 ──
                check_step = max(1, int(fps * 0.5))
                stable = 0
                last_gray = curr_gray
                settled_frame = None
                settled_gray = None

                while True:
                    s_grabbed = True
                    for _ in range(check_step):
                        count += 1
                        if not cap.grab():
                            s_grabbed = False
                            break
                    if not s_grabbed:
                        break
                    ret, tmp = cap.retrieve()
                    if not ret:
                        break
                    tmp_gray = _to_gray(tmp)
                    if np.mean(cv2.absdiff(tmp_gray, last_gray)) < 1.0:
                        stable += 1
                    else:
                        stable = 0
                    last_gray = tmp_gray
                    if stable >= 2:
                        settled_frame = tmp
                        settled_gray = tmp_gray
                        break

                # ── 去重核验 ──
                if settled_gray is not None:
                    final_diff = np.mean(cv2.absdiff(settled_gray, prev_gray))
                    dup = False
                    if enable_history and history_pool:
                        for pg in history_pool:
                            if np.mean(cv2.absdiff(settled_gray, pg)) <= threshold:
                                dup = True
                                break
                    elif final_diff <= threshold:
                        dup = True

                    if not dup and final_diff > threshold:
                        fp = os.path.join(output_dir, f"slide_{saved:04d}.jpg")
                        cv2.imencode('.jpg', settled_frame, [cv2.IMWRITE_JPEG_QUALITY, 95])[1].tofile(fp)
                        saved += 1
                        _update(saved_count=saved, message=f'已提取 {saved} 张')
                        prev_gray = settled_gray
                        if enable_history:
                            history_pool.append(settled_gray)
                            if len(history_pool) > max_history:
                                history_pool.pop(0)
                    else:
                        prev_gray = settled_gray

        cap.release()
        elapsed_total = round(time.time() - _extract_start_time, 1)
        _update(status='done', progress=100, eta_seconds=0, elapsed_seconds=elapsed_total,
               message=f'提取完成！共 {saved} 张幻灯片，耗时 {int(elapsed_total)}s')
    except Exception as e:
        error_detail = traceback.format_exc()
        print(f"！！！发生严重错误！！！\n{error_detail}")
        _update(status='error', message=f'提取出错: {e}')


# ============================================================
#  路由 — 进度 / 取消
# ============================================================
@app.route('/api/progress')
def progress():
    return jsonify(_get_state())


@app.route('/api/cancel', methods=['POST'])
def cancel():
    _update(cancel_flag=True)
    return jsonify(success=True)


# ============================================================
#  路由 — 图片列表 / 提供图片
# ============================================================
@app.route('/api/images')
def list_images():
    _ensure_dirs()
    imgs = sorted(
        f for f in os.listdir(TEMP_CACHE)
        if f.lower().endswith(('.jpg', '.jpeg', '.png'))
    )
    return jsonify(images=imgs)


@app.route('/api/image/<path:filename>')
def serve_image(filename):
    resp = send_from_directory(TEMP_CACHE, filename)
    resp.headers['Cache-Control'] = 'no-store'
    return resp


# ============================================================
#  路由 — 打包导出
# ============================================================
@app.route('/api/package', methods=['POST'])
def package():
    data = request.json or {}
    fmt = data.get('format', 'pdf')
    files = data.get('files', [])

    if not files:
        return jsonify(success=False, message='没有图片可打包')

    _ensure_dirs()
    paths = []
    for f in files:
        p = os.path.join(TEMP_CACHE, f)
        if os.path.exists(p):
            paths.append(p)
    if not paths:
        return jsonify(success=False, message='图片文件不存在')

    vname = Path(_get_state().get('video_path', '') or 'slides').stem or 'slides'

    try:
        if fmt == 'pdf':
            out = os.path.join(TEMP_PACKAGES, f'{vname}_整理版.pdf')
            imgs = [Image.open(p).convert('RGB') for p in paths]
            imgs[0].save(out, save_all=True, append_images=imgs[1:])

        elif fmt == 'pptx':
            if not HAS_PPTX:
                return jsonify(success=False, message='未安装 python-pptx，请执行 pip install python-pptx')
            out = os.path.join(TEMP_PACKAGES, f'{vname}_整理版.pptx')
            prs = Presentation()
            prs.slide_width = Inches(13.333)
            prs.slide_height = Inches(7.5)
            for p in paths:
                slide = prs.slides.add_slide(prs.slide_layouts[6])
                slide.shapes.add_picture(p, 0, 0, width=prs.slide_width, height=prs.slide_height)
            prs.save(out)

        elif fmt == 'zip':
            out = os.path.join(TEMP_PACKAGES, f'{vname}_整理版.zip')
            with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as zf:
                for i, p in enumerate(paths):
                    zf.write(p, f'slide_{i + 1:03d}{Path(p).suffix}')
        else:
            return jsonify(success=False, message=f'不支持的格式: {fmt}')

        return jsonify(success=True, filename=os.path.basename(out))
    except Exception as e:
        return jsonify(success=False, message=str(e))


@app.route('/api/download/<path:filename>')
def download(filename):
    return send_from_directory(TEMP_PACKAGES, filename, as_attachment=True)


# ============================================================
#  路由 — 清理缓存
# ============================================================
@app.route('/api/cleanup', methods=['POST'])
def cleanup():
    for d in [TEMP_CACHE, TEMP_PACKAGES]:
        if os.path.exists(d):
            shutil.rmtree(d)
    _update(status='idle', progress=0, message='', saved_count=0, video_path='', cancel_flag=False,
           eta_seconds=-1, elapsed_seconds=0)
    return jsonify(success=True)


# ============================================================
#  路由 — 心跳 & 关闭（僵尸进程防呆）
# ============================================================
@app.route('/api/heartbeat', methods=['POST'])
def heartbeat():
    """浏览器每 8 秒发一次，证明页面还开着"""
    global _last_heartbeat, _heartbeat_received
    _last_heartbeat = time.time()
    _heartbeat_received = True
    return jsonify(ok=True)


@app.route('/api/shutdown', methods=['POST'])
def shutdown():
    """前端主动请求关闭服务 — 僵尸进程防呆"""
    _do_cleanup()
    print('\n  Shutdown requested, exiting...')
    # 延迟 0.5s 后退出，让响应先返回
    threading.Timer(0.5, lambda: os._exit(0)).start()
    return jsonify(ok=True)


def _do_cleanup():
    """清理所有临时文件"""
    for d in [TEMP_CACHE, TEMP_PACKAGES]:
        if os.path.exists(d):
            shutil.rmtree(d, ignore_errors=True)


def _heartbeat_watcher():
    """后台线程：监控心跳，浏览器关闭后自动退出服务"""
    while True:
        time.sleep(5)
        if not _heartbeat_received:
            continue  # 还没有任何浏览器连接过，不要退出
        elapsed = time.time() - _last_heartbeat
        if elapsed > HEARTBEAT_TIMEOUT:
            print(f'\n  Browser disconnected for {int(elapsed)}s, shutting down...')
            _do_cleanup()
            print('  Temp files cleaned. Goodbye!')
            time.sleep(0.5)
            os._exit(0)


# ============================================================
#  启动 — 端口冲突防呆
# ============================================================
def _find_free_port(start=5873):
    """从冷门端口开始扫描，避免常见端口冲突"""
    for port in range(start, start + 100):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.bind(('127.0.0.1', port))
            s.close()
            return port
        except OSError:
            continue
    return start


if __name__ == '__main__':
    try:
        _ensure_dirs()
        port = _find_free_port(5873)
        url = f'http://127.0.0.1:{port}'

        # 延迟 1.5 秒后自动在默认浏览器中打开网页
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()

        # 启动心跳监控线程（守护线程，主线程退出时自动结束）
        watcher = threading.Thread(target=_heartbeat_watcher, daemon=True)
        watcher.start()

        print()
        print('=' * 55)
        print('  影幻智提 (VidSlide) - PPT Slide Extractor')
        print(f'  浏览器将自动打开: {url}')
        print(f'  临时文件目录: {BASE_DIR}')
        print('  关闭浏览器标签页后服务将在 30 秒内自动退出')
        print('  也可以按 Ctrl+C 手动停止')
        print('=' * 55)
        print()

        import atexit
        atexit.register(_do_cleanup)

        app.run(host='127.0.0.1', port=port, debug=False, threaded=True)

    except Exception as e:
        error_detail = traceback.format_exc()
        print(f"！！！发生严重错误！！！\n{error_detail}")
        # 无控制台模式下用 MessageBox 弹窗显示错误；有控制台则 input() 阻塞
        if sys.stdin is None or not sys.stdout.isatty():
            try:
                import ctypes
                ctypes.windll.user32.MessageBoxW(
                    0,
                    f"影幻智提启动失败，请截图此对话框发给开发者：\n\n{error_detail}",
                    "影幻智提 (VidSlide) - 严重错误",
                    0x10  # MB_ICONERROR
                )
            except Exception:
                pass
        else:
            input("请截图以上错误信息发给开发者，按回车键退出...")
