"""Domain-owned graph types for H.E.L.M."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from helm.parser.symbols import ParseDiagnostic, ReferenceConfidence, SourceSpan


class NodeKind(str, Enum):
    REPO = "repo"
    MODULE = "module"
    SYMBOL = "symbol"


class EdgeKind(str, Enum):
    CONTAINS = "contains"
    IMPORTS = "imports"
    DEFINES = "defines"
    CALLS = "calls"


def make_repo_id(root_path: str) -> str:
    return f"repo:{root_path}"


@dataclass(frozen=True)
class GraphNode:
    node_id: str
    kind: NodeKind
    name: str
    display_name: str
    file_path: str | None = None
    module_name: str | None = None
    qualname: str | None = None
    span: SourceSpan | None = None
    is_external: bool = False
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "node_id": self.node_id,
            "kind": self.kind.value,
            "name": self.name,
            "display_name": self.display_name,
            "file_path": self.file_path,
            "module_name": self.module_name,
            "qualname": self.qualname,
            "is_external": self.is_external,
            "metadata": self.metadata,
        }
        if self.span is not None:
            payload["span"] = self.span.to_dict()
        return payload


@dataclass(frozen=True)
class GraphEdge:
    edge_id: str
    kind: EdgeKind
    source_id: str
    target_id: str
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "edge_id": self.edge_id,
            "kind": self.kind.value,
            "source_id": self.source_id,
            "target_id": self.target_id,
            "metadata": self.metadata,
        }


@dataclass(frozen=True)
class UnresolvedCall:
    call_id: str
    source_id: str
    module_id: str
    owner_symbol_id: str | None
    callee_expr: str
    reason: str
    span: SourceSpan

    def to_dict(self) -> dict[str, Any]:
        return {
            "call_id": self.call_id,
            "source_id": self.source_id,
            "module_id": self.module_id,
            "owner_symbol_id": self.owner_symbol_id,
            "callee_expr": self.callee_expr,
            "reason": self.reason,
            "span": self.span.to_dict(),
        }


@dataclass(frozen=True)
class BuildReport:
    module_count: int
    symbol_count: int
    import_edge_count: int
    call_edge_count: int
    unresolved_call_count: int
    diagnostic_count: int

    def to_dict(self) -> dict[str, int]:
        return {
            "module_count": self.module_count,
            "symbol_count": self.symbol_count,
            "import_edge_count": self.import_edge_count,
            "call_edge_count": self.call_edge_count,
            "unresolved_call_count": self.unresolved_call_count,
            "diagnostic_count": self.diagnostic_count,
        }


@dataclass(frozen=True)
class RepoGraph:
    root_path: str
    repo_id: str
    nodes: dict[str, GraphNode]
    edges: tuple[GraphEdge, ...]
    diagnostics: tuple[ParseDiagnostic, ...]
    unresolved_calls: tuple[UnresolvedCall, ...]
    report: BuildReport

    def to_dict(self) -> dict[str, Any]:
        return {
            "root_path": self.root_path,
            "repo_id": self.repo_id,
            "nodes": [self.nodes[node_id].to_dict() for node_id in sorted(self.nodes)],
            "edges": [edge.to_dict() for edge in self.edges],
            "diagnostics": [diagnostic.to_dict() for diagnostic in self.diagnostics],
            "unresolved_calls": [
                unresolved.to_dict() for unresolved in self.unresolved_calls
            ],
            "report": self.report.to_dict(),
        }
