import type {
  BackendStatus,
  EditableNodeSource,
  FileContents,
  FlowGraphDocument,
  FlowSyncState,
  FlowVisualNodeKind,
  GraphActionDto,
  GraphAbstractionLevel,
  GraphNodeKind,
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
import { projectFlowDraftGraph } from "../../components/graph/flowDraftGraph";
import { flowNodePayloadFromContent, insertFlowNodeOnEdge } from "../../components/graph/flowDocument";

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
  liveSyncEnabled: false,
  syncState: "idle",
  note: "Browser-only mode is using seeded data. Run the Tauri shell to exercise the real Python backbone from the UI.",
};

interface MockTopLevelSymbolSeed {
  name: string;
  kind: "function" | "class";
}

interface MockModuleSymbolSeed extends MockTopLevelSymbolSeed {
  moduleName: string;
  relativePath: string;
}

export interface MockWorkspaceState {
  primarySummarySymbolName: string;
  uiApiImports: string[];
  uiApiExtraSymbols: MockTopLevelSymbolSeed[];
  moduleExtraSymbols: MockModuleSymbolSeed[];
  extraModules: Array<{
    moduleName: string;
    relativePath: string;
    content: string;
  }>;
  flowInsertionsBySymbolId: Record<string, Array<{
    nodeId: string;
    kind: "assign" | "call" | "return" | "branch" | "loop";
    label: string;
    subtitle: string;
    anchorEdgeId: string;
    content: string;
  }>>;
  flowDocumentsBySymbolId: Record<string, FlowGraphDocument>;
  editedSources: Record<string, string>;
}

const pythonKeywords = new Set([
  "False",
  "None",
  "True",
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
]);

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
    moduleExtraSymbols: [],
    extraModules: [],
    flowInsertionsBySymbolId: {},
    flowDocumentsBySymbolId: {},
    editedSources: {},
  };
}

function graphSummarySymbolId() {
  return symbolId("helm.ui.api", "GraphSummary");
}

function graphSummaryRepoPathSymbolId() {
  return symbolId("helm.ui.api", "GraphSummary.repo_path");
}

function graphSummaryModuleCountSymbolId() {
  return symbolId("helm.ui.api", "GraphSummary.module_count");
}

function graphSummaryToPayloadSymbolId() {
  return symbolId("helm.ui.api", "GraphSummary.to_payload");
}

function moduleId(moduleName: string): string {
  return `module:${moduleName}`;
}

function cloneFlowDocument(document: FlowGraphDocument): FlowGraphDocument {
  return {
    ...document,
    diagnostics: [...document.diagnostics],
    nodes: document.nodes.map((node) => ({
      ...node,
      payload: { ...node.payload },
    })),
    edges: document.edges.map((edge) => ({ ...edge })),
    functionInputs: (document.functionInputs ?? []).map((input) => ({ ...input })),
    inputSlots: (document.inputSlots ?? []).map((slot) => ({ ...slot })),
    inputBindings: (document.inputBindings ?? []).map((binding) => ({ ...binding })),
  };
}

function mockFunctionInputId(symbolIdValue: string, name: string) {
  return `flowinput:${symbolIdValue}:${name}`;
}

function mockInputSlotId(nodeId: string, slotKey: string) {
  return `flowslot:${nodeId}:${slotKey}`;
}

function mockInputBindingId(slotId: string, functionInputId: string) {
  return `flowbinding:${slotId}->${functionInputId}`;
}

function mockInputModel(
  symbolIdValue: string,
  inputNames: string[],
  slots: Array<{ nodeId: string; slotKey: string; inputName?: string }>,
): Pick<FlowGraphDocument, "functionInputs" | "inputSlots" | "inputBindings"> {
  const functionInputs = inputNames.map((name, index) => ({
    id: mockFunctionInputId(symbolIdValue, name),
    name,
    index,
  }));
  const inputSlots = slots.map((slot) => ({
    id: mockInputSlotId(slot.nodeId, slot.slotKey),
    nodeId: slot.nodeId,
    slotKey: slot.slotKey,
    label: slot.slotKey,
    required: true,
  }));
  const inputBindings = slots.flatMap((slot) => {
    const functionInputId = mockFunctionInputId(symbolIdValue, slot.inputName ?? slot.slotKey);
    const slotId = mockInputSlotId(slot.nodeId, slot.slotKey);
    return functionInputs.some((input) => input.id === functionInputId)
      ? [{
          id: mockInputBindingId(slotId, functionInputId),
          functionInputId,
          slotId,
        }]
      : [];
  });
  return { functionInputs, inputSlots, inputBindings };
}

function flowDocumentEdge(
  sourceId: string,
  sourceHandle: string,
  targetId: string,
  targetHandle = "in",
) {
  return {
    id: `controls:${sourceId}:${sourceHandle}->${targetId}:${targetHandle}`,
    sourceId,
    sourceHandle,
    targetId,
    targetHandle,
  };
}

function defaultMockFlowDocument(
  state: MockWorkspaceState,
  symbol: SymbolDetails,
): FlowGraphDocument {
  const entryId = `flow:${symbol.nodeId}:entry`;
  if (symbol.nodeId === symbolId("helm.ui.api", state.primarySummarySymbolName)) {
    const assignId = `flow:${symbol.nodeId}:assign:modules`;
    const callId = `flow:${symbol.nodeId}:call:rank`;
    const returnId = `flow:${symbol.nodeId}:return`;
    return {
      symbolId: symbol.nodeId,
      relativePath: symbol.filePath,
      qualname: symbol.qualname,
      editable: true,
      syncState: "clean",
      diagnostics: [],
      sourceHash: null,
      nodes: [
        { id: entryId, kind: "entry", payload: {}, indexedNodeId: entryId },
        { id: assignId, kind: "assign", payload: { source: "module_summaries = collect_module_stats(graph)" }, indexedNodeId: assignId },
        { id: callId, kind: "call", payload: { source: "sorted(module_summaries, key=score_module)" }, indexedNodeId: callId },
        { id: returnId, kind: "return", payload: { expression: "GraphSummary(...)" }, indexedNodeId: returnId },
      ],
      edges: [
        flowDocumentEdge(entryId, "start", assignId),
        flowDocumentEdge(assignId, "next", callId),
        flowDocumentEdge(callId, "next", returnId),
      ],
      ...mockInputModel(symbol.nodeId, ["graph", "top_n"], [
        { nodeId: assignId, slotKey: "graph" },
        { nodeId: callId, slotKey: "top_n" },
      ]),
    };
  }

  if (symbol.nodeId === graphSummaryToPayloadSymbolId()) {
    const returnId = `flow:${symbol.nodeId}:return`;
    return {
      symbolId: symbol.nodeId,
      relativePath: symbol.filePath,
      qualname: symbol.qualname,
      editable: true,
      syncState: "clean",
      diagnostics: [],
      sourceHash: null,
      nodes: [
        { id: entryId, kind: "entry", payload: {}, indexedNodeId: entryId },
        { id: returnId, kind: "return", payload: { expression: "{'repo_path': self.repo_path}" }, indexedNodeId: returnId },
      ],
      edges: [
        flowDocumentEdge(entryId, "start", returnId),
      ],
      ...mockInputModel(symbol.nodeId, ["self"], [
        { nodeId: returnId, slotKey: "self" },
      ]),
    };
  }

  const returnId = `flow:${symbol.nodeId}:return`;
  return {
    symbolId: symbol.nodeId,
    relativePath: symbol.filePath,
    qualname: symbol.qualname,
    editable: true,
    syncState: "clean",
    diagnostics: [],
    sourceHash: null,
    nodes: [
      { id: entryId, kind: "entry", payload: {}, indexedNodeId: entryId },
      { id: returnId, kind: "return", payload: { expression: "" }, indexedNodeId: returnId },
    ],
    edges: [
      flowDocumentEdge(entryId, "start", returnId),
    ],
    ...mockInputModel(symbol.nodeId, [], []),
  };
}

function getMockFlowDocument(
  state: MockWorkspaceState,
  symbol: SymbolDetails,
): FlowGraphDocument {
  const existing = state.flowDocumentsBySymbolId[symbol.nodeId];
  if (existing) {
    return cloneFlowDocument(existing);
  }
  const created = defaultMockFlowDocument(state, symbol);
  state.flowDocumentsBySymbolId[symbol.nodeId] = cloneFlowDocument(created);
  return cloneFlowDocument(created);
}

function mockVisualFlowNodeLabel(kind: FlowVisualNodeKind, payload: Record<string, unknown>) {
  if (kind === "entry") {
    return "Entry";
  }
  if (kind === "exit") {
    return "Exit";
  }
  if (kind === "assign" || kind === "call") {
    const source = typeof payload.source === "string" ? payload.source.trim() : "";
    return source || kind;
  }
  if (kind === "branch") {
    const condition = typeof payload.condition === "string" ? payload.condition.trim() : "";
    return condition ? `if ${condition}` : "if ...";
  }
  if (kind === "loop") {
    const header = typeof payload.header === "string" ? payload.header.trim() : "";
    return header || "loop";
  }
  const expression = typeof payload.expression === "string" ? payload.expression.trim() : "";
  return expression ? `return ${expression}` : "return";
}

function mockVisualFlowNodeSubtitle(kind: FlowVisualNodeKind, payload: Record<string, unknown>, symbol: SymbolDetails) {
  if (kind === "entry") {
    return symbol.qualname;
  }
  if (kind === "exit") {
    return "terminal path";
  }
  if (kind === "assign") {
    return "assignment";
  }
  if (kind === "call") {
    return "call";
  }
  if (kind === "branch") {
    return "conditional branch";
  }
  if (kind === "loop") {
    return "loop";
  }
  return "return";
}

function mockVisualFlowNodePosition(nodeId: string, kind: FlowVisualNodeKind, index: number) {
  if (nodeId.endsWith(":entry")) {
    return { x: 0, y: 180 };
  }
  if (nodeId.includes(":assign:modules")) {
    return { x: 470, y: 80 };
  }
  if (nodeId.includes(":call:rank")) {
    return { x: 720, y: 80 };
  }
  if (nodeId.endsWith(":return")) {
    return { x: 970, y: 180 };
  }

  const column = Math.max(1, index);
  return {
    x: 260 + column * 220,
    y: kind === "branch" || kind === "loop" ? 120 : 180,
  };
}

function validateMockFlowDocument(document: FlowGraphDocument): { syncState: FlowSyncState; diagnostics: string[] } {
  const diagnostics: string[] = [];
  const incomingByTarget = new Map<string, number>();
  const outgoingBySource = new Map<string, string[]>();
  document.edges.forEach((edge) => {
    incomingByTarget.set(edge.targetId, (incomingByTarget.get(edge.targetId) ?? 0) + 1);
    outgoingBySource.set(edge.sourceId, [...(outgoingBySource.get(edge.sourceId) ?? []), edge.sourceHandle]);
  });

  document.nodes.forEach((node) => {
    if (node.kind !== "entry" && (incomingByTarget.get(node.id) ?? 0) === 0) {
      diagnostics.push(`${node.id} is disconnected.`);
    }
    if (node.kind === "assign" || node.kind === "call") {
      const source = typeof node.payload.source === "string" ? node.payload.source.trim() : "";
      if (!source) {
        diagnostics.push(`${node.id} needs source code.`);
      }
    }
    if (node.kind === "branch") {
      const condition = typeof node.payload.condition === "string" ? node.payload.condition.trim() : "";
      if (!condition) {
        diagnostics.push(`${node.id} needs a condition.`);
      }
      if (!(outgoingBySource.get(node.id) ?? []).includes("true")) {
        diagnostics.push(`${node.id} needs a true branch.`);
      }
    }
    if (node.kind === "loop") {
      const header = typeof node.payload.header === "string" ? node.payload.header.trim() : "";
      if (!header) {
        diagnostics.push(`${node.id} needs a loop header.`);
      }
      if (!(outgoingBySource.get(node.id) ?? []).includes("body")) {
        diagnostics.push(`${node.id} needs a body path.`);
      }
    }
  });
  const boundSlotIds = new Set((document.inputBindings ?? []).map((binding) => binding.slotId));
  (document.inputSlots ?? []).forEach((slot) => {
    if (slot.required && !boundSlotIds.has(slot.id)) {
      diagnostics.push(`${slot.id} needs a function input binding.`);
    }
  });

  return {
    syncState: diagnostics.length ? "draft" : "clean",
    diagnostics,
  };
}

function buildMockVisualFlowView(
  session: RepoSession,
  state: MockWorkspaceState,
  symbol: SymbolDetails,
): GraphView {
  const document = getMockFlowDocument(state, symbol);
  return {
    rootNodeId: document.nodes[0]?.id ?? `flow:${symbol.nodeId}:entry`,
    targetId: symbol.nodeId,
    level: "flow",
    truncated: false,
    breadcrumbs: [
      { nodeId: session.id, level: "repo", label: session.name, subtitle: "Architecture map" },
      { nodeId: `module:${symbol.moduleName}`, level: "module", label: symbol.moduleName, subtitle: symbol.filePath },
      { nodeId: symbol.nodeId, level: "symbol", label: symbol.name, subtitle: symbol.qualname },
      { nodeId: `flow:${symbol.nodeId}`, level: "flow", label: "Flow", subtitle: symbol.qualname },
    ],
    focus: {
      targetId: symbol.nodeId,
      level: "flow",
      label: symbol.name,
      subtitle: "Visual flow graph",
      availableLevels: ["repo", "module", "symbol", "flow"],
    },
    nodes: document.nodes.map((flowNode, index) => {
      const position = mockVisualFlowNodePosition(flowNode.id, flowNode.kind, index);
      return node(
        flowNode.id,
        flowNode.kind === "exit" ? "exit" : flowNode.kind,
        mockVisualFlowNodeLabel(flowNode.kind, flowNode.payload),
        mockVisualFlowNodeSubtitle(flowNode.kind, flowNode.payload, symbol),
        position.x,
        position.y,
        {
          flow_visual: true,
          flow_order: index,
          ...(flowNode.indexedNodeId ? { indexed_node_id: flowNode.indexedNodeId } : {}),
          ...sourceSpanMetadataForTargetId(flowNode.id, state),
        },
      );
    }),
    edges: document.edges.map((flowEdge) =>
      edge(
        flowEdge.id,
        "controls",
        flowEdge.sourceId,
        flowEdge.targetId,
        flowEdge.sourceHandle,
        {
          source_handle: flowEdge.sourceHandle,
          target_handle: flowEdge.targetHandle,
          path_label: flowEdge.sourceHandle,
        },
      ),
    ),
    flowState: {
      editable: true,
      syncState: document.syncState,
      diagnostics: [...document.diagnostics],
      document: cloneFlowDocument(document),
    },
  };
}

function moduleNameFromRelativePath(relativePath: string): string {
  return relativePath.replace(/\.py$/i, "").split("/").filter(Boolean).join(".");
}

function parseMockSymbolId(targetId: string) {
  if (!targetId.startsWith("symbol:")) {
    return undefined;
  }

  const parts = targetId.slice("symbol:".length).split(":");
  const moduleName = parts[0];
  const qualname = parts.slice(1).join(":");
  if (!moduleName || !qualname) {
    return undefined;
  }

  return {
    moduleName,
    qualname,
    name: qualname.split(".").pop() ?? qualname,
  };
}

function topLevelOutlineEntry(
  moduleName: string,
  symbol: MockTopLevelSymbolSeed,
  index: number,
) {
  return {
    id: `outline:${symbolId(moduleName, symbol.name)}`,
    nodeId: symbolId(moduleName, symbol.name),
    label: symbol.name,
    kind: symbol.kind,
    startLine: 20 + index * 3,
    topLevel: true,
  };
}

function moduleExtraSymbolsForModule(
  state: MockWorkspaceState,
  moduleName: string,
) {
  return state.moduleExtraSymbols.filter((symbol) => symbol.moduleName === moduleName);
}

function mockModuleSymbolCount(
  state: MockWorkspaceState,
  moduleName: string,
) {
  const baseCount = moduleName === "helm.ui.api"
    ? 6
    : moduleName === "helm.cli" || moduleName === "helm.graph.models"
      ? 1
      : 0;
  const createdInUi = moduleName === "helm.ui.api" ? state.uiApiExtraSymbols.length : 0;
  return baseCount + createdInUi + moduleExtraSymbolsForModule(state, moduleName).length;
}

function mockSymbolBlock(symbol: MockTopLevelSymbolSeed) {
  return symbol.kind === "class"
    ? `class ${symbol.name}:\n    pass\n`
    : `def ${symbol.name}() -> None:\n    pass\n`;
}

function moduleExtraBlocks(
  state: MockWorkspaceState,
  moduleName: string,
) {
  const seeds: MockTopLevelSymbolSeed[] = [
    ...(moduleName === "helm.ui.api" ? state.uiApiExtraSymbols : []),
    ...moduleExtraSymbolsForModule(state, moduleName),
  ];
  return seeds.map((symbol) => mockSymbolBlock(symbol)).join("\n");
}

function appendModuleBlocks(
  baseContent: string,
  extraBlocks: string,
) {
  const trimmedBase = baseContent.trimEnd();
  if (!extraBlocks) {
    return trimmedBase;
  }
  if (!trimmedBase) {
    return extraBlocks.trimEnd();
  }
  return `${trimmedBase}\n\n${extraBlocks}`.trimEnd();
}

function mockModulePosition(index: number) {
  const column = Math.floor(index / 4);
  const row = index % 4;
  return {
    x: 640 + column * 280,
    y: 60 + row * 150,
  };
}

export function buildOverview(
  session: RepoSession,
  state: MockWorkspaceState,
): OverviewData {
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
      { label: "Symbols", value: String(8 + state.uiApiExtraSymbols.length + state.moduleExtraSymbols.length) },
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

export function buildFiles(state: MockWorkspaceState): Record<string, FileContents> {
  const searchResults = buildSearchResults(state);
  const cliSource = buildCliSource(state);
  const uiApiSource = buildUiApiSource(state);
  const graphModelsSource = appendModuleBlocks(
    "from dataclasses import dataclass\n\n\n@dataclass(frozen=True)\nclass RepoGraph:\n    root_path: str\n    repo_id: str\n    nodes: dict[str, object]\n    edges: tuple[object, ...]\n",
    moduleExtraBlocks(state, "helm.graph.models"),
  );
  const files: Record<string, FileContents> = {
    "src/helm/cli.py": {
      path: "src/helm/cli.py",
      language: "python",
      lineCount: cliSource.split("\n").length,
      sizeBytes: new TextEncoder().encode(cliSource).length,
      linkedSymbols: searchResults.filter((result) => result.filePath === "src/helm/cli.py"),
      content: cliSource,
    },
    "src/helm/ui/api.py": {
      path: "src/helm/ui/api.py",
      language: "python",
      lineCount: uiApiSource.split("\n").length,
      sizeBytes: new TextEncoder().encode(uiApiSource).length,
      linkedSymbols: searchResults.filter((result) => result.filePath === "src/helm/ui/api.py"),
      content: uiApiSource,
    },
    "src/helm/graph/models.py": {
      path: "src/helm/graph/models.py",
      language: "python",
      lineCount: graphModelsSource.split("\n").length,
      sizeBytes: new TextEncoder().encode(graphModelsSource).length,
      linkedSymbols: searchResults.filter(
        (result) => result.filePath === "src/helm/graph/models.py",
      ),
      content: graphModelsSource,
    },
  };

  state.extraModules.forEach((module) => {
    const moduleContent = appendModuleBlocks(module.content, moduleExtraBlocks(state, module.moduleName));
    files[module.relativePath] = {
      path: module.relativePath,
      language: "python",
      lineCount: moduleContent.split("\n").length,
      sizeBytes: new TextEncoder().encode(moduleContent).length,
      linkedSymbols: searchResults.filter((result) => result.filePath === module.relativePath),
      content: moduleContent,
    };
  });

  return files;
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
      signature:
        symbol.kind === "class"
          ? `${symbol.name}()`
          : `${symbol.name}() -> None`,
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
        { nodeId: moduleId("helm.ui.api"), level: "module", label: "helm.ui.api", subtitle: "src/helm/ui/api.py" },
      ],
      focus: {
        targetId: moduleId("helm.ui.api"),
        level: "module",
        label: "helm.ui.api",
        subtitle: "Architecture slice",
        availableLevels: ["repo", "module"],
      },
      nodes: [
        node(moduleId("helm.ui.api"), "module", "helm.ui.api", "src/helm/ui/api.py", 0, 220, {
          symbolCount: mockModuleSymbolCount(state, "helm.ui.api"),
          importCount: state.uiApiImports.length,
          callCount: 1,
        }, moduleActions()),
        node(moduleId("helm.cli"), "module", "helm.cli", "src/helm/cli.py", 310, 60, {
          symbolCount: mockModuleSymbolCount(state, "helm.cli"),
          importCount: 1,
          callCount: 1,
        }, moduleActions()),
        node(moduleId("helm.graph.models"), "module", "helm.graph.models", "src/helm/graph/models.py", 310, 360, {
          symbolCount: mockModuleSymbolCount(state, "helm.graph.models"),
          importCount: 0,
          callCount: 0,
        }, moduleActions()),
        node(moduleId("rich.console"), "module", "rich.console", "External dependency", 310, 500, {
          isExternal: true,
        }),
        node(graphSummarySymbolId(), "class", "GraphSummary", "helm.ui.api.GraphSummary", 700, 40, {
          symbolKind: "class",
        }, symbolActions(false, true)),
        node(primarySymbolId, "function", state.primarySummarySymbolName, `helm.ui.api.${state.primarySummarySymbolName}`, 700, 140, {
          symbolKind: "function",
        }, symbolActions(true)),
        node(symbolId("helm.ui.api", "build_export_payload"), "function", "build_export_payload", "helm.ui.api.build_export_payload", 700, 300, {
          symbolKind: "function",
        }, symbolActions(true)),
        ...extraNodes,
      ],
      edges: [
        edge("imports:cli-ui", "imports", moduleId("helm.cli"), moduleId("helm.ui.api"), "1 import"),
        edge("imports:ui-models", "imports", moduleId("helm.ui.api"), moduleId("helm.graph.models"), "1 import"),
        edge("imports:ui-rich", "imports", moduleId("helm.ui.api"), moduleId("rich.console"), "1 import"),
        edge("defines:ui-summary-class", "defines", moduleId("helm.ui.api"), graphSummarySymbolId()),
        edge("defines:ui-primary", "defines", moduleId("helm.ui.api"), primarySymbolId),
        edge("defines:ui-export", "defines", moduleId("helm.ui.api"), symbolId("helm.ui.api", "build_export_payload")),
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
        edge(`defines:${extraModule.moduleName}:extra:${index}`, "defines", moduleId(extraModule.moduleName), symbolNode.id),
      ),
    };
  }

  if (level === "repo") {
    return {
      rootNodeId: session.id,
      targetId: session.id,
      level: "repo",
      truncated: false,
      breadcrumbs: [{ nodeId: session.id, level: "repo", label: session.name, subtitle: "Architecture map" }],
      focus: {
        targetId: session.id,
        level: "repo",
        label: session.name,
        subtitle: "Architecture map",
        availableLevels: ["repo", "module"],
      },
      nodes: [
        node(session.id, "repo", session.name, "Architecture map", 0, 180),
        node(moduleId("helm.cli"), "module", "helm.cli", "src/helm/cli.py", 320, 40, {
          symbolCount: mockModuleSymbolCount(state, "helm.cli"),
          importCount: 1,
          callCount: 1,
        }, moduleActions()),
        node(moduleId("helm.ui.api"), "module", "helm.ui.api", "src/helm/ui/api.py", 320, 210, {
          symbolCount: mockModuleSymbolCount(state, "helm.ui.api"),
          importCount: state.uiApiImports.length,
          callCount: 1,
        }, moduleActions()),
        node(moduleId("helm.graph.models"), "module", "helm.graph.models", "src/helm/graph/models.py", 320, 380, {
          symbolCount: mockModuleSymbolCount(state, "helm.graph.models"),
          importCount: 0,
          callCount: 0,
        }, moduleActions()),
        node(moduleId("rich.console"), "module", "rich.console", "External dependency", 320, 550, {
          isExternal: true,
        }),
        ...extraRepoModuleNodes,
      ],
      edges: [
        edge("imports:cli-ui", "imports", moduleId("helm.cli"), moduleId("helm.ui.api"), "1 import"),
        edge("imports:ui-models", "imports", moduleId("helm.ui.api"), moduleId("helm.graph.models"), "1 import"),
        edge("imports:ui-rich", "imports", moduleId("helm.ui.api"), moduleId("rich.console"), "1 import"),
        edge("calls:cli-ui", "calls", moduleId("helm.cli"), moduleId("helm.ui.api"), "1 call"),
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
      node(moduleId("helm.cli"), "module", "helm.cli", "src/helm/cli.py", 320, 40, {
        symbolCount: mockModuleSymbolCount(state, "helm.cli"),
        importCount: 1,
        callCount: 1,
      }, moduleActions()),
      node(moduleId("helm.ui.api"), "module", "helm.ui.api", "src/helm/ui/api.py", 320, 210, {
        symbolCount: mockModuleSymbolCount(state, "helm.ui.api"),
        importCount: state.uiApiImports.length,
        callCount: 1,
      }, moduleActions()),
      node(moduleId("helm.graph.models"), "module", "helm.graph.models", "src/helm/graph/models.py", 320, 380, {
        symbolCount: mockModuleSymbolCount(state, "helm.graph.models"),
        importCount: 0,
        callCount: 0,
      }, moduleActions()),
      node(moduleId("rich.console"), "module", "rich.console", "External dependency", 320, 550, {
        isExternal: true,
      }),
      ...extraRepoModuleNodes,
    ],
    edges: [
      edge("imports:cli-ui", "imports", moduleId("helm.cli"), moduleId("helm.ui.api"), "1 import"),
      edge("imports:ui-models", "imports", moduleId("helm.ui.api"), moduleId("helm.graph.models"), "1 import"),
      edge("imports:ui-rich", "imports", moduleId("helm.ui.api"), moduleId("rich.console"), "1 import"),
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
    node(moduleIdValue, "module", moduleLabel, modulePath, 0, 160, {
      symbolCount: mockModuleSymbolCount(state, symbol?.moduleName ?? "helm.ui.api"),
      importCount: symbol?.moduleName === "helm.ui.api" ? state.uiApiImports.length : 0,
      callCount: symbol?.moduleName === "helm.ui.api" ? 1 : 0,
    }, moduleActions()),
    node(symbolIdValue, symbolNodeKind, symbolLabel, symbol?.qualname ?? symbolLabel, 310, 160, {
      symbolKind: symbol?.kind ?? "function",
    }, symbolActions(mockSymbolEditable(symbol), flowEnabled)),
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
        node(memberId, graphNodeKindForSymbolKind(member.kind), member.name, member.qualname, x, y, {
          symbolKind: member.kind,
        }, symbolActions(mockSymbolEditable(member), flowEnabledForSymbol(member))),
      );
      edges.push(edge(`contains:${symbolIdValue}:${memberId}`, "contains", symbolIdValue, memberId));
    });
  }

  if (symbol?.nodeId === graphSummaryToPayloadSymbolId()) {
    nodes.push(
      node(graphSummarySymbolId(), "class", "GraphSummary", "helm.ui.api.GraphSummary", 620, 160, {
        symbolKind: "class",
      }, symbolActions(false, true)),
    );
    edges.push(
      edge(`contains:${graphSummarySymbolId()}:${symbolIdValue}`, "contains", graphSummarySymbolId(), symbolIdValue),
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
      { nodeId: symbolIdValue, level: "symbol", label: symbolLabel, subtitle: symbol?.qualname ?? symbolIdValue.replace("symbol:", "").replace(/:/g, ".") },
    ],
    focus: {
      targetId: symbolIdValue,
      level: "symbol",
      label: symbolLabel,
      subtitle: "Semantic node",
      availableLevels: flowEnabled ? ["repo", "module", "symbol", "flow"] : ["repo", "module", "symbol"],
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
    { nodeId: session.id, level: "repo" as const, label: session.name, subtitle: "Architecture map" },
    { nodeId: `module:${symbol.moduleName}`, level: "module" as const, label: symbol.moduleName, subtitle: symbol.filePath },
    { nodeId: symbol.nodeId, level: "symbol" as const, label: symbol.name, subtitle: symbol.qualname },
    { nodeId: `flow:${symbol.nodeId}`, level: "flow" as const, label: "Flow", subtitle: symbol.qualname },
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
        node(`flow:${symbol.nodeId}:param:graph`, "param", "graph", "parameter", 220, 80, sourceSpanMetadataForTargetId(`flow:${symbol.nodeId}:param:graph`, state)),
        node(`flow:${symbol.nodeId}:param:top_n`, "param", "top_n", "parameter", 220, 280, sourceSpanMetadataForTargetId(`flow:${symbol.nodeId}:param:top_n`, state)),
        node(`flow:${symbol.nodeId}:assign:modules`, "assign", "module_summaries", "collect module stats", 470, 80, sourceSpanMetadataForTargetId(`flow:${symbol.nodeId}:assign:modules`, state)),
        node(`flow:${symbol.nodeId}:call:rank`, "call", "sorted(...)", "rank modules", 720, 80, sourceSpanMetadataForTargetId(`flow:${symbol.nodeId}:call:rank`, state)),
        node(`flow:${symbol.nodeId}:return`, "return", "return GraphSummary(...)", "emit blueprint summary", 970, 180, sourceSpanMetadataForTargetId(`flow:${symbol.nodeId}:return`, state)),
      ],
      edges: [
        edge(controlEdgeId(entryId, `flow:${symbol.nodeId}:assign:modules`), "controls", entryId, `flow:${symbol.nodeId}:assign:modules`),
        edge(controlEdgeId(`flow:${symbol.nodeId}:assign:modules`, `flow:${symbol.nodeId}:call:rank`), "controls", `flow:${symbol.nodeId}:assign:modules`, `flow:${symbol.nodeId}:call:rank`),
        edge(controlEdgeId(`flow:${symbol.nodeId}:call:rank`, `flow:${symbol.nodeId}:return`), "controls", `flow:${symbol.nodeId}:call:rank`, `flow:${symbol.nodeId}:return`),
        edge(`data:${symbol.nodeId}:graph:assign`, "data", `flow:${symbol.nodeId}:param:graph`, `flow:${symbol.nodeId}:assign:modules`, "graph"),
        edge(`data:${symbol.nodeId}:top:rank`, "data", `flow:${symbol.nodeId}:param:top_n`, `flow:${symbol.nodeId}:call:rank`, "top_n"),
        edge(`data:${symbol.nodeId}:assign:rank`, "data", `flow:${symbol.nodeId}:assign:modules`, `flow:${symbol.nodeId}:call:rank`, "module_summaries"),
        edge(`data:${symbol.nodeId}:rank:return`, "data", `flow:${symbol.nodeId}:call:rank`, `flow:${symbol.nodeId}:return`, "ranked_modules"),
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
        node(`flow:${symbol.nodeId}:param:self`, "param", "self", "parameter", 220, 180, sourceSpanMetadataForTargetId(`flow:${symbol.nodeId}:param:self`)),
        node(`flow:${symbol.nodeId}:return`, "return", "return {...}", "emit payload map", 500, 180, sourceSpanMetadataForTargetId(`flow:${symbol.nodeId}:return`)),
      ],
      edges: [
        edge(controlEdgeId(entryId, `flow:${symbol.nodeId}:return`), "controls", entryId, `flow:${symbol.nodeId}:return`),
        edge(`data:${symbol.nodeId}:self:return`, "data", `flow:${symbol.nodeId}:param:self`, `flow:${symbol.nodeId}:return`, "self"),
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
      edge(controlEdgeId(entryId, `flow:${symbol.nodeId}:return`), "controls", entryId, `flow:${symbol.nodeId}:return`),
    ],
  });
}

function buildMockClassFlowView(
  session: RepoSession,
  symbol: SymbolDetails,
  symbols: Record<string, SymbolDetails>,
): GraphView {
  const entryId = `flow:${symbol.nodeId}:entry`;
  const members = symbol.nodeId === graphSummarySymbolId()
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
      { nodeId: `module:${symbol.moduleName}`, level: "module", label: symbol.moduleName, subtitle: symbol.filePath },
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
        node(member.nodeId, graphNodeKindForSymbolKind(member.kind), member.name, member.qualname, order * 260, 180, {
          symbolKind: member.kind,
          flow_order: order,
          ...sourceSpanMetadataForTargetId(member.nodeId),
        }, symbolActions(mockSymbolEditable(member), flowEnabledForSymbol(member))),
      ),
    ],
    edges: members.map(({ symbol: member }) =>
      edge(`contains:${entryId}:${member.nodeId}`, "contains", entryId, member.nodeId),
    ),
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
  if (targetId === moduleId("helm.ui.api")) {
    return {
      targetId,
      title: "helm.ui.api",
      path: "src/helm/ui/api.py",
      startLine: 1,
      endLine: files["src/helm/ui/api.py"].lineCount,
      content: files["src/helm/ui/api.py"].content,
    };
  }

  if (targetId.startsWith("module:")) {
    const matchingModule = state.extraModules.find((module) => moduleId(module.moduleName) === targetId);
    if (matchingModule) {
      return {
        targetId,
        title: matchingModule.moduleName,
        path: matchingModule.relativePath,
        startLine: 1,
        endLine: files[matchingModule.relativePath].lineCount,
        content: files[matchingModule.relativePath].content,
      };
    }
  }

  return {
    targetId,
    title: state.primarySummarySymbolName,
    path: "src/helm/ui/api.py",
    startLine: 18,
    endLine: 21,
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
  const support = mockDeclarationEditSupport(symbol);

  const defaultContent = state.editedSources[targetId] ?? defaultSymbolSource(state, symbol);
  const sourceSpan = sourceSpanForTargetId(targetId, state);

  return {
    targetId,
    title: symbol.name,
    path: symbol.filePath,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
    startColumn: sourceSpan?.startColumn,
    endColumn: sourceSpan?.endColumn,
    content: defaultContent,
    editable: support.editable,
    nodeKind: graphNodeKindForSymbolKind(symbol.kind),
    reason: support.reason,
  };
}

function moveEditedSourceDraft(
  state: MockWorkspaceState,
  previousTargetId: string,
  nextTargetId: string,
) {
  if (!(previousTargetId in state.editedSources)) {
    return;
  }

  state.editedSources[nextTargetId] = state.editedSources[previousTargetId];
  delete state.editedSources[previousTargetId];
}

function renameMockSymbol(
  state: MockWorkspaceState,
  targetId: string,
  newName: string,
) {
  if (targetId === symbolId("helm.ui.api", state.primarySummarySymbolName)) {
    state.primarySummarySymbolName = newName;
    const nextTargetId = symbolId("helm.ui.api", newName);
    moveEditedSourceDraft(state, targetId, nextTargetId);
    return {
      relativePath: "src/helm/ui/api.py",
      nextTargetId,
    };
  }

  const parsed = parseMockSymbolId(targetId);
  if (!parsed) {
    return undefined;
  }

  const uiSymbolIndex = parsed.moduleName === "helm.ui.api"
    ? state.uiApiExtraSymbols.findIndex((symbol) => symbol.name === parsed.name)
    : -1;
  if (uiSymbolIndex >= 0) {
    state.uiApiExtraSymbols[uiSymbolIndex] = {
      ...state.uiApiExtraSymbols[uiSymbolIndex],
      name: newName,
    };
    const nextTargetId = symbolId("helm.ui.api", newName);
    moveEditedSourceDraft(state, targetId, nextTargetId);
    return {
      relativePath: "src/helm/ui/api.py",
      nextTargetId,
    };
  }

  const moduleSymbolIndex = state.moduleExtraSymbols.findIndex((symbol) => (
    symbol.moduleName === parsed.moduleName && symbol.name === parsed.name
  ));
  if (moduleSymbolIndex >= 0) {
    const current = state.moduleExtraSymbols[moduleSymbolIndex];
    state.moduleExtraSymbols[moduleSymbolIndex] = {
      ...current,
      name: newName,
    };
    const nextTargetId = symbolId(current.moduleName, newName);
    moveEditedSourceDraft(state, targetId, nextTargetId);
    return {
      relativePath: current.relativePath,
      nextTargetId,
    };
  }

  return undefined;
}

function deleteMockSymbol(
  state: MockWorkspaceState,
  targetId: string,
) {
  const parsed = parseMockSymbolId(targetId);
  if (!parsed) {
    return undefined;
  }

  if (parsed.moduleName === "helm.ui.api") {
    const uiSymbolIndex = state.uiApiExtraSymbols.findIndex((symbol) => symbol.name === parsed.name);
    if (uiSymbolIndex >= 0) {
      state.uiApiExtraSymbols.splice(uiSymbolIndex, 1);
      delete state.editedSources[targetId];
      return {
        relativePath: "src/helm/ui/api.py",
        moduleNodeId: moduleId("helm.ui.api"),
      };
    }
  }

  const moduleSymbolIndex = state.moduleExtraSymbols.findIndex((symbol) => (
    symbol.moduleName === parsed.moduleName && symbol.name === parsed.name
  ));
  if (moduleSymbolIndex >= 0) {
    const [removed] = state.moduleExtraSymbols.splice(moduleSymbolIndex, 1);
    delete state.editedSources[targetId];
    return {
      relativePath: removed.relativePath,
      moduleNodeId: moduleId(removed.moduleName),
    };
  }

  return undefined;
}

function moveMockSymbol(
  state: MockWorkspaceState,
  targetId: string,
  destinationRelativePath: string,
) {
  const parsed = parseMockSymbolId(targetId);
  if (!parsed) {
    return undefined;
  }

  const normalizedDestination = destinationRelativePath.trim();
  const destinationModuleName = moduleNameFromRelativePath(normalizedDestination);
  if (!buildFiles(state)[normalizedDestination]) {
    throw new Error(`Destination module '${normalizedDestination}' does not exist.`);
  }

  let source: MockModuleSymbolSeed | undefined;
  if (parsed.moduleName === "helm.ui.api") {
    const uiSymbolIndex = state.uiApiExtraSymbols.findIndex((symbol) => symbol.name === parsed.name);
    if (uiSymbolIndex >= 0) {
      const [removed] = state.uiApiExtraSymbols.splice(uiSymbolIndex, 1);
      source = {
        ...removed,
        moduleName: "helm.ui.api",
        relativePath: "src/helm/ui/api.py",
      };
    }
  }

  if (!source) {
    const moduleSymbolIndex = state.moduleExtraSymbols.findIndex((symbol) => (
      symbol.moduleName === parsed.moduleName && symbol.name === parsed.name
    ));
    if (moduleSymbolIndex >= 0) {
      const [removed] = state.moduleExtraSymbols.splice(moduleSymbolIndex, 1);
      source = removed;
    }
  }

  if (!source) {
    return undefined;
  }

  if (source.relativePath === normalizedDestination) {
    throw new Error("Destination module must differ from the current module.");
  }

  const nextTargetId = symbolId(destinationModuleName, source.name);
  if (normalizedDestination === "src/helm/ui/api.py") {
    state.uiApiExtraSymbols.push({ name: source.name, kind: source.kind });
  } else {
    state.moduleExtraSymbols.push({
      name: source.name,
      kind: source.kind,
      moduleName: destinationModuleName,
      relativePath: normalizedDestination,
    });
  }
  moveEditedSourceDraft(state, targetId, nextTargetId);
  return {
    sourceRelativePath: source.relativePath,
    destinationRelativePath: normalizedDestination,
    destinationModuleNodeId: moduleId(destinationModuleName),
    nextTargetId,
  };
}

export function applyMockEdit(
  state: MockWorkspaceState,
  request: StructuralEditRequest,
): StructuralEditResult {
  if (request.kind === "rename_symbol" && request.targetId) {
    if (request.newName) {
      const renamed = renameMockSymbol(state, request.targetId, request.newName);
      if (renamed) {
        return {
          request: {
            kind: "rename_symbol",
            target_id: request.targetId,
            new_name: request.newName,
          },
          summary: `Renamed symbol to ${request.newName}.`,
          touchedRelativePaths: [renamed.relativePath],
          reparsedRelativePaths: [renamed.relativePath],
          changedNodeIds: [renamed.nextTargetId],
          warnings: [],
          diagnostics: [],
        };
      }
    }
  }

  if (request.kind === "delete_symbol" && request.targetId) {
    const deleted = deleteMockSymbol(state, request.targetId);
    if (deleted) {
      return {
        request: {
          kind: "delete_symbol",
          target_id: request.targetId,
        },
        summary: `Deleted ${request.targetId}.`,
        touchedRelativePaths: [deleted.relativePath],
        reparsedRelativePaths: [deleted.relativePath],
        changedNodeIds: [deleted.moduleNodeId],
        warnings: [],
        diagnostics: [],
      };
    }
  }

  if (request.kind === "move_symbol" && request.targetId && request.destinationRelativePath) {
    const moved = moveMockSymbol(state, request.targetId, request.destinationRelativePath);
    if (moved) {
      return {
        request: {
          kind: "move_symbol",
          target_id: request.targetId,
          destination_relative_path: request.destinationRelativePath,
        },
        summary: `Moved symbol to ${request.destinationRelativePath}.`,
        touchedRelativePaths: [moved.sourceRelativePath, moved.destinationRelativePath],
        reparsedRelativePaths: [moved.sourceRelativePath, moved.destinationRelativePath],
        changedNodeIds: [moved.nextTargetId],
        warnings: [],
        diagnostics: [],
      };
    }
  }

  if (request.kind === "create_symbol" && request.relativePath && request.newName && request.symbolKind) {
    validateMockCreateSymbolRequest(state, request.relativePath, request.newName);
    if (request.relativePath !== "src/helm/ui/api.py") {
      throw new Error("Mock symbol creation is only seeded for src/helm/ui/api.py.");
    }
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
      diagnostics: [],
    };
  }

  if (request.kind === "create_module" && request.relativePath) {
    validateMockCreateModuleRequest(state, request.relativePath);
    const relativePath = request.relativePath.trim();
    const moduleName = moduleNameFromRelativePath(relativePath);
    state.extraModules.push({
      moduleName,
      relativePath,
      content: normalizedMockModuleContent(request.content),
    });
    return {
      request: {
        kind: "create_module",
        relative_path: relativePath,
        content: request.content,
      },
      summary: `Created module ${moduleName}.`,
      touchedRelativePaths: [relativePath],
      reparsedRelativePaths: [relativePath],
      changedNodeIds: [moduleId(moduleName)],
      warnings: [],
      diagnostics: [],
    };
  }

  if (
    request.kind === "insert_flow_statement"
    && request.targetId
    && request.anchorEdgeId
    && request.content
  ) {
    const symbols = buildSymbols(state);
    const symbol = symbols[request.targetId];
    if (!symbol || (symbol.kind !== "function" && symbol.kind !== "class")) {
      throw new Error("Mock flow insertion is only available for seeded functions and methods.");
    }

    const currentFlow = buildGraphView(buildRepoSession(defaultRepoPath), state, request.targetId, "flow");
    if (!currentFlow.edges.some((edgeCandidate) => (
      edgeCandidate.id === request.anchorEdgeId && edgeCandidate.kind === "controls"
    ))) {
      throw new Error(`Unknown control-flow anchor '${request.anchorEdgeId}'.`);
    }

    const kind = mockFlowNodeKindFromContent(request.content);
    const baseDocument = getMockFlowDocument(state, symbol);
    const nextIndex = baseDocument.nodes.filter((node) => node.id.startsWith(`flow:${request.targetId}:created:`)).length;
    const nodeId = `flow:${request.targetId}:created:${nextIndex + 1}`;
    const nextDocument = insertFlowNodeOnEdge(baseDocument, {
      id: nodeId,
      kind,
      payload: flowNodePayloadFromContent(kind, request.content),
    }, request.anchorEdgeId);
    const validation = validateMockFlowDocument(nextDocument);
    state.flowDocumentsBySymbolId[request.targetId] = cloneFlowDocument({
      ...nextDocument,
      syncState: validation.syncState,
      diagnostics: validation.diagnostics,
      editable: true,
    });
    return {
      request: {
        kind: "insert_flow_statement",
        target_id: request.targetId,
        anchor_edge_id: request.anchorEdgeId,
        content: request.content,
      },
      summary: `Inserted ${kind} node into ${symbol.name}.`,
      touchedRelativePaths: [symbol.filePath],
      reparsedRelativePaths: [symbol.filePath],
      changedNodeIds: [nodeId],
      warnings: [],
      diagnostics: validation.diagnostics,
      flowSyncState: validation.syncState,
    };
  }

  if (request.kind === "replace_flow_graph" && request.targetId && request.flowGraph) {
    const symbols = buildSymbols(state);
    const symbol = symbols[request.targetId];
    if (!symbol || (symbol.kind !== "function" && symbol.kind !== "class")) {
      throw new Error("Mock visual flow editing is only available for seeded functions and methods.");
    }

    const previousDocument = state.flowDocumentsBySymbolId[request.targetId];
    const nextDocument = cloneFlowDocument(request.flowGraph);
    if (nextDocument.symbolId !== request.targetId) {
      throw new Error("Flow graph payload does not match the requested symbol.");
    }

    const validation = validateMockFlowDocument(nextDocument);
    const persistedDocument: FlowGraphDocument = {
      ...nextDocument,
      syncState: validation.syncState,
      diagnostics: validation.diagnostics,
      editable: true,
    };
    state.flowDocumentsBySymbolId[request.targetId] = cloneFlowDocument(persistedDocument);
    const changedNodeIds = persistedDocument.nodes
      .filter((node) => !previousDocument?.nodes.some((candidate) => candidate.id === node.id))
      .map((node) => node.id);

    return {
      request: {
        kind: "replace_flow_graph",
        target_id: request.targetId,
        flow_graph: request.flowGraph as unknown as Record<string, unknown>,
      },
      summary: validation.syncState === "clean"
        ? `Updated visual flow for ${symbol.name}.`
        : `Saved draft visual flow for ${symbol.name}.`,
      touchedRelativePaths: validation.syncState === "clean"
        ? [symbol.filePath, ".helm/flow-models.v1.json"]
        : [".helm/flow-models.v1.json"],
      reparsedRelativePaths: validation.syncState === "clean" ? [symbol.filePath] : [],
      changedNodeIds: changedNodeIds.length ? changedNodeIds : [request.targetId],
      warnings: validation.syncState === "clean"
        ? []
        : ["Python source was left unchanged until the flow graph validates cleanly."],
      flowSyncState: validation.syncState,
      diagnostics: validation.diagnostics,
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
      diagnostics: [],
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
      diagnostics: [],
    };
  }

  if (request.kind === "replace_symbol_source" && request.targetId && request.content) {
    const symbols = buildSymbols(state);
    const symbol = symbols[request.targetId];
    if (!symbol) {
      throw new Error(`Unknown editable source target: ${request.targetId}`);
    }
    const support = mockDeclarationEditSupport(symbol);
    if (!support.editable) {
      throw new Error(support.reason ?? "This declaration is not inline editable yet.");
    }
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
      diagnostics: [],
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
      anchor_edge_id: request.anchorEdgeId,
    },
    summary: `Mock adapter acknowledged ${request.kind}.`,
    touchedRelativePaths: request.relativePath ? [request.relativePath] : [],
    reparsedRelativePaths: request.relativePath ? [request.relativePath] : [],
    changedNodeIds: request.targetId ? [request.targetId] : [],
    warnings: ["This edit is simulated in the mock adapter."],
    diagnostics: [],
  };
}

function validateMockCreateModuleRequest(
  state: MockWorkspaceState,
  relativePath: string,
) {
  const normalized = relativePath.trim();
  if (!normalized || normalized.startsWith("/") || normalized.includes("\\")) {
    throw new Error("Module path must be a relative Python file path.");
  }
  if (!normalized.endsWith(".py")) {
    throw new Error("Module path must end with .py.");
  }
  if (normalized.split("/").some((segment) => segment === "." || segment === ".." || segment.length === 0)) {
    throw new Error("Module path must stay within the repo.");
  }
  if (buildFiles(state)[normalized]) {
    throw new Error(`Module '${normalized}' already exists.`);
  }
}

function validateMockCreateSymbolRequest(
  state: MockWorkspaceState,
  relativePath: string,
  newName: string,
) {
  if (!/^[_A-Za-z][_A-Za-z0-9]*$/.test(newName)) {
    throw new Error(`Created symbol name '${newName}' must be a valid Python identifier.`);
  }
  if (pythonKeywords.has(newName)) {
    throw new Error(`Created symbol name '${newName}' cannot be a Python keyword.`);
  }

  const existing = Object.values(buildSymbols(state)).some((symbol) => {
    if (symbol.filePath !== relativePath) {
      return false;
    }
    const modulePrefix = `${symbol.moduleName}.`;
    const localQualname = symbol.qualname.startsWith(modulePrefix)
      ? symbol.qualname.slice(modulePrefix.length)
      : symbol.qualname;
    return !localQualname.includes(".") && symbol.name === newName;
  });

  if (existing) {
    throw new Error(`Top-level symbol '${newName}' already exists in ${relativePath}.`);
  }
}

function normalizedMockModuleContent(content?: string) {
  const trimmed = content?.trimEnd();
  return trimmed && trimmed.length > 0
    ? `${trimmed}\n`
    : "";
}

function mockFlowNodeKindFromContent(content: string): "assign" | "call" | "return" | "branch" | "loop" {
  const normalized = content.trim();
  if (normalized.startsWith("if ")) {
    return "branch";
  }
  if (normalized.startsWith("for ") || normalized.startsWith("while ")) {
    return "loop";
  }
  if (normalized.startsWith("return")) {
    return "return";
  }
  if (normalized.includes("=")) {
    return "assign";
  }
  return "call";
}

function buildCliSource(state: MockWorkspaceState): string {
  return appendModuleBlocks(
    `from helm.ui.api import ${state.primarySummarySymbolName}\n\n\ndef main(argv: list[str] | None = None) -> int:\n    summary = ${state.primarySummarySymbolName}(graph=RepoGraph(root_path='.', repo_id='repo', nodes={}, edges=()))\n    return 0\n`,
    moduleExtraBlocks(state, "helm.cli"),
  );
}

function buildUiApiSource(state: MockWorkspaceState): string {
  return appendModuleBlocks(
    `${state.uiApiImports.join("\n")}\n\n\n@dataclass(frozen=True)\nclass GraphSummary:\n    repo_path: str\n    module_count: int\n\n    def to_payload(self) -> dict[str, object]:\n        return {\n            "repo_path": self.repo_path,\n            "module_count": self.module_count,\n        }\n\n\ndef ${state.primarySummarySymbolName}(graph: RepoGraph, top_n: int = 10) -> GraphSummary:\n    module_summaries = []\n    ranked_modules = sorted(module_summaries)[:top_n]\n    return GraphSummary(repo_path=graph.root_path, module_count=len(ranked_modules))\n\n\ndef build_export_payload(graph: RepoGraph) -> dict[str, object]:\n    return {"graph": graph}\n`,
    moduleExtraBlocks(state, "helm.ui.api"),
  );
}

function defaultSymbolSource(
  state: MockWorkspaceState,
  symbol: SymbolDetails,
): string {
  if (symbol.nodeId === symbolId("helm.ui.api", state.primarySummarySymbolName)) {
    return `def ${state.primarySummarySymbolName}(graph: RepoGraph, top_n: int = 10) -> GraphSummary:\n    module_summaries = []\n    ranked_modules = sorted(module_summaries)[:top_n]\n    return GraphSummary(repo_path=graph.root_path, module_count=len(ranked_modules))`;
  }
  if (symbol.nodeId === graphSummarySymbolId()) {
    return "class GraphSummary:\n    repo_path: str\n    module_count: int\n\n    def to_payload(self) -> dict[str, object]:\n        return {\n            \"repo_path\": self.repo_path,\n            \"module_count\": self.module_count,\n        }";
  }
  if (symbol.nodeId === graphSummaryRepoPathSymbolId()) {
    return "repo_path: str";
  }
  if (symbol.nodeId === graphSummaryModuleCountSymbolId()) {
    return "module_count: int";
  }
  if (symbol.nodeId === graphSummaryToPayloadSymbolId()) {
    return "def to_payload(self) -> dict[str, object]:\n    return {\n        \"repo_path\": self.repo_path,\n        \"module_count\": self.module_count,\n    }";
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

function sourceSpanForTargetId(
  targetId: string,
  state?: MockWorkspaceState,
): {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
} | undefined {
  const primarySymbolId = state ? symbolId("helm.ui.api", state.primarySummarySymbolName) : undefined;
  switch (targetId) {
    case primarySymbolId:
      return { startLine: 18, startColumn: 0, endLine: 21, endColumn: 82 };
    case graphSummarySymbolId():
      return { startLine: 6, startColumn: 0, endLine: 15, endColumn: 9 };
    case graphSummaryRepoPathSymbolId():
      return { startLine: 8, startColumn: 4, endLine: 8, endColumn: 18 };
    case graphSummaryModuleCountSymbolId():
      return { startLine: 9, startColumn: 4, endLine: 9, endColumn: 21 };
    case graphSummaryToPayloadSymbolId():
      return { startLine: 11, startColumn: 4, endLine: 15, endColumn: 9 };
    case symbolId("helm.ui.api", "build_export_payload"):
      return { startLine: 24, startColumn: 0, endLine: 25, endColumn: 27 };
    case symbolId("helm.cli", "main"):
      return { startLine: 4, startColumn: 0, endLine: 6, endColumn: 12 };
    case symbolId("helm.graph.models", "RepoGraph"):
      return { startLine: 4, startColumn: 0, endLine: 8, endColumn: 26 };
    case primarySymbolId ? `flow:${primarySymbolId}:param:graph` : "":
      return { startLine: 18, startColumn: 24, endLine: 18, endColumn: 29 };
    case primarySymbolId ? `flow:${primarySymbolId}:param:top_n` : "":
      return { startLine: 18, startColumn: 42, endLine: 18, endColumn: 47 };
    case primarySymbolId ? `flow:${primarySymbolId}:assign:modules` : "":
      return { startLine: 19, startColumn: 4, endLine: 19, endColumn: 24 };
    case primarySymbolId ? `flow:${primarySymbolId}:call:rank` : "":
      return { startLine: 20, startColumn: 4, endLine: 20, endColumn: 52 };
    case primarySymbolId ? `flow:${primarySymbolId}:return` : "":
      return { startLine: 21, startColumn: 4, endLine: 21, endColumn: 78 };
    case `flow:${graphSummaryToPayloadSymbolId()}:param:self`:
      return { startLine: 11, startColumn: 19, endLine: 11, endColumn: 23 };
    case `flow:${graphSummaryToPayloadSymbolId()}:return`:
      return { startLine: 12, startColumn: 8, endLine: 15, endColumn: 9 };
    default:
      return undefined;
  }
}

function sourceSpanMetadataForTargetId(
  targetId: string,
  state?: MockWorkspaceState,
): Record<string, number> {
  const sourceSpan = sourceSpanForTargetId(targetId, state);
  if (!sourceSpan) {
    return {};
  }

  return {
    source_start_line: sourceSpan.startLine,
    source_start_column: sourceSpan.startColumn,
    source_end_line: sourceSpan.endLine,
    source_end_column: sourceSpan.endColumn,
  };
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
  metadata: Record<string, unknown> = {},
) {
  return {
    id,
    kind,
    source,
    target,
    label,
    metadata,
  };
}

function controlEdgeId(source: string, target: string, pathKey?: string) {
  return `controls:${source}->${target}${pathKey ? `:${pathKey}` : ""}`;
}

function moduleActions() {
  return [
    { actionId: "add_import", label: "Add import", enabled: true, reason: null, payload: {} },
    { actionId: "remove_import", label: "Remove import", enabled: true, reason: null, payload: {} },
    { actionId: "reveal_source", label: "Reveal source", enabled: true, reason: null, payload: {} },
  ];
}

function mockSymbolEditable(symbol?: SymbolDetails) {
  return Boolean(symbol && symbol.kind === "function" && !symbol.qualname.includes("GraphSummary."));
}

function mockDeclarationEditSupport(symbol?: SymbolDetails) {
  if (!symbol) {
    return {
      editable: false,
      reason: "This declaration is not inline editable yet.",
    };
  }
  const localQualname = symbol.nodeId.split(":").slice(2).join(":");
  const nested = localQualname.includes(".");

  if (symbol.kind === "enum") {
    return {
      editable: false,
      reason: "Enum declarations are not inline editable yet.",
    };
  }

  if (symbol.kind === "class" || symbol.kind === "function") {
    return {
      editable: true,
      reason: undefined,
    };
  }

  if (symbol.kind === "variable") {
    if (!nested) {
      return {
        editable: true,
        reason: undefined,
      };
    }
    return {
      editable: false,
      reason: "Class attribute declarations are not inline editable yet.",
    };
  }

  return {
    editable: false,
    reason: "This declaration is not inline editable yet.",
  };
}

function flowEnabledForSymbol(symbol?: SymbolDetails) {
  return symbol?.kind === "function" || symbol?.kind === "class";
}

function symbolActions(editable: boolean, flowEnabled = true) {
  return [
    {
      actionId: "rename_symbol",
      label: "Rename symbol",
      enabled: editable,
      reason: editable ? null : "Only dependency-free top-level symbols are writable in v1.",
      payload: {},
    },
    {
      actionId: "delete_symbol",
      label: "Delete symbol",
      enabled: editable,
      reason: editable ? null : "Only dependency-free top-level symbols are writable in v1.",
      payload: {},
    },
    {
      actionId: "move_symbol",
      label: "Move symbol",
      enabled: editable,
      reason: editable ? null : "Only dependency-free top-level symbols are writable in v1.",
      payload: {},
    },
    {
      actionId: "open_flow",
      label: "Open flow",
      enabled: flowEnabled,
      reason: flowEnabled ? null : "Flow only exists for functions, methods, and classes.",
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
