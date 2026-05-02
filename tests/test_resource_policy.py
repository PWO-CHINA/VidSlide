import importlib
import os
import sys
import tempfile
import types
import unittest
from unittest import mock


class ResourcePolicyTests(unittest.TestCase):
    def setUp(self):
        self._old_localappdata = os.environ.get("LOCALAPPDATA")
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["LOCALAPPDATA"] = self.tmp.name
        sys.modules.pop("app", None)
        self.app_module = importlib.import_module("app")

    def tearDown(self):
        sys.modules.pop("app", None)
        if self._old_localappdata is None:
            os.environ.pop("LOCALAPPDATA", None)
        else:
            os.environ["LOCALAPPDATA"] = self._old_localappdata
        self.tmp.cleanup()

    def _patch_resources(self, cpu, mem_percent, mem_available_mb, disk_free_mb=4096):
        self.app_module._cpu_cache["percent"] = cpu
        mem = types.SimpleNamespace(percent=mem_percent, available=mem_available_mb * 1024 * 1024)
        disk = types.SimpleNamespace(free=disk_free_mb * 1024 * 1024)
        return mock.patch.object(self.app_module.psutil, "virtual_memory", return_value=mem), \
            mock.patch.object(self.app_module.psutil, "disk_usage", return_value=disk)

    def test_soft_high_memory_warning_does_not_block_tasks(self):
        mem_patch, disk_patch = self._patch_resources(cpu=35, mem_percent=92, mem_available_mb=1200)
        with mem_patch, disk_patch:
            self.assertIsNone(self.app_module._check_resource_warning())

    def test_extreme_memory_pressure_blocks_tasks(self):
        mem_patch, disk_patch = self._patch_resources(cpu=35, mem_percent=98, mem_available_mb=128)
        with mem_patch, disk_patch:
            self.assertIn("内存使用率", self.app_module._check_resource_warning())

    def test_low_disk_space_blocks_tasks(self):
        mem_patch, disk_patch = self._patch_resources(cpu=35, mem_percent=50, mem_available_mb=4096, disk_free_mb=128)
        with mem_patch, disk_patch:
            self.assertIn("磁盘空间", self.app_module._check_resource_warning())


if __name__ == "__main__":
    unittest.main()
