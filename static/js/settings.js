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
            box.innerHTML = '工作区：' + _escHtml(res.workspace) + '<br>' +
                '磁盘剩余：' + bytes(res.disk.free_bytes) + '<br>' +
                '下载目录：' + bytes(res.dirs.downloads.size_bytes) + ' · imports：' + bytes(res.dirs.imports.size_bytes);
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
            const cdn = res.external_asset_refs?.length ? res.external_asset_refs.join(', ') : '无';
            box.innerHTML = 'ffmpeg：' + (res.ffmpeg.available ? '可用' : '未找到') + (res.ffmpeg.path ? ' · ' + _escHtml(res.ffmpeg.path) : '') + '<br>' +
                '登录：' + _escHtml(res.login.last_status || 'unknown') + '<br>' +
                'profile：' + _escHtml(res.login.profile || '') + '<br>' +
                '推荐最大并发：' + res.max_batch_workers + '<br>' +
                '外部资源引用：' + _escHtml(cdn);
        } catch (e) {
            box.textContent = '诊断失败：' + e.message;
        }
    };

    window.saveSettingsDrawer = async function () {
        try {
            const patch = {
                download: {
                    ffmpeg_path: $('settingFfmpegPath').value.trim(),
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
        } catch (e) {
            showToast('登录检查失败：' + e.message, 'error');
        }
    };
})();
