from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

MODULE_PATH = SCRIPTS_DIR / "dev.py"
SPEC = importlib.util.spec_from_file_location("helm_dev_entrypoint", MODULE_PATH)
assert SPEC is not None
assert SPEC.loader is not None
ENTRYPOINT = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = ENTRYPOINT
SPEC.loader.exec_module(ENTRYPOINT)


class DevEntrypointTests(unittest.TestCase):
    def test_extract_force_install_flag_strips_install(self) -> None:
        force_bootstrap, remaining = ENTRYPOINT.extract_force_install_flag(
            ["--install", "--verbose"]
        )

        self.assertTrue(force_bootstrap)
        self.assertEqual(remaining, ["--verbose"])

    def test_extract_force_install_flag_leaves_other_args(self) -> None:
        force_bootstrap, remaining = ENTRYPOINT.extract_force_install_flag(["repo", "--json-out"])

        self.assertFalse(force_bootstrap)
        self.assertEqual(remaining, ["repo", "--json-out"])
