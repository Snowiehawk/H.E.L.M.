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

const COLUMN_GAP = 340;
const SUPPORT_COLUMN_OFFSET = 72;
const CONTROL_ROW_GAP = 152;
const SUPPORT_ROW_GAP = 130;
const CONTROL_TOP_PADDING = 24;
const SUPPORT_BAND_OFFSET = 184;

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
  return new Map(
    ordered.map((node, index) => [
      node.id,
      {
        x: index * COLUMN_GAP,
        y: 0,
      },
    ] as const),
  );
}

function controlColumnOrder(nodes: ResolvedFlowNode[]) {
  return nodes.slice().sort((left, right) =>
    left.flowOrder - right.flowOrder || left.baseIndex - right.baseIndex || left.id.localeCompare(right.id),
  );
}

function placeControlNodes(
  nodes: ResolvedFlowNode[],
  columns: Map<string, number>,
  signatures: Map<string, SignatureSegment[]>,
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

      let previousBottom = Number.NEGATIVE_INFINITY;
      sorted.forEach((node) => {
        const desiredTop =
          signatureOffset(signatures.get(node.id) ?? []) * CONTROL_ROW_GAP
          - node.height / 2;
        const nextTop = Math.max(desiredTop, previousBottom + CONTROL_TOP_PADDING);
        positions.set(node.id, {
          x: column * COLUMN_GAP,
          y: nextTop,
        });
        previousBottom = nextTop + node.height;
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
  positions: Map<string, { x: number; y: number }>,
  edges: GraphEdgeDto[],
  controlNodeIds: Set<string>,
): Map<string, { x: number; y: number }> {
  const supportPositions = new Map<string, { x: number; y: number }>();
  if (!supportNodes.length) {
    return supportPositions;
  }

  const columnsBySupport = new Map<string, number>();
  supportNodes.forEach((node) => {
    const relatedColumns = edges.flatMap((edge) => {
      if (edge.source === node.id && controlNodeIds.has(edge.target)) {
        return [Math.round((positions.get(edge.target)?.x ?? 0) / COLUMN_GAP)];
      }
      if (edge.target === node.id && controlNodeIds.has(edge.source)) {
        return [Math.round((positions.get(edge.source)?.x ?? 0) / COLUMN_GAP)];
      }
      return [];
    });
    if (relatedColumns.length) {
      const average = relatedColumns.reduce((sum, value) => sum + value, 0) / relatedColumns.length;
      columnsBySupport.set(node.id, Math.round(average));
      return;
    }
    columnsBySupport.set(node.id, node.flowOrder > 0 ? node.flowOrder : node.baseIndex);
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
    const depthByColumn = new Map<number, number>();
    bandNodes.forEach((node) => {
      const column = columnsBySupport.get(node.id) ?? 0;
      const depth = depthByColumn.get(column) ?? 0;
      depthByColumn.set(column, depth + 1);
      supportPositions.set(node.id, {
        x: column * COLUMN_GAP + (direction === "above" ? -SUPPORT_COLUMN_OFFSET : SUPPORT_COLUMN_OFFSET),
        y:
          direction === "above"
            ? -SUPPORT_BAND_OFFSET - depth * SUPPORT_ROW_GAP
            : SUPPORT_BAND_OFFSET + depth * SUPPORT_ROW_GAP,
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
          Math.abs(canonicalPosition.x - pin.canonical.x) / COLUMN_GAP
          + Math.abs(canonicalPosition.y - pin.canonical.y) / CONTROL_ROW_GAP;
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
      const orderedControlNodes = controlColumnOrder(
        nodes.filter((node) => controlNodeIds.has(node.id)),
      );
      orderedControlNodes.forEach((node) => {
        if (node.kind === "entry" || !(incomingForwardByTarget.get(node.id)?.length)) {
          columns.set(node.id, 0);
        }
      });
      orderedControlNodes.forEach((node) => {
        const currentColumn = columns.get(node.id) ?? 0;
        columns.set(node.id, currentColumn);
        (outgoingForwardBySource.get(node.id) ?? []).forEach((edge) => {
          const nextColumn = currentColumn + 1;
          columns.set(edge.target, Math.max(columns.get(edge.target) ?? 0, nextColumn));
        });
      });

      const signatures = new Map<string, SignatureSegment[]>();
      orderedControlNodes.forEach((node) => {
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

      const controlPositions = placeControlNodes(
        orderedControlNodes,
        columns,
        signatures,
      );
      const supportPositions = placeSupportNodes(
        nodes.filter((node) => !controlNodeIds.has(node.id)),
        controlPositions,
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
