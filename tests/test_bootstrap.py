from __future__ import annotations

import contextlib
import importlib.util
import os
import shutil
import sys
import time
import unittest
import uuid
from unittest.mock import patch
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


class BootstrapPythonBaselineTests(unittest.TestCase):
    def test_rejects_old_python_before_installing_dependencies(self) -> None:
        for version in ((3, 9, 1), (3, 11, 9)):
            with (
                self.subTest(version=version),
                patch.object(BOOTSTRAP.sys, "version_info", version),
            ):
                with self.assertRaisesRegex(BOOTSTRAP.BootstrapError, r"Python 3.12\+"):
                    BOOTSTRAP.ensure_supported_python()

    def test_accepts_baseline_and_newer_development_interpreters(self) -> None:
        for version in ((3, 12, 0), (3, 14, 0)):
            with (
                self.subTest(version=version),
                patch.object(BOOTSTRAP.sys, "version_info", version),
            ):
                BOOTSTRAP.ensure_supported_python()

    def test_preserves_existing_old_venv_instead_of_replacing_it(self) -> None:
        profile = BOOTSTRAP.get_platform_profile("Darwin")
        with (
            patch.object(BOOTSTRAP.Path, "exists", return_value=True),
            patch.object(BOOTSTRAP.subprocess, "run") as run,
            patch.object(BOOTSTRAP, "run_command") as install,
        ):
            run.return_value.returncode = 1
            with self.assertRaisesRegex(BOOTSTRAP.BootstrapError, "will not replace"):
                BOOTSTRAP.ensure_venv(profile)
            install.assert_not_called()

    def test_reuses_existing_supported_venv(self) -> None:
        profile = BOOTSTRAP.get_platform_profile("Darwin")
        with (
            patch.object(BOOTSTRAP.Path, "exists", return_value=True),
            patch.object(BOOTSTRAP.subprocess, "run") as run,
            patch.object(BOOTSTRAP, "run_command") as install,
        ):
            run.return_value.returncode = 0
            self.assertEqual(BOOTSTRAP.ensure_venv(profile), BOOTSTRAP.venv_python_path(profile))
            install.assert_not_called()
