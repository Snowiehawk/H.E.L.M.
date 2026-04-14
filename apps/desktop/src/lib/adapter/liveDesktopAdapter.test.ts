import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));
const workspaceSyncState = vi.hoisted(() => ({
  callback: undefined as undefined | ((event: { payload: unknown }) => void),
}));
const { listenMock } = vi.hoisted(() => ({
  listenMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

import { LiveDesktopAdapter } from "./liveDesktopAdapter";

describe("LiveDesktopAdapter", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    listenMock.mockImplementation(async (_eventName, callback) => {
      workspaceSyncState.callback = callback;
      return vi.fn();
    });
    workspaceSyncState.callback = undefined;
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

  it("updates cached workspace state from live sync events", async () => {
    const adapter = new LiveDesktopAdapter();
    const listener = vi.fn();
    adapter.subscribeWorkspaceSync(listener);
    Reflect.set(adapter, "currentSession", {
      id: "repo:/workspace/calculator",
      name: "Calculator",
      path: "/workspace/calculator",
      branch: "local",
      primaryLanguage: "Python",
      openedAt: "2026-04-09T00:00:00.000Z",
    });

    workspaceSyncState.callback?.({
      payload: {
        repo_path: "/workspace/calculator",
        session_version: 2,
        reason: "external-change",
        status: "synced",
        changed_relative_paths: ["calculator.py"],
        needs_manual_resync: false,
        snapshot: {
          repo_id: "repo:/workspace/calculator",
          default_focus_node_id: "symbol:calculator:new_helper",
          default_level: "symbol",
          node_ids: [
            "repo:/workspace/calculator",
            "module:calculator",
            "symbol:calculator:new_helper",
          ],
        },
        payload: {
          summary: {
            repo_path: "/workspace/calculator",
            module_count: 1,
            symbol_count: 1,
            import_edge_count: 0,
            call_edge_count: 0,
            unresolved_call_count: 0,
            diagnostic_count: 0,
            modules: [
              {
                module_id: "module:calculator",
                module_name: "calculator",
                relative_path: "calculator.py",
                symbol_count: 1,
                import_count: 0,
                outgoing_call_count: 0,
              },
            ],
          },
          graph: {
            root_path: "/workspace/calculator",
            repo_id: "repo:/workspace/calculator",
            nodes: [
              {
                node_id: "repo:/workspace/calculator",
                kind: "repo",
                name: "Calculator",
                display_name: "Calculator",
                file_path: null,
                module_name: null,
                qualname: null,
                is_external: false,
                metadata: {},
              },
              {
                node_id: "module:calculator",
                kind: "module",
                name: "calculator",
                display_name: "calculator.py",
                file_path: "/workspace/calculator/calculator.py",
                module_name: "calculator",
                qualname: null,
                is_external: false,
                metadata: { relative_path: "calculator.py" },
              },
              {
                node_id: "symbol:calculator:new_helper",
                kind: "symbol",
                name: "new_helper",
                display_name: "new_helper",
                file_path: "/workspace/calculator/calculator.py",
                module_name: "calculator",
                qualname: "new_helper",
                is_external: false,
                metadata: { symbol_kind: "function" },
              },
            ],
            edges: [
              {
                edge_id: "defines:module:calculator->symbol:calculator:new_helper",
                kind: "defines",
                source_id: "module:calculator",
                target_id: "symbol:calculator:new_helper",
                metadata: {},
              },
            ],
            diagnostics: [],
            unresolved_calls: [],
            report: {
              module_count: 1,
              symbol_count: 1,
              import_edge_count: 0,
              call_edge_count: 0,
              unresolved_call_count: 0,
              diagnostic_count: 0,
            },
          },
          workspace: {
            language: "python",
            default_level: "symbol",
            default_focus_node_id: "symbol:calculator:new_helper",
            source_hidden_by_default: true,
            supported_edit_kinds: [],
            session_version: 2,
          },
        },
      },
    });

    const results = await adapter.searchRepo("new_helper", {
      includeModules: true,
      includeFiles: true,
      includeSymbols: true,
    });

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: "/workspace/calculator",
        sessionVersion: 2,
        status: "synced",
        changedRelativePaths: ["calculator.py"],
      }),
    );
    expect(results.some((result) => result.title === "new_helper")).toBe(true);
  });
});
