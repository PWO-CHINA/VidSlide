(function () {
    let currentSettings = null;
    function $(id) { return document.getElementById(id); }

    function bytes(value) {
        if (!value) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let n = Number(value);
        let i = 0;
        while (n >= 1024 && i < units.length - 1) {
            n /= 1024;
            i++;
        }
        return (i === 0 ? n.toFixed(0) : n.toFixed(1)) + ' ' + units[i];
    }

    function normalizePath(path) {
        return String(path || '').replace(/\//g, '\\').toLowerCase();
    }

    function shortPath(path) {
        const text = String(path || '');
        if (text.length <= 58) return text;
        const parts = text.split(/[\\/]/).filter(Boolean);
        if (parts.length < 3) return text.slice(0, 24) + '...' + text.slice(-26);
        const drive = /^[a-z]:/i.test(text) ? text.slice(0, 2) + '\\' : '';
        return drive + '...' + parts.slice(-3).join('\\');
    }

    function sourceLabel(source) {
        const map = {
            configured: '手动配置',
            bundled: '内置 bin\\ffmpeg.exe',
            app: '随应用提供',
            PATH: '系统 PATH',
            getvideo: 'getvideo 参考目录',
        };
        return map[source] || source || '候选项';
    }

    function activeFfmpeg(ffmpeg) {
        if (!ffmpeg?.available) return { label: '未找到', path: '', source: '' };
        const path = normalizePath(ffmpeg.path);
        const match = (ffmpeg.candidates || []).find(item => normalizePath(item.path) === path);
        return {
            label: sourceLabel(match?.source || 'configured'),
            path: ffmpeg.path || '',
            source: match?.source || '',
        };
    }

    function profileModeText(settings) {
        return settings?.download?.use_getvideo_profile_for_dev
            ? '临时复用 getvideo 的本机 Chrome profile'
            : '使用 VidSlide 专用 Chrome profile';
    }

    window.openSettingsDrawer = async function () {
        $('settingsBackdrop')?.classList.add('open');
        $('settingsDrawer')?.classList.add('open');
        if ($('settingsDrawer')) $('settingsDrawer').setAttribute('aria-hidden', 'false');
        await loadSettingsDrawer();
        refreshIcons(document);
    };

    window.closeSettingsDrawer = function () {
        $('settingsBackdrop')?.classList.remove('open');
        $('settingsDrawer')?.classList.remove('open');
        if ($('settingsDrawer')) $('settingsDrawer').setAttribute('aria-hidden', 'true');
    };

    async function loadSettingsDrawer() {
        try {
            const res = await api('/api/settings');
            if (!res.success) return;
            currentSettings = res.settings;
            $('settingFfmpegPath').value = currentSettings.download.ffmpeg_path || '';
            $('settingDownloadDir').value = currentSettings.download.download_dir || '';
            $('settingUseGetvideoProfile').checked = !!currentSettings.download.use_getvideo_profile_for_dev;
            $('settingCleanSource').checked = !!currentSettings.download.clean_source_after_successful_extraction;
            $('settingThreshold').value = currentSettings.extraction.threshold;
            $('settingUseRoi').checked = !!currentSettings.extraction.use_roi;
            $('settingFastMode').checked = !!currentSettings.extraction.fast_mode;
            $('settingUseGpu').checked = !!currentSettings.extraction.use_gpu;
            $('settingSpeedMode').value = currentSettings.extraction.speed_mode || 'fast';
            await loadStorageInfo();
            await loadDiagnostics();
        } catch (e) {
            showToast('设置读取失败：' + e.message, 'error');
        }
    }

    async function loadStorageInfo() {
        const box = $('settingsStorageInfo');
        if (!box) return;
        try {
            const res = await api('/api/storage/status');
            if (!res.success) throw new Error(res.message || 'storage failed');
            const downloadDisk = res.download_disk || res.disk || {};
            const downloadDir = res.dirs.downloads.path;
            const isF = /^f:[\\/]/i.test(downloadDir);
            box.innerHTML =
                '<div class="settings-kv"><span>工作区</span><code>' + _escHtml(res.workspace) + '</code></div>' +
                '<div class="settings-kv"><span>下载目录</span><code>' + _escHtml(downloadDir) + '</code></div>' +
                '<div class="settings-kv"><span>下载盘</span><b>' + (isF ? 'F 盘' : '非 F 盘') + ' · 剩余 ' + bytes(downloadDisk.free_bytes) + '</b></div>' +
                '<div class="settings-kv"><span>目录占用</span><b>downloads ' + bytes(res.dirs.downloads.size_bytes) + ' · imports ' + bytes(res.dirs.imports.size_bytes) + '</b></div>';
        } catch (e) {
            box.textContent = '存储状态读取失败：' + e.message;
        }
    }

    window.loadDiagnostics = async function () {
        const box = $('settingsDiagnostics');
        if (!box) return;
        try {
            const res = await api('/api/diagnostics/status');
            if (!res.success) throw new Error(res.message || 'diagnostics failed');
            renderFfmpegCandidates(res.ffmpeg || {});
            const active = activeFfmpeg(res.ffmpeg || {});
            const cdn = res.external_asset_refs?.length ? res.external_asset_refs.join(', ') : '无';
            const loginStatus = res.login.last_status || 'unknown';
            const profile = res.login.profile || '';
            box.innerHTML =
                '<div class="settings-kv"><span>当前 ffmpeg</span><b>' + _escHtml(active.label) + '</b></div>' +
                '<div class="settings-kv"><span>ffmpeg 路径</span><code>' + _escHtml(active.path || '未找到') + '</code></div>' +
                '<div class="settings-kv"><span>登录状态</span><b>' + _escHtml(loginStatus) + '</b></div>' +
                '<div class="settings-kv"><span>Profile</span><code>' + _escHtml(shortPath(profile)) + '</code></div>' +
                '<div class="settings-kv"><span>Profile 模式</span><b>' + _escHtml(profileModeText(currentSettings)) + '</b></div>' +
                '<div class="settings-kv"><span>推荐并发</span><b>' + res.max_batch_workers + '</b></div>' +
                '<div class="settings-kv"><span>外部资源引用</span><b>' + _escHtml(cdn) + '</b></div>';
        } catch (e) {
            box.textContent = '诊断失败：' + e.message;
        }
    };

    function renderFfmpegCandidates(ffmpeg) {
        const box = $('settingsFfmpegCandidates');
        if (!box) return;
        const candidates = ffmpeg.candidates || [];
        const activePath = normalizePath(ffmpeg.path);
        if (!candidates.length) {
            box.textContent = '未发现 ffmpeg 候选。建议放入项目 bin\\ffmpeg.exe，或手动填写完整路径。';
            return;
        }
        box.innerHTML = '<div class="settings-mini-title">检测到的 ffmpeg 候选，当前生效项会高亮</div>' + candidates.map((item, index) => {
            const isActive = activePath && normalizePath(item.path) === activePath;
            return '<button type="button" class="candidate-btn' + (isActive ? ' active' : '') + '" data-index="' + index + '">' +
                '<span>' + (isActive ? '当前生效 · ' : '') + _escHtml(sourceLabel(item.source)) + '</span>' +
                '<code>' + _escHtml(item.path || '') + '</code>' +
            '</button>';
        }).join('');
        box.querySelectorAll('.candidate-btn').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const item = candidates[Number(btn.dataset.index)];
                if (!item?.path) return;
                $('settingFfmpegPath').value = item.path;
                await saveSettingsDrawer();
                await loadDiagnostics();
            });
        });
    }

    window.saveSettingsDrawer = async function () {
        try {
            const patch = {
                download: {
                    ffmpeg_path: $('settingFfmpegPath').value.trim(),
                    download_dir: $('settingDownloadDir').value.trim(),
                    use_getvideo_profile_for_dev: $('settingUseGetvideoProfile').checked,
                    clean_source_after_successful_extraction: $('settingCleanSource').checked,
                },
                extraction: {
                    threshold: parseFloat($('settingThreshold').value || '5'),
                    use_roi: $('settingUseRoi').checked,
                    fast_mode: $('settingFastMode').checked,
                    use_gpu: $('settingUseGpu').checked,
                    speed_mode: $('settingSpeedMode').value,
                },
            };
            const res = await api('/api/settings', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(patch),
            });
            if (!res.success) throw new Error(res.message || 'save failed');
            currentSettings = res.settings;
            await loadStorageInfo();
            await loadDiagnostics();
            if (typeof window.refreshYanheStatus === 'function') await window.refreshYanheStatus();
            showToast('设置已保存', 'success');
        } catch (e) {
            showToast('设置保存失败：' + e.message, 'error');
        }
    };

    window.openManagedStorage = async function (kind) {
        try {
            const res = await api('/api/storage/open', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ kind }),
            });
            if (!res.success) throw new Error(res.message || 'open failed');
        } catch (e) {
            showToast('打开目录失败：' + e.message, 'error');
        }
    };

    window.checkYanheLogin = async function () {
        try {
            const res = await api('/api/yanhe/login/status');
            const login = res.login || {};
            showToast(login.usable ? '延河登录状态可用' : '需要重新登录延河', login.usable ? 'success' : 'warning');
            await loadDiagnostics();
            if (typeof window.refreshYanheStatus === 'function') await window.refreshYanheStatus();
        } catch (e) {
            showToast('登录检查失败：' + e.message, 'error');
        }
    };
})();
