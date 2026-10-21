import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import type {
  BackendStatus,
  BackendUndoTransaction,
  DesktopAdapter,
  EditableNodeSource,
  FileContents,
  FlowExpressionParseResult,
  GraphAbstractionLevel,
  GraphFilters,
  GraphNeighborhood,
  GraphSettings,
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
  WorkspaceFileMutationRequest,
  WorkspaceFileMutationResult,
  WorkspaceFileOperationPreview,
  WorkspaceFileOperationPreviewRequest,
  WorkspaceFileTree,
  WorkspaceSyncEvent,
} from "./contracts";
import {
  getFlowViewCommand,
  getGraphViewCommand,
  parseFlowExpressionCommand,
} from "./liveDesktopAdapter/graphFlow";
import type {
  NativeIndexProgressEvent,
  NativeWorkspaceSyncEvent,
  RawIndexProgressEvent,
  RawScanPayload,
  RawWorkspaceSyncEvent,
  ScanCache,
  ScanJob,
} from "./liveDesktopAdapter/rawTypes";
import {
  buildScanCache,
  getFileContents,
  getOverviewData,
  getSymbolDetails,
  searchScanCache,
} from "./liveDesktopAdapter/scanCache";
import {
  DEFAULT_PYTHON_COMMAND,
  buildRepoSessionFromPath,
  loadRecentRepos,
  normalizePath,
  rememberRecentRepo,
  toMessage,
  toRecoveryEvents,
  type InvokeCommand,
} from "./liveDesktopAdapter/shared";
import {
  applyBackendUndoCommand,
  applyStructuralEditCommand,
  getEditableNodeSourceCommand,
  openNodeInDefaultEditorCommand,
  openPathInDefaultEditorCommand,
  revealNodeInFileExplorerCommand,
  revealPathInFileExplorerCommand,
  revealSourceCommand,
  saveNodeSourceCommand,
} from "./liveDesktopAdapter/sourceEdits";
import {
  backendStatusFromSyncEvent,
  createProjectSession,
  getLiveBackendStatus,
  initialIndexingJobState,
  openRepoSession,
  scanRepoPayload,
  toIndexingJobState,
  toWorkspaceSyncEvent,
} from "./liveDesktopAdapter/statusSession";
import {
  createWorkspaceEntryCommand,
  deleteWorkspaceEntryCommand,
  listWorkspaceFilesCommand,
  moveWorkspaceEntryCommand,
  previewWorkspaceFileOperationCommand,
  readWorkspaceFileCommand,
  saveWorkspaceFileCommand,
} from "./liveDesktopAdapter/workspaceFiles";

import {
  normalizeIndexProgressWire,
  normalizeWorkspaceSyncWire,
} from "./liveDesktopAdapter/rawTypes";

const invokeCommand = invoke as InvokeCommand;

export class LiveDesktopAdapter implements DesktopAdapter {
  readonly isMock = false;

  private pendingProjectMutations = 0;
  hasPendingProjectMutation() {
    return this.pendingProjectMutations > 0;
  }
  private async trackProjectMutation<T>(operation: () => Promise<T>): Promise<T> {
    this.pendingProjectMutations++;
    try {
      return await operation();
    } finally {
      this.pendingProjectMutations--;
    }
  }
  private projectContextEpoch?: number;
  acceptProjectContextEpoch(epoch: number) {
    this.projectContextEpoch = epoch;
    ++this.sessionGeneration;
    this.scanCache = undefined;
    this.activeScanJobId = undefined;
  }
  private currentSession?: RepoSession;
  private sessionGeneration = 0;
  private nextIndexJob = 0;
  private activeScanJobId?: string;
  private backendStatus: BackendStatus = {
    mode: "live",
    available: false,
    pythonCommand: DEFAULT_PYTHON_COMMAND,
    note: "Waiting for the desktop shell to check the Python bridge.",
    liveSyncEnabled: false,
    syncState: "idle",
  };
  private scanCache?: ScanCache;
  private jobs = new Map<string, ScanJob>();
  private workspaceSyncListeners = new Set<(event: WorkspaceSyncEvent) => void>();
  private indexProgressUnlisten?: Promise<UnlistenFn>;
  private workspaceSyncUnlisten?: Promise<UnlistenFn>;

  constructor() {
    this.indexProgressUnlisten = listen<RawIndexProgressEvent | NativeIndexProgressEvent>(
      "helm://index-progress",
      (event) => {
        this.handleIndexProgress(normalizeIndexProgressWire(event.payload));
      },
    ).catch(() => () => {});
    this.workspaceSyncUnlisten = listen<RawWorkspaceSyncEvent | NativeWorkspaceSyncEvent>(
      "helm://workspace-sync",
      (event) => {
        this.handleWorkspaceSync(normalizeWorkspaceSyncWire(event.payload));
      },
    ).catch(() => () => {});
  }

  private handleIndexProgress(raw: RawIndexProgressEvent) {
    if (
      raw.job_id !== this.activeScanJobId ||
      normalizePath(raw.repo_path) !== this.currentSession?.path
    )
      return;
    // The worker's done event can precede the invocation result. Publish done only
    // after runScan has committed the cache needed by the workspace screen.
    if (raw.status !== "done") this.updateJob(raw.job_id, toIndexingJobState(raw));
  }

  private handleWorkspaceSync(raw: RawWorkspaceSyncEvent) {
    if (this.projectContextEpoch !== undefined && raw.contextEpoch !== this.projectContextEpoch)
      return;
    if (this.currentSession && normalizePath(raw.repo_path) !== this.currentSession.path) return;
    const nextBackend = backendStatusFromSyncEvent(this.backendStatus, raw);
    this.backendStatus = nextBackend;

    const normalizedRepoPath = normalizePath(raw.repo_path);
    if (raw.payload && (!this.currentSession || this.currentSession.path === normalizedRepoPath)) {
      const session = this.currentSession ?? buildRepoSessionFromPath(normalizedRepoPath);
      this.scanCache = buildScanCache(raw.payload, session, nextBackend);
      this.currentSession = session;
    } else if (this.scanCache) {
      this.scanCache = {
        ...this.scanCache,
        backend: nextBackend,
      };
    }

    const event = toWorkspaceSyncEvent(raw);
    this.workspaceSyncListeners.forEach((listener) => listener(event));
  }

  async openRepo(path?: string): Promise<RepoSession> {
    const session = await openRepoSession(open, path);
    this.selectSession(session);
    return session;
  }

  async createProject(): Promise<RepoSession | null> {
    const session = await createProjectSession(save, invokeCommand);
    if (session) this.selectSession(session);
    return session;
  }

  async listRecentRepos(): Promise<RecentRepo[]> {
    return loadRecentRepos();
  }

  async getBackendStatus(): Promise<BackendStatus> {
    this.backendStatus = await getLiveBackendStatus(invokeCommand, this.backendStatus);
    return this.backendStatus;
  }

  subscribeWorkspaceSync(onUpdate: (event: WorkspaceSyncEvent) => void): () => void {
    this.workspaceSyncListeners.add(onUpdate);
    return () => {
      this.workspaceSyncListeners.delete(onUpdate);
    };
  }

  async startIndex(repoPath: string): Promise<{ jobId: string }> {
    const jobId = `index:${repoPath}:${Date.now()}:${++this.nextIndexJob}`;
    const session =
      this.currentSession?.path === normalizePath(repoPath)
        ? this.currentSession
        : buildRepoSessionFromPath(repoPath);
    const generation = ++this.sessionGeneration;
    this.currentSession = session;
    this.activeScanJobId = jobId;
    const job: ScanJob = {
      state: initialIndexingJobState(jobId, repoPath),
      listeners: new Set(),
    };
    this.jobs.set(jobId, job);
    this.scanCache = undefined;
    void this.runScan(jobId, session, generation);
    return { jobId };
  }

  subscribeIndexProgress(jobId: string, onUpdate: (state: IndexingJobState) => void): () => void {
    const job = this.jobs.get(jobId);
    if (!job) {
      onUpdate({
        jobId,
        repoPath: this.currentSession?.path ?? "",
        status: "error",
        stage: "discover",
        processedModules: 0,
        totalModules: 0,
        symbolCount: 0,
        message: "Unknown indexing job.",
        progressPercent: 100,
        error: "The desktop shell lost track of this indexing job.",
      });
      return () => {};
    }

    job.listeners.add(onUpdate);
    onUpdate(job.state);
    return () => {
      job.listeners.delete(onUpdate);
    };
  }

  async searchRepo(query: string, filters: SearchFilters): Promise<SearchResult[]> {
    return searchScanCache(this.requireScanCache(), query, filters);
  }

  async getFile(path: string): Promise<FileContents> {
    return getFileContents(invokeCommand, this.requireScanCache(), path);
  }

  async listWorkspaceFiles(repoPath: string): Promise<WorkspaceFileTree> {
    return listWorkspaceFilesCommand(invokeCommand, repoPath);
  }

  async readWorkspaceFile(repoPath: string, relativePath: string): Promise<WorkspaceFileContents> {
    return readWorkspaceFileCommand(invokeCommand, repoPath, relativePath);
  }

  async previewWorkspaceFileOperation(
    repoPath: string,
    request: WorkspaceFileOperationPreviewRequest,
  ): Promise<WorkspaceFileOperationPreview> {
    return previewWorkspaceFileOperationCommand(invokeCommand, repoPath, request);
  }

  async createWorkspaceEntry(
    repoPath: string,
    request: WorkspaceFileMutationRequest,
  ): Promise<WorkspaceFileMutationResult> {
    const generation = this.sessionGeneration;
    const { result, payload } = await this.trackProjectMutation(() =>
      createWorkspaceEntryCommand(invokeCommand, repoPath, request),
    );
    this.applyWorkspaceMutationPayload(repoPath, payload, generation);
    return result;
  }

  async saveWorkspaceFile(
    repoPath: string,
    relativePath: string,
    content: string,
    expectedVersion: string,
  ): Promise<WorkspaceFileMutationResult> {
    const generation = this.sessionGeneration;
    const { result, payload } = await this.trackProjectMutation(() =>
      saveWorkspaceFileCommand(invokeCommand, repoPath, relativePath, content, expectedVersion),
    );
    this.applyWorkspaceMutationPayload(repoPath, payload, generation);
    return result;
  }

  async moveWorkspaceEntry(
    repoPath: string,
    request: WorkspaceFileMoveRequest,
  ): Promise<WorkspaceFileMutationResult> {
    const generation = this.sessionGeneration;
    const { result, payload } = await this.trackProjectMutation(() =>
      moveWorkspaceEntryCommand(invokeCommand, repoPath, request),
    );
    this.applyWorkspaceMutationPayload(repoPath, payload, generation);
    return result;
  }

  async deleteWorkspaceEntry(
    repoPath: string,
    request: WorkspaceFileDeleteRequest,
  ): Promise<WorkspaceFileMutationResult> {
    const generation = this.sessionGeneration;
    const { result, payload } = await this.trackProjectMutation(() =>
      deleteWorkspaceEntryCommand(invokeCommand, repoPath, request),
    );
    this.applyWorkspaceMutationPayload(repoPath, payload, generation);
    return result;
  }

  async getSymbol(symbolId: string): Promise<SymbolDetails> {
    return getSymbolDetails(this.requireScanCache(), symbolId);
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
    return getGraphViewCommand(
      invokeCommand,
      this.requireScanCache(),
      targetId,
      level,
      filters,
      settings,
    );
  }

  async getFlowView(symbolId: string): Promise<GraphView> {
    return getFlowViewCommand(invokeCommand, this.requireScanCache(), symbolId);
  }

  async parseFlowExpression(
    expression: string,
    inputSlotByName: Record<string, string> = {},
  ): Promise<FlowExpressionParseResult> {
    return parseFlowExpressionCommand(
      invokeCommand,
      this.requireScanCache(),
      expression,
      inputSlotByName,
    );
  }

  async applyStructuralEdit(request: StructuralEditRequest): Promise<StructuralEditResult> {
    const generation = this.sessionGeneration;
    const cache = this.requireScanCache();
    const { result, payload } = await this.trackProjectMutation(() =>
      applyStructuralEditCommand(invokeCommand, cache, request),
    );
    if (this.isCurrentSession(cache.session.path, generation)) {
      this.scanCache = buildScanCache(payload, cache.session, cache.backend);
    }
    return result;
  }

  async applyBackendUndo(transaction: BackendUndoTransaction) {
    const generation = this.sessionGeneration;
    const cache = this.requireScanCache();
    const { result, payload } = await this.trackProjectMutation(() =>
      applyBackendUndoCommand(invokeCommand, cache, transaction),
    );
    if (this.isCurrentSession(cache.session.path, generation)) {
      this.scanCache = buildScanCache(payload, cache.session, cache.backend);
    }
    return result;
  }

  async revealSource(targetId: string): Promise<RevealedSource> {
    return revealSourceCommand(invokeCommand, this.requireScanCache(), targetId);
  }

  async getEditableNodeSource(targetId: string): Promise<EditableNodeSource> {
    return getEditableNodeSourceCommand(invokeCommand, this.requireScanCache(), targetId);
  }

  async saveNodeSource(targetId: string, content: string): Promise<StructuralEditResult> {
    const generation = this.sessionGeneration;
    const cache = this.requireScanCache();
    const { result, payload } = await this.trackProjectMutation(() =>
      saveNodeSourceCommand(invokeCommand, cache, targetId, content),
    );
    if (this.isCurrentSession(cache.session.path, generation)) {
      this.scanCache = buildScanCache(payload, cache.session, cache.backend);
    }
    return result;
  }

  async openNodeInDefaultEditor(targetId: string): Promise<void> {
    await openNodeInDefaultEditorCommand(invokeCommand, this.requireScanCache(), targetId);
  }

  async openPathInDefaultEditor(relativePath: string): Promise<void> {
    await openPathInDefaultEditorCommand(invokeCommand, this.requireScanCache(), relativePath);
  }

  async revealNodeInFileExplorer(targetId: string): Promise<void> {
    await revealNodeInFileExplorerCommand(invokeCommand, this.requireScanCache(), targetId);
  }

  async revealPathInFileExplorer(relativePath: string): Promise<void> {
    await revealPathInFileExplorerCommand(invokeCommand, this.requireScanCache(), relativePath);
  }

  async getOverview(): Promise<OverviewData> {
    return getOverviewData(this.requireScanCache());
  }

  private async runScan(jobId: string, session: RepoSession, generation: number) {
    const job = this.jobs.get(jobId);
    if (!job) {
      return;
    }

    const repoPath = job.state.repoPath;

    try {
      const startedAt = Date.now();
      const payload = await scanRepoPayload(invokeCommand, repoPath, jobId);
      if (!this.isCurrentScan(jobId, repoPath, generation)) return;
      const completedAt = Date.now();
      const backend = await getLiveBackendStatus(invokeCommand, this.backendStatus);
      if (!this.isCurrentScan(jobId, repoPath, generation)) return;
      this.backendStatus = {
        ...backend,
        available: true,
        lastScanAt: new Date(completedAt).toISOString(),
        lastScanDurationMs: completedAt - startedAt,
        lastError: undefined,
      };
      this.scanCache = buildScanCache(payload, session, this.backendStatus);
      this.currentSession = session;
      rememberRecentRepo(session);

      const currentState = this.jobs.get(jobId)?.state;
      if (currentState && currentState.status !== "done") {
        this.updateJob(jobId, {
          ...currentState,
          status: "done",
          stage: "watch_ready",
          processedModules: payload.graph.report.module_count,
          totalModules: payload.graph.report.module_count,
          symbolCount: payload.graph.report.symbol_count,
          message:
            this.backendStatus.syncState === "manual_resync_required"
              ? "Workspace ready. Live sync needs manual reindex."
              : this.backendStatus.syncState === "synced"
                ? "Workspace ready. Watching for workspace changes."
                : "Workspace ready",
          progressPercent: 100,
          error: undefined,
          recoveryEvents: toRecoveryEvents(payload.recovery_events),
        });
      }
    } catch (reason) {
      if (!this.isCurrentScan(jobId, repoPath, generation)) return;
      const message = toMessage(reason);
      const currentState = this.jobs.get(jobId)?.state;
      this.backendStatus = {
        ...this.backendStatus,
        lastError: message,
        lastScanAt: new Date().toISOString(),
      };
      this.updateJob(jobId, {
        ...(currentState ?? job.state),
        status: "error",
        stage: currentState?.stage ?? "discover",
        message: currentState?.message ?? "Scan failed",
        progressPercent: 100,
        error: message,
      });
    }
  }

  private selectSession(session: RepoSession) {
    ++this.sessionGeneration;
    this.currentSession = session;
    this.scanCache = undefined;
    this.activeScanJobId = undefined;
  }

  private isCurrentSession(repoPath: string, generation: number): boolean {
    return (
      generation === this.sessionGeneration &&
      (!this.currentSession || this.currentSession.path === normalizePath(repoPath))
    );
  }

  private isCurrentScan(jobId: string, repoPath: string, generation: number): boolean {
    return jobId === this.activeScanJobId && this.isCurrentSession(repoPath, generation);
  }

  private updateJob(jobId: string, nextState: IndexingJobState) {
    const job = this.jobs.get(jobId);
    if (!job) {
      return;
    }

    job.state = nextState;
    job.listeners.forEach((listener) => listener(job.state));
  }

  private requireScanCache(): ScanCache {
    if (!this.scanCache) {
      throw new Error("No repo has been indexed in the desktop shell yet.");
    }
    return this.scanCache;
  }

  private applyWorkspaceMutationPayload(
    repoPath: string,
    payload: RawScanPayload | null | undefined,
    generation: number,
  ) {
    if (!payload || !this.isCurrentSession(repoPath, generation)) {
      return;
    }

    const normalizedRepoPath = normalizePath(repoPath);
    const session = this.currentSession ?? buildRepoSessionFromPath(normalizedRepoPath);
    this.currentSession = session;
    this.scanCache = buildScanCache(payload, session, this.backendStatus);
  }
}
