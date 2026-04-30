"""GraphView projection helpers for Python workspace graphs."""

from __future__ import annotations

from helm.graph import EdgeKind, GraphNode, NodeKind
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
from helm.parser import SymbolDef
from helm.parser.symbols import SourceSpan
from helm.ui.projection_context import (
    ProjectionContext,
    graph_view_kind_for_symbol,
    supports_flow,
)


def default_level(context: ProjectionContext) -> GraphAbstractionLevel:
    internal_modules = context.internal_modules()
    if not internal_modules:
        return GraphAbstractionLevel.REPO
    if len(internal_modules) <= 8:
        return GraphAbstractionLevel.SYMBOL
    return GraphAbstractionLevel.MODULE


def default_focus_node_id(context: ProjectionContext) -> str:
    level = default_level(context)
    if level == GraphAbstractionLevel.REPO:
        return context.graph.repo_id
    if level == GraphAbstractionLevel.MODULE:
        internal_modules = context.internal_modules()
        return internal_modules[0].node_id if internal_modules else context.graph.repo_id

    symbol_scores: dict[str, int] = {}
    for edge in context.graph.edges:
        symbol_scores[edge.source_id] = symbol_scores.get(edge.source_id, 0) + 1
        symbol_scores[edge.target_id] = symbol_scores.get(edge.target_id, 0) + 1

    symbol_nodes = [
        node
        for node in context.graph.nodes.values()
        if node.kind == NodeKind.SYMBOL and not node.is_external
    ]
    symbol_nodes.sort(
        key=lambda node: (
            -symbol_scores.get(node.node_id, 0),
            node.module_name or "",
            node.qualname or node.display_name,
        )
    )
    return symbol_nodes[0].node_id if symbol_nodes else context.graph.repo_id


def get_graph_view(
    context: ProjectionContext,
    target_id: str,
    level: GraphAbstractionLevel,
    filters: dict[str, bool] | None = None,
) -> GraphView:
    projector = GraphProjector(context)
    view_filters = _normalized_filters(filters)
    if level == GraphAbstractionLevel.REPO:
        return projector.build_repo_view(view_filters)
    if level == GraphAbstractionLevel.MODULE:
        return projector.build_module_view(target_id, view_filters)
    return projector.build_symbol_view(target_id, view_filters)


class GraphProjector:
    def __init__(self, context: ProjectionContext) -> None:
        self.context = context

    def build_repo_view(self, view_filters: dict[str, bool]) -> GraphView:
        return self._build_repo_view(view_filters)

    def build_module_view(self, target_id: str, view_filters: dict[str, bool]) -> GraphView:
        return self._build_module_view(target_id, view_filters)

    def build_symbol_view(self, target_id: str, view_filters: dict[str, bool]) -> GraphView:
        return self._build_symbol_view(target_id, view_filters)

    def breadcrumbs_for_module(self, module_node: GraphNode) -> tuple[GraphBreadcrumb, ...]:
        return self._breadcrumbs_for_module(module_node)

    def breadcrumbs_for_symbol(
        self,
        symbol_node: GraphNode,
        *,
        include_flow: bool = False,
    ) -> tuple[GraphBreadcrumb, ...]:
        return self._breadcrumbs_for_symbol(symbol_node, include_flow=include_flow)

    def symbol_view_node(self, node: GraphNode) -> GraphViewNode:
        return self._symbol_view_node(node)

    def _build_repo_view(self, view_filters: dict[str, bool]) -> GraphView:
        repo_node = self.context.graph.nodes[self.context.graph.repo_id]
        nodes = [
            GraphViewNode(
                node_id=repo_node.node_id,
                kind=GraphViewNodeKind.REPO,
                label=repo_node.name,
                subtitle="Architecture map",
                metadata={
                    "root_path": self.context.root_path.as_posix(),
                    "module_count": self.context.graph.report.module_count,
                    "symbol_count": self.context.graph.report.symbol_count,
                },
            )
        ]

        for module_node in self._visible_modules(view_filters):
            nodes.append(self._module_view_node(module_node, view_filters))

        edges = self._module_dependency_edges(view_filters)
        return GraphView(
            root_node_id=self.context.graph.repo_id,
            target_id=self.context.graph.repo_id,
            level=GraphAbstractionLevel.REPO,
            nodes=tuple(nodes),
            edges=tuple(edges),
            breadcrumbs=(
                GraphBreadcrumb(
                    node_id=self.context.graph.repo_id,
                    level=GraphAbstractionLevel.REPO,
                    label=repo_node.name,
                    subtitle="Architecture map",
                ),
            ),
            focus=GraphFocus(
                target_id=self.context.graph.repo_id,
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
        if target_id == self.context.graph.repo_id:
            repo_view = self._build_repo_view(view_filters)
            return GraphView(
                root_node_id=repo_view.root_node_id,
                target_id=repo_view.target_id,
                level=GraphAbstractionLevel.MODULE,
                nodes=repo_view.nodes,
                edges=repo_view.edges,
                breadcrumbs=repo_view.breadcrumbs,
                focus=GraphFocus(
                    target_id=self.context.graph.repo_id,
                    level=GraphAbstractionLevel.MODULE,
                    label=self.context.graph.nodes[self.context.graph.repo_id].name,
                    subtitle="Architecture map",
                    available_levels=(
                        GraphAbstractionLevel.REPO,
                        GraphAbstractionLevel.MODULE,
                    ),
                ),
                truncated=False,
            )

        module_node = self.context.resolve_module_node(target_id)
        module_edge_groups = self._module_dependency_groups(view_filters)
        neighbor_ids = {
            edge.source_id if edge.target_id == module_node.node_id else edge.target_id
            for edge in module_edge_groups
            if edge.source_id == module_node.node_id or edge.target_id == module_node.node_id
        }
        nodes = [self._module_view_node(module_node, view_filters)]
        nodes.extend(
            self._module_view_node(self.context.graph.nodes[neighbor_id], view_filters)
            for neighbor_id in sorted(neighbor_ids)
            if neighbor_id in self.context.graph.nodes
            and self._is_visible_in_view(self.context.graph.nodes[neighbor_id], view_filters)
        )
        top_level_symbols = [
            symbol
            for symbol in self._symbols_for_module(module_node.node_id)
            if self.context.parsed_symbol(symbol.node_id).parent_symbol_id is None
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
                subtitle=self.context.relative_path_for(module_node),
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
        parsed_symbol = self.context.parsed_symbol(symbol_node.node_id)
        module_node = self.context.resolve_module_node(symbol_node.node_id)
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

        if parsed_symbol.parent_symbol_id and parsed_symbol.parent_symbol_id in self.context.graph.nodes:
            parent_symbol = self.context.graph.nodes[parsed_symbol.parent_symbol_id]
            nodes[parent_symbol.node_id] = self._symbol_view_node(parent_symbol)
            edges.append(
                GraphViewEdge(
                    edge_id=f"contains:{parent_symbol.node_id}->{symbol_node.node_id}",
                    kind=GraphViewEdgeKind.CONTAINS,
                    source_id=parent_symbol.node_id,
                    target_id=symbol_node.node_id,
                )
            )

        for child_symbol in self.context.direct_child_symbols(symbol_node.node_id):
            child_node = self.context.require_graph_node(child_symbol.symbol_id)
            nodes[child_node.node_id] = self._symbol_view_node(child_node)
            edges.append(
                GraphViewEdge(
                    edge_id=f"contains:{symbol_node.node_id}->{child_node.node_id}",
                    kind=GraphViewEdgeKind.CONTAINS,
                    source_id=symbol_node.node_id,
                    target_id=child_node.node_id,
                )
            )

        for edge in self.context.graph.edges:
            if edge.kind == EdgeKind.CALLS and view_filters["includeCalls"]:
                if edge.source_id == symbol_node.node_id or edge.target_id == symbol_node.node_id:
                    if edge.source_id in self.context.graph.nodes:
                        nodes[edge.source_id] = self._view_node_for_graph_node(
                            self.context.graph.nodes[edge.source_id],
                            view_filters,
                        )
                    if edge.target_id in self.context.graph.nodes:
                        nodes[edge.target_id] = self._view_node_for_graph_node(
                            self.context.graph.nodes[edge.target_id],
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
                    if edge.target_id in self.context.graph.nodes and self._is_visible_in_view(
                        self.context.graph.nodes[edge.target_id],
                        view_filters,
                    ):
                        nodes[edge.target_id] = self._view_node_for_graph_node(
                            self.context.graph.nodes[edge.target_id],
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
                    if level != GraphAbstractionLevel.FLOW or supports_flow(parsed_symbol.kind)
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
        for edge in self.context.graph.edges:
            if edge.kind not in {EdgeKind.IMPORTS, EdgeKind.CALLS}:
                continue
            source_module_id = self.context.module_id_for_node_id(edge.source_id)
            target_module_id = self.context.module_id_for_node_id(edge.target_id)
            if source_module_id is None or target_module_id is None:
                continue
            if source_module_id == target_module_id:
                continue
            source_node = self.context.graph.nodes.get(source_module_id)
            target_node = self.context.graph.nodes.get(target_module_id)
            if source_node is None or target_node is None:
                continue
            if not self._is_visible_in_view(
                source_node, view_filters
            ) or not self._is_visible_in_view(
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

    def _visible_modules(self, view_filters: dict[str, bool]) -> list[GraphNode]:
        return [
            node
            for node in self.context.graph.nodes.values()
            if node.kind == NodeKind.MODULE and self._is_visible_in_view(node, view_filters)
        ]

    def _symbols_for_module(self, module_id: str) -> list[GraphViewNode]:
        nodes: list[GraphViewNode] = []
        for node in self.context.graph.nodes.values():
            if node.kind != NodeKind.SYMBOL:
                continue
            if self.context.module_id_for_node_id(node.node_id) != module_id:
                continue
            nodes.append(self._symbol_view_node(node))
        nodes.sort(key=lambda node: node.label)
        return nodes

    def _breadcrumbs_for_module(self, module_node: GraphNode) -> tuple[GraphBreadcrumb, ...]:
        repo_node = self.context.graph.nodes[self.context.graph.repo_id]
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
                subtitle=self.context.relative_path_for(module_node),
            ),
        )

    def _breadcrumbs_for_symbol(
        self,
        symbol_node: GraphNode,
        *,
        include_flow: bool = False,
    ) -> tuple[GraphBreadcrumb, ...]:
        module_node = self.context.resolve_module_node(symbol_node.node_id)
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
        relative_path = self.context.relative_path_for(node)
        for edge in self.context.graph.edges:
            edge_target_node = self.context.graph.nodes.get(edge.target_id)
            if (
                edge.kind == EdgeKind.IMPORTS
                and self.context.module_id_for_node_id(edge.source_id) == node.node_id
                and (
                    edge_target_node is None
                    or self._is_visible_in_view(edge_target_node, view_filters)
                )
            ):
                import_count += 1
            if (
                edge.kind == EdgeKind.CALLS
                and self.context.module_id_for_node_id(edge.source_id) == node.node_id
            ):
                call_count += 1
        for graph_node in self.context.graph.nodes.values():
            if (
                graph_node.kind == NodeKind.SYMBOL
                and self.context.module_id_for_node_id(graph_node.node_id) == node.node_id
            ):
                symbol_count += 1
        return GraphViewNode(
            node_id=node.node_id,
            kind=GraphViewNodeKind.MODULE,
            label=node.module_name or node.name,
            subtitle=_semantic_module_subtitle(symbol_count, import_count, call_count),
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
        parsed_symbol = self.context.parsed_symbol(node.node_id)
        flow_enabled = supports_flow(parsed_symbol.kind)
        top_level = parsed_symbol.parent_symbol_id is None
        inbound_count = self.context.inbound_dependency_count().get(node.node_id, 0)
        rename_enabled = top_level and inbound_count == 0
        structural_reason = (
            None if rename_enabled else "Only dependency-free top-level symbols are writable in v1."
        )
        return GraphViewNode(
            node_id=node.node_id,
            kind=graph_view_kind_for_symbol(parsed_symbol.kind),
            label=node.name,
            subtitle=_semantic_symbol_subtitle(parsed_symbol, node),
            metadata={
                "symbol_kind": parsed_symbol.kind.value,
                "module_name": node.module_name,
                "qualname": node.qualname or node.display_name,
                "relative_path": self.context.relative_path_for(node),
                "top_level": top_level,
                "inbound_dependency_count": inbound_count,
                **_source_metadata_for_span(node.span),
            },
            available_actions=tuple(
                action
                for action in (
                    GraphAction(
                        "rename_symbol",
                        "Rename symbol",
                        enabled=rename_enabled,
                        reason=structural_reason,
                    ),
                    GraphAction(
                        "delete_symbol",
                        "Delete symbol",
                        enabled=rename_enabled,
                        reason=structural_reason,
                    ),
                    GraphAction(
                        "move_symbol",
                        "Move symbol",
                        enabled=rename_enabled,
                        reason=structural_reason,
                    ),
                    GraphAction(
                        "open_flow",
                        "Open flow",
                        enabled=flow_enabled,
                        reason=None
                        if flow_enabled
                        else "Flow only exists for functions, methods, and classes.",
                    ),
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
                metadata={"root_path": self.context.root_path.as_posix()},
            )
        if node.kind == NodeKind.MODULE:
            return self._module_view_node(node, view_filters)
        return self._symbol_view_node(node)

    def _is_visible_in_view(self, node: GraphNode, view_filters: dict[str, bool]) -> bool:
        return bool(view_filters["includeExternalDependencies"] or not node.is_external)

    def _resolve_symbol_node(self, node_id: str) -> GraphNode:
        node = self.context.require_graph_node(node_id)
        if node.kind == NodeKind.SYMBOL:
            return node
        if node.kind == NodeKind.MODULE:
            symbols = self._symbols_for_module(node.node_id)
            if not symbols:
                raise ValueError(f"No symbols were found for {node.node_id}")
            return self.context.require_graph_node(symbols[0].node_id)
        default_symbol_id = default_focus_node_id(self.context)
        return self.context.require_graph_node(default_symbol_id)


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


def _source_metadata_for_span(span: SourceSpan | None) -> dict[str, int]:
    if span is None:
        return {}

    return {
        "source_start_line": span.start_line,
        "source_start_column": span.start_column,
        "source_end_line": span.end_line,
        "source_end_column": span.end_column,
    }


def _semantic_module_subtitle(
    symbol_count: int,
    import_count: int,
    call_count: int,
) -> str:
    return f"{symbol_count} symbols · {import_count} imports · {call_count} calls"


def _semantic_symbol_subtitle(symbol: SymbolDef, node: GraphNode) -> str:
    symbol_kind = symbol.kind.value.replace("_", " ")
    module_name = node.module_name or "module"
    return f"{symbol_kind} · {module_name}"
