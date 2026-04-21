from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from helm.ui.workspace_files import MAX_INLINE_TEXT_BYTES
from helm.ui.workspace_session import WorkspaceSession, WorkspaceSessionManager
from tests.helpers import write_repo_files


def _graph_node_ids(payload: dict) -> set[str]:
    return {
        node["node_id"]
        for node in payload["graph"]["nodes"]
    }


def _unique_progress_stages(events: list[dict]) -> list[str]:
    stages: list[str] = []
    for event in events:
        stage = event["stage"]
        if not stages or stages[-1] != stage:
            stages.append(stage)
    return stages


class WorkspaceSessionTests(unittest.TestCase):
    def test_session_manager_reuses_sessions_for_the_same_repo(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir) / "repo"
            write_repo_files(root, {"service.py": "def helper():\n    return 1\n"})

            manager = WorkspaceSessionManager()

            first = manager.ensure_session(root)
            second = manager.ensure_session(root)

            self.assertIs(first, second)

    def test_workspace_files_list_create_save_and_reject_traversal(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir) / "repo"
            write_repo_files(
                root,
                {
                    "README.md": "# Demo\n",
                    "src/app.py": "def run():\n    return 1\n",
                },
            )

            session = WorkspaceSession.open(root)

            tree = session.list_workspace_files()
            entries_by_path = {
                entry["relative_path"]: entry
                for entry in tree["entries"]
            }
            self.assertEqual(entries_by_path["README.md"]["kind"], "file")
            self.assertEqual(entries_by_path["src"]["kind"], "directory")
            self.assertEqual(entries_by_path["src/app.py"]["kind"], "file")

            with self.assertRaises(ValueError):
                session.read_workspace_file("../outside.txt")
            with self.assertRaises(ValueError):
                session.create_workspace_entry(
                    kind="file",
                    relative_path="../outside.txt",
                    content="nope",
                )

            created = session.create_workspace_entry(
                kind="file",
                relative_path="docs/notes.md",
                content="# Notes\n",
            )
            self.assertNotIn("payload", created)
            self.assertEqual(created["file"]["content"], "# Notes\n")

            version = created["file"]["version"]
            saved = session.save_workspace_file(
                relative_path="docs/notes.md",
                content="# Notes\nUpdated\n",
                expected_version=version,
            )
            self.assertNotIn("payload", saved)
            self.assertEqual(saved["file"]["content"], "# Notes\nUpdated\n")

            with self.assertRaises(ValueError):
                session.save_workspace_file(
                    relative_path="docs/notes.md",
                    content="stale write\n",
                    expected_version=version,
                )

            moved = session.move_workspace_entry(
                source_relative_path="README.md",
                target_directory_relative_path="docs",
            )
            self.assertNotIn("payload", moved)
            self.assertEqual(moved["relative_path"], "docs/README.md")
            self.assertEqual(moved["file"]["content"], "# Demo\n")
            self.assertFalse((root / "README.md").exists())
            self.assertTrue((root / "docs" / "README.md").exists())

            deleted = session.delete_workspace_entry(relative_path="docs/README.md")
            self.assertNotIn("payload", deleted)
            self.assertEqual(deleted["relative_path"], "docs/README.md")
            self.assertFalse((root / "docs" / "README.md").exists())

            with self.assertRaises(ValueError):
                session.move_workspace_entry(
                    source_relative_path="../outside.txt",
                    target_directory_relative_path="docs",
                )
            with self.assertRaises(ValueError):
                session.delete_workspace_entry(relative_path="../outside.txt")

    def test_workspace_file_python_mutations_refresh_graph_payload(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir) / "repo"
            root.mkdir()

            session = WorkspaceSession.open(root)
            created = session.create_workspace_entry(
                kind="file",
                relative_path="app.py",
                content="def run():\n    return 1\n",
            )

            self.assertIn("payload", created)
            self.assertEqual(created["session_version"], 2)
            self.assertIn("module:app", _graph_node_ids(created["payload"]))
            self.assertEqual(created["diagnostics"], [])

            current = session.read_workspace_file("app.py")
            saved = session.save_workspace_file(
                relative_path="app.py",
                content="def run():\n    return 1\n\n\ndef helper():\n    return run()\n",
                expected_version=current["version"],
            )

            self.assertIn("payload", saved)
            self.assertEqual(saved["session_version"], 3)
            self.assertIn("symbol:app:helper", _graph_node_ids(saved["payload"]))

            session.create_workspace_entry(
                kind="directory",
                relative_path="pkg",
            )
            moved = session.move_workspace_entry(
                source_relative_path="app.py",
                target_directory_relative_path="pkg",
            )

            self.assertIn("payload", moved)
            self.assertEqual(moved["session_version"], 4)
            self.assertEqual(moved["relative_path"], "pkg/app.py")
            self.assertEqual(
                moved["changed_relative_paths"],
                ["app.py", "pkg/app.py"],
            )
            self.assertNotIn("module:app", _graph_node_ids(moved["payload"]))
            self.assertIn("module:pkg.app", _graph_node_ids(moved["payload"]))

            deleted = session.delete_workspace_entry(relative_path="pkg/app.py")

            self.assertIn("payload", deleted)
            self.assertEqual(deleted["session_version"], 5)
            self.assertEqual(deleted["changed_relative_paths"], ["pkg/app.py"])
            self.assertNotIn("module:pkg.app", _graph_node_ids(deleted["payload"]))

    def test_python_module_source_can_be_edited_from_inspector_pipeline(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir) / "repo"
            root.mkdir()

            session = WorkspaceSession.open(root)
            created = session.create_workspace_entry(
                kind="file",
                relative_path="test.py",
                content="",
            )
            self.assertIn("module:test", _graph_node_ids(created["payload"]))

            module_source = session.get_editable_node_source("module:test")
            self.assertTrue(module_source["editable"])
            self.assertEqual(module_source["node_kind"], "module")
            self.assertEqual(module_source["content"], "")

            saved = session.save_node_source(
                "module:test",
                "def run():\n    return 7\n",
            )

            self.assertEqual(saved["edit"]["request"]["kind"], "replace_module_source")
            self.assertIn("symbol:test:run", _graph_node_ids(saved["payload"]))
            self.assertEqual(saved["payload"]["workspace"]["session_version"], 3)

    def test_workspace_files_report_non_inline_editable_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir) / "repo"
            root.mkdir()
            (root / "binary.dat").write_bytes(b"hello\x00world")
            (root / "latin1.txt").write_bytes(b"\xff")
            (root / "large.txt").write_bytes(b"x" * (MAX_INLINE_TEXT_BYTES + 1))

            session = WorkspaceSession.open(root)
            tree = session.list_workspace_files()
            entries_by_path = {
                entry["relative_path"]: entry
                for entry in tree["entries"]
            }

            self.assertFalse(entries_by_path["binary.dat"]["editable"])
            self.assertIn("Binary", entries_by_path["binary.dat"]["reason"])
            self.assertFalse(entries_by_path["latin1.txt"]["editable"])
            self.assertIn("UTF-8", entries_by_path["latin1.txt"]["reason"])
            self.assertFalse(entries_by_path["large.txt"]["editable"])
            self.assertIn("2 MiB", entries_by_path["large.txt"]["reason"])

            self.assertFalse(session.read_workspace_file("binary.dat")["editable"])
            self.assertFalse(session.read_workspace_file("latin1.txt")["editable"])
            self.assertFalse(session.read_workspace_file("large.txt")["editable"])

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

    def test_full_resync_reports_progress_in_stage_order(self) -> None:
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
            progress_events: list[dict] = []

            payload = session.full_resync(progress=progress_events.append)

            self.assertEqual(payload["workspace"]["session_version"], 2)
            self.assertEqual(
                _unique_progress_stages(progress_events),
                ["discover", "parse", "graph_build", "cache_finalize"],
            )
            self.assertEqual(progress_events[-1]["stage"], "cache_finalize")
            self.assertEqual(progress_events[-1]["symbol_count"], 2)
            self.assertEqual(progress_events[-1]["progress_percent"], 95)

    def test_refresh_paths_reports_incremental_progress_in_stage_order(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir) / "repo"
            module_path = root / "service.py"
            write_repo_files(
                root,
                {
                    "service.py": "def helper():\n    return 1\n",
                    "worker.py": "def run():\n    return helper()\n",
                },
            )

            session = WorkspaceSession.open(root)
            module_path.write_text(
                "def helper():\n    return 1\n\n\ndef helper_blueprint():\n    return helper()\n",
                encoding="utf-8",
            )
            progress_events: list[dict] = []

            refreshed = session.refresh_paths(["service.py"], progress=progress_events.append)

            self.assertEqual(refreshed["reparsed_relative_paths"], ["service.py"])
            self.assertEqual(
                _unique_progress_stages(progress_events),
                ["discover", "parse", "graph_build", "cache_finalize"],
            )
            parse_events = [
                event
                for event in progress_events
                if event["stage"] == "parse"
            ]
            self.assertTrue(any("service.py" in event["message"] for event in parse_events))
