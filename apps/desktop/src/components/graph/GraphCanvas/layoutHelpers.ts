import type { GraphView } from "../../../lib/adapter";
import type { HelpDescriptorId } from "../../workspace/workspaceHelp";
import {
  graphLayoutNodeKey,
  type StoredGraphGroup,
  type StoredGraphLayout,
} from "../graphLayoutPersistence";
import {
  FALLBACK_GROUP_NODE_HEIGHT,
  FALLBACK_GROUP_NODE_WIDTH,
  GROUP_BOX_PADDING,
  GROUP_ORGANIZE_OPTIONS,
  REROUTE_NODE_PREFIX,
  REROUTE_NODE_SIZE,
} from "./constants";
import { normalizeGroupTitle } from "./grouping";
import { sortNodeIds } from "./selection";
import type {
  GraphCanvasNode,
  GraphGroupBounds,
  RerouteCanvasNode,
  SemanticCanvasNode,
} from "./types";
import { isRerouteCanvasNode, isSemanticCanvasNode } from "./types";

export function rerouteNodeId(rerouteId: string) {
  return `${REROUTE_NODE_PREFIX}${rerouteId}`;
}

export function rerouteStorageId(nodeId: string) {
  return nodeId.startsWith(REROUTE_NODE_PREFIX) ? nodeId.slice(REROUTE_NODE_PREFIX.length) : nodeId;
}

export function createRerouteId(logicalEdgeId: string) {
  const sanitized = logicalEdgeId.replace(/[^a-zA-Z0-9_-]+/g, "-");
  const unique =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  return `${sanitized}-${unique}`;
}

export function normalizeRerouteNodeOrders(nodes: GraphCanvasNode[]): GraphCanvasNode[] {
  const reroutesByEdge = new Map<string, RerouteCanvasNode[]>();
  nodes.forEach((node) => {
    if (!isRerouteCanvasNode(node)) {
      return;
    }
    const edgeId = node.data.logicalEdgeId;
    const current = reroutesByEdge.get(edgeId) ?? [];
    current.push(node);
    reroutesByEdge.set(edgeId, current);
  });

  if (!reroutesByEdge.size) {
    return nodes;
  }

  const nextOrderByNodeId = new Map<string, number>();
  reroutesByEdge.forEach((reroutes) => {
    reroutes
      .slice()
      .sort((left, right) => left.data.order - right.data.order || left.id.localeCompare(right.id))
      .forEach((node, index) => {
        nextOrderByNodeId.set(node.id, index);
      });
  });

  return nodes.map((node) => {
    if (!isRerouteCanvasNode(node)) {
      return node;
    }

    const nextOrder = nextOrderByNodeId.get(node.id);
    if (nextOrder === undefined || nextOrder === node.data.order) {
      return node;
    }

    return {
      ...node,
      data: {
        ...node.data,
        order: nextOrder,
      },
    };
  });
}

export function persistGraphLayout(
  nodes: GraphCanvasNode[],
  groups: StoredGraphGroup[],
): StoredGraphLayout {
  const semanticNodes = nodes.filter(isSemanticCanvasNode);
  const rerouteNodes = normalizeRerouteNodeOrders(nodes).filter(isRerouteCanvasNode);

  return {
    nodes: Object.fromEntries(
      semanticNodes.map((node) => [
        graphLayoutNodeKey(node.id, node.data.kind),
        {
          x: node.position.x,
          y: node.position.y,
        },
      ]),
    ),
    reroutes: rerouteNodes
      .map((node) => ({
        id: rerouteStorageId(node.id),
        edgeId: node.data.logicalEdgeId,
        order: node.data.order,
        x: node.position.x,
        y: node.position.y,
      }))
      .sort(
        (left, right) =>
          left.edgeId.localeCompare(right.edgeId) ||
          left.order - right.order ||
          left.id.localeCompare(right.id),
      ),
    pinnedNodeIds: semanticNodes
      .filter((node) => node.data.isPinned)
      .map((node) => node.id)
      .sort((left, right) => left.localeCompare(right)),
    groups: groups
      .map((group) => ({
        id: group.id,
        title: normalizeGroupTitle(group.title),
        memberNodeIds: sortNodeIds(group.memberNodeIds),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export function storedLayoutsEqual(left: StoredGraphLayout, right: StoredGraphLayout) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function applyStoredLayout(nodes: GraphCanvasNode[], layout: StoredGraphLayout) {
  const reroutesById = new Map(
    layout.reroutes.map((reroute) => [rerouteNodeId(reroute.id), reroute] as const),
  );
  const pinnedNodeIds = new Set(layout.pinnedNodeIds ?? []);

  return nodes.map((node) => {
    if (isRerouteCanvasNode(node)) {
      const nextReroute = reroutesById.get(node.id);
      if (!nextReroute) {
        return node;
      }
      return {
        ...node,
        position: {
          x: nextReroute.x,
          y: nextReroute.y,
        },
        data: {
          ...node.data,
          order: nextReroute.order,
        },
      };
    }

    const nextPosition = layout.nodes[graphLayoutNodeKey(node.id, node.data.kind)];
    return {
      ...node,
      position: nextPosition ?? node.position,
      data: {
        ...node.data,
        isPinned: pinnedNodeIds.has(node.id),
        actions: (node.data.actions ?? []).map((action) =>
          action.id === "pin"
            ? {
                ...action,
                label: pinnedNodeIds.has(node.id) ? "Unpin" : "Pin",
                helpId: pinActionHelpId(pinnedNodeIds.has(node.id)),
              }
            : action,
        ),
      },
    };
  });
}

export function readMeasuredDimension(node: GraphCanvasNode, key: "width" | "height") {
  const directValue = Reflect.get(node, key);
  if (typeof directValue === "number" && directValue > 0) {
    return directValue;
  }

  const measured = Reflect.get(node, "measured");
  if (measured && typeof measured === "object") {
    const measuredValue = Reflect.get(measured, key);
    if (typeof measuredValue === "number" && measuredValue > 0) {
      return measuredValue;
    }
  }

  if (isRerouteCanvasNode(node)) {
    return REROUTE_NODE_SIZE;
  }

  return undefined;
}

export function semanticNodeDimension(node: SemanticCanvasNode, key: "width" | "height") {
  return (
    readMeasuredDimension(node, key) ??
    (key === "width" ? FALLBACK_GROUP_NODE_WIDTH : FALLBACK_GROUP_NODE_HEIGHT)
  );
}

export function buildGraphGroupBounds(
  group: StoredGraphGroup,
  nodesById: Map<string, GraphCanvasNode>,
): GraphGroupBounds | undefined {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  group.memberNodeIds.forEach((memberNodeId) => {
    const node = nodesById.get(memberNodeId);
    if (!node || !isSemanticCanvasNode(node)) {
      return;
    }

    const width = semanticNodeDimension(node, "width");
    const height = semanticNodeDimension(node, "height");
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + width);
    maxY = Math.max(maxY, node.position.y + height);
  });

  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(maxY)
  ) {
    return undefined;
  }

  return {
    ...group,
    x: minX - GROUP_BOX_PADDING,
    y: minY - GROUP_BOX_PADDING,
    width: maxX - minX + GROUP_BOX_PADDING * 2,
    height: maxY - minY + GROUP_BOX_PADDING * 2,
  };
}

export function buildGraphGroupBoundsList(groups: StoredGraphGroup[], nodes: GraphCanvasNode[]) {
  const nodesById = new Map(nodes.map((node) => [node.id, node] as const));
  return groups.flatMap((group) => {
    const bounds = buildGraphGroupBounds(group, nodesById);
    return bounds ? [bounds] : [];
  });
}

export function organizeOptionsForGroup(group: StoredGraphGroup, nodes: GraphCanvasNode[]) {
  const kinds = new Set(
    nodes
      .filter((node) => isSemanticCanvasNode(node) && group.memberNodeIds.includes(node.id))
      .map((node) => node.data.kind),
  );

  return GROUP_ORGANIZE_OPTIONS.filter((option) => option.mode !== "kind" || kinds.size > 1);
}

export function toDeclutterNodes(nodes: GraphCanvasNode[]) {
  return nodes.filter(isSemanticCanvasNode).map((node) => ({
    id: node.id,
    kind: node.data.kind,
    x: node.position.x,
    y: node.position.y,
    width: readMeasuredDimension(node, "width"),
    height: readMeasuredDimension(node, "height"),
  }));
}

export function toFlowLayoutNodes(nodes: GraphCanvasNode[], graph: GraphView) {
  const metadataByNodeId = new Map(graph.nodes.map((node) => [node.id, node.metadata] as const));
  return nodes.filter(isSemanticCanvasNode).map((node) => ({
    id: node.id,
    kind: node.data.kind,
    x: node.position.x,
    y: node.position.y,
    width: readMeasuredDimension(node, "width"),
    height: readMeasuredDimension(node, "height"),
    metadata: metadataByNodeId.get(node.id) ?? {},
  }));
}

export function semanticPinnedNodeIds(nodes: GraphCanvasNode[]) {
  return nodes
    .filter(isSemanticCanvasNode)
    .filter((node) => node.data.isPinned)
    .map((node) => node.id);
}

export function storedLayoutIsEmpty(layout: StoredGraphLayout) {
  return (
    !Object.keys(layout.nodes).length &&
    !layout.reroutes.length &&
    !(layout.pinnedNodeIds?.length ?? 0) &&
    !(layout.groups?.length ?? 0)
  );
}

export function pinActionHelpId(pinned: boolean): HelpDescriptorId {
  return pinned ? "graph.node.action.unpin" : "graph.node.action.pin";
}
