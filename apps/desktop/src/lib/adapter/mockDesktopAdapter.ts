import type {
  BackendUndoResult,
  BackendUndoTransaction,
  BackendStatus,
  DesktopAdapter,
  EditableNodeSource,
  FileContents,
  FlowExpressionParseResult,
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
  WorkspaceFileContents,
  WorkspaceFileDeleteRequest,
  WorkspaceFileEntry,
  WorkspaceFileMoveRequest,
  WorkspaceFileMutationRequest,
  WorkspaceFileMutationResult,
  WorkspaceFileTree,
  WorkspaceSyncEvent,
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
  private backendRedoHistory: Array<{
    snapshot: MockWorkspaceState;
    transaction: BackendUndoTransaction;
  }> = [];
  private workspaceSyncListeners = new Set<(event: WorkspaceSyncEvent) => void>();

  async openRepo(path?: string): Promise<RepoSession> {
    await delay(220);
    this.currentSession = buildRepoSession(path ?? defaultRepoPath);
    this.workspace = createMockWorkspaceState();
    this.backendUndoHistory = [];
    this.backendRedoHistory = [];
    return this.currentSession;
  }

  async createProject(): Promise<RepoSession | null> {
    await delay(220);
    this.currentSession = buildRepoSession(
      "/Users/noahphillips/Documents/git-repos/untitled-helm-project",
    );
    this.workspace = createMockWorkspaceState();
    this.backendUndoHistory = [];
    this.backendRedoHistory = [];
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

  subscribeWorkspaceSync(onUpdate: (event: WorkspaceSyncEvent) => void): () => void {
    this.workspaceSyncListeners.add(onUpdate);
    return () => {
      this.workspaceSyncListeners.delete(onUpdate);
    };
  }

  async startIndex(repoPath: string): Promise<{ jobId: string }> {
    await delay(180);
    return {
      jobId: `index:${repoPath}:${Date.now()}`,
    };
  }

  subscribeIndexProgress(jobId: string, onUpdate: (state: IndexingJobState) => void): () => void {
    const frames: IndexingJobState[] = [
      {
        jobId,
        repoPath: this.currentSession.path,
        status: "queued",
        stage: "discover",
        processedModules: 0,
        totalModules: 3,
        symbolCount: 0,
        message: "Discovering Python modules",
        progressPercent: 6,
      },
      {
        jobId,
        repoPath: this.currentSession.path,
        status: "running",
        stage: "parse",
        processedModules: 2,
        totalModules: 3,
        symbolCount: 4,
        message: "Parsing Python modules",
        progressPercent: 56,
      },
      {
        jobId,
        repoPath: this.currentSession.path,
        status: "done",
        stage: "watch_ready",
        processedModules: 3,
        totalModules: 3,
        symbolCount:
          5 + this.workspace.uiApiExtraSymbols.length + this.workspace.moduleExtraSymbols.length,
        message: "Workspace ready. Watching for workspace changes.",
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

  async listWorkspaceFiles(repoPath: string): Promise<WorkspaceFileTree> {
    await delay(60);
    return buildMockWorkspaceFileTree(repoPath, this.workspace);
  }

  async readWorkspaceFile(_repoPath: string, relativePath: string): Promise<WorkspaceFileContents> {
    await delay(60);
    return readMockWorkspaceFile(this.workspace, relativePath);
  }

  async createWorkspaceEntry(
    _repoPath: string,
    request: WorkspaceFileMutationRequest,
  ): Promise<WorkspaceFileMutationResult> {
    await delay(100);
    const relativePath = normalizeMockWorkspacePath(request.relativePath);
    if (request.kind === "directory") {
      if (mockWorkspacePathExists(this.workspace, relativePath)) {
        throw new Error(`Workspace path already exists: ${relativePath}`);
      }
      this.workspace.workspaceFiles[relativePath] = { kind: "directory" };
      return {
        relativePath,
        kind: "directory",
        changedRelativePaths: [relativePath],
        file: null,
      };
    }

    if (mockWorkspacePathExists(this.workspace, relativePath)) {
      throw new Error(`Workspace path already exists: ${relativePath}`);
    }

    if (relativePath.endsWith(".py")) {
      applyMockEdit(this.workspace, {
        kind: "create_module",
        relativePath,
        content: request.content ?? "",
      });
    } else {
      this.workspace.workspaceFiles[relativePath] = {
        kind: "file",
        content: request.content ?? "",
      };
    }

    return {
      relativePath,
      kind: "file",
      changedRelativePaths: [relativePath],
      file: readMockWorkspaceFile(this.workspace, relativePath),
    };
  }

  async saveWorkspaceFile(
    _repoPath: string,
    relativePath: string,
    content: string,
    expectedVersion: string,
  ): Promise<WorkspaceFileMutationResult> {
    await delay(100);
    const normalized = normalizeMockWorkspacePath(relativePath);
    const current = readMockWorkspaceFile(this.workspace, normalized);
    if (!current.editable) {
      throw new Error(current.reason ?? "Workspace file is not editable inline.");
    }
    if (current.version !== expectedVersion) {
      throw new Error("Workspace file changed on disk. Reload it before saving again.");
    }

    const extraModule = this.workspace.extraModules.find(
      (module) => module.relativePath === normalized,
    );
    if (extraModule) {
      extraModule.content = content;
    } else {
      this.workspace.workspaceFiles[normalized] = {
        kind: "file",
        content,
      };
    }

    return {
      relativePath: normalized,
      kind: "file",
      changedRelativePaths: [normalized],
      file: readMockWorkspaceFile(this.workspace, normalized),
    };
  }

  async moveWorkspaceEntry(
    _repoPath: string,
    request: WorkspaceFileMoveRequest,
  ): Promise<WorkspaceFileMutationResult> {
    await delay(100);
    const sourceRelativePath = normalizeMockWorkspacePath(request.sourceRelativePath);
    const targetDirectoryRelativePath = normalizeMockDirectoryPath(
      request.targetDirectoryRelativePath,
    );
    const targetRelativePath = joinMockWorkspacePath(
      targetDirectoryRelativePath,
      sourceRelativePath.split("/").pop() ?? sourceRelativePath,
    );
    if (sourceRelativePath === targetRelativePath) {
      return mockWorkspaceMoveResult(this.workspace, sourceRelativePath, targetRelativePath);
    }
    if (!mockWorkspacePathExists(this.workspace, sourceRelativePath)) {
      throw new Error(`Workspace path does not exist: ${sourceRelativePath}`);
    }
    if (
      targetDirectoryRelativePath &&
      !mockWorkspaceDirectoryExists(this.workspace, targetDirectoryRelativePath)
    ) {
      throw new Error(`Workspace folder does not exist: ${targetDirectoryRelativePath}`);
    }
    if (mockWorkspacePathExists(this.workspace, targetRelativePath)) {
      throw new Error(`Workspace path already exists: ${targetRelativePath}`);
    }
    if (
      mockWorkspaceDirectoryExists(this.workspace, sourceRelativePath) &&
      (targetDirectoryRelativePath === sourceRelativePath ||
        targetDirectoryRelativePath.startsWith(`${sourceRelativePath}/`))
    ) {
      throw new Error("Cannot move a folder into itself or one of its descendants.");
    }

    moveMockWorkspacePath(this.workspace, sourceRelativePath, targetRelativePath);
    return mockWorkspaceMoveResult(this.workspace, sourceRelativePath, targetRelativePath);
  }

  async deleteWorkspaceEntry(
    _repoPath: string,
    request: WorkspaceFileDeleteRequest,
  ): Promise<WorkspaceFileMutationResult> {
    await delay(100);
    const relativePath = normalizeMockWorkspacePath(request.relativePath);
    if (!mockWorkspacePathExists(this.workspace, relativePath)) {
      throw new Error(`Workspace path does not exist: ${relativePath}`);
    }

    const kind = mockWorkspaceDirectoryExists(this.workspace, relativePath) ? "directory" : "file";
    const changedRelativePaths = deleteMockWorkspacePath(this.workspace, relativePath);
    return {
      relativePath,
      kind,
      changedRelativePaths,
      file: null,
    };
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

  async parseFlowExpression(expression: string): Promise<FlowExpressionParseResult> {
    await delay(40);
    const normalized = expression.trim();
    if (!normalized) {
      return {
        expression: normalized,
        graph: {
          version: 1,
          rootId: null,
          nodes: [],
          edges: [],
        },
        diagnostics: [],
      };
    }
    return {
      expression: normalized,
      graph: {
        version: 1,
        rootId: "expr:raw:0",
        nodes: [
          {
            id: "expr:raw:0",
            kind: "raw",
            label: normalized,
            payload: { expression: normalized },
          },
        ],
        edges: [],
      },
      diagnostics: [],
    };
  }

  async applyStructuralEdit(request: StructuralEditRequest): Promise<StructuralEditResult> {
    await delay(120);
    const snapshot = cloneWorkspaceState(this.workspace);
    const result = applyMockEdit(this.workspace, request);
    const transaction = buildMockUndoTransaction(result);
    this.backendUndoHistory.push({ snapshot, transaction });
    this.backendRedoHistory = [];
    return {
      ...result,
      undoTransaction: transaction,
    };
  }

  async applyBackendUndo(transaction: BackendUndoTransaction): Promise<BackendUndoResult> {
    await delay(120);
    const currentSnapshot = cloneWorkspaceState(this.workspace);
    let isRedo = false;
    let redoIndex = -1;
    for (let index = this.backendRedoHistory.length - 1; index >= 0; index -= 1) {
      if (backendUndoTransactionsEqual(this.backendRedoHistory[index].transaction, transaction)) {
        redoIndex = index;
        break;
      }
    }

    const entry =
      redoIndex >= 0
        ? this.backendRedoHistory.splice(redoIndex, 1)[0]
        : this.backendUndoHistory.pop();
    if (!entry) {
      throw new Error("No backend undo history is available in the mock adapter.");
    }

    isRedo = redoIndex >= 0;
    const inverseTransaction = cloneBackendUndoTransaction(transaction);
    this.workspace = cloneWorkspaceState(entry.snapshot);
    if (isRedo) {
      this.backendUndoHistory.push({ snapshot: currentSnapshot, transaction: inverseTransaction });
    } else {
      this.backendRedoHistory.push({ snapshot: currentSnapshot, transaction: inverseTransaction });
    }

    return {
      summary: `${isRedo ? "Redid" : "Undid"}: ${transaction.summary}`,
      restoredRelativePaths: transaction.fileSnapshots.map((snapshot) => snapshot.relativePath),
      warnings: [],
      focusTarget: transaction.focusTarget,
      redoTransaction: inverseTransaction,
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
      kind: targetId.startsWith("module:") ? "replace_module_source" : "replace_symbol_source",
      targetId,
      content,
    });
    const transaction = buildMockUndoTransaction(result);
    this.backendUndoHistory.push({ snapshot, transaction });
    this.backendRedoHistory = [];
    return {
      ...result,
      undoTransaction: transaction,
    };
  }

  async openNodeInDefaultEditor(_targetId: string): Promise<void> {
    await delay(40);
  }

  async openPathInDefaultEditor(_relativePath: string): Promise<void> {
    await delay(40);
  }

  async revealNodeInFileExplorer(_targetId: string): Promise<void> {
    await delay(40);
  }

  async revealPathInFileExplorer(_relativePath: string): Promise<void> {
    await delay(40);
  }

  async getOverview(): Promise<OverviewData> {
    await delay(100);
    return buildOverview(this.currentSession, this.workspace);
  }

  emitWorkspaceSyncForTest(event: WorkspaceSyncEvent) {
    this.workspaceSyncListeners.forEach((listener) => listener(event));
  }
}

function cloneWorkspaceState(state: MockWorkspaceState): MockWorkspaceState {
  return JSON.parse(JSON.stringify(state)) as MockWorkspaceState;
}

function normalizeMockWorkspacePath(relativePath: string) {
  const normalized = relativePath.trim().replaceAll("\\", "/").replace(/^\/+/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) {
    throw new Error("Repo-relative paths must stay inside the workspace.");
  }
  return parts.join("/");
}

function normalizeMockDirectoryPath(relativePath: string) {
  const normalized = relativePath.trim().replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized) {
    return "";
  }
  return normalizeMockWorkspacePath(normalized);
}

function joinMockWorkspacePath(directoryPath: string, name: string) {
  return directoryPath ? `${directoryPath}/${name}` : name;
}

function parentPathsFor(relativePath: string) {
  const parts = relativePath.split("/").filter(Boolean);
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
}

function mockFileVersion(content: string) {
  let hash = 0;
  for (let index = 0; index < content.length; index += 1) {
    hash = ((hash << 5) - hash + content.charCodeAt(index)) | 0;
  }
  return `mock:${content.length}:${hash >>> 0}`;
}

function mockWorkspacePathExists(state: MockWorkspaceState, relativePath: string) {
  if (state.workspaceFiles[relativePath]) {
    return true;
  }
  if (buildFiles(state)[relativePath]) {
    return true;
  }
  return (
    Object.keys(buildFiles(state)).some((filePath) => filePath.startsWith(`${relativePath}/`)) ||
    Object.keys(state.workspaceFiles).some((filePath) => filePath.startsWith(`${relativePath}/`))
  );
}

function mockWorkspaceDirectoryExists(state: MockWorkspaceState, relativePath: string) {
  if (!relativePath) {
    return true;
  }
  if (state.workspaceFiles[relativePath]?.kind === "directory") {
    return true;
  }
  return (
    Object.keys(buildFiles(state)).some((filePath) => filePath.startsWith(`${relativePath}/`)) ||
    Object.keys(state.workspaceFiles).some((filePath) => filePath.startsWith(`${relativePath}/`))
  );
}

function moveMockWorkspacePath(
  state: MockWorkspaceState,
  sourceRelativePath: string,
  targetRelativePath: string,
) {
  let moved = false;
  const workspaceMoves = Object.entries(state.workspaceFiles).filter(
    ([relativePath]) =>
      relativePath === sourceRelativePath || relativePath.startsWith(`${sourceRelativePath}/`),
  );

  workspaceMoves.forEach(([relativePath]) => {
    delete state.workspaceFiles[relativePath];
  });
  workspaceMoves.forEach(([relativePath, entry]) => {
    const suffix =
      relativePath === sourceRelativePath ? "" : relativePath.slice(sourceRelativePath.length);
    state.workspaceFiles[`${targetRelativePath}${suffix}`] = { ...entry };
    moved = true;
  });

  state.extraModules.forEach((module) => {
    if (
      module.relativePath !== sourceRelativePath &&
      !module.relativePath.startsWith(`${sourceRelativePath}/`)
    ) {
      return;
    }

    const suffix =
      module.relativePath === sourceRelativePath
        ? ""
        : module.relativePath.slice(sourceRelativePath.length);
    module.relativePath = `${targetRelativePath}${suffix}`;
    module.moduleName = moduleNameFromMockRelativePath(module.relativePath);
    moved = true;
  });

  if (!moved) {
    throw new Error("Mock workspace can only move created workspace entries.");
  }
}

function moduleNameFromMockRelativePath(relativePath: string) {
  return relativePath.replace(/\.py$/, "").replaceAll("/", ".");
}

function mockWorkspaceMoveResult(
  state: MockWorkspaceState,
  sourceRelativePath: string,
  targetRelativePath: string,
): WorkspaceFileMutationResult {
  const kind = mockWorkspaceDirectoryExists(state, targetRelativePath) ? "directory" : "file";
  return {
    relativePath: targetRelativePath,
    kind,
    changedRelativePaths:
      sourceRelativePath === targetRelativePath ? [] : [sourceRelativePath, targetRelativePath],
    file: kind === "file" ? readMockWorkspaceFile(state, targetRelativePath) : null,
  };
}

function deleteMockWorkspacePath(state: MockWorkspaceState, relativePath: string) {
  const changedRelativePaths = new Set<string>([relativePath]);
  let deleted = false;

  Object.keys(state.workspaceFiles).forEach((candidate) => {
    if (candidate !== relativePath && !candidate.startsWith(`${relativePath}/`)) {
      return;
    }
    changedRelativePaths.add(candidate);
    delete state.workspaceFiles[candidate];
    deleted = true;
  });

  const nextExtraModules = state.extraModules.filter((module) => {
    if (
      module.relativePath !== relativePath &&
      !module.relativePath.startsWith(`${relativePath}/`)
    ) {
      return true;
    }
    changedRelativePaths.add(module.relativePath);
    deleted = true;
    return false;
  });
  state.extraModules = nextExtraModules;

  if (!deleted) {
    throw new Error("Mock workspace can only delete created workspace entries.");
  }

  return [...changedRelativePaths];
}

function readMockWorkspaceFile(
  state: MockWorkspaceState,
  relativePath: string,
): WorkspaceFileContents {
  const normalized = normalizeMockWorkspacePath(relativePath);
  const workspaceEntry = state.workspaceFiles[normalized];
  if (workspaceEntry?.kind === "directory") {
    throw new Error(`Workspace path is not a file: ${normalized}`);
  }
  const content =
    workspaceEntry?.kind === "file"
      ? (workspaceEntry.content ?? "")
      : buildFiles(state)[normalized]?.content;
  if (content === undefined) {
    throw new Error(`Unknown workspace file requested: ${normalized}`);
  }

  return {
    relativePath: normalized,
    name: normalized.split("/").pop() ?? normalized,
    kind: "file",
    sizeBytes: new TextEncoder().encode(content).length,
    editable: true,
    reason: null,
    content,
    version: mockFileVersion(content),
    modifiedAt: 0,
  };
}

function buildMockWorkspaceFileTree(
  repoPath: string,
  state: MockWorkspaceState,
): WorkspaceFileTree {
  const entriesByPath = new Map<string, WorkspaceFileEntry>();

  const addDirectory = (relativePath: string) => {
    if (entriesByPath.has(relativePath)) {
      return;
    }
    entriesByPath.set(relativePath, {
      relativePath,
      name: relativePath.split("/").pop() ?? relativePath,
      kind: "directory",
      sizeBytes: null,
      editable: false,
      reason: "Directories are shown in the explorer.",
      modifiedAt: 0,
    });
  };

  const addFile = (relativePath: string, content: string) => {
    parentPathsFor(relativePath).forEach(addDirectory);
    entriesByPath.set(relativePath, {
      relativePath,
      name: relativePath.split("/").pop() ?? relativePath,
      kind: "file",
      sizeBytes: new TextEncoder().encode(content).length,
      editable: true,
      reason: null,
      modifiedAt: 0,
    });
  };

  Object.entries(buildFiles(state)).forEach(([relativePath, file]) => {
    addFile(relativePath, file.content);
  });

  Object.entries(state.workspaceFiles).forEach(([relativePath, entry]) => {
    parentPathsFor(relativePath).forEach(addDirectory);
    if (entry.kind === "directory") {
      addDirectory(relativePath);
    } else {
      addFile(relativePath, entry.content ?? "");
    }
  });

  const entries = [...entriesByPath.values()].sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "directory" ? -1 : 1;
    }
    return left.relativePath.localeCompare(right.relativePath);
  });

  return {
    rootPath: repoPath,
    entries,
    truncated: false,
  };
}

function cloneBackendUndoTransaction(transaction: BackendUndoTransaction): BackendUndoTransaction {
  return JSON.parse(JSON.stringify(transaction)) as BackendUndoTransaction;
}

function backendUndoTransactionsEqual(left: BackendUndoTransaction, right: BackendUndoTransaction) {
  return JSON.stringify(left) === JSON.stringify(right);
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
    result.request.kind === "create_symbol" ||
    result.request.kind === "add_import" ||
    result.request.kind === "remove_import" ||
    result.request.kind === "replace_module_source"
  ) {
    const relativePath = result.request.relative_path ?? result.touchedRelativePaths[0];
    const moduleName = relativePath ? mockModuleNameForFocusPath(relativePath) : "helm.ui.api";
    return {
      targetId: `module:${moduleName}`,
      level: "module",
    };
  }

  if (
    result.request.kind === "insert_flow_statement" ||
    result.request.kind === "replace_flow_graph"
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

function mockModuleNameForFocusPath(relativePath: string) {
  switch (relativePath) {
    case "src/helm/cli.py":
      return "helm.cli";
    case "src/helm/ui/api.py":
      return "helm.ui.api";
    case "src/helm/graph/models.py":
      return "helm.graph.models";
    default:
      return relativePath.replace(/\.py$/, "").replaceAll("/", ".");
  }
}

function filterGraphView(
  graph: GraphView,
  filters: GraphFilters,
  settings: GraphSettings,
): GraphView {
  const externalNodeIds = new Set(
    graph.nodes.filter((node) => node.metadata.isExternal === true).map((node) => node.id),
  );
  const edges = graph.edges.filter((edge) => {
    if (
      !settings.includeExternalDependencies &&
      (externalNodeIds.has(edge.source) || externalNodeIds.has(edge.target))
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
        connectedNodeIds.has(node.id) &&
        (settings.includeExternalDependencies || node.metadata.isExternal !== true),
    ),
  };
}
