from __future__ import annotations

import contextlib
import importlib.util
import os
import shutil
import sys
import time
import unittest
import uuid
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "bootstrap.py"
SPEC = importlib.util.spec_from_file_location("helm_bootstrap", MODULE_PATH)
assert SPEC is not None
assert SPEC.loader is not None
BOOTSTRAP = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = BOOTSTRAP
SPEC.loader.exec_module(BOOTSTRAP)
TEST_TEMP_ROOT = Path(__file__).resolve().parents[1] / ".pytest_cache" / "bootstrap-tests"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)


@contextlib.contextmanager
def scratch_dir() -> Path:
    root = TEST_TEMP_ROOT / f"case-{uuid.uuid4().hex}"
    root.mkdir(parents=True)
    try:
        yield root
    finally:
        shutil.rmtree(root, ignore_errors=True)


class BootstrapTests(unittest.TestCase):
    def test_platform_profile_for_windows_uses_scripts_python(self) -> None:
        profile = BOOTSTRAP.get_platform_profile("Windows")

        self.assertEqual(profile.name, "windows")
        self.assertEqual(profile.python_subpath, ("Scripts", "python.exe"))
        self.assertIn("Activate.ps1", profile.activation_hint)

    def test_platform_profile_for_macos_uses_bin_python(self) -> None:
        profile = BOOTSTRAP.get_platform_profile("Darwin")

        self.assertEqual(profile.name, "macos")
        self.assertEqual(profile.python_subpath, ("bin", "python"))

    def test_selected_phases_default_to_full_desktop_bootstrap(self) -> None:
        self.assertEqual(
            BOOTSTRAP.selected_phases(),
            ("python", "npm", "cargo"),
        )
        self.assertEqual(
            BOOTSTRAP.selected_phases(ui_only=True),
            ("python", "npm"),
        )
        self.assertEqual(
            BOOTSTRAP.selected_phases(python_only=True),
            ("python",),
        )

    def test_needs_refresh_when_stamp_is_missing(self) -> None:
        with scratch_dir() as root:
            input_path = root / "pyproject.toml"
            input_path.write_text("[project]\nname = 'helm'\n", encoding="utf-8")

            self.assertTrue(BOOTSTRAP.needs_refresh(root / "python.stamp", [input_path]))

    def test_needs_refresh_when_input_is_newer_than_stamp(self) -> None:
        with scratch_dir() as root:
            input_path = root / "pyproject.toml"
            stamp_path = root / "python.stamp"

            input_path.write_text("[project]\nname = 'helm'\n", encoding="utf-8")
            BOOTSTRAP.touch(stamp_path)
            time.sleep(0.02)
            input_path.write_text("[project]\nname = 'helm-updated'\n", encoding="utf-8")

            self.assertTrue(BOOTSTRAP.needs_refresh(stamp_path, [input_path]))

    def test_needs_refresh_skips_when_stamp_is_newer_than_inputs(self) -> None:
        with scratch_dir() as root:
            input_path = root / "pyproject.toml"
            stamp_path = root / "python.stamp"

            input_path.write_text("[project]\nname = 'helm'\n", encoding="utf-8")
            BOOTSTRAP.touch(stamp_path)

            newer_time = stamp_path.stat().st_mtime + 10
            os.utime(stamp_path, (newer_time, newer_time))

            self.assertFalse(BOOTSTRAP.needs_refresh(stamp_path, [input_path]))
