from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path
from typing import Iterable


APP_NAME = "VidSlide"
BRANCH_NAME = "yanhe-batch-v0.4.2"


def _local_app_data() -> Path:
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA")
        if base:
            return Path(base)
        return Path.home() / "AppData" / "Local"
    return Path(os.environ.get("XDG_STATE_HOME") or (Path.home() / ".local" / "state"))


def workspace_root() -> Path:
    return _local_app_data() / APP_NAME / BRANCH_NAME


def downloads_dir() -> Path:
    return workspace_root() / "downloads"


def imports_dir() -> Path:
    return workspace_root() / "imports"


def chrome_profile_dir() -> Path:
    return workspace_root() / "chrome-profile"


def config_dir() -> Path:
    return workspace_root() / "config"


def sessions_dir() -> Path:
    return workspace_root() / "sessions"


def logs_dir() -> Path:
    return workspace_root() / "logs"


def managed_dirs() -> dict[str, Path]:
    return {
        "workspace": workspace_root(),
        "downloads": downloads_dir(),
        "imports": imports_dir(),
        "chrome-profile": chrome_profile_dir(),
        "config": config_dir(),
        "sessions": sessions_dir(),
        "logs": logs_dir(),
    }


def ensure_workspace() -> Path:
    root = workspace_root()
    for path in managed_dirs().values():
        path.mkdir(parents=True, exist_ok=True)
    return root


def resolve_managed_path(path: str | Path) -> Path:
    ensure_workspace()
    resolved = Path(path).expanduser().resolve()
    root = workspace_root().resolve()
    if resolved != root and root not in resolved.parents:
        raise ValueError(f"path is outside VidSlide managed workspace: {resolved}")
    return resolved


def is_managed_path(path: str | Path) -> bool:
    try:
        resolve_managed_path(path)
        return True
    except Exception:
        return False


def dir_size(path: Path) -> int:
    if not path.exists():
        return 0
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            fp = Path(root) / name
            try:
                total += fp.stat().st_size
            except OSError:
                pass
    return total


def storage_status() -> dict:
    ensure_workspace()
    root = workspace_root()
    usage = shutil.disk_usage(root)
    dirs = {}
    for key, path in managed_dirs().items():
        dirs[key] = {
            "path": str(path),
            "exists": path.exists(),
            "size_bytes": dir_size(path),
            "managed": True,
        }
    return {
        "workspace": str(root),
        "disk": {
            "total_bytes": usage.total,
            "used_bytes": usage.used,
            "free_bytes": usage.free,
            "percent": round((usage.used / usage.total) * 100, 1) if usage.total else 0,
        },
        "dirs": dirs,
    }


def open_path(kind: str = "workspace") -> Path:
    ensure_workspace()
    path = managed_dirs().get(kind, workspace_root())
    path = resolve_managed_path(path)
    if os.name == "nt":
        os.startfile(str(path))  # type: ignore[attr-defined]
    elif sys_platform := os.environ.get("OSTYPE", ""):
        subprocess.Popen(["open" if "darwin" in sys_platform else "xdg-open", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path)])
    return path


def clear_managed_dir(kind: str) -> dict:
    ensure_workspace()
    allowed = {"downloads", "imports", "sessions", "chrome-profile", "logs"}
    if kind not in allowed:
        raise ValueError(f"cleanup target is not allowed: {kind}")
    path = resolve_managed_path(managed_dirs()[kind])
    removed = 0
    if path.exists():
        for child in path.iterdir():
            target = resolve_managed_path(child)
            if target.is_dir():
                shutil.rmtree(target, ignore_errors=True)
            else:
                try:
                    target.unlink()
                except FileNotFoundError:
                    pass
            removed += 1
    path.mkdir(parents=True, exist_ok=True)
    return {"target": kind, "path": str(path), "removed_entries": removed}


def reset_all() -> dict:
    root = resolve_managed_path(workspace_root())
    removed = root.exists()
    if root.exists():
        shutil.rmtree(root, ignore_errors=True)
    ensure_workspace()
    return {"target": "workspace", "path": str(root), "removed": removed}

