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
          functionInputId: "flowinput:symbol:workflow:run:a",
        },
        {
          id: "flowbinding:flowslot:flow:symbol:workflow:run:statement:1:a->flowinput:symbol:workflow:run:a",
          slotId: "flowslot:flow:symbol:workflow:run:statement:1:a",
          functionInputId: "flowinput:symbol:workflow:run:a",
        },
      ],
    };

    expect(validateFlowInputBindingConnection(document, {
      functionInputId: "flowinput:symbol:workflow:run:b",
      slotId: "flowslot:flow:symbol:workflow:run:statement:0:a",
    })).toEqual({ ok: true });

    const withoutAssignBinding = removeFlowInputBindings(document, [
      "flowbinding:flowslot:flow:symbol:workflow:run:statement:0:a->flowinput:symbol:workflow:run:a",
    ]);

    expect(withoutAssignBinding.inputBindings).toEqual([
      {
        id: "flowbinding:flowslot:flow:symbol:workflow:run:statement:1:a->flowinput:symbol:workflow:run:a",
        slotId: "flowslot:flow:symbol:workflow:run:statement:1:a",
        functionInputId: "flowinput:symbol:workflow:run:a",
      },
    ]);

    const reconnected = upsertFlowInputBinding(withoutAssignBinding, {
      functionInputId: "flowinput:symbol:workflow:run:b",
      slotId: "flowslot:flow:symbol:workflow:run:statement:0:a",
    });

    expect(reconnected.inputBindings).toEqual([
      {
        id: "flowbinding:flowslot:flow:symbol:workflow:run:statement:1:a->flowinput:symbol:workflow:run:a",
        slotId: "flowslot:flow:symbol:workflow:run:statement:1:a",
        functionInputId: "flowinput:symbol:workflow:run:a",
      },
      {
        id: "flowbinding:flowslot:flow:symbol:workflow:run:statement:0:a->flowinput:symbol:workflow:run:b",
        slotId: "flowslot:flow:symbol:workflow:run:statement:0:a",
        functionInputId: "flowinput:symbol:workflow:run:b",
      },
    ]);
  });
});
