from __future__ import annotations

import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

from helm.editor import serialize_edit_request, serialize_undo_transaction
from helm.editor.flow_model import (
    FlowModelDocument,
    FlowModelEdge,
    FlowModelNode,
    compile_flow_document,
    expression_from_expression_graph,
    expression_graph_from_expression,
    flow_return_completion_edge_id,
    import_flow_document_from_function_source,
    read_flow_document,
    write_flow_document,
)
from helm.graph.models import GraphAbstractionLevel
from helm.ui.python_adapter import PythonRepoAdapter
from tests.helpers import write_repo_files


def _replace_flow_node_id(
    document: FlowModelDocument,
    *,
    original_node_id: str,
    replacement_node_id: str,
) -> FlowModelDocument:
    return replace(
        document,
        nodes=tuple(
            replace(node, node_id=replacement_node_id)
            if node.node_id == original_node_id
            else node
            for node in document.nodes
        ),
        edges=tuple(
            replace(
                edge,
                edge_id=edge.edge_id.replace(original_node_id, replacement_node_id),
                source_id=replacement_node_id if edge.source_id == original_node_id else edge.source_id,
                target_id=replacement_node_id if edge.target_id == original_node_id else edge.target_id,
            )
            for edge in document.edges
        ),
    )


class PythonRepoAdapterTests(unittest.TestCase):
    def test_default_level_uses_repo_for_empty_repos_symbol_for_small_repo_and_module_for_large_repo(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            empty_root = Path(tmp_dir) / "empty"
            empty_root.mkdir()

            small_root = Path(tmp_dir) / "small"
            write_repo_files(
                small_root,
                {
                    "service.py": "def run():\n    return 1\n",
                },
            )

            large_root = Path(tmp_dir) / "large"
            large_files = {
                f"module_{index}.py": f"def run_{index}():\n    return {index}\n"
                for index in range(9)
            }
            write_repo_files(large_root, large_files)

            self.assertEqual(PythonRepoAdapter.scan(empty_root).default_level().value, "repo")
            self.assertEqual(PythonRepoAdapter.scan(small_root).default_level().value, "symbol")
            self.assertEqual(PythonRepoAdapter.scan(large_root).default_level().value, "module")

    def test_repo_view_aggregates_module_relationships(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            write_repo_files(
                root,
                {
                    "alpha.py": "def one():\n    return 1\n\ndef two():\n    return 2\n",
                    "beta.py": (
                        "from alpha import one, two\n\n"
                        "def run():\n"
                        "    return one() + two()\n"
                    ),
                },
            )

            adapter = PythonRepoAdapter.scan(root)
            view = adapter.get_graph_view(adapter.graph.repo_id, GraphAbstractionLevel.REPO)

            import_edges = [
                edge
                for edge in view.edges
                if edge.kind.value == "imports"
                and edge.source_id == "module:beta"
                and edge.target_id == "module:alpha"
            ]
            call_edges = [
                edge
                for edge in view.edges
                if edge.kind.value == "calls"
                and edge.source_id == "module:beta"
                and edge.target_id == "module:alpha"
            ]

            self.assertEqual(len(import_edges), 1)
            self.assertEqual(len(call_edges), 1)
            self.assertEqual(call_edges[0].metadata["count"], 2)

    def test_flow_view_extracts_operational_nodes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
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

            adapter = PythonRepoAdapter.scan(root)
            flow = adapter.get_flow_view("symbol:service:run")
            kinds = {node.kind.value for node in flow.nodes}
            control_edges = [edge for edge in flow.edges if edge.kind.value == "controls"]
            data_edges = [edge for edge in flow.edges if edge.kind.value == "data"]

            self.assertIn("param", kinds)
            self.assertIn("assign", kinds)
            self.assertIn("branch", kinds)
            self.assertIn("return", kinds)
            node_ids_by_kind = {
                node.kind.value: {candidate.node_id for candidate in flow.nodes if candidate.kind.value == node.kind.value}
                for node in flow.nodes
            }
            self.assertTrue(
                any(
                    edge.source_id.endswith(":entry")
                    and edge.target_id in node_ids_by_kind["assign"]
                    for edge in control_edges
                )
            )
            self.assertFalse(any(":param:" in edge.target_id for edge in control_edges))
            self.assertTrue(any(edge.source_id.endswith(":param:value") for edge in data_edges))
            branch_node = next(node.node_id for node in flow.nodes if node.kind.value == "branch")
            branch_edges = [edge for edge in control_edges if edge.source_id == branch_node]
            self.assertEqual({edge.label for edge in branch_edges}, {"true", "false"})
            self.assertEqual(
                {edge.metadata["path_key"] for edge in branch_edges},
                {"true", "false"},
            )
            exit_node = next(node.node_id for node in flow.nodes if node.kind.value == "exit")
            return_nodes = [node.node_id for node in flow.nodes if node.kind.value == "return"]
            self.assertEqual(len(return_nodes), 2)
            self.assertEqual(
                {
                    (edge.source_id, edge.target_id, edge.metadata.get("flow_return_completion"))
                    for edge in control_edges
                    if edge.metadata.get("flow_return_completion")
                },
                {
                    (return_node, exit_node, True)
                    for return_node in return_nodes
                },
            )
            param_node = next(node for node in flow.nodes if node.node_id.endswith(":param:value"))
            self.assertEqual(param_node.metadata["source_start_line"], 1)
            self.assertEqual(param_node.metadata["source_end_line"], 1)
            assign_node = next(node for node in flow.nodes if node.kind.value == "assign")
            self.assertEqual(assign_node.metadata["source_start_line"], 2)
            self.assertEqual(assign_node.metadata["source_end_line"], 2)
            self.assertIsNotNone(flow.flow_state)
            assert flow.flow_state is not None
            self.assertTrue(flow.flow_state["editable"])
            self.assertEqual(flow.flow_state["sync_state"], "clean")
            self.assertIsNotNone(flow.flow_state["document"])
            document = flow.flow_state["document"]
            assert document is not None
            self.assertFalse(any(node["kind"] == "param" for node in document["nodes"]))

    def test_flow_import_derives_exotic_signature_metadata(self) -> None:
        source = (
            "class Service:\n"
            "    @classmethod\n"
            "    async def build(cls, a, /, b=1, *args, c, d=2, **kwargs):\n"
            "        return b\n"
        )

        document = import_flow_document_from_function_source(
            symbol_id="symbol:service:Service.build",
            relative_path="service.py",
            qualname="Service.build",
            module_source=source,
        )

        self.assertEqual(
            [
                (function_input.name, function_input.kind, function_input.default_expression)
                for function_input in document.function_inputs
            ],
            [
                ("cls", "positional_only", None),
                ("a", "positional_only", None),
                ("b", "positional_or_keyword", "1"),
                ("args", "vararg", None),
                ("c", "keyword_only", None),
                ("d", "keyword_only", "2"),
                ("kwargs", "kwarg", None),
            ],
        )
        self.assertEqual(
            [
                item.get("kind")
                for item in document.to_dict()["function_inputs"]
            ],
            [
                "positional_only",
                "positional_only",
                "positional_or_keyword",
                "vararg",
                "keyword_only",
                "keyword_only",
                "kwarg",
            ],
        )

    def test_flow_import_derives_return_expression_graph(self) -> None:
        source = "def add(a, b, c):\n    return a + b + c\n"

        document = import_flow_document_from_function_source(
            symbol_id="symbol:service:add",
            relative_path="service.py",
            qualname="add",
            module_source=source,
        )
        return_node = next(node for node in document.nodes if node.kind == "return")
        expression_graph = return_node.payload["expression_graph"]

        self.assertEqual([function_input.name for function_input in document.function_inputs], ["a", "b", "c"])
        self.assertEqual({slot.slot_key for slot in document.input_slots}, {"a", "b", "c"})
        self.assertEqual(
            {binding.source_id for binding in document.input_bindings},
            {
                "flowinput:symbol:service:add:a",
                "flowinput:symbol:service:add:b",
                "flowinput:symbol:service:add:c",
            },
        )
        self.assertEqual(expression_from_expression_graph(expression_graph), "a + b + c")
        self.assertEqual(
            {
                node["payload"]["name"]
                for node in expression_graph["nodes"]
                if node["kind"] == "input"
            },
            {"a", "b", "c"},
        )
        self.assertTrue(any(node["kind"] == "operator" and node["label"] == "+" for node in expression_graph["nodes"]))
        compiled = compile_flow_document(document)
        self.assertEqual(compiled.sync_state, "clean")
        self.assertEqual(compiled.body_source, "return a + b + c")

    def test_expression_graph_preserves_unsupported_subtrees_as_raw_nodes(self) -> None:
        graph = expression_graph_from_expression("[value for value in items]")

        self.assertEqual(expression_from_expression_graph(graph), "[value for value in items]")
        self.assertEqual(
            [node["kind"] for node in graph["nodes"]],
            ["raw"],
        )

    def test_return_expression_graph_reports_unconnected_inputs(self) -> None:
        source = "def add(a, b, c):\n    return a + b\n"
        document = import_flow_document_from_function_source(
            symbol_id="symbol:service:add",
            relative_path="service.py",
            qualname="add",
            module_source=source,
        )
        return_node = next(node for node in document.nodes if node.kind == "return")
        graph = return_node.payload["expression_graph"]
        graph["nodes"].append({
            "id": "expr:input:c",
            "kind": "input",
            "label": "c",
            "payload": {
                "name": "c",
                "slot_id": "flowslot:flow:symbol:service:add:statement:0:c",
            },
        })
        document = replace(
            document,
            nodes=tuple(
                replace(node, payload={**node.payload, "expression_graph": graph})
                if node.node_id == return_node.node_id
                else node
                for node in document.nodes
            ),
        )

        result = compile_flow_document(document)

        self.assertEqual(result.sync_state, "draft")
        self.assertTrue(any("not connected to the return expression: c" in diagnostic for diagnostic in result.diagnostics))

    def test_flow_view_marks_loop_body_and_exit_paths(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            write_repo_files(
                root,
                {
                    "service.py": (
                        "def run(items):\n"
                        "    while items:\n"
                        "        items = items[1:]\n"
                        "    return len(items)\n"
                    ),
                },
            )

            adapter = PythonRepoAdapter.scan(root)
            flow = adapter.get_flow_view("symbol:service:run")
            loop_node = next(node.node_id for node in flow.nodes if node.kind.value == "loop")
            loop_edges = [
                edge
                for edge in flow.edges
                if edge.kind.value == "controls" and edge.source_id == loop_node
            ]

            self.assertEqual({edge.label for edge in loop_edges}, {"body", "after"})
            self.assertEqual(
                {edge.metadata["path_key"] for edge in loop_edges},
                {"body", "after"},
            )

    def test_flow_view_rehydrates_persisted_draft_documents_with_diagnostics(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            source = (
                "def run(value):\n"
                "    return value\n"
            )
            write_repo_files(root, {"service.py": source})

            adapter = PythonRepoAdapter.scan(root)
            imported = import_flow_document_from_function_source(
                symbol_id="symbol:service:run",
                relative_path="service.py",
                qualname="run",
                module_source=source,
            )
            source_backed_return_id = next(
                node.node_id
                for node in imported.nodes
                if node.kind == "return"
            )
            renamed_document = _replace_flow_node_id(
                imported,
                original_node_id=source_backed_return_id,
                replacement_node_id="flowdoc:symbol:service:run:return:draft",
            )
            draft_document = replace(
                renamed_document,
                nodes=(
                    *renamed_document.nodes,
                    FlowModelNode(
                        node_id="flowdoc:symbol:service:run:call:disconnected",
                        kind="call",
                        payload={"source": "notify(value)"},
                    ),
                ),
                sync_state="draft",
                diagnostics=("Unreachable flow nodes block code generation: flowdoc:symbol:service:run:call:disconnected.",),
            )
            write_flow_document(root, draft_document)

            flow = adapter.get_flow_view("symbol:service:run")

            self.assertIsNotNone(flow.flow_state)
            assert flow.flow_state is not None
            self.assertEqual(flow.flow_state["sync_state"], "draft")
            self.assertTrue(flow.flow_state["editable"])
            self.assertTrue(
                any("Unreachable flow nodes" in message for message in flow.flow_state["diagnostics"])
            )
            document = flow.flow_state["document"]
            self.assertIsNotNone(document)
            assert document is not None
            self.assertEqual(document["sync_state"], "draft")
            self.assertTrue(
                any(node["id"] == "flowdoc:symbol:service:run:call:disconnected" for node in document["nodes"])
            )
            self.assertIn("flow:symbol:service:run:param:value", {node.node_id for node in flow.nodes})
            self.assertIn("flowdoc:symbol:service:run:return:draft", {node.node_id for node in flow.nodes})
            self.assertTrue(
                any(
                    edge.kind.value == "data"
                    and edge.source_id == "flow:symbol:service:run:param:value"
                    and edge.target_id == "flowdoc:symbol:service:run:return:draft"
                )
                for edge in flow.edges
            )
            exit_node = next(node.node_id for node in flow.nodes if node.kind.value == "exit")
            self.assertTrue(
                any(
                    edge.kind.value == "controls"
                    and edge.source_id == "flowdoc:symbol:service:run:return:draft"
                    and edge.target_id == exit_node
                    and edge.edge_id == flow_return_completion_edge_id(
                        "flowdoc:symbol:service:run:return:draft",
                        exit_node,
                    )
                    and edge.metadata.get("flow_return_completion") is True
                )
                for edge in flow.edges
            )

    def test_flow_view_keeps_method_parameter_wires_when_persisted_document_is_draft_backed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            source = (
                "class Service:\n"
                "    def run(self, value):\n"
                "        return self.scale(value)\n"
            )
            write_repo_files(root, {"service.py": source})

            imported = import_flow_document_from_function_source(
                symbol_id="symbol:service:Service.run",
                relative_path="service.py",
                qualname="Service.run",
                module_source=source,
            )
            source_backed_return_id = next(
                node.node_id
                for node in imported.nodes
                if node.kind == "return"
            )
            draft_document = replace(
                _replace_flow_node_id(
                    imported,
                    original_node_id=source_backed_return_id,
                    replacement_node_id="flowdoc:symbol:service:Service.run:return:draft",
                ),
                sync_state="draft",
                diagnostics=("Synthetic draft diagnostics.",),
            )
            write_flow_document(root, draft_document)

            adapter = PythonRepoAdapter.scan(root)
            flow = adapter.get_flow_view("symbol:service:Service.run")

            self.assertIn("flow:symbol:service:Service.run:param:self", {node.node_id for node in flow.nodes})
            self.assertIn("flow:symbol:service:Service.run:param:value", {node.node_id for node in flow.nodes})
            self.assertIn(
                "flowdoc:symbol:service:Service.run:return:draft",
                {node.node_id for node in flow.nodes},
            )
            self.assertTrue(
                any(
                    edge.kind.value == "data"
                    and edge.source_id == "flow:symbol:service:Service.run:param:self"
                    and edge.target_id == "flowdoc:symbol:service:Service.run:return:draft"
                )
                for edge in flow.edges
            )
            self.assertTrue(
                any(
                    edge.kind.value == "data"
                    and edge.source_id == "flow:symbol:service:Service.run:param:value"
                    and edge.target_id == "flowdoc:symbol:service:Service.run:return:draft"
                )
                for edge in flow.edges
            )

    def test_flow_view_backfills_function_inputs_for_legacy_persisted_documents(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            source = (
                "def add(a, b):\n"
                "    return a + b\n"
            )
            write_repo_files(root, {"service.py": source})

            imported = import_flow_document_from_function_source(
                symbol_id="symbol:service:add",
                relative_path="service.py",
                qualname="add",
                module_source=source,
            )
            legacy_document = replace(
                imported,
                function_inputs=(),
                input_slots=(),
                input_bindings=(),
            )
            write_flow_document(root, legacy_document)

            adapter = PythonRepoAdapter.scan(root)
            flow = adapter.get_flow_view("symbol:service:add")

            document = flow.flow_state["document"] if flow.flow_state else None
            self.assertIsNotNone(document)
            assert document is not None
            self.assertEqual([item["name"] for item in document["function_inputs"]], ["a", "b"])
            self.assertEqual(
                {slot["slot_key"] for slot in document["input_slots"]},
                {"a", "b"},
            )
            self.assertEqual(len(document["input_bindings"]), 2)

            data_edges = [edge for edge in flow.edges if edge.kind.value == "data"]
            self.assertEqual(
                {
                    (edge.source_id, edge.target_id, edge.metadata.get("slot_id"))
                    for edge in data_edges
                },
                {
                    (
                        "flow:symbol:service:add:param:a",
                        "flowdoc:symbol:service:add:return:0",
                        "flowslot:flow:symbol:service:add:statement:0:a",
                    ),
                    (
                        "flow:symbol:service:add:param:b",
                        "flowdoc:symbol:service:add:return:0",
                        "flowslot:flow:symbol:service:add:statement:0:b",
                    ),
                },
            )

            stored = read_flow_document(root, "symbol:service:add")
            self.assertIsNotNone(stored)
            assert stored is not None
            self.assertEqual(stored.input_slots, ())
            self.assertEqual(stored.input_bindings, ())

    def test_flow_view_projects_local_value_sources_as_canonical_bindings(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            source = (
                "def run(value):\n"
                "    current = value + 1\n"
                "    return current\n"
            )
            write_repo_files(root, {"service.py": source})

            adapter = PythonRepoAdapter.scan(root)
            flow = adapter.get_flow_view("symbol:service:run")

            document = flow.flow_state["document"] if flow.flow_state else None
            self.assertIsNotNone(document)
            assert document is not None
            self.assertEqual(document["value_model_version"], 1)
            self.assertEqual(
                {source["name"] for source in document["value_sources"]},
                {"current"},
            )
            self.assertTrue(
                any(
                    binding["source_id"].startswith("flowsource:")
                    and binding["slot_id"].endswith(":current")
                    for binding in document["input_bindings"]
                )
            )
            self.assertTrue(
                any(
                    edge.kind.value == "data"
                    and edge.metadata.get("source_id", "").startswith("flowsource:")
                    and edge.metadata.get("slot_id", "").endswith(":current")
                    for edge in flow.edges
                )
            )
            assign_node = next(node for node in flow.nodes if node.kind.value == "assign")
            self.assertEqual(
                assign_node.metadata["flow_value_sources"][0]["name"],
                "current",
            )

    def test_flow_view_preserves_prompt2_removed_bindings_when_backfilling_value_model(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            source = (
                "def run(value):\n"
                "    current = value + 1\n"
                "    return current\n"
            )
            write_repo_files(root, {"service.py": source})

            imported = import_flow_document_from_function_source(
                symbol_id="symbol:service:run",
                relative_path="service.py",
                qualname="run",
                module_source=source,
            )
            value_slot_ids = {
                slot.slot_id
                for slot in imported.input_slots
                if slot.slot_key == "value"
            }
            prompt2_document = replace(
                imported,
                value_model_version=None,
                value_sources=(),
                input_bindings=tuple(
                    binding
                    for binding in imported.input_bindings
                    if binding.slot_id not in value_slot_ids
                ),
            )
            write_flow_document(root, prompt2_document)

            adapter = PythonRepoAdapter.scan(root)
            flow = adapter.get_flow_view("symbol:service:run")

            document = flow.flow_state["document"] if flow.flow_state else None
            self.assertIsNotNone(document)
            assert document is not None
            self.assertEqual(document["value_model_version"], 1)
            self.assertTrue(document["value_sources"])
            self.assertFalse(
                any(binding["slot_id"] in value_slot_ids for binding in document["input_bindings"])
            )

    def test_flow_view_backfills_method_inputs_for_legacy_persisted_documents(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            source = (
                "class Service:\n"
                "    def run(self, value):\n"
                "        return self.scale(value)\n"
            )
            write_repo_files(root, {"service.py": source})

            imported = import_flow_document_from_function_source(
                symbol_id="symbol:service:Service.run",
                relative_path="service.py",
                qualname="Service.run",
                module_source=source,
            )
            legacy_document = replace(
                imported,
                nodes=tuple(replace(node, indexed_node_id=None) for node in imported.nodes),
                function_inputs=(),
                input_slots=(),
                input_bindings=(),
            )
            write_flow_document(root, legacy_document)

            adapter = PythonRepoAdapter.scan(root)
            flow = adapter.get_flow_view("symbol:service:Service.run")

            document = flow.flow_state["document"] if flow.flow_state else None
            self.assertIsNotNone(document)
            assert document is not None
            self.assertEqual([item["name"] for item in document["function_inputs"]], ["self", "value"])
            self.assertEqual(
                {slot["slot_key"] for slot in document["input_slots"]},
                {"self", "value"},
            )
            self.assertEqual(len(document["input_bindings"]), 2)
            self.assertTrue(
                any(
                    edge.kind.value == "data"
                    and edge.source_id == "flow:symbol:service:Service.run:param:self"
                    and edge.target_id == "flowdoc:symbol:service:Service.run:return:0"
                    for edge in flow.edges
                )
            )
            self.assertTrue(
                any(
                    edge.kind.value == "data"
                    and edge.source_id == "flow:symbol:service:Service.run:param:value"
                    and edge.target_id == "flowdoc:symbol:service:Service.run:return:0"
                    for edge in flow.edges
                )
            )

    def test_flow_view_reimports_stale_persisted_documents_instead_of_exposing_them(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            source = (
                "def run(value):\n"
                "    return value\n"
            )
            write_repo_files(root, {"service.py": source})

            write_flow_document(
                root,
                FlowModelDocument(
                    symbol_id="symbol:service:run",
                    relative_path="service.py",
                    qualname="run",
                    nodes=(
                        FlowModelNode(node_id="flowdoc:symbol:service:run:entry", kind="entry", payload={}),
                        FlowModelNode(
                            node_id="flowdoc:symbol:service:run:call:stale",
                            kind="call",
                            payload={"source": "stale()"},
                        ),
                        FlowModelNode(node_id="flowdoc:symbol:service:run:exit", kind="exit", payload={}),
                    ),
                    edges=(
                        FlowModelEdge(
                            edge_id=(
                                "controls:flowdoc:symbol:service:run:entry:start"
                                "->flowdoc:symbol:service:run:call:stale:in"
                            ),
                            source_id="flowdoc:symbol:service:run:entry",
                            source_handle="start",
                            target_id="flowdoc:symbol:service:run:call:stale",
                            target_handle="in",
                        ),
                    ),
                    sync_state="draft",
                    diagnostics=("stale diagnostics",),
                    source_hash="stale-source-hash",
                    editable=True,
                ),
            )

            adapter = PythonRepoAdapter.scan(root)
            flow = adapter.get_flow_view("symbol:service:run")

            self.assertIsNotNone(flow.flow_state)
            assert flow.flow_state is not None
            self.assertEqual(flow.flow_state["sync_state"], "clean")
            self.assertTrue(flow.flow_state["editable"])
            document = flow.flow_state["document"]
            self.assertIsNotNone(document)
            assert document is not None
            self.assertEqual(document["sync_state"], "clean")
            self.assertFalse(any(node["id"].endswith(":call:stale") for node in document["nodes"]))
            self.assertFalse(any(node.node_id.endswith(":call:stale") for node in flow.nodes))
            visible_return = next(node.node_id for node in flow.nodes if node.kind.value == "return")
            self.assertTrue(
                any(
                    edge.kind.value == "data"
                    and edge.source_id == "flow:symbol:service:run:param:value"
                    and edge.target_id == visible_return
                )
                for edge in flow.edges
            )

    def test_flow_view_returns_import_error_for_stale_documents_when_current_source_cannot_import(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            source = (
                "def run(value):\n"
                "    with helper(value) as current:\n"
                "        return current\n"
            )
            write_repo_files(root, {"service.py": source})

            previous_source = "def run(value):\n    return value\n"
            previous_document = import_flow_document_from_function_source(
                symbol_id="symbol:service:run",
                relative_path="service.py",
                qualname="run",
                module_source=previous_source,
            )
            write_flow_document(
                root,
                replace(
                    previous_document,
                    sync_state="draft",
                    diagnostics=("stale diagnostics",),
                    source_hash="stale-source-hash",
                    editable=True,
                ),
            )

            adapter = PythonRepoAdapter.scan(root)
            flow = adapter.get_flow_view("symbol:service:run")

            self.assertIsNotNone(flow.flow_state)
            assert flow.flow_state is not None
            self.assertEqual(flow.flow_state["sync_state"], "import_error")
            self.assertFalse(flow.flow_state["editable"])
            self.assertTrue(flow.flow_state["diagnostics"])
            document = flow.flow_state["document"]
            self.assertIsNotNone(document)
            assert document is not None
            self.assertEqual(document["sync_state"], "import_error")
            self.assertFalse(document["editable"])
            self.assertEqual([item["name"] for item in document["function_inputs"]], ["value"])
            self.assertTrue(document["input_slots"])
            self.assertTrue(document["input_bindings"])
            self.assertTrue(any(node["kind"] == "return" for node in document["nodes"]))
            self.assertTrue(any(node.kind.value == "param" and node.label == "value" for node in flow.nodes))

    def test_class_symbol_view_surfaces_direct_members_and_flow(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            write_repo_files(
                root,
                {
                    "service.py": (
                        "class Service:\n"
                        "    enabled = True\n"
                        "    threshold: int = 3\n\n"
                        "    def helper(self):\n"
                        "        return self.threshold\n\n"
                        "    def run(self):\n"
                        "        return self.helper()\n"
                    ),
                },
            )

            adapter = PythonRepoAdapter.scan(root)
            class_view = adapter.get_graph_view("symbol:service:Service", GraphAbstractionLevel.SYMBOL)

            node_ids = {node.node_id for node in class_view.nodes}
            self.assertIn("symbol:service:Service.enabled", node_ids)
            self.assertIn("symbol:service:Service.threshold", node_ids)
            self.assertIn("symbol:service:Service.helper", node_ids)
            self.assertIn("symbol:service:Service.run", node_ids)

            contains_edges = {
                (edge.source_id, edge.target_id)
                for edge in class_view.edges
                if edge.kind.value == "contains"
            }
            self.assertIn(("symbol:service:Service", "symbol:service:Service.enabled"), contains_edges)
            self.assertIn(("symbol:service:Service", "symbol:service:Service.threshold"), contains_edges)
            self.assertIn(("symbol:service:Service", "symbol:service:Service.helper"), contains_edges)
            self.assertIn(("symbol:service:Service", "symbol:service:Service.run"), contains_edges)

            class_node = next(
                node for node in class_view.nodes if node.node_id == "symbol:service:Service"
            )
            actions = {
                action.action_id: action.enabled for action in class_node.available_actions
            }
            self.assertTrue(actions["open_flow"])
            self.assertIn(
                GraphAbstractionLevel.FLOW,
                class_view.focus.available_levels if class_view.focus else (),
            )

    def test_class_flow_view_orders_members_and_includes_intra_class_calls(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            write_repo_files(
                root,
                {
                    "service.py": (
                        "class Service:\n"
                        "    enabled = True\n"
                        "    threshold: int = 3\n\n"
                        "    def helper(self):\n"
                        "        return self.threshold\n\n"
                        "    def run(self):\n"
                        "        return self.helper()\n"
                    ),
                },
            )

            adapter = PythonRepoAdapter.scan(root)
            flow = adapter.get_flow_view("symbol:service:Service")

            self.assertEqual(flow.level, GraphAbstractionLevel.FLOW)
            self.assertEqual(
                [node.label for node in flow.nodes],
                ["Entry", "enabled", "threshold", "helper", "run"],
            )

            contains_edges = {
                (edge.source_id, edge.target_id)
                for edge in flow.edges
                if edge.kind.value == "contains"
            }
            self.assertIn(("flow:symbol:service:Service:entry", "symbol:service:Service.enabled"), contains_edges)
            self.assertIn(("flow:symbol:service:Service:entry", "symbol:service:Service.threshold"), contains_edges)
            self.assertIn(("flow:symbol:service:Service:entry", "symbol:service:Service.helper"), contains_edges)
            self.assertIn(("flow:symbol:service:Service:entry", "symbol:service:Service.run"), contains_edges)

            call_edges = {
                (edge.source_id, edge.target_id)
                for edge in flow.edges
                if edge.kind.value == "calls"
            }
            self.assertIn(("symbol:service:Service.run", "symbol:service:Service.helper"), call_edges)
            helper_node = next(node for node in flow.nodes if node.node_id == "symbol:service:Service.helper")
            self.assertEqual(helper_node.metadata["source_start_line"], 5)
            self.assertEqual(helper_node.metadata["source_end_line"], 6)

    def test_external_dependencies_are_hidden_by_default_but_available_in_advanced_settings(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            write_repo_files(
                root,
                {
                    "internal.py": "def helper():\n    return {'ok': True}\n",
                    "service.py": (
                        "import json\n"
                        "from internal import helper\n\n"
                        "def run():\n"
                        "    return json.dumps(helper())\n"
                    ),
                },
            )

            adapter = PythonRepoAdapter.scan(root)

            repo_view = adapter.get_graph_view(adapter.graph.repo_id, GraphAbstractionLevel.REPO)
            repo_view_with_external = adapter.get_graph_view(
                adapter.graph.repo_id,
                GraphAbstractionLevel.REPO,
                {"includeExternalDependencies": True},
            )
            module_view = adapter.get_graph_view("module:service", GraphAbstractionLevel.MODULE)
            module_view_with_external = adapter.get_graph_view(
                "module:service",
                GraphAbstractionLevel.MODULE,
                {"includeExternalDependencies": True},
            )
            symbol_view = adapter.get_graph_view("symbol:service:run", GraphAbstractionLevel.SYMBOL)
            symbol_view_with_external = adapter.get_graph_view(
                "symbol:service:run",
                GraphAbstractionLevel.SYMBOL,
                {"includeExternalDependencies": True},
            )

            self.assertNotIn("module:json", {node.node_id for node in repo_view.nodes})
            self.assertNotIn("module:json", {node.node_id for node in module_view.nodes})
            self.assertNotIn("module:json", {node.node_id for node in symbol_view.nodes})
            self.assertNotIn("module:json", {edge.target_id for edge in repo_view.edges})
            self.assertIn("module:json", {node.node_id for node in repo_view_with_external.nodes})
            self.assertIn("module:json", {node.node_id for node in module_view_with_external.nodes})
            self.assertIn("module:json", {node.node_id for node in symbol_view_with_external.nodes})

    def test_apply_edit_reparses_only_touched_modules(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            write_repo_files(
                root,
                {
                    "alpha.py": "def helper():\n    return 'ok'\n",
                    "beta.py": "def run():\n    return 1\n",
                },
            )

            adapter = PythonRepoAdapter.scan(root)
            response = adapter.apply_edit(
                serialize_edit_request(
                    {
                        "kind": "create_symbol",
                        "relative_path": "beta.py",
                        "new_name": "build_blueprint",
                        "symbol_kind": "function",
                    }
                )
            )

            self.assertEqual(response["edit"]["reparsed_relative_paths"], ["beta.py"])
            self.assertEqual(response["edit"]["changed_node_ids"], ["symbol:beta:build_blueprint"])
            symbol_names = {
                node["name"]
                for node in response["payload"]["graph"]["nodes"]
                if node["kind"] == "symbol"
            }
            self.assertIn("build_blueprint", symbol_names)

    def test_apply_edit_create_module_returns_changed_module_id(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            write_repo_files(
                root,
                {
                    "service.py": "def helper():\n    return 'ok'\n",
                },
            )

            adapter = PythonRepoAdapter.scan(root)
            response = adapter.apply_edit(
                serialize_edit_request(
                    {
                        "kind": "create_module",
                        "relative_path": "pkg/tools.py",
                        "content": "def run():\n    return 1",
                    }
                )
            )

            self.assertEqual(response["edit"]["changed_node_ids"], ["module:pkg.tools"])
            self.assertEqual(response["payload"]["summary"]["module_count"], 2)
            self.assertEqual(
                response["edit"]["undo_transaction"]["focus_target"],
                {
                    "target_id": f"repo:{root.resolve().as_posix()}",
                    "level": "repo",
                },
            )

    def test_apply_edit_insert_flow_statement_returns_changed_flow_id(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
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

            adapter = PythonRepoAdapter.scan(root)
            response = adapter.apply_edit(
                serialize_edit_request(
                    {
                        "kind": "insert_flow_statement",
                        "target_id": "symbol:service:run",
                        "anchor_edge_id": (
                            "controls:flow:symbol:service:run:statement:0"
                            "->flow:symbol:service:run:statement:1"
                        ),
                        "content": "helper = current + 1",
                    }
                )
            )

            self.assertEqual(response["edit"]["changed_node_ids"], ["flow:symbol:service:run:statement:1"])
            flow = adapter.get_flow_view("symbol:service:run")
            self.assertTrue(
                any(
                    node["payload"].get("source") == "helper = current + 1"
                    for node in flow.flow_state["document"]["nodes"]
                )
            )

    def test_apply_undo_restores_backend_state_and_focus_target(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            write_repo_files(root, {"service.py": "def helper():\n    return 'ok'\n"})

            adapter = PythonRepoAdapter.scan(root)
            edit_response = adapter.apply_edit(
                serialize_edit_request(
                    {
                        "kind": "create_symbol",
                        "relative_path": "service.py",
                        "new_name": "build_blueprint",
                        "symbol_kind": "function",
                    }
                )
            )

            self.assertIn("build_blueprint", (root / "service.py").read_text(encoding="utf-8"))

            undo_response = adapter.apply_undo(
                serialize_undo_transaction(edit_response["edit"]["undo_transaction"])
            )

            self.assertNotIn("build_blueprint", (root / "service.py").read_text(encoding="utf-8"))
            self.assertEqual(
                undo_response["undo"]["focus_target"],
                {
                    "target_id": "module:service",
                    "level": "module",
                },
            )
            self.assertIsNotNone(undo_response["undo"]["redo_transaction"])
            symbol_names = {
                node["name"]
                for node in undo_response["payload"]["graph"]["nodes"]
                if node["kind"] == "symbol"
            }
            self.assertNotIn("build_blueprint", symbol_names)

    def test_module_view_surfaces_top_level_enums_and_variables_without_flow_actions(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            write_repo_files(
                root,
                {
                    "service.py": (
                        "import enum\n\n"
                        "READY = True\n\n"
                        "class Mode(enum.Enum):\n"
                        "    FAST = 'fast'\n\n"
                        "def run():\n"
                        "    return READY\n"
                    ),
                },
            )

            adapter = PythonRepoAdapter.scan(root)
            module_view = adapter.get_graph_view("module:service", GraphAbstractionLevel.MODULE)

            module_symbols = {
                node.node_id: node.kind.value
                for node in module_view.nodes
                if node.kind.value in {"function", "class", "enum", "variable", "symbol"}
            }
            self.assertEqual(module_symbols["symbol:service:READY"], "variable")
            self.assertEqual(module_symbols["symbol:service:Mode"], "enum")
            self.assertEqual(module_symbols["symbol:service:run"], "function")

            variable_view = adapter.get_graph_view("symbol:service:READY", GraphAbstractionLevel.SYMBOL)
            enum_view = adapter.get_graph_view("symbol:service:Mode", GraphAbstractionLevel.SYMBOL)

            variable_node = next(
                node for node in variable_view.nodes if node.node_id == "symbol:service:READY"
            )
            enum_node = next(
                node for node in enum_view.nodes if node.node_id == "symbol:service:Mode"
            )
            variable_actions = {
                action.action_id: action.enabled for action in variable_node.available_actions
            }
            enum_actions = {
                action.action_id: action.enabled for action in enum_node.available_actions
            }
            self.assertFalse(variable_actions["open_flow"])
            self.assertFalse(enum_actions["open_flow"])

            with self.assertRaisesRegex(
                ValueError,
                "functions, methods, and classes",
            ):
                adapter.get_flow_view("symbol:service:READY")

    def test_get_editable_node_source_marks_functions_and_variables_editable(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            write_repo_files(
                root,
                {
                    "service.py": (
                        "READY = True\n\n"
                        "def run():\n"
                        "    return READY\n"
                    ),
                },
            )

            adapter = PythonRepoAdapter.scan(root)
            function_source = adapter.get_editable_node_source("symbol:service:run")
            variable_source = adapter.get_editable_node_source("symbol:service:READY")

            self.assertTrue(function_source["editable"])
            self.assertIn("def run()", function_source["content"])
            self.assertTrue(variable_source["editable"])
            self.assertEqual(variable_source["content"].strip(), "READY = True")

    def test_get_editable_node_source_supports_classes_and_methods_but_blocks_class_attributes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            write_repo_files(
                root,
                {
                    "service.py": (
                        "def traced(func):\n"
                        "    return func\n\n"
                        "@traced\n"
                        "class Service:\n"
                        "    enabled: bool = True\n\n"
                        "    @traced\n"
                        "    async def run(\n"
                        "        self,\n"
                        "        value: str,\n"
                        "    ) -> str:\n"
                        "        \"\"\"Return a value.\"\"\"\n"
                        "        return value\n"
                    ),
                },
            )

            adapter = PythonRepoAdapter.scan(root)
            class_source = adapter.get_editable_node_source("symbol:service:Service")
            method_source = adapter.get_editable_node_source("symbol:service:Service.run")
            attribute_source = adapter.get_editable_node_source("symbol:service:Service.enabled")

            self.assertTrue(class_source["editable"])
            self.assertTrue(method_source["editable"])
            self.assertFalse(attribute_source["editable"])
            self.assertEqual(
                attribute_source["reason"],
                "Class attribute declarations are not inline editable yet.",
            )
            self.assertTrue(class_source["content"].startswith("@traced\nclass Service:"))
            self.assertTrue(method_source["content"].startswith("@traced\nasync def run("))
            self.assertIn('"""Return a value."""', method_source["content"])
            self.assertEqual(method_source["start_column"], 4)

    def test_get_editable_node_source_blocks_enum_declarations_and_enum_methods(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            write_repo_files(
                root,
                {
                    "service.py": (
                        "import enum\n\n"
                        "class Mode(enum.Enum):\n"
                        "    FAST = 'fast'\n\n"
                        "    def label(self) -> str:\n"
                        "        return self.value\n"
                    ),
                },
            )

            adapter = PythonRepoAdapter.scan(root)
            enum_source = adapter.get_editable_node_source("symbol:service:Mode")
            method_source = adapter.get_editable_node_source("symbol:service:Mode.label")

            self.assertFalse(enum_source["editable"])
            self.assertEqual(
                enum_source["reason"],
                "Enum declarations are not inline editable yet.",
            )
            self.assertFalse(method_source["editable"])
            self.assertEqual(
                method_source["reason"],
                "Methods inside enum declarations are not inline editable yet.",
            )

    def test_save_node_source_replaces_function_and_variable_declarations(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            write_repo_files(
                root,
                {
                    "service.py": (
                        "READY = True\n\n"
                        "def run():\n"
                        "    return READY\n"
                    ),
                },
            )

            adapter = PythonRepoAdapter.scan(root)
            adapter.save_node_source(
                "symbol:service:run",
                "def run():\n    return False\n",
            )
            adapter.save_node_source(
                "symbol:service:READY",
                "READY = False\n",
            )

            function_source = adapter.get_editable_node_source("symbol:service:run")
            variable_source = adapter.get_editable_node_source("symbol:service:READY")
            self.assertIn("return False", function_source["content"])
            self.assertEqual(variable_source["content"].strip(), "READY = False")

    def test_save_node_source_replaces_class_and_method_declarations(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            write_repo_files(
                root,
                {
                    "service.py": (
                        "class Service:\n"
                        "    enabled = True\n\n"
                        "    async def run(self) -> bool:\n"
                        "        return self.enabled\n"
                    ),
                },
            )

            adapter = PythonRepoAdapter.scan(root)
            adapter.save_node_source(
                "symbol:service:Service",
                (
                    "class Service:\n"
                    "    enabled = False\n\n"
                    "    async def run(self) -> bool:\n"
                    "        return self.enabled\n"
                ),
            )
            adapter.save_node_source(
                "symbol:service:Service.run",
                (
                    "async def run(self) -> bool:\n"
                    "    return False\n"
                ),
            )

            class_source = adapter.get_editable_node_source("symbol:service:Service")
            method_source = adapter.get_editable_node_source("symbol:service:Service.run")
            self.assertIn("enabled = False", class_source["content"])
            self.assertIn("return False", method_source["content"])

    def test_save_node_source_rejects_wrong_declaration_shape(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            write_repo_files(
                root,
                {
                    "service.py": (
                        "READY = True\n\n"
                        "def run():\n"
                        "    return READY\n"
                    ),
                },
            )

            adapter = PythonRepoAdapter.scan(root)

            with self.assertRaisesRegex(ValueError, "original name 'run'"):
                adapter.save_node_source(
                    "symbol:service:run",
                    "def renamed():\n    return True\n",
                )

            with self.assertRaisesRegex(ValueError, "assignment targeting 'READY'"):
                adapter.save_node_source(
                    "symbol:service:READY",
                    "OTHER = False\n",
                )

    def test_save_node_source_rejects_wrong_class_and_method_declaration_shape(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            write_repo_files(
                root,
                {
                    "service.py": (
                        "class Service:\n"
                        "    async def run(self) -> bool:\n"
                        "        return True\n"
                    ),
                },
            )

            adapter = PythonRepoAdapter.scan(root)

            with self.assertRaisesRegex(ValueError, "original name 'Service'|keep the original name 'Service'"):
                adapter.save_node_source(
                    "symbol:service:Service",
                    "class RenamedService:\n    pass\n",
                )

            with self.assertRaisesRegex(
                ValueError,
                "Function replacements must parse as exactly one top-level function.",
            ):
                adapter.save_node_source(
                    "symbol:service:Service.run",
                    "class Run:\n    pass\n",
                )

    def test_save_node_source_rejects_blocked_declarations_with_shared_backend_reason(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            write_repo_files(
                root,
                {
                    "service.py": (
                        "import enum\n\n"
                        "class Mode(enum.Enum):\n"
                        "    FAST = 'fast'\n\n"
                        "class Service:\n"
                        "    enabled = True\n"
                    ),
                },
            )

            adapter = PythonRepoAdapter.scan(root)

            with self.assertRaisesRegex(ValueError, "Enum declarations are not inline editable yet."):
                adapter.save_node_source(
                    "symbol:service:Mode",
                    "class Mode:\n    FAST = 'fast'\n",
                )

            with self.assertRaisesRegex(
                ValueError,
                "Class attribute declarations are not inline editable yet.",
            ):
                adapter.save_node_source(
                    "symbol:service:Service.enabled",
                    "enabled = False\n",
                )
