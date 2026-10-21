"""Real graph generation/preparation joins; child execution is synthetic Python only.

These tests do not invoke the Rust supervisor, a packaged app, or owner projects.
The launch spy counts actual bounded/reaped Python children after preparation.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from helm.editor.flow_model import (
    FLOW_MODEL_RELATIVE_PATH,
    import_flow_document_from_function_source,
    read_flow_document,
)
from helm.parser import PythonModuleParser
from helm.recovery import JournalPreimage, RepoMutationJournal, recover_pending
from helm.ui import desktop_bridge
from helm.ui.run_preparation import prepare_run_source
from helm.ui.workspace_session import WorkspaceSessionManager
from tests.helpers import write_repo_files


SOURCE = (
    'LABEL = "graph Ω"\n\n'
    "def run(a, b):\n    return b\n\n"
    'if __name__ == "__main__":\n'
    "    import hashlib, json\n"
    "    from pathlib import Path\n"
    '    print(json.dumps({"sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), '
    '"result": run(3, 11), "label": LABEL}))\n'
)
SYMBOL = "symbol:service:run"


class SyntheticPythonLaunch:
    def __init__(self, *, execute: bool = False) -> None:
        self.calls: list[Path] = []
        self.execute = execute

    def __call__(self, root: Path) -> dict:
        # Root-approved disposable script only, literal argv, no inherited secrets,
        # no shell, no grandchildren, bounded wait and subprocess.run-owned reap.
        environment = {"PATH": os.defpath}
        if os.name == "nt" and "SYSTEMROOT" in os.environ:
            environment["SYSTEMROOT"] = os.environ["SYSTEMROOT"]
        source = root / "service.py"
        self.calls.append(source)
        if not self.execute:
            return {}  # refusal/failing-before fixtures record attempts, never execute
        child = subprocess.run(
            [sys.executable, "-I", "-B", str(source)],
            cwd=root,
            env=environment,
            capture_output=True,
            timeout=3,
            check=True,
        )
        return json.loads(child.stdout)


class JoinedGraphRunPreparationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.manager = WorkspaceSessionManager()
        manager_patch = patch.object(desktop_bridge, "_SESSION_MANAGER", self.manager)
        manager_patch.start()
        self.addCleanup(manager_patch.stop)

    def _payload(self, root: Path) -> dict:
        return import_flow_document_from_function_source(
            symbol_id=SYMBOL,
            relative_path="service.py",
            qualname="run",
            module_source=(root / "service.py").read_text(encoding="utf-8"),
        ).to_dict()

    def _rewire_return(self, payload: dict, name: str) -> dict:
        return_ids = {node["id"] for node in payload["nodes"] if node["kind"] == "return"}
        slot = next(slot for slot in payload["input_slots"] if slot["node_id"] in return_ids)
        source = next(source for source in payload["function_inputs"] if source["name"] == name)
        payload["input_bindings"] = [
            {
                **binding,
                "id": f"flowbinding:{slot['id']}->{source['id']}",
                "source_id": source["id"],
                "function_input_id": source["id"],
            }
            if binding["slot_id"] == slot["id"]
            else binding
            for binding in payload["input_bindings"]
        ]
        return payload

    def _request(self, root: Path, payload: dict) -> dict:
        return {
            "id": 41,
            "command": "apply-edit",
            "params": {
                "repo": str(root),
                "request_json": json.dumps(
                    {"kind": "replace_flow_graph", "target_id": SYMBOL, "flow_graph": payload}
                ),
            },
        }

    def _edit(self, root: Path, payload: dict) -> dict:
        output = io.StringIO()
        desktop_bridge.run_worker(
            io.StringIO(json.dumps(self._request(root, payload)) + "\n"), output
        )
        return json.loads(output.getvalue())

    def _prepare_then_launch(self, root: Path, launch: SyntheticPythonLaunch) -> tuple[dict, dict]:
        proof = desktop_bridge._handle_worker_command("prepare-run-source", {"repo": str(root)})
        return proof, launch(root)

    def test_real_graph_binding_edit_saved_bytes_equal_prepared_and_child_observed_hash(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory(prefix="helm-graph-run-") as directory:
            root = Path(directory)
            write_repo_files(root, {"service.py": SOURCE})
            reply = self._edit(root, self._rewire_return(self._payload(root), "a"))
            self.assertTrue(reply["ok"], reply)
            self.assertEqual(reply["result"]["edit"]["flow_sync_state"], "clean")
            self.assertEqual(reply["result"]["edit"]["diagnostics"], [])
            self.assertIn("return a", (root / "service.py").read_text())
            stored = read_flow_document(root, SYMBOL)
            self.assertIsNotNone(stored)
            self.assertEqual(stored.sync_state, "clean")
            saved = (root / "service.py").read_bytes()
            launch = SyntheticPythonLaunch(execute=True)
            proof, observed = self._prepare_then_launch(root, launch)
            by_path = {item["relativePath"]: item["sha256"] for item in proof["files"]}
            self.assertEqual(len(launch.calls), 1)
            self.assertEqual(by_path["service.py"], hashlib.sha256(saved).hexdigest())
            self.assertEqual(observed["sha256"], by_path["service.py"])
            self.assertEqual(observed["result"], 3)  # last-good behavior was 11
            self.assertEqual(observed["label"], "graph Ω")
            self.assertEqual(
                by_path[FLOW_MODEL_RELATIVE_PATH],
                hashlib.sha256((root / FLOW_MODEL_RELATIVE_PATH).read_bytes()).hexdigest(),
            )
            undo = reply["result"]["edit"]["undo_transaction"]
            desktop_bridge._handle_worker_command(
                "apply-undo", {"repo": str(root), "transaction_json": json.dumps(undo)}
            )
            self.assertEqual((root / "service.py").read_bytes(), SOURCE.encode())
            self.assertFalse((root / FLOW_MODEL_RELATIVE_PATH).exists())

    def test_invalid_return_binding_retains_draft_diagnostic_and_creates_zero_children(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_repo_files(root, {"service.py": SOURCE})
            payload = self._payload(root)
            payload["input_bindings"] = []
            reply = self._edit(root, payload)
            self.assertTrue(reply["ok"], reply)
            edit = reply["result"]["edit"]
            self.assertEqual(edit["flow_sync_state"], "draft")
            self.assertIn("needs a value binding", " ".join(edit["diagnostics"]))
            self.assertEqual((root / "service.py").read_bytes(), SOURCE.encode())
            launch = SyntheticPythonLaunch()
            with self.assertRaisesRegex(ValueError, "not synchronized"):
                self._prepare_then_launch(root, launch)
            self.assertEqual(launch.calls, [])
            self.assertEqual(read_flow_document(root, SYMBOL).sync_state, "draft")

    def test_invalid_branch_binding_never_launches_last_good_source(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original = "def run(flag, a):\n    if flag:\n        x = a\n    return a\n"
            write_repo_files(root, {"service.py": original})
            payload = self._payload(root)
            return_id = next(node["id"] for node in payload["nodes"] if node["kind"] == "return")
            slot = next(slot for slot in payload["input_slots"] if slot["node_id"] == return_id)
            source = next(source for source in payload["value_sources"] if source["name"] == "x")
            payload["input_bindings"] = [
                {
                    "id": f"flowbinding:{slot['id']}->{source['id']}",
                    "slot_id": slot["id"],
                    "source_id": source["id"],
                }
                if binding["slot_id"] == slot["id"]
                else binding
                for binding in payload["input_bindings"]
            ]
            reply = self._edit(root, payload)
            self.assertTrue(reply["ok"], reply)
            self.assertEqual(reply["result"]["edit"]["flow_sync_state"], "draft")
            self.assertIn(
                "branch-only source after merge", " ".join(reply["result"]["edit"]["diagnostics"])
            )
            self.assertEqual((root / "service.py").read_text(), original)
            launch = SyntheticPythonLaunch()
            with self.assertRaisesRegex(ValueError, "not synchronized"):
                self._prepare_then_launch(root, launch)
            self.assertEqual(launch.calls, [])

    def test_watcher_delay_does_not_hide_external_change_from_preparation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_repo_files(root, {"service.py": SOURCE})
            reply = self._edit(root, self._rewire_return(self._payload(root), "a"))
            self.assertTrue(reply["ok"], reply)
            cached = self.manager.ensure_session(root)
            version = cached.session_version
            (root / "service.py").write_text(
                (root / "service.py").read_text().replace("return a", "return b")
            )
            launch = SyntheticPythonLaunch()
            with self.assertRaisesRegex(ValueError, "flow source changed"):
                self._prepare_then_launch(root, launch)
            self.assertEqual(launch.calls, [])
            self.assertEqual(cached.session_version, version)  # no watcher refresh delivered

    def test_reply_lost_after_real_commit_does_not_replay_mutation_or_launch(self) -> None:
        class LostReply:
            def write(self, _value: str) -> None:
                raise BrokenPipeError("injected reply loss after committed generation")

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_repo_files(root, {"service.py": SOURCE})
            request = self._request(root, self._rewire_return(self._payload(root), "a"))
            launch = SyntheticPythonLaunch()
            actual = desktop_bridge._handle_worker_command
            with patch.object(desktop_bridge, "_handle_worker_command", wraps=actual) as handler:
                with self.assertRaisesRegex(BrokenPipeError, "reply loss"):
                    desktop_bridge.run_worker(io.StringIO(json.dumps(request) + "\n"), LostReply())
                    self._prepare_then_launch(root, launch)
                self.assertEqual(handler.call_count, 1)
            self.assertIn("return a", (root / "service.py").read_text())
            self.assertEqual(read_flow_document(root, SYMBOL).sync_state, "clean")
            self.assertEqual(launch.calls, [])
            self.assertFalse(any((root / ".helm/recovery/journals").glob("*.json")))
            # A passive proof alone cannot detect a transport-lost reply. Native
            # admission must retain its request lease; separate Rust tests own it.
            self.assertTrue(prepare_run_source(root)["files"])

    def test_partial_metadata_failure_rolls_back_without_replaying_or_launching(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_repo_files(root, {"service.py": SOURCE})
            self.assertTrue(self._edit(root, self._payload(root))["ok"])
            source = (root / "service.py").read_bytes()
            metadata = (root / FLOW_MODEL_RELATIVE_PATH).read_bytes()
            payload = self._rewire_return(self._payload(root), "a")
            with patch(
                "helm.editor.patcher.write_flow_document",
                side_effect=OSError("metadata write failed"),
            ) as write:
                reply = self._edit(root, payload)
            self.assertFalse(reply["ok"])
            self.assertIn("metadata write failed", reply["error"])
            self.assertEqual(write.call_count, 1)
            self.assertEqual((root / "service.py").read_bytes(), source)
            self.assertEqual((root / FLOW_MODEL_RELATIVE_PATH).read_bytes(), metadata)
            self.assertFalse(any((root / ".helm/recovery/journals").glob("*.json")))

    def test_failed_partial_write_rollback_preserves_journal_and_refuses_preparation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_repo_files(root, {"service.py": SOURCE})
            self.assertTrue(self._edit(root, self._payload(root))["ok"])
            source = (root / "service.py").read_bytes()
            metadata = (root / FLOW_MODEL_RELATIVE_PATH).read_bytes()
            payload = self._rewire_return(self._payload(root), "a")
            with (
                patch(
                    "helm.editor.patcher.write_flow_document",
                    side_effect=OSError("metadata write failed"),
                ),
                patch(
                    "helm.recovery.JournalOperation._restore_entry",
                    side_effect=OSError("rollback blocked"),
                ),
            ):
                reply = self._edit(root, payload)
            self.assertFalse(reply["ok"])
            self.assertIn("rollback blocked", reply["error"])
            self.assertIn("return a", (root / "service.py").read_text())
            self.assertEqual((root / FLOW_MODEL_RELATIVE_PATH).read_bytes(), metadata)
            journals = list((root / ".helm/recovery/journals").glob("*.json"))
            self.assertEqual(len(journals), 1)
            self.assertEqual(json.loads(journals[0].read_text())["phase"], "rolling_back")
            launch = SyntheticPythonLaunch()
            with self.assertRaisesRegex(ValueError, "recovery journal"):
                self._prepare_then_launch(root, launch)
            self.assertEqual(launch.calls, [])
            events = recover_pending(root)  # explicit reconciliation, no edit replay
            self.assertEqual([event.outcome for event in events], ["rolled_back"])
            self.assertEqual((root / "service.py").read_bytes(), source)
            self.assertEqual((root / FLOW_MODEL_RELATIVE_PATH).read_bytes(), metadata)

    def test_new_file_during_preparation_invalidates_the_entire_inventory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_repo_files(root, {"service.py": "def run():\n    return 1\n"})
            actual = PythonModuleParser.parse_source

            def add_after_parse(parser, module, source):
                result = actual(parser, module, source)
                (root / "late.py").write_text("LATE = 2\n")
                return result

            launch = SyntheticPythonLaunch()
            with patch.object(PythonModuleParser, "parse_source", add_after_parse):
                with self.assertRaisesRegex(ValueError, "inventory changed"):
                    self._prepare_then_launch(root, launch)
            self.assertEqual(launch.calls, [])

    def test_recovery_started_during_preparation_invalidates_the_proof(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_repo_files(root, {"service.py": "def run():\n    return 1\n"})
            actual = PythonModuleParser.parse_source

            def journal_after_parse(parser, module, source):
                result = actual(parser, module, source)
                RepoMutationJournal(root).prepare(
                    kind="test-pending", preimages=(JournalPreimage("service.py"),)
                )
                return result

            launch = SyntheticPythonLaunch()
            with patch.object(PythonModuleParser, "parse_source", journal_after_parse):
                with self.assertRaisesRegex(ValueError, "recovery journal"):
                    self._prepare_then_launch(root, launch)
            self.assertEqual(launch.calls, [])
            self.assertEqual(len(list((root / ".helm/recovery/journals").glob("*.json"))), 1)

    def test_inventory_bounds_empty_directories_as_well_as_file_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_repo_files(root, {"service.py": "def run():\n    return 1\n"})
            (root / "empty-a").mkdir()
            (root / "empty-b").mkdir()
            with patch("helm.ui.run_preparation.MAX_INVENTORY_ENTRIES", 2, create=True):
                with self.assertRaisesRegex(ValueError, "inventory.*limit"):
                    prepare_run_source(root)

    def test_preparation_never_reads_ignore_files_from_excluded_trees(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            excluded = {".helm", ".venv-helm-dev", "target"}
            write_repo_files(
                root,
                {
                    "service.py": "def run():\n    return 1\n",
                    **{f"{name}/.gitignore": "deep/\n" for name in excluded},
                    **{
                        f"{name}/deep/ignored.py": "def ignored():\n    return 2\n"
                        for name in excluded
                    },
                },
            )
            actual = Path.read_text

            def guarded_read(path, *args, **kwargs):
                if path.name == ".gitignore" and excluded.intersection(path.parts):
                    raise AssertionError(f"Preparation traversed excluded tree: {path.parent.name}")
                return actual(path, *args, **kwargs)

            with patch.object(Path, "read_text", guarded_read):
                proof = prepare_run_source(root)
            self.assertEqual([symbol["nodeId"] for symbol in proof["indexedSymbols"]], [SYMBOL])
            self.assertEqual([item["relativePath"] for item in proof["files"]], ["service.py"])

    def test_bounded_manifest_mapping_preserves_package_ids_and_nested_gitignore_scopes(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_repo_files(
                root,
                {
                    ".gitignore": "*.tmp.py\n!keep.tmp.py\n",
                    "__init__.py": "def root():\n    return 1\n",
                    "pkg/__init__.py": "def package():\n    return 2\n",
                    "pkg/.gitignore": "generated/\n",
                    "pkg/service.py": "def run():\n    return 3\n",
                    "pkg/generated/ignored.py": "def ignored():\n    return 4\n",
                    "other/generated/keep.py": "def keep():\n    return 5\n",
                    "scratch.tmp.py": "def ignored():\n    return 6\n",
                    "keep.tmp.py": "def kept():\n    return 7\n",
                },
            )
            proof = prepare_run_source(root)
            self.assertEqual(
                {symbol["nodeId"] for symbol in proof["indexedSymbols"]},
                {
                    "symbol:__init__:root",
                    "symbol:pkg:package",
                    "symbol:pkg.service:run",
                    "symbol:other.generated.keep:keep",
                    "symbol:keep.tmp:kept",
                },
            )
            # Gitignored source remains frozen for execution, but it must not be
            # represented as if it were indexed in the IDE's code graph.
            paths = {item["relativePath"] for item in proof["files"]}
            self.assertIn("pkg/generated/ignored.py", paths)
            self.assertIn("scratch.tmp.py", paths)

    def test_parser_uses_frozen_source_without_reopening_a_growing_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            raw = "def run():\r\n    return 'Ω'\r\n".encode()
            (root / "service.py").write_bytes(raw)
            actual = Path.read_text

            def bounded_reads_only(path, *args, **kwargs):
                if path.name == "service.py":
                    raise AssertionError("Parser reopened source instead of using frozen bytes")
                return actual(path, *args, **kwargs)

            with patch.object(Path, "read_text", bounded_reads_only):
                proof = prepare_run_source(root)
            symbol = proof["indexedSymbols"][0]
            self.assertEqual(symbol["nodeId"], SYMBOL)
            self.assertEqual(symbol["startLine"], 1)
            self.assertEqual(symbol["endLine"], 2)
            self.assertEqual(symbol["sourceHash"], hashlib.sha256(raw).hexdigest())

    def test_non_utf8_python_keeps_frozen_bytes_without_fabricated_mapping(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            raw = b"# coding: latin-1\ndef run():\n    return '\xff'\n"
            (root / "service.py").write_bytes(raw)
            proof = prepare_run_source(root)
            self.assertEqual(proof["indexedSymbols"], [])
            self.assertEqual(proof["files"][0]["sha256"], hashlib.sha256(raw).hexdigest())


if __name__ == "__main__":
    unittest.main()
