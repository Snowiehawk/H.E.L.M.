import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppProviders } from "../app/AppProviders";
import { buildRepoSession, defaultRepoPath, mockBackendStatus } from "../lib/mocks/mockData";
import { MockDesktopAdapter } from "../lib/adapter/mockDesktopAdapter";
import type {
  BackendStatus,
  GraphAbstractionLevel,
  SourceRange,
  WorkspaceSyncEvent,
} from "../lib/adapter";
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
    return "Watching the active repo for Python changes.";
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
  override async applyStructuralEdit(...args: Parameters<MockDesktopAdapter["applyStructuralEdit"]>) {
    const [request] = args;
    if (request.kind === "replace_flow_graph") {
      throw new Error("Mock flow save failed.");
    }
    return super.applyStructuralEdit(...args);
  }
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

  it("keeps sync progress inline and defers heavy refreshes until sync completes", async () => {
    const adapter = new SyncAwareMockDesktopAdapter();
    const router = createMemoryRouter(
      [{ path: "/workspace", element: <WorkspaceScreen /> }],
      { initialEntries: ["/workspace"] },
    );

    render(
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
        message: "Watching the active repo for Python changes.",
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

  it("creates a disconnected flow node in the local draft and keeps it through composer and selection changes", async () => {
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
    const flowGraphPanel = await screen.findByRole("region", { name: /Graph canvas/i });
    const flowGraph = within(flowGraphPanel);
    expect(await screen.findByRole("heading", { name: /Internal flow/i })).toBeInTheDocument();
    expect((await flowGraph.findAllByText(/module_summaries/i)).length).toBeGreaterThan(0);

    (flowGraphPanel as HTMLElement).focus();
    fireEvent.keyDown(flowGraphPanel as HTMLElement, { key: "c" });
    expect(await screen.findByTestId("graph-create-mode-badge")).toBeInTheDocument();
    expect(screen.getByTestId("graph-create-mode-hint")).toHaveTextContent(
      "Click the graph to add a disconnected node, or click an insertion lane to place one on that control-flow path.",
    );
    await waitFor(() =>
      expect((flowGraphPanel as HTMLElement).querySelector(".react-flow__pane")).not.toBeNull(),
    );
    const graphPane = (flowGraphPanel as HTMLElement).querySelector(".react-flow__pane");
    expect(graphPane).not.toBeNull();

    await user.click(graphPane as HTMLElement);

    expect(await screen.findByRole("heading", { name: /Create flow node/i })).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: /Flow statement/i }), "helper = rank_modules(graph)");
    await user.click(screen.getByRole("button", { name: /Create node/i }));

    expect((await screen.findAllByText(/rank_modules/i)).length).toBeGreaterThan(0);
    expect(useUiStore.getState().activeLevel).toBe("flow");
    expect(useUiStore.getState().activeNodeId).toMatch(
      /^flowdoc:symbol:helm\.ui\.api:build_graph_summary:assign:/,
    );

    fireEvent.click(
      await flowGraph.findByTestId("rf__node-flow:symbol:helm.ui.api:build_graph_summary:assign:modules"),
    );
    expect((await screen.findAllByText(/rank_modules/i)).length).toBeGreaterThan(0);

    await user.click(graphPane as HTMLElement);
    expect(await screen.findByRole("heading", { name: /Create flow node/i })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: /Create flow node/i })).not.toBeInTheDocument();
    });
    expect((await screen.findAllByText(/rank_modules/i)).length).toBeGreaterThan(0);
    expect(screen.getByTestId("graph-create-mode-badge")).toBeInTheDocument();
  }, WORKSPACE_TEST_TIMEOUT_MS);

  it("keeps a draft-backed disconnected flow node visible across a same-symbol refetch", async () => {
    const user = userEvent.setup();
    const adapter = new SyncAwareMockDesktopAdapter();
    const flowViewSpy = vi.spyOn(adapter, "getFlowView");
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
    await user.click(await screen.findByRole("button", { name: /Open flow/i }));
    await waitFor(() => expect(flowViewSpy).toHaveBeenCalled());

    const flowGraphPanel = await screen.findByRole("region", { name: /Graph canvas/i });
    (flowGraphPanel as HTMLElement).focus();
    fireEvent.keyDown(flowGraphPanel as HTMLElement, { key: "c" });
    await waitFor(() =>
      expect(screen.getByTestId("graph-create-mode-hint")).toHaveTextContent(
        "Click the graph to add a disconnected node, or click an insertion lane to place one on that control-flow path.",
      ),
    );
    await waitFor(() =>
      expect((flowGraphPanel as HTMLElement).querySelector(".react-flow__pane")).not.toBeNull(),
    );
    const graphPane = (flowGraphPanel as HTMLElement).querySelector(".react-flow__pane");
    expect(graphPane).not.toBeNull();
    await user.click(graphPane as HTMLElement);
    await user.type(screen.getByRole("textbox", { name: /Flow statement/i }), "helper = rank_modules(graph)");
    await user.click(screen.getByRole("button", { name: /Create node/i }));
    await screen.findAllByText(/rank_modules/i);

    const localNodeId = useUiStore.getState().activeNodeId;
    expect(localNodeId).toMatch(/^flowdoc:symbol:helm\.ui\.api:build_graph_summary:assign:/);
    const initialFlowViewCalls = flowViewSpy.mock.calls.length;

    act(() => {
      adapter.emitWorkspaceSync({
        repoPath: defaultRepoPath,
        sessionVersion: 4,
        reason: "refresh",
        status: "synced",
        changedRelativePaths: [],
        needsManualResync: false,
        message: "Watching the active repo for Python changes.",
        snapshot: {
          repoId: buildRepoSession().id,
          defaultFocusNodeId: "symbol:helm.ui.api:build_graph_summary",
          defaultLevel: "flow",
          nodeIds: ["symbol:helm.ui.api:build_graph_summary", localNodeId ?? ""],
        },
      });
    });

    await waitFor(() => expect(flowViewSpy.mock.calls.length).toBeGreaterThan(initialFlowViewCalls));
    expect((await screen.findAllByText(/rank_modules/i)).length).toBeGreaterThan(0);
    expect(useUiStore.getState().activeNodeId).toBe(localNodeId);
  }, WORKSPACE_TEST_TIMEOUT_MS);

  it("routes lane insertion through replace_flow_graph when a draft document is available", async () => {
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
    const adapter = new MockDesktopAdapter();
    const editSpy = vi.spyOn(adapter, "applyStructuralEdit");
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
    await user.click(await screen.findByRole("button", { name: /Open flow/i }));

    const flowGraphPanel = await screen.findByRole("region", { name: /Graph canvas/i });
    (flowGraphPanel as HTMLElement).focus();
    fireEvent.keyDown(flowGraphPanel as HTMLElement, { key: "c" });
    await waitFor(() =>
      expect(screen.getByTestId("graph-create-mode-hint")).toHaveTextContent(
        "Click the graph to add a disconnected node, or click an insertion lane to place one on that control-flow path.",
      ),
    );

    const insertLane = await screen.findByTestId(
      "graph-edge:controls:flow:symbol:helm.ui.api:build_graph_summary:entry:start->flow:symbol:helm.ui.api:build_graph_summary:assign:modules:in",
    );
    expect(insertLane).toHaveTextContent("+First step");

    await user.click(insertLane);

    expect(await screen.findByRole("heading", { name: /Create flow node/i })).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: /Flow statement/i }), "helper = rank_modules(graph)");
    await user.click(screen.getByRole("button", { name: /Create node/i }));

    await waitFor(() =>
      expect(editSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "replace_flow_graph",
          targetId: "symbol:helm.ui.api:build_graph_summary",
        }),
      ),
    );
    expect((await screen.findAllByText(/rank_modules/i)).length).toBeGreaterThan(0);
    expect(useUiStore.getState().activeLevel).toBe("flow");
    expect(useUiStore.getState().activeNodeId).toMatch(
      /^flowdoc:symbol:helm\.ui\.api:build_graph_summary:assign:/,
    );
    expect(screen.getByTestId("graph-create-mode-badge")).toBeInTheDocument();
  }, WORKSPACE_TEST_TIMEOUT_MS);

  it("keeps a failed flow draft save visible and recoverable", async () => {
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

    const flowGraphPanel = await screen.findByRole("region", { name: /Graph canvas/i });
    (flowGraphPanel as HTMLElement).focus();
    fireEvent.keyDown(flowGraphPanel as HTMLElement, { key: "c" });
    await waitFor(() =>
      expect(screen.getByTestId("graph-create-mode-hint")).toHaveTextContent(
        "Click the graph to add a disconnected node, or click an insertion lane to place one on that control-flow path.",
      ),
    );
    await waitFor(() =>
      expect((flowGraphPanel as HTMLElement).querySelector(".react-flow__pane")).not.toBeNull(),
    );
    const graphPane = (flowGraphPanel as HTMLElement).querySelector(".react-flow__pane");
    expect(graphPane).not.toBeNull();
    await user.click(graphPane as HTMLElement);

    await user.type(screen.getByRole("textbox", { name: /Flow statement/i }), "helper = rank_modules(graph)");
    await user.click(screen.getByRole("button", { name: /Create node/i }));

    expect(await screen.findByText("Mock flow save failed.")).toBeInTheDocument();
    expect((await screen.findAllByText(/rank_modules/i)).length).toBeGreaterThan(0);
    expect(useUiStore.getState().activeNodeId).toMatch(
      /^flowdoc:symbol:helm\.ui\.api:build_graph_summary:assign:/,
    );
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

    expect(await screen.findByText(/Declaration editor/i)).toBeInTheDocument();
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
    expect((await graph.findAllByText(/self/i)).length).toBeGreaterThan(0);
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
    expect(
      (screen.getByRole("textbox", { name: /Class source editor/i }) as HTMLTextAreaElement).value,
    ).toContain("class GraphSummary");
    expect(screen.getByTestId("inspector-inline-editor")).toHaveAttribute("data-highlight-start-line", "11");
    expect(screen.getByTestId("inspector-inline-editor")).toHaveAttribute("data-highlight-end-line", "15");
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
    expect(screen.getByTestId("inspector-revealed-source")).toHaveAttribute("data-read-only", "true");
  });

  it("shows backend-disabled reasons for structural symbol actions in the expanded inspector", async () => {
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

    fireEvent.change(await screen.findByRole("textbox", { name: /New symbol name/i }), {
      target: { value: "build_graph_projection" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Rename symbol/i }));

    await waitFor(() => {
      expect(useUiStore.getState().activeLevel).toBe("symbol");
      expect(useUiStore.getState().activeNodeId).toBe("symbol:helm.ui.api:build_graph_projection");
    }, { timeout: 4000 });
    expect(openRepoSpy).not.toHaveBeenCalled();
    expect(await screen.findByRole("heading", { name: "build_graph_projection" })).toBeInTheDocument();
  });

  it("deletes a created symbol through the inspector and falls back to the containing module", async () => {
    const adapter = new MockDesktopAdapter();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    await seedMockFunctionSymbol(adapter, "build_issue_cleanup");
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

    const functionNode = (await graph.findByText("build_issue_cleanup")).closest(".graph-node");
    expect(functionNode).not.toBeNull();
    fireEvent.click(within(functionNode as HTMLElement).getByText("Inspect"));
    fireEvent.click(await screen.findByRole("button", { name: /Delete symbol/i }));

    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalled();
      expect(useUiStore.getState().activeLevel).toBe("module");
      expect(useUiStore.getState().activeNodeId).toBe("module:helm.ui.api");
    }, { timeout: 4000 });
    expect(screen.queryByRole("heading", { name: "build_issue_cleanup" })).not.toBeInTheDocument();
  });

  it("moves a created symbol through the inspector and focuses the destination module", async () => {
    const adapter = new MockDesktopAdapter();
    await seedMockFunctionSymbol(adapter, "build_issue_moved");
    await seedMockModule(adapter, "pkg/plan_target.py");
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

    const functionNode = (await graph.findByText("build_issue_moved")).closest(".graph-node");
    expect(functionNode).not.toBeNull();
    fireEvent.click(within(functionNode as HTMLElement).getByText("Inspect"));

    fireEvent.change(await screen.findByRole("combobox", { name: /Destination module/i }), {
      target: { value: "pkg/plan_target.py" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Move symbol/i }));

    await waitFor(() => {
      expect(useUiStore.getState().activeLevel).toBe("module");
      expect(useUiStore.getState().activeNodeId).toBe("module:pkg.plan_target");
    }, { timeout: 4000 });
    expect(await screen.findByText("build_issue_moved")).toBeInTheDocument();
  });

  it("adds an import through the module inspector", async () => {
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
