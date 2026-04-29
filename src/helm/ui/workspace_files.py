"""Repo-scoped filesystem helpers for the desktop workspace."""

from __future__ import annotations

import json
import hashlib
import os
import shutil
from pathlib import Path, PurePosixPath
from typing import Any, Callable

from helm.editor.models import BackendUndoTransaction
from helm.io_atomic import atomic_write_bytes
from helm.recovery import (
    JournalPreimage,
    RepoMutationJournal,
    recover_pending,
    repo_mutation_lock,
)
from helm.workspace_undo import create_workspace_undo_snapshot, discard_workspace_undo_snapshot

MAX_INLINE_TEXT_BYTES = 2 * 1024 * 1024
TEXT_PROBE_BYTES = 8192
IGNORED_DIRECTORY_NAMES = {
    ".cache",
    ".git",
    ".hg",
    ".helm",
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
VCS_CONTROL_DIRECTORY_NAMES = {".git", ".hg", ".svn"}
PROTECTED_WORKSPACE_DIRECTORY_NAMES = {*VCS_CONTROL_DIRECTORY_NAMES, ".helm"}
RECURSIVE_WARNING_ENTRY_THRESHOLD = 500
RECURSIVE_WARNING_SIZE_BYTES = 50 * 1024 * 1024
MAX_AFFECTED_PATHS_SUMMARY = 40


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


def create_workspace_entry(
    root: str | Path,
    *,
    kind: str,
    relative_path: str,
    content: str | None = None,
    session_id: str = "direct",
) -> dict[str, Any]:
    """Create a repo-relative file or directory."""

    root_path = _validated_root(root)
    normalized_relative_path = _validated_repo_relative_path(relative_path)
    _reject_protected_workspace_mutation_path(normalized_relative_path, "create")
    target_path = _resolve_repo_relative_path(root_path, normalized_relative_path)
    if target_path.exists():
        raise ValueError(f"Workspace path already exists: {normalized_relative_path}")

    if kind == "directory":
        return _run_workspace_mutation(
            root_path,
            session_id=session_id,
            journal_kind="workspace.create.directory",
            undo_kind="workspace.create",
            undo_summary=f"Created folder {normalized_relative_path}.",
            undo_snapshot_paths=(normalized_relative_path,),
            changed_relative_paths=(normalized_relative_path,),
            preimages=(
                JournalPreimage(
                    normalized_relative_path,
                    role="create",
                    metadata={"entry_kind": "directory"},
                ),
            ),
            mutation=lambda: _create_workspace_directory(
                target_path,
                normalized_relative_path,
            ),
        )

    if kind != "file":
        raise ValueError("Workspace entry kind must be 'file' or 'directory'.")

    return _run_workspace_mutation(
        root_path,
        session_id=session_id,
        journal_kind="workspace.create.file",
        undo_kind="workspace.create",
        undo_summary=f"Created file {normalized_relative_path}.",
        undo_snapshot_paths=(normalized_relative_path,),
        changed_relative_paths=(normalized_relative_path,),
        preimages=(
            JournalPreimage(
                normalized_relative_path,
                role="create",
                metadata={"entry_kind": "file"},
            ),
        ),
        mutation=lambda: _create_workspace_file(
            root_path,
            target_path,
            normalized_relative_path,
            content or "",
        ),
    )


def _create_workspace_directory(target_path: Path, normalized_relative_path: str) -> dict[str, Any]:
    target_path.mkdir(parents=True, exist_ok=False)
    return {
        "relative_path": normalized_relative_path,
        "kind": "directory",
        "changed_relative_paths": [normalized_relative_path],
        "file": None,
    }


def _create_workspace_file(
    root_path: Path,
    target_path: Path,
    normalized_relative_path: str,
    content: str,
) -> dict[str, Any]:
    target_path.parent.mkdir(parents=True, exist_ok=True)
    _write_workspace_text(target_path, content)
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
    session_id: str = "direct",
) -> dict[str, Any]:
    """Save a repo-relative text file, refusing stale writes."""

    root_path = _validated_root(root)
    normalized_relative_path = _validated_repo_relative_path(relative_path)
    _reject_protected_workspace_mutation_path(normalized_relative_path, "save")
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

    return _run_workspace_mutation(
        root_path,
        session_id=session_id,
        journal_kind="workspace.save.file",
        undo_kind="workspace.save",
        undo_summary=f"Saved {normalized_relative_path}.",
        undo_snapshot_paths=(normalized_relative_path,),
        changed_relative_paths=(normalized_relative_path,),
        preimages=(
            JournalPreimage(
                normalized_relative_path,
                role="save",
                metadata={"version": current["version"]},
            ),
        ),
        mutation=lambda: _save_workspace_file(
            root_path,
            file_path,
            normalized_relative_path,
            content,
        ),
    )


def _save_workspace_file(
    root_path: Path,
    file_path: Path,
    normalized_relative_path: str,
    content: str,
) -> dict[str, Any]:
    _write_workspace_text(file_path, content)
    return {
        "relative_path": normalized_relative_path,
        "kind": "file",
        "changed_relative_paths": [normalized_relative_path],
        "file": read_workspace_file(root_path, normalized_relative_path),
    }


def _write_workspace_text(path: Path, content: str) -> None:
    atomic_write_bytes(path, content.encode("utf-8"))


def move_workspace_entry(
    root: str | Path,
    *,
    source_relative_path: str,
    target_directory_relative_path: str,
    expected_impact_fingerprint: str | None = None,
    session_id: str = "direct",
) -> dict[str, Any]:
    """Move a repo-relative file or directory into a repo-relative directory."""

    root_path = _validated_root(root)
    normalized_source_relative_path = _validated_repo_relative_path(source_relative_path)
    _reject_protected_workspace_mutation_path(normalized_source_relative_path, "move")
    source_path = _resolve_repo_relative_path(root_path, normalized_source_relative_path)
    if not source_path.exists():
        raise ValueError(f"Workspace path does not exist: {normalized_source_relative_path}")
    _reject_symlinked_directory_source(
        root_path,
        normalized_source_relative_path,
        "move",
    )

    normalized_target_directory = _validated_repo_directory_path(target_directory_relative_path)
    if normalized_target_directory:
        _reject_protected_workspace_mutation_path(normalized_target_directory, "move")
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
    _reject_protected_workspace_mutation_path(normalized_target_relative_path, "move")

    kind = "directory" if source_path.is_dir() else "file"
    changed_relative_paths = _move_changed_relative_paths(
        source_path,
        normalized_source_relative_path,
        normalized_target_relative_path,
    )

    def verify_directory_preview() -> None:
        if kind != "directory":
            return
        if not expected_impact_fingerprint:
            raise ValueError("Recursive workspace moves require an expected impact fingerprint.")
        preview = _preview_from_manifest(
            _recursive_operation_manifest(
                root_path,
                operation="move",
                source_relative_path=normalized_source_relative_path,
                target_directory_relative_path=normalized_target_directory,
            )
        )
        if preview["impact_fingerprint"] != expected_impact_fingerprint:
            raise ValueError(
                "Workspace move preview is stale. Review the folder impact again before applying."
            )

    return _run_workspace_mutation(
        root_path,
        session_id=session_id,
        journal_kind="workspace.move.entry",
        undo_kind="workspace.move",
        undo_summary=(
            f"Moved folder {normalized_source_relative_path} to {normalized_target_relative_path}."
            if kind == "directory"
            else f"Moved file {normalized_source_relative_path} to {normalized_target_relative_path}."
        ),
        undo_snapshot_paths=(normalized_source_relative_path, normalized_target_relative_path),
        changed_relative_paths=tuple(changed_relative_paths),
        preimages=(
            JournalPreimage(
                normalized_source_relative_path,
                role="move-source",
                metadata={"entry_kind": kind},
            ),
            JournalPreimage(
                normalized_target_relative_path,
                role="move-destination",
                metadata={"entry_kind": kind, "expected": "missing"},
            ),
        ),
        mutation=lambda: _move_workspace_entry(
            root_path,
            source_path,
            target_path,
            normalized_target_relative_path,
            kind,
            changed_relative_paths,
        ),
        preflight=verify_directory_preview,
    )


def _move_workspace_entry(
    root_path: Path,
    source_path: Path,
    target_path: Path,
    normalized_target_relative_path: str,
    kind: str,
    changed_relative_paths: list[str],
) -> dict[str, Any]:
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
    expected_impact_fingerprint: str | None = None,
    session_id: str = "direct",
) -> dict[str, Any]:
    """Delete a repo-relative file or directory."""

    root_path = _validated_root(root)
    normalized_relative_path = _validated_repo_relative_path(relative_path)
    _reject_protected_workspace_mutation_path(normalized_relative_path, "delete")
    target_path = _resolve_repo_relative_path(root_path, normalized_relative_path)
    if not target_path.exists():
        raise ValueError(f"Workspace path does not exist: {normalized_relative_path}")
    _reject_symlinked_directory_source(root_path, normalized_relative_path, "delete")

    kind = "directory" if target_path.is_dir() else "file"
    changed_relative_paths = _delete_changed_relative_paths(
        target_path,
        normalized_relative_path,
    )

    def verify_directory_preview() -> None:
        if kind != "directory":
            return
        if not expected_impact_fingerprint:
            raise ValueError("Recursive workspace deletes require an expected impact fingerprint.")
        preview = _preview_from_manifest(
            _recursive_operation_manifest(
                root_path,
                operation="delete",
                relative_path=normalized_relative_path,
            )
        )
        if preview["impact_fingerprint"] != expected_impact_fingerprint:
            raise ValueError(
                "Workspace delete preview is stale. Review the folder impact again before applying."
            )

    return _run_workspace_mutation(
        root_path,
        session_id=session_id,
        journal_kind="workspace.delete.entry",
        undo_kind="workspace.delete",
        undo_summary=(
            f"Deleted folder {normalized_relative_path}."
            if kind == "directory"
            else f"Deleted file {normalized_relative_path}."
        ),
        undo_snapshot_paths=(normalized_relative_path,),
        changed_relative_paths=tuple(changed_relative_paths),
        preimages=(
            JournalPreimage(
                normalized_relative_path,
                role="delete-target",
                metadata={"entry_kind": kind},
            ),
        ),
        mutation=lambda: _delete_workspace_entry(
            target_path,
            normalized_relative_path,
            kind,
            changed_relative_paths,
        ),
        preflight=verify_directory_preview,
    )


def _delete_workspace_entry(
    target_path: Path,
    normalized_relative_path: str,
    kind: str,
    changed_relative_paths: list[str],
) -> dict[str, Any]:
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


def _run_workspace_mutation(
    root_path: Path,
    *,
    session_id: str,
    journal_kind: str,
    undo_kind: str,
    undo_summary: str,
    undo_snapshot_paths: tuple[str, ...],
    changed_relative_paths: tuple[str, ...],
    preimages: tuple[JournalPreimage, ...],
    mutation: Callable[[], dict[str, Any]],
    preflight: Callable[[], None] | None = None,
) -> dict[str, Any]:
    with repo_mutation_lock(root_path):
        recovery_events = recover_pending(root_path)
        if preflight is not None:
            preflight()

        undo_snapshot = create_workspace_undo_snapshot(
            root_path,
            session_id=session_id,
            kind=undo_kind,
            summary=undo_summary,
            touched_relative_paths=changed_relative_paths,
            snapshot_relative_paths=undo_snapshot_paths,
        )
        try:
            operation = RepoMutationJournal(root_path).prepare(
                kind=journal_kind,
                preimages=preimages,
            )
            result = operation.apply(mutation)
        except Exception:
            discard_workspace_undo_snapshot(root_path, undo_snapshot.token)
            raise

        result["recovery_events"] = [event.to_dict() for event in recovery_events]
        result["undo_transaction"] = BackendUndoTransaction(
            summary=undo_snapshot.summary,
            request_kind=undo_snapshot.kind,
            snapshot_token=undo_snapshot.token,
            touched_relative_paths=undo_snapshot.touched_relative_paths,
        ).to_dict()
        return result


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


def _validated_root(root: str | Path) -> Path:
    root_path = Path(root).resolve()
    if not root_path.exists():
        raise ValueError(f"Repository root does not exist: {root_path}")
    if not root_path.is_dir():
        raise ValueError(f"Repository root is not a directory: {root_path}")
    return root_path


def _validated_repo_relative_path(relative_path: str) -> str:
    raw = relative_path.strip().replace("\\", "/")
    if not raw or raw == ".":
        raise ValueError("Repo-relative path cannot be empty.")
    if "//" in raw:
        raise ValueError("Repo-relative paths must not contain empty segments.")

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


def _reject_protected_workspace_mutation_path(relative_path: str, operation: str) -> None:
    normalized = _validated_repo_relative_path(relative_path)
    parts = PurePosixPath(normalized).parts
    if not parts:
        raise ValueError(f"Cannot {operation} the repository root.")
    if parts[0] in PROTECTED_WORKSPACE_DIRECTORY_NAMES:
        raise ValueError(
            f"Cannot {operation} protected workspace metadata or VCS directory '{parts[0]}'."
        )
    if any(
        parts[index] == ".helm" and index + 1 < len(parts) and parts[index + 1] == "recovery"
        for index in range(len(parts))
    ):
        raise ValueError("Cannot mutate HELM recovery storage from workspace operations.")


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


def _reject_symlinked_directory_source(
    root_path: Path,
    relative_path: str,
    operation: str,
) -> None:
    lexical_path = root_path / _validated_repo_relative_path(relative_path)
    if lexical_path.is_symlink() and lexical_path.is_dir():
        raise ValueError(
            f"Cannot {operation} symlinked workspace folders until safe recovery is supported."
        )


def _reject_symlinked_directories_in_tree(path: Path, relative_path: str) -> None:
    for child in path.rglob("*"):
        if child.is_symlink() and child.is_dir():
            child_relative = child.relative_to(path).as_posix()
            raise ValueError(
                "Destructive symlinked directory operations are not supported: "
                f"{relative_path}/{child_relative}"
            )


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
