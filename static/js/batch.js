/**
 * 影幻智提 (VidSlide) v0.5.0 - 批量处理前端模块
 * ================================================
 * 依赖 main.js 中的 G, api(), showToast(), formatTime() 等全局函数。
 */

// ============================================================
//  批量模式状态
// ============================================================
let _batchPendingPaths = [];   // 待命名的视频路径列表
let _batchSortable = null;     // SortableJS 实例（队列）
let _batchAddSortable = null;  // SortableJS 实例（命名弹窗）
let _batchTitleFlash = null;   // 标题闪烁 interval
let _maxBatchWorkers = 3;      // 服务器返回的硬件上限
let _batchDetailVid = null;    // 当前打开的详情弹窗视频 ID
let _batchDetailImages = [];   // 详情弹窗图片列表
let _batchPreviewIdx = -1;     // 详情弹窗大图预览索引
let _batchDetailDeletedStack = []; // 详情弹窗图片删除栈（Ctrl+Z 撤销）
let _batchDetailSortable = null;   // 详情弹窗画廊 SortableJS 实例

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
//  完成音效（Web Audio API）
// ============================================================
function _playBatchDoneSound() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const notes = [523.25, 659.25, 783.99]; // C5, E5, G5
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
    const count = G.batch ? G.batch.tasks.length : 0;
    if (G.batchMode) {
        btn.innerHTML = '\uD83D\uDCD1 \u6807\u7B7E\u9875\u6A21\u5F0F';
    } else if (count > 0) {
        btn.innerHTML = '\uD83D\uDCCB \u6279\u91CF\u6A21\u5F0F <span class="inline-flex items-center justify-center w-4 h-4 text-[10px] font-bold bg-red-500 text-white rounded-full ml-1">' + count + '</span>';
    } else {
        btn.innerHTML = '\uD83D\uDCCB \u6279\u91CF\u6A21\u5F0F';
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
        // 资源监控条在批量模式下也显示
        if (resBar) resBar.style.display = '';
        // 首次进入批量模式时，如果没有 batch，创建一个
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
//  批量初始化
// ============================================================
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
            tasks: [],
            status: 'idle',
            params,
            maxWorkers: 1,
            eventSource: null,
            completedCount: 0,
            failedCount: 0,
            totalCount: 0,
            globalProgress: 0,
            totalImages: 0,
            sseErrorCount: 0,
        };
        _applyBatchPrefsToUI();
        _updateWorkerOptions();
        _connectBatchSSE();
    } catch (e) {
        showToast('创建批量队列失败: ' + e.message, 'error');
    }
}

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

function _updateWorkerOptions() {
    const sel = document.getElementById('batchWorkerCount');
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
            _renderBatchQueue();
            _updateBatchControls();
            break;
        case 'video_status':
            _updateTaskStatus(data.video_id, data.status, data.message);
            break;
        case 'video_progress':
            _updateTaskProgress(data);
            break;
        case 'video_done':
            _onVideoDone(data);
            break;
        case 'video_error':
            _onVideoError(data);
            break;
        case 'batch_done':
            _onBatchDone(data);
            break;
        case 'disk_warning':
            _showDiskWarning(data.free_mb);
            break;
        case 'packaging':
            _onPackagingProgress(data);
            break;
        case 'packaging_done':
            _onPackagingDone(data);
            break;
        case 'packaging_error':
            _onPackagingError(data);
            break;
        case 'batch_packaging':
            _onBatchPackagingProgress(data);
            break;
        case 'batch_packaging_done':
            _onBatchPackagingDone(data);
            break;
        case 'batch_packaging_error':
            showToast('批量打包失败: ' + data.message, 'error');
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
    G.batch.tasks = (state.tasks || []).map(t => ({
        vid: t.id,
        videoPath: t.video_path,
        displayName: t.display_name,
        status: t.status,
        progress: t.progress,
        message: t.message,
        savedCount: t.saved_count,
        etaSeconds: t.eta_seconds,
        elapsedSeconds: t.elapsed_seconds,
        errorMessage: t.error_message,
        retryCount: t.retry_count,
    }));
    G.batch.totalCount = G.batch.tasks.length;
    _renderBatchQueue();
    _updateBatchControls();
    _updateGlobalProgress();
}

// ============================================================
//  添加视频
// ============================================================
async function addVideosToBatch() {
    if (!G.batch) { showToast('请先进入批量模式', 'warning'); return; }
    try {
        const res = await api('/api/select-videos', { method: 'POST' });
        if (!res.success) { showToast(res.message || '未选择文件', 'info'); return; }
        _batchPendingPaths = res.paths || [];
        if (_batchPendingPaths.length === 0) return;
        _showBatchAddModal(_batchPendingPaths);
    } catch (e) {
        showToast('选择文件失败: ' + e.message, 'error');
    }
}

async function scanFolderForBatch() {
    if (!G.batch) { showToast('请先进入批量模式', 'warning'); return; }
    try {
        const res = await api('/api/select-folder', { method: 'POST' });
        if (!res.success) { showToast(res.message || '未选择文件夹', 'info'); return; }
        _batchPendingPaths = res.paths || [];
        if (_batchPendingPaths.length === 0) return;
        _showBatchAddModal(_batchPendingPaths);
    } catch (e) {
        showToast('扫描文件夹失败: ' + e.message, 'error');
    }
}

// ============================================================
//  命名弹窗
// ============================================================
function _showBatchAddModal(paths) {
    const modal = document.getElementById('batchAddModal');
    const list = document.getElementById('batchAddList');
    const autoInc = document.getElementById('batchAutoIncrement');
    const baseInput = document.getElementById('batchBaseNameInput');
    const btnPreview = document.getElementById('btnPreviewIncrement');

    // 重置命名模式
    const originalRadio = document.querySelector('input[name="batchNamingMode"][value="original"]');
    if (originalRadio) originalRadio.checked = true;
    _onNamingModeChange();

    // 重置自由编辑区域
    if (autoInc) autoInc.checked = false;
    if (baseInput) { baseInput.disabled = true; baseInput.value = ''; }
    if (btnPreview) btnPreview.disabled = true;

    // 重置模板区域
    const courseName = document.getElementById('batchCourseName');
    if (courseName) courseName.value = '';
    const startNum = document.getElementById('batchStartNum');
    if (startNum) startNum.value = '1';

    // 渲染文件列表（带拖拽手柄 + 缩略图）
    list.innerHTML = '';
    paths.forEach((p, i) => {
        const name = p.split(/[/\\]/).pop().replace(/\.[^.]+$/, '');
        const item = document.createElement('div');
        item.className = 'batch-add-list-item';
        item.innerHTML =
            '<span class="batch-add-drag-handle" title="\u62D6\u62FD\u8C03\u6574\u987A\u5E8F">\u2807</span>' +
            '<img class="batch-add-thumb" data-path="' + _escHtml(p) + '" src="" alt="" style="width:64px;height:36px;object-fit:cover;border-radius:3px;background:#e2e8f0;flex-shrink:0">' +
            '<input type="text" value="' + _escHtml(name) + '" data-path="' + _escHtml(p) + '" data-idx="' + i + '" placeholder="\u8F93\u5165\u663E\u793A\u540D\u79F0" class="batch-name-field">' +
            '<span class="text-xs text-slate-400 truncate max-w-[150px]" title="' + _escHtml(p) + '">' + _escHtml(p.split(/[/\\]/).pop()) + '</span>';
        list.appendChild(item);
    });

    // 异步加载缩略图
    document.querySelectorAll('#batchAddList .batch-add-thumb').forEach(async (img) => {
        try {
            const res = await api('/api/video-preview-thumb', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: img.dataset.path }),
            });
            if (res.success && res.thumbnail) {
                img.src = res.thumbnail;
            }
        } catch (e) { /* 缩略图加载失败不影响功能 */ }
    });

    // 初始化拖拽排序
    if (_batchAddSortable) _batchAddSortable.destroy();
    _batchAddSortable = Sortable.create(list, {
        animation: 200,
        handle: '.batch-add-drag-handle',
        ghostClass: 'sortable-ghost',
        onEnd() {
            // 更新 _batchPendingPaths 顺序
            const fields = list.querySelectorAll('.batch-name-field');
            _batchPendingPaths = Array.from(fields).map(f => f.dataset.path);
        },
    });

    // 自动递增开关（自由编辑模式下）
    if (autoInc) {
        autoInc.onchange = () => {
            if (baseInput) baseInput.disabled = !autoInc.checked;
            if (btnPreview) btnPreview.disabled = !autoInc.checked;
            if (autoInc.checked && baseInput && !baseInput.value) {
                const first = list.querySelector('.batch-name-field');
                if (first) baseInput.value = first.value;
            }
        };
    }

    modal.style.display = '';

    // ESC 关闭命名弹窗
    const _batchAddModalKeyHandler = (e) => {
        if (e.key === 'Escape') {
            cancelBatchAdd();
            document.removeEventListener('keydown', _batchAddModalKeyHandler);
        }
    };
    document.addEventListener('keydown', _batchAddModalKeyHandler);
}

async function previewAutoIncrement() {
    const baseInput = document.getElementById('batchBaseNameInput');
    const baseName = baseInput.value.trim();
    if (!baseName) { showToast('请输入基础名称', 'warning'); return; }
    try {
        const res = await api('/api/batch/auto-increment-names', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ base_name: baseName, count: _batchPendingPaths.length }),
        });
        if (res.success && res.names) {
            const fields = document.querySelectorAll('#batchAddList .batch-name-field');
            res.names.forEach((n, i) => { if (fields[i]) fields[i].value = n; });
            showToast('已预览递增命名', 'success', 2000);
        }
    } catch (e) {
        showToast('预览失败: ' + e.message, 'error');
    }
}

function cancelBatchAdd() {
    document.getElementById('batchAddModal').style.display = 'none';
    _batchPendingPaths = [];
}

async function confirmBatchAdd() {
    if (!G.batch) return;
    const fields = document.querySelectorAll('#batchAddList .batch-name-field');
    const entries = [];
    fields.forEach(f => {
        const path = f.dataset.path;
        const name = f.value.trim() || path.split(/[/\\]/).pop().replace(/\.[^.]+$/, '');
        entries.push({ path, name });
    });
    if (entries.length === 0) return;

    // 重复名称检测：新增视频之间 + 与已有队列
    const existingNames = G.batch.tasks.map(t => t.displayName);
    const allNames = [...existingNames];
    const duplicates = [];
    for (const e of entries) {
        if (allNames.includes(e.name)) {
            duplicates.push(e.name);
        }
        allNames.push(e.name);
    }
    if (duplicates.length > 0) {
        const unique = [...new Set(duplicates)];
        showToast('\u5B58\u5728\u91CD\u590D\u540D\u79F0\uFF1A' + unique.join(', ') + '\uFF0C\u8BF7\u4FEE\u6539\u540E\u91CD\u8BD5', 'warning', 4000);
        return;
    }

    document.getElementById('batchAddModal').style.display = 'none';

    try {
        const res = await api(`/api/batch/${G.batch.bid}/add-videos`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entries }),
        });
        if (res.success) {
            // 添加到本地状态
            for (const a of (res.added || [])) {
                G.batch.tasks.push({
                    vid: a.id,
                    videoPath: a.video_path,
                    displayName: a.display_name,
                    status: a.status,
                    progress: 0, message: '', savedCount: 0,
                    etaSeconds: -1, elapsedSeconds: 0,
                    errorMessage: '', retryCount: 0,
                });
            }
            G.batch.totalCount = G.batch.tasks.length;
            _renderBatchQueue();
            _updateBatchControls();
            _updateBatchBadge();
            showToast(`已添加 ${res.count} 个视频`, 'success', 2000);
        } else {
            showToast(res.message || '添加失败', 'error');
        }
    } catch (e) {
        showToast('添加视频失败: ' + e.message, 'error');
    }
    _batchPendingPaths = [];
}

// ============================================================
//  队列渲染
// ============================================================
function _renderBatchQueue() {
    if (!G.batch) return;
    const list = document.getElementById('batchQueueList');
    const empty = document.getElementById('batchEmptyHint');
    const countEl = document.getElementById('batchQueueCount');
    const clearBtn = document.getElementById('btnBatchClearQueue');
    const tasks = G.batch.tasks;
    countEl.textContent = '\uFF08' + tasks.length + ' \u4E2A\u89C6\u9891\uFF09';
    if (tasks.length === 0) {
        list.style.display = 'none';
        empty.style.display = '';
        clearBtn.style.display = 'none';
        return;
    }
    list.style.display = '';
    empty.style.display = 'none';
    clearBtn.style.display = tasks.some(t => t.status === 'queued') ? '' : 'none';
    list.innerHTML = '';
    const frag = document.createDocumentFragment();
    tasks.forEach(t => frag.appendChild(_createVideoItem(t)));
    list.appendChild(frag);
    _initBatchSortable();
}

function _createVideoItem(task) {
    const div = document.createElement('div');
    div.className = 'batch-video-item status-' + task.status;
    div.dataset.vid = task.vid;
    const statusLabels = {
        queued: '\u6392\u961F\u4E2D', running: '\u5904\u7406\u4E2D', done: '\u5DF2\u5B8C\u6210',
        error: '\u5931\u8D25', skipped: '\u5DF2\u8DF3\u8FC7', cancelled: '\u5DF2\u53D6\u6D88',
        paused: '\u5DF2\u6682\u505C',
    };
    const bid = G.batch.bid;
    const thumbUrl = '/api/batch/' + bid + '/thumbnail/' + task.vid;
    const batchRunning = G.batch && G.batch.status === 'running';

    // 有图片的非运行状态视频也可以点击查看
    const hasImages = task.savedCount > 0;
    const canView = task.status === 'done' || (hasImages && ['cancelled', 'skipped', 'error', 'paused'].includes(task.status));

    // 名称单击 = 重命名（非运行状态），查看详情用"查看"按钮
    let nameClick;
    if (task.status !== 'running') {
        nameClick = ' onclick="_startInlineEdit(this)" style="cursor:text"';
    } else {
        nameClick = '';
    }
    const nameTitle = task.status !== 'running' ? '\u70B9\u51FB\u91CD\u547D\u540D' : '';

    // 已完成视频的勾选框
    const checkbox = task.status === 'done'
        ? '<input type="checkbox" class="batch-select-cb" data-vid="' + task.vid + '" ' + (task.selected !== false ? 'checked' : '') + ' onclick="event.stopPropagation();_onBatchSelectChange(\'' + task.vid + '\', this.checked)" title="\u9009\u62E9\u5BFC\u51FA">'
        : '';

    div.innerHTML =
        checkbox +
        '<span class="drag-handle" title="\u62D6\u62FD\u6392\u5E8F">\u2807</span>' +
        '<img class="batch-thumbnail" src="' + thumbUrl + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">' +
        '<div class="flex-1 min-w-0">' +
            '<div class="batch-video-name" data-vid="' + task.vid + '"' + nameClick + ' title="' + nameTitle + '">' + _escHtml(task.displayName) + (task.savedCount > 0 ? ' <span class="text-xs text-slate-400">(' + task.savedCount + '\u5F20)</span>' : '') + '</div>' +
            '<div class="text-xs text-slate-400 mt-0.5 truncate batch-item-message">' + _escHtml(task.message || '') + '</div>' +
        '</div>' +
        '<div class="batch-mini-progress" style="' + (task.status === 'running' ? '' : 'display:none') + '">' +
            '<div class="batch-mini-progress-fill" style="width:' + task.progress + '%"></div>' +
        '</div>' +
        '<span class="batch-status-badge ' + task.status + '">' + (statusLabels[task.status] || task.status) + '</span>' +
        '<div class="batch-item-actions">' +
            (task.status === 'queued' ? '<button onclick="_prioritizeVideo(\'' + task.vid + '\')" class="btn-ghost text-xs" title="\u4F18\u5148\u5904\u7406">\u2B06</button>' : '') +
            (task.status === 'queued' && !batchRunning ? '<button onclick="_removeVideo(\'' + task.vid + '\')" class="btn-ghost-danger text-xs" title="\u79FB\u9664">\u2715</button>' : '') +
            (task.status === 'queued' && batchRunning ? '<button onclick="_skipVideo(\'' + task.vid + '\')" class="bg-yellow-500 hover:bg-yellow-600 text-white text-xs px-2 py-0.5 rounded transition" title="\u8DF3\u8FC7\u6B64\u89C6\u9891">\u8DF3\u8FC7</button>' : '') +
            (task.status === 'running' ? '<button onclick="_pauseVideo(\'' + task.vid + '\')" class="bg-orange-500 hover:bg-orange-600 text-white text-xs px-2 py-0.5 rounded transition" title="\u6682\u505C\u5904\u7406">\u6682\u505C</button>' : '') +
            ((task.status === 'error' || task.status === 'skipped' || task.status === 'cancelled' || task.status === 'paused') ? '<button onclick="_retryVideo(\'' + task.vid + '\')" class="btn-ghost text-xs" title="\u91CD\u65B0\u52A0\u5165\u961F\u5217">\u91CD\u65B0\u6392\u961F</button>' : '') +
            (canView ? '<button onclick="openBatchDetail(\'' + task.vid + '\')" class="btn-ghost text-xs" title="\u67E5\u770B\u56FE\u7247">\u67E5\u770B</button>' : '') +
            (task.status === 'done' ? '<button onclick="_packageVideo(\'' + task.vid + '\',\'zip\')" class="btn-ghost text-xs" title="ZIP \u6253\u5305">ZIP</button>' : '') +
            (task.status === 'done' ? '<button onclick="_packageVideo(\'' + task.vid + '\',\'pdf\')" class="btn-ghost text-xs" title="PDF \u5BFC\u51FA">PDF</button>' : '') +
            (task.status === 'done' ? '<button onclick="_packageVideo(\'' + task.vid + '\',\'pptx\')" class="btn-ghost text-xs" title="PPTX \u5BFC\u51FA">PPTX</button>' : '') +
            ((task.status === 'done' || task.status === 'cancelled' || task.status === 'error' || task.status === 'skipped' || task.status === 'paused') ? '<button onclick="_trashBatchVideo(\'' + task.vid + '\')" class="btn-ghost-danger text-xs" title="\u79FB\u5165\u56DE\u6536\u7AD9">\uD83D\uDDD1</button>' : '') +
        '</div>';
    return div;
}

function _updateVideoItemUI(vid) {
    const task = G.batch.tasks.find(t => t.vid === vid);
    if (!task) return;
    const el = document.querySelector('.batch-video-item[data-vid="' + vid + '"]');
    if (!el) return;
    el.className = 'batch-video-item status-' + task.status;
    const prog = el.querySelector('.batch-mini-progress');
    const fill = el.querySelector('.batch-mini-progress-fill');
    if (prog && fill) {
        prog.style.display = task.status === 'running' ? '' : 'none';
        fill.style.width = task.progress + '%';
    }
    const badge = el.querySelector('.batch-status-badge');
    if (badge) {
        const labels = { queued:'\u6392\u961F\u4E2D', running:'\u5904\u7406\u4E2D', done:'\u5DF2\u5B8C\u6210', error:'\u5931\u8D25', skipped:'\u5DF2\u8DF3\u8FC7', cancelled:'\u5DF2\u53D6\u6D88' };
        badge.className = 'batch-status-badge ' + task.status;
        badge.textContent = labels[task.status] || task.status;
    }
    const msg = el.querySelector('.batch-item-message');
    if (msg) msg.textContent = task.message || '';
}

// ============================================================
//  行内编辑名称
// ============================================================
function _startInlineEdit(nameEl) {
    if (nameEl.querySelector('input')) return;
    const vid = nameEl.dataset.vid;
    // 从 task 数据获取真实名称，避免把 "(16张)" 等 DOM 文本混入
    const task = G.batch ? G.batch.tasks.find(t => t.vid === vid) : null;
    const oldName = task ? task.displayName : nameEl.firstChild ? nameEl.firstChild.textContent.trim() : nameEl.textContent.trim();
    nameEl.innerHTML = '<input type="text" class="batch-video-name-input" value="' + _escHtml(oldName) + '">';
    const input = nameEl.querySelector('input');
    input.focus();
    input.select();
    const finish = async () => {
        const newName = input.value.trim() || oldName;
        // 重复名称检测
        if (newName !== oldName && G.batch) {
            const dup = G.batch.tasks.find(t => t.vid !== vid && t.displayName === newName);
            if (dup) {
                showToast('\u5DF2\u5B58\u5728\u540C\u540D\u89C6\u9891\uFF1A' + newName + '\uFF0C\u8BF7\u4F7F\u7528\u4E0D\u540C\u540D\u79F0', 'warning', 3000);
                // 恢复原名称显示
                _restoreNameEl(nameEl, oldName, task);
                return;
            }
        }
        // 更新显示（含图片数量标签）
        _restoreNameEl(nameEl, newName, task);
        if (newName !== oldName && G.batch) {
            if (task) task.displayName = newName;
            await api('/api/batch/' + G.batch.bid + '/update-name/' + vid, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: newName }),
            });
        }
    };
    input.addEventListener('blur', finish, { once: true });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur();
        if (e.key === 'Escape') { input.value = oldName; input.blur(); }
    });
}

function _restoreNameEl(nameEl, name, task) {
    const count = task && task.savedCount > 0 ? ' <span class="text-xs text-slate-400">(' + task.savedCount + '\u5F20)</span>' : '';
    nameEl.innerHTML = _escHtml(name) + count;
}

// ============================================================
//  拖拽排序
// ============================================================
function _initBatchSortable() {
    if (_batchSortable) _batchSortable.destroy();
    const list = document.getElementById('batchQueueList');
    if (!list) return;
    _batchSortable = Sortable.create(list, {
        animation: 250,
        handle: '.drag-handle',
        ghostClass: 'sortable-ghost',
        chosenClass: 'sortable-chosen',
        filter: '.status-running,.status-done,.status-error',
        onEnd() {
            if (!G.batch) return;
            const items = list.querySelectorAll('.batch-video-item');
            const newOrder = Array.from(items).map(el => el.dataset.vid);
            const taskMap = {};
            G.batch.tasks.forEach(t => taskMap[t.vid] = t);
            G.batch.tasks = newOrder.map(vid => taskMap[vid]).filter(Boolean);
            api('/api/batch/' + G.batch.bid + '/reorder', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ order: newOrder }),
            });
        },
    });
}

// ============================================================
//  队列操作
// ============================================================
async function _removeVideo(vid) {
    if (!G.batch) return;
    const res = await api('/api/batch/' + G.batch.bid + '/remove-video/' + vid, { method: 'POST' });
    if (res.success) {
        G.batch.tasks = G.batch.tasks.filter(t => t.vid !== vid);
        G.batch.totalCount = G.batch.tasks.length;
        _renderBatchQueue();
        _updateBatchControls();
        _updateBatchBadge();
    } else {
        showToast(res.message || '\u79FB\u9664\u5931\u8D25', 'error');
    }
}

async function _prioritizeVideo(vid) {
    if (!G.batch) return;
    const res = await api('/api/batch/' + G.batch.bid + '/prioritize/' + vid, { method: 'POST' });
    if (res.success) {
        const task = G.batch.tasks.find(t => t.vid === vid);
        if (task) {
            G.batch.tasks = G.batch.tasks.filter(t => t.vid !== vid);
            let idx = 0;
            for (let i = 0; i < G.batch.tasks.length; i++) {
                if (G.batch.tasks[i].status === 'running') idx = i + 1;
                else break;
            }
            G.batch.tasks.splice(idx, 0, task);
            _renderBatchQueue();
        }
        showToast('\u5DF2\u4F18\u5148\u5904\u7406', 'success', 1500);
    }
}

async function clearBatchQueue() {
    if (!G.batch) return;
    if (!confirm('\u786E\u5B9A\u6E05\u7A7A\u6240\u6709\u6392\u961F\u4E2D\u7684\u89C6\u9891\uFF1F')) return;
    const res = await api('/api/batch/' + G.batch.bid + '/clear-queue', { method: 'POST' });
    if (res.success) {
        G.batch.tasks = G.batch.tasks.filter(t => t.status !== 'queued');
        G.batch.totalCount = G.batch.tasks.length;
        _renderBatchQueue();
        _updateBatchControls();
        showToast('\u5DF2\u6E05\u7A7A ' + res.removed + ' \u4E2A\u89C6\u9891', 'success', 2000);
    }
}

async function _retryVideo(vid) {
    if (!G.batch) return;
    const res = await api('/api/batch/' + G.batch.bid + '/retry/' + vid, { method: 'POST' });
    if (res.success) {
        const task = G.batch.tasks.find(t => t.vid === vid);
        if (task) { task.status = 'queued'; task.progress = 0; task.message = ''; task.errorMessage = ''; }
        _renderBatchQueue();
        _updateBatchControls();
    } else {
        showToast(res.message || '\u91CD\u8BD5\u5931\u8D25', 'error');
    }
}

async function _cancelSingleVideo(vid) {
    if (!G.batch) return;
    const task = G.batch.tasks.find(t => t.vid === vid);
    if (!task) return;
    const isRunning = task.status === 'running';
    if (isRunning && !confirm('\u786E\u5B9A\u53D6\u6D88\u6B63\u5728\u5904\u7406\u7684\u89C6\u9891\uFF1F')) return;
    const res = await api('/api/batch/' + G.batch.bid + '/cancel-video/' + vid, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auto_trash: false }),
    });
    if (res.success) {
        if (!isRunning) {
            // queued 状态直接更新
            task.status = 'cancelled';
            task.message = '\u5DF2\u53D6\u6D88';
        } else {
            task.message = '\u6B63\u5728\u53D6\u6D88\u2026';
        }
        _renderBatchQueue();
        _updateBatchControls();
        showToast(isRunning ? '\u6B63\u5728\u53D6\u6D88\uFF0C\u8BF7\u7A0D\u5019' : '\u5DF2\u53D6\u6D88', 'success', 2000);
    } else {
        showToast(res.message || '\u53D6\u6D88\u5931\u8D25', 'error');
    }
}

// 暂停正在运行的视频（复用 cancel API，后端会设置 cancel_flag）
async function _pauseVideo(vid) {
    if (!G.batch) return;
    const task = G.batch.tasks.find(t => t.vid === vid);
    if (!task || task.status !== 'running') return;
    const res = await api('/api/batch/' + G.batch.bid + '/cancel-video/' + vid, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auto_trash: false, pause: true }),
    });
    if (res.success) {
        task.message = '\u6B63\u5728\u6682\u505C\u2026';
        _renderBatchQueue();
        _updateBatchControls();
        showToast('\u6B63\u5728\u6682\u505C\uFF0C\u8BF7\u7A0D\u5019', 'success', 2000);
    } else {
        showToast(res.message || '\u6682\u505C\u5931\u8D25', 'error');
    }
}

// 跳过排队中的视频
async function _skipVideo(vid) {
    if (!G.batch) return;
    const task = G.batch.tasks.find(t => t.vid === vid);
    if (!task || task.status !== 'queued') return;
    const res = await api('/api/batch/' + G.batch.bid + '/cancel-video/' + vid, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auto_trash: false, skip: true }),
    });
    if (res.success) {
        task.status = 'skipped';
        task.message = '\u5DF2\u8DF3\u8FC7';
        _renderBatchQueue();
        _updateBatchControls();
        showToast('\u5DF2\u8DF3\u8FC7', 'success', 2000);
    } else {
        showToast(res.message || '\u8DF3\u8FC7\u5931\u8D25', 'error');
    }
}

// ============================================================
//  执行控制
// ============================================================
async function startBatch() {
    if (!G.batch) return;
    // 更新参数并保存到 localStorage
    G.batch.params = _readBatchParams();
    _saveBatchPrefs(G.batch.params);
    G.batch.maxWorkers = parseInt(document.getElementById('batchWorkerCount').value) || 1;
    try {
        const res = await api('/api/batch/' + G.batch.bid + '/start', { method: 'POST' });
        if (res.success) {
            G.batch.status = 'running';
            G.batch._startTime = Date.now();
            _updateBatchControls();
            document.getElementById('batchGlobalStats').style.display = '';
            _renderBatchQueue();
            showToast('\u6279\u91CF\u5904\u7406\u5DF2\u5F00\u59CB', 'success', 2000);
        } else {
            showToast(res.message || '\u542F\u52A8\u5931\u8D25', 'error');
        }
    } catch (e) {
        showToast('\u542F\u52A8\u5931\u8D25: ' + e.message, 'error');
    }
}

async function pauseBatch() {
    if (!G.batch) return;
    const res = await api('/api/batch/' + G.batch.bid + '/pause', { method: 'POST' });
    if (res.success) {
        G.batch.status = 'paused';
        _updateBatchControls();
        showToast('\u5DF2\u6682\u505C\uFF0C\u5F53\u524D\u8FD0\u884C\u4E2D\u7684\u89C6\u9891\u4F1A\u5B8C\u6210', 'info', 3000);
    }
}

async function resumeBatch() {
    if (!G.batch) return;
    const res = await api('/api/batch/' + G.batch.bid + '/resume', { method: 'POST' });
    if (res.success) {
        G.batch.status = 'running';
        if (!G.batch._startTime) G.batch._startTime = Date.now();
        _updateBatchControls();
        _renderBatchQueue();
        showToast('\u5DF2\u6062\u590D\u5904\u7406', 'success', 2000);
    }
}

async function cancelBatch() {
    if (!G.batch) return;
    if (!confirm('\u786E\u5B9A\u53D6\u6D88\u6240\u6709\u5904\u7406\uFF1F\u5F53\u524D\u8FD0\u884C\u4E2D\u7684\u89C6\u9891\u4F1A\u88AB\u4E2D\u65AD\u3002')) return;
    const res = await api('/api/batch/' + G.batch.bid + '/cancel', { method: 'POST' });
    if (res.success) {
        G.batch.status = 'cancelled';
        G.batch.tasks.forEach(t => { if (t.status === 'queued') t.status = 'cancelled'; });
        _renderBatchQueue();
        _updateBatchControls();
    }
}

function _updateBatchControls() {
    if (!G.batch) return;
    const s = G.batch.status;
    const hasQueued = G.batch.tasks.some(t => t.status === 'queued');
    const hasDone = G.batch.tasks.some(t => t.status === 'done');

    const el = (id) => document.getElementById(id);
    // 开始按钮
    el('btnBatchStart').disabled = !hasQueued || s === 'running' || s === 'paused';
    el('btnBatchStart').style.display = (s === 'running' || s === 'paused') ? 'none' : '';
    // 暂停
    el('btnBatchPause').style.display = s === 'running' ? '' : 'none';
    // 继续
    el('btnBatchResume').style.display = s === 'paused' ? '' : 'none';
    // 取消
    el('btnBatchCancel').style.display = (s === 'running' || s === 'paused') ? '' : 'none';
    // 添加按钮
    el('btnBatchAddFiles').disabled = s === 'running';
    el('btnBatchScanFolder').disabled = s === 'running';
    // 并发数
    el('batchWorkerCount').disabled = s === 'running';
    // 导出区域
    el('batchExportSection').style.display = hasDone ? '' : 'none';
    // 全局进度
    el('batchGlobalStats').style.display = (s === 'running' || s === 'paused' || s === 'done' || s === 'cancelled') ? '' : 'none';
}

// ============================================================
//  SSE 事件处理
// ============================================================
function _updateTaskStatus(vid, status, message) {
    const task = G.batch.tasks.find(t => t.vid === vid);
    if (!task) return;
    const oldStatus = task.status;
    task.status = status;
    if (message !== undefined) task.message = message;
    // 状态变化时需要完整重建（按钮组会变化）
    if (oldStatus !== status) {
        _renderBatchQueue();
    } else {
        _updateVideoItemUI(vid);
    }
    _updateBatchControls();
}

function _updateTaskProgress(data) {
    const task = G.batch.tasks.find(t => t.vid === data.video_id);
    if (!task) return;
    task.status = 'running';
    task.progress = data.progress || 0;
    task.message = data.message || '';
    task.savedCount = data.saved_count || task.savedCount;
    task.etaSeconds = data.eta_seconds ?? -1;
    task.elapsedSeconds = data.elapsed_seconds ?? 0;
    _updateVideoItemUI(data.video_id);
    // 更新全局进度
    if (data.global_progress !== undefined) {
        G.batch.globalProgress = data.global_progress;
    }
    _updateGlobalProgress();
}

function _onVideoDone(data) {
    const task = G.batch.tasks.find(t => t.vid === data.video_id);
    if (task) {
        task.status = 'done';
        task.progress = 100;
        task.savedCount = data.saved_count || task.savedCount;
        task.message = data.message || '\u5B8C\u6210';
        task.selected = true;  // 新完成的视频默认勾选
    }
    G.batch.completedCount++;
    G.batch.totalImages += (data.saved_count || 0);
    if (data.global_progress !== undefined) G.batch.globalProgress = data.global_progress;
    _renderBatchQueue();
    _updateBatchControls();
    _updateGlobalProgress();
    _updateBatchExportSelection();
}

function _onVideoError(data) {
    const task = G.batch.tasks.find(t => t.vid === data.video_id);
    if (task) {
        task.status = data.status || 'error';
        task.errorMessage = data.message || '';
        task.message = data.message || '\u5904\u7406\u5931\u8D25';
    }
    G.batch.failedCount++;
    if (data.global_progress !== undefined) G.batch.globalProgress = data.global_progress;
    _renderBatchQueue();
    _updateBatchControls();
    _updateGlobalProgress();
}

function _onBatchDone(data) {
    G.batch.status = data.status || 'done';
    G.batch.completedCount = data.completed_count || G.batch.completedCount;
    G.batch.failedCount = data.failed_count || G.batch.failedCount;
    G.batch.totalImages = data.total_images || G.batch.totalImages;
    G.batch.globalProgress = 100;
    _updateBatchControls();
    _updateGlobalProgress();
    _updateBatchBadge();
    _playBatchDoneSound();
    _notifyBatchComplete(data);
}

// ============================================================
//  全局进度
// ============================================================
function _updateGlobalProgress() {
    if (!G.batch) return;

    // 计算全局进度：所有视频（queued=0%, running=其进度, done/error/cancelled/skipped=100%）
    const tasks = G.batch.tasks;
    const total = tasks.length;
    if (total === 0) return;

    let weightedSum = 0;
    let doneCount = 0;
    let failedCount = 0;
    let runningCount = 0;
    let queuedCount = 0;
    const images = G.batch.totalImages || 0;

    for (const t of tasks) {
        if (t.status === 'done') { weightedSum += 100; doneCount++; }
        else if (t.status === 'error' || t.status === 'cancelled' || t.status === 'skipped') { weightedSum += 100; failedCount++; }
        else if (t.status === 'running') { weightedSum += (t.progress || 0); runningCount++; }
        else { queuedCount++; }
    }
    const pct = Math.round(weightedSum / total);

    const bar = document.getElementById('batchGlobalProgress');
    const text = document.getElementById('batchStatsText');
    const detail = document.getElementById('batchStatsDetail');
    const pctEl = document.getElementById('batchProgressPct');
    const etaEl = document.getElementById('batchProgressEta');

    if (bar) bar.style.width = pct + '%';

    if (text) {
        if (G.batch.status === 'running') {
            text.textContent = '\u5904\u7406\u4E2D';
        } else if (G.batch.status === 'paused') {
            text.textContent = '\u5DF2\u6682\u505C';
        } else if (G.batch.status === 'done') {
            text.textContent = '\u5168\u90E8\u5B8C\u6210';
        } else if (G.batch.status === 'cancelled') {
            text.textContent = '\u5DF2\u53D6\u6D88';
        } else {
            text.textContent = '\u5C31\u7EEA';
        }
    }
    if (detail) {
        let parts = [];
        parts.push('\u5B8C\u6210 ' + doneCount + '/' + total);
        if (failedCount > 0) parts.push('\u5931\u8D25 ' + failedCount);
        if (queuedCount > 0) parts.push('\u7B49\u5F85 ' + queuedCount);
        parts.push('\u5171 ' + images + ' \u5F20');
        detail.textContent = parts.join(' | ');
    }
    if (pctEl) {
        pctEl.textContent = pct + '%';
    }
    if (etaEl) {
        if (G.batch.status === 'running' && pct > 0 && pct < 100 && G.batch._startTime) {
            const elapsed = (Date.now() - G.batch._startTime) / 1000;
            const remaining = elapsed / pct * (100 - pct);
            etaEl.textContent = '\u9884\u8BA1\u5269\u4F59 ' + _formatDuration(remaining);
        } else if (pct >= 100) {
            etaEl.textContent = '';
        } else {
            etaEl.textContent = '';
        }
    }
}

function _formatDuration(seconds) {
    seconds = Math.round(seconds);
    if (seconds < 60) return seconds + '\u79D2';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    if (m < 60) return m + '\u5206' + (s > 0 ? s + '\u79D2' : '');
    const h = Math.floor(m / 60);
    return h + '\u5C0F\u65F6' + (m % 60) + '\u5206';
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
function _notifyBatchComplete(data) {
    const images = data.total_images || 0;
    const elapsed = data.elapsed_seconds || 0;
    const elapsedStr = _formatBatchTime(elapsed);

    // 页面横幅
    const banner = document.getElementById('batchCompleteBanner');
    const bannerText = document.getElementById('batchCompleteText');
    if (banner && bannerText) {
        bannerText.textContent = '\u6279\u91CF\u5904\u7406\u5B8C\u6210\uFF01\u5171\u63D0\u53D6 ' + images + ' \u5F20\u56FE\u7247\uFF0C\u8017\u65F6 ' + elapsedStr;
        banner.style.display = '';
    }

    // 标题闪烁
    if (_batchTitleFlash) clearInterval(_batchTitleFlash);
    const origTitle = document.title;
    _batchTitleFlash = setInterval(() => {
        document.title = document.title.startsWith('\u2705')
            ? origTitle
            : '\u2705 \u6279\u91CF\u5904\u7406\u5B8C\u6210 - VidSlide';
    }, 1000);
    window.addEventListener('focus', () => {
        if (_batchTitleFlash) { clearInterval(_batchTitleFlash); _batchTitleFlash = null; }
        document.title = origTitle;
    }, { once: true });

    // 浏览器通知
    if ('Notification' in window) {
        if (Notification.permission === 'granted') {
            new Notification('VidSlide \u6279\u91CF\u5904\u7406\u5B8C\u6210', {
                body: '\u5DF2\u63D0\u53D6 ' + images + ' \u5F20\u5E7B\u706F\u7247\uFF0C\u8017\u65F6 ' + elapsedStr,
            });
        } else if (Notification.permission !== 'denied') {
            Notification.requestPermission().then(p => {
                if (p === 'granted') {
                    new Notification('VidSlide \u6279\u91CF\u5904\u7406\u5B8C\u6210', {
                        body: '\u5DF2\u63D0\u53D6 ' + images + ' \u5F20\u5E7B\u706F\u7247',
                    });
                }
            });
        }
    }
}

function _formatBatchTime(seconds) {
    if (!seconds || seconds <= 0) return '0s';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    if (m > 0) return m + '\u5206' + s + '\u79D2';
    return s + '\u79D2';
}

// ============================================================
//  单视频导出
// ============================================================
function _showVideoExport(vid) {
    if (!G.batch) return;
    const task = G.batch.tasks.find(t => t.vid === vid);
    if (!task || task.status !== 'done') return;

    const el = document.querySelector('.batch-video-item[data-vid="' + vid + '"]');
    if (!el) return;

    // 检查是否已有导出面板
    if (el.querySelector('.batch-export-inline')) return;

    const panel = document.createElement('div');
    panel.className = 'batch-export-inline mt-2 p-2 bg-slate-50 dark:bg-slate-800 rounded flex items-center gap-2 flex-wrap';
    panel.innerHTML =
        '<span class="text-xs text-slate-500">\u5BFC\u51FA:</span>' +
        '<button onclick="_packageVideo(\'' + vid + '\',\'pdf\')" class="btn-ghost text-xs">PDF</button>' +
        '<button onclick="_packageVideo(\'' + vid + '\',\'pptx\')" class="btn-ghost text-xs">PPTX</button>' +
        '<button onclick="_packageVideo(\'' + vid + '\',\'zip\')" class="btn-ghost text-xs">ZIP</button>' +
        '<div class="batch-video-download-links"></div>';
    el.appendChild(panel);
}

async function _packageVideo(vid, fmt) {
    if (!G.batch) return;
    const res = await api('/api/batch/' + G.batch.bid + '/package/' + vid, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: fmt }),
    });
    if (res.success) {
        showToast(fmt.toUpperCase() + ' \u6253\u5305\u5DF2\u5F00\u59CB', 'success', 2000);
    } else {
        showToast(res.message || '\u6253\u5305\u5931\u8D25', 'error');
    }
}

function _onPackagingProgress(data) {
    // 可选：在视频项上显示打包进度
}

function _onPackagingDone(data) {
    if (!G.batch) return;
    const vid = data.video_id;
    const filename = data.filename;
    // 自动触发浏览器下载
    if (filename) {
        const a = document.createElement('a');
        a.href = '/api/batch/' + G.batch.bid + '/video/' + vid + '/download/' + filename;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }
    showToast('\u6253\u5305\u5B8C\u6210: ' + (filename || ''), 'success', 3000);
}

function _onPackagingError(data) {
    showToast('\u6253\u5305\u5931\u8D25: ' + (data.message || ''), 'error');
}

// ============================================================
//  批量导出（旧版已移至下方 packageBatchAll，此处保留进度处理）
// ============================================================

function _onBatchPackagingProgress(data) {
    const bar = document.getElementById('batchExportProgressBar');
    const msg = document.getElementById('batchExportMessage');
    if (bar) bar.style.width = (data.progress || 0) + '%';
    if (msg) msg.textContent = data.message || '';
}

function _onBatchPackagingDone(data) {
    const bar = document.getElementById('batchExportProgressBar');
    if (bar) bar.style.width = '100%';
    document.getElementById('batchExportProgress').style.display = 'none';

    // 自动触发浏览器下载
    if (data.filename && G.batch) {
        const a = document.createElement('a');
        a.href = '/api/batch/' + G.batch.bid + '/download/' + data.filename;
        a.download = data.filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }
    showToast('\u6279\u91CF\u6253\u5305\u5B8C\u6210', 'success', 3000);
}

// ============================================================
//  视频选择（批量导出勾选）
// ============================================================
function _onBatchSelectChange(vid, checked) {
    if (!G.batch) return;
    const task = G.batch.tasks.find(t => t.vid === vid);
    if (task) task.selected = checked;
    _updateBatchExportSelection();
}

function _getSelectedVids() {
    if (!G.batch) return [];
    return G.batch.tasks
        .filter(t => t.status === 'done' && t.selected !== false)
        .map(t => t.vid);
}

function _updateBatchExportSelection() {
    const selectedCount = _getSelectedVids().length;
    const totalDone = G.batch ? G.batch.tasks.filter(t => t.status === 'done').length : 0;
    const hint = document.getElementById('batchExportHint');
    if (hint) {
        hint.textContent = '\u5DF2\u9009\u62E9 ' + selectedCount + '/' + totalDone + ' \u4E2A\u89C6\u9891';
    }
    // 同步切换按钮文字
    const btn = document.getElementById('batchSelectToggleBtn');
    if (btn) {
        const allSelected = totalDone > 0 && selectedCount === totalDone;
        btn.textContent = allSelected ? '\u53D6\u6D88\u5168\u9009' : '\u5168\u9009';
    }
}

function selectAllBatchVideos(checked) {
    if (!G.batch) return;
    // 如果没传参数，自动切换：当前全选则取消，否则全选
    if (checked === undefined) {
        const doneTasks = G.batch.tasks.filter(t => t.status === 'done');
        const allSelected = doneTasks.length > 0 && doneTasks.every(t => t.selected !== false);
        checked = !allSelected;
    }
    G.batch.tasks.forEach(t => { if (t.status === 'done') t.selected = checked; });
    document.querySelectorAll('.batch-select-cb').forEach(cb => { cb.checked = checked; });
    _updateBatchExportSelection();
    // 更新按钮文字
    const btn = document.getElementById('batchSelectToggleBtn');
    if (btn) btn.textContent = checked ? '\u53D6\u6D88\u5168\u9009' : '\u5168\u9009';
}

// ============================================================
//  视频回收站操作
// ============================================================
async function _trashBatchVideo(vid) {
    if (!G.batch) return;
    const task = G.batch.tasks.find(t => t.vid === vid);
    if (!task) return;
    const res = await api('/api/batch/' + G.batch.bid + '/trash-video/' + vid, { method: 'POST' });
    if (res.success) {
        G.batch.tasks = G.batch.tasks.filter(t => t.vid !== vid);
        G.batch.totalCount = G.batch.tasks.length;
        _renderBatchQueue();
        _updateBatchControls();
        _updateBatchBadge();
        _updateBatchVideoRecycleBadge();
        _updateBatchExportSelection();
        showToast('\u5DF2\u79FB\u5165\u56DE\u6536\u7AD9', 'success', 2000);
    } else {
        showToast(res.message || '\u79FB\u5165\u56DE\u6536\u7AD9\u5931\u8D25', 'error');
    }
}

async function openBatchVideoRecycleBin() {
    if (!G.batch) return;
    let videos = [];
    try {
        const res = await api('/api/batch/' + G.batch.bid + '/trashed-videos');
        if (res.success) videos = res.videos || [];
    } catch { }

    const drawer = document.getElementById('batchVideoRecycleDrawer');
    const backdrop = document.getElementById('batchVideoRecycleBackdrop');
    const list = document.getElementById('batchVideoRecycleList');
    const countEl = document.getElementById('batchVideoRecycleCount');
    const restoreAllBtn = document.getElementById('btnBatchVideoRestoreAll');

    if (!drawer || !list) return;

    countEl.textContent = videos.length > 0 ? '(' + videos.length + ' \u4E2A)' : '';
    restoreAllBtn.style.display = videos.length > 0 ? '' : 'none';

    list.innerHTML = '';
    if (videos.length === 0) {
        list.innerHTML = '<p class="text-center text-gray-400 text-sm py-12">\u56DE\u6536\u7AD9\u662F\u7A7A\u7684</p>';
    } else {
        const reasonLabels = { done: '\u5DF2\u5B8C\u6210', cancelled: '\u5DF2\u53D6\u6D88', error: '\u5931\u8D25', skipped: '\u5DF2\u8DF3\u8FC7' };
        videos.forEach(v => {
            const item = document.createElement('div');
            item.className = 'recycle-item';
            item.innerHTML =
                '<div class="flex-1 min-w-0">' +
                    '<p class="text-sm font-medium text-gray-700 dark:text-gray-300 truncate">' + _escHtml(v.display_name || v.id) + '</p>' +
                    '<p class="text-xs text-gray-400">' + (reasonLabels[v.trash_reason] || v.trash_reason || '') +
                    (v.saved_count > 0 ? ' \u00B7 ' + v.saved_count + ' \u5F20\u56FE\u7247' : '') + '</p>' +
                '</div>' +
                '<button class="shrink-0 btn text-xs bg-brand-50 text-brand-600 hover:bg-brand-100 border border-brand-200">\u21A9\uFE0F \u6062\u590D</button>';
            item.querySelector('button').addEventListener('click', async () => {
                const res = await api('/api/batch/' + G.batch.bid + '/restore-video/' + v.id, { method: 'POST' });
                if (res.success) {
                    // 重新获取 batch 状态
                    const stateRes = await api('/api/batch/' + G.batch.bid + '/status');
                    if (stateRes.success) _handleBatchInit(stateRes.batch);
                    openBatchVideoRecycleBin(); // 刷新列表
                    showToast('\u5DF2\u6062\u590D\u300C' + (v.display_name || v.id) + '\u300D', 'success', 2000);
                } else {
                    showToast(res.message || '\u6062\u590D\u5931\u8D25', 'error');
                }
            });
            list.appendChild(item);
        });
    }

    drawer.classList.add('open');
    backdrop.classList.add('open');
    document.body.style.overflow = 'hidden';
}

function closeBatchVideoRecycleBin() {
    const drawer = document.getElementById('batchVideoRecycleDrawer');
    const backdrop = document.getElementById('batchVideoRecycleBackdrop');
    if (drawer) drawer.classList.remove('open');
    if (backdrop) backdrop.classList.remove('open');
    document.body.style.overflow = '';
}

async function restoreAllBatchVideos() {
    if (!G.batch) return;
    const res = await api('/api/batch/' + G.batch.bid + '/restore-all-videos', { method: 'POST' });
    if (res.success) {
        const stateRes = await api('/api/batch/' + G.batch.bid + '/status');
        if (stateRes.success) _handleBatchInit(stateRes.batch);
        closeBatchVideoRecycleBin();
        showToast('\u5DF2\u6062\u590D\u5168\u90E8 ' + res.count + ' \u4E2A\u89C6\u9891', 'success');
    }
}

function _updateBatchVideoRecycleBadge() {
    const btn = document.getElementById('btnBatchVideoRecycle');
    if (!btn) return;
    // 简单显示按钮，实际数量在打开时获取
    btn.style.display = '';
}

// ============================================================
//  批量命名模板
// ============================================================
const _NAMING_TEMPLATES = {
    'course_lessonN': { label: '\u8BFE\u7A0B\u540D_\u7B2CN\u8282', format: (name, n) => name + '_\u7B2C' + n + '\u8282' },
    'lessonN_course': { label: '\u7B2CN\u8BB2_\u8BFE\u7A0B\u540D', format: (name, n) => '\u7B2C' + n + '\u8BB2_' + name },
    'course_parenN': { label: '\u8BFE\u7A0B\u540D(N)', format: (name, n) => name + '(' + n + ')' },
    'course_dashN': { label: '\u8BFE\u7A0B\u540D-N', format: (name, n) => name + '-' + String(n).padStart(2, '0') },
};

function previewTemplateNames() {
    const mode = document.querySelector('input[name="batchNamingMode"]:checked');
    if (!mode || mode.value !== 'template') return;

    const courseName = document.getElementById('batchCourseName').value.trim();
    if (!courseName) { showToast('\u8BF7\u8F93\u5165\u8BFE\u7A0B/\u4E3B\u9898\u540D\u79F0', 'warning'); return; }

    const templateKey = document.getElementById('batchNamingTemplate').value;
    const startNum = parseInt(document.getElementById('batchStartNum').value) || 1;
    const tmpl = _NAMING_TEMPLATES[templateKey];
    if (!tmpl) return;

    const fields = document.querySelectorAll('#batchAddList .batch-name-field');
    fields.forEach((f, i) => {
        f.value = tmpl.format(courseName, startNum + i);
    });
    showToast('\u5DF2\u9884\u89C8\u547D\u540D\u7ED3\u679C', 'success', 2000);
}

function applyTemplateNames() {
    previewTemplateNames();
    // 预览已经填入了值，这里额外提示"已应用"
    const fields = document.querySelectorAll('#batchAddList .batch-name-field');
    if (fields.length > 0 && fields[0].value) {
        showToast('\u6A21\u677F\u547D\u540D\u5DF2\u5E94\u7528', 'success', 2000);
    }
}

function sortBatchAddList(order) {
    const list = document.getElementById('batchAddList');
    if (!list) return;
    const items = Array.from(list.querySelectorAll('.batch-add-list-item'));
    if (items.length === 0) return;
    items.sort((a, b) => {
        const nameA = a.querySelector('.batch-name-field').value.trim();
        const nameB = b.querySelector('.batch-name-field').value.trim();
        return order === 'asc' ? nameA.localeCompare(nameB, 'zh') : nameB.localeCompare(nameA, 'zh');
    });
    items.forEach(item => list.appendChild(item));
    // 更新 data-idx
    list.querySelectorAll('.batch-name-field').forEach((f, i) => { f.dataset.idx = i; });
    showToast(order === 'asc' ? '\u5DF2\u6309\u540D\u79F0\u5347\u5E8F\u6392\u5217' : '\u5DF2\u6309\u540D\u79F0\u964D\u5E8F\u6392\u5217', 'success', 2000);
}

function _onNamingModeChange() {
    const mode = document.querySelector('input[name="batchNamingMode"]:checked');
    if (!mode) return;
    const templateArea = document.getElementById('namingTemplateArea');
    const autoIncArea = document.getElementById('batchAutoIncrementArea');
    if (templateArea) templateArea.style.display = mode.value === 'template' ? '' : 'none';
    if (autoIncArea) autoIncArea.style.display = mode.value === 'free' ? '' : 'none';
}

// ============================================================
//  批量模式清空
// ============================================================
async function cleanupBatchMode() {
    if (!G.batch) { showToast('\u6CA1\u6709\u9700\u8981\u6E05\u7406\u7684\u6279\u91CF\u961F\u5217', 'info'); return; }
    if (G.batch.status === 'running') {
        if (!confirm('\u6279\u91CF\u5904\u7406\u6B63\u5728\u8FD0\u884C\u4E2D\uFF0C\u786E\u5B9A\u8981\u6E05\u7A7A\u5417\uFF1F')) return;
    } else {
        if (!confirm('\u786E\u5B9A\u6E05\u7A7A\u6279\u91CF\u961F\u5217\u7684\u6240\u6709\u6570\u636E\u5417\uFF1F')) return;
    }
    _disconnectBatchSSE();
    await api('/api/batch/' + G.batch.bid + '/cleanup', { method: 'POST' });
    G.batch = null;
    document.getElementById('batchQueueList').style.display = 'none';
    document.getElementById('batchEmptyHint').style.display = '';
    document.getElementById('batchQueueCount').textContent = '\uFF080 \u4E2A\u89C6\u9891\uFF09';
    document.getElementById('batchGlobalStats').style.display = 'none';
    document.getElementById('batchExportSection').style.display = 'none';
    document.getElementById('batchCompleteBanner').style.display = 'none';
    _updateBatchBadge();
    showToast('\u6279\u91CF\u961F\u5217\u5DF2\u6E05\u7A7A', 'success');
    // 清空后自动重建空 batch，避免用户需要切换模式才能继续操作
    if (G.batchMode) {
        _initBatch();
    }
}

// ============================================================
//  HTML 转义
// ============================================================
function _escHtml(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
}

// ============================================================
//  批量模式恢复（页面加载时调用）
// ============================================================
async function _recoverBatch() {
    try {
        const res = await api('/api/batches');
        if (!res.success || !res.batches || res.batches.length === 0) return false;
        _maxBatchWorkers = res.max_batch_workers || 3;
        // 恢复第一个 batch
        const info = res.batches[0];
        const stateRes = await api('/api/batch/' + info.id + '/status');
        if (!stateRes.success) return false;
        const state = stateRes.batch;
        G.batch = {
            bid: state.id,
            tasks: (state.tasks || []).map(t => ({
                vid: t.id, videoPath: t.video_path, displayName: t.display_name,
                status: t.status, progress: t.progress, message: t.message,
                savedCount: t.saved_count, etaSeconds: t.eta_seconds,
                elapsedSeconds: t.elapsed_seconds, errorMessage: t.error_message,
                retryCount: t.retry_count,
            })),
            status: state.status,
            params: state.params || {},
            maxWorkers: state.max_workers || 1,
            eventSource: null,
            completedCount: state.completed_count || 0,
            failedCount: state.failed_count || 0,
            totalCount: (state.tasks || []).length,
            globalProgress: state.global_progress || 0,
            totalImages: state.total_images || 0,
            sseErrorCount: 0,
        };
        _connectBatchSSE();
        return true;
    } catch (e) {
        console.warn('[Batch] \u6062\u590D\u5931\u8D25:', e);
        return false;
    }
}

// ============================================================
//  参数面板事件绑定（页面加载时调用）
// ============================================================
function _initBatchParamEvents() {
    const el = (id) => document.getElementById(id);
    // 阈值滑块
    el('batchThreshold').addEventListener('input', function() {
        el('batchThresholdVal').textContent = this.value;
    });
    // 并发数变更
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
//  视频详情弹窗（画廊 + 大图预览 + 删除 + 导出）
// ============================================================
async function openBatchDetail(vid) {
    if (!G.batch) return;
    const task = G.batch.tasks.find(t => t.vid === vid);
    if (!task) { showToast('\u89C6\u9891\u4E0D\u5B58\u5728', 'warning'); return; }
    const hasImages = task.savedCount > 0;
    const canView = task.status === 'done' || (hasImages && ['cancelled', 'skipped', 'error'].includes(task.status));
    if (!canView) {
        showToast('\u8BE5\u89C6\u9891\u5C1A\u672A\u5B8C\u6210\u5904\u7406\u6216\u65E0\u56FE\u7247', 'warning');
        return;
    }
    _batchDetailVid = vid;
    _batchDetailImages = [];
    _batchPreviewIdx = -1;
    _batchDetailDeletedStack = [];

    // 获取图片列表
    try {
        const res = await api('/api/batch/' + G.batch.bid + '/video/' + vid + '/images');
        if (res.success && res.images) {
            _batchDetailImages = res.images;
        }
    } catch (e) {
        showToast('\u83B7\u53D6\u56FE\u7247\u5217\u8868\u5931\u8D25', 'error');
        return;
    }

    // 填充弹窗
    const modal = document.getElementById('batchDetailModal');
    document.getElementById('batchDetailTitle').textContent = task.displayName;
    document.getElementById('batchDetailCount').textContent = _batchDetailImages.length + ' \u5F20\u56FE\u7247';
    document.getElementById('batchDetailExportStatus').textContent = '';
    // 隐藏回收站面板
    const recyclePanel = document.getElementById('batchDetailRecyclePanel');
    if (recyclePanel) recyclePanel.style.display = 'none';
    _renderBatchDetailGrid();
    modal.classList.remove('hidden');

    // ESC 关闭
    document.addEventListener('keydown', _batchDetailKeyHandler);
}

function closeBatchDetail() {
    const modal = document.getElementById('batchDetailModal');
    modal.classList.add('hidden');
    if (_batchDetailSortable) { _batchDetailSortable.destroy(); _batchDetailSortable = null; }
    _batchDetailVid = null;
    _batchDetailImages = [];
    _batchPreviewIdx = -1;
    _batchDetailDeletedStack = [];
    document.removeEventListener('keydown', _batchDetailKeyHandler);
}

function _batchDetailKeyHandler(e) {
    if (e.key === 'Escape') {
        if (document.getElementById('batchDetailRecyclePanel')?.style.display !== 'none') {
            _closeBatchDetailRecycleBin();
            return;
        }
        if (_batchPreviewIdx >= 0) {
            _closeBatchPreview();
        } else {
            closeBatchDetail();
        }
        return;
    }
    // Ctrl+Z 撤销删除
    if (e.ctrlKey && e.key === 'z') {
        e.preventDefault();
        _undoBatchDetailDelete();
        return;
    }
    if (_batchPreviewIdx >= 0) {
        if (e.key === 'ArrowLeft') _batchPreviewNav(-1);
        if (e.key === 'ArrowRight') _batchPreviewNav(1);
        if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            _deleteBatchDetailImageInPreview();
        }
    }
}

function _renderBatchDetailGrid() {
    const grid = document.getElementById('batchDetailGrid');
    if (!grid) return;
    grid.innerHTML = '';
    const bid = G.batch.bid;
    const vid = _batchDetailVid;
    const frag = document.createDocumentFragment();
    _batchDetailImages.forEach((img, idx) => {
        const url = '/api/batch/' + bid + '/video/' + vid + '/image/' + img;
        const div = document.createElement('div');
        div.className = 'batch-detail-thumb-wrap';
        div.dataset.filename = img;
        div.innerHTML =
            '<img src="' + url + '" alt="' + _escHtml(img) + '" class="batch-detail-thumb" loading="lazy">' +
            '<div class="batch-detail-thumb-overlay">' +
                '<span class="bg-black/60 text-white text-xs px-2 py-0.5 rounded-full font-bold backdrop-blur">' + (idx + 1) + '</span>' +
                '<button class="batch-detail-del-btn" title="\u5220\u9664">\u2715</button>' +
            '</div>';
        // 点击图片打开预览
        div.querySelector('img').addEventListener('click', () => _openBatchPreview(idx));
        // 删除按钮
        div.querySelector('.batch-detail-del-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            const curIdx = Array.from(grid.children).indexOf(div);
            if (curIdx >= 0) _deleteBatchDetailImage(curIdx);
        });
        frag.appendChild(div);
    });
    grid.appendChild(frag);
    document.getElementById('batchDetailCount').textContent = _batchDetailImages.length + ' \u5F20\u56FE\u7247';
    _updateBatchDetailRecycleBtn();
    _initBatchDetailSortable();
}

function _initBatchDetailSortable() {
    if (_batchDetailSortable) _batchDetailSortable.destroy();
    const grid = document.getElementById('batchDetailGrid');
    if (!grid) return;
    _batchDetailSortable = Sortable.create(grid, {
        animation: 250,
        ghostClass: 'sortable-ghost',
        chosenClass: 'sortable-chosen',
        delay: 120,
        delayOnTouchOnly: true,
        onEnd(evt) {
            const [moved] = _batchDetailImages.splice(evt.oldIndex, 1);
            _batchDetailImages.splice(evt.newIndex, 0, moved);
            _refreshBatchDetailBadges();
        },
    });
}

function _refreshBatchDetailBadges() {
    const grid = document.getElementById('batchDetailGrid');
    if (!grid) return;
    const cards = grid.children;
    for (let i = 0; i < cards.length; i++) {
        const badge = cards[i].querySelector('.batch-detail-thumb-overlay span');
        if (badge) badge.textContent = i + 1;
    }
    document.getElementById('batchDetailCount').textContent = _batchDetailImages.length + ' \u5F20\u56FE\u7247';
}

// 大图预览
function _openBatchPreview(idx) {
    if (idx < 0 || idx >= _batchDetailImages.length) return;
    _batchPreviewIdx = idx;
    const bid = G.batch.bid;
    const vid = _batchDetailVid;
    const img = _batchDetailImages[idx];
    const url = '/api/batch/' + bid + '/video/' + vid + '/image/' + img;

    const modal = document.getElementById('previewModal');
    const previewImg = document.getElementById('previewImage');
    const counter = document.getElementById('previewCounter');
    previewImg.src = url;
    counter.textContent = (idx + 1) + ' / ' + _batchDetailImages.length;
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    document.body.style.overflow = 'hidden';

    // 导航按钮
    const btnPrev = document.getElementById('btnPrevPreview');
    const btnNext = document.getElementById('btnNextPreview');
    const btnDel = document.getElementById('btnDeletePreview');
    btnPrev.style.visibility = idx > 0 ? '' : 'hidden';
    btnNext.style.visibility = idx < _batchDetailImages.length - 1 ? '' : 'hidden';
    btnPrev.onclick = () => _batchPreviewNav(-1);
    btnNext.onclick = () => _batchPreviewNav(1);
    if (btnDel) btnDel.onclick = () => _deleteBatchDetailImageInPreview();
}

function _closeBatchPreview() {
    _batchPreviewIdx = -1;
    const modal = document.getElementById('previewModal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    document.body.style.overflow = '';
}

function _batchPreviewNav(dir) {
    const newIdx = _batchPreviewIdx + dir;
    if (newIdx < 0 || newIdx >= _batchDetailImages.length) return;
    _openBatchPreview(newIdx);
}

function _deleteBatchDetailImageInPreview() {
    if (_batchPreviewIdx < 0 || _batchPreviewIdx >= _batchDetailImages.length) return;

    // 按钮视觉反馈
    const delBtn = document.getElementById('btnDeletePreview');
    if (delBtn) {
        delBtn.classList.remove('flash');
        void delBtn.offsetWidth;
        delBtn.classList.add('flash');
    }

    _deleteBatchDetailImage(_batchPreviewIdx);

    if (_batchDetailImages.length === 0) {
        showToast('\u5DF2\u5220\u9664\u6700\u540E\u4E00\u5F20\u56FE\u7247\uFF0C\u9000\u51FA\u9884\u89C8', 'info', 2000);
        _closeBatchPreview();
        return;
    }
    const newIdx = _batchPreviewIdx < _batchDetailImages.length ? _batchPreviewIdx : _batchDetailImages.length - 1;
    _openBatchPreview(newIdx);
}

async function _deleteBatchDetailImage(idx) {
    if (!G.batch || !_batchDetailVid) return;
    if (idx < 0 || idx >= _batchDetailImages.length) return;
    const img = _batchDetailImages[idx];

    // 调用服务端软删除
    try {
        const res = await api('/api/batch/' + G.batch.bid + '/video/' + _batchDetailVid + '/delete-image/' + img, {
            method: 'POST',
        });
        if (!res.success) {
            showToast(res.message || '\u5220\u9664\u5931\u8D25', 'error');
            return;
        }
    } catch (e) {
        showToast('\u5220\u9664\u5931\u8D25: ' + e.message, 'error');
        return;
    }

    // 从列表中移除并推入删除栈
    _batchDetailImages.splice(idx, 1);
    _batchDetailDeletedStack.push({ filename: img, originalIndex: idx });

    // 更新本地 savedCount
    const task = G.batch.tasks.find(t => t.vid === _batchDetailVid);
    if (task) task.savedCount = _batchDetailImages.length;

    // 从画廊 DOM 中移除卡片
    const grid = document.getElementById('batchDetailGrid');
    const card = grid.children[idx];
    if (card) {
        card.classList.add('removing');
        card.addEventListener('transitionend', () => { card.remove(); _refreshBatchDetailBadges(); }, { once: true });
        setTimeout(() => { if (card.parentNode) { card.remove(); _refreshBatchDetailBadges(); } }, 350);
    }
    _updateBatchDetailRecycleBtn();
    _renderBatchQueue();
    showToast('\u5DF2\u79FB\u5165\u56DE\u6536\u7AD9 (Ctrl+Z \u64A4\u9500)', 'info', 2000);
}

async function _undoBatchDetailDelete() {
    if (!G.batch || !_batchDetailVid || _batchDetailDeletedStack.length === 0) return;
    const { filename, originalIndex } = _batchDetailDeletedStack.pop();

    // 调用服务端恢复
    try {
        const res = await api('/api/batch/' + G.batch.bid + '/video/' + _batchDetailVid + '/restore-image/' + filename, {
            method: 'POST',
        });
        if (!res.success) {
            showToast(res.message || '\u6062\u590D\u5931\u8D25', 'error');
            _batchDetailDeletedStack.push({ filename, originalIndex });
            return;
        }
    } catch (e) {
        showToast('\u6062\u590D\u5931\u8D25: ' + e.message, 'error');
        _batchDetailDeletedStack.push({ filename, originalIndex });
        return;
    }

    // 恢复到列表中
    const insertIdx = Math.min(originalIndex, _batchDetailImages.length);
    _batchDetailImages.splice(insertIdx, 0, filename);

    // 更新 savedCount
    const task = G.batch.tasks.find(t => t.vid === _batchDetailVid);
    if (task) task.savedCount = _batchDetailImages.length;

    _renderBatchDetailGrid();
    _renderBatchQueue();
    showToast('\u5DF2\u6062\u590D\u300C' + filename + '\u300D', 'success', 2000);

    // 如果在预览模式，跳转到恢复的图片
    if (_batchPreviewIdx >= 0) {
        _openBatchPreview(Math.min(insertIdx, _batchDetailImages.length - 1));
    }
}

function _updateBatchDetailRecycleBtn() {
    const btn = document.getElementById('batchDetailRecycleBtn');
    if (!btn) return;
    const count = _batchDetailDeletedStack.length;
    btn.style.display = count > 0 ? '' : 'none';
    btn.textContent = '\uD83D\uDDD1 \u56DE\u6536\u7AD9 (' + count + ')';
}

async function _openBatchDetailRecycleBin() {
    if (!G.batch || !_batchDetailVid) return;
    // 从服务端获取完整的回收站列表
    let trashedImages = [];
    try {
        const res = await api('/api/batch/' + G.batch.bid + '/video/' + _batchDetailVid + '/trashed-images');
        if (res.success) trashedImages = res.images || [];
    } catch { }

    const panel = document.getElementById('batchDetailRecyclePanel');
    const list = document.getElementById('batchDetailRecycleList');
    if (!panel || !list) return;

    list.innerHTML = '';
    if (trashedImages.length === 0) {
        list.innerHTML = '<p class="text-center text-gray-400 text-sm py-6">\u56DE\u6536\u7AD9\u662F\u7A7A\u7684</p>';
        panel.style.display = '';
        return;
    }

    const bid = G.batch.bid;
    const vid = _batchDetailVid;
    trashedImages.forEach(img => {
        const url = '/api/batch/' + bid + '/video/' + vid + '/trashed-image/' + img;
        const item = document.createElement('div');
        item.className = 'recycle-item';
        item.innerHTML =
            '<img src="' + url + '" alt="' + _escHtml(img) + '" style="width:60px;height:45px;object-fit:cover;border-radius:4px">' +
            '<div class="flex-1 min-w-0"><p class="text-sm text-gray-700 truncate">' + _escHtml(img) + '</p></div>' +
            '<button class="shrink-0 btn text-xs bg-brand-50 text-brand-600 hover:bg-brand-100 border border-brand-200">\u21A9\uFE0F \u6062\u590D</button>';
        item.querySelector('button').addEventListener('click', async () => {
            const res = await api('/api/batch/' + bid + '/video/' + vid + '/restore-image/' + img, { method: 'POST' });
            if (res.success) {
                _batchDetailImages.push(img);
                _batchDetailImages.sort();
                const task = G.batch.tasks.find(t => t.vid === vid);
                if (task) task.savedCount = _batchDetailImages.length;
                // 从删除栈中也移除（如果有）
                const stackIdx = _batchDetailDeletedStack.findIndex(d => d.filename === img);
                if (stackIdx >= 0) _batchDetailDeletedStack.splice(stackIdx, 1);
                _renderBatchDetailGrid();
                _renderBatchQueue();
                _openBatchDetailRecycleBin(); // 刷新回收站列表
                showToast('\u5DF2\u6062\u590D\u300C' + img + '\u300D', 'success', 2000);
            } else {
                showToast(res.message || '\u6062\u590D\u5931\u8D25', 'error');
            }
        });
        list.appendChild(item);
    });

    // 全部恢复按钮
    const restoreAllBtn = document.createElement('button');
    restoreAllBtn.className = 'w-full mt-2 btn text-xs bg-brand-50 text-brand-600 hover:bg-brand-100 border border-brand-200';
    restoreAllBtn.textContent = '\u21A9\uFE0F \u5168\u90E8\u6062\u590D (' + trashedImages.length + ' \u5F20)';
    restoreAllBtn.addEventListener('click', async () => {
        const res = await api('/api/batch/' + bid + '/video/' + vid + '/restore-all-images', { method: 'POST' });
        if (res.success) {
            _batchDetailDeletedStack = [];
            // 重新获取图片列表
            const imgRes = await api('/api/batch/' + bid + '/video/' + vid + '/images');
            if (imgRes.success) _batchDetailImages = imgRes.images || [];
            const task = G.batch.tasks.find(t => t.vid === vid);
            if (task) task.savedCount = _batchDetailImages.length;
            _renderBatchDetailGrid();
            _renderBatchQueue();
            panel.style.display = 'none';
            showToast('\u5DF2\u6062\u590D\u5168\u90E8 ' + res.count + ' \u5F20\u56FE\u7247', 'success');
        }
    });
    list.appendChild(restoreAllBtn);
    panel.style.display = '';
}

function _closeBatchDetailRecycleBin() {
    const panel = document.getElementById('batchDetailRecyclePanel');
    if (panel) panel.style.display = 'none';
}

async function _batchDetailExport(fmt) {
    if (!G.batch || !_batchDetailVid) return;
    const statusEl = document.getElementById('batchDetailExportStatus');
    statusEl.textContent = '\u6B63\u5728\u5BFC\u51FA ' + fmt.toUpperCase() + '...';
    const res = await api('/api/batch/' + G.batch.bid + '/package/' + _batchDetailVid, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: fmt }),
    });
    if (res.success) {
        statusEl.textContent = fmt.toUpperCase() + ' \u5BFC\u51FA\u5DF2\u5F00\u59CB\uFF0C\u5B8C\u6210\u540E\u53EF\u4E0B\u8F7D';
    } else {
        statusEl.textContent = '\u5BFC\u51FA\u5931\u8D25: ' + (res.message || '');
    }
}

// packageBatchAll 现在使用选中的视频
async function packageBatchAll(fmt) {
    if (!G.batch) return;
    const selectedVids = _getSelectedVids();
    if (selectedVids.length === 0) {
        showToast('\u8BF7\u5148\u52FE\u9009\u8981\u5BFC\u51FA\u7684\u89C6\u9891', 'warning');
        return;
    }
    const res = await api('/api/batch/' + G.batch.bid + '/package-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: fmt, video_ids: selectedVids }),
    });
    if (res.success) {
        document.getElementById('batchExportProgress').style.display = '';
        showToast('\u6279\u91CF\u6253\u5305\u5DF2\u5F00\u59CB (' + selectedVids.length + ' \u4E2A\u89C6\u9891)', 'success', 2000);
    } else {
        showToast(res.message || '\u6279\u91CF\u6253\u5305\u5931\u8D25', 'error');
    }
}
