"""Persisted visual flow model helpers."""

from __future__ import annotations

import ast
import hashlib
import json
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any


FLOW_MODEL_VERSION = 1
FLOW_MODEL_RELATIVE_PATH = ".helm/flow-models.v1.json"
# Parameter nodes remain projected visual support nodes in flow views. The
# persisted FlowModelDocument stores authored control-flow statements plus entry
# / exit sentinels, source-backed node identity, and first-class function-input
# bindings so editable graphs own input/value semantics.
FLOW_NODE_KINDS = {"entry", "assign", "call", "branch", "loop", "return", "exit"}
FLOW_SYNC_STATES = {"clean", "draft", "import_error"}


@dataclass(frozen=True)
class FlowModelNode:
    node_id: str
    kind: str
    payload: dict[str, Any]
    indexed_node_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        payload = {
            "id": self.node_id,
            "kind": self.kind,
            "payload": self.payload,
        }
        if self.indexed_node_id:
            payload["indexed_node_id"] = self.indexed_node_id
        return payload


@dataclass(frozen=True)
class FlowModelEdge:
    edge_id: str
    source_id: str
    source_handle: str
    target_id: str
    target_handle: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.edge_id,
            "source_id": self.source_id,
            "source_handle": self.source_handle,
            "target_id": self.target_id,
            "target_handle": self.target_handle,
        }


@dataclass(frozen=True)
class FlowFunctionInput:
    input_id: str
    name: str
    index: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.input_id,
            "name": self.name,
            "index": self.index,
        }


@dataclass(frozen=True)
class FlowInputSlot:
    slot_id: str
    node_id: str
    slot_key: str
    label: str
    required: bool = True

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.slot_id,
            "node_id": self.node_id,
            "slot_key": self.slot_key,
            "label": self.label,
            "required": self.required,
        }


@dataclass(frozen=True)
class FlowInputBinding:
    binding_id: str
    function_input_id: str
    slot_id: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.binding_id,
            "function_input_id": self.function_input_id,
            "slot_id": self.slot_id,
        }


@dataclass(frozen=True)
class FlowModelDocument:
    symbol_id: str
    relative_path: str
    qualname: str
    nodes: tuple[FlowModelNode, ...]
    edges: tuple[FlowModelEdge, ...]
    function_inputs: tuple[FlowFunctionInput, ...] = ()
    input_slots: tuple[FlowInputSlot, ...] = ()
    input_bindings: tuple[FlowInputBinding, ...] = ()
    sync_state: str = "clean"
    diagnostics: tuple[str, ...] = ()
    source_hash: str | None = None
    editable: bool = True

    def to_dict(self) -> dict[str, Any]:
        return {
            "symbol_id": self.symbol_id,
            "relative_path": self.relative_path,
            "qualname": self.qualname,
            "nodes": [node.to_dict() for node in self.nodes],
            "edges": [edge.to_dict() for edge in self.edges],
            "function_inputs": [function_input.to_dict() for function_input in self.function_inputs],
            "input_slots": [slot.to_dict() for slot in self.input_slots],
            "input_bindings": [binding.to_dict() for binding in self.input_bindings],
            "sync_state": self.sync_state,
            "diagnostics": list(self.diagnostics),
            "source_hash": self.source_hash,
            "editable": self.editable,
        }


@dataclass(frozen=True)
class FlowCompileResult:
    document: FlowModelDocument
    body_source: str | None
    diagnostics: tuple[str, ...]
    sync_state: str


class FlowImportError(ValueError):
    """Raised when a function cannot be represented by the visual flow model."""


@dataclass
class _ImportedBlock:
    root_id: str | None
    continuation: tuple[str, str] | None = None


@dataclass
class _ImportBuilder:
    symbol_id: str
    relative_path: str
    qualname: str
    function_inputs: list[FlowFunctionInput]
    nodes: list[FlowModelNode]
    edges: list[FlowModelEdge]
    input_slots: list[FlowInputSlot]
    input_bindings: list[FlowInputBinding]
    definitions: dict[str, str]
    next_index: int = 0

    def create_node(
        self,
        kind: str,
        payload: dict[str, Any],
        *,
        indexed_node_id: str | None = None,
    ) -> str:
        node_id = f"flowdoc:{self.symbol_id}:{kind}:{self.next_index}"
        resolved_indexed_node_id = indexed_node_id
        if resolved_indexed_node_id is None:
            resolved_indexed_node_id = indexed_flow_statement_node_id(
                self.symbol_id,
                self.next_index,
            )
        self.next_index += 1
        self.nodes.append(
            FlowModelNode(
                node_id=node_id,
                kind=kind,
                payload=payload,
                indexed_node_id=resolved_indexed_node_id,
            )
        )
        return node_id

    def connect(self, source_id: str, source_handle: str, target_id: str) -> None:
        self.edges.append(
            FlowModelEdge(
                edge_id=flow_edge_id(source_id, source_handle, target_id, "in"),
                source_id=source_id,
                source_handle=source_handle,
                target_id=target_id,
                target_handle="in",
            )
        )

    def bind_function_input_slots(self, node_id: str, statement: ast.stmt | ast.expr) -> None:
        node = next((candidate for candidate in self.nodes if candidate.node_id == node_id), None)
        if node is None:
            return

        function_input_by_id = {
            function_input.input_id: function_input
            for function_input in self.function_inputs
        }
        existing_slot_ids = {slot.slot_id for slot in self.input_slots}
        existing_binding_ids = {binding.binding_id for binding in self.input_bindings}
        used_names = sorted(_names_used(statement))
        for used_name in used_names:
            definition_id = self.definitions.get(used_name)
            if definition_id not in function_input_by_id:
                continue
            source_identity = flow_model_node_source_identity(node)
            slot_id = flow_input_slot_id(source_identity, used_name)
            if slot_id not in existing_slot_ids:
                self.input_slots.append(
                    FlowInputSlot(
                        slot_id=slot_id,
                        node_id=node.node_id,
                        slot_key=used_name,
                        label=used_name,
                    )
                )
                existing_slot_ids.add(slot_id)
            binding_id = flow_input_binding_id(slot_id, definition_id)
            if binding_id not in existing_binding_ids:
                self.input_bindings.append(
                    FlowInputBinding(
                        binding_id=binding_id,
                        function_input_id=definition_id,
                        slot_id=slot_id,
                    )
                )
                existing_binding_ids.add(binding_id)

    def record_assigned_names(self, statement: ast.stmt) -> None:
        for assigned_name in _assigned_names(statement):
            self.definitions[assigned_name] = ""


def flow_models_path(root_path: Path) -> Path:
    return root_path / FLOW_MODEL_RELATIVE_PATH


def flow_edge_id(
    source_id: str,
    source_handle: str,
    target_id: str,
    target_handle: str,
) -> str:
    return f"controls:{source_id}:{source_handle}->{target_id}:{target_handle}"


def indexed_flow_entry_node_id(symbol_id: str) -> str:
    return f"flow:{symbol_id}:entry"


def indexed_flow_statement_node_id(symbol_id: str, statement_index: int) -> str:
    return f"flow:{symbol_id}:statement:{statement_index}"


def flow_function_input_id(symbol_id: str, name: str) -> str:
    return f"flowinput:{symbol_id}:{name}"


def flow_input_slot_id(node_source_identity: str, slot_key: str) -> str:
    return f"flowslot:{node_source_identity}:{slot_key}"


def flow_input_binding_id(slot_id: str, function_input_id: str) -> str:
    return f"flowbinding:{slot_id}->{function_input_id}"


def flow_model_node_source_identity(node: FlowModelNode) -> str:
    return node.indexed_node_id or node.node_id


def _flow_model_node_identity_candidates(node: FlowModelNode) -> tuple[str, ...]:
    return tuple(dict.fromkeys((flow_model_node_source_identity(node), node.node_id)))


def read_flow_document(root_path: Path, symbol_id: str) -> FlowModelDocument | None:
    storage_path = flow_models_path(root_path)
    if not storage_path.exists():
        return None

    raw = json.loads(storage_path.read_text(encoding="utf-8"))
    symbols = raw.get("symbols")
    if not isinstance(symbols, dict):
        return None
    payload = symbols.get(symbol_id)
    if not isinstance(payload, dict):
        return None
    return flow_document_from_payload(payload)


def write_flow_document(root_path: Path, document: FlowModelDocument) -> None:
    storage_path = flow_models_path(root_path)
    storage_path.parent.mkdir(parents=True, exist_ok=True)
    payload: dict[str, Any] = {"version": FLOW_MODEL_VERSION, "symbols": {}}
    if storage_path.exists():
        existing = json.loads(storage_path.read_text(encoding="utf-8"))
        if isinstance(existing, dict):
            payload.update(existing)
            payload["version"] = FLOW_MODEL_VERSION
            payload["symbols"] = dict(existing.get("symbols") or {})
    payload["symbols"][document.symbol_id] = document.to_dict()
    storage_path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


def flow_document_from_payload(payload: dict[str, Any]) -> FlowModelDocument:
    symbol_id = str(payload.get("symbol_id") or "").strip()
    relative_path = str(payload.get("relative_path") or "").strip()
    qualname = str(payload.get("qualname") or "").strip()
    if not symbol_id or not relative_path or not qualname:
        raise ValueError("Flow graph payload is missing identity fields.")

    raw_nodes = payload.get("nodes")
    if not isinstance(raw_nodes, list):
        raise ValueError("Flow graph payload requires a node list.")
    raw_edges = payload.get("edges")
    if not isinstance(raw_edges, list):
        raise ValueError("Flow graph payload requires an edge list.")

    nodes: list[FlowModelNode] = []
    seen_node_ids: set[str] = set()
    for raw_node in raw_nodes:
        if not isinstance(raw_node, dict):
            raise ValueError("Flow graph nodes must be objects.")
        node_id = str(raw_node.get("id") or "").strip()
        kind = str(raw_node.get("kind") or "").strip()
        payload_value = raw_node.get("payload") or {}
        indexed_node_id = raw_node.get("indexed_node_id")
        if not node_id or kind not in FLOW_NODE_KINDS:
            raise ValueError("Flow graph nodes require a valid id and supported document kind.")
        if node_id in seen_node_ids:
            raise ValueError(f"Duplicate flow node id '{node_id}'.")
        if not isinstance(payload_value, dict):
            raise ValueError("Flow graph node payloads must be objects.")
        if indexed_node_id is not None and not isinstance(indexed_node_id, str):
            raise ValueError("Flow graph node 'indexed_node_id' values must be strings when provided.")
        seen_node_ids.add(node_id)
        nodes.append(
            FlowModelNode(
                node_id=node_id,
                kind=kind,
                payload=dict(payload_value),
                indexed_node_id=indexed_node_id.strip() or None if isinstance(indexed_node_id, str) else None,
            )
        )

    edges: list[FlowModelEdge] = []
    seen_edge_ids: set[str] = set()
    for raw_edge in raw_edges:
        if not isinstance(raw_edge, dict):
            raise ValueError("Flow graph edges must be objects.")
        edge_id = str(raw_edge.get("id") or "").strip()
        source_id = str(raw_edge.get("source_id") or "").strip()
        source_handle = str(raw_edge.get("source_handle") or "").strip()
        target_id = str(raw_edge.get("target_id") or "").strip()
        target_handle = str(raw_edge.get("target_handle") or "").strip()
        if not edge_id or not source_id or not source_handle or not target_id or not target_handle:
            raise ValueError("Flow graph edges require id, endpoints, and handles.")
        if edge_id in seen_edge_ids:
            raise ValueError(f"Duplicate flow edge id '{edge_id}'.")
        seen_edge_ids.add(edge_id)
        edges.append(
            FlowModelEdge(
                edge_id=edge_id,
                source_id=source_id,
                source_handle=source_handle,
                target_id=target_id,
                target_handle=target_handle,
            )
        )

    function_inputs: list[FlowFunctionInput] = []
    seen_function_input_ids: set[str] = set()
    raw_function_inputs = payload.get("function_inputs") or []
    if not isinstance(raw_function_inputs, list):
        raise ValueError("Flow graph payload field 'function_inputs' must be a list when provided.")
    for raw_input in raw_function_inputs:
        if not isinstance(raw_input, dict):
            raise ValueError("Flow graph function inputs must be objects.")
        input_id = str(raw_input.get("id") or "").strip()
        name = str(raw_input.get("name") or "").strip()
        index = raw_input.get("index")
        if not input_id or not name or not isinstance(index, int):
            raise ValueError("Flow graph function inputs require id, name, and integer index.")
        if input_id in seen_function_input_ids:
            raise ValueError(f"Duplicate flow function input id '{input_id}'.")
        seen_function_input_ids.add(input_id)
        function_inputs.append(FlowFunctionInput(input_id=input_id, name=name, index=index))

    input_slots: list[FlowInputSlot] = []
    seen_slot_ids: set[str] = set()
    raw_input_slots = payload.get("input_slots") or []
    if not isinstance(raw_input_slots, list):
        raise ValueError("Flow graph payload field 'input_slots' must be a list when provided.")
    for raw_slot in raw_input_slots:
        if not isinstance(raw_slot, dict):
            raise ValueError("Flow graph input slots must be objects.")
        slot_id = str(raw_slot.get("id") or "").strip()
        slot_node_id = str(raw_slot.get("node_id") or "").strip()
        slot_key = str(raw_slot.get("slot_key") or "").strip()
        label = str(raw_slot.get("label") or slot_key).strip()
        required = bool(raw_slot.get("required", True))
        if not slot_id or not slot_node_id or not slot_key:
            raise ValueError("Flow graph input slots require id, node_id, and slot_key.")
        if slot_node_id not in seen_node_ids:
            continue
        if slot_id in seen_slot_ids:
            raise ValueError(f"Duplicate flow input slot id '{slot_id}'.")
        seen_slot_ids.add(slot_id)
        input_slots.append(
            FlowInputSlot(
                slot_id=slot_id,
                node_id=slot_node_id,
                slot_key=slot_key,
                label=label or slot_key,
                required=required,
            )
        )

    input_bindings: list[FlowInputBinding] = []
    seen_binding_ids: set[str] = set()
    bound_slot_ids: set[str] = set()
    raw_input_bindings = payload.get("input_bindings") or []
    if not isinstance(raw_input_bindings, list):
        raise ValueError("Flow graph payload field 'input_bindings' must be a list when provided.")
    for raw_binding in raw_input_bindings:
        if not isinstance(raw_binding, dict):
            raise ValueError("Flow graph input bindings must be objects.")
        binding_id = str(raw_binding.get("id") or "").strip()
        function_input_id = str(raw_binding.get("function_input_id") or "").strip()
        slot_id = str(raw_binding.get("slot_id") or "").strip()
        if not binding_id or not function_input_id or not slot_id:
            raise ValueError("Flow graph input bindings require id, function_input_id, and slot_id.")
        if binding_id in seen_binding_ids:
            raise ValueError(f"Duplicate flow input binding id '{binding_id}'.")
        if function_input_id not in seen_function_input_ids or slot_id not in seen_slot_ids:
            continue
        if slot_id in bound_slot_ids:
            raise ValueError(f"Flow graph input slot '{slot_id}' can only have one function input binding.")
        seen_binding_ids.add(binding_id)
        bound_slot_ids.add(slot_id)
        input_bindings.append(
            FlowInputBinding(
                binding_id=binding_id,
                function_input_id=function_input_id,
                slot_id=slot_id,
            )
        )

    sync_state = str(payload.get("sync_state") or "clean")
    if sync_state not in FLOW_SYNC_STATES:
        sync_state = "draft"
    diagnostics = tuple(str(item) for item in payload.get("diagnostics") or ())
    source_hash = payload.get("source_hash")
    editable = bool(payload.get("editable", True))
    return FlowModelDocument(
        symbol_id=symbol_id,
        relative_path=relative_path,
        qualname=qualname,
        nodes=tuple(nodes),
        edges=tuple(edges),
        function_inputs=tuple(sorted(function_inputs, key=lambda item: (item.index, item.name))),
        input_slots=tuple(input_slots),
        input_bindings=tuple(input_bindings),
        sync_state=sync_state,
        diagnostics=diagnostics,
        source_hash=str(source_hash) if isinstance(source_hash, str) and source_hash else None,
        editable=editable,
    )


def with_flow_document_status(
    document: FlowModelDocument,
    *,
    sync_state: str,
    diagnostics: tuple[str, ...],
    source_hash: str | None,
    editable: bool = True,
) -> FlowModelDocument:
    return replace(
        document,
        sync_state=sync_state,
        diagnostics=diagnostics,
        source_hash=source_hash,
        editable=editable,
    )


def with_flow_document_derived_input_model(
    document: FlowModelDocument,
    *,
    preserve_existing: bool = True,
) -> FlowModelDocument:
    if not document.function_inputs:
        return document

    function_input_by_name = {
        function_input.name: function_input
        for function_input in document.function_inputs
    }
    function_input_ids = {function_input.input_id for function_input in document.function_inputs}
    node_by_id = {node.node_id: node for node in document.nodes}
    existing_slot_by_node_key = {
        (slot.node_id, slot.slot_key): slot
        for slot in document.input_slots
    } if preserve_existing else {}
    existing_binding_by_slot_id = {
        binding.slot_id: binding
        for binding in document.input_bindings
    } if preserve_existing else {}

    ordered_node_ids = list(flow_document_compile_order_node_ids(document))
    ordered_node_ids.extend(
        node.node_id
        for node in document.nodes
        if node.kind not in {"entry", "exit"} and node.node_id not in ordered_node_ids
    )

    definitions: dict[str, str] = {
        function_input.name: function_input.input_id
        for function_input in document.function_inputs
    }
    next_slots: list[FlowInputSlot] = []
    next_bindings: list[FlowInputBinding] = []
    seen_slot_ids: set[str] = set()
    seen_bound_slot_ids: set[str] = set()

    for node_id in ordered_node_ids:
        node = node_by_id.get(node_id)
        if node is None:
            continue
        for used_name in sorted(_names_used_by_flow_node_payload(node)):
            definition_id = definitions.get(used_name)
            if definition_id not in function_input_ids:
                continue
            source_identity = flow_model_node_source_identity(node)
            existing_slot = existing_slot_by_node_key.get((node.node_id, used_name))
            slot_id = existing_slot.slot_id if existing_slot else flow_input_slot_id(source_identity, used_name)
            if slot_id in seen_slot_ids:
                continue
            slot = FlowInputSlot(
                slot_id=slot_id,
                node_id=node.node_id,
                slot_key=used_name,
                label=existing_slot.label if existing_slot else used_name,
                required=existing_slot.required if existing_slot else True,
            )
            next_slots.append(slot)
            seen_slot_ids.add(slot.slot_id)

            existing_binding = existing_binding_by_slot_id.get(slot.slot_id)
            if existing_slot and existing_binding is None:
                continue
            function_input_id = (
                existing_binding.function_input_id
                if existing_binding and existing_binding.function_input_id in function_input_ids
                else definition_id
            )
            if function_input_id not in function_input_ids or slot.slot_id in seen_bound_slot_ids:
                continue
            next_bindings.append(
                FlowInputBinding(
                    binding_id=existing_binding.binding_id
                    if existing_binding
                    else flow_input_binding_id(slot.slot_id, function_input_id),
                    function_input_id=function_input_id,
                    slot_id=slot.slot_id,
                )
            )
            seen_bound_slot_ids.add(slot.slot_id)

        for assigned_name in _assigned_names_by_flow_node_payload(node):
            definitions[assigned_name] = ""

    return replace(
        document,
        input_slots=tuple(next_slots),
        input_bindings=tuple(next_bindings),
    )


def with_flow_document_inherited_input_model(
    document: FlowModelDocument,
    *,
    source_document: FlowModelDocument,
) -> FlowModelDocument:
    """Backfill legacy editable flow input bindings from source-backed semantics.

    Older persisted flow documents only stored authored control flow. When those
    documents have no canonical input slots, derive the missing function-input
    model from the current imported source document instead of parsing draft
    payload text.
    """

    source_function_inputs = source_document.function_inputs
    if not source_function_inputs:
        return document

    if document.input_slots:
        if document.function_inputs:
            return document
        return replace(document, function_inputs=source_function_inputs)

    existing_input_by_name = {
        function_input.name: function_input
        for function_input in document.function_inputs
    }
    next_function_inputs = tuple(
        FlowFunctionInput(
            input_id=existing_input_by_name.get(source_input.name, source_input).input_id,
            name=source_input.name,
            index=source_input.index,
        )
        for source_input in source_function_inputs
    )
    next_input_by_name = {
        function_input.name: function_input
        for function_input in next_function_inputs
    }

    source_node_by_id = {node.node_id: node for node in source_document.nodes}
    document_node_by_identity: dict[str, FlowModelNode] = {}
    for node in document.nodes:
        for identity in _flow_model_node_identity_candidates(node):
            document_node_by_identity.setdefault(identity, node)

    indexed_node_id_by_node_id: dict[str, str] = {}
    for source_node in source_document.nodes:
        if not source_node.indexed_node_id:
            continue
        for identity in _flow_model_node_identity_candidates(source_node):
            document_node = document_node_by_identity.get(identity)
            if document_node is not None:
                indexed_node_id_by_node_id[document_node.node_id] = source_node.indexed_node_id
                break

    slot_id_by_source_slot_id: dict[str, str] = {}
    next_slots: list[FlowInputSlot] = []
    seen_slot_ids: set[str] = set()
    for source_slot in source_document.input_slots:
        source_node = source_node_by_id.get(source_slot.node_id)
        if source_node is None:
            continue
        target_node = None
        for identity in _flow_model_node_identity_candidates(source_node):
            target_node = document_node_by_identity.get(identity)
            if target_node is not None:
                break
        if target_node is None:
            continue

        slot_id = flow_input_slot_id(flow_model_node_source_identity(source_node), source_slot.slot_key)
        slot_id_by_source_slot_id[source_slot.slot_id] = slot_id
        if slot_id in seen_slot_ids:
            continue
        seen_slot_ids.add(slot_id)
        next_slots.append(
            FlowInputSlot(
                slot_id=slot_id,
                node_id=target_node.node_id,
                slot_key=source_slot.slot_key,
                label=source_slot.label,
                required=source_slot.required,
            )
        )

    source_input_by_id = {
        function_input.input_id: function_input
        for function_input in source_function_inputs
    }
    next_bindings: list[FlowInputBinding] = []
    seen_bound_slot_ids: set[str] = set()
    for source_binding in source_document.input_bindings:
        slot_id = slot_id_by_source_slot_id.get(source_binding.slot_id)
        source_input = source_input_by_id.get(source_binding.function_input_id)
        if slot_id is None or source_input is None:
            continue
        function_input = next_input_by_name.get(source_input.name)
        if function_input is None or slot_id in seen_bound_slot_ids:
            continue
        seen_bound_slot_ids.add(slot_id)
        next_bindings.append(
            FlowInputBinding(
                binding_id=flow_input_binding_id(slot_id, function_input.input_id),
                function_input_id=function_input.input_id,
                slot_id=slot_id,
            )
        )

    next_nodes = tuple(
        replace(
            node,
            indexed_node_id=indexed_node_id_by_node_id.get(node.node_id, node.indexed_node_id),
        )
        for node in document.nodes
    )

    return replace(
        document,
        nodes=next_nodes,
        function_inputs=next_function_inputs,
        input_slots=tuple(next_slots),
        input_bindings=tuple(next_bindings),
    )


def with_flow_document_applied_input_bindings(
    document: FlowModelDocument,
) -> FlowModelDocument:
    if not document.function_inputs or not document.input_slots or not document.input_bindings:
        return document

    function_input_by_id = {
        function_input.input_id: function_input
        for function_input in document.function_inputs
    }
    slot_by_id = {slot.slot_id: slot for slot in document.input_slots}
    replacements_by_node_id: dict[str, dict[str, str]] = {}
    for binding in document.input_bindings:
        slot = slot_by_id.get(binding.slot_id)
        function_input = function_input_by_id.get(binding.function_input_id)
        if slot is None or function_input is None:
            continue
        if slot.slot_key == function_input.name:
            continue
        replacements_by_node_id.setdefault(slot.node_id, {})[slot.slot_key] = function_input.name

    if not replacements_by_node_id:
        return document

    return replace(
        document,
        nodes=tuple(
            replace(
                node,
                payload=_rewrite_flow_node_payload_input_names(
                    node,
                    replacements_by_node_id.get(node.node_id, {}),
                ),
            )
            if node.node_id in replacements_by_node_id
            else node
            for node in document.nodes
        ),
    )


def function_source_hash(source: str) -> str:
    normalized = source.replace("\r\n", "\n")
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def function_source_for_qualname(module_source: str, qualname: str) -> str:
    tree = ast.parse(module_source)
    node = find_ast_symbol(tree, qualname)
    if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        raise ValueError(f"Unable to resolve function source for {qualname}.")
    source_segment = ast.get_source_segment(module_source, node)
    if not source_segment:
        raise ValueError(f"Unable to recover exact function source for {qualname}.")
    return source_segment


def find_ast_symbol(tree: ast.AST, qualname: str) -> ast.AST | None:
    parts = qualname.split(".")
    candidates: list[ast.AST] = list(getattr(tree, "body", []))
    current: ast.AST | None = None
    for part in parts:
        current = None
        next_candidates: list[ast.AST] = []
        for candidate in candidates:
            if isinstance(candidate, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and candidate.name == part:
                current = candidate
                next_candidates = list(getattr(candidate, "body", []))
                break
        if current is None:
            return None
        candidates = next_candidates
    return current


def _function_inputs_for_ast_function(
    symbol_id: str,
    function_node: ast.FunctionDef | ast.AsyncFunctionDef,
) -> tuple[FlowFunctionInput, ...]:
    positional_args = [
        *function_node.args.posonlyargs,
        *function_node.args.args,
    ]
    all_args = [
        *positional_args,
        *function_node.args.kwonlyargs,
    ]
    if function_node.args.vararg is not None:
        all_args.append(function_node.args.vararg)
    if function_node.args.kwarg is not None:
        all_args.append(function_node.args.kwarg)
    return tuple(
        FlowFunctionInput(
            input_id=flow_function_input_id(symbol_id, argument.arg),
            name=argument.arg,
            index=index,
        )
        for index, argument in enumerate(all_args)
    )


def function_inputs_from_function_source(
    *,
    symbol_id: str,
    qualname: str,
    module_source: str,
) -> tuple[FlowFunctionInput, ...]:
    tree = ast.parse(module_source)
    function_node = find_ast_symbol(tree, qualname)
    if not isinstance(function_node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        return ()
    return _function_inputs_for_ast_function(symbol_id, function_node)


def import_flow_document_from_function_source(
    *,
    symbol_id: str,
    relative_path: str,
    qualname: str,
    module_source: str,
) -> FlowModelDocument:
    tree = ast.parse(module_source)
    function_node = find_ast_symbol(tree, qualname)
    if not isinstance(function_node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        raise FlowImportError(f"Unable to resolve flow for {qualname}.")

    function_inputs = _function_inputs_for_ast_function(symbol_id, function_node)
    builder = _ImportBuilder(
        symbol_id=symbol_id,
        relative_path=relative_path,
        qualname=qualname,
        function_inputs=list(function_inputs),
        nodes=[
            FlowModelNode(
                node_id=f"flowdoc:{symbol_id}:entry",
                kind="entry",
                payload={},
                indexed_node_id=indexed_flow_entry_node_id(symbol_id),
            ),
            FlowModelNode(node_id=f"flowdoc:{symbol_id}:exit", kind="exit", payload={}),
        ],
        edges=[],
        input_slots=[],
        input_bindings=[],
        definitions={
            function_input.name: function_input.input_id
            for function_input in function_inputs
        },
    )
    entry_id = builder.nodes[0].node_id
    exit_id = builder.nodes[1].node_id
    imported = _import_block(builder, function_node.body)
    if imported.root_id:
        builder.connect(entry_id, "start", imported.root_id)
        if imported.continuation:
            builder.connect(imported.continuation[0], imported.continuation[1], exit_id)
    else:
        builder.connect(entry_id, "start", exit_id)

    function_source = function_source_for_qualname(module_source, qualname)
    return FlowModelDocument(
        symbol_id=symbol_id,
        relative_path=relative_path,
        qualname=qualname,
        nodes=tuple(builder.nodes),
        edges=tuple(builder.edges),
        function_inputs=tuple(function_inputs),
        input_slots=tuple(builder.input_slots),
        input_bindings=tuple(builder.input_bindings),
        sync_state="clean",
        diagnostics=(),
        source_hash=function_source_hash(function_source),
        editable=True,
    )


def _import_block(
    builder: _ImportBuilder,
    statements: list[ast.stmt],
) -> _ImportedBlock:
    block = _ImportedBlock(root_id=None, continuation=None)
    for statement in statements:
        imported = _import_statement(builder, statement)
        if imported.root_id is None:
            continue
        if block.root_id is None:
            block.root_id = imported.root_id
        if block.continuation is not None:
            builder.connect(block.continuation[0], block.continuation[1], imported.root_id)
        block.continuation = imported.continuation
    return block


def _import_statement(
    builder: _ImportBuilder,
    statement: ast.stmt,
) -> _ImportedBlock:
    if isinstance(statement, ast.Pass):
        return _ImportedBlock(root_id=None, continuation=None)

    if isinstance(statement, ast.Return):
        node_id = builder.create_node(
            "return",
            {"expression": ast.unparse(statement.value) if statement.value is not None else ""},
        )
        if statement.value is not None:
            builder.bind_function_input_slots(node_id, statement.value)
        return _ImportedBlock(root_id=node_id, continuation=None)

    if isinstance(statement, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
        node_id = builder.create_node("assign", {"source": ast.unparse(statement)})
        builder.bind_function_input_slots(node_id, statement)
        builder.record_assigned_names(statement)
        return _ImportedBlock(root_id=node_id, continuation=(node_id, "next"))

    if isinstance(statement, ast.Expr):
        if _is_docstring_expression(statement):
            return _ImportedBlock(root_id=None, continuation=None)
        if any(isinstance(node, ast.Call) for node in ast.walk(statement)):
            node_id = builder.create_node("call", {"source": ast.unparse(statement)})
            builder.bind_function_input_slots(node_id, statement)
            return _ImportedBlock(root_id=node_id, continuation=(node_id, "next"))
        raise FlowImportError("Expression statements without a call are not supported in visual flow mode.")

    if isinstance(statement, ast.If):
        node_id = builder.create_node("branch", {"condition": ast.unparse(statement.test)})
        builder.bind_function_input_slots(node_id, statement.test)
        true_block = _import_block(builder, statement.body)
        false_block = _import_block(builder, statement.orelse)
        if true_block.root_id:
            builder.connect(node_id, "true", true_block.root_id)
        if false_block.root_id:
            builder.connect(node_id, "false", false_block.root_id)
        return _ImportedBlock(root_id=node_id, continuation=(node_id, "after"))

    if isinstance(statement, ast.While):
        node_id = builder.create_node("loop", {"header": f"while {ast.unparse(statement.test)}"})
        builder.bind_function_input_slots(node_id, statement.test)
        body_block = _import_block(builder, statement.body)
        if body_block.root_id:
            builder.connect(node_id, "body", body_block.root_id)
        return _ImportedBlock(root_id=node_id, continuation=(node_id, "after"))

    if isinstance(statement, ast.For):
        header = f"for {ast.unparse(statement.target)} in {ast.unparse(statement.iter)}"
        node_id = builder.create_node("loop", {"header": header})
        builder.bind_function_input_slots(node_id, statement.iter)
        for assigned_name in _assigned_names(statement):
            builder.definitions[assigned_name] = ""
        body_block = _import_block(builder, statement.body)
        if body_block.root_id:
            builder.connect(node_id, "body", body_block.root_id)
        return _ImportedBlock(root_id=node_id, continuation=(node_id, "after"))

    raise FlowImportError(
        f"Visual flow mode does not support importing {statement.__class__.__name__} yet."
    )


def compile_flow_document(document: FlowModelDocument) -> FlowCompileResult:
    document = with_flow_document_derived_input_model(document)
    node_by_id = {node.node_id: node for node in document.nodes}
    diagnostics: list[str] = []
    entry_node = next((node for node in document.nodes if node.kind == "entry"), None)
    exit_node = next((node for node in document.nodes if node.kind == "exit"), None)
    if entry_node is None or exit_node is None:
        diagnostics.append("Flow documents must include entry and exit nodes.")
        return FlowCompileResult(
            document=with_flow_document_status(
                document,
                sync_state="draft",
                diagnostics=tuple(diagnostics),
                source_hash=document.source_hash,
                editable=document.editable,
            ),
            body_source=None,
            diagnostics=tuple(diagnostics),
            sync_state="draft",
        )

    output_edges: dict[tuple[str, str], FlowModelEdge] = {}
    target_counts: dict[tuple[str, str], int] = {}
    allowed_input_counts = {"exit": None}
    for edge in document.edges:
        if edge.source_id not in node_by_id or edge.target_id not in node_by_id:
            diagnostics.append(f"Flow edge '{edge.edge_id}' points at an unknown node.")
            continue
        source_node = node_by_id[edge.source_id]
        target_node = node_by_id[edge.target_id]
        if edge.source_handle not in allowed_flow_output_handles(source_node.kind):
            diagnostics.append(
                f"{source_node.kind} node '{source_node.node_id}' cannot use output '{edge.source_handle}'."
            )
            continue
        if edge.target_handle not in allowed_flow_input_handles(target_node.kind):
            diagnostics.append(
                f"{target_node.kind} node '{target_node.node_id}' cannot use input '{edge.target_handle}'."
            )
            continue
        output_key = (edge.source_id, edge.source_handle)
        if output_key in output_edges:
            diagnostics.append(
                f"Output '{edge.source_handle}' on node '{edge.source_id}' can only have one connection."
            )
            continue
        output_edges[output_key] = edge
        target_key = (edge.target_id, edge.target_handle)
        target_counts[target_key] = target_counts.get(target_key, 0) + 1

    for node in document.nodes:
        if node.kind == "entry":
            continue
        target_count = target_counts.get((node.node_id, "in"), 0)
        if node.kind != "exit" and target_count > 1:
            diagnostics.append(f"Node '{node.node_id}' can only accept one inbound control connection.")

    reachable = reachable_flow_node_ids(document)
    visible_node_ids = {
        node.node_id
        for node in document.nodes
        if node.kind not in {"entry", "exit"}
    }
    unreachable = sorted(visible_node_ids - reachable)
    if unreachable:
        diagnostics.append(
            f"Unreachable flow nodes block code generation: {', '.join(unreachable)}."
        )

    for node in document.nodes:
        diagnostics.extend(_validate_node_payload(node, output_edges))

    bound_slot_ids = {binding.slot_id for binding in document.input_bindings}
    for slot in document.input_slots:
        if slot.required and slot.slot_id not in bound_slot_ids:
            diagnostics.append(
                f"Input slot '{slot.label}' on node '{slot.node_id}' needs a function input binding."
            )

    if diagnostics:
        normalized = with_flow_document_status(
            document,
            sync_state="draft",
            diagnostics=tuple(dict.fromkeys(diagnostics)),
            source_hash=document.source_hash,
            editable=document.editable,
        )
        return FlowCompileResult(
            document=normalized,
            body_source=None,
            diagnostics=normalized.diagnostics,
            sync_state="draft",
        )

    document = with_flow_document_derived_input_model(
        with_flow_document_applied_input_bindings(document),
        preserve_existing=False,
    )
    node_by_id = {node.node_id: node for node in document.nodes}
    output_edges = {(edge.source_id, edge.source_handle): edge for edge in document.edges}
    body_lines = _compile_sequence(
        start_node_id=target_id_for_edge(output_edges.get((entry_node.node_id, "start"))),
        exit_node_id=exit_node.node_id,
        node_by_id=node_by_id,
        output_edges=output_edges,
    )
    body_source = "\n".join(body_lines or ["pass"])
    normalized = with_flow_document_status(
        document,
        sync_state="clean",
        diagnostics=(),
        source_hash=document.source_hash,
        editable=document.editable,
    )
    return FlowCompileResult(
        document=normalized,
        body_source=body_source,
        diagnostics=(),
        sync_state="clean",
    )


def target_id_for_edge(edge: FlowModelEdge | None) -> str | None:
    if edge is None:
        return None
    return edge.target_id


def reachable_flow_node_ids(document: FlowModelDocument) -> set[str]:
    node_by_id = {node.node_id: node for node in document.nodes}
    output_edges = {(edge.source_id, edge.source_handle): edge for edge in document.edges}
    entry_node = next((node for node in document.nodes if node.kind == "entry"), None)
    if entry_node is None:
        return set()

    stack = [target_id_for_edge(output_edges.get((entry_node.node_id, "start")))]
    reachable: set[str] = set()
    while stack:
        node_id = stack.pop()
        if node_id is None or node_id in reachable:
            continue
        node = node_by_id.get(node_id)
        if node is None:
            continue
        reachable.add(node_id)
        for handle in allowed_flow_output_handles(node.kind):
            stack.append(target_id_for_edge(output_edges.get((node_id, handle))))
    return reachable


def allowed_flow_output_handles(kind: str) -> tuple[str, ...]:
    if kind == "entry":
        return ("start",)
    if kind in {"assign", "call"}:
        return ("next",)
    if kind == "branch":
        return ("true", "false", "after")
    if kind == "loop":
        return ("body", "after")
    return ()


def allowed_flow_input_handles(kind: str) -> tuple[str, ...]:
    if kind in {"entry"}:
        return ()
    return ("in",)


def _is_docstring_expression(statement: ast.Expr) -> bool:
    value = statement.value
    if isinstance(value, ast.Constant):
        return isinstance(value.value, str)
    return isinstance(value, ast.Str)


def _names_used(node: ast.AST) -> set[str]:
    return {
        candidate.id
        for candidate in ast.walk(node)
        if isinstance(candidate, ast.Name) and isinstance(candidate.ctx, ast.Load)
    }


def _assigned_names(statement: ast.stmt) -> set[str]:
    assigned: set[str] = set()
    targets: list[ast.AST] = []
    if isinstance(statement, ast.Assign):
        targets.extend(statement.targets)
    elif isinstance(statement, ast.AnnAssign):
        targets.append(statement.target)
    elif isinstance(statement, ast.AugAssign):
        targets.append(statement.target)
    elif isinstance(statement, (ast.For, ast.AsyncFor)):
        targets.append(statement.target)
    for target in targets:
        for node in ast.walk(target):
            if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
                assigned.add(node.id)
    return assigned


def _names_used_by_flow_node_payload(node: FlowModelNode) -> set[str]:
    try:
        if node.kind in {"assign", "call"}:
            parsed = ast.parse(f"{str(node.payload.get('source') or '').strip()}\n").body
            return _names_used(parsed[0]) if parsed else set()
        if node.kind == "branch":
            expression = ast.parse(str(node.payload.get("condition") or ""), mode="eval")
            return _names_used(expression)
        if node.kind == "loop":
            header = str(node.payload.get("header") or "").strip().rstrip(":")
            parsed = ast.parse(f"{header}:\n    pass\n").body
            if not parsed:
                return set()
            statement = parsed[0]
            if isinstance(statement, ast.While):
                return _names_used(statement.test)
            if isinstance(statement, ast.For):
                return _names_used(statement.iter)
            return set()
        if node.kind == "return":
            expression = str(node.payload.get("expression") or "").strip()
            if not expression:
                return set()
            return _names_used(ast.parse(expression, mode="eval"))
    except SyntaxError:
        return set()
    return set()


def _assigned_names_by_flow_node_payload(node: FlowModelNode) -> set[str]:
    try:
        if node.kind == "assign":
            parsed = ast.parse(f"{str(node.payload.get('source') or '').strip()}\n").body
            return _assigned_names(parsed[0]) if parsed else set()
        if node.kind == "loop":
            header = str(node.payload.get("header") or "").strip().rstrip(":")
            parsed = ast.parse(f"{header}:\n    pass\n").body
            return _assigned_names(parsed[0]) if parsed else set()
    except SyntaxError:
        return set()
    return set()


class _InputNameRewriteTransformer(ast.NodeTransformer):
    def __init__(self, replacements: dict[str, str]) -> None:
        self.replacements = replacements

    def visit_Name(self, node: ast.Name) -> ast.AST:
        if isinstance(node.ctx, ast.Load) and node.id in self.replacements:
            return ast.copy_location(ast.Name(id=self.replacements[node.id], ctx=node.ctx), node)
        return node


def _rewrite_ast_input_names(node: ast.AST, replacements: dict[str, str]) -> ast.AST:
    rewritten = _InputNameRewriteTransformer(replacements).visit(node)
    ast.fix_missing_locations(rewritten)
    return rewritten


def _rewrite_flow_node_payload_input_names(
    node: FlowModelNode,
    replacements: dict[str, str],
) -> dict[str, Any]:
    if not replacements:
        return node.payload
    try:
        if node.kind in {"assign", "call"}:
            parsed = ast.parse(f"{str(node.payload.get('source') or '').strip()}\n").body
            if len(parsed) != 1:
                return node.payload
            rewritten = _rewrite_ast_input_names(parsed[0], replacements)
            return {**node.payload, "source": ast.unparse(rewritten)}
        if node.kind == "branch":
            expression = str(node.payload.get("condition") or "").strip()
            parsed = ast.parse(expression, mode="eval")
            rewritten = _rewrite_ast_input_names(parsed.body, replacements)
            return {**node.payload, "condition": ast.unparse(rewritten)}
        if node.kind == "loop":
            header = str(node.payload.get("header") or "").strip().rstrip(":")
            parsed = ast.parse(f"{header}:\n    pass\n").body
            if len(parsed) != 1:
                return node.payload
            statement = _rewrite_ast_input_names(parsed[0], replacements)
            if isinstance(statement, ast.While):
                return {**node.payload, "header": f"while {ast.unparse(statement.test)}"}
            if isinstance(statement, ast.For):
                return {
                    **node.payload,
                    "header": f"for {ast.unparse(statement.target)} in {ast.unparse(statement.iter)}",
                }
            return node.payload
        if node.kind == "return":
            expression = str(node.payload.get("expression") or "").strip()
            if not expression:
                return node.payload
            parsed = ast.parse(expression, mode="eval")
            rewritten = _rewrite_ast_input_names(parsed.body, replacements)
            return {**node.payload, "expression": ast.unparse(rewritten)}
    except SyntaxError:
        return node.payload
    return node.payload


def _validate_node_payload(
    node: FlowModelNode,
    output_edges: dict[tuple[str, str], FlowModelEdge],
) -> list[str]:
    payload = node.payload
    diagnostics: list[str] = []
    if node.kind == "assign":
        source = str(payload.get("source") or "").strip()
        if not source:
            diagnostics.append(f"Assign node '{node.node_id}' needs a statement.")
            return diagnostics
        try:
            parsed = ast.parse(f"{source}\n").body
        except SyntaxError as exc:
            diagnostics.append(f"Assign node '{node.node_id}' has invalid Python: {exc.msg}.")
            return diagnostics
        if len(parsed) != 1 or not isinstance(parsed[0], (ast.Assign, ast.AnnAssign, ast.AugAssign)):
            diagnostics.append(f"Assign node '{node.node_id}' must contain one assignment statement.")
    elif node.kind == "call":
        source = str(payload.get("source") or "").strip()
        if not source:
            diagnostics.append(f"Call node '{node.node_id}' needs a statement.")
            return diagnostics
        try:
            parsed = ast.parse(f"{source}\n").body
        except SyntaxError as exc:
            diagnostics.append(f"Call node '{node.node_id}' has invalid Python: {exc.msg}.")
            return diagnostics
        if len(parsed) != 1 or not isinstance(parsed[0], ast.Expr) or not any(
            isinstance(inner, ast.Call) for inner in ast.walk(parsed[0])
        ):
            diagnostics.append(f"Call node '{node.node_id}' must contain one call expression statement.")
    elif node.kind == "branch":
        condition = str(payload.get("condition") or "").strip()
        if not condition:
            diagnostics.append(f"Branch node '{node.node_id}' needs a condition.")
        else:
            try:
                ast.parse(condition, mode="eval")
            except SyntaxError as exc:
                diagnostics.append(f"Branch node '{node.node_id}' has an invalid condition: {exc.msg}.")
    elif node.kind == "loop":
        header = str(payload.get("header") or "").strip().rstrip(":")
        if not header:
            diagnostics.append(f"Loop node '{node.node_id}' needs a header.")
        else:
            try:
                parsed = ast.parse(f"{header}:\n    pass\n").body
            except SyntaxError as exc:
                diagnostics.append(f"Loop node '{node.node_id}' has an invalid header: {exc.msg}.")
            else:
                if len(parsed) != 1 or not isinstance(parsed[0], (ast.For, ast.While)):
                    diagnostics.append(
                        f"Loop node '{node.node_id}' must start with 'while' or 'for ... in ...'."
                    )
        if (node.node_id, "body") not in output_edges:
            diagnostics.append(f"Loop node '{node.node_id}' needs a body connection.")
    elif node.kind == "return":
        expression = str(payload.get("expression") or "").strip()
        if expression:
            try:
                ast.parse(expression, mode="eval")
            except SyntaxError as exc:
                diagnostics.append(f"Return node '{node.node_id}' has an invalid expression: {exc.msg}.")
    return diagnostics


def _compile_sequence(
    *,
    start_node_id: str | None,
    exit_node_id: str,
    node_by_id: dict[str, FlowModelNode],
    output_edges: dict[tuple[str, str], FlowModelEdge],
) -> list[str]:
    lines: list[str] = []
    current_id = start_node_id
    visited: set[str] = set()
    while current_id and current_id != exit_node_id:
        if current_id in visited:
            raise ValueError(f"Cycle detected in flow graph at '{current_id}'.")
        visited.add(current_id)
        node = node_by_id[current_id]
        if node.kind == "assign":
            lines.append(str(node.payload.get("source") or "").strip())
            current_id = target_id_for_edge(output_edges.get((current_id, "next")))
            continue
        if node.kind == "call":
            lines.append(str(node.payload.get("source") or "").strip())
            current_id = target_id_for_edge(output_edges.get((current_id, "next")))
            continue
        if node.kind == "return":
            expression = str(node.payload.get("expression") or "").strip()
            lines.append(f"return {expression}" if expression else "return")
            break
        if node.kind == "branch":
            condition = str(node.payload.get("condition") or "").strip()
            true_lines = _compile_sequence(
                start_node_id=target_id_for_edge(output_edges.get((current_id, "true"))),
                exit_node_id=exit_node_id,
                node_by_id=node_by_id,
                output_edges=output_edges,
            )
            false_lines = _compile_sequence(
                start_node_id=target_id_for_edge(output_edges.get((current_id, "false"))),
                exit_node_id=exit_node_id,
                node_by_id=node_by_id,
                output_edges=output_edges,
            )
            lines.append(f"if {condition}:")
            lines.extend(_indent_lines(true_lines or ["pass"]))
            if false_lines:
                lines.append("else:")
                lines.extend(_indent_lines(false_lines))
            current_id = target_id_for_edge(output_edges.get((current_id, "after")))
            continue
        if node.kind == "loop":
            header = str(node.payload.get("header") or "").strip().rstrip(":")
            body_lines = _compile_sequence(
                start_node_id=target_id_for_edge(output_edges.get((current_id, "body"))),
                exit_node_id=exit_node_id,
                node_by_id=node_by_id,
                output_edges=output_edges,
            )
            lines.append(f"{header}:")
            lines.extend(_indent_lines(body_lines or ["pass"]))
            current_id = target_id_for_edge(output_edges.get((current_id, "after")))
            continue
        if node.kind == "exit":
            break
        raise ValueError(f"Unsupported flow node kind during compile: {node.kind}")
    return lines


def _indent_lines(lines: list[str]) -> list[str]:
    return [f"    {line}" for line in lines]


def flow_document_compile_order_node_ids(document: FlowModelDocument) -> tuple[str, ...]:
    node_by_id = {node.node_id: node for node in document.nodes}
    output_edges = {(edge.source_id, edge.source_handle): edge for edge in document.edges}
    entry_node = next((node for node in document.nodes if node.kind == "entry"), None)
    exit_node = next((node for node in document.nodes if node.kind == "exit"), None)
    if entry_node is None:
        return tuple()

    ordered: list[str] = []
    visited: set[str] = set()

    def visit(start_node_id: str | None) -> None:
        current_id = start_node_id
        while current_id and current_id != (exit_node.node_id if exit_node else None):
            if current_id in visited:
                return
            visited.add(current_id)
            node = node_by_id.get(current_id)
            if node is None:
                return
            if node.kind not in {"entry", "exit"}:
                ordered.append(node.node_id)
            if node.kind in {"assign", "call"}:
                current_id = target_id_for_edge(output_edges.get((current_id, "next")))
                continue
            if node.kind == "return":
                return
            if node.kind == "branch":
                visit(target_id_for_edge(output_edges.get((current_id, "true"))))
                visit(target_id_for_edge(output_edges.get((current_id, "false"))))
                current_id = target_id_for_edge(output_edges.get((current_id, "after")))
                continue
            if node.kind == "loop":
                visit(target_id_for_edge(output_edges.get((current_id, "body"))))
                current_id = target_id_for_edge(output_edges.get((current_id, "after")))
                continue
            return

    visit(target_id_for_edge(output_edges.get((entry_node.node_id, "start"))))
    return tuple(ordered)


def with_flow_document_indexed_node_ids(
    document: FlowModelDocument,
    *,
    source_document: FlowModelDocument,
) -> FlowModelDocument:
    source_entry = next((node for node in source_document.nodes if node.kind == "entry"), None)
    document_entry = next((node for node in document.nodes if node.kind == "entry"), None)
    indexed_node_id_by_node_id: dict[str, str] = {}
    if source_entry is not None and document_entry is not None:
        indexed_node_id_by_node_id[document_entry.node_id] = flow_model_node_source_identity(source_entry)

    source_document_order = flow_document_compile_order_node_ids(source_document)
    source_node_by_id = {node.node_id: node for node in source_document.nodes}
    source_statement_ids = [
        flow_model_node_source_identity(source_node_by_id[node_id])
        for node_id in source_document_order
        if node_id in source_node_by_id
    ]
    document_statement_ids = flow_document_compile_order_node_ids(document)
    for node_id, indexed_node_id in zip(document_statement_ids, source_statement_ids):
        indexed_node_id_by_node_id[node_id] = indexed_node_id

    normalized = replace(
        document,
        nodes=tuple(
            replace(
                node,
                indexed_node_id=indexed_node_id_by_node_id.get(node.node_id, node.indexed_node_id),
            )
            for node in document.nodes
        ),
    )
    return with_flow_document_normalized_input_ids(normalized)


def with_flow_document_normalized_input_ids(document: FlowModelDocument) -> FlowModelDocument:
    slot_id_by_old_id: dict[str, str] = {}
    node_by_id = {node.node_id: node for node in document.nodes}
    normalized_slots: list[FlowInputSlot] = []
    seen_slot_ids: set[str] = set()
    for slot in document.input_slots:
        node = node_by_id.get(slot.node_id)
        if node is None:
            continue
        next_slot_id = flow_input_slot_id(flow_model_node_source_identity(node), slot.slot_key)
        slot_id_by_old_id[slot.slot_id] = next_slot_id
        if next_slot_id in seen_slot_ids:
            continue
        seen_slot_ids.add(next_slot_id)
        normalized_slots.append(replace(slot, slot_id=next_slot_id))

    normalized_bindings: list[FlowInputBinding] = []
    seen_bound_slot_ids: set[str] = set()
    function_input_ids = {function_input.input_id for function_input in document.function_inputs}
    for binding in document.input_bindings:
        next_slot_id = slot_id_by_old_id.get(binding.slot_id)
        if next_slot_id is None or binding.function_input_id not in function_input_ids:
            continue
        if next_slot_id in seen_bound_slot_ids:
            continue
        seen_bound_slot_ids.add(next_slot_id)
        normalized_bindings.append(
            FlowInputBinding(
                binding_id=flow_input_binding_id(next_slot_id, binding.function_input_id),
                function_input_id=binding.function_input_id,
                slot_id=next_slot_id,
            )
        )

    return replace(
        document,
        input_slots=tuple(normalized_slots),
        input_bindings=tuple(normalized_bindings),
    )


def flow_node_label(node: FlowModelNode) -> str:
    if node.kind == "entry":
        return "Entry"
    if node.kind == "exit":
        return "Exit"
    if node.kind == "assign":
        source = str(node.payload.get("source") or "").strip()
        if "=" in source:
            return source.split("=", 1)[0].strip() or "Assign"
        return source or "Assign"
    if node.kind == "call":
        source = str(node.payload.get("source") or "").strip()
        return source or "Call"
    if node.kind == "branch":
        condition = str(node.payload.get("condition") or "").strip()
        return f"if {condition}" if condition else "Branch"
    if node.kind == "loop":
        header = str(node.payload.get("header") or "").strip()
        return header or "Loop"
    if node.kind == "return":
        expression = str(node.payload.get("expression") or "").strip()
        return f"return {expression}" if expression else "return"
    return node.kind.title()


def flow_edge_label(source_handle: str) -> str | None:
    if source_handle in {"true", "false", "body", "after"}:
        return source_handle
    return None


def flow_edge_order(source_handle: str) -> int | None:
    return {
        "true": 0,
        "false": 1,
        "body": 0,
        "after": 2,
    }.get(source_handle)
