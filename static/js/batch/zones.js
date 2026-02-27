/**
 * VidSlide v0.5.3 - 三区域渲染模块
 * ===================================
 * 未选中 / 处理队列 / 已完成 三区域的视频卡片渲染
 */

// ============================================================
//  主渲染入口
// ============================================================
function renderAllZones() {
    if (!G.batch) {
        // 无 batch 时显示空状态
        _showEmptyState('zoneUnselected', true);
        _showEmptyState('zoneQueue', true);
        _showEmptyState('zoneCompleted', true);
        return;
    }
    _renderZone('unselected');
    _renderZone('queue');
    _renderZone('completed');
    _updateZoneCounts();
    _updateGlobalProgress();
    _updateBatchBadge();
    _updateRecycleCapsule();
}

function _renderZone(zone) {
    if (!G.batch) return;
    const tasks = G.batch.zones[zone] || [];
    const listId = zone === 'unselected' ? 'unselectedList'
                 : zone === 'queue' ? 'queueList'
                 : 'completedList';
    const list = document.getElementById(listId);
    if (!list) return;

    const isEmpty = tasks.length === 0;
    _showEmptyState('zone' + zone.charAt(0).toUpperCase() + zone.slice(1), isEmpty);

    if (isEmpty) {
        list.innerHTML = '';
        return;
    }

    list.style.display = '';
    const frag = document.createDocumentFragment();
    tasks.forEach(t => frag.appendChild(_createZoneVideoItem(t, zone)));
    list.innerHTML = '';
    list.appendChild(frag);

    // 初始化拖拽
    _initZoneSortable(zone);
}

function _showEmptyState(sectionId, show) {
    const emptyIds = {
        zoneUnselected: 'unselectedEmpty',
        zoneQueue: 'queueEmpty',
        zoneCompleted: 'completedEmpty',
    };
    const listIds = {
        zoneUnselected: 'unselectedList',
        zoneQueue: 'queueList',
        zoneCompleted: 'completedList',
    };
    const emptyEl = document.getElementById(emptyIds[sectionId]);
    const listEl = document.getElementById(listIds[sectionId]);
    if (emptyEl) emptyEl.style.display = show ? '' : 'none';
    if (listEl) listEl.style.display = show ? 'none' : '';
}

function _updateZoneCounts() {
    if (!G.batch) return;
    const z = G.batch.zones;
    const el = (id) => document.getElementById(id);
    if (el('unselectedCount')) el('unselectedCount').textContent = '(' + z.unselected.length + ')';
    if (el('queueCount')) el('queueCount').textContent = '(' + z.queue.length + ')';
    if (el('completedCount')) el('completedCount').textContent = '(' + z.completed.length + ')';
}

// ============================================================
//  视频卡片模板
// ============================================================
function _createZoneVideoItem(task, zone) {
    const div = document.createElement('div');
    div.className = 'batch-video-item zone-' + zone + ' status-' + task.status;
    div.dataset.vid = task.vid;
    div.dataset.zone = zone;

    const bid = G.batch.bid;
    const thumbUrl = '/api/batch/' + bid + '/thumbnail/' + task.vid;

    let infoHtml = '';
    let actionsHtml = '';
    let nameClickable = false;
    let showCheckbox = false;
    let showDragHandle = false;

    if (zone === 'unselected') {
        nameClickable = true;
        showDragHandle = true;
        showCheckbox = true;
        // 预估处理时间
        const est = task.estimatedTime;
        infoHtml = est > 0 ? '预估处理时间: ' + _formatDuration(est) : '';
        actionsHtml =
            '<button onclick="_removeFromUnselected(\'' + task.vid + '\')" class="btn-ghost-danger text-xs" title="从列表移除">✕</button>';

    } else if (zone === 'queue') {
        showDragHandle = task.status === 'waiting';
        showCheckbox = task.status === 'waiting';

        if (task.status === 'running') {
            const elapsed = _formatDuration(task.elapsedSeconds || 0);
            const eta = task.etaSeconds > 0 ? _formatDuration(task.etaSeconds) : '--';
            infoHtml = elapsed + ' · ' + task.progress + '% · 剩余 ' + eta;
            actionsHtml =
                '<button onclick="_trashRunningVideo(\'' + task.vid + '\')" class="btn-ghost-danger text-xs" title="取消并移入回收站">🗑</button>';
        } else if (task.status === 'waiting') {
            const est = task.estimatedTime;
            infoHtml = est > 0 ? '预估: ' + _formatDuration(est) : '等待处理';
            actionsHtml =
                '<button onclick="_prioritizeInQueue(\'' + task.vid + '\')" class="btn-ghost text-xs" title="优先处理">⬆</button>' +
                '<button onclick="_moveBackToUnselected(\'' + task.vid + '\')" class="btn-ghost text-xs" title="移回未选中">← 移回</button>';
        } else if (task.status === 'error') {
            infoHtml = '<span class="text-red-500">' + _escHtml(task.errorMessage || task.message || '处理失败') + '</span>';
            actionsHtml =
                '<button onclick="_retryQueueVideo(\'' + task.vid + '\')" class="btn-ghost text-xs" title="重试">重试</button>' +
                '<button onclick="_trashErrorVideo(\'' + task.vid + '\')" class="btn-ghost-danger text-xs" title="移入回收站">🗑</button>';
        }

    } else if (zone === 'completed') {
        nameClickable = true;
        showCheckbox = true;
        const elapsed = _formatDuration(task.elapsedSeconds || 0);
        infoHtml = elapsed + ' · ' + task.savedCount + ' 张幻灯片';
        actionsHtml =
            '<button onclick="_trashCompletedVideo(\'' + task.vid + '\')" class="btn-ghost-danger text-xs" title="移入回收站">🗑</button>';
    }

    // 名称点击行为
    let nameAttr = '';
    if (nameClickable) {
        if (zone === 'unselected') {
            nameAttr = ' onclick="_openUnselectedDetail(\'' + task.vid + '\')" style="cursor:pointer"';
        } else if (zone === 'completed') {
            nameAttr = ' onclick="openBatchDetail(\'' + task.vid + '\')" style="cursor:pointer"';
        }
    }

    // 多选复选框
    const checkboxHtml = showCheckbox
        ? '<input type="checkbox" class="zone-select-cb" data-vid="' + task.vid + '" data-zone="' + zone + '" ' +
          (task.selected ? 'checked' : '') +
          ' onclick="event.stopPropagation();_onZoneSelectChange(\'' + task.vid + '\',\'' + zone + '\',this.checked,event)">'
        : '';

    // 拖拽手柄
    const dragHtml = showDragHandle
        ? '<span class="drag-handle" title="拖拽排序">⁞</span>'
        : '';

    // 进度条（仅 running）
    const progressHtml = task.status === 'running'
        ? '<div class="batch-mini-progress"><div class="batch-mini-progress-fill" style="width:' + task.progress + '%"></div></div>'
        : '';

    // 状态徽章
    const statusLabels = {
        idle: '', waiting: '等待中', running: '处理中', done: '已完成', error: '失败',
    };
    const badgeHtml = statusLabels[task.status]
        ? '<span class="batch-status-badge ' + task.status + '">' + statusLabels[task.status] + '</span>'
        : '';

    div.innerHTML =
        checkboxHtml +
        dragHtml +
        '<img class="batch-thumbnail" src="' + thumbUrl + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">' +
        '<div class="flex-1 min-w-0">' +
            '<div class="batch-video-name" data-vid="' + task.vid + '"' + nameAttr + '>' +
                _escHtml(task.displayName) +
                (task.savedCount > 0 && zone !== 'completed' ? ' <span class="text-xs text-slate-400">(' + task.savedCount + '张)</span>' : '') +
            '</div>' +
            '<div class="text-xs text-slate-400 mt-0.5 truncate batch-item-message">' + (infoHtml || _escHtml(task.message || '')) + '</div>' +
        '</div>' +
        progressHtml +
        badgeHtml +
        '<div class="batch-item-actions">' + actionsHtml + '</div>';

    return div;
}

// ============================================================
//  就地更新（避免全量重渲染）
// ============================================================
function _updateVideoItemInPlace(vid) {
    const task = _findTask(vid);
    if (!task) return;
    const el = document.querySelector('.batch-video-item[data-vid="' + vid + '"]');
    if (!el) return;

    // 更新进度条
    const prog = el.querySelector('.batch-mini-progress');
    const fill = el.querySelector('.batch-mini-progress-fill');
    if (prog && fill) {
        prog.style.display = task.status === 'running' ? '' : 'none';
        fill.style.width = task.progress + '%';
    }

    // 更新状态徽章
    const badge = el.querySelector('.batch-status-badge');
    if (badge) {
        const labels = { idle: '', waiting: '等待中', running: '处理中', done: '已完成', error: '失败' };
        badge.className = 'batch-status-badge ' + task.status;
        badge.textContent = labels[task.status] || '';
    }

    // 更新信息行
    const msg = el.querySelector('.batch-item-message');
    if (msg) {
        if (task.status === 'running') {
            const elapsed = _formatDuration(task.elapsedSeconds || 0);
            const eta = task.etaSeconds > 0 ? _formatDuration(task.etaSeconds) : '--';
            msg.innerHTML = elapsed + ' · ' + task.progress + '% · 剩余 ' + eta;
        } else {
            msg.textContent = task.message || '';
        }
    }

    el.className = 'batch-video-item zone-' + task.zone + ' status-' + task.status;
}

// ============================================================
//  全局进度条
// ============================================================
function _updateGlobalProgress() {
    if (!G.batch) return;
    const queueTasks = G.batch.zones.queue || [];
    const completedTasks = G.batch.zones.completed || [];
    const total = queueTasks.length + completedTasks.length;

    const progressSection = document.getElementById('queueProgress');
    if (!progressSection) return;

    if (total === 0 && G.batch.status === 'idle') {
        progressSection.style.display = 'none';
        return;
    }
    progressSection.style.display = '';

    let weightedSum = 0;
    let doneCount = completedTasks.length;
    let failedCount = 0;
    let runningCount = 0;
    let waitingCount = 0;

    for (const t of queueTasks) {
        if (t.status === 'error') { weightedSum += 100; failedCount++; }
        else if (t.status === 'running') { weightedSum += (t.progress || 0); runningCount++; }
        else { waitingCount++; }
    }
    weightedSum += doneCount * 100;
    const allCount = total;
    const pct = allCount > 0 ? Math.round(weightedSum / allCount) : 0;

    const bar = document.getElementById('batchGlobalProgress');
    const text = document.getElementById('batchStatsText');
    const detail = document.getElementById('batchStatsDetail');
    const pctEl = document.getElementById('batchProgressPct');
    const etaEl = document.getElementById('batchProgressEta');

    if (bar) bar.style.width = pct + '%';
    if (text) {
        if (G.batch.status === 'processing') text.textContent = '处理中';
        else if (G.batch.status === 'idle' && doneCount > 0) text.textContent = '已暂停';
        else text.textContent = '就绪';
    }
    if (detail) {
        let parts = [];
        parts.push('完成 ' + doneCount + '/' + allCount);
        if (failedCount > 0) parts.push('失败 ' + failedCount);
        if (waitingCount > 0) parts.push('等待 ' + waitingCount);
        parts.push('共 ' + (G.batch.totalImages || 0) + ' 张');
        detail.textContent = parts.join(' | ');
    }
    if (pctEl) pctEl.textContent = pct + '%';
    if (etaEl) {
        if (G.batch.status === 'processing' && pct > 0 && pct < 100 && G.batch._startTime) {
            const elapsed = (Date.now() - G.batch._startTime) / 1000;
            const remaining = elapsed / pct * (100 - pct);
            etaEl.textContent = '预计剩余 ' + _formatDuration(remaining);
        } else {
            etaEl.textContent = '';
        }
    }
}

// ============================================================
//  回收站胶囊
// ============================================================
async function _updateRecycleCapsule() {
    const capsule = document.getElementById('recycleCapsule');
    const countEl = document.getElementById('recycleCapsuleCount');
    if (!capsule || !G.batch) {
        if (capsule) capsule.style.display = 'none';
        return;
    }
    try {
        const res = await api('/api/batch/' + G.batch.bid + '/trashed-videos');
        const count = res.success ? (res.videos || []).length : 0;
        capsule.style.display = count > 0 ? '' : 'none';
        if (countEl) countEl.textContent = count;
    } catch {
        capsule.style.display = 'none';
    }
}
