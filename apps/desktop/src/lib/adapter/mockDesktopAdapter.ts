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
  WorkspaceFileMoveRequest,
  WorkspaceFileOperationPreview,
  WorkspaceFileOperationPreviewRequest,
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
import { filterGraphView } from "./mockDesktopAdapter/graph";
import {
  joinMockWorkspacePath,
  normalizeMockDirectoryPath,
  normalizeMockWorkspacePath,
} from "./mockDesktopAdapter/paths";
import {
  cloneBackendUndoTransaction,
  backendUndoTransactionsEqual,
  buildMockUndoTransaction,
  buildMockWorkspaceUndoTransaction,
  cloneWorkspaceState,
} from "./mockDesktopAdapter/undo";
import {
  buildMockWorkspaceFileTree,
  deleteMockWorkspacePath,
  mockWorkspaceAffectedPaths,
  mockWorkspaceDirectoryExists,
  mockWorkspaceMoveResult,
  mockWorkspacePathExists,
  moveMockWorkspacePath,
  readMockWorkspaceFile,
  readMockWorkspaceFileIfAvailable,
} from "./mockDesktopAdapter/workspaceFiles";

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

  async previewWorkspaceFileOperation(
    _repoPath: string,
    request: WorkspaceFileOperationPreviewRequest,
  ): Promise<WorkspaceFileOperationPreview> {
    await delay(60);
    const sourceRelativePath =
      request.operation === "delete"
        ? normalizeMockWorkspacePath(request.relativePath)
        : normalizeMockWorkspacePath(request.sourceRelativePath);
    const targetRelativePath =
      request.operation === "move"
        ? joinMockWorkspacePath(
            normalizeMockDirectoryPath(request.targetDirectoryRelativePath),
            sourceRelativePath.split("/").pop() ?? sourceRelativePath,
          )
        : null;
    const affectedPaths = mockWorkspaceAffectedPaths(this.workspace, sourceRelativePath);
    const directoryCount = affectedPaths.filter((path) =>
      mockWorkspaceDirectoryExists(this.workspace, path),
    ).length;
    const fileCount = affectedPaths.length - directoryCount;
    return {
      operationKind: request.operation,
      sourceRelativePath,
      targetRelativePath,
      entryKind: mockWorkspaceDirectoryExists(this.workspace, sourceRelativePath)
        ? "directory"
        : "file",
      counts: {
        entryCount: affectedPaths.length,
        fileCount,
        directoryCount,
        symlinkCount: 0,
        totalSizeBytes: affectedPaths.reduce((sum, path) => {
          const file = readMockWorkspaceFileIfAvailable(this.workspace, path);
          return sum + (file?.sizeBytes ?? 0);
        }, 0),
        pythonFileCount: affectedPaths.filter((path) => path.endsWith(".py")).length,
      },
      warnings: [],
      affectedPaths: affectedPaths.slice(0, 40),
      affectedPathsTruncated: affectedPaths.length > 40,
      impactFingerprint: `mock:${request.operation}:${sourceRelativePath}:${targetRelativePath ?? ""}:${affectedPaths.length}`,
    };
  }

  async createWorkspaceEntry(
    _repoPath: string,
    request: WorkspaceFileMutationRequest,
  ): Promise<WorkspaceFileMutationResult> {
    await delay(100);
    const snapshot = cloneWorkspaceState(this.workspace);
    const relativePath = normalizeMockWorkspacePath(request.relativePath);
    if (request.kind === "directory") {
      if (mockWorkspacePathExists(this.workspace, relativePath)) {
        throw new Error(`Workspace path already exists: ${relativePath}`);
      }
      this.workspace.workspaceFiles[relativePath] = { kind: "directory" };
      const result: WorkspaceFileMutationResult = {
        relativePath,
        kind: "directory",
        changedRelativePaths: [relativePath],
        file: null,
      };
      return this.recordMockWorkspaceUndo(
        snapshot,
        result,
        `Created folder ${relativePath}.`,
        "workspace.create",
      );
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

    const result: WorkspaceFileMutationResult = {
      relativePath,
      kind: "file",
      changedRelativePaths: [relativePath],
      file: readMockWorkspaceFile(this.workspace, relativePath),
    };
    return this.recordMockWorkspaceUndo(
      snapshot,
      result,
      `Created file ${relativePath}.`,
      "workspace.create",
    );
  }

  async saveWorkspaceFile(
    _repoPath: string,
    relativePath: string,
    content: string,
    expectedVersion: string,
  ): Promise<WorkspaceFileMutationResult> {
    await delay(100);
    const snapshot = cloneWorkspaceState(this.workspace);
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

    const result: WorkspaceFileMutationResult = {
      relativePath: normalized,
      kind: "file",
      changedRelativePaths: [normalized],
      file: readMockWorkspaceFile(this.workspace, normalized),
    };
    return this.recordMockWorkspaceUndo(snapshot, result, `Saved ${normalized}.`, "workspace.save");
  }

  async moveWorkspaceEntry(
    _repoPath: string,
    request: WorkspaceFileMoveRequest,
  ): Promise<WorkspaceFileMutationResult> {
    await delay(100);
    const snapshot = cloneWorkspaceState(this.workspace);
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
    const result = mockWorkspaceMoveResult(this.workspace, sourceRelativePath, targetRelativePath);
    return this.recordMockWorkspaceUndo(
      snapshot,
      result,
      `Moved ${sourceRelativePath} to ${targetRelativePath}.`,
      "workspace.move",
    );
  }

  async deleteWorkspaceEntry(
    _repoPath: string,
    request: WorkspaceFileDeleteRequest,
  ): Promise<WorkspaceFileMutationResult> {
    await delay(100);
    const snapshot = cloneWorkspaceState(this.workspace);
    const relativePath = normalizeMockWorkspacePath(request.relativePath);
    if (!mockWorkspacePathExists(this.workspace, relativePath)) {
      throw new Error(`Workspace path does not exist: ${relativePath}`);
    }

    const kind = mockWorkspaceDirectoryExists(this.workspace, relativePath) ? "directory" : "file";
    const changedRelativePaths = deleteMockWorkspacePath(this.workspace, relativePath);
    const result: WorkspaceFileMutationResult = {
      relativePath,
      kind,
      changedRelativePaths,
      file: null,
    };
    return this.recordMockWorkspaceUndo(
      snapshot,
      result,
      `Deleted ${relativePath}.`,
      "workspace.delete",
    );
  }

  private recordMockWorkspaceUndo(
    snapshot: MockWorkspaceState,
    result: WorkspaceFileMutationResult,
    summary: string,
    requestKind: BackendUndoTransaction["requestKind"],
  ): WorkspaceFileMutationResult {
    const transaction = buildMockWorkspaceUndoTransaction(
      summary,
      requestKind,
      result.changedRelativePaths,
    );
    this.backendUndoHistory.push({ snapshot, transaction });
    this.backendRedoHistory = [];
    return {
      ...result,
      undoTransaction: transaction,
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
