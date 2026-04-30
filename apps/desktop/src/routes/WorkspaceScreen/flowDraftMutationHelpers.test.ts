import { describe, expect, it } from "vitest";
import type { FlowGraphDocument } from "../../lib/adapter";
import type { AuthoredFlowNode, AuthoredFlowNodeKind } from "../../components/graph/flowDocument";
import {
  applyFlowConnectionMutation,
  createAuthoredFlowNodeMutation,
  deleteFlowSelectionMutation,
  removeFlowFunctionInputsMutation,
} from "./flowDraftMutationHelpers";

function flowDocument(partial: Partial<FlowGraphDocument> = {}): FlowGraphDocument {
  return {
    symbolId: "symbol:pkg.mod:run",
    relativePath: "pkg/mod.py",
    qualname: "run",
    nodes: [
      { id: "entry", kind: "entry", payload: {} },
      { id: "return", kind: "return", payload: { expression: "value" } },
    ],
    edges: [],
    functionInputs: [],
    valueSources: [],
    inputSlots: [],
    inputBindings: [],
    syncState: "clean",
    diagnostics: [],
    editable: true,
    ...partial,
  };
}

function nodeFactory(ids: string[]) {
  return (_symbolId: string, kind: AuthoredFlowNodeKind): AuthoredFlowNode => ({
    id: ids.shift() ?? `node-${kind}`,
    kind,
    payload: {},
    indexedNodeId: null,
  });
}

describe("flowDraftMutationHelpers", () => {
  it("builds inserted flow nodes with seeded layout positions", () => {
    const document = flowDocument({
      nodes: [
        { id: "entry", kind: "entry", payload: {} },
        { id: "loop", kind: "loop", payload: { header: "while ready" } },
        { id: "after-loop", kind: "call", payload: { source: "done()" } },
      ],
      edges: [
        {
          id: "edge-loop-body",
          sourceId: "loop",
          sourceHandle: "body",
          targetId: "after-loop",
          targetHandle: "in",
        },
      ],
    });

    const result = createAuthoredFlowNodeMutation({
      content: "value = compute()",
      createNode: nodeFactory(["created", "starter"]),
      document,
      flowNodeKind: "assign",
      position: { x: 10, y: 20 },
      seedFlowConnection: {
        sourceNodeId: "loop",
        sourceHandle: "body",
        label: "Repeat",
      },
      symbolId: document.symbolId,
    });

    expect(result.createdNodeId).toBe("created");
    expect(result.seededNodes).toEqual([
      { nodeId: "created", kind: "assign", position: { x: 10, y: 20 } },
    ]);
    expect(result.document.edges.map((edge) => edge.id)).not.toContain("edge-loop-body");
    expect(result.document.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: "loop",
          sourceHandle: "body",
          targetId: "created",
          targetHandle: "in",
        }),
        expect.objectContaining({
          sourceId: "created",
          sourceHandle: "next",
          targetId: "after-loop",
          targetHandle: "in",
        }),
      ]),
    );
  });

  it("deletes selected flow nodes and separates control edges from data bindings", () => {
    const document = flowDocument({
      nodes: [
        { id: "entry", kind: "entry", payload: {} },
        { id: "assign", kind: "assign", payload: { source: "value = 1" } },
        { id: "return", kind: "return", payload: { expression: "value" } },
      ],
      edges: [
        {
          id: "entry-to-assign",
          sourceId: "entry",
          sourceHandle: "next",
          targetId: "assign",
          targetHandle: "in",
        },
        {
          id: "assign-to-return",
          sourceId: "assign",
          sourceHandle: "next",
          targetId: "return",
          targetHandle: "in",
        },
      ],
      valueSources: [{ id: "source-assign", nodeId: "assign", name: "value", label: "value" }],
      inputSlots: [
        { id: "slot-return", nodeId: "return", slotKey: "value", label: "value", required: true },
      ],
      inputBindings: [{ id: "binding", sourceId: "source-assign", slotId: "slot-return" }],
    });

    const nextDocument = deleteFlowSelectionMutation(
      document,
      {
        nodeIds: ["assign"],
        edgeIds: ["data:binding"],
      },
      [],
    );

    expect(nextDocument.nodes.map((node) => node.id)).toEqual(["entry", "return"]);
    expect(nextDocument.edges).toEqual([]);
    expect(nextDocument.valueSources).toEqual([]);
    expect(nextDocument.inputBindings).toEqual([]);
  });

  it("removes function inputs and downstream slots while preserving remaining input order", () => {
    const document = flowDocument({
      functionInputs: [
        { id: "input-a", name: "alpha", index: 0, defaultExpression: null },
        { id: "input-b", name: "beta", index: 1, defaultExpression: null },
      ],
      inputSlots: [
        { id: "slot-alpha", nodeId: "return", slotKey: "alpha", label: "alpha", required: true },
      ],
      inputBindings: [
        {
          id: "binding-alpha",
          sourceId: "input-a",
          functionInputId: "input-a",
          slotId: "slot-alpha",
        },
      ],
    });

    const nextDocument = removeFlowFunctionInputsMutation(document, ["input-a"]);

    expect(nextDocument.functionInputs).toEqual([
      { id: "input-b", name: "beta", index: 0, defaultExpression: null },
    ]);
    expect(nextDocument.inputSlots).toEqual([]);
    expect(nextDocument.inputBindings).toEqual([]);
  });

  it("validates and applies return input binding connections", () => {
    const document = flowDocument({
      functionInputs: [{ id: "input-a", name: "alpha", index: 0, defaultExpression: null }],
    });

    const invalid = applyFlowConnectionMutation({
      connectionIntent: {
        sourceId: "param-node",
        sourceHandle: "out:data:function-input:missing",
        targetId: "return",
        targetHandle: "in:data:return-input:return",
      },
      document,
      graphNodes: undefined,
    });
    expect(invalid).toEqual({
      status: "invalid",
      message: "Unable to find the selected value source.",
    });

    const valid = applyFlowConnectionMutation({
      connectionIntent: {
        sourceId: "param-node",
        sourceHandle: "out:data:function-input:input-a",
        targetId: "return",
        targetHandle: "in:data:return-input:return",
      },
      document,
      graphNodes: undefined,
    });

    expect(valid.status).toBe("changed");
    if (valid.status !== "changed") {
      return;
    }
    expect(valid.connectionKind).toBe("input-binding");
    expect(valid.document.inputSlots).toEqual([
      expect.objectContaining({
        nodeId: "return",
        label: "alpha",
      }),
    ]);
    expect(valid.document.inputBindings).toEqual([
      expect.objectContaining({
        sourceId: "input-a",
      }),
    ]);
  });
});
