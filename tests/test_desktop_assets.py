from __future__ import annotations

import json
import unittest
from pathlib import Path


class DesktopAssetTests(unittest.TestCase):
    def test_tauri_bundle_icons_exist(self) -> None:
        repo_root = Path(__file__).resolve().parents[1]
        tauri_dir = repo_root / "apps" / "desktop" / "src-tauri"
        config = json.loads((tauri_dir / "tauri.conf.json").read_text(encoding="utf-8"))

        expected_icons = [
            "icons/32x32.png",
            "icons/128x128.png",
            "icons/128x128@2x.png",
            "icons/icon.icns",
            "icons/icon.ico",
        ]

        self.assertEqual(config["bundle"]["icon"], expected_icons)
        for relative_path in expected_icons:
            self.assertTrue(
                (tauri_dir / relative_path).exists(),
                f"Missing Tauri icon asset: {relative_path}",
            )
