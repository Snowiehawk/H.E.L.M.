import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import type {
  BackendUndoTransaction,
  DesktopAdapter,
  GraphAbstractionLevel,
  RepoSession,
  WorkspaceFileDeleteRequest,
  WorkspaceFileEntry,
  WorkspaceFileEntryKind,
  WorkspaceFileMoveRequest,
  WorkspaceFileMutationRequest,
  WorkspaceRecoveryEvent,
} from "../../lib/adapter";
import {
  confirmFlowRemoval,
  isWorkspacePathAtOrBelow,
  moduleIdFromRelativePath,
  movedWorkspaceRelativePath,
  workspaceRecursivePreviewMessage,
} from "./workspaceScreenModel";
import {
  invalidateWorkspaceFileOperationQueries,
  invalidateWorkspaceFileSaveQueries,
  workspaceQueryKeys,
} from "./workspaceQueries";

export function useWorkspaceFileOperations({
  adapter,
  currentModulePath,
  focusGraph,
  inspectorSourcePath,
  queryClient,
  recordBackendUndoTransaction,
  repoSession,
  selectedFilePath,
  surfaceRecoveryEvents,
  workspaceEntries,
}: {
  adapter: DesktopAdapter;
  currentModulePath?: string;
  focusGraph: (nodeId: string, level: GraphAbstractionLevel) => void;
  inspectorSourcePath?: string;
  queryClient: QueryClient;
  recordBackendUndoTransaction: (
    transaction: BackendUndoTransaction | null | undefined,
    summary?: string,
  ) => void;
  repoSession?: RepoSession;
  selectedFilePath?: string;
  surfaceRecoveryEvents: (events?: WorkspaceRecoveryEvent[]) => void;
  workspaceEntries?: WorkspaceFileEntry[];
}) {
  const [activeWorkspaceFilePath, setActiveWorkspaceFilePath] = useState<string | undefined>(
    undefined,
  );
  const [workspaceFileDraft, updateWorkspaceFileDraft] = useState("");
  const workspaceFileDraftRef = useRef("");
  const workspaceFileDraftRevisionRef = useRef(0);
  const workspaceFileReloadEpochRef = useRef(0);
  const workspaceFileSaveEpochRef = useRef(0);
  const workspaceFileMountedRef = useRef(true);
  const workspaceSessionRef = useRef(repoSession?.id);
  const workspaceRepoPathRef = useRef(repoSession?.path);
  const workspaceFilePathRef = useRef(activeWorkspaceFilePath);
  if (
    workspaceSessionRef.current !== repoSession?.id ||
    workspaceRepoPathRef.current !== repoSession?.path ||
    workspaceFilePathRef.current !== activeWorkspaceFilePath
  )
    workspaceFileReloadEpochRef.current += 1;
  workspaceSessionRef.current = repoSession?.id;
  workspaceRepoPathRef.current = repoSession?.path;
  workspaceFilePathRef.current = activeWorkspaceFilePath;
  useEffect(() => {
    workspaceFileMountedRef.current = true;
    return () => {
      workspaceFileMountedRef.current = false;
      workspaceFileReloadEpochRef.current += 1;
    };
  }, []);
  const setWorkspaceFileDraft = useCallback((update: SetStateAction<string>) => {
    const next = typeof update === "function" ? update(workspaceFileDraftRef.current) : update;
    if (next !== workspaceFileDraftRef.current) workspaceFileDraftRevisionRef.current += 1;
    workspaceFileDraftRef.current = next;
    updateWorkspaceFileDraft(next);
  }, []);
  const [workspaceFileStale, setWorkspaceFileStale] = useState(false);
  const [workspaceFileSaveError, setWorkspaceFileSaveError] = useState<string | null>(null);
  const [isSavingWorkspaceFile, setIsSavingWorkspaceFile] = useState(false);
  const workspaceFileLoadedKeyRef = useRef<string | undefined>(undefined);

  const workspaceFileQuery = useQuery({
    queryKey: workspaceQueryKeys.workspaceFile(repoSession?.id, activeWorkspaceFilePath),
    queryFn: () => adapter.readWorkspaceFile(repoSession!.path, activeWorkspaceFilePath!),
    enabled: Boolean(repoSession && activeWorkspaceFilePath),
  });
  const activeWorkspaceFile = workspaceFileQuery.data;
  const workspaceFileDirty = Boolean(
    activeWorkspaceFile?.editable && workspaceFileDraft !== activeWorkspaceFile.content,
  );
  const workspaceEntryKindForPath = useCallback(
    (relativePath: string): WorkspaceFileEntryKind | undefined =>
      workspaceEntries?.find((entry) => entry.relativePath === relativePath)?.kind,
    [workspaceEntries],
  );

  useEffect(() => {
    if (!activeWorkspaceFile) {
      return;
    }

    const loadedKey = `${activeWorkspaceFile.relativePath}:${activeWorkspaceFile.version}`;
    if (workspaceFileLoadedKeyRef.current !== loadedKey) {
      if (workspaceFileLoadedKeyRef.current && workspaceFileDirty) {
        setWorkspaceFileStale(true);
        workspaceFileLoadedKeyRef.current = loadedKey;
        return;
      }

      workspaceFileLoadedKeyRef.current = loadedKey;
      setWorkspaceFileDraft(activeWorkspaceFile.content);
      setWorkspaceFileStale(false);
      setWorkspaceFileSaveError(null);
      return;
    }

    if (!workspaceFileDirty && !workspaceFileStale) {
      setWorkspaceFileDraft(activeWorkspaceFile.content);
    }
  }, [activeWorkspaceFile, workspaceFileDirty, workspaceFileStale]);

  const resetWorkspaceFileState = useCallback(() => {
    workspaceFileReloadEpochRef.current += 1;
    setActiveWorkspaceFilePath(undefined);
    setWorkspaceFileDraft("");
    setWorkspaceFileStale(false);
    setWorkspaceFileSaveError(null);
    setIsSavingWorkspaceFile(false);
    workspaceFileLoadedKeyRef.current = undefined;
  }, []);

  const selectWorkspaceFile = useCallback((relativePath: string) => {
    workspaceFileReloadEpochRef.current += 1;
    setActiveWorkspaceFilePath(relativePath);
    setWorkspaceFileDraft("");
    setWorkspaceFileStale(false);
    setWorkspaceFileSaveError(null);
    workspaceFileLoadedKeyRef.current = undefined;
  }, []);

  const createWorkspaceEntry = useCallback(
    async (request: WorkspaceFileMutationRequest) => {
      if (!repoSession) {
        throw new Error("Open a repository before creating files.");
      }

      const result = await adapter.createWorkspaceEntry(repoSession.path, request);
      surfaceRecoveryEvents(result.recoveryEvents);
      recordBackendUndoTransaction(result.undoTransaction);
      await invalidateWorkspaceFileOperationQueries(queryClient);

      if (result.kind === "file") {
        if (result.relativePath.endsWith(".py")) {
          focusGraph(moduleIdFromRelativePath(result.relativePath), "module");
          setActiveWorkspaceFilePath(undefined);
        } else {
          selectWorkspaceFile(result.relativePath);
        }
      }
    },
    [
      adapter,
      focusGraph,
      queryClient,
      recordBackendUndoTransaction,
      repoSession,
      selectWorkspaceFile,
      surfaceRecoveryEvents,
    ],
  );

  const moveWorkspaceEntry = useCallback(
    async (request: WorkspaceFileMoveRequest) => {
      if (!repoSession) {
        throw new Error("Open a repository before moving files.");
      }

      const targetRelativePath = request.targetDirectoryRelativePath
        ? `${request.targetDirectoryRelativePath}/${request.sourceRelativePath.split("/").pop() ?? request.sourceRelativePath}`
        : (request.sourceRelativePath.split("/").pop() ?? request.sourceRelativePath);
      const movedActiveFilePath = movedWorkspaceRelativePath(
        activeWorkspaceFilePath,
        request.sourceRelativePath,
        targetRelativePath,
      );
      if (movedActiveFilePath && workspaceFileDirty) {
        throw new Error("Save or cancel the open file before moving it.");
      }

      let requestToApply = request;
      const sourceKind = workspaceEntryKindForPath(request.sourceRelativePath);
      if (sourceKind !== "file") {
        const preview = await adapter.previewWorkspaceFileOperation(repoSession.path, {
          operation: "move",
          sourceRelativePath: request.sourceRelativePath,
          targetDirectoryRelativePath: request.targetDirectoryRelativePath,
        });
        if (preview.entryKind === "directory") {
          const confirmed = await confirmFlowRemoval(workspaceRecursivePreviewMessage(preview), {
            okLabel: "Move Folder",
            title: "Move Workspace Folder",
          });
          if (!confirmed) {
            return;
          }
          requestToApply = {
            ...request,
            expectedImpactFingerprint: preview.impactFingerprint,
          };
        }
      }

      const result = await adapter.moveWorkspaceEntry(repoSession.path, requestToApply);
      surfaceRecoveryEvents(result.recoveryEvents);
      recordBackendUndoTransaction(result.undoTransaction);
      await invalidateWorkspaceFileOperationQueries(queryClient);

      if (movedActiveFilePath) {
        if (movedActiveFilePath.endsWith(".py")) {
          setActiveWorkspaceFilePath(undefined);
          focusGraph(moduleIdFromRelativePath(movedActiveFilePath), "module");
        } else {
          selectWorkspaceFile(movedActiveFilePath);
        }
        return;
      }

      if (result.kind === "file" && result.relativePath.endsWith(".py")) {
        focusGraph(moduleIdFromRelativePath(result.relativePath), "module");
      }
    },
    [
      activeWorkspaceFilePath,
      adapter,
      focusGraph,
      queryClient,
      recordBackendUndoTransaction,
      repoSession,
      selectWorkspaceFile,
      surfaceRecoveryEvents,
      workspaceEntryKindForPath,
      workspaceFileDirty,
    ],
  );

  const deleteWorkspaceEntry = useCallback(
    async (request: WorkspaceFileDeleteRequest) => {
      if (!repoSession) {
        throw new Error("Open a repository before deleting files.");
      }

      const deletingOpenFile = isWorkspacePathAtOrBelow(
        activeWorkspaceFilePath,
        request.relativePath,
      );
      if (deletingOpenFile && workspaceFileDirty) {
        throw new Error("Save or cancel the open file before deleting it.");
      }

      let requestToApply = request;
      const entryKind = workspaceEntryKindForPath(request.relativePath);
      let confirmationMessage = `Delete ${request.relativePath}? Undo will be available after success.`;
      if (entryKind !== "file") {
        const preview = await adapter.previewWorkspaceFileOperation(repoSession.path, {
          operation: "delete",
          relativePath: request.relativePath,
        });
        if (preview.entryKind === "directory") {
          confirmationMessage = workspaceRecursivePreviewMessage(preview);
          requestToApply = {
            ...request,
            expectedImpactFingerprint: preview.impactFingerprint,
          };
        }
      }
      const confirmed = await confirmFlowRemoval(confirmationMessage, {
        okLabel: "Delete",
        title: "Delete Workspace Entry",
      });
      if (!confirmed) {
        return;
      }

      const deletingActiveGraphPath =
        isWorkspacePathAtOrBelow(selectedFilePath, request.relativePath) ||
        isWorkspacePathAtOrBelow(currentModulePath, request.relativePath) ||
        isWorkspacePathAtOrBelow(inspectorSourcePath, request.relativePath);

      const deletedOpenFilePath = deletingOpenFile ? activeWorkspaceFilePath : undefined;
      const result = await adapter.deleteWorkspaceEntry(repoSession.path, requestToApply);
      surfaceRecoveryEvents(result.recoveryEvents);
      recordBackendUndoTransaction(result.undoTransaction);
      if (deletingOpenFile) {
        setActiveWorkspaceFilePath(undefined);
        setWorkspaceFileDraft("");
        setWorkspaceFileStale(false);
        setWorkspaceFileSaveError(null);
        workspaceFileLoadedKeyRef.current = undefined;
        if (deletedOpenFilePath) {
          queryClient.removeQueries({
            queryKey: workspaceQueryKeys.workspaceFile(repoSession.id, deletedOpenFilePath),
            exact: true,
          });
        }
      }

      if (deletingOpenFile) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["workspace-files"] }),
          queryClient.invalidateQueries({ queryKey: ["overview"] }),
          queryClient.invalidateQueries({ queryKey: ["graph-view"] }),
          queryClient.invalidateQueries({ queryKey: ["workspace-search"] }),
        ]);
      } else {
        await invalidateWorkspaceFileOperationQueries(queryClient);
      }

      if (
        deletingActiveGraphPath ||
        result.changedRelativePaths.some(
          (path) => path.endsWith(".py") && path === currentModulePath,
        )
      ) {
        focusGraph(repoSession.id, "repo");
      }
    },
    [
      activeWorkspaceFilePath,
      adapter,
      currentModulePath,
      focusGraph,
      inspectorSourcePath,
      queryClient,
      recordBackendUndoTransaction,
      repoSession,
      selectedFilePath,
      surfaceRecoveryEvents,
      workspaceEntryKindForPath,
      workspaceFileDirty,
    ],
  );

  const renderedFileEditorEpoch = workspaceFileReloadEpochRef.current;
  const saveWorkspaceFileVerified = useCallback(async () => {
    if (!repoSession || !activeWorkspaceFile) {
      throw new Error("Open a workspace file before saving.");
    }
    if (
      !workspaceFileMountedRef.current ||
      workspaceSessionRef.current !== repoSession.id ||
      workspaceRepoPathRef.current !== repoSession.path ||
      workspaceFilePathRef.current !== activeWorkspaceFile.relativePath ||
      workspaceFileReloadEpochRef.current !== renderedFileEditorEpoch
    )
      throw new Error(
        "This file editor is no longer current. Review the current editor before saving.",
      );
    if (workspaceFileStale) {
      setWorkspaceFileSaveError("This file changed on disk. Reload it before saving again.");
      throw new Error("This file changed on disk. Reload it before saving again.");
    }

    setIsSavingWorkspaceFile(true);
    setWorkspaceFileSaveError(null);
    const saveEpoch = ++workspaceFileSaveEpochRef.current;
    const savedDraft = workspaceFileDraftRef.current;
    const savedDraftRevision = workspaceFileDraftRevisionRef.current;
    const savedEditorEpoch = workspaceFileReloadEpochRef.current;
    const savedSessionId = repoSession.id;
    const savedRepoPath = repoSession.path;
    const savedPath = activeWorkspaceFile.relativePath;
    const sameSession = () =>
      workspaceFileMountedRef.current &&
      workspaceSessionRef.current === savedSessionId &&
      workspaceRepoPathRef.current === savedRepoPath;
    const sameEditor = () =>
      sameSession() &&
      workspaceFilePathRef.current === savedPath &&
      workspaceFileReloadEpochRef.current === savedEditorEpoch;
    try {
      const result = await adapter.saveWorkspaceFile(
        repoSession.path,
        activeWorkspaceFile.relativePath,
        savedDraft,
        activeWorkspaceFile.version,
      );
      // A committed write retains Undo in its original mounted session, even
      // when that session's file editor closed or switched during the write.
      // It must never append that transaction to a replacement session.
      if (sameSession()) {
        surfaceRecoveryEvents(result.recoveryEvents);
        recordBackendUndoTransaction(result.undoTransaction);
      }
      if (!sameEditor())
        throw new Error(
          "The workspace or file editor changed while saving. Saved edits remain saved; review the current editor before Run.",
        );
      if (!result.file || result.file.content !== savedDraft) {
        throw new Error(
          "The file save did not confirm the requested bytes. Review the draft and retry.",
        );
      }
      const verified = await adapter.readWorkspaceFile(
        repoSession.path,
        activeWorkspaceFile.relativePath,
      );
      if (verified.version !== result.file.version || verified.content !== savedDraft) {
        throw new Error(
          "The file changed while saving. The draft is preserved; review it before Run.",
        );
      }
      if (
        !sameEditor() ||
        workspaceFileDraftRevisionRef.current !== savedDraftRevision ||
        workspaceFileDraftRef.current !== savedDraft
      ) {
        throw new Error(
          "The workspace or draft changed while saving. Review the current draft and retry.",
        );
      }
      if (result.file) {
        queryClient.setQueryData(
          workspaceQueryKeys.workspaceFile(repoSession.id, result.file.relativePath),
          result.file,
        );
        setWorkspaceFileDraft(result.file.content);
        workspaceFileLoadedKeyRef.current = `${result.file.relativePath}:${result.file.version}`;
      }
      setWorkspaceFileStale(false);
      await invalidateWorkspaceFileSaveQueries(queryClient);
    } catch (reason) {
      if (sameEditor())
        setWorkspaceFileSaveError(
          reason instanceof Error ? reason.message : "Unable to save this file.",
        );
      throw reason;
    } finally {
      if (workspaceFileMountedRef.current && workspaceFileSaveEpochRef.current === saveEpoch)
        setIsSavingWorkspaceFile(false);
    }
  }, [
    activeWorkspaceFile,
    adapter,
    queryClient,
    recordBackendUndoTransaction,
    repoSession,
    renderedFileEditorEpoch,
    surfaceRecoveryEvents,
    workspaceFileStale,
    setWorkspaceFileDraft,
  ]);

  // Click handlers retain the existing inline error behavior. Execution and
  // transition callers must use the explicit rejecting/verified operation.
  const saveWorkspaceFile = useCallback(async () => {
    try {
      await saveWorkspaceFileVerified();
    } catch {
      // The editor already displays the responsible failure.
    }
  }, [saveWorkspaceFileVerified]);

  const handleCancelWorkspaceFileEdit = useCallback(async () => {
    // Cancel retires a pending save/reload even if the resulting text happens
    // to equal an earlier draft. Text equality cannot re-admit its reply.
    workspaceFileReloadEpochRef.current += 1;
    if (workspaceFileStale) {
      if (!repoSession || !activeWorkspaceFile) return;
      const epoch = ++workspaceFileReloadEpochRef.current;
      const draftRevision = workspaceFileDraftRevisionRef.current;
      const stillOwned = () =>
        workspaceFileReloadEpochRef.current === epoch &&
        workspaceSessionRef.current === repoSession.id &&
        workspaceRepoPathRef.current === repoSession.path;
      setWorkspaceFileSaveError(null);
      // Keep Run/save blocked until a fresh read confirms the replacement.
      // The disk version may already be cached while the old draft is retained.
      try {
        const file = await adapter.readWorkspaceFile(
          repoSession.path,
          activeWorkspaceFile.relativePath,
        );
        if (!stillOwned()) return;
        if (!file || file.relativePath !== activeWorkspaceFile.relativePath) {
          throw new Error("Unable to confirm this file from disk. The draft is preserved.");
        }
        if (workspaceFileDraftRevisionRef.current !== draftRevision) {
          throw new Error("The draft changed while reloading. Review it before reloading again.");
        }
        workspaceFileLoadedKeyRef.current = `${file.relativePath}:${file.version}`;
        queryClient.setQueryData(
          workspaceQueryKeys.workspaceFile(repoSession.id, file.relativePath),
          file,
        );
        setWorkspaceFileDraft(file.content);
        setWorkspaceFileStale(false);
      } catch (reason) {
        if (stillOwned()) {
          setWorkspaceFileSaveError(
            reason instanceof Error ? reason.message : "Unable to reload this file.",
          );
        }
      }
      return;
    }

    setWorkspaceFileDraft(activeWorkspaceFile?.content ?? "");
    setWorkspaceFileSaveError(null);
  }, [
    activeWorkspaceFile,
    adapter,
    queryClient,
    repoSession,
    setWorkspaceFileDraft,
    workspaceFileStale,
  ]);

  const handleCloseWorkspaceFileEditor = useCallback(() => {
    if (workspaceFileDirty || workspaceFileStale) {
      const shouldClose = window.confirm("Close this file editor and discard the current draft?");
      if (!shouldClose) {
        return;
      }
    }
    resetWorkspaceFileState();
  }, [resetWorkspaceFileState, workspaceFileDirty, workspaceFileStale]);

  const workspaceFileError =
    workspaceFileQuery.error instanceof Error
      ? workspaceFileQuery.error.message
      : workspaceFileQuery.error
        ? "Unable to load this file."
        : null;

  return {
    activeWorkspaceFile,
    activeWorkspaceFilePath,
    createWorkspaceEntry,
    deleteWorkspaceEntry,
    handleCancelWorkspaceFileEdit,
    handleCloseWorkspaceFileEditor,
    isSavingWorkspaceFile,
    moveWorkspaceEntry,
    resetWorkspaceFileState,
    saveWorkspaceFile,
    saveWorkspaceFileVerified,
    selectWorkspaceFile,
    setActiveWorkspaceFilePath,
    setWorkspaceFileDraft,
    setWorkspaceFileSaveError,
    setWorkspaceFileStale,
    workspaceFileDirty,
    workspaceFileDraft,
    workspaceFileDraftRef,
    workspaceFileError,
    workspaceFileQuery,
    workspaceFileSaveError,
    workspaceFileStale,
  };
}
