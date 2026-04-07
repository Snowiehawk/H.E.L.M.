export type IndexStatus = "queued" | "running" | "done" | "error";
export type BackendMode = "mock" | "live";
export type ThemeMode = "system" | "light" | "dark";
export type WorkspaceTab = "overview" | "file" | "symbol" | "graph";
export type SearchResultKind = "file" | "symbol";
export type GraphNodeKind = "repo" | "module" | "symbol";
export type GraphEdgeKind = "contains" | "imports" | "defines" | "calls";

export interface RepoSession {
  id: string;
  name: string;
  path: string;
  branch: string;
  primaryLanguage: string;
  openedAt: string;
}

export interface RecentRepo {
  name: string;
  path: string;
  branch: string;
  lastOpenedAt: string;
}

export interface IndexingJobState {
  jobId: string;
  repoPath: string;
  status: IndexStatus;
  processedModules: number;
  totalModules: number;
  symbolCount: number;
  message: string;
  progressPercent?: number;
  error?: string;
}

export interface BackendStatus {
  mode: BackendMode;
  available: boolean;
  pythonCommand: string;
  workspaceRoot?: string;
  note: string;
  lastScanAt?: string;
  lastScanDurationMs?: number;
  lastError?: string;
}

export interface SearchFilters {
  includeFiles: boolean;
  includeSymbols: boolean;
}

export interface SearchResult {
  id: string;
  kind: SearchResultKind;
  title: string;
  subtitle: string;
  score: number;
  filePath: string;
  symbolId?: string;
  nodeId?: string;
}

export interface FileContents {
  path: string;
  language: string;
  lineCount: number;
  sizeBytes: number;
  content: string;
  linkedSymbols: SearchResult[];
}

export interface RelationshipItem {
  id: string;
  label: string;
  subtitle: string;
  nodeId: string;
  symbolId?: string;
}

export interface SymbolDetails {
  symbolId: string;
  nodeId: string;
  kind: string;
  name: string;
  qualname: string;
  moduleName: string;
  filePath: string;
  signature: string;
  docSummary: string;
  startLine: number;
  endLine: number;
  callers: RelationshipItem[];
  callees: RelationshipItem[];
  references: RelationshipItem[];
  metadata: Record<string, string>;
}

export interface GraphNodeDto {
  id: string;
  kind: GraphNodeKind;
  label: string;
  subtitle: string;
  x: number;
  y: number;
}

export interface GraphEdgeDto {
  id: string;
  kind: GraphEdgeKind;
  source: string;
  target: string;
  label?: string;
}

export interface GraphFilters {
  includeImports: boolean;
  includeCalls: boolean;
  includeDefines: boolean;
}

export interface GraphNeighborhood {
  rootNodeId: string;
  depth: number;
  nodes: GraphNodeDto[];
  edges: GraphEdgeDto[];
  truncated: boolean;
}

export interface OverviewMetric {
  label: string;
  value: string;
  tone?: "default" | "accent";
}

export interface OverviewModule {
  id: string;
  moduleId: string;
  moduleName: string;
  relativePath: string;
  symbolCount: number;
  importCount: number;
  callCount: number;
}

export interface HotspotCard {
  title: string;
  description: string;
}

export interface SavedView {
  id: string;
  label: string;
  description: string;
  nodeId: string;
}

export interface OverviewData {
  repo: RepoSession;
  metrics: OverviewMetric[];
  modules: OverviewModule[];
  hotspots: HotspotCard[];
  savedViews: SavedView[];
  focusSymbols: SearchResult[];
  diagnostics: string[];
  backend: BackendStatus;
}

export interface DesktopAdapter {
  readonly isMock: boolean;
  openRepo(path?: string): Promise<RepoSession>;
  listRecentRepos(): Promise<RecentRepo[]>;
  getBackendStatus(): Promise<BackendStatus>;
  startIndex(repoPath: string): Promise<{ jobId: string }>;
  subscribeIndexProgress(
    jobId: string,
    onUpdate: (state: IndexingJobState) => void,
  ): () => void;
  searchRepo(query: string, filters: SearchFilters): Promise<SearchResult[]>;
  getFile(path: string): Promise<FileContents>;
  getSymbol(symbolId: string): Promise<SymbolDetails>;
  getGraphNeighborhood(
    nodeId: string,
    depth: number,
    filters: GraphFilters,
  ): Promise<GraphNeighborhood>;
  getOverview(): Promise<OverviewData>;
}
