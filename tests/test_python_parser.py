from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from helm.parser import PythonModuleParser, discover_python_modules
from tests.helpers import write_repo_files


class PythonParserTests(unittest.TestCase):
    def test_extracts_symbols_imports_and_calls(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            write_repo_files(
                root,
                {
                    "service.py": (
                        "from helpers import helper\n"
                        "import utils\n\n"
                        "class Service:\n"
                        "    def run(self):\n"
                        "        helper()\n"
                        "        utils.format_value()\n"
                        "        self._private()\n\n"
                        "    def _private(self):\n"
                        "        return helper()\n\n"
                        "def top():\n"
                        "    return helper()\n"
                    ),
                },
            )

            module = discover_python_modules(root).modules[0]
            parsed = PythonModuleParser().parse_module(module)

            qualnames = {symbol.qualname: symbol.kind.value for symbol in parsed.symbols}
            self.assertEqual(
                qualnames,
                {
                    "Service": "class",
                    "Service.run": "method",
                    "Service._private": "method",
                    "top": "function",
                },
            )
            self.assertEqual({item.local_name for item in parsed.imports}, {"helper", "utils"})
            call_map = {call.callee_expr: (call.root_name, call.attribute_path) for call in parsed.calls}
            self.assertIn("helper", call_map)
            self.assertIn("utils.format_value", call_map)
            self.assertEqual(call_map["self._private"], ("self", ("_private",)))

    def test_reports_syntax_errors_without_crashing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            write_repo_files(root, {"broken.py": "def bad(:\n    pass\n"})

            module = discover_python_modules(root).modules[0]
            parsed = PythonModuleParser().parse_module(module)

            self.assertEqual(len(parsed.diagnostics), 1)
            self.assertEqual(parsed.diagnostics[0].code, "syntax_error")
            self.assertEqual(parsed.symbols, ())

    def test_extracts_top_level_enums_and_variables_without_locals_or_attributes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            write_repo_files(
                root,
                {
                    "service.py": (
                        "import enum\n"
                        "from helpers import helper\n\n"
                        "READY = helper()\n"
                        "LIMIT: int = 3\n\n"
                        "class Mode(enum.IntFlag):\n"
                        "    FAST = 1\n\n"
                        "class Service:\n"
                        "    enabled = True\n\n"
                        "    def run(self):\n"
                        "        local_value = READY\n"
                        "        return local_value\n"
                    ),
                },
            )

            module = discover_python_modules(root).modules[0]
            parsed = PythonModuleParser().parse_module(module)

            qualnames = {symbol.qualname: symbol.kind.value for symbol in parsed.symbols}
            self.assertEqual(
                qualnames,
                {
                    "READY": "variable",
                    "LIMIT": "variable",
                    "Mode": "enum",
                    "Service": "class",
                    "Service.run": "method",
                },
            )
            self.assertNotIn("Service.enabled", qualnames)
            self.assertNotIn("local_value", qualnames)
