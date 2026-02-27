/**
 * VidSlide v0.5.3 - 详情页模块
 * ==============================
 * 未选中详情（重命名 + 预估时间）
 * 已完成详情（画廊 + 预览 + 删除 + 撤销 + 导出）
 */

// ============================================================
//  未选中区域详情页
// ============================================================
function _openUnselectedDetail(vid) {
    if (!G.batch) return;
    const task = G.batch.zones.unselected.find(t => t.vid === vid);
    if (!task) return;

    const modal = document.getElementById('batchDetailModal');
    const title = document.getElementById('batchDetailTitle');
    const count = document.getElementById('batchDetailCount');
    const grid = document.getElementById('batchDetailGrid');
    const info = document.getElementById('batchDetailInfo');
    const exportBar = document.getElementById('batchDetailExportBar');
    const recycleBtn = document.getElementById('batchDetailRecycleBtn');

    title.textContent = task.displayName;
    title.dataset.vid = vid;
    title.dataset.zone = 'unselected';
    title.onclick = () => _startDetailRename(vid);
    title.style.cursor = 'pointer';
    title.title = '点击重命名';

    count.textContent = '';
    grid.innerHTML = '<div class="text-center py-12 text-slate-400">' +
        '<p class="text-sm mb-2">预估处理时间: ' + (task.estimatedTime > 0 ? _formatDuration(task.estimatedTime) : '未知') + '</p>' +
        '<p class="text-xs">帧数: ' + (task.totalFrames || '未知') + ' · FPS: ' + (task.fps || '未知') + '</p>' +
        '<p class="text-xs">分辨率: ' + (task.resolution[0] || '?') + '×' + (task.resolution[1] || '?') + '</p>' +
        '</div>';
    info.textContent = '点击标题可重命名';
    if (exportBar) exportBar.style.display = 'none';
    if (recycleBtn) recycleBtn.style.display = 'none';

    const recyclePanel = document.getElementById('batchDetailRecyclePanel');
    if (recyclePanel) recyclePanel.style.display = 'none';

    modal.classList.remove('hidden');
    document.addEventListener('keydown', _batchDetailKeyHandler);
}

// ============================================================
//  已完成区域详情页（画廊 + 预览 + 导出）
// ============================================================
let _batchDetailVid = null;
let _batchDetailImages = [];
let _batchPreviewIdx = -1;
let _batchDetailDeletedStack = [];
let _batchDetailSortable = null;

async function openBatchDetail(vid) {
    if (!G.batch) return;
    const task = G.batch.zones.completed.find(t => t.vid === vid);
    if (!task) { showToast('视频不存在', 'warning'); return; }

    _batchDetailVid = vid;
    _batchDetailImages = [];
    _batchPreviewIdx = -1;
    _batchDetailDeletedStack = [];

    try {
        const res = await api('/api/batch/' + G.batch.bid + '/video/' + vid + '/images');
        if (res.success && res.images) {
            _batchDetailImages = res.images;
        }
    } catch (e) {
        showToast('获取图片列表失败', 'error');
        return;
    }

    const modal = document.getElementById('batchDetailModal');
    const title = document.getElementById('batchDetailTitle');
    const count = document.getElementById('batchDetailCount');
    const exportBar = document.getElementById('batchDetailExportBar');
    const recycleBtn = document.getElementById('batchDetailRecycleBtn');

    title.textContent = task.displayName;
    title.dataset.vid = vid;
    title.dataset.zone = 'completed';
    title.onclick = () => _startDetailRename(vid);
    title.style.cursor = 'pointer';
    title.title = '点击重命名';

    count.textContent = _batchDetailImages.length + ' 张图片';
    document.getElementById('batchDetailExportStatus').textContent = '';

    if (exportBar) exportBar.style.display = '';
    if (recycleBtn) recycleBtn.style.display = 'none';

    const recyclePanel = document.getElementById('batchDetailRecyclePanel');
    if (recyclePanel) recyclePanel.style.display = 'none';

    _renderBatchDetailGrid();
    modal.classList.remove('hidden');
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

// ============================================================
//  画廊渲染
// ============================================================
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
                '<button class="batch-detail-del-btn" title="删除">✕</button>' +
            '</div>';
        div.querySelector('img').addEventListener('click', () => _openBatchPreview(idx));
        div.querySelector('.batch-detail-del-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            const curIdx = Array.from(grid.children).indexOf(div);
            if (curIdx >= 0) _deleteBatchDetailImage(curIdx);
        });
        frag.appendChild(div);
    });
    grid.appendChild(frag);
    document.getElementById('batchDetailCount').textContent = _batchDetailImages.length + ' 张图片';
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
    document.getElementById('batchDetailCount').textContent = _batchDetailImages.length + ' 张图片';
}

// ============================================================
//  大图预览
// ============================================================
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

    // 接管预览弹窗的所有按钮，避免调用标签页模式的函数
    modal.onclick = (e) => { if (e.target === modal) _closeBatchPreview(); };
    const btnClose = modal.querySelector('button[onclick*="hidePreview"]');
    if (btnClose) btnClose.onclick = (e) => { e.stopPropagation(); _closeBatchPreview(); };

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

async function _deleteBatchDetailImageInPreview() {
    if (_batchPreviewIdx < 0 || _batchPreviewIdx >= _batchDetailImages.length) return;
    const delBtn = document.getElementById('btnDeletePreview');
    if (delBtn) {
        delBtn.classList.remove('flash');
        void delBtn.offsetWidth;
        delBtn.classList.add('flash');
    }
    await _deleteBatchDetailImage(_batchPreviewIdx);
    if (_batchDetailImages.length === 0) {
        showToast('已删除最后一张图片，退出预览', 'info', 2000);
        _closeBatchPreview();
        return;
    }
    const newIdx = _batchPreviewIdx < _batchDetailImages.length ? _batchPreviewIdx : _batchDetailImages.length - 1;
    _openBatchPreview(newIdx);
}

// ============================================================
//  图片删除 / 撤销
// ============================================================
async function _deleteBatchDetailImage(idx) {
    if (!G.batch || !_batchDetailVid) return;
    if (idx < 0 || idx >= _batchDetailImages.length) return;
    const img = _batchDetailImages[idx];

    try {
        const res = await api('/api/batch/' + G.batch.bid + '/video/' + _batchDetailVid + '/delete-image/' + img, {
            method: 'POST',
        });
        if (!res.success) {
            showToast(res.message || '删除失败', 'error');
            return;
        }
    } catch (e) {
        showToast('删除失败: ' + e.message, 'error');
        return;
    }

    _batchDetailImages.splice(idx, 1);
    _batchDetailDeletedStack.push({ filename: img, originalIndex: idx });

    const task = G.batch.zones.completed.find(t => t.vid === _batchDetailVid);
    if (task) task.savedCount = _batchDetailImages.length;

    const grid = document.getElementById('batchDetailGrid');
    const card = grid.children[idx];
    if (card) {
        card.classList.add('removing');
        card.addEventListener('transitionend', () => { card.remove(); _refreshBatchDetailBadges(); }, { once: true });
        setTimeout(() => { if (card.parentNode) { card.remove(); _refreshBatchDetailBadges(); } }, 350);
    }
    _updateBatchDetailRecycleBtn();
    // 如果回收站面板已展开，实时刷新其内容
    const recyclePanel = document.getElementById('batchDetailRecyclePanel');
    if (recyclePanel && recyclePanel.style.display !== 'none') {
        _openBatchDetailRecycleBin();
    }
    showToast('已移入回收站 (Ctrl+Z 撤销)', 'info', 2000);
}

async function _undoBatchDetailDelete() {
    if (!G.batch || !_batchDetailVid || _batchDetailDeletedStack.length === 0) return;
    const { filename, originalIndex } = _batchDetailDeletedStack.pop();

    try {
        const res = await api('/api/batch/' + G.batch.bid + '/video/' + _batchDetailVid + '/restore-image/' + filename, {
            method: 'POST',
        });
        if (!res.success) {
            showToast(res.message || '恢复失败', 'error');
            _batchDetailDeletedStack.push({ filename, originalIndex });
            return;
        }
    } catch (e) {
        showToast('恢复失败: ' + e.message, 'error');
        _batchDetailDeletedStack.push({ filename, originalIndex });
        return;
    }

    const insertIdx = Math.min(originalIndex, _batchDetailImages.length);
    _batchDetailImages.splice(insertIdx, 0, filename);

    const task = G.batch.zones.completed.find(t => t.vid === _batchDetailVid);
    if (task) task.savedCount = _batchDetailImages.length;

    _renderBatchDetailGrid();
    _updateBatchDetailRecycleBtn();
    // 如果回收站面板已展开，实时刷新其内容
    const recyclePanel = document.getElementById('batchDetailRecyclePanel');
    if (recyclePanel && recyclePanel.style.display !== 'none') {
        _openBatchDetailRecycleBin();
    }
    showToast('已恢复「' + filename + '」', 'success', 2000);

    if (_batchPreviewIdx >= 0) {
        _openBatchPreview(Math.min(insertIdx, _batchDetailImages.length - 1));
    }
}

// ============================================================
//  详情页图片回收站
// ============================================================
async function _updateBatchDetailRecycleBtn() {
    const btn = document.getElementById('batchDetailRecycleBtn');
    if (!btn) return;
    let count = 0;
    if (G.batch && _batchDetailVid) {
        try {
            const res = await api('/api/batch/' + G.batch.bid + '/video/' + _batchDetailVid + '/trashed-images');
            if (res.success) count = (res.images || []).length;
        } catch { }
    }
    btn.style.display = count > 0 ? '' : 'none';
    btn.textContent = '🗑 回收站 (' + count + ')';
}

async function _openBatchDetailRecycleBin() {
    if (!G.batch || !_batchDetailVid) return;
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
        list.innerHTML = '<p class="text-center text-gray-400 text-sm py-6">回收站是空的</p>';
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
            '<button class="shrink-0 btn text-xs bg-brand-50 text-brand-600 hover:bg-brand-100 border border-brand-200">↩️ 恢复</button>';
        item.querySelector('button').addEventListener('click', async () => {
            const res = await api('/api/batch/' + bid + '/video/' + vid + '/restore-image/' + img, { method: 'POST' });
            if (res.success) {
                _batchDetailImages.push(img);
                _batchDetailImages.sort();
                const task = G.batch.zones.completed.find(t => t.vid === vid);
                if (task) task.savedCount = _batchDetailImages.length;
                const stackIdx = _batchDetailDeletedStack.findIndex(d => d.filename === img);
                if (stackIdx >= 0) _batchDetailDeletedStack.splice(stackIdx, 1);
                _renderBatchDetailGrid();
                _openBatchDetailRecycleBin();
                showToast('已恢复「' + img + '」', 'success', 2000);
            } else {
                showToast(res.message || '恢复失败', 'error');
            }
        });
        list.appendChild(item);
    });

    const restoreAllBtn = document.createElement('button');
    restoreAllBtn.className = 'w-full mt-2 btn text-xs bg-brand-50 text-brand-600 hover:bg-brand-100 border border-brand-200';
    restoreAllBtn.textContent = '↩️ 全部恢复 (' + trashedImages.length + ' 张)';
    restoreAllBtn.addEventListener('click', async () => {
        const res = await api('/api/batch/' + bid + '/video/' + vid + '/restore-all-images', { method: 'POST' });
        if (res.success) {
            _batchDetailDeletedStack = [];
            const imgRes = await api('/api/batch/' + bid + '/video/' + vid + '/images');
            if (imgRes.success) _batchDetailImages = imgRes.images || [];
            const task = G.batch.zones.completed.find(t => t.vid === vid);
            if (task) task.savedCount = _batchDetailImages.length;
            _renderBatchDetailGrid();
            panel.style.display = 'none';
            showToast('已恢复全部 ' + res.count + ' 张图片', 'success');
        }
    });
    list.appendChild(restoreAllBtn);
    panel.style.display = '';
}

function _closeBatchDetailRecycleBin() {
    const panel = document.getElementById('batchDetailRecyclePanel');
    if (panel) panel.style.display = 'none';
}

// ============================================================
//  详情页重命名
// ============================================================
function _startDetailRename(vid) {
    const title = document.getElementById('batchDetailTitle');
    if (!title || title.querySelector('input')) return;

    const zone = title.dataset.zone;
    const task = G.batch ? G.batch.zones[zone]?.find(t => t.vid === vid) : null;
    if (!task) return;

    const oldName = task.displayName;
    title.innerHTML = '<input type="text" class="batch-video-name-input text-sm font-semibold" value="' + _escHtml(oldName) + '">';
    const input = title.querySelector('input');
    input.focus();
    input.select();

    const finish = async () => {
        const newName = input.value.trim() || oldName;
        title.textContent = newName;
        title.onclick = () => _startDetailRename(vid);
        if (newName !== oldName && G.batch) {
            task.displayName = newName;
            await api('/api/batch/' + G.batch.bid + '/update-name/' + vid, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: newName }),
            });
            renderAllZones();
        }
    };
    input.addEventListener('blur', finish, { once: true });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur();
        if (e.key === 'Escape') { input.value = oldName; input.blur(); }
    });
}

// ============================================================
//  详情页导出
// ============================================================
async function _batchDetailExport(fmt) {
    if (!G.batch || !_batchDetailVid) return;
    const statusEl = document.getElementById('batchDetailExportStatus');
    statusEl.textContent = '正在导出 ' + fmt.toUpperCase() + '...';
    const res = await api('/api/batch/' + G.batch.bid + '/package/' + _batchDetailVid, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: fmt }),
    });
    if (res.success) {
        statusEl.textContent = fmt.toUpperCase() + ' 导出已开始，完成后可下载';
    } else {
        statusEl.textContent = '导出失败: ' + (res.message || '');
    }
}
