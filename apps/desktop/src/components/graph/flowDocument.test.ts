import { describe, expect, it } from "vitest";
import type { FlowGraphDocument } from "../../lib/adapter";
import type { AuthoredFlowNode } from "./flowDocument";
import {
  addDisconnectedFlowNode,
  isFlowDocumentNodeKind,
  isFlowNodeAuthorableKind,
  removeFlowEdges,
  removeFlowInputBindings,
  removeFlowNodes,
  flowReturnCompletionEdgeId,
  upsertFlowInputBinding,
  upsertFlowConnection,
  validateFlowConnection,
  validateFlowInputBindingConnection,
} from "./flowDocument";

const baseDocument: FlowGraphDocument = {
  symbolId: "symbol:workflow:run",
  relativePath: "workflow.py",
  qualname: "workflow.run",
  editable: true,
  syncState: "clean",
  diagnostics: [],
  sourceHash: null,
  nodes: [
    { id: "flowdoc:symbol:workflow:run:entry", kind: "entry", payload: {} },
    { id: "flowdoc:symbol:workflow:run:call:0", kind: "call", payload: { source: "prepare()" } },
    { id: "flowdoc:symbol:workflow:run:exit", kind: "exit", payload: {} },
  ],
  edges: [
    {
      id: "controls:flowdoc:symbol:workflow:run:entry:start->flowdoc:symbol:workflow:run:call:0:in",
      sourceId: "flowdoc:symbol:workflow:run:entry",
      sourceHandle: "start",
      targetId: "flowdoc:symbol:workflow:run:call:0",
      targetHandle: "in",
    },
    {
      id: "controls:flowdoc:symbol:workflow:run:call:0:next->flowdoc:symbol:workflow:run:exit:in",
      sourceId: "flowdoc:symbol:workflow:run:call:0",
      sourceHandle: "next",
      targetId: "flowdoc:symbol:workflow:run:exit",
      targetHandle: "in",
    },
  ],
};

describe("flowDocument logical helpers", () => {
  it("treats parameter nodes as visual support nodes instead of authored document nodes", () => {
    expect(isFlowDocumentNodeKind("assign")).toBe(true);
    expect(isFlowNodeAuthorableKind("assign")).toBe(true);
    expect(isFlowDocumentNodeKind("param")).toBe(false);
    expect(isFlowNodeAuthorableKind("param")).toBe(false);
  });

  it("adds a disconnected node without mutating existing edges", () => {
    const node: AuthoredFlowNode = {
      id: "flowdoc:symbol:workflow:run:assign:1",
      kind: "assign",
      payload: { source: "result = prepare()" },
    };

    const result = addDisconnectedFlowNode(baseDocument, node);

    expect(result.nodes.map((candidate) => candidate.id)).toContain(node.id);
    expect(result.edges).toEqual(baseDocument.edges);
  });

  it("validates control-flow connections before mutating the logical document", () => {
    expect(validateFlowConnection(baseDocument, {
      sourceId: "flowdoc:symbol:workflow:run:entry",
      sourceHandle: "start",
      targetId: "flowdoc:symbol:workflow:run:exit",
      targetHandle: "in",
    })).toEqual({
      ok: false,
      message: "That control output is already connected.",
    });

    expect(validateFlowConnection(baseDocument, {
      sourceId: "flowdoc:symbol:workflow:run:call:0",
      sourceHandle: "next",
      targetId: "flowdoc:symbol:workflow:run:call:0",
      targetHandle: "in",
    })).toEqual({
      ok: false,
      message: "Flow nodes cannot connect back into themselves.",
    });

    const unchanged = upsertFlowConnection(baseDocument, {
      sourceId: "flowdoc:symbol:workflow:run:entry",
      sourceHandle: "start",
      targetId: "flowdoc:symbol:workflow:run:exit",
      targetHandle: "in",
    });
    expect(unchanged).toEqual(baseDocument);

    const reconnected = upsertFlowConnection(
      baseDocument,
      {
        sourceId: "flowdoc:symbol:workflow:run:entry",
        sourceHandle: "start",
        targetId: "flowdoc:symbol:workflow:run:exit",
        targetHandle: "in",
      },
      "controls:flowdoc:symbol:workflow:run:entry:start->flowdoc:symbol:workflow:run:call:0:in",
    );

    expect(reconnected.edges).toEqual([
      {
        id: "controls:flowdoc:symbol:workflow:run:call:0:next->flowdoc:symbol:workflow:run:exit:in",
        sourceId: "flowdoc:symbol:workflow:run:call:0",
        sourceHandle: "next",
        targetId: "flowdoc:symbol:workflow:run:exit",
        targetHandle: "in",
      },
      {
        id: "controls:flowdoc:symbol:workflow:run:entry:start->flowdoc:symbol:workflow:run:exit:in",
        sourceId: "flowdoc:symbol:workflow:run:entry",
        sourceHandle: "start",
        targetId: "flowdoc:symbol:workflow:run:exit",
        targetHandle: "in",
      },
    ]);
  });

  it("keeps return completion edges derived instead of authorable", () => {
    const returnDocument: FlowGraphDocument = {
      ...baseDocument,
      nodes: [
        { id: "flowdoc:symbol:workflow:run:entry", kind: "entry", payload: {} },
        { id: "flowdoc:symbol:workflow:run:return:0", kind: "return", payload: { expression: "value" } },
        { id: "flowdoc:symbol:workflow:run:exit", kind: "exit", payload: {} },
      ],
      edges: [
        {
          id: "controls:flowdoc:symbol:workflow:run:entry:start->flowdoc:symbol:workflow:run:return:0:in",
          sourceId: "flowdoc:symbol:workflow:run:entry",
          sourceHandle: "start",
          targetId: "flowdoc:symbol:workflow:run:return:0",
          targetHandle: "in",
        },
      ],
    };
    const completionEdgeId = flowReturnCompletionEdgeId(
      "flowdoc:symbol:workflow:run:return:0",
      "flowdoc:symbol:workflow:run:exit",
    );

    expect(validateFlowConnection(returnDocument, {
      sourceId: "flowdoc:symbol:workflow:run:return:0",
      sourceHandle: "exit",
      targetId: "flowdoc:symbol:workflow:run:exit",
      targetHandle: "in",
    })).toEqual({
      ok: false,
      message: "That control output is not available for the selected source node.",
    });
    expect(removeFlowEdges(returnDocument, [completionEdgeId])).toEqual(returnDocument);
  });

  it("removes selected authored nodes and control edges while protecting entry nodes", () => {
    const withoutNode = removeFlowNodes(baseDocument, [
      "flowdoc:symbol:workflow:run:call:0",
      "flowdoc:symbol:workflow:run:entry",
    ]);

    expect(withoutNode.nodes.map((node) => node.id)).toEqual([
      "flowdoc:symbol:workflow:run:entry",
      "flowdoc:symbol:workflow:run:exit",
    ]);
    expect(withoutNode.edges).toEqual([]);

    const withoutEdge = removeFlowEdges(baseDocument, [
      "controls:flowdoc:symbol:workflow:run:call:0:next->flowdoc:symbol:workflow:run:exit:in",
    ]);

    expect(withoutEdge.edges).toEqual([
      {
        id: "controls:flowdoc:symbol:workflow:run:entry:start->flowdoc:symbol:workflow:run:call:0:in",
        sourceId: "flowdoc:symbol:workflow:run:entry",
        sourceHandle: "start",
        targetId: "flowdoc:symbol:workflow:run:call:0",
        targetHandle: "in",
      },
    ]);
  });

  it("does not delete unsupported support nodes even if they are forced into a draft payload", () => {
    const documentWithSupportNode = {
      ...baseDocument,
      nodes: [
        ...baseDocument.nodes,
        { id: "flow:symbol:workflow:run:param:value", kind: "param", payload: {} },
      ],
    } as FlowGraphDocument;

    const result = removeFlowNodes(documentWithSupportNode, ["flow:symbol:workflow:run:param:value"]);

    expect(result.nodes.map((node) => node.id)).toContain("flow:symbol:workflow:run:param:value");
  });

  it("updates one canonical function-input binding without touching siblings for the same input", () => {
    const document: FlowGraphDocument = {
      ...baseDocument,
      nodes: [
        { id: "flowdoc:symbol:workflow:run:entry", kind: "entry", payload: {} },
        { id: "flowdoc:symbol:workflow:run:assign:0", kind: "assign", payload: { source: "x = a" } },
        { id: "flowdoc:symbol:workflow:run:return:1", kind: "return", payload: { expression: "a" } },
        { id: "flowdoc:symbol:workflow:run:exit", kind: "exit", payload: {} },
      ],
      functionInputs: [
        { id: "flowinput:symbol:workflow:run:a", name: "a", index: 0 },
        { id: "flowinput:symbol:workflow:run:b", name: "b", index: 1 },
      ],
      inputSlots: [
        {
          id: "flowslot:flow:symbol:workflow:run:statement:0:a",
          nodeId: "flowdoc:symbol:workflow:run:assign:0",
          slotKey: "a",
          label: "a",
          required: true,
        },
        {
          id: "flowslot:flow:symbol:workflow:run:statement:1:a",
          nodeId: "flowdoc:symbol:workflow:run:return:1",
          slotKey: "a",
          label: "a",
          required: true,
        },
      ],
      inputBindings: [
        {
          id: "flowbinding:flowslot:flow:symbol:workflow:run:statement:0:a->flowinput:symbol:workflow:run:a",
          slotId: "flowslot:flow:symbol:workflow:run:statement:0:a",
          sourceId: "flowinput:symbol:workflow:run:a",
          functionInputId: "flowinput:symbol:workflow:run:a",
        },
        {
          id: "flowbinding:flowslot:flow:symbol:workflow:run:statement:1:a->flowinput:symbol:workflow:run:a",
          slotId: "flowslot:flow:symbol:workflow:run:statement:1:a",
          sourceId: "flowinput:symbol:workflow:run:a",
          functionInputId: "flowinput:symbol:workflow:run:a",
        },
      ],
    };

    expect(validateFlowInputBindingConnection(document, {
      sourceId: "flowinput:symbol:workflow:run:b",
      slotId: "flowslot:flow:symbol:workflow:run:statement:0:a",
    })).toEqual({ ok: true });

    const withoutAssignBinding = removeFlowInputBindings(document, [
      "flowbinding:flowslot:flow:symbol:workflow:run:statement:0:a->flowinput:symbol:workflow:run:a",
    ]);

    expect(withoutAssignBinding.inputBindings).toEqual([
      {
        id: "flowbinding:flowslot:flow:symbol:workflow:run:statement:1:a->flowinput:symbol:workflow:run:a",
        slotId: "flowslot:flow:symbol:workflow:run:statement:1:a",
        sourceId: "flowinput:symbol:workflow:run:a",
        functionInputId: "flowinput:symbol:workflow:run:a",
      },
    ]);

    const reconnected = upsertFlowInputBinding(withoutAssignBinding, {
      sourceId: "flowinput:symbol:workflow:run:b",
      slotId: "flowslot:flow:symbol:workflow:run:statement:0:a",
    });

    expect(reconnected.inputBindings).toEqual([
      {
        id: "flowbinding:flowslot:flow:symbol:workflow:run:statement:1:a->flowinput:symbol:workflow:run:a",
        slotId: "flowslot:flow:symbol:workflow:run:statement:1:a",
        sourceId: "flowinput:symbol:workflow:run:a",
        functionInputId: "flowinput:symbol:workflow:run:a",
      },
      {
        id: "flowbinding:flowslot:flow:symbol:workflow:run:statement:0:a->flowinput:symbol:workflow:run:b",
        slotId: "flowslot:flow:symbol:workflow:run:statement:0:a",
        sourceId: "flowinput:symbol:workflow:run:b",
        functionInputId: "flowinput:symbol:workflow:run:b",
      },
    ]);
  });

  it("updates and deletes local value-source bindings independently of control edges", () => {
    const sourceId = "flowsource:flow:symbol:workflow:run:statement:0:current";
    const slotId = "flowslot:flow:symbol:workflow:run:statement:1:current";
    const document: FlowGraphDocument = {
      ...baseDocument,
      nodes: [
        { id: "flowdoc:symbol:workflow:run:entry", kind: "entry", payload: {} },
        { id: "flowdoc:symbol:workflow:run:assign:0", kind: "assign", payload: { source: "current = prepare()" } },
        { id: "flowdoc:symbol:workflow:run:return:1", kind: "return", payload: { expression: "current" } },
        { id: "flowdoc:symbol:workflow:run:exit", kind: "exit", payload: {} },
      ],
      valueSources: [
        {
          id: sourceId,
          nodeId: "flowdoc:symbol:workflow:run:assign:0",
          name: "current",
          label: "current",
        },
      ],
      inputSlots: [
        {
          id: slotId,
          nodeId: "flowdoc:symbol:workflow:run:return:1",
          slotKey: "current",
          label: "current",
          required: true,
        },
      ],
      inputBindings: [],
    };

    expect(validateFlowInputBindingConnection(document, {
      sourceId,
      slotId,
    })).toEqual({ ok: true });

    const connected = upsertFlowInputBinding(document, { sourceId, slotId });
    expect(connected.inputBindings).toEqual([
      {
        id: `flowbinding:${slotId}->${sourceId}`,
        sourceId,
        slotId,
      },
    ]);

    const removedSourceNode = removeFlowNodes(connected, ["flowdoc:symbol:workflow:run:assign:0"]);
    expect(removedSourceNode.valueSources).toEqual([]);
    expect(removedSourceNode.inputSlots).toEqual(document.inputSlots);
    expect(removedSourceNode.inputBindings).toEqual([]);
  });
});
