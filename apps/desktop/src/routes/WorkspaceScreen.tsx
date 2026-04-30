import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { CommandPalette } from "../components/CommandPalette";
import {
  GraphCanvas,
  type CreateModeState,
  type GraphCreateIntent,
  type GraphExpressionGraphIntent,
  type GraphFlowEditIntent,
} from "../components/graph/GraphCanvas";
import {
  graphLayoutNodeKey,
  peekStoredGraphLayout,
  readStoredGraphLayout,
  writeStoredGraphLayout,
} from "../components/graph/graphLayoutPersistence";
import { isFlowNodeAuthorableKind } from "../components/graph/flowDocument";
import { DesktopWindow } from "../components/layout/DesktopWindow";
import { SidebarPane } from "../components/panes/SidebarPane";
import { AppWindowActions } from "../components/shared/AppWindowActions";
import { BlueprintInspector } from "../components/workspace/BlueprintInspector";
import {
  GraphCreateComposer,
  type GraphCreateComposerState,
  type GraphCreateComposerSubmit,
} from "../components/workspace/GraphCreateComposer";
import { FlowExpressionGraphCanvas } from "../components/workspace/FlowExpressionGraphCanvas";
import {
  EMPTY_EXPRESSION_GRAPH,
  normalizeExpressionGraphOrEmpty,
  returnExpressionFromPayload,
} from "../components/graph/flowExpressionGraphEditing";
import { expressionFromFlowExpressionGraph } from "../components/graph/flowExpressionGraph";
import {
  BlueprintInspectorDrawer,
  type BlueprintInspectorDrawerAction,
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
  FlowExpressionGraph,
  FlowInputSlot,
  GraphAbstractionLevel,
  GraphNodeKind,
  StructuralEditRequest,
  WorkspaceRecoveryEvent,
} from "../lib/adapter";
import {
  isEnterableGraphNodeKind,
  isGraphSymbolNodeKind,
  isInspectableGraphNodeKind,
} from "../lib/adapter";
import { useUiStore } from "../store/uiStore";
import { WorkspaceFileEditorPanel } from "./WorkspaceScreen/WorkspaceFileEditorPanel";
import { useBackendUndoCoordinator } from "./WorkspaceScreen/useBackendUndoCoordinator";
import {
  useFlowDraftMutationCallbacks,
  useFlowDraftMutations,
} from "./WorkspaceScreen/useFlowDraftMutations";
import { useGraphNavigation } from "./WorkspaceScreen/useGraphNavigation";
import { useInspectorSourceState } from "./WorkspaceScreen/useInspectorSourceState";
import { useWorkspaceFileOperations } from "./WorkspaceScreen/useWorkspaceFileOperations";
import { useWorkspaceLayout } from "./WorkspaceScreen/useWorkspaceLayout";
import { useWorkspaceSyncEffects } from "./WorkspaceScreen/useWorkspaceSyncEffects";
import {
  invalidateWorkspaceDataQueries,
  workspaceQueryKeys,
} from "./WorkspaceScreen/workspaceQueries";
import type { ReturnExpressionGraphViewState } from "./WorkspaceScreen/types";
import {
  buildFallbackGraphPathItems,
  buildGraphPathItems,
  DEFAULT_EXPLORER_SIDEBAR_WIDTH,
  graphNodeRelativePath,
  INSPECTOR_SPACE_TAP_THRESHOLD_MS,
  moduleIdFromRelativePath,
  moduleIdFromSymbolId,
  recoveryActivityFromEvents,
  shouldTrackInspectorSpaceTap,
  symbolIdForModuleAndName,
  workspaceWindowSubtitle,
} from "./WorkspaceScreen/workspaceScreenModel";

export function WorkspaceScreen() {
  const adapter = useDesktopAdapter();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [repoOpenError, setRepoOpenError] = useState<string | null>(null);
  const {
    handleExplorerSidebarResize,
    handleExplorerResizeKeyDown,
    handleExplorerResizePointerDown,
    inspectorDrawerHeight,
    narrowWorkspaceLayout,
    setInspectorDrawerHeight,
    workspaceLayoutRef,
    workspaceLayoutStyle,
  } = useWorkspaceLayout();
  const [isSavingSource, setIsSavingSource] = useState(false);
  const [createModeState, setCreateModeState] = useState<CreateModeState>("inactive");
  const [createComposer, setCreateComposer] = useState<GraphCreateComposerState | undefined>(
    undefined,
  );
  const [isSubmittingCreate, setIsSubmittingCreate] = useState(false);
  const [returnExpressionGraphView, setReturnExpressionGraphView] = useState<
    ReturnExpressionGraphViewState | undefined
  >(undefined);
  const [isSubmittingExpressionGraph, setIsSubmittingExpressionGraph] = useState(false);
  const [inspectorActionError, setInspectorActionError] = useState<string | null>(null);
  const [createModeError, setCreateModeError] = useState<string | null>(null);
  const inspectorSpaceTapRef = useRef<{ startedAt: number; cancelled: boolean } | null>(null);
  const [dismissedPeekNodeId, setDismissedPeekNodeId] = useState<string | undefined>(undefined);
  const [pendingCreatedNodeId, setPendingCreatedNodeId] = useState<string | undefined>(undefined);
  const inspectorDraftContentRef = useRef<string | undefined>(undefined);
  const saveInspectorDraftRef = useRef<(targetId: string, draftContent: string) => Promise<void>>(
    async () => {},
  );
  const createModeContextKeyRef = useRef<string | undefined>(undefined);
  const [graphPathRevealError, setGraphPathRevealError] = useState<string | null>(null);
  const repoSession = useUiStore((state) => state.repoSession);
  const graphTargetId = useUiStore((state) => state.graphTargetId);
  const activeLevel = useUiStore((state) => state.activeLevel);
  const activeNodeId = useUiStore((state) => state.activeNodeId);
  const activeSymbolId = useUiStore((state) => state.activeSymbolId);
  const graphFilters = useUiStore((state) => state.graphFilters);
  const graphSettings = useUiStore((state) => state.graphSettings);
  const flowInputDisplayMode = useUiStore((state) => state.flowInputDisplayMode);
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
  const setFlowInputDisplayMode = useUiStore((state) => state.setFlowInputDisplayMode);
  const toggleGraphPathHighlight = useUiStore((state) => state.toggleGraphPathHighlight);
  const toggleEdgeLabels = useUiStore((state) => state.toggleEdgeLabels);
  const setRevealedSource = useUiStore((state) => state.setRevealedSource);
  const setLastEdit = useUiStore((state) => state.setLastEdit);
  const setLastActivity = useUiStore((state) => state.setLastActivity);
  const resetWorkspace = useUiStore((state) => state.resetWorkspace);
  const surfaceRecoveryEvents = useCallback(
    (events?: WorkspaceRecoveryEvent[]) => {
      const activity = recoveryActivityFromEvents(events);
      if (activity) {
        setLastActivity(activity);
      }
    },
    [setLastActivity],
  );
  const refreshWorkspaceData = useCallback(
    async (editableTargetId?: string) => {
      await invalidateWorkspaceDataQueries(queryClient, { includeEditableSource: true });

      if (editableTargetId) {
        return queryClient.fetchQuery({
          queryKey: workspaceQueryKeys.editableNodeSource(
            repoSession?.id,
            "editable",
            editableTargetId,
          ),
          queryFn: () => adapter.getEditableNodeSource(editableTargetId),
        });
      }
      return undefined;
    },
    [adapter, queryClient, repoSession?.id],
  );
  const clearInspectorDraftContent = useCallback(() => {
    inspectorDraftContentRef.current = undefined;
  }, []);

  useEffect(() => {
    if (!repoSession) {
      navigate("/", { replace: true });
    }
  }, [navigate, repoSession]);

  const overviewQuery = useQuery({
    queryKey: workspaceQueryKeys.overview(repoSession?.id),
    queryFn: () => adapter.getOverview(),
    enabled: Boolean(repoSession),
  });

  const workspaceFilesQuery = useQuery({
    queryKey: workspaceQueryKeys.workspaceFiles(repoSession?.id),
    queryFn: () => adapter.listWorkspaceFiles(repoSession!.path),
    enabled: Boolean(repoSession),
  });

  useEffect(() => {
    if (!graphTargetId && overviewQuery.data) {
      initializeWorkspace(overviewQuery.data.defaultFocusNodeId, overviewQuery.data.defaultLevel);
    }
  }, [graphTargetId, initializeWorkspace, overviewQuery.data]);

  const backendStatusQuery = useQuery({
    queryKey: workspaceQueryKeys.backendStatus(),
    queryFn: () => adapter.getBackendStatus(),
  });

  const sidebarSearchQuery = useQuery({
    queryKey: workspaceQueryKeys.workspaceSearch(repoSession?.id, sidebarQuery),
    queryFn: () =>
      adapter.searchRepo(sidebarQuery, {
        includeModules: true,
        includeFiles: true,
        includeSymbols: true,
      }),
    enabled: Boolean(repoSession) && sidebarQuery.trim().length > 0,
  });

  const graphQuery = useQuery({
    queryKey: workspaceQueryKeys.graphView(
      repoSession?.id,
      graphTargetId,
      activeLevel,
      graphFilters,
      graphSettings,
    ),
    queryFn: () => {
      if (activeLevel === "flow") {
        return adapter.getFlowView(graphTargetId as string);
      }
      return adapter.getGraphView(
        graphTargetId as string,
        activeLevel,
        graphFilters,
        graphSettings,
      );
    },
    enabled: Boolean(repoSession && graphTargetId),
  });

  const currentSymbolTargetId = graphTargetId?.startsWith("symbol:") ? graphTargetId : undefined;
  const currentFlowSymbolId = activeLevel === "flow" ? currentSymbolTargetId : undefined;
  const {
    activeFlowDraft,
    effectiveGraph,
    flowDraftSeedDocument,
    resetFlowDraftState,
    setFlowDraftState,
    syncFlowDraftLayout,
  } = useFlowDraftMutations({
    activeLevel,
    currentFlowSymbolId,
    currentSymbolTargetId,
    flowInputDisplayMode,
    graphData: graphQuery.data,
    graphDataUpdatedAt: graphQuery.dataUpdatedAt,
    graphTargetId,
    repoPath: repoSession?.path,
  });
  const returnExpressionFlowDocument = useMemo(() => {
    if (!returnExpressionGraphView || activeLevel !== "flow") {
      return undefined;
    }
    if (activeFlowDraft?.symbolId === returnExpressionGraphView.symbolId) {
      return activeFlowDraft.document;
    }
    if (flowDraftSeedDocument?.symbolId === returnExpressionGraphView.symbolId) {
      return flowDraftSeedDocument;
    }
    return undefined;
  }, [activeFlowDraft, activeLevel, flowDraftSeedDocument, returnExpressionGraphView]);

  useEffect(() => {
    if (!returnExpressionGraphView) {
      return;
    }
    const returnNode =
      activeLevel === "flow" &&
      returnExpressionFlowDocument?.symbolId === returnExpressionGraphView.symbolId
        ? returnExpressionFlowDocument.nodes.find(
            (node) => node.id === returnExpressionGraphView.returnNodeId && node.kind === "return",
          )
        : undefined;

    if (!returnNode) {
      setReturnExpressionGraphView(undefined);
      setIsSubmittingExpressionGraph(false);
      return;
    }

    if (returnExpressionGraphView.isDraftOnly) {
      return;
    }

    setReturnExpressionGraphView((current) => {
      if (!current || current.isDraftOnly) {
        return current;
      }
      const selectedExpressionNodeStillExists =
        current.selectedExpressionNodeId &&
        normalizeExpressionGraphOrEmpty(
          returnNode.payload.expression_graph as FlowExpressionGraph | undefined,
        ).nodes.some((node) => node.id === current.selectedExpressionNodeId);
      const nextSelectedExpressionNodeId = selectedExpressionNodeStillExists
        ? current.selectedExpressionNodeId
        : undefined;
      if (
        current.draftGraph === undefined &&
        current.draftExpression === undefined &&
        current.diagnostics.length === 0 &&
        current.error === null &&
        current.selectedExpressionNodeId === nextSelectedExpressionNodeId
      ) {
        return current;
      }
      return {
        ...current,
        draftGraph: undefined,
        draftExpression: undefined,
        diagnostics: [],
        error: null,
        selectedExpressionNodeId: nextSelectedExpressionNodeId,
      };
    });
  }, [activeLevel, returnExpressionFlowDocument, returnExpressionGraphView]);

  const returnExpressionGraphViewNode = useMemo(
    () =>
      returnExpressionGraphView && returnExpressionFlowDocument
        ? returnExpressionFlowDocument.nodes.find(
            (node) => node.id === returnExpressionGraphView.returnNodeId && node.kind === "return",
          )
        : undefined,
    [returnExpressionFlowDocument, returnExpressionGraphView],
  );
  const returnExpressionGraphViewInputSlots = useMemo<FlowInputSlot[]>(() => {
    if (!returnExpressionGraphView || !returnExpressionFlowDocument) {
      return [];
    }
    return (returnExpressionFlowDocument.inputSlots ?? []).filter(
      (slot) => slot.nodeId === returnExpressionGraphView.returnNodeId,
    );
  }, [returnExpressionFlowDocument, returnExpressionGraphView]);
  const returnExpressionGraphViewGraph = useMemo(() => {
    if (!returnExpressionGraphView) {
      return EMPTY_EXPRESSION_GRAPH;
    }
    return normalizeExpressionGraphOrEmpty(
      returnExpressionGraphView.draftGraph ??
        (returnExpressionGraphViewNode?.payload.expression_graph as
          | FlowExpressionGraph
          | undefined),
    );
  }, [returnExpressionGraphView, returnExpressionGraphViewNode?.payload.expression_graph]);
  const returnExpressionGraphViewExpression = useMemo(() => {
    if (!returnExpressionGraphView || !returnExpressionGraphViewNode) {
      return "";
    }
    if (returnExpressionGraphView.draftExpression !== undefined) {
      return returnExpressionGraphView.draftExpression;
    }
    const graphExpression = expressionFromFlowExpressionGraph(returnExpressionGraphViewGraph);
    if (!graphExpression.diagnostics.length && graphExpression.expression.trim()) {
      return graphExpression.expression;
    }
    return returnExpressionFromPayload(returnExpressionGraphViewNode.payload);
  }, [returnExpressionGraphView, returnExpressionGraphViewGraph, returnExpressionGraphViewNode]);

  const selectedGraphNode = effectiveGraph?.nodes.find((node) => node.id === activeNodeId);
  const selectedInspectableNode =
    selectedGraphNode && isInspectableGraphNodeKind(selectedGraphNode.kind)
      ? selectedGraphNode
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
  const currentModuleBreadcrumb = useMemo(
    () =>
      [...(effectiveGraph?.breadcrumbs ?? [])]
        .reverse()
        .find((breadcrumb) => breadcrumb.level === "module"),
    [effectiveGraph?.breadcrumbs],
  );
  const currentModulePath = currentModuleBreadcrumb?.subtitle ?? undefined;
  const currentModuleNode = useMemo(() => {
    const moduleBreadcrumbId = currentModuleBreadcrumb?.nodeId;
    if (!moduleBreadcrumbId) {
      return undefined;
    }
    return effectiveGraph?.nodes.find(
      (node) => node.id === moduleBreadcrumbId && node.kind === "module",
    );
  }, [currentModuleBreadcrumb?.nodeId, effectiveGraph]);
  const flowOwnerSymbolQuery = useQuery({
    queryKey: workspaceQueryKeys.flowOwnerSymbol(graphTargetId),
    queryFn: () => adapter.getSymbol(graphTargetId as string),
    enabled: Boolean(activeLevel === "flow" && graphTargetId?.startsWith("symbol:")),
  });

  const {
    editableSourceQuery,
    effectiveEditableSource,
    effectiveInspectorDrawerMode,
    effectiveInspectorNode,
    handleInspectorEditorStateChange,
    inspectorDirty,
    inspectorDraftStale,
    inspectorHighlightRange,
    inspectorNode,
    inspectorPanelMode,
    inspectorSelectionNode,
    inspectorSnapshot,
    previewInspectorNode,
    inspectorSourcePath,
    inspectorSourceTarget,
    inspectorSourceVersion,
    inspectorTargetId,
    resetInspectorSourceState,
    setInspectorDirty,
    setInspectorDraftStale,
    setInspectorEditableSourceOverride,
    setInspectorPanelMode,
    setInspectorSnapshot,
    setInspectorSourceVersion,
    setInspectorTargetId,
    symbolQuery,
  } = useInspectorSourceState({
    activeLevel,
    adapter,
    currentModuleNode,
    dismissedPeekNodeId,
    effectiveGraph,
    graphTargetId,
    inspectorDraftContentRef,
    repoSessionId: repoSession?.id,
    selectedGraphNode,
    selectedInspectableNode,
  });
  const { recordBackendUndoTransaction, resetBackendUndoHistory } = useBackendUndoCoordinator({
    activeLevel,
    adapter,
    clearInspectorDraftContent,
    focusGraph,
    graphTargetId,
    inspectorTargetId,
    refreshWorkspaceData,
    setDismissedPeekNodeId,
    setInspectorDirty,
    setInspectorEditableSourceOverride,
    setInspectorPanelMode,
    setInspectorSourceVersion,
    setLastActivity,
    setLastEdit,
    setRevealedSource,
    surfaceRecoveryEvents,
  });

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

  const effectiveBackendStatus = backendStatusQuery.data
    ? {
        ...(overviewQuery.data?.backend ?? {}),
        ...backendStatusQuery.data,
      }
    : overviewQuery.data?.backend;

  useEffect(() => {
    if (!repoSession) {
      resetInspectorSourceState();
      setDismissedPeekNodeId(undefined);
      setCreateModeState("inactive");
      setCreateComposer(undefined);
      setCreateModeError(null);
      resetFlowDraftState();
      setPendingCreatedNodeId(undefined);
      resetBackendUndoHistory();
    }
  }, [repoSession, resetBackendUndoHistory, resetFlowDraftState, resetInspectorSourceState]);

  useEffect(() => {
    resetBackendUndoHistory();
    setInspectorDraftStale(false);
  }, [repoSession?.id, resetBackendUndoHistory, setInspectorDraftStale]);

  const {
    activeWorkspaceFile,
    activeWorkspaceFilePath,
    createWorkspaceEntry,
    deleteWorkspaceEntry,
    handleCancelWorkspaceFileEdit,
    handleCloseWorkspaceFileEditor,
    isSavingWorkspaceFile,
    moveWorkspaceEntry,
    resetWorkspaceFileState,
    saveWorkspaceFile,
    selectWorkspaceFile,
    setActiveWorkspaceFilePath,
    setWorkspaceFileDraft,
    setWorkspaceFileSaveError,
    setWorkspaceFileStale,
    workspaceFileDirty,
    workspaceFileDraft,
    workspaceFileError,
    workspaceFileQuery,
    workspaceFileSaveError,
    workspaceFileStale,
  } = useWorkspaceFileOperations({
    adapter,
    currentModulePath,
    focusGraph,
    inspectorSourcePath,
    queryClient,
    recordBackendUndoTransaction,
    repoSession,
    selectedFilePath,
    surfaceRecoveryEvents,
    workspaceEntries: workspaceFilesQuery.data?.entries,
  });

  useEffect(() => {
    if (!repoSession) {
      resetWorkspaceFileState();
    }
  }, [repoSession, resetWorkspaceFileState]);

  useEffect(() => {
    resetWorkspaceFileState();
  }, [repoSession?.id, resetWorkspaceFileState]);

  useWorkspaceSyncEffects({
    activeNodeId,
    activeWorkspaceFilePath,
    adapter,
    breadcrumbs: effectiveGraph?.breadcrumbs,
    focusGraph,
    graphTargetId,
    inspectorDirty,
    inspectorSourcePath,
    inspectorTargetId,
    queryClient,
    repoSessionPath: repoSession?.path,
    selectNode,
    setInspectorDraftStale,
    setInspectorEditableSourceOverride,
    setInspectorSnapshot,
    setInspectorTargetId,
    setWorkspaceFileStale,
    workspaceFileDirty,
  });

  const inspectorDraftTargetId = effectiveEditableSource?.editable
    ? effectiveEditableSource.targetId
    : undefined;

  const {
    handleClearGraphSelection,
    handleGraphActivateNode,
    handleGraphInspectNode,
    handleGraphPathItemClick,
    handleGraphSelectNode,
    handleNavigateGraphOut,
    handleOpenBlueprint,
    handleOpenExplorerPathInDefaultEditor,
    handleOpenInDefaultEditor,
    handleOpenNodeInDefaultEditor,
    handleRevealExplorerPath,
    handleRevealNodeInFileExplorer,
    handleSelectBreadcrumb,
    handleSelectLevel,
    requestClearSelectionState,
    selectOverviewModule,
    selectOverviewSymbol,
    selectSidebarResult,
  } = useGraphNavigation({
    activeGraphSymbolId,
    activeLevel,
    adapter,
    dismissedPeekNodeId,
    effectiveGraph,
    focusGraph,
    graphTargetId,
    inspectorDirty,
    inspectorDraftContentRef,
    inspectorDraftStale,
    inspectorDraftTargetId,
    inspectorPanelMode,
    repoSession,
    returnExpressionGraphView,
    saveInspectorDraftRef,
    selectNode,
    selectSearchResult,
    setActiveWorkspaceFilePath,
    setDismissedPeekNodeId,
    setGraphPathRevealError,
    setInspectorActionError,
    setInspectorDirty,
    setInspectorDraftStale,
    setInspectorEditableSourceOverride,
    setInspectorPanelMode,
    setInspectorSnapshot,
    setInspectorSourceVersion,
    setInspectorTargetId,
    setReturnExpressionGraphView,
    setRevealedSource,
    setSidebarQuery,
  });

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
    surfaceRecoveryEvents(result.recoveryEvents);
    recordBackendUndoTransaction(result.undoTransaction, result.summary);
    setInspectorPanelMode("expanded");
    setLastEdit(result);
    setRevealedSource(undefined);
    setInspectorDirty(false);
    setInspectorDraftStale(false);
    inspectorDraftContentRef.current = undefined;
    if (!options?.preserveView) {
      setInspectorEditableSourceOverride(undefined);
      setInspectorSourceVersion((current) => current + 1);
    }
    await invalidateWorkspaceDataQueries(queryClient, { includeEditableSource: true });

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
        nextFocusTarget = {
          targetId: renamedSymbolTarget,
          level: "symbol",
          pinInspectorTarget: true,
        };
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
      (request.kind === "add_import" || request.kind === "remove_import") &&
      request.relativePath
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
      setInspectorTargetId(
        nextFocusTarget.pinInspectorTarget ? nextFocusTarget.targetId : undefined,
      );
      focusGraph(nextFocusTarget.targetId, nextFocusTarget.level);
      return result;
    }
    if (graphTargetId) {
      focusGraph(graphTargetId, activeLevel);
    }
    return result;
  };

  const handleDeleteSymbolNode = useCallback(
    (nodeId: string) => {
      const node = effectiveGraph?.nodes.find((candidate) => candidate.id === nodeId);
      if (!node || !isGraphSymbolNodeKind(node.kind)) {
        return;
      }

      const deleteAction = node.availableActions.find(
        (action) => action.actionId === "delete_symbol",
      );
      if (!deleteAction?.enabled) {
        setInspectorTargetId(node.id);
        setInspectorSnapshot(node);
        setInspectorPanelMode("expanded");
        setInspectorActionError(
          deleteAction?.reason ?? "This symbol cannot be deleted from the graph.",
        );
        return;
      }

      if (isSavingSource || inspectorDraftStale || inspectorDirty) {
        setInspectorTargetId(node.id);
        setInspectorSnapshot(node);
        setInspectorPanelMode("expanded");
        setInspectorActionError("Save or cancel inline source edits before deleting a symbol.");
        return;
      }

      if (
        !window.confirm(
          `Delete ${node.label}? This removes the declaration from the current module.`,
        )
      ) {
        return;
      }

      setInspectorActionError(null);
      void handleApplyEdit({
        kind: "delete_symbol",
        targetId: node.id,
      }).catch((reason) => {
        setInspectorTargetId(node.id);
        setInspectorSnapshot(node);
        setInspectorPanelMode("expanded");
        setInspectorActionError(
          reason instanceof Error ? reason.message : "Unable to delete the selected symbol.",
        );
      });
    },
    [effectiveGraph, handleApplyEdit, inspectorDirty, inspectorDraftStale, isSavingSource],
  );

  const handleSaveNodeSource = async (targetId: string, content: string) => {
    if (inspectorDraftStale) {
      throw new Error(
        "This draft is stale because the file changed outside H.E.L.M. Reload from disk before saving again.",
      );
    }

    setIsSavingSource(true);
    try {
      const result = await adapter.saveNodeSource(targetId, content);
      surfaceRecoveryEvents(result.recoveryEvents);
      recordBackendUndoTransaction(result.undoTransaction, result.summary);
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

  const handleSaveInspectorDraft = useCallback(async (targetId: string, draftContent: string) => {
    await saveInspectorDraftRef.current(targetId, draftContent);
  }, []);

  const structuralDestinationModulePaths = useMemo(
    () => overviewQuery.data?.modules.map((module) => module.relativePath) ?? [],
    [overviewQuery.data?.modules],
  );
  const flowOwnerKind = flowOwnerSymbolQuery.data?.kind;
  const flowCreateEnabled =
    activeLevel === "flow" &&
    (flowOwnerKind === "function" ||
      flowOwnerKind === "async_function" ||
      flowOwnerKind === "method" ||
      flowOwnerKind === "async_method");
  const flowEditable =
    flowCreateEnabled &&
    (effectiveGraph?.flowState?.editable ?? activeFlowDraft?.document.editable ?? false);
  const flowDraftBackedCreateEnabled = flowEditable && Boolean(activeFlowDraft?.document);
  const createModeCanvasEnabled =
    activeLevel === "repo" ||
    ((activeLevel === "module" || activeLevel === "symbol") && Boolean(currentModulePath)) ||
    flowDraftBackedCreateEnabled;
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
            ? "Click empty canvas to create a flow node in this draft."
            : "Create mode only writes inside function or method flows in v1.";
  const createModeContextKey = [
    activeLevel,
    graphTargetId ?? "",
    currentModulePath ?? "",
    flowOwnerKind ?? "",
  ].join("|");
  const createModeSupported =
    activeLevel === "repo" ||
    ((activeLevel === "module" || activeLevel === "symbol") && Boolean(currentModulePath)) ||
    flowDraftBackedCreateEnabled;

  const handleExitCreateMode = useCallback(() => {
    setCreateComposer(undefined);
    setCreateModeError(null);
    setReturnExpressionGraphView(undefined);
    setCreateModeState("inactive");
  }, []);

  const handleOpenCreateComposer = useCallback(
    (intent: GraphCreateIntent) => {
      setCreateModeError(null);
      setReturnExpressionGraphView(undefined);
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

      if (activeLevel === "flow" && flowDraftBackedCreateEnabled) {
        setCreateComposer({
          id: `${Date.now()}:flow`,
          kind: "flow",
          mode: "create",
          anchor: composerAnchor,
          flowPosition: intent.flowPosition,
          ownerLabel: flowOwnerSymbolQuery.data?.qualname ?? effectiveGraph?.focus?.label ?? "Flow",
          initialFlowNodeKind: "assign",
          initialPayload: { source: "" },
          seedFlowConnection: intent.seedFlowConnection,
        });
        setCreateModeState("composing");
      }
    },
    [
      activeLevel,
      currentModulePath,
      flowDraftBackedCreateEnabled,
      flowOwnerSymbolQuery.data?.qualname,
      effectiveGraph?.focus?.label,
    ],
  );

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
    setReturnExpressionGraphView(undefined);
    setCreateModeState("active");
  }, [createModeState, createModeSupported, handleExitCreateMode, requestClearSelectionState]);

  const seedCreatedNodeLayout = useCallback(
    async (
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
        peekStoredGraphLayout(repoSession.path, viewKey) ??
        (await readStoredGraphLayout(repoSession.path, viewKey));
      nextLayout.nodes[graphLayoutNodeKey(nodeId, nodeKind)] = {
        x: composerState.flowPosition.x,
        y: composerState.flowPosition.y,
      };
      void writeStoredGraphLayout(repoSession.path, viewKey, nextLayout);
    },
    [activeLevel, graphTargetId, repoSession?.path],
  );

  const {
    ensureFlowDraftForDocument,
    handleAddFlowFunctionInput,
    handleConnectFlowEdge,
    handleDeleteFlowSelection,
    handleDisconnectFlowEdge,
    handleMoveFlowFunctionInput,
    handleReconnectFlowEdge,
    handleReturnExpressionGraphChange,
    handleUpdateFlowFunctionInput,
    markActiveFlowDraftError,
    removeFlowFunctionInputWithConfirmation,
    submitFlowComposerMutation,
  } = useFlowDraftMutationCallbacks({
    activeFlowDraft,
    adapter,
    applyStructuralEdit: handleApplyEdit,
    effectiveGraph,
    graphDataUpdatedAt: graphQuery.dataUpdatedAt,
    graphTargetId,
    inspectorSourceTarget,
    queryClient,
    repoSessionId: repoSession?.id,
    requestClearSelectionState,
    returnExpressionGraphView,
    selectNode,
    setCreateModeError,
    setFlowDraftState,
    setInspectorActionError,
    setInspectorEditableSourceOverride,
    setInspectorSourceVersion,
    setIsSubmittingExpressionGraph,
    setReturnExpressionGraphView,
    syncFlowDraftLayout,
  });

  saveInspectorDraftRef.current = async (targetId: string, draftContent: string) => {
    await handleSaveNodeSource(targetId, draftContent);
  };

  const handleCreateSubmit = useCallback(
    async (payload: GraphCreateComposerSubmit) => {
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
          (payload.kind === "flow" || payload.kind === "flow_param") &&
          createComposer.kind === "flow" &&
          graphTargetId?.startsWith("symbol:")
        ) {
          const flowResult = await submitFlowComposerMutation(payload, createComposer);
          if (flowResult.kind === "flow_param") {
            if (flowResult.createdParamNodeId) {
              setFlowInputDisplayMode("param_nodes");
              selectNode(flowResult.createdParamNodeId);
              setPendingCreatedNodeId(flowResult.createdParamNodeId);
            }
            setCreateComposer(undefined);
            setCreateModeState("active");
            return;
          }

          if (flowResult.kind === "flow_edit") {
            setCreateComposer(undefined);
            setCreateModeState(resumeCreateMode ? "active" : "inactive");
            return;
          }

          setPendingCreatedNodeId(undefined);
          setCreateComposer(undefined);
          setCreateModeState("active");
          return;
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
          reason instanceof Error
            ? reason.message
            : "Unable to create from the current graph context.";
        setCreateModeError(message);
        if (
          (payload.kind === "flow" || payload.kind === "flow_param") &&
          graphTargetId?.startsWith("symbol:")
        ) {
          markActiveFlowDraftError(graphTargetId, message);
        }
      } finally {
        setIsSubmittingCreate(false);
      }
    },
    [
      activeLevel,
      createComposer,
      createModeState,
      focusGraph,
      graphTargetId,
      handleApplyEdit,
      markActiveFlowDraftError,
      seedCreatedNodeLayout,
      selectNode,
      setFlowInputDisplayMode,
      submitFlowComposerMutation,
    ],
  );

  const handleOpenFlowEditComposer = useCallback(
    (intent: GraphFlowEditIntent) => {
      if (
        activeLevel !== "flow" ||
        !graphTargetId?.startsWith("symbol:") ||
        activeFlowDraft?.symbolId !== graphTargetId ||
        !activeFlowDraft.document.editable
      ) {
        return;
      }

      const targetNode = activeFlowDraft.document.nodes.find((node) => node.id === intent.nodeId);
      if (!targetNode || !isFlowNodeAuthorableKind(targetNode.kind)) {
        return;
      }

      setCreateModeError(null);
      setReturnExpressionGraphView(undefined);
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
        initialLoopType: intent.initialLoopType,
      });
      if (createModeState === "active") {
        setCreateModeState("composing");
      }
    },
    [
      activeFlowDraft,
      activeLevel,
      createModeState,
      effectiveGraph?.focus?.label,
      flowDraftBackedCreateEnabled,
      flowOwnerSymbolQuery.data?.qualname,
      graphTargetId,
    ],
  );

  const handleOpenExpressionGraphEditor = useCallback(
    (intent: GraphExpressionGraphIntent) => {
      const draftDocument =
        activeFlowDraft && activeFlowDraft.symbolId === graphTargetId
          ? activeFlowDraft.document
          : flowDraftSeedDocument?.symbolId === graphTargetId
            ? flowDraftSeedDocument
            : undefined;

      if (
        activeLevel !== "flow" ||
        !graphTargetId?.startsWith("symbol:") ||
        !draftDocument?.editable
      ) {
        return;
      }

      const targetNode = draftDocument.nodes.find(
        (node) => node.id === intent.nodeId && node.kind === "return",
      );
      if (!targetNode) {
        return;
      }

      if (activeFlowDraft?.symbolId !== graphTargetId) {
        ensureFlowDraftForDocument(graphTargetId, draftDocument);
      }
      setCreateComposer(undefined);
      setCreateModeError(null);
      selectNode(targetNode.id);
      const expressionGraph = normalizeExpressionGraphOrEmpty(
        targetNode.payload.expression_graph as FlowExpressionGraph | undefined,
      );
      setReturnExpressionGraphView({
        symbolId: graphTargetId,
        returnNodeId: targetNode.id,
        selectedExpressionNodeId:
          intent.expressionNodeId ?? expressionGraph.rootId ?? expressionGraph.nodes[0]?.id,
        diagnostics: [],
        isDraftOnly: false,
        error: null,
      });
      if (createModeState !== "inactive") {
        setCreateModeState("inactive");
      }
    },
    [
      activeFlowDraft,
      activeLevel,
      createModeState,
      ensureFlowDraftForDocument,
      flowDraftSeedDocument,
      graphTargetId,
      selectNode,
    ],
  );

  const handleExitReturnExpressionGraph = useCallback(() => {
    setReturnExpressionGraphView(undefined);
  }, []);

  const handleSelectReturnExpressionNode = useCallback((nodeId?: string) => {
    setReturnExpressionGraphView((current) =>
      current ? { ...current, selectedExpressionNodeId: nodeId } : current,
    );
  }, []);

  const requestInspectorClose = useCallback(async () => {
    const draftContent = inspectorDraftContentRef.current;
    if (inspectorDirty && inspectorDraftTargetId && draftContent !== undefined) {
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
            await handleSaveInspectorDraft(inspectorDraftTargetId, draftContent);
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
    inspectorDraftTargetId,
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

  const titleCopy = useMemo(() => {
    if (returnExpressionGraphView) {
      return "Return graph";
    }
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
  }, [activeLevel, returnExpressionGraphView]);
  const graphPathItems = useMemo(() => {
    const baseItems = effectiveGraph
      ? buildGraphPathItems(effectiveGraph)
      : buildFallbackGraphPathItems(
          repoSession
            ? {
                id: repoSession.id,
                name: repoSession.name,
                path: repoSession.path,
              }
            : undefined,
          graphTargetId,
          activeLevel,
          overviewQuery.data?.modules ?? [],
        );
    if (!returnExpressionGraphView) {
      return baseItems;
    }
    return [
      ...baseItems,
      {
        key: `return-expression:${returnExpressionGraphView.returnNodeId}`,
        label: "return",
      },
    ];
  }, [
    activeLevel,
    effectiveGraph,
    graphTargetId,
    overviewQuery.data?.modules,
    repoSession,
    returnExpressionGraphView,
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
        event.key !== "Escape" ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
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
    if (
      !pendingCreatedNodeId ||
      !effectiveGraph?.nodes.some((node) => node.id === pendingCreatedNodeId)
    ) {
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
    effectiveGraph?.focus?.label ??
    graphPathItems[graphPathItems.length - 1]?.label ??
    repoSession?.name ??
    "Inspector";
  const graphContextSubtitle = effectiveGraph?.focus?.subtitle ?? (graphContextPath || titleCopy);
  const inspectorSummaryText = selectionSummary(effectiveInspectorNode);
  const drawerTitle = effectiveInspectorNode?.label ?? graphContextTitle;
  const drawerSubtitle = effectiveInspectorNode
    ? inspectorSummaryText && inspectorSummaryText !== effectiveInspectorNode.label
      ? inspectorSummaryText
      : graphContextSubtitle
    : graphContextSubtitle;
  const drawerActionNode =
    activeLevel === "flow" &&
    selectedGraphNode &&
    (isEnterableGraphNodeKind(selectedGraphNode.kind) ||
      isInspectableGraphNodeKind(selectedGraphNode.kind))
      ? selectedGraphNode
      : effectiveInspectorNode;
  const drawerNodePath =
    relativePathForNode(drawerActionNode) ??
    (drawerActionNode?.subtitle?.endsWith(".py") ? drawerActionNode.subtitle : undefined);
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
        label:
          revealedSource?.targetId === drawerActionNode.id ? "Refresh source" : "Reveal source",
        helpId: "inspector.reveal-source",
        onClick: () => {
          void handleRevealSource(drawerActionNode.id);
        },
      });
    }
  }

  const handleWorkspaceKeyDownCapture = (event: ReactKeyboardEvent<HTMLElement>) => {
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

  useEffect(() => {
    setGraphPathRevealError(null);
  }, [activeLevel, graphTargetId]);

  return (
    <DesktopWindow
      eyebrow="Blueprint Editor"
      title={repoSession?.name ?? "H.E.L.M."}
      subtitle={workspaceWindowSubtitle(repoSession?.path, effectiveBackendStatus)}
      actions={<AppWindowActions />}
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
              workspaceFiles={workspaceFilesQuery.data}
              sidebarQuery={sidebarQuery}
              searchResults={sidebarSearchQuery.data ?? []}
              isSearching={sidebarSearchQuery.isFetching}
              selectedFilePath={
                activeWorkspaceFilePath ??
                selectedFilePath ??
                inspectorSourcePath ??
                graphNodeRelativePath(inspectorNode?.metadata, inspectorNode?.subtitle)
              }
              selectedNodeId={activeNodeId}
              onSidebarQueryChange={setSidebarQuery}
              onSelectResult={selectSidebarResult}
              onSelectModule={selectOverviewModule}
              onSelectSymbol={selectOverviewSymbol}
              onSelectWorkspaceFile={selectWorkspaceFile}
              onCreateWorkspaceEntry={createWorkspaceEntry}
              onMoveWorkspaceEntry={moveWorkspaceEntry}
              onDeleteWorkspaceEntry={(relativePath) => deleteWorkspaceEntry({ relativePath })}
              onFocusRepoGraph={() => {
                setActiveWorkspaceFilePath(undefined);
                if (repoSession) {
                  focusGraph(repoSession.id, "repo");
                }
              }}
              onReindexRepo={reindexCurrentRepo}
              onOpenRepo={openAndIndexRepo}
              onOpenPathInDefaultEditor={handleOpenExplorerPathInDefaultEditor}
              onRevealPathInFileExplorer={handleRevealExplorerPath}
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
              {repoOpenError ? (
                <p className="error-copy graph-stage__error">{repoOpenError}</p>
              ) : null}
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
                          item.key.startsWith("module:") || item.key.startsWith("fallback-module:")
                            ? "graph.path.file"
                            : item.breadcrumb?.level === "repo"
                              ? "graph.path.repo"
                              : item.breadcrumb?.level === "symbol"
                                ? "graph.path.symbol"
                                : item.breadcrumb?.level === "flow"
                                  ? "graph.path.flow"
                                  : undefined;
                        const itemClassName = `graph-location__button${
                          item.revealPath ? " graph-location__button--revealable" : ""
                        }${isCurrent ? " is-current" : ""}`;

                        return (
                          <div key={item.key} className="graph-location__item">
                            {index > 0 ? (
                              <span aria-hidden="true" className="graph-location__separator">
                                /
                              </span>
                            ) : null}

                            {item.breadcrumb ? (
                              <button
                                {...helpTargetProps(itemHelpId ?? "graph.path.symbol", {
                                  label: item.label,
                                })}
                                aria-current={isCurrent ? "page" : undefined}
                                className={itemClassName}
                                type="button"
                                title={
                                  item.revealPath
                                    ? "Click to navigate. Cmd/Ctrl-click to reveal in Finder/Explorer."
                                    : "Click to navigate."
                                }
                                onClick={(event) => handleGraphPathItemClick(event, item)}
                              >
                                {item.label}
                              </button>
                            ) : (
                              <span
                                {...helpTargetProps(
                                  itemHelpId ??
                                    (isCurrent && activeLevel === "flow"
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
                    {graphPathRevealError ? (
                      <p className="error-copy">{graphPathRevealError}</p>
                    ) : null}
                  </div>
                ) : null}
              </div>

              <div className="blueprint-main__body">
                <div
                  className={`blueprint-graph-shell blueprint-graph-shell--${effectiveInspectorDrawerMode}`}
                  data-inspector-mode={effectiveInspectorDrawerMode}
                >
                  <div className="blueprint-graph-shell__canvas">
                    {returnExpressionGraphView && returnExpressionGraphViewNode ? (
                      <FlowExpressionGraphCanvas
                        diagnostics={returnExpressionGraphView.diagnostics}
                        error={returnExpressionGraphView.error}
                        expression={returnExpressionGraphViewExpression}
                        graph={returnExpressionGraphViewGraph}
                        inputSlots={returnExpressionGraphViewInputSlots}
                        isDraftOnly={returnExpressionGraphView.isDraftOnly}
                        isSaving={isSubmittingExpressionGraph}
                        ownerLabel={
                          flowOwnerSymbolQuery.data?.qualname ??
                          effectiveGraph?.focus?.label ??
                          "Return"
                        }
                        selectedExpressionNodeId={
                          returnExpressionGraphView.selectedExpressionNodeId
                        }
                        onGraphChange={handleReturnExpressionGraphChange}
                        onNavigateOut={handleExitReturnExpressionGraph}
                        onSelectExpressionNode={handleSelectReturnExpressionNode}
                      />
                    ) : (
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
                        flowInputDisplayMode={flowInputDisplayMode}
                        highlightGraphPath={highlightGraphPath}
                        showEdgeLabels={showEdgeLabels}
                        onSelectNode={handleGraphSelectNode}
                        onActivateNode={handleGraphActivateNode}
                        onInspectNode={handleGraphInspectNode}
                        onOpenNodeInDefaultEditor={handleOpenNodeInDefaultEditor}
                        onRevealNodeInFileExplorer={handleRevealNodeInFileExplorer}
                        onSelectBreadcrumb={handleSelectBreadcrumb}
                        onSelectLevel={handleSelectLevel}
                        onToggleGraphFilter={toggleGraphFilter}
                        onToggleGraphSetting={toggleGraphSetting}
                        onSetFlowInputDisplayMode={setFlowInputDisplayMode}
                        onToggleGraphPathHighlight={toggleGraphPathHighlight}
                        onToggleEdgeLabels={toggleEdgeLabels}
                        onNavigateOut={handleNavigateGraphOut}
                        onClearSelection={() => void handleClearGraphSelection()}
                        createModeState={createModeState}
                        createModeCanvasEnabled={createModeCanvasEnabled}
                        createModeHint={createModeHint}
                        onToggleCreateMode={() => {
                          void handleToggleCreateMode();
                        }}
                        onCreateIntent={handleOpenCreateComposer}
                        onEditFlowNodeIntent={handleOpenFlowEditComposer}
                        onOpenExpressionGraphIntent={handleOpenExpressionGraphEditor}
                        onConnectFlowEdge={handleConnectFlowEdge}
                        onReconnectFlowEdge={handleReconnectFlowEdge}
                        onDisconnectFlowEdge={handleDisconnectFlowEdge}
                        onDeleteFlowSelection={handleDeleteFlowSelection}
                        onDeleteSymbolNode={handleDeleteSymbolNode}
                      />
                    )}
                    {createComposer && !returnExpressionGraphView ? (
                      <GraphCreateComposer
                        key={createComposer.id}
                        composer={createComposer}
                        error={createModeError}
                        isSubmitting={isSubmittingCreate}
                        onCancel={() => {
                          setCreateComposer(undefined);
                          setCreateModeError(null);
                          setCreateModeState((current) =>
                            current === "composing" ? "active" : current,
                          );
                        }}
                        onSubmit={handleCreateSubmit}
                      />
                    ) : null}
                  </div>

                  {activeWorkspaceFilePath ? (
                    <WorkspaceFileEditorPanel
                      file={activeWorkspaceFile}
                      draft={workspaceFileDraft}
                      dirty={workspaceFileDirty}
                      stale={workspaceFileStale}
                      error={workspaceFileError}
                      isLoading={workspaceFileQuery.isFetching && !activeWorkspaceFile}
                      isSaving={isSavingWorkspaceFile}
                      saveError={workspaceFileSaveError}
                      onCancel={handleCancelWorkspaceFileEdit}
                      onChange={(content) => {
                        setWorkspaceFileDraft(content);
                        setWorkspaceFileSaveError(null);
                      }}
                      onClose={handleCloseWorkspaceFileEditor}
                      onSave={() => {
                        void saveWorkspaceFile();
                      }}
                    />
                  ) : null}

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
                          key={`inspector:${inspectorSelectionNode?.id ?? "none"}:${inspectorSourceTarget?.targetId ?? "no-source"}:${inspectorSourceVersion}`}
                          selectedNode={inspectorSelectionNode}
                          sourceContextNode={inspectorSourceTarget?.node}
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
                          flowFunctionInputs={activeFlowDraft?.document.functionInputs ?? []}
                          flowInputDisplayMode={flowInputDisplayMode}
                          flowInputsEditable={Boolean(activeFlowDraft?.document.editable)}
                          onApplyStructuralEdit={handleApplyEdit}
                          onAddFlowFunctionInput={handleAddFlowFunctionInput}
                          onUpdateFlowFunctionInput={handleUpdateFlowFunctionInput}
                          onMoveFlowFunctionInput={handleMoveFlowFunctionInput}
                          onRemoveFlowFunctionInput={removeFlowFunctionInputWithConfirmation}
                          onOpenNodeInDefaultEditor={handleOpenNodeInDefaultEditor}
                          onRevealNodeInFileExplorer={handleRevealNodeInFileExplorer}
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
