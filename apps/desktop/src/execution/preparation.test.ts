import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopAdapter } from "../lib/adapter/contracts";
import { freezeWorkspaceMutationAdmission, trackDesktopMutations } from "./mutationTracking";
import {
  assertWorkspacePreparationCurrent,
  prepareWorkspaceToRun,
  readWorkspacePreparationSnapshot,
  registerWorkspacePreparation,
  type PreparedSource,
  type WorkspacePreparationSnapshot,
} from "./preparation";

const source: PreparedSource = { repoPath: "/repo", files: [], indexedSymbols: [] };
let unregister: (() => void) | undefined;
afterEach(() => unregister?.());

function setup(overrides: Partial<WorkspacePreparationSnapshot> = {}) {
  const snapshot: WorkspacePreparationSnapshot = {
    repoPath: "/repo",
    sessionId: "session:1",
    availability: "ready",
    dirty: false,
    stale: false,
    busy: false,
    revision: "exact draft",
    blockers: [],
    saves: [],
    ...overrides,
  };
  unregister = registerWorkspacePreparation(() => snapshot);
  return snapshot;
}

describe("verified Save and Run barrier", () => {
  it("saves in order and freezes only after each authoritative save succeeds", async () => {
    const order: string[] = [];
    setup({
      saves: [
        async () => {
          order.push("declaration");
        },
        async () => {
          order.push("file");
        },
      ],
    });
    const receipt = await prepareWorkspaceToRun("/repo", "session:1", async () => {
      order.push("freeze");
      return source;
    });
    expect(order).toEqual(["declaration", "file", "freeze"]);
    expect(receipt.preparedSource).toBe(source);
    expect(() => assertWorkspacePreparationCurrent(receipt)).not.toThrow();
  });

  it("never freezes/launches a stale, conflicting, unsupported or in-flight draft", async () => {
    const freeze = vi.fn(async () => source);
    const save = vi.fn(async () => {});
    setup({ blockers: ["Finish the flow draft first."], saves: [save] });
    await expect(prepareWorkspaceToRun("/repo", "session:1", freeze)).rejects.toThrow("flow draft");
    expect(save).not.toHaveBeenCalled();
    expect(freeze).not.toHaveBeenCalled();
  });

  it("preserves a save rejection and does not freeze old disk source", async () => {
    const freeze = vi.fn(async () => source);
    setup({
      saves: [
        async () => {
          throw new Error("disk version changed");
        },
      ],
    });
    await expect(prepareWorkspaceToRun("/repo", "session:1", freeze)).rejects.toThrow(
      "disk version",
    );
    expect(freeze).not.toHaveBeenCalled();
  });

  it("rejects content changes while already dirty during save", async () => {
    const freeze = vi.fn(async () => source);
    const snapshot = setup();
    snapshot.saves = [
      async () => {
        snapshot.revision = "new exact content, still dirty";
      },
    ];
    await expect(prepareWorkspaceToRun("/repo", "session:1", freeze)).rejects.toThrow(
      "Edits changed",
    );
    expect(freeze).not.toHaveBeenCalled();
  });

  it("accepts only the exact owner-certified normalization and keeps its receipt immutable", async () => {
    const snapshot = setup({ revision: "submitted declaration" });
    snapshot.saves = [
      async () => {
        snapshot.revision = "confirmed declaration\n";
        return { previousRevision: "submitted declaration", revision: "confirmed declaration\n" };
      },
    ];
    const receipt = await prepareWorkspaceToRun("/repo", "session:1", async () => source);
    expect(receipt.revision).toBe("confirmed declaration\n");
    expect(() => assertWorkspacePreparationCurrent(receipt)).not.toThrow();
    snapshot.revision = "confirmed declaration\n\n";
    expect(() => assertWorkspacePreparationCurrent(receipt)).toThrow("Edits changed");
  });

  it.each(["extra newline\n", "CRLF\r\n", "other file changed", "flow draft changed"])(
    "refuses a concurrent %s instead of adopting it into the verified save revision",
    async (concurrent) => {
      const snapshot = setup({ revision: "submitted declaration" });
      snapshot.saves = [
        async () => {
          snapshot.revision = concurrent;
          return { previousRevision: "submitted declaration", revision: "confirmed declaration\n" };
        },
      ];
      const freeze = vi.fn(async () => source);
      await expect(prepareWorkspaceToRun("/repo", "session:1", freeze)).rejects.toThrow(
        "Edits changed",
      );
      expect(freeze).not.toHaveBeenCalled();
    },
  );

  it("refuses normalization certified for a different starting revision", async () => {
    const snapshot = setup({ revision: "submitted declaration" });
    snapshot.saves = [
      async () => {
        snapshot.revision = "confirmed declaration\n";
        return { previousRevision: "another draft", revision: "confirmed declaration\n" };
      },
    ];
    const freeze = vi.fn(async () => source);
    await expect(prepareWorkspaceToRun("/repo", "session:1", freeze)).rejects.toThrow(
      "before the verified save",
    );
    expect(freeze).not.toHaveBeenCalled();
  });

  it("rejects a later edit during freeze after accepting the owned normalization", async () => {
    const snapshot = setup({ revision: "submitted declaration" });
    snapshot.saves = [
      async () => {
        snapshot.revision = "confirmed declaration\n";
        return { previousRevision: "submitted declaration", revision: snapshot.revision };
      },
    ];
    await expect(
      prepareWorkspaceToRun("/repo", "session:1", async () => {
        await Promise.resolve();
        snapshot.revision += "\n";
        return source;
      }),
    ).rejects.toThrow("Edits changed");
  });

  it("retains cancellation and provider ownership checks after certified normalization", async () => {
    for (const change of ["cancel", "provider"] as const) {
      const snapshot = setup({ revision: "submitted declaration" });
      const controller = new AbortController();
      snapshot.saves = [
        async () => {
          snapshot.revision = "confirmed declaration\n";
          if (change === "cancel") controller.abort();
          else {
            unregister?.();
            setup({ revision: snapshot.revision });
          }
          return { previousRevision: "submitted declaration", revision: "confirmed declaration\n" };
        },
      ];
      const freeze = vi.fn(async () => source);
      await expect(
        prepareWorkspaceToRun("/repo", "session:1", freeze, controller.signal),
      ).rejects.toThrow(change === "cancel" ? "canceled" : "workspace changed");
      expect(freeze).not.toHaveBeenCalled();
    }
  });

  it("rejects a project replacement after a delayed successful source freeze", async () => {
    const snapshot = setup();
    await expect(
      prepareWorkspaceToRun("/repo", "session:1", async () => {
        snapshot.sessionId = "session:2";
        return source;
      }),
    ).rejects.toThrow("Edits changed");
  });

  it("checks cancellation after a committed save before any source admission", async () => {
    const controller = new AbortController();
    const freeze = vi.fn(async () => source);
    setup({ saves: [async () => controller.abort()] });
    await expect(
      prepareWorkspaceToRun("/repo", "session:1", freeze, controller.signal),
    ).rejects.toThrow("canceled");
    expect(freeze).not.toHaveBeenCalled();
  });

  it("invalidates the receipt on edits or provider replacement immediately before launch", async () => {
    const snapshot = setup();
    const receipt = await prepareWorkspaceToRun("/repo", "session:1", async () => source);
    snapshot.revision = "changed";
    expect(() => assertWorkspacePreparationCurrent(receipt)).toThrow("Edits changed");
    snapshot.revision = receipt.revision;
    unregister?.();
    expect(() => assertWorkspacePreparationCurrent(receipt)).toThrow("workspace changed");
  });

  it("allows its verified save but refuses an unrelated completed mutation during freeze", async () => {
    const adapter = trackDesktopMutations({
      saveNodeSource: vi.fn(async () => ({})),
      applyStructuralEdit: vi.fn(async () => ({})),
    } as unknown as DesktopAdapter);
    setup({
      saves: [
        async () => {
          await adapter.saveNodeSource("symbol:app:run", "def run(): pass");
        },
      ],
    });
    const receipt = await prepareWorkspaceToRun("/repo", "session:1", async () => source);
    expect(() => assertWorkspacePreparationCurrent(receipt)).not.toThrow();
    await adapter.applyStructuralEdit({
      kind: "rename_symbol",
      targetId: "symbol:app:run",
      newName: "new_run",
    });
    expect(() => assertWorkspacePreparationCurrent(receipt)).toThrow("workspace mutation changed");
    setup();
    await expect(
      prepareWorkspaceToRun("/repo", "session:1", async () => {
        await adapter.applyStructuralEdit({
          kind: "rename_symbol",
          targetId: "symbol:app:new_run",
          newName: "run",
        });
        return source;
      }),
    ).rejects.toThrow("workspace mutation changed");
  });

  it("refuses an already pending Undo before any preparation callback", async () => {
    let finish!: () => void;
    const adapter = trackDesktopMutations({
      applyBackendUndo: vi.fn(
        () =>
          new Promise((resolve) => {
            finish = () => resolve({});
          }),
      ),
    } as unknown as DesktopAdapter);
    setup();
    const undo = adapter.applyBackendUndo({} as never);
    const freeze = vi.fn(async () => source);
    await expect(prepareWorkspaceToRun("/repo", "session:1", freeze)).rejects.toThrow(
      "workspace mutation",
    );
    expect(freeze).not.toHaveBeenCalled();
    finish();
    await undo;
  });
});

describe("workspace lifetime admission", () => {
  it("blocks Run and navigation while frozen and invalidates callbacks after freeze ABA", async () => {
    setup();
    const run = vi.fn(async () => source);
    const before = readWorkspacePreparationSnapshot()!.revision;
    const freeze = freezeWorkspaceMutationAdmission();
    try {
      expect(readWorkspacePreparationSnapshot()!.blockers.join(" ")).toContain("Source navigation");
      await expect(prepareWorkspaceToRun("/repo", "session:1", run)).rejects.toThrow("refused");
      expect(run).not.toHaveBeenCalled();
    } finally {
      freeze.release();
    }
    expect(readWorkspacePreparationSnapshot()!.revision).not.toBe(before);
  });
});
