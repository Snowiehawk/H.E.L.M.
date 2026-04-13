import { describe, expect, it } from "vitest";
import type { GraphEdgeDto } from "../../lib/adapter";
import { layoutFlowGraph, type FlowLayoutNode } from "./flowLayout";

function rightEdge(node: FlowLayoutNode, x: number) {
  return x + (node.width ?? 0);
}

function bottomEdge(node: FlowLayoutNode, y: number) {
  return y + (node.height ?? 0);
}

describe("layoutFlowGraph", () => {
  it("lays out straight-line flow deterministically from left to right", () => {
    const nodes: FlowLayoutNode[] = [
      { id: "entry", kind: "entry", x: 0, y: 0, width: 190, height: 94, metadata: { flow_order: 0 } },
      { id: "assign", kind: "assign", x: 20, y: 0, width: 280, height: 98, metadata: { flow_order: 1 } },
      { id: "call", kind: "call", x: 40, y: 0, width: 300, height: 102, metadata: { flow_order: 2 } },
      { id: "return", kind: "return", x: 60, y: 0, width: 240, height: 96, metadata: { flow_order: 3 } },
    ];
    const edges: GraphEdgeDto[] = [
      { id: "controls:entry-assign", kind: "controls", source: "entry", target: "assign" },
      { id: "controls:assign-call", kind: "controls", source: "assign", target: "call" },
      { id: "controls:call-return", kind: "controls", source: "call", target: "return" },
    ];

    const first = layoutFlowGraph(nodes, edges);
    const second = layoutFlowGraph(nodes, edges);

    expect(first.positions.entry.x).toBeLessThan(first.positions.assign.x);
    expect(first.positions.assign.x).toBeLessThan(first.positions.call.x);
    expect(first.positions.call.x).toBeLessThan(first.positions.return.x);
    expect(first.positions.assign.x - rightEdge(nodes[0]!, first.positions.entry.x)).toBeGreaterThanOrEqual(160);
    expect(first.positions.call.x - rightEdge(nodes[1]!, first.positions.assign.x)).toBeGreaterThanOrEqual(160);
    expect(first.positions.return.x - rightEdge(nodes[2]!, first.positions.call.x)).toBeGreaterThanOrEqual(160);
    expect(first.positions).toEqual(second.positions);
  });

  it("places true branches above false branches and merges back toward the spine", () => {
    const nodes: FlowLayoutNode[] = [
      { id: "entry", kind: "entry", x: 0, y: 0, width: 190, height: 94, metadata: { flow_order: 0 } },
      { id: "branch", kind: "branch", x: 0, y: 0, width: 280, height: 110, metadata: { flow_order: 1 } },
      { id: "true-node", kind: "assign", x: 0, y: 0, width: 240, height: 98, metadata: { flow_order: 2 } },
      { id: "false-node", kind: "assign", x: 0, y: 0, width: 240, height: 98, metadata: { flow_order: 3 } },
      { id: "merge", kind: "return", x: 0, y: 0, width: 240, height: 96, metadata: { flow_order: 4 } },
    ];
    const edges: GraphEdgeDto[] = [
      { id: "controls:entry-branch", kind: "controls", source: "entry", target: "branch" },
      {
        id: "controls:branch-true:true",
        kind: "controls",
        source: "branch",
        target: "true-node",
        label: "true",
        metadata: { path_key: "true", path_label: "true", path_order: 0 },
      },
      {
        id: "controls:branch-false:false",
        kind: "controls",
        source: "branch",
        target: "false-node",
        label: "false",
        metadata: { path_key: "false", path_label: "false", path_order: 1 },
      },
      { id: "controls:true-merge", kind: "controls", source: "true-node", target: "merge" },
      { id: "controls:false-merge", kind: "controls", source: "false-node", target: "merge" },
    ];

    const result = layoutFlowGraph(nodes, edges);

    expect(result.positions["true-node"].y).toBeLessThan(result.positions["false-node"].y);
    expect(result.positions.merge.x).toBeGreaterThan(result.positions.branch.x);
    expect(Math.abs(result.positions.merge.y - result.positions.branch.y)).toBeLessThan(
      Math.abs(result.positions["true-node"].y - result.positions.branch.y),
    );
    expect(
      bottomEdge(nodes[2]!, result.positions["true-node"].y) + 60,
    ).toBeLessThanOrEqual(result.positions["false-node"].y);
  });

  it("places loop bodies above exits and returns to the main spine after the loop", () => {
    const nodes: FlowLayoutNode[] = [
      { id: "entry", kind: "entry", x: 0, y: 0, metadata: { flow_order: 0 } },
      { id: "loop", kind: "loop", x: 0, y: 0, metadata: { flow_order: 1 } },
      { id: "body", kind: "assign", x: 0, y: 0, metadata: { flow_order: 2 } },
      { id: "after", kind: "return", x: 0, y: 0, metadata: { flow_order: 3 } },
    ];
    const edges: GraphEdgeDto[] = [
      { id: "controls:entry-loop", kind: "controls", source: "entry", target: "loop" },
      {
        id: "controls:loop-body:body",
        kind: "controls",
        source: "loop",
        target: "body",
        label: "body",
        metadata: { path_key: "body", path_label: "body", path_order: 0 },
      },
      {
        id: "controls:loop-after:exit",
        kind: "controls",
        source: "loop",
        target: "after",
        label: "exit",
        metadata: { path_key: "exit", path_label: "exit", path_order: 1 },
      },
      { id: "controls:body-loop", kind: "controls", source: "body", target: "loop" },
    ];

    const result = layoutFlowGraph(nodes, edges);

    expect(result.positions.body.y).toBeLessThan(result.positions.after.y);
    expect(result.positions.after.x).toBeGreaterThan(result.positions.loop.x);
  });

  it("keeps inputs above the control spine and supporting outputs below it", () => {
    const nodes: FlowLayoutNode[] = [
      { id: "entry", kind: "entry", x: 0, y: 0, width: 190, height: 94, metadata: { flow_order: 0 } },
      { id: "call", kind: "call", x: 0, y: 0, width: 280, height: 102, metadata: { flow_order: 1 } },
      { id: "return", kind: "return", x: 0, y: 0, width: 240, height: 96, metadata: { flow_order: 2 } },
      { id: "flag", kind: "param", x: 0, y: 0, width: 220, height: 92 },
      { id: "helper", kind: "function", x: 0, y: 0, width: 300, height: 120 },
    ];
    const edges: GraphEdgeDto[] = [
      { id: "controls:entry-call", kind: "controls", source: "entry", target: "call" },
      { id: "controls:call-return", kind: "controls", source: "call", target: "return" },
      { id: "data:flag-call", kind: "data", source: "flag", target: "call", label: "flag" },
      { id: "calls:call-helper", kind: "calls", source: "call", target: "helper", label: "helper" },
    ];

    const result = layoutFlowGraph(nodes, edges);

    expect(result.positions.flag.y).toBeLessThan(result.positions.call.y);
    expect(result.positions.helper.y).toBeGreaterThan(result.positions.call.y);
    expect(
      bottomEdge(nodes[3]!, result.positions.flag.y) + 120,
    ).toBeLessThanOrEqual(result.positions.call.y);
    expect(
      bottomEdge(nodes[1]!, result.positions.call.y) + 120,
    ).toBeLessThanOrEqual(result.positions.helper.y);
  });
});
