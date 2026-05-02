import os
import json
import tempfile
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

    def test_downloader_helpers(self):
        self.assertEqual(ydm._course_url("67968"), "https://www.yanhekt.cn/course/67968")
        self.assertEqual(core.parse_session_ids("1, 2;3\n4"), {"1", "2", "3", "4"})
        self.assertNotIn(":", core.sanitize_filename("bad:name?.mp4"))
        self.assertTrue(core.filename_for({"title": "第1周", "course_name": "生物仪器分析"}, 1).endswith("_课堂录屏.mp4"))
        with self.assertRaises(FileNotFoundError):
            core.find_ffmpeg(str(Path(self.tmp.name) / "missing-ffmpeg.exe"))

    def test_dry_run_preflight_does_not_require_ffmpeg(self):
        result = ydm.download_preflight({"dry_run": True})
        self.assertTrue(result["ok"])
        self.assertIn("output_dir", result)

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
