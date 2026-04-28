import { describe, expect, it } from "vitest";
import type { FlowExpressionGraph } from "../../lib/adapter";
import { createFlowExpressionEdge, expressionFromFlowExpressionGraph } from "./flowExpressionGraph";

describe("flowExpressionGraph", () => {
  it("compiles an editable operator graph back into expression source", () => {
    const graph: FlowExpressionGraph = {
      version: 1,
      rootId: "op:add",
      nodes: [
        { id: "input:a", kind: "input", label: "a", payload: { name: "a" } },
        { id: "input:b", kind: "input", label: "b", payload: { name: "b" } },
        { id: "op:add", kind: "operator", label: "+", payload: { operator: "+" } },
      ],
      edges: [
        createFlowExpressionEdge("input:a", "op:add", "left"),
        createFlowExpressionEdge("input:b", "op:add", "right"),
      ],
    };

    expect(expressionFromFlowExpressionGraph(graph)).toEqual({
      diagnostics: [],
      expression: "a + b",
    });
  });

  it("reports graph-side diagnostics for missing required inputs", () => {
    const graph: FlowExpressionGraph = {
      version: 1,
      rootId: "op:add",
      nodes: [
        { id: "input:a", kind: "input", label: "a", payload: { name: "a" } },
        { id: "op:add", kind: "operator", label: "+", payload: { operator: "+" } },
      ],
      edges: [createFlowExpressionEdge("input:a", "op:add", "left")],
    };

    expect(expressionFromFlowExpressionGraph(graph)).toEqual({
      diagnostics: ["+ needs one right input."],
      expression: "",
    });
  });

  it("recovers the terminal expression when a stale root is still connected upstream", () => {
    const graph: FlowExpressionGraph = {
      version: 1,
      rootId: "input:c",
      nodes: [
        { id: "input:a", kind: "input", label: "a", payload: { name: "a" } },
        { id: "input:b", kind: "input", label: "b", payload: { name: "b" } },
        { id: "input:c", kind: "input", label: "c", payload: { name: "c" } },
        { id: "op:inner", kind: "operator", label: "+", payload: { operator: "+" } },
        { id: "op:outer", kind: "operator", label: "+", payload: { operator: "+" } },
      ],
      edges: [
        createFlowExpressionEdge("input:a", "op:inner", "left"),
        createFlowExpressionEdge("input:b", "op:inner", "right"),
        createFlowExpressionEdge("op:inner", "op:outer", "left"),
        createFlowExpressionEdge("input:c", "op:outer", "right"),
      ],
    };

    expect(expressionFromFlowExpressionGraph(graph)).toEqual({
      diagnostics: [],
      expression: "a + b + c",
    });
  });
});
