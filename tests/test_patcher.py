from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from helm.editor import apply_structural_edit, serialize_edit_request
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
