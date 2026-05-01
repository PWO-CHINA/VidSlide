from __future__ import annotations

import json
import queue
import threading
import time
import traceback
import uuid
from pathlib import Path
from typing import Any

import batch_manager
import settings_store
import storage
import yanhe_downloader_core as core


MAX_EVENT_QUEUE_SIZE = 200

_jobs_lock = threading.RLock()
_jobs: dict[str, dict[str, Any]] = {}
_login_proc: Any | None = None
_login_cdp_base: str | None = None


def get_getvideo_profile_dir() -> Path:
    if core.os.name == "nt":
        base = Path(core.os.environ.get("LOCALAPPDATA") or (Path.home() / "AppData" / "Local"))
    else:
        base = Path(core.os.environ.get("XDG_STATE_HOME") or (Path.home() / ".local" / "state"))
    return base / "YanhektDownloader" / "chrome-profile"


def selected_profile_dir(settings: dict[str, Any] | None = None) -> Path:
    settings = settings or settings_store.load_settings()
    if settings.get("download", {}).get("use_getvideo_profile_for_dev") and get_getvideo_profile_dir().exists():
        return get_getvideo_profile_dir()
    configured = settings.get("yanhe", {}).get("chrome_profile_dir") or ""
    return Path(configured) if configured else storage.chrome_profile_dir()


def _course_url(course_input: str) -> str:
    value = str(course_input or "").strip()
    if not value:
        raise ValueError("course input is empty")
    if value.isdigit():
        return f"{core.YANHE_HOST}/course/{value}"
    return value


def _close_browser(browser: Any | None, proc: Any | None) -> None:
    try:
        if browser is not None:
            browser.call("Browser.close", {}, timeout=3)
    except Exception:
        pass
    try:
        if proc is not None and proc.poll() is None:
            proc.terminate()
    except Exception:
        pass


def _open_yanhe_browser(course_input: str, headless: bool = True) -> tuple[Any, str, Any, str, str]:
    settings = settings_store.load_settings()
    profile = selected_profile_dir(settings)
    chrome = core.find_chrome(None)
    url = _course_url(course_input)
    proc, cdp_base = core.launch_dedicated_chrome(chrome, profile, url, headless=headless)
    cdp, session_id, _target = core.connect_yanhe_session(cdp_base, url)
    return proc, cdp_base, cdp, session_id, str(profile)


def check_login_status(headless: bool = True) -> dict[str, Any]:
    proc = None
    cdp = None
    profile = str(selected_profile_dir())
    result: dict[str, Any] = {
        "status": "unknown",
        "usable": False,
        "profile": profile,
        "profile_exists": Path(profile).exists(),
        "checked_at": time.time(),
    }
    try:
        proc, _base, cdp, session_id, profile = _open_yanhe_browser(core.YANHE_HOST, headless=headless)
        result["profile"] = profile
        auth = cdp.evaluate(
            r"""
(() => {
  let parsed = {};
  try { parsed = JSON.parse(localStorage.getItem('auth') || '{}'); } catch (e) {}
  const expiredAt = Number(parsed.expired_at || 0);
  return {
    href: location.href,
    title: document.title,
    has_auth_record: Boolean(localStorage.getItem('auth')),
    has_token: Boolean(parsed.token),
    expired_at: expiredAt || null,
    expires_in_ms: expiredAt ? (expiredAt - Date.now()) : null
  };
})()
""",
            timeout=10,
            session_id=session_id,
        )
        result["auth"] = auth
        if not auth.get("has_token") or not auth.get("expires_in_ms") or auth.get("expires_in_ms") <= 0:
            result["status"] = "login_required"
            return result
        user = cdp.evaluate(
            r"""
(async () => {
  const auth = JSON.parse(localStorage.getItem('auth') || '{}');
  const response = await fetch('https://cbiz.yanhekt.cn/v1/user', {
    headers: {
      'Authorization': 'Bearer ' + auth.token,
      'Content-Type': 'application/json',
      'Xdomain-Client': 'web_user'
    }
  });
  const body = await response.json();
  return {
    http_status: response.status,
    code: body.code,
    has_badge: Boolean(body.data && body.data.badge),
    user_name: body.data && (body.data.name || body.data.nickname || body.data.real_name || '')
  };
})()
""",
            timeout=20,
            session_id=session_id,
        )
        result["user"] = user
        result["usable"] = user.get("http_status") == 200 and user.get("code") == 0
        result["status"] = "usable" if result["usable"] else "api_failed"
        return result
    except Exception as exc:
        result["status"] = "check_failed"
        result["message"] = str(exc)
        result["error_type"] = type(exc).__name__
        return result
    finally:
        _close_browser(cdp, proc)
        try:
            settings_store.update_settings({
                "yanhe": {
                    "last_login_check_at": result["checked_at"],
                    "last_login_status": result["status"],
                }
            })
        except Exception:
            pass


def start_login_browser() -> dict[str, Any]:
    global _login_proc, _login_cdp_base
    settings = settings_store.load_settings()
    profile = selected_profile_dir(settings)
    chrome = core.find_chrome(None)
    if _login_proc is not None and _login_proc.poll() is None:
        return {"status": "already_open", "profile": str(profile), "cdp_base": _login_cdp_base}
    _login_proc, _login_cdp_base = core.launch_dedicated_chrome(
        chrome,
        profile,
        core.YANHE_HOST,
        headless=False,
    )
    return {"status": "opened", "profile": str(profile), "cdp_base": _login_cdp_base}


def use_getvideo_profile() -> dict[str, Any]:
    profile = get_getvideo_profile_dir()
    if not profile.exists():
        return {"success": False, "message": "getvideo profile does not exist", "profile": str(profile)}
    settings = settings_store.update_settings({"download": {"use_getvideo_profile_for_dev": True}})
    return {"success": True, "profile": str(profile), "settings": settings}


def clear_vidslide_login_profile() -> dict[str, Any]:
    return storage.clear_managed_dir("chrome-profile")


def load_course(course_input: str, output_dir: str | None = None) -> dict[str, Any]:
    proc = None
    cdp = None
    try:
        output = Path(output_dir or settings_store.load_settings()["download"]["download_dir"])
        output.mkdir(parents=True, exist_ok=True)
        proc, _base, cdp, session_id, profile = _open_yanhe_browser(course_input, headless=True)
        core.wait_for_page_ready(cdp, session_id=session_id, timeout=30)
        info = cdp.evaluate(core.course_info_expression(_course_url(course_input)), timeout=90, session_id=session_id)
        planned = core.build_download_plan(info.get("items", []), output)
        payload = core.plan_json_payload(info, planned, output)
        payload["profile"] = profile
        payload["login_status"] = "usable"
        payload["ffmpeg"] = ffmpeg_status()
        return payload
    except Exception as exc:
        login = check_login_status(headless=True)
        if login.get("status") != "usable":
            return {
                "login_status": login.get("status"),
                "login": login,
                "error": str(exc),
                "items": [],
                "count": 0,
            }
        raise
    finally:
        _close_browser(cdp, proc)


def ffmpeg_status(user_path: str | None = None) -> dict[str, Any]:
    try:
        settings = settings_store.load_settings()
        path = core.find_ffmpeg(user_path or settings.get("download", {}).get("ffmpeg_path") or None)
        return {"available": True, "path": path}
    except Exception as exc:
        return {"available": False, "message": str(exc)}


def _new_job(payload: dict[str, Any]) -> dict[str, Any]:
    jid = uuid.uuid4().hex[:10]
    now = time.time()
    job = {
        "id": jid,
        "status": "planning",
        "created_at": now,
        "updated_at": now,
        "payload": payload,
        "course": None,
        "items": [],
        "current": None,
        "progress": 0,
        "message": "queued",
        "downloaded": [],
        "failed": [],
        "batch_id": payload.get("batch_id"),
        "cancel": False,
        "event_queues": [],
        "thread": None,
    }
    with _jobs_lock:
        _jobs[jid] = job
    return job


def _job_snapshot(job: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": job["id"],
        "status": job["status"],
        "created_at": job["created_at"],
        "updated_at": job["updated_at"],
        "course": job.get("course"),
        "items": job.get("items", []),
        "current": job.get("current"),
        "progress": job.get("progress", 0),
        "message": job.get("message", ""),
        "downloaded": job.get("downloaded", []),
        "failed": job.get("failed", []),
        "batch_id": job.get("batch_id"),
    }


def _publish(job: dict[str, Any], event: dict[str, Any]) -> None:
    event["job_id"] = job["id"]
    event["status"] = job.get("status")
    event["updated_at"] = time.time()
    job["updated_at"] = event["updated_at"]
    for q in list(job.get("event_queues", [])):
        try:
            q.put_nowait(event)
        except queue.Full:
            pass


def get_job(job_id: str) -> dict[str, Any] | None:
    with _jobs_lock:
        job = _jobs.get(job_id)
    return _job_snapshot(job) if job else None


def create_download_job(payload: dict[str, Any], sessions_root: str) -> dict[str, Any]:
    job = _new_job(payload)
    t = threading.Thread(target=_run_download_job, args=(job, sessions_root), daemon=True)
    job["thread"] = t
    t.start()
    return _job_snapshot(job)


def cancel_job(job_id: str) -> bool:
    with _jobs_lock:
        job = _jobs.get(job_id)
    if not job:
        return False
    job["cancel"] = True
    job["message"] = "cancelling"
    _publish(job, {"type": "cancel_requested", "message": "cancelling"})
    return True


def _ensure_batch(job: dict[str, Any], sessions_root: str) -> str:
    bid = job.get("batch_id")
    if bid and batch_manager.get_batch_state(bid):
        return bid
    settings = settings_store.load_settings()
    params = dict(settings.get("extraction", {}), classroom_mode="ppt")
    workers = int(settings.get("batch", {}).get("default_workers", 1) or 1)
    bid = batch_manager.create_batch(sessions_root, params, workers)
    job["batch_id"] = bid
    return bid


def _run_download_job(job: dict[str, Any], sessions_root: str) -> None:
    proc = None
    cdp = None
    try:
        payload = job["payload"]
        course_input = payload.get("course_input") or payload.get("course_url") or payload.get("course_id")
        selected_ids = {str(x) for x in payload.get("session_ids", []) if str(x).strip()}
        overwrite = bool(payload.get("overwrite", False))
        output_dir = Path(payload.get("output_dir") or settings_store.load_settings()["download"]["download_dir"])
        output_dir.mkdir(parents=True, exist_ok=True)
        ffmpeg = core.find_ffmpeg(payload.get("ffmpeg_path") or settings_store.load_settings()["download"].get("ffmpeg_path") or None)

        job["status"] = "planning"
        job["message"] = "loading course"
        _publish(job, {"type": "job_status", "job": _job_snapshot(job)})

        proc, _base, cdp, session_id, profile = _open_yanhe_browser(str(course_input), headless=True)
        core.wait_for_page_ready(cdp, session_id=session_id, timeout=30)
        info = cdp.evaluate(core.course_info_expression(_course_url(str(course_input))), timeout=90, session_id=session_id)
        planned = core.build_download_plan(info.get("items", []), output_dir)
        if selected_ids:
            planned = core.filter_plan_by_session_ids(planned, selected_ids)
        job["course"] = {"course_id": info.get("course_id"), "course_name": info.get("course_name"), "profile": profile}
        job["items"] = [
            {
                "session_id": item.get("session_id"),
                "title": item.get("title"),
                "filename": output.name,
                "output_path": str(output),
                "status": "waiting",
                "progress": 0,
            }
            for item, output in planned
        ]
        _publish(job, {"type": "course_loaded", "job": _job_snapshot(job)})

        if not planned:
            job["status"] = "completed"
            job["message"] = "no selected recordings"
            _publish(job, {"type": "job_done", "job": _job_snapshot(job)})
            return

        batch_id = _ensure_batch(job, sessions_root)
        total = len(planned)
        completed = 0
        job["status"] = "downloading"

        for index, (item, output) in enumerate(planned):
            if job.get("cancel"):
                raise InterruptedError("download job cancelled")
            job["current"] = {
                "index": index + 1,
                "total": total,
                "session_id": item.get("session_id"),
                "title": item.get("title"),
                "filename": output.name,
                "output_path": str(output),
            }
            job["message"] = f"downloading {index + 1}/{total}"
            _publish(job, {"type": "item_started", "current": job["current"], "job": _job_snapshot(job)})

            if output.exists() and core.is_probably_complete_mp4(output) and not overwrite:
                item_result = {"path": str(output), "name": output.stem, "status": "exists"}
                job["downloaded"].append(item_result)
                batch_manager.add_videos(batch_id, [{"path": str(output), "name": output.stem}])
                completed += 1
                job["progress"] = int(completed * 100 / total)
                _publish(job, {"type": "item_done", "item": item_result, "job": _job_snapshot(job)})
                continue

            signed = cdp.evaluate(
                core.sign_url_expression(item["raw_vga"], str(info["user_badge"])),
                timeout=60,
                session_id=session_id,
            )
            duration = core.parse_duration(item.get("duration"))
            expected_size = None
            try:
                expected_size = core.estimate_hls_size(signed, item.get("session_url") or _course_url(str(course_input)), duration)
            except Exception:
                expected_size = None

            def on_progress(**data: Any) -> None:
                item_pct = None
                if data.get("duration") and data.get("current_time") is not None:
                    item_pct = max(0, min(100, data["current_time"] * 100 / data["duration"]))
                elif data.get("expected_size") and data.get("current_size") is not None:
                    item_pct = max(0, min(100, data["current_size"] * 100 / data["expected_size"]))
                aggregate = ((completed * 100) + (item_pct or 0)) / total
                job["progress"] = int(aggregate)
                _publish(job, {
                    "type": "download_progress",
                    "current": job["current"],
                    "item_progress": item_pct,
                    "current_size": data.get("current_size"),
                    "expected_size": data.get("expected_size"),
                    "speed": data.get("speed"),
                    "job": _job_snapshot(job),
                })

            core.run_ffmpeg(
                ffmpeg,
                signed,
                output,
                item.get("session_url") or _course_url(str(course_input)),
                overwrite,
                duration,
                expected_size,
                f"{index + 1}/{total}",
                progress_lines=False,
                progress_callback=on_progress,
                should_cancel=lambda: bool(job.get("cancel")),
            )
            item_result = {"path": str(output), "name": output.stem, "status": "downloaded"}
            job["downloaded"].append(item_result)
            batch_manager.add_videos(batch_id, [{"path": str(output), "name": output.stem}])
            completed += 1
            job["progress"] = int(completed * 100 / total)
            _publish(job, {"type": "item_done", "item": item_result, "job": _job_snapshot(job)})

        job["status"] = "completed"
        job["message"] = "download completed"
        job["progress"] = 100
        _publish(job, {"type": "job_done", "job": _job_snapshot(job)})
    except InterruptedError as exc:
        job["status"] = "cancelled"
        job["message"] = str(exc)
        _publish(job, {"type": "job_cancelled", "job": _job_snapshot(job)})
    except Exception as exc:
        job["status"] = "error"
        job["message"] = str(exc)
        job["trace_tail"] = traceback.format_exc().splitlines()[-8:]
        _publish(job, {"type": "job_error", "message": str(exc), "job": _job_snapshot(job)})
    finally:
        _close_browser(cdp, proc)


def generate_job_sse(job_id: str):
    with _jobs_lock:
        job = _jobs.get(job_id)
    if not job:
        return None
    q: queue.Queue = queue.Queue(maxsize=MAX_EVENT_QUEUE_SIZE)
    job["event_queues"].append(q)

    def cleanup() -> None:
        try:
            job["event_queues"].remove(q)
        except ValueError:
            pass

    def gen():
        try:
            yield f"data: {json.dumps({'type': 'init', 'job': _job_snapshot(job)}, ensure_ascii=False)}\n\n"
            while True:
                try:
                    event = q.get(timeout=15)
                    yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
                    if job.get("status") in {"completed", "error", "cancelled"} and q.empty():
                        break
                except queue.Empty:
                    yield f"data: {json.dumps({'type': 'heartbeat', 'job_id': job_id}, ensure_ascii=False)}\n\n"
        finally:
            cleanup()

    return gen

