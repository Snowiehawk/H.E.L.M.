from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from helm.editor import serialize_edit_request, serialize_undo_transaction
from helm.editor.flow_model import (
    FlowModelDocument,
    FlowModelEdge,
    FlowModelNode,
    import_flow_document_from_function_source,
    write_flow_document,
)
from helm.graph.models import GraphAbstractionLevel
from helm.ui.python_adapter import PythonRepoAdapter
from tests.helpers import write_repo_files


class PythonRepoAdapterTests(unittest.TestCase):
    def test_default_level_uses_symbol_for_small_repo_and_module_for_large_repo(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
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
            self.assertTrue(
                any(edge.source_id.endswith(":entry") and ":statement:" in edge.target_id for edge in control_edges)
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

            self.assertEqual({edge.label for edge in loop_edges}, {"body", "exit"})
            self.assertEqual(
                {edge.metadata["path_key"] for edge in loop_edges},
                {"body", "exit"},
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
            draft_document = FlowModelDocument(
                symbol_id=imported.symbol_id,
                relative_path=imported.relative_path,
                qualname=imported.qualname,
                nodes=(
                    *imported.nodes,
                    FlowModelNode(
                        node_id="flowdoc:symbol:service:run:call:disconnected",
                        kind="call",
                        payload={"source": "notify(value)"},
                    ),
                ),
                edges=imported.edges,
                sync_state="draft",
                diagnostics=("Unreachable flow nodes block code generation: flowdoc:symbol:service:run:call:disconnected.",),
                source_hash=imported.source_hash,
                editable=True,
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

    def test_flow_view_returns_import_error_for_stale_documents_when_current_source_cannot_import(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            source = (
                "def run(value):\n"
                "    with helper(value) as current:\n"
                "        return current\n"
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
                    edges=(),
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
            self.assertFalse(any(node["id"].endswith(":call:stale") for node in document["nodes"]))
            self.assertFalse(any(node.node_id.endswith(":call:stale") for node in flow.nodes))

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
            self.assertIn("helper = current + 1", {node.label for node in flow.nodes})

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
