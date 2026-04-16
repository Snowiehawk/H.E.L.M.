export type IndexStatus = "queued" | "running" | "done" | "error";
export type IndexStage =
  | "discover"
  | "parse"
  | "graph_build"
  | "cache_finalize"
  | "watch_ready";
export type BackendMode = "mock" | "live";
export type WorkspaceSyncState =
  | "idle"
  | "syncing"
  | "synced"
  | "error"
  | "manual_resync_required";
export type ThemeMode = "system" | "light" | "dark";
export type WorkspaceTab = "overview" | "file" | "symbol" | "graph";
export type SearchResultKind = "module" | "symbol" | "file";
export type GraphAbstractionLevel = "repo" | "module" | "symbol" | "flow";
export type GraphSymbolNodeKind =
  | "symbol"
  | "function"
  | "class"
  | "enum"
  | "variable";
export type GraphNodeKind =
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
export type GraphEdgeKind =
  | "contains"
  | "imports"
  | "defines"
  | "calls"
  | "controls"
  | "data";
export type StructuralEditKind =
  | "create_module"
  | "rename_symbol"
  | "create_symbol"
  | "delete_symbol"
  | "move_symbol"
  | "add_import"
  | "remove_import"
  | "replace_symbol_source"
  | "insert_flow_statement"
  | "replace_flow_graph";

export type FlowSyncState = "clean" | "draft" | "import_error";
export type FlowVisualNodeKind =
  | "entry"
  | "assign"
  | "call"
  | "branch"
  | "loop"
  | "return"
  | "exit";

export interface FlowGraphNode {
  // Persisted flow documents stay statement-node-only in v1. Visual support nodes such
  // as `param` can still appear in rendered flow views, but they do not belong here.
  id: string;
  kind: FlowVisualNodeKind;
  payload: Record<string, unknown>;
}

export interface FlowGraphEdge {
  id: string;
  sourceId: string;
  sourceHandle: string;
  targetId: string;
  targetHandle: string;
}

export interface FlowGraphDocument {
  symbolId: string;
  relativePath: string;
  qualname: string;
  nodes: FlowGraphNode[];
  edges: FlowGraphEdge[];
  syncState: FlowSyncState;
  diagnostics: string[];
  sourceHash?: string | null;
  editable: boolean;
}

export interface FlowViewState {
  editable: boolean;
  syncState: FlowSyncState;
  diagnostics: string[];
  document?: FlowGraphDocument | null;
}

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
  stage: IndexStage;
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
  liveSyncEnabled: boolean;
  syncState: WorkspaceSyncState;
  lastSyncAt?: string;
  lastSyncError?: string;
  lastScanAt?: string;
  lastScanDurationMs?: number;
  lastError?: string;
}

export interface WorkspaceSyncSnapshot {
  repoId: string;
  defaultFocusNodeId: string;
  defaultLevel: GraphAbstractionLevel;
  nodeIds: string[];
}

export interface WorkspaceSyncEvent {
  repoPath: string;
  sessionVersion: number;
  reason: string;
  status: WorkspaceSyncState;
  changedRelativePaths: string[];
  needsManualResync: boolean;
  message?: string;
  snapshot?: WorkspaceSyncSnapshot;
}

export interface SearchFilters {
  includeModules: boolean;
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
  level?: GraphAbstractionLevel;
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

export interface GraphActionDto {
  actionId: string;
  label: string;
  enabled: boolean;
  reason?: string | null;
  payload: Record<string, unknown>;
}

export interface GraphBreadcrumbDto {
  nodeId: string;
  level: GraphAbstractionLevel;
  label: string;
  subtitle?: string | null;
}

export interface GraphFocusDto {
  targetId: string;
  level: GraphAbstractionLevel;
  label: string;
  subtitle?: string | null;
  availableLevels: GraphAbstractionLevel[];
}

export interface GraphNodeDto {
  id: string;
  kind: GraphNodeKind;
  label: string;
  subtitle?: string | null;
  x: number;
  y: number;
  metadata: Record<string, unknown>;
  availableActions: GraphActionDto[];
}

export interface GraphEdgeDto {
  id: string;
  kind: GraphEdgeKind;
  source: string;
  target: string;
  label?: string;
  metadata?: Record<string, unknown>;
}

export interface GraphFilters {
  includeImports: boolean;
  includeCalls: boolean;
  includeDefines: boolean;
}

export interface GraphSettings {
  includeExternalDependencies: boolean;
}

export interface SourceRange {
  startLine: number;
  endLine: number;
  startColumn?: number;
  endColumn?: number;
}

export interface GraphView {
  rootNodeId: string;
  targetId: string;
  level: GraphAbstractionLevel;
  nodes: GraphNodeDto[];
  edges: GraphEdgeDto[];
  breadcrumbs: GraphBreadcrumbDto[];
  focus?: GraphFocusDto | null;
  truncated: boolean;
  flowState?: FlowViewState | null;
}

export type GraphNeighborhood = GraphView;

export function isGraphSymbolNodeKind(
  kind: GraphNodeKind | string | null | undefined,
): kind is GraphSymbolNodeKind {
  return (
    kind === "symbol"
    || kind === "function"
    || kind === "class"
    || kind === "enum"
    || kind === "variable"
  );
}

export function isInspectableGraphNodeKind(
  kind: GraphNodeKind | string | null | undefined,
): kind is "function" | "class" | "variable" | "enum" {
  return kind === "function" || kind === "class" || kind === "variable" || kind === "enum";
}

export function isEnterableGraphNodeKind(
  kind: GraphNodeKind | string | null | undefined,
): kind is "repo" | "module" | "symbol" | "class" {
  return kind === "repo" || kind === "module" || kind === "symbol" || kind === "class";
}

export interface RevealedSource extends SourceRange {
  targetId: string;
  title: string;
  path: string;
  content: string;
}

export interface EditableNodeSource extends RevealedSource {
  editable: boolean;
  nodeKind: GraphNodeKind;
  reason?: string;
}

export interface StructuralEditRequest {
  kind: StructuralEditKind;
  targetId?: string;
  relativePath?: string;
  newName?: string;
  symbolKind?: "function" | "class";
  destinationRelativePath?: string;
  importedModule?: string;
  importedName?: string;
  alias?: string;
  anchorEdgeId?: string;
  body?: string;
  content?: string;
  flowGraph?: FlowGraphDocument;
}

export interface UndoFocusTarget {
  targetId: string;
  level: GraphAbstractionLevel;
}

export interface BackendUndoFileSnapshot {
  relativePath: string;
  existed: boolean;
  content?: string | null;
}

export interface BackendUndoTransaction {
  summary: string;
  requestKind: StructuralEditKind;
  fileSnapshots: BackendUndoFileSnapshot[];
  changedNodeIds: string[];
  focusTarget?: UndoFocusTarget;
}

export interface BackendUndoResult {
  summary: string;
  restoredRelativePaths: string[];
  warnings: string[];
  focusTarget?: UndoFocusTarget | null;
}

export interface StructuralEditResult {
  request: {
    kind: StructuralEditKind;
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
  touchedRelativePaths: string[];
  reparsedRelativePaths: string[];
  changedNodeIds: string[];
  warnings: string[];
  flowSyncState?: FlowSyncState | null;
  diagnostics: string[];
  undoTransaction?: BackendUndoTransaction | null;
}

export interface OverviewMetric {
  label: string;
  value: string;
  tone?: "default" | "accent";
}

export type OverviewOutlineKind =
  | "function"
  | "async_function"
  | "class"
  | "enum"
  | "variable";

export interface OverviewOutlineItem {
  id: string;
  nodeId: string;
  label: string;
  kind: OverviewOutlineKind;
  startLine: number;
  topLevel: boolean;
}

export interface OverviewModule {
  id: string;
  moduleId: string;
  moduleName: string;
  relativePath: string;
  symbolCount: number;
  importCount: number;
  callCount: number;
  outline?: OverviewOutlineItem[];
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
  level: GraphAbstractionLevel;
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
  defaultLevel: GraphAbstractionLevel;
  defaultFocusNodeId: string;
}

export interface DesktopAdapter {
  readonly isMock: boolean;
  openRepo(path?: string): Promise<RepoSession>;
  listRecentRepos(): Promise<RecentRepo[]>;
  getBackendStatus(): Promise<BackendStatus>;
  subscribeWorkspaceSync(onUpdate: (event: WorkspaceSyncEvent) => void): () => void;
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
  getGraphView(
    targetId: string,
    level: GraphAbstractionLevel,
    filters: GraphFilters,
    settings?: GraphSettings,
  ): Promise<GraphView>;
  getFlowView(symbolId: string): Promise<GraphView>;
  applyStructuralEdit(request: StructuralEditRequest): Promise<StructuralEditResult>;
  applyBackendUndo(transaction: BackendUndoTransaction): Promise<BackendUndoResult>;
  revealSource(targetId: string): Promise<RevealedSource>;
  getEditableNodeSource(targetId: string): Promise<EditableNodeSource>;
  saveNodeSource(targetId: string, content: string): Promise<StructuralEditResult>;
  openNodeInDefaultEditor(targetId: string): Promise<void>;
  revealNodeInFileExplorer(targetId: string): Promise<void>;
  getOverview(): Promise<OverviewData>;
}
