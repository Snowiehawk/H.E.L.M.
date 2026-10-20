from __future__ import annotations

import os
import sys
import types
import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch

if "invoke" not in sys.modules:
    invoke_stub = types.ModuleType("invoke")
    invoke_stub.Exit = RuntimeError

    def task(*args, **kwargs):
        def decorator(function):
            return function

        return decorator

    invoke_stub.task = task
    sys.modules["invoke"] = invoke_stub

import tasks


class TaskHelpersTests(unittest.TestCase):
    def test_pty_supported_matches_platform(self) -> None:
        self.assertEqual(tasks._pty_supported(), os.name != "nt")

    def test_pip_compile_command_uses_stable_relative_paths(self) -> None:
        command = tasks._pip_compile_command(
            tasks.REQUIREMENTS_DIR / "python-runtime.in",
            tasks.REQUIREMENTS_DIR / "python-runtime.txt",
        )

        self.assertIn("requirements/python-runtime.in", command)
        self.assertIn("requirements/python-runtime.txt", command)
        self.assertIn("--no-annotate", command)
        self.assertIn("--no-emit-index-url", command)


class LockBaselineTests(unittest.TestCase):
    def test_rejects_nonbaseline_interpreters(self) -> None:
        for version in ((3, 9), (3, 11), (3, 13), (3, 14)):
            with self.subTest(version=version), patch.object(tasks.sys, "version_info", version):
                with self.assertRaisesRegex(tasks.Exit, "Python 3.12"):
                    tasks._ensure_python_lock_version()

    def test_accepts_exact_python312_baseline(self) -> None:
        with patch.object(tasks.sys, "version_info", (3, 12)):
            tasks._ensure_python_lock_version()


class SameInterpreterToolTests(unittest.TestCase):
    @unittest.skipIf(os.name == "nt", "Windows venv Python is not a POSIX symlink.")
    def test_prefers_venv_script_beside_symlinked_python(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            bin_dir = Path(temp) / "bin"
            bin_dir.mkdir()
            python = bin_dir / "python"
            python.symlink_to(sys.executable)
            tool = bin_dir / "ruff"
            tool.touch()
            with patch.object(tasks.sys, "executable", str(python)):
                self.assertEqual(tasks._same_python_tool("ruff"), str(tool))
