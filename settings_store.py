from __future__ import annotations

import json
import os
import shutil
import tempfile
from copy import deepcopy
from pathlib import Path
from typing import Any

import storage


SETTINGS_VERSION = 1
_ALLOWED_SPEED_MODES = {"eco", "fast"}


DEFAULT_SETTINGS: dict[str, Any] = {
    "version": SETTINGS_VERSION,
    "appearance": {
        "theme": "system",
        "show_quick_theme_toggle": True,
        "reduced_motion": False,
        "completion_confetti": True,
    },
    "download": {
        "ffmpeg_path": "",
        "download_dir": "",
        "auto_add_to_batch": True,
        "clean_source_after_successful_extraction": True,
        "use_getvideo_profile_for_dev": True,
    },
    "yanhe": {
        "chrome_profile_dir": "",
        "last_login_check_at": 0,
        "last_login_status": "unknown",
    },
    "extraction": {
        "threshold": 5.0,
        "use_roi": True,
        "fast_mode": True,
        "use_gpu": True,
        "enable_history": True,
        "max_history": 5,
        "speed_mode": "fast",
        "remember_params": True,
    },
    "batch": {
        "default_workers": 1,
        "auto_recommend_workers": True,
        "remember_naming": True,
        "course_name_history": [],
    },
    "diagnostics": {
        "remember_task_metrics": True,
        "show_advanced_hardware": False,
    },
}


def settings_path() -> Path:
    return storage.config_dir() / "settings.json"


def _deep_merge(base: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    merged = deepcopy(base)
    for key, value in (patch or {}).items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def _normalize_settings(data: dict[str, Any]) -> dict[str, Any]:
    settings = _deep_merge(DEFAULT_SETTINGS, data or {})
    legacy_download_dir = str(storage.workspace_root() / "downloads")
    current_download_dir = str(settings["download"].get("download_dir") or "")
    if not current_download_dir or current_download_dir == legacy_download_dir:
        settings["download"]["download_dir"] = str(storage.downloads_dir())
    if not settings["yanhe"].get("chrome_profile_dir"):
        settings["yanhe"]["chrome_profile_dir"] = str(storage.chrome_profile_dir())
    extraction = settings["extraction"]
    try:
        threshold = float(extraction.get("threshold", DEFAULT_SETTINGS["extraction"]["threshold"]))
    except (TypeError, ValueError):
        threshold = DEFAULT_SETTINGS["extraction"]["threshold"]
    extraction["threshold"] = min(15.0, max(4.5, threshold))
    if extraction.get("speed_mode") not in _ALLOWED_SPEED_MODES:
        extraction["speed_mode"] = "fast"
    settings["version"] = SETTINGS_VERSION
    return settings


def load_settings() -> dict[str, Any]:
    storage.ensure_workspace()
    path = settings_path()
    if not path.exists():
        settings = _normalize_settings({})
        save_settings(settings)
        return settings
    try:
        with path.open("r", encoding="utf-8") as f:
            raw = json.load(f)
    except Exception:
        raw = {}
    settings = _normalize_settings(raw)
    if settings != raw:
        save_settings(settings)
    return settings


def save_settings(settings: dict[str, Any]) -> dict[str, Any]:
    storage.ensure_workspace()
    normalized = _normalize_settings(settings)
    path = settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix="settings-", suffix=".json", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(normalized, f, ensure_ascii=False, indent=2)
            f.write("\n")
        try:
            os.replace(tmp_name, path)
        except OSError:
            shutil.copyfile(tmp_name, path)
    finally:
        try:
            if os.path.exists(tmp_name):
                os.unlink(tmp_name)
        except OSError:
            pass
    return normalized


def update_settings(patch: dict[str, Any]) -> dict[str, Any]:
    current = load_settings()
    updated = _deep_merge(current, patch or {})
    return save_settings(updated)


def reset_settings() -> dict[str, Any]:
    return save_settings({})
