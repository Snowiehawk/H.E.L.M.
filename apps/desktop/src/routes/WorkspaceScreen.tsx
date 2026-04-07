import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { CommandPalette } from "../components/CommandPalette";
import { GraphCanvas } from "../components/graph/GraphCanvas";
import { DesktopWindow } from "../components/layout/DesktopWindow";
import { GraphDetailPanel } from "../components/panes/GraphDetailPanel";
import { SidebarPane } from "../components/panes/SidebarPane";
import { ThemeCycleButton } from "../components/shared/ThemeCycleButton";
import { useDesktopAdapter } from "../lib/adapter";
import type { GraphNodeKind, OverviewModule, SearchResult } from "../lib/adapter";
import { useUiStore } from "../store/uiStore";

export function WorkspaceScreen() {
  const adapter = useDesktopAdapter();
  const navigate = useNavigate();
  const [repoOpenError, setRepoOpenError] = useState<string | null>(null);
  const repoSession = useUiStore((state) => state.repoSession);
  const activeTab = useUiStore((state) => state.activeTab);
  const activeFilePath = useUiStore((state) => state.activeFilePath);
  const activeSymbolId = useUiStore((state) => state.activeSymbolId);
  const activeNodeId = useUiStore((state) => state.activeNodeId);
  const graphDepth = useUiStore((state) => state.graphDepth);
  const graphFilters = useUiStore((state) => state.graphFilters);
  const highlightGraphPath = useUiStore((state) => state.highlightGraphPath);
  const sidebarQuery = useUiStore((state) => state.sidebarQuery);
  const setSidebarQuery = useUiStore((state) => state.setSidebarQuery);
  const openFile = useUiStore((state) => state.openFile);
  const openSymbol = useUiStore((state) => state.openSymbol);
  const openGraph = useUiStore((state) => state.openGraph);
  const setSession = useUiStore((state) => state.setSession);
  const selectSearchResult = useUiStore((state) => state.selectSearchResult);
  const expandGraphDepth = useUiStore((state) => state.expandGraphDepth);
  const reduceGraphDepth = useUiStore((state) => state.reduceGraphDepth);
  const toggleGraphFilter = useUiStore((state) => state.toggleGraphFilter);
  const toggleGraphPathHighlight = useUiStore((state) => state.toggleGraphPathHighlight);
  const resetWorkspace = useUiStore((state) => state.resetWorkspace);

  useEffect(() => {
    if (!repoSession) {
      navigate("/", { replace: true });
    }
  }, [navigate, repoSession]);

  useEffect(() => {
    if (repoSession && !activeNodeId) {
      openGraph(repoSession.id);
    }
  }, [activeNodeId, openGraph, repoSession]);

  const overviewQuery = useQuery({
    queryKey: ["overview", repoSession?.id],
    queryFn: () => adapter.getOverview(),
    enabled: Boolean(repoSession),
  });
  const backendStatusQuery = useQuery({
    queryKey: ["backend-status"],
    queryFn: () => adapter.getBackendStatus(),
  });
  const sidebarSearchQuery = useQuery({
    queryKey: ["workspace-search", repoSession?.id, sidebarQuery],
    queryFn: () =>
      adapter.searchRepo(sidebarQuery, {
        includeFiles: true,
        includeSymbols: true,
      }),
    enabled: Boolean(repoSession) && sidebarQuery.trim().length > 0,
  });
  const fileQuery = useQuery({
    queryKey: ["file", activeFilePath],
    queryFn: () => adapter.getFile(activeFilePath as string),
    enabled: Boolean(activeFilePath) && activeTab === "file",
  });
  const symbolQuery = useQuery({
    queryKey: ["symbol", activeSymbolId],
    queryFn: () => adapter.getSymbol(activeSymbolId as string),
    enabled: Boolean(activeSymbolId) && activeTab === "symbol",
  });
  const graphQuery = useQuery({
    queryKey: ["graph", activeNodeId, graphDepth, graphFilters],
    queryFn: () =>
      adapter.getGraphNeighborhood(activeNodeId as string, graphDepth, graphFilters),
    enabled: Boolean(activeNodeId),
  });

  const selectSidebarResult = (result: SearchResult) => {
    selectSearchResult(result);
    setSidebarQuery("");
  };

  const selectOverviewModule = (module: OverviewModule) => {
    openFile(module.relativePath, module.moduleId);
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
    if (kind === "symbol") {
      openSymbol(nodeId, nodeId);
      return;
    }

    if (kind === "module") {
      const module = overviewQuery.data?.modules.find((item) => item.moduleId === nodeId);
      if (module) {
        openFile(module.relativePath, module.moduleId);
        return;
      }
    }

    openGraph(nodeId);
  };

  const selectedGraphNode = graphQuery.data?.nodes.find((node) => node.id === activeNodeId);
  const effectiveBackendStatus = overviewQuery.data?.backend ?? backendStatusQuery.data;

  return (
    <DesktopWindow
      eyebrow="Code Graph"
      title={repoSession?.name ?? "H.E.L.M."}
      subtitle={repoSession?.path ?? "Open a local repository to begin."}
      actions={<ThemeCycleButton />}
      dense
    >
      <main className="workspace-layout">
        <SidebarPane
          backendStatus={effectiveBackendStatus}
          overview={overviewQuery.data}
          sidebarQuery={sidebarQuery}
          searchResults={sidebarSearchQuery.data ?? []}
          isSearching={sidebarSearchQuery.isFetching}
          selectedFilePath={activeFilePath}
          selectedNodeId={activeNodeId}
          onSidebarQueryChange={setSidebarQuery}
          onSelectResult={selectSidebarResult}
          onSelectModule={selectOverviewModule}
          onFocusRepoGraph={() => repoSession && openGraph(repoSession.id)}
          onReindexRepo={reindexCurrentRepo}
          onOpenRepo={openAndIndexRepo}
        />

        <section className="graph-stage">
          {repoOpenError ? <p className="error-copy graph-stage__error">{repoOpenError}</p> : null}
          <GraphCanvas
            graph={graphQuery.data}
            activeNodeId={activeNodeId}
            graphDepth={graphDepth}
            graphFilters={graphFilters}
            highlightGraphPath={highlightGraphPath}
            onSelectNode={handleGraphSelectNode}
            onExpandDepth={expandGraphDepth}
            onReduceDepth={reduceGraphDepth}
            onToggleGraphFilter={toggleGraphFilter}
            onToggleGraphPathHighlight={toggleGraphPathHighlight}
          />

          {activeTab === "file" || activeTab === "symbol" ? (
            <GraphDetailPanel
              activeTab={activeTab}
              file={fileQuery.data}
              symbol={symbolQuery.data}
              selectedNode={selectedGraphNode}
              onOpenFile={openFile}
              onOpenSymbol={openSymbol}
              onClose={() => openGraph(activeNodeId)}
            />
          ) : null}
        </section>
      </main>
      <CommandPalette />
    </DesktopWindow>
  );
}
