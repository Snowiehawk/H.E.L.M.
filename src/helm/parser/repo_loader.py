"""Repository traversal and Python module discovery."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from helm.config import ScanConfig
from helm.parser.symbols import ModuleRef, make_module_id


@dataclass(frozen=True)
class RepoInventory:
    root_path: str
    modules: tuple[ModuleRef, ...] = field(default_factory=tuple)

    def to_dict(self) -> dict[str, object]:
        return {
            "root_path": self.root_path,
            "modules": [module.to_dict() for module in self.modules],
        }


def discover_python_modules(root: Path, config: ScanConfig | None = None) -> RepoInventory:
    """Walk a repository and return Python files with stable module identities."""

    scan_config = config or ScanConfig(root=root)
    normalized_root = scan_config.normalized_root()
    if not normalized_root.exists():
        raise ValueError(f"Repository root does not exist: {normalized_root}")
    if not normalized_root.is_dir():
        raise ValueError(f"Repository root is not a directory: {normalized_root}")

    modules: list[ModuleRef] = []
    for directory, dirnames, filenames in os.walk(
        normalized_root,
        topdown=True,
        followlinks=scan_config.follow_symlinks,
    ):
        dirnames[:] = sorted(
            name for name in dirnames if name not in scan_config.exclude_dirs
        )
        for filename in sorted(filenames):
            path = Path(directory, filename)
            if not scan_config.includes(path):
                continue
            relative_path = path.relative_to(normalized_root)
            module_name, is_package = _module_name_from_relative_path(relative_path)
            modules.append(
                ModuleRef(
                    module_id=make_module_id(module_name),
                    module_name=module_name,
                    file_path=str(path.resolve()),
                    relative_path=relative_path.as_posix(),
                    is_package=is_package,
                )
            )
            if scan_config.max_files is not None and len(modules) >= scan_config.max_files:
                return RepoInventory(
                    root_path=str(normalized_root),
                    modules=tuple(sorted(modules, key=lambda item: item.relative_path)),
                )

    return RepoInventory(
        root_path=str(normalized_root),
        modules=tuple(sorted(modules, key=lambda item: item.relative_path)),
    )


def _module_name_from_relative_path(relative_path: Path) -> tuple[str, bool]:
    without_suffix = relative_path.with_suffix("")
    parts = list(without_suffix.parts)
    if not parts:
        raise ValueError("Expected a non-empty relative path for module discovery.")

    if parts[-1] == "__init__":
        package_parts = parts[:-1]
        module_name = ".".join(package_parts) if package_parts else "__init__"
        return module_name, True

    return ".".join(parts), False
