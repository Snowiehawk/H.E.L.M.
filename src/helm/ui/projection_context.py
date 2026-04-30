"""Read-only projection context for Python workspace graph views."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from helm.graph import EdgeKind, GraphNode, NodeKind, RepoGraph
from helm.graph.models import GraphViewNodeKind
from helm.parser import ParsedModule, SymbolDef, SymbolKind


@dataclass(frozen=True)
class ProjectionContext:
    root_path: Path
    graph: RepoGraph
    parsed_modules: list[ParsedModule]

    def require_graph_node(self, node_id: str) -> GraphNode:
        node = self.graph.nodes.get(node_id)
        if node is None:
            raise ValueError(f"Unknown graph node: {node_id}")
        return node

    def require_symbol(self, symbol_id: str) -> tuple[ParsedModule, SymbolDef]:
        for parsed in self.parsed_modules:
            for symbol in parsed.symbols:
                if symbol.symbol_id == symbol_id:
                    return parsed, symbol
        raise ValueError(f"Unknown symbol id: {symbol_id}")

    def parsed_symbol(self, symbol_id: str) -> SymbolDef:
        _, symbol = self.require_symbol(symbol_id)
        return symbol

    def resolve_module_node(self, node_id: str) -> GraphNode:
        node = self.require_graph_node(node_id)
        if node.kind == NodeKind.MODULE:
            return node
        module_id = self.module_id_for_node_id(node_id)
        if module_id is None:
            raise ValueError(f"Unable to resolve a module context for {node_id}")
        return self.require_graph_node(module_id)

    def module_id_for_node_id(self, node_id: str) -> str | None:
        node = self.graph.nodes.get(node_id)
        if node is None:
            return None
        if node.kind == NodeKind.MODULE:
            return node.node_id
        if node.kind == NodeKind.SYMBOL and node.module_name:
            return f"module:{node.module_name}"
        return None

    def relative_path_for(self, node: GraphNode) -> str:
        if isinstance(node.metadata.get("relative_path"), str):
            return str(node.metadata["relative_path"])
        if not node.file_path:
            return node.display_name
        source_path = Path(node.file_path)
        try:
            return source_path.relative_to(self.root_path).as_posix()
        except ValueError:
            return source_path.as_posix()

    def direct_child_symbols(self, parent_symbol_id: str) -> list[SymbolDef]:
        children = [
            symbol
            for parsed in self.parsed_modules
            for symbol in parsed.symbols
            if symbol.parent_symbol_id == parent_symbol_id
        ]
        children.sort(key=symbol_source_order)
        return children

    def lookup_symbol(self, symbol_id: str) -> SymbolDef | None:
        for parsed in self.parsed_modules:
            for symbol in parsed.symbols:
                if symbol.symbol_id == symbol_id:
                    return symbol
        return None

    def internal_modules(self) -> list[GraphNode]:
        return [
            node
            for node in self.graph.nodes.values()
            if node.kind == NodeKind.MODULE and not node.is_external
        ]

    def inbound_dependency_count(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for edge in self.graph.edges:
            if edge.kind != EdgeKind.CALLS:
                continue
            counts[edge.target_id] = counts.get(edge.target_id, 0) + 1
        return counts


def graph_view_kind_for_symbol(symbol_kind: SymbolKind) -> GraphViewNodeKind:
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


def is_function_like_symbol_kind(symbol_kind: SymbolKind) -> bool:
    return symbol_kind in {
        SymbolKind.FUNCTION,
        SymbolKind.ASYNC_FUNCTION,
        SymbolKind.METHOD,
        SymbolKind.ASYNC_METHOD,
    }


def supports_flow(symbol_kind: SymbolKind) -> bool:
    return is_function_like_symbol_kind(symbol_kind) or symbol_kind == SymbolKind.CLASS


def symbol_source_order(symbol: SymbolDef) -> tuple[int, int, str]:
    if symbol.span is None:
        return (10**9, 10**9, symbol.qualname)
    return (symbol.span.start_line, symbol.span.start_column, symbol.qualname)
