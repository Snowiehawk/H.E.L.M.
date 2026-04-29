import type {
  FlowFunctionInput,
  FlowGraphDocument,
  FlowInputBinding,
  FlowInputSlot,
} from "../../../lib/adapter";
import { flowExpressionGraphFromPayload, withoutExpressionInputSlots } from "./expressionInputs";

export type FlowFunctionInputDraft = {
  name?: string;
  defaultExpression?: string | null;
};

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
