import { useCallback, useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type {
  BackendUndoTransaction,
  DesktopAdapter,
  EditableNodeSource,
  GraphAbstractionLevel,
  RevealedSource,
  StructuralEditResult,
  WorkspaceRecoveryEvent,
} from "../../lib/adapter";
import type { WorkspaceActivity } from "../../store/uiStore";
import { useUndoStore } from "../../store/undoStore";
import type { BackendUndoHistoryEntry, InspectorPanelMode } from "./types";

export function useBackendUndoCoordinator({
  activeLevel,
  adapter,
  clearInspectorDraftContent,
  focusGraph,
  graphTargetId,
  inspectorTargetId,
  refreshWorkspaceData,
  setDismissedPeekNodeId,
  setInspectorDirty,
  setInspectorEditableSourceOverride,
  setInspectorPanelMode,
  setInspectorSourceVersion,
  setLastActivity,
  setLastEdit,
  setRevealedSource,
  surfaceRecoveryEvents,
}: {
  activeLevel: GraphAbstractionLevel;
  adapter: DesktopAdapter;
  clearInspectorDraftContent: () => void;
  focusGraph: (nodeId: string, level: GraphAbstractionLevel) => void;
  graphTargetId?: string;
  inspectorTargetId?: string;
  refreshWorkspaceData: (targetId?: string) => Promise<EditableNodeSource | undefined>;
  setDismissedPeekNodeId: (nodeId?: string) => void;
  setInspectorDirty: (dirty: boolean) => void;
  setInspectorEditableSourceOverride: (source?: EditableNodeSource) => void;
  setInspectorPanelMode: Dispatch<SetStateAction<InspectorPanelMode>>;
  setInspectorSourceVersion: Dispatch<SetStateAction<number>>;
  setLastActivity: (activity?: WorkspaceActivity) => void;
  setLastEdit: (edit?: StructuralEditResult) => void;
  setRevealedSource: (source?: RevealedSource) => void;
  surfaceRecoveryEvents: (events?: WorkspaceRecoveryEvent[]) => void;
}) {
  const [backendUndoStack, setBackendUndoStack] = useState<BackendUndoHistoryEntry[]>([]);
  const [backendRedoStack, setBackendRedoStack] = useState<BackendUndoHistoryEntry[]>([]);

  const resetBackendUndoHistory = useCallback(() => {
    setBackendUndoStack([]);
    setBackendRedoStack([]);
  }, []);

  const recordBackendUndoTransaction = useCallback(
    (transaction: BackendUndoTransaction | null | undefined, summary?: string) => {
      if (!transaction) {
        return;
      }
      setBackendUndoStack((current) => [
        ...current,
        {
          transaction,
          entry: {
            domain: "backend",
            summary: summary ?? transaction.summary,
            createdAt: Date.now(),
          },
        },
      ]);
      setBackendRedoStack([]);
    },
    [],
  );

  useEffect(
    () =>
      useUndoStore.getState().registerDomain("backend", {
        canUndo: () => backendUndoStack.length > 0,
        canRedo: () => backendRedoStack.length > 0,
        peekEntry: () => backendUndoStack[backendUndoStack.length - 1]?.entry,
        peekRedoEntry: () => backendRedoStack[backendRedoStack.length - 1]?.entry,
        undo: async () => {
          const undoEntry = backendUndoStack[backendUndoStack.length - 1];
          if (!undoEntry) {
            return {
              domain: "backend" as const,
              handled: false,
            };
          }

          try {
            const result = await adapter.applyBackendUndo(undoEntry.transaction);
            surfaceRecoveryEvents(result.recoveryEvents);
            setBackendUndoStack((current) => current.slice(0, -1));
            const redoTransaction = result.redoTransaction;
            if (redoTransaction) {
              setBackendRedoStack((current) => [
                ...current,
                {
                  transaction: redoTransaction,
                  entry: {
                    ...undoEntry.entry,
                    createdAt: Date.now(),
                  },
                },
              ]);
            }
            setDismissedPeekNodeId(undefined);
            setInspectorPanelMode("expanded");
            setLastEdit(undefined);
            setLastActivity({
              domain: "backend",
              kind: "undo",
              summary: result.summary,
              touchedRelativePaths: result.restoredRelativePaths,
              warnings: result.warnings,
            });
            setRevealedSource(undefined);
            setInspectorDirty(false);
            clearInspectorDraftContent();
            const refreshedSource = await refreshWorkspaceData(inspectorTargetId);
            setInspectorEditableSourceOverride(refreshedSource);
            setInspectorSourceVersion((current) => current + 1);

            if (result.focusTarget) {
              focusGraph(result.focusTarget.targetId, result.focusTarget.level);
            } else if (graphTargetId) {
              focusGraph(graphTargetId, activeLevel);
            }

            return {
              domain: "backend" as const,
              handled: true,
              summary: result.summary,
            };
          } catch (reason) {
            const summary =
              reason instanceof Error ? reason.message : "Unable to undo the last backend change.";
            setLastActivity({
              domain: "backend",
              kind: "error",
              summary,
            });
            return {
              domain: "backend" as const,
              handled: false,
              summary,
            };
          }
        },
        redo: async () => {
          const redoEntry = backendRedoStack[backendRedoStack.length - 1];
          if (!redoEntry) {
            return {
              domain: "backend" as const,
              handled: false,
            };
          }

          try {
            const result = await adapter.applyBackendUndo(redoEntry.transaction);
            surfaceRecoveryEvents(result.recoveryEvents);
            const summary = `Redid: ${redoEntry.entry.summary}`;
            setBackendRedoStack((current) => current.slice(0, -1));
            const undoTransaction = result.redoTransaction;
            if (undoTransaction) {
              setBackendUndoStack((current) => [
                ...current,
                {
                  transaction: undoTransaction,
                  entry: {
                    ...redoEntry.entry,
                    createdAt: Date.now(),
                  },
                },
              ]);
            }
            setDismissedPeekNodeId(undefined);
            setInspectorPanelMode("expanded");
            setLastEdit(undefined);
            setLastActivity({
              domain: "backend",
              kind: "redo",
              summary,
              touchedRelativePaths: result.restoredRelativePaths,
              warnings: result.warnings,
            });
            setRevealedSource(undefined);
            setInspectorDirty(false);
            clearInspectorDraftContent();
            const refreshedSource = await refreshWorkspaceData(inspectorTargetId);
            setInspectorEditableSourceOverride(refreshedSource);
            setInspectorSourceVersion((current) => current + 1);

            if (result.focusTarget) {
              focusGraph(result.focusTarget.targetId, result.focusTarget.level);
            } else if (graphTargetId) {
              focusGraph(graphTargetId, activeLevel);
            }

            return {
              domain: "backend" as const,
              handled: true,
              summary,
            };
          } catch (reason) {
            const summary =
              reason instanceof Error ? reason.message : "Unable to redo the last backend change.";
            setLastActivity({
              domain: "backend",
              kind: "error",
              summary,
            });
            return {
              domain: "backend" as const,
              handled: false,
              summary,
            };
          }
        },
      }),
    [
      activeLevel,
      adapter,
      backendRedoStack,
      backendUndoStack,
      clearInspectorDraftContent,
      focusGraph,
      graphTargetId,
      inspectorTargetId,
      refreshWorkspaceData,
      setDismissedPeekNodeId,
      setInspectorDirty,
      setInspectorEditableSourceOverride,
      setInspectorPanelMode,
      setInspectorSourceVersion,
      setLastActivity,
      setLastEdit,
      setRevealedSource,
      surfaceRecoveryEvents,
    ],
  );

  return {
    recordBackendUndoTransaction,
    resetBackendUndoHistory,
  };
}
