import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppProviders } from "../app/AppProviders";
import { buildRepoSession, defaultRepoPath } from "../lib/mocks/mockData";
import { MockDesktopAdapter } from "../lib/adapter/mockDesktopAdapter";
import type { GraphAbstractionLevel, SourceRange } from "../lib/adapter";
import { useUiStore } from "../store/uiStore";
import { useUndoStore } from "../store/undoStore";
import { WorkspaceScreen } from "./WorkspaceScreen";

const WORKSPACE_TEST_TIMEOUT_MS = 15000;
const EMPTY_STORED_GRAPH_LAYOUT = {
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
      memberNodeIds: [
        "symbol:helm.ui.api:build_graph_summary",
        "symbol:helm.ui.api:GraphSummary",
      ],
    },
  ],
};

const { readStoredGraphLayoutMock, writeStoredGraphLayoutMock } = vi.hoisted(() => ({
  readStoredGraphLayoutMock: vi.fn(),
  writeStoredGraphLayoutMock: vi.fn(),
}));

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
  const actual = await vi.importActual<typeof import("../components/graph/graphLayoutPersistence")>("../components/graph/graphLayoutPersistence");
  return {
    ...actual,
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

describe("WorkspaceScreen", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetStore();
    readStoredGraphLayoutMock.mockReset();
    writeStoredGraphLayoutMock.mockReset();
    readStoredGraphLayoutMock.mockResolvedValue(EMPTY_STORED_GRAPH_LAYOUT);
    writeStoredGraphLayoutMock.mockResolvedValue(undefined);
  });

  it("resizes the explorer panel and restores the saved width", async () => {
    const router = createMemoryRouter(
      [{ path: "/workspace", element: <WorkspaceScreen /> }],
      { initialEntries: ["/workspace"] },
    );

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
  }, WORKSPACE_TEST_TIMEOUT_MS);

  it("keeps single click selection-only and uses explicit enter/inspect actions", async () => {
    const user = userEvent.setup();
    const router = createMemoryRouter(
      [{ path: "/workspace", element: <WorkspaceScreen /> }],
      { initialEntries: ["/workspace"] },
    );

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
      expect(within(screen.getByRole("navigation", { name: /Graph path/i })).getByText("api.py")).toBeInTheDocument(),
    );

    const functionNode = (await graph.findByText("build_graph_summary")).closest(".graph-node");
    expect(functionNode).not.toBeNull();
    fireEvent.click(within(functionNode as HTMLElement).getByText("Inspect"));

    expect(await screen.findByTestId("blueprint-inspector-drawer")).toHaveAttribute("data-mode", "expanded");
    expect(await screen.findByText(/Declaration editor/i)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Open File In Default Editor/i })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Open flow/i })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Open blueprint/i })).toBeInTheDocument();
    expect(
      (await screen.findByRole("textbox", { name: /Function source editor/i }) as HTMLTextAreaElement).value,
    ).toMatch(/def build_graph_summary/i);

    const graphPane = (graphPanel as HTMLElement).querySelector(".react-flow__pane");
    expect(graphPane).not.toBeNull();
    await user.click(graphPane as HTMLElement);

    const expandedDrawer = await screen.findByTestId("blueprint-inspector-drawer");
    expect(expandedDrawer).toHaveAttribute("data-mode", "expanded");
    expect(within(expandedDrawer).getByRole("heading", { name: /Nothing selected/i })).toBeInTheDocument();
    expect(within(expandedDrawer).queryByText(/Declaration editor/i)).not.toBeInTheDocument();
  }, WORKSPACE_TEST_TIMEOUT_MS);

  it("updates the active inspector target when another inspectable node is selected while visible", async () => {
    const router = createMemoryRouter(
      [{ path: "/workspace", element: <WorkspaceScreen /> }],
      { initialEntries: ["/workspace"] },
    );

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
    expect(within(drawer).getByRole("heading", { name: "build_graph_summary" })).toBeInTheDocument();

    fireEvent.click(await graph.findByText("GraphSummary"));

    await waitFor(() =>
      expect(within(screen.getByTestId("blueprint-inspector-drawer")).getByRole("heading", { name: "GraphSummary" })).toBeInTheDocument(),
    );
  });

  it("updates the inspector when a grouped inspectable node is selected", async () => {
    readStoredGraphLayoutMock
      .mockResolvedValueOnce(EMPTY_STORED_GRAPH_LAYOUT)
      .mockResolvedValueOnce(GROUPED_SYMBOL_LAYOUT);

    const router = createMemoryRouter(
      [{ path: "/workspace", element: <WorkspaceScreen /> }],
      { initialEntries: ["/workspace"] },
    );

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
    expect(within(drawer).getByRole("heading", { name: "build_graph_summary" })).toBeInTheDocument();

    fireEvent.click(await graph.findByText("GraphSummary"), { ctrlKey: true });

    await waitFor(() =>
      expect(within(screen.getByTestId("blueprint-inspector-drawer")).getByRole("heading", { name: "GraphSummary" })).toBeInTheDocument(),
    );

    fireEvent.click(await graph.findByText("build_graph_summary"));

    await waitFor(() =>
      expect(within(screen.getByTestId("blueprint-inspector-drawer")).getByRole("heading", { name: "build_graph_summary" })).toBeInTheDocument(),
    );
  });

  it("shows a collapsed peek rail for the current inspectable selection before full inspect", async () => {
    const router = createMemoryRouter(
      [{ path: "/workspace", element: <WorkspaceScreen /> }],
      { initialEntries: ["/workspace"] },
    );

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
    expect(within(drawer).getByRole("button", { name: /Open File In Default Editor/i })).toBeInTheDocument();
    expect(within(drawer).getByRole("button", { name: /Open flow/i })).toBeInTheDocument();
    expect(within(drawer).getByRole("button", { name: /Open blueprint/i })).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("blueprint-inspector-drawer-toggle"));
    expect(await screen.findByTestId("blueprint-inspector-drawer")).toHaveAttribute("data-mode", "expanded");
    expect(await screen.findByText(/Declaration editor/i)).toBeInTheDocument();
  });

  it("enters create mode from the graph, clears sticky inspector selection, and shows the mode chrome", async () => {
    const user = userEvent.setup();
    const router = createMemoryRouter(
      [{ path: "/workspace", element: <WorkspaceScreen /> }],
      { initialEntries: ["/workspace"] },
    );

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
    expect(await screen.findByRole("heading", { name: "build_graph_summary" })).toBeInTheDocument();

    (graphPanel as HTMLElement).focus();
    fireEvent.keyDown(graphPanel as HTMLElement, { key: "c" });

    expect(await screen.findByTestId("graph-create-mode-badge")).toHaveTextContent(/Create mode/i);
    expect(screen.getByTestId("graph-create-mode-watermark")).toHaveTextContent("CREATE MODE");
    expect(screen.getByText("Click the graph to create a function or class in src/helm/ui/api.py.")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: /Nothing selected/i })).toBeInTheDocument();
    expect(useUiStore.getState().activeNodeId).toBeUndefined();
  }, WORKSPACE_TEST_TIMEOUT_MS);

  it("does not enter create mode while typing in the inspector editor", async () => {
    const router = createMemoryRouter(
      [{ path: "/workspace", element: <WorkspaceScreen /> }],
      { initialEntries: ["/workspace"] },
    );

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
  }, WORKSPACE_TEST_TIMEOUT_MS);

  it("prompts for unsaved changes before entering create mode and saves when confirmed", async () => {
    const adapter = new MockDesktopAdapter();
    const saveSpy = vi.spyOn(adapter, "saveNodeSource");
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const router = createMemoryRouter(
      [{ path: "/workspace", element: <WorkspaceScreen /> }],
      { initialEntries: ["/workspace"] },
    );

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

    fireEvent.change(await screen.findByRole("textbox", { name: /Function source editor/i }), {
      target: { value: "def build_graph_summary(graph):\n    return GraphSummary(repo_path='.', module_count=1)\n" },
    });

    (graphPanel as HTMLElement).focus();
    fireEvent.keyDown(graphPanel as HTMLElement, { key: "c" });

    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalled();
      expect(saveSpy).toHaveBeenCalled();
    });
    expect(await screen.findByTestId("graph-create-mode-badge")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: /Nothing selected/i })).toBeInTheDocument();
  }, WORKSPACE_TEST_TIMEOUT_MS);

  it("prompts for unsaved changes before entering create mode and discards when declined", async () => {
    const adapter = new MockDesktopAdapter();
    const saveSpy = vi.spyOn(adapter, "saveNodeSource");
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const router = createMemoryRouter(
      [{ path: "/workspace", element: <WorkspaceScreen /> }],
      { initialEntries: ["/workspace"] },
    );

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

    fireEvent.change(await screen.findByRole("textbox", { name: /Function source editor/i }), {
      target: { value: "def build_graph_summary(graph):\n    return GraphSummary(repo_path='.', module_count=2)\n" },
    });

    (graphPanel as HTMLElement).focus();
    fireEvent.keyDown(graphPanel as HTMLElement, { key: "c" });

    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalled();
      expect(saveSpy).not.toHaveBeenCalled();
    });
    expect(await screen.findByTestId("graph-create-mode-badge")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: /Nothing selected/i })).toBeInTheDocument();
  }, WORKSPACE_TEST_TIMEOUT_MS);

  it("creates a module from repo view create mode and selects it", async () => {
    const user = userEvent.setup();
    const repoSession = buildRepoSession();
    setGraphFocusForTest({
      targetId: repoSession.id,
      level: "repo",
      activeNodeId: undefined,
      activeSymbolId: undefined,
    });

    const router = createMemoryRouter(
      [{ path: "/workspace", element: <WorkspaceScreen /> }],
      { initialEntries: ["/workspace"] },
    );

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
    expect(await screen.findByText("Click the graph to place a new Python module.")).toBeInTheDocument();

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
  }, WORKSPACE_TEST_TIMEOUT_MS);

  it("creates a function from module view create mode and keeps create mode active", async () => {
    const user = userEvent.setup();
    setGraphFocusForTest({
      targetId: "module:helm.ui.api",
      level: "module",
      activeNodeId: undefined,
      activeSymbolId: undefined,
    });

    const router = createMemoryRouter(
      [{ path: "/workspace", element: <WorkspaceScreen /> }],
      { initialEntries: ["/workspace"] },
    );

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
  }, WORKSPACE_TEST_TIMEOUT_MS);

  it("uses the parent module path when creating a class from symbol view create mode", async () => {
    const user = userEvent.setup();
    const adapter = new MockDesktopAdapter();
    const editSpy = vi.spyOn(adapter, "applyStructuralEdit");
    setGraphFocusForTest({
      targetId: "symbol:helm.ui.api:build_graph_summary",
      level: "symbol",
      activeNodeId: undefined,
      activeSymbolId: "symbol:helm.ui.api:build_graph_summary",
    });

    const router = createMemoryRouter(
      [{ path: "/workspace", element: <WorkspaceScreen /> }],
      { initialEntries: ["/workspace"] },
    );

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
  }, WORKSPACE_TEST_TIMEOUT_MS);

  it("opens the flow composer from a create-mode insertion lane and inserts a flow node on the clicked path", async () => {
    const user = userEvent.setup();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 240,
      bottom: 96,
      width: 240,
      height: 96,
      toJSON: () => ({}),
    }) as DOMRect);
    const router = createMemoryRouter(
      [{ path: "/workspace", element: <WorkspaceScreen /> }],
      { initialEntries: ["/workspace"] },
    );

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
    expect((await graph.findAllByText("module_summaries")).length).toBeGreaterThan(0);

    (graphPanel as HTMLElement).focus();
    fireEvent.keyDown(graphPanel as HTMLElement, { key: "c" });
    expect(await screen.findByTestId("graph-create-mode-badge")).toBeInTheDocument();
    expect(screen.getByTestId("graph-create-mode-hint")).toHaveTextContent(
      "Click an insertion lane to add a node on that control-flow path.",
    );

    const insertLane = await screen.findByTestId(
      "graph-edge:controls:flow:symbol:helm.ui.api:build_graph_summary:entry->flow:symbol:helm.ui.api:build_graph_summary:assign:modules",
    );
    expect(insertLane).toHaveTextContent("+First step");

    await user.click(
      insertLane,
    );

    expect(await screen.findByRole("heading", { name: /Insert flow node/i })).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: /Flow statement/i }), "helper = rank_modules(graph)");
    await user.click(screen.getByRole("button", { name: /Insert node/i }));

    expect((await screen.findAllByText("helper")).length).toBeGreaterThan(0);
    expect(useUiStore.getState().activeLevel).toBe("flow");
    expect(useUiStore.getState().activeNodeId).toBe("flow:symbol:helm.ui.api:build_graph_summary:created:1");
    expect(screen.getByTestId("graph-create-mode-badge")).toBeInTheDocument();
  }, WORKSPACE_TEST_TIMEOUT_MS);

  it("shows create mode as unavailable in class flow and does not open the composer", async () => {
    const user = userEvent.setup();
    const router = createMemoryRouter(
      [{ path: "/workspace", element: <WorkspaceScreen /> }],
      { initialEntries: ["/workspace"] },
    );

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

    expect(await screen.findByText("Create mode only writes inside function or method flows in v1.")).toBeInTheDocument();
    await user.click(graphPane as HTMLElement);
    expect(screen.queryByTestId("graph-create-composer")).not.toBeInTheDocument();
  }, WORKSPACE_TEST_TIMEOUT_MS);

  it("closes the create composer with Escape before exiting create mode", async () => {
    const user = userEvent.setup();
    setGraphFocusForTest({
      targetId: "module:helm.ui.api",
      level: "module",
      activeNodeId: undefined,
      activeSymbolId: undefined,
    });

    const router = createMemoryRouter(
      [{ path: "/workspace", element: <WorkspaceScreen /> }],
      { initialEntries: ["/workspace"] },
    );

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
  }, WORKSPACE_TEST_TIMEOUT_MS);

  it("navigates one layer out with Backspace from flow to symbol", async () => {
    const user = userEvent.setup();
    const router = createMemoryRouter(
      [{ path: "/workspace", element: <WorkspaceScreen /> }],
      { initialEntries: ["/workspace"] },
    );

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

    await waitFor(() =>
      expect(screen.getByText(/Symbol blueprint/i)).toBeInTheDocument(),
    );
    expect(
      within(screen.getByRole("navigation", { name: /Graph path/i })).queryByText("Flow"),
    ).not.toBeInTheDocument();
  }, WORKSPACE_TEST_TIMEOUT_MS);

  it("treats class nodes as both inspectable and enterable", async () => {
    const user = userEvent.setup();
    const router = createMemoryRouter(
      [{ path: "/workspace", element: <WorkspaceScreen /> }],
      { initialEntries: ["/workspace"] },
    );

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

    expect(await screen.findByRole("button", { name: /Open File In Default Editor/i })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Open flow/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Open blueprint/i })).not.toBeInTheDocument();

    await user.click(screen.getByTestId("blueprint-inspector-panel-collapse"));
    expect(await screen.findByTestId("blueprint-inspector-drawer")).toHaveAttribute("data-mode", "collapsed");
    fireEvent.click(within(classNode as HTMLElement).getByText("Enter"));

    expect(await screen.findByText(/Symbol blueprint/i)).toBeInTheDocument();
    expect(await screen.findByText("repo_path")).toBeInTheDocument();
    expect(await screen.findByText("module_count")).toBeInTheDocument();
    expect(await screen.findByText("to_payload")).toBeInTheDocument();
  });

  it("opens class flow and lets nested methods drill into their own flow", async () => {
    const user = userEvent.setup();
    const router = createMemoryRouter(
      [{ path: "/workspace", element: <WorkspaceScreen /> }],
      { initialEntries: ["/workspace"] },
    );

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
    expect((await graph.findAllByText("self")).length).toBeGreaterThan(0);
  });

  it("keeps the flow owner source in the inspector and highlights the selected class-flow member", async () => {
    const router = createMemoryRouter(
      [{ path: "/workspace", element: <WorkspaceScreen /> }],
      { initialEntries: ["/workspace"] },
    );

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
    expect(within(drawer).getByRole("heading", { name: "GraphSummary" })).toBeInTheDocument();
    expect(screen.getByLabelText(/Read-only class source/i)).toHaveTextContent("class GraphSummary");
    expect(screen.getByTestId("inspector-readonly-source")).toHaveAttribute("data-highlight-start-line", "11");
    expect(screen.getByTestId("inspector-readonly-source")).toHaveAttribute("data-highlight-end-line", "15");
  });

  it("navigates one layer out with Backspace from class flow to class blueprint", async () => {
    const user = userEvent.setup();
    const router = createMemoryRouter(
      [{ path: "/workspace", element: <WorkspaceScreen /> }],
      { initialEntries: ["/workspace"] },
    );

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

    await waitFor(() =>
      expect(screen.getByText(/Symbol blueprint/i)).toBeInTheDocument(),
    );
    expect(await graph.findByText("to_payload")).toBeInTheDocument();
  });

  it("reveals the current graph file from the graph path", async () => {
    const user = userEvent.setup();
    const adapter = new MockDesktopAdapter();
    const revealSpy = vi
      .spyOn(adapter, "revealNodeInFileExplorer")
      .mockResolvedValue(undefined);
    const router = createMemoryRouter(
      [{ path: "/workspace", element: <WorkspaceScreen /> }],
      { initialEntries: ["/workspace"] },
    );

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

    await waitFor(() => expect(revealSpy).toHaveBeenCalledWith("module:helm.ui.api"));
  });

  it("tracks inline edits, supports cancel, and saves through the existing callback", async () => {
    const adapter = new MockDesktopAdapter();
    const saveSpy = vi.spyOn(adapter, "saveNodeSource");
    const router = createMemoryRouter(
      [{ path: "/workspace", element: <WorkspaceScreen /> }],
      { initialEntries: ["/workspace"] },
    );

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
    expect(await screen.findByTestId("blueprint-inspector-drawer")).toHaveAttribute("data-mode", "collapsed");
    expect(screen.queryByRole("textbox", { name: /Function source editor/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("blueprint-inspector-drawer-toggle"));
    expect(await screen.findByTestId("blueprint-inspector-drawer")).toHaveAttribute("data-mode", "expanded");
    expect(await screen.findByRole("textbox", { name: /Function source editor/i })).toHaveValue(unsavedValue);
    expect(screen.getAllByText("Unsaved").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));

    expect((await screen.findAllByText("Synced")).length).toBeGreaterThan(0);
    expect(await screen.findByRole("textbox", { name: /Function source editor/i })).toHaveValue(originalValue);

    fireEvent.change(await screen.findByRole("textbox", { name: /Function source editor/i }), {
      target: { value: `${originalValue}\n# saved note` },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save/i }));

    await waitFor(() => expect(saveSpy).toHaveBeenCalledTimes(1));
    expect(saveSpy.mock.calls[0]?.[1]).toContain("# saved note");
    await waitFor(() => expect(screen.getAllByText("Synced").length).toBeGreaterThan(0));
  });

  it("marks dirty inspector drafts stale after same-file live sync events", async () => {
    const adapter = new MockDesktopAdapter();
    const router = createMemoryRouter(
      [{ path: "/workspace", element: <WorkspaceScreen /> }],
      { initialEntries: ["/workspace"] },
    );

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
    const router = createMemoryRouter(
      [{ path: "/workspace", element: <WorkspaceScreen /> }],
      { initialEntries: ["/workspace"] },
    );

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
      expect(screen.getByRole("textbox", { name: /Function source editor/i })).toHaveValue(originalValue),
    );
    expect(screen.getByText("Latest Activity")).toBeInTheDocument();
    expect(screen.getByText("backend")).toBeInTheDocument();
    expect(screen.getByText(/Undid:/i)).toBeInTheDocument();
  });

  it("toggles the inspector drawer with a Space tap outside text editing surfaces", async () => {
    const router = createMemoryRouter(
      [{ path: "/workspace", element: <WorkspaceScreen /> }],
      { initialEntries: ["/workspace"] },
    );

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

    expect(await screen.findByTestId("blueprint-inspector-drawer")).toHaveAttribute("data-mode", "expanded");

    fireEvent.keyDown(workspace as HTMLElement, { code: "Space", key: " " });
    fireEvent.keyUp(workspace as HTMLElement, { code: "Space", key: " " });
    expect(await screen.findByTestId("blueprint-inspector-drawer")).toHaveAttribute("data-mode", "collapsed");

    fireEvent.keyDown(workspace as HTMLElement, { code: "Space", key: " " });
    fireEvent.keyUp(workspace as HTMLElement, { code: "Space", key: " " });
    expect(await screen.findByTestId("blueprint-inspector-drawer")).toHaveAttribute("data-mode", "expanded");
  });

  it("does not toggle the inspector drawer while typing in the editor", async () => {
    const user = userEvent.setup();
    const router = createMemoryRouter(
      [{ path: "/workspace", element: <WorkspaceScreen /> }],
      { initialEntries: ["/workspace"] },
    );

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

    expect(await screen.findByTestId("blueprint-inspector-drawer")).toHaveAttribute("data-mode", "expanded");
    expect(await screen.findByRole("textbox", { name: /Function source editor/i })).toHaveValue(`${originalValue} `);
  });

  it("keeps non-editable nodes read-only and renders revealed source in a read-only surface", async () => {
    const user = userEvent.setup();
    const router = createMemoryRouter(
      [{ path: "/workspace", element: <WorkspaceScreen /> }],
      { initialEntries: ["/workspace"] },
    );

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

    expect(await screen.findByText(/Code details/i)).toBeInTheDocument();
    expect(screen.queryByTestId("inspector-inline-editor")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Save/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Reveal source/i }));

    expect(await screen.findByText(/Revealed Source/i)).toBeInTheDocument();
    expect(screen.getByTestId("inspector-revealed-source")).toHaveAttribute("data-read-only", "true");
  });

  it("prompts on unsaved close and saves when confirmed", async () => {
    const user = userEvent.setup();
    const adapter = new MockDesktopAdapter();
    const saveSpy = vi.spyOn(adapter, "saveNodeSource");
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const router = createMemoryRouter(
      [{ path: "/workspace", element: <WorkspaceScreen /> }],
      { initialEntries: ["/workspace"] },
    );

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
    expect(await screen.findByTestId("blueprint-inspector-drawer")).toHaveAttribute("data-mode", "collapsed");

    await user.click(screen.getByTestId("blueprint-inspector-drawer-close"));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(saveSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      const drawer = screen.getByTestId("blueprint-inspector-drawer");
      expect(drawer).toHaveAttribute("data-mode", "collapsed");
      expect(within(drawer).getByText("helm.ui.api")).toBeInTheDocument();
      expect(within(drawer).queryByTestId("blueprint-inspector-drawer-close")).not.toBeInTheDocument();
    });
  });

  it("prompts on unsaved close and discards when not confirmed", async () => {
    const user = userEvent.setup();
    const adapter = new MockDesktopAdapter();
    const saveSpy = vi.spyOn(adapter, "saveNodeSource");
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const router = createMemoryRouter(
      [{ path: "/workspace", element: <WorkspaceScreen /> }],
      { initialEntries: ["/workspace"] },
    );

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
    expect(await screen.findByTestId("blueprint-inspector-drawer")).toHaveAttribute("data-mode", "collapsed");

    await user.click(screen.getByTestId("blueprint-inspector-drawer-close"));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy).not.toHaveBeenCalled();
    await waitFor(() => {
      const drawer = screen.getByTestId("blueprint-inspector-drawer");
      expect(drawer).toHaveAttribute("data-mode", "collapsed");
      expect(within(drawer).getByText("helm.ui.api")).toBeInTheDocument();
      expect(within(drawer).queryByTestId("blueprint-inspector-drawer-close")).not.toBeInTheDocument();
    });
  });

  it("updates the footer help box across explorer, graph path, graph nodes, and inspector actions", async () => {
    const user = userEvent.setup();
    const router = createMemoryRouter(
      [{ path: "/workspace", element: <WorkspaceScreen /> }],
      { initialEntries: ["/workspace"] },
    );

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
    expect(help.getByText("api.py in Finder/Explorer")).toBeInTheDocument();

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
    const openInEditor = await screen.findByRole("button", { name: /Open File In Default Editor/i });
    await user.hover(openInEditor);
    expect(help.getByText("Open file in default editor")).toBeInTheDocument();
  });
});
