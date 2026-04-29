"""Typed structural edit models used by the graph editor."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class StructuralEditKind(str, Enum):
    CREATE_MODULE = "create_module"
    RENAME_SYMBOL = "rename_symbol"
    CREATE_SYMBOL = "create_symbol"
    DELETE_SYMBOL = "delete_symbol"
    MOVE_SYMBOL = "move_symbol"
    ADD_IMPORT = "add_import"
    REMOVE_IMPORT = "remove_import"
    REPLACE_MODULE_SOURCE = "replace_module_source"
    REPLACE_SYMBOL_SOURCE = "replace_symbol_source"
    INSERT_FLOW_STATEMENT = "insert_flow_statement"
    REPLACE_FLOW_GRAPH = "replace_flow_graph"


@dataclass(frozen=True)
class UndoFocusTarget:
    target_id: str
    level: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "target_id": self.target_id,
            "level": self.level,
        }


@dataclass(frozen=True)
class UndoFileSnapshot:
    relative_path: str
    existed: bool
    content: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "relative_path": self.relative_path,
            "existed": self.existed,
            "content": self.content,
        }


@dataclass(frozen=True)
class BackendUndoTransaction:
    summary: str
    request_kind: str
    file_snapshots: tuple[UndoFileSnapshot, ...] = field(default_factory=tuple)
    changed_node_ids: tuple[str, ...] = field(default_factory=tuple)
    focus_target: UndoFocusTarget | None = None
    snapshot_token: str | None = None
    touched_relative_paths: tuple[str, ...] = field(default_factory=tuple)

    def to_dict(self) -> dict[str, Any]:
        return {
            "summary": self.summary,
            "request_kind": self.request_kind,
            "file_snapshots": [snapshot.to_dict() for snapshot in self.file_snapshots],
            "changed_node_ids": list(self.changed_node_ids),
            "focus_target": self.focus_target.to_dict() if self.focus_target else None,
            "snapshot_token": self.snapshot_token,
            "touched_relative_paths": list(self.touched_relative_paths),
        }


@dataclass(frozen=True)
class BackendUndoResult:
    summary: str
    restored_relative_paths: tuple[str, ...] = field(default_factory=tuple)
    warnings: tuple[str, ...] = field(default_factory=tuple)
    focus_target: UndoFocusTarget | None = None
    redo_transaction: BackendUndoTransaction | None = None
    recovery_events: tuple[dict[str, Any], ...] = field(default_factory=tuple)

    def to_dict(self) -> dict[str, Any]:
        return {
            "summary": self.summary,
            "restored_relative_paths": list(self.restored_relative_paths),
            "warnings": list(self.warnings),
            "focus_target": self.focus_target.to_dict() if self.focus_target else None,
            "redo_transaction": (
                self.redo_transaction.to_dict() if self.redo_transaction is not None else None
            ),
            "recovery_events": list(self.recovery_events),
        }


@dataclass(frozen=True)
class StructuralEditRequest:
    kind: StructuralEditKind
    target_id: str | None = None
    relative_path: str | None = None
    new_name: str | None = None
    symbol_kind: str | None = None
    destination_relative_path: str | None = None
    imported_module: str | None = None
    imported_name: str | None = None
    alias: str | None = None
    anchor_edge_id: str | None = None
    body: str | None = None
    content: str | None = None
    flow_graph: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind.value,
            "target_id": self.target_id,
            "relative_path": self.relative_path,
            "new_name": self.new_name,
            "symbol_kind": self.symbol_kind,
            "destination_relative_path": self.destination_relative_path,
            "imported_module": self.imported_module,
            "imported_name": self.imported_name,
            "alias": self.alias,
            "anchor_edge_id": self.anchor_edge_id,
            "body": self.body,
            "content": self.content,
            "flow_graph": self.flow_graph,
        }


@dataclass(frozen=True)
class StructuralEditResult:
    request: StructuralEditRequest
    summary: str
    touched_relative_paths: tuple[str, ...] = field(default_factory=tuple)
    reparsed_relative_paths: tuple[str, ...] = field(default_factory=tuple)
    changed_node_ids: tuple[str, ...] = field(default_factory=tuple)
    warnings: tuple[str, ...] = field(default_factory=tuple)
    flow_sync_state: str | None = None
    diagnostics: tuple[str, ...] = field(default_factory=tuple)
    undo_transaction: BackendUndoTransaction | None = None
    recovery_events: tuple[dict[str, Any], ...] = field(default_factory=tuple)

    def to_dict(self) -> dict[str, Any]:
        return {
            "request": self.request.to_dict(),
            "summary": self.summary,
            "touched_relative_paths": list(self.touched_relative_paths),
            "reparsed_relative_paths": list(self.reparsed_relative_paths),
            "changed_node_ids": list(self.changed_node_ids),
            "warnings": list(self.warnings),
            "flow_sync_state": self.flow_sync_state,
            "diagnostics": list(self.diagnostics),
            "undo_transaction": (
                self.undo_transaction.to_dict() if self.undo_transaction is not None else None
            ),
            "recovery_events": list(self.recovery_events),
        }
