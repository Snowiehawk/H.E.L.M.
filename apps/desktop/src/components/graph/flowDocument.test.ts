import { describe, expect, it } from "vitest";
import type { FlowGraphDocument } from "../../lib/adapter";
import type { AuthoredFlowNode } from "./flowDocument";
import {
  addDisconnectedFlowNode,
  insertFlowNodeOnEdge,
  removeFlowEdges,
  removeFlowNodes,
  upsertFlowConnection,
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

  it("splices a new node into the requested control edge", () => {
    const node: AuthoredFlowNode = {
      id: "flowdoc:symbol:workflow:run:assign:1",
      kind: "assign",
      payload: { source: "result = prepare()" },
    };

    const result = insertFlowNodeOnEdge(
      baseDocument,
      node,
      "controls:flowdoc:symbol:workflow:run:entry:start->flowdoc:symbol:workflow:run:call:0:in",
    );

    expect(result.nodes.map((candidate) => candidate.id)).toContain(node.id);
    expect(result.edges).toEqual([
      {
        id: "controls:flowdoc:symbol:workflow:run:entry:start->flowdoc:symbol:workflow:run:assign:1:in",
        sourceId: "flowdoc:symbol:workflow:run:entry",
        sourceHandle: "start",
        targetId: "flowdoc:symbol:workflow:run:assign:1",
        targetHandle: "in",
      },
      {
        id: "controls:flowdoc:symbol:workflow:run:assign:1:next->flowdoc:symbol:workflow:run:call:0:in",
        sourceId: "flowdoc:symbol:workflow:run:assign:1",
        sourceHandle: "next",
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
    ]);
  });

  it("upserts and reconnects control-flow edges through the logical document helper", () => {
    const connected = upsertFlowConnection(baseDocument, {
      sourceId: "flowdoc:symbol:workflow:run:entry",
      sourceHandle: "start",
      targetId: "flowdoc:symbol:workflow:run:exit",
      targetHandle: "in",
    });

    expect(connected.edges).toEqual([
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

    const reconnected = upsertFlowConnection(
      connected,
      {
        sourceId: "flowdoc:symbol:workflow:run:entry",
        sourceHandle: "start",
        targetId: "flowdoc:symbol:workflow:run:call:0",
        targetHandle: "in",
      },
      "controls:flowdoc:symbol:workflow:run:entry:start->flowdoc:symbol:workflow:run:exit:in",
    );

    expect(reconnected.edges.map((edge) => edge.id).sort()).toEqual(
      baseDocument.edges.map((edge) => edge.id).sort(),
    );
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
});
