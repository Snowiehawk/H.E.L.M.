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
    REPLACE_SYMBOL_SOURCE = "replace_symbol_source"
    INSERT_FLOW_STATEMENT = "insert_flow_statement"
    REPLACE_FLOW_GRAPH = "replace_flow_graph"


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
        }
