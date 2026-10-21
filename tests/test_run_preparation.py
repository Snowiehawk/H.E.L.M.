from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from helm.editor.flow_model import (
    FLOW_MODEL_RELATIVE_PATH,
    import_flow_document_from_function_source,
    write_flow_document,
)
from helm.ui.desktop_bridge import _handle_worker_command
from helm.ui.run_preparation import prepare_run_source
from helm.ui.workspace_session import WorkspaceSession
from helm.recovery import JournalPreimage, RepoMutationJournal
from tests.helpers import write_repo_files


class RunPreparationTests(unittest.TestCase):
    def test_stale_declaration_save_refuses_external_disk_change_without_journal_or_overwrite(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = "def hello():\n    return 1\n"
            external = "def hello():\n    return 9\n"
            write_repo_files(root, {"app.py": source})
            session = WorkspaceSession.open(root)
            baseline = session.get_editable_node_source("symbol:app:hello")["content"]
            (root / "app.py").write_text(external)
            version = session.session_version
            with self.assertRaisesRegex(ValueError, "changed on disk"):
                session.save_node_source(
                    "symbol:app:hello", "def hello():\n    return 2", expected_source=baseline
                )
            self.assertEqual((root / "app.py").read_text(), external)
            self.assertEqual(session.session_version, version)
            self.assertFalse(any((root / ".helm/recovery/journals").glob("*.json")))

    def test_matching_declaration_baseline_saves_and_retains_undo(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_repo_files(root, {"app.py": "def hello():\n    return 1\n"})
            session = WorkspaceSession.open(root)
            baseline = session.get_editable_node_source("symbol:app:hello")["content"]
            result = session.save_node_source(
                "symbol:app:hello", "def hello():\n    return 2", expected_source=baseline
            )
            self.assertIn("return 2", (root / "app.py").read_text())
            self.assertIsNotNone(result["edit"]["undo_transaction"])

    def test_optimistic_source_check_preserves_prior_recovery_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_repo_files(root, {"app.py": "def hello():\n    return 1\n"})
            session = WorkspaceSession.open(root)
            baseline = session.get_editable_node_source("symbol:app:hello")["content"]
            RepoMutationJournal(root).prepare(
                kind="test-interrupted", preimages=(JournalPreimage("app.py"),)
            )
            (root / "app.py").write_text("def hello():\n    return 9\n")
            result = session.save_node_source(
                "symbol:app:hello", "def hello():\n    return 2", expected_source=baseline
            )
            self.assertEqual(result["edit"]["recovery_events"][0]["outcome"], "rolled_back")
            self.assertIn("return 2", (root / "app.py").read_text())

    def test_passive_snapshot_hashes_exact_unicode_crlf_bytes_without_running_source(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            canary = root / "executed"
            raw = f"from pathlib import Path\r\nPath({str(canary)!r}).touch()\r\ndef hello():\r\n    return 'Ω'\r\n".encode()
            (root / "app.py").write_bytes(raw)
            (root / "package.json").write_text('{"scripts":{"start":"touch executed"}}')
            result = _handle_worker_command("prepare-run-source", {"repo": str(root)})
            self.assertFalse(canary.exists())
            by_path = {item["relativePath"]: item for item in result["files"]}
            self.assertEqual(by_path["app.py"]["sha256"], hashlib.sha256(raw).hexdigest())
            self.assertIn("package.json", by_path)
            symbol = next(
                item for item in result["indexedSymbols"] if item["nodeId"] == "symbol:app:hello"
            )
            self.assertEqual(symbol["sourceHash"], by_path["app.py"]["sha256"])
            self.assertEqual(symbol["startLine"], 3)
            self.assertEqual(symbol["endLine"], 4)

    def test_valid_persisted_flow_is_proven_and_store_is_frozen(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = "def hello():\n    return 1\n"
            write_repo_files(root, {"app.py": source})
            document = import_flow_document_from_function_source(
                symbol_id="symbol:app:hello",
                relative_path="app.py",
                qualname="hello",
                module_source=source,
            )
            write_flow_document(root, document)
            result = prepare_run_source(root)
            self.assertIn(
                FLOW_MODEL_RELATIVE_PATH, {item["relativePath"] for item in result["files"]}
            )

    def test_invalid_flow_draft_never_admits_last_good_python(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = "def hello():\n    return 1\n"
            write_repo_files(root, {"app.py": source})
            document = import_flow_document_from_function_source(
                symbol_id="symbol:app:hello",
                relative_path="app.py",
                qualname="hello",
                module_source=source,
            )
            write_flow_document(root, replace(document, sync_state="draft"))
            with self.assertRaisesRegex(ValueError, "not synchronized"):
                prepare_run_source(root)
            self.assertEqual((root / "app.py").read_text(), source)

    def test_external_source_change_and_forged_clean_flow_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = "def hello():\n    return 1\n"
            write_repo_files(root, {"app.py": source})
            document = import_flow_document_from_function_source(
                symbol_id="symbol:app:hello",
                relative_path="app.py",
                qualname="hello",
                module_source=source,
            )
            write_flow_document(root, document)
            (root / "app.py").write_text(source.replace("return 1", "return 2"))
            with self.assertRaisesRegex(ValueError, "flow source changed"):
                prepare_run_source(root)
            (root / "app.py").write_text(source)
            write_flow_document(root, replace(document, nodes=()))
            with self.assertRaisesRegex(ValueError, "does not compile cleanly"):
                prepare_run_source(root)

    def test_corrupt_or_unsupported_flow_storage_is_preserved_and_refused(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_repo_files(root, {"app.py": "print('ok')\n", FLOW_MODEL_RELATIVE_PATH: "{"})
            with self.assertRaisesRegex(ValueError, "cannot be decoded"):
                prepare_run_source(root)
            self.assertEqual((root / FLOW_MODEL_RELATIVE_PATH).read_text(), "{")
            (root / FLOW_MODEL_RELATIVE_PATH).write_text(
                json.dumps({"version": 999, "symbols": {}})
            )
            with self.assertRaisesRegex(ValueError, "unsupported"):
                prepare_run_source(root)

    def test_symlinks_pending_recovery_and_source_limits_refuse_admission(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_repo_files(root, {"app.py": "print('ok')\n"})
            (root / "alias.py").symlink_to(root / "app.py")
            with self.assertRaisesRegex(ValueError, "symlink file"):
                prepare_run_source(root)
            (root / "alias.py").unlink()
            with patch("helm.ui.run_preparation.MAX_SOURCE_BYTES", 1):
                with self.assertRaisesRegex(ValueError, "verification limit"):
                    prepare_run_source(root)
            write_repo_files(root, {".helm/recovery/journals/pending.json": "{}"})
            with self.assertRaisesRegex(ValueError, "recovery journal"):
                prepare_run_source(root)


if __name__ == "__main__":
    unittest.main()
