import type {
  FlowExpressionEdge,
  FlowExpressionGraph,
  FlowExpressionNode,
  FlowFunctionInput,
  FlowGraphDocument,
  FlowGraphEdge,
  FlowGraphNode,
  FlowInputBinding,
  FlowInputSlot,
  FlowVisualNodeKind,
} from "../../lib/adapter";
import { expressionFromFlowExpressionGraph } from "./flowExpressionGraph";

export const FLOW_DOCUMENT_NODE_KINDS = [
  "entry",
  "assign",
  "call",
  "branch",
  "loop",
  "return",
  "exit",
] as const satisfies readonly FlowVisualNodeKind[];

export const FLOW_AUTHORABLE_NODE_KINDS = ["assign", "call", "return", "branch", "loop"] as const;

const FLOW_DOCUMENT_NODE_KIND_SET = new Set<string>(FLOW_DOCUMENT_NODE_KINDS);
const FLOW_AUTHORABLE_NODE_KIND_SET = new Set<string>(FLOW_AUTHORABLE_NODE_KINDS);

export type AuthoredFlowNodeKind = (typeof FLOW_AUTHORABLE_NODE_KINDS)[number];
export type AuthoredFlowNode = FlowGraphNode & { kind: AuthoredFlowNodeKind };
export type FlowLoopType = "while" | "for";

export interface FlowLoopDraft {
  loopType: FlowLoopType;
  condition: string;
  target: string;
  iterable: string;
}

export function isFlowNodeStructuralKind(
  kind: FlowVisualNodeKind | string,
): kind is "entry" | "exit" {
  return kind === "entry" || kind === "exit";
}

export function isFlowDocumentNodeKind(
  kind: FlowVisualNodeKind | string,
): kind is FlowVisualNodeKind {
  return FLOW_DOCUMENT_NODE_KIND_SET.has(kind);
}

export function isFlowNodeAuthorableKind(
  kind: FlowVisualNodeKind | string,
): kind is AuthoredFlowNodeKind {
  return FLOW_AUTHORABLE_NODE_KIND_SET.has(kind);
}

export function isAuthoredFlowNodeKind(
  kind: FlowVisualNodeKind | string,
): kind is AuthoredFlowNodeKind {
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
    return flowLoopPayloadFromDraft({
      loopType: "while",
      condition: "",
      target: "",
      iterable: "",
    });
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
    return flowLoopPayloadFromDraft(
      normalizeFlowLoopPayload({ header: normalized.replace(/:$/, "") }),
    );
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
    return normalizeFlowLoopPayload(payload).header;
  }
  const expression = typeof payload.expression === "string" ? payload.expression : "";
  return expression ? `return ${expression}` : "return";
}

export function normalizeFlowLoopPayload(
  payload: Record<string, unknown>,
): FlowLoopDraft & { header: string } {
  const rawHeader =
    typeof payload.header === "string" ? payload.header.trim().replace(/:$/, "") : "";
  const inferred = inferFlowLoopDraftFromHeader(rawHeader);
  const rawLoopType =
    typeof payload.loop_type === "string"
      ? payload.loop_type
      : typeof payload.loopType === "string"
        ? payload.loopType
        : undefined;
  const loopType: FlowLoopType =
    rawLoopType === "for_each" || rawLoopType === "for"
      ? "for"
      : rawLoopType === "while"
        ? "while"
        : (inferred?.loopType ?? "while");
  const condition =
    typeof payload.condition === "string"
      ? payload.condition.trim()
      : loopType === "while" && inferred?.loopType === "while"
        ? inferred.condition
        : "";
  const target =
    typeof payload.target === "string"
      ? payload.target.trim()
      : loopType === "for" && inferred?.loopType === "for"
        ? inferred.target
        : "";
  const iterable =
    typeof payload.iterable === "string"
      ? payload.iterable.trim()
      : loopType === "for" && inferred?.loopType === "for"
        ? inferred.iterable
        : "";
  const draft = { loopType, condition, target, iterable };
  const header = canonicalFlowLoopHeader(draft) || rawHeader;
  return { ...draft, header };
}

export function flowLoopPayloadFromDraft(draft: FlowLoopDraft): Record<string, unknown> {
  const header = canonicalFlowLoopHeader(draft);
  if (draft.loopType === "for") {
    return {
      header,
      loop_type: "for",
      target: draft.target.trim(),
      iterable: draft.iterable.trim(),
    };
  }
  return {
    header,
    loop_type: "while",
    condition: draft.condition.trim(),
  };
}

export function canonicalFlowLoopHeader(draft: FlowLoopDraft): string {
  if (draft.loopType === "for") {
    const target = draft.target.trim();
    const iterable = draft.iterable.trim();
    return target && iterable ? `for ${target} in ${iterable}` : "";
  }
  const condition = draft.condition.trim();
  return condition ? `while ${condition}` : "";
}

export function flowControlPathLabel(
  kind: FlowVisualNodeKind | string,
  sourceHandle: string,
): string {
  if (kind === "loop") {
    if (sourceHandle === "body") {
      return "Repeat";
    }
    if (sourceHandle === "after") {
      return "Done";
    }
  }
  return sourceHandle;
}

function inferFlowLoopDraftFromHeader(header: string): FlowLoopDraft | undefined {
  const normalized = header.trim().replace(/:$/, "");
  const whileMatch = /^while\s+(.+)$/i.exec(normalized);
  if (whileMatch) {
    return {
      loopType: "while",
      condition: whileMatch[1].trim(),
      target: "",
      iterable: "",
    };
  }
  const forMatch = /^for\s+(.+?)\s+in\s+(.+)$/i.exec(normalized);
  if (forMatch) {
    return {
      loopType: "for",
      condition: "",
      target: forMatch[1].trim(),
      iterable: forMatch[2].trim(),
    };
  }
  return undefined;
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

  return handleId.startsWith("out:control:") ? handleId.slice("out:control:".length) : undefined;
}

export function allowedOutputHandles(kind: FlowVisualNodeKind): string[] {
  if (kind === "entry") {
    return ["start"];
  }
  if (kind === "assign" || kind === "call") {
    return ["next"];
  }
  if (kind === "branch") {
    return ["true", "false"];
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
    nodes: document.nodes.map((node) => (node.id === nodeId ? { ...node, payload } : node)),
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

export type FlowFunctionInputDraft = {
  name?: string;
  defaultExpression?: string | null;
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

export function validateFlowInputBindingConnection(
  document: FlowGraphDocument,
  connection: FlowInputBindingConnection,
): { ok: true } | { ok: false; message: string } {
  const sourceExists =
    (document.functionInputs ?? []).some((input) => input.id === connection.sourceId) ||
    (document.valueSources ?? []).some((source) => source.id === connection.sourceId);
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
  const sourceExists =
    (document.functionInputs ?? []).some((input) => input.id === connection.sourceId) ||
    (document.valueSources ?? []).some((source) => source.id === connection.sourceId);
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

  const functionInput = (document.functionInputs ?? []).find(
    (input) => input.id === connection.sourceId,
  );
  const binding: FlowInputBinding = {
    id: flowInputBindingId(connection.slotId, connection.sourceId),
    sourceId: connection.sourceId,
    ...(functionInput ? { functionInputId: functionInput.id } : {}),
    slotId: connection.slotId,
  };
  return {
    ...document,
    inputBindings: [
      ...(document.inputBindings ?? []).filter(
        (candidate) => candidate.id !== previousBindingId && candidate.slotId !== connection.slotId,
      ),
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

  const existingSlot = (document.inputSlots ?? []).find(
    (slot) => slot.nodeId === targetNode.id && slot.slotKey === sourceLabel,
  );
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
    nodes: documentWithSlot.nodes.map((node) =>
      node.id === targetNode.id
        ? {
            ...node,
            payload: withReturnExpressionInputNode(node.payload, slot.id, sourceLabel),
          }
        : node,
    ),
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

export function flowFunctionInputUsage(
  document: FlowGraphDocument,
  inputId: string,
): {
  input?: FlowFunctionInput;
  bindings: FlowInputBinding[];
} {
  return {
    input: (document.functionInputs ?? []).find((input) => input.id === inputId),
    bindings: (document.inputBindings ?? []).filter(
      (binding) => binding.sourceId === inputId || binding.functionInputId === inputId,
    ),
  };
}

export function flowFunctionInputRemovalSummary(
  document: FlowGraphDocument,
  inputId: string,
): {
  input?: FlowFunctionInput;
  bindings: FlowInputBinding[];
  connectionCount: number;
  downstreamUseCount: number;
  expressionInputCount: number;
  inputSlots: FlowInputSlot[];
} {
  const usage = flowFunctionInputUsage(document, inputId);
  const slotIds = new Set(usage.bindings.map((binding) => binding.slotId));
  const inputSlots = (document.inputSlots ?? []).filter((slot) => slotIds.has(slot.id));
  const slotNames = new Set<string>();
  inputSlots.forEach((slot) => {
    if (slot.label.trim()) {
      slotNames.add(slot.label.trim());
    }
    if (slot.slotKey.trim()) {
      slotNames.add(slot.slotKey.trim());
    }
  });
  if (usage.input?.name.trim()) {
    slotNames.add(usage.input.name.trim());
  }

  const expressionInputCount = document.nodes.reduce((count, node) => {
    if (node.kind !== "return" || !node.payload.expression_graph) {
      return count;
    }
    const graph = flowExpressionGraphFromPayload(node.payload.expression_graph);
    return (
      count +
      graph.nodes.filter((expressionNode) => {
        if (expressionNode.kind !== "input") {
          return false;
        }
        const payloadSlotId = expressionNode.payload.slot_id ?? expressionNode.payload.slotId;
        const payloadName =
          typeof expressionNode.payload.name === "string" ? expressionNode.payload.name.trim() : "";
        return (
          (typeof payloadSlotId === "string" && slotIds.has(payloadSlotId)) ||
          (payloadName && slotNames.has(payloadName)) ||
          slotNames.has(expressionNode.label.trim())
        );
      }).length
    );
  }, 0);

  const connectionCount = usage.bindings.length;
  return {
    ...usage,
    connectionCount,
    downstreamUseCount: Math.max(connectionCount, inputSlots.length, expressionInputCount),
    expressionInputCount,
    inputSlots,
  };
}

export function addFlowFunctionInput(
  document: FlowGraphDocument,
  draft: FlowFunctionInputDraft = {},
): FlowGraphDocument {
  const inputs = sortedFlowFunctionInputs(document.functionInputs ?? []);
  const name = uniqueFlowFunctionInputName(inputs, draft.name ?? "input");
  const existingIds = new Set(inputs.map((input) => input.id));
  const input: FlowFunctionInput = {
    id: uniqueFlowFunctionInputId(document.symbolId, name, existingIds),
    name,
    index: inputs.length,
    kind: "positional_or_keyword",
    defaultExpression: normalizeOptionalExpression(draft.defaultExpression),
  };
  return {
    ...document,
    functionInputs: [...inputs, input],
  };
}

export function updateFlowFunctionInput(
  document: FlowGraphDocument,
  inputId: string,
  draft: FlowFunctionInputDraft,
): FlowGraphDocument {
  const inputs = sortedFlowFunctionInputs(document.functionInputs ?? []);
  const target = inputs.find((input) => input.id === inputId);
  if (!target) {
    return document;
  }
  const otherInputs = inputs.filter((input) => input.id !== inputId);
  const nextName =
    draft.name === undefined
      ? target.name
      : uniqueFlowFunctionInputName(otherInputs, draft.name, target.name);
  const nextDefaultExpression =
    draft.defaultExpression === undefined
      ? (target.defaultExpression ?? null)
      : normalizeOptionalExpression(draft.defaultExpression);
  return {
    ...document,
    functionInputs: reindexFlowFunctionInputs(
      inputs.map((input) =>
        input.id === inputId
          ? {
              ...input,
              name: nextName,
              defaultExpression: nextDefaultExpression,
            }
          : input,
      ),
    ),
  };
}

export function moveFlowFunctionInput(
  document: FlowGraphDocument,
  inputId: string,
  direction: -1 | 1,
): FlowGraphDocument {
  const inputs = sortedFlowFunctionInputs(document.functionInputs ?? []);
  const index = inputs.findIndex((input) => input.id === inputId);
  const nextIndex = index + direction;
  if (index < 0 || nextIndex < 0 || nextIndex >= inputs.length) {
    return document;
  }
  const nextInputs = [...inputs];
  const [input] = nextInputs.splice(index, 1);
  nextInputs.splice(nextIndex, 0, input);
  return {
    ...document,
    functionInputs: reindexFlowFunctionInputs(nextInputs),
  };
}

export function removeFlowFunctionInput(
  document: FlowGraphDocument,
  inputId: string,
): FlowGraphDocument {
  const inputs = document.functionInputs ?? [];
  if (!inputs.some((input) => input.id === inputId)) {
    return document;
  }
  return {
    ...document,
    functionInputs: reindexFlowFunctionInputs(inputs.filter((input) => input.id !== inputId)),
    inputBindings: (document.inputBindings ?? []).filter(
      (binding) => binding.sourceId !== inputId && binding.functionInputId !== inputId,
    ),
  };
}

export function removeFlowFunctionInputAndDownstreamUses(
  document: FlowGraphDocument,
  inputId: string,
): FlowGraphDocument {
  const usage = flowFunctionInputUsage(document, inputId);
  if (!usage.input) {
    return document;
  }

  const slotIdsToRemove = new Set(usage.bindings.map((binding) => binding.slotId));
  const slotNamesToRemove = new Set<string>();
  (document.inputSlots ?? []).forEach((slot) => {
    if (!slotIdsToRemove.has(slot.id)) {
      return;
    }
    if (slot.label.trim()) {
      slotNamesToRemove.add(slot.label.trim());
    }
    if (slot.slotKey.trim()) {
      slotNamesToRemove.add(slot.slotKey.trim());
    }
  });
  if (usage.input.name.trim()) {
    slotNamesToRemove.add(usage.input.name.trim());
  }

  const withoutInput = removeFlowFunctionInput(document, inputId);
  if (!slotIdsToRemove.size && !slotNamesToRemove.size) {
    return withoutInput;
  }

  return {
    ...withoutInput,
    nodes: withoutInput.nodes.map((node) =>
      node.kind === "return"
        ? {
            ...node,
            payload: withoutExpressionInputSlots(node.payload, slotIdsToRemove, slotNamesToRemove),
          }
        : node,
    ),
    inputSlots: (withoutInput.inputSlots ?? []).filter((slot) => !slotIdsToRemove.has(slot.id)),
    inputBindings: (withoutInput.inputBindings ?? []).filter(
      (binding) => !slotIdsToRemove.has(binding.slotId),
    ),
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
    (document.inputSlots ?? []).filter((slot) => removable.has(slot.nodeId)).map((slot) => slot.id),
  );
  const removedSourceIds = new Set(
    (document.valueSources ?? [])
      .filter((source) => removable.has(source.nodeId))
      .map((source) => source.id),
  );

  return {
    ...document,
    nodes: document.nodes.filter((node) => !removable.has(node.id)),
    edges: document.edges.filter(
      (edge) => !removable.has(edge.sourceId) && !removable.has(edge.targetId),
    ),
    valueSources: (document.valueSources ?? []).filter((source) => !removable.has(source.nodeId)),
    inputSlots: (document.inputSlots ?? []).filter((slot) => !removable.has(slot.nodeId)),
    inputBindings: (document.inputBindings ?? []).filter(
      (binding) => !removedSlotIds.has(binding.slotId) && !removedSourceIds.has(binding.sourceId),
    ),
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

function flowInputSlotId(nodeSourceIdentity: string, slotKey: string) {
  return `flowslot:${nodeSourceIdentity}:${slotKey}`;
}

function sortedFlowFunctionInputs(inputs: FlowFunctionInput[]): FlowFunctionInput[] {
  return [...inputs].sort(
    (left, right) => left.index - right.index || left.name.localeCompare(right.name),
  );
}

function reindexFlowFunctionInputs(inputs: FlowFunctionInput[]): FlowFunctionInput[] {
  return inputs.map((input, index) => ({ ...input, index }));
}

function normalizeFlowFunctionInputName(value: string, fallback = "input"): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }
  const identifier = trimmed.replace(/^[^A-Za-z_]+/, "").replace(/[^A-Za-z0-9_]+/g, "_");
  return identifier || fallback;
}

function uniqueFlowFunctionInputName(
  inputs: FlowFunctionInput[],
  requestedName: string,
  fallbackName?: string,
): string {
  const baseName = normalizeFlowFunctionInputName(requestedName, fallbackName ?? "input");
  const usedNames = new Set(inputs.map((input) => input.name));
  if (!usedNames.has(baseName)) {
    return baseName;
  }
  if (fallbackName && !usedNames.has(fallbackName)) {
    return fallbackName;
  }
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${baseName}_${suffix}`;
    if (!usedNames.has(candidate)) {
      return candidate;
    }
  }
  return `${baseName}_${Date.now()}`;
}

function uniqueFlowFunctionInputId(
  symbolId: string,
  name: string,
  existingIds: Set<string>,
): string {
  const baseId = `flowinput:${symbolId}:${name}`;
  if (!existingIds.has(baseId)) {
    return baseId;
  }
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${baseId}:${suffix}`;
    if (!existingIds.has(candidate)) {
      return candidate;
    }
  }
  return `${baseId}:${Date.now()}`;
}

function normalizeOptionalExpression(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : null;
}

export function returnInputTargetHandle(nodeId: string): string {
  return `in:data:return-input:${nodeId}`;
}

export function parseReturnInputTargetHandle(
  handleId: string | null | undefined,
): string | undefined {
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
  const draftOnlyNodes = currentDocument.nodes.filter(
    (node) =>
      !baseSourceBackedIdentities.has(flowGraphNodeSourceIdentity(node)) &&
      !sourceNodeByIdentity.has(flowGraphNodeSourceIdentity(node)) &&
      !sourceNodeIds.has(node.id),
  );
  const nextNodeIds = new Set([
    ...sourceDocument.nodes.map((node) => node.id),
    ...draftOnlyNodes.map((node) => node.id),
  ]);

  const baseEdgeIds = new Set(baseDocument.edges.map((edge) => edge.id));
  const sourceEdgeKeys = new Set(sourceDocument.edges.map(flowEdgeKey));
  const sourceControlOutputs = new Set(
    sourceDocument.edges.map((edge) => `${edge.sourceId}\u0000${edge.sourceHandle}`),
  );
  const sourceControlInputs = new Set(
    sourceDocument.edges.map((edge) => `${edge.targetId}\u0000${edge.targetHandle}`),
  );
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
    if (
      remapped.targetHandle !== "in" &&
      sourceControlInputs.has(`${remapped.targetId}\u0000${remapped.targetHandle}`)
    ) {
      return [];
    }
    return [remapped];
  });

  const baseValueSourceIds = new Set((baseDocument.valueSources ?? []).map((source) => source.id));
  const sourceValueSourceIds = new Set(
    (sourceDocument.valueSources ?? []).map((source) => source.id),
  );
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
  const sourceSlotKeys = new Set(
    (sourceDocument.inputSlots ?? []).map((slot) => `${slot.nodeId}\u0000${slot.slotKey}`),
  );
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
  const sourceBindingSlotIds = new Set(
    (sourceDocument.inputBindings ?? []).map((binding) => binding.slotId),
  );
  const sourceBindingIds = new Set(
    (sourceDocument.inputBindings ?? []).map((binding) => binding.id),
  );
  const nextInputBindings = [
    ...(sourceDocument.inputBindings ?? []),
    ...(currentDocument.inputBindings ?? []).flatMap((binding) => {
      if (
        baseBindingIds.has(binding.id) ||
        sourceBindingIds.has(binding.id) ||
        sourceBindingSlotIds.has(binding.slotId) ||
        !nextSourceIds.has(binding.sourceId) ||
        !nextSlotIds.has(binding.slotId)
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
    return "true";
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
    return (
      node.kind === "input" &&
      (payloadSlotId === slotId || payloadName === name || node.label === name)
    );
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

function withoutExpressionInputSlots(
  payload: Record<string, unknown>,
  slotIdsToRemove: Set<string>,
  slotNamesToRemove: Set<string>,
): Record<string, unknown> {
  if (!payload.expression_graph) {
    return payload;
  }
  const graph = flowExpressionGraphFromPayload(payload.expression_graph);
  const removedNodeIds = new Set(
    graph.nodes
      .filter((node) => {
        if (node.kind !== "input") {
          return false;
        }
        const payloadSlotId = node.payload.slot_id ?? node.payload.slotId;
        const payloadName = typeof node.payload.name === "string" ? node.payload.name.trim() : "";
        return (
          (typeof payloadSlotId === "string" && slotIdsToRemove.has(payloadSlotId)) ||
          (payloadName && slotNamesToRemove.has(payloadName)) ||
          slotNamesToRemove.has(node.label.trim())
        );
      })
      .map((node) => node.id),
  );
  if (!removedNodeIds.size) {
    return payload;
  }

  const nextGraph = simplifyExpressionGraphWithoutNodes(graph, removedNodeIds);
  const expressionResult = expressionFromFlowExpressionGraph(nextGraph);
  return {
    ...payload,
    expression_graph: nextGraph,
    ...(expressionResult.diagnostics.length ? {} : { expression: expressionResult.expression }),
  };
}

function simplifyExpressionGraphWithoutNodes(
  graph: FlowExpressionGraph,
  removedNodeIds: Set<string>,
): FlowExpressionGraph {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const incomingByTarget = new Map<string, FlowExpressionEdge[]>();
  graph.edges.forEach((edge) => {
    incomingByTarget.set(edge.targetId, [...(incomingByTarget.get(edge.targetId) ?? []), edge]);
  });

  const keptNodes = new Map<string, FlowExpressionNode>();
  const keptEdges = new Map<string, FlowExpressionEdge>();
  const visiting = new Set<string>();

  const keepNode = (node: FlowExpressionNode) => {
    if (!keptNodes.has(node.id)) {
      keptNodes.set(node.id, {
        ...node,
        payload: { ...node.payload },
      });
    }
  };
  const keepEdge = (sourceId: string, targetId: string, targetHandle: string) => {
    const id = `expr-edge:${sourceId}->${targetId}:${targetHandle}`;
    keptEdges.set(id, {
      id,
      sourceId,
      sourceHandle: "value",
      targetId,
      targetHandle,
    });
  };
  const singleChild = (nodeId: string, handle: string) =>
    (incomingByTarget.get(nodeId) ?? []).find((edge) => edge.targetHandle === handle);
  const indexedChildren = (nodeId: string, prefix: string) =>
    (incomingByTarget.get(nodeId) ?? [])
      .filter((edge) => edge.targetHandle.startsWith(prefix))
      .slice()
      .sort((left, right) => left.targetHandle.localeCompare(right.targetHandle));

  const visit = (nodeId: string): string | undefined => {
    if (removedNodeIds.has(nodeId) || visiting.has(nodeId)) {
      return undefined;
    }
    const node = nodeById.get(nodeId);
    if (!node) {
      return undefined;
    }
    visiting.add(nodeId);

    const keepWithRequiredChildren = (
      children: Array<[FlowExpressionEdge | undefined, string]>,
    ) => {
      const resolved = children.map(
        ([edge, handle]) => [edge ? visit(edge.sourceId) : undefined, handle] as const,
      );
      if (resolved.some(([sourceId]) => !sourceId)) {
        visiting.delete(nodeId);
        return undefined;
      }
      keepNode(node);
      resolved.forEach(([sourceId, handle]) => {
        keepEdge(sourceId as string, node.id, handle);
      });
      visiting.delete(nodeId);
      return node.id;
    };

    if (node.kind === "operator") {
      const left = singleChild(node.id, "left");
      const right = singleChild(node.id, "right");
      const leftSourceId = left ? visit(left.sourceId) : undefined;
      const rightSourceId = right ? visit(right.sourceId) : undefined;
      if (!leftSourceId || !rightSourceId) {
        visiting.delete(nodeId);
        return leftSourceId ?? rightSourceId;
      }
      keepNode(node);
      keepEdge(leftSourceId, node.id, "left");
      keepEdge(rightSourceId, node.id, "right");
      visiting.delete(nodeId);
      return node.id;
    }

    if (node.kind === "bool") {
      const children = indexedChildren(node.id, "value:")
        .map((edge) => visit(edge.sourceId))
        .filter((sourceId): sourceId is string => Boolean(sourceId));
      if (children.length <= 1) {
        visiting.delete(nodeId);
        return children[0];
      }
      keepNode(node);
      children.forEach((sourceId, index) => keepEdge(sourceId, node.id, `value:${index}`));
      visiting.delete(nodeId);
      return node.id;
    }

    if (node.kind === "call") {
      const functionEdge = singleChild(node.id, "function");
      const functionSourceId = functionEdge ? visit(functionEdge.sourceId) : undefined;
      if (!functionSourceId) {
        visiting.delete(nodeId);
        return undefined;
      }
      keepNode(node);
      keepEdge(functionSourceId, node.id, "function");
      let argumentIndex = 0;
      indexedChildren(node.id, "arg:").forEach((edge) => {
        const sourceId = visit(edge.sourceId);
        if (sourceId) {
          keepEdge(sourceId, node.id, `arg:${argumentIndex}`);
          argumentIndex += 1;
        }
      });
      (incomingByTarget.get(node.id) ?? [])
        .filter((edge) => edge.targetHandle.startsWith("kwarg:"))
        .forEach((edge) => {
          const sourceId = visit(edge.sourceId);
          if (sourceId) {
            keepEdge(sourceId, node.id, edge.targetHandle);
          }
        });
      visiting.delete(nodeId);
      return node.id;
    }

    if (node.kind === "collection") {
      const childPrefix =
        node.payload.collection_type === "dict" || node.payload.collectionType === "dict"
          ? "value:"
          : "item:";
      const children = indexedChildren(node.id, childPrefix)
        .map((edge) => visit(edge.sourceId))
        .filter((sourceId): sourceId is string => Boolean(sourceId));
      keepNode(node);
      children.forEach((sourceId, index) => keepEdge(sourceId, node.id, `${childPrefix}${index}`));
      visiting.delete(nodeId);
      return node.id;
    }

    if (node.kind === "unary") {
      return keepWithRequiredChildren([[singleChild(node.id, "operand"), "operand"]]);
    }
    if (node.kind === "attribute") {
      return keepWithRequiredChildren([[singleChild(node.id, "value"), "value"]]);
    }
    if (node.kind === "subscript") {
      return keepWithRequiredChildren([
        [singleChild(node.id, "value"), "value"],
        [singleChild(node.id, "slice"), "slice"],
      ]);
    }
    if (node.kind === "conditional") {
      return keepWithRequiredChildren([
        [singleChild(node.id, "test"), "test"],
        [singleChild(node.id, "body"), "body"],
        [singleChild(node.id, "orelse"), "orelse"],
      ]);
    }
    if (node.kind === "compare") {
      const left = singleChild(node.id, "left");
      const leftSourceId = left ? visit(left.sourceId) : undefined;
      const comparators = indexedChildren(node.id, "comparator:")
        .map((edge) => visit(edge.sourceId))
        .filter((sourceId): sourceId is string => Boolean(sourceId));
      if (!leftSourceId) {
        visiting.delete(nodeId);
        return undefined;
      }
      if (!comparators.length) {
        visiting.delete(nodeId);
        return leftSourceId;
      }
      keepNode(node);
      keepEdge(leftSourceId, node.id, "left");
      comparators.forEach((sourceId, index) => keepEdge(sourceId, node.id, `comparator:${index}`));
      visiting.delete(nodeId);
      return node.id;
    }

    keepNode(node);
    visiting.delete(nodeId);
    return node.id;
  };

  const rootId = graph.rootId ? visit(graph.rootId) : undefined;
  const keptNodeIds = new Set(keptNodes.keys());
  const layoutNodes = graph.layout?.nodes
    ? Object.fromEntries(
        Object.entries(graph.layout.nodes).filter(([nodeId]) => keptNodeIds.has(nodeId)),
      )
    : undefined;
  return {
    ...graph,
    rootId: rootId ?? null,
    nodes: graph.nodes
      .filter((node) => keptNodeIds.has(node.id))
      .map((node) => keptNodes.get(node.id) ?? node),
    edges: [...keptEdges.values()],
    ...(layoutNodes && Object.keys(layoutNodes).length ? { layout: { nodes: layoutNodes } } : {}),
  };
}

function flowExpressionGraphFromPayload(value: unknown): FlowExpressionGraph {
  if (
    value &&
    typeof value === "object" &&
    Array.isArray((value as Partial<FlowExpressionGraph>).nodes) &&
    Array.isArray((value as Partial<FlowExpressionGraph>).edges)
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
