import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { AppProviders } from "../app/AppProviders";
import { MockDesktopAdapter } from "../lib/adapter/mockDesktopAdapter";
import { useUiStore } from "../store/uiStore";
import { CommandPalette } from "./CommandPalette";

function resetStore() {
  const current = useUiStore.getState();
  useUiStore.setState({
    ...current,
    paletteOpen: true,
    sidebarQuery: "",
    activeTab: "graph",
    activeFilePath: undefined,
    activeSymbolId: undefined,
    activeNodeId: undefined,
  });
}

describe("CommandPalette", () => {
  beforeEach(() => {
    resetStore();
  });

  it("opens a symbol result and updates the workspace selection", async () => {
    const user = userEvent.setup();

    render(
      <AppProviders adapter={new MockDesktopAdapter()}>
        <CommandPalette />
      </AppProviders>,
    );

    await user.type(
      screen.getByPlaceholderText(/search files, symbols, or graph anchors/i),
      "summary",
    );
    await user.click(await screen.findByRole("button", { name: /build_graph_summary/i }));

    const state = useUiStore.getState();
    expect(state.activeTab).toBe("symbol");
    expect(state.activeSymbolId).toBe("symbol:helm.ui.api.build_graph_summary");
  });
});
