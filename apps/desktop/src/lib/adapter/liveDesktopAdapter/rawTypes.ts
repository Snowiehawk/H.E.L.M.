import type {
  BackendStatus,
  BackendUndoTransaction,
  FlowExpressionNodeKind,
  GraphAbstractionLevel,
  GraphNodeDto,
  IndexStage,
  IndexingJobState,
  RepoSession,
  SearchResult,
  StructuralEditRequest,
  WorkspaceFileOperationPreview,
  WorkspaceSyncState,
} from "../contracts";

export interface RawSourceSpan {
  file_path: string;
  start_line: number;
  start_column: number;
  end_line: number;
  end_column: number;
  start_offset: number;
  end_offset: number;
}

export interface RawGraphNode {
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

export interface RawGraphEdge {
  edge_id: string;
  kind: "contains" | "imports" | "defines" | "calls";
  source_id: string;
  target_id: string;
  metadata: Record<string, unknown>;
}

export interface RawDiagnostic {
  code: string;
  message: string;
  file_path: string;
  severity: string;
  line?: number | null;
  column?: number | null;
}

export interface RawModuleSummary {
  module_id: string;
  module_name: string;
  relative_path: string;
  symbol_count: number;
  import_count: number;
  outgoing_call_count: number;
}

export interface RawScanPayload {
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
  recovery_events?: RawRecoveryEvent[];
}

export interface RawRecoveryEvent {
  operation_id: string;
  kind: string;
  outcome: string;
  touched_relative_paths?: string[];
  warnings?: string[];
}

export interface RawGraphAction {
  action_id: string;
  label: string;
  enabled: boolean;
  reason?: string | null;
  payload: Record<string, unknown>;
}

export interface RawGraphViewNode {
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

export interface RawGraphViewEdge {
  edge_id: string;
  kind: "contains" | "imports" | "defines" | "calls" | "controls" | "data";
  source_id: string;
  target_id: string;
  label?: string | null;
  metadata: Record<string, unknown>;
}

export interface RawGraphView {
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
        kind?: "positional_only" | "positional_or_keyword" | "keyword_only" | "vararg" | "kwarg";
        default_expression?: string | null;
      }>;
      value_sources?: Array<{
        id: string;
        node_id: string;
        name: string;
        label: string;
        emitted_name?: string | null;
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

export interface RawBackendHealth {
  mode: "live";
  available: boolean;
  python_command: string;
  workspace_root: string;
  note: string;
  live_sync_enabled: boolean;
  sync_state: WorkspaceSyncState;
  last_sync_error?: string | null;
}

export interface RawNewProjectResult {
  projectPath: string;
  packageName: string;
}

export interface RawWorkspaceSyncSnapshot {
  repo_id: string;
  default_focus_node_id: string;
  default_level: GraphAbstractionLevel;
  node_ids: string[];
}

export interface RawWorkspaceSyncEvent {
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

export interface RawIndexProgressEvent {
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

export interface RawEditResult {
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
    request_kind: BackendUndoTransaction["requestKind"];
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
    snapshot_token?: string | null;
    touched_relative_paths?: string[];
  } | null;
  recovery_events?: RawRecoveryEvent[];
}

export type RawBackendUndoTransaction = NonNullable<RawEditResult["undo_transaction"]>;

export interface RawApplyEditResponse {
  edit: RawEditResult;
  payload: RawScanPayload;
}

export interface RawFlowExpressionParseResult {
  expression: string;
  graph?: {
    version: number;
    rootId?: string | null;
    root_id?: string | null;
    nodes: Array<{
      id: string;
      kind: FlowExpressionNodeKind;
      label: string;
      payload: Record<string, unknown>;
    }>;
    edges: Array<{
      id: string;
      source_id?: string;
      sourceId?: string;
      source_handle?: string;
      sourceHandle?: string;
      target_id?: string;
      targetId?: string;
      target_handle?: string;
      targetHandle?: string;
    }>;
  } | null;
  diagnostics?: string[];
}

export interface RawUndoResult {
  summary: string;
  restored_relative_paths: string[];
  warnings: string[];
  focus_target?: {
    target_id: string;
    level: GraphAbstractionLevel;
  } | null;
  redo_transaction?: RawBackendUndoTransaction | null;
  recovery_events?: RawRecoveryEvent[];
}

export interface RawApplyUndoResponse {
  undo: RawUndoResult;
  payload: RawScanPayload;
}

export interface RawWorkspaceFileEntry {
  relative_path: string;
  name: string;
  kind: "file" | "directory";
  size_bytes?: number | null;
  editable: boolean;
  reason?: string | null;
  modified_at?: number | null;
}

export interface RawWorkspaceFileTree {
  root_path: string;
  entries: RawWorkspaceFileEntry[];
  truncated: boolean;
}

export interface RawWorkspaceFileContents extends RawWorkspaceFileEntry {
  kind: "file";
  content: string;
  version: string;
}

export interface RawWorkspaceFileMutationResult {
  relative_path: string;
  kind: "file" | "directory";
  changed_relative_paths: string[];
  file?: RawWorkspaceFileContents | null;
  payload?: RawScanPayload | null;
  recovery_events?: RawRecoveryEvent[];
  undo_transaction?: RawBackendUndoTransaction | null;
}

export interface RawWorkspaceFileOperationPreview {
  operation_kind: "delete" | "move";
  source_relative_path: string;
  target_relative_path?: string | null;
  entry_kind: WorkspaceFileOperationPreview["entryKind"];
  counts: {
    entry_count: number;
    file_count: number;
    directory_count: number;
    symlink_count: number;
    total_size_bytes: number;
    python_file_count: number;
  };
  warnings: string[];
  affected_paths: string[];
  affected_paths_truncated: boolean;
  impact_fingerprint: string;
}

export interface RawEditableNodeSource {
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

export interface ScanJob {
  state: IndexingJobState;
  listeners: Set<(state: IndexingJobState) => void>;
}

export interface ScanCache {
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
