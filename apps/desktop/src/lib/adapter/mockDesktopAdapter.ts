import type {
  BackendUndoResult,
  BackendUndoTransaction,
  BackendStatus,
  DesktopAdapter,
  EditableNodeSource,
  FileContents,
  GraphAbstractionLevel,
  GraphFilters,
  GraphSettings,
  GraphNeighborhood,
  GraphView,
  IndexingJobState,
  OverviewData,
  RecentRepo,
  RepoSession,
  RevealedSource,
  SearchFilters,
  SearchResult,
  StructuralEditRequest,
  StructuralEditResult,
  SymbolDetails,
} from "./contracts";
import {
  applyMockEdit,
  buildEditableNodeSource,
  buildFiles,
  buildGraphView,
  buildOverview,
  buildRepoSession,
  buildRevealedSource,
  buildSearchResults,
  buildSymbols,
  createMockWorkspaceState,
  defaultRepoPath,
  mockBackendStatus,
  recentRepos,
  type MockWorkspaceState,
} from "../mocks/mockData";

const delay = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

export class MockDesktopAdapter implements DesktopAdapter {
  readonly isMock = true;
  private currentSession = buildRepoSession(defaultRepoPath);
  private workspace: MockWorkspaceState = createMockWorkspaceState();
  private backendUndoHistory: Array<{
    snapshot: MockWorkspaceState;
    transaction: BackendUndoTransaction;
  }> = [];

  async openRepo(path?: string): Promise<RepoSession> {
    await delay(220);
    this.currentSession = buildRepoSession(path ?? defaultRepoPath);
    this.workspace = createMockWorkspaceState();
    this.backendUndoHistory = [];
    return this.currentSession;
  }

  async listRecentRepos(): Promise<RecentRepo[]> {
    await delay(120);
    return recentRepos;
  }

  async getBackendStatus(): Promise<BackendStatus> {
    await delay(80);
    return mockBackendStatus;
  }

  async startIndex(repoPath: string): Promise<{ jobId: string }> {
    await delay(180);
    return {
      jobId: `index:${repoPath}:${Date.now()}`,
    };
  }

  subscribeIndexProgress(
    jobId: string,
    onUpdate: (state: IndexingJobState) => void,
  ): () => void {
    const frames: IndexingJobState[] = [
      {
        jobId,
        repoPath: this.currentSession.path,
        status: "queued",
        processedModules: 0,
        totalModules: 3,
        symbolCount: 0,
        message: "Queueing architecture scan",
        progressPercent: 6,
      },
      {
        jobId,
        repoPath: this.currentSession.path,
        status: "running",
        processedModules: 2,
        totalModules: 3,
        symbolCount: 4,
        message: "Collecting modules and symbols",
        progressPercent: 56,
      },
      {
        jobId,
        repoPath: this.currentSession.path,
        status: "done",
        processedModules: 3,
        totalModules: 3,
        symbolCount: 5 + this.workspace.uiApiExtraSymbols.length,
        message: "Blueprint workspace ready",
        progressPercent: 100,
      },
    ];

    let index = 0;
    onUpdate(frames[index]);
    const timer = window.setInterval(() => {
      index += 1;
      onUpdate(frames[Math.min(index, frames.length - 1)]);
      if (index >= frames.length - 1) {
        window.clearInterval(timer);
      }
    }, 600);

    return () => window.clearInterval(timer);
  }

  async searchRepo(query: string, filters: SearchFilters): Promise<SearchResult[]> {
    await delay(80);
    const normalized = query.trim().toLowerCase();
    const results = buildSearchResults(this.workspace).filter((result) => {
      if (result.kind === "file" && !filters.includeFiles) {
        return false;
      }
      if (result.kind === "module" && !filters.includeModules) {
        return false;
      }
      if (result.kind === "symbol" && !filters.includeSymbols) {
        return false;
      }
      if (!normalized) {
        return true;
      }
      return (
        result.title.toLowerCase().includes(normalized) ||
        result.subtitle.toLowerCase().includes(normalized) ||
        result.filePath.toLowerCase().includes(normalized)
      );
    });

    return results.sort((left, right) => right.score - left.score);
  }

  async getFile(path: string): Promise<FileContents> {
    await delay(60);
    const files = buildFiles(this.workspace);
    const file = files[path];
    if (!file) {
      throw new Error(`Unknown file requested: ${path}`);
    }
    return file;
  }

  async getSymbol(symbolId: string): Promise<SymbolDetails> {
    await delay(60);
    const symbols = buildSymbols(this.workspace);
    const symbol = symbols[symbolId];
    if (!symbol) {
      throw new Error(`Unknown symbol requested: ${symbolId}`);
    }
    return symbol;
  }

  async getGraphNeighborhood(
    nodeId: string,
    _depth: number,
    filters: GraphFilters,
  ): Promise<GraphNeighborhood> {
    return this.getGraphView(nodeId, "symbol", filters);
  }

  async getGraphView(
    targetId: string,
    level: GraphAbstractionLevel,
    filters: GraphFilters,
    settings: GraphSettings = { includeExternalDependencies: false },
  ): Promise<GraphView> {
    await delay(120);
    return filterGraphView(
      buildGraphView(this.currentSession, this.workspace, targetId, level),
      filters,
      settings,
    );
  }

  async getFlowView(symbolId: string): Promise<GraphView> {
    await delay(120);
    return buildGraphView(this.currentSession, this.workspace, symbolId, "flow");
  }

  async applyStructuralEdit(request: StructuralEditRequest): Promise<StructuralEditResult> {
    await delay(120);
    const snapshot = cloneWorkspaceState(this.workspace);
    const result = applyMockEdit(this.workspace, request);
    const transaction = buildMockUndoTransaction(result);
    this.backendUndoHistory.push({ snapshot, transaction });
    return {
      ...result,
      undoTransaction: transaction,
    };
  }

  async applyBackendUndo(transaction: BackendUndoTransaction): Promise<BackendUndoResult> {
    await delay(120);
    const entry = this.backendUndoHistory.pop();
    if (!entry) {
      throw new Error("No backend undo history is available in the mock adapter.");
    }

    this.workspace = cloneWorkspaceState(entry.snapshot);
    return {
      summary: `Undid: ${transaction.summary}`,
      restoredRelativePaths: transaction.fileSnapshots.map((snapshot) => snapshot.relativePath),
      warnings: [],
      focusTarget: transaction.focusTarget,
    };
  }

  async revealSource(targetId: string): Promise<RevealedSource> {
    await delay(60);
    return buildRevealedSource(this.workspace, targetId);
  }

  async getEditableNodeSource(targetId: string): Promise<EditableNodeSource> {
    await delay(60);
    return buildEditableNodeSource(this.workspace, targetId);
  }

  async saveNodeSource(targetId: string, content: string): Promise<StructuralEditResult> {
    await delay(120);
    const snapshot = cloneWorkspaceState(this.workspace);
    const result = applyMockEdit(this.workspace, {
      kind: "replace_symbol_source",
      targetId,
      content,
    });
    const transaction = buildMockUndoTransaction(result);
    this.backendUndoHistory.push({ snapshot, transaction });
    return {
      ...result,
      undoTransaction: transaction,
    };
  }

  async openNodeInDefaultEditor(_targetId: string): Promise<void> {
    await delay(40);
  }

  async revealNodeInFileExplorer(_targetId: string): Promise<void> {
    await delay(40);
  }

  async getOverview(): Promise<OverviewData> {
    await delay(100);
    return buildOverview(this.currentSession, this.workspace);
  }
}

function cloneWorkspaceState(state: MockWorkspaceState): MockWorkspaceState {
  return JSON.parse(JSON.stringify(state)) as MockWorkspaceState;
}

function buildMockUndoTransaction(result: StructuralEditResult): BackendUndoTransaction {
  return {
    summary: result.summary,
    requestKind: result.request.kind,
    fileSnapshots: result.touchedRelativePaths.map((relativePath) => ({
      relativePath,
      existed: true,
      content: "",
    })),
    changedNodeIds: result.changedNodeIds,
    focusTarget: inferMockUndoFocusTarget(result),
  };
}

function inferMockUndoFocusTarget(
  result: StructuralEditResult,
): BackendUndoTransaction["focusTarget"] {
  if (result.request.kind === "create_module") {
    return {
      targetId: buildRepoSession(defaultRepoPath).id,
      level: "repo",
    };
  }

  if (
    result.request.kind === "create_symbol"
    || result.request.kind === "add_import"
    || result.request.kind === "remove_import"
  ) {
    const relativePath = result.request.relative_path ?? result.touchedRelativePaths[0];
    const moduleName = relativePath?.replace(/\.py$/, "").replaceAll("/", ".") ?? "helm.ui.api";
    return {
      targetId: `module:${moduleName}`,
      level: "module",
    };
  }

  if (
    result.request.kind === "insert_flow_statement"
    || result.request.kind === "replace_flow_graph"
  ) {
    return result.request.target_id
      ? {
          targetId: result.request.target_id,
          level: "flow",
        }
      : undefined;
  }

  return result.request.target_id
    ? {
        targetId: result.request.target_id,
        level: "symbol",
      }
    : undefined;
}

function filterGraphView(
  graph: GraphView,
  filters: GraphFilters,
  settings: GraphSettings,
): GraphView {
  const externalNodeIds = new Set(
    graph.nodes
      .filter((node) => node.metadata.isExternal === true)
      .map((node) => node.id),
  );
  const edges = graph.edges.filter((edge) => {
    if (
      !settings.includeExternalDependencies
      && (externalNodeIds.has(edge.source) || externalNodeIds.has(edge.target))
    ) {
      return false;
    }
    if (edge.kind === "imports") {
      return filters.includeImports;
    }
    if (edge.kind === "calls") {
      return filters.includeCalls;
    }
    if (edge.kind === "defines") {
      return filters.includeDefines;
    }
    return true;
  });

  const connectedNodeIds = new Set<string>([graph.rootNodeId, graph.targetId]);
  edges.forEach((edge) => {
    connectedNodeIds.add(edge.source);
    connectedNodeIds.add(edge.target);
  });

  return {
    ...graph,
    edges,
    nodes: graph.nodes.filter(
      (node) =>
        connectedNodeIds.has(node.id)
        && (settings.includeExternalDependencies || node.metadata.isExternal !== true),
    ),
  };
}
