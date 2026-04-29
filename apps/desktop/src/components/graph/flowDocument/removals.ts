import type { FlowGraphDocument } from "../../../lib/adapter";
import { isFlowNodeAuthorableKind } from "./model";

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
