import type {
  BackendStatus,
  EditableNodeSource,
  FileContents,
  GraphActionDto,
  GraphAbstractionLevel,
  GraphSymbolNodeKind,
  GraphView,
  OverviewData,
  RecentRepo,
  RepoSession,
  RevealedSource,
  SearchResult,
  StructuralEditRequest,
  StructuralEditResult,
  SymbolDetails,
} from "../adapter/contracts";
import { isGraphSymbolNodeKind } from "../adapter/contracts";

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
];

export const mockBackendStatus: BackendStatus = {
  mode: "mock",
  available: true,
  pythonCommand: "mock",
  note: "Browser-only mode is using seeded data. Run the Tauri shell to exercise the real Python backbone from the UI.",
};

export interface MockWorkspaceState {
  primarySummarySymbolName: string;
  uiApiImports: string[];
  uiApiExtraSymbols: Array<{ name: string; kind: "function" | "class" }>;
  editedSources: Record<string, string>;
}

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

export function createMockWorkspaceState(): MockWorkspaceState {
  return {
    primarySummarySymbolName: "build_graph_summary",
    uiApiImports: [
      "from dataclasses import dataclass, field",
      "from typing import Any",
      "from helm.graph.models import RepoGraph",
    ],
    uiApiExtraSymbols: [],
    editedSources: {},
  };
}

export function buildOverview(
  session: RepoSession,
  state: MockWorkspaceState,
): OverviewData {
  const searchResults = buildSearchResults(state);
  return {
    repo: session,
    metrics: [
      { label: "Modules", value: "3" },
      { label: "Symbols", value: String(5 + state.uiApiExtraSymbols.length) },
      { label: "Calls", value: "3", tone: "accent" },
      { label: "Diagnostics", value: "0" },
    ],
    modules: [
      {
        id: "module-row:cli",
        moduleId: "module:helm.cli",
        moduleName: "helm.cli",
        relativePath: "src/helm/cli.py",
        symbolCount: 1,
        importCount: 1,
        callCount: 1,
        outline: [
          {
            id: "outline:symbol:helm.cli:main",
            nodeId: symbolId("helm.cli", "main"),
            label: "main",
            kind: "function",
            startLine: 4,
            topLevel: true,
          },
        ],
      },
      {
        id: "module-row:ui",
        moduleId: "module:helm.ui.api",
        moduleName: "helm.ui.api",
        relativePath: "src/helm/ui/api.py",
        symbolCount: 3 + state.uiApiExtraSymbols.length,
        importCount: 1,
        callCount: 1,
        outline: [
          {
            id: "outline:symbol:helm.ui.api:GraphSummary",
            nodeId: symbolId("helm.ui.api", "GraphSummary"),
            label: "GraphSummary",
            kind: "class",
            startLine: 5,
            topLevel: true,
          },
          {
            id: `outline:${symbolId("helm.ui.api", state.primarySummarySymbolName)}`,
            nodeId: symbolId("helm.ui.api", state.primarySummarySymbolName),
            label: state.primarySummarySymbolName,
            kind: "function",
            startLine: 10,
            topLevel: true,
          },
          {
            id: "outline:symbol:helm.ui.api:build_export_payload",
            nodeId: symbolId("helm.ui.api", "build_export_payload"),
            label: "build_export_payload",
            kind: "function",
            startLine: 16,
            topLevel: true,
          },
          ...state.uiApiExtraSymbols.map((symbol, index) => ({
            id: `outline:${symbolId("helm.ui.api", symbol.name)}`,
            nodeId: symbolId("helm.ui.api", symbol.name),
            label: symbol.name,
            kind: symbol.kind,
            startLine: 20 + index * 3,
            topLevel: true,
          })),
        ],
      },
      {
        id: "module-row:models",
        moduleId: "module:helm.graph.models",
        moduleName: "helm.graph.models",
        relativePath: "src/helm/graph/models.py",
        symbolCount: 1,
        importCount: 0,
        callCount: 0,
        outline: [
          {
            id: "outline:symbol:helm.graph.models:RepoGraph",
            nodeId: symbolId("helm.graph.models", "RepoGraph"),
            label: "RepoGraph",
            kind: "class",
            startLine: 4,
            topLevel: true,
          },
        ],
      },
    ],
    hotspots: [
      {
        title: "Architecture-first canvas",
        description:
          "The workspace opens on module interactions instead of a directory tree, then drills into symbols and flow only when you ask.",
      },
      {
        title: "Semantic edits stay in the graph",
        description:
          "Rename, create, and import actions surface as graph operations first, with source only revealed on demand.",
      },
    ],
    savedViews: [
      {
        id: "view:repo",
        label: "Repo Architecture",
        description: "Start from the repo boundary and inspect module interactions.",
        nodeId: session.id,
        level: "module",
      },
      {
        id: "view:ui-summary",
        label: "Summary Blueprint",
        description: "Jump straight into the summary-building function and its neighbors.",
        nodeId: symbolId("helm.ui.api", state.primarySummarySymbolName),
        level: "symbol",
      },
    ],
    focusSymbols: searchResults.filter((result) => result.kind === "symbol"),
    diagnostics: [
      "Mock transport is active.",
      "Source remains hidden until Reveal source is requested.",
    ],
    backend: mockBackendStatus,
    defaultLevel: "module",
    defaultFocusNodeId: session.id,
  };
}

export function buildSearchResults(state: MockWorkspaceState): SearchResult[] {
  const results: SearchResult[] = [
    {
      id: "module:helm.cli",
      kind: "module",
      title: "helm.cli",
      subtitle: "src/helm/cli.py",
      score: 0.95,
      filePath: "src/helm/cli.py",
      nodeId: "module:helm.cli",
      level: "module",
    },
    {
      id: "module:helm.ui.api",
      kind: "module",
      title: "helm.ui.api",
      subtitle: "src/helm/ui/api.py",
      score: 0.99,
      filePath: "src/helm/ui/api.py",
      nodeId: "module:helm.ui.api",
      level: "module",
    },
    {
      id: "module:helm.graph.models",
      kind: "module",
      title: "helm.graph.models",
      subtitle: "src/helm/graph/models.py",
      score: 0.92,
      filePath: "src/helm/graph/models.py",
      nodeId: "module:helm.graph.models",
      level: "module",
    },
    {
      id: symbolId("helm.cli", "main"),
      kind: "symbol",
      title: "main",
      subtitle: "helm.cli.main",
      score: 0.91,
      filePath: "src/helm/cli.py",
      symbolId: symbolId("helm.cli", "main"),
      nodeId: symbolId("helm.cli", "main"),
      level: "symbol",
    },
    {
      id: symbolId("helm.ui.api", state.primarySummarySymbolName),
      kind: "symbol",
      title: state.primarySummarySymbolName,
      subtitle: `helm.ui.api.${state.primarySummarySymbolName}`,
      score: 1,
      filePath: "src/helm/ui/api.py",
      symbolId: symbolId("helm.ui.api", state.primarySummarySymbolName),
      nodeId: symbolId("helm.ui.api", state.primarySummarySymbolName),
      level: "symbol",
    },
    {
      id: symbolId("helm.ui.api", "GraphSummary"),
      kind: "symbol",
      title: "GraphSummary",
      subtitle: "helm.ui.api.GraphSummary",
      score: 0.96,
      filePath: "src/helm/ui/api.py",
      symbolId: symbolId("helm.ui.api", "GraphSummary"),
      nodeId: symbolId("helm.ui.api", "GraphSummary"),
      level: "symbol",
    },
    {
      id: symbolId("helm.ui.api", "build_export_payload"),
      kind: "symbol",
      title: "build_export_payload",
      subtitle: "helm.ui.api.build_export_payload",
      score: 0.93,
      filePath: "src/helm/ui/api.py",
      symbolId: symbolId("helm.ui.api", "build_export_payload"),
      nodeId: symbolId("helm.ui.api", "build_export_payload"),
      level: "symbol",
    },
    {
      id: symbolId("helm.graph.models", "RepoGraph"),
      kind: "symbol",
      title: "RepoGraph",
      subtitle: "helm.graph.models.RepoGraph",
      score: 0.94,
      filePath: "src/helm/graph/models.py",
      symbolId: symbolId("helm.graph.models", "RepoGraph"),
      nodeId: symbolId("helm.graph.models", "RepoGraph"),
      level: "symbol",
    },
  ];

  state.uiApiExtraSymbols.forEach((symbol, index) => {
    results.push({
      id: symbolId("helm.ui.api", symbol.name),
      kind: "symbol",
      title: symbol.name,
      subtitle: `helm.ui.api.${symbol.name}`,
      score: 0.7 - index * 0.02,
      filePath: "src/helm/ui/api.py",
      symbolId: symbolId("helm.ui.api", symbol.name),
      nodeId: symbolId("helm.ui.api", symbol.name),
      level: "symbol",
    });
  });

  results.push({
    id: "file:src/helm/ui/api.py",
    kind: "file",
    title: "src/helm/ui/api.py",
    subtitle: "Raw source utility",
    score: 0.35,
    filePath: "src/helm/ui/api.py",
    nodeId: "module:helm.ui.api",
    level: "module",
  });

  return results;
}

export function buildFiles(state: MockWorkspaceState): Record<string, FileContents> {
  const searchResults = buildSearchResults(state);
  return {
    "src/helm/cli.py": {
      path: "src/helm/cli.py",
      language: "python",
      lineCount: 21,
      sizeBytes: 640,
      linkedSymbols: searchResults.filter((result) => result.filePath === "src/helm/cli.py"),
      content: buildCliSource(state),
    },
    "src/helm/ui/api.py": {
      path: "src/helm/ui/api.py",
      language: "python",
      lineCount: buildUiApiSource(state).split("\n").length,
      sizeBytes: new TextEncoder().encode(buildUiApiSource(state)).length,
      linkedSymbols: searchResults.filter((result) => result.filePath === "src/helm/ui/api.py"),
      content: buildUiApiSource(state),
    },
    "src/helm/graph/models.py": {
      path: "src/helm/graph/models.py",
      language: "python",
      lineCount: 12,
      sizeBytes: 341,
      linkedSymbols: searchResults.filter(
        (result) => result.filePath === "src/helm/graph/models.py",
      ),
      content: `from dataclasses import dataclass\n\n\n@dataclass(frozen=True)\nclass RepoGraph:\n    root_path: str\n    repo_id: str\n    nodes: dict[str, object]\n    edges: tuple[object, ...]\n`,
    },
  };
}

export function buildSymbols(state: MockWorkspaceState): Record<string, SymbolDetails> {
  const primarySymbolId = symbolId("helm.ui.api", state.primarySummarySymbolName);
  const result: Record<string, SymbolDetails> = {
    [symbolId("helm.cli", "main")]: {
      symbolId: symbolId("helm.cli", "main"),
      nodeId: symbolId("helm.cli", "main"),
      kind: "function",
      name: "main",
      qualname: "helm.cli.main",
      moduleName: "helm.cli",
      filePath: "src/helm/cli.py",
      signature: "main(argv: list[str] | None = None) -> int",
      docSummary:
        "CLI boundary for repo scanning. It collects arguments, launches the parser and graph builder, then projects the architecture graph.",
      startLine: 12,
      endLine: 18,
      callers: [],
      callees: [
        {
          id: primarySymbolId,
          label: state.primarySummarySymbolName,
          subtitle: `helm.ui.api.${state.primarySummarySymbolName}`,
          nodeId: primarySymbolId,
          symbolId: primarySymbolId,
        },
      ],
      references: [
        {
          id: "module:helm.cli",
          label: "helm.cli",
          subtitle: "src/helm/cli.py",
          nodeId: "module:helm.cli",
        },
      ],
      metadata: {
        Surface: "cli",
        Role: "entrypoint",
      },
    },
    [primarySymbolId]: {
      symbolId: primarySymbolId,
      nodeId: primarySymbolId,
      kind: "function",
      name: state.primarySummarySymbolName,
      qualname: `helm.ui.api.${state.primarySummarySymbolName}`,
      moduleName: "helm.ui.api",
      filePath: "src/helm/ui/api.py",
      signature: `${state.primarySummarySymbolName}(graph: RepoGraph, top_n: int = 10) -> GraphSummary`,
      docSummary:
        "Projects the structural graph into architecture-friendly summary cards and seeds the blueprint editor with a clean starting view.",
      startLine: 10,
      endLine: 20,
      callers: [
        {
          id: symbolId("helm.cli", "main"),
          label: "main",
          subtitle: "helm.cli.main",
          nodeId: symbolId("helm.cli", "main"),
          symbolId: symbolId("helm.cli", "main"),
        },
      ],
      callees: [
        {
          id: symbolId("helm.graph.models", "RepoGraph"),
          label: "RepoGraph",
          subtitle: "helm.graph.models.RepoGraph",
          nodeId: symbolId("helm.graph.models", "RepoGraph"),
          symbolId: symbolId("helm.graph.models", "RepoGraph"),
        },
      ],
      references: [
        {
          id: "module:helm.ui.api",
          label: "helm.ui.api",
          subtitle: "src/helm/ui/api.py",
          nodeId: "module:helm.ui.api",
        },
      ],
      metadata: {
        Surface: "summary",
        Role: "architecture projection",
      },
    },
    [symbolId("helm.ui.api", "GraphSummary")]: {
      symbolId: symbolId("helm.ui.api", "GraphSummary"),
      nodeId: symbolId("helm.ui.api", "GraphSummary"),
      kind: "class",
      name: "GraphSummary",
      qualname: "helm.ui.api.GraphSummary",
      moduleName: "helm.ui.api",
      filePath: "src/helm/ui/api.py",
      signature: "GraphSummary(repo_path, module_count)",
      docSummary:
        "Simple top-level summary container used to project the repo graph into explorer-friendly overview data.",
      startLine: 5,
      endLine: 8,
      callers: [],
      callees: [],
      references: [
        {
          id: "module:helm.ui.api",
          label: "helm.ui.api",
          subtitle: "src/helm/ui/api.py",
          nodeId: "module:helm.ui.api",
        },
      ],
      metadata: {
        Surface: "summary",
        Role: "data container",
      },
    },
    [symbolId("helm.ui.api", "build_export_payload")]: {
      symbolId: symbolId("helm.ui.api", "build_export_payload"),
      nodeId: symbolId("helm.ui.api", "build_export_payload"),
      kind: "function",
      name: "build_export_payload",
      qualname: "helm.ui.api.build_export_payload",
      moduleName: "helm.ui.api",
      filePath: "src/helm/ui/api.py",
      signature: "build_export_payload(graph: RepoGraph) -> dict[str, object]",
      docSummary:
        "Packages the graph scan into a JSON-ready payload for the desktop bridge and UI adapters.",
      startLine: 16,
      endLine: 17,
      callers: [],
      callees: [],
      references: [
        {
          id: "module:helm.ui.api",
          label: "helm.ui.api",
          subtitle: "src/helm/ui/api.py",
          nodeId: "module:helm.ui.api",
        },
      ],
      metadata: {
        Surface: "export",
        Role: "payload builder",
      },
    },
    [symbolId("helm.graph.models", "RepoGraph")]: {
      symbolId: symbolId("helm.graph.models", "RepoGraph"),
      nodeId: symbolId("helm.graph.models", "RepoGraph"),
      kind: "class",
      name: "RepoGraph",
      qualname: "helm.graph.models.RepoGraph",
      moduleName: "helm.graph.models",
      filePath: "src/helm/graph/models.py",
      signature: "RepoGraph(root_path, repo_id, nodes, edges)",
      docSummary:
        "Canonical read model for the scanned repository and the main data source for architecture and flow projections.",
      startLine: 4,
      endLine: 8,
      callers: [
        {
          id: primarySymbolId,
          label: state.primarySummarySymbolName,
          subtitle: `helm.ui.api.${state.primarySummarySymbolName}`,
          nodeId: primarySymbolId,
          symbolId: primarySymbolId,
        },
      ],
      callees: [],
      references: [
        {
          id: "module:helm.graph.models",
          label: "helm.graph.models",
          subtitle: "src/helm/graph/models.py",
          nodeId: "module:helm.graph.models",
        },
      ],
      metadata: {
        Surface: "domain",
        Role: "graph root",
      },
    },
  };

  state.uiApiExtraSymbols.forEach((symbol) => {
    const currentId = symbolId("helm.ui.api", symbol.name);
    result[currentId] = {
      symbolId: currentId,
      nodeId: currentId,
      kind: symbol.kind,
      name: symbol.name,
      qualname: `helm.ui.api.${symbol.name}`,
      moduleName: "helm.ui.api",
      filePath: "src/helm/ui/api.py",
      signature:
        symbol.kind === "class"
          ? `${symbol.name}()`
          : `${symbol.name}() -> None`,
      docSummary: "Newly created semantic node in the blueprint editor.",
      startLine: 22,
      endLine: 24,
      callers: [],
      callees: [],
      references: [
        {
          id: "module:helm.ui.api",
          label: "helm.ui.api",
          subtitle: "src/helm/ui/api.py",
          nodeId: "module:helm.ui.api",
        },
      ],
      metadata: {
        Surface: "graph action",
        Role: "new symbol",
      },
    };
  });

  return result;
}

export function buildGraphView(
  session: RepoSession,
  state: MockWorkspaceState,
  targetId: string,
  level: GraphAbstractionLevel,
): GraphView {
  const primarySymbolId = symbolId("helm.ui.api", state.primarySummarySymbolName);
  if (level === "flow") {
    return {
      rootNodeId: "flow:entry",
      targetId: primarySymbolId,
      level: "flow",
      truncated: false,
      breadcrumbs: [
        { nodeId: session.id, level: "repo", label: session.name, subtitle: "Architecture map" },
        { nodeId: "module:helm.ui.api", level: "module", label: "helm.ui.api", subtitle: "src/helm/ui/api.py" },
        { nodeId: primarySymbolId, level: "symbol", label: state.primarySummarySymbolName, subtitle: `helm.ui.api.${state.primarySummarySymbolName}` },
        { nodeId: `flow:${primarySymbolId}`, level: "flow", label: "Flow", subtitle: "On-demand operation graph" },
      ],
      focus: {
        targetId: primarySymbolId,
        level: "flow",
        label: state.primarySummarySymbolName,
        subtitle: "On-demand flow graph",
        availableLevels: ["repo", "module", "symbol", "flow"],
      },
      nodes: [
        node("flow:entry", "entry", "Entry", "helm.ui.api", 0, 180),
        node("flow:param:graph", "param", "graph", "parameter", 220, 80),
        node("flow:param:top_n", "param", "top_n", "parameter", 220, 280),
        node("flow:assign:modules", "assign", "module_summaries", "collect module stats", 470, 80),
        node("flow:call:rank", "call", "sorted(...)", "rank modules", 720, 80),
        node("flow:return", "return", "return GraphSummary(...)", "emit blueprint summary", 970, 180),
      ],
      edges: [
        edge("controls:entry-assign", "controls", "flow:entry", "flow:assign:modules"),
        edge("controls:assign-rank", "controls", "flow:assign:modules", "flow:call:rank"),
        edge("controls:rank-return", "controls", "flow:call:rank", "flow:return"),
        edge("data:graph-assign", "data", "flow:param:graph", "flow:assign:modules", "graph"),
        edge("data:top-rank", "data", "flow:param:top_n", "flow:call:rank", "top_n"),
        edge("data:assign-rank", "data", "flow:assign:modules", "flow:call:rank", "module_summaries"),
        edge("data:rank-return", "data", "flow:call:rank", "flow:return", "ranked_modules"),
      ],
    };
  }

  if (level === "symbol" || targetId.startsWith("symbol:")) {
    const symbolIdValue = targetId.startsWith("symbol:") ? targetId : primarySymbolId;
    const symbol = buildSymbols(state)[symbolIdValue];
    const symbolParts = symbolIdValue.split(":");
    const fallbackSymbolLabel = symbolParts[symbolParts.length - 1] ?? "Symbol";
    const symbolLabel = symbol?.name ?? fallbackSymbolLabel;
    const moduleId = symbol ? `module:${symbol.moduleName}` : "module:helm.ui.api";
    const moduleLabel = symbol?.moduleName ?? "helm.ui.api";
    const modulePath = symbol?.filePath ?? "src/helm/ui/api.py";
    const flowEnabled = symbol?.kind === "function";
    const symbolNodeKind = graphNodeKindForSymbolKind(symbol?.kind ?? "function");
    return {
      rootNodeId: symbolIdValue,
      targetId: symbolIdValue,
      level: "symbol",
      truncated: false,
      breadcrumbs: [
        { nodeId: session.id, level: "repo", label: session.name, subtitle: "Architecture map" },
        { nodeId: moduleId, level: "module", label: moduleLabel, subtitle: modulePath },
        { nodeId: symbolIdValue, level: "symbol", label: symbolLabel, subtitle: symbol?.qualname ?? symbolIdValue.replace("symbol:", "").replace(/:/g, ".") },
      ],
      focus: {
        targetId: symbolIdValue,
        level: "symbol",
        label: symbolLabel,
        subtitle: "Semantic node",
        availableLevels: flowEnabled ? ["repo", "module", "symbol", "flow"] : ["repo", "module", "symbol"],
      },
      nodes: [
        node(moduleId, "module", moduleLabel, modulePath, 0, 160, {
          symbolCount:
            symbol?.moduleName === "helm.ui.api"
              ? 3 + state.uiApiExtraSymbols.length
              : 1,
          importCount: symbol?.moduleName === "helm.ui.api" ? state.uiApiImports.length : 0,
          callCount: symbol?.moduleName === "helm.ui.api" ? 1 : 0,
        }),
        node(symbolIdValue, symbolNodeKind, symbolLabel, symbol?.qualname ?? symbolLabel, 310, 160, {
          symbolKind: symbol?.kind ?? "function",
        }, symbolActions(true, flowEnabled)),
      ],
      edges: [
        edge(`defines:${moduleId}:${symbolIdValue}`, "defines", moduleId, symbolIdValue),
      ],
    };
  }

  if (level === "module" && targetId === "module:helm.ui.api") {
    const extraNodes = state.uiApiExtraSymbols.map((symbol, index) =>
      node(
        symbolId("helm.ui.api", symbol.name),
        graphNodeKindForSymbolKind(symbol.kind),
        symbol.name,
        `helm.ui.api.${symbol.name}`,
        700,
        420 + index * 110,
        { symbolKind: symbol.kind },
        symbolActions(true),
      ),
    );
    return {
      rootNodeId: "module:helm.ui.api",
      targetId: "module:helm.ui.api",
      level: "module",
      truncated: false,
      breadcrumbs: [
        { nodeId: session.id, level: "repo", label: session.name, subtitle: "Architecture map" },
        { nodeId: "module:helm.ui.api", level: "module", label: "helm.ui.api", subtitle: "src/helm/ui/api.py" },
      ],
      focus: {
        targetId: "module:helm.ui.api",
        level: "module",
        label: "helm.ui.api",
        subtitle: "Architecture slice",
        availableLevels: ["repo", "module"],
      },
      nodes: [
        node("module:helm.ui.api", "module", "helm.ui.api", "src/helm/ui/api.py", 0, 220, {
          symbolCount: 3 + state.uiApiExtraSymbols.length,
          importCount: 1,
          callCount: 1,
        }, moduleActions()),
        node("module:helm.cli", "module", "helm.cli", "src/helm/cli.py", 310, 60),
        node("module:helm.graph.models", "module", "helm.graph.models", "src/helm/graph/models.py", 310, 360),
        node("module:rich.console", "module", "rich.console", "External dependency", 310, 500, {
          isExternal: true,
        }),
        node(symbolId("helm.ui.api", "GraphSummary"), "class", "GraphSummary", "helm.ui.api.GraphSummary", 700, 40, {
          symbolKind: "class",
        }, symbolActions(false)),
        node(primarySymbolId, "function", state.primarySummarySymbolName, `helm.ui.api.${state.primarySummarySymbolName}`, 700, 140, {
          symbolKind: "function",
        }, symbolActions(true)),
        node(symbolId("helm.ui.api", "build_export_payload"), "function", "build_export_payload", "helm.ui.api.build_export_payload", 700, 300, {
          symbolKind: "function",
        }, symbolActions(true)),
        ...extraNodes,
      ],
      edges: [
        edge("imports:cli-ui", "imports", "module:helm.cli", "module:helm.ui.api", "1 import"),
        edge("imports:ui-models", "imports", "module:helm.ui.api", "module:helm.graph.models", "1 import"),
        edge("imports:ui-rich", "imports", "module:helm.ui.api", "module:rich.console", "1 import"),
        edge("defines:ui-summary-class", "defines", "module:helm.ui.api", symbolId("helm.ui.api", "GraphSummary")),
        edge("defines:ui-primary", "defines", "module:helm.ui.api", primarySymbolId),
        edge("defines:ui-export", "defines", "module:helm.ui.api", symbolId("helm.ui.api", "build_export_payload")),
        ...extraNodes.map((symbolNode, index) =>
          edge(`defines:ui-extra:${index}`, "defines", "module:helm.ui.api", symbolNode.id),
        ),
      ],
    };
  }

  return {
    rootNodeId: session.id,
    targetId: session.id,
    level: "module",
    truncated: false,
    breadcrumbs: [{ nodeId: session.id, level: "repo", label: session.name, subtitle: "Architecture map" }],
    focus: {
      targetId: session.id,
      level: "module",
      label: session.name,
      subtitle: "Architecture map",
      availableLevels: ["repo", "module"],
    },
    nodes: [
      node(session.id, "repo", session.name, "Architecture map", 0, 180),
      node("module:helm.cli", "module", "helm.cli", "src/helm/cli.py", 320, 40),
      node("module:helm.ui.api", "module", "helm.ui.api", "src/helm/ui/api.py", 320, 210, undefined, moduleActions()),
      node("module:helm.graph.models", "module", "helm.graph.models", "src/helm/graph/models.py", 320, 380),
      node("module:rich.console", "module", "rich.console", "External dependency", 320, 550, {
        isExternal: true,
      }),
    ],
    edges: [
      edge("imports:cli-ui", "imports", "module:helm.cli", "module:helm.ui.api", "1 import"),
      edge("imports:ui-models", "imports", "module:helm.ui.api", "module:helm.graph.models", "1 import"),
      edge("imports:ui-rich", "imports", "module:helm.ui.api", "module:rich.console", "1 import"),
      edge("calls:cli-ui", "calls", "module:helm.cli", "module:helm.ui.api", "1 call"),
    ],
  };
}

export function buildRevealedSource(
  state: MockWorkspaceState,
  targetId: string,
): RevealedSource {
  if (targetId.startsWith("symbol:")) {
    return buildEditableNodeSource(state, targetId);
  }
  const files = buildFiles(state);
  if (targetId === "module:helm.ui.api") {
    return {
      targetId,
      title: "helm.ui.api",
      path: "src/helm/ui/api.py",
      startLine: 1,
      endLine: files["src/helm/ui/api.py"].lineCount,
      content: files["src/helm/ui/api.py"].content,
    };
  }

  return {
    targetId,
    title: state.primarySummarySymbolName,
    path: "src/helm/ui/api.py",
    startLine: 10,
    endLine: 20,
    content: `def ${state.primarySummarySymbolName}(graph: RepoGraph, top_n: int = 10) -> GraphSummary:\n    module_summaries = []\n    return GraphSummary(repo_path=graph.root_path, module_count=len(module_summaries))`,
  };
}

export function buildEditableNodeSource(
  state: MockWorkspaceState,
  targetId: string,
): EditableNodeSource {
  const symbols = buildSymbols(state);
  const symbol = symbols[targetId];
  if (!symbol) {
    throw new Error(`Unknown editable source target: ${targetId}`);
  }

  const defaultContent = state.editedSources[targetId] ?? defaultSymbolSource(state, symbol);

  return {
    targetId,
    title: symbol.name,
    path: symbol.filePath,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
    content: defaultContent,
    editable: symbol.kind === "function" || symbol.kind === "variable",
    nodeKind: graphNodeKindForSymbolKind(symbol.kind),
    reason:
      symbol.kind === "function" || symbol.kind === "variable"
        ? undefined
        : "Inline editing currently supports only top-level functions and variables.",
  };
}

export function applyMockEdit(
  state: MockWorkspaceState,
  request: StructuralEditRequest,
): StructuralEditResult {
  if (request.kind === "rename_symbol" && request.targetId) {
    if (request.targetId === symbolId("helm.ui.api", state.primarySummarySymbolName) && request.newName) {
      state.primarySummarySymbolName = request.newName;
      return {
        request: {
          kind: "rename_symbol",
          target_id: request.targetId,
          new_name: request.newName,
        },
        summary: `Renamed symbol to ${request.newName}.`,
        touchedRelativePaths: ["src/helm/ui/api.py"],
        reparsedRelativePaths: ["src/helm/ui/api.py"],
        changedNodeIds: [symbolId("helm.ui.api", request.newName)],
        warnings: [],
      };
    }
  }

  if (request.kind === "create_symbol" && request.relativePath === "src/helm/ui/api.py" && request.newName && request.symbolKind) {
    state.uiApiExtraSymbols.push({ name: request.newName, kind: request.symbolKind });
    return {
      request: {
        kind: "create_symbol",
        relative_path: request.relativePath,
        new_name: request.newName,
        symbol_kind: request.symbolKind,
      },
      summary: `Created ${request.symbolKind} ${request.newName}.`,
      touchedRelativePaths: ["src/helm/ui/api.py"],
      reparsedRelativePaths: ["src/helm/ui/api.py"],
      changedNodeIds: [symbolId("helm.ui.api", request.newName)],
      warnings: [],
    };
  }

  if (request.kind === "add_import" && request.relativePath === "src/helm/ui/api.py" && request.importedModule) {
    const importLine = request.importedName
      ? `from ${request.importedModule} import ${request.importedName}${request.alias ? ` as ${request.alias}` : ""}`
      : `import ${request.importedModule}${request.alias ? ` as ${request.alias}` : ""}`;
    state.uiApiImports.push(importLine);
    return {
      request: {
        kind: "add_import",
        relative_path: request.relativePath,
        imported_module: request.importedModule,
        imported_name: request.importedName,
        alias: request.alias,
      },
      summary: `Added import ${importLine}.`,
      touchedRelativePaths: ["src/helm/ui/api.py"],
      reparsedRelativePaths: ["src/helm/ui/api.py"],
      changedNodeIds: ["module:helm.ui.api"],
      warnings: [],
    };
  }

  if (request.kind === "remove_import" && request.relativePath === "src/helm/ui/api.py" && request.importedModule) {
    state.uiApiImports = state.uiApiImports.filter((line) => !line.includes(request.importedModule!));
    return {
      request: {
        kind: "remove_import",
        relative_path: request.relativePath,
        imported_module: request.importedModule,
      },
      summary: `Removed import from ${request.relativePath}.`,
      touchedRelativePaths: ["src/helm/ui/api.py"],
      reparsedRelativePaths: ["src/helm/ui/api.py"],
      changedNodeIds: ["module:helm.ui.api"],
      warnings: [],
    };
  }

  if (request.kind === "replace_symbol_source" && request.targetId && request.content) {
    state.editedSources[request.targetId] = request.content;
    return {
      request: {
        kind: "replace_symbol_source",
        target_id: request.targetId,
        content: request.content,
      },
      summary: `Updated source for ${request.targetId}.`,
      touchedRelativePaths: ["src/helm/ui/api.py"],
      reparsedRelativePaths: ["src/helm/ui/api.py"],
      changedNodeIds: [request.targetId],
      warnings: ["This edit is simulated in the mock adapter."],
    };
  }

  return {
    request: {
      kind: request.kind,
      target_id: request.targetId,
      relative_path: request.relativePath,
      new_name: request.newName,
      symbol_kind: request.symbolKind,
      destination_relative_path: request.destinationRelativePath,
      imported_module: request.importedModule,
      imported_name: request.importedName,
      alias: request.alias,
      body: request.body,
      content: request.content,
    },
    summary: `Mock adapter acknowledged ${request.kind}.`,
    touchedRelativePaths: request.relativePath ? [request.relativePath] : [],
    reparsedRelativePaths: request.relativePath ? [request.relativePath] : [],
    changedNodeIds: request.targetId ? [request.targetId] : [],
    warnings: ["This edit is simulated in the mock adapter."],
  };
}

function buildCliSource(state: MockWorkspaceState): string {
  return `from helm.ui.api import ${state.primarySummarySymbolName}\n\n\ndef main(argv: list[str] | None = None) -> int:\n    summary = ${state.primarySummarySymbolName}(graph=RepoGraph(root_path='.', repo_id='repo', nodes={}, edges=()))\n    return 0\n`;
}

function buildUiApiSource(state: MockWorkspaceState): string {
  const extraBlocks = state.uiApiExtraSymbols
    .map((symbol) =>
      symbol.kind === "class"
        ? `class ${symbol.name}:\n    pass\n`
        : `def ${symbol.name}() -> None:\n    pass\n`,
    )
    .join("\n");
  return `${state.uiApiImports.join("\n")}\n\n\n@dataclass(frozen=True)\nclass GraphSummary:\n    repo_path: str\n    module_count: int\n\n\ndef ${state.primarySummarySymbolName}(graph: RepoGraph, top_n: int = 10) -> GraphSummary:\n    module_summaries = []\n    ranked_modules = sorted(module_summaries)[:top_n]\n    return GraphSummary(repo_path=graph.root_path, module_count=len(ranked_modules))\n\n\ndef build_export_payload(graph: RepoGraph) -> dict[str, object]:\n    return {\"graph\": graph}\n\n${extraBlocks}`.trimEnd();
}

function defaultSymbolSource(
  state: MockWorkspaceState,
  symbol: SymbolDetails,
): string {
  if (symbol.nodeId === symbolId("helm.ui.api", state.primarySummarySymbolName)) {
    return `def ${state.primarySummarySymbolName}(graph: RepoGraph, top_n: int = 10) -> GraphSummary:\n    module_summaries = []\n    ranked_modules = sorted(module_summaries)[:top_n]\n    return GraphSummary(repo_path=graph.root_path, module_count=len(ranked_modules))`;
  }
  if (symbol.nodeId === symbolId("helm.ui.api", "build_export_payload")) {
    return "def build_export_payload(graph: RepoGraph) -> dict[str, object]:\n    return {\"graph\": graph}";
  }
  if (symbol.nodeId === symbolId("helm.cli", "main")) {
    return `def main(argv: list[str] | None = None) -> int:\n    summary = ${state.primarySummarySymbolName}(graph=RepoGraph(root_path='.', repo_id='repo', nodes={}, edges=()))\n    return 0`;
  }
  if (symbol.kind === "class" || symbol.kind === "enum") {
    return `class ${symbol.name}:\n    pass`;
  }
  if (symbol.kind === "variable") {
    return `${symbol.name} = True`;
  }
  return `def ${symbol.name}() -> None:\n    pass`;
}

function symbolId(moduleName: string, qualname: string): string {
  return `symbol:${moduleName}:${qualname}`;
}

function node(
  id: string,
  kind: GraphView["nodes"][number]["kind"],
  label: string,
  subtitle: string,
  x: number,
  y: number,
  metadata: Record<string, unknown> = {},
  availableActions: GraphActionDto[] = [],
) {
  const enrichedMetadata = { ...metadata };
  if (kind === "module" && !("relative_path" in enrichedMetadata)) {
    enrichedMetadata.relative_path = subtitle;
  }
  if (isGraphSymbolNodeKind(kind)) {
    if (!("qualname" in enrichedMetadata)) {
      enrichedMetadata.qualname = subtitle;
    }
    if (!("module_name" in enrichedMetadata) && subtitle.includes(".")) {
      enrichedMetadata.module_name = subtitle.split(".").slice(0, -1).join(".");
    }
  }
  return {
    id,
    kind,
    label,
    subtitle,
    x,
    y,
    metadata: enrichedMetadata,
    availableActions,
  };
}

function edge(
  id: string,
  kind: GraphView["edges"][number]["kind"],
  source: string,
  target: string,
  label?: string,
) {
  return {
    id,
    kind,
    source,
    target,
    label,
    metadata: {},
  };
}

function moduleActions() {
  return [
    { actionId: "create_function", label: "Create function", enabled: true, reason: null, payload: {} },
    { actionId: "create_class", label: "Create class", enabled: true, reason: null, payload: {} },
    { actionId: "add_import", label: "Add import", enabled: true, reason: null, payload: {} },
    { actionId: "remove_import", label: "Remove import", enabled: true, reason: null, payload: {} },
    { actionId: "reveal_source", label: "Reveal source", enabled: true, reason: null, payload: {} },
  ];
}

function symbolActions(editable: boolean, flowEnabled = true) {
  return [
    {
      actionId: "rename_symbol",
      label: "Rename symbol",
      enabled: editable,
      reason: editable ? null : "Only dependency-free top-level symbols are editable in v1.",
      payload: {},
    },
    {
      actionId: "delete_symbol",
      label: "Delete symbol",
      enabled: editable,
      reason: editable ? null : "Only dependency-free top-level symbols are editable in v1.",
      payload: {},
    },
    {
      actionId: "move_symbol",
      label: "Move symbol",
      enabled: editable,
      reason: editable ? null : "Only dependency-free top-level symbols are editable in v1.",
      payload: {},
    },
    {
      actionId: "open_flow",
      label: "Open flow",
      enabled: flowEnabled,
      reason: flowEnabled ? null : "Flow only exists for functions and methods.",
      payload: {},
    },
    {
      actionId: "reveal_source",
      label: "Reveal source",
      enabled: true,
      reason: null,
      payload: {},
    },
  ];
}

function graphNodeKindForSymbolKind(kind: SymbolDetails["kind"]): GraphSymbolNodeKind {
  if (kind === "class") {
    return "class";
  }
  if (kind === "enum") {
    return "enum";
  }
  if (kind === "variable") {
    return "variable";
  }
  return "function";
}
