import { describe, expect, it } from "vitest";
import type { FlowExpressionGraph } from "../../lib/adapter";
import {
  createFlowExpressionEdge,
  expressionFromFlowExpressionGraph,
} from "./flowExpressionGraph";
import { connectExpressionGraphNodes } from "./flowExpressionGraphEditing";

function extendedAddGraph(): FlowExpressionGraph {
  return {
    version: 1,
    rootId: "op:add",
    nodes: [
      { id: "input:a", kind: "input", label: "a", payload: { name: "a" } },
      { id: "input:b", kind: "input", label: "b", payload: { name: "b" } },
      { id: "input:c", kind: "input", label: "c", payload: { name: "c" } },
      { id: "input:d", kind: "input", label: "d", payload: { name: "d" } },
      { id: "op:add", kind: "operator", label: "+", payload: { operator: "+" } },
      { id: "op:outer", kind: "operator", label: "+", payload: { operator: "+" } },
    ],
    edges: [
      createFlowExpressionEdge("input:a", "op:add", "left"),
      createFlowExpressionEdge("input:b", "op:add", "right"),
    ],
  };
}

describe("flowExpressionGraphEditing", () => {
  it("promotes a newly connected terminal operator to the expression root", () => {
    const graph = extendedAddGraph();

    const withOuterLeft = connectExpressionGraphNodes(graph, "op:add", "op:outer", "left");
    expect(withOuterLeft.rootId).toBe("op:outer");
    expect(expressionFromFlowExpressionGraph(withOuterLeft)).toEqual({
      diagnostics: ["+ needs one right input."],
      expression: "",
    });

    const withOuterRight = connectExpressionGraphNodes(withOuterLeft, "input:c", "op:outer", "right");
    expect(withOuterRight.rootId).toBe("op:outer");
    expect(expressionFromFlowExpressionGraph(withOuterRight)).toEqual({
      diagnostics: [],
      expression: "a + b + c",
    });
  });

  it("keeps the current root when reconnecting an upstream non-terminal node", () => {
    const graph = connectExpressionGraphNodes(
      connectExpressionGraphNodes(extendedAddGraph(), "op:add", "op:outer", "left"),
      "input:c",
      "op:outer",
      "right",
    );

    const updatedInnerAdd = connectExpressionGraphNodes(graph, "input:d", "op:add", "left");

    expect(updatedInnerAdd.rootId).toBe("op:outer");
    expect(expressionFromFlowExpressionGraph(updatedInnerAdd)).toEqual({
      diagnostics: [],
      expression: "d + b + c",
    });
  });
});
