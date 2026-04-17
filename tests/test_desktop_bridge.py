from __future__ import annotations

import io
import json
import tempfile
import unittest
from pathlib import Path

from helm.editor.flow_model import import_flow_document_from_function_source
from helm.ui.desktop_bridge import (
    apply_undo_to_payload,
    apply_edit_to_payload,
    build_flow_view_payload,
    reveal_source_payload,
    run_worker,
    scan_repo_to_payload,
)
from tests.helpers import write_repo_files


def _progress_frames(responses: list[dict]) -> list[dict]:
    return [
        response["payload"]
        for response in responses
        if response.get("event") == "progress"
    ]


def _unique_progress_stages(frames: list[dict]) -> list[str]:
    stages: list[str] = []
    for frame in frames:
        stage = frame["stage"]
        if not stages or stages[-1] != stage:
            stages.append(stage)
    return stages


class DesktopBridgeTests(unittest.TestCase):
    def test_scan_repo_to_payload_returns_workspace_metadata(self) -> None:
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
            self.assertIn("workspace", payload)
            self.assertEqual(payload["summary"]["module_count"], 2)
            self.assertEqual(payload["graph"]["report"]["call_edge_count"], 1)
            self.assertEqual(payload["workspace"]["default_level"], "symbol")

    def test_flow_and_reveal_source_payloads_are_available(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir) / "repo"
            write_repo_files(
                root,
                {
                    "service.py": (
                        "def run(value):\n"
                        "    prepared = value + 1\n"
                        "    if prepared:\n"
                        "        return prepared\n"
                        "    return 0\n"
                    ),
                },
            )

            flow = build_flow_view_payload(root, "symbol:service:run")
            revealed = reveal_source_payload(root, "symbol:service:run")

            self.assertEqual(flow["level"], "flow")
            self.assertIn("param", {node["kind"] for node in flow["nodes"]})
            document = flow["flow_state"]["document"]
            self.assertEqual(
                document["function_inputs"][0]["kind"],
                "positional_or_keyword",
            )
            self.assertEqual(revealed["path"], "service.py")
            self.assertIn("def run(value):", revealed["content"])

    def test_class_flow_payload_is_available(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir) / "repo"
            write_repo_files(
                root,
                {
                    "service.py": (
                        "class Service:\n"
                        "    enabled = True\n\n"
                        "    def run(self):\n"
                        "        return self.enabled\n"
                    ),
                },
            )

            flow = build_flow_view_payload(root, "symbol:service:Service")

            self.assertEqual(flow["level"], "flow")
            self.assertEqual(flow["nodes"][0]["kind"], "entry")
            self.assertIn("variable", {node["kind"] for node in flow["nodes"]})
            self.assertIn("function", {node["kind"] for node in flow["nodes"]})

    def test_apply_edit_to_payload_returns_refreshed_payload(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir) / "repo"
            write_repo_files(root, {"service.py": "def helper():\n    return 'ok'\n"})

            response = apply_edit_to_payload(
                root,
                json.dumps(
                    {
                        "kind": "rename_symbol",
                        "target_id": "symbol:service:helper",
                        "new_name": "helper_blueprint",
                    }
                ),
            )

            self.assertIn("edit", response)
            self.assertIn("payload", response)
            self.assertIn("Renamed helper", response["edit"]["summary"])
            symbol_names = {
                node["name"]
                for node in response["payload"]["graph"]["nodes"]
                if node["kind"] == "symbol"
            }
            self.assertIn("helper_blueprint", symbol_names)

    def test_apply_edit_to_payload_create_returns_changed_symbol_id(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir) / "repo"
            write_repo_files(root, {"service.py": "def helper():\n    return 'ok'\n"})

            response = apply_edit_to_payload(
                root,
                json.dumps(
                    {
                        "kind": "create_symbol",
                        "relative_path": "service.py",
                        "new_name": "build_issue_one",
                        "symbol_kind": "function",
                    }
                ),
            )

            self.assertIn("Created function build_issue_one", response["edit"]["summary"])
            self.assertEqual(
                response["edit"]["changed_node_ids"],
                ["symbol:service:build_issue_one"],
            )

    def test_apply_edit_to_payload_create_module_returns_changed_module_id(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir) / "repo"
            write_repo_files(root, {"service.py": "def helper():\n    return 'ok'\n"})

            response = apply_edit_to_payload(
                root,
                json.dumps(
                    {
                        "kind": "create_module",
                        "relative_path": "pkg/tools.py",
                        "content": "def run():\n    return 1",
                    }
                ),
            )

            self.assertEqual(response["edit"]["changed_node_ids"], ["module:pkg.tools"])
            self.assertEqual(response["payload"]["summary"]["module_count"], 2)

    def test_apply_edit_to_payload_insert_flow_statement_returns_changed_flow_id(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir) / "repo"
            write_repo_files(
                root,
                {
                    "service.py": (
                        "def run():\n"
                        "    current = 1\n"
                        "    return current\n"
                    ),
                },
            )

            response = apply_edit_to_payload(
                root,
                json.dumps(
                    {
                        "kind": "insert_flow_statement",
                        "target_id": "symbol:service:run",
                        "anchor_edge_id": (
                            "controls:flow:symbol:service:run:statement:0"
                            "->flow:symbol:service:run:statement:1"
                        ),
                        "content": "helper = current + 1",
                    }
                ),
            )

            self.assertEqual(
                response["edit"]["changed_node_ids"],
                ["flow:symbol:service:run:statement:1"],
            )
            self.assertIn("helper = current + 1", (root / "service.py").read_text(encoding="utf-8"))

    def test_apply_edit_to_payload_round_trips_draft_replace_flow_graph(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir) / "repo"
            source = (
                "def run(value):\n"
                "    return value\n"
            )
            write_repo_files(root, {"service.py": source})

            imported = import_flow_document_from_function_source(
                symbol_id="symbol:service:run",
                relative_path="service.py",
                qualname="run",
                module_source=source,
            )
            draft_payload = imported.to_dict()
            draft_payload["nodes"].append(
                {
                    "id": "flowdoc:symbol:service:run:call:disconnected",
                    "kind": "call",
                    "payload": {"source": "notify(value)"},
                }
            )

            response = apply_edit_to_payload(
                root,
                json.dumps(
                    {
                        "kind": "replace_flow_graph",
                        "target_id": "symbol:service:run",
                        "flow_graph": draft_payload,
                    }
                ),
            )
            flow = build_flow_view_payload(root, "symbol:service:run")

            self.assertEqual(response["edit"]["flow_sync_state"], "draft")
            self.assertEqual(response["edit"]["touched_relative_paths"], [".helm/flow-models.v1.json"])
            self.assertTrue(response["edit"]["diagnostics"])
            self.assertEqual(flow["flow_state"]["sync_state"], "draft")
            self.assertTrue(flow["flow_state"]["diagnostics"])
            self.assertTrue(
                any(
                    node["id"] == "flowdoc:symbol:service:run:call:disconnected"
                    for node in flow["flow_state"]["document"]["nodes"]
                )
            )

    def test_apply_edit_to_payload_round_trips_clean_replace_flow_graph(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir) / "repo"
            source = (
                "def run(value):\n"
                "    return value\n"
            )
            write_repo_files(root, {"service.py": source})

            imported = import_flow_document_from_function_source(
                symbol_id="symbol:service:run",
                relative_path="service.py",
                qualname="run",
                module_source=source,
            )
            clean_payload = imported.to_dict()
            original_edge = clean_payload["edges"][0]
            call_node_id = "flowdoc:symbol:service:run:call:prepare"
            clean_payload["nodes"].append(
                {
                    "id": call_node_id,
                    "kind": "call",
                    "payload": {"source": "prepare(value)"},
                }
            )
            clean_payload["edges"] = [
                {
                    "id": f"controls:{original_edge['source_id']}:start->{call_node_id}:in",
                    "source_id": original_edge["source_id"],
                    "source_handle": "start",
                    "target_id": call_node_id,
                    "target_handle": "in",
                },
                {
                    "id": f"controls:{call_node_id}:next->{original_edge['target_id']}:in",
                    "source_id": call_node_id,
                    "source_handle": "next",
                    "target_id": original_edge["target_id"],
                    "target_handle": "in",
                },
            ]

            response = apply_edit_to_payload(
                root,
                json.dumps(
                    {
                        "kind": "replace_flow_graph",
                        "target_id": "symbol:service:run",
                        "flow_graph": clean_payload,
                    }
                ),
            )
            flow = build_flow_view_payload(root, "symbol:service:run")

            self.assertEqual(response["edit"]["flow_sync_state"], "clean")
            self.assertEqual(
                response["edit"]["touched_relative_paths"],
                ["service.py", ".helm/flow-models.v1.json"],
            )
            self.assertEqual(flow["flow_state"]["sync_state"], "clean")
            self.assertEqual(flow["flow_state"]["diagnostics"], [])
            self.assertTrue(
                any(node["id"] == call_node_id for node in flow["flow_state"]["document"]["nodes"])
            )
            self.assertIn("prepare(value)", (root / "service.py").read_text(encoding="utf-8"))

    def test_apply_undo_to_payload_restores_created_symbol(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir) / "repo"
            write_repo_files(root, {"service.py": "def helper():\n    return 'ok'\n"})

            edit_response = apply_edit_to_payload(
                root,
                json.dumps(
                    {
                        "kind": "create_symbol",
                        "relative_path": "service.py",
                        "new_name": "build_issue_three",
                        "symbol_kind": "function",
                    }
                ),
            )
            self.assertIn("build_issue_three", (root / "service.py").read_text(encoding="utf-8"))

            undo_response = apply_undo_to_payload(
                root,
                json.dumps(edit_response["edit"]["undo_transaction"]),
            )

            self.assertNotIn("build_issue_three", (root / "service.py").read_text(encoding="utf-8"))
            self.assertEqual(
                undo_response["undo"]["focus_target"],
                {
                    "target_id": "module:service",
                    "level": "module",
                },
            )

    def test_run_worker_reuses_workspace_session_across_requests(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir) / "repo"
            write_repo_files(root, {"service.py": "def helper():\n    return 'ok'\n"})

            stdin = io.StringIO(
                "\n".join(
                    [
                        json.dumps(
                            {
                                "id": 1,
                                "command": "scan",
                                "params": {"repo": str(root)},
                            }
                        ),
                        json.dumps(
                            {
                                "id": 2,
                                "command": "apply-edit",
                                "params": {
                                    "repo": str(root),
                                    "request_json": json.dumps(
                                        {
                                            "kind": "rename_symbol",
                                            "target_id": "symbol:service:helper",
                                            "new_name": "helper_blueprint",
                                        }
                                    ),
                                },
                            }
                        ),
                        json.dumps(
                            {
                                "id": 3,
                                "command": "scan",
                                "params": {"repo": str(root)},
                            }
                        ),
                        json.dumps({"id": 4, "command": "shutdown", "params": {}}),
                    ]
                )
                + "\n"
            )
            stdout = io.StringIO()

            exit_code = run_worker(stdin=stdin, stdout=stdout)

            self.assertEqual(exit_code, 0)
            responses = [json.loads(line) for line in stdout.getvalue().splitlines()]
            self.assertEqual(
                [response["id"] for response in responses],
                [1, 2, 3, 4],
            )
            self.assertEqual(
                responses[0]["result"]["workspace"]["session_version"],
                1,
            )
            self.assertEqual(
                responses[1]["result"]["payload"]["workspace"]["session_version"],
                2,
            )
            self.assertEqual(
                responses[2]["result"]["workspace"]["session_version"],
                2,
            )
            symbol_names = {
                node["name"]
                for node in responses[2]["result"]["graph"]["nodes"]
                if node["kind"] == "symbol"
            }
            self.assertIn("helper_blueprint", symbol_names)

    def test_run_worker_full_resync_emits_progress_frames_when_requested(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir) / "repo"
            write_repo_files(
                root,
                {
                    "alpha.py": "def one():\n    return 1\n",
                    "beta.py": "def two():\n    return 2\n",
                },
            )

            stdin = io.StringIO(
                "\n".join(
                    [
                        json.dumps(
                            {
                                "id": 1,
                                "command": "full-resync",
                                "params": {
                                    "repo": str(root),
                                    "emit_progress": True,
                                },
                            }
                        ),
                        json.dumps({"id": 2, "command": "shutdown", "params": {}}),
                    ]
                )
                + "\n"
            )
            stdout = io.StringIO()

            exit_code = run_worker(stdin=stdin, stdout=stdout)

            self.assertEqual(exit_code, 0)
            responses = [json.loads(line) for line in stdout.getvalue().splitlines()]
            frames = _progress_frames(responses)
            self.assertEqual(
                _unique_progress_stages(frames),
                ["discover", "parse", "graph_build", "cache_finalize"],
            )
            self.assertEqual(responses[-2]["id"], 1)
            self.assertTrue(responses[-2]["ok"])

    def test_run_worker_emits_stage_scoped_error_progress_before_failure(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            missing_root = Path(tmp_dir) / "missing"
            stdin = io.StringIO(
                "\n".join(
                    [
                        json.dumps(
                            {
                                "id": 1,
                                "command": "full-resync",
                                "params": {
                                    "repo": str(missing_root),
                                    "emit_progress": True,
                                },
                            }
                        ),
                        json.dumps({"id": 2, "command": "shutdown", "params": {}}),
                    ]
                )
                + "\n"
            )
            stdout = io.StringIO()

            exit_code = run_worker(stdin=stdin, stdout=stdout)

            self.assertEqual(exit_code, 0)
            responses = [json.loads(line) for line in stdout.getvalue().splitlines()]
            frames = _progress_frames(responses)
            self.assertEqual(frames[-1]["status"], "error")
            self.assertEqual(frames[-1]["stage"], "discover")
            self.assertIn("does not exist", frames[-1]["error"])
            self.assertFalse(responses[-2]["ok"])
