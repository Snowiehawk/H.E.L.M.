"""Human-readable and JSON-ready views over the domain graph."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from helm.graph.models import EdgeKind, NodeKind, RepoGraph
from helm.graph.queries import iter_edges, iter_nodes_by_kind


@dataclass(frozen=True)
class ModuleSummary:
    module_id: str
    module_name: str
    relative_path: str
    symbol_count: int
    import_count: int
    outgoing_call_count: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "module_id": self.module_id,
            "module_name": self.module_name,
            "relative_path": self.relative_path,
            "symbol_count": self.symbol_count,
            "import_count": self.import_count,
            "outgoing_call_count": self.outgoing_call_count,
        }


@dataclass(frozen=True)
class GraphSummary:
    repo_path: str
    module_count: int
    symbol_count: int
    import_edge_count: int
    call_edge_count: int
    unresolved_call_count: int
    diagnostic_count: int
    modules: tuple[ModuleSummary, ...] = field(default_factory=tuple)

    def to_dict(self) -> dict[str, Any]:
        return {
            "repo_path": self.repo_path,
            "module_count": self.module_count,
            "symbol_count": self.symbol_count,
            "import_edge_count": self.import_edge_count,
            "call_edge_count": self.call_edge_count,
            "unresolved_call_count": self.unresolved_call_count,
            "diagnostic_count": self.diagnostic_count,
            "modules": [module.to_dict() for module in self.modules],
        }


def build_graph_summary(graph: RepoGraph, top_n: int = 10) -> GraphSummary:
    import_counts = _count_edges_by_module(graph, EdgeKind.IMPORTS)
    call_counts = _count_edges_by_module(graph, EdgeKind.CALLS)
    symbol_counts = _count_symbols_by_module(graph)
    import_edge_count = sum(import_counts.values())

    module_summaries: list[ModuleSummary] = []
    for module_node in iter_nodes_by_kind(graph, NodeKind.MODULE):
        if module_node.is_external:
            continue
        module_summaries.append(
            ModuleSummary(
                module_id=module_node.node_id,
                module_name=module_node.module_name or module_node.name,
                relative_path=str(
                    module_node.metadata.get("relative_path", module_node.display_name)
                ),
                symbol_count=symbol_counts.get(module_node.node_id, 0),
                import_count=import_counts.get(module_node.node_id, 0),
                outgoing_call_count=call_counts.get(module_node.node_id, 0),
            )
        )

    ranked_modules = tuple(
        sorted(
            module_summaries,
            key=lambda item: (-item.symbol_count, item.relative_path),
        )[:top_n]
    )
    return GraphSummary(
        repo_path=graph.root_path,
        module_count=graph.report.module_count,
        symbol_count=graph.report.symbol_count,
        import_edge_count=import_edge_count,
        call_edge_count=graph.report.call_edge_count,
        unresolved_call_count=graph.report.unresolved_call_count,
        diagnostic_count=graph.report.diagnostic_count,
        modules=ranked_modules,
    )


def render_text_summary(summary: GraphSummary) -> str:
    lines = [
        f"Scanned repo: {summary.repo_path}",
        (
            "Modules: {modules} | Symbols: {symbols} | Imports: {imports} | "
            "Resolved calls: {calls} | Unresolved calls: {unresolved} | Diagnostics: {diagnostics}"
        ).format(
            modules=summary.module_count,
            symbols=summary.symbol_count,
            imports=summary.import_edge_count,
            calls=summary.call_edge_count,
            unresolved=summary.unresolved_call_count,
            diagnostics=summary.diagnostic_count,
        ),
    ]

    if summary.modules:
        lines.append("")
        lines.append("Top modules:")
        for module in summary.modules:
            lines.append(
                (
                    f"  - {module.relative_path} "
                    f"(symbols={module.symbol_count}, imports={module.import_count}, calls={module.outgoing_call_count})"
                )
            )

    return "\n".join(lines)


def build_export_payload(graph: RepoGraph, summary: GraphSummary | None = None) -> dict[str, Any]:
    return {
        "summary": (summary or build_graph_summary(graph)).to_dict(),
        "graph": graph.to_dict(),
    }


def _count_edges_by_module(graph: RepoGraph, edge_kind: EdgeKind) -> dict[str, int]:
    module_ids = {
        node.module_name: node.node_id
        for node in iter_nodes_by_kind(graph, NodeKind.MODULE)
        if not node.is_external and node.module_name is not None
    }
    counts: dict[str, int] = {}
    for edge in iter_edges(graph, edge_kind):
        source_node = graph.nodes.get(edge.source_id)
        target_node = graph.nodes.get(edge.target_id)
        if source_node is None:
            continue
        if edge_kind == EdgeKind.IMPORTS and target_node is not None and target_node.is_external:
            continue
        if source_node.kind == NodeKind.MODULE:
            module_id = source_node.node_id
        else:
            module_id = module_ids.get(source_node.module_name or "")
        if module_id is None:
            continue
        counts[module_id] = counts.get(module_id, 0) + 1
    return counts


def _count_symbols_by_module(graph: RepoGraph) -> dict[str, int]:
    module_ids = {
        node.module_name: node.node_id
        for node in iter_nodes_by_kind(graph, NodeKind.MODULE)
        if not node.is_external and node.module_name is not None
    }
    counts: dict[str, int] = {}
    for node in iter_nodes_by_kind(graph, NodeKind.SYMBOL):
        module_id = module_ids.get(node.module_name or "")
        if module_id is None:
            continue
        counts[module_id] = counts.get(module_id, 0) + 1
    return counts
