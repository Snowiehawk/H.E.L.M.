import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopAdapter, GraphView, WorkspaceFileContents } from "../../lib/adapter";
import { navigateRunDiagnostic } from "../../execution/navigation";
import { registerWorkspacePreparation } from "../../execution/preparation";
import { useExecutionSourceNavigation } from "./useExecutionSourceNavigation";

afterEach(() => vi.unstubAllGlobals());
const sourceHash = "a".repeat(64);
const context = {
  contextId: "old-run",
  repoPath: "/fixture",
  generation: "session-one",
  trustRevision: 1,
  trusted: true,
};
const preparedSource = {
  repoPath: "/fixture",
  files: [{ relativePath: "main.py", sha256: sourceHash }],
  indexedSymbols: [
    {
      nodeId: "symbol:main:run",
      relativePath: "main.py",
      sourceHash,
      startLine: 1,
      startColumn: 0,
      endLine: 2,
      endColumn: 10,
    },
  ],
};
const graph: GraphView = {
  rootNodeId: "module:main",
  targetId: "symbol:main:run",
  level: "symbol",
  nodes: [
    {
      id: "symbol:main:run",
      kind: "function",
      label: "run",
      x: 0,
      y: 0,
      availableActions: [],
      metadata: {
        relative_path: "main.py",
        source_start_line: 1,
        source_start_column: 0,
        source_end_line: 2,
        source_end_column: 10,
      },
    },
  ],
  edges: [],
  breadcrumbs: [],
  truncated: false,
};
const file: WorkspaceFileContents = {
  kind: "file",
  relativePath: "main.py",
  name: "main.py",
  editable: true,
  content: "def run():\r\n  return 1\r\n",
  version: "original-disk-version",
};

describe("IDE diagnostic admission", () => {
  it.each(["draft", "cancel", "replacement"])(
    "a delayed file reply cannot navigate after %s supersedes it",
    async (change) => {
      vi.stubGlobal("crypto", {
        subtle: { digest: vi.fn(async () => new Uint8Array(32).fill(0xaa).buffer) },
      });
      let completeRead!: (value: WorkspaceFileContents) => void;
      let dirty = false;
      const read = vi.fn().mockReturnValue(
        new Promise<WorkspaceFileContents>((resolve) => {
          completeRead = resolve;
        }),
      );
      const openFile = vi.fn();
      const focusSymbol = vi.fn();
      const dispose = registerWorkspacePreparation(() => ({
        repoPath: "/fixture",
        sessionId: "session-one",
        availability: "ready",
        dirty: false,
        stale: false,
        busy: false,
        revision: "same",
        blockers: [],
        saves: [],
      }));
      const session = {
        id: "session-one",
        name: "Fixture",
        path: "/fixture",
        branch: "main",
        primaryLanguage: "Python",
        openedAt: "2026-10-20T00:00:00Z",
      };
      const hook = renderHook(
        ({ currentSession }) =>
          useExecutionSourceNavigation({
            session: currentSession,
            adapter: { readWorkspaceFile: read } as unknown as DesktopAdapter,
            graphFilters: { includeCalls: false, includeDefines: true, includeImports: false },
            graphSettings: { includeExternalDependencies: false },
            hasUnsavedDrafts: () => dirty,
            openFile,
            focusSymbol,
          }),
        { initialProps: { currentSession: session } },
      );
      const abort = new AbortController();
      const promise = navigateRunDiagnostic({
        context,
        preparedSource,
        signal: abort.signal,
        location: {
          relativePath: "main.py",
          line: 2,
          column: 3,
          currentHash: sourceHash,
          sourceMatches: true,
        },
      });
      const rejected = expect(promise).rejects.toThrow(
        change === "draft" ? "drafts" : change === "cancel" ? "canceled" : "workspace",
      );
      try {
        await waitFor(() => expect(read).toHaveBeenCalledOnce());
        if (change === "draft") dirty = true;
        else if (change === "cancel") abort.abort();
        else
          hook.rerender({
            currentSession: { ...session, id: "replacement", path: "/replacement" },
          });
        await act(async () => {
          completeRead(file);
        });
        await rejected;
        expect(openFile).not.toHaveBeenCalled();
        expect(focusSymbol).not.toHaveBeenCalled();
        expect(file.content).toBe("def run():\r\n  return 1\r\n");
      } finally {
        hook.unmount();
        dispose();
      }
    },
  );
  it.each([false, true])(
    "opens a validated file once with stale=%s and never selects an unproven graph node",
    async (stale) => {
      const hash = stale ? "b".repeat(64) : sourceHash;
      vi.stubGlobal("crypto", {
        subtle: { digest: vi.fn(async () => new Uint8Array(32).fill(stale ? 0xbb : 0xaa).buffer) },
      });
      const read = vi.fn().mockResolvedValue(file);
      const getGraphView = vi.fn();
      const openFile = vi.fn();
      const focusSymbol = vi.fn();
      const dispose = registerWorkspacePreparation(() => ({
        repoPath: "/fixture",
        sessionId: "session-one",
        availability: "ready",
        dirty: false,
        stale: false,
        busy: false,
        revision: "same",
        blockers: [],
        saves: [],
      }));
      const hook = renderHook(() =>
        useExecutionSourceNavigation({
          session: {
            id: "session-one",
            name: "Fixture",
            path: "/fixture",
            branch: "main",
            primaryLanguage: "Python",
            openedAt: "2026-10-20T00:00:00Z",
          },
          adapter: { readWorkspaceFile: read, getGraphView } as unknown as DesktopAdapter,
          graphFilters: { includeCalls: false, includeDefines: true, includeImports: false },
          graphSettings: { includeExternalDependencies: false },
          hasUnsavedDrafts: () => false,
          openFile,
          focusSymbol,
        }),
      );
      const location = {
        relativePath: "main.py",
        line: 2,
        column: 3,
        currentHash: hash,
        sourceMatches: !stale,
      };
      try {
        const result = await navigateRunDiagnostic({
          context,
          preparedSource: { ...preparedSource, indexedSymbols: [] },
          location,
        });
        expect(result.status).toBe(stale ? "stale" : "unmapped");
        expect(openFile).toHaveBeenCalledOnce();
        expect(openFile).toHaveBeenCalledWith(location, file);
        expect(focusSymbol).not.toHaveBeenCalled();
        expect(getGraphView).not.toHaveBeenCalled();
        expect(read).toHaveBeenCalledTimes(2);
      } finally {
        hook.unmount();
        dispose();
      }
    },
  );
  it("rechecks actual CRLF source after a delayed graph read before changing the IDE", async () => {
    vi.stubGlobal("crypto", {
      subtle: {
        digest: vi.fn(
          async (_algorithm: string, bytes: BufferSource) =>
            new Uint8Array(32).fill(new TextDecoder().decode(bytes) === file.content ? 0xaa : 0xbb)
              .buffer,
        ),
      },
    });
    let completeGraph!: (value: GraphView) => void;
    const read = vi
      .fn()
      .mockResolvedValueOnce(file)
      .mockResolvedValueOnce({
        ...file,
        content: "def run():\r\n  return 2\r\n",
        version: "external-disk-change",
      });
    const getGraphView = vi.fn().mockReturnValue(
      new Promise<GraphView>((resolve) => {
        completeGraph = resolve;
      }),
    );
    const openFile = vi.fn();
    const focusSymbol = vi.fn();
    const dispose = registerWorkspacePreparation(() => ({
      repoPath: "/fixture",
      sessionId: "session-one",
      availability: "ready",
      dirty: false,
      stale: false,
      busy: false,
      revision: "unchanged-UI",
      blockers: [],
      saves: [],
    }));
    const hook = renderHook(() =>
      useExecutionSourceNavigation({
        session: {
          id: "session-one",
          name: "Fixture",
          path: "/fixture",
          branch: "main",
          primaryLanguage: "Python",
          openedAt: "2026-10-20T00:00:00Z",
        },
        adapter: { readWorkspaceFile: read, getGraphView } as unknown as DesktopAdapter,
        graphFilters: { includeCalls: false, includeDefines: true, includeImports: false },
        graphSettings: { includeExternalDependencies: false },
        hasUnsavedDrafts: () => false,
        openFile,
        focusSymbol,
      }),
    );
    const promise = navigateRunDiagnostic({
      context,
      preparedSource,
      location: {
        relativePath: "main.py",
        line: 2,
        column: 3,
        currentHash: sourceHash,
        sourceMatches: true,
        lineText: "  return 1",
      },
    });
    const rejected = expect(promise).rejects.toThrow("changed while loading its graph");
    await waitFor(() => expect(getGraphView).toHaveBeenCalledTimes(1));
    await act(async () => {
      completeGraph(graph);
    });
    await rejected;
    expect(read).toHaveBeenCalledTimes(2);
    expect(openFile).not.toHaveBeenCalled();
    expect(focusSymbol).not.toHaveBeenCalled();
    hook.unmount();
    dispose();
  });
});
