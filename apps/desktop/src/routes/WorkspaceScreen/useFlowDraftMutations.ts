import { useCallback, useEffect, useMemo, useState } from "react";
import {
  establishFlowDraftDocument,
  projectFlowDraftGraph,
} from "../../components/graph/flowDraftGraph";
import {
  flowDocumentsEqual,
  mergeFlowDraftWithSourceDocument,
} from "../../components/graph/flowDocument";
import {
  peekStoredGraphLayout,
  readStoredGraphLayout,
  writeStoredGraphLayout,
} from "../../components/graph/graphLayoutPersistence";
import type {
  FlowGraphDocument,
  FlowInputDisplayMode,
  GraphAbstractionLevel,
  GraphNodeKind,
  GraphView,
} from "../../lib/adapter";
import type { FlowDraftState } from "./types";
import {
  emptyStoredGraphLayout,
  flowLayoutViewKey,
  synchronizeFlowLayoutWithDocumentMutation,
} from "./workspaceScreenModel";

export function useFlowDraftMutations({
  activeLevel,
  currentFlowSymbolId,
  currentSymbolTargetId,
  flowInputDisplayMode,
  graphData,
  graphDataUpdatedAt,
  graphTargetId,
  repoPath,
}: {
  activeLevel: GraphAbstractionLevel;
  currentFlowSymbolId?: string;
  currentSymbolTargetId?: string;
  flowInputDisplayMode: FlowInputDisplayMode;
  graphData?: GraphView;
  graphDataUpdatedAt: number;
  graphTargetId?: string;
  repoPath?: string;
}) {
  const [flowDraftState, setFlowDraftState] = useState<FlowDraftState | undefined>(undefined);
  const flowDraftSeedDocument = useMemo(() => establishFlowDraftDocument(graphData), [graphData]);

  useEffect(() => {
    if (
      !currentSymbolTargetId ||
      !flowDraftState?.symbolId ||
      currentSymbolTargetId === flowDraftState.symbolId
    ) {
      return;
    }

    setFlowDraftState(undefined);
  }, [currentSymbolTargetId, flowDraftState?.symbolId]);

  useEffect(() => {
    if (!currentFlowSymbolId || !flowDraftSeedDocument) {
      return;
    }

    setFlowDraftState((current) => {
      if (!current || current.symbolId !== currentFlowSymbolId) {
        return {
          symbolId: currentFlowSymbolId,
          baseDocument: flowDraftSeedDocument,
          document: flowDraftSeedDocument,
          status: "idle",
          error: null,
        };
      }

      if (current.status === "saving") {
        return current;
      }

      if (
        current.status === "reconcile-pending" &&
        (current.reconcileAfterUpdatedAt ?? 0) >= graphDataUpdatedAt
      ) {
        return current;
      }

      const mergedDocument = mergeFlowDraftWithSourceDocument(
        current.document,
        current.baseDocument,
        flowDraftSeedDocument,
      );
      const nextStatus = current.status === "reconcile-pending" ? "idle" : current.status;
      const nextError = current.status === "reconcile-pending" ? null : current.error;
      if (
        flowDocumentsEqual(current.baseDocument, flowDraftSeedDocument) &&
        flowDocumentsEqual(current.document, mergedDocument) &&
        current.status === nextStatus &&
        current.error === nextError
      ) {
        return current;
      }

      return {
        symbolId: currentFlowSymbolId,
        baseDocument: flowDraftSeedDocument,
        document: mergedDocument,
        status: nextStatus,
        error: nextError,
        reconcileAfterUpdatedAt: undefined,
      };
    });
  }, [currentFlowSymbolId, flowDraftSeedDocument, graphDataUpdatedAt]);

  const resetFlowDraftState = useCallback(() => {
    setFlowDraftState(undefined);
  }, []);

  const syncFlowDraftLayout = useCallback(
    async (
      currentDocument: FlowGraphDocument,
      nextDocument: FlowGraphDocument,
      seededNodes: Array<{
        nodeId: string;
        kind: GraphNodeKind;
        position: { x: number; y: number };
      }> = [],
    ) => {
      if (!repoPath || !graphTargetId?.startsWith("symbol:")) {
        return;
      }

      const viewKey = flowLayoutViewKey(graphTargetId);
      const layout =
        peekStoredGraphLayout(repoPath, viewKey) ??
        (await readStoredGraphLayout(repoPath, viewKey)) ??
        emptyStoredGraphLayout();
      const nextLayout = synchronizeFlowLayoutWithDocumentMutation({
        currentDocument,
        nextDocument,
        layout,
        seededNodes,
      });
      await writeStoredGraphLayout(repoPath, viewKey, nextLayout);
    },
    [graphTargetId, repoPath],
  );

  const activeFlowDraft =
    currentFlowSymbolId && flowDraftState?.symbolId === currentFlowSymbolId
      ? flowDraftState
      : undefined;
  const effectiveGraph = useMemo(() => {
    if (activeLevel === "flow" && graphData && activeFlowDraft) {
      return projectFlowDraftGraph(graphData, activeFlowDraft.document, flowInputDisplayMode);
    }
    return graphData;
  }, [activeFlowDraft, activeLevel, flowInputDisplayMode, graphData]);

  return {
    activeFlowDraft,
    effectiveGraph,
    flowDraftSeedDocument,
    flowDraftState,
    resetFlowDraftState,
    setFlowDraftState,
    syncFlowDraftLayout,
  };
}
