import { describe, expect, it } from "vitest";
import type { GraphView } from "../../lib/adapter";
import { buildBlueprintPresentation } from "./blueprintPorts";

describe("buildBlueprintPresentation", () => {
  it("groups architecture handles by relation kind and tracks the merged members", () => {
    const graph: GraphView = {
      rootNodeId: "module:focus",
      targetId: "module:focus",
      level: "module",
      truncated: false,
      breadcrumbs: [],
      focus: {
        targetId: "module:focus",
        level: "module",
        label: "focus",
        subtitle: "focus.py",
        availableLevels: ["repo", "module"],
      },
      nodes: [
        {
          id: "module:focus",
          kind: "module",
          label: "focus",
          subtitle: "1 symbol",
          x: 0,
          y: 0,
          metadata: {},
          availableActions: [],
        },
        {
          id: "module:left",
          kind: "module",
          label: "left",
          subtitle: "0 symbols",
          x: -240,
          y: 0,
          metadata: {},
          availableActions: [],
        },
        {
          id: "module:right-a",
          kind: "module",
          label: "right-a",
          subtitle: "0 symbols",
          x: 240,
          y: -80,
          metadata: {},
          availableActions: [],
        },
        {
          id: "module:right-b",
          kind: "module",
          label: "right-b",
          subtitle: "0 symbols",
          x: 240,
          y: 80,
          metadata: {},
          availableActions: [],
        },
      ],
      edges: [
        {
          id: "imports:left-focus",
          kind: "imports",
          source: "module:left",
          target: "module:focus",
          metadata: {},
        },
        {
          id: "imports:focus-right-a",
          kind: "imports",
          source: "module:focus",
          target: "module:right-a",
          metadata: {},
        },
        {
          id: "calls:focus-right-b",
          kind: "calls",
          source: "module:focus",
          target: "module:right-b",
          metadata: {},
        },
      ],
    };

    const presentation = buildBlueprintPresentation(graph);
    const focusPorts = presentation.nodePorts.get("module:focus");
    const focusImportPort = focusPorts?.outputs.find((port) => port.id === "out:graph:imports");
    const focusCallPort = focusPorts?.outputs.find((port) => port.id === "out:graph:calls");

    expect(focusPorts?.outputs.map((port) => port.id)).toEqual([
      "out:graph:imports",
      "out:graph:calls",
    ]);
    expect(focusImportPort?.memberLabels).toEqual(["right-a"]);
    expect(focusImportPort?.memberEdgeIds).toEqual(["imports:focus-right-a"]);
    expect(focusCallPort?.memberLabels).toEqual(["right-b"]);
    expect(focusCallPort?.memberEdgeIds).toEqual(["calls:focus-right-b"]);
    expect(presentation.edgeHandles.get("imports:focus-right-a")).toEqual({
      sourceHandle: "out:graph:imports",
      targetHandle: "in:graph:imports",
    });
  });

  it("collects multiple architecture edges on one handle with a member list", () => {
    const graph: GraphView = {
      rootNodeId: "module:focus",
      targetId: "module:focus",
      level: "module",
      truncated: false,
      breadcrumbs: [],
      focus: {
        targetId: "module:focus",
        level: "module",
        label: "focus",
        availableLevels: ["repo", "module"],
      },
      nodes: [
        {
          id: "module:focus",
          kind: "module",
          label: "focus",
          x: 0,
          y: 0,
          metadata: {},
          availableActions: [],
        },
        {
          id: "module:left-a",
          kind: "module",
          label: "left-a",
          x: -240,
          y: -80,
          metadata: {},
          availableActions: [],
        },
        {
          id: "module:left-b",
          kind: "module",
          label: "left-b",
          x: -240,
          y: 80,
          metadata: {},
          availableActions: [],
        },
      ],
      edges: [
        {
          id: "calls:left-a-focus",
          kind: "calls",
          source: "module:left-a",
          target: "module:focus",
          label: "2 calls",
          metadata: {},
        },
        {
          id: "calls:left-b-focus",
          kind: "calls",
          source: "module:left-b",
          target: "module:focus",
          label: "1 call",
          metadata: {},
        },
      ],
    };

    const presentation = buildBlueprintPresentation(graph);
    const focusPorts = presentation.nodePorts.get("module:focus");
    const callPort = focusPorts?.inputs.find((port) => port.id === "in:graph:calls");

    expect(focusPorts?.inputs).toHaveLength(1);
    expect(callPort?.memberLabels).toEqual([
      "left-a · 2 calls",
      "left-b · 1 call",
    ]);
    expect(callPort?.memberEdgeIds).toEqual([
      "calls:left-a-focus",
      "calls:left-b-focus",
    ]);
    expect(presentation.edgeHandles.get("calls:left-a-focus")).toEqual({
      sourceHandle: "out:graph:calls",
      targetHandle: "in:graph:calls",
    });
    expect(presentation.edgeHandles.get("calls:left-b-focus")).toEqual({
      sourceHandle: "out:graph:calls",
      targetHandle: "in:graph:calls",
    });
  });

  it("maps flow nodes to semantic input and output ports", () => {
    const graph: GraphView = {
      rootNodeId: "flow:entry",
      targetId: "symbol:service:run",
      level: "flow",
      truncated: false,
      breadcrumbs: [],
      focus: {
        targetId: "symbol:service:run",
        level: "flow",
        label: "run",
        subtitle: "service.run",
        availableLevels: ["repo", "module", "symbol", "flow"],
      },
      nodes: [
        {
          id: "flow:entry",
          kind: "entry",
          label: "Entry",
          subtitle: "service.run",
          x: 0,
          y: 0,
          metadata: {},
          availableActions: [],
        },
        {
          id: "flow:param:flag",
          kind: "param",
          label: "flag",
          subtitle: "parameter",
          x: 0,
          y: 80,
          metadata: {},
          availableActions: [],
        },
        {
          id: "flow:call:check",
          kind: "call",
          label: "check(flag)",
          subtitle: "Expr",
          x: 240,
          y: 0,
          metadata: {},
          availableActions: [],
        },
        {
          id: "flow:return",
          kind: "return",
          label: "return result",
          subtitle: "Return",
          x: 480,
          y: 0,
          metadata: {},
          availableActions: [],
        },
      ],
      edges: [
        {
          id: "controls:entry-call",
          kind: "controls",
          source: "flow:entry",
          target: "flow:call:check",
          metadata: {},
        },
        {
          id: "data:param-call",
          kind: "data",
          source: "flow:param:flag",
          target: "flow:call:check",
          label: "flag",
          metadata: {},
        },
        {
          id: "controls:call-return",
          kind: "controls",
          source: "flow:call:check",
          target: "flow:return",
          metadata: {},
        },
      ],
    };

    const presentation = buildBlueprintPresentation(graph);
    const paramPorts = presentation.nodePorts.get("flow:param:flag");
    const callPorts = presentation.nodePorts.get("flow:call:check");
    const entryEdge = presentation.edgeHandles.get("controls:entry-call");
    const dataEdge = presentation.edgeHandles.get("data:param-call");

    expect(paramPorts?.inputs).toEqual([]);
    expect(paramPorts?.outputs.map((port) => port.label)).toContain("flag");
    expect(callPorts?.inputs.map((port) => port.label)).toEqual(
      expect.arrayContaining(["exec", "flag"]),
    );
    expect(entryEdge).toEqual({
      sourceHandle: "out:control:exec",
      targetHandle: "in:control:exec",
    });
    expect(dataEdge).toEqual({
      sourceHandle: "out:data:flag",
      targetHandle: "in:data:flag",
    });
  });

  it("exposes entry-owned function inputs and unbound target slots as data ports", () => {
    const graph: GraphView = {
      rootNodeId: "flowdoc:symbol:service:run:entry",
      targetId: "symbol:service:run",
      level: "flow",
      truncated: false,
      breadcrumbs: [],
      focus: null,
      nodes: [
        {
          id: "flowdoc:symbol:service:run:entry",
          kind: "entry",
          label: "Entry",
          x: 0,
          y: 0,
          metadata: {
            flow_visual: true,
            flow_function_inputs: [
              {
                function_input_id: "flowinput:symbol:service:run:value",
                name: "value",
                index: 0,
                source_handle: "out:data:function-input:flowinput:symbol:service:run:value",
              },
            ],
          },
          availableActions: [],
        },
        {
          id: "flowdoc:symbol:service:run:return:0",
          kind: "return",
          label: "return value",
          x: 240,
          y: 0,
          metadata: {
            flow_visual: true,
            flow_input_slots: [
              {
                slot_id: "flowslot:flow:symbol:service:run:statement:0:value",
                slot_key: "value",
                label: "value",
                target_handle: "in:data:input-slot:flowslot:flow:symbol:service:run:statement:0:value",
              },
            ],
          },
          availableActions: [],
        },
      ],
      edges: [],
    };

    const presentation = buildBlueprintPresentation(graph);
    const entryPorts = presentation.nodePorts.get("flowdoc:symbol:service:run:entry");
    const returnPorts = presentation.nodePorts.get("flowdoc:symbol:service:run:return:0");

    expect(entryPorts?.outputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "out:data:function-input:flowinput:symbol:service:run:value",
          label: "value",
          kind: "data",
        }),
      ]),
    );
    expect(entryPorts?.inputs.some((port) => port.kind === "data")).toBe(false);
    expect(returnPorts?.inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "in:data:input-slot:flowslot:flow:symbol:service:run:statement:0:value",
          label: "value",
          kind: "data",
        }),
      ]),
    );
    expect(returnPorts?.outputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "out:control:exit",
          label: "exit",
          kind: "control",
        }),
      ]),
    );
  });

  it("exposes canonical local value sources as data output ports", () => {
    const graph: GraphView = {
      rootNodeId: "flowdoc:symbol:service:run:entry",
      targetId: "symbol:service:run",
      level: "flow",
      truncated: false,
      breadcrumbs: [],
      focus: null,
      nodes: [
        {
          id: "flowdoc:symbol:service:run:assign:0",
          kind: "assign",
          label: "current = value",
          x: 0,
          y: 0,
          metadata: {
            flow_visual: true,
            flow_value_sources: [
              {
                source_id: "flowsource:flow:symbol:service:run:statement:0:current",
                name: "current",
                label: "current",
                source_handle: "out:data:value-source:flowsource:flow:symbol:service:run:statement:0:current",
              },
            ],
          },
          availableActions: [],
        },
      ],
      edges: [],
    };

    const presentation = buildBlueprintPresentation(graph);
    const assignPorts = presentation.nodePorts.get("flowdoc:symbol:service:run:assign:0");

    expect(assignPorts?.outputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "out:data:value-source:flowsource:flow:symbol:service:run:statement:0:current",
          label: "current",
          kind: "data",
        }),
      ]),
    );
  });

  it("assigns distinct control handles for labeled and unlabeled split paths", () => {
    const graph: GraphView = {
      rootNodeId: "flow:entry",
      targetId: "symbol:service:run",
      level: "flow",
      truncated: false,
      breadcrumbs: [],
      focus: {
        targetId: "symbol:service:run",
        level: "flow",
        label: "run",
        availableLevels: ["repo", "module", "symbol", "flow"],
      },
      nodes: [
        {
          id: "flow:entry",
          kind: "entry",
          label: "Entry",
          x: 0,
          y: 0,
          metadata: {},
          availableActions: [],
        },
        {
          id: "flow:branch",
          kind: "branch",
          label: "if flag",
          x: 220,
          y: 0,
          metadata: {},
          availableActions: [],
        },
        {
          id: "flow:true",
          kind: "assign",
          label: "true path",
          x: 440,
          y: -80,
          metadata: {},
          availableActions: [],
        },
        {
          id: "flow:false",
          kind: "assign",
          label: "false path",
          x: 440,
          y: 80,
          metadata: {},
          availableActions: [],
        },
        {
          id: "flow:multi",
          kind: "call",
          label: "dispatch()",
          x: 660,
          y: 0,
          metadata: {},
          availableActions: [],
        },
        {
          id: "flow:path-a",
          kind: "return",
          label: "path a",
          x: 880,
          y: -80,
          metadata: {},
          availableActions: [],
        },
        {
          id: "flow:path-b",
          kind: "return",
          label: "path b",
          x: 880,
          y: 80,
          metadata: {},
          availableActions: [],
        },
      ],
      edges: [
        {
          id: "controls:entry-branch",
          kind: "controls",
          source: "flow:entry",
          target: "flow:branch",
          metadata: {},
        },
        {
          id: "controls:branch-true",
          kind: "controls",
          source: "flow:branch",
          target: "flow:true",
          label: "true",
          metadata: { path_key: "true", path_label: "true", path_order: 0 },
        },
        {
          id: "controls:branch-false",
          kind: "controls",
          source: "flow:branch",
          target: "flow:false",
          label: "false",
          metadata: { path_key: "false", path_label: "false", path_order: 1 },
        },
        {
          id: "controls:true-multi",
          kind: "controls",
          source: "flow:true",
          target: "flow:multi",
          metadata: {},
        },
        {
          id: "controls:multi-a",
          kind: "controls",
          source: "flow:multi",
          target: "flow:path-a",
          metadata: {},
        },
        {
          id: "controls:multi-b",
          kind: "controls",
          source: "flow:multi",
          target: "flow:path-b",
          metadata: {},
        },
      ],
    };

    const presentation = buildBlueprintPresentation(graph);
    const branchPorts = presentation.nodePorts.get("flow:branch");
    const multiPorts = presentation.nodePorts.get("flow:multi");

    expect(branchPorts?.outputs.map((port) => port.label)).toEqual(["true", "false"]);
    expect(multiPorts?.outputs.map((port) => port.label)).toEqual(["path 1", "path 2"]);
    expect(presentation.edgeHandles.get("controls:branch-true")).toEqual({
      sourceHandle: "out:control:true",
      targetHandle: "in:control:exec",
    });
    expect(presentation.edgeHandles.get("controls:multi-b")).toEqual({
      sourceHandle: "out:control:path-2",
      targetHandle: "in:control:exec",
    });
  });
});
