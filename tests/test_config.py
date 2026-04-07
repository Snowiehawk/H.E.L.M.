from __future__ import annotations

import unittest
from pathlib import Path

from helm.config import ScanConfig
from helm.parser.symbols import make_call_id, make_import_id, make_module_id, make_symbol_id


class ConfigAndIdTests(unittest.TestCase):
    def test_scan_config_defaults(self) -> None:
        config = ScanConfig(root=Path("."))
        self.assertIn(".git", config.exclude_dirs)
        self.assertTrue(config.includes(Path("module.py")))
        self.assertFalse(config.includes(Path("README.md")))

    def test_stable_ids(self) -> None:
        self.assertEqual(make_module_id("pkg.module"), "module:pkg.module")
        self.assertEqual(
            make_symbol_id("pkg.module", "Service.run"),
            "symbol:pkg.module:Service.run",
        )
        self.assertEqual(
            make_import_id("pkg.module", "helper", 10, 4),
            "import:pkg.module:helper:10:4",
        )
        self.assertEqual(
            make_call_id("pkg.module", "helper", 11, 8),
            "call:pkg.module:helper:11:8",
        )
