/**
 * VidSlide v0.6.1 - 回收站模块
 * ==============================
 * 视频回收站胶囊、三选项恢复、图片预览（无导出）
 */

// ============================================================
//  回收站面板
// ============================================================
async function openVideoRecycleBin() {
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

    if (!drawer || !list) return;

    countEl.textContent = videos.length > 0 ? '(' + videos.length + ' 个)' : '';

    list.innerHTML = '';
    if (videos.length === 0) {
        list.innerHTML = '<p class="text-center text-gray-400 text-sm py-12">回收站是空的</p>';
    } else {
        videos.forEach(v => {
            const isHalfProcessed = v.trash_reason !== 'done';
            const isDone = v.trash_reason === 'done';
            const item = document.createElement('div');
            item.className = 'recycle-item flex-col gap-2';

            // 视频信息行
            let infoHtml =
                '<div class="flex items-center gap-3 w-full">' +
                    '<div class="flex-1 min-w-0">' +
                        '<p class="text-sm font-medium text-gray-700 dark:text-gray-300 truncate">' + _escHtml(v.display_name || v.id) + '</p>' +
                        '<p class="text-xs text-gray-400">' +
                            (isDone ? '已完成' : '半处理') +
                            (v.saved_count > 0 ? ' · ' + v.saved_count + ' 张图片' : '') +
                        '</p>' +
                    '</div>';

            // 查看图片按钮（只读预览，无导出）
            if (v.saved_count > 0) {
                infoHtml += '<button class="btn-ghost text-xs recycle-preview-btn" data-vid="' + v.id + '">查看图片</button>';
            }
            infoHtml += '</div>';

            // 三选项操作按钮
            let actionsHtml = '<div class="flex gap-2 w-full flex-wrap">';
            if (isHalfProcessed) {
                actionsHtml +=
                    '<button class="recycle-action-btn" data-vid="' + v.id + '" data-action="to_unselected" title="删除提取结果，重新加入未选中区域">' +
                        '<i data-lucide="rotate-ccw" class="w-3 h-3 inline-block"></i> 重置到未选中' +
                    '</button>' +
                    '<button class="recycle-action-btn" data-vid="' + v.id + '" data-action="resume_to_queue" title="从断点继续处理，加入队列末尾">' +
                        '<i data-lucide="play" class="w-3 h-3 inline-block"></i> 断点续传' +
                    '</button>' +
                    '<button class="recycle-action-btn danger" data-vid="' + v.id + '" data-action="permanent_delete" title="永久删除所有数据">' +
                        '<i data-lucide="x" class="w-3 h-3 inline-block"></i> 永久删除' +
                    '</button>';
            } else {
                actionsHtml +=
                    '<button class="recycle-action-btn" data-vid="' + v.id + '" data-action="to_unselected" title="删除提取结果，重新加入未选中区域">' +
                        '<i data-lucide="rotate-ccw" class="w-3 h-3 inline-block"></i> 重置到未选中' +
                    '</button>' +
                    '<button class="recycle-action-btn" data-vid="' + v.id + '" data-action="to_completed" title="保留提取结果，直接恢复到已完成区域">' +
                        '<i data-lucide="check-circle-2" class="w-3 h-3 inline-block text-emerald-500"></i> 恢复到已完成' +
                    '</button>' +
                    '<button class="recycle-action-btn danger" data-vid="' + v.id + '" data-action="permanent_delete" title="永久删除所有数据">' +
                        '<i data-lucide="x" class="w-3 h-3 inline-block"></i> 永久删除' +
                    '</button>';
            }
            actionsHtml += '</div>';

            item.innerHTML = infoHtml + actionsHtml;

            // 绑定操作按钮事件
            item.querySelectorAll('.recycle-action-btn').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const vid = btn.dataset.vid;
                    const action = btn.dataset.action;
                    await _restoreFromTrash(vid, action);
                });
            });

            // 绑定查看图片按钮
            const previewBtn = item.querySelector('.recycle-preview-btn');
            if (previewBtn) {
                previewBtn.addEventListener('click', () => {
                    _previewTrashedVideoImages(v.id, v.display_name);
                });
            }

            list.appendChild(item);
        });
    }

    refreshIcons(list);
    drawer.classList.add('open');
    backdrop.classList.add('open');
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', _recycleBinEscHandler);
}

function _recycleBinEscHandler(e) {
    if (e.key === 'Escape') {
        closeVideoRecycleBin();
    }
}

function closeVideoRecycleBin() {
    const drawer = document.getElementById('batchVideoRecycleDrawer');
    const backdrop = document.getElementById('batchVideoRecycleBackdrop');
    if (drawer) drawer.classList.remove('open');
    if (backdrop) backdrop.classList.remove('open');
    document.body.style.overflow = '';
    document.removeEventListener('keydown', _recycleBinEscHandler);
}

async function _restoreFromTrash(vid, action) {
    if (!G.batch) return;

    if (action === 'permanent_delete') {
        if (!confirm('确定永久删除？此操作不可撤销。')) return;
    }

    const res = await api('/api/batch/' + G.batch.bid + '/restore-video/' + vid, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
    });

    if (res.success) {
        const labels = {
            to_unselected: '已重置到未选中区域',
            resume_to_queue: '已加入队列末尾（断点续传）',
            to_completed: '已恢复到已完成区域',
            permanent_delete: '已永久删除',
        };
        showToast(labels[action] || '操作成功', 'success', 2000);
        await _refreshBatchState();
        openVideoRecycleBin(); // 刷新列表
    } else {
        showToast(res.message || '操作失败', 'error');
    }
}

// ============================================================
//  回收站内图片只读预览
// ============================================================
async function _previewTrashedVideoImages(vid, displayName) {
    if (!G.batch) return;
    let images = [];
    try {
        const res = await api('/api/batch/' + G.batch.bid + '/video/' + vid + '/images');
        if (res.success) images = res.images || [];
    } catch { }

    if (images.length === 0) {
        showToast('该视频没有可预览的图片', 'info');
        return;
    }

    // 使用详情弹窗但隐藏导出和删除功能
    const modal = document.getElementById('batchDetailModal');
    const title = document.getElementById('batchDetailTitle');
    const count = document.getElementById('batchDetailCount');
    const grid = document.getElementById('batchDetailGrid');
    const exportBar = document.getElementById('batchDetailExportBar');
    const recycleBtn = document.getElementById('batchDetailRecycleBtn');
    const info = document.getElementById('batchDetailInfo');

    title.textContent = displayName + ' (回收站)';
    title.onclick = null;
    title.style.cursor = 'default';
    title.title = '';
    count.textContent = images.length + ' 张图片';
    if (exportBar) exportBar.style.display = 'none';
    if (recycleBtn) recycleBtn.style.display = 'none';
    if (info) info.textContent = '只读预览 · 不支持编辑和导出';

    const recyclePanel = document.getElementById('batchDetailRecyclePanel');
    if (recyclePanel) recyclePanel.style.display = 'none';

    // 渲染只读画廊
    grid.innerHTML = '';
    const bid = G.batch.bid;
    const frag = document.createDocumentFragment();
    images.forEach((img, idx) => {
        const url = '/api/batch/' + bid + '/video/' + vid + '/image/' + img;
        const div = document.createElement('div');
        div.className = 'batch-detail-thumb-wrap';
        div.innerHTML =
            '<img src="' + url + '" alt="' + _escHtml(img) + '" class="batch-detail-thumb" loading="lazy">' +
            '<div class="batch-detail-thumb-overlay">' +
                '<span class="bg-black/60 text-white text-xs px-2 py-0.5 rounded-full font-bold backdrop-blur">' + (idx + 1) + '</span>' +
            '</div>';
        // 点击放大（只读）
        div.querySelector('img').addEventListener('click', () => {
            _openReadOnlyPreview(bid, vid, images, idx);
        });
        frag.appendChild(div);
    });
    grid.appendChild(frag);

    modal.classList.remove('hidden');
    document.addEventListener('keydown', _recyclePreviewKeyHandler);
}

let _recyclePreviewImages = [];
let _recyclePreviewIdx = -1;
let _recyclePreviewBid = '';
let _recyclePreviewVid = '';

function _openReadOnlyPreview(bid, vid, images, idx) {
    _recyclePreviewBid = bid;
    _recyclePreviewVid = vid;
    _recyclePreviewImages = images;
    _recyclePreviewIdx = idx;

    const img = images[idx];
    const url = '/api/batch/' + bid + '/video/' + vid + '/image/' + img;
    const modal = document.getElementById('previewModal');
    const previewImg = document.getElementById('previewImage');
    const counter = document.getElementById('previewCounter');
    previewImg.src = url;
    counter.textContent = (idx + 1) + ' / ' + images.length;
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    document.body.style.overflow = 'hidden';

    const btnPrev = document.getElementById('btnPrevPreview');
    const btnNext = document.getElementById('btnNextPreview');
    const btnDel = document.getElementById('btnDeletePreview');
    btnPrev.style.visibility = idx > 0 ? '' : 'hidden';
    btnNext.style.visibility = idx < images.length - 1 ? '' : 'hidden';
    btnPrev.onclick = () => _navReadOnlyPreview(-1);
    btnNext.onclick = () => _navReadOnlyPreview(1);
    if (btnDel) btnDel.style.display = 'none'; // 隐藏删除按钮
}

function _navReadOnlyPreview(dir) {
    const newIdx = _recyclePreviewIdx + dir;
    if (newIdx < 0 || newIdx >= _recyclePreviewImages.length) return;
    _openReadOnlyPreview(_recyclePreviewBid, _recyclePreviewVid, _recyclePreviewImages, newIdx);
}

function _closeReadOnlyPreview() {
    _recyclePreviewIdx = -1;
    _recyclePreviewImages = [];
    const modal = document.getElementById('previewModal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    document.body.style.overflow = '';
    const btnDel = document.getElementById('btnDeletePreview');
    if (btnDel) btnDel.style.display = ''; // 恢复删除按钮
}

function _recyclePreviewKeyHandler(e) {
    if (e.key === 'Escape') {
        if (_recyclePreviewIdx >= 0) {
            _closeReadOnlyPreview();
        } else {
            closeBatchDetail();
            document.removeEventListener('keydown', _recyclePreviewKeyHandler);
        }
        return;
    }
    if (_recyclePreviewIdx >= 0) {
        if (e.key === 'ArrowLeft') _navReadOnlyPreview(-1);
        if (e.key === 'ArrowRight') _navReadOnlyPreview(1);
    }
}
