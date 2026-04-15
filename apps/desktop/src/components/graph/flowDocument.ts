import type {
  FlowGraphDocument,
  FlowGraphEdge,
  FlowGraphNode,
  FlowVisualNodeKind,
} from "../../lib/adapter";

export type AuthoredFlowNodeKind = Exclude<FlowVisualNodeKind, "entry" | "exit">;
export type AuthoredFlowNode = FlowGraphNode & { kind: AuthoredFlowNodeKind };

export function isAuthoredFlowNodeKind(kind: FlowVisualNodeKind | string): kind is AuthoredFlowNodeKind {
  return kind === "assign"
    || kind === "call"
    || kind === "return"
    || kind === "branch"
    || kind === "loop";
}

export function createFlowNode(symbolId: string, kind: AuthoredFlowNodeKind): AuthoredFlowNode {
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

export function defaultPayloadForKind(kind: AuthoredFlowNodeKind) {
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

export function flowNodePayloadFromContent(
  kind: AuthoredFlowNodeKind,
  content: string,
): Record<string, unknown> {
  const normalized = content.trim();
  if (kind === "assign" || kind === "call") {
    return { source: normalized };
  }
  if (kind === "branch") {
    return { condition: normalized.replace(/^if\s+/i, "").replace(/:$/, "") };
  }
  if (kind === "loop") {
    return { header: normalized.replace(/:$/, "") };
  }
  return { expression: normalized.replace(/^return\s+/i, "") };
}

export function flowNodeContentFromPayload(
  kind: AuthoredFlowNodeKind,
  payload: Record<string, unknown>,
): string {
  if (kind === "assign" || kind === "call") {
    return typeof payload.source === "string" ? payload.source : "";
  }
  if (kind === "branch") {
    const condition = typeof payload.condition === "string" ? payload.condition : "";
    return condition ? `if ${condition}` : "";
  }
  if (kind === "loop") {
    return typeof payload.header === "string" ? payload.header : "";
  }
  const expression = typeof payload.expression === "string" ? payload.expression : "";
  return expression ? `return ${expression}` : "return";
}

export function flowDocumentHandleFromBlueprintHandle(
  handleId: string | null | undefined,
  direction: "source" | "target",
): string | undefined {
  if (!handleId) {
    return undefined;
  }

  if (direction === "target") {
    return handleId === "in:control:exec" ? "in" : undefined;
  }

  return handleId.startsWith("out:control:")
    ? handleId.slice("out:control:".length)
    : undefined;
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

export function cloneFlowDocument(document: FlowGraphDocument): FlowGraphDocument {
  return {
    ...document,
    diagnostics: [...document.diagnostics],
    nodes: document.nodes.map((node) => ({
      ...node,
      payload: { ...node.payload },
    })),
    edges: document.edges.map((edge) => ({ ...edge })),
  };
}

export function addDisconnectedFlowNode(
  document: FlowGraphDocument,
  node: FlowGraphNode,
): FlowGraphDocument {
  if (document.nodes.some((candidate) => candidate.id === node.id)) {
    return document;
  }

  return {
    ...document,
    nodes: [...document.nodes, node],
  };
}

export function insertFlowNodeOnEdge(
  document: FlowGraphDocument,
  node: AuthoredFlowNode,
  anchorEdgeId: string,
): FlowGraphDocument {
  const anchorEdge = document.edges.find((edge) => edge.id === anchorEdgeId);
  const seeded = addDisconnectedFlowNode(document, node);
  if (!anchorEdge) {
    return seeded;
  }

  return {
    ...seeded,
    edges: seeded.edges.flatMap((edge) => {
      if (edge.id !== anchorEdgeId) {
        return [edge];
      }

      return [
        {
          id: flowConnectionId({
            sourceId: edge.sourceId,
            sourceHandle: edge.sourceHandle,
            targetId: node.id,
            targetHandle: "in",
          }),
          sourceId: edge.sourceId,
          sourceHandle: edge.sourceHandle,
          targetId: node.id,
          targetHandle: "in",
        },
        {
          id: flowConnectionId({
            sourceId: node.id,
            sourceHandle: defaultFlowContinuationHandle(node.kind),
            targetId: edge.targetId,
            targetHandle: edge.targetHandle,
          }),
          sourceId: node.id,
          sourceHandle: defaultFlowContinuationHandle(node.kind),
          targetId: edge.targetId,
          targetHandle: edge.targetHandle,
        },
      ];
    }),
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

export function flowDocumentsEqual(
  left: FlowGraphDocument | undefined,
  right: FlowGraphDocument | undefined,
) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function defaultFlowContinuationHandle(kind: AuthoredFlowNodeKind) {
  if (kind === "branch") {
    return "after";
  }
  if (kind === "loop") {
    return "after";
  }
  return "next";
}
