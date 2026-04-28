from __future__ import annotations

import io
import json
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

from helm.cli import main
from tests.helpers import write_repo_files


class CliTests(unittest.TestCase):
    def test_scan_command_prints_summary_and_writes_json(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir) / "repo"
            output_path = Path(tmp_dir) / "graph.json"
            write_repo_files(
                root,
                {
                    "helpers.py": "def helper():\n    return 'ok'\n",
                    "service.py": (
                        "from helpers import helper\n\ndef run():\n    return helper()\n"
                    ),
                },
            )

            stdout = io.StringIO()
            with redirect_stdout(stdout):
                exit_code = main(["scan", str(root), "--json-out", str(output_path)])

            self.assertEqual(exit_code, 0)
            self.assertIn("Scanned repo:", stdout.getvalue())
            self.assertTrue(output_path.exists())

            payload = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["summary"]["module_count"], 2)
            self.assertIn("graph", payload)

    def test_scan_command_returns_error_for_missing_repo(self) -> None:
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            exit_code = main(["scan", "does-not-exist"])

        self.assertEqual(exit_code, 2)
        self.assertIn("does not exist", stderr.getvalue())
