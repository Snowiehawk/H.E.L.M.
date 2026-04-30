from __future__ import annotations

import ast
from pathlib import Path


PROJECTION_MODULES = (
    "src/helm/ui/projection_context.py",
    "src/helm/ui/graph_projection.py",
    "src/helm/ui/flow_projection.py",
    "src/helm/ui/source_payloads.py",
)


def test_projection_modules_do_not_import_python_adapter() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    for relative_path in PROJECTION_MODULES:
        module_path = repo_root / relative_path
        tree = ast.parse(module_path.read_text(encoding="utf-8"), filename=str(module_path))
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                assert node.module != "helm.ui.python_adapter", relative_path
            if isinstance(node, ast.Import):
                imported_names = {alias.name for alias in node.names}
                assert "helm.ui.python_adapter" not in imported_names, relative_path
