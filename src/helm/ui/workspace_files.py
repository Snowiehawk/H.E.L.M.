"""Repo-scoped filesystem helpers for the desktop workspace."""

from __future__ import annotations

import hashlib
import shutil
from pathlib import Path, PurePosixPath
from typing import Any

MAX_INLINE_TEXT_BYTES = 2 * 1024 * 1024
TEXT_PROBE_BYTES = 8192
IGNORED_DIRECTORY_NAMES = {
    ".cache",
    ".git",
    ".hg",
    ".mypy_cache",
    ".nox",
    ".next",
    ".parcel-cache",
    ".pytest_cache",
    ".ruff_cache",
    ".svn",
    ".turbo",
    ".vendor",
    ".tox",
    ".venv",
    "__pycache__",
    "build",
    "coverage",
    "dist",
    "env",
    "node_modules",
    "vendor",
    "venv",
}


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


def create_workspace_entry(
    root: str | Path,
    *,
    kind: str,
    relative_path: str,
    content: str | None = None,
) -> dict[str, Any]:
    """Create a repo-relative file or directory."""

    root_path = _validated_root(root)
    normalized_relative_path = _validated_repo_relative_path(relative_path)
    target_path = _resolve_repo_relative_path(root_path, normalized_relative_path)
    if target_path.exists():
        raise ValueError(f"Workspace path already exists: {normalized_relative_path}")

    if kind == "directory":
        target_path.mkdir(parents=True, exist_ok=False)
        return {
            "relative_path": normalized_relative_path,
            "kind": "directory",
            "changed_relative_paths": [normalized_relative_path],
            "file": None,
        }

    if kind != "file":
        raise ValueError("Workspace entry kind must be 'file' or 'directory'.")

    target_path.parent.mkdir(parents=True, exist_ok=True)
    _write_workspace_text(target_path, content or "")
    return {
        "relative_path": normalized_relative_path,
        "kind": "file",
        "changed_relative_paths": [normalized_relative_path],
        "file": read_workspace_file(root_path, normalized_relative_path),
    }


def save_workspace_file(
    root: str | Path,
    *,
    relative_path: str,
    content: str,
    expected_version: str,
) -> dict[str, Any]:
    """Save a repo-relative text file, refusing stale writes."""

    root_path = _validated_root(root)
    normalized_relative_path = _validated_repo_relative_path(relative_path)
    file_path = _resolve_repo_relative_path(root_path, normalized_relative_path)
    if not file_path.exists():
        raise ValueError(f"Workspace file does not exist: {normalized_relative_path}")
    if not file_path.is_file():
        raise ValueError(f"Workspace path is not a file: {normalized_relative_path}")

    current = read_workspace_file(root_path, normalized_relative_path)
    if not current["editable"]:
        raise ValueError(current["reason"] or "Workspace file is not editable inline.")
    if current["version"] != expected_version:
        raise ValueError("Workspace file changed on disk. Reload it before saving again.")

    _write_workspace_text(file_path, content)
    return {
        "relative_path": normalized_relative_path,
        "kind": "file",
        "changed_relative_paths": [normalized_relative_path],
        "file": read_workspace_file(root_path, normalized_relative_path),
    }


def _write_workspace_text(path: Path, content: str) -> None:
    path.write_bytes(content.encode("utf-8"))


def move_workspace_entry(
    root: str | Path,
    *,
    source_relative_path: str,
    target_directory_relative_path: str,
) -> dict[str, Any]:
    """Move a repo-relative file or directory into a repo-relative directory."""

    root_path = _validated_root(root)
    normalized_source_relative_path = _validated_repo_relative_path(source_relative_path)
    source_path = _resolve_repo_relative_path(root_path, normalized_source_relative_path)
    if not source_path.exists():
        raise ValueError(f"Workspace path does not exist: {normalized_source_relative_path}")

    normalized_target_directory = _validated_repo_directory_path(target_directory_relative_path)
    target_directory_path = (
        root_path
        if not normalized_target_directory
        else _resolve_repo_relative_path(
            root_path,
            normalized_target_directory,
        )
    )
    if not target_directory_path.exists():
        raise ValueError(f"Workspace folder does not exist: {normalized_target_directory}")
    if not target_directory_path.is_dir():
        raise ValueError(f"Workspace path is not a folder: {normalized_target_directory}")

    if source_path.is_dir() and _is_path_at_or_below(target_directory_path, source_path):
        raise ValueError("Cannot move a folder into itself or one of its descendants.")

    target_path = target_directory_path / source_path.name
    normalized_target_relative_path = target_path.relative_to(root_path).as_posix()
    if source_path == target_path:
        kind = "directory" if source_path.is_dir() else "file"
        return {
            "relative_path": normalized_target_relative_path,
            "kind": kind,
            "changed_relative_paths": [],
            "file": read_workspace_file(root_path, normalized_target_relative_path)
            if kind == "file"
            else None,
        }
    if target_path.exists():
        raise ValueError(f"Workspace path already exists: {normalized_target_relative_path}")

    kind = "directory" if source_path.is_dir() else "file"
    changed_relative_paths = _move_changed_relative_paths(
        source_path,
        normalized_source_relative_path,
        normalized_target_relative_path,
    )
    source_path.rename(target_path)
    return {
        "relative_path": normalized_target_relative_path,
        "kind": kind,
        "changed_relative_paths": changed_relative_paths,
        "file": read_workspace_file(root_path, normalized_target_relative_path)
        if kind == "file"
        else None,
    }


def delete_workspace_entry(
    root: str | Path,
    *,
    relative_path: str,
) -> dict[str, Any]:
    """Delete a repo-relative file or directory."""

    root_path = _validated_root(root)
    normalized_relative_path = _validated_repo_relative_path(relative_path)
    target_path = _resolve_repo_relative_path(root_path, normalized_relative_path)
    if not target_path.exists():
        raise ValueError(f"Workspace path does not exist: {normalized_relative_path}")

    kind = "directory" if target_path.is_dir() else "file"
    changed_relative_paths = _delete_changed_relative_paths(
        target_path,
        normalized_relative_path,
    )
    if target_path.is_dir():
        shutil.rmtree(target_path)
    elif target_path.is_file():
        target_path.unlink()
    else:
        raise ValueError(f"Workspace path is not a file or folder: {normalized_relative_path}")

    return {
        "relative_path": normalized_relative_path,
        "kind": kind,
        "changed_relative_paths": changed_relative_paths,
        "file": None,
    }


def _validated_root(root: str | Path) -> Path:
    root_path = Path(root).resolve()
    if not root_path.exists():
        raise ValueError(f"Repository root does not exist: {root_path}")
    if not root_path.is_dir():
        raise ValueError(f"Repository root is not a directory: {root_path}")
    return root_path


def _validated_repo_relative_path(relative_path: str) -> str:
    raw = relative_path.strip().replace("\\", "/")
    if not raw:
        raise ValueError("Repo-relative path cannot be empty.")

    path = PurePosixPath(raw)
    if path.is_absolute():
        raise ValueError("Repo-relative paths must be relative to the repo root.")
    if any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError("Repo-relative paths must not contain empty, '.', or '..' segments.")
    return path.as_posix()


def _validated_repo_directory_path(relative_path: str) -> str:
    raw = relative_path.strip().replace("\\", "/")
    if not raw:
        return ""
    return _validated_repo_relative_path(raw)


def _resolve_repo_relative_path(root_path: Path, relative_path: str) -> Path:
    normalized_relative_path = _validated_repo_relative_path(relative_path)
    source_path = (root_path / normalized_relative_path).resolve()
    try:
        source_path.relative_to(root_path)
    except ValueError as exc:
        raise ValueError(
            f"Repo-relative path '{normalized_relative_path}' escapes the repo root."
        ) from exc
    return source_path


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


def _move_changed_relative_paths(
    source_path: Path,
    source_relative_path: str,
    target_relative_path: str,
) -> list[str]:
    changed = [source_relative_path, target_relative_path]
    if not source_path.is_dir():
        return changed

    for child in sorted(source_path.rglob("*")):
        try:
            child_relative_path = child.relative_to(source_path).as_posix()
        except ValueError:
            continue
        changed.append(f"{source_relative_path}/{child_relative_path}")
        changed.append(f"{target_relative_path}/{child_relative_path}")
    return changed


def _delete_changed_relative_paths(
    target_path: Path,
    relative_path: str,
) -> list[str]:
    changed = [relative_path]
    if not target_path.is_dir():
        return changed

    for child in sorted(target_path.rglob("*")):
        try:
            child_relative_path = child.relative_to(target_path).as_posix()
        except ValueError:
            continue
        changed.append(f"{relative_path}/{child_relative_path}")
    return changed


def _is_path_at_or_below(path: Path, ancestor: Path) -> bool:
    try:
        path.relative_to(ancestor)
    except ValueError:
        return False
    return True


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
