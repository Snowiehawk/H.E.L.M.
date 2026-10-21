import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { PropsWithChildren } from "react";
import type {
  DesktopAdapter,
  RepoSession,
  WorkspaceFileContents,
  WorkspaceFileMutationResult,
} from "../../lib/adapter";
import { useWorkspaceFileOperations } from "./useWorkspaceFileOperations";

const session: RepoSession = {
  id: "session",
  path: "/repo",
  name: "repo",
  branch: "main",
  primaryLanguage: "Python",
  openedAt: "now",
};
const file = (content: string, version: string): WorkspaceFileContents => ({
  relativePath: "notes.txt",
  name: "notes.txt",
  kind: "file",
  sizeBytes: content.length,
  editable: true,
  content,
  version,
});

async function setup(save: DesktopAdapter["saveWorkspaceFile"], readBack?: WorkspaceFileContents) {
  const read = vi
    .fn()
    .mockResolvedValueOnce(file("old", "old-version"))
    .mockResolvedValue(readBack ?? file("new", "new-version"));
  const adapter = { readWorkspaceFile: read, saveWorkspaceFile: save } as unknown as DesktopAdapter;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    () =>
      useWorkspaceFileOperations({
        adapter,
        queryClient: client,
        repoSession: session,
        focusGraph: vi.fn(),
        recordBackendUndoTransaction: vi.fn(),
        surfaceRecoveryEvents: vi.fn(),
      }),
    { wrapper },
  );
  act(() => hook.result.current.selectWorkspaceFile("notes.txt"));
  await waitFor(() => expect(hook.result.current.activeWorkspaceFile?.version).toBe("old-version"));
  await waitFor(() => expect(hook.result.current.workspaceFileDraft).toBe("old"));
  act(() => hook.result.current.setWorkspaceFileDraft("new"));
  await waitFor(() => expect(hook.result.current.workspaceFileDirty).toBe(true));
  return hook;
}

describe("authoritative workspace file save", () => {
  it("rejects a resolved save response without confirmed file bytes", async () => {
    const hook = await setup(vi.fn().mockResolvedValue({}));
    await act(async () => {
      await expect(hook.result.current.saveWorkspaceFileVerified()).rejects.toThrow(
        "did not confirm",
      );
    });
    expect(hook.result.current.workspaceFileDraft).toBe("new");
    expect(hook.result.current.workspaceFileSaveError).toContain("did not confirm");
  });

  it("rejects authoritative disk bytes differing from the save response", async () => {
    const hook = await setup(
      vi.fn().mockResolvedValue({ file: file("new", "new-version") }),
      file("external", "external-version"),
    );
    await act(async () => {
      await expect(hook.result.current.saveWorkspaceFileVerified()).rejects.toThrow(
        "file changed while saving",
      );
    });
    expect(hook.result.current.workspaceFileDraft).toBe("new");
  });

  it("preserves an edit made during a delayed successful save", async () => {
    let resolve!: (result: WorkspaceFileMutationResult) => void;
    const hook = await setup(
      vi.fn(
        () =>
          new Promise<WorkspaceFileMutationResult>((done) => {
            resolve = done;
          }),
      ),
    );
    let saving!: Promise<void>;
    act(() => {
      saving = hook.result.current.saveWorkspaceFileVerified();
    });
    act(() => hook.result.current.setWorkspaceFileDraft("newer edit"));
    await act(async () => {
      resolve({ file: file("new", "new-version") } as WorkspaceFileMutationResult);
      await expect(saving).rejects.toThrow("draft changed while saving");
    });
    expect(hook.result.current.workspaceFileDraft).toBe("newer edit");
  });

  it("confirms exact saved contents before reporting success", async () => {
    const hook = await setup(vi.fn().mockResolvedValue({ file: file("new", "new-version") }));
    await act(async () => {
      await hook.result.current.saveWorkspaceFileVerified();
    });
    expect(hook.result.current.workspaceFileSaveError).toBeNull();
    expect(hook.result.current.workspaceFileDraft).toBe("new");
    expect(hook.result.current.activeWorkspaceFile?.version).toBe("new-version");
  });
});

async function recoverySetup() {
  let disk = file("# external comment\nsource", "before");
  let pendingRead: (() => Promise<WorkspaceFileContents>) | undefined;
  const read = vi.fn(async (_repo: string, path: string) => {
    if (pendingRead && _repo === session.path && path === "notes.txt") return pendingRead();
    return { ...disk, relativePath: path };
  });
  const save = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    ({ repoSession }) =>
      useWorkspaceFileOperations({
        adapter: { readWorkspaceFile: read, saveWorkspaceFile: save } as unknown as DesktopAdapter,
        queryClient: client,
        repoSession,
        focusGraph: vi.fn(),
        recordBackendUndoTransaction: vi.fn(),
        surfaceRecoveryEvents: vi.fn(),
      }),
    { wrapper, initialProps: { repoSession: session } },
  );
  act(() => hook.result.current.selectWorkspaceFile("notes.txt"));
  await waitFor(() => expect(hook.result.current.workspaceFileDraft).toBe(disk.content));
  disk = file("source", "after");
  await act(async () => {
    await hook.result.current.workspaceFileQuery.refetch();
  });
  await waitFor(() => expect(hook.result.current.workspaceFileStale).toBe(true));
  return {
    ...hook,
    client,
    save,
    setPendingRead: (next: () => Promise<WorkspaceFileContents>) => {
      pendingRead = next;
    },
  };
}

describe("authoritative workspace file reload", () => {
  it("adopts disk bytes even when the changed disk version was already cached", async () => {
    const hook = await recoverySetup();
    expect(hook.result.current.activeWorkspaceFile?.content).toBe("source");
    expect(hook.result.current.workspaceFileDraft).toBe("# external comment\nsource");
    await act(async () => {
      await hook.result.current.handleCancelWorkspaceFileEdit();
    });
    await waitFor(() => expect(hook.result.current.workspaceFileDraft).toBe("source"));
    expect(hook.result.current.workspaceFileStale).toBe(false);
    expect(hook.result.current.workspaceFileDirty).toBe(false);
    expect(hook.save).not.toHaveBeenCalled();
  });

  it("keeps a failed reload stale and preserves the current draft", async () => {
    const hook = await recoverySetup();
    hook.setPendingRead(async () => {
      throw new Error("disk unavailable");
    });
    await act(async () => {
      await hook.result.current.handleCancelWorkspaceFileEdit();
    });
    expect(hook.result.current.workspaceFileStale).toBe(true);
    expect(hook.result.current.workspaceFileDraft).toBe("# external comment\nsource");
    expect(hook.result.current.workspaceFileSaveError).toContain("disk unavailable");
    expect(hook.result.current.workspaceFileQuery.error).toBeNull();
    hook.setPendingRead(async () => file("source", "after"));
    await act(async () => {
      await hook.result.current.handleCancelWorkspaceFileEdit();
    });
    expect(hook.result.current.workspaceFileDraft).toBe("source");
    expect(hook.result.current.workspaceFileStale).toBe(false);
    expect(hook.result.current.workspaceFileSaveError).toBeNull();
  });

  it("preserves an edit made and reversed while an authoritative reload is pending", async () => {
    const hook = await recoverySetup();
    let resolve!: (value: WorkspaceFileContents) => void;
    hook.setPendingRead(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    let reloading: unknown;
    act(() => {
      reloading = hook.result.current.handleCancelWorkspaceFileEdit();
    });
    expect(hook.result.current.workspaceFileStale).toBe(true);
    act(() => {
      hook.result.current.setWorkspaceFileDraft("later edit");
      hook.result.current.setWorkspaceFileDraft("# external comment\nsource");
    });
    await act(async () => {
      resolve(file("source", "after"));
      await reloading;
    });
    expect(hook.result.current.workspaceFileDraft).toBe("# external comment\nsource");
    expect(hook.result.current.workspaceFileStale).toBe(true);
  });

  it.each(["close", "switch", "session"])("ignores a pending reload after %s", async (action) => {
    const hook = await recoverySetup();
    let resolve!: (value: WorkspaceFileContents) => void;
    hook.setPendingRead(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    let reloading: unknown;
    act(() => {
      reloading = hook.result.current.handleCancelWorkspaceFileEdit();
    });
    if (action === "session") {
      hook.rerender({ repoSession: { ...session, id: "other-session", path: "/other" } });
    } else {
      act(() => {
        hook.result.current.resetWorkspaceFileState();
        if (action === "switch") hook.result.current.selectWorkspaceFile("other.txt");
      });
    }
    await act(async () => {
      resolve(file("obsolete reload", "obsolete"));
      await reloading;
    });
    if (action === "close") expect(hook.result.current.workspaceFileDraft).toBe("");
    if (action === "switch") {
      await waitFor(() => expect(hook.result.current.workspaceFileDraft).toBe("source"));
      expect(hook.result.current.activeWorkspaceFilePath).toBe("other.txt");
    }
    expect(hook.result.current.workspaceFileDraft).not.toBe("obsolete reload");
  });

  it("ignores a reload after unmount instead of updating a future owner's cache", async () => {
    const hook = await recoverySetup();
    let resolve!: (value: WorkspaceFileContents) => void;
    hook.setPendingRead(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    let reloading: unknown;
    act(() => {
      reloading = hook.result.current.handleCancelWorkspaceFileEdit();
    });
    hook.unmount();
    await act(async () => {
      resolve(file("obsolete reload", "obsolete"));
      await reloading;
    });
    expect(
      hook.client.getQueryData<WorkspaceFileContents>(["workspace-file", session.id, "notes.txt"])
        ?.content,
    ).toBe("source");
  });

  it("adopts a newer authoritative version and its bytes together", async () => {
    const hook = await recoverySetup();
    hook.setPendingRead(async () => file("newer disk", "newest"));
    await act(async () => {
      await hook.result.current.handleCancelWorkspaceFileEdit();
    });
    await waitFor(() => expect(hook.result.current.activeWorkspaceFile?.version).toBe("newest"));
    expect(hook.result.current.workspaceFileDraft).toBe("newer disk");
    expect(hook.result.current.workspaceFileStale).toBe(false);
    expect(hook.result.current.workspaceFileDirty).toBe(false);
  });
});
