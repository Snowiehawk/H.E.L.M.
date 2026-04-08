from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from helm.parser.repo_loader import discover_python_modules
from tests.helpers import write_repo_files


class RepoLoaderTests(unittest.TestCase):
    def test_discovers_python_modules_and_excludes_common_dirs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            write_repo_files(
                root,
                {
                    "pkg/__init__.py": "",
                    "pkg/service.py": "",
                    "tools/run.py": "",
                    ".git/ignored.py": "",
                    ".vendor/libcst/runtime.py": "",
                    ".venv/site.py": "",
                    "pkg/__pycache__/skip.py": "",
                    "README.md": "not python",
                },
            )

            inventory = discover_python_modules(root)
            module_names = [module.module_name for module in inventory.modules]
            relative_paths = [module.relative_path for module in inventory.modules]

            self.assertEqual(module_names, ["pkg", "pkg.service", "tools.run"])
            self.assertEqual(relative_paths, ["pkg/__init__.py", "pkg/service.py", "tools/run.py"])
            self.assertTrue(inventory.modules[0].is_package)

    def test_handles_root_package_init(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            write_repo_files(root, {"__init__.py": ""})

            inventory = discover_python_modules(root)

            self.assertEqual(len(inventory.modules), 1)
            self.assertEqual(inventory.modules[0].module_name, "__init__")
            self.assertTrue(inventory.modules[0].is_package)

    def test_respects_root_gitignore_for_module_discovery(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            write_repo_files(
                root,
                {
                    ".gitignore": "generated/\n*.tmp.py\n",
                    "app.py": "",
                    "generated/skip.py": "",
                    "scratch.tmp.py": "",
                },
            )

            inventory = discover_python_modules(root)

            self.assertEqual([module.relative_path for module in inventory.modules], ["app.py"])

    def test_respects_nested_gitignore_scopes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            write_repo_files(
                root,
                {
                    "pkg/.gitignore": "generated/\n",
                    "pkg/service.py": "",
                    "pkg/generated/skip.py": "",
                    "other/generated/keep.py": "",
                },
            )

            inventory = discover_python_modules(root)

            self.assertEqual(
                [module.relative_path for module in inventory.modules],
                ["other/generated/keep.py", "pkg/service.py"],
            )
