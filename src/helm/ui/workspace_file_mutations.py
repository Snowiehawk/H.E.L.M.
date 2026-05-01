"""Create, save, move, and delete operations for desktop workspace files."""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

from helm.ui.workspace_file_listing import (
    _write_workspace_text,
    read_workspace_file,
)
from helm.ui.workspace_file_paths import (
    _is_path_at_or_below,
    _reject_protected_workspace_mutation_path,
    _reject_symlinked_directory_source,
    _resolve_repo_relative_path,
    _validated_repo_directory_path,
    _validated_repo_relative_path,
    _validated_root,
)
from helm.ui.workspace_file_previews import (
    _delete_changed_relative_paths,
    _move_changed_relative_paths,
    _preview_from_manifest,
    _recursive_operation_manifest,
)
from helm.ui.workspace_file_transactions import JournalPreimage, _run_workspace_mutation


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
