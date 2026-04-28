from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from helm.editor import apply_backend_undo, apply_structural_edit, serialize_edit_request
from helm.editor.flow_model import (
    FLOW_MODEL_RELATIVE_PATH,
    FlowModelEdge,
    flow_return_completion_edge_id,
    import_flow_document_from_function_source,
    read_flow_document,
)
from helm.graph import EdgeKind, build_repo_graph
from helm.parser import PythonModuleParser, discover_python_modules
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


class EditorIntegrationTests(unittest.TestCase):
    def test_serialize_edit_request_validates_supported_payload(self) -> None:
        request = serialize_edit_request(
            {
                "kind": "create_symbol",
                "relative_path": "src/helm/ui/api.py",
                "new_name": "build_blueprint",
                "symbol_kind": "function",
                "body": "pass",
            }
        )

        self.assertEqual(request.kind.value, "create_symbol")
        self.assertEqual(request.new_name, "build_blueprint")

    def test_rename_symbol_updates_definition_for_dependency_free_symbol(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            write_repo_files(
                root,
                {
                    "service.py": "def helper():\n    return 'ok'\n",
                },
            )

            parsed_modules, _, inbound = parse_repo(root)
            result = apply_structural_edit(
                root,
                serialize_edit_request(
                    {
                        "kind": "rename_symbol",
                        "target_id": "symbol:service:helper",
                        "new_name": "helper_blueprint",
                    }
                ),
                parsed_modules=parsed_modules,
                inbound_dependency_count=inbound,
            )

            self.assertIn("Renamed helper to helper_blueprint", result.summary)
            self.assertIn(
                "def helper_blueprint():", (root / "service.py").read_text(encoding="utf-8")
            )

    def test_rejects_rename_when_inbound_calls_exist(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            write_repo_files(
                root,
                {
                    "helpers.py": "def helper():\n    return 'ok'\n",
                    "service.py": "from helpers import helper\n\ndef run():\n    return helper()\n",
                },
            )

            parsed_modules, _, inbound = parse_repo(root)
            with self.assertRaisesRegex(ValueError, "inbound dependency links"):
                apply_structural_edit(
                    root,
                    serialize_edit_request(
                        {
                            "kind": "rename_symbol",
                            "target_id": "symbol:helpers:helper",
                            "new_name": "helper_blueprint",
                        }
                    ),
                    parsed_modules=parsed_modules,
                    inbound_dependency_count=inbound,
                )

    def test_create_delete_and_move_symbol_round_trip(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            write_repo_files(
                root,
                {
                    "alpha.py": "def helper():\n    return 'ok'\n",
                    "beta.py": "",
                },
            )

            parsed_modules, _, inbound = parse_repo(root)
            create_result = apply_structural_edit(
                root,
                serialize_edit_request(
                    {
                        "kind": "create_symbol",
                        "relative_path": "beta.py",
                        "new_name": "build_blueprint",
                        "symbol_kind": "function",
                        "body": "return 'blueprint'",
                    }
                ),
                parsed_modules=parsed_modules,
                inbound_dependency_count=inbound,
            )
            self.assertIn("Created function build_blueprint", create_result.summary)
            self.assertIn("def build_blueprint():", (root / "beta.py").read_text(encoding="utf-8"))
            self.assertEqual(create_result.changed_node_ids, ("symbol:beta:build_blueprint",))

            parsed_modules, _, inbound = parse_repo(root)
            move_result = apply_structural_edit(
                root,
                serialize_edit_request(
                    {
                        "kind": "move_symbol",
                        "target_id": "symbol:alpha:helper",
                        "destination_relative_path": "beta.py",
                    }
                ),
                parsed_modules=parsed_modules,
                inbound_dependency_count=inbound,
            )
            self.assertIn("Moved helper", move_result.summary)
            self.assertNotIn("def helper():", (root / "alpha.py").read_text(encoding="utf-8"))
            self.assertIn("def helper():", (root / "beta.py").read_text(encoding="utf-8"))

            parsed_modules, _, inbound = parse_repo(root)
            delete_result = apply_structural_edit(
                root,
                serialize_edit_request(
                    {
                        "kind": "delete_symbol",
                        "target_id": "symbol:beta:build_blueprint",
                    }
                ),
                parsed_modules=parsed_modules,
                inbound_dependency_count=inbound,
            )
            self.assertIn("Deleted build_blueprint", delete_result.summary)
            self.assertNotIn(
                "def build_blueprint():", (root / "beta.py").read_text(encoding="utf-8")
            )

    def test_create_symbol_rejects_invalid_python_identifiers_keywords_and_duplicates(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            write_repo_files(
                root,
                {
                    "service.py": "def helper():\n    return 'ok'\n",
                },
            )

            parsed_modules, _, inbound = parse_repo(root)
            with self.assertRaisesRegex(ValueError, "valid Python identifier"):
                apply_structural_edit(
                    root,
                    serialize_edit_request(
                        {
                            "kind": "create_symbol",
                            "relative_path": "service.py",
                            "new_name": "123helper",
                            "symbol_kind": "function",
                        }
                    ),
                    parsed_modules=parsed_modules,
                    inbound_dependency_count=inbound,
                )

            with self.assertRaisesRegex(ValueError, "Python keyword"):
                apply_structural_edit(
                    root,
                    serialize_edit_request(
                        {
                            "kind": "create_symbol",
                            "relative_path": "service.py",
                            "new_name": "class",
                            "symbol_kind": "function",
                        }
                    ),
                    parsed_modules=parsed_modules,
                    inbound_dependency_count=inbound,
                )

            with self.assertRaisesRegex(ValueError, "already exists"):
                apply_structural_edit(
                    root,
                    serialize_edit_request(
                        {
                            "kind": "create_symbol",
                            "relative_path": "service.py",
                            "new_name": "helper",
                            "symbol_kind": "function",
                        }
                    ),
                    parsed_modules=parsed_modules,
                    inbound_dependency_count=inbound,
                )

    def test_create_module_creates_python_file_and_validates_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            write_repo_files(
                root,
                {
                    "service.py": "def helper():\n    return 'ok'\n",
                },
            )

            parsed_modules, _, inbound = parse_repo(root)
            create_result = apply_structural_edit(
                root,
                serialize_edit_request(
                    {
                        "kind": "create_module",
                        "relative_path": "pkg/tools.py",
                        "content": "def run():\n    return 1",
                    }
                ),
                parsed_modules=parsed_modules,
                inbound_dependency_count=inbound,
            )

            self.assertIn("Created module pkg/tools.py", create_result.summary)
            self.assertEqual(create_result.changed_node_ids, ("module:pkg.tools",))
            self.assertEqual(
                (root / "pkg" / "tools.py").read_text(encoding="utf-8"),
                "def run():\n    return 1\n",
            )

            with self.assertRaisesRegex(ValueError, "Python source file ending in '.py'"):
                apply_structural_edit(
                    root,
                    serialize_edit_request(
                        {
                            "kind": "create_module",
                            "relative_path": "pkg/tools.txt",
                        }
                    ),
                    parsed_modules=parsed_modules,
                    inbound_dependency_count=inbound,
                )

            with self.assertRaisesRegex(ValueError, "already exists"):
                apply_structural_edit(
                    root,
                    serialize_edit_request(
                        {
                            "kind": "create_module",
                            "relative_path": "pkg/tools.py",
                        }
                    ),
                    parsed_modules=parsed_modules,
                    inbound_dependency_count=inbound,
                )

    def test_insert_flow_statement_supports_entry_and_linear_paths(self) -> None:
        cases = (
            {
                "name": "entry",
                "anchor_edge_id": (
                    "controls:flow:symbol:service:run:entry->flow:symbol:service:run:statement:0"
                ),
                "content": "helper = 1",
                "expected_snippet": (
                    "def run():\n    helper = 1\n    current = 1\n    return current\n"
                ),
                "expected_changed_id": "flow:symbol:service:run:statement:0",
            },
            {
                "name": "linear",
                "anchor_edge_id": (
                    "controls:flow:symbol:service:run:statement:0"
                    "->flow:symbol:service:run:statement:1"
                ),
                "content": "helper = current + 1",
                "expected_snippet": (
                    "def run():\n    current = 1\n    helper = current + 1\n    return current\n"
                ),
                "expected_changed_id": "flow:symbol:service:run:statement:1",
            },
        )

        for case in cases:
            with self.subTest(path=case["name"]):
                with tempfile.TemporaryDirectory() as tmp_dir:
                    root = Path(tmp_dir)
                    write_repo_files(
                        root,
                        {
                            "service.py": ("def run():\n    current = 1\n    return current\n"),
                        },
                    )

                    parsed_modules, _, inbound = parse_repo(root)
                    result = apply_structural_edit(
                        root,
                        serialize_edit_request(
                            {
                                "kind": "insert_flow_statement",
                                "target_id": "symbol:service:run",
                                "anchor_edge_id": case["anchor_edge_id"],
                                "content": case["content"],
                            }
                        ),
                        parsed_modules=parsed_modules,
                        inbound_dependency_count=inbound,
                    )

                    self.assertEqual(result.changed_node_ids, (case["expected_changed_id"],))
                    self.assertEqual(
                        (root / "service.py").read_text(encoding="utf-8"),
                        case["expected_snippet"],
                    )

    def test_insert_flow_statement_supports_branch_true_and_false_paths(self) -> None:
        cases = (
            {
                "name": "true",
                "anchor_edge_id": (
                    "controls:flow:symbol:service:run:statement:0"
                    "->flow:symbol:service:run:statement:1:true"
                ),
                "content": "helper = 1",
                "expected_snippet": (
                    "def run(flag):\n"
                    "    if flag:\n"
                    "        helper = 1\n"
                    "        return 1\n"
                    "    return 0\n"
                ),
                "expected_changed_id": "flow:symbol:service:run:statement:1",
            },
            {
                "name": "false",
                "anchor_edge_id": (
                    "controls:flow:symbol:service:run:statement:0"
                    "->flow:symbol:service:run:statement:2:false"
                ),
                "content": "helper = 0",
                "expected_snippet": (
                    "def run(flag):\n"
                    "    if flag:\n"
                    "        return 1\n"
                    "    else:\n"
                    "        helper = 0\n"
                    "    return 0\n"
                ),
                "expected_changed_id": "flow:symbol:service:run:statement:2",
            },
        )

        for case in cases:
            with self.subTest(path=case["name"]):
                with tempfile.TemporaryDirectory() as tmp_dir:
                    root = Path(tmp_dir)
                    write_repo_files(
                        root,
                        {
                            "service.py": (
                                "def run(flag):\n    if flag:\n        return 1\n    return 0\n"
                            ),
                        },
                    )

                    parsed_modules, _, inbound = parse_repo(root)
                    result = apply_structural_edit(
                        root,
                        serialize_edit_request(
                            {
                                "kind": "insert_flow_statement",
                                "target_id": "symbol:service:run",
                                "anchor_edge_id": case["anchor_edge_id"],
                                "content": case["content"],
                            }
                        ),
                        parsed_modules=parsed_modules,
                        inbound_dependency_count=inbound,
                    )

                    self.assertEqual(result.changed_node_ids, (case["expected_changed_id"],))
                    self.assertEqual(
                        (root / "service.py").read_text(encoding="utf-8"),
                        case["expected_snippet"],
                    )

    def test_insert_flow_statement_supports_loop_body_and_exit_paths(self) -> None:
        cases = (
            {
                "name": "body",
                "anchor_edge_id": (
                    "controls:flow:symbol:service:run:statement:0"
                    "->flow:symbol:service:run:statement:1:body"
                ),
                "content": "head = items[0]",
                "expected_snippet": (
                    "def run(items):\n"
                    "    while items:\n"
                    "        head = items[0]\n"
                    "        items = items[1:]\n"
                    "    return len(items)\n"
                ),
                "expected_changed_id": "flow:symbol:service:run:statement:1",
            },
            {
                "name": "exit",
                "anchor_edge_id": (
                    "controls:flow:symbol:service:run:statement:0"
                    "->flow:symbol:service:run:statement:2:exit"
                ),
                "content": "remaining = len(items)",
                "expected_snippet": (
                    "def run(items):\n"
                    "    while items:\n"
                    "        items = items[1:]\n"
                    "    remaining = len(items)\n"
                    "    return len(items)\n"
                ),
                "expected_changed_id": "flow:symbol:service:run:statement:2",
            },
        )

        for case in cases:
            with self.subTest(path=case["name"]):
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

                    parsed_modules, _, inbound = parse_repo(root)
                    result = apply_structural_edit(
                        root,
                        serialize_edit_request(
                            {
                                "kind": "insert_flow_statement",
                                "target_id": "symbol:service:run",
                                "anchor_edge_id": case["anchor_edge_id"],
                                "content": case["content"],
                            }
                        ),
                        parsed_modules=parsed_modules,
                        inbound_dependency_count=inbound,
                    )

                    self.assertEqual(result.changed_node_ids, (case["expected_changed_id"],))
                    self.assertEqual(
                        (root / "service.py").read_text(encoding="utf-8"),
                        case["expected_snippet"],
                    )

    def test_add_and_remove_import_round_trip(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            write_repo_files(
                root,
                {
                    "service.py": "def run():\n    return 1\n",
                },
            )

            parsed_modules, _, inbound = parse_repo(root)
            add_result = apply_structural_edit(
                root,
                serialize_edit_request(
                    {
                        "kind": "add_import",
                        "relative_path": "service.py",
                        "imported_module": "helpers",
                        "imported_name": "helper",
                    }
                ),
                parsed_modules=parsed_modules,
                inbound_dependency_count=inbound,
            )
            self.assertIn("Added import", add_result.summary)
            self.assertIn(
                "from helpers import helper", (root / "service.py").read_text(encoding="utf-8")
            )

            parsed_modules, _, inbound = parse_repo(root)
            remove_result = apply_structural_edit(
                root,
                serialize_edit_request(
                    {
                        "kind": "remove_import",
                        "relative_path": "service.py",
                        "imported_module": "helpers",
                        "imported_name": "helper",
                    }
                ),
                parsed_modules=parsed_modules,
                inbound_dependency_count=inbound,
            )
            self.assertIn("Removed import", remove_result.summary)
            self.assertNotIn(
                "from helpers import helper", (root / "service.py").read_text(encoding="utf-8")
            )

    def test_undo_transaction_removes_created_module_and_cleans_empty_dirs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            write_repo_files(root, {"service.py": "def helper():\n    return 'ok'\n"})

            parsed_modules, _, inbound = parse_repo(root)
            result = apply_structural_edit(
                root,
                serialize_edit_request(
                    {
                        "kind": "create_module",
                        "relative_path": "pkg/tools.py",
                        "content": "def run():\n    return 1",
                    }
                ),
                parsed_modules=parsed_modules,
                inbound_dependency_count=inbound,
            )

            undo_result = apply_backend_undo(root, result.undo_transaction)

            self.assertFalse((root / "pkg" / "tools.py").exists())
            self.assertFalse((root / "pkg").exists())
            self.assertEqual(
                undo_result.focus_target.target_id, f"repo:{root.resolve().as_posix()}"
            )
            self.assertEqual(undo_result.focus_target.level, "repo")

    def test_backend_undo_restores_deleted_symbol_source(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            write_repo_files(root, {"service.py": "def helper():\n    return 'ok'\n"})

            parsed_modules, _, inbound = parse_repo(root)
            delete_result = apply_structural_edit(
                root,
                serialize_edit_request(
                    {
                        "kind": "delete_symbol",
                        "target_id": "symbol:service:helper",
                    }
                ),
                parsed_modules=parsed_modules,
                inbound_dependency_count=inbound,
            )
            self.assertNotIn("def helper():", (root / "service.py").read_text(encoding="utf-8"))

            undo_result = apply_backend_undo(root, delete_result.undo_transaction)

            self.assertIn("def helper():", (root / "service.py").read_text(encoding="utf-8"))
            self.assertEqual(undo_result.focus_target.target_id, "symbol:service:helper")
            self.assertEqual(undo_result.focus_target.level, "symbol")
            self.assertIsNotNone(undo_result.redo_transaction)

            redo_result = apply_backend_undo(root, undo_result.redo_transaction)
            self.assertNotIn("def helper():", (root / "service.py").read_text(encoding="utf-8"))
            self.assertIsNotNone(redo_result.redo_transaction)

    def test_backend_undo_restores_saved_function_source_and_flow_document(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            write_repo_files(
                root,
                {
                    "service.py": "def run():\n    return True\n",
                },
            )

            parsed_modules, _, inbound = parse_repo(root)
            result = apply_structural_edit(
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

            self.assertIn("return False", (root / "service.py").read_text(encoding="utf-8"))
            self.assertTrue((root / FLOW_MODEL_RELATIVE_PATH).exists())

            undo_result = apply_backend_undo(root, result.undo_transaction)

            self.assertIn("return True", (root / "service.py").read_text(encoding="utf-8"))
            self.assertFalse((root / FLOW_MODEL_RELATIVE_PATH).exists())
            self.assertEqual(undo_result.focus_target.target_id, "symbol:service:run")
            self.assertEqual(undo_result.focus_target.level, "symbol")

    def test_replace_module_source_replaces_full_file_and_supports_undo(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            write_repo_files(root, {"service.py": ""})

            parsed_modules, _, inbound = parse_repo(root)
            result = apply_structural_edit(
                root,
                serialize_edit_request(
                    {
                        "kind": "replace_module_source",
                        "target_id": "module:service",
                        "content": "def run():\n    return 42\n",
                    }
                ),
                parsed_modules=parsed_modules,
                inbound_dependency_count=inbound,
            )

            self.assertIn("return 42", (root / "service.py").read_text(encoding="utf-8"))
            self.assertEqual(result.touched_relative_paths, ("service.py",))
            self.assertEqual(result.changed_node_ids, ("module:service",))

            undo_result = apply_backend_undo(root, result.undo_transaction)

            self.assertEqual((root / "service.py").read_text(encoding="utf-8"), "")
            self.assertEqual(undo_result.focus_target.target_id, "module:service")
            self.assertEqual(undo_result.focus_target.level, "module")

    def test_replace_symbol_source_supports_whole_class_replacement_with_attributes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            write_repo_files(
                root,
                {
                    "service.py": (
                        "# before class\n"
                        "@decorator\n"
                        "class Service(\n"
                        "    Base,\n"
                        "):\n"
                        '    """Original docstring."""\n'
                        "    enabled: bool = True\n\n"
                        "    def run(self) -> bool:\n"
                        "        return self.enabled\n\n"
                        "# after class\n"
                        "def helper() -> bool:\n"
                        "    return True\n"
                    ),
                },
            )

            parsed_modules, _, inbound = parse_repo(root)
            result = apply_structural_edit(
                root,
                serialize_edit_request(
                    {
                        "kind": "replace_symbol_source",
                        "target_id": "symbol:service:Service",
                        "content": (
                            "@decorator\n"
                            "class Service(\n"
                            "    Base,\n"
                            "):\n"
                            '    """Updated docstring."""\n'
                            "    enabled: bool = False\n\n"
                            "    def run(self) -> bool:\n"
                            "        return self.enabled\n"
                        ),
                    }
                ),
                parsed_modules=parsed_modules,
                inbound_dependency_count=inbound,
            )

            self.assertEqual(result.changed_node_ids, ("symbol:service:Service",))
            self.assertEqual(
                (root / "service.py").read_text(encoding="utf-8"),
                (
                    "# before class\n"
                    "@decorator\n"
                    "class Service(\n"
                    "    Base,\n"
                    "):\n"
                    '    """Updated docstring."""\n'
                    "    enabled: bool = False\n\n"
                    "    def run(self) -> bool:\n"
                    "        return self.enabled\n\n"
                    "# after class\n"
                    "def helper() -> bool:\n"
                    "    return True\n"
                ),
            )

    def test_replace_symbol_source_preserves_nested_method_spacing_comments_and_async_shape(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            write_repo_files(
                root,
                {
                    "service.py": (
                        "class Service:\n"
                        "    enabled = True\n\n"
                        "    # before run\n"
                        "    @trace\n"
                        "    async def run(\n"
                        "        self,\n"
                        "        value: str,\n"
                        "    ) -> str:\n"
                        '        """Return the current value."""\n'
                        "        return value\n\n"
                        "    def helper(self) -> bool:\n"
                        "        return self.enabled\n"
                    ),
                },
            )

            parsed_modules, _, inbound = parse_repo(root)
            result = apply_structural_edit(
                root,
                serialize_edit_request(
                    {
                        "kind": "replace_symbol_source",
                        "target_id": "symbol:service:Service.run",
                        "content": (
                            "@trace\n"
                            "async def run(\n"
                            "    self,\n"
                            "    value: str,\n"
                            "    fallback: str | None = None,\n"
                            ") -> str:\n"
                            '    """Return the latest value."""\n'
                            "    return fallback or value\n"
                        ),
                    }
                ),
                parsed_modules=parsed_modules,
                inbound_dependency_count=inbound,
            )

            self.assertEqual(result.changed_node_ids, ("symbol:service:Service.run",))
            self.assertEqual(result.flow_sync_state, "clean")
            self.assertTrue((root / FLOW_MODEL_RELATIVE_PATH).exists())
            self.assertEqual(
                (root / "service.py").read_text(encoding="utf-8"),
                (
                    "class Service:\n"
                    "    enabled = True\n\n"
                    "    # before run\n"
                    "    @trace\n"
                    "    async def run(\n"
                    "        self,\n"
                    "        value: str,\n"
                    "        fallback: str | None = None,\n"
                    "    ) -> str:\n"
                    '        """Return the latest value."""\n'
                    "        return fallback or value\n\n"
                    "    def helper(self) -> bool:\n"
                    "        return self.enabled\n"
                ),
            )

    def test_backend_undo_restores_saved_method_source_and_flow_document(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            write_repo_files(
                root,
                {
                    "service.py": (
                        "class Service:\n    def run(self) -> bool:\n        return True\n"
                    ),
                },
            )

            parsed_modules, _, inbound = parse_repo(root)
            result = apply_structural_edit(
                root,
                serialize_edit_request(
                    {
                        "kind": "replace_symbol_source",
                        "target_id": "symbol:service:Service.run",
                        "content": "def run(self) -> bool:\n    return False\n",
                    }
                ),
                parsed_modules=parsed_modules,
                inbound_dependency_count=inbound,
            )

            self.assertIn("return False", (root / "service.py").read_text(encoding="utf-8"))
            self.assertTrue((root / FLOW_MODEL_RELATIVE_PATH).exists())

            undo_result = apply_backend_undo(root, result.undo_transaction)

            self.assertIn("return True", (root / "service.py").read_text(encoding="utf-8"))
            self.assertFalse((root / FLOW_MODEL_RELATIVE_PATH).exists())
            self.assertEqual(undo_result.focus_target.target_id, "symbol:service:Service.run")
            self.assertEqual(undo_result.focus_target.level, "symbol")

    def test_backend_undo_restores_inserted_flow_statement(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            write_repo_files(
                root,
                {
                    "service.py": ("def run():\n    current = 1\n    return current\n"),
                },
            )

            parsed_modules, _, inbound = parse_repo(root)
            result = apply_structural_edit(
                root,
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
                ),
                parsed_modules=parsed_modules,
                inbound_dependency_count=inbound,
            )

            self.assertIn("helper = current + 1", (root / "service.py").read_text(encoding="utf-8"))

            undo_result = apply_backend_undo(root, result.undo_transaction)

            self.assertNotIn(
                "helper = current + 1", (root / "service.py").read_text(encoding="utf-8")
            )
            self.assertEqual(undo_result.focus_target.target_id, "symbol:service:run")
            self.assertEqual(undo_result.focus_target.level, "flow")

    def test_replace_flow_graph_saves_invalid_graph_as_draft_without_touching_python_source(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            original_source = "def run(value):\n    current = value + 1\n    return current\n"
            write_repo_files(root, {"service.py": original_source})

            imported = import_flow_document_from_function_source(
                symbol_id="symbol:service:run",
                relative_path="service.py",
                qualname="run",
                module_source=original_source,
            )
            draft_payload = imported.to_dict()
            draft_payload["nodes"].append(
                {
                    "id": "flowdoc:symbol:service:run:call:disconnected",
                    "kind": "call",
                    "payload": {"source": "notify(current)"},
                }
            )

            parsed_modules, _, inbound = parse_repo(root)
            result = apply_structural_edit(
                root,
                serialize_edit_request(
                    {
                        "kind": "replace_flow_graph",
                        "target_id": "symbol:service:run",
                        "flow_graph": draft_payload,
                    }
                ),
                parsed_modules=parsed_modules,
                inbound_dependency_count=inbound,
            )

            self.assertEqual(result.flow_sync_state, "draft")
            self.assertTrue(
                any("Unreachable flow nodes" in message for message in result.diagnostics)
            )
            self.assertEqual(result.touched_relative_paths, (FLOW_MODEL_RELATIVE_PATH,))
            self.assertEqual((root / "service.py").read_text(encoding="utf-8"), original_source)
            self.assertEqual(result.undo_transaction.focus_target.target_id, "symbol:service:run")
            self.assertEqual(result.undo_transaction.focus_target.level, "flow")

            stored = read_flow_document(root, "symbol:service:run")
            self.assertIsNotNone(stored)
            assert stored is not None
            self.assertEqual(stored.sync_state, "draft")
            self.assertTrue(
                any("Unreachable flow nodes" in message for message in stored.diagnostics)
            )
            indexed_node_ids = {node.node_id: node.indexed_node_id for node in stored.nodes}
            self.assertEqual(
                indexed_node_ids.get("flowdoc:symbol:service:run:entry"),
                "flow:symbol:service:run:entry",
            )
            self.assertEqual(
                next(node.indexed_node_id for node in stored.nodes if node.kind == "return"),
                "flow:symbol:service:run:statement:1",
            )
            self.assertIsNone(indexed_node_ids.get("flowdoc:symbol:service:run:call:disconnected"))

            undo_result = apply_backend_undo(root, result.undo_transaction)
            self.assertFalse((root / FLOW_MODEL_RELATIVE_PATH).exists())
            self.assertEqual(undo_result.focus_target.target_id, "symbol:service:run")
            self.assertEqual(undo_result.focus_target.level, "flow")

    def test_replace_flow_graph_rejects_parameter_nodes_in_persisted_documents(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            source = "def run(value):\n    return value\n"
            write_repo_files(root, {"service.py": source})

            imported = import_flow_document_from_function_source(
                symbol_id="symbol:service:run",
                relative_path="service.py",
                qualname="run",
                module_source=source,
            )
            payload = imported.to_dict()
            payload["nodes"].append(
                {
                    "id": "flow:symbol:service:run:param:value",
                    "kind": "param",
                    "payload": {},
                }
            )

            parsed_modules, _, inbound = parse_repo(root)
            with self.assertRaisesRegex(ValueError, "supported document kind"):
                apply_structural_edit(
                    root,
                    serialize_edit_request(
                        {
                            "kind": "replace_flow_graph",
                            "target_id": "symbol:service:run",
                            "flow_graph": payload,
                        }
                    ),
                    parsed_modules=parsed_modules,
                    inbound_dependency_count=inbound,
                )

    def test_replace_flow_graph_saves_clean_graph_updates_source_and_undo_restores_both_files(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            original_source = "def run(value):\n    return value\n"
            write_repo_files(root, {"service.py": original_source})

            imported = import_flow_document_from_function_source(
                symbol_id="symbol:service:run",
                relative_path="service.py",
                qualname="run",
                module_source=original_source,
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

            parsed_modules, _, inbound = parse_repo(root)
            result = apply_structural_edit(
                root,
                serialize_edit_request(
                    {
                        "kind": "replace_flow_graph",
                        "target_id": "symbol:service:run",
                        "flow_graph": clean_payload,
                    }
                ),
                parsed_modules=parsed_modules,
                inbound_dependency_count=inbound,
            )

            self.assertEqual(result.flow_sync_state, "clean")
            self.assertEqual(result.diagnostics, ())
            self.assertEqual(
                result.touched_relative_paths,
                ("service.py", FLOW_MODEL_RELATIVE_PATH),
            )
            self.assertIn("prepare(value)", (root / "service.py").read_text(encoding="utf-8"))

            stored = read_flow_document(root, "symbol:service:run")
            self.assertIsNotNone(stored)
            assert stored is not None
            self.assertEqual(stored.sync_state, "clean")
            self.assertEqual(stored.diagnostics, ())
            self.assertTrue(any(node.node_id == call_node_id for node in stored.nodes))
            stored_call = next(node for node in stored.nodes if node.node_id == call_node_id)
            self.assertEqual(
                stored_call.indexed_node_id,
                "flow:symbol:service:run:statement:0",
            )
            stored_return = next(node for node in stored.nodes if node.kind == "return")
            self.assertEqual(
                stored_return.indexed_node_id,
                "flow:symbol:service:run:statement:1",
            )

            apply_backend_undo(root, result.undo_transaction)
            self.assertEqual((root / "service.py").read_text(encoding="utf-8"), original_source)
            self.assertFalse((root / FLOW_MODEL_RELATIVE_PATH).exists())

    def test_replace_flow_graph_drops_derived_return_completion_edges_before_persisting(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            source = "def run(value):\n    return value\n"
            write_repo_files(root, {"service.py": source})

            imported = import_flow_document_from_function_source(
                symbol_id="symbol:service:run",
                relative_path="service.py",
                qualname="run",
                module_source=source,
            )
            return_node = next(node for node in imported.nodes if node.kind == "return")
            exit_node = next(node for node in imported.nodes if node.kind == "exit")
            completion_edge_id = flow_return_completion_edge_id(
                return_node.node_id, exit_node.node_id
            )
            payload = imported.to_dict()
            payload["edges"].append(
                FlowModelEdge(
                    edge_id=completion_edge_id,
                    source_id=return_node.node_id,
                    source_handle="exit",
                    target_id=exit_node.node_id,
                    target_handle="in",
                ).to_dict()
            )

            parsed_modules, _, inbound = parse_repo(root)
            result = apply_structural_edit(
                root,
                serialize_edit_request(
                    {
                        "kind": "replace_flow_graph",
                        "target_id": "symbol:service:run",
                        "flow_graph": payload,
                    }
                ),
                parsed_modules=parsed_modules,
                inbound_dependency_count=inbound,
            )

            self.assertEqual(result.flow_sync_state, "clean")
            self.assertEqual((root / "service.py").read_text(encoding="utf-8"), source)
            stored = read_flow_document(root, "symbol:service:run")
            self.assertIsNotNone(stored)
            assert stored is not None
            self.assertFalse(any(edge.edge_id == completion_edge_id for edge in stored.edges))

    def test_replace_flow_graph_keeps_invalid_return_control_edges_draft_backed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            source = "def run(value):\n    return value\n"
            write_repo_files(root, {"service.py": source})

            imported = import_flow_document_from_function_source(
                symbol_id="symbol:service:run",
                relative_path="service.py",
                qualname="run",
                module_source=source,
            )
            return_node = next(node for node in imported.nodes if node.kind == "return")
            exit_node = next(node for node in imported.nodes if node.kind == "exit")
            invalid_edge_id = f"controls:{return_node.node_id}:next->{exit_node.node_id}:in"
            payload = imported.to_dict()
            payload["edges"].append(
                FlowModelEdge(
                    edge_id=invalid_edge_id,
                    source_id=return_node.node_id,
                    source_handle="next",
                    target_id=exit_node.node_id,
                    target_handle="in",
                ).to_dict()
            )

            parsed_modules, _, inbound = parse_repo(root)
            result = apply_structural_edit(
                root,
                serialize_edit_request(
                    {
                        "kind": "replace_flow_graph",
                        "target_id": "symbol:service:run",
                        "flow_graph": payload,
                    }
                ),
                parsed_modules=parsed_modules,
                inbound_dependency_count=inbound,
            )

            self.assertEqual(result.flow_sync_state, "draft")
            self.assertIn(
                f"return node '{return_node.node_id}' cannot use output 'next'.",
                result.diagnostics,
            )
            self.assertEqual((root / "service.py").read_text(encoding="utf-8"), source)
            stored = read_flow_document(root, "symbol:service:run")
            self.assertIsNotNone(stored)
            assert stored is not None
            self.assertEqual(stored.sync_state, "draft")
            self.assertTrue(any(edge.edge_id == invalid_edge_id for edge in stored.edges))

    def test_replace_flow_graph_backfills_legacy_control_only_payload_before_clean_save(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            source = "def add(a, b):\n    return a + b\n"
            write_repo_files(root, {"service.py": source})

            imported = import_flow_document_from_function_source(
                symbol_id="symbol:service:add",
                relative_path="service.py",
                qualname="add",
                module_source=source,
            )
            legacy_payload = imported.to_dict()
            legacy_payload.pop("function_inputs", None)
            legacy_payload.pop("input_slots", None)
            legacy_payload.pop("input_bindings", None)
            for node in legacy_payload["nodes"]:
                node.pop("indexed_node_id", None)

            parsed_modules, _, inbound = parse_repo(root)
            result = apply_structural_edit(
                root,
                serialize_edit_request(
                    {
                        "kind": "replace_flow_graph",
                        "target_id": "symbol:service:add",
                        "flow_graph": legacy_payload,
                    }
                ),
                parsed_modules=parsed_modules,
                inbound_dependency_count=inbound,
            )

            self.assertEqual(result.flow_sync_state, "clean")
            stored = read_flow_document(root, "symbol:service:add")
            self.assertIsNotNone(stored)
            assert stored is not None
            self.assertEqual(
                [function_input.name for function_input in stored.function_inputs], ["a", "b"]
            )
            self.assertEqual(
                {slot.slot_id for slot in stored.input_slots},
                {
                    "flowslot:flow:symbol:service:add:statement:0:a",
                    "flowslot:flow:symbol:service:add:statement:0:b",
                },
            )
            self.assertEqual(
                {binding.binding_id for binding in stored.input_bindings},
                {
                    (
                        "flowbinding:flowslot:flow:symbol:service:add:statement:0:a"
                        "->flowinput:symbol:service:add:a"
                    ),
                    (
                        "flowbinding:flowslot:flow:symbol:service:add:statement:0:b"
                        "->flowinput:symbol:service:add:b"
                    ),
                },
            )

    def test_replace_flow_graph_rewrites_function_signature_from_flow_inputs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            source = "def run(a: int, b=1):\n    return a + b\n"
            write_repo_files(root, {"service.py": source})

            imported = import_flow_document_from_function_source(
                symbol_id="symbol:service:run",
                relative_path="service.py",
                qualname="run",
                module_source=source,
            )
            payload = imported.to_dict()
            input_ids = {item["name"]: item["id"] for item in payload["function_inputs"]}
            payload["function_inputs"] = [
                payload["function_inputs"][0],
                {
                    **payload["function_inputs"][1],
                    "name": "limit",
                    "default_expression": "2",
                },
                {
                    "id": "flowinput:symbol:service:run:c",
                    "name": "c",
                    "index": 2,
                    "kind": "positional_or_keyword",
                    "default_expression": "10",
                },
            ]
            payload["input_bindings"] = [
                (
                    {
                        **binding,
                        "function_input_id": input_ids["b"],
                    }
                    if binding["source_id"] == input_ids["b"]
                    else binding
                )
                for binding in payload["input_bindings"]
            ]

            parsed_modules, _, inbound = parse_repo(root)
            result = apply_structural_edit(
                root,
                serialize_edit_request(
                    {
                        "kind": "replace_flow_graph",
                        "target_id": "symbol:service:run",
                        "flow_graph": payload,
                    }
                ),
                parsed_modules=parsed_modules,
                inbound_dependency_count=inbound,
            )

            self.assertEqual(result.flow_sync_state, "clean")
            updated_source = (root / "service.py").read_text(encoding="utf-8")
            self.assertIn("def run(a: int, limit=2, c=10):", updated_source)
            self.assertIn("return a + limit", updated_source)
            stored = read_flow_document(root, "symbol:service:run")
            self.assertIsNotNone(stored)
            assert stored is not None
            self.assertEqual(
                [
                    (item.input_id, item.name, item.default_expression)
                    for item in stored.function_inputs
                ],
                [
                    ("flowinput:symbol:service:run:a", "a", None),
                    ("flowinput:symbol:service:run:b", "limit", "2"),
                    ("flowinput:symbol:service:run:c", "c", "10"),
                ],
            )

    def test_replace_flow_graph_rewrites_rewired_function_input_bindings_semantically(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            source = 'def run(a, b, value):\n    label = "b"\n    return value.b + b\n'
            write_repo_files(root, {"service.py": source})

            imported = import_flow_document_from_function_source(
                symbol_id="symbol:service:run",
                relative_path="service.py",
                qualname="run",
                module_source=source,
            )
            payload = imported.to_dict()
            input_ids = {item["name"]: item["id"] for item in payload["function_inputs"]}
            b_slot = next(slot for slot in payload["input_slots"] if slot["slot_key"] == "b")
            payload["input_bindings"] = [
                (
                    {
                        **binding,
                        "id": f"flowbinding:{b_slot['id']}->{input_ids['a']}",
                        "function_input_id": input_ids["a"],
                    }
                    if binding["slot_id"] == b_slot["id"]
                    else binding
                )
                for binding in payload["input_bindings"]
            ]

            parsed_modules, _, inbound = parse_repo(root)
            result = apply_structural_edit(
                root,
                serialize_edit_request(
                    {
                        "kind": "replace_flow_graph",
                        "target_id": "symbol:service:run",
                        "flow_graph": payload,
                    }
                ),
                parsed_modules=parsed_modules,
                inbound_dependency_count=inbound,
            )

            self.assertEqual(result.flow_sync_state, "clean")
            updated_source = (root / "service.py").read_text(encoding="utf-8")
            self.assertIn("label = 'b'", updated_source)
            self.assertIn("return value.b + a", updated_source)
            self.assertNotIn("return value.a + a", updated_source)

    def test_replace_flow_graph_rewrites_rewired_local_value_bindings_semantically(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            source = "def run(a, b):\n    x = a + 1\n    y = b + 1\n    return x\n"
            write_repo_files(root, {"service.py": source})

            imported = import_flow_document_from_function_source(
                symbol_id="symbol:service:run",
                relative_path="service.py",
                qualname="run",
                module_source=source,
            )
            payload = imported.to_dict()
            return_slot = next(slot for slot in payload["input_slots"] if slot["slot_key"] == "x")
            y_source = next(source for source in payload["value_sources"] if source["name"] == "y")
            payload["input_bindings"] = [
                (
                    {
                        **binding,
                        "id": f"flowbinding:{return_slot['id']}->{y_source['id']}",
                        "source_id": y_source["id"],
                    }
                    if binding["slot_id"] == return_slot["id"]
                    else binding
                )
                for binding in payload["input_bindings"]
            ]

            parsed_modules, _, inbound = parse_repo(root)
            result = apply_structural_edit(
                root,
                serialize_edit_request(
                    {
                        "kind": "replace_flow_graph",
                        "target_id": "symbol:service:run",
                        "flow_graph": payload,
                    }
                ),
                parsed_modules=parsed_modules,
                inbound_dependency_count=inbound,
            )

            self.assertEqual(result.flow_sync_state, "clean")
            updated_source = (root / "service.py").read_text(encoding="utf-8")
            self.assertIn("return y", updated_source)
            stored = read_flow_document(root, "symbol:service:run")
            self.assertIsNotNone(stored)
            assert stored is not None
            self.assertTrue(any(source.name == "y" for source in stored.value_sources))

    def test_replace_flow_graph_duplicate_local_name_rewire_clean_saves_with_alias(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            source = "def run(a):\n    x = a\n    x = a + 1\n    return x\n"
            write_repo_files(root, {"service.py": source})

            imported = import_flow_document_from_function_source(
                symbol_id="symbol:service:run",
                relative_path="service.py",
                qualname="run",
                module_source=source,
            )
            payload = imported.to_dict()
            x_sources = [source for source in payload["value_sources"] if source["name"] == "x"]
            self.assertEqual(len(x_sources), 2)
            earlier_source = x_sources[0]
            return_slot = next(slot for slot in payload["input_slots"] if slot["slot_key"] == "x")
            payload["input_bindings"] = [
                (
                    {
                        **binding,
                        "id": f"flowbinding:{return_slot['id']}->{earlier_source['id']}",
                        "source_id": earlier_source["id"],
                    }
                    if binding["slot_id"] == return_slot["id"]
                    else binding
                )
                for binding in payload["input_bindings"]
            ]

            parsed_modules, _, inbound = parse_repo(root)
            result = apply_structural_edit(
                root,
                serialize_edit_request(
                    {
                        "kind": "replace_flow_graph",
                        "target_id": "symbol:service:run",
                        "flow_graph": payload,
                    }
                ),
                parsed_modules=parsed_modules,
                inbound_dependency_count=inbound,
            )

            self.assertEqual(result.flow_sync_state, "clean")
            self.assertEqual(result.diagnostics, ())
            self.assertEqual(
                (root / "service.py").read_text(encoding="utf-8"),
                ("def run(a):\n    x__flow_0 = a\n    x = a + 1\n    return x__flow_0\n"),
            )
            stored = read_flow_document(root, "symbol:service:run")
            self.assertIsNotNone(stored)
            assert stored is not None
            self.assertEqual(stored.sync_state, "clean")
            stored_earlier_source = next(
                source
                for source in stored.value_sources
                if source.source_id == earlier_source["id"]
            )
            self.assertEqual(stored_earlier_source.name, "x")
            self.assertEqual(stored_earlier_source.emitted_name, "x__flow_0")
            self.assertTrue(
                any(binding.source_id == earlier_source["id"] for binding in stored.input_bindings)
            )

    def test_replace_flow_graph_function_input_shadow_rewire_clean_saves_with_local_alias(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            source = "def run(x):\n    x = 1\n    return x\n"
            write_repo_files(root, {"service.py": source})

            imported = import_flow_document_from_function_source(
                symbol_id="symbol:service:run",
                relative_path="service.py",
                qualname="run",
                module_source=source,
            )
            payload = imported.to_dict()
            input_id = payload["function_inputs"][0]["id"]
            node_kind_by_id = {node["id"]: node["kind"] for node in payload["nodes"]}
            return_slot = next(
                slot
                for slot in payload["input_slots"]
                if node_kind_by_id[slot["node_id"]] == "return"
            )
            payload["input_bindings"] = [
                (
                    {
                        **binding,
                        "id": f"flowbinding:{return_slot['id']}->{input_id}",
                        "source_id": input_id,
                        "function_input_id": input_id,
                    }
                    if binding["slot_id"] == return_slot["id"]
                    else binding
                )
                for binding in payload["input_bindings"]
            ]

            parsed_modules, _, inbound = parse_repo(root)
            result = apply_structural_edit(
                root,
                serialize_edit_request(
                    {
                        "kind": "replace_flow_graph",
                        "target_id": "symbol:service:run",
                        "flow_graph": payload,
                    }
                ),
                parsed_modules=parsed_modules,
                inbound_dependency_count=inbound,
            )

            self.assertEqual(result.flow_sync_state, "clean")
            self.assertEqual(
                (root / "service.py").read_text(encoding="utf-8"),
                ("def run(x):\n    x__flow_0 = 1\n    return x\n"),
            )
            stored = read_flow_document(root, "symbol:service:run")
            self.assertIsNotNone(stored)
            assert stored is not None
            local_source = next(source for source in stored.value_sources if source.name == "x")
            self.assertEqual(local_source.emitted_name, "x__flow_0")
            self.assertTrue(
                any(
                    binding.source_id == input_id and binding.slot_id.endswith(":x")
                    for binding in stored.input_bindings
                )
            )

    def test_replace_flow_graph_async_method_shadow_rewire_preserves_async_shape(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            source = (
                "class Service:\n"
                "    async def run(self, value):\n"
                "        value = 1\n"
                "        return value\n"
            )
            write_repo_files(root, {"service.py": source})

            imported = import_flow_document_from_function_source(
                symbol_id="symbol:service:Service.run",
                relative_path="service.py",
                qualname="Service.run",
                module_source=source,
            )
            payload = imported.to_dict()
            input_id = next(
                item["id"] for item in payload["function_inputs"] if item["name"] == "value"
            )
            node_kind_by_id = {node["id"]: node["kind"] for node in payload["nodes"]}
            return_slot = next(
                slot
                for slot in payload["input_slots"]
                if node_kind_by_id[slot["node_id"]] == "return"
            )
            payload["input_bindings"] = [
                (
                    {
                        **binding,
                        "id": f"flowbinding:{return_slot['id']}->{input_id}",
                        "source_id": input_id,
                        "function_input_id": input_id,
                    }
                    if binding["slot_id"] == return_slot["id"]
                    else binding
                )
                for binding in payload["input_bindings"]
            ]

            parsed_modules, _, inbound = parse_repo(root)
            result = apply_structural_edit(
                root,
                serialize_edit_request(
                    {
                        "kind": "replace_flow_graph",
                        "target_id": "symbol:service:Service.run",
                        "flow_graph": payload,
                    }
                ),
                parsed_modules=parsed_modules,
                inbound_dependency_count=inbound,
            )

            self.assertEqual(result.flow_sync_state, "clean")
            self.assertEqual(
                (root / "service.py").read_text(encoding="utf-8"),
                (
                    "class Service:\n"
                    "    async def run(self, value):\n"
                    "        value__flow_0 = 1\n"
                    "        return value\n"
                ),
            )

    def test_replace_flow_graph_future_source_binding_remains_draft(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            source = "def run(a):\n    y = a\n    x = a\n    return y\n"
            write_repo_files(root, {"service.py": source})

            imported = import_flow_document_from_function_source(
                symbol_id="symbol:service:run",
                relative_path="service.py",
                qualname="run",
                module_source=source,
            )
            payload = imported.to_dict()
            node_kind_by_id = {node["id"]: node["kind"] for node in payload["nodes"]}
            payload_by_id = {node["id"]: node["payload"] for node in payload["nodes"]}
            first_assign_slot = next(
                slot
                for slot in payload["input_slots"]
                if node_kind_by_id[slot["node_id"]] == "assign"
                and str(payload_by_id[slot["node_id"]].get("source", "")).startswith("y =")
            )
            x_source = next(source for source in payload["value_sources"] if source["name"] == "x")
            payload["input_bindings"] = [
                (
                    {
                        **binding,
                        "id": f"flowbinding:{first_assign_slot['id']}->{x_source['id']}",
                        "source_id": x_source["id"],
                    }
                    if binding["slot_id"] == first_assign_slot["id"]
                    else binding
                )
                for binding in payload["input_bindings"]
            ]

            parsed_modules, _, inbound = parse_repo(root)
            result = apply_structural_edit(
                root,
                serialize_edit_request(
                    {
                        "kind": "replace_flow_graph",
                        "target_id": "symbol:service:run",
                        "flow_graph": payload,
                    }
                ),
                parsed_modules=parsed_modules,
                inbound_dependency_count=inbound,
            )

            self.assertEqual(result.flow_sync_state, "draft")
            self.assertIn("future-source", " ".join(result.diagnostics))
            self.assertEqual((root / "service.py").read_text(encoding="utf-8"), source)

    def test_replace_flow_graph_branch_only_source_after_merge_remains_draft(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            source = "def run(flag, a):\n    if flag:\n        x = a\n    return x\n"
            write_repo_files(root, {"service.py": source})
            imported = import_flow_document_from_function_source(
                symbol_id="symbol:service:run",
                relative_path="service.py",
                qualname="run",
                module_source=source,
            )

            parsed_modules, _, inbound = parse_repo(root)
            result = apply_structural_edit(
                root,
                serialize_edit_request(
                    {
                        "kind": "replace_flow_graph",
                        "target_id": "symbol:service:run",
                        "flow_graph": imported.to_dict(),
                    }
                ),
                parsed_modules=parsed_modules,
                inbound_dependency_count=inbound,
            )

            self.assertEqual(result.flow_sync_state, "draft")
            self.assertIn("branch-only source after merge", " ".join(result.diagnostics))
            self.assertEqual((root / "service.py").read_text(encoding="utf-8"), source)

    def test_replace_flow_graph_loop_body_source_after_loop_remains_draft(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            source = (
                "def run(flag, a):\n"
                "    while flag:\n"
                "        x = a\n"
                "        flag = False\n"
                "    return x\n"
            )
            write_repo_files(root, {"service.py": source})
            imported = import_flow_document_from_function_source(
                symbol_id="symbol:service:run",
                relative_path="service.py",
                qualname="run",
                module_source=source,
            )

            parsed_modules, _, inbound = parse_repo(root)
            result = apply_structural_edit(
                root,
                serialize_edit_request(
                    {
                        "kind": "replace_flow_graph",
                        "target_id": "symbol:service:run",
                        "flow_graph": imported.to_dict(),
                    }
                ),
                parsed_modules=parsed_modules,
                inbound_dependency_count=inbound,
            )

            self.assertEqual(result.flow_sync_state, "draft")
            self.assertIn("loop-body-only source after loop", " ".join(result.diagnostics))
            self.assertEqual((root / "service.py").read_text(encoding="utf-8"), source)

    def test_input_binding_records_allow_one_input_to_feed_multiple_slots_independently(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            source = "def run(a):\n    x = a\n    return a\n"
            write_repo_files(root, {"service.py": source})

            imported = import_flow_document_from_function_source(
                symbol_id="symbol:service:run",
                relative_path="service.py",
                qualname="run",
                module_source=source,
            )
            self.assertEqual(len(imported.input_bindings), 2)
            self.assertEqual(
                {binding.function_input_id for binding in imported.input_bindings},
                {imported.function_inputs[0].input_id},
            )

            payload = imported.to_dict()
            removed_binding = payload["input_bindings"][0]
            payload["input_bindings"] = [
                binding
                for binding in payload["input_bindings"]
                if binding["id"] != removed_binding["id"]
            ]

            parsed_modules, _, inbound = parse_repo(root)
            result = apply_structural_edit(
                root,
                serialize_edit_request(
                    {
                        "kind": "replace_flow_graph",
                        "target_id": "symbol:service:run",
                        "flow_graph": payload,
                    }
                ),
                parsed_modules=parsed_modules,
                inbound_dependency_count=inbound,
            )

            self.assertEqual(result.flow_sync_state, "draft")
            stored = read_flow_document(root, "symbol:service:run")
            self.assertIsNotNone(stored)
            assert stored is not None
            self.assertEqual(len(stored.input_bindings), 1)
            self.assertEqual(
                stored.input_bindings[0].function_input_id, imported.function_inputs[0].input_id
            )
            self.assertNotEqual(stored.input_bindings[0].binding_id, removed_binding["id"])
            self.assertEqual(result.undo_transaction.focus_target.target_id, "symbol:service:run")
            self.assertEqual(result.undo_transaction.focus_target.level, "flow")

    def test_replace_flow_graph_round_trips_all_picker_node_kinds_cleanly(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            original_source = "def run(value, items, total):\n    return value\n"
            write_repo_files(root, {"service.py": original_source})

            payload = {
                "symbol_id": "symbol:service:run",
                "relative_path": "service.py",
                "qualname": "run",
                "nodes": [
                    {"id": "flowdoc:symbol:service:run:entry", "kind": "entry", "payload": {}},
                    {
                        "id": "flowdoc:symbol:service:run:assign:prepare",
                        "kind": "assign",
                        "payload": {"source": "value = prepare(value)"},
                    },
                    {
                        "id": "flowdoc:symbol:service:run:call:notify",
                        "kind": "call",
                        "payload": {"source": "notify(value)"},
                    },
                    {
                        "id": "flowdoc:symbol:service:run:branch:ready",
                        "kind": "branch",
                        "payload": {"condition": "value > 0"},
                    },
                    {
                        "id": "flowdoc:symbol:service:run:loop:items",
                        "kind": "loop",
                        "payload": {"header": "for item in items"},
                    },
                    {
                        "id": "flowdoc:symbol:service:run:call:tick",
                        "kind": "call",
                        "payload": {"source": "tick(item)"},
                    },
                    {
                        "id": "flowdoc:symbol:service:run:return:false",
                        "kind": "return",
                        "payload": {"expression": "value"},
                    },
                    {
                        "id": "flowdoc:symbol:service:run:return:after",
                        "kind": "return",
                        "payload": {"expression": "total + 1"},
                    },
                    {"id": "flowdoc:symbol:service:run:exit", "kind": "exit", "payload": {}},
                ],
                "edges": [
                    {
                        "id": "controls:flowdoc:symbol:service:run:entry:start->flowdoc:symbol:service:run:assign:prepare:in",
                        "source_id": "flowdoc:symbol:service:run:entry",
                        "source_handle": "start",
                        "target_id": "flowdoc:symbol:service:run:assign:prepare",
                        "target_handle": "in",
                    },
                    {
                        "id": "controls:flowdoc:symbol:service:run:assign:prepare:next->flowdoc:symbol:service:run:call:notify:in",
                        "source_id": "flowdoc:symbol:service:run:assign:prepare",
                        "source_handle": "next",
                        "target_id": "flowdoc:symbol:service:run:call:notify",
                        "target_handle": "in",
                    },
                    {
                        "id": "controls:flowdoc:symbol:service:run:call:notify:next->flowdoc:symbol:service:run:branch:ready:in",
                        "source_id": "flowdoc:symbol:service:run:call:notify",
                        "source_handle": "next",
                        "target_id": "flowdoc:symbol:service:run:branch:ready",
                        "target_handle": "in",
                    },
                    {
                        "id": "controls:flowdoc:symbol:service:run:branch:ready:true->flowdoc:symbol:service:run:loop:items:in",
                        "source_id": "flowdoc:symbol:service:run:branch:ready",
                        "source_handle": "true",
                        "target_id": "flowdoc:symbol:service:run:loop:items",
                        "target_handle": "in",
                    },
                    {
                        "id": "controls:flowdoc:symbol:service:run:branch:ready:false->flowdoc:symbol:service:run:return:false:in",
                        "source_id": "flowdoc:symbol:service:run:branch:ready",
                        "source_handle": "false",
                        "target_id": "flowdoc:symbol:service:run:return:false",
                        "target_handle": "in",
                    },
                    {
                        "id": "controls:flowdoc:symbol:service:run:loop:items:body->flowdoc:symbol:service:run:call:tick:in",
                        "source_id": "flowdoc:symbol:service:run:loop:items",
                        "source_handle": "body",
                        "target_id": "flowdoc:symbol:service:run:call:tick",
                        "target_handle": "in",
                    },
                    {
                        "id": "controls:flowdoc:symbol:service:run:call:tick:next->flowdoc:symbol:service:run:exit:in",
                        "source_id": "flowdoc:symbol:service:run:call:tick",
                        "source_handle": "next",
                        "target_id": "flowdoc:symbol:service:run:exit",
                        "target_handle": "in",
                    },
                    {
                        "id": "controls:flowdoc:symbol:service:run:loop:items:after->flowdoc:symbol:service:run:return:after:in",
                        "source_id": "flowdoc:symbol:service:run:loop:items",
                        "source_handle": "after",
                        "target_id": "flowdoc:symbol:service:run:return:after",
                        "target_handle": "in",
                    },
                ],
                "sync_state": "clean",
                "diagnostics": [],
                "editable": True,
            }

            parsed_modules, _, inbound = parse_repo(root)
            result = apply_structural_edit(
                root,
                serialize_edit_request(
                    {
                        "kind": "replace_flow_graph",
                        "target_id": "symbol:service:run",
                        "flow_graph": payload,
                    }
                ),
                parsed_modules=parsed_modules,
                inbound_dependency_count=inbound,
            )

            self.assertEqual(result.flow_sync_state, "clean")
            self.assertEqual(result.diagnostics, ())
            updated_source = (root / "service.py").read_text(encoding="utf-8")
            self.assertIn("value = prepare(value)", updated_source)
            self.assertIn("notify(value)", updated_source)
            self.assertIn("if value > 0:", updated_source)
            self.assertIn("for item in items:", updated_source)
            self.assertIn("tick(item)", updated_source)
            self.assertIn("return total + 1", updated_source)

            stored = read_flow_document(root, "symbol:service:run")
            self.assertIsNotNone(stored)
            assert stored is not None
            self.assertEqual(stored.sync_state, "clean")
            self.assertEqual(
                {node.kind for node in stored.nodes},
                {"entry", "assign", "call", "branch", "loop", "return", "exit"},
            )
