"""Flow GraphView projection helpers for Python workspace graphs."""

from __future__ import annotations

import ast
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

from helm.editor.flow_model import (
    FlowImportError,
    FlowFunctionInput,
    FlowInputBinding,
    FlowInputSlot,
    FlowModelDocument,
    FlowModelEdge,
    FlowModelNode,
    FlowValueSource,
    flow_edge_label,
    flow_edge_order,
    flow_function_input_id,
    flow_input_binding_id,
    flow_input_slot_id,
    flow_model_node_source_identity,
    flow_node_label,
    flow_return_completion_edge_id,
    flow_value_source_id,
    function_inputs_from_function_source,
    function_source_for_qualname,
    function_source_hash,
    import_flow_document_from_function_source,
    indexed_flow_entry_node_id,
    read_flow_document,
    with_flow_document_inherited_input_model,
    without_flow_return_completion_edges,
)
from helm.graph import EdgeKind, GraphNode, NodeKind
from helm.graph.models import (
    GraphAbstractionLevel,
    GraphFocus,
    GraphView,
    GraphViewEdge,
    GraphViewEdgeKind,
    GraphViewNode,
    GraphViewNodeKind,
)
from helm.parser import ParsedModule, SymbolDef, SymbolKind
from helm.parser.symbols import SourceSpan
from helm.ui.graph_projection import GraphProjector
from helm.ui.projection_context import (
    ProjectionContext,
    is_function_like_symbol_kind,
)

_FLOW_VISUAL_GRAPH_NODE_KINDS = {
    GraphViewNodeKind.ENTRY,
    GraphViewNodeKind.ASSIGN,
    GraphViewNodeKind.CALL,
    GraphViewNodeKind.BRANCH,
    GraphViewNodeKind.LOOP,
    GraphViewNodeKind.RETURN,
    GraphViewNodeKind.EXIT,
}


def get_flow_view(context: ProjectionContext, symbol_id: str) -> GraphView:
    return FlowProjector(context).get_flow_view(symbol_id)


class FlowProjector:
    def __init__(self, context: ProjectionContext) -> None:
        self.context = context
        self.graph_projector = GraphProjector(context)

    def get_flow_view(self, symbol_id: str) -> GraphView:
        symbol_node = self.context.require_graph_node(symbol_id)
        if symbol_node.kind != NodeKind.SYMBOL:
            raise ValueError("Flow view is only available for symbols.")

        parsed, symbol = self.context.require_symbol(symbol_id)
        if is_function_like_symbol_kind(symbol.kind):
            return self._build_function_flow_view(symbol_node, parsed, symbol)
        if symbol.kind == SymbolKind.CLASS:
            return self._build_class_flow_view(symbol_node, symbol)
        raise ValueError("Flow view is only available for functions, methods, and classes.")

    def _build_function_flow_view(
        self,
        symbol_node: GraphNode,
        parsed: ParsedModule,
        symbol: SymbolDef,
    ) -> GraphView:
        source = Path(parsed.module.file_path).read_text(encoding="utf-8")
        base_view = self._build_code_derived_function_flow_view(
            symbol_node=symbol_node,
            parsed=parsed,
            symbol=symbol,
            source=source,
            flow_state=None,
        )
        persisted_document = read_flow_document(self.context.root_path, symbol.symbol_id)
        current_source_hash = function_source_hash(
            function_source_for_qualname(source, symbol.qualname)
        )

        if persisted_document is not None and persisted_document.source_hash == current_source_hash:
            document = persisted_document
            if (
                persisted_document.value_model_version is None
                or not persisted_document.input_slots
                or not persisted_document.value_sources
            ):
                try:
                    source_document = import_flow_document_from_function_source(
                        symbol_id=symbol.symbol_id,
                        relative_path=parsed.module.relative_path,
                        qualname=symbol.qualname,
                        module_source=source,
                    )
                except FlowImportError:
                    source_document = None
                if source_document is not None:
                    document = with_flow_document_inherited_input_model(
                        document,
                        source_document=source_document,
                    )
            return _project_function_flow_document_view(
                base_view,
                document,
            )

        try:
            imported_document = import_flow_document_from_function_source(
                symbol_id=symbol.symbol_id,
                relative_path=parsed.module.relative_path,
                qualname=symbol.qualname,
                module_source=source,
            )
        except FlowImportError as exc:
            return replace(
                base_view,
                flow_state=_flow_state_payload(
                    _build_import_error_flow_document(
                        symbol_id=symbol.symbol_id,
                        relative_path=parsed.module.relative_path,
                        qualname=symbol.qualname,
                        module_source=source,
                        previous_document=persisted_document,
                        source_hash=current_source_hash,
                        diagnostics=(str(exc),),
                    )
                ),
            )

        return _project_function_flow_document_view(
            base_view,
            imported_document,
        )

    def _build_code_derived_function_flow_view(
        self,
        *,
        symbol_node: GraphNode,
        parsed: ParsedModule,
        symbol: SymbolDef,
        source: str,
        flow_state: dict[str, Any] | None,
    ) -> GraphView:
        symbol_id = symbol.symbol_id
        tree = ast.parse(source, filename=parsed.module.file_path)
        function_node = _find_ast_symbol(tree, symbol.qualname)
        if not isinstance(function_node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            raise ValueError(f"Unable to resolve flow for {symbol.qualname}.")

        nodes: list[GraphViewNode] = []
        edges: list[GraphViewEdge] = []
        breadcrumbs = self.graph_projector.breadcrumbs_for_symbol(symbol_node, include_flow=True)
        entry_id = f"flow:{symbol_id}:entry"
        nodes.append(
            GraphViewNode(
                node_id=entry_id,
                kind=GraphViewNodeKind.ENTRY,
                label="Entry",
                subtitle=symbol.qualname,
                metadata={"flow_order": 0},
            )
        )

        function_inputs = function_inputs_from_function_source(
            symbol_id=symbol_id,
            qualname=symbol.qualname,
            module_source=source,
        )
        argument_by_name = {
            argument.arg: argument
            for argument in (
                *function_node.args.posonlyargs,
                *function_node.args.args,
                *((function_node.args.vararg,) if function_node.args.vararg is not None else ()),
                *function_node.args.kwonlyargs,
                *((function_node.args.kwarg,) if function_node.args.kwarg is not None else ()),
            )
        }

        definitions: dict[str, str] = {}
        previous_control_id = entry_id
        for function_input in function_inputs:
            argument = argument_by_name.get(function_input.name)
            param_id = _function_input_param_node_id(symbol_id, function_input)
            nodes.append(
                GraphViewNode(
                    node_id=param_id,
                    kind=GraphViewNodeKind.PARAM,
                    label=function_input.name,
                    subtitle="parameter",
                    metadata={
                        **(_source_metadata_for_ast_node(argument) if argument is not None else {}),
                        "function_input_id": function_input.input_id,
                        "function_input_kind": function_input.kind,
                        "default_expression": function_input.default_expression,
                        "signature_owner_id": entry_id,
                        "signature_order": function_input.index,
                        "source_handle": _function_input_source_handle(function_input.input_id),
                    },
                )
            )
            definitions[function_input.name] = param_id

        _append_statement_block(
            statements=function_node.body,
            symbol_id=symbol_id,
            pending_links=[_PendingControlLink(source_id=previous_control_id)],
            nodes=nodes,
            edges=edges,
            definitions=definitions,
            statement_index=0,
        )

        return GraphView(
            root_node_id=entry_id,
            target_id=symbol_id,
            level=GraphAbstractionLevel.FLOW,
            nodes=tuple(nodes),
            edges=tuple(edges),
            breadcrumbs=breadcrumbs,
            focus=GraphFocus(
                target_id=symbol_id,
                level=GraphAbstractionLevel.FLOW,
                label=symbol_node.name,
                subtitle=symbol.qualname,
                available_levels=(
                    GraphAbstractionLevel.REPO,
                    GraphAbstractionLevel.MODULE,
                    GraphAbstractionLevel.SYMBOL,
                    GraphAbstractionLevel.FLOW,
                ),
            ),
            truncated=False,
            flow_state=flow_state
            or {
                "editable": False,
                "sync_state": "clean",
                "diagnostics": [],
                "document": None,
            },
        )

    def _build_class_flow_view(
        self,
        symbol_node: GraphNode,
        symbol: SymbolDef,
    ) -> GraphView:
        symbol_id = symbol.symbol_id
        breadcrumbs = self.graph_projector.breadcrumbs_for_symbol(symbol_node, include_flow=True)
        entry_id = f"flow:{symbol_id}:entry"
        nodes: list[GraphViewNode] = [
            GraphViewNode(
                node_id=entry_id,
                kind=GraphViewNodeKind.ENTRY,
                label="Entry",
                subtitle=symbol.qualname,
                metadata={"flow_order": 0},
            )
        ]
        edges: list[GraphViewEdge] = []
        direct_children = self.context.direct_child_symbols(symbol_id)
        direct_child_ids = {child.symbol_id for child in direct_children}

        for index, child in enumerate(direct_children, start=1):
            child_node = self.context.require_graph_node(child.symbol_id)
            child_view = self.graph_projector.symbol_view_node(child_node)
            nodes.append(
                GraphViewNode(
                    node_id=child_view.node_id,
                    kind=child_view.kind,
                    label=child_view.label,
                    subtitle=child_view.subtitle,
                    metadata={**child_view.metadata, "flow_order": index},
                    available_actions=child_view.available_actions,
                )
            )
            edges.append(
                GraphViewEdge(
                    edge_id=f"contains:{entry_id}->{child.symbol_id}",
                    kind=GraphViewEdgeKind.CONTAINS,
                    source_id=entry_id,
                    target_id=child.symbol_id,
                )
            )

        for edge in self.context.graph.edges:
            if (
                edge.kind == EdgeKind.CALLS
                and edge.source_id in direct_child_ids
                and edge.target_id in direct_child_ids
            ):
                edges.append(
                    GraphViewEdge(
                        edge_id=edge.edge_id,
                        kind=GraphViewEdgeKind.CALLS,
                        source_id=edge.source_id,
                        target_id=edge.target_id,
                        label=str(edge.metadata.get("callee_expr", "calls")),
                        metadata=edge.metadata,
                    )
                )

        return GraphView(
            root_node_id=entry_id,
            target_id=symbol_id,
            level=GraphAbstractionLevel.FLOW,
            nodes=tuple(nodes),
            edges=tuple(edges),
            breadcrumbs=breadcrumbs,
            focus=GraphFocus(
                target_id=symbol_id,
                level=GraphAbstractionLevel.FLOW,
                label=symbol_node.name,
                subtitle=symbol.qualname,
                available_levels=(
                    GraphAbstractionLevel.REPO,
                    GraphAbstractionLevel.MODULE,
                    GraphAbstractionLevel.SYMBOL,
                    GraphAbstractionLevel.FLOW,
                ),
            ),
            truncated=False,
        )


@dataclass(frozen=True)
class _PendingControlLink:
    source_id: str
    path_key: str | None = None
    path_label: str | None = None
    path_order: int | None = None


def _append_statement_block(
    *,
    statements: list[ast.stmt],
    symbol_id: str,
    pending_links: list[_PendingControlLink],
    nodes: list[GraphViewNode],
    edges: list[GraphViewEdge],
    definitions: dict[str, str],
    statement_index: int,
) -> tuple[list[_PendingControlLink], int]:
    current_links = pending_links
    for statement in statements:
        current_links, statement_index = _append_statement_flow(
            statement=statement,
            symbol_id=symbol_id,
            pending_links=current_links,
            nodes=nodes,
            edges=edges,
            definitions=definitions,
            statement_index=statement_index,
        )
    return current_links, statement_index


def _append_control_edges(
    *,
    pending_links: list[_PendingControlLink],
    target_id: str,
    edges: list[GraphViewEdge],
) -> None:
    for pending in pending_links:
        metadata: dict[str, Any] = {}
        if pending.path_key is not None:
            metadata["path_key"] = pending.path_key
        if pending.path_label is not None:
            metadata["path_label"] = pending.path_label
        if pending.path_order is not None:
            metadata["path_order"] = pending.path_order

        suffix = f":{pending.path_key}" if pending.path_key else ""
        edges.append(
            GraphViewEdge(
                edge_id=f"controls:{pending.source_id}->{target_id}{suffix}",
                kind=GraphViewEdgeKind.CONTROLS,
                source_id=pending.source_id,
                target_id=target_id,
                label=pending.path_label,
                metadata=metadata,
            )
        )


def _pending_path(
    source_id: str,
    path_key: str,
    path_label: str,
    path_order: int,
) -> _PendingControlLink:
    return _PendingControlLink(
        source_id=source_id,
        path_key=path_key,
        path_label=path_label,
        path_order=path_order,
    )


def _strip_pending_paths(pending_links: list[_PendingControlLink]) -> list[_PendingControlLink]:
    return [_PendingControlLink(source_id=pending.source_id) for pending in pending_links]


def _append_statement_flow(
    *,
    statement: ast.stmt,
    symbol_id: str,
    pending_links: list[_PendingControlLink],
    nodes: list[GraphViewNode],
    edges: list[GraphViewEdge],
    definitions: dict[str, str],
    statement_index: int,
) -> tuple[list[_PendingControlLink], int]:
    node_id = f"flow:{symbol_id}:statement:{statement_index}"
    flow_order = statement_index + 1
    statement_index += 1
    kind = _statement_kind(statement)
    label = _statement_label(statement)
    nodes.append(
        GraphViewNode(
            node_id=node_id,
            kind=kind,
            label=label,
            subtitle=statement.__class__.__name__,
            metadata={
                "flow_order": flow_order,
                **_source_metadata_for_ast_node(statement),
            },
        )
    )
    _append_control_edges(pending_links=pending_links, target_id=node_id, edges=edges)

    for used_name in _names_used(statement):
        source_id = definitions.get(used_name)
        if source_id and source_id != node_id:
            edges.append(
                GraphViewEdge(
                    edge_id=f"data:{source_id}->{node_id}:{used_name}:{statement_index}",
                    kind=GraphViewEdgeKind.DATA,
                    source_id=source_id,
                    target_id=node_id,
                    label=used_name,
                )
            )

    for assigned_name in _assigned_names(statement):
        definitions[assigned_name] = node_id

    if isinstance(statement, ast.If):
        true_exits, statement_index = _append_statement_block(
            statements=statement.body,
            symbol_id=symbol_id,
            pending_links=[_pending_path(node_id, "true", "true", 0)],
            nodes=nodes,
            edges=edges,
            definitions=definitions,
            statement_index=statement_index,
        )
        false_exits, statement_index = _append_statement_block(
            statements=statement.orelse,
            symbol_id=symbol_id,
            pending_links=[_pending_path(node_id, "false", "false", 1)],
            nodes=nodes,
            edges=edges,
            definitions=definitions,
            statement_index=statement_index,
        )
        return [*true_exits, *false_exits], statement_index

    if isinstance(statement, (ast.For, ast.AsyncFor, ast.While)):
        body_exits, statement_index = _append_statement_block(
            statements=statement.body,
            symbol_id=symbol_id,
            pending_links=[_pending_path(node_id, "body", "body", 0)],
            nodes=nodes,
            edges=edges,
            definitions=definitions,
            statement_index=statement_index,
        )
        if statement.body:
            _append_control_edges(
                pending_links=_strip_pending_paths(body_exits),
                target_id=node_id,
                edges=edges,
            )
        return [_pending_path(node_id, "exit", "exit", 1)], statement_index

    return [_PendingControlLink(source_id=node_id)], statement_index


def _statement_kind(statement: ast.stmt) -> GraphViewNodeKind:
    if isinstance(statement, ast.Return):
        return GraphViewNodeKind.RETURN
    if isinstance(statement, ast.If):
        return GraphViewNodeKind.BRANCH
    if isinstance(statement, (ast.For, ast.AsyncFor, ast.While)):
        return GraphViewNodeKind.LOOP
    if isinstance(statement, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
        return GraphViewNodeKind.ASSIGN
    if _contains_call(statement):
        return GraphViewNodeKind.CALL
    return GraphViewNodeKind.ASSIGN


def _statement_label(statement: ast.stmt) -> str:
    try:
        text = ast.unparse(statement)
    except Exception:
        text = statement.__class__.__name__
    text = " ".join(text.split())
    return text[:78] + ("..." if len(text) > 78 else "")


def _contains_call(statement: ast.stmt) -> bool:
    return any(isinstance(node, ast.Call) for node in ast.walk(statement))


def _source_metadata_for_span(span: SourceSpan | None) -> dict[str, int]:
    if span is None:
        return {}

    return {
        "source_start_line": span.start_line,
        "source_start_column": span.start_column,
        "source_end_line": span.end_line,
        "source_end_column": span.end_column,
    }


def _source_metadata_for_ast_node(node: ast.AST) -> dict[str, int]:
    start_line = getattr(node, "lineno", None)
    start_column = getattr(node, "col_offset", None)
    end_line = getattr(node, "end_lineno", None) or start_line
    end_column = getattr(node, "end_col_offset", None)
    if (
        not isinstance(start_line, int)
        or not isinstance(start_column, int)
        or not isinstance(end_line, int)
    ):
        return {}

    if not isinstance(end_column, int):
        node_label = getattr(node, "arg", None)
        end_column = start_column + len(node_label) if isinstance(node_label, str) else start_column

    return {
        "source_start_line": start_line,
        "source_start_column": start_column,
        "source_end_line": end_line,
        "source_end_column": end_column,
    }


def _flow_state_payload(document: FlowModelDocument) -> dict[str, Any]:
    return {
        "editable": document.editable,
        "sync_state": document.sync_state,
        "diagnostics": list(document.diagnostics),
        "document": document.to_dict(),
    }


def _build_import_error_flow_document(
    *,
    symbol_id: str,
    relative_path: str,
    qualname: str,
    module_source: str,
    previous_document: FlowModelDocument | None = None,
    source_hash: str,
    diagnostics: tuple[str, ...],
) -> FlowModelDocument:
    try:
        current_function_inputs = function_inputs_from_function_source(
            symbol_id=symbol_id,
            qualname=qualname,
            module_source=module_source,
        )
    except SyntaxError:
        current_function_inputs = ()
    if previous_document is not None:
        return replace(
            previous_document,
            function_inputs=current_function_inputs or previous_document.function_inputs,
            sync_state="import_error",
            diagnostics=diagnostics,
            source_hash=source_hash,
            editable=False,
        )

    entry_node_id = f"flowdoc:{symbol_id}:entry"
    exit_node_id = f"flowdoc:{symbol_id}:exit"
    return FlowModelDocument(
        symbol_id=symbol_id,
        relative_path=relative_path,
        qualname=qualname,
        nodes=(
            FlowModelNode(
                node_id=entry_node_id,
                kind="entry",
                payload={},
                indexed_node_id=indexed_flow_entry_node_id(symbol_id),
            ),
            FlowModelNode(node_id=exit_node_id, kind="exit", payload={}),
        ),
        edges=(),
        function_inputs=current_function_inputs,
        sync_state="import_error",
        diagnostics=diagnostics,
        source_hash=source_hash,
        editable=False,
    )


def _function_input_param_node_id(symbol_id: str, function_input: FlowFunctionInput) -> str:
    return f"flow:{symbol_id}:param:{function_input.name}"


def _function_input_source_handle(function_input_id: str) -> str:
    return f"out:data:function-input:{function_input_id}"


def _value_source_handle(source_id: str) -> str:
    return f"out:data:value-source:{source_id}"


def _input_slot_target_handle(slot_id: str) -> str:
    return f"in:data:input-slot:{slot_id}"


def _with_flow_document_inherited_input_model_from_base_view(
    base_view: GraphView,
    document: FlowModelDocument,
) -> FlowModelDocument:
    param_nodes = sorted(
        (node for node in base_view.nodes if node.kind == GraphViewNodeKind.PARAM),
        key=lambda candidate: (
            candidate.metadata.get("signature_order")
            if isinstance(candidate.metadata.get("signature_order"), int)
            else 10**9,
            candidate.label,
        ),
    )

    existing_input_by_name = {
        function_input.name: function_input for function_input in document.function_inputs
    }
    function_inputs: list[FlowFunctionInput] = []
    for index, node in enumerate(param_nodes):
        raw_function_input_id = node.metadata.get("function_input_id")
        function_input_id = (
            raw_function_input_id
            if isinstance(raw_function_input_id, str) and raw_function_input_id.strip()
            else flow_function_input_id(document.symbol_id, node.label)
        )
        existing = existing_input_by_name.get(node.label)
        raw_kind = node.metadata.get("function_input_kind")
        function_input_kind = (
            raw_kind
            if isinstance(raw_kind, str)
            and raw_kind
            in {
                "positional_only",
                "positional_or_keyword",
                "keyword_only",
                "vararg",
                "kwarg",
            }
            else (existing.kind if existing else "positional_or_keyword")
        )
        raw_default_expression = node.metadata.get("default_expression")
        default_expression = (
            raw_default_expression
            if isinstance(raw_default_expression, str)
            else (existing.default_expression if existing else None)
        )
        function_inputs.append(
            FlowFunctionInput(
                input_id=existing.input_id if existing else function_input_id,
                name=node.label,
                index=index,
                kind=function_input_kind,
                default_expression=default_expression,
            )
        )

    projected_function_inputs = tuple(function_inputs)
    if document.function_inputs and projected_function_inputs:
        existing_by_name = {
            function_input.name: function_input for function_input in document.function_inputs
        }
        projected_function_inputs = tuple(
            FlowFunctionInput(
                input_id=existing_by_name.get(function_input.name, function_input).input_id,
                name=function_input.name,
                index=function_input.index,
                kind=function_input.kind,
                default_expression=function_input.default_expression,
            )
            for function_input in projected_function_inputs
        )

    if document.input_slots:
        if document.value_model_version == 1:
            if document.function_inputs or not projected_function_inputs:
                return replace(
                    document, function_inputs=projected_function_inputs or document.function_inputs
                )
            return replace(document, function_inputs=projected_function_inputs)
        return replace(
            document,
            value_model_version=1,
            function_inputs=projected_function_inputs or document.function_inputs,
            value_sources=document.value_sources
            or _value_sources_from_base_graph(base_view, document),
        )

    function_input_by_param_node_id = {
        node.node_id: function_inputs[index] for index, node in enumerate(param_nodes)
    }
    document_node_by_identity: dict[str, FlowModelNode] = {}
    for node in document.nodes:
        document_node_by_identity.setdefault(flow_model_node_source_identity(node), node)
        document_node_by_identity.setdefault(node.node_id, node)

    slots: list[FlowInputSlot] = []
    value_sources: list[FlowValueSource] = []
    bindings: list[FlowInputBinding] = []
    seen_slot_ids: set[str] = set()
    seen_source_ids: set[str] = set()
    seen_bound_slot_ids: set[str] = set()
    for edge in base_view.edges:
        if edge.kind != GraphViewEdgeKind.DATA:
            continue
        function_input = function_input_by_param_node_id.get(edge.source_id)
        source_id: str | None = None
        source_label: str | None = None
        if function_input is not None:
            source_id = function_input.input_id
            source_label = function_input.name
        else:
            source_node = document_node_by_identity.get(edge.source_id)
            source_label = (edge.label or "").strip()
            if source_node is not None and source_label:
                source_id = flow_value_source_id(
                    flow_model_node_source_identity(source_node), source_label
                )
                if source_id not in seen_source_ids:
                    seen_source_ids.add(source_id)
                    value_sources.append(
                        FlowValueSource(
                            source_id=source_id,
                            node_id=source_node.node_id,
                            name=source_label,
                            label=source_label,
                            emitted_name=None,
                        )
                    )
        if source_id is None or source_label is None:
            continue
        target_node = document_node_by_identity.get(edge.target_id)
        if target_node is None:
            continue
        slot_key = (edge.label or source_label).strip() or source_label
        slot_id = flow_input_slot_id(flow_model_node_source_identity(target_node), slot_key)
        if slot_id in seen_slot_ids:
            continue
        seen_slot_ids.add(slot_id)
        slots.append(
            FlowInputSlot(
                slot_id=slot_id,
                node_id=target_node.node_id,
                slot_key=slot_key,
                label=slot_key,
                required=True,
            )
        )
        if slot_id in seen_bound_slot_ids:
            continue
        seen_bound_slot_ids.add(slot_id)
        bindings.append(
            FlowInputBinding(
                binding_id=flow_input_binding_id(slot_id, source_id),
                source_id=source_id,
                slot_id=slot_id,
                function_input_id=source_id if function_input is not None else None,
            )
        )

    return replace(
        document,
        value_model_version=1,
        function_inputs=projected_function_inputs,
        value_sources=tuple(value_sources),
        input_slots=tuple(slots),
        input_bindings=tuple(bindings),
    )


def _value_sources_from_base_graph(
    base_view: GraphView,
    document: FlowModelDocument,
) -> tuple[FlowValueSource, ...]:
    document_node_by_identity: dict[str, FlowModelNode] = {}
    for node in document.nodes:
        document_node_by_identity.setdefault(flow_model_node_source_identity(node), node)
        document_node_by_identity.setdefault(node.node_id, node)

    existing_by_node_name = {
        (source.node_id, source.name): source for source in document.value_sources
    }
    value_sources: list[FlowValueSource] = []
    seen_source_ids: set[str] = set()
    for edge in base_view.edges:
        if edge.kind != GraphViewEdgeKind.DATA:
            continue
        source_node = document_node_by_identity.get(edge.source_id)
        if source_node is None:
            continue
        source_name = (edge.label or "").strip()
        if not source_name:
            continue
        existing = existing_by_node_name.get((source_node.node_id, source_name))
        source_id = (
            existing.source_id
            if existing
            else flow_value_source_id(
                flow_model_node_source_identity(source_node),
                source_name,
            )
        )
        if source_id in seen_source_ids:
            continue
        seen_source_ids.add(source_id)
        value_sources.append(
            FlowValueSource(
                source_id=source_id,
                node_id=source_node.node_id,
                name=source_name,
                label=existing.label if existing else source_name,
                emitted_name=existing.emitted_name if existing else None,
            )
        )
    return tuple(value_sources)


def _graph_view_node_for_function_input(
    symbol_id: str,
    function_input: FlowFunctionInput,
    *,
    entry_node_id: str | None,
    existing: GraphViewNode | None,
) -> GraphViewNode:
    node_id = _function_input_param_node_id(symbol_id, function_input)
    return GraphViewNode(
        node_id=node_id,
        kind=GraphViewNodeKind.PARAM,
        label=function_input.name,
        subtitle="signature parameter",
        metadata={
            **(existing.metadata if existing else {}),
            "function_input_id": function_input.input_id,
            "function_input_kind": function_input.kind,
            "default_expression": function_input.default_expression,
            "signature_owner_id": entry_node_id,
            "signature_order": function_input.index,
            "source_handle": _function_input_source_handle(function_input.input_id),
        },
        available_actions=existing.available_actions if existing else (),
    )


def _graph_view_edge_for_input_binding(
    document: FlowModelDocument,
    binding: FlowInputBinding,
) -> GraphViewEdge:
    slot_by_id = {slot.slot_id: slot for slot in document.input_slots}
    input_by_id = {
        function_input.input_id: function_input for function_input in document.function_inputs
    }
    value_source_by_id = {
        value_source.source_id: value_source for value_source in document.value_sources
    }
    slot = slot_by_id.get(binding.slot_id)
    function_input = input_by_id.get(binding.source_id)
    value_source = value_source_by_id.get(binding.source_id)
    if slot is None or (function_input is None and value_source is None):
        return GraphViewEdge(
            edge_id=f"data:{binding.binding_id}",
            kind=GraphViewEdgeKind.DATA,
            source_id=document.nodes[0].node_id if document.nodes else document.symbol_id,
            target_id=document.nodes[0].node_id if document.nodes else document.symbol_id,
        )
    if function_input is not None:
        source_id = _function_input_param_node_id(document.symbol_id, function_input)
        source_handle = _function_input_source_handle(function_input.input_id)
        source_label = function_input.name
        function_input_id = function_input.input_id
    else:
        source_id = value_source.node_id
        source_handle = _value_source_handle(value_source.source_id)
        source_label = value_source.label or value_source.name
        function_input_id = None
    target_handle = _input_slot_target_handle(slot.slot_id)
    metadata = {
        "flow_input_binding": True,
        "binding_id": binding.binding_id,
        "source_id": binding.source_id,
        "slot_id": slot.slot_id,
        "source_label": source_label,
        "target_label": slot.label,
        "source_handle": source_handle,
        "target_handle": target_handle,
    }
    if function_input_id:
        metadata["function_input_id"] = function_input_id
    return GraphViewEdge(
        edge_id=f"data:{binding.binding_id}",
        kind=GraphViewEdgeKind.DATA,
        source_id=source_id,
        target_id=slot.node_id,
        label=source_label,
        metadata=metadata,
    )


def _project_function_flow_document_view(
    base_view: GraphView,
    document: FlowModelDocument,
) -> GraphView:
    document = without_flow_return_completion_edges(
        _with_flow_document_inherited_input_model_from_base_view(base_view, document)
    )
    visual_node_ids = {node.node_id for node in document.nodes}
    function_input_param_node_ids = {
        _function_input_param_node_id(document.symbol_id, function_input)
        for function_input in document.function_inputs
    }
    preserved_nodes = tuple(
        node
        for node in base_view.nodes
        if node.node_id not in visual_node_ids
        and node.kind not in _FLOW_VISUAL_GRAPH_NODE_KINDS
        and node.node_id not in function_input_param_node_ids
    )
    base_nodes_by_id = {node.node_id: node for node in base_view.nodes}
    document_nodes = tuple(
        _graph_view_node_for_flow_model_node(
            node,
            index=index,
            qualname=document.qualname,
            document=document,
            existing=base_nodes_by_id.get(node.node_id)
            or (base_nodes_by_id.get(node.indexed_node_id) if node.indexed_node_id else None),
        )
        for index, node in enumerate(document.nodes)
    )
    projected_node_ids = {node.node_id: node.node_id for node in document.nodes}
    projected_node_ids.update(
        {
            flow_model_node_source_identity(node): node.node_id
            for node in document.nodes
            if node.indexed_node_id
        }
    )
    entry_node_id = next((node.node_id for node in document.nodes if node.kind == "entry"), None)
    input_nodes = tuple(
        _graph_view_node_for_function_input(
            document.symbol_id,
            function_input,
            entry_node_id=entry_node_id,
            existing=base_nodes_by_id.get(
                _function_input_param_node_id(document.symbol_id, function_input)
            ),
        )
        for function_input in document.function_inputs
    )
    visible_node_ids = {
        *(node.node_id for node in preserved_nodes),
        *(node.node_id for node in input_nodes),
        *(node.node_id for node in document_nodes),
    }
    base_edges_by_id = {edge.edge_id: edge for edge in base_view.edges}
    preserved_edges: list[GraphViewEdge] = []
    for edge in base_view.edges:
        if edge.kind == GraphViewEdgeKind.CONTROLS:
            continue
        projected_source_id = projected_node_ids.get(edge.source_id, edge.source_id)
        projected_target_id = projected_node_ids.get(edge.target_id, edge.target_id)
        if edge.kind == GraphViewEdgeKind.DATA and (
            projected_target_id in {node.node_id for node in document.nodes}
            or projected_source_id in {node.node_id for node in document.nodes}
            or edge.source_id in function_input_param_node_ids
        ):
            continue
        if (
            projected_source_id not in visible_node_ids
            or projected_target_id not in visible_node_ids
        ):
            continue
        preserved_edges.append(
            replace(
                edge,
                source_id=projected_source_id,
                target_id=projected_target_id,
            )
        )
    document_edges = tuple(
        _graph_view_edge_for_flow_model_edge(
            edge,
            existing=base_edges_by_id.get(edge.edge_id),
        )
        for edge in document.edges
    )
    return_completion_edges = tuple(_graph_view_return_completion_edges(document))
    input_binding_edges = tuple(
        _graph_view_edge_for_input_binding(document, binding) for binding in document.input_bindings
    )
    root_node_id = projected_node_ids.get(base_view.root_node_id, base_view.root_node_id)
    if root_node_id not in visible_node_ids:
        root_node_id = document.nodes[0].node_id if document.nodes else base_view.root_node_id
    return replace(
        base_view,
        root_node_id=root_node_id,
        nodes=(*preserved_nodes, *input_nodes, *document_nodes),
        edges=(*preserved_edges, *input_binding_edges, *document_edges, *return_completion_edges),
        flow_state=_flow_state_payload(document),
    )


def _graph_view_return_completion_edges(document: FlowModelDocument) -> tuple[GraphViewEdge, ...]:
    exit_node = next((node for node in document.nodes if node.kind == "exit"), None)
    if exit_node is None:
        return ()

    edges: list[GraphViewEdge] = []
    for node in document.nodes:
        if node.kind != "return":
            continue
        edge_id = flow_return_completion_edge_id(node.node_id, exit_node.node_id)
        edges.append(
            GraphViewEdge(
                edge_id=edge_id,
                kind=GraphViewEdgeKind.CONTROLS,
                source_id=node.node_id,
                target_id=exit_node.node_id,
                label="exit",
                metadata={
                    "source_handle": "exit",
                    "target_handle": "in",
                    "path_key": "exit",
                    "path_label": "exit",
                    "path_order": 3,
                    "flow_return_completion": True,
                },
            )
        )
    return tuple(edges)


def _graph_view_node_for_flow_model_node(
    node: FlowModelNode,
    *,
    index: int,
    qualname: str,
    document: FlowModelDocument,
    existing: GraphViewNode | None,
) -> GraphViewNode:
    input_slots = [
        {
            "slot_id": slot.slot_id,
            "slot_key": slot.slot_key,
            "label": slot.label,
            "target_handle": _input_slot_target_handle(slot.slot_id),
        }
        for slot in document.input_slots
        if slot.node_id == node.node_id
    ]
    source_name_counts: dict[str, int] = {}
    for source in document.value_sources:
        source_name_counts[source.name] = source_name_counts.get(source.name, 0) + 1
    value_sources = [
        {
            "source_id": source.source_id,
            "name": source.name,
            "label": source.label,
            "emitted_name": source.emitted_name,
            "source_handle": _value_source_handle(source.source_id),
            "duplicate_name": source_name_counts.get(source.name, 0) > 1,
        }
        for source in document.value_sources
        if source.node_id == node.node_id
    ]
    function_inputs = (
        [
            {
                "function_input_id": function_input.input_id,
                "name": function_input.name,
                "index": function_input.index,
                "kind": function_input.kind,
                "default_expression": function_input.default_expression,
                "source_handle": _function_input_source_handle(function_input.input_id),
            }
            for function_input in document.function_inputs
        ]
        if node.kind == "entry"
        else []
    )
    return GraphViewNode(
        node_id=node.node_id,
        kind=GraphViewNodeKind(node.kind),
        label=flow_node_label(node),
        subtitle=existing.subtitle
        if existing and existing.subtitle
        else _flow_node_subtitle(node, qualname),
        metadata={
            **(existing.metadata if existing else {}),
            "flow_visual": True,
            "flow_order": index,
            **({"indexed_node_id": node.indexed_node_id} if node.indexed_node_id else {}),
            **({"flow_input_slots": input_slots} if input_slots else {}),
            **({"flow_value_sources": value_sources} if value_sources else {}),
            **({"flow_function_inputs": function_inputs} if function_inputs else {}),
        },
        available_actions=existing.available_actions if existing else (),
    )


def _graph_view_edge_for_flow_model_edge(
    edge: FlowModelEdge,
    *,
    existing: GraphViewEdge | None,
) -> GraphViewEdge:
    path_label = flow_edge_label(edge.source_handle)
    path_order = flow_edge_order(edge.source_handle)
    metadata = {
        **(existing.metadata if existing else {}),
        "source_handle": edge.source_handle,
        "target_handle": edge.target_handle,
    }
    if path_label is not None:
        metadata["path_key"] = path_label
        metadata["path_label"] = path_label
    if path_order is not None:
        metadata["path_order"] = path_order

    return GraphViewEdge(
        edge_id=edge.edge_id,
        kind=GraphViewEdgeKind.CONTROLS,
        source_id=edge.source_id,
        target_id=edge.target_id,
        label=path_label,
        metadata=metadata,
    )


def _flow_node_subtitle(node: FlowModelNode, qualname: str) -> str:
    if node.kind == "entry":
        return qualname
    if node.kind == "exit":
        return "Flow exit"
    if node.kind == "assign":
        return "Assign"
    if node.kind == "call":
        return "Call"
    if node.kind == "branch":
        return "Branch"
    if node.kind == "loop":
        return "Loop"
    if node.kind == "return":
        return "Return"
    return node.kind.title()


def _find_ast_symbol(tree: ast.AST, qualname: str) -> ast.AST | None:
    parts = qualname.split(".")
    candidates: list[ast.AST] = list(getattr(tree, "body", []))
    current: ast.AST | None = None
    for part in parts:
        current = None
        next_candidates: list[ast.AST] = []
        for candidate in candidates:
            if (
                isinstance(candidate, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
                and candidate.name == part
            ):
                current = candidate
                next_candidates = list(getattr(candidate, "body", []))
                break
        if current is None:
            return None
        candidates = next_candidates
    return current


def _names_used(statement: ast.stmt) -> set[str]:
    return {
        node.id
        for node in ast.walk(statement)
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load)
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
    for target in targets:
        for node in ast.walk(target):
            if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
                assigned.add(node.id)
    return assigned
