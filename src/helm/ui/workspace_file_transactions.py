"""Journal, recovery, and undo transaction helpers for workspace file operations."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

from helm.editor.models import BackendUndoTransaction
from helm.recovery import (
    JournalPreimage,
    RepoMutationJournal,
    recover_pending,
    repo_mutation_lock,
)
from helm.workspace_undo import create_workspace_undo_snapshot, discard_workspace_undo_snapshot


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
