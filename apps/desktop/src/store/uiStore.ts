import { create } from "zustand";
import type {
  GraphAbstractionLevel,
  GraphFilters,
  FlowInputDisplayMode,
  FlowSyncState,
  GraphSettings,
  RepoSession,
  RevealedSource,
  SearchResult,
  StructuralEditResult,
  ThemeMode,
  WorkspaceTab,
} from "../lib/adapter";

const UI_SCALE_STORAGE_KEY = "helm.ui-scale";
const FLOW_INPUT_DISPLAY_MODE_STORAGE_KEY = "helm.flow-input-display-mode";
export const DEFAULT_UI_SCALE = 1;
export const UI_SCALE_STEP = 0.1;
export const MIN_UI_SCALE = 0.7;
export const MAX_UI_SCALE = 1.5;

function normalizeUiScale(value: number) {
  if (!Number.isFinite(value)) {
    return DEFAULT_UI_SCALE;
  }

  const snapped = Math.round(value / UI_SCALE_STEP) * UI_SCALE_STEP;
  const bounded = Math.min(MAX_UI_SCALE, Math.max(MIN_UI_SCALE, snapped));
  return Number(bounded.toFixed(2));
}

function uiScaleStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  if (typeof window === "undefined") {
    return null;
  }

  const storage = window.localStorage;
  if (
    !storage
    || typeof storage.getItem !== "function"
    || typeof storage.setItem !== "function"
  ) {
    return null;
  }

  return storage;
}

function readStoredUiScale() {
  const storage = uiScaleStorage();
  if (!storage) {
    return DEFAULT_UI_SCALE;
  }

  const rawValue = storage.getItem(UI_SCALE_STORAGE_KEY);
  if (!rawValue) {
    return DEFAULT_UI_SCALE;
  }

  const parsed = Number(rawValue);
  return normalizeUiScale(parsed);
}

function persistUiScale(scale: number) {
  const storage = uiScaleStorage();
  if (!storage) {
    return;
  }

  storage.setItem(UI_SCALE_STORAGE_KEY, String(scale));
}

function readStoredFlowInputDisplayMode(): FlowInputDisplayMode {
  const storage = uiScaleStorage();
  const value = storage?.getItem(FLOW_INPUT_DISPLAY_MODE_STORAGE_KEY);
  return value === "entry" || value === "param_nodes" ? value : "param_nodes";
}

function persistFlowInputDisplayMode(mode: FlowInputDisplayMode) {
  const storage = uiScaleStorage();
  if (!storage) {
    return;
  }
  storage.setItem(FLOW_INPUT_DISPLAY_MODE_STORAGE_KEY, mode);
}

export type WorkspaceActivityDomain = "backend" | "layout" | "editor";
export type WorkspaceActivityKind = "mutation" | "undo" | "redo" | "error";

export interface WorkspaceActivity {
  domain: WorkspaceActivityDomain;
  kind: WorkspaceActivityKind;
  summary: string;
  touchedRelativePaths?: string[];
  warnings?: string[];
  flowSyncState?: FlowSyncState | null;
  diagnostics?: string[];
}

interface UiState {
  theme: ThemeMode;
  uiScale: number;
  preferencesOpen: boolean;
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
  flowInputDisplayMode: FlowInputDisplayMode;
  highlightGraphPath: boolean;
  showEdgeLabels: boolean;
  revealedSource?: RevealedSource;
  lastEdit?: StructuralEditResult;
  lastActivity?: WorkspaceActivity;
  setTheme: (theme: ThemeMode) => void;
  setUiScale: (scale: number) => void;
  increaseUiScale: () => void;
  decreaseUiScale: () => void;
  resetUiScale: () => void;
  setPreferencesOpen: (isOpen: boolean) => void;
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
  setFlowInputDisplayMode: (mode: FlowInputDisplayMode) => void;
  toggleGraphPathHighlight: () => void;
  toggleEdgeLabels: () => void;
  setRevealedSource: (source?: RevealedSource) => void;
  setLastEdit: (edit?: StructuralEditResult) => void;
  setLastActivity: (activity?: WorkspaceActivity) => void;
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
  uiScale: readStoredUiScale(),
  preferencesOpen: false,
  paletteOpen: false,
  sidebarQuery: "",
  activeTab: "graph",
  activeLevel: "module",
  graphDepth: 1,
  graphFilters: defaultGraphFilters,
  graphSettings: defaultGraphSettings,
  flowInputDisplayMode: readStoredFlowInputDisplayMode(),
  highlightGraphPath: true,
  showEdgeLabels: true,
  setTheme: (theme) => set({ theme }),
  setUiScale: (scale) => {
    const nextScale = normalizeUiScale(scale);
    persistUiScale(nextScale);
    set({ uiScale: nextScale });
  },
  increaseUiScale: () =>
    set((state) => {
      const nextScale = normalizeUiScale(state.uiScale + UI_SCALE_STEP);
      persistUiScale(nextScale);
      return { uiScale: nextScale };
    }),
  decreaseUiScale: () =>
    set((state) => {
      const nextScale = normalizeUiScale(state.uiScale - UI_SCALE_STEP);
      persistUiScale(nextScale);
      return { uiScale: nextScale };
    }),
  resetUiScale: () => {
    persistUiScale(DEFAULT_UI_SCALE);
    set({ uiScale: DEFAULT_UI_SCALE });
  },
  setPreferencesOpen: (preferencesOpen) => set({ preferencesOpen }),
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
      lastActivity: undefined,
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
  setFlowInputDisplayMode: (flowInputDisplayMode) => {
    persistFlowInputDisplayMode(flowInputDisplayMode);
    set({ flowInputDisplayMode });
  },
  toggleGraphPathHighlight: () =>
    set((state) => ({ highlightGraphPath: !state.highlightGraphPath })),
  toggleEdgeLabels: () =>
    set((state) => ({ showEdgeLabels: !state.showEdgeLabels })),
  setRevealedSource: (revealedSource) => set({ revealedSource }),
  setLastEdit: (lastEdit) =>
    set({
      lastEdit,
      lastActivity: lastEdit
        ? {
            domain: "backend",
            kind: "mutation",
            summary: lastEdit.summary,
            touchedRelativePaths: lastEdit.touchedRelativePaths,
            warnings: lastEdit.warnings,
            flowSyncState: lastEdit.flowSyncState,
            diagnostics: lastEdit.diagnostics,
          }
        : undefined,
    }),
  setLastActivity: (lastActivity) => set({ lastActivity }),
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
      lastActivity: undefined,
    }),
}));
