"""Listing, reading, and inline text helpers for workspace files."""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

from helm.io_atomic import atomic_write_bytes
from helm.ui.workspace_file_constants import (
    IGNORED_DIRECTORY_NAMES,
    MAX_INLINE_TEXT_BYTES,
    TEXT_PROBE_BYTES,
)
from helm.ui.workspace_file_paths import (
    _resolve_repo_relative_path,
    _validated_repo_relative_path,
    _validated_root,
)


def list_workspace_files(root: str | Path, *, max_entries: int = 5000) -> dict[str, Any]:
    """Return a repo-relative filesystem inventory for the desktop explorer."""

    root_path = _validated_root(root)
    entries: list[dict[str, Any]] = []
    truncated = False

    def visit(directory: Path) -> None:
        nonlocal truncated
        if truncated:
            return

        try:
            children = sorted(
                directory.iterdir(),
                key=lambda path: (not path.is_dir(), path.name.lower(), path.name),
            )
        except OSError:
            return

        for child in children:
            if len(entries) >= max_entries:
                truncated = True
                return
            if child.is_dir() and child.name in IGNORED_DIRECTORY_NAMES:
                continue
            try:
                child.resolve().relative_to(root_path)
                relative_path = child.relative_to(root_path).as_posix()
            except (OSError, ValueError):
                continue
            if child.is_dir():
                entries.append(_directory_entry(child, relative_path))
                visit(child)
                continue
            if child.is_file():
                entries.append(_file_entry(child, relative_path))

    visit(root_path)
    return {
        "root_path": root_path.as_posix(),
        "entries": entries,
        "truncated": truncated,
    }


def read_workspace_file(root: str | Path, relative_path: str) -> dict[str, Any]:
    """Read a repo-relative text file if it is safe for inline editing."""

    root_path = _validated_root(root)
    file_path = _resolve_repo_relative_path(root_path, relative_path)
    if not file_path.exists():
        raise ValueError(f"Workspace file does not exist: {relative_path}")
    if not file_path.is_file():
        raise ValueError(f"Workspace path is not a file: {relative_path}")

    size_bytes = file_path.stat().st_size
    editable, reason = _inline_editability(file_path)
    content = ""
    version = _metadata_version(file_path)
    if editable:
        raw = file_path.read_bytes()
        try:
            content = raw.decode("utf-8")
            version = _content_version(raw)
        except UnicodeDecodeError:
            editable = False
            reason = "Only UTF-8 text files are editable inline."

    return {
        "relative_path": _validated_repo_relative_path(relative_path),
        "name": file_path.name,
        "kind": "file",
        "size_bytes": size_bytes,
        "editable": editable,
        "reason": reason,
        "content": content,
        "version": version,
        "modified_at": file_path.stat().st_mtime,
    }


def _directory_entry(path: Path, relative_path: str) -> dict[str, Any]:
    return {
        "relative_path": relative_path,
        "name": path.name,
        "kind": "directory",
        "size_bytes": None,
        "editable": False,
        "reason": "Directories are shown in the explorer.",
        "modified_at": path.stat().st_mtime,
    }


def _file_entry(path: Path, relative_path: str) -> dict[str, Any]:
    size_bytes = path.stat().st_size
    editable, reason = _inline_editability(path)
    return {
        "relative_path": relative_path,
        "name": path.name,
        "kind": "file",
        "size_bytes": size_bytes,
        "editable": editable,
        "reason": reason,
        "modified_at": path.stat().st_mtime,
    }


def _inline_editability(path: Path) -> tuple[bool, str | None]:
    size_bytes = path.stat().st_size
    if size_bytes > MAX_INLINE_TEXT_BYTES:
        return False, "File is larger than the 2 MiB inline editing limit."

    try:
        probe = path.read_bytes()[:TEXT_PROBE_BYTES]
    except OSError as exc:
        return False, f"Unable to read file: {exc}"

    if b"\x00" in probe:
        return False, "Binary files are not editable inline."

    try:
        probe.decode("utf-8")
    except UnicodeDecodeError:
        return False, "Only UTF-8 text files are editable inline."

    return True, None


def _content_version(raw: bytes) -> str:
    return f"sha256:{hashlib.sha256(raw).hexdigest()}"


def _metadata_version(path: Path) -> str:
    stat = path.stat()
    return f"stat:{stat.st_size}:{stat.st_mtime_ns}"


def _write_workspace_text(path: Path, content: str) -> None:
    atomic_write_bytes(path, content.encode("utf-8"))
