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
