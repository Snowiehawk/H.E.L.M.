import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppProviders } from "../app/AppProviders";
import { MockDesktopAdapter } from "../lib/adapter/mockDesktopAdapter";
import { useUiStore } from "../store/uiStore";
import { useUndoStore } from "../store/undoStore";
import { IndexingScreen } from "./IndexingScreen";
import { WelcomeScreen } from "./WelcomeScreen";

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

describe("welcome flow", () => {
  beforeEach(() => {
    resetStores();
  });

  afterEach(() => {
    resetStores();
  });

  it("opens a repo and navigates into indexing", async () => {
    const user = userEvent.setup();

    render(
      <AppProviders adapter={new MockDesktopAdapter()}>
        <MemoryRouter initialEntries={["/"]}>
          <Routes>
            <Route path="/" element={<WelcomeScreen />} />
            <Route path="/indexing/:jobId" element={<IndexingScreen />} />
          </Routes>
        </MemoryRouter>
      </AppProviders>,
    );

    await user.click(screen.getByRole("button", { name: /open local repo/i }));

    expect(await screen.findByText(/Preparing the workspace/i)).toBeInTheDocument();
    expect(await screen.findByText(/Discovering Python modules/i)).toBeInTheDocument();
    expect(await screen.findByText(/Job ID/i)).toBeInTheDocument();
  });

  it("creates a new project and navigates into indexing", async () => {
    const user = userEvent.setup();

    render(
      <AppProviders adapter={new MockDesktopAdapter()}>
        <MemoryRouter initialEntries={["/"]}>
          <Routes>
            <Route path="/" element={<WelcomeScreen />} />
            <Route path="/indexing/:jobId" element={<IndexingScreen />} />
          </Routes>
        </MemoryRouter>
      </AppProviders>,
    );

    await user.click(screen.getByRole("button", { name: /new project/i }));

    expect(await screen.findByText(/Preparing the workspace/i)).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "untitled-helm-project" })).toBeInTheDocument();
    expect(await screen.findByText(/Job ID/i)).toBeInTheDocument();
  });
});
