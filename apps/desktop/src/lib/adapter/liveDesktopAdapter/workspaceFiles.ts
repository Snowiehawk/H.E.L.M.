import type {
  WorkspaceFileContents,
  WorkspaceFileDeleteRequest,
  WorkspaceFileEntry,
  WorkspaceFileMoveRequest,
  WorkspaceFileMutationRequest,
  WorkspaceFileMutationResult,
  WorkspaceFileOperationPreview,
  WorkspaceFileOperationPreviewRequest,
  WorkspaceFileTree,
} from "../contracts";
import type {
  RawScanPayload,
  RawWorkspaceFileContents,
  RawWorkspaceFileEntry,
  RawWorkspaceFileMutationResult,
  RawWorkspaceFileOperationPreview,
  RawWorkspaceFileTree,
} from "./rawTypes";
import { fromRawUndoTransaction } from "./sourceEdits";
import { normalizePath, toRecoveryEvents, type InvokeCommand } from "./shared";

export type WorkspaceFileMutationCommandResult = {
  result: WorkspaceFileMutationResult;
  payload?: RawScanPayload | null;
};

export function toWorkspaceFileEntry(raw: RawWorkspaceFileEntry): WorkspaceFileEntry {
  return {
    relativePath: raw.relative_path,
    name: raw.name,
    kind: raw.kind,
    sizeBytes: raw.size_bytes ?? null,
    editable: raw.editable,
    reason: raw.reason ?? null,
    modifiedAt: raw.modified_at ?? null,
  };
}

export function toWorkspaceFileContents(raw: RawWorkspaceFileContents): WorkspaceFileContents {
  return {
    ...toWorkspaceFileEntry(raw),
    kind: "file",
    content: raw.content,
    version: raw.version,
  };
}

export function toWorkspaceFileMutationResult(
  raw: RawWorkspaceFileMutationResult,
): WorkspaceFileMutationResult {
  return {
    relativePath: raw.relative_path,
    kind: raw.kind,
    changedRelativePaths: raw.changed_relative_paths,
    file: raw.file ? toWorkspaceFileContents(raw.file) : (raw.file ?? null),
    recoveryEvents: toRecoveryEvents(raw.recovery_events),
    undoTransaction: raw.undo_transaction
      ? fromRawUndoTransaction(raw.undo_transaction)
      : undefined,
  };
}

export function toWorkspaceFileOperationPreview(
  raw: RawWorkspaceFileOperationPreview,
): WorkspaceFileOperationPreview {
  return {
    operationKind: raw.operation_kind,
    sourceRelativePath: raw.source_relative_path,

    entryKind: raw.entry_kind,
    counts: {
      entryCount: raw.counts.entry_count,
      fileCount: raw.counts.file_count,
      directoryCount: raw.counts.directory_count,
      symlinkCount: raw.counts.symlink_count,
      totalSizeBytes: raw.counts.total_size_bytes,
      pythonFileCount: raw.counts.python_file_count,
    },
    warnings: raw.warnings,
    affectedPaths: raw.affected_paths,
    affectedPathsTruncated: raw.affected_paths_truncated,
    impactFingerprint: raw.impact_fingerprint,
  };
}

export async function listWorkspaceFilesCommand(
  invokeCommand: InvokeCommand,
  repoPath: string,
): Promise<WorkspaceFileTree> {
  const raw = await invokeCommand<RawWorkspaceFileTree>("list_workspace_files", {
    repoPath: normalizePath(repoPath),
  });
  return {
    rootPath: normalizePath(raw.root_path),
    entries: raw.entries.map(toWorkspaceFileEntry),
    truncated: raw.truncated,
  };
}

export async function readWorkspaceFileCommand(
  invokeCommand: InvokeCommand,
  repoPath: string,
  relativePath: string,
): Promise<WorkspaceFileContents> {
  const raw = await invokeCommand<RawWorkspaceFileContents>("read_workspace_file", {
    repoPath: normalizePath(repoPath),
    relativePath,
  });
  return toWorkspaceFileContents(raw);
}

export async function previewWorkspaceFileOperationCommand(
  invokeCommand: InvokeCommand,
  repoPath: string,
  request: WorkspaceFileOperationPreviewRequest,
): Promise<WorkspaceFileOperationPreview> {
  const raw = await invokeCommand<RawWorkspaceFileOperationPreview>(
    "preview_workspace_file_operation",
    {
      repoPath: normalizePath(repoPath),
      operation: request.operation,
      relativePath: request.operation === "delete" ? request.relativePath : null,
      sourceRelativePath: request.operation === "move" ? request.sourceRelativePath : null,
      targetDirectoryRelativePath:
        request.operation === "move" ? request.targetDirectoryRelativePath : null,
    },
  );
  return toWorkspaceFileOperationPreview(raw);
}

export async function createWorkspaceEntryCommand(
  invokeCommand: InvokeCommand,
  repoPath: string,
  request: WorkspaceFileMutationRequest,
): Promise<WorkspaceFileMutationCommandResult> {
  const raw = await invokeCommand<RawWorkspaceFileMutationResult>("create_workspace_entry", {
    repoPath: normalizePath(repoPath),
    kind: request.kind,
    relativePath: request.relativePath,
    content: request.content ?? null,
  });
  return { result: toWorkspaceFileMutationResult(raw), payload: raw.payload };
}

export async function saveWorkspaceFileCommand(
  invokeCommand: InvokeCommand,
  repoPath: string,
  relativePath: string,
  content: string,
  expectedVersion: string,
): Promise<WorkspaceFileMutationCommandResult> {
  const raw = await invokeCommand<RawWorkspaceFileMutationResult>("save_workspace_file", {
    repoPath: normalizePath(repoPath),
    relativePath,
    content,
    expectedVersion,
  });
  return { result: toWorkspaceFileMutationResult(raw), payload: raw.payload };
}

export async function moveWorkspaceEntryCommand(
  invokeCommand: InvokeCommand,
  repoPath: string,
  request: WorkspaceFileMoveRequest,
): Promise<WorkspaceFileMutationCommandResult> {
  const raw = await invokeCommand<RawWorkspaceFileMutationResult>("move_workspace_entry", {
    repoPath: normalizePath(repoPath),
    sourceRelativePath: request.sourceRelativePath,
    targetDirectoryRelativePath: request.targetDirectoryRelativePath,
    expectedImpactFingerprint: request.expectedImpactFingerprint ?? null,
  });
  return { result: toWorkspaceFileMutationResult(raw), payload: raw.payload };
}

export async function deleteWorkspaceEntryCommand(
  invokeCommand: InvokeCommand,
  repoPath: string,
  request: WorkspaceFileDeleteRequest,
): Promise<WorkspaceFileMutationCommandResult> {
  const raw = await invokeCommand<RawWorkspaceFileMutationResult>("delete_workspace_entry", {
    repoPath: normalizePath(repoPath),
    relativePath: request.relativePath,
    expectedImpactFingerprint: request.expectedImpactFingerprint ?? null,
  });
  return { result: toWorkspaceFileMutationResult(raw), payload: raw.payload };
}
