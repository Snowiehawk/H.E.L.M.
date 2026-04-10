import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { CommandPalette } from "../components/CommandPalette";
import { GraphCanvas } from "../components/graph/GraphCanvas";
import { DesktopWindow } from "../components/layout/DesktopWindow";
import { SidebarPane } from "../components/panes/SidebarPane";
import { ThemeCycleButton } from "../components/shared/ThemeCycleButton";
import { BlueprintInspector } from "../components/workspace/BlueprintInspector";
import {
  WorkspaceHelpProvider,
  WorkspaceHelpScope,
  helpTargetProps,
} from "../components/workspace/workspaceHelp";
import { useDesktopAdapter } from "../lib/adapter";
import type {
  GraphAbstractionLevel,
  GraphBreadcrumbDto,
  GraphNodeKind,
  GraphView,
  OverviewModule,
  SearchResult,
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

  if (event.target.closest(".monaco-editor, .monaco-diff-editor")) {
    return false;
  }

  const editableHost = event.target.closest(
    'input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"]',
  );
  if (editableHost instanceof HTMLElement) {
    return false;
  }

  return event.target.closest(".graph-panel") instanceof HTMLElement;
}

interface GraphPathItem {
  key: string;
  label: string;
  breadcrumb?: GraphBreadcrumbDto;
  revealTargetId?: string;
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
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorTargetId, setInspectorTargetId] = useState<string | undefined>(undefined);
  const [inspectorSnapshot, setInspectorSnapshot] = useState<GraphView["nodes"][number]>();
  const [isSavingSource, setIsSavingSource] = useState(false);
  const [inspectorDirty, setInspectorDirty] = useState(false);
  const inspectorDraftContentRef = useRef<string | undefined>(undefined);
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
      setInspectorOpen(false);
      setInspectorTargetId(undefined);
      setInspectorSnapshot(undefined);
      inspectorDraftContentRef.current = undefined;
      setInspectorDirty(false);
    }
  }, [repoSession]);

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
  const symbolQuery = useQuery({
    queryKey: ["symbol", inspectorTargetId],
    queryFn: () => adapter.getSymbol(inspectorTargetId as string),
    enabled: Boolean(inspectorTargetId && inspectorTargetId.startsWith("symbol:")),
  });

  useEffect(() => {
    if (!inspectorTargetId || !graphQuery.data) {
      return;
    }

    const matching = graphQuery.data.nodes.find((node) => node.id === inspectorTargetId);
    if (matching) {
      setInspectorSnapshot(matching);
    }
  }, [graphQuery.data, inspectorTargetId]);

  const inspectorNode = useMemo(() => {
    if (inspectorTargetId) {
      return graphQuery.data?.nodes.find((node) => node.id === inspectorTargetId) ?? inspectorSnapshot;
    }
    if (inspectorOpen && selectedGraphNode) {
      return selectedGraphNode;
    }
    return undefined;
  }, [graphQuery.data, inspectorOpen, inspectorSnapshot, inspectorTargetId, selectedGraphNode]);

  const editableSourceQuery = useQuery({
    queryKey: ["editable-node-source", repoSession?.id, inspectorNode?.id],
    queryFn: () => adapter.getEditableNodeSource(inspectorNode?.id as string),
    enabled: Boolean(inspectorOpen && inspectorNode && isInspectableGraphNodeKind(inspectorNode.kind)),
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

    if (
      inspectorOpen
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
      setInspectorTargetId(nodeId);
      setInspectorOpen(true);
    }
  }, [focusGraph, graphQuery.data, selectNode, setRevealedSource]);

  const handleGraphInspectNode = useCallback((nodeId: string, kind: GraphNodeKind) => {
    if (!isInspectableGraphNodeKind(kind)) {
      return;
    }

    selectNode(nodeId);
    const node = graphQuery.data?.nodes.find((candidate) => candidate.id === nodeId);
    if (node) {
      setInspectorSnapshot(node);
    }
    setInspectorTargetId(nodeId);
    setInspectorOpen(true);
  }, [graphQuery.data, selectNode]);

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
    const source = await adapter.revealSource(nodeId);
    setInspectorOpen(true);
    setRevealedSource(source);
  };

  const handleApplyEdit = async (request: StructuralEditRequest) => {
    const result = await adapter.applyStructuralEdit(request);
    setInspectorOpen(true);
    setLastEdit(result);
    setRevealedSource(undefined);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["overview"] }),
      queryClient.invalidateQueries({ queryKey: ["graph-view"] }),
      queryClient.invalidateQueries({ queryKey: ["symbol"] }),
      queryClient.invalidateQueries({ queryKey: ["workspace-search"] }),
    ]);

    const changedSymbolId = result.changedNodeIds.find((nodeId) => nodeId.startsWith("symbol:"));
    if (changedSymbolId) {
      focusGraph(changedSymbolId, "symbol");
      return;
    }
    const changedModuleId = result.changedNodeIds.find((nodeId) => nodeId.startsWith("module:"));
    if (changedModuleId) {
      focusGraph(changedModuleId, "module");
      return;
    }
    if (graphTargetId) {
      focusGraph(graphTargetId, activeLevel);
    }
  };

  const handleSaveNodeSource = async (targetId: string, content: string) => {
    setIsSavingSource(true);
    try {
      const result = await adapter.saveNodeSource(targetId, content);
      setInspectorOpen(true);
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

  const handleOpenBlueprint = (symbolId: string) => {
    setInspectorTargetId(symbolId);
    focusGraph(symbolId, "symbol");
  };

  const requestInspectorClose = useCallback(async () => {
    const draftContent = inspectorDraftContentRef.current;
    if (inspectorDirty && inspectorTargetId && draftContent !== undefined) {
      const shouldSave = window.confirm(
        "Save your changes before closing the inspector? Click OK to save or Cancel to discard.",
      );
      if (shouldSave) {
        try {
          await handleSaveNodeSource(inspectorTargetId, draftContent);
        } catch {
          return false;
        }
      }
    }

    setInspectorOpen(false);
    setInspectorTargetId(undefined);
    setInspectorSnapshot(undefined);
    inspectorDraftContentRef.current = undefined;
    setInspectorDirty(false);
    setRevealedSource(undefined);
    return true;
  }, [
    handleSaveNodeSource,
    inspectorDirty,
    inspectorTargetId,
    setRevealedSource,
  ]);

  const handleToggleInspector = async () => {
    if (inspectorOpen) {
      await requestInspectorClose();
      return;
    }

    const nextNode = selectedGraphNode ?? inspectorSnapshot;
    if (nextNode) {
      setInspectorTargetId(nextNode.id);
      setInspectorSnapshot(nextNode);
    }
    setInspectorOpen(true);
  };

  const handleClearGraphSelection = async () => {
    if (inspectorOpen) {
      const closed = await requestInspectorClose();
      if (!closed) {
        return;
      }
    }
    selectNode(undefined);
  };

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

  const handleWorkspaceKeyDownCapture = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!shouldNavigateGraphOutFromKeyEvent(event.nativeEvent)) {
      return;
    }

    event.preventDefault();
    handleNavigateGraphOut();
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
          className="workspace-layout workspace-layout--blueprint"
          onKeyDownCapture={handleWorkspaceKeyDownCapture}
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
              {inspectorOpen ? (
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
                  onSaveSource={handleSaveNodeSource}
                  onEditorStateChange={handleInspectorEditorStateChange}
                  onOpenFlow={(symbolId) => {
                    setInspectorTargetId(symbolId);
                    focusGraph(symbolId, "flow");
                  }}
                  onOpenBlueprint={handleOpenBlueprint}
                  onRevealSource={handleRevealSource}
                  onOpenInDefaultEditor={(targetId) => adapter.openNodeInDefaultEditor(targetId)}
                  onDismissSource={() => setRevealedSource(undefined)}
                  onClose={() => void requestInspectorClose()}
                />
              ) : null}

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
                inspectorOpen={inspectorOpen}
                onSelectNode={handleGraphSelectNode}
                onActivateNode={handleGraphActivateNode}
                onInspectNode={handleGraphInspectNode}
                onSelectBreadcrumb={handleSelectBreadcrumb}
                onSelectLevel={handleSelectLevel}
                onToggleGraphFilter={toggleGraphFilter}
                onToggleGraphSetting={toggleGraphSetting}
                onToggleGraphPathHighlight={toggleGraphPathHighlight}
                onToggleEdgeLabels={toggleEdgeLabels}
                onToggleInspector={handleToggleInspector}
                onNavigateOut={handleNavigateGraphOut}
                onClearSelection={() => void handleClearGraphSelection()}
              />
            </div>
          </section>
        </WorkspaceHelpScope>
      </WorkspaceHelpProvider>
      <CommandPalette />
    </DesktopWindow>
  );
}
