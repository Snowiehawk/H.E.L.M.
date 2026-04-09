import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphView } from "../../lib/adapter";
import {
  graphLayoutViewKey,
  readStoredGraphLayout,
  writeStoredGraphLayout,
} from "./graphLayoutPersistence";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

describe("graphLayoutPersistence", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("builds path-independent keys for repo-backed layouts", () => {
    const repoGraph: GraphView = {
      rootNodeId: "repo:/Users/alice/workspace/project",
      targetId: "repo:/Users/alice/workspace/project",
      level: "repo",
      nodes: [],
      edges: [],
      breadcrumbs: [],
      truncated: false,
    };
    const symbolGraph: GraphView = {
      rootNodeId: "module:helm.ui.api",
      targetId: "symbol:helm.ui.api:build_graph_summary",
      level: "symbol",
      nodes: [],
      edges: [],
      breadcrumbs: [],
      truncated: false,
    };

    expect(graphLayoutViewKey(repoGraph)).toBe("repo|repo-root");
    expect(graphLayoutViewKey(symbolGraph)).toBe(
      "symbol|symbol:helm.ui.api:build_graph_summary",
    );
  });

  it("reads persisted positions from the opened repo", async () => {
    invokeMock.mockResolvedValue({
      "module:alpha": { x: 120, y: -40 },
      "module:beta": { x: 440, y: 80 },
      broken: { x: "nope", y: 2 },
    });

    await expect(
      readStoredGraphLayout("/workspace/project", "module|module:alpha"),
    ).resolves.toEqual({
      nodes: {
        "module:alpha": { x: 120, y: -40 },
        "module:beta": { x: 440, y: 80 },
      },
      reroutes: [],
    });

    expect(invokeMock).toHaveBeenCalledWith("read_repo_graph_layout", {
      repoPath: "/workspace/project",
      viewKey: "module|module:alpha",
    });
  });

  it("writes persisted positions into the opened repo", async () => {
    invokeMock.mockResolvedValue(undefined);

    await writeStoredGraphLayout("/workspace/project", "module|module:alpha", {
      nodes: {
        "module:alpha": { x: 120, y: -40 },
        "module:beta": { x: 440, y: 80 },
      },
      reroutes: [],
    });

    expect(invokeMock).toHaveBeenCalledWith("write_repo_graph_layout", {
      repoPath: "/workspace/project",
      viewKey: "module|module:alpha",
      layoutJson:
        "{\"nodes\":{\"module:alpha\":{\"x\":120,\"y\":-40},\"module:beta\":{\"x\":440,\"y\":80}},\"reroutes\":[]}",
    });
  });

  it("reads structured layouts with reroutes intact", async () => {
    invokeMock.mockResolvedValue({
      nodes: {
        "module:alpha": { x: 120, y: -40 },
      },
      reroutes: [
        {
          id: "reroute-1",
          edgeId: "calls:alpha:beta",
          order: 0,
          x: 280,
          y: 24,
        },
      ],
    });

    await expect(
      readStoredGraphLayout("/workspace/project", "module|module:alpha"),
    ).resolves.toEqual({
      nodes: {
        "module:alpha": { x: 120, y: -40 },
      },
      reroutes: [
        {
          id: "reroute-1",
          edgeId: "calls:alpha:beta",
          order: 0,
          x: 280,
          y: 24,
        },
      ],
    });
  });
});
