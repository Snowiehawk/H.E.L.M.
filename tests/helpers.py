"""Small test helpers for temporary repositories."""

from __future__ import annotations

from pathlib import Path


def write_repo_files(root: Path, files: dict[str, str]) -> None:
    for relative_path, contents in files.items():
        path = root / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(contents.encode("utf-8"))
