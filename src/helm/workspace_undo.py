"""Repo-local undo snapshots for workspace file operations."""

from __future__ import annotations

import json
import os
import shutil
import time
import uuid
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

from helm.io_atomic import atomic_write_bytes, atomic_write_text
from helm.recovery import RECOVERY_RELATIVE_PATH, ensure_recovery_storage

UNDO_RELATIVE_PATH = f"{RECOVERY_RELATIVE_PATH}/undo"
UNDO_TOKEN_TTL_SECONDS = 24 * 60 * 60
_UNDO_VERSION = 1


@dataclass(frozen=True)
class WorkspaceUndoSnapshot:
    token: str
    session_id: str
    operation_id: str
    kind: str
    summary: str
    touched_relative_paths: tuple[str, ...]
    snapshot_relative_paths: tuple[str, ...]
    snapshot_manifest: tuple[dict[str, Any], ...]

    def to_record(self) -> dict[str, Any]:
        return {
            "version": _UNDO_VERSION,
            "token": self.token,
            "session_id": self.session_id,
            "operation_id": self.operation_id,
            "created_at": time.time(),
            "kind": self.kind,
            "summary": self.summary,
            "touched_relative_paths": list(self.touched_relative_paths),
            "snapshot_relative_paths": list(self.snapshot_relative_paths),
            "snapshot_manifest": list(self.snapshot_manifest),
        }


def create_workspace_undo_snapshot(
    root: str | Path,
    *,
    session_id: str,
    kind: str,
    summary: str,
    touched_relative_paths: tuple[str, ...],
    snapshot_relative_paths: tuple[str, ...],
) -> WorkspaceUndoSnapshot:
    """Stage current path state into an opaque repo-local undo token."""

    root_path = Path(root).resolve()
    ensure_recovery_storage(root_path)
    _cleanup_stale_undo_tokens(root_path)

    token = _operation_id()
    operation_id = _operation_id()
    undo_dir = _undo_dir(root_path, token)
    undo_dir.mkdir(parents=True, exist_ok=False)
    try:
        normalized_snapshot_paths = tuple(
            dict.fromkeys(_validated_repo_relative_path(path) for path in snapshot_relative_paths)
        )
        normalized_touched_paths = tuple(
            dict.fromkeys(_validated_repo_relative_path(path) for path in touched_relative_paths)
        )
        manifest = tuple(
            _stage_snapshot(index, root_path, undo_dir, relative_path)
            for index, relative_path in enumerate(normalized_snapshot_paths)
        )
        snapshot = WorkspaceUndoSnapshot(
            token=token,
            session_id=session_id,
            operation_id=operation_id,
            kind=kind,
            summary=summary,
            touched_relative_paths=normalized_touched_paths,
            snapshot_relative_paths=normalized_snapshot_paths,
            snapshot_manifest=manifest,
        )
        atomic_write_text(
            undo_dir / "token.json",
            json.dumps(snapshot.to_record(), indent=2, sort_keys=True),
        )
        return snapshot
    except Exception:
        shutil.rmtree(undo_dir, ignore_errors=True)
        raise


def load_workspace_undo_snapshot(root: str | Path, token: str) -> WorkspaceUndoSnapshot:
    root_path = Path(root).resolve()
    token_path = _undo_dir(root_path, _validated_token(token)) / "token.json"
    try:
        record = json.loads(token_path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ValueError("Workspace undo token is no longer available.") from exc
    if not isinstance(record, dict):
        raise ValueError("Workspace undo token record must be an object.")
    if record.get("version") != _UNDO_VERSION:
        raise ValueError("Workspace undo token has an unsupported version.")

    created_at = record.get("created_at")
    if isinstance(created_at, (int, float)) and time.time() - created_at > UNDO_TOKEN_TTL_SECONDS:
        discard_workspace_undo_snapshot(root_path, token)
        raise ValueError("Workspace undo token has expired.")

    snapshot_manifest = record.get("snapshot_manifest")
    if not isinstance(snapshot_manifest, list):
        raise ValueError("Workspace undo token is missing its snapshot manifest.")

    return WorkspaceUndoSnapshot(
        token=_required_string(record, "token"),
        session_id=_required_string(record, "session_id"),
        operation_id=_required_string(record, "operation_id"),
        kind=_required_string(record, "kind"),
        summary=_required_string(record, "summary"),
        touched_relative_paths=_string_tuple(record, "touched_relative_paths"),
        snapshot_relative_paths=_string_tuple(record, "snapshot_relative_paths"),
        snapshot_manifest=tuple(item for item in snapshot_manifest if isinstance(item, dict)),
    )


def restore_workspace_undo_snapshot(root: str | Path, snapshot: WorkspaceUndoSnapshot) -> None:
    """Restore staged undo entries. The caller owns journaling and token cleanup."""

    root_path = Path(root).resolve()
    undo_dir = _undo_dir(root_path, snapshot.token)
    for entry in reversed(snapshot.snapshot_manifest):
        _restore_snapshot_entry(root_path, undo_dir, entry)


def discard_workspace_undo_snapshot(root: str | Path, token: str) -> None:
    root_path = Path(root).resolve()
    shutil.rmtree(_undo_dir(root_path, _validated_token(token)), ignore_errors=True)


def _cleanup_stale_undo_tokens(root_path: Path) -> None:
    undo_root = root_path / UNDO_RELATIVE_PATH
    if not undo_root.exists():
        return
    cutoff = time.time() - UNDO_TOKEN_TTL_SECONDS
    for token_dir in undo_root.iterdir():
        if not token_dir.is_dir():
            continue
        token_path = token_dir / "token.json"
        try:
            raw = json.loads(token_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            continue
        created_at = raw.get("created_at") if isinstance(raw, dict) else None
        if isinstance(created_at, (int, float)) and created_at < cutoff:
            shutil.rmtree(token_dir, ignore_errors=True)


def _stage_snapshot(
    index: int,
    root_path: Path,
    undo_dir: Path,
    relative_path: str,
) -> dict[str, Any]:
    target_path = _repo_target_path(root_path, relative_path)
    entry: dict[str, Any] = {"relative_path": relative_path}

    if target_path.is_symlink():
        if target_path.is_dir():
            raise ValueError(
                f"Destructive symlinked directory operations are not supported: {relative_path}"
            )
        entry.update({"kind": "symlink", "link_target": os.readlink(target_path)})
        return entry

    if target_path.is_file():
        stage_path = undo_dir / f"entry-{index}.bin"
        shutil.copy2(target_path, stage_path)
        entry.update(
            {
                "kind": "file",
                "stage_path": stage_path.name,
                "size": target_path.stat().st_size,
                "mtime_ns": target_path.stat().st_mtime_ns,
            }
        )
        return entry

    if target_path.is_dir():
        _reject_symlinked_directories(target_path, relative_path)
        stage_path = undo_dir / f"entry-{index}"
        shutil.copytree(target_path, stage_path, symlinks=True)
        entry.update(
            {
                "kind": "directory",
                "stage_path": stage_path.name,
                "manifest": _directory_manifest(target_path),
            }
        )
        return entry

    _ensure_missing_target_parent_inside_repo(root_path, relative_path)
    entry.update({"kind": "missing"})
    return entry


def _restore_snapshot_entry(root_path: Path, undo_dir: Path, entry: dict[str, Any]) -> None:
    relative_path = _validated_repo_relative_path(_required_string(entry, "relative_path"))
    target_path = _repo_target_path(root_path, relative_path)
    kind = _required_string(entry, "kind")

    if kind == "missing":
        _remove_path(target_path)
        _cleanup_empty_parent_dirs(root_path, target_path.parent)
        return

    if kind == "file":
        stage_path = undo_dir / _required_string(entry, "stage_path")
        if not stage_path.is_file():
            raise ValueError(f"Missing staged file undo snapshot for {relative_path}.")
        _remove_path(target_path)
        target_path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_bytes(target_path, stage_path.read_bytes())
        try:
            shutil.copystat(stage_path, target_path)
        except OSError:
            pass
        return

    if kind == "directory":
        stage_path = undo_dir / _required_string(entry, "stage_path")
        if not stage_path.is_dir():
            raise ValueError(f"Missing staged directory undo snapshot for {relative_path}.")
        _remove_path(target_path)
        target_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(stage_path, target_path, symlinks=True)
        _fsync_directory(target_path.parent)
        return

    if kind == "symlink":
        link_target = _required_string(entry, "link_target")
        _remove_path(target_path)
        target_path.parent.mkdir(parents=True, exist_ok=True)
        os.symlink(link_target, target_path)
        _fsync_directory(target_path.parent)
        return

    raise ValueError(f"Unsupported workspace undo snapshot kind: {kind}")


def _undo_dir(root_path: Path, token: str) -> Path:
    return root_path / UNDO_RELATIVE_PATH / token


def _operation_id() -> str:
    return f"{time.strftime('%Y%m%d%H%M%S')}-{uuid.uuid4().hex}"


def _validated_token(token: str) -> str:
    if not token or any(part in token for part in ("/", "\\")):
        raise ValueError("Workspace undo token is malformed.")
    allowed = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")
    if any(char not in allowed for char in token):
        raise ValueError("Workspace undo token is malformed.")
    return token


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


def _repo_target_path(root_path: Path, relative_path: str) -> Path:
    normalized = _validated_repo_relative_path(relative_path)
    target_path = root_path / normalized
    if target_path.exists() or target_path.is_symlink():
        resolved = target_path.resolve()
        _ensure_inside_root(root_path, resolved, normalized)
    else:
        _ensure_missing_target_parent_inside_repo(root_path, normalized)
    return target_path


def _ensure_missing_target_parent_inside_repo(root_path: Path, relative_path: str) -> None:
    target_path = root_path / relative_path
    parent = target_path.parent
    while not parent.exists():
        if parent == root_path or parent.parent == parent:
            break
        parent = parent.parent
    _ensure_inside_root(root_path, parent.resolve(), relative_path)


def _ensure_inside_root(root_path: Path, path: Path, relative_path: str) -> None:
    try:
        path.relative_to(root_path)
    except ValueError as exc:
        raise ValueError(f"Repo-relative path '{relative_path}' escapes the repo root.") from exc


def _reject_symlinked_directories(path: Path, relative_path: str) -> None:
    for child in path.rglob("*"):
        if child.is_symlink() and child.is_dir():
            child_relative = child.relative_to(path).as_posix()
            raise ValueError(
                "Destructive symlinked directory operations are not supported: "
                f"{relative_path}/{child_relative}"
            )


def _directory_manifest(path: Path) -> list[dict[str, Any]]:
    manifest: list[dict[str, Any]] = []
    for child in sorted(path.rglob("*")):
        child_relative = child.relative_to(path).as_posix()
        if child.is_symlink():
            kind = "symlink"
            link_target: str | None = os.readlink(child)
        elif child.is_dir():
            kind = "directory"
            link_target = None
        elif child.is_file():
            kind = "file"
            link_target = None
        else:
            kind = "other"
            link_target = None
        stat = child.lstat() if child.is_symlink() else child.stat()
        entry: dict[str, Any] = {
            "path": child_relative,
            "kind": kind,
            "size": stat.st_size,
            "mtime_ns": stat.st_mtime_ns,
        }
        if link_target is not None:
            entry["link_target"] = link_target
        manifest.append(entry)
    return manifest


def _remove_path(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        return
    if path.is_dir():
        shutil.rmtree(path)


def _cleanup_empty_parent_dirs(root_path: Path, directory: Path) -> None:
    current = directory
    while current != root_path and current.exists():
        try:
            current.rmdir()
        except OSError:
            break
        current = current.parent


def _required_string(raw: dict[str, Any], key: str) -> str:
    value = raw.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"Workspace undo token requires string '{key}'.")
    return value


def _string_tuple(raw: dict[str, Any], key: str) -> tuple[str, ...]:
    values = raw.get(key)
    if not isinstance(values, list) or any(not isinstance(value, str) for value in values):
        raise ValueError(f"Workspace undo token requires string list '{key}'.")
    return tuple(values)


def _fsync_directory(path: Path) -> None:
    if os.name == "nt":
        return
    try:
        directory_fd = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
