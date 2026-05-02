(function () {
    const S = {
        course: null,
        sessions: [],
        selected: new Set(),
        jobSource: null,
        downloading: false,
        lastStatus: {},
    };

    const FLOW = [
        ['course', 'flowCourse'],
        ['download', 'flowDownload'],
        ['batch', 'flowBatch'],
        ['extract', 'flowExtract'],
        ['export', 'flowExport'],
    ];

    function $(id) { return document.getElementById(id); }

    function setText(id, text) {
        const el = $(id);
        if (el) el.textContent = text;
    }

    function setTitle(id, text) {
        const el = $(id);
        if (el) el.title = text || '';
    }

    function fmtBytes(bytes) {
        if (bytes === null || bytes === undefined || Number(bytes) < 0) return '--';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let value = Number(bytes);
        let idx = 0;
        while (value >= 1024 && idx < units.length - 1) {
            value /= 1024;
            idx++;
        }
        return (idx === 0 ? value.toFixed(0) : value.toFixed(1)) + ' ' + units[idx];
    }

    function parseDuration(value) {
        if (value === null || value === undefined || value === '') return 0;
        if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0;
        const text = String(value).trim();
        if (!text) return 0;
        if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
        if (text.includes(':')) {
            const parts = text.split(':').map(p => Number(p));
            if (parts.some(n => !Number.isFinite(n))) return 0;
            if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
            if (parts.length === 2) return parts[0] * 60 + parts[1];
        }
        let total = 0;
        const h = text.match(/(\d+(?:\.\d+)?)\s*(?:小时|时|h)/i);
        const m = text.match(/(\d+(?:\.\d+)?)\s*(?:分钟|分|min|m(?!s))/i);
        const s = text.match(/(\d+(?:\.\d+)?)\s*(?:秒|sec|s)/i);
        if (h) total += Number(h[1]) * 3600;
        if (m) total += Number(m[1]) * 60;
        if (s) total += Number(s[1]);
        return Number.isFinite(total) ? total : 0;
    }

    function durationOf(item) {
        return parseDuration(item?.duration_seconds ?? item?.duration ?? item?.video_duration);
    }

    function formatDuration(seconds) {
        const total = Math.round(Number(seconds) || 0);
        if (total <= 0) return '--';
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        if (h) return h + '小时' + String(m).padStart(2, '0') + '分';
        if (m) return m + '分' + String(s).padStart(2, '0') + '秒';
        return s + '秒';
    }

    function parseDateValue(value) {
        if (!value) return 0;
        const parsed = Date.parse(String(value).replace(/\./g, '-'));
        return Number.isFinite(parsed) ? parsed : 0;
    }

    function sourceLabel(source) {
        const map = {
            configured: '手动配置',
            bundled: '内置 ffmpeg',
            app: '随应用提供',
            PATH: '系统 PATH',
            getvideo: 'getvideo 参考目录',
        };
        return map[source] || source || '候选项';
    }

    function normalizePath(path) {
        return String(path || '').replace(/\//g, '\\').toLowerCase();
    }

    function currentFfmpegLabel(ffmpeg) {
        if (!ffmpeg?.available) return 'ffmpeg：未找到';
        const path = normalizePath(ffmpeg.path);
        const match = (ffmpeg.candidates || []).find(item => normalizePath(item.path) === path);
        return 'ffmpeg：' + sourceLabel(match?.source || 'configured');
    }

    function shortPath(path) {
        const text = String(path || '');
        if (text.length <= 52) return text;
        const parts = text.split(/[\\/]/).filter(Boolean);
        if (parts.length < 3) return text.slice(0, 22) + '...' + text.slice(-24);
        const drive = /^[a-z]:/i.test(text) ? text.slice(0, 2) + '\\' : '';
        return drive + '...' + parts.slice(-3).join('\\');
    }

    function isFDrive(path) {
        return /^f:[\\/]/i.test(String(path || ''));
    }

    function profileLabel(settings) {
        return settings?.download?.use_getvideo_profile_for_dev ? 'getvideo profile' : 'VidSlide profile';
    }

    function setInlineNotice(type, message, actionsHtml) {
        const box = $('yanheInlineNotice');
        if (!box) return;
        box.className = 'yanhe-notice ' + (type || 'info');
        box.innerHTML = '<span>' + _escHtml(message) + '</span>' + (actionsHtml || '');
        box.style.display = '';
        refreshIcons(box);
    }

    function setFlowState(active, done, error) {
        const doneSet = new Set(done || []);
        for (const [key, id] of FLOW) {
            const el = $(id);
            if (!el) continue;
            el.classList.toggle('active', key === active);
            el.classList.toggle('done', doneSet.has(key));
            el.classList.toggle('error', key === error);
        }
    }

    function selectedItems() {
        return S.sessions.filter(item => S.selected.has(String(item.session_id)));
    }

    function updateCourseStats() {
        const box = $('yanheCourseStats');
        if (!box || !S.course) return;
        const totalDuration = S.sessions.reduce((sum, item) => sum + durationOf(item), 0);
        const picked = selectedItems();
        const pickedDuration = picked.reduce((sum, item) => sum + durationOf(item), 0);
        box.style.display = '';
        setText('yanheStatRecordings', String(S.sessions.length));
        setText('yanheStatDuration', formatDuration(totalDuration));
        setText('yanheStatSelected', String(picked.length));
        setText('yanheStatSelectedDuration', formatDuration(pickedDuration));
    }

    function sortedRows(rows) {
        const sort = $('yanheSort')?.value || 'newest';
        const copy = [...rows];
        if (sort === 'shortest') {
            copy.sort((a, b) => (durationOf(a) || Number.MAX_SAFE_INTEGER) - (durationOf(b) || Number.MAX_SAFE_INTEGER));
        } else if (sort === 'oldest') {
            copy.sort((a, b) => parseDateValue(a.started_at) - parseDateValue(b.started_at));
        } else {
            copy.sort((a, b) => parseDateValue(b.started_at) - parseDateValue(a.started_at));
        }
        return copy;
    }

    function updateDownloadButton() {
        const btn = $('btnYanheDownload');
        if (!btn) return;
        const count = S.selected.size;
        btn.disabled = S.downloading || count === 0;
        const label = S.downloading ? '下载中...' : ('下载选中' + (count ? ' (' + count + ')' : ''));
        btn.innerHTML = '<i data-lucide="download" class="w-4 h-4"></i> ' + label;
        updateCourseStats();
        refreshIcons(btn);
    }

    async function refreshYanheStatus() {
        let settings = null;
        let diag = null;
        let login = null;
        try {
            const settingsRes = await api('/api/settings');
            settings = settingsRes.settings || {};
            diag = await api('/api/diagnostics/status');
            if (diag.success) {
                const downloadDir = diag.storage?.dirs?.downloads?.path || settings.download?.download_dir || '';
                const free = (diag.storage?.download_disk || diag.storage?.disk || {}).free_bytes;
                const fLabel = isFDrive(downloadDir) ? 'F盘下载' : '非 F 盘下载';
                setText('yanheWorkspaceStatus', fLabel + '：' + fmtBytes(free) + ' 可用');
                setTitle('yanheWorkspaceStatus', downloadDir);
                setText('yanheFfmpegStatus', currentFfmpegLabel(diag.ffmpeg));
                setTitle('yanheFfmpegStatus', diag.ffmpeg?.path || diag.ffmpeg?.message || '');
            }
            const loginRes = await api('/api/yanhe/login/status');
            login = loginRes.login || {};
            const loginText = login.usable ? '登录可用：' + profileLabel(settings) : '需要登录：' + profileLabel(settings);
            setText('yanheLoginStatus', loginText);
            setTitle('yanheLoginStatus', login.profile || '');

            S.lastStatus = { settings, diag, login };
            const downloadDir = diag?.storage?.dirs?.downloads?.path || settings?.download?.download_dir || '';
            if (!login.usable) {
                setInlineNotice('warning', '延河登录态不可用。请打开登录窗口完成一次登录，或在设置中确认临时使用的 profile。', '<button class="notice-action" onclick="startYanheLogin()">打开登录窗口</button>');
            } else if (!diag?.ffmpeg?.available) {
                setInlineNotice('error', '没有找到 ffmpeg，延河 m3u8 无法合并为 mp4。请放入 bin\\ffmpeg.exe 或在设置中选择路径。', '<button class="notice-action" onclick="openSettingsDrawer()">配置 ffmpeg</button>');
            } else if (downloadDir && !isFDrive(downloadDir)) {
                setInlineNotice('warning', '当前下载目录不在 F 盘：' + shortPath(downloadDir) + '。大课程建议放到 F 盘。', '<button class="notice-action" onclick="openSettingsDrawer()">修改下载目录</button>');
            } else {
                setInlineNotice('info', '就绪。录屏会下载到 ' + shortPath(downloadDir) + '，完成后只进入未选中区，不会自动开始提取。');
            }
        } catch (e) {
            setText('yanheLoginStatus', '登录：检测失败');
            setInlineNotice('error', '状态检测失败：' + e.message);
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
            setFlowState('course', []);
            showToast('正在读取延河课程...', 'info', 1800);
            const res = await api('/api/yanhe/course/load', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ course_input: input }),
            });
            if (!res.success) {
                setFlowState('course', [], 'course');
                setInlineNotice('error', res.message || '课程读取失败，可能需要重新登录。', '<button class="notice-action" onclick="checkYanheLogin()">检查登录</button>');
                showToast(res.message || '课程读取失败，可能需要重新登录', 'error');
                return;
            }
            S.course = res.course;
            S.sessions = res.course.items || [];
            S.selected = new Set();
            const progress = $('yanheDownloadProgress');
            const goBatch = $('btnYanheGoBatch');
            const bar = $('yanheDownloadBar');
            if (progress) progress.style.display = 'none';
            if (goBatch) goBatch.style.display = 'none';
            if (bar) bar.style.width = '0%';
            const summary = $('yanheCourseSummary');
            const totalDuration = S.sessions.reduce((sum, item) => sum + durationOf(item), 0);
            if (summary) {
                summary.style.display = '';
                summary.innerHTML = '<b>' + _escHtml(res.course.course_name || '延河课程') + '</b>' +
                    ' · 课程 ID ' + _escHtml(String(res.course.course_id || '')) +
                    ' · 可下载录屏 ' + S.sessions.length + ' 个' +
                    ' · 总时长 ' + _escHtml(formatDuration(totalDuration)) +
                    ' · 下载后进入未选中区';
            }
            const toolbar = $('yanheToolbar');
            if (toolbar) toolbar.style.display = '';
            renderYanheSessions();
            updateDownloadButton();
            setFlowState('download', ['course']);
            showToast('课程列表已读取', 'success');
        } catch (e) {
            setFlowState('course', [], 'course');
            setInlineNotice('error', '课程读取失败：' + e.message);
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
        const rows = sortedRows(S.sessions.filter(item => {
            const haystack = [item.title, item.filename, item.session_id, item.started_at].join(' ').toLowerCase();
            return !q || haystack.includes(q);
        }));
        if (!rows.length) {
            list.innerHTML = '<div class="yanhe-summary">没有匹配的课堂录屏。</div>';
            updateCourseStats();
            return;
        }
        list.innerHTML = rows.map(item => {
            const sid = String(item.session_id);
            const checked = S.selected.has(sid) ? 'checked' : '';
            const duration = formatDuration(durationOf(item));
            const started = item.started_at || '时间未知';
            const size = item.size ? ' · ' + fmtBytes(item.size) : '';
            const status = item.complete_mp4 ? '已在下载目录' : '待下载';
            const statusClass = item.complete_mp4 ? 'ready' : 'waiting';
            return '<label class="yanhe-session-item">' +
                '<input type="checkbox" data-yanhe-sid="' + _escHtml(sid) + '" ' + checked + ' onchange="toggleYanheSession(this)">' +
                '<span class="yanhe-session-main">' +
                    '<span class="yanhe-session-title">' + _escHtml(item.title || ('session-' + sid)) + '</span>' +
                    '<span class="yanhe-session-meta">' + _escHtml(started + ' · ' + duration + ' · ' + (item.filename || '') + size) + '</span>' +
                '</span>' +
                '<span class="status-pill ' + statusClass + '">' + status + '</span>' +
            '</label>';
        }).join('');
        updateCourseStats();
        refreshIcons(list);
    };

    window.toggleYanheSession = function (cb) {
        const sid = String(cb.dataset.yanheSid || '');
        if (!sid) return;
        if (cb.checked) S.selected.add(sid);
        else S.selected.delete(sid);
        updateDownloadButton();
        setFlowState('download', ['course']);
    };

    window.selectAllYanheSessions = function (checked) {
        if (checked) S.sessions.forEach(item => S.selected.add(String(item.session_id)));
        else S.selected.clear();
        renderYanheSessions();
        updateDownloadButton();
        setFlowState('download', ['course']);
    };

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
        S.downloading = true;
        updateDownloadButton();
        if (btn) btn.disabled = true;
        try {
            const diag = await api('/api/diagnostics/status');
            if (!diag.ffmpeg?.available) {
                setFlowState('download', ['course'], 'download');
                setInlineNotice('error', '未找到 ffmpeg，无法下载延河录屏。请先放入 bin\\ffmpeg.exe 或在设置里配置。', '<button class="notice-action" onclick="openSettingsDrawer()">配置 ffmpeg</button>');
                showToast('未找到 ffmpeg，无法下载延河录屏。', 'error', 6000);
                return;
            }
            const batchId = await ensureBatch();
            const progress = $('yanheDownloadProgress');
            const goBatch = $('btnYanheGoBatch');
            const bar = $('yanheDownloadBar');
            if (progress) progress.style.display = '';
            if (goBatch) goBatch.style.display = 'none';
            if (bar) bar.style.width = '0%';
            setText('yanheDownloadText', '下载任务已创建，完成后会进入批量未选中区');
            setFlowState('download', ['course']);
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
                setFlowState('download', ['course'], 'download');
                setInlineNotice('error', res.message || '创建下载任务失败');
                showToast(res.message || '创建下载任务失败', 'error');
                return;
            }
            connectYanheJob(res.job.id);
            showToast('下载任务已开始', 'success');
        } catch (e) {
            setFlowState('download', ['course'], 'download');
            setInlineNotice('error', '下载启动失败：' + e.message);
            showToast('下载启动失败：' + e.message, 'error');
        } finally {
            if (!S.jobSource) S.downloading = false;
            updateDownloadButton();
        }
    };

    async function recoverBatchAfterDownload() {
        if (typeof _recoverBatch === 'function') {
            await _recoverBatch();
        }
        if (typeof renderAllZones === 'function') {
            renderAllZones();
        }
    }

    function connectYanheJob(jobId) {
        if (S.jobSource) S.jobSource.close();
        const es = new EventSource('/api/yanhe/download-jobs/' + jobId + '/events');
        S.jobSource = es;
        let terminal = false;
        es.onmessage = async (event) => {
            const data = JSON.parse(event.data);
            const job = data.job || {};
            const pct = Math.max(0, Math.min(100, Math.round(job.progress || 0)));
            const bar = $('yanheDownloadBar');
            if (bar) bar.style.width = pct + '%';
            if (data.type === 'course_loaded' || data.type === 'job_status') {
                setText('yanheDownloadText', job.message || '正在准备下载列表');
            } else if (data.type === 'item_started') {
                const c = data.current || {};
                setText('yanheDownloadText', '准备下载 ' + (c.index || 1) + '/' + (c.total || S.selected.size) + ' · ' + (c.filename || c.title || '录屏'));
            } else if (data.type === 'download_progress') {
                const name = data.current?.filename || '';
                const itemPct = data.item_progress !== null && data.item_progress !== undefined ? Math.round(data.item_progress) + '%' : '计算中';
                const sizeText = data.expected_size ? fmtBytes(data.current_size || 0) + '/' + fmtBytes(data.expected_size) : '';
                const speed = data.speed ? ' · ' + data.speed : '';
                setText('yanheDownloadText', '总进度 ' + pct + '% · 当前 ' + itemPct + ' · ' + name + (sizeText ? ' · ' + sizeText : '') + speed);
            } else if (data.type === 'item_done') {
                const done = (job.downloaded || []).length;
                const total = job.items?.length || S.selected.size;
                setText('yanheDownloadText', '已加入未选中区 ' + done + '/' + total + '：' + (data.item?.name || '视频'));
            } else if (data.type === 'job_done') {
                terminal = true;
                if (bar) bar.style.width = '100%';
                setText('yanheDownloadText', '下载完成，视频已加入批量未选中区。下一步：到未选中区勾选并移入处理队列。');
                setInlineNotice('success', '下载完成。请进入批量未选中区，勾选视频后手动开始 PPT 提取。', '<button class="notice-action" onclick="switchWorkspace(\'batch\')">去未选中区</button>');
                const goBatch = $('btnYanheGoBatch');
                if (goBatch) goBatch.style.display = '';
                setFlowState('batch', ['course', 'download']);
                S.downloading = false;
                S.jobSource = null;
                updateDownloadButton();
                await recoverBatchAfterDownload();
                showToast('延河下载完成，可到批量提取区处理', 'success');
                es.close();
            } else if (data.type === 'job_error') {
                terminal = true;
                const msg = data.message || job.message || '未知错误';
                setText('yanheDownloadText', '下载失败：' + msg);
                setInlineNotice('error', '下载失败：' + msg);
                setFlowState('download', ['course'], 'download');
                S.downloading = false;
                S.jobSource = null;
                updateDownloadButton();
                showToast('下载失败：' + msg, 'error');
                es.close();
            } else if (data.type === 'job_cancelled') {
                terminal = true;
                setText('yanheDownloadText', '下载已取消');
                setFlowState('download', ['course']);
                S.downloading = false;
                S.jobSource = null;
                updateDownloadButton();
                es.close();
            }
        };
        es.onerror = () => {
            if (terminal || S.jobSource !== es) return;
            setText('yanheDownloadText', '下载事件连接中断，任务可能仍在后台运行。');
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

    window.refreshYanheStatus = refreshYanheStatus;

    document.addEventListener('DOMContentLoaded', () => {
        setFlowState('course', []);
        refreshYanheStatus();
        updateDownloadButton();
    });
})();
