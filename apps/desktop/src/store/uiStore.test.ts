import { beforeEach, describe, expect, it } from "vitest";
import { useUiStore } from "./uiStore";

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
  });
}

describe("uiStore", () => {
  beforeEach(() => {
    resetStore();
  });

  it("opens a symbol from search results and syncs the graph node selection", () => {
    useUiStore.getState().selectSearchResult({
      id: "symbol:helm.ui.api:build_graph_summary",
      kind: "symbol",
      title: "build_graph_summary",
      subtitle: "helm.ui.api.build_graph_summary",
      score: 1,
      filePath: "src/helm/ui/api.py",
      symbolId: "symbol:helm.ui.api:build_graph_summary",
      nodeId: "symbol:helm.ui.api:build_graph_summary",
    });

    const state = useUiStore.getState();
    expect(state.activeTab).toBe("symbol");
    expect(state.activeSymbolId).toBe("symbol:helm.ui.api:build_graph_summary");
    expect(state.activeNodeId).toBe("symbol:helm.ui.api:build_graph_summary");
  });

  it("expands and collapses graph depth within bounds", () => {
    useUiStore.getState().expandGraphDepth();
    useUiStore.getState().expandGraphDepth();
    useUiStore.getState().expandGraphDepth();
    useUiStore.getState().expandGraphDepth();

    expect(useUiStore.getState().graphDepth).toBe(4);

    useUiStore.getState().reduceGraphDepth();
    useUiStore.getState().reduceGraphDepth();
    useUiStore.getState().reduceGraphDepth();
    useUiStore.getState().reduceGraphDepth();

    expect(useUiStore.getState().graphDepth).toBe(1);
  });

  it("defaults advanced graph visibility settings to authored-only", () => {
    useUiStore.getState().toggleGraphSetting("includeExternalDependencies");
    expect(useUiStore.getState().graphSettings.includeExternalDependencies).toBe(true);

    useUiStore.getState().resetWorkspace();

    expect(useUiStore.getState().graphSettings.includeExternalDependencies).toBe(false);
  });

  it("adjusts UI scale within bounds and can reset it", () => {
    useUiStore.getState().decreaseUiScale();
    useUiStore.getState().decreaseUiScale();

    expect(useUiStore.getState().uiScale).toBe(0.8);

    useUiStore.getState().increaseUiScale();
    expect(useUiStore.getState().uiScale).toBe(0.9);

    useUiStore.getState().setUiScale(4);
    expect(useUiStore.getState().uiScale).toBe(1.5);

    useUiStore.getState().resetUiScale();
    expect(useUiStore.getState().uiScale).toBe(1);
  });

  it("persists the global editable flow input display preference across workspace resets", () => {
    useUiStore.getState().setFlowInputDisplayMode("entry");

    expect(useUiStore.getState().flowInputDisplayMode).toBe("entry");
    expect(window.localStorage.getItem("helm.flow-input-display-mode")).toBe("entry");

    useUiStore.getState().resetWorkspace();

    expect(useUiStore.getState().flowInputDisplayMode).toBe("entry");
  });
});
