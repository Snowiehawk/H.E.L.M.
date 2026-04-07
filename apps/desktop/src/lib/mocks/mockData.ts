import type {
  BackendStatus,
  FileContents,
  GraphNeighborhood,
  IndexingJobState,
  OverviewData,
  RecentRepo,
  RepoSession,
  SearchResult,
  SymbolDetails,
} from "../adapter/contracts";

export const defaultRepoPath =
  "/Users/noahphillips/Documents/git-repos/H.E.L.M.";

export const recentRepos: RecentRepo[] = [
  {
    name: "H.E.L.M.",
    path: defaultRepoPath,
    branch: "main",
    lastOpenedAt: "2026-04-06T20:48:00.000Z",
  },
  {
    name: "atlas-docs",
    path: "/Users/noahphillips/Documents/git-repos/atlas-docs",
    branch: "design-refresh",
    lastOpenedAt: "2026-04-05T18:14:00.000Z",
  },
  {
    name: "harbor-api",
    path: "/Users/noahphillips/Documents/git-repos/harbor-api",
    branch: "graph-beta",
    lastOpenedAt: "2026-04-03T08:12:00.000Z",
  },
];

export const mockBackendStatus: BackendStatus = {
  mode: "mock",
  available: true,
  pythonCommand: "mock",
  note: "Browser-only mode is using seeded data. Run the Tauri shell to exercise the real Python backbone from the UI.",
};

export function buildRepoSession(path = defaultRepoPath): RepoSession {
  const segments = path.split("/").filter(Boolean);
  const name = segments[segments.length - 1] ?? "repo";

  return {
    id: `repo:${path}`,
    name,
    path,
    branch: "main",
    primaryLanguage: "Python",
    openedAt: new Date().toISOString(),
  };
}

export const searchResults: SearchResult[] = [
  {
    id: "file:src/helm/cli.py",
    kind: "file",
    title: "src/helm/cli.py",
    subtitle: "CLI entrypoint for scanning repositories",
    score: 0.96,
    filePath: "src/helm/cli.py",
    nodeId: "module:helm.cli",
  },
  {
    id: "file:src/helm/ui/api.py",
    kind: "file",
    title: "src/helm/ui/api.py",
    subtitle: "Human-readable graph summaries and export payloads",
    score: 0.94,
    filePath: "src/helm/ui/api.py",
    nodeId: "module:helm.ui.api",
  },
  {
    id: "file:src/helm/graph/models.py",
    kind: "file",
    title: "src/helm/graph/models.py",
    subtitle: "Graph node, edge, and report types",
    score: 0.91,
    filePath: "src/helm/graph/models.py",
    nodeId: "module:helm.graph.models",
  },
  {
    id: "symbol:helm.cli.main",
    kind: "symbol",
    title: "main",
    subtitle: "helm.cli.main",
    score: 0.99,
    filePath: "src/helm/cli.py",
    symbolId: "symbol:helm.cli.main",
    nodeId: "symbol:helm.cli.main",
  },
  {
    id: "symbol:helm.ui.api.build_graph_summary",
    kind: "symbol",
    title: "build_graph_summary",
    subtitle: "helm.ui.api.build_graph_summary",
    score: 0.97,
    filePath: "src/helm/ui/api.py",
    symbolId: "symbol:helm.ui.api.build_graph_summary",
    nodeId: "symbol:helm.ui.api.build_graph_summary",
  },
  {
    id: "symbol:helm.graph.models.RepoGraph",
    kind: "symbol",
    title: "RepoGraph",
    subtitle: "helm.graph.models.RepoGraph",
    score: 0.95,
    filePath: "src/helm/graph/models.py",
    symbolId: "symbol:helm.graph.models.RepoGraph",
    nodeId: "symbol:helm.graph.models.RepoGraph",
  },
];

export const files: Record<string, FileContents> = {
  "src/helm/cli.py": {
    path: "src/helm/cli.py",
    language: "python",
    lineCount: 60,
    sizeBytes: 1902,
    linkedSymbols: searchResults.filter((result) => result.filePath === "src/helm/cli.py"),
    content: `"""CLI entrypoint for scanning Python repositories into structural graphs."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from helm.config import ScanConfig
from helm.graph import build_repo_graph
from helm.parser import PythonModuleParser, discover_python_modules
from helm.ui import build_export_payload, build_graph_summary, render_text_summary
from helm.utils import configure_logging


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="helm", description="Scan Python repos into structural graphs.")
    subparsers = parser.add_subparsers(dest="command")
    scan_parser = subparsers.add_parser("scan", help="Scan a repository and print a summary.")
    scan_parser.add_argument("repo", nargs="?", default=".", help="Path to the repository root.")
    scan_parser.add_argument("--json-out", type=Path, help="Optional file path for JSON export.")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_argument_parser()
    args = parser.parse_args(argv)
    if args.command != "scan":
        parser.print_help()
        return 1
    return 0`,
  },
  "src/helm/ui/api.py": {
    path: "src/helm/ui/api.py",
    language: "python",
    lineCount: 112,
    sizeBytes: 3275,
    linkedSymbols: searchResults.filter((result) => result.filePath === "src/helm/ui/api.py"),
    content: `"""Human-readable and JSON-ready views over the domain graph."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class GraphSummary:
    repo_path: str
    module_count: int
    symbol_count: int
    import_edge_count: int
    call_edge_count: int
    unresolved_call_count: int
    diagnostic_count: int


def build_graph_summary(graph, top_n: int = 10) -> GraphSummary:
    return GraphSummary(
        repo_path=graph.root_path,
        module_count=graph.report.module_count,
        symbol_count=graph.report.symbol_count,
        import_edge_count=graph.report.import_edge_count,
        call_edge_count=graph.report.call_edge_count,
        unresolved_call_count=graph.report.unresolved_call_count,
        diagnostic_count=graph.report.diagnostic_count,
    )`,
  },
  "src/helm/graph/models.py": {
    path: "src/helm/graph/models.py",
    language: "python",
    lineCount: 126,
    sizeBytes: 3660,
    linkedSymbols: searchResults.filter(
      (result) => result.filePath === "src/helm/graph/models.py",
    ),
    content: `"""Domain-owned graph types for H.E.L.M."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class NodeKind(str, Enum):
    REPO = "repo"
    MODULE = "module"
    SYMBOL = "symbol"


@dataclass(frozen=True)
class RepoGraph:
    root_path: str
    repo_id: str
    nodes: dict[str, GraphNode]
    edges: tuple[GraphEdge, ...]
    diagnostics: tuple[ParseDiagnostic, ...]
    unresolved_calls: tuple[UnresolvedCall, ...]
    report: BuildReport`,
  },
};

export const symbols: Record<string, SymbolDetails> = {
  "symbol:helm.cli.main": {
    symbolId: "symbol:helm.cli.main",
    nodeId: "symbol:helm.cli.main",
    kind: "function",
    name: "main",
    qualname: "helm.cli.main",
    moduleName: "helm.cli",
    filePath: "src/helm/cli.py",
    signature: "main(argv: list[str] | None = None) -> int",
    docSummary:
      "CLI boundary for repo scanning. It collects arguments, launches the parser and graph builder, then prints a summary.",
    startLine: 28,
    endLine: 58,
    callers: [
      {
        id: "ref:entrypoint",
        label: "__main__",
        subtitle: "Script entrypoint",
        nodeId: "module:helm.cli",
      },
    ],
    callees: [
      {
        id: "symbol:helm.ui.api.build_graph_summary",
        label: "build_graph_summary",
        subtitle: "helm.ui.api.build_graph_summary",
        nodeId: "symbol:helm.ui.api.build_graph_summary",
        symbolId: "symbol:helm.ui.api.build_graph_summary",
      },
      {
        id: "symbol:helm.graph.models.RepoGraph",
        label: "RepoGraph",
        subtitle: "helm.graph.models.RepoGraph",
        nodeId: "symbol:helm.graph.models.RepoGraph",
        symbolId: "symbol:helm.graph.models.RepoGraph",
      },
    ],
    references: [
      {
        id: "ref:cli:scan",
        label: "scan subcommand",
        subtitle: "Used by the desktop onboarding flow as a future backend entrypoint",
        nodeId: "module:helm.cli",
      },
    ],
    metadata: {
      Visibility: "public",
      Stability: "backbone-owned",
      Surface: "read-only in desktop v1",
    },
  },
  "symbol:helm.ui.api.build_graph_summary": {
    symbolId: "symbol:helm.ui.api.build_graph_summary",
    nodeId: "symbol:helm.ui.api.build_graph_summary",
    kind: "function",
    name: "build_graph_summary",
    qualname: "helm.ui.api.build_graph_summary",
    moduleName: "helm.ui.api",
    filePath: "src/helm/ui/api.py",
    signature: "build_graph_summary(graph: RepoGraph, top_n: int = 10) -> GraphSummary",
    docSummary:
      "Projects the structural graph into compact summary cards the UI can render quickly while the deeper graph remains explorable.",
    startLine: 49,
    endLine: 81,
    callers: [
      {
        id: "symbol:helm.cli.main",
        label: "main",
        subtitle: "helm.cli.main",
        nodeId: "symbol:helm.cli.main",
        symbolId: "symbol:helm.cli.main",
      },
    ],
    callees: [
      {
        id: "symbol:helm.graph.models.RepoGraph",
        label: "RepoGraph",
        subtitle: "Depends on graph report counts",
        nodeId: "symbol:helm.graph.models.RepoGraph",
        symbolId: "symbol:helm.graph.models.RepoGraph",
      },
    ],
    references: [
      {
        id: "ref:summary:modules",
        label: "ModuleSummary",
        subtitle: "Produces ranked modules for the overview cards",
        nodeId: "module:helm.ui.api",
      },
    ],
    metadata: {
      Visibility: "public",
      Stability: "candidate adapter boundary",
      Surface: "summary payload",
    },
  },
  "symbol:helm.graph.models.RepoGraph": {
    symbolId: "symbol:helm.graph.models.RepoGraph",
    nodeId: "symbol:helm.graph.models.RepoGraph",
    kind: "dataclass",
    name: "RepoGraph",
    qualname: "helm.graph.models.RepoGraph",
    moduleName: "helm.graph.models",
    filePath: "src/helm/graph/models.py",
    signature: "RepoGraph(root_path, repo_id, nodes, edges, diagnostics, unresolved_calls, report)",
    docSummary:
      "The canonical read model of the scanned repository. The desktop UI will eventually consume a transport-friendly projection of this object.",
    startLine: 107,
    endLine: 125,
    callers: [
      {
        id: "symbol:helm.ui.api.build_graph_summary",
        label: "build_graph_summary",
        subtitle: "helm.ui.api.build_graph_summary",
        nodeId: "symbol:helm.ui.api.build_graph_summary",
        symbolId: "symbol:helm.ui.api.build_graph_summary",
      },
    ],
    callees: [],
    references: [
      {
        id: "ref:graph:builder",
        label: "build_repo_graph",
        subtitle: "Constructed after parsing modules",
        nodeId: "module:helm.graph.builder",
      },
    ],
    metadata: {
      Visibility: "public",
      Stability: "domain-owned",
      Surface: "transport input",
    },
  },
};

export function buildOverview(session: RepoSession): OverviewData {
  return {
    repo: session,
    metrics: [
      { label: "Modules", value: "24" },
      { label: "Symbols", value: "87" },
      { label: "Calls", value: "132", tone: "accent" },
      { label: "Diagnostics", value: "2" },
    ],
    modules: [
      {
        id: "module-row:cli",
        moduleId: "module:helm.cli",
        moduleName: "helm.cli",
        relativePath: "src/helm/cli.py",
        symbolCount: 3,
        importCount: 6,
        callCount: 11,
      },
      {
        id: "module-row:ui",
        moduleId: "module:helm.ui.api",
        moduleName: "helm.ui.api",
        relativePath: "src/helm/ui/api.py",
        symbolCount: 7,
        importCount: 4,
        callCount: 9,
      },
      {
        id: "module-row:models",
        moduleId: "module:helm.graph.models",
        moduleName: "helm.graph.models",
        relativePath: "src/helm/graph/models.py",
        symbolCount: 8,
        importCount: 3,
        callCount: 4,
      },
    ],
    hotspots: [
      {
        title: "Transport boundary is shaping up",
        description:
          "The Python UI summary layer already exposes graph-centric projections, which makes it a natural future adapter boundary.",
      },
      {
        title: "CLI path is a clean launch seam",
        description:
          "The scan command already sequences discovery, parsing, and graph building in a way the desktop shell can reuse later.",
      },
    ],
    savedViews: [
      {
        id: "view:scan-flow",
        label: "Scan flow",
        description: "Follow repo ingestion from CLI to graph summary.",
        nodeId: "symbol:helm.cli.main",
      },
      {
        id: "view:ui-summary",
        label: "UI summary",
        description: "Start from build_graph_summary and inspect its neighborhood.",
        nodeId: "symbol:helm.ui.api.build_graph_summary",
      },
      {
        id: "view:graph-core",
        label: "Graph core",
        description: "Jump to RepoGraph and adjacent model types.",
        nodeId: "symbol:helm.graph.models.RepoGraph",
      },
    ],
    focusSymbols: searchResults.filter((result) => result.kind === "symbol"),
    diagnostics: [
      "No live backend transport wired yet. Mock adapter is active.",
      "Graph view is intentionally bounded to a selected neighborhood for readability.",
    ],
    backend: mockBackendStatus,
  };
}

export function buildGraph(nodeId = "symbol:helm.ui.api.build_graph_summary"): GraphNeighborhood {
  return {
    rootNodeId: nodeId,
    depth: 2,
    truncated: false,
    nodes: [
      {
        id: `repo:${defaultRepoPath}`,
        kind: "repo",
        label: "H.E.L.M.",
        subtitle: "Repository",
        x: 0,
        y: 160,
      },
      {
        id: "module:helm.cli",
        kind: "module",
        label: "helm.cli",
        subtitle: "src/helm/cli.py",
        x: 260,
        y: 40,
      },
      {
        id: "module:helm.ui.api",
        kind: "module",
        label: "helm.ui.api",
        subtitle: "src/helm/ui/api.py",
        x: 260,
        y: 270,
      },
      {
        id: "module:helm.graph.models",
        kind: "module",
        label: "helm.graph.models",
        subtitle: "src/helm/graph/models.py",
        x: 530,
        y: 200,
      },
      {
        id: "symbol:helm.cli.main",
        kind: "symbol",
        label: "main",
        subtitle: "helm.cli.main",
        x: 530,
        y: 20,
      },
      {
        id: "symbol:helm.ui.api.build_graph_summary",
        kind: "symbol",
        label: "build_graph_summary",
        subtitle: "helm.ui.api.build_graph_summary",
        x: 560,
        y: 310,
      },
      {
        id: "symbol:helm.graph.models.RepoGraph",
        kind: "symbol",
        label: "RepoGraph",
        subtitle: "helm.graph.models.RepoGraph",
        x: 860,
        y: 180,
      },
    ],
    edges: [
      {
        id: "edge:repo-cli",
        kind: "contains",
        source: `repo:${defaultRepoPath}`,
        target: "module:helm.cli",
      },
      {
        id: "edge:repo-ui",
        kind: "contains",
        source: `repo:${defaultRepoPath}`,
        target: "module:helm.ui.api",
      },
      {
        id: "edge:repo-models",
        kind: "contains",
        source: `repo:${defaultRepoPath}`,
        target: "module:helm.graph.models",
      },
      {
        id: "edge:cli-main",
        kind: "defines",
        source: "module:helm.cli",
        target: "symbol:helm.cli.main",
      },
      {
        id: "edge:ui-summary",
        kind: "defines",
        source: "module:helm.ui.api",
        target: "symbol:helm.ui.api.build_graph_summary",
      },
      {
        id: "edge:models-repograph",
        kind: "defines",
        source: "module:helm.graph.models",
        target: "symbol:helm.graph.models.RepoGraph",
      },
      {
        id: "edge:main-summary",
        kind: "calls",
        source: "symbol:helm.cli.main",
        target: "symbol:helm.ui.api.build_graph_summary",
        label: "summary projection",
      },
      {
        id: "edge:summary-graph",
        kind: "calls",
        source: "symbol:helm.ui.api.build_graph_summary",
        target: "symbol:helm.graph.models.RepoGraph",
        label: "reads report counts",
      },
      {
        id: "edge:cli-import-ui",
        kind: "imports",
        source: "module:helm.cli",
        target: "module:helm.ui.api",
      },
      {
        id: "edge:ui-import-models",
        kind: "imports",
        source: "module:helm.ui.api",
        target: "module:helm.graph.models",
      },
    ],
  };
}

export function buildIndexingStates(jobId: string, repoPath: string): IndexingJobState[] {
  return [
    {
      jobId,
      repoPath,
      status: "queued",
      processedModules: 0,
      totalModules: 24,
      symbolCount: 0,
      message: "Queueing scan plan",
      progressPercent: 4,
    },
    {
      jobId,
      repoPath,
      status: "running",
      processedModules: 7,
      totalModules: 24,
      symbolCount: 21,
      message: "Parsing modules and collecting symbols",
      progressPercent: 35,
    },
    {
      jobId,
      repoPath,
      status: "running",
      processedModules: 16,
      totalModules: 24,
      symbolCount: 59,
      message: "Resolving references and graph edges",
      progressPercent: 72,
    },
    {
      jobId,
      repoPath,
      status: "done",
      processedModules: 24,
      totalModules: 24,
      symbolCount: 87,
      message: "Workspace ready",
      progressPercent: 100,
    },
  ];
}
