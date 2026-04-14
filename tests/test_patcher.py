from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from helm.editor import apply_backend_undo, apply_structural_edit, serialize_edit_request
from helm.editor.flow_model import FLOW_MODEL_RELATIVE_PATH
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
            self.assertIn("def helper_blueprint():", (root / "service.py").read_text(encoding="utf-8"))

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
            self.assertNotIn("def build_blueprint():", (root / "beta.py").read_text(encoding="utf-8"))

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
                    "controls:flow:symbol:service:run:entry"
                    "->flow:symbol:service:run:statement:0"
                ),
                "content": "helper = 1",
                "expected_snippet": (
                    "def run():\n"
                    "    helper = 1\n"
                    "    current = 1\n"
                    "    return current\n"
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
                    "def run():\n"
                    "    current = 1\n"
                    "    helper = current + 1\n"
                    "    return current\n"
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
                            "service.py": (
                                "def run():\n"
                                "    current = 1\n"
                                "    return current\n"
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
                                "def run(flag):\n"
                                "    if flag:\n"
                                "        return 1\n"
                                "    return 0\n"
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
            self.assertIn("from helpers import helper", (root / "service.py").read_text(encoding="utf-8"))

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
            self.assertNotIn("from helpers import helper", (root / "service.py").read_text(encoding="utf-8"))

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
            self.assertEqual(undo_result.focus_target.target_id, f"repo:{root.resolve().as_posix()}")
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
                        "    \"\"\"Original docstring.\"\"\"\n"
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
                            "    \"\"\"Updated docstring.\"\"\"\n"
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
                    "    \"\"\"Updated docstring.\"\"\"\n"
                    "    enabled: bool = False\n\n"
                    "    def run(self) -> bool:\n"
                    "        return self.enabled\n\n"
                    "# after class\n"
                    "def helper() -> bool:\n"
                    "    return True\n"
                ),
            )

    def test_replace_symbol_source_preserves_nested_method_spacing_comments_and_async_shape(self) -> None:
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
                        "        \"\"\"Return the current value.\"\"\"\n"
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
                            "    \"\"\"Return the latest value.\"\"\"\n"
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
                    "        \"\"\"Return the latest value.\"\"\"\n"
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
                        "class Service:\n"
                        "    def run(self) -> bool:\n"
                        "        return True\n"
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
                    "service.py": (
                        "def run():\n"
                        "    current = 1\n"
                        "    return current\n"
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

            self.assertNotIn("helper = current + 1", (root / "service.py").read_text(encoding="utf-8"))
            self.assertEqual(undo_result.focus_target.target_id, "symbol:service:run")
            self.assertEqual(undo_result.focus_target.level, "flow")
