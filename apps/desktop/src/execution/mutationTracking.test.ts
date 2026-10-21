import { describe, expect, it, vi } from "vitest";
import type { DesktopAdapter } from "../lib/adapter/contracts";
import {
  freezeWorkspaceMutationAdmission,
  isWorkspaceInstallationFrozen,
  trackDesktopMutations,
  workspaceMutationState,
} from "./mutationTracking";

describe("installation mutation admission", () => {
  it("rejects programmatic source writes, indexing and replacement without calling the adapter", async () => {
    const write = vi.fn(async () => ({}));
    const adapter = trackDesktopMutations({
      applyStructuralEdit: write,
      openRepo: write,
      startIndex: write,
      saveWorkspaceFile: write,
    } as unknown as DesktopAdapter);
    const freeze = freezeWorkspaceMutationAdmission();
    try {
      await expect(adapter.applyStructuralEdit({ kind: "rename_symbol" })).rejects.toThrow(
        "refused",
      );
      await expect(adapter.openRepo("/repo")).rejects.toThrow("refused");
      await expect(adapter.startIndex("/repo")).rejects.toThrow("refused");
      await expect(
        adapter.saveWorkspaceFile("/repo", "app.py", "draft", "version"),
      ).rejects.toThrow("refused");
      expect(write).not.toHaveBeenCalled();
      expect(workspaceMutationState().active).toBe(0);
    } finally {
      freeze.release();
    }
  });

  it("permits only the chosen save's synchronous entry and never grants delayed callbacks admission", async () => {
    const save = vi.fn(async () => ({}));
    const replace = vi.fn(async () => ({}));
    const adapter = trackDesktopMutations({
      saveNodeSource: save,
      openRepo: replace,
    } as unknown as DesktopAdapter);
    const freeze = freezeWorkspaceMutationAdmission();
    try {
      await freeze.save(() => adapter.saveNodeSource("symbol:a:f", "def f(): pass", "baseline"));
      expect(save).toHaveBeenCalledTimes(1);
      await expect(
        freeze.save(async () => {
          await Promise.resolve();
          return adapter.saveNodeSource("symbol:a:f", "def f(): pass", "baseline");
        }),
      ).rejects.toThrow("refused");
      await expect(freeze.save(() => adapter.openRepo("/other"))).rejects.toThrow("refused");
      expect(save).toHaveBeenCalledTimes(1);
      expect(replace).not.toHaveBeenCalled();
    } finally {
      freeze.release();
    }
  });

  it("advances admission epoch through freeze/release ABA and releases exactly once", () => {
    const before = workspaceMutationState().started;
    const freeze = freezeWorkspaceMutationAdmission();
    expect(isWorkspaceInstallationFrozen()).toBe(true);
    expect(workspaceMutationState().started).toBe(before + 1);
    freeze.release();
    expect(isWorkspaceInstallationFrozen()).toBe(false);
    expect(workspaceMutationState().started).toBe(before + 2);
    freeze.release();
    expect(workspaceMutationState().started).toBe(before + 2);
  });
});
