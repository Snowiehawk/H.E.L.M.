"""Configuration for repository scans."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path


DEFAULT_EXCLUDE_DIRS = (
    ".git",
    ".hg",
    ".mypy_cache",
    ".nox",
    ".pytest_cache",
    ".ruff_cache",
    ".svn",
    ".tox",
    ".venv",
    "__pycache__",
    "build",
    "dist",
    "env",
    "node_modules",
    "venv",
)


@dataclass(frozen=True)
class ScanConfig:
    """Configuration for a single repository ingestion pass."""

    root: Path
    include_suffixes: tuple[str, ...] = (".py",)
    exclude_dirs: tuple[str, ...] = field(default_factory=lambda: DEFAULT_EXCLUDE_DIRS)
    follow_symlinks: bool = False
    max_files: int | None = None

    def normalized_root(self) -> Path:
        return self.root.expanduser().resolve()

    def includes(self, path: Path) -> bool:
        return path.suffix in self.include_suffixes
