/**
 * 影幻智提 (VidSlide) v0.5.3 - 批量处理核心模块
 * ================================================
 * 状态模型、SSE、初始化、恢复、工具函数
 * 依赖 main.js 中的 G, api(), showToast(), formatTime()
 */

// ============================================================
//  工具函数
// ============================================================
function _escHtml(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
}

function _formatDuration(seconds) {
    seconds = Math.round(seconds);
    if (seconds < 0) return '--';
    if (seconds < 60) return seconds + '秒';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    if (m < 60) return m + '分' + (s > 0 ? s + '秒' : '');
    const h = Math.floor(m / 60);
    return h + '小时' + (m % 60) + '分';
}

function _formatBatchTime(seconds) {
    if (!seconds || seconds <= 0) return '0s';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    if (m > 0) return m + '分' + s + '秒';
    return s + '秒';
}

// ============================================================
//  参数记忆（localStorage）
// ============================================================
const _BATCH_PREFS_KEY = 'vidslide_batch_prefs';

function _loadBatchPrefs() {
    try {
        const raw = localStorage.getItem(_BATCH_PREFS_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
}

function _saveBatchPrefs(params) {
    try {
        localStorage.setItem(_BATCH_PREFS_KEY, JSON.stringify(params));
    } catch {}
}

// ============================================================
//  完成音效
// ============================================================
function _playBatchDoneSound() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const notes = [523.25, 659.25, 783.99];
        notes.forEach((freq, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(0.15, ctx.currentTime + i * 0.15);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.15 + 0.4);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(ctx.currentTime + i * 0.15);
            osc.stop(ctx.currentTime + i * 0.15 + 0.4);
        });
    } catch {}
}

// ============================================================
//  队列计数徽章
// ============================================================
function _updateBatchBadge() {
    const btn = document.getElementById('btnToggleMode');
    if (!btn) return;
    let count = 0;
    if (G.batch) {
        const z = G.batch.zones;
        count = z.unselected.length + z.queue.length + z.completed.length;
    }
    if (G.batchMode) {
        btn.innerHTML = '📑 标签页模式';
    } else if (count > 0) {
        btn.innerHTML = '📋 批量模式 <span class="inline-flex items-center justify-center w-4 h-4 text-[10px] font-bold bg-red-500 text-white rounded-full ml-1">' + count + '</span>';
    } else {
        btn.innerHTML = '📋 批量模式';
    }
}

// ============================================================
//  视图切换
// ============================================================
function toggleBatchMode() {
    G.batchMode = !G.batchMode;
    const main = document.querySelector('main');
    const panel = document.getElementById('batchPanel');
    const resBar = document.getElementById('resourceBar');
    if (G.batchMode) {
        main.style.display = 'none';
        panel.style.display = '';
        if (resBar) resBar.style.display = '';
        if (!G.batch) {
            _initBatch();
        } else {
            _applyBatchPrefsToUI();
        }
    } else {
        main.style.display = '';
        panel.style.display = 'none';
    }
    _updateBatchBadge();
}

// ============================================================
//  参数 UI
// ============================================================
function _applyBatchPrefsToUI() {
    if (!G.batch) return;
    const p = G.batch.params;
    const el = (id) => document.getElementById(id);
    el('batchThreshold').value = p.threshold ?? 5;
    el('batchThresholdVal').textContent = p.threshold ?? 5;
    el('batchUseRoi').checked = p.use_roi ?? true;
    el('batchFastMode').checked = p.fast_mode ?? true;
    el('batchUseGpu').checked = p.use_gpu ?? true;
    el('batchEnableHistory').checked = p.enable_history ?? true;
    el('batchMaxHistory').value = p.max_history ?? 5;
    el('batchSpeedMode').value = p.speed_mode ?? 'fast';
}

function _readBatchParams() {
    const el = (id) => document.getElementById(id);
    return {
        threshold: parseFloat(el('batchThreshold').value),
        fast_mode: el('batchFastMode').checked,
        use_roi: el('batchUseRoi').checked,
        use_gpu: el('batchUseGpu').checked,
        enable_history: el('batchEnableHistory').checked,
        max_history: parseInt(el('batchMaxHistory').value),
        speed_mode: el('batchSpeedMode').value,
    };
}

// ============================================================
//  批量初始化
// ============================================================
let _maxBatchWorkers = 3;

async function _initBatch() {
    const prefs = _loadBatchPrefs();
    const params = {
        threshold: prefs.threshold ?? 5,
        fast_mode: prefs.fast_mode ?? true,
        use_roi: prefs.use_roi ?? true,
        use_gpu: prefs.use_gpu ?? true,
        enable_history: prefs.enable_history ?? true,
        max_history: prefs.max_history ?? 5,
        speed_mode: prefs.speed_mode ?? 'fast',
    };
    try {
        const res = await api('/api/batch/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ params, max_workers: 1 }),
        });
        if (!res.success) {
            showToast(res.message || '创建批量队列失败', 'error');
            return;
        }
        _maxBatchWorkers = res.max_batch_workers || 3;
        G.batch = {
            bid: res.batch_id,
            zones: { unselected: [], queue: [], completed: [] },
            status: 'idle',
            params,
            maxWorkers: 1,
            eventSource: null,
            completedCount: 0,
            failedCount: 0,
            globalProgress: 0,
            totalImages: 0,
            sseErrorCount: 0,
            _startTime: 0,
        };
        _applyBatchPrefsToUI();
        _updateWorkerOptions();
        _connectBatchSSE();
    } catch (e) {
        showToast('创建批量队列失败: ' + e.message, 'error');
    }
}

function _updateWorkerOptions() {
    const sel = document.getElementById('batchWorkerCount');
    if (!sel) return;
    for (const opt of sel.options) {
        const v = parseInt(opt.value);
        opt.disabled = v > _maxBatchWorkers;
    }
}

// ============================================================
//  批量 SSE
// ============================================================
function _connectBatchSSE() {
    if (!G.batch) return;
    if (G.batch.eventSource) G.batch.eventSource.close();
    G.batch.sseErrorCount = 0;
    const es = new EventSource(`/api/batch/${G.batch.bid}/events`);
    G.batch.eventSource = es;
    es.onmessage = (e) => {
        G.batch.sseErrorCount = 0;
        try {
            const data = JSON.parse(e.data);
            _handleBatchSSE(data);
        } catch (err) {
            console.warn('[BatchSSE] 解析错误:', err);
        }
    };
    es.onerror = () => {
        G.batch.sseErrorCount++;
        if (G.batch.sseErrorCount >= 3) {
            console.error('[BatchSSE] 重连失败，放弃连接');
            _disconnectBatchSSE();
        }
    };
}

function _disconnectBatchSSE() {
    if (G.batch && G.batch.eventSource) {
        G.batch.eventSource.close();
        G.batch.eventSource = null;
    }
}

function _handleBatchSSE(data) {
    if (!G.batch) return;
    switch (data.type) {
        case 'init':
            _handleBatchInit(data.state);
            break;
        case 'batch_status':
            G.batch.status = data.status;
            renderAllZones();
            _updateBatchControls();
            break;
        case 'video_status':
            _handleVideoStatus(data);
            break;
        case 'video_progress':
            _handleVideoProgress(data);
            break;
        case 'zone_change':
            _handleZoneChange(data);
            break;
        case 'video_error':
            _handleVideoError(data);
            break;
        case 'queue_idle':
            _handleQueueIdle(data);
            break;
        case 'disk_warning':
            _showDiskWarning(data.free_mb);
            break;
        case 'packaging':
        case 'packaging_done':
        case 'packaging_error':
        case 'batch_packaging':
        case 'batch_packaging_done':
        case 'batch_packaging_error':
            _handlePackagingEvent(data);
            break;
    }
}

function _handleBatchInit(state) {
    if (!state || !G.batch) return;
    G.batch.status = state.status;
    G.batch.completedCount = state.completed_count;
    G.batch.failedCount = state.failed_count;
    G.batch.totalImages = state.total_images;
    G.batch.globalProgress = state.global_progress;

    // 按 zone 分组映射
    G.batch.zones = { unselected: [], queue: [], completed: [] };
    for (const zone of ['unselected', 'queue', 'completed']) {
        G.batch.zones[zone] = (state.zones[zone] || []).map(_mapTask);
    }

    renderAllZones();
    _updateBatchControls();
    _updateGlobalProgress();
}

function _mapTask(t) {
    return {
        vid: t.id,
        videoPath: t.video_path,
        displayName: t.display_name,
        zone: t.zone,
        status: t.status,
        progress: t.progress,
        message: t.message,
        savedCount: t.saved_count,
        etaSeconds: t.eta_seconds,
        elapsedSeconds: t.elapsed_seconds,
        errorMessage: t.error_message,
        retryCount: t.retry_count,
        totalFrames: t.total_frames,
        fps: t.fps || 0,
        resolution: t.resolution || [0, 0],
        estimatedTime: t.estimated_time || -1,
        selected: false,
    };
}

function _findTask(vid) {
    if (!G.batch) return null;
    for (const zone of ['unselected', 'queue', 'completed']) {
        const t = G.batch.zones[zone].find(t => t.vid === vid);
        if (t) return t;
    }
    return null;
}

function _handleVideoStatus(data) {
    const task = _findTask(data.video_id);
    if (!task) return;
    const oldStatus = task.status;
    task.status = data.status;
    if (data.message !== undefined) task.message = data.message;
    if (oldStatus !== data.status) {
        renderAllZones();
    } else {
        _updateVideoItemInPlace(data.video_id);
    }
    _updateBatchControls();
}

function _handleVideoProgress(data) {
    const task = _findTask(data.video_id);
    if (!task) return;
    task.status = 'running';
    task.progress = data.progress || 0;
    task.message = data.message || '';
    task.savedCount = data.saved_count || task.savedCount;
    task.etaSeconds = data.eta_seconds ?? -1;
    task.elapsedSeconds = data.elapsed_seconds ?? 0;
    _updateVideoItemInPlace(data.video_id);
    if (data.global_progress !== undefined) {
        G.batch.globalProgress = data.global_progress;
    }
    _updateGlobalProgress();
}

function _handleZoneChange(data) {
    // 重新获取完整状态以保持一致性
    _refreshBatchState();
}

function _handleVideoError(data) {
    const task = _findTask(data.video_id);
    if (task) {
        task.status = data.status || 'error';
        task.errorMessage = data.message || '';
        task.message = data.message || '处理失败';
        task.savedCount = data.saved_count || task.savedCount;
    }
    if (data.global_progress !== undefined) G.batch.globalProgress = data.global_progress;
    renderAllZones();
    _updateBatchControls();
    _updateGlobalProgress();
}

function _handleQueueIdle(data) {
    G.batch.status = 'idle';
    G.batch.completedCount = data.completed_count || G.batch.completedCount;
    G.batch.failedCount = data.failed_count || G.batch.failedCount;
    G.batch.totalImages = data.total_images || G.batch.totalImages;
    _updateBatchControls();
    _updateGlobalProgress();
    _updateBatchBadge();

    // 检查是否有已完成的视频（播放音效+通知）
    if (G.batch.zones.completed.length > 0) {
        _playBatchDoneSound();
        _notifyBatchComplete(data);
    }
    renderAllZones();
}

async function _refreshBatchState() {
    if (!G.batch) return;
    try {
        const res = await api('/api/batch/' + G.batch.bid + '/status');
        if (res.success) _handleBatchInit(res.batch);
    } catch {}
}

function _showDiskWarning(freeMb) {
    const el = document.getElementById('batchDiskWarning');
    const freeEl = document.getElementById('batchDiskFree');
    if (el) el.style.display = '';
    if (freeEl) freeEl.textContent = freeMb;
}

// ============================================================
//  完成通知
// ============================================================
let _batchTitleFlash = null;

function _notifyBatchComplete(data) {
    const images = data.total_images || G.batch.totalImages || 0;
    const elapsed = data.elapsed_seconds || 0;
    const elapsedStr = _formatBatchTime(elapsed);

    const banner = document.getElementById('batchCompleteBanner');
    const bannerText = document.getElementById('batchCompleteText');
    if (banner && bannerText) {
        bannerText.textContent = '批量处理完成！共提取 ' + images + ' 张图片，耗时 ' + elapsedStr;
        banner.style.display = '';
    }

    if (_batchTitleFlash) clearInterval(_batchTitleFlash);
    const origTitle = document.title;
    _batchTitleFlash = setInterval(() => {
        document.title = document.title.startsWith('✅')
            ? origTitle
            : '✅ 批量处理完成 - VidSlide';
    }, 1000);
    window.addEventListener('focus', () => {
        if (_batchTitleFlash) { clearInterval(_batchTitleFlash); _batchTitleFlash = null; }
        document.title = origTitle;
    }, { once: true });

    if ('Notification' in window) {
        if (Notification.permission === 'granted') {
            new Notification('VidSlide 批量处理完成', {
                body: '已提取 ' + images + ' 张幻灯片，耗时 ' + elapsedStr,
            });
        } else if (Notification.permission !== 'denied') {
            Notification.requestPermission().then(p => {
                if (p === 'granted') {
                    new Notification('VidSlide 批量处理完成', {
                        body: '已提取 ' + images + ' 张幻灯片',
                    });
                }
            });
        }
    }
}

// ============================================================
//  批量模式恢复
// ============================================================
async function _recoverBatch() {
    try {
        const res = await api('/api/batches');
        if (!res.success || !res.batches || res.batches.length === 0) return false;
        _maxBatchWorkers = res.max_batch_workers || 3;
        const info = res.batches[0];
        const stateRes = await api('/api/batch/' + info.id + '/status');
        if (!stateRes.success) return false;
        const state = stateRes.batch;
        G.batch = {
            bid: state.id,
            zones: { unselected: [], queue: [], completed: [] },
            status: state.status,
            params: state.params || {},
            maxWorkers: state.max_workers || 1,
            eventSource: null,
            completedCount: state.completed_count || 0,
            failedCount: state.failed_count || 0,
            globalProgress: state.global_progress || 0,
            totalImages: state.total_images || 0,
            sseErrorCount: 0,
            _startTime: 0,
        };
        for (const zone of ['unselected', 'queue', 'completed']) {
            G.batch.zones[zone] = (state.zones[zone] || []).map(_mapTask);
        }
        _connectBatchSSE();
        return true;
    } catch (e) {
        console.warn('[Batch] 恢复失败:', e);
        return false;
    }
}

// ============================================================
//  参数面板事件绑定
// ============================================================
function _initBatchParamEvents() {
    const el = (id) => document.getElementById(id);
    el('batchThreshold').addEventListener('input', function() {
        el('batchThresholdVal').textContent = this.value;
    });
    el('batchWorkerCount').addEventListener('change', async function() {
        if (!G.batch) return;
        const n = parseInt(this.value);
        await api('/api/batch/' + G.batch.bid + '/set-workers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ max_workers: n }),
        });
    });
}

// ============================================================
//  批量模式清空
// ============================================================
async function cleanupBatchMode() {
    if (!G.batch) { showToast('没有需要清理的批量队列', 'info'); return; }
    if (G.batch.status === 'processing') {
        if (!confirm('批量处理正在运行中，确定要清空吗？')) return;
    } else {
        if (!confirm('确定清空批量队列的所有数据吗？')) return;
    }
    _disconnectBatchSSE();
    await api('/api/batch/' + G.batch.bid + '/cleanup', { method: 'POST' });
    G.batch = null;
    renderAllZones();
    _updateBatchBadge();
    showToast('批量队列已清空', 'success');
    if (G.batchMode) {
        _initBatch();
    }
}
