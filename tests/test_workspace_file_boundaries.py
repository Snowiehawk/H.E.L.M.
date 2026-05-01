from __future__ import annotations

import ast
from pathlib import Path


WORKSPACE_FILE_MODULES = {
    "helm.ui.workspace_file_constants": "src/helm/ui/workspace_file_constants.py",
    "helm.ui.workspace_file_paths": "src/helm/ui/workspace_file_paths.py",
    "helm.ui.workspace_file_listing": "src/helm/ui/workspace_file_listing.py",
    "helm.ui.workspace_file_previews": "src/helm/ui/workspace_file_previews.py",
    "helm.ui.workspace_file_transactions": "src/helm/ui/workspace_file_transactions.py",
    "helm.ui.workspace_file_mutations": "src/helm/ui/workspace_file_mutations.py",
}

ALLOWED_WORKSPACE_FILE_IMPORTS = {
    "helm.ui.workspace_file_constants": set(),
    "helm.ui.workspace_file_paths": {"helm.ui.workspace_file_constants"},
    "helm.ui.workspace_file_listing": {
        "helm.ui.workspace_file_constants",
        "helm.ui.workspace_file_paths",
    },
    "helm.ui.workspace_file_previews": {
        "helm.ui.workspace_file_constants",
        "helm.ui.workspace_file_paths",
    },
    "helm.ui.workspace_file_transactions": set(),
    "helm.ui.workspace_file_mutations": {
        "helm.ui.workspace_file_listing",
        "helm.ui.workspace_file_paths",
        "helm.ui.workspace_file_previews",
        "helm.ui.workspace_file_transactions",
    },
}


def _imported_modules(tree: ast.AST) -> set[str]:
    modules: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            modules.add(node.module)
        elif isinstance(node, ast.Import):
            modules.update(alias.name for alias in node.names)
    return modules


def test_workspace_file_extractions_do_not_import_facade_or_wrong_siblings() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    for module_name, relative_path in WORKSPACE_FILE_MODULES.items():
        module_path = repo_root / relative_path
        tree = ast.parse(module_path.read_text(encoding="utf-8"), filename=str(module_path))
        imports = _imported_modules(tree)

        assert "helm.ui.workspace_files" not in imports, module_name

        imported_workspace_file_modules = {
            imported for imported in imports if imported in WORKSPACE_FILE_MODULES
        }
        assert imported_workspace_file_modules <= ALLOWED_WORKSPACE_FILE_IMPORTS[module_name]

        if module_name == "helm.ui.workspace_file_constants":
            assert not {imported for imported in imports if imported.startswith("helm.")}
