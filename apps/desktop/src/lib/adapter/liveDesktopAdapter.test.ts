import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

import { LiveDesktopAdapter } from "./liveDesktopAdapter";

describe("LiveDesktopAdapter", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("returns cyclic flow views without hanging the renderer", async () => {
    const adapter = new LiveDesktopAdapter();
    Reflect.set(adapter, "scanCache", {
      session: {
        id: "repo:/workspace/calculator",
        name: "Calculator",
        path: "/workspace/calculator",
        branch: "local",
        primaryLanguage: "Python",
        openedAt: "2026-04-09T00:00:00.000Z",
      },
    });

    invokeMock.mockResolvedValue({
      root_node_id: "flow:symbol:calculator:run:entry",
      target_id: "symbol:calculator:run",
      level: "flow",
      nodes: [
        {
          node_id: "flow:symbol:calculator:run:entry",
          kind: "entry",
          label: "Entry",
          subtitle: "run",
          metadata: { flow_order: 0 },
          available_actions: [],
        },
        {
          node_id: "flow:symbol:calculator:run:statement:0",
          kind: "loop",
          label: "while tokens",
          subtitle: "While",
          metadata: { flow_order: 1 },
          available_actions: [],
        },
        {
          node_id: "flow:symbol:calculator:run:statement:1",
          kind: "call",
          label: "consume()",
          subtitle: "Expr",
          metadata: { flow_order: 2 },
          available_actions: [],
        },
        {
          node_id: "flow:symbol:calculator:run:statement:2",
          kind: "return",
          label: "return output",
          subtitle: "Return",
          metadata: { flow_order: 3 },
          available_actions: [],
        },
      ],
      edges: [
        {
          edge_id: "controls:entry->loop",
          kind: "controls",
          source_id: "flow:symbol:calculator:run:entry",
          target_id: "flow:symbol:calculator:run:statement:0",
          metadata: {},
        },
        {
          edge_id: "controls:loop->body",
          kind: "controls",
          source_id: "flow:symbol:calculator:run:statement:0",
          target_id: "flow:symbol:calculator:run:statement:1",
          label: "body",
          metadata: {
            path_key: "body",
            path_label: "body",
            path_order: 0,
          },
        },
        {
          edge_id: "controls:body->loop",
          kind: "controls",
          source_id: "flow:symbol:calculator:run:statement:1",
          target_id: "flow:symbol:calculator:run:statement:0",
          metadata: {},
        },
        {
          edge_id: "controls:loop->exit",
          kind: "controls",
          source_id: "flow:symbol:calculator:run:statement:0",
          target_id: "flow:symbol:calculator:run:statement:2",
          label: "exit",
          metadata: {
            path_key: "exit",
            path_label: "exit",
            path_order: 1,
          },
        },
      ],
      breadcrumbs: [],
      focus: {
        target_id: "symbol:calculator:run",
        level: "flow",
        label: "run",
        available_levels: ["symbol", "flow"],
      },
      truncated: false,
    });

    const graph = await adapter.getFlowView("symbol:calculator:run");

    expect(invokeMock).toHaveBeenCalledWith("flow_view", {
      repoPath: "/workspace/calculator",
      symbolId: "symbol:calculator:run",
    });
    expect(graph.level).toBe("flow");
    expect(graph.nodes).toHaveLength(4);
    expect(graph.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
    expect(
      graph.nodes.find((node) => node.id === "flow:symbol:calculator:run:entry")?.x,
    ).toBeLessThan(
      graph.nodes.find((node) => node.id === "flow:symbol:calculator:run:statement:0")?.x ?? 0,
    );
  });
});
