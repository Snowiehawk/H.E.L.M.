"""Python-first workspace adapter for the architecture editor."""

from __future__ import annotations

import ast
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Literal

from helm.editor import apply_backend_undo, apply_structural_edit
from helm.editor.declaration_support import resolve_declaration_edit_support
from helm.editor.models import (
    BackendUndoResult,
    BackendUndoTransaction,
    StructuralEditKind,
    StructuralEditRequest,
    StructuralEditResult,
)
from helm.graph import EdgeKind, GraphNode, NodeKind, RepoGraph, build_repo_graph
from helm.graph.models import (
    GraphAbstractionLevel,
    GraphAction,
    GraphBreadcrumb,
    GraphFocus,
    GraphView,
    GraphViewEdge,
    GraphViewEdgeKind,
    GraphViewNode,
    GraphViewNodeKind,
)
from helm.parser import ParsedModule, PythonModuleParser, SymbolDef, SymbolKind, discover_python_modules
from helm.parser.symbols import SourceSpan
from helm.ui.api import build_export_payload, build_graph_summary

IndexStage = Literal["discover", "parse", "graph_build", "cache_finalize", "watch_ready"]
ProgressReporter = Callable[[dict[str, Any]], None]

_STAGE_PROGRESS_RANGES: dict[IndexStage, tuple[int, int]] = {
    "discover": (4, 18),
    "parse": (18, 76),
    "graph_build": (76, 88),
    "cache_finalize": (88, 95),
    "watch_ready": (95, 100),
}


def _stage_progress_percent(
    stage: IndexStage,
    *,
    processed_modules: int = 0,
    total_modules: int = 0,
) -> int:
    start, end = _STAGE_PROGRESS_RANGES[stage]
    if total_modules <= 0:
        return start

    bounded_progress = min(max(processed_modules / total_modules, 0), 1)
    return round(start + (end - start) * bounded_progress)


def build_progress_update(
    stage: IndexStage,
    message: str,
    *,
    processed_modules: int = 0,
    total_modules: int = 0,
    symbol_count: int = 0,
    status: str = "running",
    error: str | None = None,
) -> dict[str, Any]:
    progress_percent = 100 if status == "done" else _stage_progress_percent(
        stage,
        processed_modules=processed_modules,
        total_modules=total_modules,
    )
    return {
        "stage": stage,
        "status": status,
        "message": message,
        "processed_modules": processed_modules,
        "total_modules": total_modules,
        "symbol_count": symbol_count,
        "progress_percent": progress_percent,
        "error": error,
    }


def emit_progress(
    reporter: ProgressReporter | None,
    stage: IndexStage,
    message: str,
    *,
    processed_modules: int = 0,
    total_modules: int = 0,
    symbol_count: int = 0,
    status: str = "running",
    error: str | None = None,
) -> None:
    if reporter is None:
        return
    reporter(
        build_progress_update(
            stage,
            message,
            processed_modules=processed_modules,
            total_modules=total_modules,
            symbol_count=symbol_count,
            status=status,
            error=error,
        )
    )


@dataclass
class PythonRepoAdapter:
    root_path: Path
    inventory: Any
    parsed_modules: list[ParsedModule]
    graph: RepoGraph

    @classmethod
    def scan(
        cls,
        repo: str | Path,
        *,
        progress: ProgressReporter | None = None,
    ) -> PythonRepoAdapter:
        root_path = Path(repo).resolve()
        emit_progress(
            progress,
            "discover",
            "Discovering Python modules",
            processed_modules=0,
            total_modules=0,
        )
        inventory = discover_python_modules(root_path)
        total_modules = len(inventory.modules)
        emit_progress(
            progress,
            "discover",
            f"Discovered {total_modules} Python module{'s' if total_modules != 1 else ''}",
            processed_modules=total_modules,
            total_modules=total_modules,
        )
        parser = PythonModuleParser()
        parsed_modules: list[ParsedModule] = []
        symbol_count = 0
        for index, module in enumerate(inventory.modules, start=1):
            parsed_module = parser.parse_module(module)
            parsed_modules.append(parsed_module)
            symbol_count += len(parsed_module.symbols)
            emit_progress(
                progress,
                "parse",
                f"Parsed {module.relative_path}",
                processed_modules=index,
                total_modules=total_modules,
                symbol_count=symbol_count,
            )
        emit_progress(
            progress,
            "graph_build",
            "Building the repo graph",
            processed_modules=total_modules,
            total_modules=total_modules,
            symbol_count=symbol_count,
        )
        graph = build_repo_graph(root_path, parsed_modules)
        return cls(root_path=root_path, inventory=inventory, parsed_modules=parsed_modules, graph=graph)

    def build_payload(
        self,
        top_n: int = 24,
        *,
        progress: ProgressReporter | None = None,
    ) -> dict[str, Any]:
        emit_progress(
            progress,
            "cache_finalize",
            "Finalizing workspace payload",
            processed_modules=self.graph.report.module_count,
            total_modules=self.graph.report.module_count,
            symbol_count=self.graph.report.symbol_count,
        )
        summary = build_graph_summary(self.graph, top_n=top_n)
        payload = build_export_payload(self.graph, summary)
        payload["workspace"] = {
            "language": "python",
            "default_level": self.default_level().value,
            "default_focus_node_id": self.default_focus_node_id(),
            "source_hidden_by_default": True,
            "supported_edit_kinds": [kind.value for kind in StructuralEditKind],
        }
        return payload

    def default_level(self) -> GraphAbstractionLevel:
        if self.graph.report.module_count > 8 or self.graph.report.symbol_count > 60:
            return GraphAbstractionLevel.MODULE
        return GraphAbstractionLevel.SYMBOL

    def default_focus_node_id(self) -> str:
        level = self.default_level()
        if level == GraphAbstractionLevel.MODULE:
            return self.graph.repo_id

        symbol_scores: dict[str, int] = {}
        for edge in self.graph.edges:
            if edge.kind != EdgeKind.CALLS:
                continue
            symbol_scores[edge.source_id] = symbol_scores.get(edge.source_id, 0) + 1
            symbol_scores[edge.target_id] = symbol_scores.get(edge.target_id, 0) + 1

        symbol_nodes = [
            node
            for node in self.graph.nodes.values()
            if node.kind == NodeKind.SYMBOL and not node.is_external
        ]
        symbol_nodes.sort(
            key=lambda node: (
                -symbol_scores.get(node.node_id, 0),
                node.module_name or "",
                node.qualname or node.display_name,
            )
        )
        return symbol_nodes[0].node_id if symbol_nodes else self.graph.repo_id

    def get_graph_view(
        self,
        target_id: str,
        level: GraphAbstractionLevel,
        filters: dict[str, bool] | None = None,
    ) -> GraphView:
        view_filters = _normalized_filters(filters)
        if level == GraphAbstractionLevel.REPO:
            return self._build_repo_view(view_filters)
        if level == GraphAbstractionLevel.MODULE:
            return self._build_module_view(target_id, view_filters)
        if level == GraphAbstractionLevel.SYMBOL:
            return self._build_symbol_view(target_id, view_filters)
        return self.get_flow_view(target_id)

    def get_flow_view(self, symbol_id: str) -> GraphView:
        symbol_node = self._require_graph_node(symbol_id)
        if symbol_node.kind != NodeKind.SYMBOL:
            raise ValueError("Flow view is only available for symbols.")

        parsed, symbol = self._require_symbol(symbol_id)
        if _is_function_like_symbol_kind(symbol.kind):
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
        return self._build_code_derived_function_flow_view(
            symbol_node=symbol_node,
            parsed=parsed,
            symbol=symbol,
            source=source,
            import_error=None,
        )

    def _build_code_derived_function_flow_view(
        self,
        *,
        symbol_node: GraphNode,
        parsed: ParsedModule,
        symbol: SymbolDef,
        source: str,
        import_error: str | None,
    ) -> GraphView:
        symbol_id = symbol.symbol_id
        tree = ast.parse(source, filename=parsed.module.file_path)
        function_node = _find_ast_symbol(tree, symbol.qualname)
        if not isinstance(function_node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            raise ValueError(f"Unable to resolve flow for {symbol.qualname}.")

        nodes: list[GraphViewNode] = []
        edges: list[GraphViewEdge] = []
        breadcrumbs = self._breadcrumbs_for_symbol(symbol_node, include_flow=True)
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

        definitions: dict[str, str] = {}
        previous_control_id = entry_id
        for argument in function_node.args.args:
            param_id = f"flow:{symbol_id}:param:{argument.arg}"
            nodes.append(
                GraphViewNode(
                    node_id=param_id,
                    kind=GraphViewNodeKind.PARAM,
                    label=argument.arg,
                    subtitle="parameter",
                    metadata=_source_metadata_for_ast_node(argument),
                )
            )
            definitions[argument.arg] = param_id

        _append_statement_block(
            statements=function_node.body,
            symbol_id=symbol_id,
            pending_links=[_PendingControlLink(source_id=previous_control_id)],
            nodes=nodes,
            edges=edges,
            definitions=definitions,
            statement_index=0,
        )

        diagnostics = [import_error] if import_error else []
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
            flow_state={
                "editable": False,
                "sync_state": "import_error" if diagnostics else "clean",
                "diagnostics": diagnostics,
                "document": None,
            },
        )

    def _build_class_flow_view(
        self,
        symbol_node: GraphNode,
        symbol: SymbolDef,
    ) -> GraphView:
        symbol_id = symbol.symbol_id
        breadcrumbs = self._breadcrumbs_for_symbol(symbol_node, include_flow=True)
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
        direct_children = self._direct_child_symbols(symbol_id)
        direct_child_ids = {child.symbol_id for child in direct_children}

        for index, child in enumerate(direct_children, start=1):
            child_node = self._require_graph_node(child.symbol_id)
            child_view = self._symbol_view_node(child_node)
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

        for edge in self.graph.edges:
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

    def reveal_source(self, target_id: str) -> dict[str, Any]:
        node = self._require_graph_node(target_id)
        if node.file_path is None:
            raise ValueError(f"No source is associated with {target_id}.")

        return self._source_payload_for_node(node, target_id=target_id, exact=False)

    def get_editable_node_source(self, target_id: str) -> dict[str, Any]:
        node = self._require_graph_node(target_id)
        if node.kind != NodeKind.SYMBOL:
            raise ValueError("Editable source is only available for symbols.")

        _, symbol = self._require_symbol(target_id)
        support = resolve_declaration_edit_support(
            symbol,
            lookup_symbol=self._lookup_symbol,
        )
        payload = self._source_payload_for_node(node, target_id=target_id, exact=True)
        payload.update(
            {
                "editable": support.editable,
                "reason": support.reason,
                "node_kind": _graph_view_kind_for_symbol(symbol.kind).value,
            }
        )
        return payload

    def apply_edit(self, request: StructuralEditRequest) -> dict[str, Any]:
        result = apply_structural_edit(
            self.root_path,
            request,
            parsed_modules=self.parsed_modules,
            inbound_dependency_count=self._inbound_dependency_count(),
        )
        reparsed = self._reparse_touched_modules(result.touched_relative_paths)
        enriched = StructuralEditResult(
            request=result.request,
            summary=result.summary,
            touched_relative_paths=result.touched_relative_paths,
            reparsed_relative_paths=reparsed,
            changed_node_ids=result.changed_node_ids,
            warnings=result.warnings,
            flow_sync_state=result.flow_sync_state,
            diagnostics=result.diagnostics,
            undo_transaction=result.undo_transaction,
        )
        return {"edit": enriched.to_dict(), "payload": self.build_payload()}

    def apply_undo(self, transaction: BackendUndoTransaction) -> dict[str, Any]:
        result = apply_backend_undo(self.root_path, transaction)
        self._reparse_touched_modules(result.restored_relative_paths)
        enriched = BackendUndoResult(
            summary=result.summary,
            restored_relative_paths=result.restored_relative_paths,
            warnings=result.warnings,
            focus_target=result.focus_target,
        )
        return {"undo": enriched.to_dict(), "payload": self.build_payload()}

    def save_node_source(self, target_id: str, content: str) -> dict[str, Any]:
        return self.apply_edit(
            StructuralEditRequest(
                kind=StructuralEditKind.REPLACE_SYMBOL_SOURCE,
                target_id=target_id,
                content=content,
            )
        )

    def _reparse_touched_modules(self, touched_relative_paths: tuple[str, ...]) -> tuple[str, ...]:
        refreshed_inventory = discover_python_modules(self.root_path)
        previous_by_relative = {
            parsed.module.relative_path: parsed for parsed in self.parsed_modules
        }
        parser = PythonModuleParser()
        reparsed: list[str] = []
        next_parsed_modules: list[ParsedModule] = []
        touched = set(touched_relative_paths)

        for module in refreshed_inventory.modules:
            previous = previous_by_relative.get(module.relative_path)
            needs_reparse = (
                module.relative_path in touched
                or previous is None
                or previous.module.module_name != module.module_name
                or previous.module.file_path != module.file_path
            )
            if needs_reparse:
                next_parsed_modules.append(parser.parse_module(module))
                reparsed.append(module.relative_path)
            else:
                next_parsed_modules.append(previous)

        self.inventory = refreshed_inventory
        self.parsed_modules = next_parsed_modules
        self.graph = build_repo_graph(self.root_path, self.parsed_modules)
        return tuple(reparsed)

    def _build_repo_view(self, view_filters: dict[str, bool]) -> GraphView:
        repo_node = self.graph.nodes[self.graph.repo_id]
        nodes = [
            GraphViewNode(
                node_id=repo_node.node_id,
                kind=GraphViewNodeKind.REPO,
                label=repo_node.name,
                subtitle="Architecture map",
                metadata={
                    "root_path": self.root_path.as_posix(),
                    "module_count": self.graph.report.module_count,
                    "symbol_count": self.graph.report.symbol_count,
                },
            )
        ]

        for module_node in self._visible_modules(view_filters):
            nodes.append(self._module_view_node(module_node, view_filters))

        edges = self._module_dependency_edges(view_filters)
        return GraphView(
            root_node_id=self.graph.repo_id,
            target_id=self.graph.repo_id,
            level=GraphAbstractionLevel.REPO,
            nodes=tuple(nodes),
            edges=tuple(edges),
            breadcrumbs=(
                GraphBreadcrumb(
                    node_id=self.graph.repo_id,
                    level=GraphAbstractionLevel.REPO,
                    label=repo_node.name,
                    subtitle="Architecture map",
                ),
            ),
            focus=GraphFocus(
                target_id=self.graph.repo_id,
                level=GraphAbstractionLevel.REPO,
                label=repo_node.name,
                subtitle="Architecture map",
                available_levels=(
                    GraphAbstractionLevel.REPO,
                    GraphAbstractionLevel.MODULE,
                ),
            ),
            truncated=False,
        )

    def _build_module_view(
        self,
        target_id: str,
        view_filters: dict[str, bool],
    ) -> GraphView:
        if target_id == self.graph.repo_id:
            repo_view = self._build_repo_view(view_filters)
            return GraphView(
                root_node_id=repo_view.root_node_id,
                target_id=repo_view.target_id,
                level=GraphAbstractionLevel.MODULE,
                nodes=repo_view.nodes,
                edges=repo_view.edges,
                breadcrumbs=repo_view.breadcrumbs,
                focus=GraphFocus(
                    target_id=self.graph.repo_id,
                    level=GraphAbstractionLevel.MODULE,
                    label=self.graph.nodes[self.graph.repo_id].name,
                    subtitle="Architecture map",
                    available_levels=(
                        GraphAbstractionLevel.REPO,
                        GraphAbstractionLevel.MODULE,
                    ),
                ),
                truncated=False,
            )

        module_node = self._resolve_module_node(target_id)
        module_edge_groups = self._module_dependency_groups(view_filters)
        neighbor_ids = {
            edge.source_id if edge.target_id == module_node.node_id else edge.target_id
            for edge in module_edge_groups
            if edge.source_id == module_node.node_id or edge.target_id == module_node.node_id
        }
        nodes = [self._module_view_node(module_node, view_filters)]
        nodes.extend(
            self._module_view_node(self.graph.nodes[neighbor_id], view_filters)
            for neighbor_id in sorted(neighbor_ids)
            if neighbor_id in self.graph.nodes
            and self._is_visible_in_view(self.graph.nodes[neighbor_id], view_filters)
        )
        top_level_symbols = [
            symbol
            for symbol in self._symbols_for_module(module_node.node_id)
            if self._parsed_symbol(symbol.node_id).parent_symbol_id is None
        ]
        nodes.extend(top_level_symbols)

        edges = [
            edge
            for edge in self._module_dependency_edges(view_filters)
            if edge.source_id == module_node.node_id or edge.target_id == module_node.node_id
        ]
        if view_filters["includeDefines"]:
            for symbol_node in top_level_symbols:
                edges.append(
                    GraphViewEdge(
                        edge_id=f"defines:{module_node.node_id}->{symbol_node.node_id}",
                        kind=GraphViewEdgeKind.DEFINES,
                        source_id=module_node.node_id,
                        target_id=symbol_node.node_id,
                    )
                )

        return GraphView(
            root_node_id=module_node.node_id,
            target_id=module_node.node_id,
            level=GraphAbstractionLevel.MODULE,
            nodes=tuple(nodes),
            edges=tuple(edges),
            breadcrumbs=self._breadcrumbs_for_module(module_node),
            focus=GraphFocus(
                target_id=module_node.node_id,
                level=GraphAbstractionLevel.MODULE,
                label=module_node.name,
                subtitle=self._relative_path_for(module_node),
                available_levels=(
                    GraphAbstractionLevel.REPO,
                    GraphAbstractionLevel.MODULE,
                ),
            ),
            truncated=False,
        )

    def _build_symbol_view(
        self,
        target_id: str,
        view_filters: dict[str, bool],
    ) -> GraphView:
        symbol_node = self._resolve_symbol_node(target_id)
        parsed_symbol = self._parsed_symbol(symbol_node.node_id)
        module_node = self._resolve_module_node(symbol_node.node_id)
        nodes: dict[str, GraphViewNode] = {
            module_node.node_id: self._module_view_node(module_node, view_filters),
            symbol_node.node_id: self._symbol_view_node(symbol_node),
        }
        edges: list[GraphViewEdge] = [
            GraphViewEdge(
                edge_id=f"defines:{module_node.node_id}->{symbol_node.node_id}",
                kind=GraphViewEdgeKind.DEFINES,
                source_id=module_node.node_id,
                target_id=symbol_node.node_id,
            )
        ]

        if parsed_symbol.parent_symbol_id and parsed_symbol.parent_symbol_id in self.graph.nodes:
            parent_symbol = self.graph.nodes[parsed_symbol.parent_symbol_id]
            nodes[parent_symbol.node_id] = self._symbol_view_node(parent_symbol)
            edges.append(
                GraphViewEdge(
                    edge_id=f"contains:{parent_symbol.node_id}->{symbol_node.node_id}",
                    kind=GraphViewEdgeKind.CONTAINS,
                    source_id=parent_symbol.node_id,
                    target_id=symbol_node.node_id,
                )
            )

        for child_symbol in self._direct_child_symbols(symbol_node.node_id):
            child_node = self._require_graph_node(child_symbol.symbol_id)
            nodes[child_node.node_id] = self._symbol_view_node(child_node)
            edges.append(
                GraphViewEdge(
                    edge_id=f"contains:{symbol_node.node_id}->{child_node.node_id}",
                    kind=GraphViewEdgeKind.CONTAINS,
                    source_id=symbol_node.node_id,
                    target_id=child_node.node_id,
                )
            )

        for edge in self.graph.edges:
            if edge.kind == EdgeKind.CALLS and view_filters["includeCalls"]:
                if edge.source_id == symbol_node.node_id or edge.target_id == symbol_node.node_id:
                    if edge.source_id in self.graph.nodes:
                        nodes[edge.source_id] = self._view_node_for_graph_node(
                            self.graph.nodes[edge.source_id],
                            view_filters,
                        )
                    if edge.target_id in self.graph.nodes:
                        nodes[edge.target_id] = self._view_node_for_graph_node(
                            self.graph.nodes[edge.target_id],
                            view_filters,
                        )
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
            if edge.kind == EdgeKind.IMPORTS and view_filters["includeImports"]:
                if edge.source_id == symbol_node.node_id or edge.source_id == module_node.node_id:
                    if edge.target_id in self.graph.nodes and self._is_visible_in_view(
                        self.graph.nodes[edge.target_id],
                        view_filters,
                    ):
                        nodes[edge.target_id] = self._view_node_for_graph_node(
                            self.graph.nodes[edge.target_id],
                            view_filters,
                        )
                    else:
                        continue
                    edges.append(
                        GraphViewEdge(
                            edge_id=edge.edge_id,
                            kind=GraphViewEdgeKind.IMPORTS,
                            source_id=edge.source_id,
                            target_id=edge.target_id,
                            label=str(edge.metadata.get("local_name", "imports")),
                            metadata=edge.metadata,
                        )
                    )

        return GraphView(
            root_node_id=symbol_node.node_id,
            target_id=symbol_node.node_id,
            level=GraphAbstractionLevel.SYMBOL,
            nodes=tuple(nodes.values()),
            edges=tuple(edges),
            breadcrumbs=self._breadcrumbs_for_symbol(symbol_node),
            focus=GraphFocus(
                target_id=symbol_node.node_id,
                level=GraphAbstractionLevel.SYMBOL,
                label=symbol_node.name,
                subtitle=symbol_node.qualname or symbol_node.display_name,
                available_levels=tuple(
                    level
                    for level in (
                        GraphAbstractionLevel.REPO,
                        GraphAbstractionLevel.MODULE,
                        GraphAbstractionLevel.SYMBOL,
                        GraphAbstractionLevel.FLOW,
                    )
                    if level != GraphAbstractionLevel.FLOW or _supports_flow(parsed_symbol.kind)
                ),
            ),
            truncated=False,
        )

    def _module_dependency_edges(self, view_filters: dict[str, bool]) -> list[GraphViewEdge]:
        return [
            edge
            for edge in self._module_dependency_groups(view_filters)
            if (edge.kind == GraphViewEdgeKind.IMPORTS and view_filters["includeImports"])
            or (edge.kind == GraphViewEdgeKind.CALLS and view_filters["includeCalls"])
        ]

    def _module_dependency_groups(self, view_filters: dict[str, bool]) -> list[GraphViewEdge]:
        grouped: dict[tuple[str, str, GraphViewEdgeKind], int] = {}
        for edge in self.graph.edges:
            if edge.kind not in {EdgeKind.IMPORTS, EdgeKind.CALLS}:
                continue
            source_module_id = self._module_id_for_node_id(edge.source_id)
            target_module_id = self._module_id_for_node_id(edge.target_id)
            if source_module_id is None or target_module_id is None:
                continue
            if source_module_id == target_module_id:
                continue
            source_node = self.graph.nodes.get(source_module_id)
            target_node = self.graph.nodes.get(target_module_id)
            if source_node is None or target_node is None:
                continue
            if not self._is_visible_in_view(source_node, view_filters) or not self._is_visible_in_view(
                target_node,
                view_filters,
            ):
                continue
            kind = (
                GraphViewEdgeKind.IMPORTS
                if edge.kind == EdgeKind.IMPORTS
                else GraphViewEdgeKind.CALLS
            )
            grouped[(source_module_id, target_module_id, kind)] = (
                grouped.get((source_module_id, target_module_id, kind), 0) + 1
            )

        results: list[GraphViewEdge] = []
        for (source_id, target_id, kind), count in sorted(grouped.items()):
            label = f"{count} {'import' if kind == GraphViewEdgeKind.IMPORTS else 'call'}"
            if count != 1:
                label += "s"
            results.append(
                GraphViewEdge(
                    edge_id=f"{kind.value}:{source_id}->{target_id}",
                    kind=kind,
                    source_id=source_id,
                    target_id=target_id,
                    label=label,
                    metadata={"count": count},
                )
            )
        return results

    def _inbound_dependency_count(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for edge in self.graph.edges:
            if edge.kind != EdgeKind.CALLS:
                continue
            counts[edge.target_id] = counts.get(edge.target_id, 0) + 1
        return counts

    def _internal_modules(self) -> list[GraphNode]:
        return [
            node
            for node in self.graph.nodes.values()
            if node.kind == NodeKind.MODULE and not node.is_external
        ]

    def _visible_modules(self, view_filters: dict[str, bool]) -> list[GraphNode]:
        return [
            node
            for node in self.graph.nodes.values()
            if node.kind == NodeKind.MODULE and self._is_visible_in_view(node, view_filters)
        ]

    def _symbols_for_module(self, module_id: str) -> list[GraphViewNode]:
        nodes: list[GraphViewNode] = []
        for node in self.graph.nodes.values():
            if node.kind != NodeKind.SYMBOL:
                continue
            if self._module_id_for_node_id(node.node_id) != module_id:
                continue
            nodes.append(self._symbol_view_node(node))
        nodes.sort(key=lambda node: node.label)
        return nodes

    def _direct_child_symbols(self, parent_symbol_id: str) -> list[SymbolDef]:
        children = [
            symbol
            for parsed in self.parsed_modules
            for symbol in parsed.symbols
            if symbol.parent_symbol_id == parent_symbol_id
        ]
        children.sort(key=_symbol_source_order)
        return children

    def _breadcrumbs_for_module(self, module_node: GraphNode) -> tuple[GraphBreadcrumb, ...]:
        repo_node = self.graph.nodes[self.graph.repo_id]
        return (
            GraphBreadcrumb(
                node_id=repo_node.node_id,
                level=GraphAbstractionLevel.REPO,
                label=repo_node.name,
                subtitle="Architecture map",
            ),
            GraphBreadcrumb(
                node_id=module_node.node_id,
                level=GraphAbstractionLevel.MODULE,
                label=module_node.name,
                subtitle=self._relative_path_for(module_node),
            ),
        )

    def _breadcrumbs_for_symbol(
        self,
        symbol_node: GraphNode,
        *,
        include_flow: bool = False,
    ) -> tuple[GraphBreadcrumb, ...]:
        module_node = self._resolve_module_node(symbol_node.node_id)
        breadcrumbs = [
            *self._breadcrumbs_for_module(module_node),
            GraphBreadcrumb(
                node_id=symbol_node.node_id,
                level=GraphAbstractionLevel.SYMBOL,
                label=symbol_node.name,
                subtitle=symbol_node.qualname or symbol_node.display_name,
            ),
        ]
        if include_flow:
            breadcrumbs.append(
                GraphBreadcrumb(
                    node_id=f"flow:{symbol_node.node_id}",
                    level=GraphAbstractionLevel.FLOW,
                    label="Flow",
                    subtitle=symbol_node.qualname or symbol_node.display_name,
                )
            )
        return tuple(breadcrumbs)

    def _module_view_node(self, node: GraphNode, view_filters: dict[str, bool]) -> GraphViewNode:
        if node.is_external:
            return GraphViewNode(
                node_id=node.node_id,
                kind=GraphViewNodeKind.MODULE,
                label=node.module_name or node.name,
                subtitle="External dependency",
                metadata={
                    "relative_path": node.display_name,
                    "symbol_count": 0,
                    "import_count": 0,
                    "call_count": 0,
                    "is_external": True,
                },
            )

        import_count = 0
        call_count = 0
        symbol_count = 0
        relative_path = self._relative_path_for(node)
        for edge in self.graph.edges:
            edge_target_node = self.graph.nodes.get(edge.target_id)
            if (
                edge.kind == EdgeKind.IMPORTS
                and self._module_id_for_node_id(edge.source_id) == node.node_id
                and (edge_target_node is None or self._is_visible_in_view(edge_target_node, view_filters))
            ):
                import_count += 1
            if edge.kind == EdgeKind.CALLS and self._module_id_for_node_id(edge.source_id) == node.node_id:
                call_count += 1
        for graph_node in self.graph.nodes.values():
            if graph_node.kind == NodeKind.SYMBOL and self._module_id_for_node_id(graph_node.node_id) == node.node_id:
                symbol_count += 1
        return GraphViewNode(
            node_id=node.node_id,
            kind=GraphViewNodeKind.MODULE,
            label=node.module_name or node.name,
            subtitle=self._semantic_module_subtitle(symbol_count, import_count, call_count),
            metadata={
                "relative_path": relative_path,
                "symbol_count": symbol_count,
                "import_count": import_count,
                "call_count": call_count,
                "is_external": node.is_external,
            },
            available_actions=(
                GraphAction("add_import", "Add import"),
                GraphAction("remove_import", "Remove import"),
                GraphAction("reveal_source", "Reveal source"),
            ),
        )

    def _symbol_view_node(self, node: GraphNode) -> GraphViewNode:
        parsed_symbol = self._parsed_symbol(node.node_id)
        flow_enabled = _supports_flow(parsed_symbol.kind)
        top_level = parsed_symbol.parent_symbol_id is None
        inbound_count = self._inbound_dependency_count().get(node.node_id, 0)
        rename_enabled = top_level and inbound_count == 0
        structural_reason = (
            None
            if rename_enabled
            else "Only dependency-free top-level symbols are writable in v1."
        )
        return GraphViewNode(
            node_id=node.node_id,
            kind=_graph_view_kind_for_symbol(parsed_symbol.kind),
            label=node.name,
            subtitle=self._semantic_symbol_subtitle(parsed_symbol, node),
            metadata={
                "symbol_kind": parsed_symbol.kind.value,
                "module_name": node.module_name,
                "qualname": node.qualname or node.display_name,
                "relative_path": self._relative_path_for(node),
                "top_level": top_level,
                "inbound_dependency_count": inbound_count,
                **_source_metadata_for_span(node.span),
            },
            available_actions=tuple(
                action
                for action in (
                    GraphAction("rename_symbol", "Rename symbol", enabled=rename_enabled, reason=structural_reason),
                    GraphAction("delete_symbol", "Delete symbol", enabled=rename_enabled, reason=structural_reason),
                    GraphAction("move_symbol", "Move symbol", enabled=rename_enabled, reason=structural_reason),
                    GraphAction("open_flow", "Open flow", enabled=flow_enabled, reason=None if flow_enabled else "Flow only exists for functions, methods, and classes."),
                    GraphAction("reveal_source", "Reveal source"),
                )
            ),
        )

    def _view_node_for_graph_node(
        self,
        node: GraphNode,
        view_filters: dict[str, bool],
    ) -> GraphViewNode:
        if node.kind == NodeKind.REPO:
            return GraphViewNode(
                node_id=node.node_id,
                kind=GraphViewNodeKind.REPO,
                label=node.name,
                subtitle="Architecture map",
                metadata={"root_path": self.root_path.as_posix()},
            )
        if node.kind == NodeKind.MODULE:
            return self._module_view_node(node, view_filters)
        return self._symbol_view_node(node)

    def _is_visible_in_view(self, node: GraphNode, view_filters: dict[str, bool]) -> bool:
        return bool(view_filters["includeExternalDependencies"] or not node.is_external)

    def _require_graph_node(self, node_id: str) -> GraphNode:
        node = self.graph.nodes.get(node_id)
        if node is None:
            raise ValueError(f"Unknown graph node: {node_id}")
        return node

    def _require_symbol(self, symbol_id: str) -> tuple[ParsedModule, SymbolDef]:
        for parsed in self.parsed_modules:
            for symbol in parsed.symbols:
                if symbol.symbol_id == symbol_id:
                    return parsed, symbol
        raise ValueError(f"Unknown symbol id: {symbol_id}")

    def _parsed_symbol(self, symbol_id: str) -> SymbolDef:
        _, symbol = self._require_symbol(symbol_id)
        return symbol

    def _resolve_module_node(self, node_id: str) -> GraphNode:
        node = self._require_graph_node(node_id)
        if node.kind == NodeKind.MODULE:
            return node
        module_id = self._module_id_for_node_id(node_id)
        if module_id is None:
            raise ValueError(f"Unable to resolve a module context for {node_id}")
        return self._require_graph_node(module_id)

    def _resolve_symbol_node(self, node_id: str) -> GraphNode:
        node = self._require_graph_node(node_id)
        if node.kind == NodeKind.SYMBOL:
            return node
        if node.kind == NodeKind.MODULE:
            symbols = self._symbols_for_module(node.node_id)
            if not symbols:
                raise ValueError(f"No symbols were found for {node.node_id}")
            return self._require_graph_node(symbols[0].node_id)
        default_symbol_id = self.default_focus_node_id()
        return self._require_graph_node(default_symbol_id)

    def _module_id_for_node_id(self, node_id: str) -> str | None:
        node = self.graph.nodes.get(node_id)
        if node is None:
            return None
        if node.kind == NodeKind.MODULE:
            return node.node_id
        if node.kind == NodeKind.SYMBOL and node.module_name:
            return f"module:{node.module_name}"
        return None

    def _relative_path_for(self, node: GraphNode) -> str:
        if isinstance(node.metadata.get("relative_path"), str):
            return str(node.metadata["relative_path"])
        if not node.file_path:
            return node.display_name
        source_path = Path(node.file_path)
        try:
            return source_path.relative_to(self.root_path).as_posix()
        except ValueError:
            return source_path.as_posix()

    def _source_payload_for_node(
        self,
        node: GraphNode,
        *,
        target_id: str,
        exact: bool,
    ) -> dict[str, Any]:
        if node.file_path is None:
            raise ValueError(f"No source is associated with {target_id}.")

        source_path = Path(node.file_path)
        content = source_path.read_text(encoding="utf-8")
        lines = content.splitlines()
        if node.span is None:
            start_line = 1
            end_line = len(lines)
            snippet = content
        elif exact:
            start_line = node.span.start_line
            end_line = node.span.end_line
            snippet = _exact_source_snippet(content, node.span)
        else:
            start_line = node.span.start_line
            end_line = node.span.end_line
            snippet = "\n".join(lines[start_line - 1 : end_line])

        return {
            "target_id": target_id,
            "title": node.display_name,
            "path": self._relative_path_for(node),
            "start_line": start_line,
            "end_line": end_line,
            **(
                {
                    "start_column": node.span.start_column,
                    "end_column": node.span.end_column,
                }
                if exact and node.span is not None
                else {}
            ),
            "content": snippet,
        }

    def _semantic_module_subtitle(
        self,
        symbol_count: int,
        import_count: int,
        call_count: int,
    ) -> str:
        return f"{symbol_count} symbols · {import_count} imports · {call_count} calls"

    def _semantic_symbol_subtitle(self, symbol: SymbolDef, node: GraphNode) -> str:
        symbol_kind = symbol.kind.value.replace("_", " ")
        module_name = node.module_name or "module"
        return f"{symbol_kind} · {module_name}"

    def _lookup_symbol(self, symbol_id: str) -> SymbolDef | None:
        for parsed in self.parsed_modules:
            for symbol in parsed.symbols:
                if symbol.symbol_id == symbol_id:
                    return symbol
        return None


def _normalized_filters(filters: dict[str, bool] | None) -> dict[str, bool]:
    base = {
        "includeImports": True,
        "includeCalls": True,
        "includeDefines": True,
        "includeExternalDependencies": False,
    }
    if filters:
        for key in base:
            if key in filters:
                base[key] = bool(filters[key])
    return base


def _graph_view_kind_for_symbol(symbol_kind: SymbolKind) -> GraphViewNodeKind:
    if symbol_kind in {
        SymbolKind.FUNCTION,
        SymbolKind.ASYNC_FUNCTION,
        SymbolKind.METHOD,
        SymbolKind.ASYNC_METHOD,
    }:
        return GraphViewNodeKind.FUNCTION
    if symbol_kind == SymbolKind.CLASS:
        return GraphViewNodeKind.CLASS
    if symbol_kind == SymbolKind.ENUM:
        return GraphViewNodeKind.ENUM
    if symbol_kind == SymbolKind.VARIABLE:
        return GraphViewNodeKind.VARIABLE
    return GraphViewNodeKind.SYMBOL


def _is_function_like_symbol_kind(symbol_kind: SymbolKind) -> bool:
    return symbol_kind in {
        SymbolKind.FUNCTION,
        SymbolKind.ASYNC_FUNCTION,
        SymbolKind.METHOD,
        SymbolKind.ASYNC_METHOD,
    }


def _supports_flow(symbol_kind: SymbolKind) -> bool:
    return _is_function_like_symbol_kind(symbol_kind) or symbol_kind == SymbolKind.CLASS


def _symbol_source_order(symbol: SymbolDef) -> tuple[int, int, str]:
    if symbol.span is None:
        return (10**9, 10**9, symbol.qualname)
    return (symbol.span.start_line, symbol.span.start_column, symbol.qualname)

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


def _exact_source_snippet(content: str, span: SourceSpan) -> str:
    line_starts = _line_start_offsets(content)
    start_offset = line_starts[max(min(span.start_line - 1, len(line_starts) - 1), 0)]
    raw = content[start_offset : span.end_offset]
    if span.start_column <= 0:
        return raw
    return _strip_base_indentation(raw, span.start_column)


def _line_start_offsets(content: str) -> list[int]:
    offsets = [0]
    for index, character in enumerate(content):
        if character == "\n":
            offsets.append(index + 1)
    return offsets


def _strip_base_indentation(snippet: str, base_indent: int) -> str:
    if base_indent <= 0:
        return snippet

    prefix = " " * base_indent
    stripped_lines: list[str] = []
    for line in snippet.splitlines(keepends=True):
        if line.startswith(prefix):
            stripped_lines.append(line[base_indent:])
        else:
            stripped_lines.append(line)
    return "".join(stripped_lines)


def _find_ast_symbol(tree: ast.AST, qualname: str) -> ast.AST | None:
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
