"""
影幻智提 (VidSlide) - 视频提取核心模块
======================================
负责从视频中检测场景变化并提取幻灯片截图。
支持 GPU 硬件加速解码（自动检测）和进程优先级调整。

作者: PWO-CHINA
版本: v0.4.2
"""

import cv2
import gc
import numpy as np
import os
import time
import traceback

try:
    import psutil
    HAS_PSUTIL = True
except ImportError:
    HAS_PSUTIL = False


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
                    print('[GPU] 已请求硬件加速，等待系统调度')
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
                   speed_mode='eco',
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

        total_frames = max(int(cap.get(cv2.CAP_PROP_FRAME_COUNT)), 1)
        fps = cap.get(cv2.CAP_PROP_FPS) or 30
        # Turbo: 2秒跳距（减少一半比较次数），其他: 1秒
        frame_step = max(1, int(fps * (2 if _is_turbo else 1)))

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
        history_pool = [prev_gray] if enable_history else None

        _extract_start_time = time.time()

        # ── 保存第一帧（续传时跳过，因为断点帧只用于比较基准） ──
        if not is_resuming:
            fp = os.path.join(output_dir, f"slide_{saved_offset + saved:04d}.jpg")
            cv2.imencode('.jpg', prev_frame, [cv2.IMWRITE_JPEG_QUALITY, 95])[1].tofile(fp)
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

            grabbed = True
            for _ in range(frame_step):
                count += 1
                if not cap.grab():
                    grabbed = False
                    break
            if not grabbed:
                break

            # ── 定期 gc 防止内存溢出（Fast 模式下产生帧数组极快） ──
            if count % _GC_EVERY_N_FRAMES == 0:
                gc.collect()

            if should_cancel():
                return ('cancelled', f'已取消，已保存 {saved_offset + saved} 张', saved)

            ok, curr_frame = cap.retrieve()
            if not ok:
                break

            pct = min(99, int(count / total_frames * 100))
            elapsed = time.time() - _extract_start_time
            if pct > 2:
                eta = elapsed / pct * (100 - pct)
            else:
                eta = -1
            on_progress(saved, pct, f'已提取 {saved_offset + saved} 张', round(eta, 1), round(elapsed, 1), count)

            curr_gray = _to_gray(curr_frame)
            mean_diff = np.mean(cv2.absdiff(curr_gray, prev_gray))

            if mean_diff > threshold:
                # Turbo: 稳定帧检测加速——0.3s 步长，1次确认；其他: 0.5s 步长，2次确认
                _stable_secs = 0.3 if _is_turbo else 0.5
                _stable_need = 1 if _is_turbo else 2
                check_step = max(1, int(fps * _stable_secs))
                stable = 0
                last_gray = curr_gray
                settled_frame = None
                settled_gray = None

                while True:
                    if should_cancel():
                        break  # 跳出稳定帧检测，外层会处理取消
                    time.sleep(_THROTTLE_INTERVAL)  # 子循环也节流
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
                        cv2.imencode('.jpg', settled_frame, [cv2.IMWRITE_JPEG_QUALITY, 95])[1].tofile(fp)
                        saved += 1
                        on_progress(saved, pct, f'已提取 {saved_offset + saved} 张',
                                    round(eta, 1), round(elapsed, 1), count)
                        prev_gray = settled_gray
                        if enable_history:
                            history_pool.append(settled_gray)
                            if len(history_pool) > max_history:
                                history_pool.pop(0)
                    else:
                        prev_gray = settled_gray

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
