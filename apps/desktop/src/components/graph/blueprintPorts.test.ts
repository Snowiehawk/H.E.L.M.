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
});
