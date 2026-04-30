import type { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import {
  invalidateWorkspaceDataQueries,
  invalidateWorkspaceSyncQueries,
  workspaceQueryKeys,
} from "./workspaceQueries";

function fakeQueryClient() {
  const invalidateQueries = vi.fn(() => Promise.resolve());
  return {
    client: { invalidateQueries } as unknown as QueryClient,
    invalidateQueries,
  };
}

describe("workspaceQueries", () => {
  it("keeps route query key factories stable", () => {
    expect(workspaceQueryKeys.overview("repo")).toEqual(["overview", "repo"]);
    expect(workspaceQueryKeys.workspaceFile("repo", "pkg/mod.py")).toEqual([
      "workspace-file",
      "repo",
      "pkg/mod.py",
    ]);
    expect(
      workspaceQueryKeys.graphView(
        "repo",
        "module:pkg.mod",
        "module",
        { includeImports: true },
        { includeExternalDependencies: false },
      ),
    ).toEqual([
      "graph-view",
      "repo",
      "module:pkg.mod",
      "module",
      { includeImports: true },
      { includeExternalDependencies: false },
    ]);
  });

  it("can include editable source invalidation in full workspace refreshes", async () => {
    const { client, invalidateQueries } = fakeQueryClient();

    await invalidateWorkspaceDataQueries(client, { includeEditableSource: true });

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["editable-node-source"] });
  });

  it("only refreshes backend status during syncing-only events", async () => {
    const { client, invalidateQueries } = fakeQueryClient();

    await invalidateWorkspaceSyncQueries(client, { refreshWorkspaceData: false });

    expect(invalidateQueries).toHaveBeenCalledTimes(1);
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["backend-status"] });
  });
});
