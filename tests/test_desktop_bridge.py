from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from helm.ui.desktop_bridge import scan_repo_to_payload
from tests.helpers import write_repo_files


class DesktopBridgeTests(unittest.TestCase):
    def test_scan_repo_to_payload_returns_summary_and_graph(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir) / "repo"
            write_repo_files(
                root,
                {
                    "alpha.py": "def one():\n    return 1\n",
                    "beta.py": "from alpha import one\n\ndef two():\n    return one()\n",
                },
            )

            payload = scan_repo_to_payload(root)

            self.assertIn("summary", payload)
            self.assertIn("graph", payload)
            self.assertEqual(payload["summary"]["module_count"], 2)
            self.assertEqual(payload["graph"]["report"]["call_edge_count"], 1)
