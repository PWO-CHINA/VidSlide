/**
 * VidSlide v0.5.3 - 多选模块
 * ============================
 * 未选中区域：有序多选 + Shift 范围选
 * 处理队列：无序多选（仅 waiting）
 * 已完成区域：无序多选 + Shift 范围选
 */

// 选择状态
// unselected 用数组保序，queue/completed 用 Set
const _selectionState = {
    unselected: [],   // 有序数组
    queue: new Set(),
    completed: new Set(),
    _lastClicked: { unselected: null, queue: null, completed: null },
};

function _onZoneSelectChange(vid, zone, checked, event) {
    if (zone === 'unselected') {
        if (checked) {
            // Shift 范围选
            if (event && event.shiftKey && _selectionState._lastClicked.unselected) {
                _shiftSelect(zone, _selectionState._lastClicked.unselected, vid);
                return;
            }
            if (!_selectionState.unselected.includes(vid)) {
                _selectionState.unselected.push(vid);
            }
        } else {
            _selectionState.unselected = _selectionState.unselected.filter(v => v !== vid);
        }
        _selectionState._lastClicked.unselected = vid;
    } else if (zone === 'queue') {
        if (checked) {
            _selectionState.queue.add(vid);
        } else {
            _selectionState.queue.delete(vid);
        }
        _selectionState._lastClicked.queue = vid;
    } else if (zone === 'completed') {
        if (checked) {
            if (event && event.shiftKey && _selectionState._lastClicked.completed) {
                _shiftSelect(zone, _selectionState._lastClicked.completed, vid);
                return;
            }
            _selectionState.completed.add(vid);
        } else {
            _selectionState.completed.delete(vid);
        }
        _selectionState._lastClicked.completed = vid;
    }

    // 同步 task.selected
    _syncSelectionToTasks(zone);
    _updateSelectionUI(zone);
}

function _shiftSelect(zone, fromVid, toVid) {
    if (!G.batch) return;
    const tasks = G.batch.zones[zone];
    const fromIdx = tasks.findIndex(t => t.vid === fromVid);
    const toIdx = tasks.findIndex(t => t.vid === toVid);
    if (fromIdx < 0 || toIdx < 0) return;

    const start = Math.min(fromIdx, toIdx);
    const end = Math.max(fromIdx, toIdx);

    for (let i = start; i <= end; i++) {
        const vid = tasks[i].vid;
        // 队列中只选 waiting 状态
        if (zone === 'queue' && tasks[i].status !== 'waiting') continue;

        if (zone === 'unselected') {
            if (!_selectionState.unselected.includes(vid)) {
                _selectionState.unselected.push(vid);
            }
        } else {
            _selectionState[zone].add(vid);
        }
    }

    _syncSelectionToTasks(zone);
    _updateSelectionUI(zone);
    // 更新所有复选框
    _updateCheckboxes(zone);
}

function _syncSelectionToTasks(zone) {
    if (!G.batch) return;
    const tasks = G.batch.zones[zone];
    if (zone === 'unselected') {
        const selectedSet = new Set(_selectionState.unselected);
        tasks.forEach(t => { t.selected = selectedSet.has(t.vid); });
    } else {
        tasks.forEach(t => { t.selected = _selectionState[zone].has(t.vid); });
    }
}

function _updateCheckboxes(zone) {
    const listId = zone === 'unselected' ? 'unselectedList'
                 : zone === 'queue' ? 'queueList'
                 : 'completedList';
    const list = document.getElementById(listId);
    if (!list) return;
    list.querySelectorAll('.zone-select-cb').forEach(cb => {
        const vid = cb.dataset.vid;
        if (zone === 'unselected') {
            cb.checked = _selectionState.unselected.includes(vid);
        } else {
            cb.checked = _selectionState[zone].has(vid);
        }
    });
}

function _updateSelectionUI(zone) {
    // 更新移入队列按钮文字
    if (zone === 'unselected') {
        const btn = document.getElementById('btnMoveToQueue');
        const count = _selectionState.unselected.length;
        if (btn) {
            btn.textContent = count > 0
                ? '移入队列 (' + count + ') →'
                : '全部移入队列 →';
        }
    }
    // 更新移回按钮
    if (zone === 'queue') {
        const btn = document.getElementById('btnMoveToUnselected');
        const count = _selectionState.queue.size;
        if (btn) {
            btn.textContent = count > 0
                ? '← 移回 (' + count + ')'
                : '← 移回未选中';
            btn.disabled = count === 0;
        }
    }
    // 更新导出选择提示
    if (zone === 'completed') {
        const hint = document.getElementById('batchExportHint');
        const total = G.batch ? G.batch.zones.completed.length : 0;
        const count = _selectionState.completed.size;
        if (hint) hint.textContent = '已选择 ' + count + '/' + total + ' 个视频';
    }
}

function _getSelectedVids(zone) {
    if (zone === 'unselected') {
        return [..._selectionState.unselected];
    }
    return [..._selectionState[zone]];
}

function _clearSelection(zone) {
    if (zone === 'unselected') {
        _selectionState.unselected = [];
    } else {
        _selectionState[zone].clear();
    }
    _selectionState._lastClicked[zone] = null;
    if (G.batch) {
        G.batch.zones[zone].forEach(t => { t.selected = false; });
    }
    _updateCheckboxes(zone);
    _updateSelectionUI(zone);
}

function selectAllInZone(zone) {
    if (!G.batch) return;
    const tasks = G.batch.zones[zone];
    const currentCount = zone === 'unselected'
        ? _selectionState.unselected.length
        : _selectionState[zone].size;
    const eligibleTasks = zone === 'queue'
        ? tasks.filter(t => t.status === 'waiting')
        : tasks;
    const allSelected = currentCount === eligibleTasks.length && eligibleTasks.length > 0;

    if (allSelected) {
        // 取消全选
        _clearSelection(zone);
    } else {
        // 全选
        if (zone === 'unselected') {
            _selectionState.unselected = eligibleTasks.map(t => t.vid);
        } else {
            _selectionState[zone] = new Set(eligibleTasks.map(t => t.vid));
        }
        _syncSelectionToTasks(zone);
        _updateCheckboxes(zone);
        _updateSelectionUI(zone);
    }

    // 更新全选按钮文字
    const btnId = zone === 'completed' ? 'btnSelectAllCompleted' : null;
    if (btnId) {
        const btn = document.getElementById(btnId);
        if (btn) btn.textContent = allSelected ? '全选' : '取消全选';
    }
}
