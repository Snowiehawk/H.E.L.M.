import type {
  BackendStatus,
  IndexingJobState,
  RepoSession,
  WorkspaceSyncEvent,
  WorkspaceSyncState,
} from "../contracts";
import type {
  RawBackendHealth,
  RawIndexProgressEvent,
  RawNewProjectResult,
  RawScanPayload,
  RawWorkspaceSyncEvent,
} from "./rawTypes";
import { buildRepoSessionFromPath, normalizePath, toMessage, type InvokeCommand } from "./shared";

export type OpenRepoDialog = (options: {
  directory: true;
  multiple: false;
  title: string;
}) => Promise<string | string[] | null>;

export type SaveProjectDialog = (options: {
  title: string;
  defaultPath: string;
  canCreateDirectories: true;
}) => Promise<string | null>;

export async function openRepoSession(
  openDialog: OpenRepoDialog,
  path?: string,
): Promise<RepoSession> {
  let resolvedPath = path;
  if (!resolvedPath) {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: "Open repository",
    });
    if (!selected || Array.isArray(selected)) {
      throw new Error("Repository selection was cancelled.");
    }
    resolvedPath = selected;
  }
  return buildRepoSessionFromPath(resolvedPath);
}

export async function createProjectSession(
  saveDialog: SaveProjectDialog,
  invokeCommand: InvokeCommand,
): Promise<RepoSession | null> {
  const selected = await saveDialog({
    title: "Where would you like this new project?",
    defaultPath: "untitled-helm-project",
    canCreateDirectories: true,
  });
  if (!selected) {
    return null;
  }
  const created = await invokeCommand<RawNewProjectResult>("create_new_project", {
    projectPath: selected,
  });
  return buildRepoSessionFromPath(created.projectPath);
}

export async function getLiveBackendStatus(
  invokeCommand: InvokeCommand,
  current: BackendStatus,
): Promise<BackendStatus> {
  try {
    const raw = await invokeCommand<RawBackendHealth>("backend_health");
    return {
      ...current,
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
    return {
      ...current,
      mode: "live",
      available: false,
      liveSyncEnabled: false,
      syncState: "error",
      note: "The desktop shell could not reach the Python bridge.",
      lastSyncError: message,
      lastError: message,
    };
  }
}

export function initialIndexingJobState(jobId: string, repoPath: string): IndexingJobState {
  return {
    jobId,
    repoPath,
    status: "queued",
    stage: "discover",
    processedModules: 0,
    totalModules: 0,
    symbolCount: 0,
    message: "Waiting for backend indexing to begin",
    progressPercent: 0,
  };
}

export async function scanRepoPayload(
  invokeCommand: InvokeCommand,
  repoPath: string,
  jobId: string,
): Promise<RawScanPayload> {
  return invokeCommand<RawScanPayload>("scan_repo_payload", { repoPath, jobId });
}

export function toWorkspaceSyncEvent(raw: RawWorkspaceSyncEvent): WorkspaceSyncEvent {
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

export function toIndexingJobState(raw: RawIndexProgressEvent): IndexingJobState {
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

export function backendStatusFromSyncEvent(
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

export function workspaceSyncNote(status: WorkspaceSyncState): string {
  if (status === "syncing") {
    return "Applying external repo changes to the live workspace.";
  }
  if (status === "synced") {
    return "Watching the active repo for workspace changes.";
  }
  if (status === "manual_resync_required") {
    return "Live sync needs a manual reindex to recover the workspace session.";
  }
  if (status === "error") {
    return "Live sync encountered an error.";
  }
  return "Persistent Python bridge is ready. Open a repo to enable live sync.";
}
