import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphView } from "../../lib/adapter";
import {
  WorkspaceHelpBox,
  WorkspaceHelpProvider,
  WorkspaceHelpScope,
} from "../workspace/workspaceHelp";
import { GraphCanvas, buildEdgeLabelOffsets } from "./GraphCanvas";

const { readStoredGraphLayoutMock, writeStoredGraphLayoutMock } = vi.hoisted(() => ({
  readStoredGraphLayoutMock: vi.fn(),
  writeStoredGraphLayoutMock: vi.fn(),
}));

vi.mock("./graphLayoutPersistence", async () => {
  const actual = await vi.importActual<typeof import("./graphLayoutPersistence")>("./graphLayoutPersistence");
  return {
    ...actual,
    readStoredGraphLayout: readStoredGraphLayoutMock,
    writeStoredGraphLayout: writeStoredGraphLayoutMock,
  };
});

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

const originalLayout = {
  nodes: {
    "entry:calculate": { x: 0, y: 150 },
    "branch:left": { x: 220, y: 132 },
    "branch:right": { x: 246, y: 152 },
    "return:done": { x: 520, y: 150 },
  },
  reroutes: [],
};

describe("GraphCanvas", () => {
  beforeEach(() => {
    readStoredGraphLayoutMock.mockReset();
    writeStoredGraphLayoutMock.mockReset();
    readStoredGraphLayoutMock.mockResolvedValue({ nodes: {}, reroutes: [] });
    writeStoredGraphLayoutMock.mockResolvedValue(undefined);
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
        inspectorOpen={false}
        onSelectNode={vi.fn()}
        onActivateNode={vi.fn()}
        onInspectNode={vi.fn()}
        onSelectBreadcrumb={vi.fn()}
        onSelectLevel={vi.fn()}
        onToggleGraphFilter={vi.fn()}
        onToggleGraphSetting={vi.fn()}
        onToggleGraphPathHighlight={vi.fn()}
        onToggleEdgeLabels={vi.fn()}
        onToggleInspector={vi.fn()}
        onNavigateOut={vi.fn()}
        onClearSelection={vi.fn()}
      />,
    );

    expect(await screen.findByRole("region", { name: /Graph canvas/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Controls" }));
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
        inspectorOpen={false}
        onSelectNode={vi.fn()}
        onActivateNode={vi.fn()}
        onInspectNode={vi.fn()}
        onSelectBreadcrumb={vi.fn()}
        onSelectLevel={vi.fn()}
        onToggleGraphFilter={vi.fn()}
        onToggleGraphSetting={vi.fn()}
        onToggleGraphPathHighlight={vi.fn()}
        onToggleEdgeLabels={vi.fn()}
        onToggleInspector={vi.fn()}
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
        inspectorOpen={false}
        onSelectNode={vi.fn()}
        onActivateNode={vi.fn()}
        onInspectNode={vi.fn()}
        onSelectBreadcrumb={vi.fn()}
        onSelectLevel={vi.fn()}
        onToggleGraphFilter={vi.fn()}
        onToggleGraphSetting={vi.fn()}
        onToggleGraphPathHighlight={vi.fn()}
        onToggleEdgeLabels={vi.fn()}
        onToggleInspector={vi.fn()}
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
            inspectorOpen={false}
            onSelectNode={vi.fn()}
            onActivateNode={vi.fn()}
            onInspectNode={vi.fn()}
            onSelectBreadcrumb={vi.fn()}
            onSelectLevel={vi.fn()}
            onToggleGraphFilter={vi.fn()}
            onToggleGraphSetting={vi.fn()}
            onToggleGraphPathHighlight={vi.fn()}
            onToggleEdgeLabels={vi.fn()}
            onToggleInspector={vi.fn()}
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
        inspectorOpen={false}
        onSelectNode={vi.fn()}
        onActivateNode={vi.fn()}
        onInspectNode={vi.fn()}
        onSelectBreadcrumb={vi.fn()}
        onSelectLevel={vi.fn()}
        onToggleGraphFilter={vi.fn()}
        onToggleGraphSetting={vi.fn()}
        onToggleGraphPathHighlight={vi.fn()}
        onToggleEdgeLabels={vi.fn()}
        onToggleInspector={vi.fn()}
        onNavigateOut={vi.fn()}
        onClearSelection={vi.fn()}
      />,
    );

    expect(await screen.findByTestId("rf__node-reroute:reroute-1")).toBeInTheDocument();
    expect(writeStoredGraphLayoutMock).not.toHaveBeenCalled();
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
        inspectorOpen={false}
        onSelectNode={vi.fn()}
        onActivateNode={vi.fn()}
        onInspectNode={vi.fn()}
        onSelectBreadcrumb={vi.fn()}
        onSelectLevel={vi.fn()}
        onToggleGraphFilter={vi.fn()}
        onToggleGraphSetting={vi.fn()}
        onToggleGraphPathHighlight={vi.fn()}
        onToggleEdgeLabels={vi.fn()}
        onToggleInspector={vi.fn()}
        onNavigateOut={vi.fn()}
        onClearSelection={onClearSelection}
      />,
    );

    const pane = document.querySelector(".react-flow__pane");
    expect(pane).not.toBeNull();
    await user.click(pane as HTMLElement);

    expect(onClearSelection).toHaveBeenCalledTimes(1);
  });
});
