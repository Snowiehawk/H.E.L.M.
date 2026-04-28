import type { GraphEdgeDto, GraphNodeKind } from "../../lib/adapter";
import { declutterGraphLayout } from "./declutterLayout";

export type GroupOrganizeMode = "column" | "row" | "grid" | "tidy" | "kind";

export interface GroupOrganizeNode {
  id: string;
  kind: GraphNodeKind;
  x: number;
  y: number;
  width: number;
  height: number;
  metadata?: Record<string, unknown>;
}

export interface GroupOrganizeResult {
  changed: boolean;
  positions: Record<string, { x: number; y: number }>;
  movedNodeIds: string[];
}

interface GroupBounds {
  centerX: number;
  centerY: number;
  width: number;
  height: number;
}

const ROW_GAP = 56;
const COLUMN_GAP = 40;
const KIND_ORDER: GraphNodeKind[] = [
  "repo",
  "module",
  "symbol",
  "function",
  "class",
  "enum",
  "variable",
  "entry",
  "param",
  "assign",
  "call",
  "branch",
  "loop",
  "return",
];

function compareNodeIds(left: string, right: string) {
  return left.localeCompare(right);
}

function metadataNumber(node: GroupOrganizeNode, key: string): number | undefined {
  const value =
    node.metadata?.[key] ??
    node.metadata?.[key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())];
  return typeof value === "number" ? value : undefined;
}

function flowOrder(node: GroupOrganizeNode) {
  return metadataNumber(node, "flow_order");
}

function compareTopToBottom(left: GroupOrganizeNode, right: GroupOrganizeNode) {
  return left.y - right.y || left.x - right.x || compareNodeIds(left.id, right.id);
}

function compareLeftToRight(left: GroupOrganizeNode, right: GroupOrganizeNode) {
  return left.x - right.x || left.y - right.y || compareNodeIds(left.id, right.id);
}

function compareReadingOrder(left: GroupOrganizeNode, right: GroupOrganizeNode) {
  return compareTopToBottom(left, right);
}

function compareFlowOrderThen(
  left: GroupOrganizeNode,
  right: GroupOrganizeNode,
  fallback: (left: GroupOrganizeNode, right: GroupOrganizeNode) => number,
) {
  const leftFlowOrder = flowOrder(left);
  const rightFlowOrder = flowOrder(right);
  const leftHasFlowOrder = typeof leftFlowOrder === "number";
  const rightHasFlowOrder = typeof rightFlowOrder === "number";

  if (leftHasFlowOrder || rightHasFlowOrder) {
    if (leftHasFlowOrder && rightHasFlowOrder && leftFlowOrder !== rightFlowOrder) {
      return leftFlowOrder - rightFlowOrder;
    }

    if (leftHasFlowOrder !== rightHasFlowOrder) {
      return leftHasFlowOrder ? -1 : 1;
    }
  }

  return fallback(left, right);
}

function roundPosition(position: { x: number; y: number }) {
  return {
    x: Math.round(position.x),
    y: Math.round(position.y),
  };
}

function buildBounds(
  nodes: GroupOrganizeNode[],
  positions: Record<string, { x: number; y: number }>,
): GroupBounds {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  nodes.forEach((node) => {
    const position = positions[node.id] ?? { x: node.x, y: node.y };
    minX = Math.min(minX, position.x);
    minY = Math.min(minY, position.y);
    maxX = Math.max(maxX, position.x + node.width);
    maxY = Math.max(maxY, position.y + node.height);
  });

  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(maxY)
  ) {
    return {
      centerX: 0,
      centerY: 0,
      width: 0,
      height: 0,
    };
  }

  return {
    centerX: minX + (maxX - minX) / 2,
    centerY: minY + (maxY - minY) / 2,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function centerPositions(
  nodes: GroupOrganizeNode[],
  positions: Record<string, { x: number; y: number }>,
) {
  const currentBounds = buildBounds(
    nodes,
    Object.fromEntries(nodes.map((node) => [node.id, { x: node.x, y: node.y }] as const)),
  );
  const nextBounds = buildBounds(nodes, positions);
  const delta = {
    x: currentBounds.centerX - nextBounds.centerX,
    y: currentBounds.centerY - nextBounds.centerY,
  };

  return Object.fromEntries(
    nodes.map(
      (node) =>
        [
          node.id,
          roundPosition({
            x: (positions[node.id]?.x ?? node.x) + delta.x,
            y: (positions[node.id]?.y ?? node.y) + delta.y,
          }),
        ] as const,
    ),
  );
}

function buildColumnPositions(nodes: GroupOrganizeNode[]) {
  const ordered = nodes
    .slice()
    .sort((left, right) => compareFlowOrderThen(left, right, compareTopToBottom));
  const maxWidth = Math.max(...ordered.map((node) => node.width));
  let cursorY = 0;

  return Object.fromEntries(
    ordered.map((node, index) => {
      const position = {
        x: (maxWidth - node.width) / 2,
        y: cursorY,
      };
      cursorY += node.height + (index < ordered.length - 1 ? COLUMN_GAP : 0);
      return [node.id, position] as const;
    }),
  );
}

function buildRowPositions(nodes: GroupOrganizeNode[]) {
  const ordered = nodes
    .slice()
    .sort((left, right) => compareFlowOrderThen(left, right, compareLeftToRight));
  const maxHeight = Math.max(...ordered.map((node) => node.height));
  let cursorX = 0;

  return Object.fromEntries(
    ordered.map((node, index) => {
      const position = {
        x: cursorX,
        y: (maxHeight - node.height) / 2,
      };
      cursorX += node.width + (index < ordered.length - 1 ? ROW_GAP : 0);
      return [node.id, position] as const;
    }),
  );
}

function chooseGridColumnCount(nodes: GroupOrganizeNode[]) {
  if (nodes.length <= 1) {
    return 1;
  }

  const bounds = buildBounds(
    nodes,
    Object.fromEntries(nodes.map((node) => [node.id, { x: node.x, y: node.y }] as const)),
  );
  const averageWidth = nodes.reduce((sum, node) => sum + node.width, 0) / nodes.length;
  const averageHeight = nodes.reduce((sum, node) => sum + node.height, 0) / nodes.length;
  const widthUnits = Math.max(bounds.width / Math.max(averageWidth, 1), 0.5);
  const heightUnits = Math.max(bounds.height / Math.max(averageHeight, 1), 0.5);
  const aspectWeight = Math.max(0.5, Math.min(4, widthUnits / heightUnits));
  return Math.max(1, Math.min(nodes.length, Math.round(Math.sqrt(nodes.length * aspectWeight))));
}

function buildGridPositions(nodes: GroupOrganizeNode[]) {
  const ordered = nodes
    .slice()
    .sort((left, right) => compareFlowOrderThen(left, right, compareReadingOrder));
  const columnCount = chooseGridColumnCount(ordered);
  const rowCount = Math.ceil(ordered.length / columnCount);
  const columnWidths = new Array(columnCount).fill(0);
  const rowHeights = new Array(rowCount).fill(0);

  ordered.forEach((node, index) => {
    const column = index % columnCount;
    const row = Math.floor(index / columnCount);
    columnWidths[column] = Math.max(columnWidths[column] ?? 0, node.width);
    rowHeights[row] = Math.max(rowHeights[row] ?? 0, node.height);
  });

  const columnOffsets = columnWidths.map(
    (_, index) =>
      columnWidths.slice(0, index).reduce((sum, width) => sum + width, 0) + ROW_GAP * index,
  );
  const rowOffsets = rowHeights.map(
    (_, index) =>
      rowHeights.slice(0, index).reduce((sum, height) => sum + height, 0) + COLUMN_GAP * index,
  );

  return Object.fromEntries(
    ordered.map((node, index) => {
      const column = index % columnCount;
      const row = Math.floor(index / columnCount);
      return [
        node.id,
        {
          x: columnOffsets[column] + ((columnWidths[column] ?? node.width) - node.width) / 2,
          y: rowOffsets[row] + ((rowHeights[row] ?? node.height) - node.height) / 2,
        },
      ] as const;
    }),
  );
}

function buildKindPositions(nodes: GroupOrganizeNode[]) {
  const lanes = KIND_ORDER.flatMap((kind) => {
    const laneNodes = nodes
      .filter((node) => node.kind === kind)
      .sort((left, right) => compareFlowOrderThen(left, right, compareTopToBottom));
    if (!laneNodes.length) {
      return [];
    }

    const laneWidth = Math.max(...laneNodes.map((node) => node.width));
    let cursorY = 0;
    const lanePositions = Object.fromEntries(
      laneNodes.map((node, index) => {
        const position = {
          x: (laneWidth - node.width) / 2,
          y: cursorY,
        };
        cursorY += node.height + (index < laneNodes.length - 1 ? COLUMN_GAP : 0);
        return [node.id, position] as const;
      }),
    );

    return [
      {
        kind,
        laneNodes,
        laneWidth,
        laneHeight: cursorY,
        lanePositions,
      },
    ];
  });

  const maxLaneHeight = Math.max(...lanes.map((lane) => lane.laneHeight), 0);
  let cursorX = 0;

  return Object.fromEntries(
    lanes.flatMap((lane, laneIndex) => {
      const laneYOffset = (maxLaneHeight - lane.laneHeight) / 2;
      const positionedNodes = lane.laneNodes.map(
        (node) =>
          [
            node.id,
            {
              x: cursorX + (lane.lanePositions[node.id]?.x ?? 0),
              y: laneYOffset + (lane.lanePositions[node.id]?.y ?? 0),
            },
          ] as const,
      );
      cursorX += lane.laneWidth + (laneIndex < lanes.length - 1 ? ROW_GAP : 0);
      return positionedNodes;
    }),
  );
}

function buildTidyPositions(nodes: GroupOrganizeNode[], edges: GraphEdgeDto[]) {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const internalEdges = edges.filter(
    (edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target),
  );
  const result = declutterGraphLayout(
    nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
    })),
    internalEdges,
  );

  return Object.fromEntries(
    nodes.map((node) => [node.id, result.positions[node.id] ?? { x: node.x, y: node.y }] as const),
  );
}

function buildOrganizedPositions(
  mode: GroupOrganizeMode,
  nodes: GroupOrganizeNode[],
  edges: GraphEdgeDto[],
) {
  switch (mode) {
    case "column":
      return buildColumnPositions(nodes);
    case "row":
      return buildRowPositions(nodes);
    case "grid":
      return buildGridPositions(nodes);
    case "tidy":
      return buildTidyPositions(nodes, edges);
    case "kind":
      return buildKindPositions(nodes);
    default:
      return Object.fromEntries(nodes.map((node) => [node.id, { x: node.x, y: node.y }] as const));
  }
}

export function organizeGroupedNodes({
  mode,
  nodes,
  edges,
}: {
  mode: GroupOrganizeMode;
  nodes: GroupOrganizeNode[];
  edges: GraphEdgeDto[];
}): GroupOrganizeResult {
  if (!nodes.length) {
    return {
      changed: false,
      positions: {},
      movedNodeIds: [],
    };
  }

  const nextPositions = centerPositions(nodes, buildOrganizedPositions(mode, nodes, edges));
  const movedNodeIds = nodes
    .filter((node) => {
      const nextPosition = nextPositions[node.id];
      return Boolean(nextPosition) && (nextPosition.x !== node.x || nextPosition.y !== node.y);
    })
    .map((node) => node.id)
    .sort(compareNodeIds);

  return {
    changed: movedNodeIds.length > 0,
    positions: nextPositions,
    movedNodeIds,
  };
}
