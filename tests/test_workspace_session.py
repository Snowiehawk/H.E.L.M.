from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from helm.ui.workspace_session import WorkspaceSession, WorkspaceSessionManager
from tests.helpers import write_repo_files


def _graph_node_ids(payload: dict) -> set[str]:
    return {
        node["node_id"]
        for node in payload["graph"]["nodes"]
    }


class WorkspaceSessionTests(unittest.TestCase):
    def test_session_manager_reuses_sessions_for_the_same_repo(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir) / "repo"
            write_repo_files(root, {"service.py": "def helper():\n    return 1\n"})

            manager = WorkspaceSessionManager()

            first = manager.ensure_session(root)
            second = manager.ensure_session(root)

            self.assertIs(first, second)

    def test_refresh_paths_updates_existing_module_symbols(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir) / "repo"
            module_path = root / "service.py"
            write_repo_files(root, {"service.py": "def helper():\n    return 1\n"})

            session = WorkspaceSession.open(root)

            module_path.write_text(
                "def helper():\n    return 1\n\n\ndef helper_blueprint():\n    return helper()\n",
                encoding="utf-8",
            )

            refreshed = session.refresh_paths(["service.py"])

            self.assertEqual(refreshed["changed_relative_paths"], ["service.py"])
            self.assertEqual(refreshed["reparsed_relative_paths"], ["service.py"])
            self.assertEqual(refreshed["session_version"], 2)
            self.assertIn(
                "symbol:service:helper_blueprint",
                _graph_node_ids(refreshed["payload"]),
            )

    def test_refresh_paths_handles_added_and_removed_modules(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir) / "repo"
            write_repo_files(
                root,
                {
                    "alpha.py": "def one():\n    return 1\n",
                    "beta.py": "def two():\n    return 2\n",
                },
            )

            session = WorkspaceSession.open(root)
            (root / "beta.py").unlink()
            write_repo_files(root, {"gamma.py": "def three():\n    return 3\n"})

            refreshed = session.refresh_paths(["beta.py", "gamma.py"])
            node_ids = _graph_node_ids(refreshed["payload"])

            self.assertIn("module:gamma", node_ids)
            self.assertNotIn("module:beta", node_ids)
            self.assertEqual(
                refreshed["changed_relative_paths"],
                ["beta.py", "gamma.py"],
            )

    def test_full_resync_recovers_after_a_syntax_error_refresh(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir) / "repo"
            module_path = root / "service.py"
            write_repo_files(root, {"service.py": "def helper():\n    return 1\n"})

            session = WorkspaceSession.open(root)

            module_path.write_text("def helper(:\n    return 1\n", encoding="utf-8")
            broken = session.refresh_paths(["service.py"])
            self.assertTrue(
                any("syntax_error" in message for message in broken["diagnostics"])
            )

            module_path.write_text("def helper():\n    return 2\n", encoding="utf-8")
            payload = session.full_resync()

            self.assertEqual(payload["workspace"]["session_version"], 3)
            self.assertEqual(payload["summary"]["diagnostic_count"], 0)

