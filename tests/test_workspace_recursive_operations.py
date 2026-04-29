from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from helm.editor import apply_backend_undo, serialize_undo_transaction
from helm.ui.workspace_files import (
    delete_workspace_entry,
    move_workspace_entry,
    preview_workspace_file_operation,
)
from tests.helpers import write_repo_files


class WorkspaceRecursiveOperationTests(unittest.TestCase):
    def test_recursive_delete_rejects_stale_preview_before_mutating(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            write_repo_files(
                root,
                {
                    "pkg/app.py": "def run():\n    return 1\n",
                    "pkg/nested/data.txt": "data\n",
                },
            )

            preview = preview_workspace_file_operation(
                root,
                operation="delete",
                relative_path="pkg",
            )
            self.assertEqual(preview["counts"]["entry_count"], 4)
            self.assertEqual(preview["counts"]["python_file_count"], 1)
            self.assertTrue(preview["impact_fingerprint"].startswith("sha256:"))

            (root / "pkg" / "new.txt").write_text("new\n", encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "preview is stale"):
                delete_workspace_entry(
                    root,
                    relative_path="pkg",
                    expected_impact_fingerprint=preview["impact_fingerprint"],
                )

            self.assertTrue((root / "pkg" / "app.py").exists())
            self.assertTrue((root / "pkg" / "new.txt").exists())

    def test_recursive_delete_undo_and_redo_use_opaque_backend_tokens(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            write_repo_files(
                root,
                {
                    "pkg/app.py": "def run():\n    return 1\n",
                    "pkg/nested/data.txt": "data\n",
                },
            )

            preview = preview_workspace_file_operation(
                root,
                operation="delete",
                relative_path="pkg",
            )
            deleted = delete_workspace_entry(
                root,
                relative_path="pkg",
                expected_impact_fingerprint=preview["impact_fingerprint"],
            )

            self.assertFalse((root / "pkg").exists())
            transaction = serialize_undo_transaction(deleted["undo_transaction"])
            self.assertEqual(transaction.request_kind, "workspace.delete")
            self.assertEqual(transaction.file_snapshots, ())
            self.assertIsNotNone(transaction.snapshot_token)

            undo_result = apply_backend_undo(root, transaction)
            self.assertTrue((root / "pkg" / "app.py").exists())
            self.assertTrue((root / "pkg" / "nested" / "data.txt").exists())
            self.assertIsNotNone(undo_result.redo_transaction)
            self.assertNotEqual(
                transaction.snapshot_token,
                undo_result.redo_transaction.snapshot_token,
            )

            redo_result = apply_backend_undo(root, undo_result.redo_transaction)
            self.assertFalse((root / "pkg").exists())
            self.assertIsNotNone(redo_result.redo_transaction)

    def test_recursive_move_requires_matching_preview_and_blocks_self_moves(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            write_repo_files(
                root,
                {
                    "pkg/app.py": "def run():\n    return 1\n",
                    "dest/.keep": "",
                },
            )

            with self.assertRaisesRegex(ValueError, "expected impact fingerprint"):
                move_workspace_entry(
                    root,
                    source_relative_path="pkg",
                    target_directory_relative_path="dest",
                )

            with self.assertRaisesRegex(ValueError, "Cannot move a folder into itself"):
                preview_workspace_file_operation(
                    root,
                    operation="move",
                    source_relative_path="pkg",
                    target_directory_relative_path="pkg",
                )

            preview = preview_workspace_file_operation(
                root,
                operation="move",
                source_relative_path="pkg",
                target_directory_relative_path="dest",
            )
            moved = move_workspace_entry(
                root,
                source_relative_path="pkg",
                target_directory_relative_path="dest",
                expected_impact_fingerprint=preview["impact_fingerprint"],
            )

            self.assertFalse((root / "pkg").exists())
            self.assertTrue((root / "dest" / "pkg" / "app.py").exists())
            self.assertEqual(moved["undo_transaction"]["request_kind"], "workspace.move")

    def test_protected_metadata_paths_are_not_mutated_from_workspace_operations(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            write_repo_files(root, {".git/config": "", ".helm/recovery/token": ""})

            with self.assertRaisesRegex(ValueError, "protected workspace metadata"):
                delete_workspace_entry(root, relative_path=".git/config")
            with self.assertRaisesRegex(ValueError, "protected workspace metadata"):
                delete_workspace_entry(root, relative_path=".helm")

    def test_recursive_previews_reject_nested_vcs_control_directories(self) -> None:
        for control_dir in (".git", ".hg", ".svn"):
            for operation in ("delete", "move"):
                with self.subTest(control_dir=control_dir, operation=operation):
                    with tempfile.TemporaryDirectory() as tmp_dir:
                        root = Path(tmp_dir)
                        write_repo_files(
                            root,
                            {
                                f"pkg/nested/{control_dir}/config": "",
                                "pkg/app.py": "def run():\n    return 1\n",
                                "dest/.keep": "",
                            },
                        )

                        with self.assertRaisesRegex(ValueError, "VCS control directory"):
                            if operation == "delete":
                                preview_workspace_file_operation(
                                    root,
                                    operation="delete",
                                    relative_path="pkg",
                                )
                            else:
                                preview_workspace_file_operation(
                                    root,
                                    operation="move",
                                    source_relative_path="pkg",
                                    target_directory_relative_path="dest",
                                )

    def test_recursive_previews_reject_nested_helm_recovery_storage(self) -> None:
        for operation in ("delete", "move"):
            with self.subTest(operation=operation):
                with tempfile.TemporaryDirectory() as tmp_dir:
                    root = Path(tmp_dir)
                    write_repo_files(
                        root,
                        {
                            "pkg/.helm/recovery/pending.json": "{}",
                            "pkg/app.py": "def run():\n    return 1\n",
                            "dest/.keep": "",
                        },
                    )

                    with self.assertRaisesRegex(ValueError, "HELM recovery storage"):
                        if operation == "delete":
                            preview_workspace_file_operation(
                                root,
                                operation="delete",
                                relative_path="pkg",
                            )
                        else:
                            preview_workspace_file_operation(
                                root,
                                operation="move",
                                source_relative_path="pkg",
                                target_directory_relative_path="dest",
                            )


if __name__ == "__main__":
    unittest.main()
