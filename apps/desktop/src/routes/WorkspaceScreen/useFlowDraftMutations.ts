import { useCallback, useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { QueryClient } from "@tanstack/react-query";
import type {
  GraphFlowConnectionIntent,
  GraphFlowDeleteIntent,
} from "../../components/graph/GraphCanvas";
import {
  establishFlowDraftDocument,
  projectFlowDraftGraph,
} from "../../components/graph/flowDraftGraph";
import {
  addFlowFunctionInput,
  createFlowNode,
  flowFunctionInputRemovalSummary,
  flowDocumentsEqual,
  flowNodePayloadFromContent,
  mergeFlowDraftWithSourceDocument,
  moveFlowFunctionInput,
  updateFlowFunctionInput,
} from "../../components/graph/flowDocument";
import { EMPTY_EXPRESSION_GRAPH } from "../../components/graph/flowExpressionGraphEditing";
import {
  expressionFromFlowExpressionGraph,
  normalizeFlowExpressionGraph,
} from "../../components/graph/flowExpressionGraph";
import {
  peekStoredGraphLayout,
  readStoredGraphLayout,
  writeStoredGraphLayout,
} from "../../components/graph/graphLayoutPersistence";
import type {
  GraphCreateComposerState,
  GraphCreateComposerSubmit,
} from "../../components/workspace/GraphCreateComposer";
import type {
  DesktopAdapter,
  EditableNodeSource,
  FlowExpressionGraph,
  FlowGraphDocument,
  FlowInputDisplayMode,
  GraphAbstractionLevel,
  GraphNodeKind,
  GraphView,
  StructuralEditRequest,
  StructuralEditResult,
} from "../../lib/adapter";
import type {
  FlowDraftState,
  InspectorSourceTarget,
  ReturnExpressionGraphViewState,
} from "./types";
import {
  applyFlowConnectionMutation,
  createAuthoredFlowNodeMutation,
  createFlowFunctionInputMutation,
  deleteFlowSelectionMutation,
  disconnectFlowEdgeMutation,
  functionInputIdsForFlowSelection,
  optimisticFlowDocument,
  removeFlowFunctionInputsMutation,
  selectedFlowEntryNodeId,
  updateAuthoredFlowNodePayload,
  updateReturnExpressionFlowDocument,
  type SeededFlowLayoutNode,
} from "./flowDraftMutationHelpers";
import { workspaceQueryKeys } from "./workspaceQueries";
import {
  confirmFlowRemoval,
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

export function useFlowDraftMutationCallbacks({
  activeFlowDraft,
  adapter,
  applyStructuralEdit,
  effectiveGraph,
  graphDataUpdatedAt,
  graphTargetId,
  inspectorSourceTarget,
  queryClient,
  repoSessionId,
  requestClearSelectionState,
  returnExpressionGraphView,
  selectNode,
  setCreateModeError,
  setFlowDraftState,
  setInspectorActionError,
  setInspectorEditableSourceOverride,
  setInspectorSourceVersion,
  setIsSubmittingExpressionGraph,
  setReturnExpressionGraphView,
  syncFlowDraftLayout,
}: {
  activeFlowDraft?: FlowDraftState;
  adapter: DesktopAdapter;
  applyStructuralEdit: (
    request: StructuralEditRequest,
    options?: { preserveView?: boolean },
  ) => Promise<StructuralEditResult>;
  effectiveGraph?: GraphView;
  graphDataUpdatedAt: number;
  graphTargetId?: string;
  inspectorSourceTarget?: InspectorSourceTarget;
  queryClient: QueryClient;
  repoSessionId?: string;
  requestClearSelectionState: () => Promise<boolean>;
  returnExpressionGraphView?: ReturnExpressionGraphViewState;
  selectNode: (nodeId?: string) => void;
  setCreateModeError: Dispatch<SetStateAction<string | null>>;
  setFlowDraftState: Dispatch<SetStateAction<FlowDraftState | undefined>>;
  setInspectorActionError: Dispatch<SetStateAction<string | null>>;
  setInspectorEditableSourceOverride: Dispatch<SetStateAction<EditableNodeSource | undefined>>;
  setInspectorSourceVersion: Dispatch<SetStateAction<number>>;
  setIsSubmittingExpressionGraph: Dispatch<SetStateAction<boolean>>;
  setReturnExpressionGraphView: Dispatch<
    SetStateAction<ReturnExpressionGraphViewState | undefined>
  >;
  syncFlowDraftLayout: (
    currentDocument: FlowGraphDocument,
    nextDocument: FlowGraphDocument,
    seededNodes?: SeededFlowLayoutNode[],
  ) => Promise<void>;
}) {
  const applyFlowDraftMutation = useCallback(
    async ({
      transform,
      seededNodes,
      selectedNodeId,
    }: {
      transform: (document: FlowGraphDocument) => FlowGraphDocument;
      seededNodes?: SeededFlowLayoutNode[];
      selectedNodeId?: string;
    }) => {
      if (!graphTargetId?.startsWith("symbol:") || activeFlowDraft?.symbolId !== graphTargetId) {
        throw new Error("Editable flow draft state is no longer available for this symbol.");
      }

      const flowTargetId = graphTargetId;
      const currentDocument = activeFlowDraft.document;
      const nextDocument = transform(currentDocument);
      if (flowDocumentsEqual(currentDocument, nextDocument)) {
        return {
          document: currentDocument,
          result: undefined,
        };
      }
      const optimisticDocument = optimisticFlowDocument(currentDocument, nextDocument);

      await syncFlowDraftLayout(currentDocument, optimisticDocument, seededNodes);
      setFlowDraftState({
        symbolId: flowTargetId,
        baseDocument: activeFlowDraft.baseDocument,
        document: optimisticDocument,
        status: "saving",
        error: null,
      });
      if (selectedNodeId) {
        selectNode(selectedNodeId);
      }

      try {
        const result = await applyStructuralEdit(
          {
            kind: "replace_flow_graph",
            targetId: flowTargetId,
            flowGraph: optimisticDocument,
          },
          { preserveView: true },
        );

        if (
          result.flowSyncState === "clean" &&
          inspectorSourceTarget?.fetchMode === "editable" &&
          inspectorSourceTarget.targetId === flowTargetId
        ) {
          try {
            const refreshedSource = await queryClient.fetchQuery({
              queryKey: workspaceQueryKeys.editableNodeSource(
                repoSessionId,
                "editable",
                flowTargetId,
              ),
              queryFn: () => adapter.getEditableNodeSource(flowTargetId),
            });
            setInspectorEditableSourceOverride(refreshedSource);
            setInspectorSourceVersion((current) => current + 1);
            setInspectorActionError(null);
          } catch (reason) {
            setInspectorActionError(
              reason instanceof Error
                ? `Graph updated, but source refresh failed: ${reason.message}`
                : "Graph updated, but source refresh failed.",
            );
          }
        }

        setFlowDraftState((current) => {
          if (!current || current.symbolId !== flowTargetId) {
            return current;
          }

          return {
            symbolId: current.symbolId,
            baseDocument: current.baseDocument,
            document: {
              ...optimisticDocument,
              syncState: result.flowSyncState ?? optimisticDocument.syncState,
              diagnostics: [...result.diagnostics],
            },
            status: "reconcile-pending",
            error: null,
            reconcileAfterUpdatedAt: graphDataUpdatedAt,
          };
        });

        return {
          document: optimisticDocument,
          result,
        };
      } catch (reason) {
        const message =
          reason instanceof Error ? reason.message : "Unable to update the current visual flow.";
        setFlowDraftState((current) => {
          if (!current || current.symbolId !== flowTargetId) {
            return current;
          }

          return {
            ...current,
            document: optimisticDocument,
            status: "dirty",
            error: message,
          };
        });
        throw reason;
      }
    },
    [
      activeFlowDraft,
      adapter,
      applyStructuralEdit,
      graphDataUpdatedAt,
      graphTargetId,
      inspectorSourceTarget?.fetchMode,
      inspectorSourceTarget?.targetId,
      queryClient,
      repoSessionId,
      selectNode,
      setFlowDraftState,
      setInspectorActionError,
      setInspectorEditableSourceOverride,
      setInspectorSourceVersion,
      syncFlowDraftLayout,
    ],
  );

  const activeEntryNodeId = selectedFlowEntryNodeId(activeFlowDraft?.document);

  const handleAddFlowFunctionInput = useCallback(
    (draft: { name?: string; defaultExpression?: string | null }) => {
      void applyFlowDraftMutation({
        transform: (document) => addFlowFunctionInput(document, draft),
        selectedNodeId: activeEntryNodeId,
      }).catch((reason) => {
        const message = reason instanceof Error ? reason.message : "Unable to add the flow input.";
        setCreateModeError(message);
      });
    },
    [activeEntryNodeId, applyFlowDraftMutation, setCreateModeError],
  );

  const handleUpdateFlowFunctionInput = useCallback(
    (
      inputId: string,
      patch: {
        name?: string;
        defaultExpression?: string | null;
      },
    ) => {
      void applyFlowDraftMutation({
        transform: (document) => updateFlowFunctionInput(document, inputId, patch),
        selectedNodeId: activeEntryNodeId,
      }).catch((reason) => {
        const message =
          reason instanceof Error ? reason.message : "Unable to update the flow input.";
        setCreateModeError(message);
      });
    },
    [activeEntryNodeId, applyFlowDraftMutation, setCreateModeError],
  );

  const handleMoveFlowFunctionInput = useCallback(
    (inputId: string, direction: -1 | 1) => {
      void applyFlowDraftMutation({
        transform: (document) => moveFlowFunctionInput(document, inputId, direction),
        selectedNodeId: activeEntryNodeId,
      }).catch((reason) => {
        const message =
          reason instanceof Error ? reason.message : "Unable to reorder the flow input.";
        setCreateModeError(message);
      });
    },
    [activeEntryNodeId, applyFlowDraftMutation, setCreateModeError],
  );

  const confirmFlowFunctionInputRemoval = useCallback(
    (
      inputIds: string[],
      subjectLabel: "input" | "param node" = "input",
    ): Promise<string[] | undefined> => {
      if (!activeFlowDraft) {
        return Promise.resolve(undefined);
      }
      return (async () => {
        const uniqueInputIds = [...new Set(inputIds)];
        for (const inputId of uniqueInputIds) {
          const summary = flowFunctionInputRemovalSummary(activeFlowDraft.document, inputId);
          if (!summary.input) {
            continue;
          }
          const downstreamUseCount = summary.downstreamUseCount;
          const connectionCount = summary.connectionCount;
          const shouldDelete = await confirmFlowRemoval(
            `Are you sure you would like to delete ${subjectLabel} "${summary.input.name}"? It has ${downstreamUseCount} downstream use${downstreamUseCount === 1 ? "" : "s"} and ${connectionCount} connection${connectionCount === 1 ? "" : "s"}.`,
            {
              okLabel: subjectLabel === "param node" ? "Delete param" : "Delete input",
              title: subjectLabel === "param node" ? "Delete param node" : "Delete input",
            },
          );
          if (!shouldDelete) {
            return undefined;
          }
          if (!downstreamUseCount && !connectionCount) {
            continue;
          }
          const shouldRemoveDownstream = await confirmFlowRemoval(
            `Would you like to remove downstream uses and connections for "${summary.input.name}"?`,
            {
              okLabel: "Remove downstream",
              title: "Remove downstream uses",
            },
          );
          if (!shouldRemoveDownstream) {
            return undefined;
          }
        }
        return uniqueInputIds.filter((inputId) =>
          Boolean(flowFunctionInputRemovalSummary(activeFlowDraft.document, inputId).input),
        );
      })();
    },
    [activeFlowDraft],
  );

  const removeFlowFunctionInputWithConfirmation = useCallback(
    async (inputId: string) => {
      if (!activeFlowDraft) {
        return;
      }
      const inputIdsToRemove = await confirmFlowFunctionInputRemoval([inputId], "input");
      if (!inputIdsToRemove?.length) {
        return;
      }
      await applyFlowDraftMutation({
        transform: (document) => removeFlowFunctionInputsMutation(document, inputIdsToRemove),
        selectedNodeId: activeEntryNodeId,
      }).catch((reason) => {
        const message =
          reason instanceof Error ? reason.message : "Unable to remove the flow input.";
        setCreateModeError(message);
      });
    },
    [
      activeEntryNodeId,
      activeFlowDraft,
      applyFlowDraftMutation,
      confirmFlowFunctionInputRemoval,
      setCreateModeError,
    ],
  );

  const submitFlowComposerMutation = useCallback(
    async (
      payload: Extract<GraphCreateComposerSubmit, { kind: "flow" | "flow_param" }>,
      composer: Extract<GraphCreateComposerState, { kind: "flow" }>,
    ): Promise<
      | { kind: "flow_param"; createdParamNodeId?: string }
      | { kind: "flow_edit" }
      | { kind: "flow_create"; createdNodeId: string }
    > => {
      if (!graphTargetId?.startsWith("symbol:") || activeFlowDraft?.symbolId !== graphTargetId) {
        throw new Error("Editable flow draft state is no longer available for this symbol.");
      }

      if (payload.kind === "flow_param") {
        let createdParamNodeId: string | undefined;
        const seededNodes: SeededFlowLayoutNode[] = [];
        await applyFlowDraftMutation({
          transform: (document) => {
            const result = createFlowFunctionInputMutation(
              document,
              {
                name: payload.name,
                defaultExpression: payload.defaultExpression,
              },
              composer.flowPosition,
            );
            createdParamNodeId = result.createdParamNodeId;
            seededNodes.push(...result.seededNodes);
            return result.document;
          },
          seededNodes,
        });
        return {
          kind: "flow_param",
          createdParamNodeId,
        };
      }

      if (composer.mode === "edit" && composer.editingNodeId) {
        const nextPayload =
          payload.payload ?? flowNodePayloadFromContent(payload.flowNodeKind, payload.content);
        await applyFlowDraftMutation({
          transform: (document) =>
            updateAuthoredFlowNodePayload(document, composer.editingNodeId as string, nextPayload),
          selectedNodeId: composer.editingNodeId,
        });
        return { kind: "flow_edit" };
      }

      const createdNode = {
        ...createFlowNode(graphTargetId, payload.flowNodeKind),
        payload:
          payload.payload ?? flowNodePayloadFromContent(payload.flowNodeKind, payload.content),
      };
      const seededNodes: SeededFlowLayoutNode[] = [];
      await applyFlowDraftMutation({
        transform: (document) => {
          const result = createAuthoredFlowNodeMutation({
            content: payload.content,
            document,
            flowNodeKind: payload.flowNodeKind,
            node: createdNode,
            payload: payload.payload,
            position: composer.flowPosition,
            seedFlowConnection: composer.seedFlowConnection,
            starterSteps: payload.starterSteps,
            symbolId: graphTargetId,
          });
          seededNodes.push(...result.seededNodes);
          return result.document;
        },
        seededNodes,
        selectedNodeId: createdNode.id,
      });
      return {
        kind: "flow_create",
        createdNodeId: createdNode.id,
      };
    },
    [activeFlowDraft, applyFlowDraftMutation, graphTargetId],
  );

  const handleConnectFlowEdge = useCallback(
    (connectionIntent: GraphFlowConnectionIntent) => {
      if (!activeFlowDraft) {
        return;
      }

      const mutation = applyFlowConnectionMutation({
        connectionIntent,
        document: activeFlowDraft.document,
        graphNodes: effectiveGraph?.nodes,
      });
      if (mutation.status === "ignored") {
        return;
      }
      if (mutation.status === "invalid") {
        setCreateModeError(mutation.message);
        return;
      }

      void applyFlowDraftMutation({
        transform: () => mutation.document,
      }).catch((reason) => {
        const message =
          reason instanceof Error
            ? reason.message
            : mutation.connectionKind === "input-binding"
              ? "Unable to bind the selected value source."
              : "Unable to connect the selected flow nodes.";
        setCreateModeError(message);
      });
    },
    [activeFlowDraft, applyFlowDraftMutation, effectiveGraph?.nodes, setCreateModeError],
  );

  const handleReconnectFlowEdge = useCallback(
    (edgeId: string, connectionIntent: GraphFlowConnectionIntent) => {
      if (!activeFlowDraft) {
        return;
      }

      const mutation = applyFlowConnectionMutation({
        connectionIntent,
        document: activeFlowDraft.document,
        graphNodes: effectiveGraph?.nodes,
        previousEdgeId: edgeId,
      });
      if (mutation.status === "ignored") {
        return;
      }
      if (mutation.status === "invalid") {
        setCreateModeError(mutation.message);
        return;
      }

      void applyFlowDraftMutation({
        transform: () => mutation.document,
      }).catch((reason) => {
        const message =
          reason instanceof Error
            ? reason.message
            : mutation.connectionKind === "input-binding"
              ? "Unable to reconnect the selected value source."
              : "Unable to reconnect the selected flow edge.";
        setCreateModeError(message);
      });
    },
    [activeFlowDraft, applyFlowDraftMutation, effectiveGraph?.nodes, setCreateModeError],
  );

  const handleDisconnectFlowEdge = useCallback(
    (edgeId: string) => {
      if (!activeFlowDraft) {
        return;
      }
      const mutation = disconnectFlowEdgeMutation(activeFlowDraft.document, edgeId);
      if (mutation.status === "function-input") {
        void removeFlowFunctionInputWithConfirmation(mutation.functionInputId);
        return;
      }
      void applyFlowDraftMutation({
        transform: () => mutation.document,
      }).catch((reason) => {
        const message =
          reason instanceof Error
            ? reason.message
            : edgeId.startsWith("data:")
              ? "Unable to disconnect the selected value binding."
              : "Unable to disconnect the selected flow edge.";
        setCreateModeError(message);
      });
    },
    [
      activeFlowDraft,
      applyFlowDraftMutation,
      removeFlowFunctionInputWithConfirmation,
      setCreateModeError,
    ],
  );

  const handleDeleteFlowSelection = useCallback(
    (selection: GraphFlowDeleteIntent) => {
      if (!selection.nodeIds.length && !selection.edgeIds.length) {
        return;
      }
      if (!activeFlowDraft) {
        return;
      }

      void (async () => {
        const { functionInputIdsFromParamNodes, functionInputIdsToRemove } =
          functionInputIdsForFlowSelection({
            document: activeFlowDraft.document,
            graphNodes: effectiveGraph?.nodes,
            selection,
          });
        let confirmedFunctionInputIdsToRemove = functionInputIdsToRemove;
        if (functionInputIdsToRemove.length) {
          const confirmedInputIds = await confirmFlowFunctionInputRemoval(
            functionInputIdsToRemove,
            functionInputIdsFromParamNodes.length ? "param node" : "input",
          );
          if (!confirmedInputIds?.length) {
            return;
          }
          confirmedFunctionInputIdsToRemove = confirmedInputIds;
        }

        const cleared = await requestClearSelectionState();
        if (!cleared) {
          return;
        }

        try {
          await applyFlowDraftMutation({
            transform: (document) =>
              deleteFlowSelectionMutation(document, selection, confirmedFunctionInputIdsToRemove),
          });
        } catch (reason) {
          const message =
            reason instanceof Error ? reason.message : "Unable to delete the selected flow items.";
          setCreateModeError(message);
        }
      })();
    },
    [
      activeFlowDraft,
      applyFlowDraftMutation,
      confirmFlowFunctionInputRemoval,
      effectiveGraph?.nodes,
      requestClearSelectionState,
      setCreateModeError,
    ],
  );

  const ensureFlowDraftForDocument = useCallback(
    (symbolId: string, document: FlowGraphDocument) => {
      setFlowDraftState((current) =>
        current?.symbolId === symbolId
          ? current
          : {
              symbolId,
              baseDocument: document,
              document,
              status: "idle",
              error: null,
            },
      );
    },
    [setFlowDraftState],
  );

  const markActiveFlowDraftError = useCallback(
    (symbolId: string | undefined, message: string) => {
      if (!symbolId) {
        return;
      }
      setFlowDraftState((current) => {
        if (!current || current.symbolId !== symbolId) {
          return current;
        }

        return {
          ...current,
          status: "dirty",
          error: message,
        };
      });
    },
    [setFlowDraftState],
  );

  const handleReturnExpressionGraphChange = useCallback(
    (nextGraph: FlowExpressionGraph, options?: { selectedExpressionNodeId?: string }) => {
      const view = returnExpressionGraphView;
      if (!view) {
        return;
      }

      const normalizedGraph = normalizeFlowExpressionGraph(nextGraph) ?? EMPTY_EXPRESSION_GRAPH;
      const sourceResult = expressionFromFlowExpressionGraph(normalizedGraph);
      const selectedExpressionNodeId = options?.selectedExpressionNodeId;

      if (sourceResult.diagnostics.length || !sourceResult.expression.trim()) {
        setReturnExpressionGraphView({
          ...view,
          selectedExpressionNodeId,
          draftGraph: normalizedGraph,
          draftExpression: sourceResult.expression,
          diagnostics: sourceResult.diagnostics,
          isDraftOnly: true,
          error: null,
        });
        return;
      }

      setReturnExpressionGraphView({
        ...view,
        selectedExpressionNodeId,
        draftGraph: normalizedGraph,
        draftExpression: sourceResult.expression,
        diagnostics: [],
        isDraftOnly: false,
        error: null,
      });
      setIsSubmittingExpressionGraph(true);
      void (async () => {
        try {
          await applyFlowDraftMutation({
            transform: (document) =>
              updateReturnExpressionFlowDocument({
                document,
                expression: sourceResult.expression,
                expressionGraph: normalizedGraph,
                returnNodeId: view.returnNodeId,
              }),
            selectedNodeId: view.returnNodeId,
          });
          setReturnExpressionGraphView((current) =>
            current && current.returnNodeId === view.returnNodeId
              ? {
                  ...current,
                  diagnostics: [],
                  isDraftOnly: false,
                  error: null,
                }
              : current,
          );
        } catch (reason) {
          const message =
            reason instanceof Error
              ? reason.message
              : "Unable to save the return expression graph.";
          setReturnExpressionGraphView((current) =>
            current && current.returnNodeId === view.returnNodeId
              ? {
                  ...current,
                  draftGraph: normalizedGraph,
                  draftExpression: sourceResult.expression,
                  diagnostics: [],
                  isDraftOnly: true,
                  error: message,
                }
              : current,
          );
        } finally {
          setIsSubmittingExpressionGraph(false);
        }
      })();
    },
    [
      applyFlowDraftMutation,
      returnExpressionGraphView,
      setIsSubmittingExpressionGraph,
      setReturnExpressionGraphView,
    ],
  );

  return {
    activeEntryNodeId,
    applyFlowDraftMutation,
    ensureFlowDraftForDocument,
    handleAddFlowFunctionInput,
    handleConnectFlowEdge,
    handleDeleteFlowSelection,
    handleDisconnectFlowEdge,
    handleMoveFlowFunctionInput,
    handleReconnectFlowEdge,
    handleReturnExpressionGraphChange,
    handleUpdateFlowFunctionInput,
    markActiveFlowDraftError,
    removeFlowFunctionInputWithConfirmation,
    submitFlowComposerMutation,
  };
}
