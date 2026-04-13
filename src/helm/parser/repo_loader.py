"""Repository traversal and Python module discovery."""

from __future__ import annotations

import fnmatch
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


@dataclass(frozen=True)
class _GitIgnoreRule:
    base_path: Path
    pattern: str
    negated: bool
    directory_only: bool
    basename_only: bool

    def matches(self, path: Path, *, is_dir: bool) -> bool:
        if self.directory_only and not is_dir:
            return False

        try:
            relative_path = path.relative_to(self.base_path).as_posix()
        except ValueError:
            return False

        if not relative_path or relative_path == ".":
            return False

        if self.basename_only:
            return any(
                fnmatch.fnmatchcase(part, self.pattern)
                for part in relative_path.split("/")
                if part
            )
        return fnmatch.fnmatchcase(relative_path, self.pattern)


def discover_python_modules(root: Path, config: ScanConfig | None = None) -> RepoInventory:
    """Walk a repository and return Python files with stable module identities."""

    scan_config = config or ScanConfig(root=root)
    normalized_root = scan_config.normalized_root()
    if not normalized_root.exists():
        raise ValueError(f"Repository root does not exist: {normalized_root}")
    if not normalized_root.is_dir():
        raise ValueError(f"Repository root is not a directory: {normalized_root}")

    modules: list[ModuleRef] = []
    rules_by_directory: dict[Path, tuple[_GitIgnoreRule, ...]] = {
        normalized_root: _load_gitignore_rules(normalized_root),
    }
    for directory, dirnames, filenames in os.walk(
        normalized_root,
        topdown=True,
        followlinks=scan_config.follow_symlinks,
    ):
        current_directory = Path(directory)
        active_rules = rules_by_directory.get(current_directory, ())
        included_directories: list[str] = []
        for name in sorted(dirnames):
            if name in scan_config.exclude_dirs:
                continue

            child_directory = current_directory / name
            if _is_gitignored(child_directory, is_dir=True, rules=active_rules):
                continue

            child_rules = (*active_rules, *_load_gitignore_rules(child_directory))
            rules_by_directory[child_directory] = child_rules
            included_directories.append(name)
        dirnames[:] = included_directories
        for filename in sorted(filenames):
            path = Path(directory, filename)
            if _is_gitignored(path, is_dir=False, rules=active_rules):
                continue
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


def _load_gitignore_rules(directory: Path) -> tuple[_GitIgnoreRule, ...]:
    gitignore_path = directory / ".gitignore"
    if not gitignore_path.is_file():
        return ()

    rules: list[_GitIgnoreRule] = []
    for raw_line in gitignore_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue

        negated = line.startswith("!")
        if negated:
            line = line[1:].strip()
        if not line:
            continue

        directory_only = line.endswith("/")
        normalized_pattern = line.lstrip("/").rstrip("/")
        if not normalized_pattern:
            continue

        rules.append(
            _GitIgnoreRule(
                base_path=directory,
                pattern=normalized_pattern,
                negated=negated,
                directory_only=directory_only,
                basename_only="/" not in normalized_pattern,
            )
        )

    return tuple(rules)


def _is_gitignored(
    path: Path,
    *,
    is_dir: bool,
    rules: tuple[_GitIgnoreRule, ...],
) -> bool:
    ignored = False
    for rule in rules:
        if rule.matches(path, is_dir=is_dir):
            ignored = not rule.negated
    return ignored
