/**
 * VidSlide v0.6.1 - 控制模块
 * ============================
 * 开始/暂停、移入队列/移回、重试、SortableJS
 */

// ============================================================
//  SortableJS 实例
// ============================================================
let _sortableUnselected = null;
let _sortableQueue = null;

function _initZoneSortable(zone) {
    if (zone === 'unselected') {
        if (_sortableUnselected) _sortableUnselected.destroy();
        const list = document.getElementById('unselectedList');
        if (!list || !list.children.length) return;
        _sortableUnselected = Sortable.create(list, {
            animation: 250,
            handle: '.drag-handle',
            ghostClass: 'sortable-ghost',
            chosenClass: 'sortable-chosen',
            group: { name: 'unselected', pull: 'clone', put: false },
            sort: true,
            onEnd(evt) {
                if (!G.batch) return;
                // 区域内排序
                if (evt.from === evt.to) {
                    const items = list.querySelectorAll('.batch-video-item');
                    const newOrder = Array.from(items).map(el => el.dataset.vid);
                    const taskMap = {};
                    G.batch.zones.unselected.forEach(t => taskMap[t.vid] = t);
                    G.batch.zones.unselected = newOrder.map(vid => taskMap[vid]).filter(Boolean);
                    api('/api/batch/' + G.batch.bid + '/reorder', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ order: newOrder, zone: 'unselected' }),
                    });
                }
            },
        });
    } else if (zone === 'queue') {
        if (_sortableQueue) _sortableQueue.destroy();
        const list = document.getElementById('queueList');
        if (!list || !list.children.length) return;
        _sortableQueue = Sortable.create(list, {
            animation: 250,
            handle: '.drag-handle',
            ghostClass: 'sortable-ghost',
            chosenClass: 'sortable-chosen',
            group: { name: 'queue', pull: false, put: ['unselected'] },
            sort: true,
            // 不允许拖到 running 视频前面
            onMove(evt) {
                const related = evt.related;
                if (related && related.dataset.vid) {
                    const task = G.batch.zones.queue.find(t => t.vid === related.dataset.vid);
                    if (task && task.status === 'running' && evt.willInsertAfter === false) {
                        return false;
                    }
                }
                return true;
            },
            onAdd(evt) {
                // 从未选中拖入队列
                if (!G.batch) return;
                const vid = evt.item.dataset.vid;
                const position = evt.newIndex;
                // 移除克隆的 DOM（我们会通过 API 刷新）
                evt.item.remove();
                _moveToQueueByIds([vid], position);
            },
            onEnd(evt) {
                if (!G.batch) return;
                if (evt.from === evt.to) {
                    const items = list.querySelectorAll('.batch-video-item');
                    const newOrder = Array.from(items).map(el => el.dataset.vid);
                    const taskMap = {};
                    G.batch.zones.queue.forEach(t => taskMap[t.vid] = t);
                    G.batch.zones.queue = newOrder.map(vid => taskMap[vid]).filter(Boolean);
                    api('/api/batch/' + G.batch.bid + '/reorder', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ order: newOrder, zone: 'queue' }),
                    });
                }
            },
        });
    }
    // completed 区域不支持拖拽排序
}

// ============================================================
//  队列控制按钮
// ============================================================
function _updateBatchControls() {
    if (!G.batch) return;
    const s = G.batch.status;
    const hasWaiting = G.batch.zones.queue.some(t => t.status === 'waiting');
    const hasRunning = G.batch.zones.queue.some(t => t.status === 'running');
    const hasDone = G.batch.zones.completed.length > 0;

    const el = (id) => document.getElementById(id);

    // 开始/暂停按钮
    const btnStartPause = el('btnStartOrPause');
    if (btnStartPause) {
        if (s === 'processing') {
            btnStartPause.innerHTML = '<i data-lucide="pause" class="w-3.5 h-3.5 inline-block"></i> 处理完当前视频后暂停';
            btnStartPause.className = 'btn-secondary text-xs';
            btnStartPause.disabled = false;
            btnStartPause.onclick = pauseAfterCurrent;
        } else {
            btnStartPause.innerHTML = '<i data-lucide="play" class="w-3.5 h-3.5 inline-block"></i> 开始处理';
            btnStartPause.className = 'btn-primary text-xs';
            btnStartPause.disabled = !hasWaiting;
            btnStartPause.onclick = startProcessing;
        }
        refreshIcons(btnStartPause);
    }

    // 移入队列按钮
    const btnMoveToQueue = el('btnMoveToQueue');
    if (btnMoveToQueue) {
        const selectedCount = _getSelectedVids('unselected').length;
        btnMoveToQueue.disabled = selectedCount === 0 && G.batch.zones.unselected.length === 0;
    }

    // 移回未选中按钮
    const btnMoveBack = el('btnMoveToUnselected');
    if (btnMoveBack) {
        const selectedCount = _getSelectedVids('queue').length;
        btnMoveBack.disabled = selectedCount === 0;
    }

    // 导出按钮区域
    const exportSection = el('completedExportBar');
    if (exportSection) {
        exportSection.style.display = hasDone ? '' : 'none';
    }

    // 并发数
    const workerSel = el('batchWorkerCount');
    if (workerSel) workerSel.disabled = s === 'processing';

    // 全局进度区域
    const progressSection = el('queueProgress');
    if (progressSection) {
        progressSection.style.display = (s === 'processing' || hasRunning || G.batch.zones.completed.length > 0) ? '' : 'none';
    }
}

// ============================================================
//  开始处理 / 暂停
// ============================================================
async function startProcessing() {
    if (!G.batch) return;
    // 更新参数并保存
    G.batch.params = _readBatchParams();
    _saveBatchPrefs(G.batch.params);
    G.batch.maxWorkers = parseInt(document.getElementById('batchWorkerCount').value) || 1;
    try {
        const res = await api('/api/batch/' + G.batch.bid + '/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ params: G.batch.params })
        });
        if (res.success) {
            G.batch.status = 'processing';
            G.batch._startTime = Date.now();
            _updateBatchControls();
            renderAllZones();
            showToast('批量处理已开始', 'success', 2000);
        } else {
            showToast(res.message || '启动失败', 'error');
        }
    } catch (e) {
        showToast('启动失败: ' + e.message, 'error');
    }
}

async function pauseAfterCurrent() {
    if (!G.batch) return;
    const res = await api('/api/batch/' + G.batch.bid + '/pause', { method: 'POST' });
    if (res.success) {
        showToast('将在当前视频处理完成后暂停', 'info', 3000);
        // 按钮状态会通过 SSE batch_status 事件更新
    }
}

// ============================================================
//  移入队列 / 移回未选中
// ============================================================
async function moveSelectedToQueue() {
    if (!G.batch) return;
    let vids = _getSelectedVids('unselected');
    if (vids.length === 0) {
        // 没有选中的，移入全部
        vids = G.batch.zones.unselected.map(t => t.vid);
    }
    if (vids.length === 0) {
        showToast('没有可移入的视频', 'warning');
        return;
    }
    await _moveToQueueByIds(vids);
}

async function _moveToQueueByIds(vids, position) {
    if (!G.batch || vids.length === 0) return;
    const body = { video_ids: vids };
    if (position !== undefined) body.position = position;
    const res = await api('/api/batch/' + G.batch.bid + '/move-to-queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (res.success) {
        showToast('已移入队列 ' + res.moved + ' 个视频', 'success', 2000);
        _clearSelection('unselected');
        await _refreshBatchState();
    } else {
        showToast(res.message || '移入失败', 'error');
    }
}

async function moveSelectedToUnselected() {
    if (!G.batch) return;
    const vids = _getSelectedVids('queue');
    if (vids.length === 0) {
        showToast('请先选择要移回的视频', 'warning');
        return;
    }
    const res = await api('/api/batch/' + G.batch.bid + '/move-to-unselected', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ video_ids: vids }),
    });
    if (res.success) {
        showToast('已移回 ' + res.moved + ' 个视频', 'success', 2000);
        _clearSelection('queue');
        await _refreshBatchState();
    } else {
        showToast(res.message || '移回失败', 'error');
    }
}

// ============================================================
//  单视频操作
// ============================================================
async function _removeFromUnselected(vid) {
    if (!G.batch) return;
    const res = await api('/api/batch/' + G.batch.bid + '/remove-video/' + vid, { method: 'POST' });
    if (res.success) {
        G.batch.zones.unselected = G.batch.zones.unselected.filter(t => t.vid !== vid);
        renderAllZones();
    } else {
        showToast(res.message || '移除失败', 'error');
    }
}

async function _moveBackToUnselected(vid) {
    if (!G.batch) return;
    const res = await api('/api/batch/' + G.batch.bid + '/move-to-unselected', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ video_ids: [vid] }),
    });
    if (res.success) {
        await _refreshBatchState();
    }
}

async function _prioritizeInQueue(vid) {
    if (!G.batch) return;
    const res = await api('/api/batch/' + G.batch.bid + '/prioritize/' + vid, { method: 'POST' });
    if (res.success) {
        await _refreshBatchState();
        showToast('已优先处理', 'success', 1500);
    }
}

async function _retryQueueVideo(vid) {
    if (!G.batch) return;
    const res = await api('/api/batch/' + G.batch.bid + '/retry/' + vid, { method: 'POST' });
    if (res.success) {
        const task = _findTask(vid);
        if (task) { task.status = 'waiting'; task.progress = 0; task.message = ''; task.errorMessage = ''; }
        renderAllZones();
        _updateBatchControls();
    } else {
        showToast(res.message || '重试失败', 'error');
    }
}

async function _trashRunningVideo(vid) {
    if (!G.batch) return;
    if (!confirm('确定取消正在处理的视频？已提取的图片将保留在回收站中。')) return;
    const res = await api('/api/batch/' + G.batch.bid + '/cancel-video/' + vid, { method: 'POST' });
    if (res.success) {
        showToast('正在取消，请稍候', 'info', 2000);
    } else {
        showToast(res.message || '取消失败', 'error');
    }
}

async function _trashErrorVideo(vid) {
    if (!G.batch) return;
    const res = await api('/api/batch/' + G.batch.bid + '/trash-video/' + vid, { method: 'POST' });
    if (res.success) {
        await _refreshBatchState();
        showToast('已移入回收站', 'success', 2000);
    } else {
        showToast(res.message || '操作失败', 'error');
    }
}

async function _trashCompletedVideo(vid) {
    if (!G.batch) return;
    const res = await api('/api/batch/' + G.batch.bid + '/trash-video/' + vid, { method: 'POST' });
    if (res.success) {
        await _refreshBatchState();
        showToast('已移入回收站', 'success', 2000);
    } else {
        showToast(res.message || '操作失败', 'error');
    }
}

// ============================================================
//  添加视频 / 扫描文件夹
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
