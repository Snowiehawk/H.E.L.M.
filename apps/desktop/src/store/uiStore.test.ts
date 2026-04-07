import { beforeEach, describe, expect, it } from "vitest";
import { useUiStore } from "./uiStore";

function resetStore() {
  const current = useUiStore.getState();
  useUiStore.setState({
    ...current,
    theme: "system",
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
    highlightGraphPath: true,
  });
}

describe("uiStore", () => {
  beforeEach(() => {
    resetStore();
  });

  it("opens a symbol from search results and syncs the graph node selection", () => {
    useUiStore.getState().selectSearchResult({
      id: "symbol:helm.ui.api.build_graph_summary",
      kind: "symbol",
      title: "build_graph_summary",
      subtitle: "helm.ui.api.build_graph_summary",
      score: 1,
      filePath: "src/helm/ui/api.py",
      symbolId: "symbol:helm.ui.api.build_graph_summary",
      nodeId: "symbol:helm.ui.api.build_graph_summary",
    });

    const state = useUiStore.getState();
    expect(state.activeTab).toBe("symbol");
    expect(state.activeSymbolId).toBe("symbol:helm.ui.api.build_graph_summary");
    expect(state.activeNodeId).toBe("symbol:helm.ui.api.build_graph_summary");
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
});
