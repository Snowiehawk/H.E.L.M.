import { describe, expect, it } from "vitest";
import type { FlowGraphDocument, GraphView } from "../../lib/adapter";
import { flowInputBindingEdgeId, inputSlotTargetHandle, projectFlowDraftGraph } from "./flowDraftGraph";
import { flowReturnCompletionEdgeId } from "./flowDocument";

describe("flowDraftGraph", () => {
  it("backfills legacy function input bindings onto draft nodes through indexedNodeId", () => {
    const baseGraph: GraphView = {
      rootNodeId: "flow:symbol:workflow:run:entry",
      targetId: "symbol:workflow:run",
      level: "flow",
      nodes: [
        {
          id: "flow:symbol:workflow:run:entry",
          kind: "entry",
          label: "Entry",
          subtitle: "workflow.run",
          x: 0,
          y: 0,
          metadata: { flow_order: 0 },
          availableActions: [],
        },
        {
          id: "flow:symbol:workflow:run:param:value",
          kind: "param",
          label: "value",
          subtitle: "parameter",
          x: 0,
          y: 120,
          metadata: { flow_order: 0 },
          availableActions: [],
        },
        {
          id: "flow:symbol:workflow:run:statement:0",
          kind: "assign",
          label: "result = value",
          subtitle: "assignment",
          x: 240,
          y: 0,
          metadata: { flow_order: 1 },
          availableActions: [],
        },
      ],
      edges: [
        {
          id: "controls:entry->assign",
          kind: "controls",
          source: "flow:symbol:workflow:run:entry",
          target: "flow:symbol:workflow:run:statement:0",
          metadata: {
            source_handle: "start",
            target_handle: "in",
          },
        },
        {
          id: "data:param->assign",
          kind: "data",
          source: "flow:symbol:workflow:run:param:value",
          target: "flow:symbol:workflow:run:statement:0",
          label: "value",
          metadata: {},
        },
      ],
      breadcrumbs: [],
      focus: null,
      truncated: false,
      flowState: {
        editable: true,
        syncState: "draft",
        diagnostics: [],
        document: undefined,
      },
    };
    const document: FlowGraphDocument = {
      symbolId: "symbol:workflow:run",
      relativePath: "workflow.py",
      qualname: "workflow.run",
      editable: true,
      syncState: "draft",
      diagnostics: [],
      sourceHash: null,
      nodes: [
        {
          id: "flowdoc:symbol:workflow:run:entry",
          kind: "entry",
          payload: {},
          indexedNodeId: "flow:symbol:workflow:run:entry",
        },
        {
          id: "flowdoc:symbol:workflow:run:assign:draft",
          kind: "assign",
          payload: { source: "result = value" },
          indexedNodeId: "flow:symbol:workflow:run:statement:0",
        },
        {
          id: "flowdoc:symbol:workflow:run:exit",
          kind: "exit",
          payload: {},
        },
      ],
      edges: [
        {
          id: "controls:draft-entry->draft-assign",
          sourceId: "flowdoc:symbol:workflow:run:entry",
          sourceHandle: "start",
          targetId: "flowdoc:symbol:workflow:run:assign:draft",
          targetHandle: "in",
        },
      ],
    };

    const before = JSON.stringify(document);
    const paramMode = projectFlowDraftGraph(baseGraph, document, "param_nodes");
    const entryMode = projectFlowDraftGraph(baseGraph, document, "entry");
    const bindingId = "flowbinding:flowslot:flow:symbol:workflow:run:statement:0:value->flowinput:symbol:workflow:run:value";

    expect(JSON.stringify(document)).toBe(before);
    expect(paramMode.nodes.map((node) => node.id)).toContain("flow:symbol:workflow:run:param:value");
    expect(paramMode.nodes.map((node) => node.id)).toContain("flowdoc:symbol:workflow:run:assign:draft");
    expect(paramMode.nodes.map((node) => node.id)).not.toContain("flow:symbol:workflow:run:statement:0");
    expect(entryMode.nodes.some((node) => node.kind === "param")).toBe(false);
    expect(paramMode.flowState?.document?.inputSlots).toEqual([
      expect.objectContaining({
        id: "flowslot:flow:symbol:workflow:run:statement:0:value",
        nodeId: "flowdoc:symbol:workflow:run:assign:draft",
        slotKey: "value",
      }),
    ]);
    expect(paramMode.flowState?.document?.inputBindings).toEqual([
      expect.objectContaining({
        id: bindingId,
        sourceId: "flowinput:symbol:workflow:run:value",
        functionInputId: "flowinput:symbol:workflow:run:value",
        slotId: "flowslot:flow:symbol:workflow:run:statement:0:value",
      }),
    ]);
    expect(paramMode.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: flowInputBindingEdgeId(bindingId),
          kind: "data",
          source: "flow:symbol:workflow:run:param:value",
          target: "flowdoc:symbol:workflow:run:assign:draft",
          metadata: expect.objectContaining({
            binding_id: bindingId,
            function_input_id: "flowinput:symbol:workflow:run:value",
            slot_id: "flowslot:flow:symbol:workflow:run:statement:0:value",
          }),
        }),
      ]),
    );
    expect(entryMode.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: flowInputBindingEdgeId(bindingId),
          kind: "data",
          source: "flowdoc:symbol:workflow:run:entry",
          target: "flowdoc:symbol:workflow:run:assign:draft",
        }),
      ]),
    );
    expect(paramMode.edges.some((edge) => edge.id === "data:param->assign")).toBe(false);
  });

  it("projects canonical function input bindings equivalently in entry and parameter modes", () => {
    const baseGraph: GraphView = {
      rootNodeId: "flow:symbol:calculator:add:entry",
      targetId: "symbol:calculator:add",
      level: "flow",
      nodes: [
        {
          id: "flow:symbol:calculator:add:entry",
          kind: "entry",
          label: "Entry",
          subtitle: "calculator.add",
          x: 0,
          y: 0,
          metadata: { flow_order: 0 },
          availableActions: [],
        },
        {
          id: "flow:symbol:calculator:add:param:a",
          kind: "param",
          label: "a",
          subtitle: "parameter",
          x: 0,
          y: 120,
          metadata: { signature_order: 0 },
          availableActions: [],
        },
        {
          id: "flow:symbol:calculator:add:param:b",
          kind: "param",
          label: "b",
          subtitle: "parameter",
          x: 0,
          y: 240,
          metadata: { signature_order: 1 },
          availableActions: [],
        },
        {
          id: "flow:symbol:calculator:add:statement:0",
          kind: "return",
          label: "return a + b",
          subtitle: "return",
          x: 240,
          y: 0,
          metadata: { flow_order: 1 },
          availableActions: [],
        },
      ],
      edges: [
        {
          id: "data:legacy-a",
          kind: "data",
          source: "flow:symbol:calculator:add:param:a",
          target: "flow:symbol:calculator:add:statement:0",
          label: "a",
          metadata: {},
        },
      ],
      breadcrumbs: [],
      focus: null,
      truncated: false,
      flowState: {
        editable: true,
        syncState: "draft",
        diagnostics: [],
        document: undefined,
      },
    };
    const document: FlowGraphDocument = {
      symbolId: "symbol:calculator:add",
      relativePath: "calculator.py",
      qualname: "calculator.add",
      editable: true,
      syncState: "draft",
      diagnostics: [],
      sourceHash: null,
      nodes: [
        {
          id: "flowdoc:symbol:calculator:add:entry",
          kind: "entry",
          payload: {},
          indexedNodeId: "flow:symbol:calculator:add:entry",
        },
        {
          id: "flowdoc:symbol:calculator:add:return:0",
          kind: "return",
          payload: { expression: "a + b" },
          indexedNodeId: "flow:symbol:calculator:add:statement:0",
        },
        {
          id: "flowdoc:symbol:calculator:add:exit",
          kind: "exit",
          payload: {},
        },
      ],
      edges: [
        {
          id: "controls:entry->return",
          sourceId: "flowdoc:symbol:calculator:add:entry",
          sourceHandle: "start",
          targetId: "flowdoc:symbol:calculator:add:return:0",
          targetHandle: "in",
        },
      ],
      functionInputs: [
        { id: "flowinput:symbol:calculator:add:a", name: "a", index: 0 },
        { id: "flowinput:symbol:calculator:add:b", name: "b", index: 1 },
      ],
      inputSlots: [
        {
          id: "flowslot:flow:symbol:calculator:add:statement:0:a",
          nodeId: "flowdoc:symbol:calculator:add:return:0",
          slotKey: "a",
          label: "a",
          required: true,
        },
        {
          id: "flowslot:flow:symbol:calculator:add:statement:0:b",
          nodeId: "flowdoc:symbol:calculator:add:return:0",
          slotKey: "b",
          label: "b",
          required: true,
        },
      ],
      inputBindings: [
        {
          id: "flowbinding:flowslot:flow:symbol:calculator:add:statement:0:a->flowinput:symbol:calculator:add:a",
          slotId: "flowslot:flow:symbol:calculator:add:statement:0:a",
          sourceId: "flowinput:symbol:calculator:add:a",
          functionInputId: "flowinput:symbol:calculator:add:a",
        },
        {
          id: "flowbinding:flowslot:flow:symbol:calculator:add:statement:0:b->flowinput:symbol:calculator:add:b",
          slotId: "flowslot:flow:symbol:calculator:add:statement:0:b",
          sourceId: "flowinput:symbol:calculator:add:b",
          functionInputId: "flowinput:symbol:calculator:add:b",
        },
      ],
    };
    const before = JSON.stringify(document);

    const entryMode = projectFlowDraftGraph(baseGraph, document, "entry");
    const paramMode = projectFlowDraftGraph(baseGraph, document, "param_nodes");

    expect(JSON.stringify(document)).toBe(before);
    expect(entryMode.nodes.some((node) => node.kind === "param")).toBe(false);
    expect(paramMode.nodes.map((node) => node.id)).toEqual(
      expect.arrayContaining([
        "flow:symbol:calculator:add:param:a",
        "flow:symbol:calculator:add:param:b",
      ]),
    );

    const entryNode = entryMode.nodes.find((node) => node.id === "flowdoc:symbol:calculator:add:entry");
    expect(entryNode?.metadata.flow_function_inputs).toEqual([
      expect.objectContaining({
        function_input_id: "flowinput:symbol:calculator:add:a",
        source_handle: "out:data:function-input:flowinput:symbol:calculator:add:a",
      }),
      expect.objectContaining({
        function_input_id: "flowinput:symbol:calculator:add:b",
        source_handle: "out:data:function-input:flowinput:symbol:calculator:add:b",
      }),
    ]);

    const paramNode = paramMode.nodes.find((node) => node.id === "flow:symbol:calculator:add:param:a");
    expect(paramNode?.metadata).toEqual(
      expect.objectContaining({
        function_input_id: "flowinput:symbol:calculator:add:a",
        signature_owner_id: "flowdoc:symbol:calculator:add:entry",
        signature_order: 0,
      }),
    );

    const returnNode = entryMode.nodes.find((node) => node.id === "flowdoc:symbol:calculator:add:return:0");
    expect(returnNode?.metadata.flow_return_input_handle).toBe(
      "in:data:return-input:flowdoc:symbol:calculator:add:return:0",
    );
    expect(returnNode?.metadata.flow_input_slots).toEqual([
      expect.objectContaining({
        slot_id: "flowslot:flow:symbol:calculator:add:statement:0:a",
        target_handle: inputSlotTargetHandle("flowslot:flow:symbol:calculator:add:statement:0:a"),
      }),
      expect.objectContaining({
        slot_id: "flowslot:flow:symbol:calculator:add:statement:0:b",
        target_handle: inputSlotTargetHandle("flowslot:flow:symbol:calculator:add:statement:0:b"),
      }),
    ]);

    const firstBindingId = document.inputBindings?.[0]?.id ?? "";
    const entryBindingEdge = entryMode.edges.find((edge) => edge.id === flowInputBindingEdgeId(firstBindingId));
    const paramBindingEdge = paramMode.edges.find((edge) => edge.id === flowInputBindingEdgeId(firstBindingId));
    expect(entryBindingEdge).toEqual(
      expect.objectContaining({
        kind: "data",
        source: "flowdoc:symbol:calculator:add:entry",
        target: "flowdoc:symbol:calculator:add:return:0",
        metadata: expect.objectContaining({
          binding_id: firstBindingId,
          function_input_id: "flowinput:symbol:calculator:add:a",
          slot_id: "flowslot:flow:symbol:calculator:add:statement:0:a",
          source_handle: "out:data:function-input:flowinput:symbol:calculator:add:a",
          target_handle: "in:data:input-slot:flowslot:flow:symbol:calculator:add:statement:0:a",
        }),
      }),
    );
    expect(paramBindingEdge).toEqual(
      expect.objectContaining({
        kind: "data",
        source: "flow:symbol:calculator:add:param:a",
        target: "flowdoc:symbol:calculator:add:return:0",
        metadata: expect.objectContaining({
          binding_id: firstBindingId,
          function_input_id: "flowinput:symbol:calculator:add:a",
          slot_id: "flowslot:flow:symbol:calculator:add:statement:0:a",
        }),
      }),
    );
    expect(entryMode.edges.some((edge) => edge.id === "data:legacy-a")).toBe(false);
    expect(paramMode.edges.some((edge) => edge.id === "data:legacy-a")).toBe(false);
    expect(entryMode.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: flowReturnCompletionEdgeId(
            "flowdoc:symbol:calculator:add:return:0",
            "flowdoc:symbol:calculator:add:exit",
          ),
          kind: "controls",
          source: "flowdoc:symbol:calculator:add:return:0",
          target: "flowdoc:symbol:calculator:add:exit",
          label: "exit",
          metadata: expect.objectContaining({
            source_handle: "exit",
            target_handle: "in",
            flow_return_completion: true,
          }),
        }),
      ]),
    );
    expect(entryMode.flowState?.document?.edges).toEqual(document.edges);
  });

  it("projects canonical local value bindings as editable source handles", () => {
    const assignId = "flowdoc:symbol:calculator:add:assign:0";
    const returnId = "flowdoc:symbol:calculator:add:return:1";
    const sourceId = "flowsource:flow:symbol:calculator:add:statement:0:total";
    const slotId = "flowslot:flow:symbol:calculator:add:statement:1:total";
    const bindingId = `flowbinding:${slotId}->${sourceId}`;
    const baseGraph: GraphView = {
      rootNodeId: "flow:symbol:calculator:add:entry",
      targetId: "symbol:calculator:add",
      level: "flow",
      nodes: [],
      edges: [
        {
          id: "data:indexed-total",
          kind: "data",
          source: "flow:symbol:calculator:add:statement:0",
          target: "flow:symbol:calculator:add:statement:1",
          label: "total",
          metadata: {},
        },
      ],
      breadcrumbs: [],
      focus: null,
      truncated: false,
    };
    const document: FlowGraphDocument = {
      symbolId: "symbol:calculator:add",
      relativePath: "calculator.py",
      qualname: "add",
      editable: true,
      syncState: "clean",
      diagnostics: [],
      sourceHash: null,
      valueModelVersion: 1,
      nodes: [
        {
          id: "flowdoc:symbol:calculator:add:entry",
          kind: "entry",
          payload: {},
          indexedNodeId: "flow:symbol:calculator:add:entry",
        },
        {
          id: assignId,
          kind: "assign",
          payload: { source: "total = a + b" },
          indexedNodeId: "flow:symbol:calculator:add:statement:0",
        },
        {
          id: returnId,
          kind: "return",
          payload: { expression: "total" },
          indexedNodeId: "flow:symbol:calculator:add:statement:1",
        },
        {
          id: "flowdoc:symbol:calculator:add:exit",
          kind: "exit",
          payload: {},
        },
      ],
      edges: [],
      functionInputs: [],
      valueSources: [
        {
          id: sourceId,
          nodeId: assignId,
          name: "total",
          label: "total",
          emittedName: "total__flow_0",
        },
      ],
      inputSlots: [
        {
          id: slotId,
          nodeId: returnId,
          slotKey: "total",
          label: "total",
          required: true,
        },
      ],
      inputBindings: [
        {
          id: bindingId,
          sourceId,
          slotId,
        },
      ],
    };

    const projected = projectFlowDraftGraph(baseGraph, document, "entry");
    const assignNode = projected.nodes.find((node) => node.id === assignId);

    expect(assignNode?.metadata.flow_value_sources).toEqual([
        expect.objectContaining({
          source_id: sourceId,
          name: "total",
          emitted_name: "total__flow_0",
          source_handle: `out:data:value-source:${sourceId}`,
        }),
      ]);
    expect(projected.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: flowInputBindingEdgeId(bindingId),
          kind: "data",
          source: assignId,
          target: returnId,
          metadata: expect.objectContaining({
            binding_id: bindingId,
            source_id: sourceId,
            slot_id: slotId,
            source_handle: `out:data:value-source:${sourceId}`,
            target_handle: inputSlotTargetHandle(slotId),
          }),
        }),
      ]),
    );
    expect(projected.edges.some((edge) => edge.id === "data:indexed-total")).toBe(false);
  });
});
