"""
影幻智提 (VidSlide) - 视频提取核心模块
======================================
负责从视频中检测场景变化并提取幻灯片截图。
支持 GPU 硬件加速解码（自动检测）和进程优先级调整。

作者: PWO-CHINA
版本: v0.6.1
"""

import cv2
import gc
import numpy as np
import os
import time
import traceback
from concurrent.futures import ThreadPoolExecutor

try:
    import psutil
    HAS_PSUTIL = True
except ImportError:
    HAS_PSUTIL = False

try:
    import av
    HAS_PYAV = True
except ImportError:
    HAS_PYAV = False


# ── GPU 硬件加速探测（应用启动时调用一次，结果缓存） ──
_gpu_probe_cache = None


def probe_gpu():
    """
    探测系统 GPU 硬件加速能力。结果全局缓存，后续调用直接返回。
    返回 dict: gpus, pyav, hw_decoders, best_per_codec, summary
    """
    global _gpu_probe_cache
    if _gpu_probe_cache is not None:
        return _gpu_probe_cache

    result = {
        'gpus': [],
        'pyav': HAS_PYAV,
        'hw_decoders': {},       # codec -> [可用 hw_type]
        'best_per_codec': {},    # codec -> 最优 hw_type（首选）
        'summary': ''
    }

    # 1. 检测 GPU 设备名称（Windows wmic）
    if os.name == 'nt':
        try:
            import subprocess
            output = subprocess.check_output(
                ['wmic', 'path', 'win32_VideoController', 'get', 'name'],
                text=True, timeout=5,
                creationflags=0x08000000  # CREATE_NO_WINDOW
            )
            for line in output.strip().split('\n')[1:]:
                name = line.strip()
                if name and name != 'Name':
                    result['gpus'].append(name)
        except Exception:
            pass

    # 2. 探测 PyAV 硬件加速支持
    if HAS_PYAV:
        try:
            from av.codec.hwaccel import HWAccel
            _hw_order = ('cuda', 'd3d11va', 'qsv', 'dxva2')
            for codec in ('h264', 'hevc', 'av1'):
                available = []
                for hw_type in _hw_order:
                    try:
                        HWAccel(codec=codec, device_type=hw_type)
                        available.append(hw_type)
                    except Exception:
                        pass
                result['hw_decoders'][codec] = available
                if available:
                    result['best_per_codec'][codec] = available[0]
        except ImportError:
            pass

    # 3. 生成人类可读摘要
    gpu_name = result['gpus'][0] if result['gpus'] else '未检测到 GPU'
    # 过滤虚拟显示适配器
    for g in result['gpus']:
        if 'virtual' not in g.lower() and 'basic' not in g.lower():
            gpu_name = g
            break

    if result['hw_decoders']:
        hw_parts = []
        for codec in ('h264', 'hevc', 'av1'):
            types = result['hw_decoders'].get(codec, [])
            if types:
                hw_parts.append(f"{codec.upper()}: {'/'.join(types)}")
            else:
                label = 'dav1d' if (codec == 'av1' and HAS_PYAV) else 'CPU'
                hw_parts.append(f"{codec.upper()}: {label}")
        result['summary'] = f"{gpu_name} | {', '.join(hw_parts)}"
    else:
        result['summary'] = f"{gpu_name} | PyAV {'可用' if HAS_PYAV else '未安装'}"

    _gpu_probe_cache = result
    print(f'[GPU 探测] {result["summary"]}')
    return result


def _lower_process_priority():
    """降低当前进程优先级，防止提取任务抢占系统资源"""
    if not HAS_PSUTIL:
        return
    try:
        p = psutil.Process(os.getpid())
        if os.name == 'nt':
            p.nice(psutil.BELOW_NORMAL_PRIORITY_CLASS)
        else:
            p.nice(10)
        print('[优化] 已降低进程优先级，减少对前台任务的影响')
    except Exception as e:
        print(f'[优化] 降低优先级失败（不影响运行）: {e}')


def _open_video_capture(video_path, use_gpu=True):
    """
    打开视频文件。
    当 use_gpu=True 时优先使用 GPU 硬件加速解码，不可用则自动回退到 CPU。
    当 use_gpu=False 时直接使用 CPU 软解。
    """
    if use_gpu:
        try:
            params = [cv2.CAP_PROP_HW_ACCELERATION, cv2.VIDEO_ACCELERATION_ANY]
            cap = cv2.VideoCapture(video_path, cv2.CAP_ANY, params)
            if cap.isOpened():
                hw_accel = int(cap.get(cv2.CAP_PROP_HW_ACCELERATION))
                if hw_accel != 0:
                    print(f'[GPU] 已启用硬件加速解码 (type={hw_accel})')
                else:
                    print('[GPU] 硬件加速未生效（当前 GPU 可能不支持该编码的硬件解码），使用 CPU 解码')
                return cap
        except (AttributeError, cv2.error) as e:
            print(f'[GPU] 硬件加速不可用 ({e})，回退到 CPU 解码')
    else:
        print('[CPU] 用户选择 CPU 解码模式')

    # 回退 / CPU 模式: 纯 CPU 解码
    cap = cv2.VideoCapture(video_path)
    return cap


def extract_slides(video_path, output_dir, threshold=5.0, enable_history=False,
                   max_history=5, use_roi=True, fast_mode=True, use_gpu=True,
                   speed_mode='eco', classroom_mode='ppt',
                   on_progress=None, should_cancel=None,
                   start_frame=0, saved_offset=0):
    """
    从视频中提取幻灯片截图。

    Args:
        video_path:      视频文件路径
        output_dir:      输出目录
        threshold:       场景检测灵敏度阈值
        enable_history:  是否启用历史记忆池
        max_history:     历史记忆池容量
        use_roi:         是否裁剪 PPT 区域
        fast_mode:       是否使用快速模式（降低比较分辨率）
        use_gpu:         是否使用 GPU 硬件加速解码
        speed_mode:      运行模式 'eco'(后台静默) | 'fast'(全速狂飙) | 'turbo'(极速狂暴)
        classroom_mode:  视频类型 'ppt'(PPT录屏) | 'hybrid'(电子课堂) | 'blackboard'(实体课堂)
        on_progress:     进度回调 (saved_count, progress_pct, message, eta_seconds, elapsed_seconds[, current_frame])
        should_cancel:   取消检查回调 () -> bool
        start_frame:     断点续传：从第几帧开始（0=从头）
        saved_offset:    断点续传：已有图片数量（文件命名偏移）

    Returns:
        (status, message, saved_count) 元组
        status: 'done' | 'cancelled' | 'error'
    """
    if on_progress is None:
        on_progress = lambda *args, **kwargs: None
    if should_cancel is None:
        should_cancel = lambda: False

    # ── 三模式内部标志 ──
    if classroom_mode not in ('ppt', 'blackboard', 'hybrid'):
        classroom_mode = 'ppt'
    _use_mog2 = classroom_mode in ('blackboard', 'hybrid')    # 需要 MOG2 人物遮罩
    _skip_stable = classroom_mode in ('blackboard', 'hybrid')  # 跳过稳定帧检测
    _is_blackboard = (classroom_mode == 'blackboard')          # 纯黑板特有逻辑
    _mode_label = {'ppt': 'PPT 录屏', 'hybrid': '电子课堂', 'blackboard': '实体课堂'}[classroom_mode]

    cap = None
    history_pool = None
    saved = 0

    try:
        # ── 根据运行模式配置节流和优先级 ──
        _is_turbo = (speed_mode == 'turbo')
        _is_fast = (speed_mode == 'fast') or _is_turbo
        if _is_fast:
            _THROTTLE_INTERVAL = 0.001  # 1ms 微小间隙，仅让出 GIL
            if _is_turbo:
                print('[Turbo] 极速狂暴模式：2x帧跳距 + 320p对比 + 加速稳定帧检测')
            else:
                print('[Fast] 全速狂飙模式：保持正常优先级，最小节流')
        else:
            _THROTTLE_INTERVAL = 0.008  # 8ms 节流，降低峰值占用
            _lower_process_priority()

        _GC_EVERY_N_FRAMES = 500  # 每 500 帧强制 gc.collect() 防 OOM

        # ── 使用 GPU 硬件加速打开视频 ──
        cap = _open_video_capture(video_path, use_gpu=use_gpu)

        # ── MOG2 背景建模（电子课堂 + 实体课堂共用，忽略走动人物） ──
        backSub = None
        _close_kernel = None
        _dilate_kernel = None
        if _use_mog2:
            backSub = cv2.createBackgroundSubtractorMOG2(
                history=500, varThreshold=16, detectShadows=False)
            _close_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
            _dilate_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (13, 13))
            print(f'[{_mode_label}] MOG2 背景建模已启用，将忽略移动前景')

        total_frames = max(int(cap.get(cv2.CAP_PROP_FRAME_COUNT)), 1)
        fps = cap.get(cv2.CAP_PROP_FPS) or 30
        # 黑板模式步长（仅 PyAV 不可用时的 OpenCV 回退）：10 秒
        # 步长设置（PyAV NONKEY 可用时会在后面覆盖）
        if _is_blackboard:
            frame_step = max(1, int(fps * 10))   # 板书渐变，大步长
        elif classroom_mode == 'hybrid':
            frame_step = max(1, int(fps * 3))    # 电子课堂，短步长抓翻页
        else:
            frame_step = max(1, int(fps * (2 if _is_turbo else 1)))  # PPT 录屏

        # ── 断点续传：跳到上次中断的位置 ──
        is_resuming = (start_frame > 0)
        if is_resuming:
            cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)
            print(f'[断点续传] 从第 {start_frame} 帧恢复，已有 {saved_offset} 张图片')

        ok, prev_frame = cap.read()
        if not ok:
            return ('error', '无法读取视频文件', 0)

        count = start_frame if is_resuming else 0

        h, w = prev_frame.shape[:2]
        if use_roi:
            y1, y2 = int(h * 0.185), h
            x1, x2 = int(w * 0.208), w
        else:
            y1, y2 = 0, h
            x1, x2 = 0, w

        roi_w = x2 - x1
        # Turbo: 320p 超低分辨率对比（像素减 55%）; Fast/Eco: 480p
        COMPARE_WIDTH = 320 if _is_turbo else 480
        if fast_mode and roi_w > COMPARE_WIDTH:
            _scale = COMPARE_WIDTH / roi_w
        else:
            _scale = 1.0

        def _to_gray(frame):
            roi = frame[y1:y2, x1:x2]
            if _scale < 1.0:
                roi = cv2.resize(roi, None, fx=_scale, fy=_scale,
                                 interpolation=cv2.INTER_AREA)
            return cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)

        prev_gray = _to_gray(prev_frame)
        if backSub is not None:
            backSub.apply(prev_gray)  # 首帧喂入 MOG2 开始建模
            prev_bg_mask = np.ones_like(prev_gray, dtype=np.uint8) * 255  # 首帧无前景历史
        history_pool = [prev_gray] if enable_history else None

        # ── 性能优化：JPEG 质量 / seek 跳转 / 异步保存 ──
        _JPEG_QUALITY = 85 if _is_blackboard else 95
        _USE_SEEK = (backSub is not None)  # 电子课堂/实体课堂启用 seek 跳转

        # ── PyAV 加速：仅解码关键帧（skip_frame=NONKEY） ──
        # 对所有模式生效：PPT 模式同样受益（AV1 顺序 grab 极慢）
        # use_gpu=True 时使用启动时缓存的探测结果，直接选用最优 hw_type
        _av_container = None
        _av_stream = None
        _keyframe_iter = None
        if HAS_PYAV:
            _pyav_hw = ''
            _codec_name = ''
            # 探测视频编码格式
            try:
                _probe = av.open(video_path)
                _codec_name = _probe.streams.video[0].codec_context.name
                _probe.close()
            except Exception:
                pass

            # 使用启动时缓存的探测结果，仅尝试已知可用的 hw_type
            if use_gpu and _codec_name:
                _cached = probe_gpu()
                _best_hw = _cached.get('best_per_codec', {}).get(_codec_name)
                if _best_hw:
                    try:
                        from av.codec.hwaccel import HWAccel
                        _hwaccel = HWAccel(codec=_codec_name, device_type=_best_hw)
                        _av_container = av.open(video_path, hwaccel=_hwaccel)
                        _av_stream = _av_container.streams.video[0]
                        _av_stream.thread_type = 'AUTO'
                        _av_stream.codec_context.skip_frame = 'NONKEY'
                        _keyframe_iter = _av_container.decode(_av_stream)
                        # 试解一帧确认硬件解码确实可用
                        next(_keyframe_iter).to_ndarray(format='bgr24')
                        _pyav_hw = _best_hw
                    except Exception:
                        if _av_container is not None:
                            try: _av_container.close()
                            except Exception: pass
                            _av_container = None
                        _keyframe_iter = None

            # 软件解码回退（dav1d 解 AV1 仍极快）
            if _keyframe_iter is None:
                try:
                    _av_container = av.open(video_path)
                    _av_stream = _av_container.streams.video[0]
                    _av_stream.thread_type = 'AUTO'
                    _av_stream.codec_context.skip_frame = 'NONKEY'
                    if not _codec_name:
                        _codec_name = _av_stream.codec_context.name
                    _keyframe_iter = _av_container.decode(_av_stream)
                except Exception as e:
                    print(f'[PyAV] 初始化失败，回退 OpenCV: {e}')
                    if _av_container is not None:
                        try: _av_container.close()
                        except Exception: pass
                    _av_container = None
                    _keyframe_iter = None

            if _keyframe_iter is not None:
                _hw_label = f'GPU {_pyav_hw}' if _pyav_hw else 'CPU dav1d'
                print(f'[PyAV] 检测到 {_codec_name}，启用关键帧快速迭代（skip_frame=NONKEY，{_hw_label}）')

                # NONKEY + 黑板模式：两遍扫描策略
                # 第一遍（预训练）：快速扫完全部关键帧，只喂 MOG2，不做比较
                # 第二遍（提取）：  seek 回开头，用训练好的模型做精确遮罩
                if backSub is not None:
                    backSub.setHistory(60)
                    print(f'[{_mode_label}] MOG2 预训练：扫描全部关键帧建立背景模型…')
                    _warmup_count = 0
                    try:
                        for _wf in _keyframe_iter:
                            _wg = _to_gray(_wf.to_ndarray(format='bgr24'))
                            backSub.apply(_wg, learningRate=0.02)
                            _warmup_count += 1
                    except StopIteration:
                        pass
                    print(f'[{_mode_label}] MOG2 预训练完成：已学习 {_warmup_count} 个关键帧')
                    # seek 回起点，重建关键帧迭代器
                    _av_container.seek(0)
                    _keyframe_iter = _av_container.decode(_av_stream)
                    # NONKEY 步长覆盖：实体课堂 5 秒，电子课堂 3 秒
                    if _is_blackboard:
                        frame_step = max(1, int(fps * 5))
                    else:
                        frame_step = max(1, int(fps * 3))

        def _advance(frames_to_skip):
            """跳过指定帧数。优先用 PyAV 关键帧迭代（所有模式），失败则回退 seek/grab。"""
            nonlocal count, _keyframe_iter
            if frames_to_skip <= 0:
                return True, None

            # PyAV NONKEY 模式：获取下一个满足间距的关键帧
            # 对密集关键帧视频（如 H.264 每秒一个 I 帧），跳过间距不足的关键帧
            if _keyframe_iter is not None:
                try:
                    target_count = count + frames_to_skip
                    while True:
                        frame = next(_keyframe_iter)
                        if frame.pts is not None and _av_stream.time_base:
                            actual_sec = float(frame.pts * _av_stream.time_base)
                            frame_count = int(actual_sec * fps)
                        else:
                            frame_count = target_count  # 无 PTS 时直接使用
                        if frame_count >= target_count:
                            arr = frame.to_ndarray(format='bgr24')
                            count = frame_count
                            return True, arr
                        # 此关键帧离上一帧太近，跳过（不做 to_ndarray 省开销）
                except StopIteration:
                    return False, None
                except Exception as e:
                    print(f'[PyAV] 关键帧迭代失败 ({e})，回退 OpenCV')
                    _keyframe_iter = None  # 后续不再尝试

            # OpenCV seek（黑板模式备选）
            if _USE_SEEK:
                target_frame = count + frames_to_skip
                seek_ok = cap.set(cv2.CAP_PROP_POS_FRAMES, target_frame)
                if seek_ok:
                    ok, frame = cap.read()
                    if ok:
                        count = int(cap.get(cv2.CAP_PROP_POS_FRAMES))
                        return ok, frame
                # seek 失败（MSMF 后端限制），回退顺序 grab
                print(f'[Blackboard] seek 回退为顺序 grab（target={target_frame}）')
            # PPT 模式 / seek 回退：顺序 grab
            for _ in range(frames_to_skip):
                count += 1
                if not cap.grab():
                    return False, None
            ok, frame = cap.retrieve()
            return ok, frame

        _save_pool = ThreadPoolExecutor(max_workers=2)
        _save_futures = []

        def _async_save(frame, filepath, quality):
            buf = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, quality])[1]
            buf.tofile(filepath)

        _extract_start_time = time.time()

        # ── 保存第一帧（续传时跳过，因为断点帧只用于比较基准） ──
        if not is_resuming:
            fp = os.path.join(output_dir, f"slide_{saved_offset + saved:04d}.jpg")
            _save_futures.append(_save_pool.submit(_async_save, prev_frame.copy(), fp, _JPEG_QUALITY))
            saved += 1
            on_progress(saved, 0, f'已提取 {saved_offset + saved} 张', -1, 0, count)
        else:
            on_progress(saved, int(count / total_frames * 100),
                        f'从断点恢复，继续提取…', -1, 0, count)

        while True:
            if should_cancel():
                return ('cancelled', f'已取消，已保存 {saved_offset + saved} 张', saved)

            # ── 节流：让出少量 CPU 给系统和其他线程 ──
            time.sleep(_THROTTLE_INTERVAL)

            ok, curr_frame = _advance(frame_step)
            if not ok or curr_frame is None:
                break

            # ── 定期 gc 防止内存溢出（Fast 模式下产生帧数组极快） ──
            if count % _GC_EVERY_N_FRAMES == 0:
                gc.collect()

            if should_cancel():
                return ('cancelled', f'已取消，已保存 {saved_offset + saved} 张', saved)

            pct = min(99, int(count / total_frames * 100))
            elapsed = time.time() - _extract_start_time
            if pct > 2:
                eta = elapsed / pct * (100 - pct)
            else:
                eta = -1
            on_progress(saved, pct, f'已提取 {saved_offset + saved} 张', round(eta, 1), round(elapsed, 1), count)

            curr_gray = _to_gray(curr_frame)

            # ── 计算帧间差异（实体课堂模式：交集掩码消除残影） ──
            if backSub is not None:
                _bb_lr = 0.005 if _keyframe_iter is not None else -1
                fg_mask = backSub.apply(curr_gray, learningRate=_bb_lr)
                # 形态学处理：先闭合填充人物轮廓内空洞，再膨胀扩大遮罩覆盖范围
                fg_mask = cv2.morphologyEx(fg_mask, cv2.MORPH_CLOSE, _close_kernel)
                fg_mask = cv2.dilate(fg_mask, _dilate_kernel, iterations=2)
                bg_mask = cv2.bitwise_not(fg_mask)
                # 交集掩码：同时排除人物"现在的位置"和"刚才的位置"
                combined_bg = cv2.bitwise_and(bg_mask, prev_bg_mask)
                valid_pixels = cv2.countNonZero(combined_bg)
                total_pixels = curr_gray.shape[0] * curr_gray.shape[1]
                if valid_pixels < total_pixels * 0.10:
                    mean_diff = 0  # 人挡住了大部分画面，跳过
                else:
                    diff = cv2.absdiff(curr_gray, prev_gray)
                    masked_diff = cv2.bitwise_and(diff, diff, mask=combined_bg)
                    mean_diff = np.sum(masked_diff) / valid_pixels
            else:
                mean_diff = np.mean(cv2.absdiff(curr_gray, prev_gray))

            if mean_diff > threshold:
                if _skip_stable:
                    # ── 电子课堂 / 实体课堂：直接截图，不等稳定 ──
                    settled_frame = curr_frame
                    settled_gray = curr_gray
                elif _keyframe_iter is not None:
                    # ── PPT + NONKEY：用后续关键帧做稳定检测（等 PPT 动画播完） ──
                    _stable_need = 1 if _is_turbo else 2
                    stable = 0
                    last_gray = curr_gray
                    settled_frame = None
                    settled_gray = None
                    for _ in range(10):  # 最多检查 10 个后续关键帧
                        if should_cancel():
                            break
                        time.sleep(_THROTTLE_INTERVAL)
                        try:
                            sf = next(_keyframe_iter)
                            if sf.pts is not None and _av_stream.time_base:
                                count = int(float(sf.pts * _av_stream.time_base) * fps)
                            tmp_frame = sf.to_ndarray(format='bgr24')
                            tmp_gray = _to_gray(tmp_frame)
                            if np.mean(cv2.absdiff(tmp_gray, last_gray)) < max(threshold * 0.4, 2.5):
                                stable += 1
                            else:
                                stable = 0
                            last_gray = tmp_gray
                            if stable >= _stable_need:
                                settled_frame = tmp_frame
                                settled_gray = tmp_gray
                                break
                        except StopIteration:
                            break
                else:
                    # ── PPT 模式：稳定帧检测（等动画播完再截图） ──
                    _stable_secs = 0.3 if _is_turbo else 0.5
                    _stable_need = 1 if _is_turbo else 2
                    check_step = max(1, int(fps * _stable_secs))
                    stable = 0
                    last_gray = curr_gray
                    settled_frame = None
                    settled_gray = None

                    while True:
                        if should_cancel():
                            break
                        time.sleep(_THROTTLE_INTERVAL)
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
                        if stable >= _stable_need:
                            settled_frame = tmp
                            settled_gray = tmp_gray
                            break

                # 稳定帧检测后再检查一次取消
                if should_cancel():
                    return ('cancelled', f'已取消，已保存 {saved_offset + saved} 张', saved)

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
                        fp = os.path.join(output_dir, f"slide_{saved_offset + saved:04d}.jpg")
                        _save_futures.append(_save_pool.submit(_async_save, settled_frame.copy(), fp, _JPEG_QUALITY))
                        saved += 1
                        on_progress(saved, pct, f'已提取 {saved_offset + saved} 张',
                                    round(eta, 1), round(elapsed, 1), count)
                        prev_gray = settled_gray
                        if backSub is not None:
                            prev_bg_mask = bg_mask.copy()
                            # 15 秒步长本身已提供足够间隔，无需额外冷却
                        if enable_history:
                            history_pool.append(settled_gray)
                            if len(history_pool) > max_history:
                                history_pool.pop(0)
                    else:
                        prev_gray = settled_gray
                        if backSub is not None:
                            prev_bg_mask = bg_mask.copy()

        # ── 尾帧保护：捕获视频最后一帧的板书状态 ──
        # 主循环因 _advance() 到达视频末尾而 break，最后一段板书可能被跳过
        if backSub is not None and not should_cancel():
            cap.set(cv2.CAP_PROP_POS_FRAMES, total_frames - 1)
            ok_last, last_frame = cap.read()
            if ok_last and last_frame is not None:
                last_gray = _to_gray(last_frame)
                fg_mask = backSub.apply(last_gray)
                fg_mask = cv2.dilate(fg_mask, None, iterations=2)
                bg_mask = cv2.bitwise_not(fg_mask)
                combined_bg = cv2.bitwise_and(bg_mask, prev_bg_mask)
                valid_pixels = cv2.countNonZero(combined_bg)
                total_pixels = last_gray.shape[0] * last_gray.shape[1]
                if valid_pixels >= total_pixels * 0.10:
                    diff = cv2.absdiff(last_gray, prev_gray)
                    masked_diff = cv2.bitwise_and(diff, diff, mask=combined_bg)
                    last_diff = np.sum(masked_diff) / valid_pixels
                    if last_diff > threshold:
                        fp = os.path.join(output_dir, f"slide_{saved_offset + saved:04d}.jpg")
                        _save_futures.append(_save_pool.submit(_async_save, last_frame.copy(), fp, _JPEG_QUALITY))
                        saved += 1
                        print(f'[Blackboard] 尾帧保护：捕获最后一帧板书（diff={last_diff:.1f}）')

        elapsed_total = round(time.time() - _extract_start_time, 1)
        total_saved = saved_offset + saved
        return ('done',
                f'提取完成！共 {total_saved} 张幻灯片，耗时 {int(elapsed_total)}s',
                saved)

    except Exception as e:
        error_detail = traceback.format_exc()
        print(f"！！！ 提取发生严重错误！！！\n{error_detail}")
        err_msg = str(e)
        if 'memory' in err_msg.lower() or 'MemoryError' in type(e).__name__:
            hint = '内存不足，请关闭其他标签页或程序后重试。'
        elif 'permission' in err_msg.lower() or 'access' in err_msg.lower():
            hint = '文件权限被拒绝，请检查文件是否正在被其他程序使用。'
        elif isinstance(e, cv2.error):
            hint = '视频处理出错，建议用 FFmpeg 转码后重试。'
        else:
            hint = '请截图此错误并前往 GitHub Issues 反馈。'
        return ('error', f'提取出错: {err_msg}\n💡 {hint}', saved)

    finally:
        # ── 等待所有异步保存完成 ──
        for f in _save_futures:
            try:
                f.result()
            except Exception as save_err:
                print(f'[保存] 异步写盘失败: {save_err}')
        try:
            _save_pool.shutdown(wait=False)
        except Exception:
            pass
        # ── 关闭 PyAV 资源 ──
        if _av_container is not None:
            try:
                _av_container.close()
            except Exception:
                pass
        # ── 确保释放所有重量级资源 ──
        if cap is not None:
            try:
                cap.release()
            except Exception:
                pass
        cap = None
        history_pool = None
        # 立即触发垃圾回收，释放大量 numpy 数组占用的内存
        gc.collect()
