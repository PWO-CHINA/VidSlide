/**
 * VidSlide v0.6.0 - 导出模块
 * ============================
 * 单视频导出 + 批量导出 + 打包进度 + 下载
 */

// ============================================================
//  单视频导出
// ============================================================
async function _packageVideo(vid, fmt) {
    if (!G.batch) return;
    const res = await api('/api/batch/' + G.batch.bid + '/package/' + vid, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: fmt }),
    });
    if (res.success) {
        showToast(fmt.toUpperCase() + ' 打包已开始', 'success', 2000);
    } else {
        showToast(res.message || '打包失败', 'error');
    }
}

// ============================================================
//  批量导出（已完成区域多选）
// ============================================================
async function packageBatchAll(fmt) {
    if (!G.batch) return;
    const selectedVids = _getSelectedVids('completed');
    if (selectedVids.length === 0) {
        showToast('请先勾选要导出的视频', 'warning');
        return;
    }
    const res = await api('/api/batch/' + G.batch.bid + '/package-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: fmt, video_ids: selectedVids }),
    });
    if (res.success) {
        const progressEl = document.getElementById('batchExportProgress');
        if (progressEl) progressEl.style.display = '';
        showToast('批量打包已开始 (' + selectedVids.length + ' 个视频)', 'success', 2000);
    } else {
        showToast(res.message || '批量打包失败', 'error');
    }
}

// ============================================================
//  打包事件处理（SSE）
// ============================================================
function _handlePackagingEvent(data) {
    switch (data.type) {
        case 'packaging':
            // 单视频打包进度（可选展示）
            break;
        case 'packaging_done':
            _onPackagingDone(data);
            break;
        case 'packaging_error':
            showToast('打包失败: ' + (data.message || ''), 'error');
            break;
        case 'batch_packaging':
            _onBatchPackagingProgress(data);
            break;
        case 'batch_packaging_done':
            _onBatchPackagingDone(data);
            break;
        case 'batch_packaging_error':
            showToast('批量打包失败: ' + (data.message || ''), 'error');
            break;
    }
}

function _onPackagingDone(data) {
    if (!G.batch) return;
    const vid = data.video_id;
    const filename = data.filename;
    if (filename) {
        const a = document.createElement('a');
        a.href = '/api/batch/' + G.batch.bid + '/video/' + vid + '/download/' + filename;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }
    showToast('打包完成: ' + (filename || ''), 'success', 3000);

    // 更新详情页导出状态
    const statusEl = document.getElementById('batchDetailExportStatus');
    if (statusEl && _batchDetailVid === vid) {
        statusEl.textContent = '导出完成，已开始下载';
    }
}

function _onBatchPackagingProgress(data) {
    const bar = document.getElementById('batchExportProgressBar');
    const msg = document.getElementById('batchExportMessage');
    if (bar) bar.style.width = (data.progress || 0) + '%';
    if (msg) msg.textContent = data.message || '';
}

function _onBatchPackagingDone(data) {
    const bar = document.getElementById('batchExportProgressBar');
    if (bar) bar.style.width = '100%';
    const progressEl = document.getElementById('batchExportProgress');
    if (progressEl) progressEl.style.display = 'none';

    if (data.filename && G.batch) {
        const a = document.createElement('a');
        a.href = '/api/batch/' + G.batch.bid + '/download/' + data.filename;
        a.download = data.filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }
    showToast('批量打包完成', 'success', 3000);
}
