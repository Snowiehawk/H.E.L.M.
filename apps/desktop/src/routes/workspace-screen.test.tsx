import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppProviders } from "../app/AppProviders";
import { buildRepoSession } from "../lib/mocks/mockData";
import { MockDesktopAdapter } from "../lib/adapter/mockDesktopAdapter";
import { useUiStore } from "../store/uiStore";
import { WorkspaceScreen } from "./WorkspaceScreen";

const WORKSPACE_TEST_TIMEOUT_MS = 15000;

vi.mock("../components/editor/InspectorCodeSurface", () => ({
  InspectorCodeSurface: ({
    ariaLabel,
    className,
    dataTestId,
    onChange,
    readOnly,
    value,
  }: {
    ariaLabel: string;
    className?: string;
    dataTestId?: string;
    onChange?: (value: string) => void;
    readOnly: boolean;
    value: string;
  }) =>
    readOnly ? (
      <div className={className} data-read-only="true" data-testid={dataTestId}>
        <pre aria-label={ariaLabel}>{value}</pre>
      </div>
    ) : (
      <div className={className} data-read-only="false" data-testid={dataTestId}>
        <textarea
          aria-label={ariaLabel}
          spellCheck={false}
          value={value}
          onChange={(event) => onChange?.(event.target.value)}
        />
      </div>
    ),
}));

function clearLocalStorage() {
  if (typeof window.localStorage?.clear === "function") {
    window.localStorage.clear();
  }
}

function resetStore() {
  const current = useUiStore.getState();
  const repoSession = buildRepoSession();
  clearLocalStorage();
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
  });
}

describe("WorkspaceScreen", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetStore();
  });

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

    await waitFor(() =>
      expect(within(screen.getByRole("navigation", { name: /Graph path/i })).getByText("api.py")).toBeInTheDocument(),
    );

    const functionNode = (await graph.findByText("build_graph_summary")).closest(".graph-node");
    expect(functionNode).not.toBeNull();
    fireEvent.click(within(functionNode as HTMLElement).getByText("Inspect"));

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

    await waitFor(() =>
      expect(screen.queryByText(/Declaration editor/i)).not.toBeInTheDocument(),
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

    await user.click(screen.getByRole("button", { name: /Close/i }));
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

    expect(await screen.findByText("Unsaved")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save/i })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));

    expect(await screen.findByText("Synced")).toBeInTheDocument();
    expect(await screen.findByRole("textbox", { name: /Function source editor/i })).toHaveValue(originalValue);

    fireEvent.change(await screen.findByRole("textbox", { name: /Function source editor/i }), {
      target: { value: `${originalValue}\n# saved note` },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save/i }));

    await waitFor(() => expect(saveSpy).toHaveBeenCalledTimes(1));
    expect(saveSpy.mock.calls[0]?.[1]).toContain("# saved note");
    await waitFor(() => expect(screen.getByText("Synced")).toBeInTheDocument());
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

    await user.click(screen.getByRole("button", { name: /Close/i }));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(saveSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText(/Declaration editor/i)).not.toBeInTheDocument());
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

    await user.click(screen.getByRole("button", { name: /Close/i }));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText(/Declaration editor/i)).not.toBeInTheDocument());
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
