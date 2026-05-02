import os
import importlib
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

import settings_store
import storage
import yanhe_download_manager as ydm
import yanhe_downloader_core as core
import batch_manager


class YanheBranchTests(unittest.TestCase):
    def setUp(self):
        self._old_localappdata = os.environ.get("LOCALAPPDATA")
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["LOCALAPPDATA"] = self.tmp.name

    def tearDown(self):
        batch_manager._batches.clear()
        ydm._jobs.clear()
        if self._old_localappdata is None:
            os.environ.pop("LOCALAPPDATA", None)
        else:
            os.environ["LOCALAPPDATA"] = self._old_localappdata
        self.tmp.cleanup()

    def test_workspace_paths_are_created_and_guarded(self):
        root = storage.ensure_workspace()
        self.assertTrue(root.exists())
        self.assertTrue(storage.downloads_dir().exists())
        self.assertTrue(storage.is_managed_path(storage.sessions_dir()))
        with self.assertRaises(ValueError):
            storage.resolve_managed_path(Path(self.tmp.name).parent)

    def test_settings_round_trip_defaults_to_managed_dirs(self):
        settings = settings_store.load_settings()
        self.assertIn("yanhe-batch-v0.4.2", settings["download"]["download_dir"])
        updated = settings_store.update_settings({"extraction": {"threshold": 7.5}})
        self.assertEqual(updated["extraction"]["threshold"], 7.5)
        self.assertEqual(settings_store.load_settings()["extraction"]["threshold"], 7.5)

    def test_settings_normalizes_formal_extraction_boundaries(self):
        updated = settings_store.update_settings({
            "extraction": {
                "threshold": 1,
                "speed_mode": "turbo",
            }
        })
        self.assertEqual(updated["extraction"]["threshold"], 4.5)
        self.assertEqual(updated["extraction"]["speed_mode"], "fast")

    def test_downloader_helpers(self):
        self.assertEqual(ydm._course_url("67968"), "https://www.yanhekt.cn/course/67968")
        self.assertEqual(core.parse_session_ids("1, 2;3\n4"), {"1", "2", "3", "4"})
        self.assertNotIn(":", core.sanitize_filename("bad:name?.mp4"))
        self.assertTrue(core.filename_for({"title": "第1周", "course_name": "生物仪器分析"}, 1).endswith("_课堂录屏.mp4"))
        with self.assertRaises(FileNotFoundError):
            core.find_ffmpeg(str(Path(self.tmp.name) / "missing-ffmpeg.exe"))

    def test_resource_dirs_include_nuitka_containing_dir(self):
        compiled_dir = Path(self.tmp.name) / "nuitka-onefile"
        compiled_dir.mkdir()
        old_compiled = getattr(core, "__compiled__", None)
        core.__compiled__ = types.SimpleNamespace(containing_dir=str(compiled_dir))
        try:
            self.assertIn(compiled_dir.resolve(), core.resource_dirs())
        finally:
            if old_compiled is None:
                delattr(core, "__compiled__")
            else:
                core.__compiled__ = old_compiled

    def test_dry_run_preflight_does_not_require_ffmpeg(self):
        result = ydm.download_preflight({"dry_run": True})
        self.assertTrue(result["ok"])
        self.assertIn("output_dir", result)

    def test_yanhe_api_batch_params_clamp_turbo_to_fast(self):
        sys.modules.pop("app", None)
        app_module = importlib.import_module("app")
        try:
            params = app_module._yanhe_batch_params({
                "threshold": "0.5",
                "speed_mode": "turbo",
                "classroom_mode": "blackboard",
                "max_history": "999",
                "use_roi": "false",
            })
        finally:
            sys.modules.pop("app", None)
        self.assertEqual(params["speed_mode"], "fast")
        self.assertEqual(params["classroom_mode"], "ppt")
        self.assertEqual(params["threshold"], 4.5)
        self.assertEqual(params["max_history"], 20)
        self.assertFalse(params["use_roi"])

    def test_batch_manager_clamps_turbo_on_create_and_update(self):
        sessions = Path(self.tmp.name) / "sessions"
        bid = batch_manager.create_batch(sessions, {
            "threshold": 3,
            "speed_mode": "turbo",
            "classroom_mode": "hybrid",
            "max_history": 1,
        }, 1)
        state = batch_manager.get_batch_state(bid)
        self.assertEqual(state["params"]["speed_mode"], "fast")
        self.assertEqual(state["params"]["classroom_mode"], "ppt")
        self.assertEqual(state["params"]["threshold"], 4.5)
        self.assertEqual(state["params"]["max_history"], 2)

        batch_manager.update_batch_params(bid, {
            "speed_mode": "turbo",
            "classroom_mode": "blackboard",
        })
        state = batch_manager.get_batch_state(bid)
        self.assertEqual(state["params"]["speed_mode"], "fast")
        self.assertEqual(state["params"]["classroom_mode"], "ppt")

    def test_recovered_batch_metadata_clamps_turbo_to_fast(self):
        sessions = Path(self.tmp.name) / "sessions"
        batch_dir = sessions / "batch_legacy"
        batch_dir.mkdir(parents=True)
        (batch_dir / "batch.json").write_text(json.dumps({
            "id": "legacy",
            "params": {
                "threshold": 3,
                "speed_mode": "turbo",
                "classroom_mode": "blackboard",
            },
            "tasks": [],
        }), encoding="utf-8")

        batch_manager.recover_batches_from_disk(str(sessions))
        state = batch_manager.get_batch_state("legacy")
        self.assertEqual(state["params"]["speed_mode"], "fast")
        self.assertEqual(state["params"]["classroom_mode"], "ppt")
        self.assertEqual(state["params"]["threshold"], 5.0)

    def test_batch_quality_flags_for_unusual_saved_counts(self):
        many = {
            "saved_count": 80,
            "fps": 30,
            "total_frames": 30 * 60 * 10,
        }
        few = {
            "saved_count": 1,
            "fps": 30,
            "total_frames": 30 * 60 * 45,
        }
        normal = {
            "saved_count": 18,
            "fps": 30,
            "total_frames": 30 * 60 * 10,
        }
        self.assertTrue(any(f["code"] == "too_many" for f in batch_manager._quality_flags_for_task(many, {"threshold": 5})))
        self.assertTrue(any(f["code"] == "too_few" for f in batch_manager._quality_flags_for_task(few, {"threshold": 5})))
        self.assertEqual(batch_manager._quality_flags_for_task(normal, {"threshold": 5}), [])

    def test_batch_resume_counts_existing_and_new_saved_images(self):
        video = Path(self.tmp.name) / "sample.mp4"
        video.write_bytes(b"not a real mp4")
        bid = batch_manager.create_batch(Path(self.tmp.name) / "sessions", {"threshold": 5}, 1)
        task = {
            "id": "vid1",
            "video_path": str(video),
            "display_name": "sample",
            "zone": "queue",
            "status": "waiting",
            "progress": 0,
            "message": "",
            "saved_count": 4,
            "eta_seconds": -1,
            "elapsed_seconds": 0,
            "error_message": "",
            "retry_count": 0,
            "cancel_flag": False,
            "_pending_trash": False,
            "total_frames": 100,
            "fps": 25,
            "resolution": (1920, 1080),
            "codec": "h264",
            "last_frame_index": 50,
            "resume_from_breakpoint": True,
            "output_dir": str(Path(self.tmp.name) / "out"),
            "cache_dir": str(Path(self.tmp.name) / "out" / "cache"),
            "pkg_dir": str(Path(self.tmp.name) / "out" / "packages"),
        }
        Path(task["cache_dir"]).mkdir(parents=True)
        Path(task["pkg_dir"]).mkdir(parents=True)
        batch = batch_manager.get_batch(bid)
        with batch["lock"]:
            batch["tasks"].append(task)

        fake_cap = mock.Mock()
        fake_cap.isOpened.return_value = True
        fake_cap.read.return_value = (True, object())
        fake_cap.get.side_effect = lambda prop: {
            batch_manager.cv2.CAP_PROP_FRAME_COUNT: 100,
            batch_manager.cv2.CAP_PROP_FPS: 25,
        }.get(prop, 0)
        fake_cap.release.return_value = None

        def fake_extract(*_args, **kwargs):
            self.assertEqual(kwargs["start_frame"], 50)
            self.assertEqual(kwargs["saved_offset"], 4)
            kwargs["on_progress"](2, 80, "resume progress", 1, 2, 75)
            return "done", "done", 3

        with mock.patch.object(batch_manager.cv2, "VideoCapture", return_value=fake_cap), \
             mock.patch.object(batch_manager, "extract_slides", side_effect=fake_extract):
            batch["worker_semaphore"].acquire()
            batch_manager._video_worker(bid, "vid1")

        state = batch_manager.get_batch_state(bid)
        completed = state["zones"]["completed"][0]
        self.assertEqual(completed["saved_count"], 7)
        self.assertEqual(state["total_images"], 7)

    def test_batch_add_videos_skips_duplicate_paths(self):
        video = Path(self.tmp.name) / "sample.mp4"
        video.write_bytes(b"not a real mp4")
        bid = batch_manager.create_batch(Path(self.tmp.name) / "sessions", {"threshold": 5}, 1)
        with mock.patch.object(batch_manager, "get_video_metadata", return_value=(0, (0, 0), 0, "")), \
             mock.patch.object(batch_manager, "_generate_thumbnail", return_value=False):
            first = batch_manager.add_videos(bid, [{"path": str(video), "name": "sample"}])
            second = batch_manager.add_videos(bid, [{"path": str(video), "name": "sample again"}])
        state = batch_manager.get_batch_state(bid)
        self.assertEqual(len(first), 1)
        self.assertEqual(second, [])
        self.assertEqual(len(state["zones"]["unselected"]), 1)

    def test_download_job_sse_closes_for_late_terminal_subscriber(self):
        job = ydm._new_job({"course_input": "67968"})
        job["status"] = "completed"
        job["message"] = "already done"
        job["progress"] = 100

        gen_factory = ydm.generate_job_sse(job["id"])
        self.assertIsNotNone(gen_factory)
        gen = gen_factory()
        init = json.loads(next(gen).removeprefix("data: ").strip())
        self.assertEqual(init["type"], "init")
        self.assertEqual(init["job"]["status"], "completed")
        with self.assertRaises(StopIteration):
            next(gen)
        self.assertEqual(job["event_queues"], [])

    def test_download_job_sse_closes_after_terminal_event(self):
        job = ydm._new_job({"course_input": "67968"})
        gen_factory = ydm.generate_job_sse(job["id"])
        self.assertIsNotNone(gen_factory)
        gen = gen_factory()
        init = json.loads(next(gen).removeprefix("data: ").strip())
        self.assertEqual(init["type"], "init")

        job["status"] = "completed"
        job["message"] = "done"
        job["progress"] = 100
        ydm._publish(job, {"type": "job_done", "job": ydm._job_snapshot(job)})

        done = json.loads(next(gen).removeprefix("data: ").strip())
        self.assertEqual(done["type"], "job_done")
        self.assertEqual(done["job"]["status"], "completed")
        with self.assertRaises(StopIteration):
            next(gen)
        self.assertEqual(job["event_queues"], [])

    def test_existing_download_enters_unselected_once_and_does_not_start_batch(self):
        downloads = Path(self.tmp.name) / "downloads"
        sessions = Path(self.tmp.name) / "sessions"
        downloads.mkdir()
        video = downloads / "course_week1.mp4"
        video.write_bytes(b"existing mp4")
        course_info = {
            "course_id": "67968",
            "course_name": "Test Course",
            "user_badge": "badge",
            "items": [{"session_id": "1", "title": "Week 1", "raw_vga": "https://example.test/v.m3u8"}],
        }
        plan = [(course_info["items"][0], video)]

        class DummyCdp:
            def evaluate(self, *_args, **_kwargs):
                return course_info

        patches = [
            mock.patch.object(ydm, "_open_yanhe_browser", return_value=(None, "cdp", DummyCdp(), "sid", "profile")),
            mock.patch.object(ydm, "_close_browser", return_value=None),
            mock.patch.object(core, "wait_for_page_ready", return_value=None),
            mock.patch.object(core, "build_download_plan", return_value=plan),
            mock.patch.object(core, "filter_plan_by_session_ids", return_value=plan),
            mock.patch.object(core, "find_ffmpeg", return_value="ffmpeg.exe"),
            mock.patch.object(core, "is_probably_complete_mp4", return_value=True),
            mock.patch.object(batch_manager, "get_video_metadata", return_value=(0, (0, 0), 0, "")),
            mock.patch.object(batch_manager, "_generate_thumbnail", return_value=False),
        ]
        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], patches[6], patches[7], patches[8]:
            first_job = ydm._new_job({
                "course_input": "67968",
                "session_ids": ["1"],
                "output_dir": str(downloads),
            })
            ydm._run_download_job(first_job, str(sessions))
            state = batch_manager.get_batch_state(first_job["batch_id"])
            self.assertEqual(first_job["status"], "completed")
            self.assertEqual(len(state["zones"]["unselected"]), 1)
            self.assertEqual(state["zones"]["queue"], [])
            self.assertEqual(state["zones"]["completed"], [])
            self.assertEqual(state["status"], "idle")

            second_job = ydm._new_job({
                "course_input": "67968",
                "session_ids": ["1"],
                "output_dir": str(downloads),
                "batch_id": first_job["batch_id"],
            })
            ydm._run_download_job(second_job, str(sessions))
            state = batch_manager.get_batch_state(first_job["batch_id"])
            self.assertEqual(second_job["status"], "completed")
            self.assertEqual(len(state["zones"]["unselected"]), 1)
            self.assertEqual(state["zones"]["queue"], [])
            self.assertEqual(state["zones"]["completed"], [])


if __name__ == "__main__":
    unittest.main()
