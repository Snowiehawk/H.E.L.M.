import { describe, expect, it } from "vitest";
import type { GraphEdgeDto } from "../../lib/adapter";
import { declutterGraphLayout, type DeclutterLayoutNode } from "./declutterLayout";

function boxesOverlap(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
) {
  return !(
    left.x + left.width <= right.x ||
    right.x + right.width <= left.x ||
    left.y + left.height <= right.y ||
    right.y + right.height <= left.y
  );
}

describe("declutterGraphLayout", () => {
  it("separates overlapping nodes beyond direct overlap", () => {
    const nodes: DeclutterLayoutNode[] = [
      {
        id: "branch:a",
        kind: "branch",
        x: 120,
        y: 120,
        width: 280,
        height: 110,
      },
      {
        id: "branch:b",
        kind: "branch",
        x: 170,
        y: 150,
        width: 280,
        height: 110,
      },
    ];

    const result = declutterGraphLayout(nodes, []);

    expect(result.changed).toBe(true);
    const left = {
      x: result.positions["branch:a"].x,
      y: result.positions["branch:a"].y,
      width: nodes[0].width ?? 0,
      height: nodes[0].height ?? 0,
    };
    const right = {
      x: result.positions["branch:b"].x,
      y: result.positions["branch:b"].y,
      width: nodes[1].width ?? 0,
      height: nodes[1].height ?? 0,
    };
    expect(boxesOverlap(left, right)).toBe(false);
  });

  it("leaves already-spaced layouts alone", () => {
    const nodes: DeclutterLayoutNode[] = [
      {
        id: "entry",
        kind: "entry",
        x: 0,
        y: 120,
        width: 190,
        height: 94,
      },
      {
        id: "return",
        kind: "return",
        x: 420,
        y: 120,
        width: 240,
        height: 96,
      },
    ];

    const result = declutterGraphLayout(nodes, []);

    expect(result.changed).toBe(false);
    expect(result.movedNodeIds).toEqual([]);
    expect(result.positions).toEqual({
      entry: { x: 0, y: 120 },
      return: { x: 420, y: 120 },
    });
  });

  it("preserves anchor nodes outside the crowded cluster", () => {
    const nodes: DeclutterLayoutNode[] = [
      {
        id: "return:left",
        kind: "return",
        x: 220,
        y: 220,
        width: 240,
        height: 96,
      },
      {
        id: "return:right",
        kind: "return",
        x: 260,
        y: 235,
        width: 240,
        height: 96,
      },
      {
        id: "entry:anchor",
        kind: "entry",
        x: 0,
        y: 0,
        width: 190,
        height: 94,
      },
    ];

    const result = declutterGraphLayout(nodes, []);

    expect(result.changed).toBe(true);
    expect(result.positions["entry:anchor"]).toEqual({ x: 0, y: 0 });
  });

  it("keeps connected targets flowing left-to-right after declutter", () => {
    const nodes: DeclutterLayoutNode[] = [
      {
        id: "entry",
        kind: "entry",
        x: 0,
        y: 120,
        width: 190,
        height: 94,
      },
      {
        id: "branch",
        kind: "branch",
        x: 40,
        y: 126,
        width: 280,
        height: 110,
      },
      {
        id: "return",
        kind: "return",
        x: 60,
        y: 130,
        width: 240,
        height: 96,
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
        id: "controls:branch:return",
        kind: "controls",
        source: "branch",
        target: "return",
      },
    ];

    const result = declutterGraphLayout(nodes, edges);

    expect(result.changed).toBe(true);
    expect(result.positions.branch.x).toBeGreaterThan(result.positions.entry.x);
    expect(result.positions.return.x).toBeGreaterThan(result.positions.branch.x);
  });
});
