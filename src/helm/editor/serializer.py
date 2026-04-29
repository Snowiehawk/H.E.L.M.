"""Edit request serialization and validation helpers."""

from __future__ import annotations

import json
from typing import Any

from helm.editor.models import (
    BackendUndoTransaction,
    StructuralEditKind,
    StructuralEditRequest,
    UndoFileSnapshot,
    UndoFocusTarget,
)


def serialize_edit_request(payload: str | dict[str, Any]) -> StructuralEditRequest:
    """Normalize raw request payloads into typed edit requests."""

    raw = json.loads(payload) if isinstance(payload, str) else dict(payload)
    kind_raw = raw.get("kind")
    if not isinstance(kind_raw, str):
        raise ValueError("Edit request requires a string 'kind'.")

    try:
        kind = StructuralEditKind(kind_raw)
    except ValueError as exc:
        raise ValueError(f"Unsupported edit kind: {kind_raw}") from exc

    request = StructuralEditRequest(
        kind=kind,
        target_id=_optional_string(raw, "target_id"),
        relative_path=_optional_string(raw, "relative_path"),
        new_name=_optional_string(raw, "new_name"),
        symbol_kind=_optional_string(raw, "symbol_kind"),
        destination_relative_path=_optional_string(raw, "destination_relative_path"),
        imported_module=_optional_string(raw, "imported_module"),
        imported_name=_optional_string(raw, "imported_name"),
        alias=_optional_string(raw, "alias"),
        anchor_edge_id=_optional_string(raw, "anchor_edge_id"),
        body=_optional_string(raw, "body"),
        content=_optional_string(raw, "content"),
        flow_graph=_optional_mapping(raw, "flow_graph"),
    )
    _validate_request(request)
    return request


def serialize_undo_transaction(payload: str | dict[str, Any]) -> BackendUndoTransaction:
    """Normalize raw undo payloads into typed backend undo transactions."""

    raw = json.loads(payload) if isinstance(payload, str) else dict(payload)
    summary = _required_string(raw, "summary")
    request_kind = _required_string(raw, "request_kind")
    file_snapshots_raw = raw.get("file_snapshots")
    snapshot_token = raw.get("snapshot_token")
    if snapshot_token is not None and not isinstance(snapshot_token, str):
        raise ValueError("Undo transaction field 'snapshot_token' must be a string when provided.")
    if not isinstance(file_snapshots_raw, list):
        raise ValueError("Undo transaction requires a 'file_snapshots' list.")
    if not file_snapshots_raw and not snapshot_token:
        raise ValueError(
            "Undo transaction requires file snapshots or an opaque workspace snapshot token."
        )

    file_snapshots: list[UndoFileSnapshot] = []
    for index, item in enumerate(file_snapshots_raw):
        if not isinstance(item, dict):
            raise ValueError(f"Undo transaction file snapshot at index {index} must be an object.")
        relative_path = _required_string(item, "relative_path")
        existed = item.get("existed")
        if not isinstance(existed, bool):
            raise ValueError(
                f"Undo transaction file snapshot '{relative_path}' requires boolean 'existed'."
            )
        content = item.get("content")
        if content is not None and not isinstance(content, str):
            raise ValueError(
                f"Undo transaction file snapshot '{relative_path}' requires string 'content' when provided."
            )
        if existed and content is None:
            raise ValueError(
                f"Undo transaction file snapshot '{relative_path}' requires 'content' for existing files."
            )
        file_snapshots.append(
            UndoFileSnapshot(
                relative_path=relative_path,
                existed=existed,
                content=content,
            )
        )

    changed_node_ids = raw.get("changed_node_ids") or []
    if not isinstance(changed_node_ids, list) or any(
        not isinstance(node_id, str) for node_id in changed_node_ids
    ):
        raise ValueError("Undo transaction field 'changed_node_ids' must be a list of strings.")

    touched_relative_paths = raw.get("touched_relative_paths") or []
    if not isinstance(touched_relative_paths, list) or any(
        not isinstance(path, str) for path in touched_relative_paths
    ):
        raise ValueError(
            "Undo transaction field 'touched_relative_paths' must be a list of strings."
        )

    focus_target_raw = raw.get("focus_target")
    focus_target: UndoFocusTarget | None = None
    if focus_target_raw is not None:
        if not isinstance(focus_target_raw, dict):
            raise ValueError(
                "Undo transaction field 'focus_target' must be an object when provided."
            )
        focus_target = UndoFocusTarget(
            target_id=_required_string(focus_target_raw, "target_id"),
            level=_required_string(focus_target_raw, "level"),
        )

    return BackendUndoTransaction(
        summary=summary,
        request_kind=request_kind,
        file_snapshots=tuple(file_snapshots),
        changed_node_ids=tuple(changed_node_ids),
        focus_target=focus_target,
        snapshot_token=snapshot_token,
        touched_relative_paths=tuple(touched_relative_paths),
    )


def _optional_string(raw: dict[str, Any], key: str) -> str | None:
    value = raw.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"Edit request field '{key}' must be a string when provided.")
    return value


def _optional_mapping(raw: dict[str, Any], key: str) -> dict[str, Any] | None:
    value = raw.get(key)
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError(f"Edit request field '{key}' must be an object when provided.")
    return dict(value)


def _required_string(raw: dict[str, Any], key: str) -> str:
    value = raw.get(key)
    if not isinstance(value, str):
        raise ValueError(f"Field '{key}' must be a string.")
    return value


def _validate_request(request: StructuralEditRequest) -> None:
    if request.kind == StructuralEditKind.CREATE_MODULE:
        if not request.relative_path:
            raise ValueError("create_module requires 'relative_path'.")
    elif request.kind == StructuralEditKind.RENAME_SYMBOL:
        if not request.target_id or not request.new_name:
            raise ValueError("rename_symbol requires 'target_id' and 'new_name'.")
    elif request.kind == StructuralEditKind.CREATE_SYMBOL:
        if not request.relative_path or not request.new_name or not request.symbol_kind:
            raise ValueError(
                "create_symbol requires 'relative_path', 'new_name', and 'symbol_kind'."
            )
        if request.symbol_kind not in {"function", "class"}:
            raise ValueError("create_symbol only supports 'function' and 'class'.")
    elif request.kind == StructuralEditKind.DELETE_SYMBOL:
        if not request.target_id:
            raise ValueError("delete_symbol requires 'target_id'.")
    elif request.kind == StructuralEditKind.MOVE_SYMBOL:
        if not request.target_id or not request.destination_relative_path:
            raise ValueError("move_symbol requires 'target_id' and 'destination_relative_path'.")
    elif request.kind == StructuralEditKind.ADD_IMPORT:
        if not request.relative_path or not request.imported_module:
            raise ValueError("add_import requires 'relative_path' and 'imported_module'.")
    elif request.kind == StructuralEditKind.REMOVE_IMPORT:
        if not request.relative_path or not request.imported_module:
            raise ValueError("remove_import requires 'relative_path' and 'imported_module'.")
    elif request.kind == StructuralEditKind.REPLACE_MODULE_SOURCE:
        if not request.target_id or request.content is None:
            raise ValueError("replace_module_source requires 'target_id' and 'content'.")
    elif request.kind == StructuralEditKind.REPLACE_SYMBOL_SOURCE:
        if not request.target_id or request.content is None:
            raise ValueError("replace_symbol_source requires 'target_id' and 'content'.")
    elif request.kind == StructuralEditKind.INSERT_FLOW_STATEMENT:
        if not request.target_id or not request.anchor_edge_id or request.content is None:
            raise ValueError(
                "insert_flow_statement requires 'target_id', 'anchor_edge_id', and 'content'."
            )
    elif request.kind == StructuralEditKind.REPLACE_FLOW_GRAPH:
        if not request.target_id or request.flow_graph is None:
            raise ValueError("replace_flow_graph requires 'target_id' and 'flow_graph'.")
