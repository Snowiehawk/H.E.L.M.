import { applyNodeChanges, type NodeChange } from "@xyflow/react";
import type { StoredGraphGroup } from "../graphLayoutPersistence";
import { DEFAULT_GROUP_TITLE } from "./constants";
import type {
  GraphCanvasNode,
  GroupMembership,
  MergeGroupsForSelectionResult,
  UngroupGroupsForSelectionResult,
} from "./types";
import { isSemanticCanvasNode } from "./types";
import { sameNodeIds, sortNodeIds } from "./selection";

export function createGroupId() {
  const unique =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  return `group-${unique}`;
}

export function normalizeGroupTitle(title: string | undefined) {
  const normalized = title?.trim();
  return normalized?.length ? normalized : DEFAULT_GROUP_TITLE;
}

export function normalizeStoredGroups(
  groups: StoredGraphGroup[] | undefined,
  liveNodeIds: Set<string>,
): StoredGraphGroup[] {
  const claimedNodeIds = new Set<string>();
  const normalized: StoredGraphGroup[] = [];

  (groups ?? []).forEach((group) => {
    if (!group.id) {
      return;
    }

    const memberNodeIds = sortNodeIds(
      new Set(
        (group.memberNodeIds ?? []).filter(
          (memberNodeId) => liveNodeIds.has(memberNodeId) && !claimedNodeIds.has(memberNodeId),
        ),
      ),
    );

    if (memberNodeIds.length < 2) {
      return;
    }

    memberNodeIds.forEach((memberNodeId) => {
      claimedNodeIds.add(memberNodeId);
    });

    normalized.push({
      id: group.id,
      title: normalizeGroupTitle(group.title),
      memberNodeIds,
    });
  });

  return normalized;
}

export function buildGroupMembership(groups: StoredGraphGroup[]): GroupMembership {
  const groupByNodeId = new Map<string, string>();
  const memberNodeIdsByGroupId = new Map<string, string[]>();

  groups.forEach((group) => {
    const memberNodeIds = sortNodeIds(group.memberNodeIds);
    memberNodeIdsByGroupId.set(group.id, memberNodeIds);
    memberNodeIds.forEach((memberNodeId) => {
      groupByNodeId.set(memberNodeId, group.id);
    });
  });

  return {
    groupByNodeId,
    memberNodeIdsByGroupId,
  };
}

export function touchedGroupIdsForNodeIds(
  nodeIds: Iterable<string>,
  groupByNodeId: Map<string, string>,
) {
  const groupIds = new Set<string>();
  [...nodeIds].forEach((nodeId) => {
    const groupId = groupByNodeId.get(nodeId);
    if (groupId) {
      groupIds.add(groupId);
    }
  });
  return sortNodeIds(groupIds);
}

export function expandGroupedNodeIds(
  nodeIds: Iterable<string>,
  groupByNodeId: Map<string, string>,
  memberNodeIdsByGroupId: Map<string, string[]>,
) {
  const expanded = new Set<string>();
  [...nodeIds].forEach((nodeId) => {
    const groupId = groupByNodeId.get(nodeId);
    if (!groupId) {
      expanded.add(nodeId);
      return;
    }

    (memberNodeIdsByGroupId.get(groupId) ?? []).forEach((memberNodeId) => {
      expanded.add(memberNodeId);
    });
  });

  return sortNodeIds(expanded);
}

export function applyMemberNodeDelta(
  nodes: GraphCanvasNode[],
  memberNodeIds: Iterable<string>,
  delta: { x: number; y: number },
  basePositions?: Map<string, { x: number; y: number }>,
) {
  if (!delta.x && !delta.y) {
    return nodes;
  }

  const targetNodeIds = new Set(memberNodeIds);
  return nodes.map((node) => {
    if (!isSemanticCanvasNode(node) || !targetNodeIds.has(node.id)) {
      return node;
    }

    const basePosition = basePositions?.get(node.id) ?? node.position;
    return {
      ...node,
      position: {
        x: basePosition.x + delta.x,
        y: basePosition.y + delta.y,
      },
    };
  });
}

export function applyGroupedPositionChanges(
  currentNodes: GraphCanvasNode[],
  changes: NodeChange<GraphCanvasNode>[],
  groupByNodeId: Map<string, string>,
  _memberNodeIdsByGroupId: Map<string, string[]>,
) {
  const nextNodes = applyNodeChanges(changes, currentNodes);
  const currentNodesById = new Map(currentNodes.map((node) => [node.id, node] as const));
  const groupDeltaByGroupId = new Map<string, { x: number; y: number }>();

  changes.forEach((change) => {
    if (change.type !== "position" || !change.position) {
      return;
    }

    const groupId = groupByNodeId.get(change.id);
    const currentNode = currentNodesById.get(change.id);
    if (!groupId || !currentNode || !isSemanticCanvasNode(currentNode)) {
      return;
    }

    if (!groupDeltaByGroupId.has(groupId)) {
      groupDeltaByGroupId.set(groupId, {
        x: change.position.x - currentNode.position.x,
        y: change.position.y - currentNode.position.y,
      });
    }
  });

  if (!groupDeltaByGroupId.size) {
    return nextNodes;
  }

  return nextNodes.map((node) => {
    if (!isSemanticCanvasNode(node)) {
      return node;
    }

    const groupId = groupByNodeId.get(node.id);
    const delta = groupId ? groupDeltaByGroupId.get(groupId) : undefined;
    const currentNode = currentNodesById.get(node.id);
    if (!delta || !currentNode || !isSemanticCanvasNode(currentNode)) {
      return node;
    }

    return {
      ...node,
      position: {
        x: currentNode.position.x + delta.x,
        y: currentNode.position.y + delta.y,
      },
    };
  });
}

export function applyGroupedLayoutPositions(
  nodes: GraphCanvasNode[],
  nextPositions: Record<string, { x: number; y: number }>,
  memberNodeIdsByGroupId: Map<string, string[]>,
  groupByNodeId: Map<string, string>,
) {
  const groupDeltaByGroupId = new Map<string, { x: number; y: number }>();

  memberNodeIdsByGroupId.forEach((memberNodeIds, groupId) => {
    const anchorNodeId = memberNodeIds.find((memberNodeId) => nextPositions[memberNodeId]);
    if (!anchorNodeId) {
      return;
    }

    const anchorNode = nodes.find((node) => node.id === anchorNodeId);
    const nextAnchorPosition = nextPositions[anchorNodeId];
    if (!anchorNode || !nextAnchorPosition) {
      return;
    }

    groupDeltaByGroupId.set(groupId, {
      x: nextAnchorPosition.x - anchorNode.position.x,
      y: nextAnchorPosition.y - anchorNode.position.y,
    });
  });

  return nodes.map((node) => {
    if (!isSemanticCanvasNode(node)) {
      return node;
    }

    const groupId = groupByNodeId.get(node.id);
    const delta = groupId ? groupDeltaByGroupId.get(groupId) : undefined;
    if (delta) {
      return {
        ...node,
        position: {
          x: node.position.x + delta.x,
          y: node.position.y + delta.y,
        },
      };
    }

    const nextPosition = nextPositions[node.id];
    if (!nextPosition) {
      return node;
    }

    return {
      ...node,
      position: nextPosition,
    };
  });
}

export function mergeGroupsForSelection(
  groups: StoredGraphGroup[],
  selectedNodeIds: string[],
  createId: () => string = createGroupId,
): MergeGroupsForSelectionResult {
  const normalizedSelectedNodeIds = sortNodeIds(new Set(selectedNodeIds));
  if (normalizedSelectedNodeIds.length < 2) {
    return {
      changed: false,
      nextGroups: groups,
    };
  }

  const { groupByNodeId, memberNodeIdsByGroupId } = buildGroupMembership(groups);
  const touchedGroupIds = touchedGroupIdsForNodeIds(normalizedSelectedNodeIds, groupByNodeId);
  if (
    touchedGroupIds.length === 1 &&
    sameNodeIds(
      sortNodeIds(memberNodeIdsByGroupId.get(touchedGroupIds[0] ?? "") ?? []),
      normalizedSelectedNodeIds,
    )
  ) {
    return {
      changed: false,
      nextGroups: groups,
    };
  }

  const nextGroupId = createId();
  return {
    changed: true,
    nextGroupId,
    nextGroups: [
      ...groups.filter((group) => !touchedGroupIds.includes(group.id)),
      {
        id: nextGroupId,
        title: DEFAULT_GROUP_TITLE,
        memberNodeIds: expandGroupedNodeIds(
          normalizedSelectedNodeIds,
          groupByNodeId,
          memberNodeIdsByGroupId,
        ),
      },
    ],
  };
}

export function ungroupGroupsForSelection(
  groups: StoredGraphGroup[],
  selectedNodeIds: string[],
  selectedGroupId?: string,
): UngroupGroupsForSelectionResult {
  const { groupByNodeId } = buildGroupMembership(groups);
  const removedGroupIds = selectedGroupId
    ? [selectedGroupId]
    : touchedGroupIdsForNodeIds(selectedNodeIds, groupByNodeId);

  if (!removedGroupIds.length) {
    return {
      changed: false,
      nextGroups: groups,
      removedGroupIds: [],
    };
  }

  return {
    changed: true,
    nextGroups: groups.filter((group) => !removedGroupIds.includes(group.id)),
    removedGroupIds,
  };
}

export function renameGraphGroup(groups: StoredGraphGroup[], groupId: string, title: string) {
  return groups.map((group) =>
    group.id === groupId
      ? {
          ...group,
          title: normalizeGroupTitle(title),
        }
      : group,
  );
}
