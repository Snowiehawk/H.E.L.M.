from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from helm.editor import apply_structural_edit, serialize_edit_request
from helm.io_atomic import atomic_write_text
from helm.graph import EdgeKind, build_repo_graph
from helm.parser import PythonModuleParser, discover_python_modules
from helm.recovery import (
    JournalPreimage,
    RepoMutationJournal,
    recover_pending,
    run_journaled_mutation,
)
from helm.ui import workspace_files
from helm.ui.workspace_files import read_workspace_file, save_workspace_file
from helm.ui.workspace_session import WorkspaceSession
from tests.helpers import write_repo_files


def parse_repo(root: Path):
    inventory = discover_python_modules(root)
    parsed_modules = [PythonModuleParser().parse_module(module) for module in inventory.modules]
    graph = build_repo_graph(root, parsed_modules)
    inbound = {}
    for edge in graph.edges:
        if edge.kind != EdgeKind.CALLS:
            continue
        inbound[edge.target_id] = inbound.get(edge.target_id, 0) + 1
    return parsed_modules, graph, inbound


class RecoveryTests(unittest.TestCase):
    def test_atomic_write_preserves_old_content_after_replace_failure(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "file.txt"
            path.write_text("old\n", encoding="utf-8")

            with mock.patch("helm.io_atomic.os.replace", side_effect=OSError("boom")):
                with self.assertRaisesRegex(OSError, "boom"):
                    atomic_write_text(path, "new\n")

            self.assertEqual(path.read_text(encoding="utf-8"), "old\n")
            self.assertEqual(
                [candidate for candidate in path.parent.iterdir() if candidate.name != "file.txt"],
                [],
            )

    def test_journal_setup_failure_aborts_before_mutation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            touched = root / "touched.txt"

            with mock.patch.object(
                RepoMutationJournal,
                "_ensure_recovery_dirs",
                side_effect=OSError("journal unavailable"),
            ):
                with self.assertRaisesRegex(OSError, "journal unavailable"):
                    run_journaled_mutation(
                        root,
                        kind="test.setup-failure",
                        preimages=(JournalPreimage("touched.txt"),),
                        mutation=lambda: touched.write_text("changed\n", encoding="utf-8"),
                    )

            self.assertFalse(touched.exists())

    def test_recovery_area_is_added_to_local_git_exclude(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            git_info = root / ".git" / "info"
            git_info.mkdir(parents=True)
            exclude_path = git_info / "exclude"
            exclude_path.write_text("# existing local ignores\n", encoding="utf-8")

            run_journaled_mutation(
                root,
                kind="test.git-exclude",
                preimages=(JournalPreimage("created.txt"),),
                mutation=lambda: (root / "created.txt").write_text(
                    "created\n",
                    encoding="utf-8",
                ),
            )

            self.assertIn(
                "/.helm/recovery/",
                exclude_path.read_text(encoding="utf-8").splitlines(),
            )

    def test_pending_journal_rolls_back_on_workspace_open(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            write_repo_files(root, {"service.py": "def run():\n    return 1\n"})
            journal = RepoMutationJournal(root)
            operation = journal.prepare(
                kind="test.interrupted",
                preimages=(JournalPreimage("service.py"),),
            )
            operation._write_phase("applying")
            (root / "service.py").write_text("def run():\n    return 2\n", encoding="utf-8")

            session = WorkspaceSession.open(root)
            payload = session.build_payload()

            self.assertEqual(
                (root / "service.py").read_text(encoding="utf-8"), "def run():\n    return 1\n"
            )
            self.assertEqual(payload["recovery_events"][0]["outcome"], "rolled_back")

    def test_rolling_back_journal_can_be_recovered_again(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            write_repo_files(root, {"service.py": "def run():\n    return 1\n"})
            journal = RepoMutationJournal(root)
            operation = journal.prepare(
                kind="test.rolling-back",
                preimages=(JournalPreimage("service.py"),),
            )
            operation._write_phase("rolling_back")
            (root / "service.py").write_text("def run():\n    return 2\n", encoding="utf-8")

            first = recover_pending(root)
            second = recover_pending(root)

            self.assertEqual(first[0].outcome, "rolled_back")
            self.assertEqual(second, ())
            self.assertEqual(
                (root / "service.py").read_text(encoding="utf-8"), "def run():\n    return 1\n"
            )

    def test_stale_workspace_save_does_not_prepare_or_write(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            write_repo_files(root, {"notes.txt": "old\n"})
            first = read_workspace_file(root, "notes.txt")
            (root / "notes.txt").write_text("external\n", encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "changed on disk"):
                save_workspace_file(
                    root,
                    relative_path="notes.txt",
                    content="new\n",
                    expected_version=first["version"],
                )

            self.assertEqual((root / "notes.txt").read_text(encoding="utf-8"), "external\n")
            self.assertFalse((root / ".helm" / "recovery" / "journals").exists())

    def test_directory_delete_rolls_back_after_mutation_failure(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            write_repo_files(
                root,
                {
                    "pkg/__init__.py": "",
                    "pkg/nested/data.txt": "data\n",
                },
            )
            original_delete = workspace_files._delete_workspace_entry

            def fail_after_delete(*args, **kwargs):
                original_delete(*args, **kwargs)
                raise OSError("delete follow-up failed")

            with mock.patch.object(workspace_files, "_delete_workspace_entry", fail_after_delete):
                with self.assertRaisesRegex(OSError, "delete follow-up failed"):
                    preview = workspace_files.preview_workspace_file_operation(
                        root,
                        operation="delete",
                        relative_path="pkg",
                    )
                    workspace_files.delete_workspace_entry(
                        root,
                        relative_path="pkg",
                        expected_impact_fingerprint=preview["impact_fingerprint"],
                    )

            self.assertEqual(
                (root / "pkg" / "nested" / "data.txt").read_text(encoding="utf-8"), "data\n"
            )
            self.assertFalse(any((root / ".helm" / "recovery" / "journals").glob("*.json")))

    @unittest.skipIf(
        os.name == "nt", "directory symlink behavior requires elevated Windows privileges"
    )
    def test_symlinked_directory_delete_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            (root / "real").mkdir()
            (root / "real" / "file.txt").write_text("data\n", encoding="utf-8")
            (root / "linked").symlink_to(root / "real", target_is_directory=True)

            with self.assertRaisesRegex(ValueError, "symlinked workspace folders"):
                workspace_files.preview_workspace_file_operation(
                    root,
                    operation="delete",
                    relative_path="linked",
                )

    def test_structural_edit_rolls_back_source_when_flow_metadata_write_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            original_source = "def run():\n    return True\n"
            write_repo_files(root, {"service.py": original_source})
            parsed_modules, _, inbound = parse_repo(root)

            with mock.patch(
                "helm.editor.flow_model.atomic_write_text",
                side_effect=OSError("metadata write failed"),
            ):
                with self.assertRaisesRegex(OSError, "metadata write failed"):
                    apply_structural_edit(
                        root,
                        serialize_edit_request(
                            {
                                "kind": "replace_symbol_source",
                                "target_id": "symbol:service:run",
                                "content": "def run():\n    return False\n",
                            }
                        ),
                        parsed_modules=parsed_modules,
                        inbound_dependency_count=inbound,
                    )

            self.assertEqual((root / "service.py").read_text(encoding="utf-8"), original_source)
