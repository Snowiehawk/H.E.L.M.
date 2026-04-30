import type {
  GraphAbstractionLevel,
  GraphView,
  OverviewData,
  RepoSession,
  SearchResult,
  SymbolDetails,
} from "../../adapter/contracts";
import { projectFlowDraftGraph } from "../../../components/graph/flowDraftGraph";
import { _buildMockVisualFlowView, getMockFlowDocument } from "./flowFixtures";
import {
  controlEdgeId,
  edge,
  flowEnabledForSymbol,
  graphNodeKindForSymbolKind,
  graphSummaryModuleCountSymbolId,
  graphSummaryRepoPathSymbolId,
  graphSummarySymbolId,
  graphSummaryToPayloadSymbolId,
  mockSymbolEditable,
  moduleActions,
  moduleId,
  node,
  sourceSpanMetadataForTargetId,
  symbolActions,
  symbolId,
} from "./ids";
import {
  mockModulePosition,
  mockModuleSymbolCount,
  moduleExtraSymbolsForModule,
  topLevelOutlineEntry,
} from "./moduleFixtures";
import { mockBackendStatus, type MockTopLevelSymbolSeed, type MockWorkspaceState } from "./state";

export function buildOverview(session: RepoSession, state: MockWorkspaceState): OverviewData {
  const searchResults = buildSearchResults(state);
  const cliExtraSymbols = moduleExtraSymbolsForModule(state, "helm.cli");
  const uiModuleExtraSymbols = moduleExtraSymbolsForModule(state, "helm.ui.api");
  const modelExtraSymbols = moduleExtraSymbolsForModule(state, "helm.graph.models");
  const extraOverviewModules = state.extraModules.map((module, index) => {
    const extraSymbols = moduleExtraSymbolsForModule(state, module.moduleName);
    return {
      id: `module-row:extra:${module.moduleName}:${index}`,
      moduleId: moduleId(module.moduleName),
      moduleName: module.moduleName,
      relativePath: module.relativePath,
      symbolCount: extraSymbols.length,
      importCount: 0,
      callCount: 0,
      outline: extraSymbols.map((symbol, symbolIndex) =>
        topLevelOutlineEntry(module.moduleName, symbol, symbolIndex),
      ),
    };
  });
  return {
    repo: session,
    metrics: [
      { label: "Modules", value: String(3 + state.extraModules.length) },
      {
        label: "Symbols",
        value: String(8 + state.uiApiExtraSymbols.length + state.moduleExtraSymbols.length),
      },
      { label: "Calls", value: "3", tone: "accent" },
      { label: "Diagnostics", value: "0" },
    ],
    modules: [
      {
        id: "module-row:cli",
        moduleId: moduleId("helm.cli"),
        moduleName: "helm.cli",
        relativePath: "src/helm/cli.py",
        symbolCount: 1 + cliExtraSymbols.length,
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
          ...cliExtraSymbols.map((symbol, index) =>
            topLevelOutlineEntry("helm.cli", symbol, index),
          ),
        ],
      },
      {
        id: "module-row:ui",
        moduleId: moduleId("helm.ui.api"),
        moduleName: "helm.ui.api",
        relativePath: "src/helm/ui/api.py",
        symbolCount: 6 + state.uiApiExtraSymbols.length + uiModuleExtraSymbols.length,
        importCount: 1,
        callCount: 1,
        outline: [
          {
            id: "outline:symbol:helm.ui.api:GraphSummary",
            nodeId: graphSummarySymbolId(),
            label: "GraphSummary",
            kind: "class",
            startLine: 6,
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
          ...state.uiApiExtraSymbols.map((symbol, index) =>
            topLevelOutlineEntry("helm.ui.api", symbol, index),
          ),
          ...uiModuleExtraSymbols.map((symbol, index) =>
            topLevelOutlineEntry("helm.ui.api", symbol, state.uiApiExtraSymbols.length + index),
          ),
        ],
      },
      {
        id: "module-row:models",
        moduleId: moduleId("helm.graph.models"),
        moduleName: "helm.graph.models",
        relativePath: "src/helm/graph/models.py",
        symbolCount: 1 + modelExtraSymbols.length,
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
          ...modelExtraSymbols.map((symbol, index) =>
            topLevelOutlineEntry("helm.graph.models", symbol, index),
          ),
        ],
      },
      ...extraOverviewModules,
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
      id: moduleId("helm.cli"),
      kind: "module",
      title: "helm.cli",
      subtitle: "src/helm/cli.py",
      score: 0.95,
      filePath: "src/helm/cli.py",
      nodeId: moduleId("helm.cli"),
      level: "module",
    },
    {
      id: moduleId("helm.ui.api"),
      kind: "module",
      title: "helm.ui.api",
      subtitle: "src/helm/ui/api.py",
      score: 0.99,
      filePath: "src/helm/ui/api.py",
      nodeId: moduleId("helm.ui.api"),
      level: "module",
    },
    {
      id: moduleId("helm.graph.models"),
      kind: "module",
      title: "helm.graph.models",
      subtitle: "src/helm/graph/models.py",
      score: 0.92,
      filePath: "src/helm/graph/models.py",
      nodeId: moduleId("helm.graph.models"),
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

  state.moduleExtraSymbols.forEach((symbol, index) => {
    results.push({
      id: symbolId(symbol.moduleName, symbol.name),
      kind: "symbol",
      title: symbol.name,
      subtitle: `${symbol.moduleName}.${symbol.name}`,
      score: 0.68 - index * 0.02,
      filePath: symbol.relativePath,
      symbolId: symbolId(symbol.moduleName, symbol.name),
      nodeId: symbolId(symbol.moduleName, symbol.name),
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
    nodeId: moduleId("helm.ui.api"),
    level: "module",
  });

  state.extraModules.forEach((module, index) => {
    const moduleNodeId = moduleId(module.moduleName);
    results.push({
      id: moduleNodeId,
      kind: "module",
      title: module.moduleName,
      subtitle: module.relativePath,
      score: 0.62 - index * 0.01,
      filePath: module.relativePath,
      nodeId: moduleNodeId,
      level: "module",
    });
    results.push({
      id: `file:${module.relativePath}`,
      kind: "file",
      title: module.relativePath,
      subtitle: "Created in graph create mode",
      score: 0.26 - index * 0.01,
      filePath: module.relativePath,
      nodeId: moduleNodeId,
      level: "module",
    });
  });

  return results;
}

export function buildSymbols(state: MockWorkspaceState): Record<string, SymbolDetails> {
  const primarySymbolId = symbolId("helm.ui.api", state.primarySummarySymbolName);
  const summaryClassId = graphSummarySymbolId();
  const summaryRepoPathId = graphSummaryRepoPathSymbolId();
  const summaryModuleCountId = graphSummaryModuleCountSymbolId();
  const summaryToPayloadId = graphSummaryToPayloadSymbolId();
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
      startLine: 18,
      endLine: 21,
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
    [summaryClassId]: {
      symbolId: summaryClassId,
      nodeId: summaryClassId,
      kind: "class",
      name: "GraphSummary",
      qualname: "helm.ui.api.GraphSummary",
      moduleName: "helm.ui.api",
      filePath: "src/helm/ui/api.py",
      signature: "GraphSummary(repo_path, module_count)",
      docSummary:
        "Simple top-level summary container used to project the repo graph into explorer-friendly overview data.",
      startLine: 6,
      endLine: 15,
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
    [summaryRepoPathId]: {
      symbolId: summaryRepoPathId,
      nodeId: summaryRepoPathId,
      kind: "variable",
      name: "repo_path",
      qualname: "helm.ui.api.GraphSummary.repo_path",
      moduleName: "helm.ui.api",
      filePath: "src/helm/ui/api.py",
      signature: "repo_path: str",
      docSummary: "Stored repo path field on the summary dataclass.",
      startLine: 8,
      endLine: 8,
      callers: [],
      callees: [],
      references: [
        {
          id: summaryClassId,
          label: "GraphSummary",
          subtitle: "helm.ui.api.GraphSummary",
          nodeId: summaryClassId,
          symbolId: summaryClassId,
        },
      ],
      metadata: {
        Surface: "summary",
        Role: "field",
      },
    },
    [summaryModuleCountId]: {
      symbolId: summaryModuleCountId,
      nodeId: summaryModuleCountId,
      kind: "variable",
      name: "module_count",
      qualname: "helm.ui.api.GraphSummary.module_count",
      moduleName: "helm.ui.api",
      filePath: "src/helm/ui/api.py",
      signature: "module_count: int",
      docSummary: "Stored module count field on the summary dataclass.",
      startLine: 9,
      endLine: 9,
      callers: [],
      callees: [],
      references: [
        {
          id: summaryClassId,
          label: "GraphSummary",
          subtitle: "helm.ui.api.GraphSummary",
          nodeId: summaryClassId,
          symbolId: summaryClassId,
        },
      ],
      metadata: {
        Surface: "summary",
        Role: "field",
      },
    },
    [summaryToPayloadId]: {
      symbolId: summaryToPayloadId,
      nodeId: summaryToPayloadId,
      kind: "function",
      name: "to_payload",
      qualname: "helm.ui.api.GraphSummary.to_payload",
      moduleName: "helm.ui.api",
      filePath: "src/helm/ui/api.py",
      signature: "to_payload(self) -> dict[str, object]",
      docSummary: "Converts the summary dataclass into a JSON-friendly shape for display.",
      startLine: 11,
      endLine: 15,
      callers: [],
      callees: [],
      references: [
        {
          id: summaryClassId,
          label: "GraphSummary",
          subtitle: "helm.ui.api.GraphSummary",
          nodeId: summaryClassId,
          symbolId: summaryClassId,
        },
      ],
      metadata: {
        Surface: "summary",
        Role: "member function",
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
      startLine: 24,
      endLine: 25,
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
      signature: symbol.kind === "class" ? `${symbol.name}()` : `${symbol.name}() -> None`,
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

  state.moduleExtraSymbols.forEach((symbol) => {
    const currentId = symbolId(symbol.moduleName, symbol.name);
    result[currentId] = {
      symbolId: currentId,
      nodeId: currentId,
      kind: symbol.kind,
      name: symbol.name,
      qualname: `${symbol.moduleName}.${symbol.name}`,
      moduleName: symbol.moduleName,
      filePath: symbol.relativePath,
      signature: symbol.kind === "class" ? `${symbol.name}()` : `${symbol.name}() -> None`,
      docSummary: "Newly moved semantic node in the blueprint editor.",
      startLine: 4,
      endLine: 6,
      callers: [],
      callees: [],
      references: [
        {
          id: moduleId(symbol.moduleName),
          label: symbol.moduleName,
          subtitle: symbol.relativePath,
          nodeId: moduleId(symbol.moduleName),
        },
      ],
      metadata: {
        Surface: "graph action",
        Role: "moved symbol",
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
  const symbols = buildSymbols(state);
  const extraRepoModuleNodes = state.extraModules.map((module, index) => {
    const position = mockModulePosition(index);
    return node(
      moduleId(module.moduleName),
      "module",
      module.moduleName,
      module.relativePath,
      position.x,
      position.y,
      {
        symbolCount: mockModuleSymbolCount(state, module.moduleName),
        importCount: 0,
        callCount: 0,
      },
      moduleActions(),
    );
  });
  if (level === "flow") {
    const symbol = symbols[targetId] ?? symbols[primarySymbolId];
    return symbol.kind === "class"
      ? buildMockClassFlowView(session, symbol, symbols)
      : buildMockFunctionFlowView(session, state, symbol);
  }

  if (level === "symbol" || targetId.startsWith("symbol:")) {
    const symbolIdValue = targetId.startsWith("symbol:") ? targetId : primarySymbolId;
    return buildMockSymbolView(session, state, symbols, symbolIdValue);
  }

  if (level === "module" && targetId === moduleId("helm.ui.api")) {
    const uiExtraSymbols: MockTopLevelSymbolSeed[] = [
      ...state.uiApiExtraSymbols,
      ...moduleExtraSymbolsForModule(state, "helm.ui.api"),
    ];
    const extraNodes = uiExtraSymbols.map((symbol, index) =>
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
      rootNodeId: moduleId("helm.ui.api"),
      targetId: moduleId("helm.ui.api"),
      level: "module",
      truncated: false,
      breadcrumbs: [
        { nodeId: session.id, level: "repo", label: session.name, subtitle: "Architecture map" },
        {
          nodeId: moduleId("helm.ui.api"),
          level: "module",
          label: "helm.ui.api",
          subtitle: "src/helm/ui/api.py",
        },
      ],
      focus: {
        targetId: moduleId("helm.ui.api"),
        level: "module",
        label: "helm.ui.api",
        subtitle: "Architecture slice",
        availableLevels: ["repo", "module"],
      },
      nodes: [
        node(
          moduleId("helm.ui.api"),
          "module",
          "helm.ui.api",
          "src/helm/ui/api.py",
          0,
          220,
          {
            symbolCount: mockModuleSymbolCount(state, "helm.ui.api"),
            importCount: state.uiApiImports.length,
            callCount: 1,
          },
          moduleActions(),
        ),
        node(
          moduleId("helm.cli"),
          "module",
          "helm.cli",
          "src/helm/cli.py",
          310,
          60,
          {
            symbolCount: mockModuleSymbolCount(state, "helm.cli"),
            importCount: 1,
            callCount: 1,
          },
          moduleActions(),
        ),
        node(
          moduleId("helm.graph.models"),
          "module",
          "helm.graph.models",
          "src/helm/graph/models.py",
          310,
          360,
          {
            symbolCount: mockModuleSymbolCount(state, "helm.graph.models"),
            importCount: 0,
            callCount: 0,
          },
          moduleActions(),
        ),
        node(moduleId("rich.console"), "module", "rich.console", "External dependency", 310, 500, {
          isExternal: true,
        }),
        node(
          graphSummarySymbolId(),
          "class",
          "GraphSummary",
          "helm.ui.api.GraphSummary",
          700,
          40,
          {
            symbolKind: "class",
          },
          symbolActions(false, true),
        ),
        node(
          primarySymbolId,
          "function",
          state.primarySummarySymbolName,
          `helm.ui.api.${state.primarySummarySymbolName}`,
          700,
          140,
          {
            symbolKind: "function",
          },
          symbolActions(true),
        ),
        node(
          symbolId("helm.ui.api", "build_export_payload"),
          "function",
          "build_export_payload",
          "helm.ui.api.build_export_payload",
          700,
          300,
          {
            symbolKind: "function",
          },
          symbolActions(true),
        ),
        ...extraNodes,
      ],
      edges: [
        edge(
          "imports:cli-ui",
          "imports",
          moduleId("helm.cli"),
          moduleId("helm.ui.api"),
          "1 import",
        ),
        edge(
          "imports:ui-models",
          "imports",
          moduleId("helm.ui.api"),
          moduleId("helm.graph.models"),
          "1 import",
        ),
        edge(
          "imports:ui-rich",
          "imports",
          moduleId("helm.ui.api"),
          moduleId("rich.console"),
          "1 import",
        ),
        edge(
          "defines:ui-summary-class",
          "defines",
          moduleId("helm.ui.api"),
          graphSummarySymbolId(),
        ),
        edge("defines:ui-primary", "defines", moduleId("helm.ui.api"), primarySymbolId),
        edge(
          "defines:ui-export",
          "defines",
          moduleId("helm.ui.api"),
          symbolId("helm.ui.api", "build_export_payload"),
        ),
        ...extraNodes.map((symbolNode, index) =>
          edge(`defines:ui-extra:${index}`, "defines", moduleId("helm.ui.api"), symbolNode.id),
        ),
      ],
    };
  }

  const extraModule = state.extraModules.find((module) => moduleId(module.moduleName) === targetId);
  if (level === "module" && extraModule) {
    const extraModuleSymbols = moduleExtraSymbolsForModule(state, extraModule.moduleName);
    const symbolNodes = extraModuleSymbols.map((symbol, index) =>
      node(
        symbolId(extraModule.moduleName, symbol.name),
        graphNodeKindForSymbolKind(symbol.kind),
        symbol.name,
        `${extraModule.moduleName}.${symbol.name}`,
        700,
        80 + index * 110,
        { symbolKind: symbol.kind },
        symbolActions(true),
      ),
    );
    return {
      rootNodeId: moduleId(extraModule.moduleName),
      targetId: moduleId(extraModule.moduleName),
      level: "module",
      truncated: false,
      breadcrumbs: [
        { nodeId: session.id, level: "repo", label: session.name, subtitle: "Architecture map" },
        {
          nodeId: moduleId(extraModule.moduleName),
          level: "module",
          label: extraModule.moduleName,
          subtitle: extraModule.relativePath,
        },
      ],
      focus: {
        targetId: moduleId(extraModule.moduleName),
        level: "module",
        label: extraModule.moduleName,
        subtitle: "Architecture slice",
        availableLevels: ["repo", "module"],
      },
      nodes: [
        node(
          moduleId(extraModule.moduleName),
          "module",
          extraModule.moduleName,
          extraModule.relativePath,
          0,
          200,
          {
            symbolCount: mockModuleSymbolCount(state, extraModule.moduleName),
            importCount: 0,
            callCount: 0,
          },
          moduleActions(),
        ),
        ...symbolNodes,
      ],
      edges: symbolNodes.map((symbolNode, index) =>
        edge(
          `defines:${extraModule.moduleName}:extra:${index}`,
          "defines",
          moduleId(extraModule.moduleName),
          symbolNode.id,
        ),
      ),
    };
  }

  if (level === "repo") {
    return {
      rootNodeId: session.id,
      targetId: session.id,
      level: "repo",
      truncated: false,
      breadcrumbs: [
        { nodeId: session.id, level: "repo", label: session.name, subtitle: "Architecture map" },
      ],
      focus: {
        targetId: session.id,
        level: "repo",
        label: session.name,
        subtitle: "Architecture map",
        availableLevels: ["repo", "module"],
      },
      nodes: [
        node(session.id, "repo", session.name, "Architecture map", 0, 180),
        node(
          moduleId("helm.cli"),
          "module",
          "helm.cli",
          "src/helm/cli.py",
          320,
          40,
          {
            symbolCount: mockModuleSymbolCount(state, "helm.cli"),
            importCount: 1,
            callCount: 1,
          },
          moduleActions(),
        ),
        node(
          moduleId("helm.ui.api"),
          "module",
          "helm.ui.api",
          "src/helm/ui/api.py",
          320,
          210,
          {
            symbolCount: mockModuleSymbolCount(state, "helm.ui.api"),
            importCount: state.uiApiImports.length,
            callCount: 1,
          },
          moduleActions(),
        ),
        node(
          moduleId("helm.graph.models"),
          "module",
          "helm.graph.models",
          "src/helm/graph/models.py",
          320,
          380,
          {
            symbolCount: mockModuleSymbolCount(state, "helm.graph.models"),
            importCount: 0,
            callCount: 0,
          },
          moduleActions(),
        ),
        node(moduleId("rich.console"), "module", "rich.console", "External dependency", 320, 550, {
          isExternal: true,
        }),
        ...extraRepoModuleNodes,
      ],
      edges: [
        edge(
          "imports:cli-ui",
          "imports",
          moduleId("helm.cli"),
          moduleId("helm.ui.api"),
          "1 import",
        ),
        edge(
          "imports:ui-models",
          "imports",
          moduleId("helm.ui.api"),
          moduleId("helm.graph.models"),
          "1 import",
        ),
        edge(
          "imports:ui-rich",
          "imports",
          moduleId("helm.ui.api"),
          moduleId("rich.console"),
          "1 import",
        ),
        edge("calls:cli-ui", "calls", moduleId("helm.cli"), moduleId("helm.ui.api"), "1 call"),
      ],
    };
  }

  return {
    rootNodeId: session.id,
    targetId: session.id,
    level: "module",
    truncated: false,
    breadcrumbs: [
      { nodeId: session.id, level: "repo", label: session.name, subtitle: "Architecture map" },
    ],
    focus: {
      targetId: session.id,
      level: "module",
      label: session.name,
      subtitle: "Architecture map",
      availableLevels: ["repo", "module"],
    },
    nodes: [
      node(session.id, "repo", session.name, "Architecture map", 0, 180),
      node(
        moduleId("helm.cli"),
        "module",
        "helm.cli",
        "src/helm/cli.py",
        320,
        40,
        {
          symbolCount: mockModuleSymbolCount(state, "helm.cli"),
          importCount: 1,
          callCount: 1,
        },
        moduleActions(),
      ),
      node(
        moduleId("helm.ui.api"),
        "module",
        "helm.ui.api",
        "src/helm/ui/api.py",
        320,
        210,
        {
          symbolCount: mockModuleSymbolCount(state, "helm.ui.api"),
          importCount: state.uiApiImports.length,
          callCount: 1,
        },
        moduleActions(),
      ),
      node(
        moduleId("helm.graph.models"),
        "module",
        "helm.graph.models",
        "src/helm/graph/models.py",
        320,
        380,
        {
          symbolCount: mockModuleSymbolCount(state, "helm.graph.models"),
          importCount: 0,
          callCount: 0,
        },
        moduleActions(),
      ),
      node(moduleId("rich.console"), "module", "rich.console", "External dependency", 320, 550, {
        isExternal: true,
      }),
      ...extraRepoModuleNodes,
    ],
    edges: [
      edge("imports:cli-ui", "imports", moduleId("helm.cli"), moduleId("helm.ui.api"), "1 import"),
      edge(
        "imports:ui-models",
        "imports",
        moduleId("helm.ui.api"),
        moduleId("helm.graph.models"),
        "1 import",
      ),
      edge(
        "imports:ui-rich",
        "imports",
        moduleId("helm.ui.api"),
        moduleId("rich.console"),
        "1 import",
      ),
      edge("calls:cli-ui", "calls", moduleId("helm.cli"), moduleId("helm.ui.api"), "1 call"),
    ],
  };
}

function buildMockSymbolView(
  session: RepoSession,
  state: MockWorkspaceState,
  symbols: Record<string, SymbolDetails>,
  symbolIdValue: string,
): GraphView {
  const symbol = symbols[symbolIdValue];
  const symbolParts = symbolIdValue.split(":");
  const fallbackSymbolLabel = symbolParts[symbolParts.length - 1] ?? "Symbol";
  const symbolLabel = symbol?.name ?? fallbackSymbolLabel;
  const moduleIdValue = symbol ? moduleId(symbol.moduleName) : moduleId("helm.ui.api");
  const moduleLabel = symbol?.moduleName ?? "helm.ui.api";
  const modulePath = symbol?.filePath ?? "src/helm/ui/api.py";
  const flowEnabled = symbol ? flowEnabledForSymbol(symbol) : true;
  const symbolNodeKind = graphNodeKindForSymbolKind(symbol?.kind ?? "function");
  const nodes: GraphView["nodes"] = [
    node(
      moduleIdValue,
      "module",
      moduleLabel,
      modulePath,
      0,
      160,
      {
        symbolCount: mockModuleSymbolCount(state, symbol?.moduleName ?? "helm.ui.api"),
        importCount: symbol?.moduleName === "helm.ui.api" ? state.uiApiImports.length : 0,
        callCount: symbol?.moduleName === "helm.ui.api" ? 1 : 0,
      },
      moduleActions(),
    ),
    node(
      symbolIdValue,
      symbolNodeKind,
      symbolLabel,
      symbol?.qualname ?? symbolLabel,
      310,
      160,
      {
        symbolKind: symbol?.kind ?? "function",
      },
      symbolActions(mockSymbolEditable(symbol), flowEnabled),
    ),
  ];
  const edges: GraphView["edges"] = [
    edge(`defines:${moduleIdValue}:${symbolIdValue}`, "defines", moduleIdValue, symbolIdValue),
  ];

  if (symbol?.nodeId === graphSummarySymbolId()) {
    const members = [
      { memberId: graphSummaryRepoPathSymbolId(), x: 620, y: 40 },
      { memberId: graphSummaryModuleCountSymbolId(), x: 620, y: 180 },
      { memberId: graphSummaryToPayloadSymbolId(), x: 620, y: 320 },
    ];
    members.forEach(({ memberId, x, y }) => {
      const member = symbols[memberId];
      nodes.push(
        node(
          memberId,
          graphNodeKindForSymbolKind(member.kind),
          member.name,
          member.qualname,
          x,
          y,
          {
            symbolKind: member.kind,
          },
          symbolActions(mockSymbolEditable(member), flowEnabledForSymbol(member)),
        ),
      );
      edges.push(
        edge(`contains:${symbolIdValue}:${memberId}`, "contains", symbolIdValue, memberId),
      );
    });
  }

  if (symbol?.nodeId === graphSummaryToPayloadSymbolId()) {
    nodes.push(
      node(
        graphSummarySymbolId(),
        "class",
        "GraphSummary",
        "helm.ui.api.GraphSummary",
        620,
        160,
        {
          symbolKind: "class",
        },
        symbolActions(false, true),
      ),
    );
    edges.push(
      edge(
        `contains:${graphSummarySymbolId()}:${symbolIdValue}`,
        "contains",
        graphSummarySymbolId(),
        symbolIdValue,
      ),
    );
  }

  return {
    rootNodeId: symbolIdValue,
    targetId: symbolIdValue,
    level: "symbol",
    truncated: false,
    breadcrumbs: [
      { nodeId: session.id, level: "repo", label: session.name, subtitle: "Architecture map" },
      { nodeId: moduleIdValue, level: "module", label: moduleLabel, subtitle: modulePath },
      {
        nodeId: symbolIdValue,
        level: "symbol",
        label: symbolLabel,
        subtitle: symbol?.qualname ?? symbolIdValue.replace("symbol:", "").replace(/:/g, "."),
      },
    ],
    focus: {
      targetId: symbolIdValue,
      level: "symbol",
      label: symbolLabel,
      subtitle: "Semantic node",
      availableLevels: flowEnabled
        ? ["repo", "module", "symbol", "flow"]
        : ["repo", "module", "symbol"],
    },
    nodes,
    edges,
  };
}

function buildMockFunctionFlowView(
  session: RepoSession,
  state: MockWorkspaceState,
  symbol: SymbolDetails,
): GraphView {
  const entryId = `flow:${symbol.nodeId}:entry`;
  const breadcrumbs = [
    {
      nodeId: session.id,
      level: "repo" as const,
      label: session.name,
      subtitle: "Architecture map",
    },
    {
      nodeId: `module:${symbol.moduleName}`,
      level: "module" as const,
      label: symbol.moduleName,
      subtitle: symbol.filePath,
    },
    {
      nodeId: symbol.nodeId,
      level: "symbol" as const,
      label: symbol.name,
      subtitle: symbol.qualname,
    },
    {
      nodeId: `flow:${symbol.nodeId}`,
      level: "flow" as const,
      label: "Flow",
      subtitle: symbol.qualname,
    },
  ];
  const document = getMockFlowDocument(state, symbol);
  const withProjectedDraft = (view: GraphView): GraphView => projectFlowDraftGraph(view, document);

  if (symbol.nodeId === symbolId("helm.ui.api", state.primarySummarySymbolName)) {
    return withProjectedDraft({
      rootNodeId: entryId,
      targetId: symbol.nodeId,
      level: "flow",
      truncated: false,
      breadcrumbs,
      focus: {
        targetId: symbol.nodeId,
        level: "flow",
        label: symbol.name,
        subtitle: "On-demand flow graph",
        availableLevels: ["repo", "module", "symbol", "flow"],
      },
      nodes: [
        node(entryId, "entry", "Entry", symbol.qualname, 0, 180),
        node(
          `flow:${symbol.nodeId}:param:graph`,
          "param",
          "graph",
          "parameter",
          220,
          80,
          sourceSpanMetadataForTargetId(`flow:${symbol.nodeId}:param:graph`, state),
        ),
        node(
          `flow:${symbol.nodeId}:param:top_n`,
          "param",
          "top_n",
          "parameter",
          220,
          280,
          sourceSpanMetadataForTargetId(`flow:${symbol.nodeId}:param:top_n`, state),
        ),
        node(
          `flow:${symbol.nodeId}:assign:modules`,
          "assign",
          "module_summaries",
          "collect module stats",
          470,
          80,
          sourceSpanMetadataForTargetId(`flow:${symbol.nodeId}:assign:modules`, state),
        ),
        node(
          `flow:${symbol.nodeId}:call:rank`,
          "call",
          "sorted(...)",
          "rank modules",
          720,
          80,
          sourceSpanMetadataForTargetId(`flow:${symbol.nodeId}:call:rank`, state),
        ),
        node(
          `flow:${symbol.nodeId}:return`,
          "return",
          "return GraphSummary(...)",
          "emit blueprint summary",
          970,
          180,
          sourceSpanMetadataForTargetId(`flow:${symbol.nodeId}:return`, state),
        ),
      ],
      edges: [
        edge(
          controlEdgeId(entryId, `flow:${symbol.nodeId}:assign:modules`),
          "controls",
          entryId,
          `flow:${symbol.nodeId}:assign:modules`,
        ),
        edge(
          controlEdgeId(`flow:${symbol.nodeId}:assign:modules`, `flow:${symbol.nodeId}:call:rank`),
          "controls",
          `flow:${symbol.nodeId}:assign:modules`,
          `flow:${symbol.nodeId}:call:rank`,
        ),
        edge(
          controlEdgeId(`flow:${symbol.nodeId}:call:rank`, `flow:${symbol.nodeId}:return`),
          "controls",
          `flow:${symbol.nodeId}:call:rank`,
          `flow:${symbol.nodeId}:return`,
        ),
        edge(
          `data:${symbol.nodeId}:graph:assign`,
          "data",
          `flow:${symbol.nodeId}:param:graph`,
          `flow:${symbol.nodeId}:assign:modules`,
          "graph",
        ),
        edge(
          `data:${symbol.nodeId}:top:rank`,
          "data",
          `flow:${symbol.nodeId}:param:top_n`,
          `flow:${symbol.nodeId}:call:rank`,
          "top_n",
        ),
        edge(
          `data:${symbol.nodeId}:assign:rank`,
          "data",
          `flow:${symbol.nodeId}:assign:modules`,
          `flow:${symbol.nodeId}:call:rank`,
          "module_summaries",
        ),
        edge(
          `data:${symbol.nodeId}:rank:return`,
          "data",
          `flow:${symbol.nodeId}:call:rank`,
          `flow:${symbol.nodeId}:return`,
          "ranked_modules",
        ),
      ],
    });
  }

  if (symbol.nodeId === graphSummaryToPayloadSymbolId()) {
    return withProjectedDraft({
      rootNodeId: entryId,
      targetId: symbol.nodeId,
      level: "flow",
      truncated: false,
      breadcrumbs,
      focus: {
        targetId: symbol.nodeId,
        level: "flow",
        label: symbol.name,
        subtitle: "On-demand flow graph",
        availableLevels: ["repo", "module", "symbol", "flow"],
      },
      nodes: [
        node(entryId, "entry", "Entry", symbol.qualname, 0, 180),
        node(
          `flow:${symbol.nodeId}:param:self`,
          "param",
          "self",
          "parameter",
          220,
          180,
          sourceSpanMetadataForTargetId(`flow:${symbol.nodeId}:param:self`),
        ),
        node(
          `flow:${symbol.nodeId}:return`,
          "return",
          "return {...}",
          "emit payload map",
          500,
          180,
          sourceSpanMetadataForTargetId(`flow:${symbol.nodeId}:return`),
        ),
      ],
      edges: [
        edge(
          controlEdgeId(entryId, `flow:${symbol.nodeId}:return`),
          "controls",
          entryId,
          `flow:${symbol.nodeId}:return`,
        ),
        edge(
          `data:${symbol.nodeId}:self:return`,
          "data",
          `flow:${symbol.nodeId}:param:self`,
          `flow:${symbol.nodeId}:return`,
          "self",
        ),
      ],
    });
  }

  return withProjectedDraft({
    rootNodeId: entryId,
    targetId: symbol.nodeId,
    level: "flow",
    truncated: false,
    breadcrumbs,
    focus: {
      targetId: symbol.nodeId,
      level: "flow",
      label: symbol.name,
      subtitle: "On-demand flow graph",
      availableLevels: ["repo", "module", "symbol", "flow"],
    },
    nodes: [
      node(entryId, "entry", "Entry", symbol.qualname, 0, 180),
      node(`flow:${symbol.nodeId}:return`, "return", "return", "complete operation", 320, 180),
    ],
    edges: [
      edge(
        controlEdgeId(entryId, `flow:${symbol.nodeId}:return`),
        "controls",
        entryId,
        `flow:${symbol.nodeId}:return`,
      ),
    ],
  });
}

function buildMockClassFlowView(
  session: RepoSession,
  symbol: SymbolDetails,
  symbols: Record<string, SymbolDetails>,
): GraphView {
  const entryId = `flow:${symbol.nodeId}:entry`;
  const members =
    symbol.nodeId === graphSummarySymbolId()
      ? [
          { symbol: symbols[graphSummaryRepoPathSymbolId()], order: 1 },
          { symbol: symbols[graphSummaryModuleCountSymbolId()], order: 2 },
          { symbol: symbols[graphSummaryToPayloadSymbolId()], order: 3 },
        ]
      : [];

  return {
    rootNodeId: entryId,
    targetId: symbol.nodeId,
    level: "flow",
    truncated: false,
    breadcrumbs: [
      { nodeId: session.id, level: "repo", label: session.name, subtitle: "Architecture map" },
      {
        nodeId: `module:${symbol.moduleName}`,
        level: "module",
        label: symbol.moduleName,
        subtitle: symbol.filePath,
      },
      { nodeId: symbol.nodeId, level: "symbol", label: symbol.name, subtitle: symbol.qualname },
      { nodeId: `flow:${symbol.nodeId}`, level: "flow", label: "Flow", subtitle: symbol.qualname },
    ],
    focus: {
      targetId: symbol.nodeId,
      level: "flow",
      label: symbol.name,
      subtitle: "On-demand flow graph",
      availableLevels: ["repo", "module", "symbol", "flow"],
    },
    nodes: [
      node(entryId, "entry", "Entry", symbol.qualname, 0, 180, { flow_order: 0 }),
      ...members.map(({ symbol: member, order }) =>
        node(
          member.nodeId,
          graphNodeKindForSymbolKind(member.kind),
          member.name,
          member.qualname,
          order * 260,
          180,
          {
            symbolKind: member.kind,
            flow_order: order,
            ...sourceSpanMetadataForTargetId(member.nodeId),
          },
          symbolActions(mockSymbolEditable(member), flowEnabledForSymbol(member)),
        ),
      ),
    ],
    edges: members.map(({ symbol: member }) =>
      edge(`contains:${entryId}:${member.nodeId}`, "contains", entryId, member.nodeId),
    ),
  };
}
