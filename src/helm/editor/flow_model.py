"""Persisted visual flow model helpers."""

from __future__ import annotations

import ast
import hashlib
import json
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any


FLOW_MODEL_VERSION = 1
FLOW_VALUE_MODEL_VERSION = 1
FLOW_EXPRESSION_GRAPH_VERSION = 1
FLOW_MODEL_RELATIVE_PATH = ".helm/flow-models.v1.json"
# Parameter nodes remain projected visual support nodes in flow views. The
# persisted FlowModelDocument stores authored control-flow statements plus entry
# / exit sentinels, source-backed node identity, and first-class function-input
# bindings so editable graphs own input/value semantics.
FLOW_NODE_KINDS = {"entry", "assign", "call", "branch", "loop", "return", "exit"}
FLOW_SYNC_STATES = {"clean", "draft", "import_error"}
FLOW_FUNCTION_INPUT_KINDS = {
    "positional_only",
    "positional_or_keyword",
    "keyword_only",
    "vararg",
    "kwarg",
}
FLOW_EXPRESSION_NODE_KINDS = {
    "input",
    "literal",
    "operator",
    "unary",
    "bool",
    "compare",
    "call",
    "attribute",
    "subscript",
    "conditional",
    "collection",
    "raw",
}
_RETURN_EXPRESSION_GRAPH_KEY = "expression_graph"
_LOOP_TYPES = {"while", "for", "for_each"}

_BINOP_SYMBOLS: dict[type[ast.operator], str] = {
    ast.Add: "+",
    ast.Sub: "-",
    ast.Mult: "*",
    ast.MatMult: "@",
    ast.Div: "/",
    ast.FloorDiv: "//",
    ast.Mod: "%",
    ast.Pow: "**",
    ast.LShift: "<<",
    ast.RShift: ">>",
    ast.BitOr: "|",
    ast.BitXor: "^",
    ast.BitAnd: "&",
}
_BINOP_AST_BY_SYMBOL: dict[str, type[ast.operator]] = {
    symbol: operator_type
    for operator_type, symbol in _BINOP_SYMBOLS.items()
}
_UNARY_SYMBOLS: dict[type[ast.unaryop], str] = {
    ast.UAdd: "+",
    ast.USub: "-",
    ast.Not: "not",
    ast.Invert: "~",
}
_UNARY_AST_BY_SYMBOL: dict[str, type[ast.unaryop]] = {
    symbol: operator_type
    for operator_type, symbol in _UNARY_SYMBOLS.items()
}
_BOOL_SYMBOLS: dict[type[ast.boolop], str] = {
    ast.And: "and",
    ast.Or: "or",
}
_BOOL_AST_BY_SYMBOL: dict[str, type[ast.boolop]] = {
    symbol: operator_type
    for operator_type, symbol in _BOOL_SYMBOLS.items()
}
_COMPARE_SYMBOLS: dict[type[ast.cmpop], str] = {
    ast.Eq: "==",
    ast.NotEq: "!=",
    ast.Lt: "<",
    ast.LtE: "<=",
    ast.Gt: ">",
    ast.GtE: ">=",
    ast.Is: "is",
    ast.IsNot: "is not",
    ast.In: "in",
    ast.NotIn: "not in",
}
_COMPARE_AST_BY_SYMBOL: dict[str, type[ast.cmpop]] = {
    symbol: operator_type
    for operator_type, symbol in _COMPARE_SYMBOLS.items()
}


def _loop_payload_from_parts(
    loop_type: str,
    *,
    condition: str = "",
    target: str = "",
    iterable: str = "",
) -> dict[str, Any]:
    if loop_type in {"for", "for_each"}:
        clean_target = target.strip()
        clean_iterable = iterable.strip()
        return {
            "header": f"for {clean_target} in {clean_iterable}" if clean_target and clean_iterable else "",
            "loop_type": "for",
            "target": clean_target,
            "iterable": clean_iterable,
        }
    clean_condition = condition.strip()
    return {
        "header": f"while {clean_condition}" if clean_condition else "",
        "loop_type": "while",
        "condition": clean_condition,
    }


def _infer_loop_payload_from_header(header: str) -> dict[str, Any]:
    clean_header = header.strip().rstrip(":")
    if not clean_header:
        return _loop_payload_from_parts("while")
    try:
        parsed = ast.parse(f"{clean_header}:\n    pass\n").body
    except SyntaxError:
        return {"header": clean_header, "loop_type": "while", "condition": ""}
    if len(parsed) != 1:
        return {"header": clean_header, "loop_type": "while", "condition": ""}
    statement = parsed[0]
    if isinstance(statement, ast.While):
        return _loop_payload_from_parts("while", condition=ast.unparse(statement.test))
    if isinstance(statement, ast.For):
        return _loop_payload_from_parts(
            "for",
            target=ast.unparse(statement.target),
            iterable=ast.unparse(statement.iter),
        )
    return {"header": clean_header, "loop_type": "while", "condition": ""}


def _normalized_loop_payload(payload: dict[str, Any]) -> dict[str, Any]:
    header = str(payload.get("header") or "").strip().rstrip(":")
    inferred = _infer_loop_payload_from_header(header)
    raw_loop_type = str(payload.get("loop_type") or payload.get("loopType") or "").strip()
    loop_type = raw_loop_type if raw_loop_type in _LOOP_TYPES else str(inferred.get("loop_type") or "while")
    if loop_type == "for_each":
        loop_type = "for"
    if loop_type == "for":
        target = str(payload.get("target") or inferred.get("target") or "").strip()
        iterable = str(payload.get("iterable") or inferred.get("iterable") or "").strip()
        normalized = _loop_payload_from_parts("for", target=target, iterable=iterable)
    else:
        condition = str(payload.get("condition") or inferred.get("condition") or "").strip()
        normalized = _loop_payload_from_parts("while", condition=condition)
    if not normalized["header"] and header:
        normalized["header"] = header
    return {**payload, **normalized}


def _loop_header_from_payload(payload: dict[str, Any]) -> str:
    return str(_normalized_loop_payload(payload).get("header") or "").strip().rstrip(":")


def _parse_loop_statement_from_payload(payload: dict[str, Any]) -> ast.stmt | None:
    header = _loop_header_from_payload(payload)
    if not header:
        return None
    parsed = ast.parse(f"{header}:\n    pass\n").body
    return parsed[0] if len(parsed) == 1 else None


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
    kind: str = "positional_or_keyword"
    default_expression: str | None = None

    def to_dict(self) -> dict[str, Any]:
        payload = {
            "id": self.input_id,
            "name": self.name,
            "index": self.index,
            "kind": self.kind,
        }
        if self.default_expression is not None:
            payload["default_expression"] = self.default_expression
        return payload


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
class FlowValueSource:
    source_id: str
    node_id: str
    name: str
    label: str
    emitted_name: str | None = None

    def to_dict(self) -> dict[str, Any]:
        payload = {
            "id": self.source_id,
            "node_id": self.node_id,
            "name": self.name,
            "label": self.label,
        }
        if self.emitted_name:
            payload["emitted_name"] = self.emitted_name
        return payload


@dataclass(frozen=True)
class FlowInputBinding:
    binding_id: str
    source_id: str
    slot_id: str
    function_input_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        payload = {
            "id": self.binding_id,
            "source_id": self.source_id,
            "slot_id": self.slot_id,
        }
        if self.function_input_id:
            payload["function_input_id"] = self.function_input_id
        return payload


@dataclass(frozen=True)
class FlowModelDocument:
    symbol_id: str
    relative_path: str
    qualname: str
    nodes: tuple[FlowModelNode, ...]
    edges: tuple[FlowModelEdge, ...]
    value_model_version: int | None = FLOW_VALUE_MODEL_VERSION
    function_inputs: tuple[FlowFunctionInput, ...] = ()
    value_sources: tuple[FlowValueSource, ...] = ()
    input_slots: tuple[FlowInputSlot, ...] = ()
    input_bindings: tuple[FlowInputBinding, ...] = ()
    sync_state: str = "clean"
    diagnostics: tuple[str, ...] = ()
    source_hash: str | None = None
    editable: bool = True
    _preserve_input_model_exactly: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "symbol_id": self.symbol_id,
            "relative_path": self.relative_path,
            "qualname": self.qualname,
            "nodes": [node.to_dict() for node in self.nodes],
            "edges": [edge.to_dict() for edge in self.edges],
            "value_model_version": self.value_model_version,
            "function_inputs": [function_input.to_dict() for function_input in self.function_inputs],
            "value_sources": [value_source.to_dict() for value_source in self.value_sources],
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


@dataclass(frozen=True)
class _FlowNodePosition:
    order: int
    context: tuple[str, ...]


@dataclass(frozen=True)
class _ValueBindingNormalizationResult:
    document: FlowModelDocument
    diagnostics: tuple[str, ...]


class FlowImportError(ValueError):
    """Raised when a function cannot be represented by the visual flow model."""


@dataclass
class _ImportedBlock:
    root_id: str | None
    continuations: tuple[tuple[str, str], ...] = ()


@dataclass
class _ExpressionGraphBuilder:
    input_slot_by_name: dict[str, str]
    nodes: list[dict[str, Any]]
    edges: list[dict[str, Any]]
    next_index: int = 0

    def create_node(self, kind: str, label: str, payload: dict[str, Any] | None = None) -> str:
        node_id = f"expr:{kind}:{self.next_index}"
        self.next_index += 1
        self.nodes.append(
            {
                "id": node_id,
                "kind": kind,
                "label": label,
                "payload": payload or {},
            }
        )
        return node_id

    def connect(self, source_id: str, target_id: str, target_handle: str) -> None:
        self.edges.append(
            {
                "id": f"expr-edge:{source_id}->{target_id}:{target_handle}",
                "source_id": source_id,
                "source_handle": "value",
                "target_id": target_id,
                "target_handle": target_handle,
            }
        )


@dataclass
class _ImportBuilder:
    symbol_id: str
    relative_path: str
    qualname: str
    function_inputs: list[FlowFunctionInput]
    nodes: list[FlowModelNode]
    edges: list[FlowModelEdge]
    value_sources: list[FlowValueSource]
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

    def update_node_payload(self, node_id: str, payload: dict[str, Any]) -> None:
        self.nodes = [
            replace(node, payload=payload)
            if node.node_id == node_id
            else node
            for node in self.nodes
        ]

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

    def bind_input_slots(self, node_id: str, statement: ast.stmt | ast.expr) -> None:
        node = next((candidate for candidate in self.nodes if candidate.node_id == node_id), None)
        if node is None:
            return

        function_input_by_id = {
            function_input.input_id: function_input
            for function_input in self.function_inputs
        }
        value_source_by_id = {
            value_source.source_id: value_source
            for value_source in self.value_sources
        }
        existing_slot_ids = {slot.slot_id for slot in self.input_slots}
        existing_binding_ids = {binding.binding_id for binding in self.input_bindings}
        used_names = sorted(_names_used(statement))
        for used_name in used_names:
            definition_id = self.definitions.get(used_name)
            if definition_id not in function_input_by_id and definition_id not in value_source_by_id:
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
                function_input_id = definition_id if definition_id in function_input_by_id else None
                self.input_bindings.append(
                    FlowInputBinding(
                        binding_id=binding_id,
                        source_id=definition_id,
                        slot_id=slot_id,
                        function_input_id=function_input_id,
                    )
                )
                existing_binding_ids.add(binding_id)

    def record_assigned_names(self, node_id: str, statement: ast.stmt) -> None:
        node = next((candidate for candidate in self.nodes if candidate.node_id == node_id), None)
        if node is None:
            return
        existing_source_ids = {value_source.source_id for value_source in self.value_sources}
        for assigned_name in _assigned_names(statement):
            source_id = flow_value_source_id(flow_model_node_source_identity(node), assigned_name)
            if source_id not in existing_source_ids:
                self.value_sources.append(
                    FlowValueSource(
                        source_id=source_id,
                        node_id=node.node_id,
                        name=assigned_name,
                        label=assigned_name,
                    )
                )
                existing_source_ids.add(source_id)
            self.definitions[assigned_name] = source_id


def flow_models_path(root_path: Path) -> Path:
    return root_path / FLOW_MODEL_RELATIVE_PATH


def flow_edge_id(
    source_id: str,
    source_handle: str,
    target_id: str,
    target_handle: str,
) -> str:
    return f"controls:{source_id}:{source_handle}->{target_id}:{target_handle}"


def flow_return_completion_edge_id(return_node_id: str, exit_node_id: str) -> str:
    return flow_edge_id(return_node_id, "exit", exit_node_id, "in")


def is_flow_return_completion_edge(
    edge: FlowModelEdge,
    *,
    node_by_id: dict[str, FlowModelNode],
) -> bool:
    source_node = node_by_id.get(edge.source_id)
    target_node = node_by_id.get(edge.target_id)
    return (
        source_node is not None
        and target_node is not None
        and source_node.kind == "return"
        and target_node.kind == "exit"
        and edge.source_handle == "exit"
        and edge.target_handle == "in"
        and edge.edge_id == flow_return_completion_edge_id(edge.source_id, edge.target_id)
    )


def without_flow_return_completion_edges(document: FlowModelDocument) -> FlowModelDocument:
    node_by_id = {node.node_id: node for node in document.nodes}
    next_edges = tuple(
        edge
        for edge in document.edges
        if not is_flow_return_completion_edge(edge, node_by_id=node_by_id)
    )
    if len(next_edges) == len(document.edges):
        return document
    return replace(document, edges=next_edges)


def without_branch_after_edges(document: FlowModelDocument) -> FlowModelDocument:
    node_by_id = {node.node_id: node for node in document.nodes}
    branch_after_edges = tuple(
        edge
        for edge in document.edges
        if node_by_id.get(edge.source_id) is not None
        and node_by_id[edge.source_id].kind == "branch"
        and edge.source_handle == "after"
        and edge.target_handle == "in"
    )
    if not branch_after_edges:
        return document

    output_edges = {(edge.source_id, edge.source_handle): edge for edge in document.edges}
    removed_edge_ids = {edge.edge_id for edge in branch_after_edges}
    next_edges = [edge for edge in document.edges if edge.edge_id not in removed_edge_ids]
    occupied_outputs = {(edge.source_id, edge.source_handle) for edge in next_edges}

    for edge in branch_after_edges:
        continuations = _legacy_branch_continuations_for_after_edge(
            edge.source_id,
            edge.target_id,
            node_by_id=node_by_id,
            output_edges=output_edges,
        )
        for source_id, source_handle in continuations:
            output_key = (source_id, source_handle)
            if output_key in occupied_outputs:
                continue
            next_edges.append(
                FlowModelEdge(
                    edge_id=flow_edge_id(source_id, source_handle, edge.target_id, "in"),
                    source_id=source_id,
                    source_handle=source_handle,
                    target_id=edge.target_id,
                    target_handle="in",
                )
            )
            occupied_outputs.add(output_key)

    return replace(document, edges=tuple(next_edges))


def _legacy_branch_continuations_for_after_edge(
    branch_node_id: str,
    after_target_id: str,
    *,
    node_by_id: dict[str, FlowModelNode],
    output_edges: dict[tuple[str, str], FlowModelEdge],
) -> tuple[tuple[str, str], ...]:
    continuations: list[tuple[str, str]] = []
    for handle in ("true", "false"):
        start_id = target_id_for_edge(output_edges.get((branch_node_id, handle)))
        if start_id is None:
            continuations.append((branch_node_id, handle))
            continue
        continuations.extend(
            _legacy_open_continuations(
                start_id,
                stop_node_id=after_target_id,
                node_by_id=node_by_id,
                output_edges=output_edges,
                visited=set(),
            )
        )
    return tuple(dict.fromkeys(continuations))


def _legacy_open_continuations(
    node_id: str | None,
    *,
    stop_node_id: str,
    node_by_id: dict[str, FlowModelNode],
    output_edges: dict[tuple[str, str], FlowModelEdge],
    visited: set[str],
) -> tuple[tuple[str, str], ...]:
    if node_id is None or node_id == stop_node_id or node_id in visited:
        return ()
    node = node_by_id.get(node_id)
    if node is None:
        return ()
    visited.add(node_id)

    if node.kind in {"assign", "call"}:
        next_id = target_id_for_edge(output_edges.get((node_id, "next")))
        if next_id is None:
            return ((node_id, "next"),)
        return _legacy_open_continuations(
            next_id,
            stop_node_id=stop_node_id,
            node_by_id=node_by_id,
            output_edges=output_edges,
            visited=visited,
        )

    if node.kind == "return":
        return ()

    if node.kind == "branch":
        after_id = target_id_for_edge(output_edges.get((node_id, "after")))
        if after_id is not None:
            return _legacy_open_continuations(
                after_id,
                stop_node_id=stop_node_id,
                node_by_id=node_by_id,
                output_edges=output_edges,
                visited=visited,
            )
        continuations: list[tuple[str, str]] = []
        for handle in ("true", "false"):
            start_id = target_id_for_edge(output_edges.get((node_id, handle)))
            if start_id is None:
                continuations.append((node_id, handle))
                continue
            continuations.extend(
                _legacy_open_continuations(
                    start_id,
                    stop_node_id=stop_node_id,
                    node_by_id=node_by_id,
                    output_edges=output_edges,
                    visited=set(visited),
                )
            )
        return tuple(dict.fromkeys(continuations))

    if node.kind == "loop":
        after_id = target_id_for_edge(output_edges.get((node_id, "after")))
        if after_id is None:
            return ((node_id, "after"),)
        return _legacy_open_continuations(
            after_id,
            stop_node_id=stop_node_id,
            node_by_id=node_by_id,
            output_edges=output_edges,
            visited=visited,
        )

    return ()


def indexed_flow_entry_node_id(symbol_id: str) -> str:
    return f"flow:{symbol_id}:entry"


def indexed_flow_statement_node_id(symbol_id: str, statement_index: int) -> str:
    return f"flow:{symbol_id}:statement:{statement_index}"


def flow_function_input_id(symbol_id: str, name: str) -> str:
    return f"flowinput:{symbol_id}:{name}"


def flow_input_slot_id(node_source_identity: str, slot_key: str) -> str:
    return f"flowslot:{node_source_identity}:{slot_key}"


def flow_value_source_id(node_source_identity: str, name: str) -> str:
    return f"flowsource:{node_source_identity}:{name}"


def flow_input_binding_id(slot_id: str, source_id: str) -> str:
    return f"flowbinding:{slot_id}->{source_id}"


def flow_model_node_source_identity(node: FlowModelNode) -> str:
    return node.indexed_node_id or node.node_id


def flow_value_source_emitted_name(source: FlowValueSource) -> str:
    return source.emitted_name or source.name


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
        kind = str(raw_input.get("kind") or "positional_or_keyword").strip()
        raw_default_expression = raw_input.get("default_expression")
        default_expression = (
            str(raw_default_expression)
            if raw_default_expression is not None
            else None
        )
        if not input_id or not name or not isinstance(index, int):
            raise ValueError("Flow graph function inputs require id, name, and integer index.")
        if kind not in FLOW_FUNCTION_INPUT_KINDS:
            kind = "positional_or_keyword"
        if input_id in seen_function_input_ids:
            raise ValueError(f"Duplicate flow function input id '{input_id}'.")
        seen_function_input_ids.add(input_id)
        function_inputs.append(
            FlowFunctionInput(
                input_id=input_id,
                name=name,
                index=index,
                kind=kind,
                default_expression=default_expression,
            )
        )

    raw_value_model_version = payload.get("value_model_version")
    value_model_version = raw_value_model_version if isinstance(raw_value_model_version, int) else None

    value_sources: list[FlowValueSource] = []
    seen_value_source_ids: set[str] = set()
    raw_value_sources = payload.get("value_sources") or []
    if not isinstance(raw_value_sources, list):
        raise ValueError("Flow graph payload field 'value_sources' must be a list when provided.")
    for raw_source in raw_value_sources:
        if not isinstance(raw_source, dict):
            raise ValueError("Flow graph value sources must be objects.")
        source_id = str(raw_source.get("id") or "").strip()
        source_node_id = str(raw_source.get("node_id") or "").strip()
        name = str(raw_source.get("name") or "").strip()
        label = str(raw_source.get("label") or name).strip()
        raw_emitted_name = raw_source.get("emitted_name")
        emitted_name = (
            str(raw_emitted_name).strip()
            if isinstance(raw_emitted_name, str) and raw_emitted_name.strip()
            else None
        )
        if not source_id or not source_node_id or not name:
            raise ValueError("Flow graph value sources require id, node_id, and name.")
        if source_node_id not in seen_node_ids:
            continue
        if source_id in seen_value_source_ids:
            raise ValueError(f"Duplicate flow value source id '{source_id}'.")
        seen_value_source_ids.add(source_id)
        value_sources.append(
            FlowValueSource(
                source_id=source_id,
                node_id=source_node_id,
                name=name,
                label=label or name,
                emitted_name=emitted_name,
            )
        )

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
    valid_source_ids = {*seen_function_input_ids, *seen_value_source_ids}
    raw_input_bindings = payload.get("input_bindings") or []
    if not isinstance(raw_input_bindings, list):
        raise ValueError("Flow graph payload field 'input_bindings' must be a list when provided.")
    for raw_binding in raw_input_bindings:
        if not isinstance(raw_binding, dict):
            raise ValueError("Flow graph input bindings must be objects.")
        binding_id = str(raw_binding.get("id") or "").strip()
        function_input_id = str(raw_binding.get("function_input_id") or "").strip()
        raw_source_id = str(raw_binding.get("source_id") or "").strip()
        source_id = raw_source_id or function_input_id
        if (
            function_input_id in seen_function_input_ids
            and (not raw_source_id or raw_source_id in seen_function_input_ids)
        ):
            source_id = function_input_id
        slot_id = str(raw_binding.get("slot_id") or "").strip()
        if not binding_id or not source_id or not slot_id:
            raise ValueError("Flow graph input bindings require id, source_id, and slot_id.")
        if binding_id in seen_binding_ids:
            raise ValueError(f"Duplicate flow input binding id '{binding_id}'.")
        if source_id not in valid_source_ids or slot_id not in seen_slot_ids:
            continue
        if slot_id in bound_slot_ids:
            raise ValueError(f"Flow graph input slot '{slot_id}' can only have one value binding.")
        seen_binding_ids.add(binding_id)
        bound_slot_ids.add(slot_id)
        input_bindings.append(
            FlowInputBinding(
                binding_id=binding_id,
                source_id=source_id,
                slot_id=slot_id,
                function_input_id=source_id if source_id in seen_function_input_ids else None,
            )
        )

    sync_state = str(payload.get("sync_state") or "clean")
    if sync_state not in FLOW_SYNC_STATES:
        sync_state = "draft"
    diagnostics = tuple(str(item) for item in payload.get("diagnostics") or ())
    source_hash = payload.get("source_hash")
    editable = bool(payload.get("editable", True))
    document = FlowModelDocument(
        symbol_id=symbol_id,
        relative_path=relative_path,
        qualname=qualname,
        nodes=tuple(nodes),
        edges=tuple(edges),
        value_model_version=value_model_version,
        function_inputs=tuple(sorted(function_inputs, key=lambda item: (item.index, item.name))),
        value_sources=tuple(value_sources),
        input_slots=tuple(input_slots),
        input_bindings=tuple(input_bindings),
        sync_state=sync_state,
        diagnostics=diagnostics,
        source_hash=str(source_hash) if isinstance(source_hash, str) and source_hash else None,
        editable=editable,
    )
    return without_branch_after_edges(document)


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
    existing_source_by_node_name = {
        (source.node_id, source.name): source
        for source in document.value_sources
    } if preserve_existing else {}
    existing_source_by_node_emitted_name = {
        (source.node_id, flow_value_source_emitted_name(source)): source
        for source in document.value_sources
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
    derived_source_by_node_name: dict[tuple[str, str], FlowValueSource] = {}
    next_value_sources: list[FlowValueSource] = []
    seen_source_ids: set[str] = set()
    for node_id in ordered_node_ids:
        node = node_by_id.get(node_id)
        if node is None:
            continue
        for assigned_name in sorted(_assigned_names_by_flow_node_payload(node)):
            existing_source = (
                existing_source_by_node_emitted_name.get((node.node_id, assigned_name))
                or existing_source_by_node_name.get((node.node_id, assigned_name))
            )
            source_id = (
                existing_source.source_id
                if existing_source
                else flow_value_source_id(flow_model_node_source_identity(node), assigned_name)
            )
            source_name = existing_source.name if existing_source else assigned_name
            emitted_name = assigned_name if existing_source and assigned_name != source_name else None
            source = FlowValueSource(
                source_id=source_id,
                node_id=node.node_id,
                name=source_name,
                label=existing_source.label if existing_source else source_name,
                emitted_name=emitted_name,
            )
            derived_source_by_node_name[(node.node_id, assigned_name)] = source
            if source.source_id in seen_source_ids:
                continue
            seen_source_ids.add(source.source_id)
            next_value_sources.append(source)

    known_source_ids = {
        *function_input_ids,
        *(source.source_id for source in next_value_sources),
        *(source.source_id for source in document.value_sources),
    }
    if preserve_existing and document._preserve_input_model_exactly:
        return replace(
            document,
            value_model_version=FLOW_VALUE_MODEL_VERSION,
            _preserve_input_model_exactly=False,
        )

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
            source_identity = flow_model_node_source_identity(node)
            existing_slot = existing_slot_by_node_key.get((node.node_id, used_name))
            existing_binding = (
                existing_binding_by_slot_id.get(existing_slot.slot_id)
                if existing_slot is not None
                else None
            )
            existing_binding_source_id = (
                existing_binding.source_id
                if existing_binding is not None and existing_binding.source_id in known_source_ids
                else None
            )
            if definition_id not in known_source_ids and existing_binding_source_id is None:
                continue
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

            if existing_slot and existing_binding is None:
                continue
            source_id = (
                existing_binding_source_id
                if existing_binding_source_id is not None
                else definition_id
            )
            if source_id not in known_source_ids or slot.slot_id in seen_bound_slot_ids:
                continue
            next_bindings.append(
                FlowInputBinding(
                    binding_id=existing_binding.binding_id
                    if existing_binding
                    else flow_input_binding_id(slot.slot_id, source_id),
                    source_id=source_id,
                    slot_id=slot.slot_id,
                    function_input_id=source_id if source_id in function_input_ids else None,
                )
            )
            seen_bound_slot_ids.add(slot.slot_id)

        for assigned_name in _assigned_names_by_flow_node_payload(node):
            source = derived_source_by_node_name.get((node.node_id, assigned_name))
            if source is not None:
                definitions[flow_value_source_emitted_name(source)] = source.source_id

    next_nodes = _with_return_expression_graph_slot_ids(
        document.nodes,
        tuple(next_slots),
    )
    return replace(
        document,
        nodes=next_nodes,
        value_model_version=FLOW_VALUE_MODEL_VERSION,
        value_sources=tuple(next_value_sources),
        input_slots=tuple(next_slots),
        input_bindings=tuple(next_bindings),
    )


def with_flow_document_inherited_input_model(
    document: FlowModelDocument,
    *,
    source_document: FlowModelDocument,
) -> FlowModelDocument:
    """Backfill legacy editable flow value bindings from source-backed semantics.

    Older persisted flow documents only stored authored control flow. When those
    documents have no canonical input slots, derive the missing value model from
    the current imported source document instead of parsing draft payload text.
    """

    source_function_inputs = source_document.function_inputs
    if not source_function_inputs and not source_document.value_sources:
        return document

    if document.input_slots:
        next_function_inputs = _merge_flow_function_inputs(
            document.function_inputs,
            source_function_inputs,
        )
        next_value_sources = _inherited_value_sources_for_document(
            document,
            source_document=source_document,
        )
        return replace(
            document,
            value_model_version=FLOW_VALUE_MODEL_VERSION,
            function_inputs=next_function_inputs,
            value_sources=next_value_sources,
            _preserve_input_model_exactly=document.value_model_version is None,
        )

    existing_input_by_name = {
        function_input.name: function_input
        for function_input in document.function_inputs
    }
    next_function_inputs = _merge_flow_function_inputs(
        tuple(existing_input_by_name.values()),
        source_function_inputs,
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

    source_id_by_source_id: dict[str, str] = {}
    for source_input in source_function_inputs:
        function_input = next_input_by_name.get(source_input.name)
        if function_input is not None:
            source_id_by_source_id[source_input.input_id] = function_input.input_id

    next_value_sources = []
    seen_value_source_ids: set[str] = set()
    for source in source_document.value_sources:
        source_node = source_node_by_id.get(source.node_id)
        if source_node is None:
            continue
        target_node = None
        for identity in _flow_model_node_identity_candidates(source_node):
            target_node = document_node_by_identity.get(identity)
            if target_node is not None:
                break
        if target_node is None:
            continue
        source_id = flow_value_source_id(flow_model_node_source_identity(source_node), source.name)
        source_id_by_source_id[source.source_id] = source_id
        if source_id in seen_value_source_ids:
            continue
        seen_value_source_ids.add(source_id)
        next_value_sources.append(
            FlowValueSource(
                source_id=source_id,
                node_id=target_node.node_id,
                name=source.name,
                label=source.label,
                emitted_name=source.emitted_name,
            )
        )

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

    next_bindings: list[FlowInputBinding] = []
    seen_bound_slot_ids: set[str] = set()
    for source_binding in source_document.input_bindings:
        slot_id = slot_id_by_source_slot_id.get(source_binding.slot_id)
        source_id = source_id_by_source_id.get(source_binding.source_id)
        if slot_id is None or source_id is None or slot_id in seen_bound_slot_ids:
            continue
        seen_bound_slot_ids.add(slot_id)
        function_input_id = source_id if source_id in {item.input_id for item in next_function_inputs} else None
        next_bindings.append(
            FlowInputBinding(
                binding_id=flow_input_binding_id(slot_id, source_id),
                source_id=source_id,
                slot_id=slot_id,
                function_input_id=function_input_id,
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
        value_model_version=FLOW_VALUE_MODEL_VERSION,
        function_inputs=next_function_inputs,
        value_sources=tuple(next_value_sources),
        input_slots=tuple(next_slots),
        input_bindings=tuple(next_bindings),
    )


def _merge_flow_function_inputs(
    existing_inputs: tuple[FlowFunctionInput, ...],
    source_inputs: tuple[FlowFunctionInput, ...],
) -> tuple[FlowFunctionInput, ...]:
    if not source_inputs:
        return existing_inputs
    existing_by_name = {function_input.name: function_input for function_input in existing_inputs}
    return tuple(
        FlowFunctionInput(
            input_id=existing_by_name.get(source_input.name, source_input).input_id,
            name=source_input.name,
            index=source_input.index,
            kind=source_input.kind,
            default_expression=source_input.default_expression,
        )
        for source_input in source_inputs
    )


def _inherited_value_sources_for_document(
    document: FlowModelDocument,
    *,
    source_document: FlowModelDocument,
) -> tuple[FlowValueSource, ...]:
    source_node_by_id = {node.node_id: node for node in source_document.nodes}
    document_node_by_identity: dict[str, FlowModelNode] = {}
    for node in document.nodes:
        for identity in _flow_model_node_identity_candidates(node):
            document_node_by_identity.setdefault(identity, node)

    existing_by_node_name = {
        (source.node_id, source.name): source
        for source in document.value_sources
    }
    existing_by_node_emitted_name = {
        (source.node_id, flow_value_source_emitted_name(source)): source
        for source in document.value_sources
    }
    next_sources: list[FlowValueSource] = []
    seen_source_ids: set[str] = set()
    for source in source_document.value_sources:
        source_node = source_node_by_id.get(source.node_id)
        if source_node is None:
            continue
        target_node = None
        for identity in _flow_model_node_identity_candidates(source_node):
            target_node = document_node_by_identity.get(identity)
            if target_node is not None:
                break
        if target_node is None:
            continue
        existing = (
            existing_by_node_emitted_name.get((target_node.node_id, flow_value_source_emitted_name(source)))
            or existing_by_node_name.get((target_node.node_id, source.name))
        )
        source_id = existing.source_id if existing else flow_value_source_id(
            flow_model_node_source_identity(source_node),
            source.name,
        )
        if source_id in seen_source_ids:
            continue
        seen_source_ids.add(source_id)
        next_sources.append(
            FlowValueSource(
                source_id=source_id,
                node_id=target_node.node_id,
                name=source.name,
                label=existing.label if existing else source.label,
                emitted_name=existing.emitted_name if existing else source.emitted_name,
            )
        )
    return tuple(next_sources)


def flow_document_source_names_by_id(document: FlowModelDocument) -> dict[str, str]:
    return {
        **{
            function_input.input_id: function_input.name
            for function_input in document.function_inputs
        },
        **{
            value_source.source_id: flow_value_source_emitted_name(value_source)
            for value_source in document.value_sources
        },
    }


def with_flow_document_applied_input_bindings(
    document: FlowModelDocument,
) -> FlowModelDocument:
    if not document.input_slots or not document.input_bindings:
        return document

    source_name_by_id = flow_document_source_names_by_id(document)
    slot_by_id = {slot.slot_id: slot for slot in document.input_slots}
    replacements_by_node_id: dict[str, dict[str, str]] = {}
    for binding in document.input_bindings:
        slot = slot_by_id.get(binding.slot_id)
        source_name = source_name_by_id.get(binding.source_id)
        if slot is None or source_name is None:
            continue
        if slot.slot_key == source_name:
            continue
        replacements_by_node_id.setdefault(slot.node_id, {})[slot.slot_key] = source_name

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
    positional_defaults: list[ast.expr | None] = [None] * (
        len(positional_args) - len(function_node.args.defaults)
    )
    positional_defaults.extend(function_node.args.defaults)

    ordered: list[tuple[ast.arg, str, ast.expr | None]] = []
    for argument, default in zip(
        function_node.args.posonlyargs,
        positional_defaults[:len(function_node.args.posonlyargs)],
    ):
        ordered.append((argument, "positional_only", default))
    offset = len(function_node.args.posonlyargs)
    for argument, default in zip(function_node.args.args, positional_defaults[offset:]):
        ordered.append((argument, "positional_or_keyword", default))
    if function_node.args.vararg is not None:
        ordered.append((function_node.args.vararg, "vararg", None))
    for argument, default in zip(function_node.args.kwonlyargs, function_node.args.kw_defaults):
        ordered.append((argument, "keyword_only", default))
    if function_node.args.kwarg is not None:
        ordered.append((function_node.args.kwarg, "kwarg", None))

    return tuple(
        FlowFunctionInput(
            input_id=flow_function_input_id(symbol_id, argument.arg),
            name=argument.arg,
            index=index,
            kind=kind,
            default_expression=ast.unparse(default) if default is not None else None,
        )
        for index, (argument, kind, default) in enumerate(ordered)
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


def expression_graph_from_expression(
    expression: str,
    *,
    input_slot_by_name: dict[str, str] | None = None,
) -> dict[str, Any]:
    expression = expression.strip()
    if not expression:
        return {
            "version": FLOW_EXPRESSION_GRAPH_VERSION,
            "rootId": None,
            "nodes": [],
            "edges": [],
        }
    parsed = ast.parse(expression, mode="eval")
    return expression_graph_from_ast(
        parsed.body,
        input_slot_by_name=input_slot_by_name,
    )


def expression_graph_from_ast(
    expression: ast.expr,
    *,
    input_slot_by_name: dict[str, str] | None = None,
) -> dict[str, Any]:
    builder = _ExpressionGraphBuilder(
        input_slot_by_name=input_slot_by_name or {},
        nodes=[],
        edges=[],
    )
    root_id = _append_expression_ast_node(builder, expression)
    return {
        "version": FLOW_EXPRESSION_GRAPH_VERSION,
        "rootId": root_id,
        "nodes": builder.nodes,
        "edges": builder.edges,
    }


def expression_from_expression_graph(graph: dict[str, Any]) -> str:
    expression_ast = _ast_from_expression_graph(graph)
    expression_module = ast.Expression(body=expression_ast)
    ast.fix_missing_locations(expression_module)
    return ast.unparse(expression_module)


def _return_expression_from_payload(payload: dict[str, Any]) -> str:
    expression_graph = payload.get(_RETURN_EXPRESSION_GRAPH_KEY)
    if isinstance(expression_graph, dict):
        root_id = expression_graph.get("rootId") or expression_graph.get("root_id")
        if isinstance(root_id, str) and root_id:
            try:
                return expression_from_expression_graph(expression_graph)
            except ValueError:
                pass
    return str(payload.get("expression") or "").strip()


def _expression_graph_input_names(graph: dict[str, Any]) -> set[str]:
    raw_nodes = graph.get("nodes") or []
    if not isinstance(raw_nodes, list):
        return set()
    names: set[str] = set()
    for raw_node in raw_nodes:
        if not isinstance(raw_node, dict) or raw_node.get("kind") != "input":
            continue
        payload = raw_node.get("payload") if isinstance(raw_node.get("payload"), dict) else {}
        raw_name = payload.get("name") or raw_node.get("label")
        if isinstance(raw_name, str) and raw_name.strip():
            names.add(raw_name.strip())
    return names


def _rewrite_expression_graph_input_names(
    graph: dict[str, Any],
    replacements: dict[str, str],
) -> dict[str, Any]:
    if not replacements:
        return graph
    next_graph = json.loads(json.dumps(graph))
    raw_nodes = next_graph.get("nodes") or []
    if not isinstance(raw_nodes, list):
        return next_graph
    for raw_node in raw_nodes:
        if not isinstance(raw_node, dict) or raw_node.get("kind") != "input":
            continue
        payload = raw_node.get("payload")
        if not isinstance(payload, dict):
            payload = {}
            raw_node["payload"] = payload
        raw_name = payload.get("name") or raw_node.get("label")
        if not isinstance(raw_name, str):
            continue
        replacement = replacements.get(raw_name.strip())
        if not replacement:
            continue
        payload["name"] = replacement
        if raw_node.get("label") == raw_name:
            raw_node["label"] = replacement
    return next_graph


def _rewrite_expression_graph_slot_ids(
    graph: dict[str, Any],
    slot_id_by_old_id: dict[str, str],
) -> dict[str, Any]:
    if not slot_id_by_old_id:
        return graph
    next_graph = json.loads(json.dumps(graph))
    raw_nodes = next_graph.get("nodes") or []
    if not isinstance(raw_nodes, list):
        return next_graph
    for raw_node in raw_nodes:
        if not isinstance(raw_node, dict) or raw_node.get("kind") != "input":
            continue
        payload = raw_node.get("payload")
        if not isinstance(payload, dict):
            continue
        slot_id = payload.get("slot_id") or payload.get("slotId")
        if isinstance(slot_id, str) and slot_id in slot_id_by_old_id:
            payload["slot_id"] = slot_id_by_old_id[slot_id]
            payload.pop("slotId", None)
    return next_graph


def _with_return_expression_graph_slot_ids(
    nodes: tuple[FlowModelNode, ...],
    input_slots: tuple[FlowInputSlot, ...],
) -> tuple[FlowModelNode, ...]:
    slot_id_by_node_name = {
        (slot.node_id, slot.slot_key): slot.slot_id
        for slot in input_slots
    }
    next_nodes: list[FlowModelNode] = []
    for node in nodes:
        expression_graph = node.payload.get(_RETURN_EXPRESSION_GRAPH_KEY)
        if node.kind != "return" or not isinstance(expression_graph, dict):
            next_nodes.append(node)
            continue
        next_graph = json.loads(json.dumps(expression_graph))
        raw_nodes = next_graph.get("nodes") or []
        changed = False
        if isinstance(raw_nodes, list):
            for raw_node in raw_nodes:
                if not isinstance(raw_node, dict) or raw_node.get("kind") != "input":
                    continue
                payload = raw_node.get("payload")
                if not isinstance(payload, dict):
                    payload = {}
                    raw_node["payload"] = payload
                raw_name = payload.get("name") or raw_node.get("label")
                if not isinstance(raw_name, str) or not raw_name.strip():
                    continue
                slot_id = slot_id_by_node_name.get((node.node_id, raw_name.strip()))
                if slot_id and payload.get("slot_id") != slot_id:
                    payload["slot_id"] = slot_id
                    payload.pop("slotId", None)
                    changed = True
        next_nodes.append(
            replace(node, payload={**node.payload, _RETURN_EXPRESSION_GRAPH_KEY: next_graph})
            if changed
            else node
        )
    return tuple(next_nodes)


def _append_expression_ast_node(builder: _ExpressionGraphBuilder, expression: ast.expr) -> str:
    if isinstance(expression, ast.Name):
        payload: dict[str, Any] = {"name": expression.id}
        slot_id = builder.input_slot_by_name.get(expression.id)
        if slot_id:
            payload["slot_id"] = slot_id
        return builder.create_node("input", expression.id, payload)

    if isinstance(expression, ast.Constant):
        source = ast.unparse(expression)
        return builder.create_node(
            "literal",
            source,
            {
                "value": expression.value,
                "expression": source,
            },
        )

    if isinstance(expression, ast.BinOp):
        symbol = _BINOP_SYMBOLS.get(type(expression.op))
        if symbol:
            node_id = builder.create_node("operator", symbol, {"operator": symbol})
            builder.connect(_append_expression_ast_node(builder, expression.left), node_id, "left")
            builder.connect(_append_expression_ast_node(builder, expression.right), node_id, "right")
            return node_id

    if isinstance(expression, ast.UnaryOp):
        symbol = _UNARY_SYMBOLS.get(type(expression.op))
        if symbol:
            node_id = builder.create_node("unary", symbol, {"operator": symbol})
            builder.connect(_append_expression_ast_node(builder, expression.operand), node_id, "operand")
            return node_id

    if isinstance(expression, ast.BoolOp):
        symbol = _BOOL_SYMBOLS.get(type(expression.op))
        if symbol:
            node_id = builder.create_node("bool", symbol, {"operator": symbol})
            for index, value in enumerate(expression.values):
                builder.connect(_append_expression_ast_node(builder, value), node_id, f"value:{index}")
            return node_id

    if isinstance(expression, ast.Compare):
        operators = [
            _COMPARE_SYMBOLS.get(type(operator), operator.__class__.__name__)
            for operator in expression.ops
        ]
        node_id = builder.create_node("compare", " ".join(operators), {"operators": operators})
        builder.connect(_append_expression_ast_node(builder, expression.left), node_id, "left")
        for index, comparator in enumerate(expression.comparators):
            builder.connect(_append_expression_ast_node(builder, comparator), node_id, f"comparator:{index}")
        return node_id

    if isinstance(expression, ast.Call):
        label = _compact_source(expression)
        node_id = builder.create_node("call", label, {"expression": label})
        builder.connect(_append_expression_ast_node(builder, expression.func), node_id, "function")
        for index, argument in enumerate(expression.args):
            builder.connect(_append_expression_ast_node(builder, argument), node_id, f"arg:{index}")
        for index, keyword in enumerate(expression.keywords):
            if keyword.arg is None:
                target_handle = f"kwarg:{index}:**"
            else:
                target_handle = f"kwarg:{index}:{keyword.arg}"
            builder.connect(_append_expression_ast_node(builder, keyword.value), node_id, target_handle)
        return node_id

    if isinstance(expression, ast.Attribute):
        node_id = builder.create_node("attribute", f".{expression.attr}", {"attr": expression.attr})
        builder.connect(_append_expression_ast_node(builder, expression.value), node_id, "value")
        return node_id

    if isinstance(expression, ast.Subscript):
        node_id = builder.create_node("subscript", "[]", {})
        builder.connect(_append_expression_ast_node(builder, expression.value), node_id, "value")
        builder.connect(_append_expression_ast_node(builder, expression.slice), node_id, "slice")
        return node_id

    if isinstance(expression, ast.IfExp):
        node_id = builder.create_node("conditional", "if", {})
        builder.connect(_append_expression_ast_node(builder, expression.test), node_id, "test")
        builder.connect(_append_expression_ast_node(builder, expression.body), node_id, "body")
        builder.connect(_append_expression_ast_node(builder, expression.orelse), node_id, "orelse")
        return node_id

    if isinstance(expression, (ast.List, ast.Tuple, ast.Set)):
        collection_type = expression.__class__.__name__.lower()
        node_id = builder.create_node("collection", collection_type, {"collection_type": collection_type})
        for index, item in enumerate(expression.elts):
            builder.connect(_append_expression_ast_node(builder, item), node_id, f"item:{index}")
        return node_id

    if isinstance(expression, ast.Dict):
        node_id = builder.create_node("collection", "dict", {"collection_type": "dict"})
        for index, key in enumerate(expression.keys):
            if key is not None:
                builder.connect(_append_expression_ast_node(builder, key), node_id, f"key:{index}")
            builder.connect(_append_expression_ast_node(builder, expression.values[index]), node_id, f"value:{index}")
        return node_id

    return builder.create_node("raw", _compact_source(expression), {"expression": _compact_source(expression)})


def _compact_source(expression: ast.AST) -> str:
    try:
        return " ".join(ast.unparse(expression).split())
    except Exception:
        return expression.__class__.__name__


def _expression_graph_payload(graph: dict[str, Any]) -> tuple[str | None, dict[str, dict[str, Any]], dict[str, list[dict[str, str]]]]:
    root_id = graph.get("rootId") or graph.get("root_id")
    raw_nodes = graph.get("nodes") or []
    raw_edges = graph.get("edges") or []
    if root_id is not None and not isinstance(root_id, str):
        raise ValueError("Expression graph rootId must be a string when provided.")
    if not isinstance(raw_nodes, list) or not isinstance(raw_edges, list):
        raise ValueError("Expression graph nodes and edges must be lists.")

    nodes: dict[str, dict[str, Any]] = {}
    for raw_node in raw_nodes:
        if not isinstance(raw_node, dict):
            raise ValueError("Expression graph nodes must be objects.")
        node_id = raw_node.get("id")
        kind = raw_node.get("kind")
        if not isinstance(node_id, str) or not node_id:
            raise ValueError("Expression graph nodes require an id.")
        if not isinstance(kind, str) or kind not in FLOW_EXPRESSION_NODE_KINDS:
            raise ValueError(f"Expression graph node '{node_id}' has an unsupported kind.")
        payload = raw_node.get("payload") or {}
        if not isinstance(payload, dict):
            raise ValueError("Expression graph node payloads must be objects.")
        label = raw_node.get("label")
        nodes[node_id] = {
            "id": node_id,
            "kind": kind,
            "label": label if isinstance(label, str) else kind,
            "payload": payload,
        }

    incoming_by_target: dict[str, list[dict[str, str]]] = {}
    for raw_edge in raw_edges:
        if not isinstance(raw_edge, dict):
            raise ValueError("Expression graph edges must be objects.")
        source_id = raw_edge.get("source_id") or raw_edge.get("sourceId")
        target_id = raw_edge.get("target_id") or raw_edge.get("targetId")
        target_handle = raw_edge.get("target_handle") or raw_edge.get("targetHandle")
        if not isinstance(source_id, str) or not isinstance(target_id, str) or not isinstance(target_handle, str):
            raise ValueError("Expression graph edges require source_id, target_id, and target_handle.")
        if source_id not in nodes or target_id not in nodes:
            raise ValueError("Expression graph edges must point at known nodes.")
        incoming_by_target.setdefault(target_id, []).append(
            {
                "source_id": source_id,
                "target_handle": target_handle,
            }
        )

    return root_id, nodes, incoming_by_target


def _ast_from_expression_graph(graph: dict[str, Any]) -> ast.expr:
    root_id, nodes, incoming_by_target = _expression_graph_payload(graph)
    if root_id is None:
        raise ValueError("Expression graph needs a root node.")
    if root_id not in nodes:
        raise ValueError("Expression graph root node is missing.")

    visiting: set[str] = set()

    def children_for(node_id: str) -> dict[str, list[str]]:
        children: dict[str, list[str]] = {}
        for edge in incoming_by_target.get(node_id, []):
            children.setdefault(edge["target_handle"], []).append(edge["source_id"])
        return children

    def single_child(node_id: str, handle: str) -> ast.expr:
        candidates = children_for(node_id).get(handle) or []
        if len(candidates) != 1:
            raise ValueError(f"Expression node '{node_id}' needs one '{handle}' input.")
        return visit(candidates[0])

    def indexed_children(node_id: str, prefix: str) -> list[ast.expr]:
        pairs: list[tuple[int, str]] = []
        for handle, source_ids in children_for(node_id).items():
            if not handle.startswith(prefix):
                continue
            try:
                index = int(handle.split(":", 1)[1].split(":", 1)[0])
            except (IndexError, ValueError):
                index = len(pairs)
            for source_id in source_ids:
                pairs.append((index, source_id))
        return [visit(source_id) for _, source_id in sorted(pairs, key=lambda item: item[0])]

    def parse_expression_source(node_id: str, source: str) -> ast.expr:
        try:
            parsed = ast.parse(source, mode="eval")
        except SyntaxError as exc:
            raise ValueError(f"Expression node '{node_id}' has invalid Python: {exc.msg}.") from exc
        return parsed.body

    def visit(node_id: str) -> ast.expr:
        if node_id in visiting:
            raise ValueError(f"Expression graph has a cycle at '{node_id}'.")
        node = nodes.get(node_id)
        if node is None:
            raise ValueError(f"Expression graph references missing node '{node_id}'.")
        visiting.add(node_id)
        kind = node["kind"]
        payload = node["payload"]
        try:
            if kind == "input":
                name = payload.get("name") or node.get("label")
                if not isinstance(name, str) or not name.strip():
                    raise ValueError(f"Input expression node '{node_id}' needs a name.")
                return ast.Name(id=name.strip(), ctx=ast.Load())

            if kind == "literal":
                source = payload.get("expression")
                if isinstance(source, str) and source.strip():
                    return parse_expression_source(node_id, source)
                return ast.Constant(value=payload.get("value"))

            if kind == "operator":
                operator_symbol = payload.get("operator") or node.get("label")
                operator_type = _BINOP_AST_BY_SYMBOL.get(str(operator_symbol))
                if operator_type is None:
                    raise ValueError(f"Operator expression node '{node_id}' has an unsupported operator.")
                return ast.BinOp(
                    left=single_child(node_id, "left"),
                    op=operator_type(),
                    right=single_child(node_id, "right"),
                )

            if kind == "unary":
                operator_symbol = payload.get("operator") or node.get("label")
                operator_type = _UNARY_AST_BY_SYMBOL.get(str(operator_symbol))
                if operator_type is None:
                    raise ValueError(f"Unary expression node '{node_id}' has an unsupported operator.")
                return ast.UnaryOp(op=operator_type(), operand=single_child(node_id, "operand"))

            if kind == "bool":
                operator_symbol = payload.get("operator") or node.get("label")
                operator_type = _BOOL_AST_BY_SYMBOL.get(str(operator_symbol))
                values = indexed_children(node_id, "value:")
                if operator_type is None or len(values) < 2:
                    raise ValueError(f"Boolean expression node '{node_id}' needs an operator and at least two values.")
                return ast.BoolOp(op=operator_type(), values=values)

            if kind == "compare":
                operators = payload.get("operators")
                operator_symbols = operators if isinstance(operators, list) else []
                comparators = indexed_children(node_id, "comparator:")
                if len(operator_symbols) != len(comparators):
                    raise ValueError(f"Compare expression node '{node_id}' has mismatched operators and comparators.")
                cmp_ops: list[ast.cmpop] = []
                for symbol in operator_symbols:
                    operator_type = _COMPARE_AST_BY_SYMBOL.get(str(symbol))
                    if operator_type is None:
                        raise ValueError(f"Compare expression node '{node_id}' has an unsupported operator.")
                    cmp_ops.append(operator_type())
                return ast.Compare(left=single_child(node_id, "left"), ops=cmp_ops, comparators=comparators)

            if kind == "call":
                children = children_for(node_id)
                args = indexed_children(node_id, "arg:")
                keywords: list[ast.keyword] = []
                for handle, source_ids in sorted(children.items(), key=lambda item: item[0]):
                    if not handle.startswith("kwarg:"):
                        continue
                    parts = handle.split(":", 2)
                    keyword_name = parts[2] if len(parts) > 2 else None
                    if keyword_name == "**":
                        keyword_name = None
                    for source_id in source_ids:
                        keywords.append(ast.keyword(arg=keyword_name, value=visit(source_id)))
                return ast.Call(
                    func=single_child(node_id, "function"),
                    args=args,
                    keywords=keywords,
                )

            if kind == "attribute":
                attr = payload.get("attr")
                if not isinstance(attr, str) or not attr.strip():
                    raise ValueError(f"Attribute expression node '{node_id}' needs an attribute name.")
                return ast.Attribute(value=single_child(node_id, "value"), attr=attr.strip(), ctx=ast.Load())

            if kind == "subscript":
                return ast.Subscript(
                    value=single_child(node_id, "value"),
                    slice=single_child(node_id, "slice"),
                    ctx=ast.Load(),
                )

            if kind == "conditional":
                return ast.IfExp(
                    test=single_child(node_id, "test"),
                    body=single_child(node_id, "body"),
                    orelse=single_child(node_id, "orelse"),
                )

            if kind == "collection":
                collection_type = payload.get("collection_type") or payload.get("collectionType") or node.get("label")
                if collection_type == "list":
                    return ast.List(elts=indexed_children(node_id, "item:"), ctx=ast.Load())
                if collection_type == "tuple":
                    return ast.Tuple(elts=indexed_children(node_id, "item:"), ctx=ast.Load())
                if collection_type == "set":
                    return ast.Set(elts=indexed_children(node_id, "item:"))
                if collection_type == "dict":
                    children = children_for(node_id)
                    indexes = sorted({
                        int(handle.split(":", 1)[1])
                        for handle in children
                        if (handle.startswith("key:") or handle.startswith("value:")) and handle.split(":", 1)[1].isdigit()
                    })
                    keys: list[ast.expr | None] = []
                    values: list[ast.expr] = []
                    for index in indexes:
                        key_candidates = children.get(f"key:{index}", [])
                        value_candidates = children.get(f"value:{index}", [])
                        keys.append(visit(key_candidates[0]) if key_candidates else None)
                        if not value_candidates:
                            raise ValueError(f"Dict expression node '{node_id}' is missing value {index}.")
                        values.append(visit(value_candidates[0]))
                    return ast.Dict(keys=keys, values=values)
                raise ValueError(f"Collection expression node '{node_id}' has unsupported type.")

            expression = payload.get("expression") or node.get("label")
            if not isinstance(expression, str) or not expression.strip():
                raise ValueError(f"Raw expression node '{node_id}' needs Python source.")
            return parse_expression_source(node_id, expression)
        finally:
            visiting.remove(node_id)

    return visit(root_id)


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
        value_sources=[],
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
        for continuation in imported.continuations:
            builder.connect(continuation[0], continuation[1], exit_id)
    else:
        builder.connect(entry_id, "start", exit_id)

    function_source = function_source_for_qualname(module_source, qualname)
    return FlowModelDocument(
        symbol_id=symbol_id,
        relative_path=relative_path,
        qualname=qualname,
        nodes=tuple(builder.nodes),
        edges=tuple(builder.edges),
        value_model_version=FLOW_VALUE_MODEL_VERSION,
        function_inputs=tuple(function_inputs),
        value_sources=tuple(builder.value_sources),
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
    block = _ImportedBlock(root_id=None, continuations=())
    for statement in statements:
        imported = _import_statement(builder, statement)
        if imported.root_id is None:
            continue
        if block.root_id is None:
            block.root_id = imported.root_id
        for continuation in block.continuations:
            builder.connect(continuation[0], continuation[1], imported.root_id)
        block.continuations = imported.continuations
    return block


def _import_statement(
    builder: _ImportBuilder,
    statement: ast.stmt,
) -> _ImportedBlock:
    if isinstance(statement, ast.Pass):
        return _ImportedBlock(root_id=None)

    if isinstance(statement, ast.Return):
        expression = ast.unparse(statement.value) if statement.value is not None else ""
        node_id = builder.create_node(
            "return",
            {"expression": expression},
        )
        if statement.value is not None:
            builder.bind_input_slots(node_id, statement.value)
            input_slot_by_name = {
                slot.slot_key: slot.slot_id
                for slot in builder.input_slots
                if slot.node_id == node_id
            }
            builder.update_node_payload(
                node_id,
                {
                    "expression": expression,
                    _RETURN_EXPRESSION_GRAPH_KEY: expression_graph_from_ast(
                        statement.value,
                        input_slot_by_name=input_slot_by_name,
                    ),
                },
            )
        return _ImportedBlock(root_id=node_id)

    if isinstance(statement, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
        node_id = builder.create_node("assign", {"source": ast.unparse(statement)})
        builder.bind_input_slots(node_id, statement)
        builder.record_assigned_names(node_id, statement)
        return _ImportedBlock(root_id=node_id, continuations=((node_id, "next"),))

    if isinstance(statement, ast.Expr):
        if _is_docstring_expression(statement):
            return _ImportedBlock(root_id=None)
        if any(isinstance(node, ast.Call) for node in ast.walk(statement)):
            node_id = builder.create_node("call", {"source": ast.unparse(statement)})
            builder.bind_input_slots(node_id, statement)
            return _ImportedBlock(root_id=node_id, continuations=((node_id, "next"),))
        raise FlowImportError("Expression statements without a call are not supported in visual flow mode.")

    if isinstance(statement, ast.If):
        node_id = builder.create_node("branch", {"condition": ast.unparse(statement.test)})
        builder.bind_input_slots(node_id, statement.test)
        true_block = _import_block(builder, statement.body)
        false_block = _import_block(builder, statement.orelse)
        if true_block.root_id:
            builder.connect(node_id, "true", true_block.root_id)
        if false_block.root_id:
            builder.connect(node_id, "false", false_block.root_id)
        true_continuations = true_block.continuations if true_block.root_id else ((node_id, "true"),)
        false_continuations = false_block.continuations if false_block.root_id else ((node_id, "false"),)
        return _ImportedBlock(
            root_id=node_id,
            continuations=(*true_continuations, *false_continuations),
        )

    if isinstance(statement, ast.While):
        node_id = builder.create_node(
            "loop",
            _loop_payload_from_parts("while", condition=ast.unparse(statement.test)),
        )
        builder.bind_input_slots(node_id, statement.test)
        body_block = _import_block(builder, statement.body)
        if body_block.root_id:
            builder.connect(node_id, "body", body_block.root_id)
        return _ImportedBlock(root_id=node_id, continuations=((node_id, "after"),))

    if isinstance(statement, ast.For):
        node_id = builder.create_node(
            "loop",
            _loop_payload_from_parts(
                "for",
                target=ast.unparse(statement.target),
                iterable=ast.unparse(statement.iter),
            ),
        )
        builder.bind_input_slots(node_id, statement.iter)
        builder.record_assigned_names(node_id, statement)
        body_block = _import_block(builder, statement.body)
        if body_block.root_id:
            builder.connect(node_id, "body", body_block.root_id)
        return _ImportedBlock(root_id=node_id, continuations=((node_id, "after"),))

    raise FlowImportError(
        f"Visual flow mode does not support importing {statement.__class__.__name__} yet."
    )


def compile_flow_document(document: FlowModelDocument) -> FlowCompileResult:
    document = with_flow_document_derived_input_model(
        without_branch_after_edges(without_flow_return_completion_edges(document))
    )
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
                f"Input slot '{slot.label}' on node '{slot.node_id}' needs a value binding."
            )
    if not diagnostics:
        normalized_bindings = _normalize_flow_document_value_bindings(document)
        document = normalized_bindings.document
        diagnostics.extend(normalized_bindings.diagnostics)

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
        preserve_existing=True,
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


def _normalize_flow_document_value_bindings(
    document: FlowModelDocument,
) -> _ValueBindingNormalizationResult:
    """Assign Python spellings for canonical value bindings before source emit."""

    slot_by_id = {slot.slot_id: slot for slot in document.input_slots}
    function_input_by_id = {function_input.input_id: function_input for function_input in document.function_inputs}
    value_source_by_id = {source.source_id: source for source in document.value_sources}
    positions = _flow_document_node_positions(document)
    diagnostics: list[str] = []
    sources_to_alias: set[str] = set()

    for binding in document.input_bindings:
        slot = slot_by_id.get(binding.slot_id)
        if slot is None:
            continue
        function_input = function_input_by_id.get(binding.source_id)
        value_source = value_source_by_id.get(binding.source_id)
        if function_input is None and value_source is None:
            diagnostics.append(
                f"Input slot '{slot.label}' on node '{slot.node_id}' is bound to an unknown value source."
            )
            continue

        if value_source is not None:
            reason = _value_source_unavailable_reason(
                document,
                value_source,
                slot,
                positions=positions,
            )
            if reason is not None:
                diagnostics.append(_value_source_availability_diagnostic(reason, value_source, slot))
                continue
            source_name = value_source.name
        else:
            source_name = function_input.name

        current_source_id = _latest_available_source_id_for_name(
            document,
            source_name,
            slot,
            positions=positions,
        )
        if current_source_id == binding.source_id:
            continue

        if function_input is not None:
            for source in document.value_sources:
                if source.name != function_input.name:
                    continue
                if _value_source_unavailable_reason(document, source, slot, positions=positions) is None:
                    sources_to_alias.add(source.source_id)
            continue

        if value_source is not None:
            sources_to_alias.add(value_source.source_id)

    if diagnostics:
        return _ValueBindingNormalizationResult(
            document=document,
            diagnostics=tuple(dict.fromkeys(diagnostics)),
        )

    aliases, alias_diagnostics = _flow_value_source_aliases(
        document,
        source_ids_to_alias=sources_to_alias,
        positions=positions,
    )
    diagnostics.extend(alias_diagnostics)
    if diagnostics:
        return _ValueBindingNormalizationResult(
            document=document,
            diagnostics=tuple(dict.fromkeys(diagnostics)),
        )

    aliased_document = _with_flow_document_value_source_emitted_names(
        document,
        emitted_name_by_source_id=aliases,
    )
    rewritten = _rewrite_flow_document_value_source_stores(
        document,
        aliased_document,
    )
    return _ValueBindingNormalizationResult(document=rewritten, diagnostics=())


def _flow_document_node_positions(document: FlowModelDocument) -> dict[str, _FlowNodePosition]:
    node_by_id = {node.node_id: node for node in document.nodes}
    output_edges = {(edge.source_id, edge.source_handle): edge for edge in document.edges}
    entry_node = next((node for node in document.nodes if node.kind == "entry"), None)
    exit_node = next((node for node in document.nodes if node.kind == "exit"), None)
    exit_node_id = exit_node.node_id if exit_node is not None else None
    positions: dict[str, _FlowNodePosition] = {}
    next_order = 0

    def record(node_id: str, context: tuple[str, ...]) -> None:
        nonlocal next_order
        if node_id in positions:
            return
        positions[node_id] = _FlowNodePosition(order=next_order, context=context)
        next_order += 1

    def visit_sequence(
        start_node_id: str | None,
        context: tuple[str, ...],
        *,
        stop_node_id: str | None = None,
    ) -> None:
        current_id = start_node_id
        visited_in_sequence: set[str] = set()
        while current_id and current_id != exit_node_id and current_id != stop_node_id:
            if current_id in visited_in_sequence:
                return
            visited_in_sequence.add(current_id)
            node = node_by_id.get(current_id)
            if node is None:
                return
            if node.kind not in {"entry", "exit"}:
                record(node.node_id, context)
            if node.kind in {"assign", "call"}:
                current_id = target_id_for_edge(output_edges.get((current_id, "next")))
                continue
            if node.kind == "return":
                return
            if node.kind == "branch":
                true_start_id = target_id_for_edge(output_edges.get((current_id, "true")))
                false_start_id = target_id_for_edge(output_edges.get((current_id, "false")))
                merge_id = _branch_merge_node_id(
                    true_start_id,
                    false_start_id,
                    stop_node_id=stop_node_id,
                    exit_node_id=exit_node_id,
                    node_by_id=node_by_id,
                    output_edges=output_edges,
                )
                branch_stop_id = merge_id or stop_node_id
                visit_sequence(
                    true_start_id,
                    (*context, f"branch:{current_id}:true"),
                    stop_node_id=branch_stop_id,
                )
                visit_sequence(
                    false_start_id,
                    (*context, f"branch:{current_id}:false"),
                    stop_node_id=branch_stop_id,
                )
                current_id = merge_id
                continue
            if node.kind == "loop":
                visit_sequence(
                    target_id_for_edge(output_edges.get((current_id, "body"))),
                    (*context, f"loop:{current_id}:body"),
                )
                current_id = target_id_for_edge(output_edges.get((current_id, "after")))
                continue
            return

    if entry_node is not None:
        visit_sequence(target_id_for_edge(output_edges.get((entry_node.node_id, "start"))), ())

    for node in document.nodes:
        if node.kind in {"entry", "exit"} or node.node_id in positions:
            continue
        record(node.node_id, ("unreachable",))
    return positions


def _latest_available_source_id_for_name(
    document: FlowModelDocument,
    name: str,
    slot: FlowInputSlot,
    *,
    positions: dict[str, _FlowNodePosition],
) -> str | None:
    candidates: list[tuple[int, str]] = []
    for function_input in document.function_inputs:
        if function_input.name == name:
            candidates.append((-1, function_input.input_id))
    for source in document.value_sources:
        if source.name != name:
            continue
        reason = _value_source_unavailable_reason(
            document,
            source,
            slot,
            positions=positions,
        )
        if reason is not None:
            continue
        position = positions.get(source.node_id)
        if position is not None:
            candidates.append((position.order, source.source_id))
    if not candidates:
        return None
    return max(candidates, key=lambda item: item[0])[1]


def _value_source_unavailable_reason(
    document: FlowModelDocument,
    source: FlowValueSource,
    slot: FlowInputSlot,
    *,
    positions: dict[str, _FlowNodePosition],
) -> str | None:
    node_by_id = {node.node_id: node for node in document.nodes}
    source_node = node_by_id.get(source.node_id)
    source_position = positions.get(source.node_id)
    target_position = positions.get(slot.node_id)
    if source_node is None or source_position is None or target_position is None:
        return "unreachable source"

    if source_node.kind == "loop":
        loop_body_context = f"loop:{source_node.node_id}:body"
        if loop_body_context in target_position.context:
            return None
        if source_position.order < target_position.order:
            # Python's loop target spelling is representable after the loop only
            # when it does not require aliasing or structural initialization.
            return None

    if not _flow_context_is_prefix(source_position.context, target_position.context):
        missing_contexts = set(source_position.context) - set(target_position.context)
        if any(context.startswith("branch:") for context in missing_contexts):
            return "branch-only source after merge"
        if any(context.startswith("loop:") for context in missing_contexts):
            return "loop-body-only source after loop"
        return "unreachable source"

    if source_position.order >= target_position.order:
        return "future-source"
    return None


def _flow_context_is_prefix(source_context: tuple[str, ...], target_context: tuple[str, ...]) -> bool:
    return target_context[:len(source_context)] == source_context


def _value_source_availability_diagnostic(
    reason: str,
    source: FlowValueSource,
    slot: FlowInputSlot,
) -> str:
    return (
        f"Input slot '{slot.label}' on node '{slot.node_id}' is bound to value "
        f"'{source.name}', but clean Python generation cannot express that binding: {reason}."
    )


def _flow_value_source_aliases(
    document: FlowModelDocument,
    *,
    source_ids_to_alias: set[str],
    positions: dict[str, _FlowNodePosition],
) -> tuple[dict[str, str], list[str]]:
    if not source_ids_to_alias:
        return {}, []

    node_by_id = {node.node_id: node for node in document.nodes}
    sources_by_name: dict[str, list[FlowValueSource]] = {}
    for source in document.value_sources:
        sources_by_name.setdefault(source.name, []).append(source)
    for sources in sources_by_name.values():
        sources.sort(key=lambda source: (
            positions.get(source.node_id, _FlowNodePosition(10**9, ())).order,
            source.source_id,
        ))

    used_names = {
        function_input.name
        for function_input in document.function_inputs
    }
    used_names.update(
        source.name
        for source in document.value_sources
        if source.source_id not in source_ids_to_alias
    )
    aliases: dict[str, str] = {}
    diagnostics: list[str] = []
    for source in sorted(
        (source for source in document.value_sources if source.source_id in source_ids_to_alias),
        key=lambda item: (
            item.name,
            positions.get(item.node_id, _FlowNodePosition(10**9, ())).order,
            item.source_id,
        ),
    ):
        source_node = node_by_id.get(source.node_id)
        if source_node is None or source_node.kind not in {"assign", "loop"}:
            diagnostics.append(
                f"Value source '{source.name}' on node '{source.node_id}' cannot be aliased because "
                "its producing statement is not a supported assignment or loop target."
            )
            continue
        same_name_sources = sources_by_name.get(source.name, [])
        ordinal = next(
            (
                index
                for index, candidate in enumerate(same_name_sources)
                if candidate.source_id == source.source_id
            ),
            0,
        )
        candidate = f"{source.name}__flow_{ordinal}"
        while candidate in used_names or candidate in aliases.values():
            ordinal += 1
            candidate = f"{source.name}__flow_{ordinal}"
        aliases[source.source_id] = candidate
        used_names.add(candidate)
    return aliases, diagnostics


def _with_flow_document_value_source_emitted_names(
    document: FlowModelDocument,
    *,
    emitted_name_by_source_id: dict[str, str],
) -> FlowModelDocument:
    return replace(
        document,
        value_sources=tuple(
            replace(
                source,
                emitted_name=(
                    emitted_name_by_source_id[source.source_id]
                    if source.source_id in emitted_name_by_source_id
                    else None
                ),
            )
            for source in document.value_sources
        ),
    )


def target_id_for_edge(edge: FlowModelEdge | None) -> str | None:
    if edge is None:
        return None
    return edge.target_id


def _reachable_flow_distances(
    start_node_id: str | None,
    *,
    stop_node_id: str | None,
    exit_node_id: str | None,
    node_by_id: dict[str, FlowModelNode],
    output_edges: dict[tuple[str, str], FlowModelEdge],
) -> dict[str, int]:
    if start_node_id is None:
        return {}

    distances: dict[str, int] = {}
    queue: list[tuple[str, int]] = [(start_node_id, 0)]
    while queue:
        node_id, distance = queue.pop(0)
        if node_id in distances and distances[node_id] <= distance:
            continue
        node = node_by_id.get(node_id)
        if node is None:
            continue
        distances[node_id] = distance
        if node_id == stop_node_id or node_id == exit_node_id:
            continue
        for handle in allowed_flow_output_handles(node.kind):
            target_id = target_id_for_edge(output_edges.get((node_id, handle)))
            if target_id is not None:
                queue.append((target_id, distance + 1))
    return distances


def _branch_merge_node_id(
    true_start_id: str | None,
    false_start_id: str | None,
    *,
    stop_node_id: str | None,
    exit_node_id: str | None,
    node_by_id: dict[str, FlowModelNode],
    output_edges: dict[tuple[str, str], FlowModelEdge],
) -> str | None:
    true_distances = _reachable_flow_distances(
        true_start_id,
        stop_node_id=stop_node_id,
        exit_node_id=exit_node_id,
        node_by_id=node_by_id,
        output_edges=output_edges,
    )
    false_distances = _reachable_flow_distances(
        false_start_id,
        stop_node_id=stop_node_id,
        exit_node_id=exit_node_id,
        node_by_id=node_by_id,
        output_edges=output_edges,
    )
    common_ids = set(true_distances) & set(false_distances)
    if not common_ids:
        return None
    return min(
        common_ids,
        key=lambda node_id: (
            max(true_distances[node_id], false_distances[node_id]),
            true_distances[node_id] + false_distances[node_id],
            node_id,
        ),
    )


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
        return ("true", "false")
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
            statement = _parse_loop_statement_from_payload(node.payload)
            if statement is None:
                return set()
            if isinstance(statement, ast.While):
                return _names_used(statement.test)
            if isinstance(statement, ast.For):
                return _names_used(statement.iter)
            return set()
        if node.kind == "return":
            names: set[str] = set()
            expression_graph = node.payload.get(_RETURN_EXPRESSION_GRAPH_KEY)
            if isinstance(expression_graph, dict):
                names.update(_expression_graph_input_names(expression_graph))
            expression = _return_expression_from_payload(node.payload)
            if not expression:
                return names
            names.update(_names_used(ast.parse(expression, mode="eval")))
            return names
    except SyntaxError:
        return set()
    return set()


def _assigned_names_by_flow_node_payload(node: FlowModelNode) -> set[str]:
    try:
        if node.kind == "assign":
            parsed = ast.parse(f"{str(node.payload.get('source') or '').strip()}\n").body
            return _assigned_names(parsed[0]) if parsed else set()
        if node.kind == "loop":
            statement = _parse_loop_statement_from_payload(node.payload)
            return _assigned_names(statement) if statement else set()
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


class _StoreNameRewriteTransformer(ast.NodeTransformer):
    def __init__(self, replacements: dict[str, str]) -> None:
        self.replacements = replacements

    def visit_Name(self, node: ast.Name) -> ast.AST:
        if isinstance(node.ctx, ast.Store) and node.id in self.replacements:
            return ast.copy_location(ast.Name(id=self.replacements[node.id], ctx=node.ctx), node)
        return node


def _rewrite_ast_input_names(node: ast.AST, replacements: dict[str, str]) -> ast.AST:
    rewritten = _InputNameRewriteTransformer(replacements).visit(node)
    ast.fix_missing_locations(rewritten)
    return rewritten


def _rewrite_ast_store_names(node: ast.AST, replacements: dict[str, str]) -> ast.AST:
    rewritten = _StoreNameRewriteTransformer(replacements).visit(node)
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
            statement = _parse_loop_statement_from_payload(node.payload)
            if statement is None:
                return node.payload
            statement = _rewrite_ast_input_names(statement, replacements)
            if isinstance(statement, ast.While):
                return {
                    **node.payload,
                    **_loop_payload_from_parts("while", condition=ast.unparse(statement.test)),
                }
            if isinstance(statement, ast.For):
                return {
                    **node.payload,
                    **_loop_payload_from_parts(
                        "for",
                        target=ast.unparse(statement.target),
                        iterable=ast.unparse(statement.iter),
                    ),
                }
            return node.payload
        if node.kind == "return":
            expression_graph = node.payload.get(_RETURN_EXPRESSION_GRAPH_KEY)
            if isinstance(expression_graph, dict):
                next_graph = _rewrite_expression_graph_input_names(expression_graph, replacements)
                try:
                    return {
                        **node.payload,
                        "expression": expression_from_expression_graph(next_graph),
                        _RETURN_EXPRESSION_GRAPH_KEY: next_graph,
                    }
                except ValueError:
                    return {**node.payload, _RETURN_EXPRESSION_GRAPH_KEY: next_graph}

            expression = _return_expression_from_payload(node.payload)
            if not expression:
                return node.payload
            parsed = ast.parse(expression, mode="eval")
            rewritten = _rewrite_ast_input_names(parsed.body, replacements)
            return {**node.payload, "expression": ast.unparse(rewritten)}
    except SyntaxError:
        return node.payload
    return node.payload


def _rewrite_flow_document_value_source_stores(
    before: FlowModelDocument,
    after: FlowModelDocument,
) -> FlowModelDocument:
    before_source_by_id = {source.source_id: source for source in before.value_sources}
    store_replacements_by_node_id: dict[str, dict[str, str]] = {}
    for source in after.value_sources:
        previous = before_source_by_id.get(source.source_id)
        if previous is None:
            continue
        previous_name = flow_value_source_emitted_name(previous)
        next_name = flow_value_source_emitted_name(source)
        if previous_name == next_name:
            continue
        store_replacements_by_node_id.setdefault(source.node_id, {})[previous_name] = next_name
    if not store_replacements_by_node_id:
        return after

    return replace(
        after,
        nodes=tuple(
            replace(
                node,
                payload=_rewrite_flow_node_payload_store_names(
                    node,
                    store_replacements_by_node_id.get(node.node_id, {}),
                ),
            )
            if node.node_id in store_replacements_by_node_id
            else node
            for node in after.nodes
        ),
    )


def _rewrite_flow_node_payload_store_names(
    node: FlowModelNode,
    replacements: dict[str, str],
) -> dict[str, Any]:
    if not replacements:
        return node.payload
    try:
        if node.kind == "assign":
            parsed = ast.parse(f"{str(node.payload.get('source') or '').strip()}\n").body
            if len(parsed) != 1:
                return node.payload
            rewritten = _rewrite_ast_store_names(parsed[0], replacements)
            return {**node.payload, "source": ast.unparse(rewritten)}
        if node.kind == "loop":
            statement = _parse_loop_statement_from_payload(node.payload)
            if statement is None:
                return node.payload
            statement = _rewrite_ast_store_names(statement, replacements)
            if isinstance(statement, ast.While):
                return {
                    **node.payload,
                    **_loop_payload_from_parts("while", condition=ast.unparse(statement.test)),
                }
            if isinstance(statement, ast.For):
                return {
                    **node.payload,
                    **_loop_payload_from_parts(
                        "for",
                        target=ast.unparse(statement.target),
                        iterable=ast.unparse(statement.iter),
                    ),
                }
    except SyntaxError:
        return node.payload
    return node.payload


def _validate_expression_graph_payload(node: FlowModelNode) -> list[str]:
    graph = node.payload.get(_RETURN_EXPRESSION_GRAPH_KEY)
    if graph is None:
        return []
    if not isinstance(graph, dict):
        return [f"Return node '{node.node_id}' has an invalid expression graph payload."]

    diagnostics: list[str] = []
    try:
        root_id, nodes, incoming_by_target = _expression_graph_payload(graph)
    except ValueError as exc:
        return [f"Return node '{node.node_id}' has an invalid expression graph: {exc}"]

    if root_id is not None:
        try:
            expression_from_expression_graph(graph)
        except ValueError as exc:
            diagnostics.append(f"Return node '{node.node_id}' has an invalid expression graph: {exc}")

    reachable: set[str] = set()

    def visit(node_id: str) -> None:
        if node_id in reachable:
            return
        reachable.add(node_id)
        for edge in incoming_by_target.get(node_id, []):
            visit(edge["source_id"])

    if root_id is not None and root_id in nodes:
        visit(root_id)

    unwired_inputs = sorted(
        str(candidate["payload"].get("name") or candidate["label"])
        for node_id, candidate in nodes.items()
        if candidate["kind"] == "input" and node_id not in reachable
    )
    if unwired_inputs:
        diagnostics.append(
            f"Return node '{node.node_id}' has expression input"
            f"{'s' if len(unwired_inputs) != 1 else ''} not connected to the return expression: "
            f"{', '.join(unwired_inputs)}."
        )
    return diagnostics


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
        raw_loop_type = str(payload.get("loop_type") or payload.get("loopType") or "").strip()
        if raw_loop_type and raw_loop_type not in _LOOP_TYPES:
            diagnostics.append(
                f"Loop node '{node.node_id}' must use loop_type 'while' or 'for'."
            )
        normalized_loop = _normalized_loop_payload(payload)
        loop_type = str(normalized_loop.get("loop_type") or "while")
        if loop_type == "for":
            if not str(normalized_loop.get("target") or "").strip():
                diagnostics.append(f"Loop node '{node.node_id}' needs an item target.")
            if not str(normalized_loop.get("iterable") or "").strip():
                diagnostics.append(f"Loop node '{node.node_id}' needs an iterable.")
        elif not str(normalized_loop.get("condition") or "").strip():
            diagnostics.append(f"Loop node '{node.node_id}' needs a condition.")
        header = _loop_header_from_payload(payload)
        if not header:
            diagnostics.append(f"Loop node '{node.node_id}' needs a loop header.")
        else:
            try:
                parsed = ast.parse(f"{header}:\n    pass\n").body
            except SyntaxError as exc:
                diagnostics.append(f"Loop node '{node.node_id}' has invalid loop fields: {exc.msg}.")
            else:
                if len(parsed) != 1 or not isinstance(parsed[0], (ast.For, ast.While)):
                    diagnostics.append(
                        f"Loop node '{node.node_id}' must start with 'while' or 'for ... in ...'."
                    )
        if (node.node_id, "body") not in output_edges:
            diagnostics.append(f"Loop node '{node.node_id}' needs a Repeat connection.")
    elif node.kind == "return":
        expression = _return_expression_from_payload(payload)
        if expression:
            try:
                ast.parse(expression, mode="eval")
            except SyntaxError as exc:
                diagnostics.append(f"Return node '{node.node_id}' has an invalid expression: {exc.msg}.")
        diagnostics.extend(_validate_expression_graph_payload(node))
    return diagnostics


def _compile_sequence(
    *,
    start_node_id: str | None,
    exit_node_id: str,
    node_by_id: dict[str, FlowModelNode],
    output_edges: dict[tuple[str, str], FlowModelEdge],
    stop_node_id: str | None = None,
) -> list[str]:
    lines: list[str] = []
    current_id = start_node_id
    visited: set[str] = set()
    while current_id and current_id != exit_node_id and current_id != stop_node_id:
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
            expression = _return_expression_from_payload(node.payload)
            lines.append(f"return {expression}" if expression else "return")
            break
        if node.kind == "branch":
            condition = str(node.payload.get("condition") or "").strip()
            true_start_id = target_id_for_edge(output_edges.get((current_id, "true")))
            false_start_id = target_id_for_edge(output_edges.get((current_id, "false")))
            merge_id = _branch_merge_node_id(
                true_start_id,
                false_start_id,
                stop_node_id=stop_node_id,
                exit_node_id=exit_node_id,
                node_by_id=node_by_id,
                output_edges=output_edges,
            )
            branch_stop_id = merge_id or stop_node_id
            true_lines = _compile_sequence(
                start_node_id=true_start_id,
                exit_node_id=exit_node_id,
                node_by_id=node_by_id,
                output_edges=output_edges,
                stop_node_id=branch_stop_id,
            )
            false_lines = _compile_sequence(
                start_node_id=false_start_id,
                exit_node_id=exit_node_id,
                node_by_id=node_by_id,
                output_edges=output_edges,
                stop_node_id=branch_stop_id,
            )
            lines.append(f"if {condition}:")
            lines.extend(_indent_lines(true_lines or ["pass"]))
            if false_lines:
                lines.append("else:")
                lines.extend(_indent_lines(false_lines))
            current_id = merge_id
            continue
        if node.kind == "loop":
            header = _loop_header_from_payload(node.payload)
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

    def visit(start_node_id: str | None, *, stop_node_id: str | None = None) -> None:
        current_id = start_node_id
        exit_node_id = exit_node.node_id if exit_node else None
        while current_id and current_id != exit_node_id and current_id != stop_node_id:
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
                true_start_id = target_id_for_edge(output_edges.get((current_id, "true")))
                false_start_id = target_id_for_edge(output_edges.get((current_id, "false")))
                merge_id = _branch_merge_node_id(
                    true_start_id,
                    false_start_id,
                    stop_node_id=stop_node_id,
                    exit_node_id=exit_node_id,
                    node_by_id=node_by_id,
                    output_edges=output_edges,
                )
                branch_stop_id = merge_id or stop_node_id
                visit(true_start_id, stop_node_id=branch_stop_id)
                visit(false_start_id, stop_node_id=branch_stop_id)
                current_id = merge_id
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
    source_id_by_old_id: dict[str, str] = {
        function_input.input_id: function_input.input_id
        for function_input in document.function_inputs
    }
    node_by_id = {node.node_id: node for node in document.nodes}
    normalized_sources: list[FlowValueSource] = []
    seen_source_ids: set[str] = set()
    for source in document.value_sources:
        node = node_by_id.get(source.node_id)
        if node is None:
            continue
        next_source_id = flow_value_source_id(flow_model_node_source_identity(node), source.name)
        source_id_by_old_id[source.source_id] = next_source_id
        if next_source_id in seen_source_ids:
            continue
        seen_source_ids.add(next_source_id)
        normalized_sources.append(replace(source, source_id=next_source_id))

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
        next_source_id = source_id_by_old_id.get(binding.source_id)
        if next_slot_id is None or next_source_id is None:
            continue
        if next_slot_id in seen_bound_slot_ids:
            continue
        seen_bound_slot_ids.add(next_slot_id)
        normalized_bindings.append(
            FlowInputBinding(
                binding_id=flow_input_binding_id(next_slot_id, next_source_id),
                source_id=next_source_id,
                slot_id=next_slot_id,
                function_input_id=next_source_id if next_source_id in function_input_ids else None,
            )
        )

    normalized_nodes = tuple(
        replace(
            node,
            payload={
                **node.payload,
                _RETURN_EXPRESSION_GRAPH_KEY: _rewrite_expression_graph_slot_ids(
                    node.payload[_RETURN_EXPRESSION_GRAPH_KEY],
                    slot_id_by_old_id,
                ),
            },
        )
        if node.kind == "return" and isinstance(node.payload.get(_RETURN_EXPRESSION_GRAPH_KEY), dict)
        else node
        for node in document.nodes
    )

    return replace(
        document,
        nodes=normalized_nodes,
        value_model_version=FLOW_VALUE_MODEL_VERSION,
        value_sources=tuple(normalized_sources),
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
        header = _loop_header_from_payload(node.payload)
        return header or "Loop"
    if node.kind == "return":
        expression = _return_expression_from_payload(node.payload)
        return f"return {expression}" if expression else "return"
    return node.kind.title()


def flow_edge_label(source_handle: str) -> str | None:
    if source_handle == "body":
        return "Repeat"
    if source_handle == "after":
        return "Done"
    if source_handle in {"true", "false", "exit"}:
        return source_handle
    return None


def flow_edge_order(source_handle: str) -> int | None:
    return {
        "true": 0,
        "false": 1,
        "body": 0,
        "after": 2,
        "exit": 3,
    }.get(source_handle)
