(function () {
    const S = {
        course: null,
        sessions: [],
        selected: new Set(),
        jobSource: null,
    };

    function $(id) { return document.getElementById(id); }

    function setText(id, text) {
        const el = $(id);
        if (el) el.textContent = text;
    }

    function fmtBytes(bytes) {
        if (!bytes || bytes < 0) return '--';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let value = Number(bytes);
        let idx = 0;
        while (value >= 1024 && idx < units.length - 1) {
            value /= 1024;
            idx++;
        }
        return (idx === 0 ? value.toFixed(0) : value.toFixed(1)) + ' ' + units[idx];
    }

    async function refreshYanheStatus() {
        try {
            const diag = await api('/api/diagnostics/status');
            if (diag.success) {
                const free = diag.storage?.disk?.free_bytes;
                setText('yanheWorkspaceStatus', '空间：' + fmtBytes(free));
                setText('yanheFfmpegStatus', diag.ffmpeg?.available ? 'ffmpeg：可用' : 'ffmpeg：未找到');
            }
            const login = await api('/api/yanhe/login/status');
            const info = login.login || {};
            setText('yanheLoginStatus', info.usable ? '登录：可用' : '登录：需要处理');
        } catch (e) {
            setText('yanheLoginStatus', '登录：检测失败');
        }
    }

    window.loadYanheCourse = async function () {
        const input = $('yanheCourseInput')?.value?.trim();
        if (!input) {
            showToast('请先输入延河课程链接或课程 ID', 'warning');
            return;
        }
        const btn = $('btnYanheLoad');
        if (btn) btn.disabled = true;
        try {
            showToast('正在读取延河课程...', 'info', 1800);
            const res = await api('/api/yanhe/course/load', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ course_input: input }),
            });
            if (!res.success) {
                showToast(res.message || '课程读取失败，可能需要重新登录', 'error');
                return;
            }
            S.course = res.course;
            S.sessions = res.course.items || [];
            S.selected = new Set();
            const summary = $('yanheCourseSummary');
            if (summary) {
                summary.style.display = '';
                summary.innerHTML = '<b>' + _escHtml(res.course.course_name || '延河课程') + '</b>' +
                    ' · 课程 ID ' + _escHtml(String(res.course.course_id || '')) +
                    ' · 可下载录屏 ' + S.sessions.length + ' 个 · 请选择要下载的录屏';
            }
            const toolbar = $('yanheToolbar');
            if (toolbar) toolbar.style.display = '';
            renderYanheSessions();
            updateDownloadButton();
            showToast('课程列表已读取', 'success');
        } catch (e) {
            showToast('课程读取失败：' + e.message, 'error');
        } finally {
            if (btn) btn.disabled = false;
            refreshIcons(document);
        }
    };

    window.renderYanheSessions = function () {
        const list = $('yanheSessionList');
        if (!list) return;
        const q = ($('yanheSearch')?.value || '').trim().toLowerCase();
        const rows = S.sessions.filter(item => !q || String(item.title || '').toLowerCase().includes(q));
        if (!rows.length) {
            list.innerHTML = '<div class="yanhe-summary">没有匹配的课堂录屏。</div>';
            return;
        }
        list.innerHTML = rows.map(item => {
            const sid = String(item.session_id);
            const checked = S.selected.has(sid) ? 'checked' : '';
            return '<label class="yanhe-session-item">' +
                '<input type="checkbox" data-yanhe-sid="' + _escHtml(sid) + '" ' + checked + ' onchange="toggleYanheSession(this)">' +
                '<span>' +
                    '<span class="yanhe-session-title">' + _escHtml(item.title || ('session-' + sid)) + '</span>' +
                    '<span class="yanhe-session-meta">' + _escHtml((item.started_at || '') + ' · ' + (item.duration || '') + ' · ' + (item.filename || '')) + '</span>' +
                '</span>' +
                '<span class="status-pill">' + (item.complete_mp4 ? '已存在' : '待下载') + '</span>' +
            '</label>';
        }).join('');
        refreshIcons(list);
    };

    window.toggleYanheSession = function (cb) {
        const sid = String(cb.dataset.yanheSid || '');
        if (!sid) return;
        if (cb.checked) S.selected.add(sid);
        else S.selected.delete(sid);
        updateDownloadButton();
    };

    window.selectAllYanheSessions = function (checked) {
        if (checked) S.sessions.forEach(item => S.selected.add(String(item.session_id)));
        else S.selected.clear();
        renderYanheSessions();
        updateDownloadButton();
    };

    function updateDownloadButton() {
        const btn = $('btnYanheDownload');
        if (!btn) return;
        const count = S.selected.size;
        btn.disabled = count === 0;
        btn.innerHTML = '<i data-lucide="download" class="w-4 h-4"></i> 下载选中' + (count ? ' (' + count + ')' : '');
        refreshIcons(btn);
    }

    async function ensureBatch() {
        if (G.batch?.bid) return G.batch.bid;
        if (typeof _initBatch === 'function') {
            await _initBatch();
            if (G.batch?.bid) return G.batch.bid;
        }
        const params = { threshold: 5, fast_mode: true, use_roi: true, use_gpu: true, enable_history: true, max_history: 5, speed_mode: 'fast', classroom_mode: 'ppt' };
        const res = await api('/api/batch/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ params, max_workers: 1 }),
        });
        if (!res.success) throw new Error(res.message || '无法创建批量队列');
        G.batch = { bid: res.batch_id, zones: { unselected: [], queue: [], completed: [] }, status: 'idle', params, maxWorkers: 1, eventSource: null };
        if (typeof _connectBatchSSE === 'function') _connectBatchSSE();
        return G.batch.bid;
    }

    window.startYanheDownload = async function () {
        if (!S.course || !S.sessions.length) {
            showToast('请先读取课程列表', 'warning');
            return;
        }
        const ids = [...S.selected];
        if (!ids.length) {
            showToast('请至少选择一个课堂录屏', 'warning');
            return;
        }
        const btn = $('btnYanheDownload');
        if (btn) btn.disabled = true;
        try {
            const diag = await api('/api/diagnostics/status');
            if (!diag.ffmpeg?.available) {
                showToast('未找到 ffmpeg，无法下载延河录屏。请先在设置里配置 ffmpeg。', 'error', 6000);
                return;
            }
            const batchId = await ensureBatch();
            const progress = $('yanheDownloadProgress');
            if (progress) progress.style.display = '';
            setText('yanheDownloadText', '下载任务已创建');
            const res = await api('/api/yanhe/download-jobs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    course_input: $('yanheCourseInput')?.value?.trim(),
                    session_ids: ids,
                    batch_id: batchId,
                }),
            });
            if (!res.success) {
                showToast(res.message || '创建下载任务失败', 'error');
                return;
            }
            connectYanheJob(res.job.id);
            showToast('下载任务已开始', 'success');
        } catch (e) {
            showToast('下载启动失败：' + e.message, 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    };

    function connectYanheJob(jobId) {
        if (S.jobSource) S.jobSource.close();
        const es = new EventSource('/api/yanhe/download-jobs/' + jobId + '/events');
        S.jobSource = es;
        es.onmessage = (event) => {
            const data = JSON.parse(event.data);
            const job = data.job || {};
            const pct = job.progress || 0;
            const bar = $('yanheDownloadBar');
            if (bar) bar.style.width = pct + '%';
            if (data.type === 'download_progress') {
                const name = data.current?.filename || '';
                setText('yanheDownloadText', '下载中 ' + pct + '% · ' + name + ' · ' + (data.speed || ''));
            } else if (data.type === 'item_done') {
                setText('yanheDownloadText', '已加入批量未选中区：' + (data.item?.name || '视频'));
            } else if (data.type === 'job_done') {
                setText('yanheDownloadText', '下载完成，视频已加入批量未选中区');
                showToast('延河下载完成，可到批量提取区处理', 'success');
                es.close();
            } else if (data.type === 'job_error') {
                setText('yanheDownloadText', '下载失败：' + (data.message || '未知错误'));
                showToast('下载失败：' + (data.message || '未知错误'), 'error');
                es.close();
            } else if (data.type === 'job_cancelled') {
                setText('yanheDownloadText', '下载已取消');
                es.close();
            }
        };
        es.onerror = () => {
            setText('yanheDownloadText', '下载事件连接中断');
        };
    }

    window.startYanheLogin = async function () {
        try {
            const res = await api('/api/yanhe/login/start', { method: 'POST' });
            showToast(res.success ? '已打开登录窗口' : (res.message || '登录窗口打开失败'), res.success ? 'success' : 'error');
        } catch (e) {
            showToast('登录窗口打开失败：' + e.message, 'error');
        }
    };

    document.addEventListener('DOMContentLoaded', () => {
        refreshYanheStatus();
        updateDownloadButton();
    });
})();
