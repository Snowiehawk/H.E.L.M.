import { create } from "zustand";
import type {
  GraphAbstractionLevel,
  GraphFilters,
  GraphSettings,
  RepoSession,
  RevealedSource,
  SearchResult,
  StructuralEditResult,
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
  graphTargetId?: string;
  activeLevel: GraphAbstractionLevel;
  graphDepth: number;
  graphFilters: GraphFilters;
  graphSettings: GraphSettings;
  highlightGraphPath: boolean;
  showEdgeLabels: boolean;
  revealedSource?: RevealedSource;
  lastEdit?: StructuralEditResult;
  setTheme: (theme: ThemeMode) => void;
  setPaletteOpen: (isOpen: boolean) => void;
  setSidebarQuery: (query: string) => void;
  setSession: (session: RepoSession) => void;
  initializeWorkspace: (targetId: string, level: GraphAbstractionLevel) => void;
  openOverview: () => void;
  openFile: (path: string, nodeId?: string) => void;
  openSymbol: (symbolId: string, nodeId?: string) => void;
  openGraph: (nodeId?: string, level?: GraphAbstractionLevel) => void;
  focusGraph: (targetId: string, level: GraphAbstractionLevel) => void;
  selectSearchResult: (result: SearchResult) => void;
  selectNode: (nodeId?: string) => void;
  expandGraphDepth: () => void;
  reduceGraphDepth: () => void;
  toggleGraphFilter: (key: keyof GraphFilters) => void;
  toggleGraphSetting: (key: keyof GraphSettings) => void;
  toggleGraphPathHighlight: () => void;
  toggleEdgeLabels: () => void;
  setRevealedSource: (source?: RevealedSource) => void;
  setLastEdit: (edit?: StructuralEditResult) => void;
  resetWorkspace: () => void;
}

const defaultGraphFilters: GraphFilters = {
  includeImports: true,
  includeCalls: true,
  includeDefines: true,
};

const defaultGraphSettings: GraphSettings = {
  includeExternalDependencies: false,
};

export const useUiStore = create<UiState>((set) => ({
  theme: "system",
  paletteOpen: false,
  sidebarQuery: "",
  activeTab: "graph",
  activeLevel: "module",
  graphDepth: 1,
  graphFilters: defaultGraphFilters,
  graphSettings: defaultGraphSettings,
  highlightGraphPath: true,
  showEdgeLabels: true,
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
      graphTargetId: undefined,
      activeLevel: "module",
      revealedSource: undefined,
      lastEdit: undefined,
      graphDepth: 1,
      graphSettings: defaultGraphSettings,
    }),
  initializeWorkspace: (graphTargetId, activeLevel) =>
    set({
      graphTargetId,
      activeNodeId: graphTargetId,
      activeLevel,
      activeTab: "graph",
    }),
  openOverview: () => set({ activeTab: "overview" }),
  openFile: (activeFilePath, nodeId) =>
    set({
      activeFilePath,
      activeNodeId: nodeId,
      graphTargetId: nodeId,
      activeLevel: "module",
      activeTab: "file",
    }),
  openSymbol: (activeSymbolId, nodeId) =>
    set({
      activeSymbolId,
      activeNodeId: nodeId ?? activeSymbolId,
      graphTargetId: nodeId ?? activeSymbolId,
      activeLevel: "symbol",
      activeTab: "symbol",
    }),
  openGraph: (nodeId, level) =>
    set((state) => ({
      activeNodeId: nodeId ?? state.activeNodeId ?? state.activeSymbolId,
      graphTargetId: nodeId ?? state.graphTargetId ?? state.activeNodeId ?? state.activeSymbolId,
      activeLevel: level ?? state.activeLevel,
      activeSymbolId:
        (nodeId ?? state.activeNodeId)?.startsWith("symbol:")
          ? (nodeId ?? state.activeNodeId)
          : state.activeSymbolId,
      activeTab: "graph",
      revealedSource: undefined,
    })),
  focusGraph: (graphTargetId, activeLevel) =>
    set({
      graphTargetId,
      activeNodeId: graphTargetId,
      activeSymbolId: graphTargetId.startsWith("symbol:") ? graphTargetId : undefined,
      activeLevel,
      activeTab: "graph",
      revealedSource: undefined,
    }),
  selectSearchResult: (result) =>
    set(() => {
      if (result.kind === "symbol") {
        return {
          activeSymbolId: result.symbolId,
          activeNodeId: result.nodeId,
          graphTargetId: result.nodeId,
          activeLevel: "symbol" as GraphAbstractionLevel,
          activeTab: "symbol" as WorkspaceTab,
          paletteOpen: false,
          revealedSource: undefined,
        };
      }

      return {
        activeFilePath: result.filePath,
        activeNodeId: result.nodeId,
        graphTargetId: result.nodeId,
        activeLevel: "module" as GraphAbstractionLevel,
        activeTab: "graph" as WorkspaceTab,
        paletteOpen: false,
        revealedSource: undefined,
      };
    }),
  selectNode: (activeNodeId) =>
    set((state) => ({
      activeNodeId,
      activeSymbolId:
        activeNodeId?.startsWith("symbol:")
          ? activeNodeId
          : activeNodeId === undefined
            ? undefined
            : state.activeSymbolId,
      activeTab: state.activeTab,
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
  toggleGraphSetting: (key) =>
    set((state) => ({
      graphSettings: {
        ...state.graphSettings,
        [key]: !state.graphSettings[key],
      },
    })),
  toggleGraphPathHighlight: () =>
    set((state) => ({ highlightGraphPath: !state.highlightGraphPath })),
  toggleEdgeLabels: () =>
    set((state) => ({ showEdgeLabels: !state.showEdgeLabels })),
  setRevealedSource: (revealedSource) => set({ revealedSource }),
  setLastEdit: (lastEdit) => set({ lastEdit }),
  resetWorkspace: () =>
    set({
      sidebarQuery: "",
      activeTab: "graph",
      activeFilePath: undefined,
      activeSymbolId: undefined,
      activeNodeId: undefined,
      graphTargetId: undefined,
      activeLevel: "module",
      graphDepth: 1,
      graphFilters: defaultGraphFilters,
      graphSettings: defaultGraphSettings,
      highlightGraphPath: true,
      showEdgeLabels: true,
      revealedSource: undefined,
      lastEdit: undefined,
    }),
}));
