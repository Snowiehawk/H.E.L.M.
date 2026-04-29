import type { FlowGraphDocument, FlowInputBinding } from "../../../lib/adapter";
import { flowGraphNodeSourceIdentity, flowInputBindingId, flowInputSlotId } from "./ids";
import { withReturnExpressionInputNode } from "./expressionInputs";

export type FlowInputBindingConnection = {
  sourceId: string;
  slotId: string;
};

export type FlowReturnInputBindingConnection = {
  sourceId: string;
  targetNodeId: string;
};

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

export function returnInputTargetHandle(nodeId: string): string {
  return `in:data:return-input:${nodeId}`;
}

export function parseReturnInputTargetHandle(
  handleId: string | null | undefined,
): string | undefined {
  const prefix = "in:data:return-input:";
  return handleId?.startsWith(prefix) ? handleId.slice(prefix.length) : undefined;
}

function flowSourceLabel(document: FlowGraphDocument, sourceId: string): string | undefined {
  const input = (document.functionInputs ?? []).find((candidate) => candidate.id === sourceId);
  if (input?.name) {
    return input.name;
  }
  const valueSource = (document.valueSources ?? []).find((candidate) => candidate.id === sourceId);
  return valueSource?.emittedName ?? valueSource?.label ?? valueSource?.name;
}
