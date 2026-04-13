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
FLOW_NODE_KINDS = {"entry", "assign", "call", "branch", "loop", "return", "exit"}
FLOW_SYNC_STATES = {"clean", "draft", "import_error"}


@dataclass(frozen=True)
class FlowModelNode:
    node_id: str
    kind: str
    payload: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.node_id,
            "kind": self.kind,
            "payload": self.payload,
        }


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
class FlowModelDocument:
    symbol_id: str
    relative_path: str
    qualname: str
    nodes: tuple[FlowModelNode, ...]
    edges: tuple[FlowModelEdge, ...]
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
    nodes: list[FlowModelNode]
    edges: list[FlowModelEdge]
    next_index: int = 0

    def create_node(self, kind: str, payload: dict[str, Any]) -> str:
        node_id = f"flowdoc:{self.symbol_id}:{kind}:{self.next_index}"
        self.next_index += 1
        self.nodes.append(FlowModelNode(node_id=node_id, kind=kind, payload=payload))
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


def flow_models_path(root_path: Path) -> Path:
    return root_path / FLOW_MODEL_RELATIVE_PATH


def flow_edge_id(
    source_id: str,
    source_handle: str,
    target_id: str,
    target_handle: str,
) -> str:
    return f"controls:{source_id}:{source_handle}->{target_id}:{target_handle}"


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
        if not node_id or kind not in FLOW_NODE_KINDS:
            raise ValueError("Flow graph nodes require a valid id and kind.")
        if node_id in seen_node_ids:
            raise ValueError(f"Duplicate flow node id '{node_id}'.")
        if not isinstance(payload_value, dict):
            raise ValueError("Flow graph node payloads must be objects.")
        seen_node_ids.add(node_id)
        nodes.append(FlowModelNode(node_id=node_id, kind=kind, payload=dict(payload_value)))

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

    builder = _ImportBuilder(
        symbol_id=symbol_id,
        relative_path=relative_path,
        qualname=qualname,
        nodes=[
            FlowModelNode(node_id=f"flowdoc:{symbol_id}:entry", kind="entry", payload={}),
            FlowModelNode(node_id=f"flowdoc:{symbol_id}:exit", kind="exit", payload={}),
        ],
        edges=[],
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
        return _ImportedBlock(root_id=node_id, continuation=None)

    if isinstance(statement, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
        node_id = builder.create_node("assign", {"source": ast.unparse(statement)})
        return _ImportedBlock(root_id=node_id, continuation=(node_id, "next"))

    if isinstance(statement, ast.Expr):
        if any(isinstance(node, ast.Call) for node in ast.walk(statement)):
            node_id = builder.create_node("call", {"source": ast.unparse(statement)})
            return _ImportedBlock(root_id=node_id, continuation=(node_id, "next"))
        raise FlowImportError("Expression statements without a call are not supported in visual flow mode.")

    if isinstance(statement, ast.If):
        node_id = builder.create_node("branch", {"condition": ast.unparse(statement.test)})
        true_block = _import_block(builder, statement.body)
        false_block = _import_block(builder, statement.orelse)
        if true_block.root_id:
            builder.connect(node_id, "true", true_block.root_id)
        if false_block.root_id:
            builder.connect(node_id, "false", false_block.root_id)
        return _ImportedBlock(root_id=node_id, continuation=(node_id, "after"))

    if isinstance(statement, ast.While):
        node_id = builder.create_node("loop", {"header": f"while {ast.unparse(statement.test)}"})
        body_block = _import_block(builder, statement.body)
        if body_block.root_id:
            builder.connect(node_id, "body", body_block.root_id)
        return _ImportedBlock(root_id=node_id, continuation=(node_id, "after"))

    if isinstance(statement, ast.For):
        header = f"for {ast.unparse(statement.target)} in {ast.unparse(statement.iter)}"
        node_id = builder.create_node("loop", {"header": header})
        body_block = _import_block(builder, statement.body)
        if body_block.root_id:
            builder.connect(node_id, "body", body_block.root_id)
        return _ImportedBlock(root_id=node_id, continuation=(node_id, "after"))

    raise FlowImportError(
        f"Visual flow mode does not support importing {statement.__class__.__name__} yet."
    )


def compile_flow_document(document: FlowModelDocument) -> FlowCompileResult:
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
