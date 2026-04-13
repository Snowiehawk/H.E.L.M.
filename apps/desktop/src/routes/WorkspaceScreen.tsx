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
} from "../components/graph/GraphCanvas";
import {
  graphLayoutNodeKey,
  readStoredGraphLayout,
  writeStoredGraphLayout,
} from "../components/graph/graphLayoutPersistence";
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

function symbolNameFromSymbolId(symbolId: string): string | undefined {
  if (!symbolId.startsWith("symbol:")) {
    return undefined;
  }

  const parts = symbolId.slice("symbol:".length).split(":");
  return parts[parts.length - 1];
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
  const [inspectorDirty, setInspectorDirty] = useState(false);
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
  const lastEdit = useUiStore((state) => state.lastEdit);
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
      setDismissedPeekNodeId(undefined);
      setCreateModeState("inactive");
      setCreateComposer(undefined);
      setCreateModeError(null);
      setPendingCreatedNodeId(undefined);
    }
  }, [repoSession]);

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

  const selectedGraphNode = graphQuery.data?.nodes.find((node) => node.id === activeNodeId);
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
    if (!inspectorTargetId || !graphQuery.data) {
      return;
    }

    const matching = graphQuery.data.nodes.find((node) => node.id === inspectorTargetId);
    if (matching) {
      setInspectorSnapshot(matching);
    }
  }, [graphQuery.data, inspectorTargetId]);

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
      return graphQuery.data?.nodes.find((node) => node.id === inspectorTargetId) ?? inspectorSnapshot;
    }
    if (inspectorPanelMode !== "hidden" && selectedGraphNode) {
      return selectedGraphNode;
    }
    return undefined;
  }, [graphQuery.data, inspectorPanelMode, inspectorSnapshot, inspectorTargetId, selectedGraphNode]);
  const shouldShowInspectorDrawer = Boolean(repoSession && (graphTargetId || graphQuery.data));
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

  const effectiveBackendStatus = overviewQuery.data?.backend ?? backendStatusQuery.data;

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
    await openAndIndexRepo(repoSession.path);
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
      const node = graphQuery.data?.nodes.find((candidate) => candidate.id === nodeId);
      if (node) {
        setInspectorTargetId(nodeId);
        setInspectorSnapshot(node);
      }
    }
  };

  const handleGraphActivateNode = useCallback((nodeId: string, kind: GraphNodeKind) => {
    selectNode(nodeId);
    const node = graphQuery.data?.nodes.find((candidate) => candidate.id === nodeId);

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
  }, [focusGraph, graphQuery.data, selectNode, setRevealedSource]);

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

    const node = graphQuery.data?.nodes.find((candidate) => candidate.id === nodeId);
    if (node) {
      setInspectorSnapshot(node);
    }
    setDismissedPeekNodeId(undefined);
    setInspectorTargetId(nodeId);
    setInspectorPanelMode("expanded");
  }, [activeLevel, graphQuery.data, inspectorPanelMode, selectNode]);

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
    if (!graphQuery.data) {
      return;
    }

    if (level === "repo" && repoSession) {
      focusGraph(repoSession.id, "repo");
      return;
    }

    if (level === "module") {
      const moduleBreadcrumb = [...graphQuery.data.breadcrumbs]
        .reverse()
        .find((breadcrumb) => breadcrumb.level === "module");
      focusGraph(moduleBreadcrumb?.nodeId ?? repoSession?.id ?? graphQuery.data.targetId, "module");
      return;
    }

    if (level === "symbol") {
      const symbolBreadcrumb = [...graphQuery.data.breadcrumbs]
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
        ?? [...(graphQuery.data?.breadcrumbs ?? [])]
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
    setInspectorPanelMode("expanded");
    setLastEdit(result);
    setRevealedSource(undefined);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["overview"] }),
      queryClient.invalidateQueries({ queryKey: ["graph-view"] }),
      queryClient.invalidateQueries({ queryKey: ["symbol"] }),
      queryClient.invalidateQueries({ queryKey: ["workspace-search"] }),
    ]);

    if (options?.preserveView) {
      return result;
    }

    const changedSymbolId = result.changedNodeIds.find((nodeId) => nodeId.startsWith("symbol:"));
    if (changedSymbolId) {
      focusGraph(changedSymbolId, "symbol");
      return result;
    }
    const changedModuleId = result.changedNodeIds.find((nodeId) => nodeId.startsWith("module:"));
    if (changedModuleId) {
      focusGraph(changedModuleId, "module");
      return result;
    }
    if (graphTargetId) {
      focusGraph(graphTargetId, activeLevel);
    }
    return result;
  };

  const handleSaveNodeSource = async (targetId: string, content: string) => {
    setIsSavingSource(true);
    try {
      const result = await adapter.saveNodeSource(targetId, content);
      setDismissedPeekNodeId(undefined);
      setInspectorPanelMode("expanded");
      setLastEdit(result);
      setRevealedSource(undefined);
      selectNode(targetId);
      setInspectorTargetId(targetId);
      setInspectorDirty(false);
      inspectorDraftContentRef.current = content;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
        queryClient.invalidateQueries({ queryKey: ["graph-view"] }),
        queryClient.invalidateQueries({ queryKey: ["symbol"] }),
        queryClient.invalidateQueries({ queryKey: ["workspace-search"] }),
        queryClient.invalidateQueries({ queryKey: ["editable-node-source"] }),
      ]);
    } finally {
      setIsSavingSource(false);
    }
  };

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
    setRevealedSource(undefined);
    setDismissedPeekNodeId(undefined);
  }, [selectNode, setRevealedSource]);

  const requestClearSelectionState = useCallback(async () => {
    const draftContent = inspectorDraftContentRef.current;
    if (inspectorDirty && inspectorTargetId && draftContent !== undefined) {
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

    clearSelectionState();
    return true;
  }, [
    clearSelectionState,
    inspectorDirty,
    inspectorTargetId,
  ]);

  const currentModulePath = useMemo(
    () => [...(graphQuery.data?.breadcrumbs ?? [])]
      .reverse()
      .find((breadcrumb) => breadcrumb.level === "module")?.subtitle ?? undefined,
    [graphQuery.data?.breadcrumbs],
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
  const createModeCanvasEnabled =
    activeLevel === "repo"
    || ((activeLevel === "module" || activeLevel === "symbol") && Boolean(currentModulePath));
  const createModeHint =
    createModeState === "inactive"
      ? undefined
      : activeLevel === "repo"
        ? "Click the graph to place a new Python module."
        : activeLevel === "module" || activeLevel === "symbol"
          ? currentModulePath
            ? `Click the graph to create a function or class in ${currentModulePath}.`
            : "Create mode needs a concrete module target in this view."
          : flowCreateEnabled
            ? "Click an insertion lane to add a node on that control-flow path."
            : "Create mode only writes inside function or method flows in v1.";
  const createModeContextKey = [
    activeLevel,
    graphTargetId ?? "",
    currentModulePath ?? "",
    flowOwnerKind ?? "",
  ].join("|");

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

    if (activeLevel === "flow" && intent.anchorEdgeId && flowCreateEnabled) {
      setCreateComposer({
        id: `${Date.now()}:flow`,
        kind: "flow",
        anchor: composerAnchor,
        flowPosition: intent.flowPosition,
        anchorEdgeId: intent.anchorEdgeId,
        anchorLabel: intent.anchorLabel,
        ownerLabel: flowOwnerSymbolQuery.data?.qualname ?? graphQuery.data?.focus?.label ?? "Flow",
      });
      setCreateModeState("composing");
    }
  }, [
    activeLevel,
    currentModulePath,
    flowCreateEnabled,
    flowOwnerSymbolQuery.data?.qualname,
    graphQuery.data?.focus?.label,
  ]);

  const handleToggleCreateMode = useCallback(async () => {
    if (createModeState !== "inactive") {
      handleExitCreateMode();
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
    const nextLayout = level === "flow"
      ? {
          nodes: {},
          reroutes: [],
          pinnedNodeIds: [],
          groups: [],
        }
      : await readStoredGraphLayout(repoSession.path, viewKey);
    nextLayout.nodes[graphLayoutNodeKey(nodeId, nodeKind)] = {
      x: composerState.flowPosition.x,
      y: composerState.flowPosition.y,
    };
    await writeStoredGraphLayout(repoSession.path, viewKey, nextLayout);
  }, [
    activeLevel,
    graphTargetId,
    repoSession?.path,
  ]);

  saveInspectorDraftRef.current = async (targetId: string, draftContent: string) => {
    await handleSaveNodeSource(targetId, draftContent);
  };

  const handleCreateSubmit = useCallback(async (payload: GraphCreateComposerSubmit) => {
    if (!createComposer) {
      return;
    }

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
        request = {
          kind: "insert_flow_statement",
          targetId: graphTargetId,
          anchorEdgeId: createComposer.anchorEdgeId,
          content: payload.content,
        };
        createdNodeKind = payload.flowNodeKind;
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
      setCreateModeState("active");
    } catch (reason) {
      setCreateModeError(
        reason instanceof Error ? reason.message : "Unable to create from the current graph context.",
      );
    } finally {
      setIsSubmittingCreate(false);
    }
  }, [
    activeLevel,
    createComposer,
    focusGraph,
    graphTargetId,
    handleApplyEdit,
    seedCreatedNodeLayout,
    selectNode,
  ]);

  const requestInspectorClose = useCallback(async () => {
    const draftContent = inspectorDraftContentRef.current;
    if (inspectorDirty && inspectorTargetId && draftContent !== undefined) {
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

    setInspectorPanelMode("hidden");
    setInspectorTargetId(undefined);
    setInspectorSnapshot(undefined);
    inspectorDraftContentRef.current = undefined;
    setInspectorDirty(false);
    setRevealedSource(undefined);
    setDismissedPeekNodeId(selectedGraphNode?.id ?? inspectorTargetId);
    return true;
  }, [
    handleSaveInspectorDraft,
    inspectorDirty,
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
    if (graphQuery.data) {
      return buildGraphPathItems(graphQuery.data);
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
    graphQuery.data,
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
    if (!pendingCreatedNodeId || !graphQuery.data?.nodes.some((node) => node.id === pendingCreatedNodeId)) {
      return;
    }

    selectNode(pendingCreatedNodeId);
    setPendingCreatedNodeId(undefined);
  }, [graphQuery.data, pendingCreatedNodeId, selectNode]);
  const emptyInspectorCreateTargetPath =
    inspectorPanelMode === "expanded"
    && !inspectorNode
    && (activeLevel === "module" || activeLevel === "symbol")
      ? currentModulePath
      : undefined;
  const inspectorDrawerStatus = isSavingSource
    ? { label: "Saving", tone: "warning" as const }
    : inspectorDirty
      ? { label: "Unsaved", tone: "accent" as const }
      : createModeState !== "inactive"
        ? { label: "create", tone: "accent" as const }
        : { label: effectiveInspectorNode?.kind ?? activeLevel, tone: "default" as const };
  const graphContextPath = graphPathItems.map((item) => item.label).join(" / ");
  const graphContextTitle =
    graphQuery.data?.focus?.label
    ?? graphPathItems[graphPathItems.length - 1]?.label
    ?? repoSession?.name
    ?? "Inspector";
  const graphContextSubtitle =
    graphQuery.data?.focus?.subtitle
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
      subtitle={
        repoSession?.path
          ? `Repo root: ${repoSession.path}`
          : "Open a local repository to begin."
      }
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
                    graph={graphQuery.data}
                    isLoading={!graphQuery.data && graphQuery.isFetching}
                    errorMessage={
                      !graphQuery.data
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
                    createModeControlEdgeEnabled={flowCreateEnabled}
                    createModeHint={createModeHint}
                    onToggleCreateMode={() => {
                      void handleToggleCreateMode();
                    }}
                    onCreateIntent={handleOpenCreateComposer}
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
                        setCreateModeState("active");
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
                        selectedNode={inspectorNode}
                        symbol={symbolQuery.data}
                        editableSource={editableSourceQuery.data}
                        editableSourceLoading={editableSourceQuery.isFetching}
                        editableSourceError={
                          editableSourceQuery.error instanceof Error
                            ? editableSourceQuery.error.message
                            : editableSourceQuery.error
                              ? "Unable to load editable source."
                              : null
                        }
                        revealedSource={revealedSource}
                        lastEdit={lastEdit}
                        isSavingSource={isSavingSource}
                        createFunctionTargetPath={emptyInspectorCreateTargetPath}
                        createFunctionError={createModeError}
                        isCreatingFunction={isSubmittingCreate}
                        highlightRange={inspectorHighlightRange}
                        onCreateFunction={undefined}
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
