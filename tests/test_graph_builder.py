from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from helm.graph import EdgeKind, build_repo_graph
from helm.parser import PythonModuleParser, discover_python_modules
from tests.helpers import write_repo_files


class GraphBuilderTests(unittest.TestCase):
    def test_builds_import_and_call_edges_for_internal_symbols(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            write_repo_files(
                root,
                {
                    "helpers.py": "def helper():\n    return 'ok'\n",
                    "utils.py": "def format_value():\n    return 'fmt'\n",
                    "service.py": (
                        "from helpers import helper\n"
                        "import utils\n\n"
                        "class Service:\n"
                        "    def run(self):\n"
                        "        helper()\n"
                        "        utils.format_value()\n"
                        "        self._local()\n\n"
                        "    def _local(self):\n"
                        "        return helper()\n"
                    ),
                },
            )

            inventory = discover_python_modules(root)
            parsed_modules = [PythonModuleParser().parse_module(module) for module in inventory.modules]
            graph = build_repo_graph(root, parsed_modules)

            self.assertEqual(graph.report.module_count, 3)
            self.assertEqual(graph.report.unresolved_call_count, 0)

            import_targets = {
                edge.target_id for edge in graph.edges if edge.kind == EdgeKind.IMPORTS
            }
            self.assertIn("module:helpers", import_targets)
            self.assertIn("module:utils", import_targets)

            call_targets = {
                edge.target_id: edge.metadata["confidence"]
                for edge in graph.edges
                if edge.kind == EdgeKind.CALLS
            }
            self.assertIn("symbol:helpers:helper", call_targets)
            self.assertIn("symbol:utils:format_value", call_targets)
            self.assertIn("symbol:service:Service._local", call_targets)
            self.assertEqual(call_targets["symbol:helpers:helper"], "high")

    def test_tracks_unresolved_external_calls(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            write_repo_files(
                root,
                {
                    "service.py": (
                        "import requests\n\n"
                        "def run():\n"
                        "    requests.get()\n"
                    ),
                },
            )

            inventory = discover_python_modules(root)
            parsed_modules = [PythonModuleParser().parse_module(module) for module in inventory.modules]
            graph = build_repo_graph(root, parsed_modules)

            self.assertEqual(graph.report.unresolved_call_count, 1)
            self.assertIn("module:requests", graph.nodes)
            self.assertEqual(graph.nodes["module:requests"].is_external, True)
