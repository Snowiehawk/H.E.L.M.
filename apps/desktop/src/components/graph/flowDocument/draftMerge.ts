import type { FlowGraphDocument, FlowGraphNode } from "../../../lib/adapter";
import {
  flowConnectionId,
  flowEdgeKey,
  flowGraphNodeIdentityCandidates,
  flowGraphNodeSourceIdentity,
} from "./ids";

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
