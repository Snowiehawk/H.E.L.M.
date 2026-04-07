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
