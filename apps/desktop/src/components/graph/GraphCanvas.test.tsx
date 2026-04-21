import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FlowGraphDocument, GraphView } from "../../lib/adapter";
import {
  WorkspaceHelpBox,
  WorkspaceHelpProvider,
  WorkspaceHelpScope,
} from "../workspace/workspaceHelp";
import {
  GraphCanvas,
  applyMemberNodeDelta,
  applyGroupedLayoutPositions,
  buildEdgeLabelOffsets,
  collapseDuplicateEdgeLabels,
  isValidFlowCanvasConnection,
  mergeGroupsForSelection,
  normalizeStoredGroups,
  renameGraphGroup,
  resolveFlowEdgeInteraction,
  resolveSelectionPreviewNodeId,
  ungroupGroupsForSelection,
} from "./GraphCanvas";
import type { StoredGraphLayout } from "./graphLayoutPersistence";
import { useUndoStore } from "../../store/undoStore";

const {
  readStoredGraphLayoutMock,
  writeStoredGraphLayoutMock,
  peekStoredGraphLayoutMock,
  confirmDialogMock,
  storedGraphLayoutSnapshots,
} = vi.hoisted(() => ({
  readStoredGraphLayoutMock: vi.fn(),
  writeStoredGraphLayoutMock: vi.fn(),
  peekStoredGraphLayoutMock: vi.fn(),
  confirmDialogMock: vi.fn(),
  storedGraphLayoutSnapshots: new Map<string, StoredGraphLayout>(),
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

function getMockStoredGraphLayout(
  repoPath: string | undefined,
  viewKey: string | undefined,
): StoredGraphLayout | undefined {
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

vi.mock("./graphLayoutPersistence", async () => {
  const actual = await vi.importActual<typeof import("./graphLayoutPersistence")>("./graphLayoutPersistence");
  return {
    ...actual,
    peekStoredGraphLayout: peekStoredGraphLayoutMock,
    readStoredGraphLayout: readStoredGraphLayoutMock,
    writeStoredGraphLayout: writeStoredGraphLayoutMock,
  };
});

vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: confirmDialogMock,
}));

const baseGraph: GraphView = {
  rootNodeId: "symbol:calculator:calculate",
  targetId: "symbol:calculator:calculate",
  level: "flow",
  nodes: [
    {
      id: "entry:calculate",
      kind: "entry",
      label: "Entry",
      subtitle: "calculate",
      x: 0,
      y: 150,
      metadata: {},
      availableActions: [],
    },
    {
      id: "branch:left",
      kind: "branch",
      label: "branch left",
      subtitle: "If",
      x: 220,
      y: 132,
      metadata: {},
      availableActions: [],
    },
    {
      id: "branch:right",
      kind: "branch",
      label: "branch right",
      subtitle: "If",
      x: 246,
      y: 152,
      metadata: {},
      availableActions: [],
    },
    {
      id: "return:done",
      kind: "return",
      label: "return done",
      subtitle: "Return",
      x: 520,
      y: 150,
      metadata: {},
      availableActions: [],
    },
  ],
  edges: [
    {
      id: "controls:entry:left",
      kind: "controls",
      source: "entry:calculate",
      target: "branch:left",
    },
    {
      id: "controls:left:right",
      kind: "controls",
      source: "branch:left",
      target: "branch:right",
    },
    {
      id: "controls:right:return",
      kind: "controls",
      source: "branch:right",
      target: "return:done",
    },
  ],
  breadcrumbs: [
    {
      nodeId: "repo:/workspace/calculator",
      level: "repo",
      label: "Calculator",
    },
    {
      nodeId: "module:calculator",
      level: "module",
      label: "calculator.py",
    },
    {
      nodeId: "symbol:calculator:calculate",
      level: "symbol",
      label: "calculate",
    },
    {
      nodeId: "flow:symbol:calculator:calculate",
      level: "flow",
      label: "Flow",
    },
  ],
  focus: {
    targetId: "symbol:calculator:calculate",
    level: "flow",
    label: "calculate",
    availableLevels: ["symbol", "flow"],
  },
  truncated: false,
};

const editableFlowDocument: FlowGraphDocument = {
  symbolId: "symbol:calculator:calculate",
  relativePath: "calculator.py",
  qualname: "calculator.calculate",
  editable: true,
  syncState: "clean",
  diagnostics: [],
  sourceHash: "sha256:test",
  nodes: [
    { id: "entry:calculate", kind: "entry", payload: {} },
    { id: "branch:left", kind: "branch", payload: { condition: "left_branch" } },
    { id: "branch:right", kind: "branch", payload: { condition: "right_branch" } },
    { id: "return:done", kind: "return", payload: { expression: "done" } },
  ],
  edges: [
    {
      id: "controls:entry:left",
      sourceId: "entry:calculate",
      sourceHandle: "start",
      targetId: "branch:left",
      targetHandle: "in",
    },
    {
      id: "controls:left:true->right",
      sourceId: "branch:left",
      sourceHandle: "true",
      targetId: "branch:right",
      targetHandle: "in",
    },
    {
      id: "controls:left:false->right",
      sourceId: "branch:left",
      sourceHandle: "false",
      targetId: "branch:right",
      targetHandle: "in",
    },
    {
      id: "controls:right:true->return",
      sourceId: "branch:right",
      sourceHandle: "true",
      targetId: "return:done",
      targetHandle: "in",
    },
    {
      id: "controls:right:false->return",
      sourceId: "branch:right",
      sourceHandle: "false",
      targetId: "return:done",
      targetHandle: "in",
    },
  ],
};

const editableFlowGraph: GraphView = {
  ...baseGraph,
  flowState: {
    editable: true,
    syncState: "clean",
    diagnostics: [],
    document: editableFlowDocument,
  },
};

const returnExpressionGraph = {
  version: 1,
  rootId: "expr:operator:0",
  nodes: [
    {
      id: "expr:operator:0",
      kind: "operator" as const,
      label: "+",
      payload: { operator: "+" },
    },
    {
      id: "expr:input:done",
      kind: "input" as const,
      label: "done",
      payload: { name: "done", slot_id: "flowslot:return:done:done" },
    },
  ],
  edges: [
    {
      id: "expr-edge:done->plus:left",
      source_id: "expr:input:done",
      source_handle: "value",
      target_id: "expr:operator:0",
      target_handle: "left",
    },
  ],
};

const editableFlowGraphWithReturnExpression: GraphView = {
  ...editableFlowGraph,
  nodes: editableFlowGraph.nodes.map((node) => (
    node.id === "return:done"
      ? {
          ...node,
          metadata: {
            ...node.metadata,
            flow_expression_graph: returnExpressionGraph,
          },
        }
      : node
  )),
};

const labeledPathGraph: GraphView = {
  rootNodeId: "symbol:workflow:run",
  targetId: "symbol:workflow:run",
  level: "flow",
  nodes: [
    {
      id: "entry:workflow",
      kind: "entry",
      label: "Entry",
      subtitle: "run",
      x: 0,
      y: 220,
      metadata: {},
      availableActions: [],
    },
    {
      id: "branch:workflow",
      kind: "branch",
      label: "if ready",
      subtitle: "If",
      x: 220,
      y: 220,
      metadata: {},
      availableActions: [],
    },
    {
      id: "return:true",
      kind: "return",
      label: "return ready",
      subtitle: "Return",
      x: 460,
      y: 110,
      metadata: {},
      availableActions: [],
    },
    {
      id: "return:false",
      kind: "return",
      label: "return pending",
      subtitle: "Return",
      x: 460,
      y: 330,
      metadata: {},
      availableActions: [],
    },
    {
      id: "loop:workflow",
      kind: "loop",
      label: "while items",
      subtitle: "While",
      x: 220,
      y: 540,
      metadata: {},
      availableActions: [],
    },
    {
      id: "assign:body",
      kind: "assign",
      label: "head = items[0]",
      subtitle: "Assign",
      x: 470,
      y: 450,
      metadata: {},
      availableActions: [],
    },
    {
      id: "return:exit",
      kind: "return",
      label: "return len(items)",
      subtitle: "Return",
      x: 470,
      y: 640,
      metadata: {},
      availableActions: [],
    },
  ],
  edges: [
    {
      id: "controls:entry->branch",
      kind: "controls",
      source: "entry:workflow",
      target: "branch:workflow",
    },
    {
      id: "controls:branch->true:true",
      kind: "controls",
      source: "branch:workflow",
      target: "return:true",
      label: "true",
      metadata: {
        path_key: "true",
        path_label: "true",
      },
    },
    {
      id: "controls:branch->false:false",
      kind: "controls",
      source: "branch:workflow",
      target: "return:false",
      label: "false",
      metadata: {
        path_key: "false",
        path_label: "false",
      },
    },
    {
      id: "controls:entry->loop",
      kind: "controls",
      source: "entry:workflow",
      target: "loop:workflow",
    },
    {
      id: "controls:loop->body:body",
      kind: "controls",
      source: "loop:workflow",
      target: "assign:body",
      label: "body",
      metadata: {
        path_key: "body",
        path_label: "body",
      },
    },
    {
      id: "controls:loop->exit:exit",
      kind: "controls",
      source: "loop:workflow",
      target: "return:exit",
      label: "exit",
      metadata: {
        path_key: "exit",
        path_label: "exit",
      },
    },
  ],
  breadcrumbs: [
    {
      nodeId: "repo:/workspace/workflow",
      level: "repo",
      label: "Workflow",
    },
    {
      nodeId: "module:workflow",
      level: "module",
      label: "workflow.py",
    },
    {
      nodeId: "symbol:workflow:run",
      level: "symbol",
      label: "run",
    },
    {
      nodeId: "flow:symbol:workflow:run",
      level: "flow",
      label: "Flow",
    },
  ],
  focus: {
    targetId: "symbol:workflow:run",
    level: "flow",
    label: "run",
    availableLevels: ["symbol", "flow"],
  },
  truncated: false,
};

const originalLayout: StoredGraphLayout = {
  nodes: {
    "entry:calculate": { x: 0, y: 150 },
    "branch:left": { x: 220, y: 132 },
    "branch:right": { x: 246, y: 152 },
    "return:done": { x: 520, y: 150 },
  },
  reroutes: [],
  pinnedNodeIds: [],
  groups: [],
};

const labeledPathLayout: StoredGraphLayout = {
  nodes: {
    "entry:workflow": { x: 0, y: 220 },
    "branch:workflow": { x: 220, y: 220 },
    "return:true": { x: 460, y: 110 },
    "return:false": { x: 460, y: 330 },
    "loop:workflow": { x: 220, y: 540 },
    "assign:body": { x: 470, y: 450 },
    "return:exit": { x: 470, y: 640 },
  },
  reroutes: [],
  pinnedNodeIds: [],
  groups: [],
};

const visualFlowDocument: FlowGraphDocument = {
  symbolId: "symbol:calculator:calculate",
  relativePath: "calculator.py",
  qualname: "calculate",
  editable: true,
  syncState: "clean",
  diagnostics: [],
  nodes: [
    { id: "entry:calculate", kind: "entry", payload: {} },
    { id: "assign:calculate", kind: "assign", payload: { source: "value = prepare()" } },
    { id: "return:done", kind: "return", payload: { expression: "value" } },
  ],
  edges: [
    {
      id: "controls:entry:calculate:start->assign:calculate:in",
      sourceId: "entry:calculate",
      sourceHandle: "start",
      targetId: "assign:calculate",
      targetHandle: "in",
    },
    {
      id: "controls:assign:calculate:next->return:done:in",
      sourceId: "assign:calculate",
      sourceHandle: "next",
      targetId: "return:done",
      targetHandle: "in",
    },
  ],
};

const visualFlowGraph: GraphView = {
  ...baseGraph,
  nodes: [
    {
      id: "entry:calculate",
      kind: "entry",
      label: "Entry",
      subtitle: "calculate",
      x: 0,
      y: 150,
      metadata: {
        flow_visual: true,
      },
      availableActions: [],
    },
    {
      id: "assign:calculate",
      kind: "assign",
      label: "value = prepare()",
      subtitle: "assignment",
      x: 240,
      y: 150,
      metadata: {
        flow_visual: true,
      },
      availableActions: [],
    },
    {
      id: "return:done",
      kind: "return",
      label: "return value",
      subtitle: "return",
      x: 520,
      y: 150,
      metadata: {
        flow_visual: true,
      },
      availableActions: [],
    },
  ],
  edges: [
    {
      id: "controls:entry:calculate:start->assign:calculate:in",
      kind: "controls",
      source: "entry:calculate",
      target: "assign:calculate",
      metadata: {
        source_handle: "start",
        target_handle: "in",
      },
    },
    {
      id: "controls:assign:calculate:next->return:done:in",
      kind: "controls",
      source: "assign:calculate",
      target: "return:done",
      metadata: {
        source_handle: "next",
        target_handle: "in",
      },
    },
  ],
};

const editableVisualFlowGraph: GraphView = {
  ...visualFlowGraph,
  flowState: {
    editable: true,
    syncState: "clean",
    diagnostics: [],
    document: visualFlowDocument,
  },
};

const branchLoopVisualDocument: FlowGraphDocument = {
  symbolId: "symbol:workflow:run",
  relativePath: "workflow.py",
  qualname: "run",
  editable: true,
  syncState: "clean",
  diagnostics: [],
  nodes: [
    { id: "entry:workflow", kind: "entry", payload: {} },
    { id: "branch:workflow", kind: "branch", payload: { condition: "ready" } },
    { id: "return:true", kind: "return", payload: { expression: "ready" } },
    { id: "return:false", kind: "return", payload: { expression: "pending" } },
    { id: "loop:workflow", kind: "loop", payload: { header: "while items" } },
    { id: "assign:body", kind: "assign", payload: { source: "head = items[0]" } },
    { id: "return:exit", kind: "return", payload: { expression: "len(items)" } },
  ],
  edges: [
    {
      id: "controls:entry:workflow:start->branch:workflow:in",
      sourceId: "entry:workflow",
      sourceHandle: "start",
      targetId: "branch:workflow",
      targetHandle: "in",
    },
    {
      id: "controls:branch:workflow:true->return:true:in",
      sourceId: "branch:workflow",
      sourceHandle: "true",
      targetId: "return:true",
      targetHandle: "in",
    },
    {
      id: "controls:branch:workflow:false->return:false:in",
      sourceId: "branch:workflow",
      sourceHandle: "false",
      targetId: "return:false",
      targetHandle: "in",
    },
    {
      id: "controls:entry:workflow:start->loop:workflow:in",
      sourceId: "entry:workflow",
      sourceHandle: "start",
      targetId: "loop:workflow",
      targetHandle: "in",
    },
    {
      id: "controls:loop:workflow:body->assign:body:in",
      sourceId: "loop:workflow",
      sourceHandle: "body",
      targetId: "assign:body",
      targetHandle: "in",
    },
    {
      id: "controls:loop:workflow:after->return:exit:in",
      sourceId: "loop:workflow",
      sourceHandle: "after",
      targetId: "return:exit",
      targetHandle: "in",
    },
  ],
};

const branchLoopVisualGraph: GraphView = {
  ...labeledPathGraph,
  nodes: labeledPathGraph.nodes.map((node) => ({
    ...node,
    metadata: {
      ...node.metadata,
      flow_visual: true,
    },
  })),
  edges: [
    {
      id: "controls:entry:workflow:start->branch:workflow:in",
      kind: "controls",
      source: "entry:workflow",
      target: "branch:workflow",
      metadata: {
        source_handle: "start",
        target_handle: "in",
      },
    },
    {
      id: "controls:branch:workflow:true->return:true:in",
      kind: "controls",
      source: "branch:workflow",
      target: "return:true",
      label: "true",
      metadata: {
        source_handle: "true",
        target_handle: "in",
        path_key: "true",
        path_label: "true",
      },
    },
    {
      id: "controls:branch:workflow:false->return:false:in",
      kind: "controls",
      source: "branch:workflow",
      target: "return:false",
      label: "false",
      metadata: {
        source_handle: "false",
        target_handle: "in",
        path_key: "false",
        path_label: "false",
      },
    },
    {
      id: "controls:entry:workflow:start->loop:workflow:in",
      kind: "controls",
      source: "entry:workflow",
      target: "loop:workflow",
      metadata: {
        source_handle: "start",
        target_handle: "in",
      },
    },
    {
      id: "controls:loop:workflow:body->assign:body:in",
      kind: "controls",
      source: "loop:workflow",
      target: "assign:body",
      label: "body",
      metadata: {
        source_handle: "body",
        target_handle: "in",
        path_key: "body",
        path_label: "body",
      },
    },
    {
      id: "controls:loop:workflow:after->return:exit:in",
      kind: "controls",
      source: "loop:workflow",
      target: "return:exit",
      label: "after",
      metadata: {
        source_handle: "after",
        target_handle: "in",
        path_key: "after",
        path_label: "after",
      },
    },
  ],
};

const flowGroup = {
  id: "group-flow-control-path",
  title: "Group",
  memberNodeIds: ["branch:left", "entry:calculate"],
};

const moduleGraph: GraphView = {
  rootNodeId: "module:focus",
  targetId: "module:focus",
  level: "module",
  nodes: [
    {
      id: "module:focus",
      kind: "module",
      label: "focus.py",
      subtitle: "3 symbols",
      x: 0,
      y: 0,
      metadata: {
        relative_path: "src/focus.py",
      },
      availableActions: [],
    },
    {
      id: "module:left-a",
      kind: "module",
      label: "left-a.py",
      x: -240,
      y: -60,
      metadata: {
        relative_path: "src/left-a.py",
      },
      availableActions: [],
    },
    {
      id: "module:left-b",
      kind: "module",
      label: "left-b.py",
      x: -240,
      y: 60,
      metadata: {
        relative_path: "src/left-b.py",
      },
      availableActions: [],
    },
  ],
  edges: [
    {
      id: "calls:left-a-focus",
      kind: "calls",
      source: "module:left-a",
      target: "module:focus",
      label: "2 calls",
    },
    {
      id: "calls:left-b-focus",
      kind: "calls",
      source: "module:left-b",
      target: "module:focus",
      label: "1 call",
    },
  ],
  breadcrumbs: [],
  focus: {
    targetId: "module:focus",
    level: "module",
    label: "focus.py",
    availableLevels: ["repo", "module"],
  },
  truncated: false,
};

const moduleOriginalLayout: StoredGraphLayout = {
  nodes: {
    "module:focus": { x: 0, y: 0 },
    "module:left-a": { x: -240, y: -60 },
    "module:left-b": { x: -240, y: 60 },
  },
  reroutes: [],
  pinnedNodeIds: [],
  groups: [],
};

const moduleGroup = {
  id: "group-module-left",
  title: "Group",
  memberNodeIds: ["module:focus", "module:left-a"],
};

function buildStoredLayout(overrides: Partial<StoredGraphLayout> = {}): StoredGraphLayout {
  return {
    nodes: {
      ...originalLayout.nodes,
      ...overrides.nodes,
    },
    reroutes: overrides.reroutes ?? originalLayout.reroutes,
    pinnedNodeIds: overrides.pinnedNodeIds ?? originalLayout.pinnedNodeIds,
    groups: overrides.groups ?? originalLayout.groups,
  };
}

function buildModuleStoredLayout(overrides: Partial<StoredGraphLayout> = {}): StoredGraphLayout {
  return {
    nodes: {
      ...moduleOriginalLayout.nodes,
      ...overrides.nodes,
    },
    reroutes: overrides.reroutes ?? moduleOriginalLayout.reroutes,
    pinnedNodeIds: overrides.pinnedNodeIds ?? moduleOriginalLayout.pinnedNodeIds,
    groups: overrides.groups ?? moduleOriginalLayout.groups,
  };
}

function latestPersistedLayout() {
  return writeStoredGraphLayoutMock.mock.calls[writeStoredGraphLayoutMock.mock.calls.length - 1]?.[2];
}

function renderGraphCanvas(overrides: Partial<Parameters<typeof GraphCanvas>[0]> = {}) {
  return render(
    <GraphCanvas
      repoPath="/workspace/calculator"
      graph={baseGraph}
      activeNodeId="entry:calculate"
      graphFilters={{
        includeCalls: true,
        includeDefines: true,
        includeImports: true,
      }}
      graphSettings={{
        includeExternalDependencies: false,
      }}
      highlightGraphPath={false}
      showEdgeLabels={false}
      onSelectNode={vi.fn()}
      onActivateNode={vi.fn()}
      onInspectNode={vi.fn()}
      onSelectBreadcrumb={vi.fn()}
      onSelectLevel={vi.fn()}
      onToggleGraphFilter={vi.fn()}
      onToggleGraphSetting={vi.fn()}
      onToggleGraphPathHighlight={vi.fn()}
      onToggleEdgeLabels={vi.fn()}
      onNavigateOut={vi.fn()}
      onClearSelection={vi.fn()}
      {...overrides}
    />,
  );
}

function mockGraphCanvasElementRect() {
  const elementSize = function elementSize(this: HTMLElement) {
    const isHandle = this.classList?.contains("react-flow__handle");
    return {
      width: isHandle ? 12 : 240,
      height: isHandle ? 12 : 96,
    };
  };

  const clientWidthSpy = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function mockClientWidth(this: HTMLElement) {
    return elementSize.call(this).width;
  });
  const clientHeightSpy = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function mockClientHeight(this: HTMLElement) {
    return elementSize.call(this).height;
  });
  const offsetWidthSpy = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function mockWidth(this: HTMLElement) {
    return elementSize.call(this).width;
  });
  const offsetHeightSpy = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function mockHeight(this: HTMLElement) {
    return elementSize.call(this).height;
  });
  const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function mockRect(this: HTMLElement) {
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

  return () => {
    clientWidthSpy.mockRestore();
    clientHeightSpy.mockRestore();
    offsetWidthSpy.mockRestore();
    offsetHeightSpy.mockRestore();
    rectSpy.mockRestore();
  };
}

async function findGraphHandle(nodeId: string, handleId: string) {
  const nodeHost = await screen.findByTestId(`rf__node-${nodeId}`);
  await waitFor(() =>
    expect(
      nodeHost.querySelector(`.react-flow__handle[data-nodeid="${nodeId}"][data-handleid="${handleId}"]`),
    ).not.toBeNull(),
  );
  return nodeHost.querySelector(
    `.react-flow__handle[data-nodeid="${nodeId}"][data-handleid="${handleId}"]`,
  ) as HTMLElement;
}

function centerPoint(element: Element) {
  const rect = element.getBoundingClientRect();
  if (rect.width > 0 || rect.height > 0) {
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  }
  const cx = Number(element.getAttribute("cx"));
  const cy = Number(element.getAttribute("cy"));
  if (Number.isFinite(cx) && Number.isFinite(cy)) {
    return { x: cx, y: cy };
  }
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  };
}

function beginConnectionDrag({
  dragStart,
  targetHandle,
}: {
  dragStart: Element;
  targetHandle: HTMLElement;
}) {
  const startPoint = centerPoint(dragStart);
  const targetPoint = centerPoint(targetHandle);
  const originalElementFromPoint = document.elementFromPoint;
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => targetHandle,
  });

  fireEvent.mouseDown(dragStart, {
    button: 0,
    clientX: startPoint.x,
    clientY: startPoint.y,
  });
  fireEvent.mouseMove(document, {
    buttons: 1,
    clientX: targetPoint.x + 8,
    clientY: targetPoint.y + 8,
  });

  return {
    finish() {
      try {
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
    },
  };
}

describe("GraphCanvas", () => {
  beforeEach(() => {
    storedGraphLayoutSnapshots.clear();
    readStoredGraphLayoutMock.mockReset();
    writeStoredGraphLayoutMock.mockReset();
    peekStoredGraphLayoutMock.mockReset();
    confirmDialogMock.mockReset();
    useUndoStore.getState().resetSession(undefined);
    setMockStoredGraphLayout("/workspace/calculator", "flow|symbol:calculator:calculate", originalLayout);
    readStoredGraphLayoutMock.mockImplementation(async (repoPath: string | undefined, viewKey: string | undefined) => (
      getMockStoredGraphLayout(repoPath, viewKey) ?? cloneStoredGraphLayout(originalLayout)
    ));
    writeStoredGraphLayoutMock.mockImplementation(async (
      repoPath: string | undefined,
      viewKey: string | undefined,
      layout: StoredGraphLayout,
    ) => {
      setMockStoredGraphLayout(repoPath, viewKey, layout);
    });
    peekStoredGraphLayoutMock.mockImplementation((repoPath: string | undefined, viewKey: string | undefined) => (
      getMockStoredGraphLayout(repoPath, viewKey)
    ));
    confirmDialogMock.mockResolvedValue(true);
  });

  it("opens a node context menu with graph actions", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    renderGraphCanvas();

    const entryNode = await screen.findByTestId("rf__node-entry:calculate");
    fireEvent.contextMenu(entryNode, { clientX: 160, clientY: 140 });

    const menu = await screen.findByRole("menu", { name: "Entry actions" });
    expect(within(menu).getByRole("menuitem", { name: "Pin Node" })).toBeInTheDocument();

    await user.click(within(menu).getByRole("menuitem", { name: "Copy Node ID" }));

    expect(writeText).toHaveBeenCalledWith("entry:calculate");
  });

  it("opens a canvas context menu for flow creation", async () => {
    const onCreateIntent = vi.fn();
    const { container } = renderGraphCanvas({
      graph: editableFlowGraph,
      onCreateIntent,
    });

    const pane = await waitFor(() => {
      const element = container.querySelector(".react-flow__pane");
      expect(element).not.toBeNull();
      return element as Element;
    });

    fireEvent.contextMenu(pane, { clientX: 220, clientY: 180 });

    await userEvent.click(await screen.findByRole("menuitem", { name: "Create Flow Node Here" }));

    expect(onCreateIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        flowPosition: expect.objectContaining({
          x: expect.any(Number),
          y: expect.any(Number),
        }),
      }),
    );
  });

  it("opens loop context actions for type changes and Repeat/Done steps", async () => {
    const user = userEvent.setup();
    const onCreateIntent = vi.fn();
    const onEditFlowNodeIntent = vi.fn();
    renderGraphCanvas({
      graph: {
        ...branchLoopVisualGraph,
        flowState: {
          editable: true,
          syncState: "clean",
          diagnostics: [],
          document: branchLoopVisualDocument,
        },
      },
      onCreateIntent,
      onEditFlowNodeIntent,
    });

    const loopNode = await screen.findByTestId("rf__node-loop:workflow");
    fireEvent.contextMenu(loopNode, { clientX: 320, clientY: 260 });

    const menu = await screen.findByRole("menu", { name: "while items actions" });
    expect(within(menu).getByRole("menuitem", { name: "Edit Loop" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Change to While Loop" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Change to For Loop" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Add Repeat Step" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Add Done Step" })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Edit Flow Node" })).not.toBeInTheDocument();

    await user.click(within(menu).getByRole("menuitem", { name: "Change to For Loop" }));
    expect(onEditFlowNodeIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "loop:workflow",
        initialLoopType: "for",
      }),
    );

    fireEvent.contextMenu(loopNode, { clientX: 320, clientY: 260 });
    const repeatMenu = await screen.findByRole("menu", { name: "while items actions" });
    await user.click(within(repeatMenu).getByRole("menuitem", { name: "Add Repeat Step" }));
    expect(onCreateIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        seedFlowConnection: {
          sourceNodeId: "loop:workflow",
          sourceHandle: "body",
          label: "Repeat",
        },
      }),
    );

    fireEvent.contextMenu(loopNode, { clientX: 320, clientY: 260 });
    const doneMenu = await screen.findByRole("menu", { name: "while items actions" });
    await user.click(within(doneMenu).getByRole("menuitem", { name: "Add Done Step" }));
    expect(onCreateIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        seedFlowConnection: {
          sourceNodeId: "loop:workflow",
          sourceHandle: "after",
          label: "Done",
        },
      }),
    );
  });

  it("initializes and persists a structured flow layout on first open when no layout is saved", async () => {
    readStoredGraphLayoutMock.mockResolvedValueOnce({
      nodes: {},
      reroutes: [],
      pinnedNodeIds: [],
      groups: [],
    });

    render(
      <GraphCanvas
        repoPath="/workspace/calculator"
        graph={baseGraph}
        activeNodeId="entry:calculate"
        graphFilters={{
          includeCalls: true,
          includeDefines: true,
          includeImports: true,
        }}
        graphSettings={{
          includeExternalDependencies: false,
        }}
        highlightGraphPath={false}
        showEdgeLabels={false}
        onSelectNode={vi.fn()}
        onActivateNode={vi.fn()}
        onInspectNode={vi.fn()}
        onSelectBreadcrumb={vi.fn()}
        onSelectLevel={vi.fn()}
        onToggleGraphFilter={vi.fn()}
        onToggleGraphSetting={vi.fn()}
        onToggleGraphPathHighlight={vi.fn()}
        onToggleEdgeLabels={vi.fn()}
        onNavigateOut={vi.fn()}
        onClearSelection={vi.fn()}
      />,
    );

    await waitFor(() => expect(writeStoredGraphLayoutMock).toHaveBeenCalledTimes(1));
    const initialWrite = writeStoredGraphLayoutMock.mock.calls[0];
    expect(initialWrite[0]).toBe("/workspace/calculator");
    expect(initialWrite[1]).toBe("flow|symbol:calculator:calculate");
    expect(initialWrite[2].pinnedNodeIds).toEqual([]);
    expect(Object.keys(initialWrite[2].nodes)).toEqual(
      expect.arrayContaining(["entry:calculate", "branch:left", "branch:right", "return:done"]),
    );
  });

  it("shows a loading state while a graph view is still being fetched", () => {
    render(
      <GraphCanvas
        repoPath="/workspace/calculator"
        graph={undefined}
        isLoading
        activeNodeId={undefined}
        graphFilters={{
          includeCalls: true,
          includeDefines: true,
          includeImports: true,
        }}
        graphSettings={{
          includeExternalDependencies: false,
        }}
        highlightGraphPath={false}
        showEdgeLabels={false}
        onSelectNode={vi.fn()}
        onActivateNode={vi.fn()}
        onInspectNode={vi.fn()}
        onSelectBreadcrumb={vi.fn()}
        onSelectLevel={vi.fn()}
        onToggleGraphFilter={vi.fn()}
        onToggleGraphSetting={vi.fn()}
        onToggleGraphPathHighlight={vi.fn()}
        onToggleEdgeLabels={vi.fn()}
        onNavigateOut={vi.fn()}
        onClearSelection={vi.fn()}
      />,
    );

    expect(screen.getByText("Loading graph")).toBeInTheDocument();
    expect(screen.getByText("Building the current graph view.")).toBeInTheDocument();
  });

  it("declutters the current view and can undo the saved layout change", async () => {
    const user = userEvent.setup();

    render(
      <GraphCanvas
        repoPath="/workspace/calculator"
        graph={baseGraph}
        activeNodeId="entry:calculate"
        graphFilters={{
          includeCalls: true,
          includeDefines: true,
          includeImports: true,
        }}
        graphSettings={{
          includeExternalDependencies: false,
        }}
        highlightGraphPath={false}
        showEdgeLabels={false}
        onSelectNode={vi.fn()}
        onActivateNode={vi.fn()}
        onInspectNode={vi.fn()}
        onSelectBreadcrumb={vi.fn()}
        onSelectLevel={vi.fn()}
        onToggleGraphFilter={vi.fn()}
        onToggleGraphSetting={vi.fn()}
        onToggleGraphPathHighlight={vi.fn()}
        onToggleEdgeLabels={vi.fn()}
        onNavigateOut={vi.fn()}
        onClearSelection={vi.fn()}
      />,
    );

    expect(await screen.findByRole("region", { name: /Graph canvas/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /calculate/i }));
    await user.click(screen.getByRole("button", { name: "Declutter" }));

    await waitFor(() => expect(writeStoredGraphLayoutMock).toHaveBeenCalledTimes(1));
    const firstWrite = writeStoredGraphLayoutMock.mock.calls[0];
    expect(firstWrite[0]).toBe("/workspace/calculator");
    expect(firstWrite[1]).toBe("flow|symbol:calculator:calculate");
    expect(firstWrite[2]).not.toEqual(originalLayout);
    expect(screen.getByRole("button", { name: "Undo layout" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Undo layout" }));

    await waitFor(() => expect(writeStoredGraphLayoutMock).toHaveBeenCalledTimes(2));
    const secondWrite = writeStoredGraphLayoutMock.mock.calls[1];
    expect(secondWrite[2]).toEqual(originalLayout);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Undo layout" })).not.toBeInTheDocument(),
    );
  });

  it("routes layout undo through the shared undo coordinator", async () => {
    const user = userEvent.setup();

    render(
      <GraphCanvas
        repoPath="/workspace/calculator"
        graph={baseGraph}
        activeNodeId="entry:calculate"
        graphFilters={{
          includeCalls: true,
          includeDefines: true,
          includeImports: true,
        }}
        graphSettings={{
          includeExternalDependencies: false,
        }}
        highlightGraphPath={false}
        showEdgeLabels={false}
        onSelectNode={vi.fn()}
        onActivateNode={vi.fn()}
        onInspectNode={vi.fn()}
        onSelectBreadcrumb={vi.fn()}
        onSelectLevel={vi.fn()}
        onToggleGraphFilter={vi.fn()}
        onToggleGraphSetting={vi.fn()}
        onToggleGraphPathHighlight={vi.fn()}
        onToggleEdgeLabels={vi.fn()}
        onNavigateOut={vi.fn()}
        onClearSelection={vi.fn()}
      />,
    );

    expect(await screen.findByRole("region", { name: /Graph canvas/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /calculate/i }));
    await user.click(screen.getByRole("button", { name: "Declutter" }));

    await waitFor(() => expect(writeStoredGraphLayoutMock).toHaveBeenCalledTimes(1));
    expect(useUndoStore.getState().getPreferredUndoDomain()).toBe("layout");

    await act(async () => {
      await useUndoStore.getState().performUndo();
    });

    await waitFor(() => expect(writeStoredGraphLayoutMock).toHaveBeenCalledTimes(2));
    expect(writeStoredGraphLayoutMock.mock.calls[1]?.[2]).toEqual(originalLayout);
    expect(useUndoStore.getState().getPreferredRedoDomain()).toBe("layout");

    await act(async () => {
      await useUndoStore.getState().performRedo();
    });

    await waitFor(() => expect(writeStoredGraphLayoutMock).toHaveBeenCalledTimes(3));
    expect(writeStoredGraphLayoutMock.mock.calls[2]?.[2]).toEqual(
      writeStoredGraphLayoutMock.mock.calls[0]?.[2],
    );
  });

  it("emphasizes the selected node and dims unrelated nodes", async () => {
    render(
      <GraphCanvas
        repoPath="/workspace/calculator"
        graph={baseGraph}
        activeNodeId="entry:calculate"
        graphFilters={{
          includeCalls: true,
          includeDefines: true,
          includeImports: true,
        }}
        graphSettings={{
          includeExternalDependencies: false,
        }}
        highlightGraphPath={false}
        showEdgeLabels={false}
        onSelectNode={vi.fn()}
        onActivateNode={vi.fn()}
        onInspectNode={vi.fn()}
        onSelectBreadcrumb={vi.fn()}
        onSelectLevel={vi.fn()}
        onToggleGraphFilter={vi.fn()}
        onToggleGraphSetting={vi.fn()}
        onToggleGraphPathHighlight={vi.fn()}
        onToggleEdgeLabels={vi.fn()}
        onNavigateOut={vi.fn()}
        onClearSelection={vi.fn()}
      />,
    );

    const selectedHost = await screen.findByTestId("rf__node-entry:calculate");
    const connectedHost = await screen.findByTestId("rf__node-branch:left");
    const dimmedHost = await screen.findByTestId("rf__node-return:done");

    expect(selectedHost).toHaveClass("is-active", "is-related");
    expect(connectedHost).toHaveClass("is-related");
    expect(connectedHost).not.toHaveClass("is-dimmed");
    expect(dimmedHost).toHaveClass("is-dimmed");
  });

  it("does not reload the saved layout when local selection changes", async () => {
    renderGraphCanvas();

    expect(await screen.findByTestId("rf__node-branch:left")).toBeInTheDocument();
    expect(readStoredGraphLayoutMock).toHaveBeenCalledTimes(1);

    fireEvent.click(within(await screen.findByTestId("rf__node-branch:left")).getByText("branch left"));

    await waitFor(() => expect(readStoredGraphLayoutMock).toHaveBeenCalledTimes(1));
  });

  it("keeps persisted flow-node positions stable through a same-view rebuild", async () => {
    const persistedLayout = buildStoredLayout({
      nodes: {
        "entry:calculate": { x: 10, y: 20 },
        "branch:left": { x: 910, y: 340 },
        "branch:right": { x: 1040, y: 360 },
        "return:done": { x: 1200, y: 340 },
      },
    });
    setMockStoredGraphLayout("/workspace/calculator", "flow|symbol:calculator:calculate", persistedLayout);

    const { rerender } = renderGraphCanvas();
    const branchNode = await screen.findByTestId("rf__node-branch:left");
    await waitFor(() => {
      expect(branchNode.style.transform).toContain("translate(910px,340px)");
    });

    const rebuiltGraph: GraphView = {
      ...baseGraph,
      nodes: baseGraph.nodes.map((node) => (
        node.id === "branch:left"
          ? {
              ...node,
              x: 45,
              y: 55,
            }
          : node
      )),
    };

    rerender(
      <GraphCanvas
        repoPath="/workspace/calculator"
        graph={rebuiltGraph}
        activeNodeId="entry:calculate"
        graphFilters={{
          includeCalls: true,
          includeDefines: true,
          includeImports: true,
        }}
        graphSettings={{
          includeExternalDependencies: false,
        }}
        highlightGraphPath={false}
        showEdgeLabels={false}
        onSelectNode={vi.fn()}
        onActivateNode={vi.fn()}
        onInspectNode={vi.fn()}
        onSelectBreadcrumb={vi.fn()}
        onSelectLevel={vi.fn()}
        onToggleGraphFilter={vi.fn()}
        onToggleGraphSetting={vi.fn()}
        onToggleGraphPathHighlight={vi.fn()}
        onToggleEdgeLabels={vi.fn()}
        onNavigateOut={vi.fn()}
        onClearSelection={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("rf__node-branch:left").style.transform).toContain("translate(910px,340px)");
    });
  });

  it("treats shift-click as additive multiselect for nodes", async () => {
    renderGraphCanvas();

    fireEvent.click(within(await screen.findByTestId("rf__node-entry:calculate")).getByText("Entry"));
    fireEvent.keyDown(window, { key: "Shift", shiftKey: true });
    fireEvent.click(
      within(await screen.findByTestId("rf__node-branch:left")).getByText("branch left"),
      { shiftKey: true },
    );
    fireEvent.keyUp(window, { key: "Shift" });

    await waitFor(() => {
      expect(screen.getByTestId("rf__node-entry:calculate")).toHaveClass("selected");
      expect(screen.getByTestId("rf__node-branch:left")).toHaveClass("selected");
    });
  });

  it("keeps single-select emphasis behavior across a multiselect context", async () => {
    renderGraphCanvas();

    fireEvent.click(within(await screen.findByTestId("rf__node-entry:calculate")).getByText("Entry"));
    fireEvent.keyDown(window, { key: "Shift", shiftKey: true });
    fireEvent.click(
      within(await screen.findByTestId("rf__node-branch:left")).getByText("branch left"),
      { shiftKey: true },
    );
    fireEvent.keyUp(window, { key: "Shift" });

    await waitFor(() => {
      expect(screen.getByTestId("rf__node-entry:calculate")).toHaveClass("is-active", "is-related");
      expect(screen.getByTestId("rf__node-branch:left")).toHaveClass("is-active", "is-related");
      expect(screen.getByTestId("rf__node-branch:right")).toHaveClass("is-related");
      expect(screen.getByTestId("rf__node-branch:right")).not.toHaveClass("is-dimmed");
      expect(screen.getByTestId("rf__node-return:done")).toHaveClass("is-dimmed");
    });
  });

  it("suppresses single-node emphasis while a marquee selection is active", () => {
    const graphNodeIds = new Set(baseGraph.nodes.map((node) => node.id));

    expect(resolveSelectionPreviewNodeId({
      activeNodeId: "entry:calculate",
      effectiveSemanticSelection: ["branch:left"],
      graphNodeIds,
      marqueeSelectionActive: true,
      selectedRerouteCount: 0,
    })).toBe("");

    expect(resolveSelectionPreviewNodeId({
      activeNodeId: "entry:calculate",
      effectiveSemanticSelection: [],
      graphNodeIds,
      marqueeSelectionActive: true,
      selectedRerouteCount: 0,
    })).toBe("");

    expect(resolveSelectionPreviewNodeId({
      activeNodeId: "entry:calculate",
      effectiveSemanticSelection: ["branch:left"],
      graphNodeIds,
      marqueeSelectionActive: false,
      selectedRerouteCount: 0,
    })).toBe("branch:left");
  });

  it("highlights a whole handle group when you hover a grouped port", async () => {
    const user = userEvent.setup();
    const architectureGraph: GraphView = {
      rootNodeId: "module:focus",
      targetId: "module:focus",
      level: "module",
      nodes: [
        {
          id: "module:focus",
          kind: "module",
          label: "focus.py",
          subtitle: "3 symbols",
          x: 0,
          y: 0,
          metadata: {
            relative_path: "src/focus.py",
          },
          availableActions: [],
        },
        {
          id: "module:left-a",
          kind: "module",
          label: "left-a.py",
          x: -240,
          y: -60,
          metadata: {
            relative_path: "src/left-a.py",
          },
          availableActions: [],
        },
        {
          id: "module:left-b",
          kind: "module",
          label: "left-b.py",
          x: -240,
          y: 60,
          metadata: {
            relative_path: "src/left-b.py",
          },
          availableActions: [],
        },
        {
          id: "module:importer",
          kind: "module",
          label: "importer.py",
          x: -240,
          y: 160,
          metadata: {
            relative_path: "src/importer.py",
          },
          availableActions: [],
        },
      ],
      edges: [
        {
          id: "calls:left-a-focus",
          kind: "calls",
          source: "module:left-a",
          target: "module:focus",
          label: "2 calls",
        },
        {
          id: "calls:left-b-focus",
          kind: "calls",
          source: "module:left-b",
          target: "module:focus",
          label: "1 call",
        },
        {
          id: "imports:importer-focus",
          kind: "imports",
          source: "module:importer",
          target: "module:focus",
          label: "import",
        },
      ],
      breadcrumbs: [],
      focus: {
        targetId: "module:focus",
        level: "module",
        label: "focus.py",
        availableLevels: ["repo", "module"],
      },
      truncated: false,
    };

    render(
      <GraphCanvas
        repoPath="/workspace/project"
        graph={architectureGraph}
        activeNodeId="module:focus"
        graphFilters={{
          includeCalls: true,
          includeDefines: true,
          includeImports: true,
        }}
        graphSettings={{
          includeExternalDependencies: false,
        }}
        highlightGraphPath={false}
        showEdgeLabels
        onSelectNode={vi.fn()}
        onActivateNode={vi.fn()}
        onInspectNode={vi.fn()}
        onSelectBreadcrumb={vi.fn()}
        onSelectLevel={vi.fn()}
        onToggleGraphFilter={vi.fn()}
        onToggleGraphSetting={vi.fn()}
        onToggleGraphPathHighlight={vi.fn()}
        onToggleEdgeLabels={vi.fn()}
        onNavigateOut={vi.fn()}
        onClearSelection={vi.fn()}
      />,
    );

    const focusNodeHost = await screen.findByTestId("rf__node-module:focus");
    const focusNode = focusNodeHost.querySelector(".graph-node");
    expect(focusNode).not.toBeNull();

    const callsPort = within(focusNode as HTMLElement).getByText("calls").closest(".graph-node__port");
    const importsPort = within(focusNode as HTMLElement).getByText("imports").closest(".graph-node__port");
    expect(callsPort).not.toBeNull();
    expect(importsPort).not.toBeNull();

    await user.hover(within(callsPort as HTMLElement).getByText("calls"));

    await waitFor(() => {
      const liveCallsPort = within(focusNodeHost).getByText("calls").closest(".graph-node__port");
      const liveImportsPort = within(focusNodeHost).getByText("imports").closest(".graph-node__port");
      expect(liveCallsPort).toHaveClass("is-highlighted");
      expect(liveImportsPort).toHaveClass("is-dimmed");
    });

    await user.unhover(within(callsPort as HTMLElement).getByText("calls"));

    await waitFor(() => {
      const liveCallsPort = within(focusNodeHost).getByText("calls").closest(".graph-node__port");
      const liveImportsPort = within(focusNodeHost).getByText("imports").closest(".graph-node__port");
      expect(liveCallsPort).not.toHaveClass("is-highlighted");
      expect(liveImportsPort).not.toHaveClass("is-dimmed");
    });
  });

  it("fans out labels that share the same visual edge lane", () => {
    const offsets = buildEdgeLabelOffsets([
      {
        id: "calls:alpha::segment:0",
        label: "alpha",
        source: "module:source",
        target: "module:target",
        sourceHandle: "out:graph:calls",
        targetHandle: "in:graph:calls",
      },
      {
        id: "calls:beta::segment:0",
        label: "beta",
        source: "module:source",
        target: "module:target",
        sourceHandle: "out:graph:calls",
        targetHandle: "in:graph:calls",
      },
      {
        id: "calls:gamma::segment:0",
        label: "gamma",
        source: "module:source",
        target: "module:target",
        sourceHandle: "out:graph:calls",
        targetHandle: "in:graph:calls",
      },
    ]);

    const alphaOffset = offsets.get("calls:alpha::segment:0");
    const betaOffset = offsets.get("calls:beta::segment:0");
    const gammaOffset = offsets.get("calls:gamma::segment:0");

    expect(alphaOffset).toBeDefined();
    expect(betaOffset).toBeDefined();
    expect(gammaOffset).toBeDefined();
    expect(alphaOffset?.x).not.toBe(betaOffset?.x);
    expect(betaOffset?.x).not.toBe(gammaOffset?.x);
    expect(alphaOffset?.x).not.toBe(gammaOffset?.x);
    expect(alphaOffset?.y).toBe(-10);
    expect(betaOffset?.y).toBe(-10);
    expect(gammaOffset?.y).toBe(-10);
  });

  it("collapses duplicate labels on the same visual edge lane into one counted label", () => {
    const { collapsedLabels, visibleSegments } = collapseDuplicateEdgeLabels([
      {
        id: "calls:error-a::segment:0",
        label: "CalculatorError",
        source: "module:source",
        target: "module:target",
        sourceHandle: "out:graph:calls",
        targetHandle: "in:graph:calls",
      },
      {
        id: "calls:error-b::segment:0",
        label: "CalculatorError",
        source: "module:source",
        target: "module:target",
        sourceHandle: "out:graph:calls",
        targetHandle: "in:graph:calls",
      },
      {
        id: "calls:error-c::segment:0",
        label: "CalculatorError",
        source: "module:source",
        target: "module:target",
        sourceHandle: "out:graph:calls",
        targetHandle: "in:graph:calls",
      },
      {
        id: "calls:value::segment:0",
        label: "value",
        source: "module:source",
        target: "module:target",
        sourceHandle: "out:graph:calls",
        targetHandle: "in:graph:calls",
      },
    ]);

    const countedLabelIds = [...collapsedLabels.entries()]
      .filter(([, label]) => label.label === "CalculatorError")
      .map(([id]) => id);
    const hiddenLabelIds = [...collapsedLabels.entries()]
      .filter(([, label]) => label.label === undefined)
      .map(([id]) => id);

    expect(visibleSegments.map((segment) => segment.label).sort()).toEqual(["CalculatorError", "value"]);
    expect(countedLabelIds).toHaveLength(1);
    expect(collapsedLabels.get(countedLabelIds[0] ?? "")).toEqual({
      label: "CalculatorError",
      count: 3,
    });
    expect(hiddenLabelIds.sort()).toEqual([
      "calls:error-b::segment:0",
      "calls:error-c::segment:0",
    ]);
    expect(collapsedLabels.get("calls:value::segment:0")).toEqual({
      label: "value",
      count: undefined,
    });
  });

  it("reports graph port help through the workspace help box", async () => {
    const user = userEvent.setup();

    render(
      <WorkspaceHelpProvider>
        <WorkspaceHelpScope>
          <GraphCanvas
            repoPath="/workspace/calculator"
            graph={baseGraph}
            activeNodeId="entry:calculate"
            graphFilters={{
              includeCalls: true,
              includeDefines: true,
              includeImports: true,
            }}
            graphSettings={{
              includeExternalDependencies: false,
            }}
            highlightGraphPath={false}
            showEdgeLabels={false}
            onSelectNode={vi.fn()}
            onActivateNode={vi.fn()}
            onInspectNode={vi.fn()}
            onSelectBreadcrumb={vi.fn()}
            onSelectLevel={vi.fn()}
            onToggleGraphFilter={vi.fn()}
            onToggleGraphSetting={vi.fn()}
            onToggleGraphPathHighlight={vi.fn()}
            onToggleEdgeLabels={vi.fn()}
            onNavigateOut={vi.fn()}
            onClearSelection={vi.fn()}
          />
          <WorkspaceHelpBox />
        </WorkspaceHelpScope>
      </WorkspaceHelpProvider>,
    );

    const helpBox = document.querySelector(".workspace-help-box");
    expect(helpBox).not.toBeNull();
    const help = within(helpBox as HTMLElement);

    const paramHost = await screen.findByTestId("rf__node-branch:left");
    const execPort = within(paramHost).getAllByText("exec")[0]?.closest(".graph-node__port");
    expect(execPort).not.toBeNull();
    await user.hover(execPort as HTMLElement);
    expect(help.getByText("Execution port")).toBeInTheDocument();
  });

  it("hydrates persisted reroute nodes from the repo-backed layout", async () => {
    readStoredGraphLayoutMock.mockResolvedValueOnce({
      nodes: {},
      reroutes: [
        {
          id: "reroute-1",
          edgeId: "controls:entry:left",
          order: 0,
          x: 132,
          y: 164,
        },
      ],
      pinnedNodeIds: [],
      groups: [],
    });

    render(
      <GraphCanvas
        repoPath="/workspace/calculator"
        graph={baseGraph}
        activeNodeId="entry:calculate"
        graphFilters={{
          includeCalls: true,
          includeDefines: true,
          includeImports: true,
        }}
        graphSettings={{
          includeExternalDependencies: false,
        }}
        highlightGraphPath={false}
        showEdgeLabels={false}
        onSelectNode={vi.fn()}
        onActivateNode={vi.fn()}
        onInspectNode={vi.fn()}
        onSelectBreadcrumb={vi.fn()}
        onSelectLevel={vi.fn()}
        onToggleGraphFilter={vi.fn()}
        onToggleGraphSetting={vi.fn()}
        onToggleGraphPathHighlight={vi.fn()}
        onToggleEdgeLabels={vi.fn()}
        onNavigateOut={vi.fn()}
        onClearSelection={vi.fn()}
      />,
    );

    expect(await screen.findByTestId("rf__node-reroute:reroute-1")).toBeInTheDocument();
    expect(writeStoredGraphLayoutMock).not.toHaveBeenCalled();
  });

  it("pins nodes through the node action and toggles them back with the hotkey", async () => {
    render(
      <GraphCanvas
        repoPath="/workspace/calculator"
        graph={baseGraph}
        activeNodeId="entry:calculate"
        graphFilters={{
          includeCalls: true,
          includeDefines: true,
          includeImports: true,
        }}
        graphSettings={{
          includeExternalDependencies: false,
        }}
        highlightGraphPath={false}
        showEdgeLabels={false}
        onSelectNode={vi.fn()}
        onActivateNode={vi.fn()}
        onInspectNode={vi.fn()}
        onSelectBreadcrumb={vi.fn()}
        onSelectLevel={vi.fn()}
        onToggleGraphFilter={vi.fn()}
        onToggleGraphSetting={vi.fn()}
        onToggleGraphPathHighlight={vi.fn()}
        onToggleEdgeLabels={vi.fn()}
        onNavigateOut={vi.fn()}
        onClearSelection={vi.fn()}
      />,
    );

    const entryNodeHost = await screen.findByTestId("rf__node-entry:calculate");
    expect(writeStoredGraphLayoutMock).not.toHaveBeenCalled();
    expect(within(entryNodeHost).getByText("Pin")).toBeInTheDocument();

    const graphPanel = screen.getByRole("region", { name: /Graph canvas/i });
    fireEvent.keyDown(graphPanel, { key: "p" });

    await waitFor(() =>
      expect(
        writeStoredGraphLayoutMock.mock.calls[writeStoredGraphLayoutMock.mock.calls.length - 1]?.[2].pinnedNodeIds,
      ).toEqual(["entry:calculate"]),
    );

    fireEvent.keyDown(graphPanel, { key: "p" });

    await waitFor(() =>
      expect(
        writeStoredGraphLayoutMock.mock.calls[writeStoredGraphLayoutMock.mock.calls.length - 1]?.[2].pinnedNodeIds,
      ).toEqual([]),
    );
  });

  it("fits the graph view when you press f", async () => {
    renderGraphCanvas();

    expect(await screen.findByTestId("rf__node-entry:calculate")).toBeInTheDocument();

    const graphPanel = screen.getByRole("region", { name: /Graph canvas/i });
    const fitViewButton = document.querySelector(".react-flow__controls-fitview") as HTMLButtonElement | null;
    if (!fitViewButton) {
      throw new Error("Expected the React Flow fit-view control to be rendered.");
    }
    const clickSpy = vi.spyOn(fitViewButton, "click").mockImplementation(() => {});

    fireEvent.keyDown(graphPanel, { key: "f" });

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("clears selection when the graph pane background is clicked", async () => {
    const onClearSelection = vi.fn();
    const user = userEvent.setup();

    render(
      <GraphCanvas
        repoPath="/workspace/calculator"
        graph={baseGraph}
        activeNodeId="entry:calculate"
        graphFilters={{
          includeCalls: true,
          includeDefines: true,
          includeImports: true,
        }}
        graphSettings={{
          includeExternalDependencies: false,
        }}
        highlightGraphPath={false}
        showEdgeLabels={false}
        onSelectNode={vi.fn()}
        onActivateNode={vi.fn()}
        onInspectNode={vi.fn()}
        onSelectBreadcrumb={vi.fn()}
        onSelectLevel={vi.fn()}
        onToggleGraphFilter={vi.fn()}
        onToggleGraphSetting={vi.fn()}
        onToggleGraphPathHighlight={vi.fn()}
        onToggleEdgeLabels={vi.fn()}
        onNavigateOut={vi.fn()}
        onClearSelection={onClearSelection}
      />,
    );

    const pane = document.querySelector(".react-flow__pane");
    expect(pane).not.toBeNull();
    await user.click(pane as HTMLElement);

    expect(onClearSelection).toHaveBeenCalledTimes(1);
  });

  it("renders the create-mode chrome and opens a canvas create intent from the pane", async () => {
    const onCreateIntent = vi.fn();
    const user = userEvent.setup();

    renderGraphCanvas({
      graph: moduleGraph,
      activeNodeId: undefined,
      createModeState: "active",
      createModeCanvasEnabled: true,
      createModeHint: "Click the graph to create a symbol.",
      onCreateIntent,
    });

    expect(await screen.findByTestId("graph-create-mode-badge")).toHaveTextContent(/Create mode/i);
    expect(screen.getByTestId("graph-create-mode-watermark")).toHaveTextContent("CREATE MODE");
    expect(screen.getByTestId("graph-create-mode-hint")).toHaveTextContent("Click the graph to create a symbol.");

    const pane = document.querySelector(".react-flow__pane");
    expect(pane).not.toBeNull();
    await user.click(pane as HTMLElement);

    await waitFor(() =>
      expect(onCreateIntent).toHaveBeenCalledWith(
        expect.objectContaining({
          flowPosition: expect.objectContaining({
            x: expect.any(Number),
            y: expect.any(Number),
          }),
          panelPosition: expect.objectContaining({
            x: expect.any(Number),
            y: expect.any(Number),
          }),
        }),
      ),
    );
  });

  it("keeps flow-node clicks selection-only in create mode and still opens a create intent from empty canvas", async () => {
    const onCreateIntent = vi.fn();
    const onSelectNode = vi.fn();

    renderGraphCanvas({
      graph: baseGraph,
      activeNodeId: undefined,
      createModeState: "active",
      createModeCanvasEnabled: true,
      createModeHint: "Click empty canvas to create a flow node in this draft.",
      onCreateIntent,
      onSelectNode,
    });

    const existingNode = await screen.findByTestId("rf__node-branch:left");
    fireEvent.click(existingNode);

    expect(onCreateIntent).not.toHaveBeenCalled();
    expect(onSelectNode).toHaveBeenCalledWith("branch:left", "branch");

    const pane = document.querySelector(".react-flow__pane");
    expect(pane).not.toBeNull();
    fireEvent.click(pane as HTMLElement);

    await waitFor(() =>
      expect(onCreateIntent).toHaveBeenCalledWith(
        expect.objectContaining({
          flowPosition: expect.objectContaining({
            x: expect.any(Number),
            y: expect.any(Number),
          }),
          panelPosition: expect.objectContaining({
            x: expect.any(Number),
            y: expect.any(Number),
          }),
        }),
      ),
    );
  });

  it("opens a flow edit intent from ordinary flow-node double-clicks even while create mode is active", async () => {
    const onEditFlowNodeIntent = vi.fn();
    const onCreateIntent = vi.fn();

    renderGraphCanvas({
      graph: editableFlowGraph,
      activeNodeId: undefined,
      createModeState: "active",
      createModeCanvasEnabled: true,
      createModeHint: "Click empty canvas to create a flow node in this draft.",
      onCreateIntent,
      onEditFlowNodeIntent,
    });

    const existingNode = await screen.findByTestId("rf__node-branch:left");
    fireEvent.doubleClick(existingNode);

    await waitFor(() =>
      expect(onEditFlowNodeIntent).toHaveBeenCalledWith(
        expect.objectContaining({
          nodeId: "branch:left",
          flowPosition: expect.objectContaining({
            x: expect.any(Number),
            y: expect.any(Number),
          }),
          panelPosition: expect.objectContaining({
            x: expect.any(Number),
            y: expect.any(Number),
          }),
        }),
      ),
    );
    expect(onCreateIntent).not.toHaveBeenCalled();
  });

  it("opens the return expression graph from return-node double-clicks", async () => {
    const onOpenExpressionGraphIntent = vi.fn();
    const onEditFlowNodeIntent = vi.fn();

    renderGraphCanvas({
      graph: editableFlowGraph,
      activeNodeId: undefined,
      onEditFlowNodeIntent,
      onOpenExpressionGraphIntent,
    });

    const returnNode = await screen.findByTestId("rf__node-return:done");
    fireEvent.doubleClick(returnNode);

    await waitFor(() =>
      expect(onOpenExpressionGraphIntent).toHaveBeenCalledWith(
        expect.objectContaining({
          nodeId: "return:done",
          flowPosition: expect.objectContaining({
            x: expect.any(Number),
            y: expect.any(Number),
          }),
          panelPosition: expect.objectContaining({
            x: expect.any(Number),
            y: expect.any(Number),
          }),
        }),
      ),
    );
    expect(onEditFlowNodeIntent).not.toHaveBeenCalled();
  });

  it("opens the return expression graph from mini-preview nodes", async () => {
    const onOpenExpressionGraphIntent = vi.fn();

    renderGraphCanvas({
      graph: editableFlowGraphWithReturnExpression,
      activeNodeId: undefined,
      onOpenExpressionGraphIntent,
    });

    const previewNode = await screen.findByTestId("graph-expression-preview-node-expr:input:done");
    fireEvent.click(previewNode);

    await waitFor(() =>
      expect(onOpenExpressionGraphIntent).toHaveBeenCalledWith(
        expect.objectContaining({
          nodeId: "return:done",
          expressionNodeId: "expr:input:done",
          flowPosition: expect.objectContaining({
            x: expect.any(Number),
            y: expect.any(Number),
          }),
          panelPosition: expect.objectContaining({
            x: expect.any(Number),
            y: expect.any(Number),
          }),
        }),
      ),
    );
  });

  it("distinguishes plain edge selection from Alt-click disconnect in editable flow views", () => {
    expect(resolveFlowEdgeInteraction({
      flowAuthoringEnabled: true,
      logicalEdgeKind: "controls",
      altKey: false,
    })).toBe("select");

    expect(resolveFlowEdgeInteraction({
      flowAuthoringEnabled: true,
      logicalEdgeKind: "controls",
      altKey: true,
    })).toBe("disconnect");

    expect(resolveFlowEdgeInteraction({
      flowAuthoringEnabled: true,
      logicalEdgeKind: "calls",
      altKey: true,
    })).toBe("ignore");
  });

  it("validates only supported flow handle pairings at the canvas layer", () => {
    expect(isValidFlowCanvasConnection({
      source: "entry:calculate",
      sourceHandle: "out:control:start",
      target: "branch:left",
      targetHandle: "in:control:exec",
    })).toBe(true);

    expect(isValidFlowCanvasConnection({
      source: "entry:calculate",
      sourceHandle: "out:data:function-input:graph",
      target: "branch:left",
      targetHandle: "in:data:input-slot:graph",
    })).toBe(true);

    expect(isValidFlowCanvasConnection({
      source: "branch:left",
      sourceHandle: "out:control:true",
      target: "branch:left",
      targetHandle: "in:control:exec",
    })).toBe(false);

    expect(isValidFlowCanvasConnection({
      source: "entry:calculate",
      sourceHandle: "out:control:start",
      target: "branch:left",
      targetHandle: "in:data:input-slot:graph",
    })).toBe(false);
  });

  it("shows a visible connection line while dragging editable flow control handles", async () => {
    const restoreRects = mockGraphCanvasElementRect();
    const onConnectFlowEdge = vi.fn();

    try {
      renderGraphCanvas({
        graph: editableVisualFlowGraph,
        activeNodeId: undefined,
        onConnectFlowEdge,
      });

      const sourceHandle = await findGraphHandle("entry:calculate", "out:control:start");
      const targetHandle = await findGraphHandle("assign:calculate", "in:control:exec");
      expect(sourceHandle).toHaveClass("connectable");
      expect(targetHandle).toHaveClass("connectable");
      expect(sourceHandle).toHaveClass("is-flow-connectable");
      expect(targetHandle).toHaveClass("is-flow-connectable");
      const drag = beginConnectionDrag({
        dragStart: sourceHandle,
        targetHandle,
      });

      try {
        expect(await screen.findByTestId("graph-connection-line")).toHaveClass("is-valid");
      } finally {
        drag.finish();
      }

      await waitFor(() =>
        expect(onConnectFlowEdge).toHaveBeenCalledWith({
          sourceId: "entry:calculate",
          sourceHandle: "out:control:start",
          targetId: "assign:calculate",
          targetHandle: "in:control:exec",
        }),
      );
    } finally {
      restoreRects();
    }
  });

  it("keeps editable flow edges reconnectable through their edge updater anchors", async () => {
    const restoreRects = mockGraphCanvasElementRect();
    const edgeId = "controls:entry:calculate:start->assign:calculate:in";

    try {
      renderGraphCanvas({
        graph: editableVisualFlowGraph,
        activeNodeId: undefined,
      });

      const edgeHost = await screen.findByTestId(`rf__edge-${edgeId}::segment:0`);
      const targetUpdater = edgeHost.querySelector(".react-flow__edgeupdater-target");
      expect(targetUpdater).not.toBeNull();
      expect(isValidFlowCanvasConnection({
        source: "entry:calculate",
        sourceHandle: "out:control:start",
        target: "return:done",
        targetHandle: "in:control:exec",
      })).toBe(true);
    } finally {
      restoreRects();
    }
  });

  it("shows the same drag feedback for editable flow data handles", async () => {
    const restoreRects = mockGraphCanvasElementRect();
    const dataFlowGraph: GraphView = {
      ...editableVisualFlowGraph,
      edges: [
        ...editableVisualFlowGraph.edges,
        {
          id: "data:assign:return",
          kind: "data",
          source: "assign:calculate",
          target: "return:done",
          label: "value",
          metadata: {
            source_handle: "out:data:value-source:assign-value",
            target_handle: "in:data:input-slot:return-value",
          },
        },
      ],
    };

    try {
      renderGraphCanvas({
        graph: dataFlowGraph,
        activeNodeId: undefined,
      });

      const sourceHandle = await findGraphHandle("assign:calculate", "out:data:value-source:assign-value");
      const targetHandle = await findGraphHandle("return:done", "in:data:input-slot:return-value");
      expect(sourceHandle).toHaveClass("is-flow-connectable");
      expect(targetHandle).toHaveClass("is-flow-connectable");
      const drag = beginConnectionDrag({
        dragStart: sourceHandle,
        targetHandle,
      });

      try {
        expect(await screen.findByTestId("graph-connection-line")).toHaveClass("is-valid");
      } finally {
        drag.finish();
      }
    } finally {
      restoreRects();
    }
  });

  it("keeps non-flow graph handles read-only without connection drag feedback", async () => {
    const restoreRects = mockGraphCanvasElementRect();
    const onConnectFlowEdge = vi.fn();

    try {
      renderGraphCanvas({
        graph: moduleGraph,
        activeNodeId: undefined,
        onConnectFlowEdge,
      });

      const sourceHandle = await findGraphHandle("module:left-a", "out:graph:calls");
      const targetHandle = await findGraphHandle("module:focus", "in:graph:calls");
      expect(sourceHandle).not.toHaveClass("is-flow-connectable");
      expect(targetHandle).not.toHaveClass("is-flow-connectable");
      const drag = beginConnectionDrag({
        dragStart: sourceHandle,
        targetHandle,
      });

      try {
        expect(screen.queryByTestId("graph-connection-line")).not.toBeInTheDocument();
      } finally {
        drag.finish();
      }
      expect(onConnectFlowEdge).not.toHaveBeenCalled();
    } finally {
      restoreRects();
    }
  });

  it("does not render insertion-lane UI in the normal editable flow authoring path", async () => {
    renderGraphCanvas({
      graph: editableFlowGraph,
      activeNodeId: undefined,
      createModeState: "active",
      createModeCanvasEnabled: true,
      createModeHint: "Click empty canvas to create a flow node in this draft.",
      onCreateIntent: vi.fn(),
    });

    await waitFor(() =>
      expect(screen.queryByTestId("graph-edge:controls:entry:left")).not.toBeInTheDocument(),
    );
  });

  it("merges touched groups into one flat group when regrouping a selection", () => {
    expect(
      mergeGroupsForSelection(
        [
          {
            id: "group-left",
            title: "Left side",
            memberNodeIds: ["branch:left", "entry:calculate"],
          },
          {
            id: "group-right",
            title: "Right side",
            memberNodeIds: ["branch:right", "return:done"],
          },
        ],
        ["branch:left", "branch:right"],
        () => "group-merged",
      ),
    ).toEqual({
      changed: true,
      nextGroupId: "group-merged",
      nextGroups: [
        {
          id: "group-merged",
          title: "Group",
          memberNodeIds: ["branch:left", "branch:right", "entry:calculate", "return:done"],
        },
      ],
    });
  });

  it("no-ops grouping and ungroups touched selections through the pure grouping helpers", () => {
    const existingGroups = [
      {
        id: flowGroup.id,
        title: flowGroup.title,
        memberNodeIds: flowGroup.memberNodeIds,
      },
    ];

    expect(
      mergeGroupsForSelection(existingGroups, ["entry:calculate", "branch:left"], () => "unused"),
    ).toEqual({
      changed: false,
      nextGroups: existingGroups,
    });

    expect(ungroupGroupsForSelection(existingGroups, ["entry:calculate"])).toEqual({
      changed: true,
      nextGroups: [],
      removedGroupIds: [flowGroup.id],
    });
  });

  it("normalizes persisted groups against live nodes and keeps declutter deltas rigid for groups", () => {
    expect(
      normalizeStoredGroups(
        [
          {
            id: "group-primary",
            title: "",
            memberNodeIds: ["entry:calculate", "branch:left", "branch:left", "missing:node"],
          },
          {
            id: "group-secondary",
            title: "Should drop",
            memberNodeIds: ["entry:calculate", "return:done"],
          },
          {
            id: "group-solo",
            title: "Solo",
            memberNodeIds: ["return:done"],
          },
        ],
        new Set(baseGraph.nodes.map((node) => node.id)),
      ),
    ).toEqual([
      {
        id: "group-primary",
        title: "Group",
        memberNodeIds: ["branch:left", "entry:calculate"],
      },
    ]);

    const groupedNodes = [
      {
        id: "entry:calculate",
        type: "blueprint",
        position: { x: 0, y: 150 },
        data: {
          kind: "entry",
          label: "Entry",
          isPinned: false,
          inputPorts: [],
          outputPorts: [],
          actions: [],
        },
      },
      {
        id: "branch:left",
        type: "blueprint",
        position: { x: 220, y: 132 },
        data: {
          kind: "branch",
          label: "branch left",
          isPinned: false,
          inputPorts: [],
          outputPorts: [],
          actions: [],
        },
      },
      {
        id: "return:done",
        type: "blueprint",
        position: { x: 520, y: 150 },
        data: {
          kind: "return",
          label: "return done",
          isPinned: false,
          inputPorts: [],
          outputPorts: [],
          actions: [],
        },
      },
    ] as unknown as Parameters<typeof applyGroupedLayoutPositions>[0];
    const groupedLayout = applyGroupedLayoutPositions(
      groupedNodes,
      {
        "entry:calculate": { x: 48, y: 186 },
        "return:done": { x: 600, y: 140 },
      },
      new Map([[flowGroup.id, ["branch:left", "entry:calculate"]]]),
      new Map([
        ["entry:calculate", flowGroup.id],
        ["branch:left", flowGroup.id],
      ]),
    );

    expect(groupedLayout.find((node) => node.id === "entry:calculate")?.position).toEqual({
      x: 48,
      y: 186,
    });
    expect(groupedLayout.find((node) => node.id === "branch:left")?.position).toEqual({
      x: 268,
      y: 168,
    });
    expect(groupedLayout.find((node) => node.id === "return:done")?.position).toEqual({
      x: 600,
      y: 140,
    });
  });

  it("renders persisted flow groups, keeps grouped member selection working, and normalizes renamed titles", async () => {
    const onSelectNode = vi.fn();
    readStoredGraphLayoutMock.mockResolvedValueOnce(buildStoredLayout({
      groups: [flowGroup],
    }));

    renderGraphCanvas({
      onSelectNode,
    });

    const groupBox = await screen.findByTestId(`graph-group-${flowGroup.id}`);
    expect(groupBox).toBeInTheDocument();
    expect(within(groupBox).getByTitle("2 nodes grouped")).toHaveTextContent("2");
    expect(await screen.findByTestId("rf__node-entry:calculate")).toHaveClass("is-group-member");
    fireEvent.pointerDown(within(groupBox).getByTestId(`graph-group-hit-area-${flowGroup.id}-top`), {
      button: 0,
      clientX: 96,
      clientY: 48,
    });
    fireEvent.pointerUp(window, {
      clientX: 96,
      clientY: 48,
    });
    await waitFor(() => expect(groupBox).toHaveClass("is-selected"));
    fireEvent.click(within(await screen.findByTestId("rf__node-entry:calculate")).getByText("Entry"));
    expect(onSelectNode).toHaveBeenCalledWith("entry:calculate", "entry");
    await waitFor(() => expect(groupBox).not.toHaveClass("is-selected"));
    expect(renameGraphGroup([flowGroup], flowGroup.id, "Control path")).toEqual([
      {
        ...flowGroup,
        title: "Control path",
      },
    ]);

    expect(renameGraphGroup([flowGroup], flowGroup.id, "   ")).toEqual([
      flowGroup,
    ]);
  });

  it("selects and drags a group from the boundary band without changing membership", async () => {
    const groupedLayout = buildStoredLayout({
      groups: [flowGroup],
    });
    readStoredGraphLayoutMock.mockResolvedValueOnce(groupedLayout);

    renderGraphCanvas();

    const groupBox = await screen.findByTestId(`graph-group-${flowGroup.id}`);
    const topHitArea = within(groupBox).getByTestId(`graph-group-hit-area-${flowGroup.id}-top`);

    fireEvent.pointerDown(topHitArea, {
      button: 0,
      clientX: 96,
      clientY: 48,
    });
    await waitFor(() => expect(groupBox).toHaveClass("is-selected"));

    fireEvent.pointerMove(window, {
      clientX: 176,
      clientY: 132,
    });
    fireEvent.pointerUp(window, {
      clientX: 176,
      clientY: 132,
    });

    await waitFor(() => expect(writeStoredGraphLayoutMock).toHaveBeenCalled());
    expect(latestPersistedLayout()?.groups).toEqual([flowGroup]);
    expect(latestPersistedLayout()?.nodes["entry:calculate"]).not.toEqual(groupedLayout.nodes["entry:calculate"]);
    expect(latestPersistedLayout()?.nodes["branch:left"]).not.toEqual(groupedLayout.nodes["branch:left"]);
  });

  it("organizes a group through inline presets and can undo the layout change", async () => {
    const user = userEvent.setup();
    const groupedLayout = buildStoredLayout({
      groups: [flowGroup],
    });
    readStoredGraphLayoutMock.mockResolvedValueOnce(groupedLayout);

    renderGraphCanvas();

    const groupBox = await screen.findByTestId(`graph-group-${flowGroup.id}`);
    await user.click(within(groupBox).getByRole("button", { name: "Organize" }));

    const organizePalette = await screen.findByTestId(`graph-group-organize-${flowGroup.id}`);
    expect(within(organizePalette).getByRole("button", { name: "Column" })).toBeInTheDocument();
    expect(within(organizePalette).getByRole("button", { name: "By kind" })).toBeInTheDocument();

    await user.click(within(organizePalette).getByRole("button", { name: "Column" }));

    await waitFor(() => expect(writeStoredGraphLayoutMock).toHaveBeenCalledTimes(1));
    expect(latestPersistedLayout()?.groups).toEqual([flowGroup]);
    expect(latestPersistedLayout()?.nodes["entry:calculate"]).not.toEqual(groupedLayout.nodes["entry:calculate"]);
    expect(latestPersistedLayout()?.nodes["branch:left"]).not.toEqual(groupedLayout.nodes["branch:left"]);
    expect(screen.queryByTestId(`graph-group-organize-${flowGroup.id}`)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /calculate/i }));
    expect(screen.getByRole("button", { name: "Undo layout" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Undo layout" }));

    await waitFor(() => expect(writeStoredGraphLayoutMock).toHaveBeenCalledTimes(2));
    expect(writeStoredGraphLayoutMock.mock.calls[1]?.[2]).toEqual(groupedLayout);
  });

  it("fans out flow pinning to every grouped member and ungroups from the group chip", async () => {
    readStoredGraphLayoutMock.mockResolvedValueOnce(buildStoredLayout({
      groups: [flowGroup],
      pinnedNodeIds: ["entry:calculate"],
    }));

    renderGraphCanvas();

    fireEvent.click(within(await screen.findByTestId("rf__node-entry:calculate")).getByText("Entry"));

    const graphPanel = screen.getByRole("region", { name: /Graph canvas/i });
    fireEvent.keyDown(graphPanel, { key: "p" });

    await waitFor(() =>
      expect(latestPersistedLayout()?.pinnedNodeIds).toEqual(["branch:left", "entry:calculate"]),
    );
    expect(within(await screen.findByTestId("rf__node-entry:calculate")).getByText("Unpin")).toBeInTheDocument();
    expect(within(await screen.findByTestId("rf__node-branch:left")).getByText("Unpin")).toBeInTheDocument();

    fireEvent.keyDown(graphPanel, { key: "p" });

    await waitFor(() =>
      expect(latestPersistedLayout()?.pinnedNodeIds).toEqual([]),
    );

    fireEvent.click(
      within(await screen.findByTestId(`graph-group-${flowGroup.id}`)).getByRole("button", { name: "Ungroup" }),
    );

    await waitFor(() =>
      expect(confirmDialogMock).toHaveBeenCalledWith(
        'Ungroup "Group"?',
        {
          title: "Ungroup nodes",
          kind: "warning",
          okLabel: "Ungroup",
          cancelLabel: "Cancel",
        },
      ),
    );
    await waitFor(() => expect(latestPersistedLayout()?.groups).toEqual([]));
  });

  it("keeps the group when ungroup confirmation is cancelled", async () => {
    confirmDialogMock.mockResolvedValue(false);
    readStoredGraphLayoutMock.mockResolvedValueOnce(buildStoredLayout({
      groups: [flowGroup],
    }));

    renderGraphCanvas();

    fireEvent.click(
      within(await screen.findByTestId(`graph-group-${flowGroup.id}`)).getByRole("button", { name: "Ungroup" }),
    );

    await waitFor(() =>
      expect(confirmDialogMock).toHaveBeenCalledWith(
        'Ungroup "Group"?',
        {
          title: "Ungroup nodes",
          kind: "warning",
          okLabel: "Ungroup",
          cancelLabel: "Cancel",
        },
      ),
    );
    expect(writeStoredGraphLayoutMock).not.toHaveBeenCalled();
    expect(await screen.findByTestId(`graph-group-${flowGroup.id}`)).toBeInTheDocument();
  });

  it("applies group-box style movement deltas rigidly to every grouped member", () => {
    const movedNodes = applyMemberNodeDelta(
      [
        {
          id: "entry:calculate",
          type: "blueprint",
          position: { x: 0, y: 150 },
          data: {
            kind: "entry",
            label: "Entry",
            isPinned: false,
            inputPorts: [],
            outputPorts: [],
            actions: [],
          },
        },
        {
          id: "branch:left",
          type: "blueprint",
          position: { x: 220, y: 132 },
          data: {
            kind: "branch",
            label: "branch left",
            isPinned: false,
            inputPorts: [],
            outputPorts: [],
            actions: [],
          },
        },
        {
          id: "return:done",
          type: "blueprint",
          position: { x: 520, y: 150 },
          data: {
            kind: "return",
            label: "return done",
            isPinned: false,
            inputPorts: [],
            outputPorts: [],
            actions: [],
          },
        },
      ] as unknown as Parameters<typeof applyMemberNodeDelta>[0],
      flowGroup.memberNodeIds,
      { x: 60, y: 34 },
      new Map([
        ["entry:calculate", { x: 0, y: 150 }],
        ["branch:left", { x: 220, y: 132 }],
      ]),
    );

    expect(movedNodes.find((node) => node.id === "entry:calculate")?.position).toEqual({
      x: 60,
      y: 184,
    });
    expect(movedNodes.find((node) => node.id === "branch:left")?.position).toEqual({
      x: 280,
      y: 166,
    });
    expect(movedNodes.find((node) => node.id === "return:done")?.position).toEqual({
      x: 520,
      y: 150,
    });
  });

  it("renders groups on non-flow canvases and leaves pinning unavailable", async () => {
    readStoredGraphLayoutMock.mockResolvedValueOnce(buildModuleStoredLayout({
      groups: [moduleGroup],
    }));

    renderGraphCanvas({
      graph: moduleGraph,
      activeNodeId: "module:focus",
    });

    expect(await screen.findByTestId(`graph-group-${moduleGroup.id}`)).toBeInTheDocument();
    expect(within(await screen.findByTestId("rf__node-module:focus")).queryByText("Pin")).not.toBeInTheDocument();
    fireEvent.click(within(await screen.findByTestId("rf__node-module:focus")).getByText("focus.py"));
    fireEvent.keyDown(screen.getByRole("region", { name: /Graph canvas/i }), { key: "p" });

    expect(writeStoredGraphLayoutMock).not.toHaveBeenCalled();
  });

  it("hides the by-kind preset for groups with only one node kind", async () => {
    const user = userEvent.setup();
    readStoredGraphLayoutMock.mockResolvedValueOnce(buildModuleStoredLayout({
      groups: [moduleGroup],
    }));

    renderGraphCanvas({
      graph: moduleGraph,
      activeNodeId: "module:focus",
    });

    const groupBox = await screen.findByTestId(`graph-group-${moduleGroup.id}`);
    await user.click(within(groupBox).getByRole("button", { name: "Organize" }));

    const organizePalette = await screen.findByTestId(`graph-group-organize-${moduleGroup.id}`);
    expect(within(organizePalette).queryByRole("button", { name: "By kind" })).not.toBeInTheDocument();
  });
});
