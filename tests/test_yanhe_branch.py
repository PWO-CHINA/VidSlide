import os
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


if __name__ == "__main__":
    unittest.main()
