/**
 * VidSlide v0.6.1 - 命名模块
 * ============================
 * 批量添加命名弹窗、模板命名、自动递增
 */

let _batchPendingPaths = [];
let _batchAddSortable = null;
let _namingPreviewActive = false;  // 预览/取消预览切换

const _NAMING_TEMPLATES = {
    'course_lessonN': { label: '课程名_第N节', format: (name, n) => name + '_第' + n + '节' },
    'lessonN_course': { label: '第N讲_课程名', format: (name, n) => '第' + n + '讲_' + name },
    'course_parenN': { label: '课程名(N)', format: (name, n) => name + '(' + n + ')' },
    'course_dashN': { label: '课程名-N', format: (name, n) => name + '-' + String(n).padStart(2, '0') },
};

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
    _namingPreviewActive = false;

    if (autoInc) autoInc.checked = false;
    if (baseInput) { baseInput.disabled = true; baseInput.value = ''; }
    if (btnPreview) btnPreview.disabled = true;

    const courseName = document.getElementById('batchCourseName');
    if (courseName) courseName.value = '';
    const startNum = document.getElementById('batchStartNum');
    if (startNum) startNum.value = '1';

    // 渲染文件列表
    list.innerHTML = '';
    paths.forEach((p, i) => {
        const name = p.split(/[/\\]/).pop().replace(/\.[^.]+$/, '');
        const item = document.createElement('div');
        item.className = 'batch-add-list-item';
        item.innerHTML =
            '<span class="batch-add-drag-handle" title="拖拽调整顺序">⁞</span>' +
            '<img class="batch-add-thumb" data-path="' + _escHtml(p) + '" src="" alt="" style="width:64px;height:36px;object-fit:cover;border-radius:3px;background:#e2e8f0;flex-shrink:0">' +
            '<input type="text" value="' + _escHtml(name) + '" data-path="' + _escHtml(p) + '" data-idx="' + i + '" placeholder="输入显示名称" class="batch-name-field">' +
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
            const fields = list.querySelectorAll('.batch-name-field');
            _batchPendingPaths = Array.from(fields).map(f => f.dataset.path);
        },
    });

    modal.style.display = '';
}

async function confirmBatchAdd() {
    if (!G.batch) return;
    const fields = document.querySelectorAll('#batchAddList .batch-name-field');
    const entries = [];
    fields.forEach(f => {
        entries.push({ path: f.dataset.path, name: f.value.trim() || undefined });
    });
    if (entries.length === 0) return;

    const res = await api('/api/batch/' + G.batch.bid + '/add-videos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries }),
    });
    if (res.success) {
        showToast('已添加 ' + (res.added || entries.length) + ' 个视频到未选中区域', 'success', 2000);
        cancelBatchAdd();
        await _refreshBatchState();
    } else {
        showToast(res.message || '添加失败', 'error');
    }
}

function cancelBatchAdd() {
    const modal = document.getElementById('batchAddModal');
    modal.style.display = 'none';
    _batchPendingPaths = [];
    if (_batchAddSortable) { _batchAddSortable.destroy(); _batchAddSortable = null; }
}

function previewTemplateNames() {
    const mode = document.querySelector('input[name="batchNamingMode"]:checked');
    if (!mode || mode.value !== 'template') return;

    const courseName = document.getElementById('batchCourseName').value.trim();
    if (!courseName) { showToast('请输入课程/主题名称', 'warning'); return; }

    const templateKey = document.getElementById('batchNamingTemplate').value;
    const startNum = parseInt(document.getElementById('batchStartNum').value) || 1;
    const tmpl = _NAMING_TEMPLATES[templateKey];
    if (!tmpl) return;

    const fields = document.querySelectorAll('#batchAddList .batch-name-field');

    if (_namingPreviewActive) {
        // 取消预览：恢复原始名称
        fields.forEach(f => {
            if (f.dataset.originalName) {
                f.value = f.dataset.originalName;
                delete f.dataset.originalName;
            }
        });
        _namingPreviewActive = false;
        const btn = document.getElementById('btnPreviewTemplate');
        if (btn) btn.textContent = '预览命名';
        showToast('已取消预览', 'info', 1500);
    } else {
        // 预览：保存原始名称并应用模板
        fields.forEach((f, i) => {
            f.dataset.originalName = f.value;
            f.value = tmpl.format(courseName, startNum + i);
        });
        _namingPreviewActive = true;
        const btn = document.getElementById('btnPreviewTemplate');
        if (btn) btn.textContent = '取消预览';
        showToast('已预览命名结果', 'success', 2000);
    }
}

function applyTemplateNames() {
    if (!_namingPreviewActive) {
        // 先预览
        _namingPreviewActive = false; // 确保进入预览分支
        previewTemplateNames();
    }
    // 清除 originalName，使预览变为正式
    const fields = document.querySelectorAll('#batchAddList .batch-name-field');
    fields.forEach(f => { delete f.dataset.originalName; });
    _namingPreviewActive = false;
    const btn = document.getElementById('btnPreviewTemplate');
    if (btn) btn.textContent = '预览命名';
    showToast('模板命名已应用', 'success', 2000);
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
    list.querySelectorAll('.batch-name-field').forEach((f, i) => { f.dataset.idx = i; });
    showToast(order === 'asc' ? '已按名称升序排列' : '已按名称降序排列', 'success', 2000);
}

function _onNamingModeChange() {
    const mode = document.querySelector('input[name="batchNamingMode"]:checked');
    if (!mode) return;
    const templateArea = document.getElementById('namingTemplateArea');
    const autoIncArea = document.getElementById('batchAutoIncrementArea');
    if (templateArea) templateArea.style.display = mode.value === 'template' ? '' : 'none';
    if (autoIncArea) autoIncArea.style.display = mode.value === 'free' ? '' : 'none';
}
