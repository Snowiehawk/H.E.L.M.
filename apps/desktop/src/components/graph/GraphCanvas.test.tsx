import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphView } from "../../lib/adapter";
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
  mergeGroupsForSelection,
  normalizeStoredGroups,
  renameGraphGroup,
  resolveSelectionPreviewNodeId,
  ungroupGroupsForSelection,
} from "./GraphCanvas";
import type { StoredGraphLayout } from "./graphLayoutPersistence";

const { readStoredGraphLayoutMock, writeStoredGraphLayoutMock, confirmDialogMock } = vi.hoisted(() => ({
  readStoredGraphLayoutMock: vi.fn(),
  writeStoredGraphLayoutMock: vi.fn(),
  confirmDialogMock: vi.fn(),
}));

vi.mock("./graphLayoutPersistence", async () => {
  const actual = await vi.importActual<typeof import("./graphLayoutPersistence")>("./graphLayoutPersistence");
  return {
    ...actual,
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

describe("GraphCanvas", () => {
  beforeEach(() => {
    readStoredGraphLayoutMock.mockReset();
    writeStoredGraphLayoutMock.mockReset();
    confirmDialogMock.mockReset();
    readStoredGraphLayoutMock.mockResolvedValue(originalLayout);
    writeStoredGraphLayoutMock.mockResolvedValue(undefined);
    confirmDialogMock.mockResolvedValue(true);
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
    expect(screen.getByRole("button", { name: "Undo declutter" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Undo declutter" }));

    await waitFor(() => expect(writeStoredGraphLayoutMock).toHaveBeenCalledTimes(2));
    const secondWrite = writeStoredGraphLayoutMock.mock.calls[1];
    expect(secondWrite[2]).toEqual(originalLayout);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Undo declutter" })).not.toBeInTheDocument(),
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
    expect(await screen.findByTestId("rf__node-entry:calculate")).toHaveClass("is-group-member");
    fireEvent.click(within(await screen.findByTestId("rf__node-entry:calculate")).getByText("Entry"));
    expect(onSelectNode).toHaveBeenCalledWith("entry:calculate", "entry");
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
});
