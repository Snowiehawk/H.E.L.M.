from __future__ import annotations

import json
import unittest
from pathlib import Path


class DesktopAssetTests(unittest.TestCase):
    def test_github_issue_loader_has_only_the_approved_network_allowance(self) -> None:
        repo_root = Path(__file__).resolve().parents[1]
        config = json.loads(
            (repo_root / "apps/desktop/src-tauri/tauri.conf.json").read_text(encoding="utf-8")
        )
        security = config["app"]["security"]
        endpoint = "https://api.github.com/graphql"
        local_sources = {"ipc:", "http://ipc.localhost"}
        dev_sources = {
            "http://localhost:1420",
            "ws://localhost:1420",
            "http://127.0.0.1:1420",
            "ws://127.0.0.1:1420",
        }
        for policy, existing_sources in (
            ("csp", local_sources),
            ("devCsp", local_sources | dev_sources),
        ):
            with self.subTest(policy=policy):
                connections = security[policy]["connect-src"]
                self.assertEqual(connections.count(endpoint), 1)
                self.assertEqual(set(connections), existing_sources | {endpoint})
        self.assertEqual(security["csp"]["default-src"], ["'self'"])
        self.assertEqual(security["csp"]["script-src"], ["'self'"])

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
