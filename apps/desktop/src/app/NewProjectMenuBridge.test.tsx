import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { NewProjectMenuBridge } from "./NewProjectMenuBridge";
import { AdapterProvider } from "../lib/adapter";
import { MockDesktopAdapter } from "../lib/adapter/mockDesktopAdapter";
import { IndexingScreen } from "../routes/IndexingScreen";
import { useUiStore } from "../store/uiStore";
import { useUndoStore } from "../store/undoStore";

const menuCallbacks = vi.hoisted(() => ({
  callbacks: [] as Array<(event: { payload: { action?: string } }) => void>,
}));
const { listenMock } = vi.hoisted(() => ({
  listenMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}));

function resetStores() {
  const current = useUiStore.getState();
  useUndoStore.getState().resetSession(undefined);
  useUiStore.setState({
    ...current,
    preferencesOpen: false,
    paletteOpen: false,
    sidebarQuery: "",
    activeTab: "graph",
    repoSession: undefined,
    activeFilePath: undefined,
    activeSymbolId: undefined,
    activeNodeId: undefined,
    graphTargetId: undefined,
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
    flowInputDisplayMode: "param_nodes",
    highlightGraphPath: true,
    showEdgeLabels: true,
    revealedSource: undefined,
    lastEdit: undefined,
    lastActivity: undefined,
  });
}

describe("NewProjectMenuBridge", () => {
  beforeEach(() => {
    resetStores();
    menuCallbacks.callbacks = [];
    listenMock.mockReset();
    listenMock.mockImplementation(async (_eventName, callback) => {
      menuCallbacks.callbacks.push(callback);
      return vi.fn();
    });
  });

  afterEach(() => {
    resetStores();
  });

  it("creates and indexes a project from the native menu action", async () => {
    render(
      <AdapterProvider adapter={new MockDesktopAdapter()}>
        <MemoryRouter initialEntries={["/workspace"]}>
          <NewProjectMenuBridge enabled />
          <Routes>
            <Route path="/workspace" element={<div>Workspace</div>} />
            <Route path="/indexing/:jobId" element={<IndexingScreen />} />
          </Routes>
        </MemoryRouter>
      </AdapterProvider>,
    );

    await waitFor(() => expect(menuCallbacks.callbacks).toHaveLength(1));

    await act(async () => {
      menuCallbacks.callbacks[0]?.({ payload: { action: "new-project" } });
      await Promise.resolve();
    });

    expect(await screen.findByText(/Preparing the workspace/i)).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "untitled-helm-project" })).toBeInTheDocument();
  });
});
