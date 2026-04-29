import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppProviders } from "../app/AppProviders";
import {
  graphLayoutNodeKey,
  type StoredGraphLayout,
} from "../components/graph/graphLayoutPersistence";
import { buildRepoSession, defaultRepoPath, mockBackendStatus } from "../lib/mocks/mockData";
import { MockDesktopAdapter } from "../lib/adapter/mockDesktopAdapter";
import type {
  BackendStatus,
  FlowGraphDocument,
  GraphAbstractionLevel,
  GraphView,
  SourceRange,
  StructuralEditRequest,
  StructuralEditResult,
  WorkspaceSyncEvent,
} from "../lib/adapter";
import { useUiStore } from "../store/uiStore";
import { useUndoStore } from "../store/undoStore";
import { WorkspaceScreen } from "./WorkspaceScreen";

const WORKSPACE_TEST_TIMEOUT_MS = 15000;
const BUILD_GRAPH_SUMMARY_SYMBOL_ID = "symbol:helm.ui.api:build_graph_summary";
const BUILD_GRAPH_SUMMARY_ENTRY_ID = `flow:${BUILD_GRAPH_SUMMARY_SYMBOL_ID}:entry`;
const BUILD_GRAPH_SUMMARY_GRAPH_PARAM_ID = `flow:${BUILD_GRAPH_SUMMARY_SYMBOL_ID}:param:graph`;
const BUILD_GRAPH_SUMMARY_TOP_N_PARAM_ID = `flow:${BUILD_GRAPH_SUMMARY_SYMBOL_ID}:param:top_n`;
const BUILD_GRAPH_SUMMARY_ASSIGN_MODULES_ID = `flow:${BUILD_GRAPH_SUMMARY_SYMBOL_ID}:assign:modules`;
const BUILD_GRAPH_SUMMARY_CALL_RANK_ID = `flow:${BUILD_GRAPH_SUMMARY_SYMBOL_ID}:call:rank`;
const BUILD_GRAPH_SUMMARY_RETURN_ID = `flow:${BUILD_GRAPH_SUMMARY_SYMBOL_ID}:return`;
const BUILD_GRAPH_SUMMARY_EXIT_ID = `flow:${BUILD_GRAPH_SUMMARY_SYMBOL_ID}:exit`;
const BUILD_GRAPH_SUMMARY_GRAPH_INPUT_ID = `flowinput:${BUILD_GRAPH_SUMMARY_SYMBOL_ID}:graph`;
const BUILD_GRAPH_SUMMARY_TOP_N_INPUT_ID = `flowinput:${BUILD_GRAPH_SUMMARY_SYMBOL_ID}:top_n`;
const BUILD_GRAPH_SUMMARY_GRAPH_SLOT_ID = `flowslot:${BUILD_GRAPH_SUMMARY_ASSIGN_MODULES_ID}:graph`;
const BUILD_GRAPH_SUMMARY_TOP_N_SLOT_ID = `flowslot:${BUILD_GRAPH_SUMMARY_CALL_RANK_ID}:top_n`;
const BUILD_GRAPH_SUMMARY_MODULE_SUMMARIES_SOURCE_ID = `flowsource:${BUILD_GRAPH_SUMMARY_ASSIGN_MODULES_ID}:module_summaries`;
const BUILD_GRAPH_SUMMARY_MODULE_SUMMARIES_SLOT_ID = `flowslot:${BUILD_GRAPH_SUMMARY_CALL_RANK_ID}:module_summaries`;
const BUILD_GRAPH_SUMMARY_RETURN_MODULE_SUMMARIES_SLOT_ID = `flowslot:${BUILD_GRAPH_SUMMARY_RETURN_ID}:module_summaries`;
const BUILD_GRAPH_SUMMARY_RANK_TO_RETURN_EDGE_ID =
  "controls:flow:symbol:helm.ui.api:build_graph_summary:call:rank:next->flow:symbol:helm.ui.api:build_graph_summary:return:in";
const BUILD_GRAPH_SUMMARY_RETURN_COMPLETION_EDGE_ID = `controls:${BUILD_GRAPH_SUMMARY_RETURN_ID}:exit->${BUILD_GRAPH_SUMMARY_EXIT_ID}:in`;
const ADD_SYMBOL_ID = "symbol:helm.ui.api:add";
const ADD_ENTRY_ID = `flowdoc:${ADD_SYMBOL_ID}:entry`;
const ADD_INDEXED_ENTRY_ID = `flow:${ADD_SYMBOL_ID}:entry`;
const ADD_RETURN_ID = `flowdoc:${ADD_SYMBOL_ID}:return:0`;
const ADD_INDEXED_RETURN_ID = `flow:${ADD_SYMBOL_ID}:statement:0`;
const ADD_EXIT_ID = `flowdoc:${ADD_SYMBOL_ID}:exit`;
const ADD_PARAM_A_ID = `flow:${ADD_SYMBOL_ID}:param:a`;
const ADD_PARAM_B_ID = `flow:${ADD_SYMBOL_ID}:param:b`;
const ADD_INPUT_A_ID = `flowinput:${ADD_SYMBOL_ID}:a`;
const ADD_INPUT_B_ID = `flowinput:${ADD_SYMBOL_ID}:b`;
const ADD_SLOT_A_ID = `flowslot:${ADD_INDEXED_RETURN_ID}:a`;
const ADD_SLOT_B_ID = `flowslot:${ADD_INDEXED_RETURN_ID}:b`;
const EMPTY_STORED_GRAPH_LAYOUT: StoredGraphLayout = {
  nodes: {},
  reroutes: [],
  pinnedNodeIds: [],
  groups: [],
};
const GROUPED_SYMBOL_LAYOUT = {
  ...EMPTY_STORED_GRAPH_LAYOUT,
  groups: [
    {
      id: "group-symbol-summary",
      title: "Summary nodes",
      memberNodeIds: ["symbol:helm.ui.api:build_graph_summary", "symbol:helm.ui.api:GraphSummary"],
    },
  ],
};

const { readStoredGraphLayoutMock, writeStoredGraphLayoutMock } = vi.hoisted(() => ({
  readStoredGraphLayoutMock: vi.fn(),
  writeStoredGraphLayoutMock: vi.fn(),
}));
const { peekStoredGraphLayoutMock, storedGraphLayoutSnapshots } = vi.hoisted(() => ({
  peekStoredGraphLayoutMock: vi.fn(),
  storedGraphLayoutSnapshots: new Map<string, StoredGraphLayout>(),
}));
const { confirmDialogMock } = vi.hoisted(() => ({
  confirmDialogMock: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: confirmDialogMock,
}));

function mockStoredGraphLayoutKey(repoPath: string | undefined, viewKey: string | undefined) {
  if (!repoPath || !viewKey) {
    return undefined;
  }

  return `${repoPath}\u0000${viewKey}`;
}

function cloneStoredGraphLayout(layout: StoredGraphLayout): StoredGraphLayout {
  return {
    nodes: Object.fromEntries(
      Object.entries(layout.nodes).map(([nodeId, position]) => [
        nodeId,
        { x: position.x, y: position.y },
      ]),
    ),
    reroutes: layout.reroutes.map((reroute) => ({ ...reroute })),
    pinnedNodeIds: [...layout.pinnedNodeIds],
    groups: layout.groups.map((group) => ({
      ...group,
      memberNodeIds: [...group.memberNodeIds],
    })),
  };
}

function getMockStoredGraphLayout(repoPath: string | undefined, viewKey: string | undefined) {
  const key = mockStoredGraphLayoutKey(repoPath, viewKey);
  if (!key) {
    return undefined;
  }

  const layout = storedGraphLayoutSnapshots.get(key);
  return layout ? cloneStoredGraphLayout(layout) : undefined;
}

function setMockStoredGraphLayout(
  repoPath: string | undefined,
  viewKey: string | undefined,
  layout: StoredGraphLayout,
) {
  const key = mockStoredGraphLayoutKey(repoPath, viewKey);
  if (!key) {
    return;
  }

  storedGraphLayoutSnapshots.set(key, cloneStoredGraphLayout(layout));
}

vi.mock("../components/editor/InspectorCodeSurface", () => ({
  InspectorCodeSurface: ({
    ariaLabel,
    className,
    dataTestId,
    highlightRange,
    onChange,
    readOnly,
    value,
  }: {
    ariaLabel: string;
    className?: string;
    dataTestId?: string;
    highlightRange?: SourceRange;
    onChange?: (value: string) => void;
    readOnly: boolean;
    value: string;
  }) =>
    readOnly ? (
      <div
        className={className}
        data-highlight-end-line={highlightRange?.endLine}
        data-highlight-start-line={highlightRange?.startLine}
        data-read-only="true"
        data-testid={dataTestId}
      >
        <pre aria-label={ariaLabel}>{value}</pre>
      </div>
    ) : (
      <div
        className={className}
        data-highlight-end-line={highlightRange?.endLine}
        data-highlight-start-line={highlightRange?.startLine}
        data-read-only="false"
        data-testid={dataTestId}
      >
        <textarea
          aria-label={ariaLabel}
          spellCheck={false}
          value={value}
          onChange={(event) => onChange?.(event.target.value)}
        />
      </div>
    ),
}));

vi.mock("../components/graph/graphLayoutPersistence", async () => {
  const actual = await vi.importActual<typeof import("../components/graph/graphLayoutPersistence")>(
    "../components/graph/graphLayoutPersistence",
  );
  return {
    ...actual,
    peekStoredGraphLayout: peekStoredGraphLayoutMock,
    readStoredGraphLayout: readStoredGraphLayoutMock,
    writeStoredGraphLayout: writeStoredGraphLayoutMock,
  };
});

function clearLocalStorage() {
  if (typeof window.localStorage?.clear === "function") {
    window.localStorage.clear();
  }
}

function resetStore() {
  const current = useUiStore.getState();
  const repoSession = buildRepoSession();
  clearLocalStorage();
  useUndoStore.getState().resetSession(undefined);
  useUiStore.setState({
    ...current,
    theme: "system",
    uiScale: 1,
    paletteOpen: false,
    sidebarQuery: "",
    activeTab: "graph",
    repoSession,
    activeFilePath: undefined,
    activeSymbolId: undefined,
    activeNodeId: repoSession.id,
    graphTargetId: repoSession.id,
    activeLevel: "module",
    graphDepth: 1,
    graphFilters: {
      includeImports: true,
      includeCalls: true,
      includeDefines: true,
    },
    graphSettings: {
      includeExternalDependencies: false,
    },
    highlightGraphPath: true,
    showEdgeLabels: true,
    revealedSource: undefined,
    lastEdit: undefined,
    lastActivity: undefined,
  });
}

function setGraphFocusForTest({
  targetId,
  level,
  activeNodeId,
  activeSymbolId,
}: {
  targetId: string;
  level: GraphAbstractionLevel;
  activeNodeId?: string;
  activeSymbolId?: string;
}) {
  const current = useUiStore.getState();
  useUiStore.setState({
    ...current,
    activeTab: "graph",
    graphTargetId: targetId,
    activeLevel: level,
    activeNodeId,
    activeSymbolId,
  });
}

function lastWrittenGraphLayout() {
  return writeStoredGraphLayoutMock.mock.calls[
    writeStoredGraphLayoutMock.mock.calls.length - 1
  ]?.[2];
}

function lastReplaceFlowGraphRequest(editSpy: {
  mock: {
    calls: Array<[StructuralEditRequest, ...unknown[]]>;
  };
}): StructuralEditRequest | undefined {
  return editSpy.mock.calls
    .map(([request]) => request)
    .filter((request) => request.kind === "replace_flow_graph")
    .slice(-1)[0];
}

function flowInputSourceHandle(functionInputId: string) {
  return `out:data:function-input:${functionInputId}`;
}

function flowValueSourceHandle(sourceId: string) {
  return `out:data:value-source:${sourceId}`;
}

function flowInputSlotTargetHandle(slotId: string) {
  return `in:data:input-slot:${slotId}`;
}

function flowInputBindingId(slotId: string, functionInputId: string) {
  return `flowbinding:${slotId}->${functionInputId}`;
}

type FlowGraphDocumentLike =
  | StructuralEditRequest["flowGraph"]
  | FlowGraphDocument
  | null
  | undefined;

function expectFlowBinding(
  document: FlowGraphDocumentLike,
  slotId: string,
  functionInputId: string,
) {
  expect(document?.inputBindings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: flowInputBindingId(slotId, functionInputId),
        slotId,
        sourceId: functionInputId,
        functionInputId,
      }),
    ]),
  );
}

function expectNoBinding(document: FlowGraphDocumentLike, slotId: string, sourceId: string) {
  expect(
    document?.inputBindings?.some(
      (binding) => binding.slotId === slotId && binding.sourceId === sourceId,
    ),
  ).toBe(false);
}

async function expandFlowToolbar(
  user: ReturnType<typeof userEvent.setup>,
  symbolName = "build_graph_summary",
) {
  if (screen.queryByRole("button", { name: "Entry inputs" })) {
    return;
  }
  const escapedSymbolName = symbolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await user.click(
    await screen.findByRole("button", { name: new RegExp(`${escapedSymbolName} flow view`, "i") }),
  );
  await screen.findByRole("button", { name: "Entry inputs" });
}

async function setFlowInputMode(
  user: ReturnType<typeof userEvent.setup>,
  mode: "entry" | "param_nodes",
  symbolName = "build_graph_summary",
) {
  await expandFlowToolbar(user, symbolName);
  await user.click(
    screen.getByRole("button", { name: mode === "entry" ? "Entry inputs" : "Parameters" }),
  );
}

function mockGraphElementRect() {
  const elementSize = function elementSize(this: HTMLElement) {
    const isHandle = this.classList?.contains("react-flow__handle");
    return {
      width: isHandle ? 12 : 240,
      height: isHandle ? 12 : 96,
    };
  };

  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function mockClientWidth(
    this: HTMLElement,
  ) {
    return elementSize.call(this).width;
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    function mockClientHeight(this: HTMLElement) {
      return elementSize.call(this).height;
    },
  );
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function mockWidth(
    this: HTMLElement,
  ) {
    return elementSize.call(this).width;
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function mockHeight(
    this: HTMLElement,
  ) {
    return elementSize.call(this).height;
  });

  return vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function mockRect(this: HTMLElement) {
      const { width, height } = elementSize.call(this);
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: width,
        bottom: height,
        width,
        height,
        toJSON: () => ({}),
      } as DOMRect;
    });
}

function queryTestIdElementByFragments(prefix: string, fragments: string[]) {
  return Array.from(document.querySelectorAll(`[data-testid^="${prefix}"]`)).find((element) => {
    const testId = element.getAttribute("data-testid") ?? "";
    return fragments.every((fragment) => testId.includes(fragment));
  });
}

async function findTestIdElementByFragments(prefix: string, fragments: string[]) {
  await waitFor(() => expect(queryTestIdElementByFragments(prefix, fragments)).not.toBeUndefined());
  return queryTestIdElementByFragments(prefix, fragments) as Element;
}

async function openFunctionFlow(user: ReturnType<typeof userEvent.setup>, symbolName: string) {
  const graphPanel = document.querySelector(".graph-panel");
  expect(graphPanel).not.toBeNull();
  const graph = within(graphPanel as HTMLElement);
  fireEvent.doubleClick(await graph.findByText("api.py"));
  const functionNode = (await graph.findByText(symbolName)).closest(".graph-node");
  expect(functionNode).not.toBeNull();
  fireEvent.click(within(functionNode as HTMLElement).getByText("Inspect"));
  await user.click(await screen.findByRole("button", { name: /Open flow/i }));

  const flowGraphPanel = await waitForFunctionFlowReady(symbolName);
  return {
    graphPanel: graphPanel as HTMLElement,
    flowGraphPanel,
  };
}

async function openBuildGraphSummaryFlow(user: ReturnType<typeof userEvent.setup>) {
  return openFunctionFlow(user, "build_graph_summary");
}

async function waitForFunctionFlowReady(symbolName: string) {
  const escapedSymbolName = symbolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await screen.findByRole("button", {
    name: new RegExp(`${escapedSymbolName} flow view`, "i"),
  });
  const flowGraphPanel = (await screen.findByRole("region", {
    name: /Graph canvas/i,
  })) as HTMLElement;
  await waitFor(() =>
    expect(
      (screen.getByRole("textbox", { name: /Function source editor/i }) as HTMLTextAreaElement)
        .value,
    ).not.toBe(""),
  );
  return flowGraphPanel;
}

async function ensureFlowCreateMode(flowGraphPanel: HTMLElement) {
  if (!screen.queryByTestId("graph-create-mode-badge")) {
    flowGraphPanel.focus();
    fireEvent.keyDown(flowGraphPanel, { key: "c" });
  }

  await screen.findByTestId("graph-create-mode-badge");
  await waitFor(() =>
    expect(screen.getByTestId("graph-create-mode-hint")).toHaveTextContent(
      "Click empty canvas to create a flow node in this draft.",
    ),
  );
  await waitFor(() =>
    expect((flowGraphPanel as HTMLElement).querySelector(".react-flow__pane")).not.toBeNull(),
  );
  return (flowGraphPanel as HTMLElement).querySelector(".react-flow__pane") as HTMLElement;
}

function flowComposerFieldLabel(kind: "assign" | "call" | "return" | "branch" | "loop") {
  if (kind === "branch") {
    return /Branch condition/i;
  }
  if (kind === "loop") {
    return /Continue while/i;
  }
  return /Flow statement/i;
}

async function createDraftFlowNode({
  user,
  flowGraphPanel,
  position,
  kind,
  content,
}: {
  user: ReturnType<typeof userEvent.setup>;
  flowGraphPanel: HTMLElement;
  position: { clientX: number; clientY: number };
  kind: "assign" | "call" | "return" | "branch" | "loop";
  content: string;
}) {
  const graphPane = await ensureFlowCreateMode(flowGraphPanel);
  fireEvent.click(graphPane, position);

  if (kind !== "assign") {
    await user.selectOptions(screen.getByRole("combobox", { name: /Flow node kind/i }), kind);
  }

  await user.type(screen.getByRole("textbox", { name: flowComposerFieldLabel(kind) }), content);
  await user.click(screen.getByRole("button", { name: /Create node/i }));

  const createdNodeId = useUiStore.getState().activeNodeId;
  expect(createdNodeId).toMatch(
    new RegExp(
      `^flowdoc:${BUILD_GRAPH_SUMMARY_SYMBOL_ID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:${kind}:`,
    ),
  );
  await waitFor(() =>
    expect(screen.queryByRole("heading", { name: /Create flow node/i })).not.toBeInTheDocument(),
  );
  await screen.findByTestId(`rf__node-${createdNodeId}`);
  return createdNodeId as string;
}

async function findFlowHandle(nodeId: string, handleId: string) {
  const nodeHost = await screen.findByTestId(`rf__node-${nodeId}`);
  await waitFor(() =>
    expect(
      nodeHost.querySelector(
        `.react-flow__handle[data-nodeid="${nodeId}"][data-handleid="${handleId}"]`,
      ),
    ).not.toBeNull(),
  );
  return nodeHost.querySelector(
    `.react-flow__handle[data-nodeid="${nodeId}"][data-handleid="${handleId}"]`,
  ) as HTMLElement;
}

function centerPoint(element: Element) {
  const rect = element.getBoundingClientRect();
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  };
}

function dragConnectionToHandle({
  dragStart,
  onDragMove,
  targetHandle,
}: {
  dragStart: Element;
  onDragMove?: () => void;
  targetHandle: HTMLElement;
}) {
  const targetPoint = centerPoint(targetHandle);
  const originalElementFromPoint = document.elementFromPoint;
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => targetHandle,
  });

  try {
    fireEvent.mouseDown(dragStart, {
      button: 0,
      clientX: 0,
      clientY: 0,
    });
    fireEvent.mouseMove(document, {
      buttons: 1,
      clientX: targetPoint.x + 8,
      clientY: targetPoint.y + 8,
    });
    onDragMove?.();
    fireEvent.mouseUp(document, {
      clientX: targetPoint.x + 8,
      clientY: targetPoint.y + 8,
    });
  } finally {
    if (originalElementFromPoint) {
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: originalElementFromPoint,
      });
    } else {
      Reflect.deleteProperty(document, "elementFromPoint");
    }
  }
}

type FlowViewSpy = {
  mock: {
    calls: unknown[][];
  };
};

async function emitSameSymbolRefetch(
  adapter: SyncAwareMockDesktopAdapter,
  flowViewSpy: FlowViewSpy,
  nodeIds: string[],
  targetSymbolId = BUILD_GRAPH_SUMMARY_SYMBOL_ID,
) {
  const initialFlowViewCalls = flowViewSpy.mock.calls.length;

  act(() => {
    adapter.emitWorkspaceSync({
      repoPath: defaultRepoPath,
      sessionVersion: 4,
      reason: "refresh",
      status: "synced",
      changedRelativePaths: [],
      needsManualResync: false,
      message: "Watching the active repo for workspace changes.",
      snapshot: {
        repoId: buildRepoSession().id,
        defaultFocusNodeId: targetSymbolId,
        defaultLevel: "flow",
        nodeIds: [targetSymbolId, ...nodeIds],
      },
    });
  });

  await waitFor(() => expect(flowViewSpy.mock.calls.length).toBeGreaterThan(initialFlowViewCalls));
}

async function seedMockFunctionSymbol(adapter: MockDesktopAdapter, newName: string) {
  await adapter.applyStructuralEdit({
    kind: "create_symbol",
    relativePath: "src/helm/ui/api.py",
    newName,
    symbolKind: "function",
  });
  return `symbol:helm.ui.api:${newName}`;
}

async function seedMockModule(adapter: MockDesktopAdapter, relativePath: string) {
  await adapter.applyStructuralEdit({
    kind: "create_module",
    relativePath,
    content: "",
  });
  return `module:${relativePath.replace(/\.py$/, "").replaceAll("/", ".")}`;
}

function workspaceSyncNoteForTest(event: WorkspaceSyncEvent) {
  if (event.message) {
    return event.message;
  }
  if (event.status === "syncing") {
    return "Applying external repo changes to the live workspace.";
  }
  if (event.status === "synced") {
    return "Watching the active repo for workspace changes.";
  }
  if (event.status === "manual_resync_required") {
    return "Live sync needs a manual reindex to recover the workspace session.";
  }
  if (event.status === "error") {
    return "Live sync encountered an error.";
  }
  return mockBackendStatus.note;
}

class SyncAwareMockDesktopAdapter extends MockDesktopAdapter {
  private syncListeners = new Set<(event: WorkspaceSyncEvent) => void>();
  backendStatusCallCount = 0;
  overviewCallCount = 0;
  graphViewCallCount = 0;
  private backendStatusState: BackendStatus = {
    ...mockBackendStatus,
  };

  override subscribeWorkspaceSync(onUpdate: (event: WorkspaceSyncEvent) => void): () => void {
    this.syncListeners.add(onUpdate);
    return () => {
      this.syncListeners.delete(onUpdate);
    };
  }

  emitWorkspaceSync(event: WorkspaceSyncEvent) {
    this.backendStatusState = {
      ...this.backendStatusState,
      liveSyncEnabled: event.status === "syncing" || event.status === "synced",
      syncState: event.needsManualResync ? "manual_resync_required" : event.status,
      note: workspaceSyncNoteForTest(event),
      lastSyncError: event.needsManualResync ? event.message : undefined,
      lastError: event.needsManualResync ? event.message : undefined,
    };
    this.syncListeners.forEach((listener) => listener(event));
  }

  override async getBackendStatus() {
    this.backendStatusCallCount += 1;
    return this.backendStatusState;
  }

  override async getOverview() {
    this.overviewCallCount += 1;
    return super.getOverview();
  }

  override async getGraphView(...args: Parameters<MockDesktopAdapter["getGraphView"]>) {
    this.graphViewCallCount += 1;
    return super.getGraphView(...args);
  }
}

class FlowSaveFailureMockDesktopAdapter extends MockDesktopAdapter {
  override async applyStructuralEdit(
    ...args: Parameters<MockDesktopAdapter["applyStructuralEdit"]>
  ) {
    const [request] = args;
    if (request.kind === "replace_flow_graph") {
      throw new Error("Mock flow save failed.");
    }
    return super.applyStructuralEdit(...args);
  }
}

class ImportErrorFlowMockDesktopAdapter extends MockDesktopAdapter {
  override async getFlowView(symbolId: string): Promise<GraphView> {
    const graph = await super.getFlowView(symbolId);
    if (symbolId !== "symbol:helm.ui.api:build_graph_summary") {
      return graph;
    }

    const diagnostics = ["Current source cannot be represented as a visual flow."];
    return {
      ...graph,
      flowState: {
        editable: false,
        syncState: "import_error",
        diagnostics,
        document: graph.flowState?.document
          ? {
              ...graph.flowState.document,
              editable: false,
              syncState: "import_error",
              diagnostics,
            }
          : undefined,
      },
    };
  }
}

class IndexedDraftFlowMockDesktopAdapter extends SyncAwareMockDesktopAdapter {
  override async getFlowView(symbolId: string): Promise<GraphView> {
    const graph = await super.getFlowView(symbolId);
    if (symbolId !== BUILD_GRAPH_SUMMARY_SYMBOL_ID || !graph.flowState?.document) {
      return graph;
    }

    const sourceAssignId = "flow:symbol:helm.ui.api:build_graph_summary:assign:modules";
    const draftAssignId = "flowdoc:symbol:helm.ui.api:build_graph_summary:assign:indexed";
    const diagnostics = ["Draft-backed flow keeps indexed parameter wiring."];
    return {
      ...graph,
      flowState: {
        ...graph.flowState,
        syncState: "draft",
        diagnostics,
        document: {
          ...graph.flowState.document,
          syncState: "draft",
          diagnostics,
          nodes: graph.flowState.document.nodes.map((node) => {
            if (node.id === sourceAssignId) {
              return {
                ...node,
                id: draftAssignId,
                indexedNodeId: sourceAssignId,
              };
            }
            if (node.kind === "entry" && !node.indexedNodeId) {
              return {
                ...node,
                indexedNodeId: node.id,
              };
            }
            return node;
          }),
          edges: graph.flowState.document.edges.map((edge) => ({
            ...edge,
            id: edge.id.replace(sourceAssignId, draftAssignId),
            sourceId: edge.sourceId === sourceAssignId ? draftAssignId : edge.sourceId,
            targetId: edge.targetId === sourceAssignId ? draftAssignId : edge.targetId,
          })),
        },
      },
    };
  }
}

function cloneTestFlowDocument(document: FlowGraphDocument): FlowGraphDocument {
  return JSON.parse(JSON.stringify(document)) as FlowGraphDocument;
}

function importedAddFlowDocument(): FlowGraphDocument {
  return {
    symbolId: ADD_SYMBOL_ID,
    relativePath: "src/helm/ui/api.py",
    qualname: "helm.ui.api.add",
    editable: true,
    syncState: "clean",
    diagnostics: [],
    sourceHash: "indexed-add-fixture",
    valueModelVersion: 1,
    nodes: [
      {
        id: ADD_ENTRY_ID,
        kind: "entry",
        payload: {},
        indexedNodeId: ADD_INDEXED_ENTRY_ID,
      },
      {
        id: ADD_RETURN_ID,
        kind: "return",
        payload: {
          expression: "a + b",
          expression_graph: {
            version: 1,
            rootId: "expr:operator:add",
            nodes: [
              {
                id: "expr:input:a",
                kind: "input",
                label: "a",
                payload: { name: "a", slot_id: ADD_SLOT_A_ID },
              },
              {
                id: "expr:input:b",
                kind: "input",
                label: "b",
                payload: { name: "b", slot_id: ADD_SLOT_B_ID },
              },
              {
                id: "expr:operator:add",
                kind: "operator",
                label: "+",
                payload: { operator: "+" },
              },
            ],
            edges: [
              {
                id: "expr-edge:expr:input:a->expr:operator:add:left",
                sourceId: "expr:input:a",
                sourceHandle: "value",
                targetId: "expr:operator:add",
                targetHandle: "left",
              },
              {
                id: "expr-edge:expr:input:b->expr:operator:add:right",
                sourceId: "expr:input:b",
                sourceHandle: "value",
                targetId: "expr:operator:add",
                targetHandle: "right",
              },
            ],
          },
        },
        indexedNodeId: ADD_INDEXED_RETURN_ID,
      },
      {
        id: ADD_EXIT_ID,
        kind: "exit",
        payload: {},
      },
    ],
    edges: [
      {
        id: `controls:${ADD_ENTRY_ID}:start->${ADD_RETURN_ID}:in`,
        sourceId: ADD_ENTRY_ID,
        sourceHandle: "start",
        targetId: ADD_RETURN_ID,
        targetHandle: "in",
      },
    ],
    functionInputs: [
      { id: ADD_INPUT_A_ID, name: "a", index: 0 },
      { id: ADD_INPUT_B_ID, name: "b", index: 1 },
    ],
    valueSources: [],
    inputSlots: [
      {
        id: ADD_SLOT_A_ID,
        nodeId: ADD_RETURN_ID,
        slotKey: "a",
        label: "a",
        required: true,
      },
      {
        id: ADD_SLOT_B_ID,
        nodeId: ADD_RETURN_ID,
        slotKey: "b",
        label: "b",
        required: true,
      },
    ],
    inputBindings: [
      {
        id: flowInputBindingId(ADD_SLOT_A_ID, ADD_INPUT_A_ID),
        sourceId: ADD_INPUT_A_ID,
        functionInputId: ADD_INPUT_A_ID,
        slotId: ADD_SLOT_A_ID,
      },
      {
        id: flowInputBindingId(ADD_SLOT_B_ID, ADD_INPUT_B_ID),
        sourceId: ADD_INPUT_B_ID,
        functionInputId: ADD_INPUT_B_ID,
        slotId: ADD_SLOT_B_ID,
      },
    ],
  };
}

class ImportedAddFlowMockDesktopAdapter extends SyncAwareMockDesktopAdapter {
  private addDocument = importedAddFlowDocument();
  readonly replacePayloads: FlowGraphDocument[] = [];

  async seedAddSymbol() {
    await super.applyStructuralEdit({
      kind: "create_symbol",
      relativePath: "src/helm/ui/api.py",
      newName: "add",
      symbolKind: "function",
    });
  }

  override async getFlowView(symbolId: string): Promise<GraphView> {
    if (symbolId !== ADD_SYMBOL_ID) {
      return super.getFlowView(symbolId);
    }

    const document = cloneTestFlowDocument(this.addDocument);
    return {
      rootNodeId: ADD_ENTRY_ID,
      targetId: ADD_SYMBOL_ID,
      level: "flow",
      truncated: false,
      breadcrumbs: [
        {
          nodeId: buildRepoSession().id,
          level: "repo",
          label: "H.E.L.M.",
          subtitle: "Architecture map",
        },
        {
          nodeId: "module:helm.ui.api",
          level: "module",
          label: "helm.ui.api",
          subtitle: "src/helm/ui/api.py",
        },
        { nodeId: ADD_SYMBOL_ID, level: "symbol", label: "add", subtitle: "helm.ui.api.add" },
        {
          nodeId: `flow:${ADD_SYMBOL_ID}`,
          level: "flow",
          label: "Flow",
          subtitle: "helm.ui.api.add",
        },
      ],
      focus: {
        targetId: ADD_SYMBOL_ID,
        level: "flow",
        label: "add",
        subtitle: "On-demand flow graph",
        availableLevels: ["repo", "module", "symbol", "flow"],
      },
      nodes: [
        {
          id: ADD_ENTRY_ID,
          kind: "entry",
          label: "Entry",
          subtitle: "helm.ui.api.add",
          x: 0,
          y: 180,
          metadata: {},
          availableActions: [],
        },
        {
          id: ADD_RETURN_ID,
          kind: "return",
          label: "return a + b",
          subtitle: "return",
          x: 420,
          y: 180,
          metadata: {},
          availableActions: [],
        },
        {
          id: ADD_EXIT_ID,
          kind: "exit",
          label: "Exit",
          subtitle: "function exit",
          x: 680,
          y: 180,
          metadata: {},
          availableActions: [],
        },
      ],
      edges: [
        {
          id: `controls:${ADD_ENTRY_ID}:start->${ADD_RETURN_ID}:in`,
          kind: "controls",
          source: ADD_ENTRY_ID,
          target: ADD_RETURN_ID,
          label: "start",
          metadata: {
            source_handle: "start",
            target_handle: "in",
            path_key: "start",
            path_label: "start",
            path_order: 0,
          },
        },
      ],
      flowState: {
        editable: document.editable,
        syncState: document.syncState,
        diagnostics: [...document.diagnostics],
        document,
      },
    };
  }

  override async applyStructuralEdit(
    ...args: Parameters<SyncAwareMockDesktopAdapter["applyStructuralEdit"]>
  ): Promise<StructuralEditResult> {
    const [request] = args;
    if (
      request.kind === "replace_flow_graph" &&
      request.targetId === ADD_SYMBOL_ID &&
      request.flowGraph
    ) {
      const nextDocument: FlowGraphDocument = {
        ...cloneTestFlowDocument(request.flowGraph),
        editable: true,
        syncState: "clean",
        diagnostics: [],
      };
      this.addDocument = cloneTestFlowDocument(nextDocument);
      this.replacePayloads.push(cloneTestFlowDocument(nextDocument));
      const result: StructuralEditResult = {
        request: {
          kind: "replace_flow_graph",
          target_id: ADD_SYMBOL_ID,
          flow_graph: request.flowGraph as unknown as Record<string, unknown>,
        },
        summary: "Updated visual flow for add.",
        touchedRelativePaths: ["src/helm/ui/api.py", ".helm/flow-models.v1.json"],
        reparsedRelativePaths: ["src/helm/ui/api.py"],
        changedNodeIds: [ADD_SYMBOL_ID],
        warnings: [],
        diagnostics: [],
        flowSyncState: "clean" as const,
      };
      return result;
    }

    return super.applyStructuralEdit(...args);
  }
}

describe("WorkspaceScreen", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetStore();
    storedGraphLayoutSnapshots.clear();
    readStoredGraphLayoutMock.mockReset();
    writeStoredGraphLayoutMock.mockReset();
    peekStoredGraphLayoutMock.mockReset();
    readStoredGraphLayoutMock.mockImplementation(
      async (repoPath: string | undefined, viewKey: string | undefined) =>
        getMockStoredGraphLayout(repoPath, viewKey) ??
        cloneStoredGraphLayout(EMPTY_STORED_GRAPH_LAYOUT),
    );
    writeStoredGraphLayoutMock.mockImplementation(
      async (
        repoPath: string | undefined,
        viewKey: string | undefined,
        layout: StoredGraphLayout,
      ) => {
        setMockStoredGraphLayout(repoPath, viewKey, layout);
      },
    );
    peekStoredGraphLayoutMock.mockImplementation(
      (repoPath: string | undefined, viewKey: string | undefined) =>
        getMockStoredGraphLayout(repoPath, viewKey),
    );
    confirmDialogMock.mockReset();
    confirmDialogMock.mockResolvedValue(true);
  });

  it(
    "resizes the explorer panel and restores the saved width",
    async () => {
      const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
        initialEntries: ["/workspace"],
      });

      const firstRender = render(
        <AppProviders adapter={new MockDesktopAdapter()}>
          <RouterProvider router={router} />
        </AppProviders>,
      );

      const layout = await screen.findByTestId("workspace-layout");
      expect(layout.style.gridTemplateColumns).toContain("260px");

      const resizeHandle = screen.getByTestId("workspace-sidebar-resize");
      fireEvent.pointerDown(resizeHandle, { clientX: 260 });
      fireEvent.mouseMove(window, { clientX: 348 });
      fireEvent.mouseUp(window);

      await waitFor(() => {
        expect(layout.style.gridTemplateColumns).toContain("348px");
      });

      firstRender.unmount();

      const rerenderedRouter = createMemoryRouter(
        [{ path: "/workspace", element: <WorkspaceScreen /> }],
        { initialEntries: ["/workspace"] },
      );

      render(
        <AppProviders adapter={new MockDesktopAdapter()}>
          <RouterProvider router={rerenderedRouter} />
        </AppProviders>,
      );

      const restoredLayout = await screen.findByTestId("workspace-layout");
      await waitFor(() => {
        expect(restoredLayout.style.gridTemplateColumns).toContain("348px");
      });
    },
    WORKSPACE_TEST_TIMEOUT_MS,
  );

  it(
    "creates and edits non-Python text files from the explorer without replacing the graph",
    async () => {
      const user = userEvent.setup();
      const adapter = new MockDesktopAdapter();
      const saveSpy = vi.spyOn(adapter, "saveWorkspaceFile");
      const deleteSpy = vi.spyOn(adapter, "deleteWorkspaceEntry");
      const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
        initialEntries: ["/workspace"],
      });

      render(
        <AppProviders adapter={adapter}>
          <RouterProvider router={router} />
        </AppProviders>,
      );

      await user.click(await screen.findByRole("button", { name: "New File" }));

      const filePathInput = await screen.findByRole("textbox", { name: "New file path" });
      await user.clear(filePathInput);
      await user.type(filePathInput, "README.md");
      await user.click(screen.getByRole("button", { name: "Create" }));

      expect(document.querySelector(".graph-panel")).toBeInTheDocument();

      const editor = await screen.findByRole("textbox", { name: /Edit README\.md/i });
      fireEvent.change(editor, { target: { value: "# Hello\n" } });

      const editorPanel = screen
        .getByTestId("workspace-file-editor")
        .closest(".workspace-file-editor");
      expect(editorPanel).not.toBeNull();
      await user.click(within(editorPanel as HTMLElement).getByRole("button", { name: "Save" }));

      await waitFor(() => expect(saveSpy).toHaveBeenCalledTimes(1));
      expect(saveSpy.mock.calls[0]?.[0]).toBe(defaultRepoPath);
      expect(saveSpy.mock.calls[0]?.[1]).toBe("README.md");
      expect(saveSpy.mock.calls[0]?.[2]).toBe("# Hello\n");

      await waitFor(() =>
        expect(screen.getByRole("textbox", { name: /Edit README\.md/i })).toHaveValue("# Hello\n"),
      );
      await waitFor(() => {
        expect(
          within(editorPanel as HTMLElement).getByRole("button", { name: "Save" }),
        ).toBeDisabled();
      });

      fireEvent.contextMenu(screen.getByRole("treeitem", { name: "README.md" }), {
        clientX: 120,
        clientY: 80,
      });
      await user.click(screen.getByRole("menuitem", { name: "Delete" }));

      await waitFor(() => expect(deleteSpy).toHaveBeenCalledTimes(1));
      expect(deleteSpy).toHaveBeenCalledWith(defaultRepoPath, {
        relativePath: "README.md",
      });
      await waitFor(() =>
        expect(screen.queryByRole("textbox", { name: /Edit README\.md/i })).not.toBeInTheDocument(),
      );
    },
    WORKSPACE_TEST_TIMEOUT_MS,
  );

  it(
    "lets newly created Python modules be typed in from the inspector",
    async () => {
      const user = userEvent.setup();
      const adapter = new MockDesktopAdapter();
      const saveSourceSpy = vi.spyOn(adapter, "saveNodeSource");
      const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
        initialEntries: ["/workspace"],
      });

      render(
        <AppProviders adapter={adapter}>
          <RouterProvider router={router} />
        </AppProviders>,
      );

      await user.click(await screen.findByRole("button", { name: "New File" }));

      const filePathInput = await screen.findByRole("textbox", { name: "New file path" });
      await user.clear(filePathInput);
      await user.type(filePathInput, "test.py");
      await user.click(screen.getByRole("button", { name: "Create" }));

      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: /Expand inspector for test/i }),
        ).toBeInTheDocument(),
      );
      await user.click(screen.getByRole("button", { name: /Expand inspector for test/i }));

      const editor = await screen.findByRole("textbox", { name: /Module source editor/i });
      fireEvent.change(editor, {
        target: { value: "VALUE = 1" },
      });
      expect(editor).toHaveValue("VALUE = 1");

      const inspectorDrawer = await screen.findByTestId("blueprint-inspector-drawer");
      await user.click(within(inspectorDrawer).getByRole("button", { name: /Save/i }));

      await waitFor(() => expect(saveSourceSpy).toHaveBeenCalledTimes(1));
      expect(saveSourceSpy).toHaveBeenCalledWith("module:test", "VALUE = 1");
      await waitFor(() =>
        expect(screen.getByRole("textbox", { name: /Module source editor/i })).toHaveValue(
          "VALUE = 1",
        ),
      );
    },
    WORKSPACE_TEST_TIMEOUT_MS,
  );

  it(
    "keeps single click selection-only and uses explicit enter/inspect actions",
    async () => {
      const user = userEvent.setup();
      const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
        initialEntries: ["/workspace"],
      });

      render(
        <AppProviders adapter={new MockDesktopAdapter()}>
          <RouterProvider router={router} />
        </AppProviders>,
      );

      expect(await screen.findByText(/Architecture graph/i)).toBeInTheDocument();
      expect(
        await screen.findByText(/Repo root: .*Documents\/git-repos\/H\.E\.L\.M\./i),
      ).toBeInTheDocument();

      const graphPanel = document.querySelector(".graph-panel");
      expect(graphPanel).not.toBeNull();
      const graph = within(graphPanel as HTMLElement);

      fireEvent.click(await graph.findByText("api.py"));

      const rootPathTrail = screen.getByRole("navigation", { name: /Graph path/i });
      expect(within(rootPathTrail).getByText("H.E.L.M.")).toBeInTheDocument();
      expect(within(rootPathTrail).queryByText("api.py")).not.toBeInTheDocument();
      expect(screen.queryByText(/Declaration editor/i)).not.toBeInTheDocument();

      fireEvent.doubleClick(await graph.findByText("api.py"));

      const graphContextDrawer = await screen.findByTestId("blueprint-inspector-drawer");
      expect(graphContextDrawer).toHaveAttribute("data-mode", "collapsed");
      expect(within(graphContextDrawer).getByText("api.py")).toBeInTheDocument();
      expect(within(graphContextDrawer).getByText("module")).toBeInTheDocument();

      await waitFor(() =>
        expect(
          within(screen.getByRole("navigation", { name: /Graph path/i })).getByText("api.py"),
        ).toBeInTheDocument(),
      );

      const functionNode = (await graph.findByText("build_graph_summary")).closest(".graph-node");
      expect(functionNode).not.toBeNull();
      fireEvent.click(within(functionNode as HTMLElement).getByText("Inspect"));

      expect(await screen.findByTestId("blueprint-inspector-drawer")).toHaveAttribute(
        "data-mode",
        "expanded",
      );
      expect(await screen.findByText(/Declaration editor/i)).toBeInTheDocument();
      expect(
        await screen.findByRole("button", { name: /Open File In Default Editor/i }),
      ).toBeInTheDocument();
      expect(await screen.findByRole("button", { name: /Open flow/i })).toBeInTheDocument();
      expect(await screen.findByRole("button", { name: /Open blueprint/i })).toBeInTheDocument();
      expect(
        (
          (await screen.findByRole("textbox", {
            name: /Function source editor/i,
          })) as HTMLTextAreaElement
        ).value,
      ).toMatch(/def build_graph_summary/i);

      const graphPane = (graphPanel as HTMLElement).querySelector(".react-flow__pane");
      expect(graphPane).not.toBeNull();
      await user.click(graphPane as HTMLElement);

      const expandedDrawer = await screen.findByTestId("blueprint-inspector-drawer");
      expect(expandedDrawer).toHaveAttribute("data-mode", "expanded");
      expect(
        within(expandedDrawer).getByRole("heading", { name: /Current Context/i }),
      ).toBeInTheDocument();
      expect(within(expandedDrawer).getAllByText("src/helm/ui/api.py").length).toBeGreaterThan(0);
      expect(within(expandedDrawer).queryByText(/Nothing selected/i)).not.toBeInTheDocument();
      const moduleEditor = await screen.findByRole(
        "textbox",
        { name: /Module source editor/i },
        { timeout: WORKSPACE_TEST_TIMEOUT_MS },
      );
      expect((moduleEditor as HTMLTextAreaElement).value).toMatch(/def build_graph_summary/i);
      expect(within(expandedDrawer).getByText(/Source editor/i)).toBeInTheDocument();
      expect(useUiStore.getState().activeNodeId).toBeUndefined();
    },
    WORKSPACE_TEST_TIMEOUT_MS,
  );

  it(
    "keeps sync progress inline and defers heavy refreshes until sync completes",
    async () => {
      const adapter = new SyncAwareMockDesktopAdapter();
      const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
        initialEntries: ["/workspace"],
      });

      const _rendered = render(
        <AppProviders adapter={adapter}>
          <RouterProvider router={router} />
        </AppProviders>,
      );

      expect(await screen.findByText(/Architecture graph/i)).toBeInTheDocument();
      await waitFor(() => {
        expect(adapter.overviewCallCount).toBeGreaterThan(0);
        expect(adapter.graphViewCallCount).toBeGreaterThan(0);
        expect(adapter.backendStatusCallCount).toBeGreaterThan(0);
      });

      const initialOverviewCallCount = adapter.overviewCallCount;
      const initialGraphViewCallCount = adapter.graphViewCallCount;
      const initialBackendStatusCallCount = adapter.backendStatusCallCount;

      act(() => {
        adapter.emitWorkspaceSync({
          repoPath: defaultRepoPath,
          sessionVersion: 2,
          reason: "external-change",
          status: "syncing",
          changedRelativePaths: ["src/helm/ui/api.py"],
          needsManualResync: false,
          message: "Parsing src/helm/ui/api.py",
        });
      });

      await waitFor(() => {
        expect(adapter.backendStatusCallCount).toBeGreaterThan(initialBackendStatusCallCount);
      });
      expect(adapter.overviewCallCount).toBe(initialOverviewCallCount);
      expect(adapter.graphViewCallCount).toBe(initialGraphViewCallCount);
      expect(await screen.findByText(/Parsing src\/helm\/ui\/api\.py/i)).toBeInTheDocument();

      act(() => {
        adapter.emitWorkspaceSync({
          repoPath: defaultRepoPath,
          sessionVersion: 3,
          reason: "external-change",
          status: "synced",
          changedRelativePaths: ["src/helm/ui/api.py"],
          needsManualResync: false,
          message: "Watching the active repo for workspace changes.",
          snapshot: {
            repoId: buildRepoSession().id,
            defaultFocusNodeId: "symbol:helm.ui.api:build_graph_summary",
            defaultLevel: "symbol",
            nodeIds: ["symbol:helm.ui.api:build_graph_summary"],
          },
        });
      });

      await waitFor(() => {
        expect(adapter.graphViewCallCount).toBeGreaterThan(initialGraphViewCallCount);
      });
    },
    WORKSPACE_TEST_TIMEOUT_MS,
  );

  it("updates the active inspector target when another inspectable node is selected while visible", async () => {
    const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
      initialEntries: ["/workspace"],
    });

    render(
      <AppProviders adapter={new MockDesktopAdapter()}>
        <RouterProvider router={router} />
      </AppProviders>,
    );

    const graphPanel = document.querySelector(".graph-panel");
    expect(graphPanel).not.toBeNull();
    const graph = within(graphPanel as HTMLElement);

    fireEvent.doubleClick(await graph.findByText("api.py"));

    const functionNode = (await graph.findByText("build_graph_summary")).closest(".graph-node");
    expect(functionNode).not.toBeNull();
    fireEvent.click(within(functionNode as HTMLElement).getByText("Inspect"));

    const drawer = await screen.findByTestId("blueprint-inspector-drawer");
    expect(
      within(drawer).getByRole("heading", { name: "build_graph_summary" }),
    ).toBeInTheDocument();

    fireEvent.click(await graph.findByText("GraphSummary"));

    await waitFor(() =>
      expect(
        within(screen.getByTestId("blueprint-inspector-drawer")).getByRole("heading", {
          name: "GraphSummary",
        }),
      ).toBeInTheDocument(),
    );
  });

  it("updates the inspector when a grouped inspectable node is selected", async () => {
    readStoredGraphLayoutMock
      .mockResolvedValueOnce(EMPTY_STORED_GRAPH_LAYOUT)
      .mockResolvedValueOnce(GROUPED_SYMBOL_LAYOUT);

    const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
      initialEntries: ["/workspace"],
    });

    render(
      <AppProviders adapter={new MockDesktopAdapter()}>
        <RouterProvider router={router} />
      </AppProviders>,
    );

    const graphPanel = document.querySelector(".graph-panel");
    expect(graphPanel).not.toBeNull();
    const graph = within(graphPanel as HTMLElement);

    fireEvent.doubleClick(await graph.findByText("api.py"));

    const functionNode = (await graph.findByText("build_graph_summary")).closest(".graph-node");
    expect(functionNode).not.toBeNull();
    fireEvent.click(within(functionNode as HTMLElement).getByText("Inspect"));

    const drawer = await screen.findByTestId("blueprint-inspector-drawer");
    expect(
      within(drawer).getByRole("heading", { name: "build_graph_summary" }),
    ).toBeInTheDocument();

    fireEvent.click(await graph.findByText("GraphSummary"), { ctrlKey: true });

    await waitFor(() =>
      expect(
        within(screen.getByTestId("blueprint-inspector-drawer")).getByRole("heading", {
          name: "GraphSummary",
        }),
      ).toBeInTheDocument(),
    );

    fireEvent.click(await graph.findByText("build_graph_summary"));

    await waitFor(() =>
      expect(
        within(screen.getByTestId("blueprint-inspector-drawer")).getByRole("heading", {
          name: "build_graph_summary",
        }),
      ).toBeInTheDocument(),
    );
  });

  it("shows a collapsed peek rail for the current inspectable selection before full inspect", async () => {
    const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
      initialEntries: ["/workspace"],
    });

    render(
      <AppProviders adapter={new MockDesktopAdapter()}>
        <RouterProvider router={router} />
      </AppProviders>,
    );

    const graphPanel = document.querySelector(".graph-panel");
    expect(graphPanel).not.toBeNull();
    const graph = within(graphPanel as HTMLElement);

    fireEvent.doubleClick(await graph.findByText("api.py"));
    fireEvent.click(await graph.findByText("build_graph_summary"));

    const drawer = await screen.findByTestId("blueprint-inspector-drawer");
    expect(drawer).toHaveAttribute("data-mode", "collapsed");
    expect(within(drawer).getByText("build_graph_summary")).toBeInTheDocument();
    expect(within(drawer).getByText("function")).toBeInTheDocument();
    expect(
      within(drawer).getByRole("button", { name: /Open File In Default Editor/i }),
    ).toBeInTheDocument();
    expect(within(drawer).getByRole("button", { name: /Open flow/i })).toBeInTheDocument();
    expect(within(drawer).getByRole("button", { name: /Open blueprint/i })).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("blueprint-inspector-drawer-toggle"));
    expect(await screen.findByTestId("blueprint-inspector-drawer")).toHaveAttribute(
      "data-mode",
      "expanded",
    );
    expect(await screen.findByText(/Declaration editor/i)).toBeInTheDocument();
  });

  it(
    "enters create mode from the graph, clears sticky inspector selection, and shows the mode chrome",
    async () => {
      const _user = userEvent.setup();
      const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
        initialEntries: ["/workspace"],
      });

      render(
        <AppProviders adapter={new MockDesktopAdapter()}>
          <RouterProvider router={router} />
        </AppProviders>,
      );

      const graphPanel = document.querySelector(".graph-panel");
      expect(graphPanel).not.toBeNull();
      const graph = within(graphPanel as HTMLElement);

      fireEvent.doubleClick(await graph.findByText("api.py"));
      const functionNode = (await graph.findByText("build_graph_summary")).closest(".graph-node");
      expect(functionNode).not.toBeNull();
      fireEvent.click(within(functionNode as HTMLElement).getByText("Inspect"));
      expect(
        await screen.findByRole("heading", { name: "build_graph_summary" }),
      ).toBeInTheDocument();

      (graphPanel as HTMLElement).focus();
      fireEvent.keyDown(graphPanel as HTMLElement, { key: "c" });

      expect(await screen.findByTestId("graph-create-mode-badge")).toHaveTextContent(
        /Create mode/i,
      );
      expect(screen.getByTestId("graph-create-mode-watermark")).toHaveTextContent("CREATE MODE");
      expect(
        screen.getByText("Click the graph to create a function or class in src/helm/ui/api.py."),
      ).toBeInTheDocument();
      expect(await screen.findByRole("heading", { name: /Current Context/i })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: /Nothing selected/i })).not.toBeInTheDocument();
      const moduleEditor = await screen.findByRole(
        "textbox",
        { name: /Module source editor/i },
        { timeout: WORKSPACE_TEST_TIMEOUT_MS },
      );
      expect((moduleEditor as HTMLTextAreaElement).value).toMatch(/def build_graph_summary/i);
      expect(await screen.findByText(/Source editor/i)).toBeInTheDocument();
      expect(useUiStore.getState().activeNodeId).toBeUndefined();
    },
    WORKSPACE_TEST_TIMEOUT_MS,
  );

  it(
    "does not enter create mode while typing in the inspector editor",
    async () => {
      const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
        initialEntries: ["/workspace"],
      });

      render(
        <AppProviders adapter={new MockDesktopAdapter()}>
          <RouterProvider router={router} />
        </AppProviders>,
      );

      const graphPanel = document.querySelector(".graph-panel");
      expect(graphPanel).not.toBeNull();
      const graph = within(graphPanel as HTMLElement);

      fireEvent.doubleClick(await graph.findByText("api.py"));
      const functionNode = (await graph.findByText("build_graph_summary")).closest(".graph-node");
      expect(functionNode).not.toBeNull();
      fireEvent.click(within(functionNode as HTMLElement).getByText("Inspect"));

      const editor = await screen.findByRole("textbox", { name: /Function source editor/i });
      fireEvent.keyDown(editor, { key: "c" });

      expect(screen.queryByTestId("graph-create-mode-badge")).not.toBeInTheDocument();
    },
    WORKSPACE_TEST_TIMEOUT_MS,
  );

  it(
    "prompts for unsaved changes before entering create mode and saves when confirmed",
    async () => {
      const adapter = new MockDesktopAdapter();
      const saveSpy = vi.spyOn(adapter, "saveNodeSource");
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
      const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
        initialEntries: ["/workspace"],
      });

      const _rendered = render(
        <AppProviders adapter={adapter}>
          <RouterProvider router={router} />
        </AppProviders>,
      );

      const graphPanel = document.querySelector(".graph-panel");
      expect(graphPanel).not.toBeNull();
      const graph = within(graphPanel as HTMLElement);

      fireEvent.doubleClick(await graph.findByText("api.py"));
      const functionNode = (await graph.findByText("build_graph_summary")).closest(".graph-node");
      expect(functionNode).not.toBeNull();
      fireEvent.click(within(functionNode as HTMLElement).getByText("Inspect"));

      fireEvent.change(await screen.findByRole("textbox", { name: /Function source editor/i }), {
        target: {
          value:
            "def build_graph_summary(graph):\n    return GraphSummary(repo_path='.', module_count=1)\n",
        },
      });

      (graphPanel as HTMLElement).focus();
      fireEvent.keyDown(graphPanel as HTMLElement, { key: "c" });

      await waitFor(() => {
        expect(confirmSpy).toHaveBeenCalled();
        expect(saveSpy).toHaveBeenCalled();
      });
      expect(await screen.findByTestId("graph-create-mode-badge")).toBeInTheDocument();
      expect(await screen.findByRole("heading", { name: /Current Context/i })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: /Nothing selected/i })).not.toBeInTheDocument();
    },
    WORKSPACE_TEST_TIMEOUT_MS,
  );

  it(
    "prompts for unsaved changes before entering create mode and discards when declined",
    async () => {
      const adapter = new MockDesktopAdapter();
      const saveSpy = vi.spyOn(adapter, "saveNodeSource");
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
      const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
        initialEntries: ["/workspace"],
      });

      const _rendered = render(
        <AppProviders adapter={adapter}>
          <RouterProvider router={router} />
        </AppProviders>,
      );

      const graphPanel = document.querySelector(".graph-panel");
      expect(graphPanel).not.toBeNull();
      const graph = within(graphPanel as HTMLElement);

      fireEvent.doubleClick(await graph.findByText("api.py"));
      const functionNode = (await graph.findByText("build_graph_summary")).closest(".graph-node");
      expect(functionNode).not.toBeNull();
      fireEvent.click(within(functionNode as HTMLElement).getByText("Inspect"));

      fireEvent.change(await screen.findByRole("textbox", { name: /Function source editor/i }), {
        target: {
          value:
            "def build_graph_summary(graph):\n    return GraphSummary(repo_path='.', module_count=2)\n",
        },
      });

      (graphPanel as HTMLElement).focus();
      fireEvent.keyDown(graphPanel as HTMLElement, { key: "c" });

      await waitFor(() => {
        expect(confirmSpy).toHaveBeenCalled();
        expect(saveSpy).not.toHaveBeenCalled();
      });
      expect(await screen.findByTestId("graph-create-mode-badge")).toBeInTheDocument();
      expect(await screen.findByRole("heading", { name: /Current Context/i })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: /Nothing selected/i })).not.toBeInTheDocument();
    },
    WORKSPACE_TEST_TIMEOUT_MS,
  );

  it(
    "creates a module from repo view create mode and selects it",
    async () => {
      const user = userEvent.setup();
      const repoSession = buildRepoSession();
      setGraphFocusForTest({
        targetId: repoSession.id,
        level: "repo",
        activeNodeId: undefined,
        activeSymbolId: undefined,
      });

      const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
        initialEntries: ["/workspace"],
      });

      render(
        <AppProviders adapter={new MockDesktopAdapter()}>
          <RouterProvider router={router} />
        </AppProviders>,
      );

      const graphPanel = document.querySelector(".graph-panel");
      expect(graphPanel).not.toBeNull();
      await waitFor(() =>
        expect((graphPanel as HTMLElement).querySelector(".react-flow__pane")).not.toBeNull(),
      );
      const graphPane = (graphPanel as HTMLElement).querySelector(".react-flow__pane");

      (graphPanel as HTMLElement).focus();
      fireEvent.keyDown(graphPanel as HTMLElement, { key: "c" });
      expect(
        await screen.findByText("Click the graph to place a new Python module."),
      ).toBeInTheDocument();

      await user.click(graphPane as HTMLElement);

      expect(await screen.findByRole("heading", { name: /Create module/i })).toBeInTheDocument();
      await user.type(screen.getByRole("textbox", { name: /Module path/i }), "pkg/new_module.py");
      await user.type(screen.getByRole("textbox", { name: /Module starter source/i }), "VALUE = 1");
      await user.click(screen.getByRole("button", { name: /Create module/i }));

      await waitFor(() => {
        expect(useUiStore.getState().activeLevel).toBe("repo");
        expect(useUiStore.getState().activeNodeId).toBe("module:pkg.new_module");
      });
      expect(screen.getByText("pkg")).toBeInTheDocument();
      expect(screen.getByTestId("graph-create-mode-badge")).toBeInTheDocument();
    },
    WORKSPACE_TEST_TIMEOUT_MS,
  );

  it(
    "creates a function from module view create mode and keeps create mode active",
    async () => {
      const user = userEvent.setup();
      setGraphFocusForTest({
        targetId: "module:helm.ui.api",
        level: "module",
        activeNodeId: undefined,
        activeSymbolId: undefined,
      });

      const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
        initialEntries: ["/workspace"],
      });

      render(
        <AppProviders adapter={new MockDesktopAdapter()}>
          <RouterProvider router={router} />
        </AppProviders>,
      );

      const graphPanel = document.querySelector(".graph-panel");
      expect(graphPanel).not.toBeNull();
      await waitFor(() =>
        expect((graphPanel as HTMLElement).querySelector(".react-flow__pane")).not.toBeNull(),
      );
      const graphPane = (graphPanel as HTMLElement).querySelector(".react-flow__pane");

      (graphPanel as HTMLElement).focus();
      fireEvent.keyDown(graphPanel as HTMLElement, { key: "c" });
      await user.click(graphPane as HTMLElement);

      expect(await screen.findByRole("heading", { name: /Create symbol/i })).toBeInTheDocument();
      expect(screen.getByText("src/helm/ui/api.py")).toBeInTheDocument();
      await user.type(screen.getByRole("textbox", { name: /Symbol name/i }), "build_issue_one");
      await user.click(screen.getByRole("button", { name: /Create function/i }));

      await waitFor(() => {
        expect(useUiStore.getState().activeLevel).toBe("module");
        expect(useUiStore.getState().activeNodeId).toBe("symbol:helm.ui.api:build_issue_one");
      });
      expect(screen.getAllByText("build_issue_one").length).toBeGreaterThan(0);
      expect(screen.getByTestId("graph-create-mode-badge")).toBeInTheDocument();
    },
    WORKSPACE_TEST_TIMEOUT_MS,
  );

  it(
    "uses the parent module path when creating a class from symbol view create mode",
    async () => {
      const user = userEvent.setup();
      const adapter = new MockDesktopAdapter();
      const editSpy = vi.spyOn(adapter, "applyStructuralEdit");
      setGraphFocusForTest({
        targetId: "symbol:helm.ui.api:build_graph_summary",
        level: "symbol",
        activeNodeId: undefined,
        activeSymbolId: "symbol:helm.ui.api:build_graph_summary",
      });

      const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
        initialEntries: ["/workspace"],
      });

      render(
        <AppProviders adapter={adapter}>
          <RouterProvider router={router} />
        </AppProviders>,
      );

      const graphPanel = document.querySelector(".graph-panel");
      expect(graphPanel).not.toBeNull();
      await waitFor(() =>
        expect((graphPanel as HTMLElement).querySelector(".react-flow__pane")).not.toBeNull(),
      );
      const graphPane = (graphPanel as HTMLElement).querySelector(".react-flow__pane");

      (graphPanel as HTMLElement).focus();
      fireEvent.keyDown(graphPanel as HTMLElement, { key: "c" });
      await user.click(graphPane as HTMLElement);

      expect(await screen.findByRole("heading", { name: /Create symbol/i })).toBeInTheDocument();
      expect(screen.getByText("src/helm/ui/api.py")).toBeInTheDocument();
      await user.selectOptions(screen.getByRole("combobox", { name: /Symbol type/i }), "class");
      await user.type(screen.getByRole("textbox", { name: /Symbol name/i }), "GraphBuilder");
      await user.click(screen.getByRole("button", { name: /Create class/i }));

      await waitFor(() =>
        expect(editSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            kind: "create_symbol",
            relativePath: "src/helm/ui/api.py",
            newName: "GraphBuilder",
            symbolKind: "class",
          }),
        ),
      );
      await waitFor(() => {
        expect(useUiStore.getState().activeNodeId).toBe("symbol:helm.ui.api:GraphBuilder");
      });
      expect(useUiStore.getState().activeLevel).toBe("module");
      expect(screen.getAllByText("GraphBuilder").length).toBeGreaterThan(0);
    },
    WORKSPACE_TEST_TIMEOUT_MS,
  );

  it(
    "shows the flow owner source when the flow canvas selection is cleared",
    async () => {
      const user = userEvent.setup();
      const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
        initialEntries: ["/workspace"],
      });

      render(
        <AppProviders adapter={new MockDesktopAdapter()}>
          <RouterProvider router={router} />
        </AppProviders>,
      );

      const { flowGraphPanel } = await openBuildGraphSummaryFlow(user);
      const ownerEditor = await screen.findByRole("textbox", { name: /Function source editor/i });
      expect((ownerEditor as HTMLTextAreaElement).value).toMatch(/def build_graph_summary/i);

      const graphPane = flowGraphPanel.querySelector(".react-flow__pane");
      expect(graphPane).not.toBeNull();
      await user.click(graphPane as HTMLElement);

      await waitFor(() => {
        expect(useUiStore.getState().activeNodeId).toBeUndefined();
      });
      expect(await screen.findByRole("heading", { name: /Current Context/i })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: /Nothing selected/i })).not.toBeInTheDocument();
      expect(screen.getByTestId("inspector-inline-editor")).not.toHaveAttribute(
        "data-highlight-start-line",
      );
      expect(
        (screen.getByRole("textbox", { name: /Function source editor/i }) as HTMLTextAreaElement)
          .value,
      ).toMatch(/def build_graph_summary/i);
    },
    WORKSPACE_TEST_TIMEOUT_MS,
  );

  it(
    "keeps the full flow owner source visible and highlights the selected flow node range",
    async () => {
      const user = userEvent.setup();
      const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
        initialEntries: ["/workspace"],
      });

      render(
        <AppProviders adapter={new MockDesktopAdapter()}>
          <RouterProvider router={router} />
        </AppProviders>,
      );

      await openBuildGraphSummaryFlow(user);

      fireEvent.click(
        await screen.findByTestId(`rf__node-${BUILD_GRAPH_SUMMARY_ASSIGN_MODULES_ID}`),
      );
      await waitFor(() => {
        expect(useUiStore.getState().activeNodeId).toBe(BUILD_GRAPH_SUMMARY_ASSIGN_MODULES_ID);
      });

      expect(await screen.findByRole("heading", { name: /Selection/i })).toBeInTheDocument();
      expect(
        (screen.getByRole("textbox", { name: /Function source editor/i }) as HTMLTextAreaElement)
          .value,
      ).toMatch(/def build_graph_summary/i);
      expect(screen.getByTestId("inspector-inline-editor")).toHaveAttribute(
        "data-highlight-start-line",
        "19",
      );
      expect(screen.getByTestId("inspector-inline-editor")).toHaveAttribute(
        "data-highlight-end-line",
        "19",
      );
    },
    WORKSPACE_TEST_TIMEOUT_MS,
  );

  it(
    "opens the flow composer from empty canvas, seeds the spawned node layout, and keeps node clicks selection-only",
    async () => {
      const user = userEvent.setup();
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
        () =>
          ({
            x: 0,
            y: 0,
            top: 0,
            left: 0,
            right: 240,
            bottom: 96,
            width: 240,
            height: 96,
            toJSON: () => ({}),
          }) as DOMRect,
      );
      const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
        initialEntries: ["/workspace"],
      });

      render(
        <AppProviders adapter={new MockDesktopAdapter()}>
          <RouterProvider router={router} />
        </AppProviders>,
      );

      const graphPanel = document.querySelector(".graph-panel");
      expect(graphPanel).not.toBeNull();
      const graph = within(graphPanel as HTMLElement);

      fireEvent.doubleClick(await graph.findByText("api.py"));
      const functionNode = (await graph.findByText("build_graph_summary")).closest(".graph-node");
      expect(functionNode).not.toBeNull();
      fireEvent.click(within(functionNode as HTMLElement).getByText("Inspect"));
      await user.click(await screen.findByRole("button", { name: /Open flow/i }));
      const flowGraphPanel = await waitForFunctionFlowReady("build_graph_summary");
      const flowGraph = within(flowGraphPanel);
      expect(await screen.findByRole("heading", { name: /Internal flow/i })).toBeInTheDocument();
      expect((await flowGraph.findAllByText(/module_summaries/i)).length).toBeGreaterThan(0);

      const graphPane = await ensureFlowCreateMode(flowGraphPanel);
      expect(screen.getByTestId("graph-create-mode-badge")).toBeInTheDocument();
      expect(screen.getByTestId("graph-create-mode-hint")).toHaveTextContent(
        "Click empty canvas to create a flow node in this draft.",
      );
      expect(
        screen.queryByTestId(
          "graph-edge:controls:flow:symbol:helm.ui.api:build_graph_summary:entry:start->flow:symbol:helm.ui.api:build_graph_summary:assign:modules:in",
        ),
      ).not.toBeInTheDocument();
      const initialLayoutWriteCount = writeStoredGraphLayoutMock.mock.calls.length;
      const firstClick = { clientX: 180, clientY: 140 };

      fireEvent.click(graphPane, firstClick);

      const composer = await screen.findByTestId("graph-create-composer");
      expect(await screen.findByRole("heading", { name: /Create flow node/i })).toBeInTheDocument();
      expect(composer).toHaveStyle({
        left: "12px",
        top: "12px",
      });
      await user.type(
        screen.getByRole("textbox", { name: /Flow statement/i }),
        "helper = rank_modules(graph)",
      );
      await user.click(screen.getByRole("button", { name: /Create node/i }));

      expect((await screen.findAllByText(/rank_modules/i)).length).toBeGreaterThan(0);
      expect(useUiStore.getState().activeLevel).toBe("flow");
      const createdNodeId = useUiStore.getState().activeNodeId;
      expect(createdNodeId).toMatch(/^flowdoc:symbol:helm\.ui\.api:build_graph_summary:assign:/);
      await waitFor(() =>
        expect(writeStoredGraphLayoutMock.mock.calls.length).toBeGreaterThan(
          initialLayoutWriteCount,
        ),
      );
      expect(
        lastWrittenGraphLayout()?.nodes[graphLayoutNodeKey(createdNodeId ?? "", "assign")],
      ).toEqual({
        x: firstClick.clientX,
        y: firstClick.clientY,
      });
      const createdNodeHost = await flowGraph.findByTestId(`rf__node-${createdNodeId}`);
      await waitFor(() => {
        expect(createdNodeHost.style.transform).toContain(
          `translate(${firstClick.clientX}px,${firstClick.clientY}px)`,
        );
      });
      await waitFor(() => {
        expect(
          screen.queryByRole("heading", { name: /Create flow node/i }),
        ).not.toBeInTheDocument();
      });

      fireEvent.click(
        await flowGraph.findByTestId(
          "rf__node-flow:symbol:helm.ui.api:build_graph_summary:assign:modules",
        ),
      );
      expect(screen.queryByRole("heading", { name: /Create flow node/i })).not.toBeInTheDocument();
      expect(useUiStore.getState().activeNodeId).toBe(
        "flow:symbol:helm.ui.api:build_graph_summary:assign:modules",
      );
      expect((await flowGraph.findByTestId(`rf__node-${createdNodeId}`)).style.transform).toContain(
        `translate(${firstClick.clientX}px,${firstClick.clientY}px)`,
      );
      expect((await screen.findAllByText(/rank_modules/i)).length).toBeGreaterThan(0);

      fireEvent.click(graphPane, { clientX: 260, clientY: 200 });
      expect(await screen.findByRole("heading", { name: /Create flow node/i })).toBeInTheDocument();
      fireEvent.keyDown(window, { key: "Escape" });
      await waitFor(() => {
        expect(
          screen.queryByRole("heading", { name: /Create flow node/i }),
        ).not.toBeInTheDocument();
      });
      expect((await screen.findAllByText(/rank_modules/i)).length).toBeGreaterThan(0);
      expect(screen.getByTestId("graph-create-mode-badge")).toBeInTheDocument();
    },
    WORKSPACE_TEST_TIMEOUT_MS,
  );

  it(
    "creates multiple disconnected flow nodes in succession from empty-canvas clicks",
    async () => {
      const user = userEvent.setup();
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
        () =>
          ({
            x: 0,
            y: 0,
            top: 0,
            left: 0,
            right: 240,
            bottom: 96,
            width: 240,
            height: 96,
            toJSON: () => ({}),
          }) as DOMRect,
      );
      const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
        initialEntries: ["/workspace"],
      });

      render(
        <AppProviders adapter={new MockDesktopAdapter()}>
          <RouterProvider router={router} />
        </AppProviders>,
      );

      const graphPanel = document.querySelector(".graph-panel");
      expect(graphPanel).not.toBeNull();
      const graph = within(graphPanel as HTMLElement);

      fireEvent.doubleClick(await graph.findByText("api.py"));
      const functionNode = (await graph.findByText("build_graph_summary")).closest(".graph-node");
      expect(functionNode).not.toBeNull();
      fireEvent.click(within(functionNode as HTMLElement).getByText("Inspect"));
      await user.click(await screen.findByRole("button", { name: /Open flow/i }));
      const flowGraphPanel = await waitForFunctionFlowReady("build_graph_summary");
      const flowGraph = within(flowGraphPanel);

      const graphPane = await ensureFlowCreateMode(flowGraphPanel);

      fireEvent.click(graphPane, { clientX: 160, clientY: 120 });
      await user.type(
        screen.getByRole("textbox", { name: /Flow statement/i }),
        "helper = rank_modules(graph)",
      );
      await user.click(screen.getByRole("button", { name: /Create node/i }));
      const firstCreatedNodeId = useUiStore.getState().activeNodeId;
      expect(firstCreatedNodeId).toMatch(
        /^flowdoc:symbol:helm\.ui\.api:build_graph_summary:assign:/,
      );
      expect(screen.getByTestId("graph-create-mode-badge")).toBeInTheDocument();
      await waitFor(() => {
        expect(
          screen.queryByRole("heading", { name: /Create flow node/i }),
        ).not.toBeInTheDocument();
      });

      fireEvent.click(graphPane, { clientX: 320, clientY: 220 });
      expect(await screen.findByRole("heading", { name: /Create flow node/i })).toBeInTheDocument();
      await user.selectOptions(screen.getByRole("combobox", { name: /Flow node kind/i }), "call");
      await user.type(
        screen.getByRole("textbox", { name: /Flow statement/i }),
        "publish_summary(helper)",
      );
      await user.click(screen.getByRole("button", { name: /Create node/i }));

      const secondCreatedNodeId = useUiStore.getState().activeNodeId;
      expect(secondCreatedNodeId).toMatch(
        /^flowdoc:symbol:helm\.ui\.api:build_graph_summary:call:/,
      );
      expect(secondCreatedNodeId).not.toBe(firstCreatedNodeId);
      expect(screen.getByTestId("graph-create-mode-badge")).toBeInTheDocument();
      await waitFor(() => {
        expect(
          screen.queryByRole("heading", { name: /Create flow node/i }),
        ).not.toBeInTheDocument();
      });
      expect((await screen.findAllByText(/rank_modules/i)).length).toBeGreaterThan(0);
      expect((await screen.findAllByText(/publish_summary/i)).length).toBeGreaterThan(0);
      expect(await flowGraph.findByTestId(`rf__node-${firstCreatedNodeId}`)).toBeInTheDocument();
      expect(await flowGraph.findByTestId(`rf__node-${secondCreatedNodeId}`)).toBeInTheDocument();
    },
    WORKSPACE_TEST_TIMEOUT_MS,
  );

  it(
    "creates parameter nodes from flow create mode and places them at the click position",
    async () => {
      const user = userEvent.setup();
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
        () =>
          ({
            x: 0,
            y: 0,
            top: 0,
            left: 0,
            right: 240,
            bottom: 96,
            width: 240,
            height: 96,
            toJSON: () => ({}),
          }) as DOMRect,
      );
      useUiStore.setState({ flowInputDisplayMode: "entry" });
      const adapter = new MockDesktopAdapter();
      const editSpy = vi.spyOn(adapter, "applyStructuralEdit");
      const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
        initialEntries: ["/workspace"],
      });

      render(
        <AppProviders adapter={adapter}>
          <RouterProvider router={router} />
        </AppProviders>,
      );

      const { flowGraphPanel } = await openBuildGraphSummaryFlow(user);
      await setFlowInputMode(user, "entry");
      const graphPane = await ensureFlowCreateMode(flowGraphPanel);
      const initialLayoutWriteCount = writeStoredGraphLayoutMock.mock.calls.length;
      const clickPosition = { clientX: 280, clientY: 180 };

      fireEvent.click(graphPane, clickPosition);
      expect(await screen.findByRole("heading", { name: /Create flow node/i })).toBeInTheDocument();
      await user.selectOptions(screen.getByRole("combobox", { name: /Flow node kind/i }), "param");
      await user.type(screen.getByRole("textbox", { name: /Parameter name/i }), "limit");
      await user.type(screen.getByRole("textbox", { name: /Parameter default expression/i }), "10");
      await user.click(screen.getByRole("button", { name: /Create parameter/i }));

      const createdParamNodeId = `flow:${BUILD_GRAPH_SUMMARY_SYMBOL_ID}:param:limit`;
      const createdInputId = `flowinput:${BUILD_GRAPH_SUMMARY_SYMBOL_ID}:limit`;
      await waitFor(() =>
        expect(writeStoredGraphLayoutMock.mock.calls.length).toBeGreaterThan(
          initialLayoutWriteCount,
        ),
      );
      expect(
        lastWrittenGraphLayout()?.nodes[graphLayoutNodeKey(createdParamNodeId, "param")],
      ).toEqual({
        x: clickPosition.clientX,
        y: clickPosition.clientY,
      });
      const replaceRequest = lastReplaceFlowGraphRequest(editSpy);
      expect(replaceRequest?.flowGraph?.functionInputs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: createdInputId,
            name: "limit",
            defaultExpression: "10",
          }),
        ]),
      );
      expect(
        replaceRequest?.flowGraph?.nodes.some((node: { kind: string }) => node.kind === "param"),
      ).toBe(false);
      await waitFor(() => expect(useUiStore.getState().flowInputDisplayMode).toBe("param_nodes"));
      await waitFor(() => expect(useUiStore.getState().activeNodeId).toBe(createdParamNodeId));
      expect(await screen.findByTestId(`rf__node-${createdParamNodeId}`)).toBeInTheDocument();
      expect(screen.getByTestId("graph-create-mode-badge")).toBeInTheDocument();
      await waitFor(() =>
        expect(
          screen.queryByRole("heading", { name: /Create flow node/i }),
        ).not.toBeInTheDocument(),
      );
    },
    WORKSPACE_TEST_TIMEOUT_MS,
  );

  it(
    "keeps the flow node picker limited to supported kinds and creates or edits branch nodes through condition-only payloads",
    async () => {
      const user = userEvent.setup();
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
        () =>
          ({
            x: 0,
            y: 0,
            top: 0,
            left: 0,
            right: 240,
            bottom: 96,
            width: 240,
            height: 96,
            toJSON: () => ({}),
          }) as DOMRect,
      );
      const adapter = new MockDesktopAdapter();
      const editSpy = vi.spyOn(adapter, "applyStructuralEdit");
      const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
        initialEntries: ["/workspace"],
      });

      render(
        <AppProviders adapter={adapter}>
          <RouterProvider router={router} />
        </AppProviders>,
      );

      const graphPanel = document.querySelector(".graph-panel");
      expect(graphPanel).not.toBeNull();
      const graph = within(graphPanel as HTMLElement);

      fireEvent.doubleClick(await graph.findByText("api.py"));
      const functionNode = (await graph.findByText("build_graph_summary")).closest(".graph-node");
      expect(functionNode).not.toBeNull();
      fireEvent.click(within(functionNode as HTMLElement).getByText("Inspect"));
      await user.click(await screen.findByRole("button", { name: /Open flow/i }));
      const flowGraphPanel = await waitForFunctionFlowReady("build_graph_summary");

      const graphPane = await ensureFlowCreateMode(flowGraphPanel);

      fireEvent.click(graphPane, { clientX: 260, clientY: 180 });
      const kindSelect = screen.getByRole("combobox", { name: /Flow node kind/i });
      expect(
        within(kindSelect)
          .getAllByRole("option")
          .map((option) => option.textContent?.trim()),
      ).toEqual(["Assign", "Call", "Return", "Branch", "Loop", "Parameter"]);

      await user.selectOptions(kindSelect, "branch");
      expect(screen.getByRole("textbox", { name: /Branch condition/i })).toBeInTheDocument();
      expect(screen.queryByRole("textbox", { name: /Flow statement/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("textbox", { name: /Branch true body/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("textbox", { name: /Branch false body/i })).not.toBeInTheDocument();
      await user.type(
        screen.getByRole("textbox", { name: /Branch condition/i }),
        "module_summaries",
      );
      await user.click(screen.getByRole("button", { name: /Create node/i }));

      const createdBranchNodeId = useUiStore.getState().activeNodeId;
      expect(createdBranchNodeId).toMatch(
        /^flowdoc:symbol:helm\.ui\.api:build_graph_summary:branch:/,
      );
      expect(
        lastReplaceFlowGraphRequest(editSpy)?.flowGraph?.nodes.find(
          (node: { id: string }) => node.id === createdBranchNodeId,
        )?.payload,
      ).toEqual({
        condition: "module_summaries",
      });
      expect((await screen.findAllByText("if module_summaries")).length).toBeGreaterThan(0);
      await waitFor(() => {
        expect(
          screen.queryByRole("heading", { name: /Create flow node/i }),
        ).not.toBeInTheDocument();
      });

      fireEvent.doubleClick(await screen.findByTestId(`rf__node-${createdBranchNodeId}`));
      expect(await screen.findByRole("heading", { name: /Edit flow node/i })).toBeInTheDocument();
      expect(screen.getByRole("textbox", { name: /Branch condition/i })).toBeInTheDocument();
      expect(screen.queryByRole("textbox", { name: /Branch true body/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("textbox", { name: /Branch false body/i })).not.toBeInTheDocument();
      await user.clear(screen.getByRole("textbox", { name: /Branch condition/i }));
      await user.type(
        screen.getByRole("textbox", { name: /Branch condition/i }),
        "summary_count > 0",
      );
      await user.click(screen.getByRole("button", { name: /Save node/i }));

      expect(
        lastReplaceFlowGraphRequest(editSpy)?.flowGraph?.nodes.find(
          (node: { id: string }) => node.id === createdBranchNodeId,
        )?.payload,
      ).toEqual({
        condition: "summary_count > 0",
      });
      expect((await screen.findAllByText("if summary_count > 0")).length).toBeGreaterThan(0);
    },
    WORKSPACE_TEST_TIMEOUT_MS,
  );

  it(
    "creates and edits loop nodes through structured payloads",
    async () => {
      const user = userEvent.setup();
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
        () =>
          ({
            x: 0,
            y: 0,
            top: 0,
            left: 0,
            right: 240,
            bottom: 96,
            width: 240,
            height: 96,
            toJSON: () => ({}),
          }) as DOMRect,
      );
      const adapter = new MockDesktopAdapter();
      const editSpy = vi.spyOn(adapter, "applyStructuralEdit");
      const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
        initialEntries: ["/workspace"],
      });

      render(
        <AppProviders adapter={adapter}>
          <RouterProvider router={router} />
        </AppProviders>,
      );

      const graphPanel = document.querySelector(".graph-panel");
      expect(graphPanel).not.toBeNull();
      const graph = within(graphPanel as HTMLElement);

      fireEvent.doubleClick(await graph.findByText("api.py"));
      const functionNode = (await graph.findByText("build_graph_summary")).closest(".graph-node");
      expect(functionNode).not.toBeNull();
      fireEvent.click(within(functionNode as HTMLElement).getByText("Inspect"));
      await user.click(await screen.findByRole("button", { name: /Open flow/i }));
      const flowGraphPanel = await waitForFunctionFlowReady("build_graph_summary");

      const graphPane = await ensureFlowCreateMode(flowGraphPanel);

      fireEvent.click(graphPane, { clientX: 300, clientY: 220 });
      await user.selectOptions(screen.getByRole("combobox", { name: /Flow node kind/i }), "loop");
      expect(screen.getByRole("combobox", { name: /Loop type/i })).toBeInTheDocument();
      expect(screen.getByRole("textbox", { name: /Continue while/i })).toBeInTheDocument();
      expect(screen.queryByRole("textbox", { name: /Loop header/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("textbox", { name: /Loop body/i })).not.toBeInTheDocument();
      await user.selectOptions(screen.getByRole("combobox", { name: /Loop type/i }), "for");
      await user.type(screen.getByRole("textbox", { name: /Item target/i }), "module");
      await user.type(screen.getByRole("textbox", { name: /Iterable/i }), "module_summaries");
      await user.click(screen.getByRole("checkbox", { name: /Add Repeat step/i }));
      await user.type(
        screen.getByRole("textbox", { name: /Repeat step statement/i }),
        "module = normalize(module)",
      );
      await user.click(screen.getByRole("checkbox", { name: /Add Done step/i }));
      await user.type(
        screen.getByRole("textbox", { name: /Done step statement/i }),
        "summary_count = len(module_summaries)",
      );
      await user.click(screen.getByRole("button", { name: /Create loop/i }));

      const createdLoopNodeId = useUiStore.getState().activeNodeId;
      expect(createdLoopNodeId).toMatch(/^flowdoc:symbol:helm\.ui\.api:build_graph_summary:loop:/);
      const createdFlowGraph = lastReplaceFlowGraphRequest(editSpy)?.flowGraph;
      expect(
        createdFlowGraph?.nodes.find((node: { id: string }) => node.id === createdLoopNodeId)
          ?.payload,
      ).toEqual({
        header: "for module in module_summaries",
        loop_type: "for",
        target: "module",
        iterable: "module_summaries",
      });
      const repeatStepNode = createdFlowGraph?.nodes.find(
        (node: { id: string; payload: Record<string, unknown> }) =>
          node.payload.source === "module = normalize(module)",
      );
      const doneStepNode = createdFlowGraph?.nodes.find(
        (node: { id: string; payload: Record<string, unknown> }) =>
          node.payload.source === "summary_count = len(module_summaries)",
      );
      expect(repeatStepNode).toBeTruthy();
      expect(doneStepNode).toBeTruthy();
      expect(createdFlowGraph?.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceId: createdLoopNodeId,
            sourceHandle: "body",
            targetId: repeatStepNode?.id,
            targetHandle: "in",
          }),
          expect.objectContaining({
            sourceId: createdLoopNodeId,
            sourceHandle: "after",
            targetId: doneStepNode?.id,
            targetHandle: "in",
          }),
        ]),
      );
      expect((await screen.findAllByText("for module in module_summaries")).length).toBeGreaterThan(
        0,
      );
      await waitFor(() => {
        expect(
          screen.queryByRole("heading", { name: /Create flow node/i }),
        ).not.toBeInTheDocument();
      });

      fireEvent.doubleClick(await screen.findByTestId(`rf__node-${createdLoopNodeId}`));
      expect(await screen.findByRole("heading", { name: /Edit loop/i })).toBeInTheDocument();
      expect(screen.queryByRole("textbox", { name: /Loop header/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("textbox", { name: /Loop body/i })).not.toBeInTheDocument();
      expect(screen.getByRole("combobox", { name: /Loop type/i })).toHaveValue("for");
      expect(screen.getByRole("textbox", { name: /Item target/i })).toHaveValue("module");
      expect(screen.getByRole("textbox", { name: /Iterable/i })).toHaveValue("module_summaries");
      await user.selectOptions(screen.getByRole("combobox", { name: /Loop type/i }), "while");
      await user.type(screen.getByRole("textbox", { name: /Continue while/i }), "module_summaries");
      await user.click(screen.getByRole("button", { name: /Save node/i }));

      expect(
        lastReplaceFlowGraphRequest(editSpy)?.flowGraph?.nodes.find(
          (node: { id: string }) => node.id === createdLoopNodeId,
        )?.payload,
      ).toEqual({
        header: "while module_summaries",
        loop_type: "while",
        condition: "module_summaries",
      });
      expect((await screen.findAllByText("while module_summaries")).length).toBeGreaterThan(0);
    },
    WORKSPACE_TEST_TIMEOUT_MS,
  );

  it(
    "deletes visual parameter nodes as function inputs after confirming downstream removal",
    async () => {
      const user = userEvent.setup();
      mockGraphElementRect();
      useUiStore.setState({ flowInputDisplayMode: "param_nodes" });
      const adapter = new SyncAwareMockDesktopAdapter();
      const editSpy = vi.spyOn(adapter, "applyStructuralEdit");
      confirmDialogMock.mockResolvedValue(true);
      const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
        initialEntries: ["/workspace"],
      });

      render(
        <AppProviders adapter={adapter}>
          <RouterProvider router={router} />
        </AppProviders>,
      );

      const { flowGraphPanel } = await openBuildGraphSummaryFlow(user);
      await setFlowInputMode(user, "param_nodes");

      const paramNodeId = BUILD_GRAPH_SUMMARY_GRAPH_PARAM_ID;
      const paramNode = await screen.findByTestId(`rf__node-${paramNodeId}`);
      fireEvent.doubleClick(paramNode);
      expect(screen.queryByTestId("graph-create-composer")).not.toBeInTheDocument();

      fireEvent.click(paramNode);
      expect(useUiStore.getState().activeNodeId).toBe(paramNodeId);
      flowGraphPanel.focus();
      const replaceCallsBeforeDelete = editSpy.mock.calls.length;
      fireEvent.keyDown(flowGraphPanel, { key: "Delete" });

      await waitFor(() =>
        expect(editSpy.mock.calls.length).toBeGreaterThan(replaceCallsBeforeDelete),
      );
      expect(confirmDialogMock).toHaveBeenCalledWith(
        expect.stringContaining('delete param node "graph"'),
        expect.objectContaining({ kind: "warning", title: "Delete param node" }),
      );
      expect(confirmDialogMock).toHaveBeenCalledWith(
        expect.stringContaining('remove downstream uses and connections for "graph"'),
        expect.objectContaining({ kind: "warning", title: "Remove downstream uses" }),
      );
      const replaceRequest = lastReplaceFlowGraphRequest(editSpy);
      expect(
        replaceRequest?.flowGraph?.functionInputs?.some(
          (input) => input.id === BUILD_GRAPH_SUMMARY_GRAPH_INPUT_ID,
        ),
      ).toBe(false);
      expect(
        replaceRequest?.flowGraph?.inputBindings?.some(
          (binding) =>
            binding.sourceId === BUILD_GRAPH_SUMMARY_GRAPH_INPUT_ID ||
            binding.functionInputId === BUILD_GRAPH_SUMMARY_GRAPH_INPUT_ID,
        ),
      ).toBe(false);
      await waitFor(() =>
        expect(screen.queryByTestId(`rf__node-${paramNodeId}`)).not.toBeInTheDocument(),
      );
    },
    WORKSPACE_TEST_TIMEOUT_MS,
  );

  it(
    "keeps visual parameter nodes when downstream removal is declined",
    async () => {
      const user = userEvent.setup();
      mockGraphElementRect();
      useUiStore.setState({ flowInputDisplayMode: "param_nodes" });
      const adapter = new SyncAwareMockDesktopAdapter();
      const editSpy = vi.spyOn(adapter, "applyStructuralEdit");
      confirmDialogMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
        initialEntries: ["/workspace"],
      });

      render(
        <AppProviders adapter={adapter}>
          <RouterProvider router={router} />
        </AppProviders>,
      );

      const { flowGraphPanel } = await openBuildGraphSummaryFlow(user);
      await setFlowInputMode(user, "param_nodes");

      const paramNodeId = BUILD_GRAPH_SUMMARY_GRAPH_PARAM_ID;
      const paramNode = await screen.findByTestId(`rf__node-${paramNodeId}`);
      fireEvent.click(paramNode);
      flowGraphPanel.focus();
      const replaceCallsBeforeDelete = editSpy.mock.calls.length;
      fireEvent.keyDown(flowGraphPanel, { key: "Delete" });

      await waitFor(() => expect(confirmDialogMock).toHaveBeenCalledTimes(2));
      expect(confirmDialogMock).toHaveBeenCalledWith(
        expect.stringContaining('delete param node "graph"'),
        expect.objectContaining({ kind: "warning", title: "Delete param node" }),
      );
      expect(confirmDialogMock).toHaveBeenCalledWith(
        expect.stringContaining('remove downstream uses and connections for "graph"'),
        expect.objectContaining({ kind: "warning", title: "Remove downstream uses" }),
      );
      expect(editSpy.mock.calls.length).toBe(replaceCallsBeforeDelete);
      expect(screen.getByTestId(`rf__node-${paramNodeId}`)).toBeInTheDocument();
    },
    WORKSPACE_TEST_TIMEOUT_MS,
  );

  it(
    "keeps a draft-backed disconnected flow node visible across a same-symbol refetch",
    async () => {
      const user = userEvent.setup();
      const adapter = new SyncAwareMockDesktopAdapter();
      const flowViewSpy = vi.spyOn(adapter, "getFlowView");
      const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
        initialEntries: ["/workspace"],
      });

      render(
        <AppProviders adapter={adapter}>
          <RouterProvider router={router} />
        </AppProviders>,
      );

      const graphPanel = document.querySelector(".graph-panel");
      expect(graphPanel).not.toBeNull();
      const graph = within(graphPanel as HTMLElement);
      fireEvent.doubleClick(await graph.findByText("api.py"));
      const functionNode = (await graph.findByText("build_graph_summary")).closest(".graph-node");
      expect(functionNode).not.toBeNull();
      fireEvent.click(within(functionNode as HTMLElement).getByText("Inspect"));
      await user.click(await screen.findByRole("button", { name: /Open flow/i }));
      await waitFor(() => expect(flowViewSpy).toHaveBeenCalled());

      const flowGraphPanel = await waitForFunctionFlowReady("build_graph_summary");
      const graphPane = await ensureFlowCreateMode(flowGraphPanel);
      const spawnClick = { clientX: 240, clientY: 180 };
      fireEvent.click(graphPane, spawnClick);
      await user.type(
        screen.getByRole("textbox", { name: /Flow statement/i }),
        "helper = rank_modules(graph)",
      );
      await user.click(screen.getByRole("button", { name: /Create node/i }));
      await screen.findAllByText(/rank_modules/i);

      const localNodeId = useUiStore.getState().activeNodeId;
      expect(localNodeId).toMatch(/^flowdoc:symbol:helm\.ui\.api:build_graph_summary:assign:/);
      const localNodeHost = await screen.findByTestId(`rf__node-${localNodeId}`);
      await waitFor(() => {
        expect(localNodeHost.style.transform).toContain(
          `translate(${spawnClick.clientX}px,${spawnClick.clientY}px)`,
        );
      });
      const initialFlowViewCalls = flowViewSpy.mock.calls.length;

      act(() => {
        adapter.emitWorkspaceSync({
          repoPath: defaultRepoPath,
          sessionVersion: 4,
          reason: "refresh",
          status: "synced",
          changedRelativePaths: [],
          needsManualResync: false,
          message: "Watching the active repo for workspace changes.",
          snapshot: {
            repoId: buildRepoSession().id,
            defaultFocusNodeId: "symbol:helm.ui.api:build_graph_summary",
            defaultLevel: "flow",
            nodeIds: ["symbol:helm.ui.api:build_graph_summary", localNodeId ?? ""],
          },
        });
      });

      await waitFor(() =>
        expect(flowViewSpy.mock.calls.length).toBeGreaterThan(initialFlowViewCalls),
      );
      expect((await screen.findAllByText(/rank_modules/i)).length).toBeGreaterThan(0);
      expect(useUiStore.getState().activeNodeId).toBe(localNodeId);
      expect((await screen.findByTestId(`rf__node-${localNodeId}`)).style.transform).toContain(
        `translate(${spawnClick.clientX}px,${spawnClick.clientY}px)`,
      );
    },
    WORKSPACE_TEST_TIMEOUT_MS,
  );

  it(
    "keeps indexed parameter wires visible through a draft-backed same-symbol refetch",
    async () => {
      const user = userEvent.setup();
      const adapter = new IndexedDraftFlowMockDesktopAdapter();
      const flowViewSpy = vi.spyOn(adapter, "getFlowView");
      const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
        initialEntries: ["/workspace"],
      });

      render(
        <AppProviders adapter={adapter}>
          <RouterProvider router={router} />
        </AppProviders>,
      );

      await openBuildGraphSummaryFlow(user);
      await waitFor(() => expect(flowViewSpy).toHaveBeenCalled());

      const draftAssignId = "flowdoc:symbol:helm.ui.api:build_graph_summary:assign:indexed";
      const paramNodeId = "flow:symbol:helm.ui.api:build_graph_summary:param:graph";
      expect(await screen.findByTestId(`rf__node-${draftAssignId}`)).toBeInTheDocument();
      expect(await screen.findByTestId(`rf__node-${paramNodeId}`)).toBeInTheDocument();
      expect(
        screen.queryByTestId("rf__node-flow:symbol:helm.ui.api:build_graph_summary:assign:modules"),
      ).not.toBeInTheDocument();

      await emitSameSymbolRefetch(adapter, flowViewSpy, [draftAssignId]);

      expect(await screen.findByTestId(`rf__node-${draftAssignId}`)).toBeInTheDocument();
      expect(await screen.findByTestId(`rf__node-${paramNodeId}`)).toBeInTheDocument();
    },
    WORKSPACE_TEST_TIMEOUT_MS,
  );

  it(
    "switches editable flow input modes without mutating the binding document",
    async () => {
      const user = userEvent.setup();
      mockGraphElementRect();
      useUiStore.setState({ flowInputDisplayMode: "param_nodes" });
      const adapter = new SyncAwareMockDesktopAdapter();
      const editSpy = vi.spyOn(adapter, "applyStructuralEdit");
      const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
        initialEntries: ["/workspace"],
      });

      render(
        <AppProviders adapter={adapter}>
          <RouterProvider router={router} />
        </AppProviders>,
      );

      await openBuildGraphSummaryFlow(user);
      await setFlowInputMode(user, "param_nodes");

      expect(
        await screen.findByTestId(`rf__node-${BUILD_GRAPH_SUMMARY_GRAPH_PARAM_ID}`),
      ).toBeInTheDocument();
      expect(
        await screen.findByTestId(`rf__node-${BUILD_GRAPH_SUMMARY_TOP_N_PARAM_ID}`),
      ).toBeInTheDocument();
      expect(
        await findTestIdElementByFragments("graph-edge-hitarea:", [
          flowInputBindingId(BUILD_GRAPH_SUMMARY_GRAPH_SLOT_ID, BUILD_GRAPH_SUMMARY_GRAPH_INPUT_ID),
        ]),
      ).toBeInTheDocument();
      expect(
        await findTestIdElementByFragments("graph-edge-hitarea:", [
          flowInputBindingId(BUILD_GRAPH_SUMMARY_TOP_N_SLOT_ID, BUILD_GRAPH_SUMMARY_TOP_N_INPUT_ID),
        ]),
      ).toBeInTheDocument();

      await setFlowInputMode(user, "entry");

      expect(
        screen.queryByTestId(`rf__node-${BUILD_GRAPH_SUMMARY_GRAPH_PARAM_ID}`),
      ).not.toBeInTheDocument();
      expect(
        await findFlowHandle(
          BUILD_GRAPH_SUMMARY_ENTRY_ID,
          flowInputSourceHandle(BUILD_GRAPH_SUMMARY_GRAPH_INPUT_ID),
        ),
      ).toBeInTheDocument();
      expect(
        await findTestIdElementByFragments("graph-edge-hitarea:", [
          flowInputBindingId(BUILD_GRAPH_SUMMARY_GRAPH_SLOT_ID, BUILD_GRAPH_SUMMARY_GRAPH_INPUT_ID),
        ]),
      ).toBeInTheDocument();

      await setFlowInputMode(user, "param_nodes");

      expect(
        await screen.findByTestId(`rf__node-${BUILD_GRAPH_SUMMARY_GRAPH_PARAM_ID}`),
      ).toBeInTheDocument();
      expect(
        await findTestIdElementByFragments("graph-edge-hitarea:", [
          flowInputBindingId(BUILD_GRAPH_SUMMARY_GRAPH_SLOT_ID, BUILD_GRAPH_SUMMARY_GRAPH_INPUT_ID),
        ]),
      ).toBeInTheDocument();
      expect(lastReplaceFlowGraphRequest(editSpy)).toBeUndefined();
    },
    WORKSPACE_TEST_TIMEOUT_MS,
  );

  it(
    "opens imported add flow with indexed input wires in both display modes without mutation",
    async () => {
      const user = userEvent.setup();
      mockGraphElementRect();
      useUiStore.setState({ flowInputDisplayMode: "param_nodes" });
      const adapter = new ImportedAddFlowMockDesktopAdapter();
      await adapter.seedAddSymbol();
      const editSpy = vi.spyOn(adapter, "applyStructuralEdit");
      const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
        initialEntries: ["/workspace"],
      });

      render(
        <AppProviders adapter={adapter}>
          <RouterProvider router={router} />
        </AppProviders>,
      );

      await openFunctionFlow(user, "add");
      await setFlowInputMode(user, "param_nodes", "add");

      expect(await screen.findByTestId(`rf__node-${ADD_PARAM_A_ID}`)).toBeInTheDocument();
      expect(await screen.findByTestId(`rf__node-${ADD_PARAM_B_ID}`)).toBeInTheDocument();
      expect(
        await findFlowHandle(ADD_RETURN_ID, flowInputSlotTargetHandle(ADD_SLOT_A_ID)),
      ).toBeInTheDocument();
      expect(
        await findFlowHandle(ADD_RETURN_ID, flowInputSlotTargetHandle(ADD_SLOT_B_ID)),
      ).toBeInTheDocument();
      expect(
        await findTestIdElementByFragments("graph-edge-hitarea:", [
          flowInputBindingId(ADD_SLOT_A_ID, ADD_INPUT_A_ID),
        ]),
      ).toBeInTheDocument();
      expect(
        await findTestIdElementByFragments("graph-edge-hitarea:", [
          flowInputBindingId(ADD_SLOT_B_ID, ADD_INPUT_B_ID),
        ]),
      ).toBeInTheDocument();

      await setFlowInputMode(user, "entry", "add");

      expect(screen.queryByTestId(`rf__node-${ADD_PARAM_A_ID}`)).not.toBeInTheDocument();
      expect(screen.queryByTestId(`rf__node-${ADD_PARAM_B_ID}`)).not.toBeInTheDocument();
      expect(
        await findFlowHandle(ADD_ENTRY_ID, flowInputSourceHandle(ADD_INPUT_A_ID)),
      ).toBeInTheDocument();
      expect(
        await findFlowHandle(ADD_ENTRY_ID, flowInputSourceHandle(ADD_INPUT_B_ID)),
      ).toBeInTheDocument();
      expect(
        await findTestIdElementByFragments("graph-edge-hitarea:", [
          flowInputBindingId(ADD_SLOT_A_ID, ADD_INPUT_A_ID),
        ]),
      ).toBeInTheDocument();
      expect(
        await findTestIdElementByFragments("graph-edge-hitarea:", [
          flowInputBindingId(ADD_SLOT_B_ID, ADD_INPUT_B_ID),
        ]),
      ).toBeInTheDocument();
      expect(lastReplaceFlowGraphRequest(editSpy)).toBeUndefined();
      expect(adapter.replacePayloads).toEqual([]);
    },
    WORKSPACE_TEST_TIMEOUT_MS,
  );

  it(
    "opens a return expression graph as the main canvas and live-saves valid graph edits",
    async () => {
      const user = userEvent.setup();
      mockGraphElementRect();
      const adapter = new ImportedAddFlowMockDesktopAdapter();
      await adapter.seedAddSymbol();
      const editSpy = vi.spyOn(adapter, "applyStructuralEdit");
      const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
        initialEntries: ["/workspace"],
      });

      render(
        <AppProviders adapter={adapter}>
          <RouterProvider router={router} />
        </AppProviders>,
      );

      await openFunctionFlow(user, "add");
      await user.click(
        await screen.findByTestId("graph-expression-preview-node-expr:operator:add"),
      );

      expect(await screen.findByTestId("flow-expression-graph-canvas")).toBeInTheDocument();
      expect(screen.queryByTestId("flow-expression-graph-editor")).not.toBeInTheDocument();
      const graphPath = screen.getByRole("navigation", { name: "Graph path" });
      expect(within(graphPath).getByText("return")).toBeInTheDocument();

      const replaceCallsBeforeEdit = editSpy.mock.calls.length;
      fireEvent.change(await screen.findByLabelText("Expression operator"), {
        target: { value: "*" },
      });

      await waitFor(() =>
        expect(editSpy.mock.calls.length).toBeGreaterThan(replaceCallsBeforeEdit),
      );
      const replaceRequest = lastReplaceFlowGraphRequest(editSpy);
      const returnDraftNode = replaceRequest?.flowGraph?.nodes.find(
        (node) => node.id === ADD_RETURN_ID,
      );
      expect(returnDraftNode?.payload.expression).toBe("a * b");
      expect(returnDraftNode?.payload.expression_graph).toEqual(
        expect.objectContaining({
          nodes: expect.arrayContaining([
            expect.objectContaining({
              id: "expr:operator:add",
              label: "*",
              payload: expect.objectContaining({ operator: "*" }),
            }),
          ]),
        }),
      );

      await user.click(within(graphPath).getByRole("button", { name: "Flow" }));
      expect(await screen.findByTestId(`rf__node-${ADD_RETURN_ID}`)).toBeInTheDocument();
      expect(screen.queryByTestId("flow-expression-graph-canvas")).not.toBeInTheDocument();
    },
    WORKSPACE_TEST_TIMEOUT_MS,
  );

  it(
    "rewires imported add input in parameter mode and preserves it across refetch and reopen",
    async () => {
      const user = userEvent.setup();
      mockGraphElementRect();
      useUiStore.setState({ flowInputDisplayMode: "param_nodes" });
      const adapter = new ImportedAddFlowMockDesktopAdapter();
      await adapter.seedAddSymbol();
      const editSpy = vi.spyOn(adapter, "applyStructuralEdit");
      const flowViewSpy = vi.spyOn(adapter, "getFlowView");
      const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
        initialEntries: ["/workspace"],
      });

      const rendered = render(
        <AppProviders adapter={adapter}>
          <RouterProvider router={router} />
        </AppProviders>,
      );

      await openFunctionFlow(user, "add");
      await setFlowInputMode(user, "param_nodes", "add");

      const replaceCallsBeforeRewire = editSpy.mock.calls.length;
      dragConnectionToHandle({
        dragStart: await findFlowHandle(ADD_PARAM_B_ID, flowInputSourceHandle(ADD_INPUT_B_ID)),
        targetHandle: await findFlowHandle(ADD_RETURN_ID, flowInputSlotTargetHandle(ADD_SLOT_A_ID)),
      });

      await waitFor(() =>
        expect(editSpy.mock.calls.length).toBeGreaterThan(replaceCallsBeforeRewire),
      );
      const replaceRequest = lastReplaceFlowGraphRequest(editSpy);
      expectFlowBinding(replaceRequest?.flowGraph, ADD_SLOT_A_ID, ADD_INPUT_B_ID);
      expectFlowBinding(replaceRequest?.flowGraph, ADD_SLOT_B_ID, ADD_INPUT_B_ID);
      expectNoBinding(replaceRequest?.flowGraph, ADD_SLOT_A_ID, ADD_INPUT_A_ID);
      expect(adapter.replacePayloads).toHaveLength(1);

      const rewiredBindingId = flowInputBindingId(ADD_SLOT_A_ID, ADD_INPUT_B_ID);
      await emitSameSymbolRefetch(
        adapter,
        flowViewSpy,
        [ADD_RETURN_ID, ADD_EXIT_ID],
        ADD_SYMBOL_ID,
      );

      expect(
        await findTestIdElementByFragments("graph-edge-hitarea:", [rewiredBindingId]),
      ).toBeInTheDocument();
      const refetchedDocument = (await adapter.getFlowView(ADD_SYMBOL_ID)).flowState?.document;
      expectFlowBinding(refetchedDocument, ADD_SLOT_A_ID, ADD_INPUT_B_ID);
      expectFlowBinding(refetchedDocument, ADD_SLOT_B_ID, ADD_INPUT_B_ID);

      rendered.unmount();
      resetStore();
      useUiStore.setState({ flowInputDisplayMode: "entry" });
      const reopenedRouter = createMemoryRouter(
        [{ path: "/workspace", element: <WorkspaceScreen /> }],
        { initialEntries: ["/workspace"] },
      );
      render(
        <AppProviders adapter={adapter}>
          <RouterProvider router={reopenedRouter} />
        </AppProviders>,
      );

      const reopenedUser = userEvent.setup();
      await openFunctionFlow(reopenedUser, "add");
      await setFlowInputMode(reopenedUser, "entry", "add");
      expect(
        await findFlowHandle(ADD_ENTRY_ID, flowInputSourceHandle(ADD_INPUT_B_ID)),
      ).toBeInTheDocument();
      expect(
        await findTestIdElementByFragments("graph-edge-hitarea:", [rewiredBindingId]),
      ).toBeInTheDocument();

      await setFlowInputMode(reopenedUser, "param_nodes", "add");
      expect(await screen.findByTestId(`rf__node-${ADD_PARAM_B_ID}`)).toBeInTheDocument();
      expect(
        await findTestIdElementByFragments("graph-edge-hitarea:", [rewiredBindingId]),
      ).toBeInTheDocument();
    },
    WORKSPACE_TEST_TIMEOUT_MS,
  );

  it(
    "rewires imported add input in entry mode and reflects it in parameter mode",
    async () => {
      const user = userEvent.setup();
      mockGraphElementRect();
      useUiStore.setState({ flowInputDisplayMode: "entry" });
      const adapter = new ImportedAddFlowMockDesktopAdapter();
      await adapter.seedAddSymbol();
      const editSpy = vi.spyOn(adapter, "applyStructuralEdit");
      const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
        initialEntries: ["/workspace"],
      });

      render(
        <AppProviders adapter={adapter}>
          <RouterProvider router={router} />
        </AppProviders>,
      );

      await openFunctionFlow(user, "add");
      await setFlowInputMode(user, "entry", "add");

      const replaceCallsBeforeRewire = editSpy.mock.calls.length;
      dragConnectionToHandle({
        dragStart: await findFlowHandle(ADD_ENTRY_ID, flowInputSourceHandle(ADD_INPUT_A_ID)),
        targetHandle: await findFlowHandle(ADD_RETURN_ID, flowInputSlotTargetHandle(ADD_SLOT_B_ID)),
      });

      await waitFor(() =>
        expect(editSpy.mock.calls.length).toBeGreaterThan(replaceCallsBeforeRewire),
      );
      const replaceRequest = lastReplaceFlowGraphRequest(editSpy);
      expectFlowBinding(replaceRequest?.flowGraph, ADD_SLOT_A_ID, ADD_INPUT_A_ID);
      expectFlowBinding(replaceRequest?.flowGraph, ADD_SLOT_B_ID, ADD_INPUT_A_ID);
      expectNoBinding(replaceRequest?.flowGraph, ADD_SLOT_B_ID, ADD_INPUT_B_ID);

      const rewiredBindingId = flowInputBindingId(ADD_SLOT_B_ID, ADD_INPUT_A_ID);
      await setFlowInputMode(user, "param_nodes", "add");
      expect(await screen.findByTestId(`rf__node-${ADD_PARAM_A_ID}`)).toBeInTheDocument();
      expect(
        await findTestIdElementByFragments("graph-edge-hitarea:", [
          flowInputBindingId(ADD_SLOT_A_ID, ADD_INPUT_A_ID),
        ]),
      ).toBeInTheDocument();
      expect(
        await findTestIdElementByFragments("graph-edge-hitarea:", [rewiredBindingId]),
      ).toBeInTheDocument();
    },
    WORKSPACE_TEST_TIMEOUT_MS,
  );

  it(
    "reflects parameter-mode input rewires in entry mode and preserves them across refetch and reopen",
    async () => {
      const user = userEvent.setup();
      mockGraphElementRect();
      useUiStore.setState({ flowInputDisplayMode: "param_nodes" });
      const adapter = new SyncAwareMockDesktopAdapter();
      const editSpy = vi.spyOn(adapter, "applyStructuralEdit");
      const flowViewSpy = vi.spyOn(adapter, "getFlowView");
      const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
        initialEntries: ["/workspace"],
      });

      const rendered = render(
        <AppProviders adapter={adapter}>
          <RouterProvider router={router} />
        </AppProviders>,
      );

      await openBuildGraphSummaryFlow(user);
      await setFlowInputMode(user, "param_nodes");

      const replaceCallsBeforeRewire = editSpy.mock.calls.length;
      dragConnectionToHandle({
        dragStart: await findFlowHandle(
          BUILD_GRAPH_SUMMARY_TOP_N_PARAM_ID,
          flowInputSourceHandle(BUILD_GRAPH_SUMMARY_TOP_N_INPUT_ID),
        ),
        targetHandle: await findFlowHandle(
          BUILD_GRAPH_SUMMARY_ASSIGN_MODULES_ID,
          flowInputSlotTargetHandle(BUILD_GRAPH_SUMMARY_GRAPH_SLOT_ID),
        ),
      });

      await waitFor(() =>
        expect(editSpy.mock.calls.length).toBeGreaterThan(replaceCallsBeforeRewire),
      );
      const replaceRequest = lastReplaceFlowGraphRequest(editSpy);
      expectFlowBinding(
        replaceRequest?.flowGraph,
        BUILD_GRAPH_SUMMARY_GRAPH_SLOT_ID,
        BUILD_GRAPH_SUMMARY_TOP_N_INPUT_ID,
      );
      expectFlowBinding(
        replaceRequest?.flowGraph,
        BUILD_GRAPH_SUMMARY_TOP_N_SLOT_ID,
        BUILD_GRAPH_SUMMARY_TOP_N_INPUT_ID,
      );
      expect(
        replaceRequest?.flowGraph?.inputBindings?.some(
          (binding) =>
            binding.slotId === BUILD_GRAPH_SUMMARY_GRAPH_SLOT_ID &&
            binding.functionInputId === BUILD_GRAPH_SUMMARY_GRAPH_INPUT_ID,
        ),
      ).toBe(false);

      const rewiredBindingId = flowInputBindingId(
        BUILD_GRAPH_SUMMARY_GRAPH_SLOT_ID,
        BUILD_GRAPH_SUMMARY_TOP_N_INPUT_ID,
      );
      await setFlowInputMode(user, "entry");
      expect(
        await findTestIdElementByFragments("graph-edge-hitarea:", [rewiredBindingId]),
      ).toBeInTheDocument();
      expect(
        await findFlowHandle(
          BUILD_GRAPH_SUMMARY_ENTRY_ID,
          flowInputSourceHandle(BUILD_GRAPH_SUMMARY_TOP_N_INPUT_ID),
        ),
      ).toBeInTheDocument();

      await emitSameSymbolRefetch(adapter, flowViewSpy, [
        BUILD_GRAPH_SUMMARY_ASSIGN_MODULES_ID,
        BUILD_GRAPH_SUMMARY_CALL_RANK_ID,
      ]);

      expect(
        await findTestIdElementByFragments("graph-edge-hitarea:", [rewiredBindingId]),
      ).toBeInTheDocument();
      const refetchedDocument = (await adapter.getFlowView(BUILD_GRAPH_SUMMARY_SYMBOL_ID)).flowState
        ?.document;
      expectFlowBinding(
        refetchedDocument,
        BUILD_GRAPH_SUMMARY_GRAPH_SLOT_ID,
        BUILD_GRAPH_SUMMARY_TOP_N_INPUT_ID,
      );
      expectFlowBinding(
        refetchedDocument,
        BUILD_GRAPH_SUMMARY_TOP_N_SLOT_ID,
        BUILD_GRAPH_SUMMARY_TOP_N_INPUT_ID,
      );

      rendered.unmount();
      resetStore();
      useUiStore.setState({ flowInputDisplayMode: "entry" });
      const reopenedRouter = createMemoryRouter(
        [{ path: "/workspace", element: <WorkspaceScreen /> }],
        { initialEntries: ["/workspace"] },
      );
      render(
        <AppProviders adapter={adapter}>
          <RouterProvider router={reopenedRouter} />
        </AppProviders>,
      );

      const reopenedUser = userEvent.setup();
      await openBuildGraphSummaryFlow(reopenedUser);
      await setFlowInputMode(reopenedUser, "entry");
      expect(
        await findTestIdElementByFragments("graph-edge-hitarea:", [rewiredBindingId]),
      ).toBeInTheDocument();

      await setFlowInputMode(reopenedUser, "param_nodes");
      expect(
        await screen.findByTestId(`rf__node-${BUILD_GRAPH_SUMMARY_TOP_N_PARAM_ID}`),
      ).toBeInTheDocument();
      expect(
        await findTestIdElementByFragments("graph-edge-hitarea:", [rewiredBindingId]),
      ).toBeInTheDocument();
    },
    WORKSPACE_TEST_TIMEOUT_MS,
  );

  it(
    "reflects entry-mode input rewires in parameter mode",
    async () => {
      const user = userEvent.setup();
      mockGraphElementRect();
      useUiStore.setState({ flowInputDisplayMode: "entry" });
      const adapter = new SyncAwareMockDesktopAdapter();
      const editSpy = vi.spyOn(adapter, "applyStructuralEdit");
      const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
        initialEntries: ["/workspace"],
      });

      render(
        <AppProviders adapter={adapter}>
          <RouterProvider router={router} />
        </AppProviders>,
      );

      await openBuildGraphSummaryFlow(user);
      await setFlowInputMode(user, "entry");

      const replaceCallsBeforeRewire = editSpy.mock.calls.length;
      dragConnectionToHandle({
        dragStart: await findFlowHandle(
          BUILD_GRAPH_SUMMARY_ENTRY_ID,
          flowInputSourceHandle(BUILD_GRAPH_SUMMARY_GRAPH_INPUT_ID),
        ),
        targetHandle: await findFlowHandle(
          BUILD_GRAPH_SUMMARY_CALL_RANK_ID,
          flowInputSlotTargetHandle(BUILD_GRAPH_SUMMARY_TOP_N_SLOT_ID),
        ),
      });

      await waitFor(() =>
        expect(editSpy.mock.calls.length).toBeGreaterThan(replaceCallsBeforeRewire),
      );
      const replaceRequest = lastReplaceFlowGraphRequest(editSpy);
      expectFlowBinding(
        replaceRequest?.flowGraph,
        BUILD_GRAPH_SUMMARY_TOP_N_SLOT_ID,
        BUILD_GRAPH_SUMMARY_GRAPH_INPUT_ID,
      );
      expectFlowBinding(
        replaceRequest?.flowGraph,
        BUILD_GRAPH_SUMMARY_GRAPH_SLOT_ID,
        BUILD_GRAPH_SUMMARY_GRAPH_INPUT_ID,
      );
      expect(
        replaceRequest?.flowGraph?.inputBindings?.some(
          (binding) =>
            binding.slotId === BUILD_GRAPH_SUMMARY_TOP_N_SLOT_ID &&
            binding.functionInputId === BUILD_GRAPH_SUMMARY_TOP_N_INPUT_ID,
        ),
      ).toBe(false);

      const rewiredBindingId = flowInputBindingId(
        BUILD_GRAPH_SUMMARY_TOP_N_SLOT_ID,
        BUILD_GRAPH_SUMMARY_GRAPH_INPUT_ID,
      );
      await setFlowInputMode(user, "param_nodes");
      expect(
        await screen.findByTestId(`rf__node-${BUILD_GRAPH_SUMMARY_GRAPH_PARAM_ID}`),
      ).toBeInTheDocument();
      expect(
        await findTestIdElementByFragments("graph-edge-hitarea:", [rewiredBindingId]),
      ).toBeInTheDocument();
    },
    WORKSPACE_TEST_TIMEOUT_MS,
  );

  it(
    "rewires local value-source bindings and preserves them across refetch",
    async () => {
      const user = userEvent.setup();
      mockGraphElementRect();
      useUiStore.setState({ flowInputDisplayMode: "entry" });
      const adapter = new SyncAwareMockDesktopAdapter();
      const editSpy = vi.spyOn(adapter, "applyStructuralEdit");
      const flowViewSpy = vi.spyOn(adapter, "getFlowView");
      const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
        initialEntries: ["/workspace"],
      });

      const rendered = render(
        <AppProviders adapter={adapter}>
          <RouterProvider router={router} />
        </AppProviders>,
      );

      await openBuildGraphSummaryFlow(user);
      await setFlowInputMode(user, "entry");

      expect(
        await findFlowHandle(
          BUILD_GRAPH_SUMMARY_ASSIGN_MODULES_ID,
          flowValueSourceHandle(BUILD_GRAPH_SUMMARY_MODULE_SUMMARIES_SOURCE_ID),
        ),
      ).toBeInTheDocument();
      expect(
        await findTestIdElementByFragments("graph-edge-hitarea:", [
          flowInputBindingId(
            BUILD_GRAPH_SUMMARY_MODULE_SUMMARIES_SLOT_ID,
            BUILD_GRAPH_SUMMARY_MODULE_SUMMARIES_SOURCE_ID,
          ),
        ]),
      ).toBeInTheDocument();

      const replaceCallsBeforeRewire = editSpy.mock.calls.length;
      dragConnectionToHandle({
        dragStart: await findFlowHandle(
          BUILD_GRAPH_SUMMARY_ASSIGN_MODULES_ID,
          flowValueSourceHandle(BUILD_GRAPH_SUMMARY_MODULE_SUMMARIES_SOURCE_ID),
        ),
        targetHandle: await findFlowHandle(
          BUILD_GRAPH_SUMMARY_CALL_RANK_ID,
          flowInputSlotTargetHandle(BUILD_GRAPH_SUMMARY_TOP_N_SLOT_ID),
        ),
      });

      await waitFor(() =>
        expect(editSpy.mock.calls.length).toBeGreaterThan(replaceCallsBeforeRewire),
      );
      const replaceRequest = lastReplaceFlowGraphRequest(editSpy);
      expect(replaceRequest?.flowGraph?.inputBindings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: flowInputBindingId(
              BUILD_GRAPH_SUMMARY_TOP_N_SLOT_ID,
              BUILD_GRAPH_SUMMARY_MODULE_SUMMARIES_SOURCE_ID,
            ),
            sourceId: BUILD_GRAPH_SUMMARY_MODULE_SUMMARIES_SOURCE_ID,
            slotId: BUILD_GRAPH_SUMMARY_TOP_N_SLOT_ID,
          }),
        ]),
      );
      expect(
        replaceRequest?.flowGraph?.inputBindings?.some(
          (binding) =>
            binding.slotId === BUILD_GRAPH_SUMMARY_TOP_N_SLOT_ID &&
            binding.sourceId === BUILD_GRAPH_SUMMARY_TOP_N_INPUT_ID,
        ),
      ).toBe(false);

      await emitSameSymbolRefetch(adapter, flowViewSpy, [
        BUILD_GRAPH_SUMMARY_ASSIGN_MODULES_ID,
        BUILD_GRAPH_SUMMARY_CALL_RANK_ID,
      ]);

      expect(
        await findTestIdElementByFragments("graph-edge-hitarea:", [
          flowInputBindingId(
            BUILD_GRAPH_SUMMARY_TOP_N_SLOT_ID,
            BUILD_GRAPH_SUMMARY_MODULE_SUMMARIES_SOURCE_ID,
          ),
        ]),
      ).toBeInTheDocument();
      const refetchedDocument = (await adapter.getFlowView(BUILD_GRAPH_SUMMARY_SYMBOL_ID)).flowState
        ?.document;
      expect(refetchedDocument?.inputBindings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceId: BUILD_GRAPH_SUMMARY_MODULE_SUMMARIES_SOURCE_ID,
            slotId: BUILD_GRAPH_SUMMARY_TOP_N_SLOT_ID,
          }),
        ]),
      );

      const rewiredLocalValueBindingId = flowInputBindingId(
        BUILD_GRAPH_SUMMARY_TOP_N_SLOT_ID,
        BUILD_GRAPH_SUMMARY_MODULE_SUMMARIES_SOURCE_ID,
      );
      await setFlowInputMode(user, "param_nodes");
      expect(
        await findTestIdElementByFragments("graph-edge-hitarea:", [rewiredLocalValueBindingId]),
      ).toBeInTheDocument();
      await setFlowInputMode(user, "entry");
      expect(
        await findTestIdElementByFragments("graph-edge-hitarea:", [rewiredLocalValueBindingId]),
      ).toBeInTheDocument();

      rendered.unmount();
      resetStore();
      useUiStore.setState({ flowInputDisplayMode: "param_nodes" });
      const reopenedRouter = createMemoryRouter(
        [{ path: "/workspace", element: <WorkspaceScreen /> }],
        { initialEntries: ["/workspace"] },
      );
      render(
        <AppProviders adapter={adapter}>
          <RouterProvider router={reopenedRouter} />
        </AppProviders>,
      );

      const reopenedUser = userEvent.setup();
      await openBuildGraphSummaryFlow(reopenedUser);
      await setFlowInputMode(reopenedUser, "param_nodes");
      expect(
        await findTestIdElementByFragments("graph-edge-hitarea:", [rewiredLocalValueBindingId]),
      ).toBeInTheDocument();
      await setFlowInputMode(reopenedUser, "entry");
      expect(
        await findTestIdElementByFragments("graph-edge-hitarea:", [rewiredLocalValueBindingId]),
      ).toBeInTheDocument();
    },
    WORKSPACE_TEST_TIMEOUT_MS,
  );

  it(
    "deletes selected local value-source bindings and keeps the slot reconnectable",
    async () => {
      const user = userEvent.setup();
      mockGraphElementRect();
      useUiStore.setState({ flowInputDisplayMode: "entry" });
      const adapter = new SyncAwareMockDesktopAdapter();
      const editSpy = vi.spyOn(adapter, "applyStructuralEdit");
      const flowViewSpy = vi.spyOn(adapter, "getFlowView");
      const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
        initialEntries: ["/workspace"],
      });

      render(
        <AppProviders adapter={adapter}>
          <RouterProvider router={router} />
        </AppProviders>,
      );

      const { flowGraphPanel } = await openBuildGraphSummaryFlow(user);
      await waitFor(() => expect(flowViewSpy).toHaveBeenCalled());

      const bindingId = flowInputBindingId(
        BUILD_GRAPH_SUMMARY_MODULE_SUMMARIES_SLOT_ID,
        BUILD_GRAPH_SUMMARY_MODULE_SUMMARIES_SOURCE_ID,
      );
      fireEvent.click(await findTestIdElementByFragments("graph-edge-hitarea:", [bindingId]));
      flowGraphPanel.focus();

      const replaceCallsBeforeDelete = editSpy.mock.calls.length;
      fireEvent.keyDown(flowGraphPanel, { key: "Delete" });

      await waitFor(() =>
        expect(editSpy.mock.calls.length).toBeGreaterThan(replaceCallsBeforeDelete),
      );
      const replaceRequest = lastReplaceFlowGraphRequest(editSpy);
      expect(replaceRequest).toEqual(
        expect.objectContaining({
          kind: "replace_flow_graph",
          targetId: BUILD_GRAPH_SUMMARY_SYMBOL_ID,
        }),
      );
      expect(
        replaceRequest?.flowGraph?.inputBindings?.some((binding) => binding.id === bindingId),
      ).toBe(false);
      expect(replaceRequest?.flowGraph?.inputSlots).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: BUILD_GRAPH_SUMMARY_MODULE_SUMMARIES_SLOT_ID,
          }),
        ]),
      );

      await emitSameSymbolRefetch(adapter, flowViewSpy, [
        BUILD_GRAPH_SUMMARY_ASSIGN_MODULES_ID,
        BUILD_GRAPH_SUMMARY_CALL_RANK_ID,
      ]);

      expect(queryTestIdElementByFragments("graph-edge-hitarea:", [bindingId])).toBeUndefined();
      expect(
        await findFlowHandle(
          BUILD_GRAPH_SUMMARY_CALL_RANK_ID,
          flowInputSlotTargetHandle(BUILD_GRAPH_SUMMARY_MODULE_SUMMARIES_SLOT_ID),
        ),
      ).toBeInTheDocument();
    },
    WORKSPACE_TEST_TIMEOUT_MS,
  );

  it(
    "shows return value inputs plus derived completion without persisting the completion edge",
    async () => {
      const user = userEvent.setup();
      mockGraphElementRect();
      useUiStore.setState({ flowInputDisplayMode: "entry" });
      const adapter = new SyncAwareMockDesktopAdapter();
      const editSpy = vi.spyOn(adapter, "applyStructuralEdit");
      const flowViewSpy = vi.spyOn(adapter, "getFlowView");
      const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
        initialEntries: ["/workspace"],
      });

      const rendered = render(
        <AppProviders adapter={adapter}>
          <RouterProvider router={router} />
        </AppProviders>,
      );

      const { flowGraphPanel } = await openBuildGraphSummaryFlow(user);
      await waitFor(() => expect(flowViewSpy).toHaveBeenCalled());

      const returnValueBindingId = flowInputBindingId(
        BUILD_GRAPH_SUMMARY_RETURN_MODULE_SUMMARIES_SLOT_ID,
        BUILD_GRAPH_SUMMARY_MODULE_SUMMARIES_SOURCE_ID,
      );
      expect(
        await findFlowHandle(
          BUILD_GRAPH_SUMMARY_RETURN_ID,
          flowInputSlotTargetHandle(BUILD_GRAPH_SUMMARY_RETURN_MODULE_SUMMARIES_SLOT_ID),
        ),
      ).toBeInTheDocument();
      expect(
        await findFlowHandle(BUILD_GRAPH_SUMMARY_RETURN_ID, "out:control:exit"),
      ).toBeInTheDocument();
      expect(
        await findTestIdElementByFragments("graph-edge-hitarea:", [returnValueBindingId]),
      ).toBeInTheDocument();
      expect(
        await findTestIdElementByFragments("graph-edge-hitarea:", [
          BUILD_GRAPH_SUMMARY_RETURN_COMPLETION_EDGE_ID,
        ]),
      ).toBeInTheDocument();

      const document = (await adapter.getFlowView(BUILD_GRAPH_SUMMARY_SYMBOL_ID)).flowState
        ?.document;
      expect(document?.inputBindings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: returnValueBindingId,
            sourceId: BUILD_GRAPH_SUMMARY_MODULE_SUMMARIES_SOURCE_ID,
            slotId: BUILD_GRAPH_SUMMARY_RETURN_MODULE_SUMMARIES_SLOT_ID,
          }),
        ]),
      );
      expect(
        document?.edges.some((edge) => edge.id === BUILD_GRAPH_SUMMARY_RETURN_COMPLETION_EDGE_ID),
      ).toBe(false);

      const replaceCallsBeforeRewire = editSpy.mock.calls.length;
      dragConnectionToHandle({
        dragStart: await findFlowHandle(
          BUILD_GRAPH_SUMMARY_ENTRY_ID,
          flowInputSourceHandle(BUILD_GRAPH_SUMMARY_TOP_N_INPUT_ID),
        ),
        targetHandle: await findFlowHandle(
          BUILD_GRAPH_SUMMARY_RETURN_ID,
          flowInputSlotTargetHandle(BUILD_GRAPH_SUMMARY_RETURN_MODULE_SUMMARIES_SLOT_ID),
        ),
      });

      await waitFor(() =>
        expect(editSpy.mock.calls.length).toBeGreaterThan(replaceCallsBeforeRewire),
      );
      const replaceRequest = lastReplaceFlowGraphRequest(editSpy);
      expectFlowBinding(
        replaceRequest?.flowGraph,
        BUILD_GRAPH_SUMMARY_RETURN_MODULE_SUMMARIES_SLOT_ID,
        BUILD_GRAPH_SUMMARY_TOP_N_INPUT_ID,
      );
      expect(
        replaceRequest?.flowGraph?.inputBindings?.some(
          (binding) =>
            binding.slotId === BUILD_GRAPH_SUMMARY_RETURN_MODULE_SUMMARIES_SLOT_ID &&
            binding.sourceId === BUILD_GRAPH_SUMMARY_MODULE_SUMMARIES_SOURCE_ID,
        ),
      ).toBe(false);
      expect(
        replaceRequest?.flowGraph?.edges.some(
          (edge) => edge.id === BUILD_GRAPH_SUMMARY_RETURN_COMPLETION_EDGE_ID,
        ),
      ).toBe(false);

      const rewiredReturnBindingId = flowInputBindingId(
        BUILD_GRAPH_SUMMARY_RETURN_MODULE_SUMMARIES_SLOT_ID,
        BUILD_GRAPH_SUMMARY_TOP_N_INPUT_ID,
      );
      await emitSameSymbolRefetch(adapter, flowViewSpy, [
        BUILD_GRAPH_SUMMARY_RETURN_ID,
        BUILD_GRAPH_SUMMARY_EXIT_ID,
      ]);

      expect(
        await findTestIdElementByFragments("graph-edge-hitarea:", [rewiredReturnBindingId]),
      ).toBeInTheDocument();
      expect(
        await findTestIdElementByFragments("graph-edge-hitarea:", [
          BUILD_GRAPH_SUMMARY_RETURN_COMPLETION_EDGE_ID,
        ]),
      ).toBeInTheDocument();

      const replaceCallsBeforeDelete = editSpy.mock.calls.length;
      fireEvent.click(
        await findTestIdElementByFragments("graph-edge-hitarea:", [
          BUILD_GRAPH_SUMMARY_RETURN_COMPLETION_EDGE_ID,
        ]),
      );
      flowGraphPanel.focus();
      fireEvent.keyDown(flowGraphPanel, { key: "Delete" });

      expect(
        await findTestIdElementByFragments("graph-edge-hitarea:", [
          BUILD_GRAPH_SUMMARY_RETURN_COMPLETION_EDGE_ID,
        ]),
      ).toBeInTheDocument();
      expect(editSpy.mock.calls.length).toBe(replaceCallsBeforeDelete);

      rendered.unmount();
      resetStore();
      useUiStore.setState({ flowInputDisplayMode: "entry" });
      const reopenedRouter = createMemoryRouter(
        [{ path: "/workspace", element: <WorkspaceScreen /> }],
        { initialEntries: ["/workspace"] },
      );
      render(
        <AppProviders adapter={adapter}>
          <RouterProvider router={reopenedRouter} />
        </AppProviders>,
      );

      const reopenedUser = userEvent.setup();
      await openBuildGraphSummaryFlow(reopenedUser);
      expect(
        await findTestIdElementByFragments("graph-edge-hitarea:", [rewiredReturnBindingId]),
      ).toBeInTheDocument();
      expect(
        await findTestIdElementByFragments("graph-edge-hitarea:", [
          BUILD_GRAPH_SUMMARY_RETURN_COMPLETION_EDGE_ID,
        ]),
      ).toBeInTheDocument();
    },
    WORKSPACE_TEST_TIMEOUT_MS,
  );

  it(
    "keeps a failed flow draft save visible and recoverable",
    async () => {
      const user = userEvent.setup();
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
        () =>
          ({
            x: 0,
            y: 0,
            top: 0,
            left: 0,
            right: 240,
            bottom: 96,
            width: 240,
            height: 96,
            toJSON: () => ({}),
          }) as DOMRect,
      );
      const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
        initialEntries: ["/workspace"],
      });

      render(
        <AppProviders adapter={new FlowSaveFailureMockDesktopAdapter()}>
          <RouterProvider router={router} />
        </AppProviders>,
      );

      const graphPanel = document.querySelector(".graph-panel");
      expect(graphPanel).not.toBeNull();
      const graph = within(graphPanel as HTMLElement);
      fireEvent.doubleClick(await graph.findByText("api.py"));
      const functionNode = (await graph.findByText("build_graph_summary")).closest(".graph-node");
      expect(functionNode).not.toBeNull();
      fireEvent.click(within(functionNode as HTMLElement).getByText("Inspect"));
      await user.click(await screen.findByRole("button", { name: /Open flow/i }));

      const flowGraphPanel = await waitForFunctionFlowReady("build_graph_summary");
      const graphPane = await ensureFlowCreateMode(flowGraphPanel);
      await user.click(graphPane);

      await user.type(
        screen.getByRole("textbox", { name: /Flow statement/i }),
        "helper = rank_modules(graph)",
      );
      await user.click(screen.getByRole("button", { name: /Create node/i }));

      expect(await screen.findByText("Mock flow save failed.")).toBeInTheDocument();
      expect((await screen.findAllByText(/rank_modules/i)).length).toBeGreaterThan(0);
      expect(useUiStore.getState().activeNodeId).toMatch(
        /^flowdoc:symbol:helm\.ui\.api:build_graph_summary:assign:/,
      );
    },
    WORKSPACE_TEST_TIMEOUT_MS,
  );

  it(
    "edits an existing flow node via the popover and persists through replace_flow_graph",
    async () => {
      const user = userEvent.setup();
      const adapter = new MockDesktopAdapter();
      const editSpy = vi.spyOn(adapter, "applyStructuralEdit");
      const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
        initialEntries: ["/workspace"],
      });

      render(
        <AppProviders adapter={adapter}>
          <RouterProvider router={router} />
        </AppProviders>,
      );

      const graphPanel = document.querySelector(".graph-panel");
      expect(graphPanel).not.toBeNull();
      const graph = within(graphPanel as HTMLElement);
      fireEvent.doubleClick(await graph.findByText("api.py"));
      const functionNode = (await graph.findByText("build_graph_summary")).closest(".graph-node");
      expect(functionNode).not.toBeNull();
      fireEvent.click(within(functionNode as HTMLElement).getByText("Inspect"));
      await user.click(await screen.findByRole("button", { name: /Open flow/i }));

      const authoredNode = await screen.findByTestId(
        "rf__node-flow:symbol:helm.ui.api:build_graph_summary:assign:modules",
      );
      fireEvent.doubleClick(authoredNode);

      expect(await screen.findByRole("heading", { name: /Edit flow node/i })).toBeInTheDocument();
      const statementInput = screen.getByRole("textbox", { name: /Flow statement/i });
      await user.clear(statementInput);
      await user.type(statementInput, "module_summaries = rank_modules(graph)");
      await user.click(screen.getByRole("button", { name: /Save node/i }));

      await waitFor(() =>
        expect(editSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            kind: "replace_flow_graph",
            targetId: "symbol:helm.ui.api:build_graph_summary",
          }),
        ),
      );
      const replaceRequest = editSpy.mock.calls
        .map(([request]) => request)
        .filter((request) => request.kind === "replace_flow_graph")
        .slice(-1)[0];
      expect(
        replaceRequest?.flowGraph?.nodes.find(
          (node: { id: string }) =>
            node.id === "flow:symbol:helm.ui.api:build_graph_summary:assign:modules",
        )?.payload,
      ).toEqual({
        source: "module_summaries = rank_modules(graph)",
      });
      await waitFor(() =>
        expect(
          screen.getByTestId("rf__node-flow:symbol:helm.ui.api:build_graph_summary:assign:modules"),
        ).toHaveTextContent("module_summaries = rank_modules(graph)"),
      );
    },
    WORKSPACE_TEST_TIMEOUT_MS,
  );

  it(
    "edits a newly spawned flow node through the same popover while create mode stays available",
    async () => {
      const user = userEvent.setup();
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
        () =>
          ({
            x: 0,
            y: 0,
            top: 0,
            left: 0,
            right: 240,
            bottom: 96,
            width: 240,
            height: 96,
            toJSON: () => ({}),
          }) as DOMRect,
      );
      const adapter = new MockDesktopAdapter();
      const editSpy = vi.spyOn(adapter, "applyStructuralEdit");
      const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
        initialEntries: ["/workspace"],
      });

      render(
        <AppProviders adapter={adapter}>
          <RouterProvider router={router} />
        </AppProviders>,
      );

      const graphPanel = document.querySelector(".graph-panel");
      expect(graphPanel).not.toBeNull();
      const graph = within(graphPanel as HTMLElement);
      fireEvent.doubleClick(await graph.findByText("api.py"));
      const functionNode = (await graph.findByText("build_graph_summary")).closest(".graph-node");
      expect(functionNode).not.toBeNull();
      fireEvent.click(within(functionNode as HTMLElement).getByText("Inspect"));
      await user.click(await screen.findByRole("button", { name: /Open flow/i }));

      const flowGraphPanel = await waitForFunctionFlowReady("build_graph_summary");
      const graphPane = await ensureFlowCreateMode(flowGraphPanel);
      fireEvent.click(graphPane, { clientX: 180, clientY: 140 });
      await user.type(
        screen.getByRole("textbox", { name: /Flow statement/i }),
        "helper = rank_modules(graph)",
      );
      await user.click(screen.getByRole("button", { name: /Create node/i }));

      const createdNodeId = useUiStore.getState().activeNodeId;
      expect(createdNodeId).toMatch(/^flowdoc:symbol:helm\.ui\.api:build_graph_summary:assign:/);
      await waitFor(() =>
        expect(
          screen.queryByRole("heading", { name: /Create flow node/i }),
        ).not.toBeInTheDocument(),
      );
      expect(screen.getByTestId("graph-create-mode-badge")).toBeInTheDocument();

      fireEvent.doubleClick(await screen.findByTestId(`rf__node-${createdNodeId}`));
      expect(await screen.findByRole("heading", { name: /Edit flow node/i })).toBeInTheDocument();
      const statementInput = screen.getByRole("textbox", { name: /Flow statement/i });
      await user.clear(statementInput);
      await user.type(statementInput, "helper = rescore_modules(graph)");
      await user.click(await screen.findByRole("button", { name: /Save node/i }));

      await waitFor(() =>
        expect(editSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            kind: "replace_flow_graph",
            targetId: "symbol:helm.ui.api:build_graph_summary",
          }),
        ),
      );
      const replaceRequest = lastReplaceFlowGraphRequest(editSpy);
      expect(
        replaceRequest?.flowGraph?.nodes.find((node: { id: string }) => node.id === createdNodeId)
          ?.payload,
      ).toEqual({
        source: "helper = rescore_modules(graph)",
      });
      expect(
        (await screen.findAllByText("helper = rescore_modules(graph)")).length,
      ).toBeGreaterThan(0);
      expect(screen.getByTestId("graph-create-mode-badge")).toBeInTheDocument();
    },
    WORKSPACE_TEST_TIMEOUT_MS,
  );

  it(
    "persists a flow connect action through replace_flow_graph and a same-symbol refetch",
    async () => {
      const user = userEvent.setup();
      mockGraphElementRect();
      const adapter = new SyncAwareMockDesktopAdapter();
      const editSpy = vi.spyOn(adapter, "applyStructuralEdit");
      const flowViewSpy = vi.spyOn(adapter, "getFlowView");
      const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
        initialEntries: ["/workspace"],
      });

      render(
        <AppProviders adapter={adapter}>
          <RouterProvider router={router} />
        </AppProviders>,
      );

      const { flowGraphPanel } = await openBuildGraphSummaryFlow(user);
      await waitFor(() => expect(flowViewSpy).toHaveBeenCalled());

      const branchNodeId = await createDraftFlowNode({
        user,
        flowGraphPanel,
        position: { clientX: 260, clientY: 180 },
        kind: "branch",
        content: "module_summaries",
      });
      const returnNodeId = await createDraftFlowNode({
        user,
        flowGraphPanel,
        position: { clientX: 520, clientY: 180 },
        kind: "return",
        content: "return module_summaries",
      });

      const replaceCallsBeforeConnect = editSpy.mock.calls.length;
      dragConnectionToHandle({
        dragStart: await findFlowHandle(branchNodeId, "out:control:true"),
        onDragMove: () => {
          expect(screen.getByTestId("graph-connection-line")).toBeInTheDocument();
        },
        targetHandle: await findFlowHandle(returnNodeId, "in:control:exec"),
      });

      await waitFor(() =>
        expect(editSpy.mock.calls.length).toBeGreaterThan(replaceCallsBeforeConnect),
      );
      const expectedEdgeId = `controls:${branchNodeId}:true->${returnNodeId}:in`;
      const replaceRequest = lastReplaceFlowGraphRequest(editSpy);
      expect(replaceRequest).toEqual(
        expect.objectContaining({
          kind: "replace_flow_graph",
          targetId: BUILD_GRAPH_SUMMARY_SYMBOL_ID,
        }),
      );
      expect(
        replaceRequest?.flowGraph?.edges.some((edge: { id: string }) => edge.id === expectedEdgeId),
      ).toBe(true);

      await emitSameSymbolRefetch(adapter, flowViewSpy, [branchNodeId, returnNodeId]);

      expect(
        await findTestIdElementByFragments("graph-edge-hitarea:", [expectedEdgeId]),
      ).toBeInTheDocument();
      expect(await screen.findByTestId(`rf__node-${branchNodeId}`)).toBeInTheDocument();
      expect(await screen.findByTestId(`rf__node-${returnNodeId}`)).toBeInTheDocument();
    },
    WORKSPACE_TEST_TIMEOUT_MS,
  );

  it(
    "persists a flow reconnect action through replace_flow_graph and a same-symbol refetch",
    async () => {
      const user = userEvent.setup();
      mockGraphElementRect();
      const adapter = new SyncAwareMockDesktopAdapter();
      const editSpy = vi.spyOn(adapter, "applyStructuralEdit");
      const flowViewSpy = vi.spyOn(adapter, "getFlowView");
      const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
        initialEntries: ["/workspace"],
      });

      render(
        <AppProviders adapter={adapter}>
          <RouterProvider router={router} />
        </AppProviders>,
      );

      const { flowGraphPanel } = await openBuildGraphSummaryFlow(user);
      await waitFor(() => expect(flowViewSpy).toHaveBeenCalled());

      const returnNodeId = await createDraftFlowNode({
        user,
        flowGraphPanel,
        position: { clientX: 560, clientY: 220 },
        kind: "return",
        content: "return ranked_modules",
      });

      const reconnectTarget = await findTestIdElementByFragments("rf__edge-", [
        BUILD_GRAPH_SUMMARY_RANK_TO_RETURN_EDGE_ID,
      ]);
      const targetUpdater = reconnectTarget.querySelector(".react-flow__edgeupdater-target");
      expect(targetUpdater).not.toBeNull();
      const replaceCallsBeforeReconnect = editSpy.mock.calls.length;
      dragConnectionToHandle({
        dragStart: targetUpdater as Element,
        targetHandle: await findFlowHandle(returnNodeId, "in:control:exec"),
      });

      await waitFor(() =>
        expect(editSpy.mock.calls.length).toBeGreaterThan(replaceCallsBeforeReconnect),
      );
      const expectedEdgeId = `controls:flow:symbol:helm.ui.api:build_graph_summary:call:rank:next->${returnNodeId}:in`;
      const replaceRequest = lastReplaceFlowGraphRequest(editSpy);
      expect(replaceRequest).toEqual(
        expect.objectContaining({
          kind: "replace_flow_graph",
          targetId: BUILD_GRAPH_SUMMARY_SYMBOL_ID,
        }),
      );
      expect(
        replaceRequest?.flowGraph?.edges.some((edge: { id: string }) => edge.id === expectedEdgeId),
      ).toBe(true);
      expect(
        replaceRequest?.flowGraph?.edges.some(
          (edge: { id: string }) => edge.id === BUILD_GRAPH_SUMMARY_RANK_TO_RETURN_EDGE_ID,
        ),
      ).toBe(false);

      await emitSameSymbolRefetch(adapter, flowViewSpy, [returnNodeId]);

      expect(
        await findTestIdElementByFragments("graph-edge-hitarea:", [expectedEdgeId]),
      ).toBeInTheDocument();
      expect(
        queryTestIdElementByFragments("graph-edge-hitarea:", [
          BUILD_GRAPH_SUMMARY_RANK_TO_RETURN_EDGE_ID,
        ]),
      ).toBeUndefined();
    },
    WORKSPACE_TEST_TIMEOUT_MS,
  );

  it(
    "persists Alt-click control-edge disconnect through replace_flow_graph and a same-symbol refetch",
    async () => {
      const user = userEvent.setup();
      mockGraphElementRect();
      const adapter = new SyncAwareMockDesktopAdapter();
      const editSpy = vi.spyOn(adapter, "applyStructuralEdit");
      const flowViewSpy = vi.spyOn(adapter, "getFlowView");
      const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
        initialEntries: ["/workspace"],
      });

      render(
        <AppProviders adapter={adapter}>
          <RouterProvider router={router} />
        </AppProviders>,
      );

      await openBuildGraphSummaryFlow(user);
      await waitFor(() => expect(flowViewSpy).toHaveBeenCalled());

      const replaceCallsBeforeDisconnect = editSpy.mock.calls.length;
      fireEvent.click(
        await findTestIdElementByFragments("graph-edge-hitarea:", [
          BUILD_GRAPH_SUMMARY_RANK_TO_RETURN_EDGE_ID,
        ]),
        { altKey: true },
      );

      await waitFor(() =>
        expect(editSpy.mock.calls.length).toBeGreaterThan(replaceCallsBeforeDisconnect),
      );
      const replaceRequest = lastReplaceFlowGraphRequest(editSpy);
      expect(replaceRequest).toEqual(
        expect.objectContaining({
          kind: "replace_flow_graph",
          targetId: BUILD_GRAPH_SUMMARY_SYMBOL_ID,
        }),
      );
      expect(
        replaceRequest?.flowGraph?.edges.some(
          (edge: { id: string }) => edge.id === BUILD_GRAPH_SUMMARY_RANK_TO_RETURN_EDGE_ID,
        ),
      ).toBe(false);

      await emitSameSymbolRefetch(adapter, flowViewSpy, []);

      expect(
        queryTestIdElementByFragments("graph-edge-hitarea:", [
          BUILD_GRAPH_SUMMARY_RANK_TO_RETURN_EDGE_ID,
        ]),
      ).toBeUndefined();
      expect(
        await screen.findByTestId(
          "rf__node-flow:symbol:helm.ui.api:build_graph_summary:assign:modules",
        ),
      ).toBeInTheDocument();
      expect(
        await screen.findByTestId("rf__node-flow:symbol:helm.ui.api:build_graph_summary:call:rank"),
      ).toBeInTheDocument();
      expect(
        await screen.findByTestId("rf__node-flow:symbol:helm.ui.api:build_graph_summary:return"),
      ).toBeInTheDocument();
    },
    WORKSPACE_TEST_TIMEOUT_MS,
  );

  it(
    "keeps invalid flow deletions as visible drafts with source unchanged",
    async () => {
      const user = userEvent.setup();
      const adapter = new MockDesktopAdapter();
      const editSpy = vi.spyOn(adapter, "applyStructuralEdit");
      const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
        initialEntries: ["/workspace"],
      });

      render(
        <AppProviders adapter={adapter}>
          <RouterProvider router={router} />
        </AppProviders>,
      );

      const graphPanel = document.querySelector(".graph-panel");
      expect(graphPanel).not.toBeNull();
      const graph = within(graphPanel as HTMLElement);
      fireEvent.doubleClick(await graph.findByText("api.py"));
      const functionNode = (await graph.findByText("build_graph_summary")).closest(".graph-node");
      expect(functionNode).not.toBeNull();
      fireEvent.click(within(functionNode as HTMLElement).getByText("Inspect"));
      await user.click(await screen.findByRole("button", { name: /Open flow/i }));

      const flowGraphPanel = await waitForFunctionFlowReady("build_graph_summary");
      flowGraphPanel.focus();
      const sourceBeforeDelete = (
        (await screen.findByRole("textbox", {
          name: /Function source editor/i,
        })) as HTMLTextAreaElement
      ).value;
      const sourceBackedNodeId = "flow:symbol:helm.ui.api:build_graph_summary:assign:modules";
      fireEvent.click(await screen.findByTestId(`rf__node-${sourceBackedNodeId}`));
      const replaceCallsBeforeDelete = editSpy.mock.calls.length;
      fireEvent.keyDown(flowGraphPanel, { key: "Backspace" });

      await waitFor(() =>
        expect(editSpy.mock.calls.length).toBeGreaterThan(replaceCallsBeforeDelete),
      );
      const replaceRequest = lastReplaceFlowGraphRequest(editSpy);
      expect(replaceRequest).toEqual(
        expect.objectContaining({
          kind: "replace_flow_graph",
          targetId: "symbol:helm.ui.api:build_graph_summary",
        }),
      );
      expect(replaceRequest?.flowGraph?.nodes.map((node: { id: string }) => node.id)).not.toContain(
        sourceBackedNodeId,
      );
      await waitFor(() =>
        expect(screen.queryByTestId(`rf__node-${sourceBackedNodeId}`)).not.toBeInTheDocument(),
      );
      expect(screen.getByRole("heading", { name: /Internal flow/i })).toBeInTheDocument();
      expect(
        within(screen.getByRole("navigation", { name: /Graph path/i })).getByText("Flow"),
      ).toBeInTheDocument();
      expect(await screen.findByText("Draft only")).toBeInTheDocument();
      expect(await screen.findByText("Not applied to code")).toBeInTheDocument();
      expect(await screen.findByText(/Python source was left unchanged/i)).toBeInTheDocument();
      expect((await screen.findAllByText(/disconnected/i)).length).toBeGreaterThan(0);
      expect(
        (screen.getByRole("textbox", { name: /Function source editor/i }) as HTMLTextAreaElement)
          .value,
      ).toBe(sourceBeforeDelete);
    },
    WORKSPACE_TEST_TIMEOUT_MS,
  );

  it(
    "refreshes inspector source immediately after clean flow deletions update code",
    async () => {
      const user = userEvent.setup();
      const adapter = new MockDesktopAdapter();
      const editSpy = vi.spyOn(adapter, "applyStructuralEdit");
      const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
        initialEntries: ["/workspace"],
      });

      render(
        <AppProviders adapter={adapter}>
          <RouterProvider router={router} />
        </AppProviders>,
      );

      const { flowGraphPanel } = await openBuildGraphSummaryFlow(user);
      const editor = await screen.findByRole("textbox", { name: /Function source editor/i });
      expect((editor as HTMLTextAreaElement).value).toContain("return GraphSummary");

      (flowGraphPanel as HTMLElement).focus();
      fireEvent.click(await screen.findByTestId(`rf__node-${BUILD_GRAPH_SUMMARY_RETURN_ID}`));
      const replaceCallsBeforeDelete = editSpy.mock.calls.length;
      fireEvent.keyDown(flowGraphPanel as HTMLElement, { key: "Backspace" });

      await waitFor(() =>
        expect(editSpy.mock.calls.length).toBeGreaterThan(replaceCallsBeforeDelete),
      );
      await waitFor(() => {
        const refreshedSource = (
          screen.getByRole("textbox", { name: /Function source editor/i }) as HTMLTextAreaElement
        ).value;
        expect(refreshedSource).not.toContain("return GraphSummary");
        expect(refreshedSource).toContain("collect_module_stats(graph)");
      });
      expect(screen.queryByText("Draft only")).not.toBeInTheDocument();
      expect(
        lastReplaceFlowGraphRequest(editSpy)?.flowGraph?.nodes.map(
          (node: { id: string }) => node.id,
        ),
      ).not.toContain(BUILD_GRAPH_SUMMARY_RETURN_ID);
    },
    WORKSPACE_TEST_TIMEOUT_MS,
  );

  it(
    "deletes newly spawned flow nodes through replace_flow_graph",
    async () => {
      const user = userEvent.setup();
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
        () =>
          ({
            x: 0,
            y: 0,
            top: 0,
            left: 0,
            right: 240,
            bottom: 96,
            width: 240,
            height: 96,
            toJSON: () => ({}),
          }) as DOMRect,
      );
      const adapter = new MockDesktopAdapter();
      const editSpy = vi.spyOn(adapter, "applyStructuralEdit");
      const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
        initialEntries: ["/workspace"],
      });

      render(
        <AppProviders adapter={adapter}>
          <RouterProvider router={router} />
        </AppProviders>,
      );

      const graphPanel = document.querySelector(".graph-panel");
      expect(graphPanel).not.toBeNull();
      const graph = within(graphPanel as HTMLElement);
      fireEvent.doubleClick(await graph.findByText("api.py"));
      const functionNode = (await graph.findByText("build_graph_summary")).closest(".graph-node");
      expect(functionNode).not.toBeNull();
      fireEvent.click(within(functionNode as HTMLElement).getByText("Inspect"));
      await user.click(await screen.findByRole("button", { name: /Open flow/i }));

      const flowGraphPanel = await waitForFunctionFlowReady("build_graph_summary");
      const graphPane = await ensureFlowCreateMode(flowGraphPanel);
      fireEvent.click(graphPane, { clientX: 180, clientY: 140 });
      await user.type(
        screen.getByRole("textbox", { name: /Flow statement/i }),
        "helper = rank_modules(graph)",
      );
      await user.click(screen.getByRole("button", { name: /Create node/i }));

      const createdNodeId = useUiStore.getState().activeNodeId;
      expect(createdNodeId).toMatch(/^flowdoc:symbol:helm\.ui\.api:build_graph_summary:assign:/);
      await waitFor(() =>
        expect(
          screen.queryByRole("heading", { name: /Create flow node/i }),
        ).not.toBeInTheDocument(),
      );

      fireEvent.click(await screen.findByTestId(`rf__node-${createdNodeId}`));
      const replaceCallsBeforeDelete = editSpy.mock.calls.length;
      fireEvent.keyDown(flowGraphPanel as HTMLElement, { key: "Delete" });

      await waitFor(() =>
        expect(editSpy.mock.calls.length).toBeGreaterThan(replaceCallsBeforeDelete),
      );
      const replaceRequest = lastReplaceFlowGraphRequest(editSpy);
      expect(replaceRequest).toEqual(
        expect.objectContaining({
          kind: "replace_flow_graph",
          targetId: "symbol:helm.ui.api:build_graph_summary",
        }),
      );
      expect(replaceRequest?.flowGraph?.nodes.map((node: { id: string }) => node.id)).not.toContain(
        createdNodeId,
      );
      await waitFor(() =>
        expect(screen.queryByTestId(`rf__node-${createdNodeId}`)).not.toBeInTheDocument(),
      );
    },
    WORKSPACE_TEST_TIMEOUT_MS,
  );

  it(
    "keeps create mode unavailable in class flow and does not open the composer",
    async () => {
      const user = userEvent.setup();
      const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
        initialEntries: ["/workspace"],
      });

      render(
        <AppProviders adapter={new MockDesktopAdapter()}>
          <RouterProvider router={router} />
        </AppProviders>,
      );

      const graphPanel = document.querySelector(".graph-panel");
      expect(graphPanel).not.toBeNull();
      const graph = within(graphPanel as HTMLElement);
      fireEvent.doubleClick(await graph.findByText("api.py"));
      const classNode = (await graph.findByText("GraphSummary")).closest(".graph-node");
      expect(classNode).not.toBeNull();
      fireEvent.click(within(classNode as HTMLElement).getByText("Inspect"));
      await user.click(await screen.findByRole("button", { name: /Open flow/i }));
      expect(await graph.findByText("repo_path")).toBeInTheDocument();
      await waitFor(() =>
        expect((graphPanel as HTMLElement).querySelector(".react-flow__pane")).not.toBeNull(),
      );
      const graphPane = (graphPanel as HTMLElement).querySelector(".react-flow__pane");

      (graphPanel as HTMLElement).focus();
      fireEvent.keyDown(graphPanel as HTMLElement, { key: "c" });

      await waitFor(() =>
        expect(screen.queryByTestId("graph-create-mode-badge")).not.toBeInTheDocument(),
      );
      await user.click(graphPane as HTMLElement);
      expect(screen.queryByTestId("graph-create-composer")).not.toBeInTheDocument();
    },
    WORKSPACE_TEST_TIMEOUT_MS,
  );

  it(
    "keeps import_error function flows non-authorable and does not expose flow edit tooling",
    async () => {
      const user = userEvent.setup();
      const adapter = new ImportErrorFlowMockDesktopAdapter();
      const editSpy = vi.spyOn(adapter, "applyStructuralEdit");
      const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
        initialEntries: ["/workspace"],
      });

      render(
        <AppProviders adapter={adapter}>
          <RouterProvider router={router} />
        </AppProviders>,
      );

      const graphPanel = document.querySelector(".graph-panel");
      expect(graphPanel).not.toBeNull();
      const graph = within(graphPanel as HTMLElement);
      fireEvent.doubleClick(await graph.findByText("api.py"));
      const functionNode = (await graph.findByText("build_graph_summary")).closest(".graph-node");
      expect(functionNode).not.toBeNull();
      fireEvent.click(within(functionNode as HTMLElement).getByText("Inspect"));
      await user.click(await screen.findByRole("button", { name: /Open flow/i }));

      const flowGraphPanel = await waitForFunctionFlowReady("build_graph_summary");
      flowGraphPanel.focus();
      fireEvent.keyDown(flowGraphPanel, { key: "c" });
      await waitFor(() =>
        expect(screen.queryByTestId("graph-create-mode-badge")).not.toBeInTheDocument(),
      );

      const authoredNode = await screen.findByTestId(
        "rf__node-flow:symbol:helm.ui.api:build_graph_summary:assign:modules",
      );
      fireEvent.doubleClick(authoredNode);
      expect(screen.queryByTestId("graph-create-composer")).not.toBeInTheDocument();

      fireEvent.click(authoredNode);
      fireEvent.keyDown(window, { key: "Delete" });
      expect(editSpy).not.toHaveBeenCalled();
    },
    WORKSPACE_TEST_TIMEOUT_MS,
  );

  it(
    "closes the create composer with Escape before exiting create mode",
    async () => {
      const user = userEvent.setup();
      setGraphFocusForTest({
        targetId: "module:helm.ui.api",
        level: "module",
        activeNodeId: undefined,
        activeSymbolId: undefined,
      });

      const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
        initialEntries: ["/workspace"],
      });

      render(
        <AppProviders adapter={new MockDesktopAdapter()}>
          <RouterProvider router={router} />
        </AppProviders>,
      );

      const graphPanel = document.querySelector(".graph-panel");
      expect(graphPanel).not.toBeNull();
      await waitFor(() =>
        expect((graphPanel as HTMLElement).querySelector(".react-flow__pane")).not.toBeNull(),
      );
      const graphPane = (graphPanel as HTMLElement).querySelector(".react-flow__pane");

      (graphPanel as HTMLElement).focus();
      fireEvent.keyDown(graphPanel as HTMLElement, { key: "c" });
      await user.click(graphPane as HTMLElement);
      expect(await screen.findByTestId("graph-create-composer")).toBeInTheDocument();

      fireEvent.keyDown(window, { key: "Escape" });
      await waitFor(() =>
        expect(screen.queryByTestId("graph-create-composer")).not.toBeInTheDocument(),
      );
      expect(screen.getByTestId("graph-create-mode-badge")).toBeInTheDocument();

      fireEvent.keyDown(window, { key: "Escape" });
      await waitFor(() =>
        expect(screen.queryByTestId("graph-create-mode-badge")).not.toBeInTheDocument(),
      );
    },
    WORKSPACE_TEST_TIMEOUT_MS,
  );

  it(
    "keeps function flow focused when Backspace is pressed without a selected flow deletion",
    async () => {
      const user = userEvent.setup();
      const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
        initialEntries: ["/workspace"],
      });

      render(
        <AppProviders adapter={new MockDesktopAdapter()}>
          <RouterProvider router={router} />
        </AppProviders>,
      );

      const graphPanel = document.querySelector(".graph-panel");
      expect(graphPanel).not.toBeNull();
      const graph = within(graphPanel as HTMLElement);

      fireEvent.doubleClick(await graph.findByText("api.py"));

      const functionNode = (await graph.findByText("build_graph_summary")).closest(".graph-node");
      expect(functionNode).not.toBeNull();
      fireEvent.click(within(functionNode as HTMLElement).getByText("Inspect"));
      await user.click(await screen.findByRole("button", { name: /Open flow/i }));

      expect(await screen.findByRole("heading", { name: /Internal flow/i })).toBeInTheDocument();
      (graphPanel as HTMLElement).focus();
      fireEvent.keyDown(graphPanel as HTMLElement, { key: "Backspace" });

      expect(
        within(screen.getByRole("navigation", { name: /Graph path/i })).getByText("Flow"),
      ).toBeInTheDocument();
      expect(screen.queryByText(/Symbol blueprint/i)).not.toBeInTheDocument();
    },
    WORKSPACE_TEST_TIMEOUT_MS,
  );

  it("treats class nodes as both inspectable and enterable", async () => {
    const user = userEvent.setup();
    const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
      initialEntries: ["/workspace"],
    });

    render(
      <AppProviders adapter={new MockDesktopAdapter()}>
        <RouterProvider router={router} />
      </AppProviders>,
    );

    const graphPanel = document.querySelector(".graph-panel");
    expect(graphPanel).not.toBeNull();
    const graph = within(graphPanel as HTMLElement);

    fireEvent.doubleClick(await graph.findByText("api.py"));

    const classNode = (await graph.findByText("GraphSummary")).closest(".graph-node");
    expect(classNode).not.toBeNull();
    expect(within(classNode as HTMLElement).getByText("Inspect")).toBeInTheDocument();
    expect(within(classNode as HTMLElement).getByText("Enter")).toBeInTheDocument();

    fireEvent.click(within(classNode as HTMLElement).getByText("Inspect"));

    expect(await screen.findByText(/Declaration editor/i)).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: /Open File In Default Editor/i }),
    ).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Open flow/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Open blueprint/i })).not.toBeInTheDocument();

    await user.click(screen.getByTestId("blueprint-inspector-panel-collapse"));
    expect(await screen.findByTestId("blueprint-inspector-drawer")).toHaveAttribute(
      "data-mode",
      "collapsed",
    );
    fireEvent.click(within(classNode as HTMLElement).getByText("Enter"));

    expect(await screen.findByText(/Symbol blueprint/i)).toBeInTheDocument();
    expect(await screen.findByText("repo_path")).toBeInTheDocument();
    expect(await screen.findByText("module_count")).toBeInTheDocument();
    expect(await screen.findByText("to_payload")).toBeInTheDocument();
  });

  it("opens class flow and lets nested methods drill into their own flow", async () => {
    const user = userEvent.setup();
    const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
      initialEntries: ["/workspace"],
    });

    render(
      <AppProviders adapter={new MockDesktopAdapter()}>
        <RouterProvider router={router} />
      </AppProviders>,
    );

    const graphPanel = document.querySelector(".graph-panel");
    expect(graphPanel).not.toBeNull();
    const graph = within(graphPanel as HTMLElement);

    fireEvent.doubleClick(await graph.findByText("api.py"));

    const classNode = (await graph.findByText("GraphSummary")).closest(".graph-node");
    expect(classNode).not.toBeNull();
    fireEvent.click(within(classNode as HTMLElement).getByText("Inspect"));
    await user.click(await screen.findByRole("button", { name: /Open flow/i }));

    expect(await screen.findByRole("heading", { name: /Internal flow/i })).toBeInTheDocument();
    expect(await graph.findByText("repo_path")).toBeInTheDocument();
    expect(await graph.findByText("module_count")).toBeInTheDocument();

    const methodNode = (await graph.findByText("to_payload")).closest(".graph-node");
    expect(methodNode).not.toBeNull();
    fireEvent.click(within(methodNode as HTMLElement).getByText("Inspect"));
    await user.click(await screen.findByRole("button", { name: /Open flow/i }));

    expect(await screen.findByRole("heading", { name: /Internal flow/i })).toBeInTheDocument();
    expect((await graph.findAllByText(/self/i)).length).toBeGreaterThan(0);
  });

  it("keeps the flow owner source in the inspector and highlights the selected class-flow member", async () => {
    const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
      initialEntries: ["/workspace"],
    });

    render(
      <AppProviders adapter={new MockDesktopAdapter()}>
        <RouterProvider router={router} />
      </AppProviders>,
    );

    const graphPanel = document.querySelector(".graph-panel");
    expect(graphPanel).not.toBeNull();
    const graph = within(graphPanel as HTMLElement);

    fireEvent.doubleClick(await graph.findByText("api.py"));

    const classNode = (await graph.findByText("GraphSummary")).closest(".graph-node");
    expect(classNode).not.toBeNull();
    fireEvent.click(within(classNode as HTMLElement).getByText("Inspect"));
    fireEvent.click(await screen.findByRole("button", { name: /Open flow/i }));

    expect(await screen.findByRole("heading", { name: /Internal flow/i })).toBeInTheDocument();

    fireEvent.click(await graph.findByText("to_payload"));

    const drawer = await screen.findByTestId("blueprint-inspector-drawer");
    expect(within(drawer).getByRole("heading", { name: "to_payload" })).toBeInTheDocument();
    expect(
      (screen.getByRole("textbox", { name: /Class source editor/i }) as HTMLTextAreaElement).value,
    ).toContain("class GraphSummary");
    expect(screen.getByTestId("inspector-inline-editor")).toHaveAttribute(
      "data-highlight-start-line",
      "11",
    );
    expect(screen.getByTestId("inspector-inline-editor")).toHaveAttribute(
      "data-highlight-end-line",
      "15",
    );
  });

  it("keeps class flow focused when Backspace is pressed without a selected flow deletion", async () => {
    const user = userEvent.setup();
    const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
      initialEntries: ["/workspace"],
    });

    render(
      <AppProviders adapter={new MockDesktopAdapter()}>
        <RouterProvider router={router} />
      </AppProviders>,
    );

    const graphPanel = document.querySelector(".graph-panel");
    expect(graphPanel).not.toBeNull();
    const graph = within(graphPanel as HTMLElement);

    fireEvent.doubleClick(await graph.findByText("api.py"));

    const classNode = (await graph.findByText("GraphSummary")).closest(".graph-node");
    expect(classNode).not.toBeNull();
    fireEvent.click(within(classNode as HTMLElement).getByText("Inspect"));
    await user.click(await screen.findByRole("button", { name: /Open flow/i }));

    expect(await screen.findByRole("heading", { name: /Internal flow/i })).toBeInTheDocument();
    (graphPanel as HTMLElement).focus();
    fireEvent.keyDown(graphPanel as HTMLElement, { key: "Backspace" });

    expect(screen.getByRole("heading", { name: /Internal flow/i })).toBeInTheDocument();
    expect(
      within(screen.getByRole("navigation", { name: /Graph path/i })).getByText("Flow"),
    ).toBeInTheDocument();
    expect(await graph.findByText("to_payload")).toBeInTheDocument();
  });

  it("reveals the current graph file from the graph path", async () => {
    const adapter = new MockDesktopAdapter();
    const revealSpy = vi.spyOn(adapter, "revealPathInFileExplorer").mockResolvedValue(undefined);
    const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
      initialEntries: ["/workspace"],
    });

    render(
      <AppProviders adapter={adapter}>
        <RouterProvider router={router} />
      </AppProviders>,
    );

    const graphPanel = document.querySelector(".graph-panel");
    expect(graphPanel).not.toBeNull();
    const graph = within(graphPanel as HTMLElement);

    fireEvent.doubleClick(await graph.findByText("api.py"));

    const graphPath = await screen.findByRole("navigation", { name: /Graph path/i });
    const fileButton = await within(graphPath).findByRole("button", { name: "api.py" });
    fireEvent.click(fileButton);

    expect(revealSpy).not.toHaveBeenCalled();

    fireEvent.click(fileButton, { metaKey: true });

    await waitFor(() => expect(revealSpy).toHaveBeenCalledWith("src/helm/ui/api.py"));
  });

  it("navigates from a graph path file segment back to the module graph", async () => {
    const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
      initialEntries: ["/workspace"],
    });

    render(
      <AppProviders adapter={new MockDesktopAdapter()}>
        <RouterProvider router={router} />
      </AppProviders>,
    );

    const graphPanel = document.querySelector(".graph-panel");
    expect(graphPanel).not.toBeNull();
    const graph = within(graphPanel as HTMLElement);

    fireEvent.doubleClick(await graph.findByText("api.py"));

    const classNode = (await graph.findByText("GraphSummary")).closest(".graph-node");
    expect(classNode).not.toBeNull();
    fireEvent.click(within(classNode as HTMLElement).getByText("Enter"));

    expect(await screen.findByText(/Symbol blueprint/i)).toBeInTheDocument();

    const graphPath = await screen.findByRole("navigation", { name: /Graph path/i });
    fireEvent.click(within(graphPath).getByRole("button", { name: "api.py" }));

    await waitFor(() => expect(screen.queryByText(/Symbol blueprint/i)).not.toBeInTheDocument());
    expect(
      within(screen.getByRole("navigation", { name: /Graph path/i })).queryByText("GraphSummary"),
    ).not.toBeInTheDocument();
  });

  it("navigates from a graph path folder segment to the containing module graph", async () => {
    const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
      initialEntries: ["/workspace"],
    });

    render(
      <AppProviders adapter={new MockDesktopAdapter()}>
        <RouterProvider router={router} />
      </AppProviders>,
    );

    const graphPanel = document.querySelector(".graph-panel");
    expect(graphPanel).not.toBeNull();
    const graph = within(graphPanel as HTMLElement);

    fireEvent.doubleClick(await graph.findByText("api.py"));

    const classNode = (await graph.findByText("GraphSummary")).closest(".graph-node");
    expect(classNode).not.toBeNull();
    fireEvent.click(within(classNode as HTMLElement).getByText("Enter"));

    expect(await screen.findByText(/Symbol blueprint/i)).toBeInTheDocument();

    const graphPath = await screen.findByRole("navigation", { name: /Graph path/i });
    fireEvent.click(within(graphPath).getByRole("button", { name: "src" }));

    await waitFor(() => expect(screen.queryByText(/Symbol blueprint/i)).not.toBeInTheDocument());
    expect(
      within(screen.getByRole("navigation", { name: /Graph path/i })).queryByText("GraphSummary"),
    ).not.toBeInTheDocument();
  });

  it("reveals an intermediate graph path folder with a modifier click", async () => {
    const adapter = new MockDesktopAdapter();
    const revealSpy = vi.spyOn(adapter, "revealPathInFileExplorer").mockResolvedValue(undefined);
    const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
      initialEntries: ["/workspace"],
    });

    render(
      <AppProviders adapter={adapter}>
        <RouterProvider router={router} />
      </AppProviders>,
    );

    const graphPanel = document.querySelector(".graph-panel");
    expect(graphPanel).not.toBeNull();
    const graph = within(graphPanel as HTMLElement);

    fireEvent.doubleClick(await graph.findByText("api.py"));

    const graphPath = await screen.findByRole("navigation", { name: /Graph path/i });
    fireEvent.click(within(graphPath).getByRole("button", { name: "src" }), { metaKey: true });

    await waitFor(() => expect(revealSpy).toHaveBeenCalledWith("src"));
  });

  it("tracks inline edits, supports cancel, and saves through the existing callback", async () => {
    const adapter = new MockDesktopAdapter();
    const saveSpy = vi.spyOn(adapter, "saveNodeSource");
    const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
      initialEntries: ["/workspace"],
    });

    render(
      <AppProviders adapter={adapter}>
        <RouterProvider router={router} />
      </AppProviders>,
    );

    const graphPanel = document.querySelector(".graph-panel");
    expect(graphPanel).not.toBeNull();
    const graph = within(graphPanel as HTMLElement);

    fireEvent.doubleClick(await graph.findByText("api.py"));

    const functionNode = (await graph.findByText("build_graph_summary")).closest(".graph-node");
    expect(functionNode).not.toBeNull();
    fireEvent.click(within(functionNode as HTMLElement).getByText("Inspect"));

    const editor = await screen.findByRole("textbox", { name: /Function source editor/i });
    const originalValue = (editor as HTMLTextAreaElement).value;
    const unsavedValue = `${originalValue}\n# inline note`;

    fireEvent.change(editor, { target: { value: unsavedValue } });

    expect((await screen.findAllByText("Unsaved")).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /Save/i })).toBeEnabled();

    fireEvent.click(screen.getByTestId("blueprint-inspector-drawer-toggle"));
    expect(await screen.findByTestId("blueprint-inspector-drawer")).toHaveAttribute(
      "data-mode",
      "collapsed",
    );
    expect(
      screen.queryByRole("textbox", { name: /Function source editor/i }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("blueprint-inspector-drawer-toggle"));
    expect(await screen.findByTestId("blueprint-inspector-drawer")).toHaveAttribute(
      "data-mode",
      "expanded",
    );
    expect(await screen.findByRole("textbox", { name: /Function source editor/i })).toHaveValue(
      unsavedValue,
    );
    expect(screen.getAllByText("Unsaved").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));

    expect((await screen.findAllByText("Synced")).length).toBeGreaterThan(0);
    expect(await screen.findByRole("textbox", { name: /Function source editor/i })).toHaveValue(
      originalValue,
    );

    fireEvent.change(await screen.findByRole("textbox", { name: /Function source editor/i }), {
      target: { value: `${originalValue}\n# saved note` },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save/i }));

    await waitFor(() => expect(saveSpy).toHaveBeenCalledTimes(1));
    expect(saveSpy.mock.calls[0]?.[1]).toContain("# saved note");
    await waitFor(() => expect(screen.getAllByText("Synced").length).toBeGreaterThan(0));
  });

  it(
    "refreshes the flow graph after inline source saves",
    async () => {
      const user = userEvent.setup();
      const adapter = new MockDesktopAdapter();
      const saveSpy = vi.spyOn(adapter, "saveNodeSource");
      const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
        initialEntries: ["/workspace"],
      });

      render(
        <AppProviders adapter={adapter}>
          <RouterProvider router={router} />
        </AppProviders>,
      );

      const graphPanel = document.querySelector(".graph-panel");
      expect(graphPanel).not.toBeNull();
      const graph = within(graphPanel as HTMLElement);

      fireEvent.doubleClick(await graph.findByText("api.py"));
      const functionNode = (await graph.findByText("build_graph_summary")).closest(".graph-node");
      expect(functionNode).not.toBeNull();
      fireEvent.click(within(functionNode as HTMLElement).getByText("Inspect"));

      const nextSource = [
        "def build_graph_summary(graph: RepoGraph, top_n: int = 10) -> GraphSummary:",
        "    return GraphSummary(repo_path=graph.root_path, module_count=0)",
      ].join("\n");
      fireEvent.change(await screen.findByRole("textbox", { name: /Function source editor/i }), {
        target: { value: nextSource },
      });
      fireEvent.click(screen.getByRole("button", { name: /Save/i }));

      await waitFor(() => expect(saveSpy).toHaveBeenCalledTimes(1));
      await user.click(await screen.findByRole("button", { name: /Open flow/i }));

      expect(
        await graph.findByText("return GraphSummary(repo_path=graph.root_path, module_count=0)"),
      ).toBeInTheDocument();
      expect(graph.queryByText(/ranked_modules/i)).not.toBeInTheDocument();
    },
    WORKSPACE_TEST_TIMEOUT_MS,
  );

  it("marks dirty inspector drafts stale after same-file live sync events", async () => {
    const adapter = new MockDesktopAdapter();
    const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
      initialEntries: ["/workspace"],
    });

    render(
      <AppProviders adapter={adapter}>
        <RouterProvider router={router} />
      </AppProviders>,
    );

    const graphPanel = document.querySelector(".graph-panel");
    expect(graphPanel).not.toBeNull();
    const graph = within(graphPanel as HTMLElement);

    fireEvent.doubleClick(await graph.findByText("api.py"));

    const functionNode = (await graph.findByText("build_graph_summary")).closest(".graph-node");
    expect(functionNode).not.toBeNull();
    fireEvent.click(within(functionNode as HTMLElement).getByText("Inspect"));

    const editor = await screen.findByRole("textbox", { name: /Function source editor/i });
    const originalValue = (editor as HTMLTextAreaElement).value;
    fireEvent.change(editor, {
      target: { value: `${originalValue}\n# local draft` },
    });

    await act(async () => {
      adapter.emitWorkspaceSyncForTest({
        repoPath: defaultRepoPath,
        sessionVersion: 2,
        reason: "external-change",
        status: "synced",
        changedRelativePaths: ["src/helm/ui/api.py"],
        needsManualResync: false,
        snapshot: {
          repoId: `repo:${defaultRepoPath}`,
          defaultFocusNodeId: "symbol:helm.ui.api:build_graph_summary",
          defaultLevel: "symbol",
          nodeIds: [
            `repo:${defaultRepoPath}`,
            "module:helm.ui.api",
            "symbol:helm.ui.api:build_graph_summary",
          ],
        },
      });
    });

    expect((await screen.findAllByText("Stale")).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /Save/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Reload from Disk/i })).toBeEnabled();
    expect(screen.getByRole("textbox", { name: /Function source editor/i })).toHaveValue(
      `${originalValue}\n# local draft`,
    );
  });

  it("undoes backend source saves through the shared undo coordinator and refreshes activity feedback", async () => {
    const adapter = new MockDesktopAdapter();
    const undoSpy = vi.spyOn(adapter, "applyBackendUndo");
    const editableSourceSpy = vi.spyOn(adapter, "getEditableNodeSource");
    const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
      initialEntries: ["/workspace"],
    });

    render(
      <AppProviders adapter={adapter}>
        <RouterProvider router={router} />
      </AppProviders>,
    );

    const graphPanel = document.querySelector(".graph-panel");
    expect(graphPanel).not.toBeNull();
    const graph = within(graphPanel as HTMLElement);

    fireEvent.doubleClick(await graph.findByText("api.py"));

    const functionNode = (await graph.findByText("build_graph_summary")).closest(".graph-node");
    expect(functionNode).not.toBeNull();
    fireEvent.click(within(functionNode as HTMLElement).getByText("Inspect"));

    const editor = await screen.findByRole("textbox", { name: /Function source editor/i });
    const originalValue = (editor as HTMLTextAreaElement).value;

    fireEvent.change(editor, {
      target: { value: `${originalValue}\n# saved note` },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save/i }));

    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: /Function source editor/i })).toHaveValue(
        `${originalValue}\n# saved note`,
      ),
    );
    await waitFor(() => {
      expect(useUndoStore.getState().getPreferredUndoDomain()).toBe("backend");
    });

    await act(async () => {
      await useUndoStore.getState().performUndo();
    });

    await waitFor(() => expect(undoSpy).toHaveBeenCalledTimes(1));
    expect(editableSourceSpy).toHaveBeenCalled();
    await expect(
      adapter.getEditableNodeSource("symbol:helm.ui.api:build_graph_summary"),
    ).resolves.toMatchObject({ content: originalValue });

    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: /Function source editor/i })).toHaveValue(
        originalValue,
      ),
    );
    expect(screen.getByText("Latest Activity")).toBeInTheDocument();
    expect(screen.getByText("backend")).toBeInTheDocument();
    expect(screen.getByText(/Undid:/i)).toBeInTheDocument();

    expect(useUndoStore.getState().getPreferredRedoDomain()).toBe("backend");

    await act(async () => {
      await useUndoStore.getState().performRedo();
    });

    await waitFor(() => expect(undoSpy).toHaveBeenCalledTimes(2));
    await expect(
      adapter.getEditableNodeSource("symbol:helm.ui.api:build_graph_summary"),
    ).resolves.toMatchObject({ content: `${originalValue}\n# saved note` });

    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: /Function source editor/i })).toHaveValue(
        `${originalValue}\n# saved note`,
      ),
    );
    expect(screen.getByText(/Redid:/i)).toBeInTheDocument();
  });

  it("toggles the inspector drawer with a Space tap outside text editing surfaces", async () => {
    const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
      initialEntries: ["/workspace"],
    });

    render(
      <AppProviders adapter={new MockDesktopAdapter()}>
        <RouterProvider router={router} />
      </AppProviders>,
    );

    const workspace = document.querySelector(".workspace-layout--blueprint");
    expect(workspace).not.toBeNull();
    const graphPanel = document.querySelector(".graph-panel");
    expect(graphPanel).not.toBeNull();
    const graph = within(graphPanel as HTMLElement);

    fireEvent.doubleClick(await graph.findByText("api.py"));

    const functionNode = (await graph.findByText("build_graph_summary")).closest(".graph-node");
    expect(functionNode).not.toBeNull();
    fireEvent.click(within(functionNode as HTMLElement).getByText("Inspect"));

    expect(await screen.findByTestId("blueprint-inspector-drawer")).toHaveAttribute(
      "data-mode",
      "expanded",
    );

    fireEvent.keyDown(workspace as HTMLElement, { code: "Space", key: " " });
    fireEvent.keyUp(workspace as HTMLElement, { code: "Space", key: " " });
    expect(await screen.findByTestId("blueprint-inspector-drawer")).toHaveAttribute(
      "data-mode",
      "collapsed",
    );

    fireEvent.keyDown(workspace as HTMLElement, { code: "Space", key: " " });
    fireEvent.keyUp(workspace as HTMLElement, { code: "Space", key: " " });
    expect(await screen.findByTestId("blueprint-inspector-drawer")).toHaveAttribute(
      "data-mode",
      "expanded",
    );
  });

  it("does not toggle the inspector drawer while typing in the editor", async () => {
    const user = userEvent.setup();
    const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
      initialEntries: ["/workspace"],
    });

    render(
      <AppProviders adapter={new MockDesktopAdapter()}>
        <RouterProvider router={router} />
      </AppProviders>,
    );

    const graphPanel = document.querySelector(".graph-panel");
    expect(graphPanel).not.toBeNull();
    const graph = within(graphPanel as HTMLElement);

    fireEvent.doubleClick(await graph.findByText("api.py"));

    const functionNode = (await graph.findByText("build_graph_summary")).closest(".graph-node");
    expect(functionNode).not.toBeNull();
    fireEvent.click(within(functionNode as HTMLElement).getByText("Inspect"));

    const editor = await screen.findByRole("textbox", { name: /Function source editor/i });
    const originalValue = (editor as HTMLTextAreaElement).value;

    await user.type(editor, " ");

    expect(await screen.findByTestId("blueprint-inspector-drawer")).toHaveAttribute(
      "data-mode",
      "expanded",
    );
    expect(await screen.findByRole("textbox", { name: /Function source editor/i })).toHaveValue(
      `${originalValue} `,
    );
  });

  it("keeps non-editable nodes read-only and renders revealed source in a read-only surface", async () => {
    const user = userEvent.setup();
    const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
      initialEntries: ["/workspace"],
    });

    render(
      <AppProviders adapter={new MockDesktopAdapter()}>
        <RouterProvider router={router} />
      </AppProviders>,
    );

    const graphPanel = document.querySelector(".graph-panel");
    expect(graphPanel).not.toBeNull();
    const graph = within(graphPanel as HTMLElement);

    fireEvent.doubleClick(await graph.findByText("api.py"));

    const classNode = (await graph.findByText("GraphSummary")).closest(".graph-node");
    expect(classNode).not.toBeNull();
    fireEvent.click(within(classNode as HTMLElement).getByText("Enter"));

    expect(await screen.findByText(/Symbol blueprint/i)).toBeInTheDocument();

    const attributeNode = (await graph.findByText("repo_path")).closest(".graph-node");
    expect(attributeNode).not.toBeNull();
    fireEvent.click(within(attributeNode as HTMLElement).getByText("Inspect"));

    expect(await screen.findByText(/Code details/i)).toBeInTheDocument();
    expect(screen.queryByTestId("inspector-inline-editor")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Save/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Reveal source/i }));

    expect(await screen.findByText(/Revealed Source/i)).toBeInTheDocument();
    expect(screen.getByTestId("inspector-revealed-source")).toHaveAttribute(
      "data-read-only",
      "true",
    );
  });

  it("shows backend-disabled reasons for structural symbol actions in the expanded inspector", async () => {
    const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
      initialEntries: ["/workspace"],
    });

    render(
      <AppProviders adapter={new MockDesktopAdapter()}>
        <RouterProvider router={router} />
      </AppProviders>,
    );

    const graphPanel = document.querySelector(".graph-panel");
    expect(graphPanel).not.toBeNull();
    const graph = within(graphPanel as HTMLElement);

    fireEvent.doubleClick(await graph.findByText("api.py"));

    const classNode = (await graph.findByText("GraphSummary")).closest(".graph-node");
    expect(classNode).not.toBeNull();
    fireEvent.click(within(classNode as HTMLElement).getByText("Inspect"));

    expect(await screen.findByRole("button", { name: /Rename symbol/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Delete symbol/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Move symbol/i })).toBeDisabled();
    expect(
      screen.getAllByText("Only dependency-free top-level symbols are writable in v1.").length,
    ).toBeGreaterThan(0);
  });

  it("renames a symbol through the inspector and refreshes the graph in place", async () => {
    const adapter = new MockDesktopAdapter();
    const openRepoSpy = vi.spyOn(adapter, "openRepo");
    const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
      initialEntries: ["/workspace"],
    });

    render(
      <AppProviders adapter={adapter}>
        <RouterProvider router={router} />
      </AppProviders>,
    );

    const graphPanel = document.querySelector(".graph-panel");
    expect(graphPanel).not.toBeNull();
    const graph = within(graphPanel as HTMLElement);

    fireEvent.doubleClick(await graph.findByText("api.py"));

    const functionNode = (await graph.findByText("build_graph_summary")).closest(".graph-node");
    expect(functionNode).not.toBeNull();
    fireEvent.click(within(functionNode as HTMLElement).getByText("Inspect"));

    fireEvent.change(await screen.findByRole("textbox", { name: /New symbol name/i }), {
      target: { value: "build_graph_projection" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Rename symbol/i }));

    await waitFor(
      () => {
        expect(useUiStore.getState().activeLevel).toBe("symbol");
        expect(useUiStore.getState().activeNodeId).toBe(
          "symbol:helm.ui.api:build_graph_projection",
        );
      },
      { timeout: 4000 },
    );
    expect(openRepoSpy).not.toHaveBeenCalled();
    expect(
      await screen.findByRole("heading", { name: "build_graph_projection" }),
    ).toBeInTheDocument();
  });

  it("deletes a created symbol through the inspector and falls back to the containing module", async () => {
    const adapter = new MockDesktopAdapter();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    await seedMockFunctionSymbol(adapter, "build_issue_cleanup");
    const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
      initialEntries: ["/workspace"],
    });

    render(
      <AppProviders adapter={adapter}>
        <RouterProvider router={router} />
      </AppProviders>,
    );

    const graphPanel = document.querySelector(".graph-panel");
    expect(graphPanel).not.toBeNull();
    const graph = within(graphPanel as HTMLElement);

    fireEvent.doubleClick(await graph.findByText("api.py"));

    const functionNode = (await graph.findByText("build_issue_cleanup")).closest(".graph-node");
    expect(functionNode).not.toBeNull();
    fireEvent.click(within(functionNode as HTMLElement).getByText("Inspect"));
    fireEvent.click(await screen.findByRole("button", { name: /Delete symbol/i }));

    await waitFor(
      () => {
        expect(confirmSpy).toHaveBeenCalled();
        expect(useUiStore.getState().activeLevel).toBe("module");
        expect(useUiStore.getState().activeNodeId).toBe("module:helm.ui.api");
      },
      { timeout: 4000 },
    );
    expect(screen.queryByRole("heading", { name: "build_issue_cleanup" })).not.toBeInTheDocument();
  });

  it("deletes a selected graph symbol with Backspace without reindexing", async () => {
    const adapter = new MockDesktopAdapter();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const startIndexSpy = vi.spyOn(adapter, "startIndex");
    const symbolId = await seedMockFunctionSymbol(adapter, "build_issue_cleanup_key");
    const editSpy = vi.spyOn(adapter, "applyStructuralEdit");
    const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
      initialEntries: ["/workspace"],
    });

    render(
      <AppProviders adapter={adapter}>
        <RouterProvider router={router} />
      </AppProviders>,
    );

    const graphPanel = document.querySelector(".graph-panel");
    expect(graphPanel).not.toBeNull();
    const graph = within(graphPanel as HTMLElement);

    fireEvent.doubleClick(await graph.findByText("api.py"));

    const functionNode = (await graph.findByText("build_issue_cleanup_key")).closest(".graph-node");
    expect(functionNode).not.toBeNull();
    fireEvent.click(functionNode as HTMLElement);
    expect(useUiStore.getState().activeNodeId).toBe(symbolId);

    (graphPanel as HTMLElement).focus();
    expect(fireEvent.keyDown(graphPanel as HTMLElement, { key: "Backspace" })).toBe(false);

    await waitFor(
      () => {
        expect(confirmSpy).toHaveBeenCalled();
        expect(editSpy).toHaveBeenCalledWith({
          kind: "delete_symbol",
          targetId: symbolId,
        });
        expect(useUiStore.getState().activeLevel).toBe("module");
        expect(useUiStore.getState().activeNodeId).toBe("module:helm.ui.api");
      },
      { timeout: 4000 },
    );
    expect(startIndexSpy).not.toHaveBeenCalled();
    expect(
      within(graphPanel as HTMLElement).queryByText("build_issue_cleanup_key"),
    ).not.toBeInTheDocument();
  });

  it("moves a created symbol through the inspector and focuses the destination module", async () => {
    const adapter = new MockDesktopAdapter();
    await seedMockFunctionSymbol(adapter, "build_issue_moved");
    await seedMockModule(adapter, "pkg/plan_target.py");
    const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
      initialEntries: ["/workspace"],
    });

    render(
      <AppProviders adapter={adapter}>
        <RouterProvider router={router} />
      </AppProviders>,
    );

    const graphPanel = document.querySelector(".graph-panel");
    expect(graphPanel).not.toBeNull();
    const graph = within(graphPanel as HTMLElement);

    fireEvent.doubleClick(await graph.findByText("api.py"));

    const functionNode = (await graph.findByText("build_issue_moved")).closest(".graph-node");
    expect(functionNode).not.toBeNull();
    fireEvent.click(within(functionNode as HTMLElement).getByText("Inspect"));

    fireEvent.change(await screen.findByRole("combobox", { name: /Destination module/i }), {
      target: { value: "pkg/plan_target.py" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Move symbol/i }));

    await waitFor(
      () => {
        expect(useUiStore.getState().activeLevel).toBe("module");
        expect(useUiStore.getState().activeNodeId).toBe("module:pkg.plan_target");
      },
      { timeout: 4000 },
    );
    expect(await screen.findByText("build_issue_moved")).toBeInTheDocument();
  });

  it("adds an import through the module inspector", async () => {
    const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
      initialEntries: ["/workspace"],
    });

    render(
      <AppProviders adapter={new MockDesktopAdapter()}>
        <RouterProvider router={router} />
      </AppProviders>,
    );

    const graphPanel = document.querySelector(".graph-panel");
    expect(graphPanel).not.toBeNull();
    const graph = within(graphPanel as HTMLElement);

    fireEvent.doubleClick(await graph.findByText("api.py"));
    fireEvent.click(await screen.findByTestId("blueprint-inspector-drawer-toggle"));
    await screen.findByRole("button", { name: /Add import/i }, { timeout: 3000 });

    fireEvent.change(screen.getByRole("textbox", { name: /^Imported module$/i }), {
      target: { value: "pathlib" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /Imported symbol/i }), {
      target: { value: "Path" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Add import/i }));

    await waitFor(() => {
      expect(useUiStore.getState().activeLevel).toBe("module");
      expect(useUiStore.getState().activeNodeId).toBe("module:helm.ui.api");
    });
    expect(await screen.findByText("Added import from pathlib import Path.")).toBeInTheDocument();
  });

  it("removes an import through the module inspector", async () => {
    const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
      initialEntries: ["/workspace"],
    });

    render(
      <AppProviders adapter={new MockDesktopAdapter()}>
        <RouterProvider router={router} />
      </AppProviders>,
    );

    const graphPanel = document.querySelector(".graph-panel");
    expect(graphPanel).not.toBeNull();
    const graph = within(graphPanel as HTMLElement);

    fireEvent.doubleClick(await graph.findByText("api.py"));
    fireEvent.click(await screen.findByTestId("blueprint-inspector-drawer-toggle"));
    await screen.findByRole("button", { name: /Remove import/i }, { timeout: 3000 });

    fireEvent.change(screen.getByRole("textbox", { name: /Imported module to remove/i }), {
      target: { value: "typing" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Remove import/i }));

    await waitFor(() => {
      expect(useUiStore.getState().activeLevel).toBe("module");
      expect(useUiStore.getState().activeNodeId).toBe("module:helm.ui.api");
    });
    expect(await screen.findByText("Removed import from src/helm/ui/api.py.")).toBeInTheDocument();
  });

  it("prompts on unsaved close and saves when confirmed", async () => {
    const user = userEvent.setup();
    const adapter = new MockDesktopAdapter();
    const saveSpy = vi.spyOn(adapter, "saveNodeSource");
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
      initialEntries: ["/workspace"],
    });

    render(
      <AppProviders adapter={adapter}>
        <RouterProvider router={router} />
      </AppProviders>,
    );

    const graphPanel = document.querySelector(".graph-panel");
    expect(graphPanel).not.toBeNull();
    const graph = within(graphPanel as HTMLElement);

    fireEvent.doubleClick(await graph.findByText("api.py"));

    const functionNode = (await graph.findByText("build_graph_summary")).closest(".graph-node");
    expect(functionNode).not.toBeNull();
    fireEvent.click(within(functionNode as HTMLElement).getByText("Inspect"));

    const editor = await screen.findByRole("textbox", { name: /Function source editor/i });
    fireEvent.change(editor, {
      target: { value: `${(editor as HTMLTextAreaElement).value}\n# close save` },
    });

    await user.click(screen.getByTestId("blueprint-inspector-drawer-toggle"));
    expect(await screen.findByTestId("blueprint-inspector-drawer")).toHaveAttribute(
      "data-mode",
      "collapsed",
    );

    await user.click(screen.getByTestId("blueprint-inspector-drawer-close"));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(saveSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      const drawer = screen.getByTestId("blueprint-inspector-drawer");
      expect(drawer).toHaveAttribute("data-mode", "collapsed");
      expect(within(drawer).getByText("helm.ui.api")).toBeInTheDocument();
      expect(
        within(drawer).queryByTestId("blueprint-inspector-drawer-close"),
      ).not.toBeInTheDocument();
    });
  });

  it("prompts on unsaved close and discards when not confirmed", async () => {
    const user = userEvent.setup();
    const adapter = new MockDesktopAdapter();
    const saveSpy = vi.spyOn(adapter, "saveNodeSource");
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
      initialEntries: ["/workspace"],
    });

    render(
      <AppProviders adapter={adapter}>
        <RouterProvider router={router} />
      </AppProviders>,
    );

    const graphPanel = document.querySelector(".graph-panel");
    expect(graphPanel).not.toBeNull();
    const graph = within(graphPanel as HTMLElement);

    fireEvent.doubleClick(await graph.findByText("api.py"));

    const functionNode = (await graph.findByText("build_graph_summary")).closest(".graph-node");
    expect(functionNode).not.toBeNull();
    fireEvent.click(within(functionNode as HTMLElement).getByText("Inspect"));

    const editor = await screen.findByRole("textbox", { name: /Function source editor/i });
    fireEvent.change(editor, {
      target: { value: `${(editor as HTMLTextAreaElement).value}\n# discard me` },
    });

    await user.click(screen.getByTestId("blueprint-inspector-panel-collapse"));

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(await screen.findByTestId("blueprint-inspector-drawer")).toHaveAttribute(
      "data-mode",
      "collapsed",
    );

    await user.click(screen.getByTestId("blueprint-inspector-drawer-close"));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy).not.toHaveBeenCalled();
    await waitFor(() => {
      const drawer = screen.getByTestId("blueprint-inspector-drawer");
      expect(drawer).toHaveAttribute("data-mode", "collapsed");
      expect(within(drawer).getByText("helm.ui.api")).toBeInTheDocument();
      expect(
        within(drawer).queryByTestId("blueprint-inspector-drawer-close"),
      ).not.toBeInTheDocument();
    });
  });

  it("updates the footer help box across explorer, graph path, graph nodes, and inspector actions", async () => {
    const user = userEvent.setup();
    const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
      initialEntries: ["/workspace"],
    });

    render(
      <AppProviders adapter={new MockDesktopAdapter()}>
        <RouterProvider router={router} />
      </AppProviders>,
    );

    const helpBox = document.querySelector(".workspace-help-box");
    expect(helpBox).not.toBeNull();
    const help = within(helpBox as HTMLElement);
    expect(help.getByText("Hover help")).toBeInTheDocument();

    await user.hover(await screen.findByRole("button", { name: "Open Repo" }));
    expect(help.getByText("Open repo")).toBeInTheDocument();

    await user.hover(screen.getByPlaceholderText("Jump to file or symbol"));
    expect(help.getByText("Search")).toBeInTheDocument();
    expect(help.getByText("Cmd/Ctrl + K")).toBeInTheDocument();

    const graphPanel = document.querySelector(".graph-panel");
    expect(graphPanel).not.toBeNull();
    const graph = within(graphPanel as HTMLElement);

    fireEvent.doubleClick(await graph.findByText("api.py"));

    const graphPath = await screen.findByRole("navigation", { name: /Graph path/i });
    await user.hover(within(graphPath).getByRole("button", { name: "api.py" }));
    expect(help.getByText("api.py graph path")).toBeInTheDocument();
    expect(help.getByText("Cmd/Ctrl + click reveals")).toBeInTheDocument();

    const moduleNode = (await graph.findByText("api.py")).closest(".graph-node");
    expect(moduleNode).not.toBeNull();
    await user.hover(moduleNode as HTMLElement);
    expect(help.getByText("api.py module node")).toBeInTheDocument();

    const functionNode = (await graph.findByText("build_graph_summary")).closest(".graph-node");
    expect(functionNode).not.toBeNull();
    const inspectButton = within(functionNode as HTMLElement).getByText("Inspect");
    await user.hover(inspectButton);
    expect(help.getByText("Inspect node")).toBeInTheDocument();

    fireEvent.click(inspectButton);
    const openInEditor = await screen.findByRole("button", {
      name: /Open File In Default Editor/i,
    });
    await user.hover(openInEditor);
    expect(help.getByText("Open file in default editor")).toBeInTheDocument();
  });
});
