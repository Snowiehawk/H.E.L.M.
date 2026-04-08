"""Edit request serialization and validation helpers."""

from __future__ import annotations

import json
from typing import Any

from helm.editor.models import StructuralEditKind, StructuralEditRequest


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
        body=_optional_string(raw, "body"),
        content=_optional_string(raw, "content"),
    )
    _validate_request(request)
    return request


def _optional_string(raw: dict[str, Any], key: str) -> str | None:
    value = raw.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"Edit request field '{key}' must be a string when provided.")
    return value


def _validate_request(request: StructuralEditRequest) -> None:
    if request.kind == StructuralEditKind.RENAME_SYMBOL:
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
    elif request.kind == StructuralEditKind.REPLACE_SYMBOL_SOURCE:
        if not request.target_id or request.content is None:
            raise ValueError("replace_symbol_source requires 'target_id' and 'content'.")
