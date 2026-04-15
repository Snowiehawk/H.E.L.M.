import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { CommandPalette } from "../components/CommandPalette";
import {
  GraphCanvas,
  type CreateModeState,
  type GraphCreateIntent,
  type GraphFlowConnectionIntent,
  type GraphFlowDeleteIntent,
  type GraphFlowEditIntent,
} from "../components/graph/GraphCanvas";
import {
  establishFlowDraftDocument,
  projectFlowDraftGraph,
} from "../components/graph/flowDraftGraph";
import {
  graphLayoutNodeKey,
  peekStoredGraphLayout,
  readStoredGraphLayout,
  type StoredGraphLayout,
  writeStoredGraphLayout,
} from "../components/graph/graphLayoutPersistence";
import {
  addDisconnectedFlowNode,
  createFlowNode,
  flowDocumentHandleFromBlueprintHandle,
  flowDocumentsEqual,
  flowNodePayloadFromContent,
  insertFlowNodeOnEdge,
  isAuthoredFlowNodeKind,
  removeFlowEdges,
  removeFlowNodes,
  updateFlowNodePayload,
  upsertFlowConnection,
} from "../components/graph/flowDocument";
import { DesktopWindow } from "../components/layout/DesktopWindow";
import { SidebarPane } from "../components/panes/SidebarPane";
import { ThemeCycleButton } from "../components/shared/ThemeCycleButton";
import { BlueprintInspector } from "../components/workspace/BlueprintInspector";
import {
  GraphCreateComposer,
  type GraphCreateComposerState,
  type GraphCreateComposerSubmit,
} from "../components/workspace/GraphCreateComposer";
import {
  BlueprintInspectorDrawer,
  type BlueprintInspectorDrawerAction,
  DEFAULT_BLUEPRINT_INSPECTOR_DRAWER_HEIGHT,
} from "../components/workspace/BlueprintInspectorDrawer";
import {
  relativePathForNode,
  revealActionEnabled,
  selectionSummary,
} from "../components/workspace/blueprintInspectorUtils";
import {
  WorkspaceHelpProvider,
  WorkspaceHelpScope,
  helpTargetProps,
} from "../components/workspace/workspaceHelp";
import { useDesktopAdapter } from "../lib/adapter";
import type {
  BackendStatus,
  BackendUndoTransaction,
  EditableNodeSource,
  FlowGraphDocument,
  GraphAbstractionLevel,
  GraphBreadcrumbDto,
  GraphNodeDto,
  GraphNodeKind,
  GraphView,
  OverviewModule,
  SearchResult,
  SourceRange,
  StructuralEditRequest,
} from "../lib/adapter";
import {
  isEnterableGraphNodeKind,
  isGraphSymbolNodeKind,
  isInspectableGraphNodeKind,
} from "../lib/adapter";
import { useUiStore } from "../store/uiStore";
import { useUndoStore, type UndoEntry } from "../store/undoStore";

function graphNodeRelativePath(
  metadata: Record<string, unknown> | undefined,
  fallback?: string | null,
) {
  const value = metadata?.relative_path ?? metadata?.relativePath;
  if (typeof value === "string" && (value.includes("/") || value.endsWith(".py"))) {
    return value;
  }
  if (fallback?.endsWith(".py")) {
    return fallback;
  }
  return undefined;
}

function graphNodeMetadataNumber(
  metadata: Record<string, unknown> | undefined,
  key: string,
) {
  const value =
    metadata?.[key]
    ?? metadata?.[key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())];
  return typeof value === "number" ? value : undefined;
}

function graphNodeSourceRange(node: GraphNodeDto | undefined): SourceRange | undefined {
  if (!node) {
    return undefined;
  }

  const startLine = graphNodeMetadataNumber(node.metadata, "source_start_line");
  const endLine = graphNodeMetadataNumber(node.metadata, "source_end_line");
  if (typeof startLine !== "number" || typeof endLine !== "number") {
    return undefined;
  }

  const startColumn = graphNodeMetadataNumber(node.metadata, "source_start_column");
  const endColumn = graphNodeMetadataNumber(node.metadata, "source_end_column");
  return {
    startLine,
    endLine,
    startColumn,
    endColumn,
  };
}

function isTextEditingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.closest(".monaco-editor, .monaco-diff-editor")) {
    return true;
  }

  const editableHost = target.closest(
    'input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"]',
  );
  return editableHost instanceof HTMLElement;
}

function isShortcutBypassTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const interactiveHost = target.closest(
    'button, a[href], summary, [role="button"], [role="link"], [role="menuitem"], [role="switch"], [role="tab"]',
  );
  return interactiveHost instanceof HTMLElement;
}

function shouldNavigateGraphOutFromKeyEvent(
  event: Pick<
    KeyboardEvent,
    "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "target"
  >,
) {
  if (
    event.key !== "Backspace"
    || event.altKey
    || event.ctrlKey
    || event.metaKey
    || event.shiftKey
  ) {
    return false;
  }

  if (!(event.target instanceof HTMLElement)) {
    return false;
  }

  if (isTextEditingTarget(event.target)) {
    return false;
  }

  return event.target.closest(".graph-panel") instanceof HTMLElement;
}

function shouldTrackInspectorSpaceTap(
  event: Pick<
    KeyboardEvent,
    "key" | "code" | "repeat" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "target"
  >,
) {
  const pressedSpace = event.code === "Space" || event.key === " " || event.key === "Spacebar";
  if (
    !pressedSpace
    || event.altKey
    || event.ctrlKey
    || event.metaKey
    || event.shiftKey
    || isTextEditingTarget(event.target)
    || isShortcutBypassTarget(event.target)
  ) {
    return false;
  }

  return true;
}

interface GraphPathItem {
  key: string;
  label: string;
  breadcrumb?: GraphBreadcrumbDto;
  revealTargetId?: string;
}

type InspectorPanelMode = "hidden" | "collapsed" | "expanded";

interface BackendUndoHistoryEntry {
  transaction: BackendUndoTransaction;
  entry: UndoEntry;
}

type FlowDraftStatus = "idle" | "dirty" | "saving" | "reconcile-pending";

interface FlowDraftState {
  symbolId: string;
  document: FlowGraphDocument;
  status: FlowDraftStatus;
  error: string | null;
  reconcileAfterUpdatedAt?: number;
}

const INSPECTOR_DRAWER_HEIGHT_STORAGE_KEY = "helm.blueprint.inspectorDrawerHeight";
const EXPLORER_SIDEBAR_WIDTH_STORAGE_KEY = "helm.blueprint.explorerSidebarWidth";
const INSPECTOR_SPACE_TAP_THRESHOLD_MS = 220;
const DEFAULT_EXPLORER_SIDEBAR_WIDTH = 260;
const MIN_EXPLORER_SIDEBAR_WIDTH = 220;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function readStoredInspectorDrawerHeight() {
  if (
    typeof window === "undefined"
    || typeof window.localStorage?.getItem !== "function"
  ) {
    return DEFAULT_BLUEPRINT_INSPECTOR_DRAWER_HEIGHT;
  }

  const storedValue = window.localStorage.getItem(INSPECTOR_DRAWER_HEIGHT_STORAGE_KEY);
  const parsedHeight = Number(storedValue);
  return Number.isFinite(parsedHeight) && parsedHeight > 0
    ? parsedHeight
    : DEFAULT_BLUEPRINT_INSPECTOR_DRAWER_HEIGHT;
}

function readStoredExplorerSidebarWidth() {
  if (
    typeof window === "undefined"
    || typeof window.localStorage?.getItem !== "function"
  ) {
    return DEFAULT_EXPLORER_SIDEBAR_WIDTH;
  }

  const storedValue = window.localStorage.getItem(EXPLORER_SIDEBAR_WIDTH_STORAGE_KEY);
  const parsedWidth = Number(storedValue);
  return Number.isFinite(parsedWidth) && parsedWidth > 0
    ? parsedWidth
    : DEFAULT_EXPLORER_SIDEBAR_WIDTH;
}

function clampExplorerSidebarWidth(nextWidth: number, containerWidth: number) {
  const safeContainerWidth = Math.max(
    containerWidth || 0,
    typeof window !== "undefined" ? window.innerWidth : 960,
    960,
  );
  const maxWidth = Math.max(
    MIN_EXPLORER_SIDEBAR_WIDTH,
    Math.min(
      Math.floor(safeContainerWidth * 0.42),
      safeContainerWidth - 360,
    ),
  );
  return clamp(nextWidth, MIN_EXPLORER_SIDEBAR_WIDTH, maxWidth);
}

function breadcrumbRelativePath(breadcrumb: GraphBreadcrumbDto): string | undefined {
  if (breadcrumb.level !== "module") {
    return undefined;
  }

  if (typeof breadcrumb.subtitle === "string" && breadcrumb.subtitle.includes("/")) {
    return breadcrumb.subtitle;
  }

  return undefined;
}

function buildGraphPathItems(graph?: GraphView): GraphPathItem[] {
  if (!graph) {
    return [];
  }

  const items: GraphPathItem[] = [];
  const repoBreadcrumb = graph.breadcrumbs.find((breadcrumb) => breadcrumb.level === "repo");
  const moduleBreadcrumb = graph.breadcrumbs.find((breadcrumb) => breadcrumb.level === "module");
  const symbolBreadcrumb = graph.breadcrumbs.find((breadcrumb) => breadcrumb.level === "symbol");
  const flowBreadcrumb =
    graph.level === "flow"
      ? graph.breadcrumbs.find((breadcrumb) => breadcrumb.level === "flow")
      : undefined;

  if (repoBreadcrumb) {
    items.push({
      key: `repo:${repoBreadcrumb.nodeId}`,
      label: repoBreadcrumb.label,
      breadcrumb: repoBreadcrumb,
    });
  }

  if (moduleBreadcrumb) {
    const relativePath = breadcrumbRelativePath(moduleBreadcrumb);
    if (relativePath) {
      relativePath
        .split("/")
        .filter(Boolean)
        .forEach((segment, index, parts) => {
          items.push({
            key: `module:${moduleBreadcrumb.nodeId}:${index}:${segment}`,
            label: segment,
            breadcrumb: index === parts.length - 1 ? moduleBreadcrumb : undefined,
            revealTargetId: index === parts.length - 1 ? moduleBreadcrumb.nodeId : undefined,
          });
        });
    } else {
      items.push({
        key: `module:${moduleBreadcrumb.nodeId}`,
        label: moduleBreadcrumb.label,
        breadcrumb: moduleBreadcrumb,
        revealTargetId: moduleBreadcrumb.nodeId,
      });
    }
  }

  if (symbolBreadcrumb) {
    items.push({
      key: `symbol:${symbolBreadcrumb.nodeId}`,
      label: symbolBreadcrumb.label,
      breadcrumb: symbolBreadcrumb,
    });
  }

  if (flowBreadcrumb) {
    items.push({
      key: `flow:${flowBreadcrumb.nodeId}`,
      label: flowBreadcrumb.label,
      breadcrumb: flowBreadcrumb,
    });
  }

  return items;
}

function moduleIdFromSymbolId(symbolId: string): string | undefined {
  if (!symbolId.startsWith("symbol:")) {
    return undefined;
  }

  const parts = symbolId.slice("symbol:".length).split(":");
  const moduleName = parts[0];
  if (!moduleName) {
    return undefined;
  }

  return `module:${moduleName}`;
}

function moduleNameFromModuleId(moduleId: string): string | undefined {
  return moduleId.startsWith("module:") ? moduleId.slice("module:".length) : undefined;
}

function symbolNameFromSymbolId(symbolId: string): string | undefined {
  if (!symbolId.startsWith("symbol:")) {
    return undefined;
  }

  const parts = symbolId.slice("symbol:".length).split(":");
  return parts[parts.length - 1];
}

function moduleIdFromRelativePath(relativePath: string): string {
  return `module:${relativePath.replace(/\.py$/i, "").split("/").filter(Boolean).join(".")}`;
}

function flowLayoutViewKey(symbolId: string) {
  return `flow|${symbolId}`;
}

function emptyStoredGraphLayout(): StoredGraphLayout {
  return {
    nodes: {},
    reroutes: [],
    pinnedNodeIds: [],
    groups: [],
  };
}

function synchronizeFlowLayoutWithDocumentMutation({
  currentDocument,
  nextDocument,
  layout,
  seededNodes = [],
}: {
  currentDocument: FlowGraphDocument;
  nextDocument: FlowGraphDocument;
  layout: StoredGraphLayout;
  seededNodes?: Array<{
    nodeId: string;
    kind: GraphNodeKind;
    position: { x: number; y: number };
  }>;
}) {
  const removedNodeIds = new Set(
    currentDocument.nodes
      .filter((node) => !nextDocument.nodes.some((candidate) => candidate.id === node.id))
      .map((node) => node.id),
  );
  const removedEdgeIds = new Set(
    currentDocument.edges
      .filter((edge) => !nextDocument.edges.some((candidate) => candidate.id === edge.id))
      .map((edge) => edge.id),
  );
  const nextEdgeIds = new Set(nextDocument.edges.map((edge) => edge.id));
  const nextLayout: StoredGraphLayout = {
    nodes: { ...layout.nodes },
    reroutes: layout.reroutes.filter((reroute) => !removedEdgeIds.has(reroute.edgeId) && nextEdgeIds.has(reroute.edgeId)),
    pinnedNodeIds: layout.pinnedNodeIds.filter((nodeId) => !removedNodeIds.has(nodeId)),
    groups: layout.groups
      .map((group) => ({
        ...group,
        memberNodeIds: group.memberNodeIds.filter((nodeId) => !removedNodeIds.has(nodeId)),
      }))
      .filter((group) => group.memberNodeIds.length >= 2),
  };

  currentDocument.nodes.forEach((node) => {
    if (!removedNodeIds.has(node.id)) {
      return;
    }
    delete nextLayout.nodes[graphLayoutNodeKey(node.id, node.kind)];
  });

  seededNodes.forEach(({ nodeId, kind, position }) => {
    nextLayout.nodes[graphLayoutNodeKey(nodeId, kind)] = {
      x: position.x,
      y: position.y,
    };
  });

  return nextLayout;
}

function symbolIdForModuleAndName(moduleId: string, symbolName: string): string | undefined {
  const moduleName = moduleNameFromModuleId(moduleId);
  if (!moduleName) {
    return undefined;
  }
  return `symbol:${moduleName}:${symbolName}`;
}

function relativePathForModuleId(
  moduleId: string | undefined,
  modules: OverviewModule[],
): string | undefined {
  if (!moduleId) {
    return undefined;
  }

  return modules.find((module) => module.moduleId === moduleId)?.relativePath;
}

function buildFallbackGraphPathItems(
  repoSession:
    | {
        id: string;
        name: string;
      }
    | undefined,
  targetId: string | undefined,
  level: GraphAbstractionLevel,
  modules: OverviewModule[],
): GraphPathItem[] {
  if (!repoSession) {
    return [];
  }

  const items: GraphPathItem[] = [
    {
      key: `repo:${repoSession.id}`,
      label: repoSession.name,
      breadcrumb: {
        nodeId: repoSession.id,
        level: "repo",
        label: repoSession.name,
      },
    },
  ];

  const moduleId =
    targetId?.startsWith("module:")
      ? targetId
      : targetId?.startsWith("symbol:")
        ? moduleIdFromSymbolId(targetId)
        : undefined;
  const modulePath = relativePathForModuleId(moduleId, modules);

  if (moduleId && modulePath) {
    modulePath
      .split("/")
      .filter(Boolean)
      .forEach((segment, index, parts) => {
        items.push({
          key: `fallback-module:${moduleId}:${index}:${segment}`,
          label: segment,
          breadcrumb:
            index === parts.length - 1
              ? {
                  nodeId: moduleId,
                  level: "module",
                  label: segment,
                  subtitle: modulePath,
                }
              : undefined,
          revealTargetId: index === parts.length - 1 ? moduleId : undefined,
        });
      });
  }

  if (targetId?.startsWith("symbol:")) {
    const symbolName = symbolNameFromSymbolId(targetId);
    if (symbolName) {
      items.push({
        key: `fallback-symbol:${targetId}`,
        label: symbolName,
        breadcrumb: {
          nodeId: targetId,
          level: "symbol",
          label: symbolName,
        },
      });
    }

    if (level === "flow") {
      items.push({
        key: `fallback-flow:${targetId}`,
        label: "Flow",
        breadcrumb: {
          nodeId: `flow:${targetId}`,
          level: "flow",
          label: "Flow",
        },
      });
    }
  }

  return items;
}

function workspaceWindowSubtitle(
  repoPath: string | undefined,
  backendStatus: BackendStatus | undefined,
) {
  if (!repoPath) {
    return "Open a local repository to begin.";
  }

  const syncState = backendStatus?.syncState;
  if (syncState === "syncing") {
    return `Repo root: ${repoPath} · ${backendStatus?.note ?? "Live sync updating"}`;
  }
  if (syncState === "manual_resync_required") {
    return `Repo root: ${repoPath} · ${backendStatus?.note ?? "Live sync needs reindex"}`;
  }
  if (syncState === "error") {
    return `Repo root: ${repoPath} · ${backendStatus?.note ?? "Live sync error"}`;
  }
  if (syncState === "synced") {
    return `Repo root: ${repoPath} · Live sync on`;
  }
  return `Repo root: ${repoPath}`;
}

export function WorkspaceScreen() {
  const adapter = useDesktopAdapter();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [repoOpenError, setRepoOpenError] = useState<string | null>(null);
  const [inspectorPanelMode, setInspectorPanelMode] = useState<InspectorPanelMode>("hidden");
  const [inspectorTargetId, setInspectorTargetId] = useState<string | undefined>(undefined);
  const [inspectorSnapshot, setInspectorSnapshot] = useState<GraphView["nodes"][number]>();
  const [inspectorDrawerHeight, setInspectorDrawerHeight] = useState(readStoredInspectorDrawerHeight);
  const [explorerSidebarWidth, setExplorerSidebarWidth] = useState(readStoredExplorerSidebarWidth);
  const [isSavingSource, setIsSavingSource] = useState(false);
  const [createModeState, setCreateModeState] = useState<CreateModeState>("inactive");
  const [createComposer, setCreateComposer] = useState<GraphCreateComposerState | undefined>(undefined);
  const [isSubmittingCreate, setIsSubmittingCreate] = useState(false);
  const [flowDraftState, setFlowDraftState] = useState<FlowDraftState | undefined>(undefined);
  const [inspectorDirty, setInspectorDirty] = useState(false);
  const [inspectorDraftStale, setInspectorDraftStale] = useState(false);
  const [inspectorActionError, setInspectorActionError] = useState<string | null>(null);
  const [createModeError, setCreateModeError] = useState<string | null>(null);
  const inspectorSpaceTapRef = useRef<{ startedAt: number; cancelled: boolean } | null>(null);
  const workspaceLayoutRef = useRef<HTMLDivElement>(null);
  const [workspaceLayoutWidth, setWorkspaceLayoutWidth] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth : 1280,
  );
  const [dismissedPeekNodeId, setDismissedPeekNodeId] = useState<string | undefined>(undefined);
  const [pendingCreatedNodeId, setPendingCreatedNodeId] = useState<string | undefined>(undefined);
  const inspectorDraftContentRef = useRef<string | undefined>(undefined);
  const saveInspectorDraftRef = useRef<(targetId: string, draftContent: string) => Promise<void>>(async () => {});
  const createModeContextKeyRef = useRef<string | undefined>(undefined);
  const [graphPathRevealError, setGraphPathRevealError] = useState<string | null>(null);
  const [backendUndoStack, setBackendUndoStack] = useState<BackendUndoHistoryEntry[]>([]);
  const [inspectorEditableSourceOverride, setInspectorEditableSourceOverride] =
    useState<EditableNodeSource | undefined>(undefined);
  const [inspectorSourceVersion, setInspectorSourceVersion] = useState(0);
  const repoSession = useUiStore((state) => state.repoSession);
  const graphTargetId = useUiStore((state) => state.graphTargetId);
  const activeLevel = useUiStore((state) => state.activeLevel);
  const activeNodeId = useUiStore((state) => state.activeNodeId);
  const activeSymbolId = useUiStore((state) => state.activeSymbolId);
  const graphFilters = useUiStore((state) => state.graphFilters);
  const graphSettings = useUiStore((state) => state.graphSettings);
  const highlightGraphPath = useUiStore((state) => state.highlightGraphPath);
  const showEdgeLabels = useUiStore((state) => state.showEdgeLabels);
  const sidebarQuery = useUiStore((state) => state.sidebarQuery);
  const revealedSource = useUiStore((state) => state.revealedSource);
  const lastActivity = useUiStore((state) => state.lastActivity);
  const setSidebarQuery = useUiStore((state) => state.setSidebarQuery);
  const setSession = useUiStore((state) => state.setSession);
  const initializeWorkspace = useUiStore((state) => state.initializeWorkspace);
  const selectSearchResult = useUiStore((state) => state.selectSearchResult);
  const focusGraph = useUiStore((state) => state.focusGraph);
  const selectNode = useUiStore((state) => state.selectNode);
  const toggleGraphFilter = useUiStore((state) => state.toggleGraphFilter);
  const toggleGraphSetting = useUiStore((state) => state.toggleGraphSetting);
  const toggleGraphPathHighlight = useUiStore((state) => state.toggleGraphPathHighlight);
  const toggleEdgeLabels = useUiStore((state) => state.toggleEdgeLabels);
  const setRevealedSource = useUiStore((state) => state.setRevealedSource);
  const setLastEdit = useUiStore((state) => state.setLastEdit);
  const setLastActivity = useUiStore((state) => state.setLastActivity);
  const resetWorkspace = useUiStore((state) => state.resetWorkspace);

  useEffect(() => {
    if (!repoSession) {
      navigate("/", { replace: true });
    }
  }, [navigate, repoSession]);

  useEffect(() => {
    if (!repoSession) {
      setInspectorPanelMode("hidden");
      setInspectorTargetId(undefined);
      setInspectorSnapshot(undefined);
      inspectorDraftContentRef.current = undefined;
      setInspectorDirty(false);
      setInspectorDraftStale(false);
      setInspectorEditableSourceOverride(undefined);
      setInspectorSourceVersion(0);
      setDismissedPeekNodeId(undefined);
      setCreateModeState("inactive");
      setCreateComposer(undefined);
      setCreateModeError(null);
      setFlowDraftState(undefined);
      setPendingCreatedNodeId(undefined);
      setBackendUndoStack([]);
    }
  }, [repoSession]);

  useEffect(() => {
    setBackendUndoStack([]);
    setInspectorDraftStale(false);
  }, [repoSession?.id]);

  useEffect(() => {
    if (
      typeof window === "undefined"
      || typeof window.localStorage?.setItem !== "function"
    ) {
      return;
    }

    window.localStorage.setItem(
      INSPECTOR_DRAWER_HEIGHT_STORAGE_KEY,
      String(Math.round(inspectorDrawerHeight)),
    );
  }, [inspectorDrawerHeight]);

  useEffect(() => {
    const layout = workspaceLayoutRef.current;
    if (!(layout instanceof HTMLElement)) {
      return;
    }

    const updateWidth = () => {
      setWorkspaceLayoutWidth(layout.clientWidth || window.innerWidth || 1280);
    };

    updateWidth();

    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(() => {
        updateWidth();
      });
      observer.observe(layout);
      return () => observer.disconnect();
    }

    window.addEventListener("resize", updateWidth);
    return () => window.removeEventListener("resize", updateWidth);
  }, []);

  useEffect(() => {
    if (
      typeof window === "undefined"
      || typeof window.localStorage?.setItem !== "function"
    ) {
      return;
    }

    window.localStorage.setItem(
      EXPLORER_SIDEBAR_WIDTH_STORAGE_KEY,
      String(Math.round(explorerSidebarWidth)),
    );
  }, [explorerSidebarWidth]);

  const overviewQuery = useQuery({
    queryKey: ["overview", repoSession?.id],
    queryFn: () => adapter.getOverview(),
    enabled: Boolean(repoSession),
  });

  useEffect(() => {
    if (!graphTargetId && overviewQuery.data) {
      initializeWorkspace(overviewQuery.data.defaultFocusNodeId, overviewQuery.data.defaultLevel);
    }
  }, [graphTargetId, initializeWorkspace, overviewQuery.data]);

  const backendStatusQuery = useQuery({
    queryKey: ["backend-status"],
    queryFn: () => adapter.getBackendStatus(),
  });

  const sidebarSearchQuery = useQuery({
    queryKey: ["workspace-search", repoSession?.id, sidebarQuery],
    queryFn: () =>
      adapter.searchRepo(sidebarQuery, {
        includeModules: true,
        includeFiles: true,
        includeSymbols: true,
      }),
    enabled: Boolean(repoSession) && sidebarQuery.trim().length > 0,
  });

  const graphQuery = useQuery({
    queryKey: [
      "graph-view",
      repoSession?.id,
      graphTargetId,
      activeLevel,
      graphFilters,
      graphSettings,
    ],
    queryFn: () => {
      if (activeLevel === "flow") {
        return adapter.getFlowView(graphTargetId as string);
      }
      return adapter.getGraphView(graphTargetId as string, activeLevel, graphFilters, graphSettings);
    },
    enabled: Boolean(repoSession && graphTargetId),
  });
  const currentSymbolTargetId = graphTargetId?.startsWith("symbol:") ? graphTargetId : undefined;
  const currentFlowSymbolId = activeLevel === "flow" ? currentSymbolTargetId : undefined;
  const flowDraftSeedDocument = useMemo(
    () => establishFlowDraftDocument(graphQuery.data),
    [graphQuery.data],
  );

  useEffect(() => {
    if (
      !currentSymbolTargetId
      || !flowDraftState?.symbolId
      || currentSymbolTargetId === flowDraftState.symbolId
    ) {
      return;
    }

    setFlowDraftState(undefined);
  }, [currentSymbolTargetId, flowDraftState?.symbolId]);

  useEffect(() => {
    if (!currentFlowSymbolId || !flowDraftSeedDocument) {
      return;
    }

    setFlowDraftState((current) => {
      if (!current || current.symbolId !== currentFlowSymbolId) {
        return {
          symbolId: currentFlowSymbolId,
          document: flowDraftSeedDocument,
          status: "idle",
          error: null,
        };
      }

      if (current.status !== "reconcile-pending") {
        return current;
      }

      if ((current.reconcileAfterUpdatedAt ?? 0) >= graphQuery.dataUpdatedAt) {
        return current;
      }

      if (flowDocumentsEqual(current.document, flowDraftSeedDocument)) {
        return {
          ...current,
          document: flowDraftSeedDocument,
          status: "idle",
          error: null,
          reconcileAfterUpdatedAt: undefined,
        };
      }

      return {
        symbolId: currentFlowSymbolId,
        document: flowDraftSeedDocument,
        status: "idle",
        error: null,
      };
    });
  }, [currentFlowSymbolId, flowDraftSeedDocument, graphQuery.dataUpdatedAt]);

  const activeFlowDraft = currentFlowSymbolId && flowDraftState?.symbolId === currentFlowSymbolId
    ? flowDraftState
    : undefined;
  const effectiveGraph = useMemo(() => {
    if (activeLevel === "flow" && graphQuery.data && activeFlowDraft) {
      return projectFlowDraftGraph(graphQuery.data, activeFlowDraft.document);
    }
    return graphQuery.data;
  }, [activeFlowDraft, activeLevel, graphQuery.data]);

  const selectedGraphNode = effectiveGraph?.nodes.find((node) => node.id === activeNodeId);
  const selectedInspectableNode =
    selectedGraphNode && isInspectableGraphNodeKind(selectedGraphNode.kind)
      ? selectedGraphNode
      : undefined;
  const previewInspectorNode =
    inspectorPanelMode === "hidden" && selectedInspectableNode?.id !== dismissedPeekNodeId
      ? selectedInspectableNode
      : undefined;
  const activeGraphSymbolId =
    selectedGraphNode && isGraphSymbolNodeKind(selectedGraphNode.kind)
      ? selectedGraphNode.id
      : activeSymbolId;
  const selectedFilePath = useMemo(() => {
    if (selectedGraphNode) {
      return graphNodeRelativePath(selectedGraphNode.metadata, selectedGraphNode.subtitle);
    }
    return undefined;
  }, [selectedGraphNode]);
  const narrowWorkspaceLayout = workspaceLayoutWidth <= 920;
  const clampedExplorerSidebarWidth = useMemo(
    () => clampExplorerSidebarWidth(explorerSidebarWidth, workspaceLayoutWidth),
    [explorerSidebarWidth, workspaceLayoutWidth],
  );
  const symbolQuery = useQuery({
    queryKey: ["symbol", inspectorTargetId],
    queryFn: () => adapter.getSymbol(inspectorTargetId as string),
    enabled: Boolean(inspectorTargetId && inspectorTargetId.startsWith("symbol:")),
  });
  const flowOwnerSymbolQuery = useQuery({
    queryKey: ["flow-owner-symbol", graphTargetId],
    queryFn: () => adapter.getSymbol(graphTargetId as string),
    enabled: Boolean(activeLevel === "flow" && graphTargetId?.startsWith("symbol:")),
  });

  useEffect(() => {
    if (narrowWorkspaceLayout || clampedExplorerSidebarWidth === explorerSidebarWidth) {
      return;
    }

    setExplorerSidebarWidth(clampedExplorerSidebarWidth);
  }, [clampedExplorerSidebarWidth, explorerSidebarWidth, narrowWorkspaceLayout]);

  useEffect(() => {
    if (!inspectorTargetId || !effectiveGraph) {
      return;
    }

    const matching = effectiveGraph.nodes.find((node) => node.id === inspectorTargetId);
    if (matching) {
      setInspectorSnapshot(matching);
    }
  }, [effectiveGraph, inspectorTargetId]);

  useEffect(() => {
    if (!dismissedPeekNodeId) {
      return;
    }

    if (!selectedGraphNode || selectedGraphNode.id !== dismissedPeekNodeId) {
      setDismissedPeekNodeId(undefined);
    }
  }, [dismissedPeekNodeId, selectedGraphNode]);

  useEffect(() => {
    setInspectorActionError(null);
  }, [activeLevel, graphTargetId, inspectorTargetId, selectedGraphNode?.id]);

  const inspectorNode = useMemo(() => {
    if (inspectorTargetId) {
      return effectiveGraph?.nodes.find((node) => node.id === inspectorTargetId) ?? inspectorSnapshot;
    }
    if (inspectorPanelMode !== "hidden" && selectedGraphNode) {
      return selectedGraphNode;
    }
    return undefined;
  }, [effectiveGraph, inspectorPanelMode, inspectorSnapshot, inspectorTargetId, selectedGraphNode]);
  const shouldShowInspectorDrawer = Boolean(repoSession && (graphTargetId || effectiveGraph));
  const effectiveInspectorDrawerMode =
    inspectorPanelMode === "expanded"
      ? "expanded"
      : shouldShowInspectorDrawer
        ? "collapsed"
        : "hidden";
  const effectiveInspectorNode =
    inspectorPanelMode === "hidden" ? previewInspectorNode : inspectorNode;
  const inspectorHighlightRange = useMemo(
    () =>
      inspectorPanelMode !== "hidden" && activeLevel === "flow"
        ? graphNodeSourceRange(selectedGraphNode)
        : undefined,
    [activeLevel, inspectorPanelMode, selectedGraphNode],
  );

  const editableSourceQuery = useQuery({
    queryKey: ["editable-node-source", repoSession?.id, inspectorNode?.id],
    queryFn: () => adapter.getEditableNodeSource(inspectorNode?.id as string),
    enabled: Boolean(
      inspectorPanelMode !== "hidden"
      && inspectorNode
      && isInspectableGraphNodeKind(inspectorNode.kind),
    ),
  });
  const effectiveEditableSource =
    inspectorEditableSourceOverride?.targetId === inspectorNode?.id
      ? inspectorEditableSourceOverride
      : editableSourceQuery.data;
  const inspectorSourcePath =
    effectiveEditableSource?.path
    ?? graphNodeRelativePath(inspectorNode?.metadata, inspectorNode?.subtitle);

  useEffect(() => {
    if (
      inspectorEditableSourceOverride
      && inspectorNode?.id
      && inspectorEditableSourceOverride.targetId !== inspectorNode.id
    ) {
      setInspectorEditableSourceOverride(undefined);
    }
  }, [inspectorEditableSourceOverride, inspectorNode?.id]);

  const effectiveBackendStatus = backendStatusQuery.data
    ? {
        ...(overviewQuery.data?.backend ?? {}),
        ...backendStatusQuery.data,
      }
    : overviewQuery.data?.backend;

  useEffect(() => {
    if (!inspectorDirty || !inspectorTargetId) {
      setInspectorDraftStale(false);
      return;
    }

    const currentDraft = inspectorDraftContentRef.current;
    if (
      effectiveEditableSource?.content !== undefined
      && currentDraft !== undefined
      && currentDraft === effectiveEditableSource.content
    ) {
      setInspectorDraftStale(false);
    }
  }, [effectiveEditableSource?.content, inspectorDirty, inspectorTargetId]);

  useEffect(() => adapter.subscribeWorkspaceSync((event) => {
    if (!repoSession?.path || event.repoPath !== repoSession.path) {
      return;
    }

    const matchingSnapshot = event.snapshot;
    const liveNodeIds = new Set(matchingSnapshot?.nodeIds ?? []);
    const sameFileChanged = Boolean(
      inspectorDirty
      && inspectorSourcePath
      && event.changedRelativePaths.includes(inspectorSourcePath),
    );
    if (sameFileChanged) {
      setInspectorDraftStale(true);
    }

    if (event.status === "synced" && matchingSnapshot) {
      if (activeNodeId && !liveNodeIds.has(activeNodeId)) {
        selectNode(undefined);
      }

      if (graphTargetId && !liveNodeIds.has(graphTargetId)) {
        const fallbackBreadcrumb = [...(effectiveGraph?.breadcrumbs ?? [])]
          .reverse()
          .find((breadcrumb) => breadcrumb.nodeId !== graphTargetId && liveNodeIds.has(breadcrumb.nodeId));
        if (fallbackBreadcrumb) {
          focusGraph(fallbackBreadcrumb.nodeId, fallbackBreadcrumb.level);
        } else if (liveNodeIds.has(matchingSnapshot.defaultFocusNodeId)) {
          focusGraph(matchingSnapshot.defaultFocusNodeId, matchingSnapshot.defaultLevel);
        } else {
          focusGraph(matchingSnapshot.repoId, "repo");
        }
      }

      if (inspectorTargetId && !liveNodeIds.has(inspectorTargetId) && !sameFileChanged) {
        setInspectorTargetId(undefined);
        setInspectorSnapshot(undefined);
        setInspectorEditableSourceOverride(undefined);
      }
    }

    const invalidations = [
      queryClient.invalidateQueries({ queryKey: ["backend-status"] }),
    ];
    const shouldRefreshWorkspaceData =
      event.status !== "syncing" || Boolean(event.snapshot) || event.needsManualResync;
    if (shouldRefreshWorkspaceData) {
      invalidations.push(
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
        queryClient.invalidateQueries({ queryKey: ["graph-view"] }),
        queryClient.invalidateQueries({ queryKey: ["symbol"] }),
        queryClient.invalidateQueries({ queryKey: ["workspace-search"] }),
        queryClient.invalidateQueries({ queryKey: ["editable-node-source"] }),
      );
    }

    void Promise.all(invalidations);
  }), [
    activeNodeId,
    adapter,
    focusGraph,
    effectiveGraph?.breadcrumbs,
    graphTargetId,
    inspectorDirty,
    inspectorSourcePath,
    inspectorTargetId,
    queryClient,
    repoSession?.path,
    selectNode,
  ]);

  const selectSidebarResult = (result: SearchResult) => {
    selectSearchResult(result);
    setSidebarQuery("");
    if (result.level && result.nodeId) {
      focusGraph(result.nodeId, result.level);
    }
  };

  const selectOverviewModule = (module: OverviewModule) => {
    focusGraph(module.moduleId, "module");
  };

  const selectOverviewSymbol = (nodeId: string) => {
    focusGraph(nodeId, "symbol");
  };

  const openAndIndexRepo = async (path?: string) => {
    setRepoOpenError(null);

    try {
      const session = await adapter.openRepo(path);
      resetWorkspace();
      setSession(session);
      const { jobId } = await adapter.startIndex(session.path);
      navigate(`/indexing/${encodeURIComponent(jobId)}`);
    } catch (reason) {
      const message =
        reason instanceof Error ? reason.message : "Unable to switch repositories right now.";
      setRepoOpenError(message);
    }
  };

  const reindexCurrentRepo = async () => {
    if (!repoSession) {
      return;
    }
    resetWorkspace();
    const { jobId } = await adapter.startIndex(repoSession.path);
    navigate(`/indexing/${encodeURIComponent(jobId)}`);
  };

  const handleGraphSelectNode = (nodeId: string, kind: GraphNodeKind) => {
    selectNode(nodeId);
    if (dismissedPeekNodeId === nodeId) {
      setDismissedPeekNodeId(undefined);
    }

    if (
      inspectorPanelMode !== "hidden"
      && activeLevel !== "flow"
      && (isEnterableGraphNodeKind(kind) || isInspectableGraphNodeKind(kind))
    ) {
      const node = effectiveGraph?.nodes.find((candidate) => candidate.id === nodeId);
      if (node) {
        setInspectorTargetId(nodeId);
        setInspectorSnapshot(node);
      }
    }
  };

  const handleGraphActivateNode = useCallback((nodeId: string, kind: GraphNodeKind) => {
    selectNode(nodeId);
    const node = effectiveGraph?.nodes.find((candidate) => candidate.id === nodeId);

    if (isEnterableGraphNodeKind(kind)) {
      setRevealedSource(undefined);
      if (kind === "repo") {
        focusGraph(nodeId, "repo");
        return;
      }
      if (kind === "module") {
        focusGraph(nodeId, "module");
        return;
      }
      focusGraph(nodeId, "symbol");
      return;
    }

    if (isInspectableGraphNodeKind(kind)) {
      if (node) {
        setInspectorSnapshot(node);
      }
      setDismissedPeekNodeId(undefined);
      setInspectorTargetId(nodeId);
      setInspectorPanelMode("expanded");
    }
  }, [effectiveGraph, focusGraph, selectNode, setRevealedSource]);

  const handleGraphInspectNode = useCallback((nodeId: string, kind: GraphNodeKind) => {
    if (!isInspectableGraphNodeKind(kind)) {
      return;
    }

    selectNode(nodeId);
    if (activeLevel === "flow" && inspectorPanelMode !== "hidden") {
      setDismissedPeekNodeId(undefined);
      setInspectorPanelMode("expanded");
      return;
    }

    const node = effectiveGraph?.nodes.find((candidate) => candidate.id === nodeId);
    if (node) {
      setInspectorSnapshot(node);
    }
    setDismissedPeekNodeId(undefined);
    setInspectorTargetId(nodeId);
    setInspectorPanelMode("expanded");
  }, [activeLevel, effectiveGraph, inspectorPanelMode, selectNode]);

  const handleSelectBreadcrumb = (breadcrumb: GraphBreadcrumbDto) => {
    if (breadcrumb.level === "flow") {
      if (activeGraphSymbolId) {
        focusGraph(activeGraphSymbolId, "flow");
      }
      return;
    }
    focusGraph(breadcrumb.nodeId, breadcrumb.level);
  };

  const handleSelectLevel = (level: GraphAbstractionLevel) => {
    if (!effectiveGraph) {
      return;
    }

    if (level === "repo" && repoSession) {
      focusGraph(repoSession.id, "repo");
      return;
    }

    if (level === "module") {
      const moduleBreadcrumb = [...effectiveGraph.breadcrumbs]
        .reverse()
        .find((breadcrumb) => breadcrumb.level === "module");
      focusGraph(moduleBreadcrumb?.nodeId ?? repoSession?.id ?? effectiveGraph.targetId, "module");
      return;
    }

    if (level === "symbol") {
      const symbolBreadcrumb = [...effectiveGraph.breadcrumbs]
        .reverse()
        .find((breadcrumb) => breadcrumb.level === "symbol");
      if (symbolBreadcrumb) {
        focusGraph(symbolBreadcrumb.nodeId, "symbol");
      }
      return;
    }

    if (level === "flow" && activeGraphSymbolId) {
      focusGraph(activeGraphSymbolId, "flow");
    }
  };

  const handleNavigateGraphOut = () => {
    if (!repoSession) {
      return;
    }

    if (activeLevel === "flow") {
      const symbolTarget =
        graphTargetId?.startsWith("symbol:") ? graphTargetId : activeGraphSymbolId;
      if (symbolTarget) {
        focusGraph(symbolTarget, "symbol");
      }
      return;
    }

    if (activeLevel === "symbol") {
      const symbolTarget =
        graphTargetId?.startsWith("symbol:") ? graphTargetId : activeGraphSymbolId;
      const moduleTarget =
        (symbolTarget ? moduleIdFromSymbolId(symbolTarget) : undefined)
        ?? [...(effectiveGraph?.breadcrumbs ?? [])]
          .reverse()
          .find((breadcrumb) => breadcrumb.level === "module")?.nodeId;
      if (moduleTarget) {
        focusGraph(moduleTarget, "module");
        return;
      }
      focusGraph(repoSession.id, "repo");
      return;
    }

    if (activeLevel === "module") {
      focusGraph(repoSession.id, "repo");
    }
  };

  const handleRevealSource = async (nodeId: string) => {
    setInspectorActionError(null);
    const source = await adapter.revealSource(nodeId);
    setDismissedPeekNodeId(undefined);
    setInspectorPanelMode("expanded");
    setRevealedSource(source);
  };

  const handleApplyEdit = async (
    request: StructuralEditRequest,
    options?: { preserveView?: boolean },
  ) => {
    const result = await adapter.applyStructuralEdit(request);
    const undoTransaction = result.undoTransaction;
    if (undoTransaction) {
      setBackendUndoStack((current) => [
        ...current,
        {
          transaction: undoTransaction,
          entry: {
            domain: "backend",
            summary: result.summary,
            createdAt: Date.now(),
          },
        },
      ]);
    }
    setInspectorPanelMode("expanded");
    setLastEdit(result);
    setRevealedSource(undefined);
    setInspectorDirty(false);
    setInspectorDraftStale(false);
    inspectorDraftContentRef.current = undefined;
    setInspectorEditableSourceOverride(undefined);
    setInspectorSourceVersion((current) => current + 1);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["overview"] }),
      queryClient.invalidateQueries({ queryKey: ["graph-view"] }),
      queryClient.invalidateQueries({ queryKey: ["symbol"] }),
      queryClient.invalidateQueries({ queryKey: ["workspace-search"] }),
      queryClient.invalidateQueries({ queryKey: ["editable-node-source"] }),
    ]);

    if (options?.preserveView) {
      return result;
    }

    let nextFocusTarget:
      | { targetId: string; level: GraphAbstractionLevel; pinInspectorTarget?: boolean }
      | undefined;

    if (request.kind === "rename_symbol" && request.targetId && request.newName) {
      const moduleTarget = moduleIdFromSymbolId(request.targetId);
      const renamedSymbolTarget = moduleTarget
        ? symbolIdForModuleAndName(moduleTarget, request.newName)
        : undefined;
      if (renamedSymbolTarget) {
        nextFocusTarget = { targetId: renamedSymbolTarget, level: "symbol", pinInspectorTarget: true };
      }
    } else if (request.kind === "delete_symbol" && request.targetId) {
      const moduleTarget = moduleIdFromSymbolId(request.targetId);
      if (moduleTarget) {
        nextFocusTarget = { targetId: moduleTarget, level: "module", pinInspectorTarget: true };
      }
    } else if (request.kind === "move_symbol" && request.destinationRelativePath) {
      nextFocusTarget = {
        targetId: moduleIdFromRelativePath(request.destinationRelativePath),
        level: "module",
        pinInspectorTarget: true,
      };
    } else if (
      (request.kind === "add_import" || request.kind === "remove_import")
      && request.relativePath
    ) {
      nextFocusTarget = {
        targetId: moduleIdFromRelativePath(request.relativePath),
        level: "module",
        pinInspectorTarget: true,
      };
    }

    if (!nextFocusTarget) {
      const changedSymbolId = result.changedNodeIds.find((nodeId) => nodeId.startsWith("symbol:"));
      if (changedSymbolId) {
        nextFocusTarget = { targetId: changedSymbolId, level: "symbol", pinInspectorTarget: true };
      }
    }
    if (!nextFocusTarget) {
      const changedModuleId = result.changedNodeIds.find((nodeId) => nodeId.startsWith("module:"));
      if (changedModuleId) {
        nextFocusTarget = { targetId: changedModuleId, level: "module", pinInspectorTarget: true };
      }
    }

    if (nextFocusTarget) {
      setDismissedPeekNodeId(undefined);
      setInspectorSnapshot(undefined);
      setInspectorTargetId(nextFocusTarget.pinInspectorTarget ? nextFocusTarget.targetId : undefined);
      focusGraph(nextFocusTarget.targetId, nextFocusTarget.level);
      return result;
    }
    if (graphTargetId) {
      focusGraph(graphTargetId, activeLevel);
    }
    return result;
  };

  const refreshWorkspaceData = useCallback(async (editableTargetId?: string) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["overview"] }),
      queryClient.invalidateQueries({ queryKey: ["graph-view"] }),
      queryClient.invalidateQueries({ queryKey: ["symbol"] }),
      queryClient.invalidateQueries({ queryKey: ["workspace-search"] }),
      queryClient.invalidateQueries({ queryKey: ["editable-node-source"] }),
    ]);

    if (editableTargetId) {
      return queryClient.fetchQuery({
        queryKey: ["editable-node-source", repoSession?.id, editableTargetId],
        queryFn: () => adapter.getEditableNodeSource(editableTargetId),
      });
    }
    return undefined;
  }, [adapter, queryClient, repoSession?.id]);

  const handleSaveNodeSource = async (targetId: string, content: string) => {
    if (inspectorDraftStale) {
      throw new Error(
        "This draft is stale because the file changed outside H.E.L.M. Reload from disk before saving again.",
      );
    }

    setIsSavingSource(true);
    try {
      const result = await adapter.saveNodeSource(targetId, content);
      const undoTransaction = result.undoTransaction;
      if (undoTransaction) {
        setBackendUndoStack((current) => [
          ...current,
          {
            transaction: undoTransaction,
            entry: {
              domain: "backend",
              summary: result.summary,
              createdAt: Date.now(),
            },
          },
        ]);
      }
      setDismissedPeekNodeId(undefined);
      setInspectorPanelMode("expanded");
      setLastEdit(result);
      setRevealedSource(undefined);
      selectNode(targetId);
      setInspectorTargetId(targetId);
      setInspectorDirty(false);
      setInspectorDraftStale(false);
      inspectorDraftContentRef.current = content;
      const refreshedSource = await refreshWorkspaceData(targetId);
      setInspectorEditableSourceOverride(refreshedSource);
      setInspectorSourceVersion((current) => current + 1);
    } finally {
      setIsSavingSource(false);
    }
  };

  useEffect(() => useUndoStore.getState().registerDomain("backend", {
    canUndo: () => backendUndoStack.length > 0,
    peekEntry: () => backendUndoStack[backendUndoStack.length - 1]?.entry,
    undo: async () => {
      const undoEntry = backendUndoStack[backendUndoStack.length - 1];
      if (!undoEntry) {
        return {
          domain: "backend" as const,
          handled: false,
        };
      }

      try {
        const result = await adapter.applyBackendUndo(undoEntry.transaction);
        setBackendUndoStack((current) => current.slice(0, -1));
        setDismissedPeekNodeId(undefined);
        setInspectorPanelMode("expanded");
        setLastEdit(undefined);
        setLastActivity({
          domain: "backend",
          kind: "undo",
          summary: result.summary,
          touchedRelativePaths: result.restoredRelativePaths,
          warnings: result.warnings,
        });
        setRevealedSource(undefined);
        setInspectorDirty(false);
        inspectorDraftContentRef.current = undefined;
        const refreshedSource = await refreshWorkspaceData(inspectorTargetId);
        setInspectorEditableSourceOverride(refreshedSource);
        setInspectorSourceVersion((current) => current + 1);

        if (result.focusTarget) {
          focusGraph(result.focusTarget.targetId, result.focusTarget.level);
        } else if (graphTargetId) {
          focusGraph(graphTargetId, activeLevel);
        }

        return {
          domain: "backend" as const,
          handled: true,
          summary: result.summary,
        };
      } catch (reason) {
        const summary =
          reason instanceof Error ? reason.message : "Unable to undo the last backend change.";
        setLastActivity({
          domain: "backend",
          kind: "error",
          summary,
        });
        return {
          domain: "backend" as const,
          handled: false,
          summary,
        };
      }
    },
  }), [
    activeLevel,
    adapter,
    backendUndoStack,
    focusGraph,
    graphTargetId,
    inspectorTargetId,
    refreshWorkspaceData,
    setLastActivity,
    setLastEdit,
    setRevealedSource,
  ]);

  const handleInspectorEditorStateChange = useCallback((content?: string, dirty?: boolean) => {
    inspectorDraftContentRef.current = content;
    setInspectorDirty((current) => {
      const next = Boolean(dirty);
      return current === next ? current : next;
    });
  }, []);

  const handleSaveInspectorDraft = useCallback(async (
    targetId: string,
    draftContent: string,
  ) => {
    await saveInspectorDraftRef.current(targetId, draftContent);
  }, []);

  const handleOpenBlueprint = (symbolId: string) => {
    setInspectorActionError(null);
    setInspectorTargetId(symbolId);
    focusGraph(symbolId, "symbol");
  };

  const handleOpenInDefaultEditor = useCallback(async (targetId: string) => {
    setInspectorActionError(null);
    try {
      await adapter.openNodeInDefaultEditor(targetId);
    } catch (reason) {
      setInspectorActionError(
        reason instanceof Error ? reason.message : "Unable to open the file in the default editor.",
      );
    }
  }, [adapter]);

  const clearSelectionState = useCallback(() => {
    selectNode(undefined);
    setInspectorTargetId(undefined);
    setInspectorSnapshot(undefined);
    inspectorDraftContentRef.current = undefined;
    setInspectorDirty(false);
    setInspectorDraftStale(false);
    setInspectorEditableSourceOverride(undefined);
    setInspectorSourceVersion(0);
    setRevealedSource(undefined);
    setDismissedPeekNodeId(undefined);
  }, [selectNode, setRevealedSource]);

  const requestClearSelectionState = useCallback(async () => {
    const draftContent = inspectorDraftContentRef.current;
    if (inspectorDirty && inspectorTargetId && draftContent !== undefined) {
      if (inspectorDraftStale) {
        const shouldDiscard = window.confirm(
          "This draft is stale because the file changed outside H.E.L.M. Click OK to discard it or Cancel to keep editing.",
        );
        if (!shouldDiscard) {
          return false;
        }
      } else {
        const shouldSave = window.confirm(
          "Save your changes before clearing the selection? Click OK to save or Cancel to discard.",
        );
        if (shouldSave) {
          try {
            await saveInspectorDraftRef.current(inspectorTargetId, draftContent);
          } catch {
            return false;
          }
        }
      }
    }

    clearSelectionState();
    return true;
  }, [
    clearSelectionState,
    inspectorDirty,
    inspectorDraftStale,
    inspectorTargetId,
  ]);

  const currentModulePath = useMemo(
    () => [...(effectiveGraph?.breadcrumbs ?? [])]
      .reverse()
      .find((breadcrumb) => breadcrumb.level === "module")?.subtitle ?? undefined,
    [effectiveGraph?.breadcrumbs],
  );
  const currentModuleNode = useMemo(() => {
    const moduleBreadcrumbId = [...(effectiveGraph?.breadcrumbs ?? [])]
      .reverse()
      .find((breadcrumb) => breadcrumb.level === "module")?.nodeId;
    if (!moduleBreadcrumbId) {
      return undefined;
    }
    return effectiveGraph?.nodes.find((node) => node.id === moduleBreadcrumbId && node.kind === "module");
  }, [effectiveGraph]);
  const structuralDestinationModulePaths = useMemo(
    () => overviewQuery.data?.modules.map((module) => module.relativePath) ?? [],
    [overviewQuery.data?.modules],
  );
  const flowOwnerKind = flowOwnerSymbolQuery.data?.kind;
  const flowCreateEnabled =
    activeLevel === "flow"
    && (
      flowOwnerKind === "function"
      || flowOwnerKind === "async_function"
      || flowOwnerKind === "method"
      || flowOwnerKind === "async_method"
    );
  const flowEditable = flowCreateEnabled && (effectiveGraph?.flowState?.editable ?? activeFlowDraft?.document.editable ?? false);
  const flowDraftBackedCreateEnabled = flowEditable && Boolean(activeFlowDraft?.document);
  const flowInsertionFallbackEnabled = flowEditable && !flowDraftBackedCreateEnabled;
  const flowAuthoringEnabled = flowDraftBackedCreateEnabled || flowInsertionFallbackEnabled;
  const createModeCanvasEnabled =
    activeLevel === "repo"
    || ((activeLevel === "module" || activeLevel === "symbol") && Boolean(currentModulePath))
    || flowDraftBackedCreateEnabled;
  const createModeHint =
    createModeState === "inactive"
      ? undefined
      : activeLevel === "repo"
        ? "Click the graph to place a new Python module."
        : activeLevel === "module" || activeLevel === "symbol"
          ? currentModulePath
            ? `Click the graph to create a function or class in ${currentModulePath}.`
            : "Create mode needs a concrete module target in this view."
          : flowDraftBackedCreateEnabled
            ? "Click the graph to add a disconnected node, or click an insertion lane to place one on that control-flow path."
            : flowInsertionFallbackEnabled
              ? "Click an insertion lane to add a node on that control-flow path."
            : "Create mode only writes inside function or method flows in v1.";
  const createModeContextKey = [
    activeLevel,
    graphTargetId ?? "",
    currentModulePath ?? "",
    flowOwnerKind ?? "",
  ].join("|");
  const createModeSupported =
    activeLevel === "repo"
    || ((activeLevel === "module" || activeLevel === "symbol") && Boolean(currentModulePath))
    || flowAuthoringEnabled;

  const handleExitCreateMode = useCallback(() => {
    setCreateComposer(undefined);
    setCreateModeError(null);
    setCreateModeState("inactive");
  }, []);

  const handleOpenCreateComposer = useCallback((intent: GraphCreateIntent) => {
    setCreateModeError(null);
    const composerAnchor = {
      x: intent.panelPosition.x,
      y: intent.panelPosition.y,
    };
    if (activeLevel === "repo") {
      setCreateComposer({
        id: `${Date.now()}:repo`,
        kind: "repo",
        anchor: composerAnchor,
        flowPosition: intent.flowPosition,
      });
      setCreateModeState("composing");
      return;
    }

    if ((activeLevel === "module" || activeLevel === "symbol") && currentModulePath) {
      setCreateComposer({
        id: `${Date.now()}:symbol`,
        kind: "symbol",
        anchor: composerAnchor,
        flowPosition: intent.flowPosition,
        targetModulePath: currentModulePath,
      });
      setCreateModeState("composing");
      return;
    }

    if (
      activeLevel === "flow"
      && flowAuthoringEnabled
      && (flowDraftBackedCreateEnabled || (flowInsertionFallbackEnabled && intent.anchorEdgeId))
    ) {
      setCreateComposer({
        id: `${Date.now()}:flow`,
        kind: "flow",
        mode: "create",
        anchor: composerAnchor,
        flowPosition: intent.flowPosition,
        ownerLabel: flowOwnerSymbolQuery.data?.qualname ?? effectiveGraph?.focus?.label ?? "Flow",
        initialFlowNodeKind: "assign",
        initialPayload: { source: "" },
        insertion: intent.anchorEdgeId
          ? {
              anchorEdgeId: intent.anchorEdgeId,
              anchorLabel: intent.anchorLabel,
            }
          : undefined,
      });
      setCreateModeState("composing");
    }
  }, [
    activeLevel,
    currentModulePath,
    flowDraftBackedCreateEnabled,
    flowInsertionFallbackEnabled,
    flowAuthoringEnabled,
    flowOwnerSymbolQuery.data?.qualname,
    effectiveGraph?.focus?.label,
  ]);

  const handleToggleCreateMode = useCallback(async () => {
    if (createModeState !== "inactive") {
      handleExitCreateMode();
      return;
    }

    if (!createModeSupported) {
      return;
    }

    const cleared = await requestClearSelectionState();
    if (!cleared) {
      return;
    }

    setCreateModeError(null);
    setCreateComposer(undefined);
    setCreateModeState("active");
  }, [
    createModeState,
    createModeSupported,
    handleExitCreateMode,
    requestClearSelectionState,
  ]);

  const seedCreatedNodeLayout = useCallback(async (
    nodeId: string,
    nodeKind: GraphNodeKind | undefined,
    composerState: GraphCreateComposerState,
    override: { targetId: string; level: GraphAbstractionLevel } | undefined = undefined,
  ) => {
    if (!repoSession?.path) {
      return;
    }

    const targetId = override?.targetId ?? graphTargetId;
    const level = override?.level ?? activeLevel;
    if (!targetId) {
      return;
    }

    const viewKey = level === "repo" ? "repo|repo-root" : `${level}|${targetId}`;
    const nextLayout =
      peekStoredGraphLayout(repoSession.path, viewKey)
      ?? await readStoredGraphLayout(repoSession.path, viewKey);
    nextLayout.nodes[graphLayoutNodeKey(nodeId, nodeKind)] = {
      x: composerState.flowPosition.x,
      y: composerState.flowPosition.y,
    };
    void writeStoredGraphLayout(repoSession.path, viewKey, nextLayout);
  }, [
    activeLevel,
    graphTargetId,
    repoSession?.path,
  ]);

  const syncFlowDraftLayout = useCallback(async (
    currentDocument: FlowGraphDocument,
    nextDocument: FlowGraphDocument,
    seededNodes: Array<{
      nodeId: string;
      kind: GraphNodeKind;
      position: { x: number; y: number };
    }> = [],
  ) => {
    if (!repoSession?.path || !graphTargetId?.startsWith("symbol:")) {
      return;
    }

    const viewKey = flowLayoutViewKey(graphTargetId);
    const layout =
      peekStoredGraphLayout(repoSession.path, viewKey)
      ?? await readStoredGraphLayout(repoSession.path, viewKey)
      ?? emptyStoredGraphLayout();
    const nextLayout = synchronizeFlowLayoutWithDocumentMutation({
      currentDocument,
      nextDocument,
      layout,
      seededNodes,
    });
    await writeStoredGraphLayout(repoSession.path, viewKey, nextLayout);
  }, [
    graphTargetId,
    repoSession?.path,
  ]);

  const applyFlowDraftMutation = useCallback(async ({
    transform,
    seededNodes,
    selectedNodeId,
  }: {
    transform: (document: FlowGraphDocument) => FlowGraphDocument;
    seededNodes?: Array<{
      nodeId: string;
      kind: GraphNodeKind;
      position: { x: number; y: number };
    }>;
    selectedNodeId?: string;
  }) => {
    if (!graphTargetId?.startsWith("symbol:") || activeFlowDraft?.symbolId !== graphTargetId) {
      throw new Error("Editable flow draft state is no longer available for this symbol.");
    }

    const currentDocument = activeFlowDraft.document;
    const nextDocument = transform(currentDocument);
    if (flowDocumentsEqual(currentDocument, nextDocument)) {
      return {
        document: currentDocument,
        result: undefined,
      };
    }
    const optimisticDocument: FlowGraphDocument = {
      ...nextDocument,
      syncState: currentDocument.syncState,
      diagnostics: [...currentDocument.diagnostics],
      sourceHash: nextDocument.sourceHash ?? currentDocument.sourceHash ?? null,
      editable: currentDocument.editable,
    };

    await syncFlowDraftLayout(currentDocument, optimisticDocument, seededNodes);
    setFlowDraftState({
      symbolId: graphTargetId,
      document: optimisticDocument,
      status: "saving",
      error: null,
    });
    if (selectedNodeId) {
      selectNode(selectedNodeId);
    }

    try {
      const result = await handleApplyEdit({
        kind: "replace_flow_graph",
        targetId: graphTargetId,
        flowGraph: optimisticDocument,
      }, { preserveView: true });

      setFlowDraftState((current) => {
        if (!current || current.symbolId !== graphTargetId) {
          return current;
        }

        return {
          symbolId: current.symbolId,
          document: {
            ...optimisticDocument,
            syncState: result.flowSyncState ?? optimisticDocument.syncState,
            diagnostics: [...result.diagnostics],
          },
          status: "reconcile-pending",
          error: null,
          reconcileAfterUpdatedAt: graphQuery.dataUpdatedAt,
        };
      });

      return {
        document: optimisticDocument,
        result,
      };
    } catch (reason) {
      const message =
        reason instanceof Error ? reason.message : "Unable to update the current visual flow.";
      setFlowDraftState((current) => {
        if (!current || current.symbolId !== graphTargetId) {
          return current;
        }

        return {
          ...current,
          document: optimisticDocument,
          status: "dirty",
          error: message,
        };
      });
      throw reason;
    }
  }, [
    activeFlowDraft,
    graphQuery.dataUpdatedAt,
    graphTargetId,
    handleApplyEdit,
    selectNode,
    syncFlowDraftLayout,
  ]);

  saveInspectorDraftRef.current = async (targetId: string, draftContent: string) => {
    await handleSaveNodeSource(targetId, draftContent);
  };

  const handleCreateSubmit = useCallback(async (payload: GraphCreateComposerSubmit) => {
    if (!createComposer) {
      return;
    }

    const resumeCreateMode = createModeState === "composing";
    setCreateModeError(null);
    setIsSubmittingCreate(true);
    try {
      let request: StructuralEditRequest;
      let createdNodeKind: GraphNodeKind | undefined;
      let nextFocus: { targetId: string; level: GraphAbstractionLevel } | undefined;

      if (payload.kind === "repo") {
        request = {
          kind: "create_module",
          relativePath: payload.relativePath,
          content: payload.content,
        };
        createdNodeKind = "module";
      } else if (payload.kind === "symbol" && createComposer.kind === "symbol") {
        request = {
          kind: "create_symbol",
          relativePath: createComposer.targetModulePath,
          newName: payload.newName,
          symbolKind: payload.symbolKind,
          body: payload.body,
        };
        createdNodeKind = payload.symbolKind;
        if (activeLevel === "symbol" && graphTargetId?.startsWith("symbol:")) {
          const moduleTarget = moduleIdFromSymbolId(graphTargetId);
          if (moduleTarget) {
            nextFocus = { targetId: moduleTarget, level: "module" };
          }
        }
      } else if (
        payload.kind === "flow"
        && createComposer.kind === "flow"
        && graphTargetId?.startsWith("symbol:")
      ) {
        if (activeFlowDraft?.symbolId === graphTargetId) {
          if (createComposer.mode === "edit" && createComposer.editingNodeId) {
            const nextPayload = flowNodePayloadFromContent(payload.flowNodeKind, payload.content);
            await applyFlowDraftMutation({
              transform: (document) => updateFlowNodePayload(
                document,
                createComposer.editingNodeId as string,
                nextPayload,
              ),
              selectedNodeId: createComposer.editingNodeId,
            });
            setCreateComposer(undefined);
            setCreateModeState(resumeCreateMode ? "active" : "inactive");
            return;
          }

          createdNodeKind = payload.flowNodeKind;
          const nextNode = {
            ...createFlowNode(graphTargetId, payload.flowNodeKind),
            payload: flowNodePayloadFromContent(payload.flowNodeKind, payload.content),
          };
          await applyFlowDraftMutation({
            transform: (document) => (
              createComposer.insertion
                ? insertFlowNodeOnEdge(document, nextNode, createComposer.insertion.anchorEdgeId)
                : addDisconnectedFlowNode(document, nextNode)
            ),
            seededNodes: [{
              nodeId: nextNode.id,
              kind: nextNode.kind,
              position: createComposer.flowPosition,
            }],
            selectedNodeId: nextNode.id,
          });
          setPendingCreatedNodeId(undefined);
          setCreateComposer(undefined);
          setCreateModeState("active");
          return;
        }

        request = {
          kind: "insert_flow_statement",
          targetId: graphTargetId,
          anchorEdgeId: createComposer.insertion?.anchorEdgeId,
          content: payload.content,
        };
      } else {
        throw new Error("Create-mode context no longer matches the requested action.");
      }

      const result = await handleApplyEdit(request, { preserveView: true });
      const changedNodeId = result.changedNodeIds[0];
      if (changedNodeId) {
        await seedCreatedNodeLayout(changedNodeId, createdNodeKind, createComposer, nextFocus);
        selectNode(changedNodeId);
        setPendingCreatedNodeId(changedNodeId);
      }

      if (nextFocus) {
        focusGraph(nextFocus.targetId, nextFocus.level);
      }
      setCreateComposer(undefined);
      setCreateModeState(resumeCreateMode ? "active" : "inactive");
    } catch (reason) {
      const message =
        reason instanceof Error ? reason.message : "Unable to create from the current graph context.";
      setCreateModeError(message);
      if (payload.kind === "flow" && graphTargetId?.startsWith("symbol:")) {
        setFlowDraftState((current) => {
          if (!current || current.symbolId !== graphTargetId) {
            return current;
          }

          return {
            ...current,
            status: "dirty",
            error: message,
          };
        });
      }
    } finally {
      setIsSubmittingCreate(false);
    }
  }, [
    activeLevel,
    activeFlowDraft,
    applyFlowDraftMutation,
    createComposer,
    createModeState,
    focusGraph,
    graphTargetId,
    handleApplyEdit,
    seedCreatedNodeLayout,
  ]);

  const resolveFlowDocumentConnection = useCallback((connection: GraphFlowConnectionIntent) => {
    if (!activeFlowDraft) {
      return undefined;
    }

    const sourceHandle = flowDocumentHandleFromBlueprintHandle(connection.sourceHandle, "source");
    const targetHandle = flowDocumentHandleFromBlueprintHandle(connection.targetHandle, "target");
    if (!sourceHandle || !targetHandle) {
      return undefined;
    }

    const liveNodeIds = new Set(activeFlowDraft.document.nodes.map((node) => node.id));
    if (!liveNodeIds.has(connection.sourceId) || !liveNodeIds.has(connection.targetId)) {
      return undefined;
    }

    return {
      sourceId: connection.sourceId,
      sourceHandle,
      targetId: connection.targetId,
      targetHandle,
    };
  }, [activeFlowDraft]);

  const handleOpenFlowEditComposer = useCallback((intent: GraphFlowEditIntent) => {
    if (
      activeLevel !== "flow"
      || !flowDraftBackedCreateEnabled
      || !graphTargetId?.startsWith("symbol:")
      || activeFlowDraft?.symbolId !== graphTargetId
    ) {
      return;
    }

    const targetNode = activeFlowDraft.document.nodes.find((node) => node.id === intent.nodeId);
    if (!targetNode || !isAuthoredFlowNodeKind(targetNode.kind)) {
      return;
    }

    setCreateModeError(null);
    setCreateComposer({
      id: `${Date.now()}:flow:edit:${targetNode.id}`,
      kind: "flow",
      mode: "edit",
      anchor: {
        x: intent.panelPosition.x,
        y: intent.panelPosition.y,
      },
      flowPosition: intent.flowPosition,
      ownerLabel: flowOwnerSymbolQuery.data?.qualname ?? effectiveGraph?.focus?.label ?? "Flow",
      editingNodeId: targetNode.id,
      initialFlowNodeKind: targetNode.kind,
      initialPayload: targetNode.payload,
    });
  }, [
    activeFlowDraft,
    activeLevel,
    effectiveGraph?.focus?.label,
    flowDraftBackedCreateEnabled,
    flowOwnerSymbolQuery.data?.qualname,
    graphTargetId,
  ]);

  const handleConnectFlowEdge = useCallback((connectionIntent: GraphFlowConnectionIntent) => {
    const connection = resolveFlowDocumentConnection(connectionIntent);
    if (!connection) {
      return;
    }

    void applyFlowDraftMutation({
      transform: (document) => upsertFlowConnection(document, connection),
    }).catch((reason) => {
      const message =
        reason instanceof Error ? reason.message : "Unable to connect the selected flow nodes.";
      setCreateModeError(message);
    });
  }, [
    applyFlowDraftMutation,
    resolveFlowDocumentConnection,
  ]);

  const handleReconnectFlowEdge = useCallback((
    edgeId: string,
    connectionIntent: GraphFlowConnectionIntent,
  ) => {
    const connection = resolveFlowDocumentConnection(connectionIntent);
    if (!connection) {
      return;
    }

    void applyFlowDraftMutation({
      transform: (document) => upsertFlowConnection(document, connection, edgeId),
    }).catch((reason) => {
      const message =
        reason instanceof Error ? reason.message : "Unable to reconnect the selected flow edge.";
      setCreateModeError(message);
    });
  }, [
    applyFlowDraftMutation,
    resolveFlowDocumentConnection,
  ]);

  const handleDeleteFlowSelection = useCallback((selection: GraphFlowDeleteIntent) => {
    if (!selection.nodeIds.length && !selection.edgeIds.length) {
      return;
    }

    void (async () => {
      const cleared = await requestClearSelectionState();
      if (!cleared) {
        return;
      }

      try {
        await applyFlowDraftMutation({
          transform: (document) => {
            let nextDocument = document;
            if (selection.nodeIds.length) {
              nextDocument = removeFlowNodes(nextDocument, selection.nodeIds);
            }
            if (selection.edgeIds.length) {
              nextDocument = removeFlowEdges(nextDocument, selection.edgeIds);
            }
            return nextDocument;
          },
        });
      } catch (reason) {
        const message =
          reason instanceof Error ? reason.message : "Unable to delete the selected flow items.";
        setCreateModeError(message);
      }
    })();
  }, [
    applyFlowDraftMutation,
    requestClearSelectionState,
  ]);

  const requestInspectorClose = useCallback(async () => {
    const draftContent = inspectorDraftContentRef.current;
    if (inspectorDirty && inspectorTargetId && draftContent !== undefined) {
      if (inspectorDraftStale) {
        const shouldDiscard = window.confirm(
          "This draft is stale because the file changed outside H.E.L.M. Click OK to discard it or Cancel to keep editing.",
        );
        if (!shouldDiscard) {
          return false;
        }
      } else {
        const shouldSave = window.confirm(
          "Save your changes before closing the inspector? Click OK to save or Cancel to discard.",
        );
        if (shouldSave) {
          try {
            await handleSaveInspectorDraft(inspectorTargetId, draftContent);
          } catch {
            return false;
          }
        }
      }
    }

    setInspectorPanelMode("hidden");
    setInspectorTargetId(undefined);
    setInspectorSnapshot(undefined);
    inspectorDraftContentRef.current = undefined;
    setInspectorDirty(false);
    setInspectorDraftStale(false);
    setInspectorEditableSourceOverride(undefined);
    setInspectorSourceVersion(0);
    setRevealedSource(undefined);
    setDismissedPeekNodeId(selectedGraphNode?.id ?? inspectorTargetId);
    return true;
  }, [
    handleSaveInspectorDraft,
    inspectorDirty,
    inspectorDraftStale,
    inspectorTargetId,
    selectedGraphNode?.id,
    setRevealedSource,
  ]);

  const handleCollapseInspector = useCallback(() => {
    setInspectorPanelMode((current) => (current === "expanded" ? "collapsed" : current));
  }, []);

  const handleExpandInspector = useCallback(() => {
    const nextNode = previewInspectorNode ?? selectedGraphNode ?? inspectorSnapshot;
    if (nextNode) {
      setInspectorTargetId(nextNode.id);
      setInspectorSnapshot(nextNode);
    }
    setDismissedPeekNodeId(undefined);
    setInspectorPanelMode("expanded");
  }, [inspectorSnapshot, previewInspectorNode, selectedGraphNode]);

  const handleClearGraphSelection = useCallback(async () => {
    await requestClearSelectionState();
  }, [requestClearSelectionState]);

  const handleExplorerSidebarResize = useCallback((nextWidth: number) => {
    setExplorerSidebarWidth(clampExplorerSidebarWidth(nextWidth, workspaceLayoutWidth));
  }, [workspaceLayoutWidth]);

  const handleExplorerResizePointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (narrowWorkspaceLayout) {
      return;
    }

    const layoutLeft = workspaceLayoutRef.current?.getBoundingClientRect().left ?? 0;

    event.preventDefault();

    const resizeFromClientX = (clientX: number) => {
      if (!Number.isFinite(clientX)) {
        return;
      }

      handleExplorerSidebarResize(clientX - layoutLeft);
    };

    const handlePointerMove = (moveEvent: PointerEvent) => {
      resizeFromClientX(moveEvent.clientX);
    };

    const handleMouseMove = (moveEvent: MouseEvent) => {
      resizeFromClientX(moveEvent.clientX);
    };

    const stopResize = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", stopResize);
    };

    resizeFromClientX(event.clientX);
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", stopResize);
  }, [
    handleExplorerSidebarResize,
    narrowWorkspaceLayout,
  ]);

  const handleExplorerResizeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (narrowWorkspaceLayout) {
      return;
    }

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      handleExplorerSidebarResize(clampedExplorerSidebarWidth - 24);
      return;
    }

    if (event.key === "ArrowRight") {
      event.preventDefault();
      handleExplorerSidebarResize(clampedExplorerSidebarWidth + 24);
      return;
    }

    if (event.key === "Home") {
      event.preventDefault();
      handleExplorerSidebarResize(DEFAULT_EXPLORER_SIDEBAR_WIDTH);
    }
  }, [
    clampedExplorerSidebarWidth,
    handleExplorerSidebarResize,
    narrowWorkspaceLayout,
  ]);

  const workspaceLayoutStyle = useMemo(
    () => (narrowWorkspaceLayout
      ? undefined
      : {
          gridTemplateColumns: `${Math.round(clampedExplorerSidebarWidth)}px 12px minmax(0, 1fr)`,
        }),
    [clampedExplorerSidebarWidth, narrowWorkspaceLayout],
  );

  const titleCopy = useMemo(() => {
    if (activeLevel === "flow") {
      return "Internal flow";
    }
    if (activeLevel === "symbol") {
      return "Symbol blueprint";
    }
    if (activeLevel === "repo") {
      return "Architecture graph";
    }
    return "Architecture graph";
  }, [activeLevel]);
  const graphPathItems = useMemo(() => {
    if (effectiveGraph) {
      return buildGraphPathItems(effectiveGraph);
    }

    return buildFallbackGraphPathItems(
      repoSession
        ? {
            id: repoSession.id,
            name: repoSession.name,
          }
        : undefined,
      graphTargetId,
      activeLevel,
      overviewQuery.data?.modules ?? [],
    );
  }, [
    activeLevel,
    effectiveGraph,
    graphTargetId,
    overviewQuery.data?.modules,
    repoSession,
  ]);
  useEffect(() => {
    const previousContextKey = createModeContextKeyRef.current;
    createModeContextKeyRef.current = createModeContextKey;
    setCreateModeError(null);
    if (previousContextKey && previousContextKey !== createModeContextKey) {
      setCreateComposer(undefined);
      setCreateModeState((current) => (current === "inactive" ? current : "active"));
    }
  }, [createModeContextKey]);
  useEffect(() => {
    if (createModeState === "inactive") {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape"
        || event.altKey
        || event.ctrlKey
        || event.metaKey
        || event.shiftKey
      ) {
        return;
      }

      event.preventDefault();
      if (createModeState === "composing") {
        setCreateComposer(undefined);
        setCreateModeError(null);
        setCreateModeState("active");
        return;
      }

      handleExitCreateMode();
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [createModeState, handleExitCreateMode]);
  useEffect(() => {
    if (!pendingCreatedNodeId || !effectiveGraph?.nodes.some((node) => node.id === pendingCreatedNodeId)) {
      return;
    }

    selectNode(pendingCreatedNodeId);
    setPendingCreatedNodeId(undefined);
  }, [effectiveGraph, pendingCreatedNodeId, selectNode]);
  const inspectorDrawerStatus = isSavingSource
    ? { label: "Saving", tone: "warning" as const }
    : inspectorDirty
      ? { label: "Unsaved", tone: "accent" as const }
      : createModeState !== "inactive"
        ? { label: "create", tone: "accent" as const }
        : { label: effectiveInspectorNode?.kind ?? activeLevel, tone: "default" as const };
  const graphContextPath = graphPathItems.map((item) => item.label).join(" / ");
  const graphContextTitle =
    effectiveGraph?.focus?.label
    ?? graphPathItems[graphPathItems.length - 1]?.label
    ?? repoSession?.name
    ?? "Inspector";
  const graphContextSubtitle =
    effectiveGraph?.focus?.subtitle
    ?? (graphContextPath || titleCopy);
  const inspectorSummaryText = selectionSummary(effectiveInspectorNode);
  const drawerTitle = effectiveInspectorNode?.label ?? graphContextTitle;
  const drawerSubtitle = effectiveInspectorNode
    ? inspectorSummaryText && inspectorSummaryText !== effectiveInspectorNode.label
      ? inspectorSummaryText
      : graphContextSubtitle
    : graphContextSubtitle;
  const drawerActionNode =
    activeLevel === "flow"
    && selectedGraphNode
    && (isEnterableGraphNodeKind(selectedGraphNode.kind) || isInspectableGraphNodeKind(selectedGraphNode.kind))
      ? selectedGraphNode
      : effectiveInspectorNode;
  const drawerNodePath =
    relativePathForNode(drawerActionNode)
    ?? (drawerActionNode?.subtitle?.endsWith(".py") ? drawerActionNode.subtitle : undefined);
  const effectiveDrawerNodePath = drawerNodePath ?? currentModulePath;
  const drawerActions: BlueprintInspectorDrawerAction[] = [];
  if (drawerActionNode) {
    if (effectiveDrawerNodePath) {
      drawerActions.push({
        id: "open-default-editor",
        label: "Open File In Default Editor",
        helpId: "inspector.open-default-editor",
        tone: "secondary",
        onClick: () => {
          void handleOpenInDefaultEditor(drawerActionNode.id);
        },
      });
    }

    if (drawerActionNode.kind === "function") {
      drawerActions.push({
        id: "open-blueprint",
        label: "Open blueprint",
        helpId: "inspector.open-blueprint",
        onClick: () => handleOpenBlueprint(drawerActionNode.id),
      });
    }

    if (drawerActionNode.kind === "function" || drawerActionNode.kind === "class") {
      drawerActions.push({
        id: "open-flow",
        label: "Open flow",
        helpId: "inspector.open-flow",
        onClick: () => {
          setDismissedPeekNodeId(undefined);
          setInspectorTargetId(drawerActionNode.id);
          focusGraph(drawerActionNode.id, "flow");
        },
      });
    }

    if (revealActionEnabled(drawerActionNode)) {
      drawerActions.push({
        id: "reveal-source",
        label: revealedSource?.targetId === drawerActionNode.id ? "Refresh source" : "Reveal source",
        helpId: "inspector.reveal-source",
        onClick: () => {
          void handleRevealSource(drawerActionNode.id);
        },
      });
    }
  }

  const handleWorkspaceKeyDownCapture = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (shouldNavigateGraphOutFromKeyEvent(event.nativeEvent)) {
      event.preventDefault();
      handleNavigateGraphOut();
      return;
    }

    if (!shouldTrackInspectorSpaceTap(event.nativeEvent)) {
      return;
    }

    if (event.nativeEvent.repeat) {
      if (inspectorSpaceTapRef.current) {
        inspectorSpaceTapRef.current.cancelled = true;
      }
      return;
    }

    inspectorSpaceTapRef.current = {
      startedAt: Date.now(),
      cancelled: false,
    };
    event.preventDefault();
  };

  const handleWorkspaceKeyUpCapture = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!shouldTrackInspectorSpaceTap(event.nativeEvent)) {
      return;
    }

    const trackedTap = inspectorSpaceTapRef.current;
    inspectorSpaceTapRef.current = null;
    if (!trackedTap || trackedTap.cancelled) {
      return;
    }

    if (Date.now() - trackedTap.startedAt > INSPECTOR_SPACE_TAP_THRESHOLD_MS) {
      return;
    }

    event.preventDefault();
    if (effectiveInspectorDrawerMode === "expanded") {
      handleCollapseInspector();
      return;
    }

    handleExpandInspector();
  };

  const handleWorkspacePointerDownCapture = () => {
    if (inspectorSpaceTapRef.current) {
      inspectorSpaceTapRef.current.cancelled = true;
    }
  };

  const handleRevealGraphPath = useCallback(async (targetId: string) => {
    setGraphPathRevealError(null);
    try {
      await adapter.revealNodeInFileExplorer(targetId);
    } catch (reason) {
      setGraphPathRevealError(
        reason instanceof Error
          ? reason.message
          : "Unable to reveal the current file in the system file explorer.",
      );
    }
  }, [adapter]);

  useEffect(() => {
    setGraphPathRevealError(null);
  }, [activeLevel, graphTargetId]);

  return (
    <DesktopWindow
      eyebrow="Blueprint Editor"
      title={repoSession?.name ?? "H.E.L.M."}
      subtitle={workspaceWindowSubtitle(repoSession?.path, effectiveBackendStatus)}
      actions={<ThemeCycleButton />}
      dense
    >
      <WorkspaceHelpProvider>
        <WorkspaceHelpScope
          onKeyUpCapture={handleWorkspaceKeyUpCapture}
          onKeyDownCapture={handleWorkspaceKeyDownCapture}
          onPointerDownCapture={handleWorkspacePointerDownCapture}
        >
          <div
            ref={workspaceLayoutRef}
            className="workspace-layout workspace-layout--blueprint"
            data-testid="workspace-layout"
            style={workspaceLayoutStyle}
          >
            <SidebarPane
              backendStatus={effectiveBackendStatus}
              overview={overviewQuery.data}
              sidebarQuery={sidebarQuery}
              searchResults={sidebarSearchQuery.data ?? []}
              isSearching={sidebarSearchQuery.isFetching}
              selectedFilePath={
                selectedFilePath
                ?? graphNodeRelativePath(inspectorNode?.metadata, inspectorNode?.subtitle)
              }
              selectedNodeId={activeNodeId}
              onSidebarQueryChange={setSidebarQuery}
              onSelectResult={selectSidebarResult}
              onSelectModule={selectOverviewModule}
              onSelectSymbol={selectOverviewSymbol}
              onFocusRepoGraph={() => repoSession && focusGraph(repoSession.id, "repo")}
              onReindexRepo={reindexCurrentRepo}
              onOpenRepo={openAndIndexRepo}
            />

            {!narrowWorkspaceLayout ? (
              <button
                aria-label="Resize explorer panel"
                className="workspace-layout__resize-rail"
                data-testid="workspace-sidebar-resize"
                type="button"
                onDoubleClick={() => handleExplorerSidebarResize(DEFAULT_EXPLORER_SIDEBAR_WIDTH)}
                onKeyDown={handleExplorerResizeKeyDown}
                onPointerDown={handleExplorerResizePointerDown}
              >
                <span aria-hidden="true" className="workspace-layout__resize-rail-handle" />
              </button>
            ) : null}

            <section className="pane pane--main blueprint-main">
            {repoOpenError ? <p className="error-copy graph-stage__error">{repoOpenError}</p> : null}
            <div className="blueprint-stage__header">
              <div className="blueprint-stage__header-copy">
                <span className="window-bar__eyebrow">Workspace</span>
                <h2>{titleCopy}</h2>
              </div>

              {graphPathItems.length ? (
                <div className="graph-location">
                  <span className="graph-location__label">Graph path</span>
                  <nav aria-label="Graph path" className="graph-location__trail">
                    {graphPathItems.map((item, index) => {
                      const isCurrent = index === graphPathItems.length - 1;
                      const itemHelpId =
                        item.revealTargetId || item.key.startsWith("module:") || item.key.startsWith("fallback-module:")
                          ? "graph.path.file"
                          : item.breadcrumb?.level === "repo"
                            ? "graph.path.repo"
                            : item.breadcrumb?.level === "symbol"
                              ? "graph.path.symbol"
                              : item.breadcrumb?.level === "flow"
                                ? "graph.path.flow"
                                : undefined;

                      return (
                        <div key={item.key} className="graph-location__item">
                          {index > 0 ? (
                            <span aria-hidden="true" className="graph-location__separator">
                              /
                            </span>
                          ) : null}

                          {item.revealTargetId ? (
                            <button
                              {...helpTargetProps("graph.path.file", { label: item.label })}
                              className={`graph-location__link${isCurrent ? " is-current" : ""}`}
                              type="button"
                              title="Reveal this file in the system file explorer"
                              onClick={() => void handleRevealGraphPath(item.revealTargetId as string)}
                            >
                              {item.label}
                            </button>
                          ) : !isCurrent && item.breadcrumb ? (
                            <button
                              {...helpTargetProps(
                                itemHelpId ?? "graph.path.symbol",
                                { label: item.label },
                              )}
                              className="graph-location__button"
                              type="button"
                              onClick={() => handleSelectBreadcrumb(item.breadcrumb as GraphBreadcrumbDto)}
                            >
                              {item.label}
                            </button>
                          ) : (
                            <span
                              {...helpTargetProps(
                                itemHelpId
                                ?? (isCurrent && activeLevel === "flow"
                                  ? "graph.path.flow"
                                  : "graph.path.symbol"),
                                { label: item.label },
                              )}
                              aria-current={isCurrent ? "page" : undefined}
                              className={`graph-location__segment${isCurrent ? " is-current" : ""}`}
                            >
                              {item.label}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </nav>
                  {graphPathRevealError ? <p className="error-copy">{graphPathRevealError}</p> : null}
                </div>
              ) : null}
            </div>

            <div className="blueprint-main__body">
              <div
                className={`blueprint-graph-shell blueprint-graph-shell--${effectiveInspectorDrawerMode}`}
                data-inspector-mode={effectiveInspectorDrawerMode}
              >
                <div className="blueprint-graph-shell__canvas">
                  <GraphCanvas
                    repoPath={repoSession?.path}
                    graph={effectiveGraph}
                    isLoading={!effectiveGraph && graphQuery.isFetching}
                    errorMessage={
                      !effectiveGraph
                        ? graphQuery.error instanceof Error
                          ? graphQuery.error.message
                          : graphQuery.error
                            ? "Unable to load the current graph."
                            : null
                        : null
                    }
                    activeNodeId={activeNodeId}
                    graphFilters={graphFilters}
                    graphSettings={graphSettings}
                    highlightGraphPath={highlightGraphPath}
                    showEdgeLabels={showEdgeLabels}
                    onSelectNode={handleGraphSelectNode}
                    onActivateNode={handleGraphActivateNode}
                    onInspectNode={handleGraphInspectNode}
                    onSelectBreadcrumb={handleSelectBreadcrumb}
                    onSelectLevel={handleSelectLevel}
                    onToggleGraphFilter={toggleGraphFilter}
                    onToggleGraphSetting={toggleGraphSetting}
                    onToggleGraphPathHighlight={toggleGraphPathHighlight}
                    onToggleEdgeLabels={toggleEdgeLabels}
                    onNavigateOut={handleNavigateGraphOut}
                    onClearSelection={() => void handleClearGraphSelection()}
                    createModeState={createModeState}
                    createModeCanvasEnabled={createModeCanvasEnabled}
                    createModeControlEdgeEnabled={flowAuthoringEnabled}
                    createModeHint={createModeHint}
                    onToggleCreateMode={() => {
                      void handleToggleCreateMode();
                    }}
                    onCreateIntent={handleOpenCreateComposer}
                    onEditFlowNodeIntent={handleOpenFlowEditComposer}
                    onConnectFlowEdge={handleConnectFlowEdge}
                    onReconnectFlowEdge={handleReconnectFlowEdge}
                    onDeleteFlowSelection={handleDeleteFlowSelection}
                  />
                  {createComposer ? (
                    <GraphCreateComposer
                      key={createComposer.id}
                      composer={createComposer}
                      error={createModeError}
                      isSubmitting={isSubmittingCreate}
                      onCancel={() => {
                        setCreateComposer(undefined);
                        setCreateModeError(null);
                        setCreateModeState((current) => (current === "composing" ? "active" : current));
                      }}
                      onSubmit={handleCreateSubmit}
                    />
                  ) : null}
                </div>

                {effectiveInspectorDrawerMode !== "hidden" ? (
                  <BlueprintInspectorDrawer
                    actionError={inspectorActionError}
                    actions={drawerActions}
                    drawerHeight={inspectorDrawerHeight}
                    mode={effectiveInspectorDrawerMode}
                    showDismiss={Boolean(effectiveInspectorNode)}
                    statusLabel={inspectorDrawerStatus.label}
                    statusTone={inspectorDrawerStatus.tone}
                    subtitle={drawerSubtitle}
                    title={drawerTitle}
                    onClose={() => {
                      if (inspectorPanelMode === "hidden" && effectiveInspectorNode) {
                        setDismissedPeekNodeId(effectiveInspectorNode.id);
                        return;
                      }
                      if (inspectorPanelMode !== "hidden") {
                        void requestInspectorClose();
                      }
                    }}
                    onCollapse={handleCollapseInspector}
                    onExpand={handleExpandInspector}
                    onHeightChange={setInspectorDrawerHeight}
                  >
                    {inspectorPanelMode !== "hidden" ? (
                      <BlueprintInspector
                        key={`inspector:${inspectorNode?.id ?? "none"}:${inspectorSourceVersion}`}
                        selectedNode={inspectorNode}
                        symbol={symbolQuery.data}
                        editableSource={effectiveEditableSource}
                        editableSourceLoading={editableSourceQuery.isFetching}
                        editableSourceError={
                          editableSourceQuery.error instanceof Error
                            ? editableSourceQuery.error.message
                            : editableSourceQuery.error
                              ? "Unable to load editable source."
                              : null
                        }
                        draftStale={inspectorDraftStale}
                        revealedSource={revealedSource}
                        lastActivity={lastActivity}
                        isSavingSource={isSavingSource}
                        moduleActionNode={currentModuleNode}
                        destinationModulePaths={structuralDestinationModulePaths}
                        highlightRange={inspectorHighlightRange}
                        onApplyStructuralEdit={handleApplyEdit}
                        onSaveSource={handleSaveNodeSource}
                        onEditorStateChange={handleInspectorEditorStateChange}
                        onDismissSource={() => setRevealedSource(undefined)}
                        onClose={handleCollapseInspector}
                      />
                    ) : null}
                  </BlueprintInspectorDrawer>
                ) : null}
              </div>
            </div>
          </section>
          </div>
        </WorkspaceHelpScope>
      </WorkspaceHelpProvider>
      <CommandPalette />
    </DesktopWindow>
  );
}
