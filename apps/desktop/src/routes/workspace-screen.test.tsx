import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { AppProviders } from "../app/AppProviders";
import { buildRepoSession } from "../lib/mocks/mockData";
import { MockDesktopAdapter } from "../lib/adapter/mockDesktopAdapter";
import { useUiStore } from "../store/uiStore";
import { WorkspaceScreen } from "./WorkspaceScreen";

function resetStore() {
  const current = useUiStore.getState();
  const repoSession = buildRepoSession();
  useUiStore.setState({
    ...current,
    theme: "system",
    paletteOpen: false,
    sidebarQuery: "",
    activeTab: "graph",
    repoSession,
    activeFilePath: undefined,
    activeSymbolId: undefined,
    activeNodeId: repoSession.id,
    graphDepth: 1,
    graphFilters: {
      includeImports: true,
      includeCalls: true,
      includeDefines: true,
    },
    highlightGraphPath: true,
  });
}

describe("WorkspaceScreen", () => {
  beforeEach(() => {
    resetStore();
  });

  it("opens into a graph-first workspace and can focus a file from the explorer", async () => {
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

    expect(await screen.findByText(/Node-based workspace/i)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /^api\.py$/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^api\.py$/i }));

    expect(await screen.findByText("src/helm/ui/api.py")).toBeInTheDocument();
    expect(await screen.findByText(/human-readable and json-ready views/i)).toBeInTheDocument();
  });
});
