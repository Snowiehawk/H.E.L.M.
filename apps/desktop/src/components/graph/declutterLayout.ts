import type { GraphEdgeDto, GraphEdgeKind, GraphNodeKind } from "../../lib/adapter";

export interface DeclutterLayoutNode {
  id: string;
  kind: GraphNodeKind;
  x: number;
  y: number;
  width?: number;
  height?: number;
}

export interface DeclutterLayoutResult {
  changed: boolean;
  positions: Record<string, { x: number; y: number }>;
  movedNodeIds: string[];
}

interface ResolvedNodeBox extends DeclutterLayoutNode {
  width: number;
  height: number;
}

interface CrowdingReport {
  score: number;
  hardOverlapPairs: number;
  softCrowdingPairs: number;
}

const SOFT_PADDING_X = 72;
const SOFT_PADDING_Y = 52;
const ITERATION_COUNT = 72;
const MAX_STEP_X = 24;
const MAX_STEP_Y = 20;
const MAX_TOTAL_SHIFT_X = 260;
const MAX_TOTAL_SHIFT_Y = 220;

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

function clamp(value: number, limit: number) {
  return Math.max(-limit, Math.min(limit, value));
}

function stableHash(input: string) {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function stableAxisSign(leftId: string, rightId: string) {
  return stableHash(`${leftId}:${rightId}`) % 2 === 0 ? 1 : -1;
}

function resolveNodeBox(node: DeclutterLayoutNode): ResolvedNodeBox {
  const fallback = DEFAULT_NODE_SIZES[node.kind];
  return {
    ...node,
    width: typeof node.width === "number" && node.width > 0 ? node.width : fallback.width,
    height: typeof node.height === "number" && node.height > 0 ? node.height : fallback.height,
  };
}

function overlapDepth(left: ResolvedNodeBox, right: ResolvedNodeBox, paddingX = 0, paddingY = 0) {
  const leftMinX = left.x - paddingX;
  const leftMaxX = left.x + left.width + paddingX;
  const leftMinY = left.y - paddingY;
  const leftMaxY = left.y + left.height + paddingY;
  const rightMinX = right.x - paddingX;
  const rightMaxX = right.x + right.width + paddingX;
  const rightMinY = right.y - paddingY;
  const rightMaxY = right.y + right.height + paddingY;

  const overlapX = Math.min(leftMaxX, rightMaxX) - Math.max(leftMinX, rightMinX);
  const overlapY = Math.min(leftMaxY, rightMaxY) - Math.max(leftMinY, rightMinY);
  if (overlapX <= 0 || overlapY <= 0) {
    return null;
  }

  return { overlapX, overlapY };
}

function centerX(node: ResolvedNodeBox) {
  return node.x + node.width / 2;
}

function centerY(node: ResolvedNodeBox) {
  return node.y + node.height / 2;
}

function computeSeparationVector(
  left: ResolvedNodeBox,
  right: ResolvedNodeBox,
  overlapX: number,
  overlapY: number,
) {
  const deltaX = centerX(right) - centerX(left);
  const deltaY = centerY(right) - centerY(left);

  if (overlapX < overlapY) {
    const direction = deltaX === 0 ? stableAxisSign(left.id, right.id) : Math.sign(deltaX);
    return {
      x: direction * Math.min(overlapX * 0.52 + 8, 34),
      y: 0,
    };
  }

  const direction =
    deltaY === 0 ? stableAxisSign(`${left.id}:y`, `${right.id}:y`) : Math.sign(deltaY);
  return {
    x: 0,
    y: direction * Math.min(overlapY * 0.52 + 8, 30),
  };
}

function edgeDesiredGap(kind: GraphEdgeKind) {
  switch (kind) {
    case "defines":
      return 300;
    case "controls":
      return 220;
    case "data":
      return 180;
    case "calls":
      return 250;
    case "imports":
      return 240;
    default:
      return 180;
  }
}

function buildNodeLookup(nodes: DeclutterLayoutNode[]) {
  return new Map(nodes.map((node) => [node.id, resolveNodeBox(node)] as const));
}

function buildCrowdingComponents(nodes: DeclutterLayoutNode[]) {
  const lookup = buildNodeLookup(nodes);
  const nodeList = Array.from(lookup.values());
  const adjacency = new Map<string, Set<string>>();

  for (let index = 0; index < nodeList.length; index += 1) {
    const left = nodeList[index];
    for (let otherIndex = index + 1; otherIndex < nodeList.length; otherIndex += 1) {
      const right = nodeList[otherIndex];
      if (!overlapDepth(left, right, SOFT_PADDING_X, SOFT_PADDING_Y)) {
        continue;
      }

      adjacency.set(left.id, new Set([...(adjacency.get(left.id) ?? []), right.id]));
      adjacency.set(right.id, new Set([...(adjacency.get(right.id) ?? []), left.id]));
    }
  }

  const seen = new Set<string>();
  const components: string[][] = [];

  for (const node of nodeList) {
    if (seen.has(node.id) || !adjacency.has(node.id)) {
      continue;
    }

    const stack = [node.id];
    const component: string[] = [];
    seen.add(node.id);

    while (stack.length) {
      const current = stack.pop();
      if (!current) {
        continue;
      }
      component.push(current);
      for (const neighbor of adjacency.get(current) ?? []) {
        if (seen.has(neighbor)) {
          continue;
        }
        seen.add(neighbor);
        stack.push(neighbor);
      }
    }

    if (component.length) {
      components.push(component);
    }
  }

  return components;
}

function buildCrowdingReport(nodes: DeclutterLayoutNode[]): CrowdingReport {
  const lookup = buildNodeLookup(nodes);
  const nodeList = Array.from(lookup.values());
  let score = 0;
  let hardOverlapPairs = 0;
  let softCrowdingPairs = 0;

  for (let index = 0; index < nodeList.length; index += 1) {
    const left = nodeList[index];
    for (let otherIndex = index + 1; otherIndex < nodeList.length; otherIndex += 1) {
      const right = nodeList[otherIndex];
      const hard = overlapDepth(left, right);
      if (hard) {
        hardOverlapPairs += 1;
        score += 240 + hard.overlapX * hard.overlapY;
        continue;
      }

      const soft = overlapDepth(left, right, SOFT_PADDING_X, SOFT_PADDING_Y);
      if (soft) {
        softCrowdingPairs += 1;
        score += 18 + soft.overlapX * soft.overlapY * 0.08;
      }
    }
  }

  return {
    score,
    hardOverlapPairs,
    softCrowdingPairs,
  };
}

function buildNodeBoxesFromPositions(
  originals: Map<string, ResolvedNodeBox>,
  positions: Map<string, { x: number; y: number }>,
) {
  return new Map<string, ResolvedNodeBox>(
    Array.from(originals.entries()).map(([nodeId, node]) => [
      nodeId,
      {
        ...node,
        x: positions.get(nodeId)?.x ?? node.x,
        y: positions.get(nodeId)?.y ?? node.y,
      },
    ]),
  );
}

function roundPosition(value: { x: number; y: number }) {
  return {
    x: Math.round(value.x),
    y: Math.round(value.y),
  };
}

export function declutterGraphLayout(
  nodes: DeclutterLayoutNode[],
  edges: GraphEdgeDto[],
): DeclutterLayoutResult {
  const initialReport = buildCrowdingReport(nodes);
  if (initialReport.score <= 0) {
    return {
      changed: false,
      positions: Object.fromEntries(nodes.map((node) => [node.id, { x: node.x, y: node.y }])),
      movedNodeIds: [],
    };
  }

  const components = buildCrowdingComponents(nodes);
  if (!components.length) {
    return {
      changed: false,
      positions: Object.fromEntries(nodes.map((node) => [node.id, { x: node.x, y: node.y }])),
      movedNodeIds: [],
    };
  }

  const originals = buildNodeLookup(nodes);
  const positions = new Map(nodes.map((node) => [node.id, { x: node.x, y: node.y }] as const));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const relevantEdges = edges.filter(
    (edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target),
  );

  for (const component of components) {
    const movableIds = new Set(component);
    const originalPositions = new Map(
      component.map((nodeId) => {
        const current = positions.get(nodeId) ?? { x: 0, y: 0 };
        return [nodeId, { x: current.x, y: current.y }] as const;
      }),
    );

    for (let iteration = 0; iteration < ITERATION_COUNT; iteration += 1) {
      const boxes = buildNodeBoxesFromPositions(originals, positions);
      const displacement = new Map<string, { x: number; y: number }>(
        component.map((nodeId) => [nodeId, { x: 0, y: 0 }]),
      );

      for (let index = 0; index < component.length; index += 1) {
        const leftId = component[index];
        const leftBox = boxes.get(leftId);
        if (!leftBox) {
          continue;
        }

        for (let otherIndex = index + 1; otherIndex < component.length; otherIndex += 1) {
          const rightId = component[otherIndex];
          const rightBox = boxes.get(rightId);
          if (!rightBox) {
            continue;
          }

          const overlap = overlapDepth(leftBox, rightBox, SOFT_PADDING_X, SOFT_PADDING_Y);
          if (!overlap) {
            continue;
          }

          const separation = computeSeparationVector(
            leftBox,
            rightBox,
            overlap.overlapX,
            overlap.overlapY,
          );
          displacement.get(leftId)!.x -= separation.x;
          displacement.get(leftId)!.y -= separation.y;
          displacement.get(rightId)!.x += separation.x;
          displacement.get(rightId)!.y += separation.y;
        }
      }

      for (const movableId of component) {
        const movableBox = boxes.get(movableId);
        if (!movableBox) {
          continue;
        }

        for (const [anchorId, anchorBox] of boxes.entries()) {
          if (movableIds.has(anchorId)) {
            continue;
          }

          const overlap = overlapDepth(movableBox, anchorBox, SOFT_PADDING_X, SOFT_PADDING_Y);
          if (!overlap) {
            continue;
          }

          const separation = computeSeparationVector(
            movableBox,
            anchorBox,
            overlap.overlapX,
            overlap.overlapY,
          );
          displacement.get(movableId)!.x -= separation.x;
          displacement.get(movableId)!.y -= separation.y;
        }
      }

      relevantEdges.forEach((edge) => {
        if (!movableIds.has(edge.source) && !movableIds.has(edge.target)) {
          return;
        }

        const sourceBox = boxes.get(edge.source);
        const targetBox = boxes.get(edge.target);
        if (!sourceBox || !targetBox) {
          return;
        }

        const desiredGap = edgeDesiredGap(edge.kind);
        const currentGap = targetBox.x - sourceBox.x;
        if (currentGap < desiredGap) {
          const correction = Math.min((desiredGap - currentGap) * 0.22, 22);
          if (movableIds.has(edge.target)) {
            displacement.get(edge.target)!.x += correction;
          }
          if (movableIds.has(edge.source)) {
            displacement.get(edge.source)!.x -= correction * 0.7;
          }
        }

        const sourceMidY = centerY(sourceBox);
        const targetMidY = centerY(targetBox);
        const verticalCorrection = clamp((sourceMidY - targetMidY) * 0.04, 12);
        if (movableIds.has(edge.target)) {
          displacement.get(edge.target)!.y += verticalCorrection;
        }
        if (movableIds.has(edge.source) && movableIds.has(edge.target)) {
          displacement.get(edge.source)!.y -= verticalCorrection * 0.4;
        }
      });

      for (const nodeId of component) {
        const current = positions.get(nodeId);
        const origin = originalPositions.get(nodeId);
        const delta = displacement.get(nodeId);
        if (!current || !origin || !delta) {
          continue;
        }

        const next = {
          x: current.x + clamp(delta.x + (origin.x - current.x) * 0.08, MAX_STEP_X),
          y: current.y + clamp(delta.y + (origin.y - current.y) * 0.08, MAX_STEP_Y),
        };

        positions.set(nodeId, {
          x: origin.x + clamp(next.x - origin.x, MAX_TOTAL_SHIFT_X),
          y: origin.y + clamp(next.y - origin.y, MAX_TOTAL_SHIFT_Y),
        });
      }
    }
  }

  const nextNodes = nodes.map((node) => {
    const nextPosition = roundPosition(positions.get(node.id) ?? { x: node.x, y: node.y });
    return {
      ...node,
      x: nextPosition.x,
      y: nextPosition.y,
    };
  });
  const nextReport = buildCrowdingReport(nextNodes);
  const movedNodeIds = nextNodes
    .filter((node) => {
      const original = originals.get(node.id);
      return Boolean(
        original && (Math.abs(original.x - node.x) > 1 || Math.abs(original.y - node.y) > 1),
      );
    })
    .map((node) => node.id);

  if (!movedNodeIds.length || nextReport.score >= initialReport.score * 0.92) {
    return {
      changed: false,
      positions: Object.fromEntries(nodes.map((node) => [node.id, { x: node.x, y: node.y }])),
      movedNodeIds: [],
    };
  }

  return {
    changed: true,
    positions: Object.fromEntries(nextNodes.map((node) => [node.id, { x: node.x, y: node.y }])),
    movedNodeIds,
  };
}
