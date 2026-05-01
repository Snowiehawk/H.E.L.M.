"""Recursive operation previews for workspace file mutations."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
from typing import Any

from helm.ui.workspace_file_constants import (
    MAX_AFFECTED_PATHS_SUMMARY,
    RECURSIVE_WARNING_ENTRY_THRESHOLD,
    RECURSIVE_WARNING_SIZE_BYTES,
)
from helm.ui.workspace_file_paths import (
    _is_path_at_or_below,
    _reject_protected_recursive_manifest_paths,
    _reject_protected_workspace_mutation_path,
    _reject_symlinked_directories_in_tree,
    _reject_symlinked_directory_source,
    _resolve_repo_relative_path,
    _validated_repo_directory_path,
    _validated_repo_relative_path,
    _validated_root,
)


def preview_workspace_file_operation(
    root: str | Path,
    *,
    operation: str,
    relative_path: str | None = None,
    source_relative_path: str | None = None,
    target_directory_relative_path: str | None = None,
) -> dict[str, Any]:
    """Return a backend-owned recursive operation preview and fingerprint."""

    root_path = _validated_root(root)
    manifest = _recursive_operation_manifest(
        root_path,
        operation=operation,
        relative_path=relative_path,
        source_relative_path=source_relative_path,
        target_directory_relative_path=target_directory_relative_path,
    )
    return _preview_from_manifest(manifest)


def _recursive_operation_manifest(
    root_path: Path,
    *,
    operation: str,
    relative_path: str | None = None,
    source_relative_path: str | None = None,
    target_directory_relative_path: str | None = None,
) -> dict[str, Any]:
    if operation == "delete":
        source_relative = _validated_repo_relative_path(relative_path or "")
        target_relative: str | None = None
    elif operation == "move":
        source_relative = _validated_repo_relative_path(source_relative_path or "")
        target_directory = _validated_repo_directory_path(target_directory_relative_path or "")
        if target_directory:
            _reject_protected_workspace_mutation_path(target_directory, "move")
        source_name = PurePosixPath(source_relative).name
        target_relative = f"{target_directory}/{source_name}" if target_directory else source_name
        target_relative = _validated_repo_relative_path(target_relative)
    else:
        raise ValueError("Workspace operation preview supports only 'delete' and 'move'.")

    _reject_protected_workspace_mutation_path(source_relative, operation)
    if target_relative is not None:
        _reject_protected_workspace_mutation_path(target_relative, operation)

    source_path = _resolve_repo_relative_path(root_path, source_relative)
    if not source_path.exists():
        raise ValueError(f"Workspace path does not exist: {source_relative}")
    _reject_symlinked_directory_source(root_path, source_relative, operation)

    if operation == "move":
        target_directory_path = (
            root_path
            if not target_directory
            else _resolve_repo_relative_path(root_path, target_directory)
        )
        if not target_directory_path.exists():
            raise ValueError(f"Workspace folder does not exist: {target_directory}")
        if not target_directory_path.is_dir():
            raise ValueError(f"Workspace path is not a folder: {target_directory}")
        if source_path.is_dir() and _is_path_at_or_below(target_directory_path, source_path):
            raise ValueError("Cannot move a folder into itself or one of its descendants.")
        target_path = target_directory_path / source_path.name
        if target_path.exists() and target_path != source_path:
            raise ValueError(f"Workspace path already exists: {target_relative}")

    entry_kind = _workspace_entry_kind(source_path)
    root_entry = _manifest_entry(root_path, source_path, source_relative, "")
    child_entries: list[dict[str, Any]] = []
    if source_path.is_dir():
        _reject_symlinked_directories_in_tree(source_path, source_relative)
        child_entries = [
            _manifest_entry(
                root_path, child, source_relative, child.relative_to(source_path).as_posix()
            )
            for child in sorted(source_path.rglob("*"))
        ]
    _reject_protected_recursive_manifest_paths([root_entry, *child_entries], operation)

    counts = _manifest_counts(source_relative, entry_kind, child_entries)
    return {
        "operation_kind": operation,
        "source_relative_path": source_relative,
        "target_relative_path": target_relative,
        "entry_kind": entry_kind,
        "root": root_entry,
        "children": child_entries,
        "counts": counts,
    }


def _preview_from_manifest(manifest: dict[str, Any]) -> dict[str, Any]:
    fingerprint = _impact_fingerprint(manifest)
    warnings = _preview_warnings(manifest)
    affected_paths = _affected_paths_summary(manifest)
    return {
        "operation_kind": manifest["operation_kind"],
        "source_relative_path": manifest["source_relative_path"],
        "target_relative_path": manifest["target_relative_path"],
        "entry_kind": manifest["entry_kind"],
        "counts": manifest["counts"],
        "warnings": warnings,
        "affected_paths": affected_paths,
        "affected_paths_truncated": len(affected_paths) < manifest["counts"]["entry_count"],
        "impact_fingerprint": fingerprint,
    }


def _impact_fingerprint(manifest: dict[str, Any]) -> str:
    canonical = json.dumps(manifest, sort_keys=True, separators=(",", ":"))
    return f"sha256:{hashlib.sha256(canonical.encode('utf-8')).hexdigest()}"


def _manifest_entry(
    root_path: Path,
    path: Path,
    source_relative_path: str,
    child_relative_path: str,
) -> dict[str, Any]:
    kind = _workspace_entry_kind(path)
    stat = path.lstat() if path.is_symlink() else path.stat()
    entry: dict[str, Any] = {
        "relative_path": path.relative_to(root_path).as_posix(),
        "child_relative_path": child_relative_path,
        "kind": kind,
        "size": stat.st_size,
        "mtime_ns": stat.st_mtime_ns,
        "source_relative_path": source_relative_path,
    }
    if path.is_symlink():
        entry["symlink_target"] = os.readlink(path)
    return entry


def _workspace_entry_kind(path: Path) -> str:
    if path.is_symlink():
        return "symlink_directory" if path.is_dir() else "symlink"
    if path.is_dir():
        return "directory"
    if path.is_file():
        return "file"
    return "other"


def _manifest_counts(
    source_relative_path: str,
    entry_kind: str,
    child_entries: list[dict[str, Any]],
) -> dict[str, int]:
    entries = [{"kind": entry_kind, "size": 0}, *child_entries]
    file_count = sum(1 for entry in entries if entry["kind"] in {"file", "symlink"})
    directory_count = sum(1 for entry in entries if entry["kind"] == "directory")
    symlink_count = sum(1 for entry in entries if str(entry["kind"]).startswith("symlink"))
    total_size = sum(
        int(entry.get("size") or 0) for entry in entries if entry["kind"] != "directory"
    )
    python_file_count = sum(
        1
        for entry in child_entries
        if entry["kind"] in {"file", "symlink"} and str(entry["relative_path"]).endswith(".py")
    )
    if entry_kind in {"file", "symlink"}:
        python_file_count += 1 if source_relative_path.endswith(".py") else 0
    return {
        "entry_count": len(entries),
        "file_count": file_count,
        "directory_count": directory_count,
        "symlink_count": symlink_count,
        "total_size_bytes": total_size,
        "python_file_count": python_file_count,
    }


def _preview_warnings(manifest: dict[str, Any]) -> list[str]:
    counts = manifest["counts"]
    warnings: list[str] = []
    if counts["entry_count"] >= RECURSIVE_WARNING_ENTRY_THRESHOLD:
        warnings.append(f"This touches {counts['entry_count']} filesystem entries.")
    if counts["total_size_bytes"] >= RECURSIVE_WARNING_SIZE_BYTES:
        warnings.append(
            f"This stages about {_format_size(counts['total_size_bytes'])} before applying."
        )
    if counts["symlink_count"]:
        warnings.append("Symlinked files are included and will be preserved where supported.")
    return warnings


def _affected_paths_summary(manifest: dict[str, Any]) -> list[str]:
    source = manifest["source_relative_path"]
    children = [entry["relative_path"] for entry in manifest["children"]]
    affected = [source, *children]
    target = manifest.get("target_relative_path")
    if isinstance(target, str) and target:
        affected.append(target)
        for child in manifest["children"]:
            child_relative = child["child_relative_path"]
            if child_relative:
                affected.append(f"{target}/{child_relative}")
    return sorted(dict.fromkeys(affected))[:MAX_AFFECTED_PATHS_SUMMARY]


def _format_size(size_bytes: int) -> str:
    units = ("bytes", "KiB", "MiB", "GiB")
    value = float(size_bytes)
    for unit in units:
        if value < 1024 or unit == units[-1]:
            return f"{value:.1f} {unit}" if unit != "bytes" else f"{size_bytes} bytes"
        value /= 1024
    return f"{size_bytes} bytes"


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
