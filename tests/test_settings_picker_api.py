import importlib
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


class SettingsPickerApiTests(unittest.TestCase):
    def setUp(self):
        self._old_localappdata = os.environ.get("LOCALAPPDATA")
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["LOCALAPPDATA"] = self.tmp.name
        sys.modules.pop("app", None)
        self.app_module = importlib.import_module("app")
        self.client = self.app_module.app.test_client()

    def tearDown(self):
        sys.modules.pop("app", None)
        if self._old_localappdata is None:
            os.environ.pop("LOCALAPPDATA", None)
        else:
            os.environ["LOCALAPPDATA"] = self._old_localappdata
        self.tmp.cleanup()

    def test_select_ffmpeg_updates_settings_when_candidate_is_valid(self):
        ffmpeg = Path(self.tmp.name) / "ffmpeg.exe"
        ffmpeg.write_bytes(b"fake")
        with mock.patch.object(self.app_module, "_open_file_dialog", return_value=str(ffmpeg)), \
             mock.patch.object(self.app_module._ydm, "ffmpeg_status", return_value={"available": True, "path": str(ffmpeg), "candidates": []}):
            res = self.client.post("/api/settings/select-ffmpeg")
        data = res.get_json()
        self.assertTrue(data["success"])
        self.assertEqual(data["settings"]["download"]["ffmpeg_path"], str(ffmpeg))

    def test_select_download_dir_updates_settings_and_checks_writable(self):
        target = Path(self.tmp.name) / "F_like_downloads"
        target.mkdir()
        with mock.patch.object(self.app_module, "_open_file_dialog", return_value=str(target)):
            res = self.client.post("/api/settings/select-download-dir")
        data = res.get_json()
        self.assertTrue(data["success"])
        self.assertEqual(data["settings"]["download"]["download_dir"], str(target))
        self.assertGreaterEqual(data["disk"]["free_bytes"], 0)


if __name__ == "__main__":
    unittest.main()
