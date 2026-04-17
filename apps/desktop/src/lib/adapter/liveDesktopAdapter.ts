import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  BackendUndoTransaction,
  BackendStatus,
  DesktopAdapter,
  EditableNodeSource,
  FileContents,
  FlowGraphDocument,
  GraphAbstractionLevel,
  GraphActionDto,
  GraphBreadcrumbDto,
  GraphEdgeDto,
  GraphFilters,
  GraphFocusDto,
  GraphSettings,
  GraphNeighborhood,
  GraphNodeDto,
  GraphView,
  IndexStage,
  IndexingJobState,
  OverviewData,
  OverviewOutlineItem,
  OverviewModule,
  RecentRepo,
  RelationshipItem,
  RepoSession,
  RevealedSource,
  SearchFilters,
  SearchResult,
  StructuralEditRequest,
  StructuralEditResult,
  SymbolDetails,
  WorkspaceSyncEvent,
  WorkspaceSyncSnapshot,
  WorkspaceSyncState,
} from "./contracts";

const RECENT_REPOS_STORAGE_KEY = "helm.desktop.recentRepos";
const DEFAULT_PYTHON_COMMAND = "python3";

interface RawSourceSpan {
  file_path: string;
  start_line: number;
  start_column: number;
  end_line: number;
  end_column: number;
  start_offset: number;
  end_offset: number;
}

interface RawGraphNode {
  node_id: string;
  kind: "repo" | "module" | "symbol";
  name: string;
  display_name: string;
  file_path: string | null;
  module_name: string | null;
  qualname: string | null;
  span?: RawSourceSpan;
  is_external: boolean;
  metadata: Record<string, unknown>;
}

interface RawGraphEdge {
  edge_id: string;
  kind: "contains" | "imports" | "defines" | "calls";
  source_id: string;
  target_id: string;
  metadata: Record<string, unknown>;
}

interface RawDiagnostic {
  code: string;
  message: string;
  file_path: string;
  severity: string;
  line?: number | null;
  column?: number | null;
}

interface RawModuleSummary {
  module_id: string;
  module_name: string;
  relative_path: string;
  symbol_count: number;
  import_count: number;
  outgoing_call_count: number;
}

interface RawScanPayload {
  summary: {
    repo_path: string;
    module_count: number;
    symbol_count: number;
    import_edge_count: number;
    call_edge_count: number;
    unresolved_call_count: number;
    diagnostic_count: number;
    modules: RawModuleSummary[];
  };
  graph: {
    root_path: string;
    repo_id: string;
    nodes: RawGraphNode[];
    edges: RawGraphEdge[];
    diagnostics: RawDiagnostic[];
    unresolved_calls: Array<Record<string, unknown>>;
    report: {
      module_count: number;
      symbol_count: number;
      import_edge_count: number;
      call_edge_count: number;
      unresolved_call_count: number;
      diagnostic_count: number;
    };
  };
  workspace: {
    language: string;
    default_level: GraphAbstractionLevel;
    default_focus_node_id: string;
    source_hidden_by_default: boolean;
    supported_edit_kinds: string[];
    session_version?: number;
  };
}

interface RawGraphAction {
  action_id: string;
  label: string;
  enabled: boolean;
  reason?: string | null;
  payload: Record<string, unknown>;
}

interface RawGraphViewNode {
  node_id: string;
  kind:
    | "repo"
    | "module"
    | "symbol"
    | "function"
    | "class"
    | "enum"
    | "variable"
    | "entry"
    | "param"
    | "assign"
    | "call"
    | "branch"
    | "loop"
    | "return"
    | "exit";
  label: string;
  subtitle?: string | null;
  metadata: Record<string, unknown>;
  available_actions: RawGraphAction[];
}

interface RawGraphViewEdge {
  edge_id: string;
  kind: "contains" | "imports" | "defines" | "calls" | "controls" | "data";
  source_id: string;
  target_id: string;
  label?: string | null;
  metadata: Record<string, unknown>;
}

interface RawGraphView {
  root_node_id: string;
  target_id: string;
  level: GraphAbstractionLevel;
  nodes: RawGraphViewNode[];
  edges: RawGraphViewEdge[];
  breadcrumbs: Array<{
    node_id: string;
    level: GraphAbstractionLevel;
    label: string;
    subtitle?: string | null;
  }>;
  focus?: {
    target_id: string;
    level: GraphAbstractionLevel;
    label: string;
    subtitle?: string | null;
    available_levels: GraphAbstractionLevel[];
  } | null;
  truncated: boolean;
  flow_state?: {
    editable: boolean;
    sync_state: "clean" | "draft" | "import_error";
    diagnostics: string[];
    document?: {
      symbol_id: string;
      relative_path: string;
      qualname: string;
      nodes: Array<{
        id: string;
        kind: "entry" | "assign" | "call" | "branch" | "loop" | "return" | "exit";
        payload: Record<string, unknown>;
        indexed_node_id?: string | null;
      }>;
      edges: Array<{
        id: string;
        source_id: string;
        source_handle: string;
        target_id: string;
        target_handle: string;
      }>;
      value_model_version?: number | null;
      function_inputs?: Array<{
        id: string;
        name: string;
        index: number;
      }>;
      value_sources?: Array<{
        id: string;
        node_id: string;
        name: string;
        label: string;
      }>;
      input_slots?: Array<{
        id: string;
        node_id: string;
        slot_key: string;
        label: string;
        required: boolean;
      }>;
      input_bindings?: Array<{
        id: string;
        source_id?: string;
        function_input_id?: string;
        slot_id: string;
      }>;
      sync_state: "clean" | "draft" | "import_error";
      diagnostics: string[];
      source_hash?: string | null;
      editable: boolean;
    } | null;
  } | null;
}

interface RawBackendHealth {
  mode: "live";
  available: boolean;
  python_command: string;
  workspace_root: string;
  note: string;
  live_sync_enabled: boolean;
  sync_state: WorkspaceSyncState;
  last_sync_error?: string | null;
}

interface RawWorkspaceSyncSnapshot {
  repo_id: string;
  default_focus_node_id: string;
  default_level: GraphAbstractionLevel;
  node_ids: string[];
}

interface RawWorkspaceSyncEvent {
  repo_path: string;
  session_version: number;
  reason: string;
  status: WorkspaceSyncState;
  changed_relative_paths: string[];
  needs_manual_resync: boolean;
  payload?: RawScanPayload | null;
  snapshot?: RawWorkspaceSyncSnapshot | null;
  message?: string | null;
}

interface RawIndexProgressEvent {
  job_id: string;
  repo_path: string;
  status: IndexingJobState["status"];
  stage: IndexStage;
  processed_modules: number;
  total_modules: number;
  symbol_count: number;
  message: string;
  progress_percent?: number | null;
  error?: string | null;
}

interface RawEditResult {
  request: {
    kind: StructuralEditRequest["kind"];
    target_id?: string | null;
    relative_path?: string | null;
    new_name?: string | null;
    symbol_kind?: string | null;
    destination_relative_path?: string | null;
    imported_module?: string | null;
    imported_name?: string | null;
    alias?: string | null;
    anchor_edge_id?: string | null;
    body?: string | null;
    content?: string | null;
    flow_graph?: Record<string, unknown> | null;
  };
  summary: string;
  touched_relative_paths: string[];
  reparsed_relative_paths: string[];
  changed_node_ids: string[];
  warnings: string[];
  flow_sync_state?: "clean" | "draft" | "import_error" | null;
  diagnostics?: string[];
  undo_transaction?: {
    summary: string;
    request_kind: StructuralEditRequest["kind"];
    file_snapshots: Array<{
      relative_path: string;
      existed: boolean;
      content?: string | null;
    }>;
    changed_node_ids: string[];
    focus_target?: {
      target_id: string;
      level: GraphAbstractionLevel;
    } | null;
  } | null;
}

interface RawApplyEditResponse {
  edit: RawEditResult;
  payload: RawScanPayload;
}

interface RawUndoResult {
  summary: string;
  restored_relative_paths: string[];
  warnings: string[];
  focus_target?: {
    target_id: string;
    level: GraphAbstractionLevel;
  } | null;
}

interface RawApplyUndoResponse {
  undo: RawUndoResult;
  payload: RawScanPayload;
}

interface RawEditableNodeSource {
  target_id: string;
  title: string;
  path: string;
  start_line: number;
  end_line: number;
  start_column?: number | null;
  end_column?: number | null;
  content: string;
  editable: boolean;
  node_kind: GraphNodeDto["kind"];
  reason?: string | null;
}

interface ScanJob {
  state: IndexingJobState;
  listeners: Set<(state: IndexingJobState) => void>;
}

interface ScanCache {
  payload: RawScanPayload;
  session: RepoSession;
  backend: BackendStatus;
  nodeById: Map<string, RawGraphNode>;
  edgesBySource: Map<string, RawGraphEdge[]>;
  edgesByTarget: Map<string, RawGraphEdge[]>;
  degreeByNodeId: Map<string, number>;
  moduleByRelativePath: Map<string, RawGraphNode>;
  relativePathByAbsolute: Map<string, string>;
  absolutePathByRelative: Map<string, string>;
  searchEntries: SearchResult[];
}

export class LiveDesktopAdapter implements DesktopAdapter {
  readonly isMock = false;

  private currentSession?: RepoSession;
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
    this.indexProgressUnlisten = listen<RawIndexProgressEvent>(
      "helm://index-progress",
      (event) => {
        this.handleIndexProgress(event.payload);
      },
    ).catch(() => () => {});
    this.workspaceSyncUnlisten = listen<RawWorkspaceSyncEvent>(
      "helm://workspace-sync",
      (event) => {
        this.handleWorkspaceSync(event.payload);
      },
    ).catch(() => () => {});
  }

  private handleIndexProgress(raw: RawIndexProgressEvent) {
    this.updateJob(raw.job_id, toIndexingJobState(raw));
  }

  private handleWorkspaceSync(raw: RawWorkspaceSyncEvent) {
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
    let resolvedPath = path;
    if (!resolvedPath) {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Open repository",
      });

      if (!selected || Array.isArray(selected)) {
        throw new Error("Repository selection was cancelled.");
      }

      resolvedPath = selected;
    }

    const session = buildRepoSessionFromPath(resolvedPath);
    this.currentSession = session;
    return session;
  }

  async listRecentRepos(): Promise<RecentRepo[]> {
    return loadRecentRepos();
  }

  async getBackendStatus(): Promise<BackendStatus> {
    try {
      const raw = await invoke<RawBackendHealth>("backend_health");
      this.backendStatus = {
        ...this.backendStatus,
        mode: raw.mode,
        available: raw.available,
        pythonCommand: raw.python_command,
        workspaceRoot: raw.workspace_root,
        note: raw.note,
        liveSyncEnabled: raw.live_sync_enabled,
        syncState: raw.sync_state,
        lastSyncError: raw.last_sync_error ?? undefined,
        lastError: undefined,
      };
    } catch (reason) {
      const message = toMessage(reason);
      this.backendStatus = {
        ...this.backendStatus,
        mode: "live",
        available: false,
        liveSyncEnabled: false,
        syncState: "error",
        note: "The desktop shell could not reach the Python bridge.",
        lastSyncError: message,
        lastError: message,
      };
    }

    return this.backendStatus;
  }

  subscribeWorkspaceSync(onUpdate: (event: WorkspaceSyncEvent) => void): () => void {
    this.workspaceSyncListeners.add(onUpdate);
    return () => {
      this.workspaceSyncListeners.delete(onUpdate);
    };
  }

  async startIndex(repoPath: string): Promise<{ jobId: string }> {
    const jobId = `index:${repoPath}:${Date.now()}`;
    const job: ScanJob = {
      state: {
        jobId,
        repoPath,
        status: "queued",
        stage: "discover",
        processedModules: 0,
        totalModules: 0,
        symbolCount: 0,
        message: "Waiting for backend indexing to begin",
        progressPercent: 0,
      },
      listeners: new Set(),
    };
    this.jobs.set(jobId, job);
    this.scanCache = undefined;
    void this.runScan(jobId);
    return { jobId };
  }

  subscribeIndexProgress(
    jobId: string,
    onUpdate: (state: IndexingJobState) => void,
  ): () => void {
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
    const cache = this.requireScanCache();
    const normalized = query.trim().toLowerCase();

    const results = cache.searchEntries.filter((entry) => {
      if (entry.kind === "file" && !filters.includeFiles) {
        return false;
      }
      if (entry.kind === "module" && !filters.includeModules) {
        return false;
      }
      if (entry.kind === "symbol" && !filters.includeSymbols) {
        return false;
      }
      if (!normalized) {
        return true;
      }
      return (
        entry.title.toLowerCase().includes(normalized) ||
        entry.subtitle.toLowerCase().includes(normalized) ||
        entry.filePath.toLowerCase().includes(normalized)
      );
    });

    return results
      .map((result) => ({
        ...result,
        score: scoreSearchResult(result, normalized, cache.degreeByNodeId),
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, 24);
  }

  async getFile(path: string): Promise<FileContents> {
    const cache = this.requireScanCache();
    const absolutePath = cache.absolutePathByRelative.get(path);
    if (!absolutePath) {
      throw new Error(`No indexed file matched ${path}.`);
    }

    const content = await invoke<string>("read_repo_file", {
      filePath: absolutePath,
    });
    const linkedSymbols = cache.searchEntries
      .filter((entry) => entry.kind === "symbol" && entry.filePath === path)
      .slice(0, 12);

    return {
      path,
      language: languageFromPath(path),
      lineCount: content ? content.split("\n").length : 0,
      sizeBytes: new TextEncoder().encode(content).length,
      content,
      linkedSymbols,
    };
  }

  async getSymbol(symbolId: string): Promise<SymbolDetails> {
    const cache = this.requireScanCache();
    const node = cache.nodeById.get(symbolId);
    if (!node || node.kind !== "symbol") {
      throw new Error(`No indexed symbol matched ${symbolId}.`);
    }

    const callers = (cache.edgesByTarget.get(symbolId) ?? [])
      .filter((edge) => edge.kind === "calls")
      .map((edge) => toRelationship(edge.source_id, cache));
    const callees = (cache.edgesBySource.get(symbolId) ?? [])
      .filter((edge) => edge.kind === "calls")
      .map((edge) => toRelationship(edge.target_id, cache));
    const references = [
      ...(cache.edgesByTarget.get(symbolId) ?? []).filter((edge) =>
        edge.kind === "defines" || edge.kind === "contains",
      ),
      ...(cache.edgesBySource.get(symbolId) ?? []).filter((edge) => edge.kind === "imports"),
    ].map((edge) =>
      toRelationship(edge.source_id === symbolId ? edge.target_id : edge.source_id, cache),
    );

    const filePath = relativePathForNode(node, cache);
    const startLine = node.span?.start_line ?? 1;
    const endLine = node.span?.end_line ?? startLine;
    const kind = String(node.metadata.symbol_kind ?? "symbol");

    return {
      symbolId: node.node_id,
      nodeId: node.node_id,
      kind,
      name: node.name,
      qualname: node.qualname ?? node.display_name,
      moduleName: node.module_name ?? "unknown",
      filePath,
      signature: buildSignature(node),
      docSummary: buildDocSummary(node, cache),
      startLine,
      endLine,
      callers,
      callees,
      references,
      metadata: {
        Module: node.module_name ?? "unknown",
        File: filePath,
        External: node.is_external ? "yes" : "no",
        Kind: kind,
      },
    };
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
    const cache = this.requireScanCache();
    const raw = await invoke<RawGraphView>("graph_view", {
      repoPath: cache.session.path,
      targetId,
      level,
      filtersJson: JSON.stringify({
        ...filters,
        includeExternalDependencies: settings.includeExternalDependencies,
      }),
    });
    return layoutGraphView(raw);
  }

  async getFlowView(symbolId: string): Promise<GraphView> {
    const cache = this.requireScanCache();
    const raw = await invoke<RawGraphView>("flow_view", {
      repoPath: cache.session.path,
      symbolId,
    });
    return layoutGraphView(raw);
  }

  async applyStructuralEdit(request: StructuralEditRequest): Promise<StructuralEditResult> {
    const cache = this.requireScanCache();
    const response = await invoke<RawApplyEditResponse>("apply_structural_edit", {
      repoPath: cache.session.path,
      requestJson: JSON.stringify(toRawEditRequest(request)),
    });
    this.scanCache = buildScanCache(response.payload, cache.session, cache.backend);
    return toStructuralEditResult(response.edit);
  }

  async applyBackendUndo(transaction: BackendUndoTransaction) {
    const cache = this.requireScanCache();
    const response = await invoke<RawApplyUndoResponse>("apply_backend_undo", {
      repoPath: cache.session.path,
      transactionJson: JSON.stringify(toRawUndoTransaction(transaction)),
    });
    this.scanCache = buildScanCache(response.payload, cache.session, cache.backend);
    return toBackendUndoResult(response.undo);
  }

  async revealSource(targetId: string): Promise<RevealedSource> {
    const cache = this.requireScanCache();
    const raw = await invoke<{
      target_id: string;
      title: string;
      path: string;
      start_line: number;
      end_line: number;
      content: string;
    }>("reveal_source", {
      repoPath: cache.session.path,
      targetId,
    });
    return {
      targetId: raw.target_id,
      title: raw.title,
      path: raw.path,
      startLine: raw.start_line,
      endLine: raw.end_line,
      content: raw.content,
    };
  }

  async getEditableNodeSource(targetId: string): Promise<EditableNodeSource> {
    const cache = this.requireScanCache();
    const raw = await invoke<RawEditableNodeSource>("editable_node_source", {
      repoPath: cache.session.path,
      targetId,
    });
    return {
      targetId: raw.target_id,
      title: raw.title,
      path: raw.path,
      startLine: raw.start_line,
      endLine: raw.end_line,
      startColumn: raw.start_column ?? undefined,
      endColumn: raw.end_column ?? undefined,
      content: raw.content,
      editable: raw.editable,
      nodeKind: raw.node_kind,
      reason: raw.reason ?? undefined,
    };
  }

  async saveNodeSource(targetId: string, content: string): Promise<StructuralEditResult> {
    const cache = this.requireScanCache();
    const response = await invoke<RawApplyEditResponse>("save_node_source", {
      repoPath: cache.session.path,
      targetId,
      contentJson: JSON.stringify(content),
    });
    this.scanCache = buildScanCache(response.payload, cache.session, cache.backend);
    return toStructuralEditResult(response.edit);
  }

  async openNodeInDefaultEditor(targetId: string): Promise<void> {
    const cache = this.requireScanCache();
    const node = cache.nodeById.get(targetId);
    if (!node?.file_path) {
      throw new Error(`No source file is associated with ${targetId}.`);
    }
    await invoke("open_path_in_default_editor", {
      filePath: normalizePath(node.file_path),
    });
  }

  async revealNodeInFileExplorer(targetId: string): Promise<void> {
    const cache = this.requireScanCache();
    const node = cache.nodeById.get(targetId);
    if (!node?.file_path) {
      throw new Error(`No source file is associated with ${targetId}.`);
    }
    await invoke("reveal_path_in_file_explorer", {
      filePath: normalizePath(node.file_path),
    });
  }

  async getOverview(): Promise<OverviewData> {
    const cache = this.requireScanCache();
    const topSymbols = topSymbolResults(cache, 5);
    const savedViews = [
      {
        id: "saved:architecture",
        label: "Architecture Map",
        description: "Start at the repo boundary and inspect module interactions.",
        nodeId: cache.payload.graph.repo_id,
        level: "repo" as GraphAbstractionLevel,
      },
      ...topSymbols.slice(0, 2).map((symbol, index) => ({
        id: `saved:${symbol.id}`,
        label: index === 0 ? "Primary Blueprint" : `Focus ${index + 1}`,
        description: `Inspect ${symbol.subtitle} without opening raw source.`,
        nodeId: symbol.nodeId ?? symbol.id,
        level: "symbol" as GraphAbstractionLevel,
      })),
    ];

    const modules = buildOverviewModules(cache);

    const diagnostics = cache.payload.graph.diagnostics
      .slice(0, 3)
      .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`);
    if (!diagnostics.length) {
      diagnostics.push("No parser diagnostics were reported in the last scan.");
    }

    return {
      repo: cache.session,
      metrics: [
        { label: "Modules", value: String(cache.payload.summary.module_count) },
        { label: "Symbols", value: String(cache.payload.summary.symbol_count) },
        {
          label: "Calls",
          value: String(cache.payload.summary.call_edge_count),
          tone: "accent",
        },
        { label: "Diagnostics", value: String(cache.payload.summary.diagnostic_count) },
      ],
      modules,
      hotspots: buildHotspots(cache),
      savedViews,
      focusSymbols: topSymbols,
      diagnostics,
      backend: cache.backend,
      defaultLevel: cache.payload.workspace.default_level,
      defaultFocusNodeId: cache.payload.workspace.default_focus_node_id,
    };
  }

  private async runScan(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job) {
      return;
    }

    const repoPath = job.state.repoPath;

    try {
      const startedAt = Date.now();
      const payload = await invoke<RawScanPayload>("scan_repo_payload", { repoPath, jobId });
      const completedAt = Date.now();
      const backend = await this.getBackendStatus();
      const session = this.currentSession ?? buildRepoSessionFromPath(repoPath);
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
                ? "Workspace ready. Watching for Python changes."
                : "Workspace ready",
          progressPercent: 100,
          error: undefined,
        });
      }
    } catch (reason) {
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
}

function buildRepoSessionFromPath(path: string): RepoSession {
  const normalizedPath = normalizePath(path);
  const segments = normalizedPath.split("/").filter(Boolean);
  const name = segments[segments.length - 1] ?? "repo";
  return {
    id: `repo:${normalizedPath}`,
    name,
    path: normalizedPath,
    branch: "local",
    primaryLanguage: "Python",
    openedAt: new Date().toISOString(),
  };
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function loadRecentRepos(): RecentRepo[] {
  try {
    const raw = window.localStorage.getItem(RECENT_REPOS_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rememberRecentRepo(session: RepoSession) {
  const current = loadRecentRepos();
  const next: RecentRepo[] = [
    {
      name: session.name,
      path: session.path,
      branch: session.branch,
      lastOpenedAt: new Date().toISOString(),
    },
    ...current.filter((repo) => repo.path !== session.path),
  ].slice(0, 8);
  window.localStorage.setItem(RECENT_REPOS_STORAGE_KEY, JSON.stringify(next));
}

function buildScanCache(
  payload: RawScanPayload,
  session: RepoSession,
  backend: BackendStatus,
): ScanCache {
  const nodeById = new Map(payload.graph.nodes.map((node) => [node.node_id, node]));
  const edgesBySource = new Map<string, RawGraphEdge[]>();
  const edgesByTarget = new Map<string, RawGraphEdge[]>();
  const degreeByNodeId = new Map<string, number>();
  const moduleByRelativePath = new Map<string, RawGraphNode>();
  const relativePathByAbsolute = new Map<string, string>();
  const absolutePathByRelative = new Map<string, string>();

  payload.graph.edges.forEach((edge) => {
    edgesBySource.set(edge.source_id, [...(edgesBySource.get(edge.source_id) ?? []), edge]);
    edgesByTarget.set(edge.target_id, [...(edgesByTarget.get(edge.target_id) ?? []), edge]);
    degreeByNodeId.set(edge.source_id, (degreeByNodeId.get(edge.source_id) ?? 0) + 1);
    degreeByNodeId.set(edge.target_id, (degreeByNodeId.get(edge.target_id) ?? 0) + 1);
  });

  payload.graph.nodes.forEach((node) => {
    const relativePath = relativePathForRawNode(node, payload.graph.root_path);
    if (node.kind === "module" && !node.is_external) {
      moduleByRelativePath.set(relativePath, node);
    }
    if (node.file_path) {
      relativePathByAbsolute.set(normalizePath(node.file_path), relativePath);
      absolutePathByRelative.set(relativePath, normalizePath(node.file_path));
    }
  });

  const cache: ScanCache = {
    payload,
    session,
    backend,
    nodeById,
    edgesBySource,
    edgesByTarget,
    degreeByNodeId,
    moduleByRelativePath,
    relativePathByAbsolute,
    absolutePathByRelative,
    searchEntries: [],
  };
  cache.searchEntries = buildSearchEntries(cache);
  return cache;
}

function buildSearchEntries(cache: ScanCache): SearchResult[] {
  const moduleEntries = cache.payload.graph.nodes
    .filter((node) => node.kind === "module" && !node.is_external)
    .map((node) => {
      const filePath = relativePathForNode(node, cache);
      return {
        id: node.node_id,
        kind: "module" as const,
        title: node.module_name ?? node.name,
        subtitle: filePath,
        score: 0,
        filePath,
        nodeId: node.node_id,
        level: "module" as GraphAbstractionLevel,
      };
    });
  const fileEntries = cache.payload.graph.nodes
    .filter((node) => node.kind === "module" && !node.is_external)
    .map((node) => {
      const filePath = relativePathForNode(node, cache);
      return {
        id: `file:${filePath}`,
        kind: "file" as const,
        title: filePath,
        subtitle: "Raw source utility",
        score: 0,
        filePath,
        nodeId: node.node_id,
        level: "module" as GraphAbstractionLevel,
      };
    });
  const symbolEntries = cache.payload.graph.nodes
    .filter((node) => node.kind === "symbol")
    .map((node) => ({
      id: node.node_id,
      kind: "symbol" as const,
      title: node.name,
      subtitle: node.qualname ?? node.display_name,
      score: 0,
      filePath: relativePathForNode(node, cache),
      symbolId: node.node_id,
      nodeId: node.node_id,
      level: "symbol" as GraphAbstractionLevel,
    }));

  return [...symbolEntries, ...moduleEntries, ...fileEntries];
}

function relativePathForRawNode(node: RawGraphNode, rootPath: string): string {
  if (typeof node.metadata.relative_path === "string") {
    return node.metadata.relative_path;
  }
  if (!node.file_path) {
    return node.display_name;
  }
  const normalizedRoot = normalizePath(rootPath);
  const normalizedFile = normalizePath(node.file_path);
  if (normalizedFile.startsWith(`${normalizedRoot}/`)) {
    return normalizedFile.slice(normalizedRoot.length + 1);
  }
  return normalizedFile;
}

function relativePathForNode(node: RawGraphNode, cache: ScanCache): string {
  if (typeof node.metadata.relative_path === "string") {
    return node.metadata.relative_path;
  }
  if (!node.file_path) {
    return node.display_name;
  }
  return cache.relativePathByAbsolute.get(normalizePath(node.file_path)) ?? node.display_name;
}

function toRelationship(nodeId: string, cache: ScanCache): RelationshipItem {
  const node = cache.nodeById.get(nodeId);
  if (!node) {
    return {
      id: nodeId,
      label: nodeId,
      subtitle: "Unavailable node",
      nodeId,
    };
  }

  return {
    id: node.node_id,
    label: node.name,
    subtitle:
      node.kind === "symbol"
        ? node.qualname ?? node.display_name
        : relativePathForNode(node, cache),
    nodeId: node.node_id,
    symbolId: node.kind === "symbol" ? node.node_id : undefined,
  };
}

function buildSignature(node: RawGraphNode): string {
  const symbolKind = String(node.metadata.symbol_kind ?? "symbol");
  if (symbolKind === "class") {
    return `${node.qualname ?? node.display_name} class`;
  }
  if (symbolKind === "enum") {
    return `${node.qualname ?? node.display_name} enum`;
  }
  if (symbolKind === "variable") {
    return `${node.qualname ?? node.display_name} value`;
  }
  return `${node.qualname ?? node.display_name}(...)`;
}

function buildDocSummary(node: RawGraphNode, cache: ScanCache): string {
  const symbolKind = String(node.metadata.symbol_kind ?? "symbol");
  const inboundCalls = (cache.edgesByTarget.get(node.node_id) ?? []).filter(
    (edge) => edge.kind === "calls",
  ).length;
  const outboundCalls = (cache.edgesBySource.get(node.node_id) ?? []).filter(
    (edge) => edge.kind === "calls",
  ).length;

  return `${capitalize(symbolKind)} in ${node.module_name ?? "this module"} with ${inboundCalls} inbound and ${outboundCalls} outbound structural call links in the current scan.`;
}

function topSymbolResults(cache: ScanCache, limit: number): SearchResult[] {
  return cache.searchEntries
    .filter((entry) => entry.kind === "symbol")
    .sort(
      (left, right) =>
        (cache.degreeByNodeId.get(right.nodeId ?? right.id) ?? 0) -
        (cache.degreeByNodeId.get(left.nodeId ?? left.id) ?? 0),
    )
    .slice(0, limit);
}

function buildHotspots(cache: ScanCache) {
  const topModule = cache.payload.summary.modules[0];
  const hotspots = [];
  if (topModule) {
    hotspots.push({
      title: `${topModule.module_name} anchors the architecture map`,
      description: `${topModule.relative_path} currently leads the scan with ${topModule.symbol_count} symbols and ${topModule.outgoing_call_count} outgoing calls.`,
    });
  }
  hotspots.push({
    title: `${cache.payload.workspace.default_level} is the default opening level`,
    description:
      cache.payload.workspace.default_level === "module"
        ? "This repo is large enough to open at the module architecture layer first."
        : "This repo is compact enough to open directly at the symbol layer.",
  });
  hotspots.push({
    title: `${cache.payload.graph.report.diagnostic_count} parser diagnostics`,
    description:
      cache.payload.graph.report.diagnostic_count > 0
        ? "Diagnostics are surfaced in the overview so you can validate parser edge cases without leaving the graph editor."
        : "No parser diagnostics were surfaced in the last scan.",
  });
  return hotspots;
}

function buildOverviewModules(cache: ScanCache): OverviewModule[] {
  const symbolCountByModule = new Map<string, number>();
  const importCountByModule = new Map<string, number>();
  const callCountByModule = new Map<string, number>();

  cache.payload.graph.nodes.forEach((node) => {
    if (node.kind === "symbol" && node.module_name) {
      const moduleId = `module:${node.module_name}`;
      symbolCountByModule.set(moduleId, (symbolCountByModule.get(moduleId) ?? 0) + 1);
    }
  });

  cache.payload.graph.edges.forEach((edge) => {
    const sourceNode = cache.nodeById.get(edge.source_id);
    const targetNode = cache.nodeById.get(edge.target_id);
    const moduleName =
      sourceNode?.kind === "module"
        ? sourceNode.module_name
        : sourceNode?.module_name;
    if (!moduleName) {
      return;
    }
    const moduleId = `module:${moduleName}`;
    if (edge.kind === "imports" && targetNode?.is_external !== true) {
      importCountByModule.set(moduleId, (importCountByModule.get(moduleId) ?? 0) + 1);
    }
    if (edge.kind === "calls") {
      callCountByModule.set(moduleId, (callCountByModule.get(moduleId) ?? 0) + 1);
    }
  });

  return cache.payload.graph.nodes
    .filter((node) => node.kind === "module" && !node.is_external)
    .sort((left, right) =>
      relativePathForNode(left, cache).localeCompare(relativePathForNode(right, cache)),
    )
    .map((node) => ({
      id: `module:${node.node_id}`,
      moduleId: node.node_id,
      moduleName: node.module_name ?? node.name,
      relativePath: relativePathForNode(node, cache),
      symbolCount: symbolCountByModule.get(node.node_id) ?? 0,
      importCount: importCountByModule.get(node.node_id) ?? 0,
      callCount: callCountByModule.get(node.node_id) ?? 0,
      outline: buildModuleOutline(node, cache),
    }));
}

function buildModuleOutline(
  moduleNode: RawGraphNode,
  cache: ScanCache,
): OverviewOutlineItem[] {
  return (cache.edgesBySource.get(moduleNode.node_id) ?? [])
    .filter((edge) => edge.kind === "defines")
    .map((edge) => cache.nodeById.get(edge.target_id))
    .filter((node): node is RawGraphNode => {
      if (!node || node.kind !== "symbol" || node.is_external) {
        return false;
      }
      return isOutlineSymbolKind(String(node.metadata.symbol_kind ?? ""));
    })
    .sort((left, right) => {
      const lineDelta = (left.span?.start_line ?? Number.MAX_SAFE_INTEGER) - (right.span?.start_line ?? Number.MAX_SAFE_INTEGER);
      if (lineDelta !== 0) {
        return lineDelta;
      }
      return left.name.localeCompare(right.name);
    })
    .map((node) => ({
      id: `outline:${node.node_id}`,
      nodeId: node.node_id,
      label: node.name,
      kind: String(node.metadata.symbol_kind ?? "function") as OverviewOutlineItem["kind"],
      startLine: node.span?.start_line ?? 0,
      topLevel: true,
    }));
}

function isOutlineSymbolKind(value: string): value is OverviewOutlineItem["kind"] {
  return (
    value === "function"
    || value === "async_function"
    || value === "class"
    || value === "enum"
    || value === "variable"
  );
}

function scoreSearchResult(
  result: SearchResult,
  query: string,
  degreeByNodeId: Map<string, number>,
): number {
  const degree = degreeByNodeId.get(result.nodeId ?? result.id) ?? 0;
  const kindWeight =
    result.kind === "symbol" ? 18 : result.kind === "module" ? 12 : 2;
  if (!query) {
    return degree + kindWeight;
  }

  const haystacks = [result.title.toLowerCase(), result.subtitle.toLowerCase(), result.filePath];
  let score = degree + kindWeight;
  if (haystacks.some((value) => value === query)) {
    score += 60;
  }
  if (haystacks.some((value) => value.startsWith(query))) {
    score += 30;
  }
  if (haystacks.some((value) => value.includes(query))) {
    score += 12;
  }
  return score;
}

function languageFromPath(path: string): string {
  if (path.endsWith(".py")) {
    return "python";
  }
  if (path.endsWith(".ts") || path.endsWith(".tsx")) {
    return "typescript";
  }
  return "text";
}

function capitalize(value: string): string {
  if (!value) {
    return value;
  }
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function toMessage(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.message;
  }
  if (typeof reason === "string") {
    return reason;
  }
  return "Unknown desktop bridge failure.";
}

function toRawEditRequest(request: StructuralEditRequest) {
  return {
    kind: request.kind,
    target_id: request.targetId,
    relative_path: request.relativePath,
    new_name: request.newName,
    symbol_kind: request.symbolKind,
    destination_relative_path: request.destinationRelativePath,
    imported_module: request.importedModule,
    imported_name: request.importedName,
    alias: request.alias,
    anchor_edge_id: request.anchorEdgeId,
    body: request.body,
    content: request.content,
    flow_graph: request.flowGraph
      ? {
          symbol_id: request.flowGraph.symbolId,
          relative_path: request.flowGraph.relativePath,
          qualname: request.flowGraph.qualname,
          nodes: request.flowGraph.nodes.map((node) => ({
            id: node.id,
            kind: node.kind,
            payload: node.payload,
            ...(node.indexedNodeId ? { indexed_node_id: node.indexedNodeId } : {}),
          })),
          edges: request.flowGraph.edges.map((edge) => ({
            id: edge.id,
            source_id: edge.sourceId,
            source_handle: edge.sourceHandle,
            target_id: edge.targetId,
            target_handle: edge.targetHandle,
          })),
          value_model_version: request.flowGraph.valueModelVersion ?? 1,
          function_inputs: (request.flowGraph.functionInputs ?? []).map((input) => ({
            id: input.id,
            name: input.name,
            index: input.index,
          })),
          value_sources: (request.flowGraph.valueSources ?? []).map((source) => ({
            id: source.id,
            node_id: source.nodeId,
            name: source.name,
            label: source.label,
          })),
          input_slots: (request.flowGraph.inputSlots ?? []).map((slot) => ({
            id: slot.id,
            node_id: slot.nodeId,
            slot_key: slot.slotKey,
            label: slot.label,
            required: slot.required,
          })),
          input_bindings: (request.flowGraph.inputBindings ?? []).map((binding) => ({
            id: binding.id,
            source_id: binding.sourceId,
            ...(binding.functionInputId ? { function_input_id: binding.functionInputId } : {}),
            slot_id: binding.slotId,
          })),
          sync_state: request.flowGraph.syncState,
          diagnostics: request.flowGraph.diagnostics,
          source_hash: request.flowGraph.sourceHash ?? null,
          editable: request.flowGraph.editable,
        }
      : undefined,
  };
}

function toRawUndoTransaction(transaction: BackendUndoTransaction) {
  return {
    summary: transaction.summary,
    request_kind: transaction.requestKind,
    file_snapshots: transaction.fileSnapshots.map((snapshot) => ({
      relative_path: snapshot.relativePath,
      existed: snapshot.existed,
      content: snapshot.content ?? null,
    })),
    changed_node_ids: transaction.changedNodeIds,
    focus_target: transaction.focusTarget
      ? {
          target_id: transaction.focusTarget.targetId,
          level: transaction.focusTarget.level,
        }
      : null,
  };
}

function toStructuralEditResult(raw: RawEditResult): StructuralEditResult {
  return {
    request: raw.request,
    summary: raw.summary,
    touchedRelativePaths: raw.touched_relative_paths,
    reparsedRelativePaths: raw.reparsed_relative_paths,
    changedNodeIds: raw.changed_node_ids,
    warnings: raw.warnings,
    flowSyncState: raw.flow_sync_state ?? null,
    diagnostics: raw.diagnostics ?? [],
    undoTransaction: raw.undo_transaction
      ? {
          summary: raw.undo_transaction.summary,
          requestKind: raw.undo_transaction.request_kind,
          fileSnapshots: raw.undo_transaction.file_snapshots.map((snapshot) => ({
            relativePath: snapshot.relative_path,
            existed: snapshot.existed,
            content: snapshot.content ?? undefined,
          })),
          changedNodeIds: raw.undo_transaction.changed_node_ids,
          focusTarget: raw.undo_transaction.focus_target
            ? {
                targetId: raw.undo_transaction.focus_target.target_id,
                level: raw.undo_transaction.focus_target.level,
              }
            : undefined,
        }
      : undefined,
  };
}

function toBackendUndoResult(raw: RawUndoResult) {
  return {
    summary: raw.summary,
    restoredRelativePaths: raw.restored_relative_paths,
    warnings: raw.warnings,
    focusTarget: raw.focus_target
      ? {
          targetId: raw.focus_target.target_id,
          level: raw.focus_target.level,
        }
      : undefined,
  };
}

function toWorkspaceSyncEvent(raw: RawWorkspaceSyncEvent): WorkspaceSyncEvent {
  return {
    repoPath: normalizePath(raw.repo_path),
    sessionVersion: raw.session_version,
    reason: raw.reason,
    status: raw.status,
    changedRelativePaths: raw.changed_relative_paths,
    needsManualResync: raw.needs_manual_resync,
    message: raw.message ?? undefined,
    snapshot: raw.snapshot
      ? {
          repoId: raw.snapshot.repo_id,
          defaultFocusNodeId: raw.snapshot.default_focus_node_id,
          defaultLevel: raw.snapshot.default_level,
          nodeIds: raw.snapshot.node_ids,
        }
      : undefined,
  };
}

function toIndexingJobState(raw: RawIndexProgressEvent): IndexingJobState {
  return {
    jobId: raw.job_id,
    repoPath: normalizePath(raw.repo_path),
    status: raw.status,
    stage: raw.stage,
    processedModules: raw.processed_modules,
    totalModules: raw.total_modules,
    symbolCount: raw.symbol_count,
    message: raw.message,
    progressPercent: raw.progress_percent ?? undefined,
    error: raw.error ?? undefined,
  };
}

function backendStatusFromSyncEvent(
  current: BackendStatus,
  raw: RawWorkspaceSyncEvent,
): BackendStatus {
  const nextState = raw.needs_manual_resync ? "manual_resync_required" : raw.status;
  const syncing = nextState === "syncing";
  const synced = nextState === "synced";
  const liveSyncEnabled = syncing || synced;
  const nextError = raw.message ?? (synced || syncing ? undefined : current.lastSyncError);
  const nextNote = raw.message ?? workspaceSyncNote(nextState);

  return {
    ...current,
    available: true,
    liveSyncEnabled,
    syncState: nextState,
    lastSyncAt: synced ? new Date().toISOString() : current.lastSyncAt,
    lastSyncError: nextError,
    lastError: nextError,
    note: nextNote,
  };
}

function workspaceSyncNote(status: WorkspaceSyncState): string {
  if (status === "syncing") {
    return "Applying external repo changes to the live workspace.";
  }
  if (status === "synced") {
    return "Watching the active repo for Python changes.";
  }
  if (status === "manual_resync_required") {
    return "Live sync needs a manual reindex to recover the workspace session.";
  }
  if (status === "error") {
    return "Live sync encountered an error.";
  }
  return "Persistent Python bridge is ready. Open a repo to enable live sync.";
}

function layoutGraphView(raw: RawGraphView): GraphView {
  const architectureView = raw.level === "repo" || raw.level === "module";
  const flowView = raw.level === "flow";
  const layoutEdges = architectureView
    ? raw.edges.filter((edge) => edge.kind !== "contains")
    : raw.edges;
  const edgesForLevels = layoutEdges.length ? layoutEdges : raw.edges;
  const levels = architectureView
    ? buildArchitectureLevels(raw.nodes, edgesForLevels)
    : flowView
      ? buildFlowLevels(raw.nodes, edgesForLevels)
      : buildBreadthLevels(raw.root_node_id, edgesForLevels);
  const repoNode = raw.nodes.find((node) => node.kind === "repo");
  const positioned = flowView
    ? layoutLightweightFlowGraph(raw.nodes, raw.edges, levels)
    : layoutRelaxedDirectedGraph(raw.nodes, raw.edges, levels, {
        architectureView,
        flowView,
        repoNodeId: architectureView ? repoNode?.node_id : undefined,
      });

  return {
    rootNodeId: raw.root_node_id,
    targetId: raw.target_id,
    level: raw.level,
    nodes: raw.nodes.map((node) => ({
      id: node.node_id,
      kind: node.kind,
      label: node.label,
      subtitle: node.subtitle ?? "",
      metadata: node.metadata,
      availableActions: node.available_actions.map(toGraphAction),
      x: positioned.get(node.node_id)?.x ?? 0,
      y: positioned.get(node.node_id)?.y ?? 0,
    })),
    edges: raw.edges.map((edge) => ({
      id: edge.edge_id,
      kind: edge.kind,
      source: edge.source_id,
      target: edge.target_id,
      label: edge.label ?? undefined,
      metadata: edge.metadata,
    })),
    breadcrumbs: raw.breadcrumbs.map(
      (breadcrumb): GraphBreadcrumbDto => ({
        nodeId: breadcrumb.node_id,
        level: breadcrumb.level,
        label: breadcrumb.label,
        subtitle: breadcrumb.subtitle ?? undefined,
      }),
    ),
    focus: raw.focus
      ? ({
          targetId: raw.focus.target_id,
          level: raw.focus.level,
          label: raw.focus.label,
          subtitle: raw.focus.subtitle ?? undefined,
          availableLevels: raw.focus.available_levels,
        } satisfies GraphFocusDto)
      : undefined,
    truncated: raw.truncated,
    flowState: raw.flow_state
      ? {
          editable: raw.flow_state.editable,
          syncState: raw.flow_state.sync_state,
          diagnostics: raw.flow_state.diagnostics,
          document: raw.flow_state.document
            ? toFlowGraphDocument(raw.flow_state.document)
            : undefined,
        }
      : undefined,
  };
}

function toFlowGraphDocument(
  raw: NonNullable<NonNullable<RawGraphView["flow_state"]>["document"]>,
): FlowGraphDocument {
  return {
    symbolId: raw.symbol_id,
    relativePath: raw.relative_path,
    qualname: raw.qualname,
    nodes: raw.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      payload: node.payload,
      indexedNodeId: node.indexed_node_id ?? null,
    })),
    edges: raw.edges.map((edge) => ({
      id: edge.id,
      sourceId: edge.source_id,
      sourceHandle: edge.source_handle,
      targetId: edge.target_id,
      targetHandle: edge.target_handle,
    })),
    valueModelVersion: raw.value_model_version ?? null,
    ...(raw.function_inputs
      ? {
          functionInputs: raw.function_inputs.map((input) => ({
            id: input.id,
            name: input.name,
            index: input.index,
          })),
        }
      : {}),
    ...(raw.value_sources
      ? {
          valueSources: raw.value_sources.map((source) => ({
            id: source.id,
            nodeId: source.node_id,
            name: source.name,
            label: source.label,
          })),
        }
      : {}),
    ...(raw.input_slots
      ? {
          inputSlots: raw.input_slots.map((slot) => ({
            id: slot.id,
            nodeId: slot.node_id,
            slotKey: slot.slot_key,
            label: slot.label,
            required: slot.required,
          })),
        }
      : {}),
    ...(raw.input_bindings
      ? {
          inputBindings: raw.input_bindings.map((binding) => ({
            id: binding.id,
            sourceId: binding.source_id ?? binding.function_input_id ?? "",
            ...(binding.function_input_id ? { functionInputId: binding.function_input_id } : {}),
            slotId: binding.slot_id,
          })),
        }
      : {}),
    syncState: raw.sync_state,
    diagnostics: raw.diagnostics,
    sourceHash: raw.source_hash,
    editable: raw.editable,
  };
}

function buildBreadthLevels(
  rootNodeId: string,
  edges: RawGraphViewEdge[],
): Map<string, number> {
  const adjacency = new Map<string, Set<string>>();
  const connect = (left: string, right: string) => {
    adjacency.set(left, new Set([...(adjacency.get(left) ?? []), right]));
  };

  edges.forEach((edge) => {
    connect(edge.source_id, edge.target_id);
    connect(edge.target_id, edge.source_id);
  });

  const levels = new Map<string, number>([[rootNodeId, 0]]);
  const queue = [rootNodeId];
  while (queue.length) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    const currentLevel = levels.get(current) ?? 0;
    for (const next of adjacency.get(current) ?? []) {
      if (levels.has(next)) {
        continue;
      }
      levels.set(next, currentLevel + 1);
      queue.push(next);
    }
  }

  return levels;
}

function buildFlowLevels(
  nodes: RawGraphViewNode[],
  edges: RawGraphViewEdge[],
): Map<string, number> {
  const levels = new Map<string, number>();
  const controlEdges = edges.filter((edge) => edge.kind === "controls");
  const nodeById = new Map(nodes.map((node) => [node.node_id, node] as const));
  const orderedFlowNodes = nodes
    .map((node) => [node, rawFlowOrder(node)] as const)
    .filter((entry): entry is readonly [RawGraphViewNode, number] => entry[1] !== undefined)
    .sort((left, right) => left[1] - right[1] || left[0].label.localeCompare(right[0].label));

  if (!controlEdges.length && orderedFlowNodes.length) {
    orderedFlowNodes.forEach(([node, order]) => {
      levels.set(node.node_id, order);
    });
    nodes.forEach((node) => {
      if (!levels.has(node.node_id)) {
        levels.set(node.node_id, node.kind === "entry" ? 0 : 1);
      }
    });
    return levels;
  }

  const outgoingForwardEdges = new Map<string, RawGraphViewEdge[]>();
  controlEdges
    .filter((edge) => {
      const sourceNode = nodeById.get(edge.source_id);
      const targetNode = nodeById.get(edge.target_id);
      const sourceOrder = sourceNode ? rawFlowOrder(sourceNode) : undefined;
      const targetOrder = targetNode ? rawFlowOrder(targetNode) : undefined;
      if (sourceOrder === undefined || targetOrder === undefined) {
        return true;
      }
      return targetOrder >= sourceOrder;
    })
    .forEach((edge) => {
      outgoingForwardEdges.set(edge.source_id, [...(outgoingForwardEdges.get(edge.source_id) ?? []), edge]);
    });

  const orderedNodes = nodes.slice().sort((left, right) =>
    (rawFlowOrder(left) ?? Number.MAX_SAFE_INTEGER) - (rawFlowOrder(right) ?? Number.MAX_SAFE_INTEGER)
    || `${left.kind}:${left.label}`.localeCompare(`${right.kind}:${right.label}`),
  );
  orderedNodes.forEach((node) => {
    const baseLevel = levels.get(node.node_id) ?? (node.kind === "entry" || node.kind === "param" ? 0 : 1);
    levels.set(node.node_id, baseLevel);
    for (const edge of outgoingForwardEdges.get(node.node_id) ?? []) {
      const nextLevel = baseLevel + 1;
      levels.set(edge.target_id, Math.max(levels.get(edge.target_id) ?? 0, nextLevel));
    }
  });

  nodes.forEach((node) => {
    if (!levels.has(node.node_id)) {
      levels.set(node.node_id, node.kind === "param" ? 0 : 1);
    }
  });

  return levels;
}

function layoutLightweightFlowGraph(
  nodes: RawGraphViewNode[],
  edges: RawGraphViewEdge[],
  levels: Map<string, number>,
): Map<string, { x: number; y: number }> {
  const orderedNodes = nodes
    .slice()
    .sort((left, right) =>
      (rawFlowOrder(left) ?? Number.MAX_SAFE_INTEGER) - (rawFlowOrder(right) ?? Number.MAX_SAFE_INTEGER)
      || `${left.kind}:${left.label}`.localeCompare(`${right.kind}:${right.label}`),
    );
  const positions = new Map<string, { x: number; y: number }>();
  const controlEdges = edges.filter((edge) => edge.kind === "controls");

  if (!controlEdges.length) {
    orderedNodes.forEach((node, index) => {
      positions.set(node.node_id, {
        x: index * 280,
        y: 0,
      });
    });
    return positions;
  }

  const controlNodeIds = new Set<string>();
  controlEdges.forEach((edge) => {
    controlNodeIds.add(edge.source_id);
    controlNodeIds.add(edge.target_id);
  });

  const mainFlowNodes = orderedNodes.filter((node) => node.kind === "entry" || controlNodeIds.has(node.node_id));
  const buckets = new Map<number, RawGraphViewNode[]>();
  mainFlowNodes.forEach((node) => {
    const level = levels.get(node.node_id) ?? 0;
    buckets.set(level, [...(buckets.get(level) ?? []), node]);
  });

  [...buckets.entries()]
    .sort((left, right) => left[0] - right[0])
    .forEach(([level, group]) => {
      const sortedGroup = group.slice().sort((left, right) =>
        (rawFlowOrder(left) ?? Number.MAX_SAFE_INTEGER) - (rawFlowOrder(right) ?? Number.MAX_SAFE_INTEGER)
        || `${left.kind}:${left.label}`.localeCompare(`${right.kind}:${right.label}`),
      );
      sortedGroup.forEach((node, index) => {
        const centeredIndex = index - (sortedGroup.length - 1) / 2;
        positions.set(node.node_id, {
          x: level * 320,
          y: centeredIndex * 150,
        });
      });
    });

  const controlColumnByNodeId = new Map<string, number>(
    Array.from(positions.entries()).map(([nodeId, position]) => [nodeId, Math.round(position.x / 320)] as const),
  );
  const supportAboveDepthByColumn = new Map<number, number>();
  const supportBelowDepthByColumn = new Map<number, number>();

  orderedNodes
    .filter((node) => !positions.has(node.node_id))
    .forEach((node) => {
      const relatedColumns = edges.flatMap((edge) => {
        if (edge.source_id === node.node_id && controlColumnByNodeId.has(edge.target_id)) {
          return [controlColumnByNodeId.get(edge.target_id) as number];
        }
        if (edge.target_id === node.node_id && controlColumnByNodeId.has(edge.source_id)) {
          return [controlColumnByNodeId.get(edge.source_id) as number];
        }
        return [];
      });
      const column = relatedColumns.length
        ? Math.round(relatedColumns.reduce((sum, value) => sum + value, 0) / relatedColumns.length)
        : levels.get(node.node_id) ?? 0;
      const above = node.kind === "param";
      const depthByColumn = above ? supportAboveDepthByColumn : supportBelowDepthByColumn;
      const depth = depthByColumn.get(column) ?? 0;
      depthByColumn.set(column, depth + 1);
      positions.set(node.node_id, {
        x: column * 320 + (above ? -72 : 72),
        y: above ? -180 - depth * 132 : 180 + depth * 132,
      });
    });

  return positions;
}

function buildArchitectureLevels(
  nodes: RawGraphViewNode[],
  edges: RawGraphViewEdge[],
): Map<string, number> {
  const moduleLikeNodes = nodes.filter((node) => node.kind !== "repo");
  const nodeIds = new Set(moduleLikeNodes.map((node) => node.node_id));
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();

  moduleLikeNodes.forEach((node) => indegree.set(node.node_id, 0));

  edges.forEach((edge) => {
    if (!nodeIds.has(edge.source_id) || !nodeIds.has(edge.target_id)) {
      return;
    }
    outgoing.set(edge.source_id, [...(outgoing.get(edge.source_id) ?? []), edge.target_id]);
    indegree.set(edge.target_id, (indegree.get(edge.target_id) ?? 0) + 1);
  });

  const queue = Array.from(indegree.entries())
    .filter(([, count]) => count === 0)
    .map(([nodeId]) => nodeId);
  const levels = new Map<string, number>();

  if (!queue.length) {
    moduleLikeNodes.forEach((node) => levels.set(node.node_id, 0));
    return levels;
  }

  queue.forEach((nodeId) => levels.set(nodeId, 0));
  while (queue.length) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    const currentLevel = levels.get(current) ?? 0;
    for (const next of outgoing.get(current) ?? []) {
      levels.set(next, Math.max(levels.get(next) ?? 0, currentLevel + 1));
      const nextDegree = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, nextDegree);
      if (nextDegree === 0) {
        queue.push(next);
      }
    }
  }

  moduleLikeNodes.forEach((node) => {
    if (!levels.has(node.node_id)) {
      levels.set(node.node_id, 0);
    }
  });
  return levels;
}

function layoutRelaxedDirectedGraph(
  nodes: RawGraphViewNode[],
  edges: RawGraphViewEdge[],
  levels: Map<string, number>,
  options: {
    architectureView: boolean;
    flowView: boolean;
    repoNodeId?: string;
  },
): Map<string, { x: number; y: number }> {
  const nodeIds = new Set(nodes.map((node) => node.node_id));
  const relevantEdges = edges.filter(
    (edge) => nodeIds.has(edge.source_id) && nodeIds.has(edge.target_id),
  );
  const buckets = new Map<number, RawGraphViewNode[]>();

  nodes.forEach((node) => {
    const baseLevel =
      node.node_id === options.repoNodeId ? -1 : (levels.get(node.node_id) ?? 0);
    buckets.set(baseLevel, [...(buckets.get(baseLevel) ?? []), node]);
  });

  const sortedLevels = Array.from(buckets.keys()).sort((left, right) => left - right);
  const minLevel = sortedLevels[0] ?? 0;
  const levelGap = options.architectureView ? 420 : options.flowView ? 340 : 380;
  const rowGap = options.architectureView ? 210 : options.flowView ? 170 : 190;
  const positions = new Map<string, { x: number; y: number }>();
  const fixedNodeIds = new Set<string>(options.repoNodeId ? [options.repoNodeId] : []);

  sortedLevels.forEach((level) => {
    const group = [...(buckets.get(level) ?? [])].sort((left, right) =>
      (options.flowView ? (rawFlowOrder(left) ?? Number.MAX_SAFE_INTEGER) - (rawFlowOrder(right) ?? Number.MAX_SAFE_INTEGER) : 0)
      || `${left.kind}:${left.label}`.localeCompare(`${right.kind}:${right.label}`),
    );
    group.forEach((node, index) => {
      const centeredIndex = index - (group.length - 1) / 2;
      positions.set(node.node_id, {
        x:
          (level - minLevel) * levelGap
          + centeredIndex * 54
          + stableLayoutOffset(node.node_id, 82),
        y: centeredIndex * rowGap + stableLayoutOffset(node.node_id, 96),
      });
    });
  });

  if (options.repoNodeId && positions.has(options.repoNodeId)) {
    positions.set(options.repoNodeId, { x: -levelGap * 1.15, y: 0 });
  }

  for (let iteration = 0; iteration < 140; iteration += 1) {
    const displacement = new Map<string, { x: number; y: number }>();
    nodes.forEach((node) => displacement.set(node.node_id, { x: 0, y: 0 }));

    for (let index = 0; index < nodes.length; index += 1) {
      const left = nodes[index];
      const leftPosition = positions.get(left.node_id);
      if (!leftPosition) {
        continue;
      }

      for (let otherIndex = index + 1; otherIndex < nodes.length; otherIndex += 1) {
        const right = nodes[otherIndex];
        const rightPosition = positions.get(right.node_id);
        if (!rightPosition) {
          continue;
        }

        const dx = rightPosition.x - leftPosition.x;
        const dy = rightPosition.y - leftPosition.y;
        const distance = Math.max(Math.hypot(dx, dy), 1);
        const repulsion = Math.min(180000 / (distance * distance), 22);
        const unitX = dx / distance;
        const unitY = dy / distance;

        displacement.get(left.node_id)!.x -= unitX * repulsion;
        displacement.get(left.node_id)!.y -= unitY * repulsion;
        displacement.get(right.node_id)!.x += unitX * repulsion;
        displacement.get(right.node_id)!.y += unitY * repulsion;
      }
    }

    relevantEdges.forEach((edge) => {
      const sourcePosition = positions.get(edge.source_id);
      const targetPosition = positions.get(edge.target_id);
      if (!sourcePosition || !targetPosition) {
        return;
      }

      const desiredGap = desiredHorizontalGap(edge, options.flowView);
      const dx = targetPosition.x - sourcePosition.x;
      const dy = targetPosition.y - sourcePosition.y;
      const xError = dx - desiredGap;
      const yError = dy;
      const xAdjust = xError * 0.05;
      const yAdjust = yError * 0.025;

      displacement.get(edge.source_id)!.x += xAdjust * 0.5;
      displacement.get(edge.target_id)!.x -= xAdjust * 0.5;
      displacement.get(edge.source_id)!.y += yAdjust * 0.5;
      displacement.get(edge.target_id)!.y -= yAdjust * 0.5;
    });

    nodes.forEach((node) => {
      const position = positions.get(node.node_id);
      const change = displacement.get(node.node_id);
      if (!position || !change) {
        return;
      }

      if (fixedNodeIds.has(node.node_id)) {
        position.y += clampLayoutDelta((0 - position.y) * 0.08, 20);
        return;
      }

      const nodeLevel =
        node.node_id === options.repoNodeId ? -1 : (levels.get(node.node_id) ?? 0);
      const anchorX =
        (nodeLevel - minLevel) * levelGap
        + stableLayoutOffset(node.node_id, 82);

      position.x += clampLayoutDelta(change.x + (anchorX - position.x) * 0.02, 28);
      position.y += clampLayoutDelta(change.y + (0 - position.y) * 0.003, 24);
    });
  }

  return positions;
}

function rawFlowOrder(node: RawGraphViewNode): number | undefined {
  const value = node.metadata.flow_order ?? node.metadata.flowOrder;
  return typeof value === "number" ? value : undefined;
}

function stableLayoutOffset(nodeId: string, spread: number): number {
  let hash = 0;
  for (let index = 0; index < nodeId.length; index += 1) {
    hash = (hash * 31 + nodeId.charCodeAt(index)) >>> 0;
  }
  return ((hash / 0xffffffff) - 0.5) * spread;
}

function desiredHorizontalGap(edge: RawGraphViewEdge, flowView: boolean): number {
  if (edge.kind === "defines") {
    return flowView ? 250 : 320;
  }
  if (edge.kind === "controls") {
    return 240;
  }
  if (edge.kind === "data") {
    return 210;
  }
  if (edge.kind === "calls") {
    return flowView ? 260 : 380;
  }
  if (edge.kind === "imports") {
    return 360;
  }
  return 300;
}

function clampLayoutDelta(value: number, maxMagnitude: number): number {
  return Math.max(-maxMagnitude, Math.min(maxMagnitude, value));
}

function toGraphAction(action: RawGraphAction): GraphActionDto {
  return {
    actionId: action.action_id,
    label: action.label,
    enabled: action.enabled,
    reason: action.reason ?? undefined,
    payload: action.payload,
  };
}
