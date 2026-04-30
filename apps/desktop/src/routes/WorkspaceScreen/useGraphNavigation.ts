import { useCallback } from "react";
import type {
  Dispatch,
  MouseEvent as ReactMouseEvent,
  MutableRefObject,
  SetStateAction,
} from "react";
import type {
  DesktopAdapter,
  EditableNodeSource,
  GraphAbstractionLevel,
  GraphBreadcrumbDto,
  GraphNodeDto,
  GraphNodeKind,
  GraphView,
  OverviewModule,
  RepoSession,
  RevealedSource,
  SearchResult,
} from "../../lib/adapter";
import { isEnterableGraphNodeKind, isInspectableGraphNodeKind } from "../../lib/adapter";
import type { GraphPathItem, InspectorPanelMode, ReturnExpressionGraphViewState } from "./types";
import { moduleIdFromSymbolId } from "./workspaceScreenModel";

export function useGraphNavigation({
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
}: {
  activeGraphSymbolId?: string;
  activeLevel: GraphAbstractionLevel;
  adapter: DesktopAdapter;
  dismissedPeekNodeId?: string;
  effectiveGraph?: GraphView;
  focusGraph: (nodeId: string, level: GraphAbstractionLevel) => void;
  graphTargetId?: string;
  inspectorDirty: boolean;
  inspectorDraftContentRef: MutableRefObject<string | undefined>;
  inspectorDraftStale: boolean;
  inspectorDraftTargetId?: string;
  inspectorPanelMode: InspectorPanelMode;
  repoSession?: RepoSession;
  returnExpressionGraphView?: ReturnExpressionGraphViewState;
  saveInspectorDraftRef: MutableRefObject<
    (targetId: string, draftContent: string) => Promise<void>
  >;
  selectNode: (nodeId?: string) => void;
  selectSearchResult: (result: SearchResult) => void;
  setActiveWorkspaceFilePath: (path?: string) => void;
  setDismissedPeekNodeId: (nodeId?: string) => void;
  setGraphPathRevealError: (error: string | null) => void;
  setInspectorActionError: (error: string | null) => void;
  setInspectorDirty: (dirty: boolean) => void;
  setInspectorDraftStale: (stale: boolean) => void;
  setInspectorEditableSourceOverride: (source?: EditableNodeSource) => void;
  setInspectorPanelMode: Dispatch<SetStateAction<InspectorPanelMode>>;
  setInspectorSnapshot: (node?: GraphNodeDto) => void;
  setInspectorSourceVersion: Dispatch<SetStateAction<number>>;
  setInspectorTargetId: (targetId?: string) => void;
  setReturnExpressionGraphView: Dispatch<
    SetStateAction<ReturnExpressionGraphViewState | undefined>
  >;
  setRevealedSource: (source?: RevealedSource) => void;
  setSidebarQuery: (query: string) => void;
}) {
  const selectSidebarResult = useCallback(
    (result: SearchResult) => {
      setActiveWorkspaceFilePath(undefined);
      selectSearchResult(result);
      setSidebarQuery("");
      if (result.level && result.nodeId) {
        focusGraph(result.nodeId, result.level);
      }
    },
    [focusGraph, selectSearchResult, setActiveWorkspaceFilePath, setSidebarQuery],
  );

  const selectOverviewModule = useCallback(
    (module: OverviewModule) => {
      setActiveWorkspaceFilePath(undefined);
      focusGraph(module.moduleId, "module");
    },
    [focusGraph, setActiveWorkspaceFilePath],
  );

  const selectOverviewSymbol = useCallback(
    (nodeId: string) => {
      setActiveWorkspaceFilePath(undefined);
      focusGraph(nodeId, "symbol");
    },
    [focusGraph, setActiveWorkspaceFilePath],
  );

  const handleGraphSelectNode = useCallback(
    (nodeId: string, kind: GraphNodeKind) => {
      selectNode(nodeId);
      if (dismissedPeekNodeId === nodeId) {
        setDismissedPeekNodeId(undefined);
      }

      if (
        inspectorPanelMode !== "hidden" &&
        activeLevel !== "flow" &&
        (isEnterableGraphNodeKind(kind) || isInspectableGraphNodeKind(kind))
      ) {
        const node = effectiveGraph?.nodes.find((candidate) => candidate.id === nodeId);
        if (node) {
          setInspectorTargetId(nodeId);
          setInspectorSnapshot(node);
        }
      }
    },
    [
      activeLevel,
      dismissedPeekNodeId,
      effectiveGraph,
      inspectorPanelMode,
      selectNode,
      setDismissedPeekNodeId,
      setInspectorSnapshot,
      setInspectorTargetId,
    ],
  );

  const handleGraphActivateNode = useCallback(
    (nodeId: string, kind: GraphNodeKind) => {
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
    },
    [
      effectiveGraph,
      focusGraph,
      selectNode,
      setDismissedPeekNodeId,
      setInspectorPanelMode,
      setInspectorSnapshot,
      setInspectorTargetId,
      setRevealedSource,
    ],
  );

  const handleGraphInspectNode = useCallback(
    (nodeId: string, kind: GraphNodeKind) => {
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
    },
    [
      activeLevel,
      effectiveGraph,
      inspectorPanelMode,
      selectNode,
      setDismissedPeekNodeId,
      setInspectorPanelMode,
      setInspectorSnapshot,
      setInspectorTargetId,
    ],
  );

  const handleSelectBreadcrumb = useCallback(
    (breadcrumb: GraphBreadcrumbDto) => {
      if (breadcrumb.level === "flow") {
        setReturnExpressionGraphView(undefined);
        if (activeGraphSymbolId) {
          focusGraph(activeGraphSymbolId, "flow");
        }
        return;
      }
      setReturnExpressionGraphView(undefined);
      focusGraph(breadcrumb.nodeId, breadcrumb.level);
    },
    [activeGraphSymbolId, focusGraph, setReturnExpressionGraphView],
  );

  const handleSelectLevel = useCallback(
    (level: GraphAbstractionLevel) => {
      if (!effectiveGraph) {
        return;
      }

      setReturnExpressionGraphView(undefined);

      if (level === "repo" && repoSession) {
        focusGraph(repoSession.id, "repo");
        return;
      }

      if (level === "module") {
        const moduleBreadcrumb = [...effectiveGraph.breadcrumbs]
          .reverse()
          .find((breadcrumb) => breadcrumb.level === "module");
        focusGraph(
          moduleBreadcrumb?.nodeId ?? repoSession?.id ?? effectiveGraph.targetId,
          "module",
        );
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
    },
    [activeGraphSymbolId, effectiveGraph, focusGraph, repoSession, setReturnExpressionGraphView],
  );

  const handleNavigateGraphOut = useCallback(() => {
    if (!repoSession) {
      return;
    }

    if (returnExpressionGraphView) {
      setReturnExpressionGraphView(undefined);
      return;
    }

    if (activeLevel === "flow") {
      const symbolTarget = graphTargetId?.startsWith("symbol:")
        ? graphTargetId
        : activeGraphSymbolId;
      if (symbolTarget) {
        focusGraph(symbolTarget, "symbol");
      }
      return;
    }

    if (activeLevel === "symbol") {
      const symbolTarget = graphTargetId?.startsWith("symbol:")
        ? graphTargetId
        : activeGraphSymbolId;
      const moduleTarget =
        (symbolTarget ? moduleIdFromSymbolId(symbolTarget) : undefined) ??
        [...(effectiveGraph?.breadcrumbs ?? [])]
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
  }, [
    activeGraphSymbolId,
    activeLevel,
    effectiveGraph?.breadcrumbs,
    focusGraph,
    graphTargetId,
    repoSession,
    returnExpressionGraphView,
    setReturnExpressionGraphView,
  ]);

  const handleOpenBlueprint = useCallback(
    (symbolId: string) => {
      setInspectorActionError(null);
      setInspectorTargetId(symbolId);
      focusGraph(symbolId, "symbol");
    },
    [focusGraph, setInspectorActionError, setInspectorTargetId],
  );

  const handleOpenInDefaultEditor = useCallback(
    async (targetId: string) => {
      setInspectorActionError(null);
      try {
        await adapter.openNodeInDefaultEditor(targetId);
      } catch (reason) {
        setInspectorActionError(
          reason instanceof Error
            ? reason.message
            : "Unable to open the file in the default editor.",
        );
      }
    },
    [adapter, setInspectorActionError],
  );

  const handleOpenNodeInDefaultEditor = useCallback(
    (targetId: string) => adapter.openNodeInDefaultEditor(targetId),
    [adapter],
  );

  const handleRevealNodeInFileExplorer = useCallback(
    (targetId: string) => adapter.revealNodeInFileExplorer(targetId),
    [adapter],
  );

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
  }, [
    inspectorDraftContentRef,
    selectNode,
    setDismissedPeekNodeId,
    setInspectorDirty,
    setInspectorDraftStale,
    setInspectorEditableSourceOverride,
    setInspectorSnapshot,
    setInspectorSourceVersion,
    setInspectorTargetId,
    setRevealedSource,
  ]);

  const requestClearSelectionState = useCallback(async () => {
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
          "Save your changes before clearing the selection? Click OK to save or Cancel to discard.",
        );
        if (shouldSave) {
          try {
            await saveInspectorDraftRef.current(inspectorDraftTargetId, draftContent);
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
    inspectorDraftContentRef,
    inspectorDraftStale,
    inspectorDraftTargetId,
    saveInspectorDraftRef,
  ]);

  const handleClearGraphSelection = useCallback(async () => {
    await requestClearSelectionState();
  }, [requestClearSelectionState]);

  const handleRevealGraphPath = useCallback(
    async (relativePath: string) => {
      setGraphPathRevealError(null);
      try {
        await adapter.revealPathInFileExplorer(relativePath);
      } catch (reason) {
        setGraphPathRevealError(
          reason instanceof Error
            ? reason.message
            : "Unable to reveal the current path in the system file explorer.",
        );
      }
    },
    [adapter, setGraphPathRevealError],
  );

  const handleRevealExplorerPath = useCallback(
    (relativePath: string) => adapter.revealPathInFileExplorer(relativePath),
    [adapter],
  );

  const handleOpenExplorerPathInDefaultEditor = useCallback(
    (relativePath: string) => adapter.openPathInDefaultEditor(relativePath),
    [adapter],
  );

  const handleGraphPathItemClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>, item: GraphPathItem) => {
      if ((event.metaKey || event.ctrlKey) && item.revealPath) {
        event.preventDefault();
        void handleRevealGraphPath(item.revealPath);
        return;
      }
      if (item.breadcrumb) {
        handleSelectBreadcrumb(item.breadcrumb);
      }
    },
    [handleRevealGraphPath, handleSelectBreadcrumb],
  );

  return {
    clearSelectionState,
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
    handleRevealGraphPath,
    handleRevealNodeInFileExplorer,
    handleSelectBreadcrumb,
    handleSelectLevel,
    requestClearSelectionState,
    selectOverviewModule,
    selectOverviewSymbol,
    selectSidebarResult,
  };
}
