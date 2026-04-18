import type {
  FlowExpressionGraph,
  FlowExpressionNode,
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
    valueModelVersion: document.valueModelVersion ?? null,
    functionInputs: (document.functionInputs ?? []).map((input) => ({ ...input })),
    valueSources: (document.valueSources ?? []).map((source) => ({ ...source })),
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

      const incomingEdge = {
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
      };
      if (node.kind === "return") {
        return [incomingEdge];
      }

      const continuationHandle = defaultFlowContinuationHandle(node.kind);
      return [
        incomingEdge,
        {
          id: flowConnectionId({
            sourceId: node.id,
            sourceHandle: continuationHandle,
            targetId: edge.targetId,
            targetHandle: edge.targetHandle,
          }),
          sourceId: node.id,
          sourceHandle: continuationHandle,
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
  sourceId: string;
  slotId: string;
};

type FlowReturnInputBindingConnection = {
  sourceId: string;
  targetNodeId: string;
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
  const sourceExists = (document.functionInputs ?? []).some((input) => input.id === connection.sourceId)
    || (document.valueSources ?? []).some((source) => source.id === connection.sourceId);
  if (!sourceExists) {
    return { ok: false, message: "Unable to find the selected value source." };
  }
  if (!(document.inputSlots ?? []).some((slot) => slot.id === connection.slotId)) {
    return { ok: false, message: "Unable to find the selected input slot." };
  }
  return { ok: true };
}

export function validateFlowReturnInputBindingConnection(
  document: FlowGraphDocument,
  connection: FlowReturnInputBindingConnection,
): { ok: true } | { ok: false; message: string } {
  const sourceExists = (document.functionInputs ?? []).some((input) => input.id === connection.sourceId)
    || (document.valueSources ?? []).some((source) => source.id === connection.sourceId);
  if (!sourceExists) {
    return { ok: false, message: "Unable to find the selected value source." };
  }
  const target = document.nodes.find((node) => node.id === connection.targetNodeId);
  if (!target || target.kind !== "return") {
    return { ok: false, message: "The generic value input is only available on return nodes." };
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

  const functionInput = (document.functionInputs ?? []).find((input) => input.id === connection.sourceId);
  const binding: FlowInputBinding = {
    id: flowInputBindingId(connection.slotId, connection.sourceId),
    sourceId: connection.sourceId,
    ...(functionInput ? { functionInputId: functionInput.id } : {}),
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

export function upsertFlowReturnInputBinding(
  document: FlowGraphDocument,
  connection: FlowReturnInputBindingConnection,
  previousBindingId?: string,
): FlowGraphDocument {
  const validation = validateFlowReturnInputBindingConnection(document, connection);
  if (!validation.ok) {
    return document;
  }

  const targetNode = document.nodes.find((node) => node.id === connection.targetNodeId);
  const sourceLabel = flowSourceLabel(document, connection.sourceId);
  if (!targetNode || !sourceLabel) {
    return document;
  }

  const existingSlot = (document.inputSlots ?? []).find((slot) => (
    slot.nodeId === targetNode.id
    && slot.slotKey === sourceLabel
  ));
  const slot = existingSlot ?? {
    id: flowInputSlotId(flowGraphNodeSourceIdentity(targetNode), sourceLabel),
    nodeId: targetNode.id,
    slotKey: sourceLabel,
    label: sourceLabel,
    required: true,
  };
  const documentWithSlot = existingSlot
    ? document
    : {
        ...document,
        inputSlots: [...(document.inputSlots ?? []), slot],
      };
  const documentWithExpressionInput = {
    ...documentWithSlot,
    nodes: documentWithSlot.nodes.map((node) => (
      node.id === targetNode.id
        ? {
            ...node,
            payload: withReturnExpressionInputNode(node.payload, slot.id, sourceLabel),
          }
        : node
    )),
  };
  return upsertFlowInputBinding(
    documentWithExpressionInput,
    {
      sourceId: connection.sourceId,
      slotId: slot.id,
    },
    previousBindingId,
  );
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
  const removedSourceIds = new Set(
    (document.valueSources ?? [])
      .filter((source) => removable.has(source.nodeId))
      .map((source) => source.id),
  );

  return {
    ...document,
    nodes: document.nodes.filter((node) => !removable.has(node.id)),
    edges: document.edges.filter((edge) => !removable.has(edge.sourceId) && !removable.has(edge.targetId)),
    valueSources: (document.valueSources ?? []).filter((source) => !removable.has(source.nodeId)),
    inputSlots: (document.inputSlots ?? []).filter((slot) => !removable.has(slot.nodeId)),
    inputBindings: (document.inputBindings ?? []).filter((binding) => (
      !removedSlotIds.has(binding.slotId)
      && !removedSourceIds.has(binding.sourceId)
    )),
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
      sourceNode?.kind === "return"
      && targetNode?.kind === "exit"
      && edge.sourceHandle === "exit"
      && edge.targetHandle === "in"
      && edge.id === flowReturnCompletionEdgeId(edge.sourceId, edge.targetId)
    );
  });
  return edges.length === document.edges.length ? document : { ...document, edges };
}

export function flowInputBindingId(slotId: string, sourceId: string) {
  return `flowbinding:${slotId}->${sourceId}`;
}

function flowInputSlotId(nodeSourceIdentity: string, slotKey: string) {
  return `flowslot:${nodeSourceIdentity}:${slotKey}`;
}

export function returnInputTargetHandle(nodeId: string): string {
  return `in:data:return-input:${nodeId}`;
}

export function parseReturnInputTargetHandle(handleId: string | null | undefined): string | undefined {
  const prefix = "in:data:return-input:";
  return handleId?.startsWith(prefix) ? handleId.slice(prefix.length) : undefined;
}

export function flowDocumentsEqual(
  left: FlowGraphDocument | undefined,
  right: FlowGraphDocument | undefined,
) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function mergeFlowDraftWithSourceDocument(
  currentDocument: FlowGraphDocument,
  baseDocument: FlowGraphDocument,
  sourceDocument: FlowGraphDocument,
): FlowGraphDocument {
  const sourceNodeByIdentity = new Map<string, FlowGraphNode>();
  sourceDocument.nodes.forEach((node) => {
    flowGraphNodeIdentityCandidates(node).forEach((identity) => {
      sourceNodeByIdentity.set(identity, node);
    });
  });
  const baseSourceBackedIdentities = new Set(
    baseDocument.nodes.flatMap((node) => flowGraphNodeIdentityCandidates(node)),
  );
  const sourceNodeIds = new Set(sourceDocument.nodes.map((node) => node.id));
  const nodeIdByCurrentNodeId = new Map<string, string>();
  currentDocument.nodes.forEach((node) => {
    const sourceNode = flowGraphNodeIdentityCandidates(node)
      .map((identity) => sourceNodeByIdentity.get(identity))
      .find(Boolean);
    if (sourceNode) {
      nodeIdByCurrentNodeId.set(node.id, sourceNode.id);
    }
  });
  const remapNodeId = (nodeId: string) => nodeIdByCurrentNodeId.get(nodeId) ?? nodeId;
  const draftOnlyNodes = currentDocument.nodes.filter((node) => (
    !baseSourceBackedIdentities.has(flowGraphNodeSourceIdentity(node))
    && !sourceNodeByIdentity.has(flowGraphNodeSourceIdentity(node))
    && !sourceNodeIds.has(node.id)
  ));
  const nextNodeIds = new Set([...sourceDocument.nodes.map((node) => node.id), ...draftOnlyNodes.map((node) => node.id)]);

  const baseEdgeIds = new Set(baseDocument.edges.map((edge) => edge.id));
  const sourceEdgeKeys = new Set(sourceDocument.edges.map(flowEdgeKey));
  const sourceControlOutputs = new Set(sourceDocument.edges.map((edge) => `${edge.sourceId}\u0000${edge.sourceHandle}`));
  const sourceControlInputs = new Set(sourceDocument.edges.map((edge) => `${edge.targetId}\u0000${edge.targetHandle}`));
  const draftOnlyEdges = currentDocument.edges.flatMap((edge) => {
    if (baseEdgeIds.has(edge.id)) {
      return [];
    }
    const remapped = {
      ...edge,
      sourceId: remapNodeId(edge.sourceId),
      targetId: remapNodeId(edge.targetId),
    };
    remapped.id = flowConnectionId(remapped);
    if (!nextNodeIds.has(remapped.sourceId) || !nextNodeIds.has(remapped.targetId)) {
      return [];
    }
    if (sourceEdgeKeys.has(flowEdgeKey(remapped))) {
      return [];
    }
    if (sourceControlOutputs.has(`${remapped.sourceId}\u0000${remapped.sourceHandle}`)) {
      return [];
    }
    if (remapped.targetHandle !== "in" && sourceControlInputs.has(`${remapped.targetId}\u0000${remapped.targetHandle}`)) {
      return [];
    }
    return [remapped];
  });

  const baseValueSourceIds = new Set((baseDocument.valueSources ?? []).map((source) => source.id));
  const sourceValueSourceIds = new Set((sourceDocument.valueSources ?? []).map((source) => source.id));
  const nextValueSources = [
    ...(sourceDocument.valueSources ?? []),
    ...(currentDocument.valueSources ?? []).flatMap((source) => {
      if (baseValueSourceIds.has(source.id) || sourceValueSourceIds.has(source.id)) {
        return [];
      }
      const nodeId = remapNodeId(source.nodeId);
      return nextNodeIds.has(nodeId) ? [{ ...source, nodeId }] : [];
    }),
  ];

  const baseSlotIds = new Set((baseDocument.inputSlots ?? []).map((slot) => slot.id));
  const sourceSlotKeys = new Set((sourceDocument.inputSlots ?? []).map((slot) => `${slot.nodeId}\u0000${slot.slotKey}`));
  const sourceSlotIds = new Set((sourceDocument.inputSlots ?? []).map((slot) => slot.id));
  const nextInputSlots = [
    ...(sourceDocument.inputSlots ?? []),
    ...(currentDocument.inputSlots ?? []).flatMap((slot) => {
      if (baseSlotIds.has(slot.id) || sourceSlotIds.has(slot.id)) {
        return [];
      }
      const nodeId = remapNodeId(slot.nodeId);
      if (!nextNodeIds.has(nodeId) || sourceSlotKeys.has(`${nodeId}\u0000${slot.slotKey}`)) {
        return [];
      }
      return [{ ...slot, nodeId }];
    }),
  ];

  const nextSourceIds = new Set([
    ...(sourceDocument.functionInputs ?? []).map((input) => input.id),
    ...nextValueSources.map((source) => source.id),
  ]);
  const nextSlotIds = new Set(nextInputSlots.map((slot) => slot.id));
  const baseBindingIds = new Set((baseDocument.inputBindings ?? []).map((binding) => binding.id));
  const sourceBindingSlotIds = new Set((sourceDocument.inputBindings ?? []).map((binding) => binding.slotId));
  const sourceBindingIds = new Set((sourceDocument.inputBindings ?? []).map((binding) => binding.id));
  const nextInputBindings = [
    ...(sourceDocument.inputBindings ?? []),
    ...(currentDocument.inputBindings ?? []).flatMap((binding) => {
      if (
        baseBindingIds.has(binding.id)
        || sourceBindingIds.has(binding.id)
        || sourceBindingSlotIds.has(binding.slotId)
        || !nextSourceIds.has(binding.sourceId)
        || !nextSlotIds.has(binding.slotId)
      ) {
        return [];
      }
      return [binding];
    }),
  ];

  return {
    ...sourceDocument,
    nodes: [...sourceDocument.nodes, ...draftOnlyNodes],
    edges: [...sourceDocument.edges, ...draftOnlyEdges],
    valueSources: nextValueSources,
    inputSlots: nextInputSlots,
    inputBindings: nextInputBindings,
  };
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

function flowSourceLabel(document: FlowGraphDocument, sourceId: string): string | undefined {
  const input = (document.functionInputs ?? []).find((candidate) => candidate.id === sourceId);
  if (input?.name) {
    return input.name;
  }
  const valueSource = (document.valueSources ?? []).find((candidate) => candidate.id === sourceId);
  return valueSource?.emittedName ?? valueSource?.label ?? valueSource?.name;
}

function withReturnExpressionInputNode(
  payload: Record<string, unknown>,
  slotId: string,
  name: string,
): Record<string, unknown> {
  const graph = flowExpressionGraphFromPayload(payload.expression_graph);
  const existing = graph.nodes.some((node) => {
    const payloadSlotId = node.payload.slot_id ?? node.payload.slotId;
    const payloadName = node.payload.name;
    return node.kind === "input"
      && (payloadSlotId === slotId || payloadName === name || node.label === name);
  });
  if (existing) {
    return { ...payload, expression_graph: graph };
  }
  const inputNode: FlowExpressionNode = {
    id: nextExpressionNodeId(graph, "input", name),
    kind: "input",
    label: name,
    payload: {
      name,
      slot_id: slotId,
    },
  };
  return {
    ...payload,
    expression_graph: {
      ...graph,
      nodes: [...graph.nodes, inputNode],
    },
  };
}

function flowExpressionGraphFromPayload(value: unknown): FlowExpressionGraph {
  if (
    value
    && typeof value === "object"
    && Array.isArray((value as Partial<FlowExpressionGraph>).nodes)
    && Array.isArray((value as Partial<FlowExpressionGraph>).edges)
  ) {
    const graph = value as FlowExpressionGraph;
    return {
      version: typeof graph.version === "number" ? graph.version : 1,
      rootId: typeof graph.rootId === "string" ? graph.rootId : null,
      nodes: graph.nodes.map((node) => ({
        id: node.id,
        kind: node.kind,
        label: node.label,
        payload: { ...node.payload },
      })),
      edges: graph.edges.map((edge) => ({ ...edge })),
      ...(graph.layout
        ? {
            layout: {
              ...(graph.layout.nodes ? { nodes: { ...graph.layout.nodes } } : {}),
            },
          }
        : {}),
    };
  }
  return {
    version: 1,
    rootId: null,
    nodes: [],
    edges: [],
  };
}

function nextExpressionNodeId(graph: FlowExpressionGraph, kind: string, label: string): string {
  const safeLabel = label.trim().replace(/[^a-zA-Z0-9_-]+/g, "-") || "value";
  const existingIds = new Set(graph.nodes.map((node) => node.id));
  let index = graph.nodes.length;
  let nodeId = `expr:${kind}:${safeLabel}:${index}`;
  while (existingIds.has(nodeId)) {
    index += 1;
    nodeId = `expr:${kind}:${safeLabel}:${index}`;
  }
  return nodeId;
}

function flowGraphNodeSourceIdentity(node: FlowGraphNode): string {
  return node.indexedNodeId || node.id;
}

function flowGraphNodeIdentityCandidates(node: FlowGraphNode): string[] {
  return [...new Set([flowGraphNodeSourceIdentity(node), node.id])];
}

function flowEdgeKey(edge: FlowGraphEdge): string {
  return `${edge.sourceId}\u0000${edge.sourceHandle}\u0000${edge.targetId}\u0000${edge.targetHandle}`;
}
