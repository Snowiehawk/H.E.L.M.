import type {
  FlowGraphDocument,
  FlowGraphEdge,
  FlowGraphNode,
  FlowInputBinding,
  FlowVisualNodeKind,
} from "../../lib/adapter";

export const FLOW_DOCUMENT_NODE_KINDS = [
  "entry",
  "assign",
  "call",
  "branch",
  "loop",
  "return",
  "exit",
] as const satisfies readonly FlowVisualNodeKind[];

export const FLOW_AUTHORABLE_NODE_KINDS = [
  "assign",
  "call",
  "return",
  "branch",
  "loop",
] as const;

const FLOW_DOCUMENT_NODE_KIND_SET = new Set<string>(FLOW_DOCUMENT_NODE_KINDS);
const FLOW_AUTHORABLE_NODE_KIND_SET = new Set<string>(FLOW_AUTHORABLE_NODE_KINDS);

export type AuthoredFlowNodeKind = typeof FLOW_AUTHORABLE_NODE_KINDS[number];
export type AuthoredFlowNode = FlowGraphNode & { kind: AuthoredFlowNodeKind };

export function isFlowNodeStructuralKind(kind: FlowVisualNodeKind | string): kind is "entry" | "exit" {
  return kind === "entry" || kind === "exit";
}

export function isFlowDocumentNodeKind(kind: FlowVisualNodeKind | string): kind is FlowVisualNodeKind {
  return FLOW_DOCUMENT_NODE_KIND_SET.has(kind);
}

export function isFlowNodeAuthorableKind(kind: FlowVisualNodeKind | string): kind is AuthoredFlowNodeKind {
  return FLOW_AUTHORABLE_NODE_KIND_SET.has(kind);
}

export function isAuthoredFlowNodeKind(kind: FlowVisualNodeKind | string): kind is AuthoredFlowNodeKind {
  return isFlowNodeAuthorableKind(kind);
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
    indexedNodeId: null,
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
      indexedNodeId: node.indexedNodeId ?? null,
    })),
    edges: document.edges.map((edge) => ({ ...edge })),
    functionInputs: (document.functionInputs ?? []).map((input) => ({ ...input })),
    inputSlots: (document.inputSlots ?? []).map((slot) => ({ ...slot })),
    inputBindings: (document.inputBindings ?? []).map((binding) => ({ ...binding })),
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

type FlowConnection = {
  sourceId: string;
  sourceHandle: string;
  targetId: string;
  targetHandle: string;
};

type FlowInputBindingConnection = {
  functionInputId: string;
  slotId: string;
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
    return { ok: false, message: "That control output is not available for the selected source node." };
  }

  if (!allowedInputHandles(targetNode.kind).includes(connection.targetHandle)) {
    return { ok: false, message: "That control input is not available for the selected target node." };
  }

  const competingEdges = document.edges.filter((edge) => edge.id !== previousEdgeId);
  if (competingEdges.some((edge) => (
    edge.sourceId === connection.sourceId
    && edge.sourceHandle === connection.sourceHandle
    && edge.targetId === connection.targetId
    && edge.targetHandle === connection.targetHandle
  ))) {
    return { ok: false, message: "That flow connection already exists." };
  }

  if (competingEdges.some((edge) => (
    edge.sourceId === connection.sourceId
    && edge.sourceHandle === connection.sourceHandle
  ))) {
    return { ok: false, message: "That control output is already connected." };
  }

  if (
    targetNode.kind !== "exit"
    && competingEdges.some((edge) => (
      edge.targetId === connection.targetId
      && edge.targetHandle === connection.targetHandle
    ))
  ) {
    return { ok: false, message: "That control input is already connected." };
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

export function validateFlowInputBindingConnection(
  document: FlowGraphDocument,
  connection: FlowInputBindingConnection,
): { ok: true } | { ok: false; message: string } {
  if (!(document.functionInputs ?? []).some((input) => input.id === connection.functionInputId)) {
    return { ok: false, message: "Unable to find the selected function input." };
  }
  if (!(document.inputSlots ?? []).some((slot) => slot.id === connection.slotId)) {
    return { ok: false, message: "Unable to find the selected input slot." };
  }
  return { ok: true };
}

export function upsertFlowInputBinding(
  document: FlowGraphDocument,
  connection: FlowInputBindingConnection,
  previousBindingId?: string,
): FlowGraphDocument {
  const validation = validateFlowInputBindingConnection(document, connection);
  if (!validation.ok) {
    return document;
  }

  const binding: FlowInputBinding = {
    id: flowInputBindingId(connection.slotId, connection.functionInputId),
    functionInputId: connection.functionInputId,
    slotId: connection.slotId,
  };
  return {
    ...document,
    inputBindings: [
      ...(document.inputBindings ?? []).filter((candidate) => (
        candidate.id !== previousBindingId
        && candidate.slotId !== connection.slotId
      )),
      binding,
    ],
  };
}

export function removeFlowInputBindings(
  document: FlowGraphDocument,
  bindingIds: Iterable<string>,
): FlowGraphDocument {
  const toRemove = new Set(bindingIds);
  if (!toRemove.size) {
    return document;
  }
  return {
    ...document,
    inputBindings: (document.inputBindings ?? []).filter((binding) => !toRemove.has(binding.id)),
  };
}

export function removeFlowNodes(
  document: FlowGraphDocument,
  nodeIds: Iterable<string>,
): FlowGraphDocument {
  const requestedNodeIds = [...nodeIds];
  const blocked = new Set<string>();
  const removable = new Set<string>();
  const nodeById = new Map(document.nodes.map((node) => [node.id, node] as const));
  requestedNodeIds.forEach((nodeId) => {
    const kind = nodeById.get(nodeId)?.kind;
    if (!kind || !isFlowNodeAuthorableKind(kind)) {
      blocked.add(nodeId);
      return;
    }
    removable.add(nodeId);
  });
  if (!removable.size || blocked.size === requestedNodeIds.length) {
    return document;
  }

  const removedSlotIds = new Set(
    (document.inputSlots ?? [])
      .filter((slot) => removable.has(slot.nodeId))
      .map((slot) => slot.id),
  );

  return {
    ...document,
    nodes: document.nodes.filter((node) => !removable.has(node.id)),
    edges: document.edges.filter((edge) => !removable.has(edge.sourceId) && !removable.has(edge.targetId)),
    inputSlots: (document.inputSlots ?? []).filter((slot) => !removable.has(slot.nodeId)),
    inputBindings: (document.inputBindings ?? []).filter((binding) => !removedSlotIds.has(binding.slotId)),
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

export function flowInputBindingId(slotId: string, functionInputId: string) {
  return `flowbinding:${slotId}->${functionInputId}`;
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
