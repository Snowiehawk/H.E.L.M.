"""Repo-local journal and recovery helpers for mutating workspace operations."""

from __future__ import annotations

import json
import os
import shutil
import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Iterator, TypeVar

from helm.io_atomic import atomic_write_bytes, atomic_write_text

RECOVERY_RELATIVE_PATH = ".helm/recovery"
_JOURNALS_DIR = "journals"
_STAGING_DIR = "staging"
_JOURNAL_VERSION = 1
_LOCKS: dict[str, threading.RLock] = {}
_LOCKS_GUARD = threading.Lock()

T = TypeVar("T")


@dataclass(frozen=True)
class RecoveryEvent:
    operation_id: str
    kind: str
    outcome: str
    touched_relative_paths: tuple[str, ...] = ()
    warnings: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "operation_id": self.operation_id,
            "kind": self.kind,
            "outcome": self.outcome,
            "touched_relative_paths": list(self.touched_relative_paths),
            "warnings": list(self.warnings),
        }


@dataclass(frozen=True)
class JournalPreimage:
    relative_path: str
    role: str = "preimage"
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class JournaledMutationResult:
    value: Any
    recovery_events: tuple[RecoveryEvent, ...] = ()


class RecoveryError(ValueError):
    """Raised when a pending mutation cannot be recovered automatically."""


@contextmanager
def repo_mutation_lock(root: str | Path) -> Iterator[None]:
    lock = _lock_for_root(root)
    with lock:
        yield


def recover_pending(root: str | Path) -> tuple[RecoveryEvent, ...]:
    with repo_mutation_lock(root):
        return RepoMutationJournal(root).recover_pending()


def run_journaled_mutation(
    root: str | Path,
    *,
    kind: str,
    preimages: tuple[JournalPreimage, ...],
    mutation: Callable[[], T],
) -> JournaledMutationResult:
    with repo_mutation_lock(root):
        journal = RepoMutationJournal(root)
        recovery_events = journal.recover_pending()
        operation = journal.prepare(kind=kind, preimages=preimages)
        return JournaledMutationResult(
            value=operation.apply(mutation),
            recovery_events=recovery_events,
        )


class RepoMutationJournal:
    """Manage durable per-repo mutation journals."""

    def __init__(self, root: str | Path) -> None:
        self.root_path = Path(root).resolve()
        self.recovery_dir = self.root_path / RECOVERY_RELATIVE_PATH
        self.journals_dir = self.recovery_dir / _JOURNALS_DIR
        self.staging_root = self.recovery_dir / _STAGING_DIR

    def prepare(
        self,
        *,
        kind: str,
        preimages: tuple[JournalPreimage, ...],
    ) -> JournalOperation:
        self._ensure_recovery_dirs()
        operation_id = _operation_id()
        staging_dir = self.staging_root / operation_id
        staging_dir.mkdir(parents=True, exist_ok=False)

        try:
            entries = [
                self._stage_preimage(index, staging_dir, preimage)
                for index, preimage in enumerate(preimages)
            ]
            touched_relative_paths = tuple(
                dict.fromkeys(entry["relative_path"] for entry in entries)
            )
            record = {
                "version": _JOURNAL_VERSION,
                "operation_id": operation_id,
                "kind": kind,
                "phase": "prepared",
                "created_at": time.time(),
                "touched_relative_paths": list(touched_relative_paths),
                "entries": entries,
            }
            journal_path = self._journal_path(operation_id)
            atomic_write_text(journal_path, json.dumps(record, indent=2, sort_keys=True))
            return JournalOperation(
                journal=self,
                operation_id=operation_id,
                journal_path=journal_path,
                staging_dir=staging_dir,
                record=record,
            )
        except Exception:
            shutil.rmtree(staging_dir, ignore_errors=True)
            raise

    def recover_pending(self) -> tuple[RecoveryEvent, ...]:
        if not self.journals_dir.exists():
            return ()

        events: list[RecoveryEvent] = []
        for journal_path in sorted(self.journals_dir.glob("*.json")):
            try:
                record = _read_journal_record(journal_path)
                operation = JournalOperation(
                    journal=self,
                    operation_id=str(record.get("operation_id") or journal_path.stem),
                    journal_path=journal_path,
                    staging_dir=self.staging_root
                    / str(record.get("operation_id") or journal_path.stem),
                    record=record,
                )
                if record.get("phase") == "committed":
                    operation.cleanup()
                    events.append(operation.event("committed_cleanup"))
                    continue

                operation.rollback()
                events.append(operation.event("rolled_back"))
            except Exception as exc:
                raise RecoveryError(
                    f"Unable to recover pending HELM mutation journal {journal_path}: {exc}"
                ) from exc
        return tuple(events)

    def _ensure_recovery_dirs(self) -> None:
        self._ensure_git_exclude_ignores_recovery()
        self.journals_dir.mkdir(parents=True, exist_ok=True)
        self.staging_root.mkdir(parents=True, exist_ok=True)
        gitignore = self.recovery_dir / ".gitignore"
        if not gitignore.exists():
            atomic_write_text(gitignore, "*\n!.gitignore\n")

    def _ensure_git_exclude_ignores_recovery(self) -> None:
        git_dir = self.root_path / ".git"
        if not git_dir.is_dir():
            return

        info_dir = git_dir / "info"
        info_dir.mkdir(parents=True, exist_ok=True)
        exclude_path = info_dir / "exclude"
        ignore_line = f"/{RECOVERY_RELATIVE_PATH}/"
        if exclude_path.exists():
            existing = exclude_path.read_text(encoding="utf-8")
            if ignore_line in existing.splitlines():
                return
        else:
            existing = ""

        separator = "" if not existing or existing.endswith("\n") else "\n"
        atomic_write_text(
            exclude_path,
            f"{existing}{separator}# H.E.L.M. recovery scratch space\n{ignore_line}\n",
        )

    def _journal_path(self, operation_id: str) -> Path:
        return self.journals_dir / f"{operation_id}.json"

    def _stage_preimage(
        self,
        index: int,
        staging_dir: Path,
        preimage: JournalPreimage,
    ) -> dict[str, Any]:
        normalized_relative_path = _validated_repo_relative_path(preimage.relative_path)
        target_path = _repo_target_path(self.root_path, normalized_relative_path)
        entry: dict[str, Any] = {
            "relative_path": normalized_relative_path,
            "role": preimage.role,
            "metadata": dict(preimage.metadata),
        }

        if target_path.is_symlink():
            if target_path.is_dir():
                raise ValueError(
                    f"Destructive symlinked directory operations are not supported: {normalized_relative_path}"
                )
            entry.update(
                {
                    "kind": "symlink",
                    "link_target": os.readlink(target_path),
                }
            )
            return entry

        if target_path.is_file():
            stage_path = staging_dir / f"entry-{index}.bin"
            shutil.copy2(target_path, stage_path)
            entry.update({"kind": "file", "stage_path": stage_path.name})
            return entry

        if target_path.is_dir():
            _reject_symlinked_directories(target_path, normalized_relative_path)
            stage_path = staging_dir / f"entry-{index}"
            shutil.copytree(target_path, stage_path, symlinks=True)
            entry.update(
                {
                    "kind": "directory",
                    "stage_path": stage_path.name,
                    "manifest": _directory_manifest(target_path),
                }
            )
            return entry

        _ensure_missing_target_parent_inside_repo(self.root_path, normalized_relative_path)
        entry.update({"kind": "missing"})
        return entry


class JournalOperation:
    def __init__(
        self,
        *,
        journal: RepoMutationJournal,
        operation_id: str,
        journal_path: Path,
        staging_dir: Path,
        record: dict[str, Any],
    ) -> None:
        self.journal = journal
        self.operation_id = operation_id
        self.journal_path = journal_path
        self.staging_dir = staging_dir
        self.record = record

    def apply(self, mutation: Callable[[], T]) -> T:
        self._write_phase("applying")
        try:
            result = mutation()
        except Exception:
            self.rollback()
            raise
        self.commit()
        return result

    def commit(self) -> None:
        self._write_phase("committed")
        self.cleanup()

    def rollback(self) -> None:
        if self.record.get("phase") != "rolling_back":
            self._write_phase("rolling_back")

        entries = self.record.get("entries")
        if not isinstance(entries, list):
            raise ValueError("Journal record is missing staged entries.")

        for raw_entry in reversed(entries):
            if not isinstance(raw_entry, dict):
                raise ValueError("Journal entry must be an object.")
            self._restore_entry(raw_entry)

        self.cleanup()

    def cleanup(self) -> None:
        try:
            self.journal_path.unlink()
        except FileNotFoundError:
            pass
        shutil.rmtree(self.staging_dir, ignore_errors=True)

    def event(self, outcome: str) -> RecoveryEvent:
        raw_paths = self.record.get("touched_relative_paths") or []
        paths = tuple(path for path in raw_paths if isinstance(path, str))
        return RecoveryEvent(
            operation_id=self.operation_id,
            kind=str(self.record.get("kind") or "unknown"),
            outcome=outcome,
            touched_relative_paths=paths,
        )

    def _write_phase(self, phase: str) -> None:
        self.record = {**self.record, "phase": phase, "updated_at": time.time()}
        atomic_write_text(
            self.journal_path,
            json.dumps(self.record, indent=2, sort_keys=True),
        )

    def _restore_entry(self, entry: dict[str, Any]) -> None:
        relative_path = _validated_repo_relative_path(_required_string(entry, "relative_path"))
        target_path = _repo_target_path(self.journal.root_path, relative_path)
        kind = _required_string(entry, "kind")

        if kind == "missing":
            _remove_path(target_path)
            _cleanup_empty_parent_dirs(self.journal.root_path, target_path.parent)
            return

        if kind == "file":
            stage_path = self.staging_dir / _required_string(entry, "stage_path")
            if not stage_path.is_file():
                raise ValueError(f"Missing staged file preimage for {relative_path}.")
            _remove_path(target_path)
            target_path.parent.mkdir(parents=True, exist_ok=True)
            atomic_write_bytes(target_path, stage_path.read_bytes())
            try:
                shutil.copystat(stage_path, target_path)
            except OSError:
                pass
            return

        if kind == "directory":
            stage_path = self.staging_dir / _required_string(entry, "stage_path")
            if not stage_path.is_dir():
                raise ValueError(f"Missing staged directory preimage for {relative_path}.")
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

        raise ValueError(f"Unsupported journal entry kind: {kind}")


def _lock_for_root(root: str | Path) -> threading.RLock:
    root_key = Path(root).resolve().as_posix()
    with _LOCKS_GUARD:
        lock = _LOCKS.get(root_key)
        if lock is None:
            lock = threading.RLock()
            _LOCKS[root_key] = lock
        return lock


def _operation_id() -> str:
    return f"{time.strftime('%Y%m%d%H%M%S')}-{uuid.uuid4().hex}"


def _read_journal_record(path: Path) -> dict[str, Any]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError("Journal record must be an object.")
    if raw.get("version") != _JOURNAL_VERSION:
        raise ValueError("Unsupported journal record version.")
    return raw


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
    resolved_parent = parent.resolve()
    _ensure_inside_root(root_path, resolved_parent, relative_path)


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


def _directory_manifest(path: Path) -> list[dict[str, str]]:
    manifest: list[dict[str, str]] = []
    for child in sorted(path.rglob("*")):
        child_relative = child.relative_to(path).as_posix()
        if child.is_symlink():
            kind = "symlink"
        elif child.is_dir():
            kind = "directory"
        elif child.is_file():
            kind = "file"
        else:
            kind = "other"
        manifest.append({"path": child_relative, "kind": kind})
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
        raise ValueError(f"Journal entry requires string '{key}'.")
    return value


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
