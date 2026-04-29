import type { FlowGraphDocument, FlowGraphEdge } from "../../../lib/adapter";
import { flowConnectionId } from "./ids";
import { allowedInputHandles, allowedOutputHandles } from "./nodes";

export type FlowConnection = {
  sourceId: string;
  sourceHandle: string;
  targetId: string;
  targetHandle: string;
};

export function validateFlowConnection(
  document: FlowGraphDocument,
  connection: FlowConnection,
  previousEdgeId?: string,
): { ok: true } | { ok: false; message: string } {
  const sourceNode = document.nodes.find((node) => node.id === connection.sourceId);
  if (!sourceNode) {
    return { ok: false, message: "Unable to find the source flow node." };
  }

  const targetNode = document.nodes.find((node) => node.id === connection.targetId);
  if (!targetNode) {
    return { ok: false, message: "Unable to find the target flow node." };
  }

  if (connection.sourceId === connection.targetId) {
    return { ok: false, message: "Flow nodes cannot connect back into themselves." };
  }

  if (!allowedOutputHandles(sourceNode.kind).includes(connection.sourceHandle)) {
    return {
      ok: false,
      message: "That control output is not available for the selected source node.",
    };
  }

  if (!allowedInputHandles(targetNode.kind).includes(connection.targetHandle)) {
    return {
      ok: false,
      message: "That control input is not available for the selected target node.",
    };
  }

  const competingEdges = document.edges.filter((edge) => edge.id !== previousEdgeId);
  if (
    competingEdges.some(
      (edge) =>
        edge.sourceId === connection.sourceId &&
        edge.sourceHandle === connection.sourceHandle &&
        edge.targetId === connection.targetId &&
        edge.targetHandle === connection.targetHandle,
    )
  ) {
    return { ok: false, message: "That flow connection already exists." };
  }

  if (
    competingEdges.some(
      (edge) =>
        edge.sourceId === connection.sourceId && edge.sourceHandle === connection.sourceHandle,
    )
  ) {
    return { ok: false, message: "That control output is already connected." };
  }

  return { ok: true };
}

export function upsertFlowConnection(
  document: FlowGraphDocument,
  connection: FlowConnection,
  previousEdgeId?: string,
): FlowGraphDocument {
  const validation = validateFlowConnection(document, connection, previousEdgeId);
  if (!validation.ok) {
    return document;
  }

  const filtered = document.edges.filter((edge) => edge.id !== previousEdgeId);

  const nextEdge: FlowGraphEdge = {
    id: flowConnectionId(connection),
    sourceId: connection.sourceId,
    sourceHandle: connection.sourceHandle,
    targetId: connection.targetId,
    targetHandle: connection.targetHandle,
  };

  return {
    ...document,
    edges: [...filtered, nextEdge],
  };
}

export function removeFlowEdges(
  document: FlowGraphDocument,
  edgeIds: Iterable<string>,
): FlowGraphDocument {
  const toRemove = new Set(edgeIds);
  return {
    ...document,
    edges: document.edges.filter((edge) => !toRemove.has(edge.id)),
  };
}
