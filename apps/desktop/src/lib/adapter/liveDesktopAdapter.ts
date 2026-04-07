import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  BackendStatus,
  DesktopAdapter,
  FileContents,
  GraphEdgeDto,
  GraphFilters,
  GraphNeighborhood,
  GraphNodeDto,
  IndexingJobState,
  OverviewData,
  OverviewModule,
  RecentRepo,
  RelationshipItem,
  RepoSession,
  SearchFilters,
  SearchResult,
  SymbolDetails,
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

interface RawUnresolvedCall {
  call_id: string;
  source_id: string;
  module_id: string;
  owner_symbol_id?: string | null;
  callee_expr: string;
  reason: string;
  span: RawSourceSpan;
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
    unresolved_calls: RawUnresolvedCall[];
    report: {
      module_count: number;
      symbol_count: number;
      import_edge_count: number;
      call_edge_count: number;
      unresolved_call_count: number;
      diagnostic_count: number;
    };
  };
}

interface RawBackendHealth {
  mode: "live";
  available: boolean;
  python_command: string;
  workspace_root: string;
  note: string;
}

interface ScanJob {
  state: IndexingJobState;
  listeners: Set<(state: IndexingJobState) => void>;
  pulseTimer?: number;
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
  };
  private scanCache?: ScanCache;
  private jobs = new Map<string, ScanJob>();

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
        lastError: undefined,
      };
    } catch (reason) {
      const message = toMessage(reason);
      this.backendStatus = {
        ...this.backendStatus,
        mode: "live",
        available: false,
        note: "The desktop shell could not reach the Python bridge.",
        lastError: message,
      };
    }

    return this.backendStatus;
  }

  async startIndex(repoPath: string): Promise<{ jobId: string }> {
    const jobId = `index:${repoPath}:${Date.now()}`;
    const job: ScanJob = {
      state: {
        jobId,
        repoPath,
        status: "queued",
        processedModules: 0,
        totalModules: 100,
        symbolCount: 0,
        message: "Scheduling Python scan",
        progressPercent: 4,
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
    depth: number,
    filters: GraphFilters,
  ): Promise<GraphNeighborhood> {
    const cache = this.requireScanCache();
    const rootNode = cache.nodeById.get(nodeId);
    if (!rootNode) {
      throw new Error(`No indexed graph node matched ${nodeId}.`);
    }

    const relevantEdges = cache.payload.graph.edges.filter((edge) => {
      if (edge.kind === "calls") {
        return filters.includeCalls;
      }
      if (edge.kind === "imports") {
        return filters.includeImports;
      }
      if (edge.kind === "defines") {
        return filters.includeDefines;
      }
      return true;
    });
    const selectedNodeIds = collectNeighborhood(nodeId, depth, relevantEdges);
    const nodes = Array.from(selectedNodeIds)
      .map((selectedId) => cache.nodeById.get(selectedId))
      .filter((node): node is RawGraphNode => Boolean(node));
    const edges = relevantEdges.filter(
      (edge) => selectedNodeIds.has(edge.source_id) && selectedNodeIds.has(edge.target_id),
    );

    return {
      rootNodeId: nodeId,
      depth,
      truncated: selectedNodeIds.size < cache.payload.graph.nodes.length,
      nodes: layoutGraphNodes(nodes, nodeId, edges),
      edges: edges.map((edge) => ({
        id: edge.edge_id,
        kind: edge.kind,
        source: edge.source_id,
        target: edge.target_id,
        label:
          edge.kind === "calls"
            ? String(edge.metadata.callee_expr ?? "calls")
            : edge.kind === "imports"
              ? String(edge.metadata.local_name ?? "imports")
              : undefined,
      })),
    };
  }

  async getOverview(): Promise<OverviewData> {
    const cache = this.requireScanCache();
    const topSymbols = topSymbolResults(cache, 5);
    const savedViews = topSymbols.slice(0, 3).map((symbol, index) => ({
      id: `saved:${symbol.id}`,
      label: index === 0 ? "Primary flow" : `Focus ${index}`,
      description: `Explore the neighborhood around ${symbol.subtitle}.`,
      nodeId: symbol.nodeId ?? symbol.id,
    }));

    const modules: OverviewModule[] = cache.payload.summary.modules.map((module) => ({
      id: `module:${module.module_id}`,
      moduleId: module.module_id,
      moduleName: module.module_name,
      relativePath: module.relative_path,
      symbolCount: module.symbol_count,
      importCount: module.import_count,
      callCount: module.outgoing_call_count,
    }));

    const diagnostics = cache.payload.graph.diagnostics
      .slice(0, 3)
      .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`);
    if (!diagnostics.length) {
      diagnostics.push("No parser diagnostics were reported in the last scan.");
    }
    if (cache.payload.graph.unresolved_calls.length) {
      diagnostics.push(
        `${cache.payload.graph.unresolved_calls.length} unresolved calls need a closer look.`,
      );
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
    };
  }

  private async runScan(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job) {
      return;
    }

    const repoPath = job.state.repoPath;
    this.updateJob(jobId, {
      ...job.state,
      status: "running",
      processedModules: 12,
      totalModules: 100,
      message: "Launching Python repo scan",
      progressPercent: 12,
    });

    job.pulseTimer = window.setInterval(() => {
      const currentJob = this.jobs.get(jobId);
      if (!currentJob || currentJob.state.status !== "running") {
        return;
      }

      const nextPercent = Math.min((currentJob.state.progressPercent ?? 12) + 8, 86);
      this.updateJob(jobId, {
        ...currentJob.state,
        processedModules: nextPercent,
        totalModules: 100,
        message:
          nextPercent < 46
            ? "Discovering Python modules"
            : "Building the structural graph",
        progressPercent: nextPercent,
      });
    }, 420);

    try {
      const startedAt = Date.now();
      const payload = await invoke<RawScanPayload>("scan_repo_payload", { repoPath });
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

      window.clearInterval(job.pulseTimer);
      this.updateJob(jobId, {
        ...job.state,
        status: "done",
        processedModules: payload.graph.report.module_count,
        totalModules: payload.graph.report.module_count,
        symbolCount: payload.graph.report.symbol_count,
        message: "Workspace ready",
        progressPercent: 100,
        error: undefined,
      });
    } catch (reason) {
      const message = toMessage(reason);
      this.backendStatus = {
        ...this.backendStatus,
        lastError: message,
        lastScanAt: new Date().toISOString(),
      };
      window.clearInterval(job.pulseTimer);
      this.updateJob(jobId, {
        ...job.state,
        status: "error",
        processedModules: 0,
        totalModules: 0,
        symbolCount: 0,
        message: "Scan failed",
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
  const fileEntries = cache.payload.graph.nodes
    .filter((node) => node.kind === "module" && !node.is_external)
    .map((node) => {
      const filePath = relativePathForNode(node, cache);
      return {
        id: node.node_id,
        kind: "file" as const,
        title: filePath,
        subtitle: node.module_name ?? node.display_name,
        score: 0,
        filePath,
        nodeId: node.node_id,
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
    }));

  return [...symbolEntries, ...fileEntries];
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
      title: `${topModule.module_name} is the densest module`,
      description: `${topModule.relative_path} leads the current summary with ${topModule.symbol_count} symbols and ${topModule.outgoing_call_count} outgoing calls.`,
    });
  }
  hotspots.push({
    title: `${cache.payload.graph.unresolved_calls.length} unresolved calls`,
    description:
      cache.payload.graph.unresolved_calls.length > 0
        ? "The graph builder found conservative call sites that still need human review, which makes them a good UI-level validation target."
        : "The current scan resolved every tracked call edge in this repo slice.",
  });
  hotspots.push({
    title: `${cache.payload.graph.diagnostics.length} parser diagnostics`,
    description:
      cache.payload.graph.diagnostics.length > 0
        ? "Diagnostics are surfaced in the overview so you can validate parser edge cases without leaving the desktop app."
        : "No parser diagnostics were surfaced in the last scan.",
  });
  return hotspots;
}

function collectNeighborhood(
  rootNodeId: string,
  depth: number,
  edges: RawGraphEdge[],
): Set<string> {
  const adjacency = new Map<string, Set<string>>();
  const connect = (left: string, right: string) => {
    adjacency.set(left, new Set([...(adjacency.get(left) ?? []), right]));
  };
  edges.forEach((edge) => {
    connect(edge.source_id, edge.target_id);
    connect(edge.target_id, edge.source_id);
  });

  const visited = new Set<string>([rootNodeId]);
  const queue: Array<{ nodeId: string; distance: number }> = [
    { nodeId: rootNodeId, distance: 0 },
  ];

  while (queue.length) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    if (current.distance >= depth) {
      continue;
    }
    for (const nextNodeId of adjacency.get(current.nodeId) ?? []) {
      if (visited.has(nextNodeId)) {
        continue;
      }
      visited.add(nextNodeId);
      queue.push({ nodeId: nextNodeId, distance: current.distance + 1 });
    }
  }

  return visited;
}

function layoutGraphNodes(
  nodes: RawGraphNode[],
  rootNodeId: string,
  edges: RawGraphEdge[],
): GraphNodeDto[] {
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

  const grouped = new Map<number, RawGraphNode[]>();
  nodes.forEach((node) => {
    const level = levels.get(node.node_id) ?? 0;
    grouped.set(level, [...(grouped.get(level) ?? []), node]);
  });

  const sortedGroups = Array.from(grouped.entries()).sort((left, right) => left[0] - right[0]);
  const positioned: GraphNodeDto[] = [];
  sortedGroups.forEach(([level, group]) => {
    const sortedNodes = group.sort((left, right) =>
      `${left.kind}:${left.display_name}`.localeCompare(`${right.kind}:${right.display_name}`),
    );
    const totalHeight = (sortedNodes.length - 1) * 140;
    sortedNodes.forEach((node, index) => {
      positioned.push({
        id: node.node_id,
        kind: node.kind,
        label: node.name,
        subtitle:
          node.kind === "symbol"
            ? node.qualname ?? node.display_name
            : typeof node.metadata.relative_path === "string"
              ? node.metadata.relative_path
              : node.display_name,
        x: level * 280,
        y: index * 140 - totalHeight / 2,
      });
    });
  });

  return positioned;
}

function scoreSearchResult(
  result: SearchResult,
  query: string,
  degreeByNodeId: Map<string, number>,
): number {
  const degree = degreeByNodeId.get(result.nodeId ?? result.id) ?? 0;
  if (!query) {
    return degree + (result.kind === "symbol" ? 8 : 4);
  }

  const haystacks = [result.title.toLowerCase(), result.subtitle.toLowerCase(), result.filePath];
  let score = degree;
  if (haystacks.some((value) => value === query)) {
    score += 60;
  }
  if (haystacks.some((value) => value.startsWith(query))) {
    score += 30;
  }
  if (haystacks.some((value) => value.includes(query))) {
    score += 12;
  }
  if (result.kind === "symbol") {
    score += 4;
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
