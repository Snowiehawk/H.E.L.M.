import type { GraphEdgeDto, GraphNodeKind } from "../../lib/adapter";

export interface FlowLayoutNode {
  id: string;
  kind: GraphNodeKind;
  x: number;
  y: number;
  width?: number;
  height?: number;
  metadata?: Record<string, unknown>;
}

export interface FlowLayoutResult {
  changed: boolean;
  positions: Record<string, { x: number; y: number }>;
  movedNodeIds: string[];
}

interface ResolvedFlowNode extends FlowLayoutNode {
  width: number;
  height: number;
  flowOrder: number;
  baseIndex: number;
}

interface PathChoice {
  edgeId: string;
  key: string;
  label: string;
  rank: number;
}

interface SignatureSegment {
  key: string;
  rank: number;
}

interface ColumnMetrics {
  averageWidth: number;
  centerByColumn: Map<number, number>;
  leftByColumn: Map<number, number>;
  sortedColumns: number[];
  stepEstimate: number;
  widthByColumn: Map<number, number>;
}

const CONTROL_COLUMN_GUTTER = 180;
const CONTROL_LANE_GAP = 220;
const CONTROL_NODE_GAP = 76;
const SUPPORT_COLUMN_OFFSET = 96;
const SUPPORT_ROW_GAP = 148;
const SUPPORT_BAND_MARGIN = 164;
const PIN_DISTANCE_X = 420;
const PIN_DISTANCE_Y = 220;

const DEFAULT_NODE_SIZES: Record<GraphNodeKind, { width: number; height: number }> = {
  repo: { width: 260, height: 116 },
  module: { width: 300, height: 122 },
  symbol: { width: 300, height: 120 },
  function: { width: 300, height: 120 },
  class: { width: 300, height: 120 },
  enum: { width: 300, height: 120 },
  variable: { width: 280, height: 112 },
  entry: { width: 190, height: 94 },
  param: { width: 220, height: 92 },
  assign: { width: 220, height: 98 },
  call: { width: 230, height: 102 },
  branch: { width: 280, height: 110 },
  loop: { width: 260, height: 108 },
  return: { width: 240, height: 96 },
  exit: { width: 190, height: 94 },
};

function metadataNumber(node: FlowLayoutNode, key: string): number | undefined {
  const value =
    node.metadata?.[key]
    ?? node.metadata?.[key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())];
  return typeof value === "number" ? value : undefined;
}

function edgeMetadataNumber(edge: GraphEdgeDto, key: string): number | undefined {
  const value =
    edge.metadata?.[key]
    ?? edge.metadata?.[key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())];
  return typeof value === "number" ? value : undefined;
}

function edgeMetadataString(edge: GraphEdgeDto, key: string): string | undefined {
  const value =
    edge.metadata?.[key]
    ?? edge.metadata?.[key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resolveNode(node: FlowLayoutNode, baseIndex: number): ResolvedFlowNode {
  const fallback = DEFAULT_NODE_SIZES[node.kind];
  return {
    ...node,
    width: typeof node.width === "number" && node.width > 0 ? node.width : fallback.width,
    height: typeof node.height === "number" && node.height > 0 ? node.height : fallback.height,
    flowOrder: metadataNumber(node, "flow_order") ?? baseIndex + 1,
    baseIndex,
  };
}

function roundPosition(position: { x: number; y: number }) {
  return {
    x: Math.round(position.x),
    y: Math.round(position.y),
  };
}

function centeredRank(index: number, total: number) {
  if (total <= 1) {
    return 0;
  }
  const normalized = index - (total - 1) / 2;
  return normalized / Math.max(1, (total - 1) / 2);
}

function flowEdgeOrder(edge: GraphEdgeDto): [number, string, string] {
  return [
    edgeMetadataNumber(edge, "path_order") ?? Number.MAX_SAFE_INTEGER,
    (edgeMetadataString(edge, "path_label") ?? edge.label?.trim() ?? "").toLowerCase(),
    edge.id,
  ];
}

function buildPathChoicesByEdge(
  edges: GraphEdgeDto[],
): Map<string, PathChoice> {
  const choices = new Map<string, PathChoice>();
  const bySource = new Map<string, GraphEdgeDto[]>();

  edges.forEach((edge) => {
    bySource.set(edge.source, [...(bySource.get(edge.source) ?? []), edge]);
  });

  bySource.forEach((group) => {
    const ordered = group.slice().sort((left, right) => {
      const leftKey = flowEdgeOrder(left);
      const rightKey = flowEdgeOrder(right);
      return leftKey[0] - rightKey[0]
        || leftKey[1].localeCompare(rightKey[1])
        || leftKey[2].localeCompare(rightKey[2]);
    });

    ordered.forEach((edge, index) => {
      const label =
        edgeMetadataString(edge, "path_label")
        ?? edge.label?.trim()
        ?? (ordered.length > 1 ? `path ${index + 1}` : "exec");
      const key =
        edgeMetadataString(edge, "path_key")
        ?? edgeMetadataString(edge, "path_label")
        ?? `path-${index + 1}`;
      choices.set(edge.id, {
        edgeId: edge.id,
        key,
        label,
        rank: centeredRank(index, ordered.length),
      });
    });
  });

  return choices;
}

function commonSignaturePrefix(
  left: SignatureSegment[] | undefined,
  right: SignatureSegment[],
): SignatureSegment[] {
  if (!left) {
    return right;
  }

  const prefix: SignatureSegment[] = [];
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftSegment = left[index];
    const rightSegment = right[index];
    if (leftSegment.key !== rightSegment.key) {
      break;
    }
    prefix.push(leftSegment);
  }
  return prefix;
}

function signatureOffset(signature: SignatureSegment[]) {
  return signature.reduce(
    (sum, segment, index) => sum + segment.rank * Math.pow(0.58, index),
    0,
  );
}

function sortNodesForFlow(nodes: ResolvedFlowNode[]) {
  return nodes
    .slice()
    .sort((left, right) => left.flowOrder - right.flowOrder || left.baseIndex - right.baseIndex || left.id.localeCompare(right.id));
}

function buildFallbackPositions(nodes: ResolvedFlowNode[]) {
  const ordered = sortNodesForFlow(nodes);
  let cursor = 0;
  return new Map(
    ordered.map((node) => {
      const position = {
        x: cursor,
        y: -node.height / 2,
      };
      cursor += node.width + CONTROL_COLUMN_GUTTER;
      return [node.id, position] as const;
    }),
  );
}

function controlColumnOrder(nodes: ResolvedFlowNode[]) {
  return nodes.slice().sort((left, right) =>
    left.flowOrder - right.flowOrder || left.baseIndex - right.baseIndex || left.id.localeCompare(right.id),
  );
}

function buildColumnMetrics(
  nodes: ResolvedFlowNode[],
  columns: Map<string, number>,
): ColumnMetrics {
  const widthByColumn = new Map<number, number>();
  nodes.forEach((node) => {
    const column = columns.get(node.id) ?? 0;
    widthByColumn.set(column, Math.max(widthByColumn.get(column) ?? 0, node.width));
  });

  const sortedColumns = [...widthByColumn.keys()].sort((left, right) => left - right);
  const leftByColumn = new Map<number, number>();
  const centerByColumn = new Map<number, number>();
  let cursor = 0;
  sortedColumns.forEach((column, index) => {
    if (index > 0) {
      const previousColumn = sortedColumns[index - 1] as number;
      cursor += (widthByColumn.get(previousColumn) ?? 0) + CONTROL_COLUMN_GUTTER;
    }
    const width = widthByColumn.get(column) ?? 0;
    leftByColumn.set(column, cursor);
    centerByColumn.set(column, cursor + width / 2);
  });

  const widths = [...widthByColumn.values()];
  const averageWidth = widths.length
    ? widths.reduce((sum, width) => sum + width, 0) / widths.length
    : 260;

  return {
    averageWidth,
    centerByColumn,
    leftByColumn,
    sortedColumns,
    stepEstimate: averageWidth + CONTROL_COLUMN_GUTTER,
    widthByColumn,
  };
}

function resolveColumnLeft(
  column: number,
  columnMetrics: ColumnMetrics,
) {
  const exact = columnMetrics.leftByColumn.get(column);
  if (exact !== undefined) {
    return exact;
  }

  const { sortedColumns, stepEstimate } = columnMetrics;
  if (!sortedColumns.length) {
    return column * stepEstimate;
  }

  const firstColumn = sortedColumns[0] as number;
  const lastColumn = sortedColumns[sortedColumns.length - 1] as number;
  const firstLeft = columnMetrics.leftByColumn.get(firstColumn) ?? 0;
  const lastLeft = columnMetrics.leftByColumn.get(lastColumn) ?? 0;

  if (column <= firstColumn) {
    return firstLeft - (firstColumn - column) * stepEstimate;
  }
  if (column >= lastColumn) {
    return lastLeft + (column - lastColumn) * stepEstimate;
  }

  let lowerColumn = firstColumn;
  let upperColumn = lastColumn;
  for (let index = 1; index < sortedColumns.length; index += 1) {
    const candidate = sortedColumns[index] as number;
    if (candidate >= column) {
      upperColumn = candidate;
      lowerColumn = sortedColumns[index - 1] as number;
      break;
    }
  }

  const lowerLeft = columnMetrics.leftByColumn.get(lowerColumn) ?? 0;
  const upperLeft = columnMetrics.leftByColumn.get(upperColumn) ?? 0;
  const ratio = (column - lowerColumn) / Math.max(1, upperColumn - lowerColumn);
  return lowerLeft + (upperLeft - lowerLeft) * ratio;
}

function resolveColumnCenter(
  column: number,
  columnMetrics: ColumnMetrics,
) {
  const exact = columnMetrics.centerByColumn.get(column);
  if (exact !== undefined) {
    return exact;
  }

  return resolveColumnLeft(column, columnMetrics) + columnMetrics.averageWidth / 2;
}

function placeControlNodes(
  nodes: ResolvedFlowNode[],
  columns: Map<string, number>,
  signatures: Map<string, SignatureSegment[]>,
  columnMetrics: ColumnMetrics,
): Map<string, { x: number; y: number }> {
  const byColumn = new Map<number, ResolvedFlowNode[]>();
  nodes.forEach((node) => {
    const column = columns.get(node.id) ?? 0;
    byColumn.set(column, [...(byColumn.get(column) ?? []), node]);
  });

  const positions = new Map<string, { x: number; y: number }>();
  [...byColumn.entries()]
    .sort((left, right) => left[0] - right[0])
    .forEach(([column, group]) => {
      const sorted = group
        .slice()
        .sort((left, right) => {
          const leftOffset = signatureOffset(signatures.get(left.id) ?? []);
          const rightOffset = signatureOffset(signatures.get(right.id) ?? []);
          return leftOffset - rightOffset
            || left.flowOrder - right.flowOrder
            || left.baseIndex - right.baseIndex
            || left.id.localeCompare(right.id);
        });

      const columnLeft = resolveColumnLeft(column, columnMetrics);
      const columnWidth = columnMetrics.widthByColumn.get(column) ?? columnMetrics.averageWidth;
      const desiredCenters = sorted.map(
        (node) => signatureOffset(signatures.get(node.id) ?? []) * CONTROL_LANE_GAP,
      );
      const tops: number[] = [];
      let previousBottom = Number.NEGATIVE_INFINITY;
      sorted.forEach((node, index) => {
        const desiredTop = desiredCenters[index] - node.height / 2;
        const nextTop = Math.max(desiredTop, previousBottom + CONTROL_NODE_GAP);
        tops.push(nextTop);
        previousBottom = nextTop + node.height;
      });

      const verticalShift = sorted.length
        ? desiredCenters.reduce(
          (sum, desiredCenter, index) => sum + (desiredCenter - (tops[index] + sorted[index]!.height / 2)),
          0,
        ) / sorted.length
        : 0;

      sorted.forEach((node, index) => {
        positions.set(node.id, {
          x: columnLeft + (columnWidth - node.width) / 2,
          y: tops[index] + verticalShift,
        });
      });
    });

  return positions;
}

function classifySupportNode(
  node: ResolvedFlowNode,
  edges: GraphEdgeDto[],
  controlNodeIds: Set<string>,
) {
  let outgoingToControl = 0;
  let incomingFromControl = 0;

  edges.forEach((edge) => {
    if (edge.source === node.id && controlNodeIds.has(edge.target)) {
      outgoingToControl += 1;
    }
    if (edge.target === node.id && controlNodeIds.has(edge.source)) {
      incomingFromControl += 1;
    }
  });

  if (node.kind === "param" || outgoingToControl >= incomingFromControl) {
    return "above" as const;
  }
  return "below" as const;
}

function placeSupportNodes(
  supportNodes: ResolvedFlowNode[],
  controlNodes: ResolvedFlowNode[],
  controlPositions: Map<string, { x: number; y: number }>,
  columns: Map<string, number>,
  columnMetrics: ColumnMetrics,
  edges: GraphEdgeDto[],
  controlNodeIds: Set<string>,
): Map<string, { x: number; y: number }> {
  const supportPositions = new Map<string, { x: number; y: number }>();
  if (!supportNodes.length) {
    return supportPositions;
  }

  const controlTop = controlNodes.reduce((lowest, node) => {
    const top = controlPositions.get(node.id)?.y ?? 0;
    return Math.min(lowest, top);
  }, Number.POSITIVE_INFINITY);
  const controlBottom = controlNodes.reduce((highest, node) => {
    const top = controlPositions.get(node.id)?.y ?? 0;
    return Math.max(highest, top + node.height);
  }, Number.NEGATIVE_INFINITY);

  const columnsBySupport = new Map<string, number>();
  supportNodes.forEach((node) => {
    const relatedColumns = edges.flatMap((edge) => {
      if (edge.source === node.id && controlNodeIds.has(edge.target)) {
        return [columns.get(edge.target) ?? 0];
      }
      if (edge.target === node.id && controlNodeIds.has(edge.source)) {
        return [columns.get(edge.source) ?? 0];
      }
      return [];
    });
    if (relatedColumns.length) {
      const average = relatedColumns.reduce((sum, value) => sum + value, 0) / relatedColumns.length;
      columnsBySupport.set(node.id, Math.round(average));
      return;
    }
    const fallbackColumn = columnMetrics.sortedColumns.length
      ? Math.max(
        columnMetrics.sortedColumns[0] as number,
        Math.min(
          columnMetrics.sortedColumns[columnMetrics.sortedColumns.length - 1] as number,
          node.flowOrder > 0 ? node.flowOrder : node.baseIndex,
        ),
      )
      : 0;
    columnsBySupport.set(node.id, fallbackColumn);
  });

  const above = supportNodes
    .filter((node) => classifySupportNode(node, edges, controlNodeIds) === "above")
    .sort((left, right) =>
      (columnsBySupport.get(left.id) ?? 0) - (columnsBySupport.get(right.id) ?? 0)
      || left.flowOrder - right.flowOrder
      || left.baseIndex - right.baseIndex
      || left.id.localeCompare(right.id),
    );
  const below = supportNodes
    .filter((node) => classifySupportNode(node, edges, controlNodeIds) === "below")
    .sort((left, right) =>
      (columnsBySupport.get(left.id) ?? 0) - (columnsBySupport.get(right.id) ?? 0)
      || left.flowOrder - right.flowOrder
      || left.baseIndex - right.baseIndex
      || left.id.localeCompare(right.id),
    );

  const placeBand = (
    bandNodes: ResolvedFlowNode[],
    direction: "above" | "below",
  ) => {
    const nextOffsetByColumn = new Map<number, number>();
    bandNodes.forEach((node) => {
      const column = columnsBySupport.get(node.id) ?? 0;
      const columnCenter = resolveColumnCenter(column, columnMetrics);
      const currentOffset = nextOffsetByColumn.get(column) ?? 0;
      const nextY =
        direction === "above"
          ? controlTop - SUPPORT_BAND_MARGIN - node.height - currentOffset
          : controlBottom + SUPPORT_BAND_MARGIN + currentOffset;
      nextOffsetByColumn.set(column, currentOffset + node.height + SUPPORT_ROW_GAP);
      supportPositions.set(node.id, {
        x:
          columnCenter
          - node.width / 2
          + (direction === "above" ? -SUPPORT_COLUMN_OFFSET : SUPPORT_COLUMN_OFFSET),
        y: nextY,
      });
    });
  };

  placeBand(above, "above");
  placeBand(below, "below");
  return supportPositions;
}

function applyPinnedAnchors(
  nodes: ResolvedFlowNode[],
  canonical: Map<string, { x: number; y: number }>,
  pinnedNodeIds: Set<string>,
): Map<string, { x: number; y: number }> {
  if (!pinnedNodeIds.size) {
    return new Map(canonical);
  }

  const pinned = nodes
    .filter((node) => pinnedNodeIds.has(node.id))
    .flatMap((node) => {
      const canonicalPosition = canonical.get(node.id);
      return canonicalPosition
        ? [{
            node,
            canonical: canonicalPosition,
            current: { x: node.x, y: node.y },
          }]
        : [];
    });

  if (!pinned.length) {
    return new Map(canonical);
  }

  return new Map(
    nodes.map((node) => {
      const canonicalPosition = canonical.get(node.id) ?? { x: node.x, y: node.y };
      if (pinnedNodeIds.has(node.id)) {
        return [node.id, { x: node.x, y: node.y }] as const;
      }

      let weightSum = 0;
      let deltaX = 0;
      let deltaY = 0;
      pinned.forEach((pin) => {
        const normalizedDistance =
          Math.abs(canonicalPosition.x - pin.canonical.x) / PIN_DISTANCE_X
          + Math.abs(canonicalPosition.y - pin.canonical.y) / PIN_DISTANCE_Y;
        const weight = 1 / Math.pow(Math.max(0.6, normalizedDistance + 0.6), 2);
        weightSum += weight;
        deltaX += weight * (pin.current.x - pin.canonical.x);
        deltaY += weight * (pin.current.y - pin.canonical.y);
      });

      return [
        node.id,
        {
          x: canonicalPosition.x + deltaX / Math.max(weightSum, 1),
          y: canonicalPosition.y + deltaY / Math.max(weightSum, 1),
        },
      ] as const;
    }),
  );
}

export function layoutFlowGraph(
  inputNodes: FlowLayoutNode[],
  edges: GraphEdgeDto[],
  pinnedNodeIds: Iterable<string> = [],
): FlowLayoutResult {
  const nodes = inputNodes.map(resolveNode);
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const nodeIds = new Set(nodeById.keys());
  const pinned = new Set(pinnedNodeIds);
  const positions = new Map<string, { x: number; y: number }>();

  const relevantEdges = edges.filter(
    (edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target),
  );
  const controlEdges = relevantEdges.filter((edge) => edge.kind === "controls");

  if (!controlEdges.length) {
    const fallback = buildFallbackPositions(nodes);
    const anchored = applyPinnedAnchors(nodes, fallback, pinned);
    anchored.forEach((position, nodeId) => {
      positions.set(nodeId, roundPosition(position));
    });
  } else {
    const forwardControlEdges = controlEdges.filter((edge) => {
      const source = nodeById.get(edge.source);
      const target = nodeById.get(edge.target);
      if (!source || !target) {
        return false;
      }
      return target.flowOrder >= source.flowOrder;
    });

    if (!forwardControlEdges.length) {
      const fallback = buildFallbackPositions(nodes);
      const anchored = applyPinnedAnchors(nodes, fallback, pinned);
      anchored.forEach((position, nodeId) => {
        positions.set(nodeId, roundPosition(position));
      });
    } else {
      const controlNodeIds = new Set<string>();
      forwardControlEdges.forEach((edge) => {
        controlNodeIds.add(edge.source);
        controlNodeIds.add(edge.target);
      });

      const choiceByEdgeId = buildPathChoicesByEdge(forwardControlEdges);
      const outgoingForwardBySource = new Map<string, GraphEdgeDto[]>();
      const incomingForwardByTarget = new Map<string, GraphEdgeDto[]>();
      forwardControlEdges.forEach((edge) => {
        outgoingForwardBySource.set(edge.source, [...(outgoingForwardBySource.get(edge.source) ?? []), edge]);
        incomingForwardByTarget.set(edge.target, [...(incomingForwardByTarget.get(edge.target) ?? []), edge]);
      });

      const columns = new Map<string, number>();
      const controlNodes = controlColumnOrder(
        nodes.filter((node) => controlNodeIds.has(node.id)),
      );
      controlNodes.forEach((node) => {
        if (node.kind === "entry" || !(incomingForwardByTarget.get(node.id)?.length)) {
          columns.set(node.id, 0);
        }
      });
      controlNodes.forEach((node) => {
        const currentColumn = columns.get(node.id) ?? 0;
        columns.set(node.id, currentColumn);
        (outgoingForwardBySource.get(node.id) ?? []).forEach((edge) => {
          const nextColumn = currentColumn + 1;
          columns.set(edge.target, Math.max(columns.get(edge.target) ?? 0, nextColumn));
        });
      });

      const signatures = new Map<string, SignatureSegment[]>();
      controlNodes.forEach((node) => {
        if (!signatures.has(node.id)) {
          signatures.set(node.id, []);
        }

        const sourceSignature = signatures.get(node.id) ?? [];
        const outgoing = outgoingForwardBySource.get(node.id) ?? [];
        const split = outgoing.length > 1;
        outgoing.forEach((edge) => {
          const choice = choiceByEdgeId.get(edge.id);
          const candidate = split && choice
            ? [...sourceSignature, { key: `${node.id}:${choice.key}`, rank: choice.rank }]
            : sourceSignature;
          signatures.set(edge.target, commonSignaturePrefix(signatures.get(edge.target), candidate));
        });
      });

      const columnMetrics = buildColumnMetrics(controlNodes, columns);
      const controlPositions = placeControlNodes(
        controlNodes,
        columns,
        signatures,
        columnMetrics,
      );
      const supportPositions = placeSupportNodes(
        nodes.filter((node) => !controlNodeIds.has(node.id)),
        controlNodes,
        controlPositions,
        columns,
        columnMetrics,
        relevantEdges,
        controlNodeIds,
      );

      const canonical = new Map([...controlPositions.entries(), ...supportPositions.entries()]);
      nodes.forEach((node) => {
        canonical.set(node.id, canonical.get(node.id) ?? { x: node.x, y: node.y });
      });

      const anchored = applyPinnedAnchors(nodes, canonical, pinned);
      anchored.forEach((position, nodeId) => {
        positions.set(nodeId, roundPosition(position));
      });
    }
  }

  const positionRecord = Object.fromEntries(
    nodes.map((node) => [
      node.id,
      positions.get(node.id) ?? roundPosition({ x: node.x, y: node.y }),
    ]),
  );
  const movedNodeIds = nodes
    .filter((node) => {
      const next = positionRecord[node.id];
      return next.x !== Math.round(node.x) || next.y !== Math.round(node.y);
    })
    .map((node) => node.id);

  return {
    changed: movedNodeIds.length > 0,
    positions: positionRecord,
    movedNodeIds,
  };
}
