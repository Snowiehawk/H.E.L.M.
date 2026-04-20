import { describe, expect, it } from "vitest";
import type { FlowExpressionGraph, FlowGraphDocument } from "../../lib/adapter";
import type { AuthoredFlowNode } from "./flowDocument";
import {
  addDisconnectedFlowNode,
  addFlowFunctionInput,
  flowFunctionInputUsage,
  mergeFlowDraftWithSourceDocument,
  isFlowDocumentNodeKind,
  isFlowNodeAuthorableKind,
  moveFlowFunctionInput,
  parseReturnInputTargetHandle,
  removeFlowEdges,
  removeFlowFunctionInput,
  removeFlowFunctionInputAndDownstreamUses,
  removeFlowInputBindings,
  removeFlowNodes,
  updateFlowFunctionInput,
  flowReturnCompletionEdgeId,
  returnInputTargetHandle,
  upsertFlowInputBinding,
  upsertFlowConnection,
  upsertFlowReturnInputBinding,
  validateFlowConnection,
  validateFlowInputBindingConnection,
  validateFlowReturnInputBindingConnection,
} from "./flowDocument";
import { expressionFromFlowExpressionGraph } from "./flowExpressionGraph";

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

  it("edits canonical flow function inputs and prunes downstream bindings on removal", () => {
    const withFirstInput = addFlowFunctionInput(baseDocument, {
      name: "repo path",
      defaultExpression: "'/tmp/repo'",
    });
    expect(withFirstInput.functionInputs).toEqual([
      expect.objectContaining({
        id: "flowinput:symbol:workflow:run:repo_path",
        name: "repo_path",
        index: 0,
        kind: "positional_or_keyword",
        defaultExpression: "'/tmp/repo'",
      }),
    ]);

    const withSecondInput = addFlowFunctionInput(withFirstInput, { name: "repo_path" });
    expect(withSecondInput.functionInputs?.map((input) => input.name)).toEqual(["repo_path", "repo_path_2"]);

    const firstInputId = withSecondInput.functionInputs?.[0]?.id ?? "";
    const secondInputId = withSecondInput.functionInputs?.[1]?.id ?? "";
    const renamed = updateFlowFunctionInput(withSecondInput, firstInputId, {
      name: "root",
      defaultExpression: null,
    });
    expect(renamed.functionInputs?.[0]).toEqual(
      expect.objectContaining({
        id: firstInputId,
        name: "root",
        defaultExpression: null,
      }),
    );

    const moved = moveFlowFunctionInput(renamed, secondInputId, -1);
    expect(moved.functionInputs?.map((input) => `${input.index}:${input.id}`)).toEqual([
      `0:${secondInputId}`,
      `1:${firstInputId}`,
    ]);

    const boundDocument: FlowGraphDocument = {
      ...moved,
      inputSlots: [
        {
          id: "flowslot:flow:symbol:workflow:run:call:0:root",
          nodeId: "flowdoc:symbol:workflow:run:call:0",
          slotKey: "root",
          label: "root",
          required: true,
        },
      ],
      inputBindings: [
        {
          id: `flowbinding:flowslot:flow:symbol:workflow:run:call:0:root->${firstInputId}`,
          sourceId: firstInputId,
          functionInputId: firstInputId,
          slotId: "flowslot:flow:symbol:workflow:run:call:0:root",
        },
      ],
    };
    expect(flowFunctionInputUsage(boundDocument, firstInputId).bindings).toHaveLength(1);

    const removed = removeFlowFunctionInput(boundDocument, firstInputId);
    expect(removed.functionInputs?.map((input) => input.id)).toEqual([secondInputId]);
    expect(removed.functionInputs?.[0]?.index).toBe(0);
    expect(removed.inputBindings).toEqual([]);
  });

  it("removes downstream slots and expression inputs when deleting a function input with cleanup", () => {
    const returnNodeId = "flowdoc:symbol:workflow:run:return:0";
    const document: FlowGraphDocument = {
      ...baseDocument,
      nodes: [
        { id: "flowdoc:symbol:workflow:run:entry", kind: "entry", payload: {} },
        {
          id: returnNodeId,
          kind: "return",
          payload: {
            expression: "a + b + c",
            expression_graph: {
              version: 1,
              rootId: "expr:operator:plus:2",
              nodes: [
                { id: "expr:input:a", kind: "input", label: "a", payload: { name: "a", slot_id: "flowslot:return:a" } },
                { id: "expr:input:b", kind: "input", label: "b", payload: { name: "b", slot_id: "flowslot:return:b" } },
                { id: "expr:input:c", kind: "input", label: "c", payload: { name: "c", slot_id: "flowslot:return:c" } },
                { id: "expr:operator:plus:1", kind: "operator", label: "+", payload: { operator: "+" } },
                { id: "expr:operator:plus:2", kind: "operator", label: "+", payload: { operator: "+" } },
              ],
              edges: [
                { id: "expr-edge:a", sourceId: "expr:input:a", sourceHandle: "value", targetId: "expr:operator:plus:1", targetHandle: "left" },
                { id: "expr-edge:b", sourceId: "expr:input:b", sourceHandle: "value", targetId: "expr:operator:plus:1", targetHandle: "right" },
                { id: "expr-edge:plus", sourceId: "expr:operator:plus:1", sourceHandle: "value", targetId: "expr:operator:plus:2", targetHandle: "left" },
                { id: "expr-edge:c", sourceId: "expr:input:c", sourceHandle: "value", targetId: "expr:operator:plus:2", targetHandle: "right" },
              ],
            },
          },
        },
        { id: "flowdoc:symbol:workflow:run:exit", kind: "exit", payload: {} },
      ],
      functionInputs: [
        { id: "flowinput:symbol:workflow:run:a", name: "a", index: 0 },
        { id: "flowinput:symbol:workflow:run:b", name: "b", index: 1 },
        { id: "flowinput:symbol:workflow:run:c", name: "c", index: 2 },
      ],
      inputSlots: [
        { id: "flowslot:return:a", nodeId: returnNodeId, slotKey: "a", label: "a", required: true },
        { id: "flowslot:return:b", nodeId: returnNodeId, slotKey: "b", label: "b", required: true },
        { id: "flowslot:return:c", nodeId: returnNodeId, slotKey: "c", label: "c", required: true },
      ],
      inputBindings: [
        { id: "binding:a", sourceId: "flowinput:symbol:workflow:run:a", functionInputId: "flowinput:symbol:workflow:run:a", slotId: "flowslot:return:a" },
        { id: "binding:b", sourceId: "flowinput:symbol:workflow:run:b", functionInputId: "flowinput:symbol:workflow:run:b", slotId: "flowslot:return:b" },
        { id: "binding:c", sourceId: "flowinput:symbol:workflow:run:c", functionInputId: "flowinput:symbol:workflow:run:c", slotId: "flowslot:return:c" },
      ],
    };

    const removed = removeFlowFunctionInputAndDownstreamUses(document, "flowinput:symbol:workflow:run:b");
    const returnPayload = removed.nodes.find((node) => node.id === returnNodeId)?.payload;
    const expressionGraph = returnPayload?.expression_graph;

    expect(removed.functionInputs?.map((input) => input.name)).toEqual(["a", "c"]);
    expect(removed.inputSlots?.map((slot) => slot.label)).toEqual(["a", "c"]);
    expect(removed.inputBindings?.map((binding) => binding.sourceId)).toEqual([
      "flowinput:symbol:workflow:run:a",
      "flowinput:symbol:workflow:run:c",
    ]);
    expect(JSON.stringify(expressionGraph)).not.toContain("expr:input:b");
    expect(expressionFromFlowExpressionGraph(expressionGraph as FlowExpressionGraph)).toEqual({
      diagnostics: [],
      expression: "a + c",
    });
    expect(returnPayload?.expression).toBe("a + c");
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

  it("creates a generic return slot, binding, and expression input node", () => {
    const returnNodeId = "flowdoc:symbol:workflow:run:return:0";
    const document: FlowGraphDocument = {
      ...baseDocument,
      nodes: [
        { id: "flowdoc:symbol:workflow:run:entry", kind: "entry", payload: {} },
        {
          id: returnNodeId,
          kind: "return",
          indexedNodeId: "flow:symbol:workflow:run:statement:0",
          payload: {
            expression: "a",
            expression_graph: {
              version: 1,
              rootId: "expr:input:0",
              nodes: [{
                id: "expr:input:0",
                kind: "input",
                label: "a",
                payload: { name: "a" },
              }],
              edges: [],
            },
          },
        },
        { id: "flowdoc:symbol:workflow:run:exit", kind: "exit", payload: {} },
      ],
      functionInputs: [
        { id: "flowinput:symbol:workflow:run:a", name: "a", index: 0 },
        { id: "flowinput:symbol:workflow:run:c", name: "c", index: 1 },
      ],
      inputSlots: [],
      inputBindings: [],
    };

    expect(parseReturnInputTargetHandle(returnInputTargetHandle(returnNodeId))).toBe(returnNodeId);
    expect(validateFlowReturnInputBindingConnection(document, {
      sourceId: "flowinput:symbol:workflow:run:c",
      targetNodeId: returnNodeId,
    })).toEqual({ ok: true });

    const connected = upsertFlowReturnInputBinding(document, {
      sourceId: "flowinput:symbol:workflow:run:c",
      targetNodeId: returnNodeId,
    });

    expect(connected.inputSlots).toEqual([
      expect.objectContaining({
        id: "flowslot:flow:symbol:workflow:run:statement:0:c",
        nodeId: returnNodeId,
        slotKey: "c",
      }),
    ]);
    expect(connected.inputBindings).toEqual([
      expect.objectContaining({
        id: "flowbinding:flowslot:flow:symbol:workflow:run:statement:0:c->flowinput:symbol:workflow:run:c",
        sourceId: "flowinput:symbol:workflow:run:c",
        slotId: "flowslot:flow:symbol:workflow:run:statement:0:c",
        functionInputId: "flowinput:symbol:workflow:run:c",
      }),
    ]);
    const returnPayload = connected.nodes.find((node) => node.id === returnNodeId)?.payload;
    const expressionGraph = returnPayload?.expression_graph as { nodes: Array<{ kind: string; payload: Record<string, unknown> }> };
    expect(expressionGraph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "input",
          payload: expect.objectContaining({
            name: "c",
            slot_id: "flowslot:flow:symbol:workflow:run:statement:0:c",
          }),
        }),
      ]),
    );
  });

  it("merges refreshed source flow documents into an open draft", () => {
    const base: FlowGraphDocument = {
      ...baseDocument,
      symbolId: "symbol:calculator:add",
      nodes: [
        { id: "flowdoc:symbol:calculator:add:entry", kind: "entry", payload: {}, indexedNodeId: "flow:symbol:calculator:add:entry" },
        { id: "flowdoc:symbol:calculator:add:return:0", kind: "return", payload: { expression: "a + b" }, indexedNodeId: "flow:symbol:calculator:add:statement:0" },
        { id: "flowdoc:symbol:calculator:add:exit", kind: "exit", payload: {} },
      ],
      functionInputs: [
        { id: "flowinput:symbol:calculator:add:a", name: "a", index: 0 },
        { id: "flowinput:symbol:calculator:add:b", name: "b", index: 1 },
      ],
      inputSlots: [
        { id: "flowslot:flow:symbol:calculator:add:statement:0:a", nodeId: "flowdoc:symbol:calculator:add:return:0", slotKey: "a", label: "a", required: true },
        { id: "flowslot:flow:symbol:calculator:add:statement:0:b", nodeId: "flowdoc:symbol:calculator:add:return:0", slotKey: "b", label: "b", required: true },
      ],
      inputBindings: [
        { id: "flowbinding:flowslot:flow:symbol:calculator:add:statement:0:a->flowinput:symbol:calculator:add:a", sourceId: "flowinput:symbol:calculator:add:a", functionInputId: "flowinput:symbol:calculator:add:a", slotId: "flowslot:flow:symbol:calculator:add:statement:0:a" },
        { id: "flowbinding:flowslot:flow:symbol:calculator:add:statement:0:b->flowinput:symbol:calculator:add:b", sourceId: "flowinput:symbol:calculator:add:b", functionInputId: "flowinput:symbol:calculator:add:b", slotId: "flowslot:flow:symbol:calculator:add:statement:0:b" },
      ],
    };
    const currentDraft: FlowGraphDocument = {
      ...base,
      nodes: [
        ...base.nodes,
        { id: "flowdoc:symbol:calculator:add:assign:draft", kind: "assign", payload: { source: "total = a + b" } },
      ],
    };
    const refreshedSource: FlowGraphDocument = {
      ...base,
      nodes: base.nodes.map((node) => (
        node.kind === "return"
          ? { ...node, payload: { expression: "a + b + c" } }
          : node
      )),
      functionInputs: [
        ...base.functionInputs!,
        { id: "flowinput:symbol:calculator:add:c", name: "c", index: 2 },
      ],
      inputSlots: [
        ...base.inputSlots!,
        { id: "flowslot:flow:symbol:calculator:add:statement:0:c", nodeId: "flowdoc:symbol:calculator:add:return:0", slotKey: "c", label: "c", required: true },
      ],
      inputBindings: [
        ...base.inputBindings!,
        { id: "flowbinding:flowslot:flow:symbol:calculator:add:statement:0:c->flowinput:symbol:calculator:add:c", sourceId: "flowinput:symbol:calculator:add:c", functionInputId: "flowinput:symbol:calculator:add:c", slotId: "flowslot:flow:symbol:calculator:add:statement:0:c" },
      ],
    };

    const merged = mergeFlowDraftWithSourceDocument(currentDraft, base, refreshedSource);

    expect(merged.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "flowdoc:symbol:calculator:add:assign:draft" }),
        expect.objectContaining({ id: "flowdoc:symbol:calculator:add:return:0", payload: { expression: "a + b + c" } }),
      ]),
    );
    expect(merged.functionInputs?.map((input) => input.name)).toEqual(["a", "b", "c"]);
    expect(merged.inputBindings?.map((binding) => binding.sourceId)).toContain("flowinput:symbol:calculator:add:c");
  });
});
