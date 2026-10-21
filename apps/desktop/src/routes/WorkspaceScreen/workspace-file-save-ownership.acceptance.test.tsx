import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BackendUndoTransaction,
  DesktopAdapter,
  RepoSession,
  WorkspaceFileContents,
  WorkspaceFileMutationResult,
} from "../../lib/adapter";
import { useWorkspaceFileOperations } from "./useWorkspaceFileOperations";

const session: RepoSession = {
  id: "owned",
  path: "/owned",
  name: "owned",
  branch: "dev",
  primaryLanguage: "Python",
  openedAt: "now",
};
const file = (
  relativePath: string,
  content: string,
  version = "before",
): WorkspaceFileContents => ({
  relativePath,
  name: relativePath,
  kind: "file",
  editable: true,
  content,
  version,
  sizeBytes: content.length,
});
const undo: BackendUndoTransaction = {
  summary: "Saved old file",
  requestKind: "workspace.save",
  fileSnapshots: [],
  changedNodeIds: [],
};
async function mount(beginSave = true) {
  const files = new Map([
    ["notes.txt", file("notes.txt", "old")],
    ["other.txt", file("other.txt", "other")],
  ]);
  let complete!: (value: WorkspaceFileMutationResult) => void;
  const save = vi.fn(
    () =>
      new Promise<WorkspaceFileMutationResult>((done) => {
        complete = done;
      }),
  );
  const record = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const adapter = {
    readWorkspaceFile: vi.fn(async (_repo: string, path: string) => files.get(path)),
    saveWorkspaceFile: save,
  } as unknown as DesktopAdapter;
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    ({ repoSession }) =>
      useWorkspaceFileOperations({
        adapter,
        queryClient: client,
        repoSession,
        focusGraph: vi.fn(),
        recordBackendUndoTransaction: record,
        surfaceRecoveryEvents: vi.fn(),
      }),
    { wrapper, initialProps: { repoSession: session } },
  );
  act(() => hook.result.current.selectWorkspaceFile("notes.txt"));
  await waitFor(() => expect(hook.result.current.workspaceFileDraft).toBe("old"));
  act(() => hook.result.current.setWorkspaceFileDraft(""));
  const capturedSave = hook.result.current.saveWorkspaceFileVerified;
  let saving: Promise<void> = Promise.resolve();
  if (beginSave)
    act(() => {
      saving = capturedSave();
    });
  // Attach a handler immediately; later completion intentionally rejects.
  const settled = saving.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  return {
    ...hook,
    client,
    files,
    record,
    save,
    capturedSave,
    settled,
    complete: () => {
      const written = file("notes.txt", "", "after");
      files.set("notes.txt", written);
      complete({
        relativePath: "notes.txt",
        kind: "file",
        changedRelativePaths: ["notes.txt"],
        file: written,
        undoTransaction: undo,
      });
    },
  };
}
afterEach(() => vi.restoreAllMocks());

describe("#101 late file-save ownership", () => {
  it("refuses a captured retired save callback before issuing a write", async () => {
    const hook = await mount(false);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    act(() => hook.result.current.handleCloseWorkspaceFileEditor());
    let saving!: Promise<void>;
    act(() => {
      saving = hook.capturedSave();
    });
    const settled = saving.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    const issuedWrites = hook.save.mock.calls.length;
    // Reap the deliberately bad baseline write instead of leaving a pending
    // test promise; the corrected admission path must never enter this branch.
    if (issuedWrites)
      await act(async () => {
        hook.complete();
        await settled;
      });
    expect(issuedWrites).toBe(0);
    expect(await settled).toBeInstanceOf(Error);
    expect(hook.result.current.activeWorkspaceFilePath).toBeUndefined();
    expect(hook.result.current.workspaceFileSaveError).toBeNull();
  });

  it.each(["close", "switch", "cancel"] as const)(
    "does not let late save alter a retired %s editor",
    async (action) => {
      const hook = await mount();
      if (action === "close") {
        vi.spyOn(window, "confirm").mockReturnValue(true);
        act(() => hook.result.current.handleCloseWorkspaceFileEditor());
      } else if (action === "switch") {
        act(() => hook.result.current.selectWorkspaceFile("other.txt"));
        await waitFor(() => expect(hook.result.current.workspaceFileDraft).toBe("other"));
        // Equal text does not make this new file the old save's owner.
        act(() => hook.result.current.setWorkspaceFileDraft(""));
      } else
        await act(async () => {
          await hook.result.current.handleCancelWorkspaceFileEdit();
        });
      await act(async () => {
        hook.complete();
        await hook.settled;
      });
      expect(hook.result.current.workspaceFileSaveError).toBeNull();
      expect(hook.result.current.workspaceFileStale).toBe(false);
      expect(hook.result.current.activeWorkspaceFilePath).toBe(
        action === "close" ? undefined : action === "switch" ? "other.txt" : "notes.txt",
      );
      expect(hook.result.current.workspaceFileDraft).toBe(action === "cancel" ? "old" : "");
      expect(
        hook.client.getQueryData<WorkspaceFileContents>(["workspace-file", session.id, "notes.txt"])
          ?.version,
      ).toBe("before");
      // The confirmed write is still real and retains Undo in its original session.
      expect(hook.record).toHaveBeenCalledExactlyOnceWith(undo);
      expect(await hook.settled).toBeInstanceOf(Error);
    },
  );

  it.each(["session", "unmount"] as const)(
    "never records old Undo or updates cache after %s replacement",
    async (action) => {
      const hook = await mount();
      if (action === "session")
        hook.rerender({ repoSession: { ...session, id: "new", path: "/new" } });
      else hook.unmount();
      await act(async () => {
        hook.complete();
        await hook.settled;
      });
      expect(hook.record).not.toHaveBeenCalled();
      expect(
        hook.client.getQueryData<WorkspaceFileContents>(["workspace-file", session.id, "notes.txt"])
          ?.version,
      ).toBe("before");
      expect(await hook.settled).toBeInstanceOf(Error);
    },
  );

  it("detects content edit-and-reverse ABA while a save is pending", async () => {
    const hook = await mount();
    act(() => {
      hook.result.current.setWorkspaceFileDraft("new edit");
      hook.result.current.setWorkspaceFileDraft("");
    });
    await act(async () => {
      hook.complete();
      await hook.settled;
    });
    expect(await hook.settled).toBeInstanceOf(Error);
    expect(hook.result.current.workspaceFileDraft).toBe("");
    expect(
      hook.client.getQueryData<WorkspaceFileContents>(["workspace-file", session.id, "notes.txt"])
        ?.version,
    ).toBe("before");
    expect(hook.record).toHaveBeenCalledExactlyOnceWith(undo);
  });
});
