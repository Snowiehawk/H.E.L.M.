import { describe, expect, it, vi } from "vitest";
import type { FlowExpressionGraph } from "../../../lib/adapter";
import {
  buildExpressionContextMenuItems,
  expressionContextMenuLabel,
  type ExpressionContextMenuDeps,
} from "./contextMenu";
import type { ExpressionContextMenuState } from "./types";

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
  ],
};

function buildDeps(): ExpressionContextMenuDeps {
  return {
    addExpressionNode: vi.fn(),
    deleteExpressionEdges: vi.fn(),
    deleteExpressionNode: vi.fn(),
    expression: "a + b",
    normalizedGraph: addGraph,
    onNavigateOut: vi.fn(),
    setExpressionRoot: vi.fn(),
  };
}

describe("FlowExpressionGraphCanvas context menu", () => {
  it("builds node actions and delegates to supplied callbacks", () => {
    const deps = buildDeps();
    const menu: ExpressionContextMenuState = {
      kind: "node",
      targetId: "expr:input:a",
      x: 16,
      y: 24,
    };
    const items = buildExpressionContextMenuItems(menu, deps);

    expect(expressionContextMenuLabel(menu)).toBe("Expression node actions");
    expect(items.map((item) => item.id)).toContain("set-root");
    expect(items.map((item) => item.id)).toContain("delete-node");

    items.find((item) => item.id === "set-root")?.action();
    items.find((item) => item.id === "delete-node")?.action();
    items.find((item) => item.id === "add-call")?.action();

    expect(deps.setExpressionRoot).toHaveBeenCalledWith("expr:input:a");
    expect(deps.deleteExpressionNode).toHaveBeenCalledWith("expr:input:a");
    expect(deps.addExpressionNode).toHaveBeenCalledWith("call");
  });

  it("builds edge actions and delegates deletion by edge id", () => {
    const deps = buildDeps();
    const menu: ExpressionContextMenuState = {
      kind: "edge",
      targetId: "expr-edge:expr:input:a->expr:operator:add:left",
      x: 16,
      y: 24,
    };
    const items = buildExpressionContextMenuItems(menu, deps);

    expect(expressionContextMenuLabel(menu)).toBe("Expression edge actions");
    items.find((item) => item.id === "delete-edge")?.action();

    expect(deps.deleteExpressionEdges).toHaveBeenCalledWith([
      "expr-edge:expr:input:a->expr:operator:add:left",
    ]);
  });

  it("builds pane actions for graph creation and navigation", () => {
    const deps = buildDeps();
    const menu: ExpressionContextMenuState = { kind: "pane", x: 16, y: 24 };
    const items = buildExpressionContextMenuItems(menu, deps);

    expect(expressionContextMenuLabel(menu)).toBe("Expression graph actions");
    items.find((item) => item.id === "add-input")?.action();
    items.find((item) => item.id === "back-to-flow")?.action();

    expect(deps.addExpressionNode).toHaveBeenCalledWith("input");
    expect(deps.onNavigateOut).toHaveBeenCalled();
  });
});
