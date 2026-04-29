import type { FlowGraphDocument, FlowGraphEdge, FlowGraphNode } from "../../../lib/adapter";

export function flowConnectionId(connection: {
  sourceId: string;
  sourceHandle: string;
  targetId: string;
  targetHandle: string;
}) {
  return `controls:${connection.sourceId}:${connection.sourceHandle}->${connection.targetId}:${connection.targetHandle}`;
}

export function flowReturnCompletionEdgeId(returnNodeId: string, exitNodeId: string) {
  return flowConnectionId({
    sourceId: returnNodeId,
    sourceHandle: "exit",
    targetId: exitNodeId,
    targetHandle: "in",
  });
}

export function withoutFlowReturnCompletionEdges(document: FlowGraphDocument): FlowGraphDocument {
  const nodeById = new Map(document.nodes.map((node) => [node.id, node] as const));
  const edges = document.edges.filter((edge) => {
    const sourceNode = nodeById.get(edge.sourceId);
    const targetNode = nodeById.get(edge.targetId);
    return !(
      sourceNode?.kind === "return" &&
      targetNode?.kind === "exit" &&
      edge.sourceHandle === "exit" &&
      edge.targetHandle === "in" &&
      edge.id === flowReturnCompletionEdgeId(edge.sourceId, edge.targetId)
    );
  });
  return edges.length === document.edges.length ? document : { ...document, edges };
}

export function flowInputBindingId(slotId: string, sourceId: string) {
  return `flowbinding:${slotId}->${sourceId}`;
}

export function flowInputSlotId(nodeSourceIdentity: string, slotKey: string) {
  return `flowslot:${nodeSourceIdentity}:${slotKey}`;
}

export function flowGraphNodeSourceIdentity(node: FlowGraphNode): string {
  return node.indexedNodeId || node.id;
}

export function flowGraphNodeIdentityCandidates(node: FlowGraphNode): string[] {
  return [...new Set([flowGraphNodeSourceIdentity(node), node.id])];
}

export function flowEdgeKey(edge: FlowGraphEdge): string {
  return `${edge.sourceId}\u0000${edge.sourceHandle}\u0000${edge.targetId}\u0000${edge.targetHandle}`;
}
