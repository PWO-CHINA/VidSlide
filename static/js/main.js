/**
 * 影幻智提 (VidSlide) v0.6.0 - 前端主逻辑
 * ==========================================
 * 通信方式：SSE（Server-Sent Events）服务器推送
 * 打包导出：异步后台处理 + SSE 进度推送
 * 画廊渲染：DocumentFragment 批量插入
 */

// ============================================================
//  Lucide 图标刷新工具（动态 innerHTML 后需调用）
// ============================================================
function refreshIcons(container) {
    if (typeof lucide !== 'undefined') {
        lucide.createIcons({ nodes: container ? container.querySelectorAll('[data-lucide]') : undefined });
    }
}

// ============================================================
//  跨浏览器标签页通信（BroadcastChannel）
// ============================================================
const _bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('vidslide') : null;
if (_bc) {
    _bc.onmessage = (e) => {
        if (e.data?.type === 'shutdown') {
            // 其他标签页发起了关闭服务
            G._serverShutdown = true;
            for (const sid of Object.keys(G.tabs)) {
                G.tabs[sid].disconnectSSE();
            }
            _showShutdownPage();
        }
        if (e.data?.type === 'tab_active') {
            // 另一个标签页刚打开，通知它我们已经存在
            _bc.postMessage({ type: 'tab_exists' });
        }
        if (e.data?.type === 'tab_exists') {
            _otherTabExists = true;
        }
    };
}
let _otherTabExists = false;

// ============================================================
//  深色模式切换
// ============================================================
function toggleTheme() {
    const html = document.documentElement;
    const isDark = html.classList.toggle('dark');
    localStorage.setItem('vidslide_theme', isDark ? 'dark' : 'light');
    updateThemeIcon();
}
function updateThemeIcon() {
    const icon = document.getElementById('themeIcon');
    if (!icon) return;
    const isDark = document.documentElement.classList.contains('dark');
    icon.innerHTML = isDark ? '<i data-lucide="sun" class="w-4 h-4"></i>' : '<i data-lucide="moon" class="w-4 h-4"></i>';
    refreshIcons(icon);
}
window.toggleTheme = toggleTheme;
// 初始化图标
document.addEventListener('DOMContentLoaded', updateThemeIcon);

// ============================================================
//  Sticky Header 滚动效果
// ============================================================
let lastScrollY = 0;
const header = document.querySelector('.sticky-header');
window.addEventListener('scroll', () => {
    const currentScrollY = window.scrollY;
    if (currentScrollY > 10) {
        header?.classList.add('scrolled');
    } else {
        header?.classList.remove('scrolled');
    }
    lastScrollY = currentScrollY;
}, { passive: true });

// ============================================================
//  配置记忆（localStorage）
// ============================================================
const _PREF_KEY = 'vidslide_prefs';
function _loadPrefs() {
    try { return JSON.parse(localStorage.getItem(_PREF_KEY)) || {}; } catch { return {}; }
}
function _savePrefs(patch) {
    const p = { ..._loadPrefs(), ...patch };
    try { localStorage.setItem(_PREF_KEY, JSON.stringify(p)); } catch { }
}
function _applyPrefsToPane(pane) {
    const p = _loadPrefs();
    if (p.threshold != null) {
        pane.querySelector('.js-threshold').value = p.threshold;
        pane.querySelector('.js-threshold-val').textContent = p.threshold;
    }
    if (p.fast_mode != null) pane.querySelector('.js-fast-mode').checked = p.fast_mode;
    if (p.use_roi != null) pane.querySelector('.js-use-roi').checked = p.use_roi;
    if (p.use_gpu != null) pane.querySelector('.js-use-gpu').checked = p.use_gpu;
    if (p.enable_history != null) {
        pane.querySelector('.js-enable-history').checked = p.enable_history;
        pane.querySelector('.js-max-history-group').style.display = p.enable_history ? 'flex' : 'none';
    }
    if (p.max_history != null) pane.querySelector('.js-max-history').value = p.max_history;
    if (p.speed_mode) pane.querySelector('.js-speed-mode').value = p.speed_mode;
}
const _PREF_DEFAULTS = {
    threshold: 5,
    fast_mode: true,
    use_roi: true,
    use_gpu: true,
    enable_history: true,
    max_history: 5,
    speed_mode: 'fast',
};
function _resetPrefs(pane) {
    try { localStorage.removeItem(_PREF_KEY); } catch { }
    try {
        // 将默认值写回 DOM
        pane.querySelector('.js-threshold').value = _PREF_DEFAULTS.threshold;
        pane.querySelector('.js-threshold-val').textContent = _PREF_DEFAULTS.threshold;
        pane.querySelector('.js-fast-mode').checked = _PREF_DEFAULTS.fast_mode;
        pane.querySelector('.js-use-roi').checked = _PREF_DEFAULTS.use_roi;
        pane.querySelector('.js-use-gpu').checked = _PREF_DEFAULTS.use_gpu;
        pane.querySelector('.js-enable-history').checked = _PREF_DEFAULTS.enable_history;
        pane.querySelector('.js-max-history-group').style.display = 'flex';
        pane.querySelector('.js-max-history').value = _PREF_DEFAULTS.max_history;
        pane.querySelector('.js-speed-mode').value = _PREF_DEFAULTS.speed_mode;
        showToast('已重置为默认参数', 'success', 2000);
    } catch (e) {
        console.error('[重置参数] 失败:', e);
        showToast('重置失败，请刷新页面重试', 'error');
    }
}
function _watchPrefs(pane) {
    const save = () => _savePrefs({
        threshold: parseFloat(pane.querySelector('.js-threshold').value),
        fast_mode: pane.querySelector('.js-fast-mode').checked,
        use_roi: pane.querySelector('.js-use-roi').checked,
        use_gpu: pane.querySelector('.js-use-gpu').checked,
        enable_history: pane.querySelector('.js-enable-history').checked,
        max_history: parseInt(pane.querySelector('.js-max-history').value),
        speed_mode: pane.querySelector('.js-speed-mode').value,
    });
    pane.querySelector('.js-threshold').addEventListener('change', save);
    pane.querySelector('.js-fast-mode').addEventListener('change', save);
    pane.querySelector('.js-use-roi').addEventListener('change', save);
    pane.querySelector('.js-use-gpu').addEventListener('change', save);
    pane.querySelector('.js-enable-history').addEventListener('change', save);
    pane.querySelector('.js-max-history').addEventListener('change', save);
    pane.querySelector('.js-speed-mode').addEventListener('change', save);
}

// ============================================================
//  全局应用状态
// ============================================================
const G = {
    tabs: {},          // sid -> TabState
    activeTabId: null,
    maxSessions: 3,
    previewTabId: null,
    previewIndex: -1,
    // 批量模式
    batchMode: false,
    batch: null,       // BatchState | null
};

// 每个标签页的独立状态
class TabState {
    constructor(sid) {
        this.sid = sid;
        this.videoPath = '';
        this.images = [];
        this.deletedStack = [];
        this.isExtracting = false;
        this.isPackaging = false;
        this.eventSource = null;   // SSE 连接
        this.sortable = null;
        this.hasWork = false;
        this.downloadLinks = [];
        this.sseErrorCount = 0; // 用于防御 SSE 死循环
    }

    /** 建立 SSE 连接 */
    connectSSE() {
        if (this.eventSource) {
            this.eventSource.close();
        }
        this.sseErrorCount = 0;
        this.eventSource = new EventSource(`/api/session/${this.sid}/events`);
        this.eventSource.onmessage = (e) => {
            this.sseErrorCount = 0; // 成功收到消息，重置计数
            try {
                const data = JSON.parse(e.data);
                handleSSEEvent(this.sid, data);
            } catch (err) {
                console.warn('[SSE] 解析错误:', err);
            }
        };
        this.eventSource.onerror = () => {
            this.sseErrorCount++;
            console.warn(`[SSE] 会话 ${this.sid} 连接中断，将尝试重连 (${this.sseErrorCount}/3)…`);
            if (this.sseErrorCount >= 3) {
                console.error(`[SSE] 会话 ${this.sid} 重连彻底失败，主动放弃连接。`);
                this.disconnectSSE();
            }
        };
    }

    /** 断开 SSE 连接 */
    disconnectSSE() {
        if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
        }
    }
}

// ============================================================
//  SSE 事件处理
// ============================================================
function handleSSEEvent(sid, data) {
    switch (data.type) {
        case 'init':
            handleInitEvent(sid, data.state);
            break;
        case 'extraction':
            handleExtractionEvent(sid, data);
            break;
        case 'packaging':
            handlePackagingEvent(sid, data);
            break;
        case 'close':
            // 后台主动要求断开连接（如会话已被关闭），避免重连导致无限 404
            console.log(`[SSE] 后端主动请求关闭 ${sid} 的连接。`);
            if (G.tabs[sid]) G.tabs[sid].disconnectSSE();
            break;
    }
}

function handleInitEvent(sid, state) {
    if (!state) return;
    const ts = G.tabs[sid];
    if (!ts) return;

    // 恢复提取进行中的状态（例如 SSE 重连后）
    if (state.status === 'running' && !ts.isExtracting) {
        ts.isExtracting = true;
        q(sid, 'js-btn-extract').classList.add('hidden');
        q(sid, 'js-btn-cancel').classList.remove('hidden');
        q(sid, 'js-progress-section').classList.remove('hidden');
        updateTabStatus(sid, 'running');
    }
    // 恢复打包进行中的状态
    if (state.pkg_status === 'running' && !ts.isPackaging) {
        ts.isPackaging = true;
        setExportButtonsState(sid, true, '打包中…');
        showPackagingProgress(sid, state.pkg_progress || 0, state.pkg_message || '打包中…');
    }
}

function handleExtractionEvent(sid, data) {
    const ts = G.tabs[sid];
    if (!ts) return;

    if (data.status === 'running') {
        // 更新进度 UI
        if (data.progress != null) {
            q(sid, 'js-progress-bar').style.width = data.progress + '%';
            q(sid, 'js-progress-pct').textContent = data.progress + '%';
        }
        if (data.message) {
            q(sid, 'js-progress-message').textContent = data.message;
        }

        if (data.eta_seconds != null && data.eta_seconds >= 0) {
            const eta = Math.round(data.eta_seconds);
            const elapsed = Math.round(data.elapsed_seconds || 0);
            const etaStr = eta >= 60 ? Math.floor(eta / 60) + '分' + (eta % 60) + '秒' : eta + '秒';
            const elapsedStr = elapsed >= 60 ? Math.floor(elapsed / 60) + '分' + (elapsed % 60) + '秒' : elapsed + '秒';
            q(sid, 'js-progress-hint').textContent = '已用 ' + elapsedStr + '，预计还剩 ' + etaStr;
        } else {
            q(sid, 'js-progress-hint').textContent = '正在估算剩余时间…';
        }
    } else {
        // done / cancelled / error
        ts.isExtracting = false;
        q(sid, 'js-btn-extract').classList.remove('hidden');
        q(sid, 'js-btn-cancel').classList.add('hidden');
        q(sid, 'js-btn-resume').classList.add('hidden');
        q(sid, 'js-progress-bar').style.width = '100%';
        q(sid, 'js-progress-pct').textContent = '100%';
        updateTabStatus(sid, data.status);

        if (data.status === 'done') {
            q(sid, 'js-progress-message').textContent = data.message;
            showToast(data.message, 'success', 5000);
            loadImages(sid);
        } else if (data.status === 'cancelled') {
            q(sid, 'js-progress-message').textContent = data.message;
            showToast(data.message, 'warning');
            loadImages(sid);
            // 有已提取的图片时显示「继续提取」按钮
            if (data.saved_count > 0) {
                q(sid, 'js-btn-resume').classList.remove('hidden');
            }
        } else {
            q(sid, 'js-progress-message').textContent = data.message;
            showErrorModal('提取出错', data.message,
                '如果问题持续出现，请点击下方按钮提交 Issue，开发者会尽快修复。');
        }
    }
}

function handlePackagingEvent(sid, data) {
    const ts = G.tabs[sid];
    if (!ts) return;

    const fmtNames = { pdf: 'PDF', pptx: 'PPTX', zip: 'ZIP' };

    if (data.status === 'running') {
        ts.isPackaging = true;
        showPackagingProgress(sid, data.progress || 0, data.message || '打包中…');
    } else if (data.status === 'done') {
        ts.isPackaging = false;
        hidePackagingProgress(sid);
        setExportButtonsState(sid, false);
        const fmt = data.format || 'pdf';
        showToast(`${fmtNames[fmt] || fmt.toUpperCase()} 打包完成！`, 'success');
        addDownloadLink(sid, data.filename, fmt);
    } else if (data.status === 'error') {
        ts.isPackaging = false;
        hidePackagingProgress(sid);
        setExportButtonsState(sid, false);
        if (data.hint) {
            showErrorModal(data.message || '打包失败', data.hint, null);
        } else {
            showToast(data.message || '打包失败', 'error');
        }
    }
}

// ============================================================
//  打包进度 UI 辅助函数
// ============================================================
function showPackagingProgress(sid, pct, msg) {
    const sec = q(sid, 'js-pkg-progress-section');
    if (!sec) return;
    sec.classList.remove('hidden');
    const bar = q(sid, 'js-pkg-progress-bar');
    const msgEl = q(sid, 'js-pkg-progress-message');
    const pctEl = q(sid, 'js-pkg-progress-pct');
    if (bar) bar.style.width = pct + '%';
    if (msgEl) msgEl.textContent = msg;
    if (pctEl) pctEl.textContent = pct + '%';
}

function hidePackagingProgress(sid) {
    const sec = q(sid, 'js-pkg-progress-section');
    if (sec) sec.classList.add('hidden');
}

function setExportButtonsState(sid, disabled, text) {
    const btns = [q(sid, 'js-btn-pdf'), q(sid, 'js-btn-pptx'), q(sid, 'js-btn-zip')];
    btns.forEach(btn => {
        if (!btn) return;
        if (disabled) {
            btn.disabled = true;
            btn.style.opacity = '0.5';
            btn.style.pointerEvents = 'none';
        } else {
            btn.disabled = false;
            btn.style.opacity = '';
            btn.style.pointerEvents = '';
        }
    });
}

// ============================================================
//  API 工具
// ============================================================
async function api(path, opts = {}) {
    try {
        const timeout = path.includes('select-video') ? 180000 : 60000;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        opts.signal = controller.signal;
        const resp = await fetch(path, opts);
        clearTimeout(timer);
        if (!resp.ok) {
            const text = await resp.text();
            let parsed = {};
            try { parsed = JSON.parse(text); } catch { parsed = { message: text }; }
            const msg = parsed.message || resp.statusText;
            if (parsed.hint) {
                showErrorModal('请求失败', msg, parsed.hint);
            } else {
                showToast('服务器错误: ' + msg, 'error');
            }
            return { success: false, message: msg, hint: parsed.hint };
        }
        const data = await resp.json();
        if (!data.success && data.hint) {
            showErrorModal(data.message, data.hint, null);
        }
        return data;
    } catch (e) {
        if (e.name === 'AbortError') {
            showToast('请求超时，请重试', 'error');
            return { success: false, message: '请求超时' };
        }
        // 后端已断开时不再弹 toast（断连遮罩已显示）
        if (!_serverAlive) {
            return { success: false, message: '后端服务未连接' };
        }
        showToast('无法连接到后端服务', 'error');
        if (e instanceof TypeError && e.message.includes('fetch')) {
            sendHeartbeat();
        }
        console.error('[API Error]', path, e);
        return { success: false, message: e.message };
    }
}

// ============================================================
//  Toast 通知
// ============================================================
function showToast(msg, type = 'info', duration = 3500) {
    const colors = { info: 'bg-blue-500', success: 'bg-emerald-500', error: 'bg-red-500', warning: 'bg-amber-500' };
    const icons = { info: '<i data-lucide="info" class="w-4 h-4"></i>', success: '<i data-lucide="check-circle-2" class="w-4 h-4"></i>', error: '<i data-lucide="x-circle" class="w-4 h-4"></i>', warning: '<i data-lucide="alert-triangle" class="w-4 h-4"></i>' };
    const el = document.createElement('div');
    el.className = `${colors[type] || colors.info} text-white px-5 py-3 rounded-lg shadow-lg text-sm font-medium pointer-events-auto flex items-center gap-2 toast-enter backdrop-blur-sm`;
    el.style.background = type === 'info' ? 'rgba(59,130,246,.9)' : type === 'success' ? 'rgba(16,185,129,.9)' : type === 'error' ? 'rgba(239,68,68,.9)' : 'rgba(245,158,11,.9)';
    el.innerHTML = `<span>${icons[type] || ''}</span><span>${msg}</span>`;
    document.getElementById('toasts').appendChild(el);
    refreshIcons(el);
    setTimeout(() => {
        el.classList.remove('toast-enter');
        el.classList.add('toast-leave');
        setTimeout(() => el.remove(), 300);
    }, duration);
}

// ============================================================
//  错误详情弹窗（含 Issue 提交）
// ============================================================
function showErrorModal(title, message, hint) {
    document.getElementById('errorModalTitle').textContent = title || '出错了';
    document.getElementById('errorModalMessage').textContent = message || '未知错误';
    const hintBox = document.getElementById('errorModalHint');
    if (hint) {
        document.getElementById('errorModalHintText').textContent = hint;
        hintBox.classList.remove('hidden');
    } else {
        hintBox.classList.add('hidden');
    }
    const issueTitle = encodeURIComponent(`[Bug] ${title || '错误报告'}`);
    const issueBody = encodeURIComponent(
        `## 错误描述\n${message}\n\n` +
        (hint ? `## 建议\n${hint}\n\n` : '') +
        `## 环境信息\n- 浏览器: ${navigator.userAgent}\n- 时间: ${new Date().toLocaleString()}\n` +
        `\n## 复现步骤\n1. \n2. \n3. \n`
    );
    document.getElementById('errorModalIssueLink').href =
        `https://github.com/PWO-CHINA/VidSlide/issues/new?title=${issueTitle}&body=${issueBody}`;
    document.getElementById('errorModal').classList.add('visible');
}
function closeErrorModal() {
    document.getElementById('errorModal').classList.remove('visible');
}
// 暴露到全局以便 HTML onclick 调用
window.closeErrorModal = closeErrorModal;

// ============================================================
//  标签页管理
// ============================================================
function getTabEl(sid) {
    return document.querySelector(`.tab-item[data-sid="${sid}"]`);
}
function getPane(sid) {
    return document.querySelector(`.tab-pane[data-sid="${sid}"]`);
}
function q(sid, cls) {
    const pane = getPane(sid);
    return pane ? pane.querySelector('.' + cls) : null;
}

async function addNewTab() {
    const count = Object.keys(G.tabs).length;
    if (count >= G.maxSessions) {
        showToast(`最多只能开 ${G.maxSessions} 个标签页`, 'warning');
        return;
    }

    const data = await api('/api/session/create', { method: 'POST' });
    if (!data.success) {
        showToast(data.message, 'error');
        return;
    }

    const sid = data.session_id;
    const ts = new TabState(sid);
    G.tabs[sid] = ts;
    createTabUI(sid, '新任务');
    switchTab(sid);
    updateTabAddBtn();

    // 建立 SSE 连接
    ts.connectSSE();

    showToast('已新建标签页', 'success', 2000);
}
// 暴露到全局
window.addNewTab = addNewTab;

/**
 * 恢复后端已存在的会话到前端（用于浏览器标签页关闭后重新打开的场景）
 * @param {Object} sessInfo - 后端返回的会话摘要信息
 */
function adoptExistingSession(sessInfo) {
    const sid = sessInfo.id;
    if (G.tabs[sid]) return; // 已经在前端了

    const ts = new TabState(sid);
    ts.videoPath = sessInfo.video_path || '';
    ts.hasWork = sessInfo.saved_count > 0;
    ts.isExtracting = sessInfo.status === 'running';
    ts.isPackaging = sessInfo.pkg_status === 'running';
    G.tabs[sid] = ts;

    // 确定标签页标题
    let title = '恢复的任务';
    if (sessInfo.video_name) {
        title = sessInfo.video_name;
    } else if (sessInfo.video_path) {
        title = sessInfo.video_path.split(/[\\/]/).pop() || '恢复的任务';
    }
    createTabUI(sid, title);

    // 恢复 UI 状态
    if (ts.videoPath) {
        q(sid, 'js-video-path-input').value = ts.videoPath;
        q(sid, 'js-video-path-display').textContent = ts.videoPath;
        q(sid, 'js-video-info').classList.remove('hidden');
        q(sid, 'js-btn-extract').disabled = false;
    }
    if (ts.isExtracting) {
        q(sid, 'js-btn-extract').classList.add('hidden');
        q(sid, 'js-btn-cancel').classList.remove('hidden');
        q(sid, 'js-progress-section').classList.remove('hidden');
        if (sessInfo.progress != null) {
            q(sid, 'js-progress-bar').style.width = sessInfo.progress + '%';
            q(sid, 'js-progress-pct').textContent = sessInfo.progress + '%';
        }
        if (sessInfo.message) {
            q(sid, 'js-progress-message').textContent = sessInfo.message;
        }
        updateTabStatus(sid, 'running');
    } else if (sessInfo.status === 'interrupted') {
        // 中断状态：加载已有图片，显示「继续提取」按钮
        updateTabStatus(sid, 'interrupted');
        loadImages(sid);
        q(sid, 'js-btn-resume').classList.remove('hidden');
        q(sid, 'js-progress-section').classList.remove('hidden');
        const pct = sessInfo.progress || 0;
        q(sid, 'js-progress-bar').style.width = pct + '%';
        q(sid, 'js-progress-pct').textContent = pct + '%';
        q(sid, 'js-progress-message').textContent = sessInfo.message || '提取被中断，可继续';
        q(sid, 'js-progress-hint').textContent = `已提取 ${sessInfo.saved_count} 张，进度 ${pct}%`;
    } else if (sessInfo.status === 'cancelled' && sessInfo.saved_count > 0) {
        // 取消状态且有图片：加载画廊 + 显示续传按钮
        updateTabStatus(sid, 'cancelled');
        loadImages(sid);
        q(sid, 'js-btn-resume').classList.remove('hidden');
        q(sid, 'js-progress-section').classList.remove('hidden');
        const pct = sessInfo.progress || 0;
        q(sid, 'js-progress-bar').style.width = pct + '%';
        q(sid, 'js-progress-pct').textContent = pct + '%';
        q(sid, 'js-progress-message').textContent = sessInfo.message || '提取已取消，可继续';
        q(sid, 'js-progress-hint').textContent = `已提取 ${sessInfo.saved_count} 张，进度 ${pct}%`;
    } else if (sessInfo.status === 'done' && sessInfo.saved_count > 0) {
        updateTabStatus(sid, 'done');
        // 加载已提取的图片
        loadImages(sid);
    }

    // 建立 SSE 连接（SSE init 事件会自动恢复剩余状态）
    ts.connectSSE();

    console.log(`[初始化] 恢复会话: ${sid} (状态: ${sessInfo.status}, 图片: ${sessInfo.saved_count})`);
}

function createTabUI(sid, title) {
    const tab = document.createElement('div');
    tab.className = 'tab-item';
    tab.dataset.sid = sid;
    tab.innerHTML = `
        <span class="tab-status idle"></span>
        <span class="tab-title" title="${title}">${title}</span>
        <span class="tab-close" onclick="event.stopPropagation();closeTab('${sid}')" title="关闭此标签页"><i data-lucide="x" class="w-3 h-3"></i></span>
    `;
    tab.addEventListener('click', () => switchTab(sid));
    document.getElementById('tabAddBtn').before(tab);
    refreshIcons(tab);

    const template = document.getElementById('tabPaneTemplate');
    const pane = template.content.cloneNode(true).firstElementChild;
    pane.dataset.sid = sid;
    bindPaneEvents(sid, pane);
    document.getElementById('tabContentArea').appendChild(pane);
    refreshIcons(pane);

    const hint = document.getElementById('emptyHint');
    if (hint) hint.style.display = 'none';
}

function bindPaneEvents(sid, pane) {
    pane.querySelector('.js-btn-select-video').addEventListener('click', () => selectVideo(sid));
    pane.querySelector('.js-btn-confirm-path').addEventListener('click', () => confirmManualPath(sid));
    const pathInput = pane.querySelector('.js-video-path-input');
    pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmManualPath(sid); });
    pathInput.addEventListener('paste', () => setTimeout(() => autoConfirmPath(sid), 100));
    const thSlider = pane.querySelector('.js-threshold');
    thSlider.addEventListener('input', () => {
        pane.querySelector('.js-threshold-val').textContent = thSlider.value;
    });
    const histCb = pane.querySelector('.js-enable-history');
    histCb.addEventListener('change', () => {
        pane.querySelector('.js-max-history-group').style.display = histCb.checked ? 'flex' : 'none';
    });
    pane.querySelector('.js-btn-extract').addEventListener('click', () => startExtraction(sid));
    pane.querySelector('.js-btn-resume').addEventListener('click', () => resumeExtraction(sid));
    pane.querySelector('.js-btn-cancel').addEventListener('click', () => cancelExtraction(sid));
    pane.querySelector('.js-btn-pdf').addEventListener('click', () => packageImages(sid, 'pdf'));
    pane.querySelector('.js-btn-pptx').addEventListener('click', () => packageImages(sid, 'pptx'));
    pane.querySelector('.js-btn-zip').addEventListener('click', () => packageImages(sid, 'zip'));
    pane.querySelector('.js-btn-recycle-bin').addEventListener('click', () => openRecycleBin(sid));
    // ── 恢复上次的参数配置 & 监听变更自动保存 ──
    _applyPrefsToPane(pane);
    _watchPrefs(pane);

    // ── 动态创建重置按钮（避免 <template> 克隆丢失事件/样式）──
    const paramSection = pane.querySelectorAll('section.card')[1]; // 第2个 section = 参数设置
    if (paramSection) {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'margin-top:1rem;padding-top:1rem;border-top:1px solid #f3f4f6;display:flex;justify-content:flex-end';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn-reset';
        btn.title = '将所有参数恢复为默认值并清除记忆';
        btn.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:8px;font-weight:500;font-size:12px;color:#64748b;background:#f1f5f9;border:1px solid #e2e8f0;box-shadow:0 1px 2px rgba(0,0,0,.04);cursor:pointer;transition:all .15s;font-family:inherit';
        btn.innerHTML = '<i data-lucide="rotate-ccw" class="w-3.5 h-3.5"></i> 重置为默认参数';
        refreshIcons(btn);
        btn.addEventListener('mouseenter', () => { btn.style.color = '#dc2626'; btn.style.background = '#fef2f2'; btn.style.borderColor = '#fca5a5'; });
        btn.addEventListener('mouseleave', () => { btn.style.color = '#64748b'; btn.style.background = '#f1f5f9'; btn.style.borderColor = '#e2e8f0'; });
        btn.addEventListener('click', () => _resetPrefs(pane));
        wrap.appendChild(btn);
        paramSection.appendChild(wrap);
    }
}

function switchTab(sid) {
    document.querySelectorAll('.tab-item').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    const tab = getTabEl(sid);
    const pane = getPane(sid);
    if (tab) tab.classList.add('active');
    if (pane) pane.classList.add('active');
    G.activeTabId = sid;
}

async function closeTab(sid) {
    const ts = G.tabs[sid];
    if (!ts) return;
    if (ts.images.length > 0 && ts.downloadLinks.length === 0) {
        if (!confirm('该标签页有未导出的图片，确定关闭？')) return;
    }
    if (ts.isExtracting) {
        await api(`/api/session/${sid}/cancel`, { method: 'POST' });
    }
    // 断开 SSE 连接
    ts.disconnectSSE();
    await api(`/api/session/${sid}/close`, { method: 'POST' });
    const tab = getTabEl(sid);
    const pane = getPane(sid);
    if (tab) tab.remove();
    if (pane) pane.remove();
    delete G.tabs[sid];
    const remaining = Object.keys(G.tabs);
    if (remaining.length > 0) {
        switchTab(remaining[remaining.length - 1]);
    } else {
        G.activeTabId = null;
        const hint = document.getElementById('emptyHint');
        if (hint) hint.style.display = '';
    }
    updateTabAddBtn();
    showToast('标签页已关闭', 'info', 2000);
}
window.closeTab = closeTab;

function updateTabAddBtn() {
    const btn = document.getElementById('tabAddBtn');
    const count = Object.keys(G.tabs).length;
    btn.classList.toggle('disabled', count >= G.maxSessions);
    btn.title = count >= G.maxSessions ? `已达上限 (${G.maxSessions})` : '新建标签页';
}

function updateTabStatus(sid, status) {
    const tab = getTabEl(sid);
    if (!tab) return;
    const dot = tab.querySelector('.tab-status');
    if (dot) {
        dot.className = 'tab-status ' + status;
    }
}

function updateTabTitle(sid, title) {
    const tab = getTabEl(sid);
    if (!tab) return;
    const span = tab.querySelector('.tab-title');
    if (span) {
        const short = title.length > 18 ? title.substring(0, 18) + '…' : title;
        span.textContent = short;
        span.title = title;
    }
}

// ============================================================
//  视频选择
// ============================================================
async function selectVideo(sid) {
    const ts = G.tabs[sid];
    if (!ts) return;
    const btn = q(sid, 'js-btn-select-video');
    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader" class="w-4 h-4 inline-block animate-spin"></i> 请在弹出窗口中选择文件…';
    refreshIcons(btn);
    const data = await api('/api/select-video', { method: 'POST' });
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="folder-open" class="w-4 h-4 inline-block"></i> 浏览选择视频文件';
    refreshIcons(btn);
    if (data.success && data.path) {
        setVideoPath(sid, data.path);
    } else if (data.message && data.message !== '未选择文件') {
        showToast(data.message, 'warning');
    }
}

function confirmManualPath(sid) {
    let v = q(sid, 'js-video-path-input').value.trim();
    v = v.replace(/^["']+|["']+$/g, '').trim();
    if (v) {
        q(sid, 'js-video-path-input').value = v;
        setVideoPath(sid, v);
    }
}

function autoConfirmPath(sid) {
    let v = q(sid, 'js-video-path-input').value.trim();
    v = v.replace(/^["']+|["']+$/g, '').trim();
    if (v && (v.endsWith('.mp4') || v.endsWith('.avi') || v.endsWith('.mkv') || v.endsWith('.mov') || v.endsWith('.flv') || v.endsWith('.wmv') || v.includes('\\'))) {
        q(sid, 'js-video-path-input').value = v;
        setVideoPath(sid, v);
    }
}

function setVideoPath(sid, p) {
    const ts = G.tabs[sid];
    if (!ts) return;
    ts.videoPath = p;
    q(sid, 'js-video-path-input').value = p;
    q(sid, 'js-video-path-display').textContent = p;
    q(sid, 'js-video-info').classList.remove('hidden');
    q(sid, 'js-btn-extract').disabled = false;
    const fname = p.split(/[\\/]/).pop() || p;
    updateTabTitle(sid, fname);
    showToast('已选择视频文件', 'success');
}

// ============================================================
//  提取控制（SSE 驱动，无需轮询）
// ============================================================
async function startExtraction(sid) {
    const ts = G.tabs[sid];
    if (!ts || !ts.videoPath) { showToast('请先选择视频文件', 'warning'); return; }
    if (ts.isExtracting) return;

    if (ts.images.length > 0) {
        if (!confirm('重新提取将清空当前画廊中的所有图片，确认继续？')) return;
    }

    const pane = getPane(sid);
    const data = await api(`/api/session/${sid}/extract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            video_path: ts.videoPath,
            threshold: parseFloat(pane.querySelector('.js-threshold').value),
            enable_history: pane.querySelector('.js-enable-history').checked,
            max_history: parseInt(pane.querySelector('.js-max-history').value),
            use_roi: pane.querySelector('.js-use-roi').checked,
            fast_mode: pane.querySelector('.js-fast-mode').checked,
            use_gpu: pane.querySelector('.js-use-gpu').checked,
            speed_mode: pane.querySelector('.js-speed-mode').value,
        }),
    });

    if (!data.success) { showToast(data.message, 'error'); return; }

    ts.isExtracting = true;
    ts.images = [];
    ts.deletedStack = [];
    ts.downloadLinks = [];

    q(sid, 'js-btn-extract').classList.add('hidden');
    q(sid, 'js-btn-resume').classList.add('hidden');
    q(sid, 'js-btn-cancel').classList.remove('hidden');
    q(sid, 'js-progress-section').classList.remove('hidden');
    q(sid, 'js-gallery-section').classList.add('hidden');
    q(sid, 'js-export-section').classList.add('hidden');
    q(sid, 'js-extract-status').textContent = '';
    const dlSec = q(sid, 'js-download-section');
    if (dlSec) { dlSec.innerHTML = ''; dlSec.classList.add('hidden'); }

    updateTabStatus(sid, 'running');
    // 进度更新由 SSE 事件驱动，无需轮询
}

/**
 * 断点续传：从上次中断的位置继续提取
 */
async function resumeExtraction(sid) {
    const ts = G.tabs[sid];
    if (!ts) return;
    if (ts.isExtracting) return;

    const data = await api(`/api/session/${sid}/resume`, { method: 'POST' });
    if (!data.success) { showToast(data.message, 'error'); return; }

    ts.isExtracting = true;
    ts.downloadLinks = [];

    q(sid, 'js-btn-extract').classList.add('hidden');
    q(sid, 'js-btn-resume').classList.add('hidden');
    q(sid, 'js-btn-cancel').classList.remove('hidden');
    q(sid, 'js-progress-section').classList.remove('hidden');
    q(sid, 'js-progress-message').textContent = '正在从断点恢复…';
    q(sid, 'js-progress-hint').textContent = `已有 ${data.existing_images || 0} 张，从第 ${data.resumed_from_frame || 0} 帧继续`;
    const dlSec = q(sid, 'js-download-section');
    if (dlSec) { dlSec.innerHTML = ''; dlSec.classList.add('hidden'); }

    updateTabStatus(sid, 'running');
    showToast('正在从断点继续提取…', 'success');
}
window.resumeExtraction = resumeExtraction;

async function cancelExtraction(sid) {
    const ts = G.tabs[sid];
    if (!ts) return;

    await api(`/api/session/${sid}/cancel`, { method: 'POST' });
    showToast('正在取消…', 'warning');

    // SSE 事件处理器会自动更新 UI
    // 添加安全超时：如果 10 秒内 SSE 未收到确认，手动查询一次
    setTimeout(async () => {
        if (ts.isExtracting) {
            const s = await api(`/api/session/${sid}/progress`);
            if (s && s.status && s.status !== 'running') {
                handleExtractionEvent(sid, {
                    type: 'extraction',
                    status: s.status,
                    message: s.message || '',
                    progress: 100,
                    saved_count: s.saved_count,
                });
            }
        }
    }, 10000);
}

// ============================================================
//  画廊管理（使用 DocumentFragment 优化渲染）
// ============================================================
async function loadImages(sid) {
    const ts = G.tabs[sid];
    if (!ts) return;
    const data = await api(`/api/session/${sid}/images`);
    ts.images = data.images || [];
    ts.deletedStack = [];
    ts.hasWork = ts.images.length > 0;
    renderGallery(sid);
    if (ts.images.length > 0) {
        q(sid, 'js-gallery-section').classList.remove('hidden');
        q(sid, 'js-export-section').classList.remove('hidden');
    }
    updateRecycleBinBtn(sid);
}

function createCardEl(sid, fn, idx) {
    const card = document.createElement('div');
    card.className = 'slide-card';
    card.dataset.filename = fn;
    card.innerHTML = `
        <img src="/api/session/${sid}/image/${encodeURIComponent(fn)}" alt="Slide ${idx + 1}" loading="lazy">
        <div class="overlay">
            <span class="bg-black/60 text-white text-xs px-2 py-0.5 rounded-full font-bold backdrop-blur">${idx + 1}</span>
            <button class="del-btn w-7 h-7 rounded-full bg-red-500/80 hover:bg-red-600 text-white text-sm flex items-center justify-center backdrop-blur transition" title="删除"><i data-lucide="x" class="w-3.5 h-3.5"></i></button>
        </div>
    `;
    card.querySelector('.del-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        const gallery = q(sid, 'js-gallery');
        const curIdx = Array.from(gallery.children).indexOf(card);
        if (curIdx >= 0) deleteImage(sid, curIdx);
    });
    card.addEventListener('click', () => {
        const gallery = q(sid, 'js-gallery');
        const curIdx = Array.from(gallery.children).indexOf(card);
        if (curIdx >= 0) showPreview(sid, curIdx);
    });
    return card;
}

function renderGallery(sid) {
    const ts = G.tabs[sid];
    if (!ts) return;
    const gallery = q(sid, 'js-gallery');
    gallery.innerHTML = '';

    // 【优化】使用 DocumentFragment 批量插入，浏览器只重绘 1 次
    const fragment = document.createDocumentFragment();
    ts.images.forEach((fn, i) => fragment.appendChild(createCardEl(sid, fn, i)));
    gallery.appendChild(fragment);
    refreshIcons(gallery);

    q(sid, 'js-image-count').textContent = `共 ${ts.images.length} 张`;
    initSortable(sid);
}

function initSortable(sid) {
    const ts = G.tabs[sid];
    if (!ts) return;
    if (ts.sortable) ts.sortable.destroy();
    const gallery = q(sid, 'js-gallery');
    ts.sortable = Sortable.create(gallery, {
        animation: 250,
        easing: 'cubic-bezier(.34,1.56,.64,1)',
        ghostClass: 'sortable-ghost',
        chosenClass: 'sortable-chosen',
        dragClass: 'sortable-drag',
        delay: 120,
        delayOnTouchOnly: true,
        onEnd(evt) {
            const [moved] = ts.images.splice(evt.oldIndex, 1);
            ts.images.splice(evt.newIndex, 0, moved);
            ts.hasWork = true;
            refreshBadges(sid);
        },
    });
}

function refreshBadges(sid) {
    const gallery = q(sid, 'js-gallery');
    if (!gallery) return;
    const ts = G.tabs[sid];
    const cards = gallery.children;
    for (let i = 0; i < cards.length; i++) {
        const badge = cards[i].querySelector('.overlay span');
        if (badge) badge.textContent = i + 1;
    }
    if (ts) q(sid, 'js-image-count').textContent = `共 ${ts.images.length} 张`;
}

function deleteImage(sid, idx) {
    const ts = G.tabs[sid];
    if (!ts || idx < 0 || idx >= ts.images.length) return;
    const fn = ts.images.splice(idx, 1)[0];
    ts.deletedStack.push({ filename: fn, originalIndex: idx });
    ts.hasWork = true;

    const gallery = q(sid, 'js-gallery');
    const card = gallery.children[idx];
    if (card) {
        card.classList.add('removing');
        card.addEventListener('transitionend', () => { card.remove(); refreshBadges(sid); }, { once: true });
        setTimeout(() => { if (card.parentNode) { card.remove(); refreshBadges(sid); } }, 350);
    }
    updateRecycleBinBtn(sid);
    showToast('已移入回收站 (Ctrl+Z 撤销)', 'info', 2000);
}

function undoLastDelete(sid) {
    const ts = G.tabs[sid];
    if (!ts || ts.deletedStack.length === 0) return;
    const { filename, originalIndex } = ts.deletedStack.pop();
    restoreImageAt(sid, filename, originalIndex);
    updateRecycleBinBtn(sid);
    showToast(`已恢复「${filename}」`, 'success', 2000);
    // 如果正在预览模式，跳转到恢复的图片并刷新计数器
    if (G.previewTabId === sid) {
        const restoredIdx = Math.min(originalIndex, ts.images.length - 1);
        showPreview(sid, restoredIdx);
    }
}

function restoreImageAt(sid, filename, targetIdx) {
    const ts = G.tabs[sid];
    if (!ts) return;
    const insertIdx = Math.min(targetIdx, ts.images.length);
    ts.images.splice(insertIdx, 0, filename);
    ts.hasWork = true;

    const gallery = q(sid, 'js-gallery');
    const card = createCardEl(sid, filename, insertIdx);
    card.classList.add('restoring');
    card.addEventListener('animationend', () => card.classList.remove('restoring'), { once: true });

    if (insertIdx >= gallery.children.length) {
        gallery.appendChild(card);
    } else {
        gallery.insertBefore(card, gallery.children[insertIdx]);
    }
    refreshIcons(card);
    refreshBadges(sid);
}

function updateRecycleBinBtn(sid) {
    const ts = G.tabs[sid];
    if (!ts) return;
    const btn = q(sid, 'js-btn-recycle-bin');
    const cnt = q(sid, 'js-recycle-count');
    if (ts.deletedStack.length > 0) {
        btn.classList.remove('hidden');
        cnt.textContent = ts.deletedStack.length;
    } else {
        btn.classList.add('hidden');
    }
}

// ── 回收站抽屉（全局共享 UI，按当前标签页渲染）──
let _recycleSid = null;

function openRecycleBin(sid) {
    _recycleSid = sid;
    renderRecycleList(sid);
    document.getElementById('recycleDrawer').classList.add('open');
    document.getElementById('recycleBackdrop').classList.add('open');
    document.body.style.overflow = 'hidden';
}

function closeRecycleBin() {
    document.getElementById('recycleDrawer').classList.remove('open');
    document.getElementById('recycleBackdrop').classList.remove('open');
    document.body.style.overflow = '';
    _recycleSid = null;
}
window.closeRecycleBin = closeRecycleBin;

function renderRecycleList(sid) {
    const ts = G.tabs[sid];
    if (!ts) return;
    const list = document.getElementById('recycleList');
    list.innerHTML = '';
    document.getElementById('recycleDrawerCount').textContent = ts.deletedStack.length > 0 ? `(${ts.deletedStack.length} 张)` : '';
    document.getElementById('btnRestoreAll').style.display = ts.deletedStack.length > 0 ? '' : 'none';

    if (ts.deletedStack.length === 0) {
        list.innerHTML = '<p class="text-center text-gray-400 text-sm py-12">回收站是空的</p>';
        return;
    }

    for (let i = ts.deletedStack.length - 1; i >= 0; i--) {
        const { filename, originalIndex } = ts.deletedStack[i];
        const item = document.createElement('div');
        item.className = 'recycle-item';
        item.innerHTML = `
            <img src="/api/session/${sid}/image/${encodeURIComponent(filename)}" alt="${filename}">
            <div class="flex-1 min-w-0">
                <p class="text-sm font-medium text-gray-700 truncate">${filename}</p>
                <p class="text-xs text-gray-400">原位置: 第 ${originalIndex + 1} 张</p>
            </div>
            <button class="shrink-0 btn text-xs bg-brand-50 text-brand-600 hover:bg-brand-100 border border-brand-200" title="恢复到原位置"><i data-lucide="undo-2" class="w-3 h-3 inline-block"></i> 恢复</button>
        `;
        const stackIdx = i;
        item.querySelector('button').addEventListener('click', (e) => {
            e.stopPropagation();
            restoreFromRecycleBin(sid, stackIdx);
        });
        list.appendChild(item);
    }
    refreshIcons(list);
}

function restoreFromRecycleBin(sid, stackIdx) {
    const ts = G.tabs[sid];
    if (!ts || stackIdx < 0 || stackIdx >= ts.deletedStack.length) return;
    const { filename, originalIndex } = ts.deletedStack.splice(stackIdx, 1)[0];
    restoreImageAt(sid, filename, originalIndex);
    updateRecycleBinBtn(sid);
    renderRecycleList(sid);
    showToast(`已恢复「${filename}」`, 'success', 2000);
    if (ts.deletedStack.length === 0) closeRecycleBin();
}

function restoreAll() {
    const sid = _recycleSid;
    const ts = G.tabs[sid];
    if (!ts || ts.deletedStack.length === 0) return;
    const sorted = [...ts.deletedStack].sort((a, b) => a.originalIndex - b.originalIndex);
    ts.deletedStack = [];
    sorted.forEach(({ filename, originalIndex }) => restoreImageAt(sid, filename, originalIndex));
    updateRecycleBinBtn(sid);
    renderRecycleList(sid);
    closeRecycleBin();
    showToast(`已恢复全部 ${sorted.length} 张图片`, 'success');
}
window.restoreAll = restoreAll;

// ============================================================
//  预览弹窗
// ============================================================
function showPreview(sid, idx) {
    const ts = G.tabs[sid];
    if (!ts || idx < 0 || idx >= ts.images.length) return;
    G.previewTabId = sid;
    G.previewIndex = idx;
    const fn = ts.images[idx];
    document.getElementById('previewImage').src = `/api/session/${sid}/image/${encodeURIComponent(fn)}`;
    document.getElementById('previewCounter').textContent = `${idx + 1} / ${ts.images.length}`;
    document.getElementById('previewModal').classList.remove('hidden');
    document.getElementById('previewModal').classList.add('flex');
    document.body.style.overflow = 'hidden';
    // 重置导航按钮 onclick（批量预览模式会覆盖此处理函数，切回标签页模式时必须还原）
    document.getElementById('btnPrevPreview').onclick = prevPreview;
    document.getElementById('btnNextPreview').onclick = nextPreview;
    // 导航按钮智能显隐
    document.getElementById('btnPrevPreview').style.visibility = idx > 0 ? '' : 'hidden';
    document.getElementById('btnNextPreview').style.visibility = idx < ts.images.length - 1 ? '' : 'hidden';
}

function hidePreview() {
    document.getElementById('previewModal').classList.add('hidden');
    document.getElementById('previewModal').classList.remove('flex');
    document.body.style.overflow = '';
    G.previewTabId = null;
    G.previewIndex = -1;
}
window.hidePreview = hidePreview;

function prevPreview() {
    if (G.previewIndex > 0) showPreview(G.previewTabId, G.previewIndex - 1);
}
window.prevPreview = prevPreview;

function nextPreview() {
    const ts = G.tabs[G.previewTabId];
    if (ts && G.previewIndex < ts.images.length - 1) showPreview(G.previewTabId, G.previewIndex + 1);
}
window.nextPreview = nextPreview;

/**
 * 在大图预览模式中删除当前图片，自动跳转到下一张。
 * 如果没有更多图片，提示并退出预览模式。
 */
function deleteInPreview() {
    const sid = G.previewTabId;
    const idx = G.previewIndex;
    if (!sid || idx < 0) return;
    const ts = G.tabs[sid];
    if (!ts || idx >= ts.images.length) return;

    // 按钮视觉反馈
    const delBtn = document.getElementById('btnDeletePreview');
    if (delBtn) {
        delBtn.classList.remove('flash');
        void delBtn.offsetWidth; // 强制 reflow 以重新触发动画
        delBtn.classList.add('flash');
    }

    // 执行删除
    const fn = ts.images.splice(idx, 1)[0];
    ts.deletedStack.push({ filename: fn, originalIndex: idx });
    ts.hasWork = true;

    // 从画廊 DOM 中移除卡片
    const gallery = q(sid, 'js-gallery');
    const card = gallery.children[idx];
    if (card) { card.remove(); refreshBadges(sid); }
    updateRecycleBinBtn(sid);

    if (ts.images.length === 0) {
        showToast('已删除最后一张图片，退出预览', 'info', 2000);
        hidePreview();
        return;
    }

    // 自动跳转：优先显示后一张，如果删的是末尾则显示前一张
    const newIdx = idx < ts.images.length ? idx : ts.images.length - 1;
    showPreview(sid, newIdx);
    showToast('已移入回收站 (Ctrl+Z 撤销)', 'info', 2000);
}
window.deleteInPreview = deleteInPreview;

// 键盘控制
document.addEventListener('keydown', (e) => {
    if (document.getElementById('recycleDrawer').classList.contains('open')) {
        if (e.key === 'Escape') { closeRecycleBin(); return; }
    }
    if (!document.getElementById('previewModal').classList.contains('hidden')) {
        if (e.key === 'Escape') hidePreview();
        if (e.key === 'ArrowLeft') prevPreview();
        if (e.key === 'ArrowRight') nextPreview();
        if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            deleteInPreview();
        }
        if (e.ctrlKey && e.key === 'z') {
            e.preventDefault();
            if (G.previewTabId) undoLastDelete(G.previewTabId);
        }
        return;
    }
    // Ctrl+Z 全局撤销
    if (e.ctrlKey && e.key === 'z') {
        e.preventDefault();
        if (G.activeTabId) undoLastDelete(G.activeTabId);
    }
});

// ============================================================
//  打包导出（异步后台处理 + SSE 进度推送）
// ============================================================
async function packageImages(sid, fmt) {
    const ts = G.tabs[sid];
    if (!ts || ts.images.length === 0) { showToast('画廊中没有图片', 'warning'); return; }
    if (ts.isPackaging) { showToast('正在打包中，请等待完成', 'warning'); return; }

    // 禁用所有导出按钮
    setExportButtonsState(sid, true);
    showPackagingProgress(sid, 0, '正在准备打包…');

    const data = await api(`/api/session/${sid}/package`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: fmt, files: ts.images }),
    });

    if (!data.success) {
        setExportButtonsState(sid, false);
        hidePackagingProgress(sid);
        showToast(data.message, 'error');
        return;
    }

    ts.isPackaging = true;
    // 后续进度更新由 SSE 事件驱动
}

function addDownloadLink(sid, filename, fmt) {
    const ts = G.tabs[sid];
    if (!ts) return;
    const sec = q(sid, 'js-download-section');
    sec.classList.remove('hidden');

    if (ts.downloadLinks.includes(filename)) return;
    ts.downloadLinks.push(filename);

    const icons = { pdf: '<i data-lucide="file-text" class="w-4 h-4 inline-block"></i>', pptx: '<i data-lucide="presentation" class="w-4 h-4 inline-block"></i>', zip: '<i data-lucide="archive" class="w-4 h-4 inline-block"></i>' };
    const el = document.createElement('a');
    el.href = `/api/session/${sid}/download/${encodeURIComponent(filename)}`;
    el.className = 'flex items-center gap-3 px-4 py-3 bg-emerald-50 border border-emerald-200 rounded-xl hover:bg-emerald-100 transition text-emerald-800 text-sm font-medium';
    el.innerHTML = `<span class="text-xl">${icons[fmt] || '<i data-lucide="paperclip" class="w-4 h-4 inline-block"></i>'}</span> ${filename} <span class="ml-auto text-xs text-emerald-500">点击下载 ↓</span>`;
    el.download = filename;
    sec.appendChild(el);
    refreshIcons(el);
}

// ============================================================
//  全局清理
// ============================================================
async function cleanupAll() {
    const tabCount = Object.keys(G.tabs).length;
    const hasBatch = typeof G.batch !== 'undefined' && G.batch && G.batch.zones;
    if (tabCount === 0 && !hasBatch) { showToast('没有需要清理的内容', 'info'); return; }
    if (!confirm('确定要清空所有标签页和批量队列的全部缓存吗？')) return;

    // 断开所有 SSE 连接
    for (const sid of Object.keys(G.tabs)) {
        const ts = G.tabs[sid];
        ts.disconnectSSE();
    }

    // 清空批量模式（如果存在）
    if (hasBatch && typeof _disconnectBatchSSE === 'function') {
        _disconnectBatchSSE();
    }

    await api('/api/cleanup-all', { method: 'POST' });

    document.querySelectorAll('.tab-item').forEach(t => t.remove());
    document.querySelectorAll('.tab-pane').forEach(p => p.remove());
    G.tabs = {};
    G.activeTabId = null;
    const hint = document.getElementById('emptyHint');
    if (hint) hint.style.display = '';
    updateTabAddBtn();
    closeRecycleBin();

    // 重置批量模式 UI
    if (hasBatch) {
        G.batch = null;
        if (typeof renderAllZones === 'function') renderAllZones();
        if (typeof _updateBatchBadge === 'function') _updateBatchBadge();
    }

    showToast('全部清空完成', 'success');
}
window.cleanupAll = cleanupAll;

// ============================================================
//  系统资源监控（保留 HTTP 轮询，全局数据非会话级）
// ============================================================
async function refreshResourceBar() {
    try {
        const data = await api('/api/system/status');
        if (!data.cpu_percent && data.cpu_percent !== 0) return;

        document.getElementById('resCpuText').textContent = data.cpu_percent.toFixed(0) + '%';
        document.getElementById('resCpuBar').style.width = data.cpu_percent + '%';
        document.getElementById('resCpuBar').style.background = data.cpu_percent > 90 ? '#ef4444' : data.cpu_percent > 70 ? '#f59e0b' : '#60a5fa';
        document.getElementById('resCpuText').classList.toggle('res-warn', data.cpu_percent > 90);

        document.getElementById('resMemText').textContent = data.memory_percent.toFixed(0) + '% (' + data.memory_used_gb + '/' + data.memory_total_gb + ' GB)';
        document.getElementById('resMemBar').style.width = data.memory_percent + '%';
        document.getElementById('resMemBar').style.background = data.memory_percent > 85 ? '#ef4444' : data.memory_percent > 70 ? '#f59e0b' : '#34d399';
        document.getElementById('resMemText').classList.toggle('res-warn', data.memory_percent > 85);

        document.getElementById('resDiskText').textContent = data.disk_free_gb + ' GB';
        document.getElementById('resDiskText').classList.toggle('res-warn', data.disk_free_gb < 0.5);

        document.getElementById('resTaskText').textContent = data.active_tasks;
        document.getElementById('resTabText').textContent = data.total_sessions + '/' + data.max_sessions;

        // GPU 信息
        const gpuSection = document.getElementById('resGpuSection');
        if (data.gpu_available) {
            gpuSection.style.display = '';
            const gpuUtil = data.gpu_util || 0;
            let gpuInfo = gpuUtil + '%';
            if (data.gpu_mem_used > 0 || data.gpu_mem_total > 0) {
                gpuInfo += ' (';
                if (data.gpu_mem_used > 0 && data.gpu_mem_total > 0) {
                    gpuInfo += data.gpu_mem_used + '/' + data.gpu_mem_total + ' MB';
                } else if (data.gpu_mem_used > 0) {
                    gpuInfo += data.gpu_mem_used + ' MB';
                } else {
                    gpuInfo += data.gpu_mem_total + ' MB';
                }
                if (data.gpu_temperature > 0) gpuInfo += ', ' + data.gpu_temperature + '°C';
                gpuInfo += ')';
            }
            document.getElementById('resGpuText').textContent = gpuInfo;
            document.getElementById('resGpuText').title = data.gpu_name || 'GPU';
            document.getElementById('resGpuBar').style.width = gpuUtil + '%';
            document.getElementById('resGpuBar').style.background = gpuUtil > 90 ? '#ef4444' : gpuUtil > 70 ? '#f59e0b' : '#a78bfa';
            document.getElementById('resGpuText').classList.toggle('res-warn', gpuUtil > 90);
        } else {
            gpuSection.style.display = 'none';
        }

        G.maxSessions = data.max_sessions;

        const banner = document.getElementById('resourceWarning');
        if (data.warning) {
            banner.innerHTML = '<i data-lucide="alert-triangle" class="w-4 h-4 inline-block"></i> 系统资源告警：' + data.warning;
            refreshIcons(banner);
            banner.classList.add('visible');
        } else {
            banner.classList.remove('visible');
        }
    } catch (e) {
        console.warn('[Resource] 获取资源状态失败:', e);
    }
}

setInterval(refreshResourceBar, 3000);
refreshResourceBar();

// ============================================================
//  心跳 & 断连检测
// ============================================================
let _serverAlive = true;
let _heartbeatFailCount = 0;
const HEARTBEAT_FAIL_THRESHOLD = 5;
let _reconnectTimer = null;

function showDisconnectOverlay() {
    if (G._serverShutdown) return; // 用户主动关闭服务，不显示断连遮罩
    if (document.getElementById('disconnectOverlay')) return;
    _serverAlive = false;
    const overlay = document.createElement('div');
    overlay.id = 'disconnectOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,0.85);backdrop-filter:blur(4px);';
    overlay.innerHTML = `
        <div style="text-align:center;max-width:480px;padding:48px 36px;background:white;border-radius:16px;box-shadow:0 25px 50px rgba(0,0,0,0.25);">
            <div style="font-size:56px;margin-bottom:16px;"><i data-lucide="wifi-off" class="w-14 h-14" style="display:inline-block"></i></div>
            <h1 style="font-size:22px;font-weight:700;color:#1e293b;margin-bottom:12px;">后端服务已断开</h1>
            <p style="color:#475569;line-height:1.7;font-size:15px;margin-bottom:20px;">
                服务进程已退出或被关闭。<br>正在自动尝试重新连接…
            </p>
            <div id="reconnectStatus" style="background:#f1f5f9;border-radius:10px;padding:16px 20px;text-align:center;margin-bottom:20px;">
                <p style="color:#334155;font-size:14px;font-weight:600;margin-bottom:4px;"><i data-lucide="refresh-cw" class="w-4 h-4 inline-block animate-spin"></i> 自动重连中…</p>
                <p id="reconnectCountdown" style="color:#64748b;font-size:13px;">每 5 秒尝试一次</p>
            </div>
            <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;">
                <button id="btnSmartRefresh" onclick="smartRefresh()" style="padding:10px 20px;background:#7394b8;color:white;border:none;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer;"><i data-lucide="refresh-cw" class="w-4 h-4 inline-block"></i> 检测并刷新</button>
                <a href="https://github.com/PWO-CHINA/VidSlide/issues/new?title=${encodeURIComponent('[Bug] 后端服务意外断开')}&body=${encodeURIComponent('## 问题描述\\n后端服务意外断开连接。\\n\\n## 环境信息\\n- 时间: ' + new Date().toLocaleString() + '\\n\\n## 复现步骤\\n1. \\n2. \\n3. ')}" target="_blank" style="padding:10px 20px;background:#e2e8f0;color:#334155;border:none;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer;text-decoration:none;"><i data-lucide="bug" class="w-4 h-4 inline-block"></i> 提交 Issue</a>
            </div>
            <p id="smartRefreshHint" style="color:#94a3b8;font-size:12px;margin-top:12px;display:none;"></p>
        </div>`;
    document.body.appendChild(overlay);
    refreshIcons(overlay);

    // 启动自动重连定时器
    _startAutoReconnect();
}

/**
 * 智能刷新：先 ping 后端，有响应才 reload，否则提示用户手动重启
 */
async function smartRefresh() {
    const btn = document.getElementById('btnSmartRefresh');
    const hint = document.getElementById('smartRefreshHint');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i data-lucide="loader" class="w-4 h-4 inline-block animate-spin"></i> 正在检测后端…'; refreshIcons(btn); }
    if (hint) { hint.style.display = 'block'; hint.textContent = '正在尝试连接后端服务…'; }
    try {
        const resp = await fetch('/api/heartbeat', { method: 'POST', signal: AbortSignal.timeout(3000) });
        if (resp.ok) {
            if (hint) hint.textContent = '后端已恢复，正在刷新页面…';
            location.reload();
            return;
        }
    } catch { /* 后端不可用 */ }
    if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="refresh-cw" class="w-4 h-4 inline-block"></i> 检测并刷新'; refreshIcons(btn); }
    if (hint) {
        hint.style.display = 'block';
        hint.innerHTML = '后端服务未运行。请重新双击 <b>VidSlide.exe</b> 或在终端运行 <code>python app.py</code> 启动后端，然后再点击此按钮。';
    }
}
window.smartRefresh = smartRefresh;

function _startAutoReconnect() {
    if (_reconnectTimer) return;
    let attempt = 0;
    const MAX_RECONNECT = 30; // 最多尝试 30 次（约 2.5 分钟）
    _reconnectTimer = setInterval(async () => {
        attempt++;
        const el = document.getElementById('reconnectCountdown');
        if (el) el.textContent = `第 ${attempt} 次尝试…`;
        try {
            const resp = await fetch('/api/heartbeat', { method: 'POST', signal: AbortSignal.timeout(3000) });
            if (resp.ok) {
                clearInterval(_reconnectTimer);
                _reconnectTimer = null;
                _heartbeatFailCount = 0;
                _serverAlive = true;
                // 服务恢复，刷新页面以重建状态
                location.reload();
                return;
            }
        } catch {
            // 仍然不可用，继续重试
        }
        if (attempt >= MAX_RECONNECT) {
            clearInterval(_reconnectTimer);
            _reconnectTimer = null;
            const statusEl = document.getElementById('reconnectStatus');
            if (statusEl) {
                statusEl.innerHTML = `
                    <p style="color:#991b1b;font-size:14px;font-weight:600;margin-bottom:4px;"><i data-lucide="x-circle" class="w-4 h-4 inline-block"></i> 自动重连失败</p>
                    <p style="color:#64748b;font-size:13px;">已尝试 ${MAX_RECONNECT} 次，后端服务可能已关闭。<br>请手动重启后端后点击「检测并刷新」。</p>
                `;
                refreshIcons(statusEl);
            }
        }
    }, 5000);
}

async function sendHeartbeat() {
    try {
        // 在心跳中携带当前活跃的会话 ID，让后端知道哪些会话仍被前端使用
        const activeSessions = Object.keys(G.tabs);
        const resp = await fetch('/api/heartbeat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ active_sessions: activeSessions }),
            signal: AbortSignal.timeout(5000),
        });
        if (resp.ok) {
            _heartbeatFailCount = 0;
            _serverAlive = true;
            // 如果之前断联后恢复了，移除断联遮罩
            const overlay = document.getElementById('disconnectOverlay');
            if (overlay) overlay.remove();
        } else { _heartbeatFailCount++; }
    } catch { _heartbeatFailCount++; }
    if (_heartbeatFailCount >= HEARTBEAT_FAIL_THRESHOLD) showDisconnectOverlay();
}
setInterval(sendHeartbeat, 8000);
sendHeartbeat();

// 当页面从后台恢复时立即发送心跳（对抗浏览器后台节流）
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
        sendHeartbeat();
    } else {
        // 页面进入后台时用 sendBeacon 发一次心跳，通知后端别退出
        navigator.sendBeacon('/api/heartbeat', '');
    }
});

// ============================================================
//  关闭服务
// ============================================================
function _showShutdownPage() {
    // 清除所有定时器（心跳、资源监控等）
    const highId = setTimeout(() => {}, 0);
    for (let i = 0; i < highId; i++) clearInterval(i);

    const COUNTDOWN = 5;
    document.body.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:center;height:100vh;background:#f8fafc;">
            <div style="text-align:center;max-width:400px;padding:40px;">
                <div style="font-size:64px;margin-bottom:20px;">👋</div>
                <h1 style="font-size:24px;font-weight:bold;color:#1e293b;margin-bottom:12px;">工具已关闭</h1>
                <p style="color:#64748b;line-height:1.6;">服务已安全退出，临时文件已清理。</p>
                <p id="autoCloseHint" style="color:#94a3b8;font-size:13px;margin-top:16px;">此页面将在 <span id="closeCountdown">${COUNTDOWN}</span> 秒后自动关闭…</p>
            </div>
        </div>`;

    let remaining = COUNTDOWN;
    const timer = setInterval(() => {
        remaining--;
        const el = document.getElementById('closeCountdown');
        if (el) el.textContent = remaining;
        if (remaining <= 0) {
            clearInterval(timer);
            // 尝试关闭标签页；如果浏览器阻止（非脚本打开的页面），则提示手动关闭
            try { window.close(); } catch {}
            setTimeout(() => {
                const hint = document.getElementById('autoCloseHint');
                if (hint) hint.textContent = '浏览器不允许自动关闭此页面，请手动关闭。';
            }, 300);
        }
    }, 1000);
}

async function shutdownServer() {
    const hasWork = Object.values(G.tabs).some(ts => ts.images.length > 0 && ts.downloadLinks.length === 0);
    let msg = '确定要关闭工具吗？\n\n关闭后：\n• 服务将停止运行\n• 所有标签页的临时缓存会自动清理';
    if (hasWork) msg += '\n• ⚠️ 有未导出的图片将丢失';
    if (!confirm(msg)) return;
    // 断开所有 SSE
    for (const sid of Object.keys(G.tabs)) {
        G.tabs[sid].disconnectSSE();
    }
    showToast('正在关闭服务…', 'info');
    G._serverShutdown = true;
    // 通知其他浏览器标签页
    if (_bc) _bc.postMessage({ type: 'shutdown' });
    try { await fetch('/api/shutdown', { method: 'POST' }); } catch { }
    setTimeout(() => _showShutdownPage(), 600);
}
window.shutdownServer = shutdownServer;

// ============================================================
//  页面离开保护
// ============================================================
window.addEventListener('beforeunload', (e) => {
    if (G._serverShutdown) return;
    const hasWork = Object.values(G.tabs).some(ts => ts.hasWork && ts.images.length > 0);
    if (hasWork) {
        e.preventDefault();
        e.returnValue = '有未导出的图片，确定要离开吗？';
        return e.returnValue;
    }
    // 只关闭空闲的会话，保留有任务运行中或有成果的会话（孤儿清理会处理它们）
    for (const [sid, ts] of Object.entries(G.tabs)) {
        if (!ts.isExtracting && !ts.isPackaging && ts.images.length === 0) {
            navigator.sendBeacon(`/api/session/${sid}/close`, '');
        }
    }
});

window.addEventListener('pagehide', () => {
    navigator.sendBeacon('/api/heartbeat', '');
    // 只关闭空闲会话，保留运行中/有成果的会话以便重新打开时恢复
    for (const [sid, ts] of Object.entries(G.tabs)) {
        if (!ts.isExtracting && !ts.isPackaging && ts.images.length === 0) {
            navigator.sendBeacon(`/api/session/${sid}/close`, '');
        }
    }
});

// ============================================================
//  初始化：自动创建第一个标签页
// ============================================================
(async function init() {
    // 第零步：检测是否已有其他浏览器标签页打开了本工具
    const _noDupWarn = (() => { try { return localStorage.getItem('vidslide_no_dup_warn') === '1'; } catch { return false; } })();
    const _forceOpen = (() => { try { const v = sessionStorage.getItem('vidslide_force_open'); sessionStorage.removeItem('vidslide_force_open'); return v === '1'; } catch { return false; } })();
    if (_bc && !_noDupWarn && !_forceOpen) {
        _bc.postMessage({ type: 'tab_active' });
        await new Promise(r => setTimeout(r, 300));
        if (_otherTabExists) {
            document.body.innerHTML = `
                <div style="display:flex;align-items:center;justify-content:center;height:100vh;background:#f8fafc;">
                    <div style="text-align:center;max-width:480px;padding:40px;">
                        <div style="font-size:56px;margin-bottom:16px;"><i data-lucide="repeat" class="w-14 h-14" style="display:inline-block"></i></div>
                        <h1 style="font-size:22px;font-weight:700;color:#1e293b;margin-bottom:12px;">已在其他标签页中打开</h1>
                        <p style="color:#475569;line-height:1.7;font-size:15px;margin-bottom:24px;">
                            检测到另一个浏览器标签页已经在运行影幻智提。<br>同时打开多个标签页可能导致会话冲突。
                        </p>
                        <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;">
                            <button id="btnForceOpen" style="padding:10px 20px;background:#7394b8;color:white;border:none;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer;"><i data-lucide="refresh-cw" class="w-4 h-4 inline-block"></i> 强制在此标签页打开</button>
                            <button id="btnCloseDup" style="padding:10px 20px;background:#e2e8f0;color:#334155;border:none;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer;"><i data-lucide="x" class="w-4 h-4 inline-block"></i> 关闭此标签页</button>
                        </div>
                        <label style="display:flex;align-items:center;justify-content:center;gap:6px;margin-top:16px;color:#94a3b8;font-size:12px;cursor:pointer;">
                            <input type="checkbox" id="cbNoDupWarn" style="accent-color:#7394b8;"> 不再提示
                        </label>
                    </div>
                </div>`;
            refreshIcons(document.body);
            document.getElementById('btnForceOpen').addEventListener('click', () => {
                try { sessionStorage.setItem('vidslide_force_open', '1'); } catch {}
                location.reload();
            });
            document.getElementById('btnCloseDup').addEventListener('click', () => {
                if (document.getElementById('cbNoDupWarn').checked) {
                    try { localStorage.setItem('vidslide_no_dup_warn', '1'); } catch {}
                }
                try { window.close(); } catch {}
                document.getElementById('btnCloseDup').textContent = '请手动关闭此标签页';
            });
            return; // 停止初始化
        }
    }
    // 如果是强制打开的，提示用户
    if (_forceOpen) {
        showToast('已强制打开，注意其他标签页可能仍在运行', 'warning', 5000);
    }

    // 第一步：清理后端孤儿会话（空闲且无 SSE 连接的残留会话）
    try {
        const cleanResult = await api('/api/sessions/cleanup-stale', { method: 'POST' });
        if (cleanResult.success) {
            G.maxSessions = cleanResult.max_sessions || 3;
            if (cleanResult.cleaned > 0) {
                console.log(`[初始化] 已清理 ${cleanResult.cleaned} 个孤儿会话`);
            }
        }
    } catch (e) {
        console.warn('[初始化] 清理孤儿会话失败:', e);
    }

    // 第二步：获取当前会话列表，恢复有价值的残留会话
    const sessData = await api('/api/sessions');
    if (sessData.success) {
        G.maxSessions = sessData.max_sessions || 3;
        const existingSessions = sessData.sessions || [];
        for (const sessInfo of existingSessions) {
            // 恢复有价值的会话（正在运行、中断、或有提取成果的）
            if (sessInfo.status === 'running' || sessInfo.status === 'interrupted' || sessInfo.saved_count > 0 || sessInfo.pkg_status === 'running') {
                adoptExistingSession(sessInfo);
            }
        }
        if (existingSessions.length > 0 && Object.keys(G.tabs).length > 0) {
            // 有恢复的会话，切换到第一个
            switchTab(Object.keys(G.tabs)[0]);
            updateTabAddBtn();
            showToast(`已恢复 ${Object.keys(G.tabs).length} 个标签页`, 'success', 3000);
        }
    }

    // 第三步：如果没有恢复任何会话，创建第一个标签页
    if (Object.keys(G.tabs).length === 0) {
        await addNewTab();
    }

    // 第四步：恢复批量队列（如果有）& 初始化批量参数面板事件
    if (typeof _initBatchParamEvents === 'function') _initBatchParamEvents();
    if (typeof _recoverBatch === 'function') {
        const recovered = await _recoverBatch();
        if (recovered && G.batch && G.batch.zones) {
            const total = G.batch.zones.unselected.length + G.batch.zones.queue.length + G.batch.zones.completed.length;
            console.log('[初始化] 已恢复批量队列，' + total + ' 个视频');
        }
    }
})();
