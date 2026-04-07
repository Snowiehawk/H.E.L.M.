import { create } from "zustand";
import type {
  GraphFilters,
  RepoSession,
  SearchResult,
  ThemeMode,
  WorkspaceTab,
} from "../lib/adapter";

interface UiState {
  theme: ThemeMode;
  paletteOpen: boolean;
  sidebarQuery: string;
  activeTab: WorkspaceTab;
  repoSession?: RepoSession;
  activeFilePath?: string;
  activeSymbolId?: string;
  activeNodeId?: string;
  graphDepth: number;
  graphFilters: GraphFilters;
  highlightGraphPath: boolean;
  setTheme: (theme: ThemeMode) => void;
  setPaletteOpen: (isOpen: boolean) => void;
  setSidebarQuery: (query: string) => void;
  setSession: (session: RepoSession) => void;
  openOverview: () => void;
  openFile: (path: string, nodeId?: string) => void;
  openSymbol: (symbolId: string, nodeId?: string) => void;
  openGraph: (nodeId?: string) => void;
  selectSearchResult: (result: SearchResult) => void;
  selectNode: (nodeId: string) => void;
  expandGraphDepth: () => void;
  reduceGraphDepth: () => void;
  toggleGraphFilter: (key: keyof GraphFilters) => void;
  toggleGraphPathHighlight: () => void;
  resetWorkspace: () => void;
}

const defaultGraphFilters: GraphFilters = {
  includeImports: true,
  includeCalls: true,
  includeDefines: true,
};

export const useUiStore = create<UiState>((set) => ({
  theme: "system",
  paletteOpen: false,
  sidebarQuery: "",
  activeTab: "graph",
  graphDepth: 1,
  graphFilters: defaultGraphFilters,
  highlightGraphPath: true,
  setTheme: (theme) => set({ theme }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setSidebarQuery: (sidebarQuery) => set({ sidebarQuery }),
  setSession: (repoSession) =>
    set({
      repoSession,
      activeTab: "graph",
      activeFilePath: undefined,
      activeSymbolId: undefined,
      activeNodeId: repoSession.id,
      graphDepth: 1,
    }),
  openOverview: () => set({ activeTab: "overview" }),
  openFile: (activeFilePath, activeNodeId) =>
    set({
      activeFilePath,
      activeNodeId,
      activeTab: "file",
    }),
  openSymbol: (activeSymbolId, activeNodeId) =>
    set({
      activeSymbolId,
      activeNodeId: activeNodeId ?? activeSymbolId,
      activeTab: "symbol",
    }),
  openGraph: (activeNodeId) =>
    set((state) => ({
      activeNodeId: activeNodeId ?? state.activeNodeId ?? state.activeSymbolId,
      activeSymbolId:
        activeNodeId?.startsWith("symbol:")
          ? activeNodeId
          : state.activeSymbolId,
      activeTab: "graph",
    })),
  selectSearchResult: (result) =>
    set(() => {
      if (result.kind === "file") {
        return {
          activeFilePath: result.filePath,
          activeNodeId: result.nodeId,
          activeTab: "file" as WorkspaceTab,
          paletteOpen: false,
        };
      }

      return {
        activeSymbolId: result.symbolId,
        activeNodeId: result.nodeId,
        activeTab: "symbol" as WorkspaceTab,
        paletteOpen: false,
      };
    }),
  selectNode: (activeNodeId) =>
    set((state) => ({
      activeNodeId,
      activeSymbolId:
        activeNodeId.startsWith("symbol:") ? activeNodeId : state.activeSymbolId,
      activeTab: state.activeTab === "graph" ? "graph" : state.activeTab,
    })),
  expandGraphDepth: () =>
    set((state) => ({ graphDepth: Math.min(state.graphDepth + 1, 4) })),
  reduceGraphDepth: () =>
    set((state) => ({ graphDepth: Math.max(state.graphDepth - 1, 1) })),
  toggleGraphFilter: (key) =>
    set((state) => ({
      graphFilters: {
        ...state.graphFilters,
        [key]: !state.graphFilters[key],
      },
    })),
  toggleGraphPathHighlight: () =>
    set((state) => ({ highlightGraphPath: !state.highlightGraphPath })),
  resetWorkspace: () =>
    set({
      sidebarQuery: "",
      activeTab: "graph",
      activeFilePath: undefined,
      activeSymbolId: undefined,
      activeNodeId: undefined,
      graphDepth: 1,
      graphFilters: defaultGraphFilters,
      highlightGraphPath: true,
    }),
}));
