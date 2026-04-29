from __future__ import annotations

import os
import sys
import types
import unittest

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
