"""Small read-side helpers over the domain graph."""

from __future__ import annotations

from helm.graph.models import EdgeKind, NodeKind, RepoGraph


def iter_nodes(graph: RepoGraph):
    for node_id in sorted(graph.nodes):
        yield graph.nodes[node_id]


def iter_nodes_by_kind(graph: RepoGraph, kind: NodeKind):
    for node in iter_nodes(graph):
        if node.kind == kind:
            yield node


def iter_edges(graph: RepoGraph, kind: EdgeKind | None = None):
    for edge in graph.edges:
        if kind is None or edge.kind == kind:
            yield edge


def edge_count_by_kind(graph: RepoGraph, kind: EdgeKind) -> int:
    return sum(1 for _ in iter_edges(graph, kind))
