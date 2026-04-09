import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { MockDesktopAdapter } from "../lib/adapter/mockDesktopAdapter";
import { useUiStore } from "../store/uiStore";
import { AppProviders } from "./AppProviders";

function clearLocalStorage() {
  if (typeof window.localStorage?.clear === "function") {
    window.localStorage.clear();
  }
}

function resetStore() {
  const current = useUiStore.getState();
  clearLocalStorage();
  useUiStore.setState({
    ...current,
    theme: "system",
    uiScale: 1,
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
    highlightGraphPath: true,
    showEdgeLabels: true,
    revealedSource: undefined,
    lastEdit: undefined,
  });
}

describe("AppProviders", () => {
  beforeEach(() => {
    resetStore();
  });

  it("applies app-level UI scale shortcuts", () => {
    render(
      <AppProviders adapter={new MockDesktopAdapter()}>
        <div>Scale target</div>
      </AppProviders>,
    );

    const scaleShell = document.querySelector(".app-scale-shell");
    expect(scaleShell).not.toBeNull();
    expect(screen.getByText("Scale target")).toBeInTheDocument();
    expect(useUiStore.getState().uiScale).toBe(1);

    fireEvent.keyDown(window, { key: "=", ctrlKey: true });
    expect(useUiStore.getState().uiScale).toBe(1.1);
    expect((scaleShell as HTMLElement).style.getPropertyValue("--app-ui-scale")).toBe("1.1");

    fireEvent.keyDown(window, { key: "-", ctrlKey: true });
    expect(useUiStore.getState().uiScale).toBe(1);
    expect((scaleShell as HTMLElement).style.getPropertyValue("--app-ui-scale")).toBe("1");

    fireEvent.keyDown(window, { key: "0", ctrlKey: true });
    expect(useUiStore.getState().uiScale).toBe(1);
  });
});
