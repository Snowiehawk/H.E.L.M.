import { describe, expect, it, vi } from "vitest";
import { saveNodeSourceCommand } from "./liveDesktopAdapter/sourceEdits";
import type { ScanCache } from "./liveDesktopAdapter/rawTypes";
import type { InvokeCommand } from "./liveDesktopAdapter/shared";

describe("declaration save optimistic baseline", () => {
  it("sends the exact loaded source baseline separately from the replacement", async () => {
    const invoke = vi.fn(async () => ({
      edit: {
        request: {},
        summary: "saved",
        touched_relative_paths: ["app.py"],
        reparsed_relative_paths: [],
        changed_node_ids: [],
        warnings: [],
      },
      payload: {},
    })) as unknown as InvokeCommand;
    const cache = { session: { path: "/repo" } } as ScanCache;
    await saveNodeSourceCommand(
      invoke,
      cache,
      "symbol:app:hello",
      "def hello():\n    return 2",
      "def hello():\n    return 1",
    );
    expect(invoke).toHaveBeenCalledWith("save_node_source", {
      repoPath: "/repo",
      targetId: "symbol:app:hello",
      contentJson: JSON.stringify("def hello():\n    return 2"),
      expectedSource: "def hello():\n    return 1",
    });
  });

  it("preserves a native stale-baseline rejection as a visible Error", async () => {
    const invoke = vi.fn(async () => {
      throw "This declaration changed on disk. Reload it before saving again.";
    }) as unknown as InvokeCommand;
    await expect(
      saveNodeSourceCommand(
        invoke,
        { session: { path: "/repo" } } as ScanCache,
        "symbol:app:hello",
        "replacement",
        "baseline",
      ),
    ).rejects.toThrow("changed on disk");
  });
});
