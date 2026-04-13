import type {
  FlowGraphDocument,
  FlowGraphEdge,
  FlowGraphNode,
  FlowVisualNodeKind,
} from "../../lib/adapter";

export function createFlowNode(symbolId: string, kind: Exclude<FlowVisualNodeKind, "entry" | "exit">): FlowGraphNode {
  const unique =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  return {
    id: `flowdoc:${symbolId}:${kind}:${unique}`,
    kind,
    payload: defaultPayloadForKind(kind),
  };
}

export function defaultPayloadForKind(kind: Exclude<FlowVisualNodeKind, "entry" | "exit">) {
  if (kind === "assign" || kind === "call") {
    return { source: "" };
  }
  if (kind === "branch") {
    return { condition: "" };
  }
  if (kind === "loop") {
    return { header: "" };
  }
  return { expression: "" };
}

export function allowedOutputHandles(kind: FlowVisualNodeKind): string[] {
  if (kind === "entry") {
    return ["start"];
  }
  if (kind === "assign" || kind === "call") {
    return ["next"];
  }
  if (kind === "branch") {
    return ["true", "false", "after"];
  }
  if (kind === "loop") {
    return ["body", "after"];
  }
  return [];
}

export function allowedInputHandles(kind: FlowVisualNodeKind): string[] {
  if (kind === "entry") {
    return [];
  }
  return ["in"];
}

export function updateFlowNodePayload(
  document: FlowGraphDocument,
  nodeId: string,
  payload: Record<string, unknown>,
): FlowGraphDocument {
  return {
    ...document,
    nodes: document.nodes.map((node) => (
      node.id === nodeId
        ? { ...node, payload }
        : node
    )),
  };
}

export function upsertFlowConnection(
  document: FlowGraphDocument,
  connection: {
    sourceId: string;
    sourceHandle: string;
    targetId: string;
    targetHandle: string;
  },
  previousEdgeId?: string,
): FlowGraphDocument {
  const targetNode = document.nodes.find((node) => node.id === connection.targetId);
  if (!targetNode) {
    return document;
  }

  const filtered = document.edges.filter((edge) => (
    edge.id !== previousEdgeId
    && !(edge.sourceId === connection.sourceId && edge.sourceHandle === connection.sourceHandle)
    && !(
      edge.targetId === connection.targetId
      && edge.targetHandle === connection.targetHandle
      && targetNode.kind !== "exit"
    )
  ));

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

export function removeFlowNodes(
  document: FlowGraphDocument,
  nodeIds: Iterable<string>,
): FlowGraphDocument {
  const requestedNodeIds = [...nodeIds];
  const blocked = new Set<string>();
  const removable = new Set<string>();
  const protectedKinds = new Set<FlowVisualNodeKind>(["entry", "exit"]);
  const nodeById = new Map(document.nodes.map((node) => [node.id, node] as const));
  requestedNodeIds.forEach((nodeId) => {
    const kind = nodeById.get(nodeId)?.kind;
    if (kind && protectedKinds.has(kind)) {
      blocked.add(nodeId);
      return;
    }
    removable.add(nodeId);
  });
  if (!removable.size || blocked.size === requestedNodeIds.length) {
    return document;
  }

  return {
    ...document,
    nodes: document.nodes.filter((node) => !removable.has(node.id)),
    edges: document.edges.filter((edge) => !removable.has(edge.sourceId) && !removable.has(edge.targetId)),
  };
}

export function flowConnectionId(connection: {
  sourceId: string;
  sourceHandle: string;
  targetId: string;
  targetHandle: string;
}) {
  return `controls:${connection.sourceId}:${connection.sourceHandle}->${connection.targetId}:${connection.targetHandle}`;
}
