import { MarkerType } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import type { FlowExpressionGraph } from "../../../lib/adapter";
import {
  expressionEdgesForGraph,
  expressionNodesForGraph,
  selectedNodeTargetHandles,
  targetHandleForConnection,
} from "./projection";

const addGraph: FlowExpressionGraph = {
  version: 1,
  rootId: "expr:operator:add",
  nodes: [
    {
      id: "expr:input:a",
      kind: "input",
      label: "a",
      payload: { name: "a", slot_id: "slot:a" },
    },
    {
      id: "expr:input:b",
      kind: "input",
      label: "b",
      payload: { name: "b", slot_id: "slot:b" },
    },
    {
      id: "expr:operator:add",
      kind: "operator",
      label: "+",
      payload: { operator: "+" },
    },
  ],
  edges: [
    {
      id: "expr-edge:expr:input:a->expr:operator:add:left",
      sourceId: "expr:input:a",
      sourceHandle: "value",
      targetId: "expr:operator:add",
      targetHandle: "left",
    },
    {
      id: "expr-edge:expr:input:b->expr:operator:add:right",
      sourceId: "expr:input:b",
      sourceHandle: "value",
      targetId: "expr:operator:add",
      targetHandle: "right",
    },
  ],
};

describe("FlowExpressionGraphCanvas projection", () => {
  it("projects expression graph nodes with root, selection, and target handle metadata", () => {
    const nodes = expressionNodesForGraph(addGraph, "expr:input:a");
    const inputNode = nodes.find((node) => node.id === "expr:input:a");
    const operatorNode = nodes.find((node) => node.id === "expr:operator:add");

    expect(inputNode).toMatchObject({
      type: "expression",
      selected: true,
      data: { isRoot: false },
    });
    expect(operatorNode).toMatchObject({
      type: "expression",
      selected: false,
      data: { isRoot: true },
    });
    expect(operatorNode?.data.targetHandles.map((handle) => handle.id)).toEqual(["left", "right"]);
  });

  it("projects expression graph edges with reconnectable smoothstep metadata", () => {
    const edges = expressionEdgesForGraph(
      addGraph,
      "expr-edge:expr:input:b->expr:operator:add:right",
    );

    expect(edges[1]).toMatchObject({
      id: "expr-edge:expr:input:b->expr:operator:add:right",
      type: "smoothstep",
      source: "expr:input:b",
      sourceHandle: "value",
      target: "expr:operator:add",
      targetHandle: "right",
      selected: true,
      reconnectable: true,
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: "var(--accent-strong)",
      },
      className: "flow-expression-canvas__edge",
    });
  });

  it("resolves selected-node and connection target handles from the graph", () => {
    const operatorNode = addGraph.nodes.find((node) => node.id === "expr:operator:add");

    expect(selectedNodeTargetHandles(addGraph, operatorNode).map((handle) => handle.id)).toEqual([
      "left",
      "right",
    ]);
    expect(
      targetHandleForConnection(addGraph, {
        target: "expr:operator:add",
        targetHandle: "left",
      })?.label,
    ).toBe("L");
    expect(
      targetHandleForConnection(addGraph, {
        target: "expr:operator:add",
        targetHandle: "missing",
      }),
    ).toBeUndefined();
  });
});
