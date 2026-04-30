import type {
  GraphFlowConnectionIntent,
  GraphFlowDeleteIntent,
} from "../../components/graph/GraphCanvas";
import {
  functionInputParamNodeId,
  parseFunctionInputSourceHandle,
  parseInputSlotTargetHandle,
  parseParameterEntryEdgeInputId,
  parseValueSourceHandle,
} from "../../components/graph/flowDraftGraph";
import {
  addDisconnectedFlowNode,
  addFlowFunctionInput,
  createFlowNode,
  flowDocumentHandleFromBlueprintHandle,
  flowNodePayloadFromContent,
  insertFlowNodeOnEdge,
  parseReturnInputTargetHandle,
  removeFlowEdges,
  removeFlowFunctionInputAndDownstreamUses,
  removeFlowInputBindings,
  removeFlowNodes,
  updateFlowNodePayload,
  upsertFlowConnection,
  upsertFlowInputBinding,
  upsertFlowReturnInputBinding,
  validateFlowConnection,
  validateFlowInputBindingConnection,
  validateFlowReturnInputBindingConnection,
  type AuthoredFlowNode,
  type AuthoredFlowNodeKind,
} from "../../components/graph/flowDocument";
import type {
  FlowExpressionGraph,
  FlowGraphDocument,
  GraphNodeDto,
  GraphNodeKind,
} from "../../lib/adapter";
import type { GraphCreateComposerFlowSeed } from "../../components/workspace/GraphCreateComposer";
import type { ResolvedFlowInputBindingConnection } from "./types";
import { flowFunctionInputIdForParamNode } from "./workspaceScreenModel";

export type SeededFlowLayoutNode = {
  nodeId: string;
  kind: GraphNodeKind;
  position: { x: number; y: number };
};

export type FlowConnectionMutationResult =
  | { status: "ignored" }
  | { status: "invalid"; message: string }
  | { status: "changed"; connectionKind: "control" | "input-binding"; document: FlowGraphDocument };

export function optimisticFlowDocument(
  currentDocument: FlowGraphDocument,
  nextDocument: FlowGraphDocument,
): FlowGraphDocument {
  return {
    ...nextDocument,
    syncState: currentDocument.syncState,
    diagnostics: [...currentDocument.diagnostics],
    sourceHash: nextDocument.sourceHash ?? currentDocument.sourceHash ?? null,
    editable: currentDocument.editable,
  };
}

export function selectedFlowEntryNodeId(document: FlowGraphDocument | undefined) {
  return document?.nodes.find((node) => node.kind === "entry")?.id;
}

export function createFlowFunctionInputMutation(
  document: FlowGraphDocument,
  draft: { name?: string; defaultExpression?: string | null },
  position: { x: number; y: number },
): {
  document: FlowGraphDocument;
  createdParamNodeId?: string;
  seededNodes: SeededFlowLayoutNode[];
} {
  const previousInputIds = new Set((document.functionInputs ?? []).map((input) => input.id));
  const nextDocument = addFlowFunctionInput(document, draft);
  const createdInput = (nextDocument.functionInputs ?? []).find(
    (input) => !previousInputIds.has(input.id),
  );
  if (!createdInput) {
    return {
      document: nextDocument,
      seededNodes: [],
    };
  }

  const createdParamNodeId = functionInputParamNodeId(nextDocument.symbolId, createdInput);
  return {
    document: nextDocument,
    createdParamNodeId,
    seededNodes: [
      {
        nodeId: createdParamNodeId,
        kind: "param",
        position,
      },
    ],
  };
}

export function createAuthoredFlowNodeMutation({
  content,
  createNode = createFlowNode,
  document,
  flowNodeKind,
  node,
  payload,
  position,
  seedFlowConnection,
  starterSteps = [],
  symbolId,
}: {
  content: string;
  createNode?: (symbolId: string, kind: AuthoredFlowNodeKind) => AuthoredFlowNode;
  document: FlowGraphDocument;
  flowNodeKind: AuthoredFlowNodeKind;
  node?: AuthoredFlowNode;
  payload?: Record<string, unknown>;
  position: { x: number; y: number };
  seedFlowConnection?: GraphCreateComposerFlowSeed;
  starterSteps?: Array<{
    sourceHandle: "body" | "after";
    flowNodeKind: AuthoredFlowNodeKind;
    payload: Record<string, unknown>;
  }>;
  symbolId: string;
}): {
  document: FlowGraphDocument;
  createdNodeId: string;
  seededNodes: SeededFlowLayoutNode[];
} {
  const nextNode =
    node ??
    ({
      ...createNode(symbolId, flowNodeKind),
      payload: payload ?? flowNodePayloadFromContent(flowNodeKind, content),
    } satisfies AuthoredFlowNode);
  const seededNodes: SeededFlowLayoutNode[] = [
    {
      nodeId: nextNode.id,
      kind: nextNode.kind,
      position,
    },
  ];

  let nextDocument = addDisconnectedFlowNode(document, nextNode);
  if (seedFlowConnection) {
    const existingEdge = document.edges.find(
      (edge) =>
        edge.sourceId === seedFlowConnection.sourceNodeId &&
        edge.sourceHandle === seedFlowConnection.sourceHandle,
    );
    nextDocument = existingEdge
      ? insertFlowNodeOnEdge(document, nextNode, existingEdge.id)
      : upsertFlowConnection(nextDocument, {
          sourceId: seedFlowConnection.sourceNodeId,
          sourceHandle: seedFlowConnection.sourceHandle,
          targetId: nextNode.id,
          targetHandle: "in",
        });
  }

  starterSteps.forEach((starterStep, index) => {
    const starterNode = {
      ...createNode(symbolId, starterStep.flowNodeKind),
      payload: starterStep.payload,
    };
    const starterPosition = {
      x: position.x + 280,
      y: position.y + (starterStep.sourceHandle === "body" ? -150 : 150) + index * 32,
    };
    seededNodes.push({
      nodeId: starterNode.id,
      kind: starterNode.kind,
      position: starterPosition,
    });
    nextDocument = upsertFlowConnection(addDisconnectedFlowNode(nextDocument, starterNode), {
      sourceId: nextNode.id,
      sourceHandle: starterStep.sourceHandle,
      targetId: starterNode.id,
      targetHandle: "in",
    });
  });

  return {
    document: nextDocument,
    createdNodeId: nextNode.id,
    seededNodes,
  };
}

export function updateAuthoredFlowNodePayload(
  document: FlowGraphDocument,
  nodeId: string,
  payload: Record<string, unknown>,
) {
  return updateFlowNodePayload(document, nodeId, payload);
}

export function resolveFlowDocumentConnection(
  document: FlowGraphDocument,
  connection: GraphFlowConnectionIntent,
) {
  const sourceHandle = flowDocumentHandleFromBlueprintHandle(connection.sourceHandle, "source");
  const targetHandle = flowDocumentHandleFromBlueprintHandle(connection.targetHandle, "target");
  if (!sourceHandle || !targetHandle) {
    return undefined;
  }

  const liveNodeIds = new Set(document.nodes.map((node) => node.id));
  if (!liveNodeIds.has(connection.sourceId) || !liveNodeIds.has(connection.targetId)) {
    return undefined;
  }

  return {
    sourceId: connection.sourceId,
    sourceHandle,
    targetId: connection.targetId,
    targetHandle,
  };
}

export function resolveFlowInputBindingConnection(
  document: FlowGraphDocument,
  graphNodes: GraphNodeDto[] | undefined,
  connection: GraphFlowConnectionIntent,
): ResolvedFlowInputBindingConnection | undefined {
  const sourceId =
    parseFunctionInputSourceHandle(connection.sourceHandle) ??
    parseValueSourceHandle(connection.sourceHandle) ??
    (() => {
      const sourceNode = graphNodes?.find((node) => node.id === connection.sourceId);
      const value =
        sourceNode?.metadata.source_id ??
        sourceNode?.metadata.sourceId ??
        sourceNode?.metadata.value_source_id ??
        sourceNode?.metadata.valueSourceId ??
        sourceNode?.metadata.function_input_id ??
        sourceNode?.metadata.functionInputId;
      return typeof value === "string" ? value : undefined;
    })();
  const slotId = parseInputSlotTargetHandle(connection.targetHandle);
  if (!sourceId) {
    return undefined;
  }
  if (slotId) {
    return {
      kind: "slot",
      sourceId,
      slotId,
    };
  }
  const targetNodeId = parseReturnInputTargetHandle(connection.targetHandle);
  if (
    targetNodeId &&
    document.nodes.some((node) => node.id === targetNodeId && node.kind === "return")
  ) {
    return {
      kind: "return-input",
      sourceId,
      targetNodeId,
    };
  }
  return undefined;
}

export function applyFlowConnectionMutation({
  connectionIntent,
  document,
  graphNodes,
  previousEdgeId,
}: {
  connectionIntent: GraphFlowConnectionIntent;
  document: FlowGraphDocument;
  graphNodes: GraphNodeDto[] | undefined;
  previousEdgeId?: string;
}): FlowConnectionMutationResult {
  const inputBindingConnection = resolveFlowInputBindingConnection(
    document,
    graphNodes,
    connectionIntent,
  );
  if (inputBindingConnection) {
    const validation =
      inputBindingConnection.kind === "return-input"
        ? validateFlowReturnInputBindingConnection(document, inputBindingConnection)
        : validateFlowInputBindingConnection(document, inputBindingConnection);
    if (!validation.ok) {
      return { status: "invalid", message: validation.message };
    }
    const previousBindingId = previousEdgeId?.startsWith("data:")
      ? previousEdgeId.slice("data:".length)
      : undefined;
    return {
      connectionKind: "input-binding",
      status: "changed",
      document:
        inputBindingConnection.kind === "return-input"
          ? upsertFlowReturnInputBinding(document, inputBindingConnection, previousBindingId)
          : upsertFlowInputBinding(document, inputBindingConnection, previousBindingId),
    };
  }

  const connection = resolveFlowDocumentConnection(document, connectionIntent);
  if (!connection) {
    return { status: "ignored" };
  }

  const validation = validateFlowConnection(document, connection, previousEdgeId);
  if (!validation.ok) {
    return { status: "invalid", message: validation.message };
  }

  return {
    connectionKind: "control",
    status: "changed",
    document: upsertFlowConnection(document, connection, previousEdgeId),
  };
}

export function flowFunctionInputIdFromParameterEdge(edgeId: string): string | undefined {
  return parseParameterEntryEdgeInputId(edgeId);
}

export function disconnectFlowEdgeMutation(
  document: FlowGraphDocument,
  edgeId: string,
):
  | { status: "function-input"; functionInputId: string }
  | { status: "changed"; document: FlowGraphDocument } {
  const functionInputId = parseParameterEntryEdgeInputId(edgeId);
  if (functionInputId) {
    return { status: "function-input", functionInputId };
  }
  if (edgeId.startsWith("data:")) {
    return {
      status: "changed",
      document: removeFlowInputBindings(document, [edgeId.slice("data:".length)]),
    };
  }
  return {
    status: "changed",
    document: removeFlowEdges(document, [edgeId]),
  };
}

export function functionInputIdsForFlowSelection({
  document,
  graphNodes,
  selection,
}: {
  document: FlowGraphDocument;
  graphNodes: GraphNodeDto[] | undefined;
  selection: GraphFlowDeleteIntent;
}) {
  const selectedNodeById = new Map((graphNodes ?? []).map((node) => [node.id, node] as const));
  const functionInputIdsFromParamNodes = selection.nodeIds.flatMap((nodeId) => {
    const functionInputId = flowFunctionInputIdForParamNode(selectedNodeById.get(nodeId), document);
    return functionInputId ? [functionInputId] : [];
  });
  const functionInputIdsFromEdges = selection.edgeIds.flatMap((edgeId) => {
    const functionInputId = parseParameterEntryEdgeInputId(edgeId);
    return functionInputId ? [functionInputId] : [];
  });
  return {
    functionInputIdsFromParamNodes,
    functionInputIdsToRemove: [
      ...new Set([...functionInputIdsFromParamNodes, ...functionInputIdsFromEdges]),
    ],
  };
}

export function deleteFlowSelectionMutation(
  document: FlowGraphDocument,
  selection: GraphFlowDeleteIntent,
  confirmedFunctionInputIdsToRemove: string[],
) {
  let nextDocument = document;
  if (selection.nodeIds.length) {
    nextDocument = removeFlowNodes(nextDocument, selection.nodeIds);
  }
  if (selection.edgeIds.length) {
    const dataBindingIds = selection.edgeIds
      .filter((edgeId) => edgeId.startsWith("data:") && !parseParameterEntryEdgeInputId(edgeId))
      .map((edgeId) => edgeId.slice("data:".length));
    const controlEdgeIds = selection.edgeIds.filter((edgeId) => !edgeId.startsWith("data:"));
    nextDocument = removeFlowInputBindings(nextDocument, dataBindingIds);
    nextDocument = removeFlowEdges(nextDocument, controlEdgeIds);
  }
  confirmedFunctionInputIdsToRemove.forEach((functionInputId) => {
    nextDocument = removeFlowFunctionInputAndDownstreamUses(nextDocument, functionInputId);
  });
  return nextDocument;
}

export function removeFlowFunctionInputsMutation(
  document: FlowGraphDocument,
  inputIdsToRemove: string[],
) {
  return inputIdsToRemove.reduce(
    (nextDocument, nextInputId) =>
      removeFlowFunctionInputAndDownstreamUses(nextDocument, nextInputId),
    document,
  );
}

export function updateReturnExpressionFlowDocument({
  document,
  expression,
  expressionGraph,
  returnNodeId,
}: {
  document: FlowGraphDocument;
  expression: string;
  expressionGraph: FlowExpressionGraph;
  returnNodeId: string;
}) {
  const targetNode = document.nodes.find(
    (node) => node.id === returnNodeId && node.kind === "return",
  );
  if (!targetNode) {
    throw new Error("Return node is no longer available in this flow draft.");
  }
  return updateFlowNodePayload(document, returnNodeId, {
    ...targetNode.payload,
    expression,
    expression_graph: expressionGraph,
  });
}
