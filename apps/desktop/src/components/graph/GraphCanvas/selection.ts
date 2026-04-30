export function compareNodeIds(left: string, right: string) {
  return left.localeCompare(right);
}

export function sortNodeIds(nodeIds: Iterable<string>) {
  return [...nodeIds].sort(compareNodeIds);
}

export function sameNodeIds(left: string[], right: string[]) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((nodeId, index) => nodeId === right[index]);
}

export function resolveSelectionPreviewNodeIds({
  activeNodeId,
  effectiveSemanticSelection,
  graphNodeIds,
  marqueeSelectionActive,
  selectedGroupId,
  selectedRerouteCount,
}: {
  activeNodeId?: string;
  effectiveSemanticSelection: string[];
  graphNodeIds: Set<string>;
  marqueeSelectionActive: boolean;
  selectedGroupId?: string;
  selectedRerouteCount: number;
}) {
  if (marqueeSelectionActive || selectedRerouteCount || selectedGroupId) {
    return [];
  }

  if (effectiveSemanticSelection.length) {
    return effectiveSemanticSelection;
  }

  return graphNodeIds.has(activeNodeId ?? "") ? [activeNodeId ?? ""] : [];
}

export function resolveSelectionPreviewNodeId({
  activeNodeId,
  effectiveSemanticSelection,
  graphNodeIds,
  marqueeSelectionActive,
  selectedGroupId,
  selectedRerouteCount,
}: {
  activeNodeId?: string;
  effectiveSemanticSelection: string[];
  graphNodeIds: Set<string>;
  marqueeSelectionActive: boolean;
  selectedGroupId?: string;
  selectedRerouteCount: number;
}) {
  const previewNodeIds = resolveSelectionPreviewNodeIds({
    activeNodeId,
    effectiveSemanticSelection,
    graphNodeIds,
    marqueeSelectionActive,
    selectedGroupId,
    selectedRerouteCount,
  });

  return previewNodeIds.length === 1 ? (previewNodeIds[0] ?? "") : "";
}
