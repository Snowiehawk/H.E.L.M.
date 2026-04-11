import { describe, expect, it } from "vitest";
import type { GraphEdgeDto } from "../../lib/adapter";
import {
  organizeGroupedNodes,
  type GroupOrganizeNode,
} from "./groupOrganizeLayout";

function buildBounds(
  nodes: GroupOrganizeNode[],
  positions: Record<string, { x: number; y: number }>,
) {
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

  return {
    centerX: minX + (maxX - minX) / 2,
    centerY: minY + (maxY - minY) / 2,
  };
}

function boxesOverlap(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
) {
  return !(
    left.x + left.width <= right.x
    || right.x + right.width <= left.x
    || left.y + left.height <= right.y
    || right.y + right.height <= left.y
  );
}

describe("organizeGroupedNodes", () => {
  it("stacks nodes into a centered column using flow order first", () => {
    const nodes: GroupOrganizeNode[] = [
      {
        id: "entry",
        kind: "entry",
        x: 0,
        y: 40,
        width: 120,
        height: 70,
        metadata: { flow_order: 2 },
      },
      {
        id: "branch",
        kind: "branch",
        x: 180,
        y: 10,
        width: 160,
        height: 90,
        metadata: { flow_order: 1 },
      },
      {
        id: "return",
        kind: "return",
        x: 90,
        y: 180,
        width: 140,
        height: 64,
      },
    ];

    const result = organizeGroupedNodes({
      mode: "column",
      nodes,
      edges: [],
    });

    expect(result.changed).toBe(true);
    expect(Object.keys(result.positions).sort()).toEqual(["branch", "entry", "return"]);
    expect(result.positions.branch.y).toBeLessThan(result.positions.entry.y);
    expect(result.positions.entry.y).toBeLessThan(result.positions.return.y);
    expect(buildBounds(nodes, result.positions)).toEqual(
      buildBounds(
        nodes,
        Object.fromEntries(nodes.map((node) => [node.id, { x: node.x, y: node.y }] as const)),
      ),
    );
  });

  it("lays nodes out into a centered row using flow order first", () => {
    const nodes: GroupOrganizeNode[] = [
      {
        id: "entry",
        kind: "entry",
        x: 0,
        y: 40,
        width: 120,
        height: 70,
        metadata: { flow_order: 2 },
      },
      {
        id: "branch",
        kind: "branch",
        x: 180,
        y: 10,
        width: 160,
        height: 90,
        metadata: { flow_order: 1 },
      },
      {
        id: "return",
        kind: "return",
        x: 90,
        y: 180,
        width: 140,
        height: 64,
      },
    ];

    const result = organizeGroupedNodes({
      mode: "row",
      nodes,
      edges: [],
    });

    expect(result.changed).toBe(true);
    expect(result.positions.branch.x).toBeLessThan(result.positions.entry.x);
    expect(result.positions.entry.x).toBeLessThan(result.positions.return.x);
    expect(buildBounds(nodes, result.positions)).toEqual(
      buildBounds(
        nodes,
        Object.fromEntries(nodes.map((node) => [node.id, { x: node.x, y: node.y }] as const)),
      ),
    );
  });

  it("builds a compact aspect-aware grid", () => {
    const nodes: GroupOrganizeNode[] = [
      { id: "a", kind: "entry", x: 0, y: 0, width: 100, height: 100 },
      { id: "b", kind: "branch", x: 120, y: 0, width: 100, height: 100 },
      { id: "c", kind: "call", x: 0, y: 120, width: 100, height: 100 },
      { id: "d", kind: "return", x: 120, y: 120, width: 100, height: 100 },
    ];

    const result = organizeGroupedNodes({
      mode: "grid",
      nodes,
      edges: [],
    });

    const uniqueX = [...new Set(Object.values(result.positions).map((position) => position.x))];
    const uniqueY = [...new Set(Object.values(result.positions).map((position) => position.y))];

    expect(result.changed).toBe(true);
    expect(uniqueX).toHaveLength(2);
    expect(uniqueY).toHaveLength(2);
    expect(buildBounds(nodes, result.positions)).toEqual(
      buildBounds(
        nodes,
        Object.fromEntries(nodes.map((node) => [node.id, { x: node.x, y: node.y }] as const)),
      ),
    );
  });

  it("tidies local overlap while keeping the group centered", () => {
    const nodes: GroupOrganizeNode[] = [
      {
        id: "entry",
        kind: "entry",
        x: 0,
        y: 0,
        width: 160,
        height: 90,
      },
      {
        id: "branch",
        kind: "branch",
        x: 40,
        y: 20,
        width: 180,
        height: 110,
      },
    ];
    const edges: GraphEdgeDto[] = [
      {
        id: "controls:entry:branch",
        kind: "controls",
        source: "entry",
        target: "branch",
      },
      {
        id: "controls:branch:missing",
        kind: "controls",
        source: "branch",
        target: "missing",
      },
    ];

    const result = organizeGroupedNodes({
      mode: "tidy",
      nodes,
      edges,
    });

    expect(result.changed).toBe(true);
    expect(boxesOverlap(
      {
        x: result.positions.entry.x,
        y: result.positions.entry.y,
        width: nodes[0].width,
        height: nodes[0].height,
      },
      {
        x: result.positions.branch.x,
        y: result.positions.branch.y,
        width: nodes[1].width,
        height: nodes[1].height,
      },
    )).toBe(false);
    expect(buildBounds(nodes, result.positions)).toEqual(
      buildBounds(
        nodes,
        Object.fromEntries(nodes.map((node) => [node.id, { x: node.x, y: node.y }] as const)),
      ),
    );
  });

  it("arranges left-to-right kind lanes with stable kind ordering", () => {
    const nodes: GroupOrganizeNode[] = [
      {
        id: "branch",
        kind: "branch",
        x: 130,
        y: 0,
        width: 180,
        height: 110,
      },
      {
        id: "entry:second",
        kind: "entry",
        x: 0,
        y: 140,
        width: 140,
        height: 72,
        metadata: { flow_order: 2 },
      },
      {
        id: "entry:first",
        kind: "entry",
        x: 0,
        y: 0,
        width: 140,
        height: 72,
        metadata: { flow_order: 1 },
      },
    ];

    const result = organizeGroupedNodes({
      mode: "kind",
      nodes,
      edges: [],
    });

    expect(result.changed).toBe(true);
    expect(result.positions["entry:first"].x).toBeLessThan(result.positions.branch.x);
    expect(result.positions["entry:second"].x).toBeLessThan(result.positions.branch.x);
    expect(result.positions["entry:first"].y).toBeLessThan(result.positions["entry:second"].y);
    expect(buildBounds(nodes, result.positions)).toEqual(
      buildBounds(
        nodes,
        Object.fromEntries(nodes.map((node) => [node.id, { x: node.x, y: node.y }] as const)),
      ),
    );
  });
});
