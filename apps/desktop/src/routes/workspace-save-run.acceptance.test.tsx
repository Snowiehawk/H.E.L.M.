import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppProviders } from "../app/AppProviders";
import { ExecutionWorkspace } from "../execution/ExecutionWorkspace";
import { resetExecutionActions, useExecutionActions } from "../execution/actions";
import { readWorkspacePreparationSnapshot } from "../execution/preparation";
import type { ExecutionContext } from "../execution/contracts";
import type { ExecutionSnapshot } from "../execution/adapter";
import type { GraphNodeKind, WorkspaceFileMutationResult } from "../lib/adapter";
import { MockDesktopAdapter } from "../lib/adapter/mockDesktopAdapter";
import { buildRepoSession } from "../lib/mocks/mockData";
import { useUiStore } from "../store/uiStore";
import { useUndoStore } from "../store/undoStore";
import { WorkspaceScreen } from "./WorkspaceScreen";

// Real WorkspaceScreen draft owners, verified save hooks, preparation and execution
// controller. Only visual surfaces and native/process/config boundaries are fake.
const native = vi.hoisted(() => ({ invoke: vi.fn(), start: vi.fn(), bind: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ setZoom: vi.fn(async () => {}) }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn(async () => true) }));
vi.mock("../execution/configService", () => ({
  executionConfigService: {
    bind: native.bind,
    read: vi.fn(async () => ({
      schemaVersion: 1,
      revision: 1,
      defaultId: "app",
      configs: [
        {
          id: "app",
          name: "Fixture",
          kind: "app",
          mode: "executable",
          executable: "fixture-python",
          args: ["fixture.py"],
          cwd: ".",
          command: "",
          env: {},
          secretNames: [],
        },
      ],
    })),
    suggestions: vi.fn(async () => []),
  },
}));
vi.mock("../execution/adapter", () => ({ executionAdapter: { startRun: native.start } }));
vi.mock("../execution/RunOutputNavigation", () => ({ RunOutputNavigation: () => null }));
vi.mock("../components/editor/InspectorCodeSurface", () => ({
  InspectorCodeSurface: ({
    ariaLabel,
    value,
    readOnly,
    onChange,
  }: {
    ariaLabel: string;
    value: string;
    readOnly: boolean;
    onChange?: (value: string) => void;
  }) => (
    <textarea
      aria-label={ariaLabel}
      value={value}
      readOnly={readOnly}
      onChange={(event) => onChange?.(event.target.value)}
    />
  ),
}));
vi.mock("../components/panes/SidebarPane", () => ({
  SidebarPane: ({ onSelectWorkspaceFile }: { onSelectWorkspaceFile: (path: string) => void }) => (
    <nav aria-label="Fixture file selection">
      {["notes.txt", "other.txt", "src/helm/ui/api.py"].map((path) => (
        <button key={path} onClick={() => onSelectWorkspaceFile(path)}>
          Open {path}
        </button>
      ))}
    </nav>
  ),
}));
vi.mock("../components/graph/GraphCanvas", () => ({
  GraphCanvas: ({
    onInspectNode,
  }: {
    onInspectNode: (id: string, kind: GraphNodeKind) => void;
  }) => (
    <button onClick={() => onInspectNode("module:helm.ui.api", "module")}>
      Inspect fixture module
    </button>
  ),
}));

const fixtureSession = buildRepoSession();
const textDraft = "saved café 🧭\r\nsecond line\r\n";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function mount() {
  const adapter = new MockDesktopAdapter();
  await adapter.createWorkspaceEntry(fixtureSession.path, {
    kind: "file",
    relativePath: "notes.txt",
    content: "baseline\n",
  });
  await adapter.createWorkspaceEntry(fixtureSession.path, {
    kind: "file",
    relativePath: "other.txt",
    content: "other baseline\n",
  });
  const originalFileSave = adapter.saveWorkspaceFile.bind(adapter);
  const saveFile = vi.spyOn(adapter, "saveWorkspaceFile");
  const saveSource = vi.spyOn(adapter, "saveNodeSource");
  let client!: QueryClient;
  function CaptureQueries() {
    client = useQueryClient();
    client.setDefaultOptions({ queries: { retry: false } });
    return null;
  }
  const router = createMemoryRouter([{ path: "/workspace", element: <WorkspaceScreen /> }], {
    initialEntries: ["/workspace"],
  });
  const view = render(
    <AppProviders adapter={adapter}>
      <CaptureQueries />
      <ExecutionWorkspace>
        <RouterProvider router={router} />
      </ExecutionWorkspace>
    </AppProviders>,
  );
  await waitFor(() => expect(readWorkspacePreparationSnapshot()?.availability).toBe("ready"));
  await waitFor(() => expect(useExecutionActions.getState().canRun).toBe(true));
  return { adapter, saveFile, saveSource, originalFileSave, client, ...view };
}
async function editFile(path = "notes.txt", draft = textDraft) {
  fireEvent.click(screen.getByRole("button", { name: `Open ${path}` }));
  const editor = await screen.findByRole("textbox", { name: `Edit ${path}` });
  await waitFor(() => expect(readWorkspacePreparationSnapshot()?.availability).toBe("ready"));
  fireEvent.change(editor, { target: { value: draft } });
  await waitFor(() => expect(readWorkspacePreparationSnapshot()?.dirty).toBe(true));
  return editor;
}
async function editDeclaration() {
  fireEvent.click(await screen.findByRole("button", { name: "Inspect fixture module" }));
  const editor = await screen.findByRole("textbox", { name: /Module source editor/ });
  const draft = (editor as HTMLTextAreaElement).value.trimEnd() + "\n# retained café 🧭\n";
  fireEvent.change(editor, { target: { value: draft } });
  await waitFor(() => expect(readWorkspacePreparationSnapshot()?.dirty).toBe(true));
  return { editor, draft };
}
async function run() {
  act(() => useExecutionActions.getState().run());
}
async function refused(message: RegExp) {
  await waitFor(() => expect(screen.getAllByText(message).length).toBeGreaterThan(0));
  await waitFor(() => expect(useExecutionActions.getState().canRun).toBe(true));
  expect(native.start).not.toHaveBeenCalled();
  expect(
    native.invoke.mock.calls.filter(([command]) => command === "prepare_run_source"),
  ).toHaveLength(0);
}

beforeEach(() => {
  localStorage.clear();
  native.invoke.mockReset();
  native.start.mockReset();
  native.bind.mockReset();
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  useUiStore.getState().resetWorkspace();
  useUiStore.setState({
    repoSession: fixtureSession,
    indexingSession: undefined,
    activeLevel: "module",
    graphTargetId: fixtureSession.id,
    activeNodeId: fixtureSession.id,
    preferencesOpen: false,
    paletteOpen: false,
    sidebarQuery: "",
    activeTab: "graph",
  });
  useUndoStore.getState().resetSession(fixtureSession.id);
  resetExecutionActions();
  native.bind.mockImplementation(
    async (repoPath: string, generation: string): Promise<ExecutionContext> => ({
      repoPath,
      generation,
      contextId: generation,
      trustRevision: 1,
      trusted: true,
    }),
  );
  native.invoke.mockImplementation(async (command: string) => {
    if (command === "read_repo_graph_layout")
      return { nodes: {}, reroutes: [], pinnedNodeIds: [], groups: [] };
    if (command === "prepare_run_source")
      return { repoPath: fixtureSession.path, files: [], indexedSymbols: [] };
    if (command === "execution_cancel_run")
      return native.bind(fixtureSession.path, fixtureSession.id);
    return undefined;
  });
  native.start.mockResolvedValue({
    id: "run-fixture",
    kind: "run",
    state: "exited",
    exitCode: 0,
    cleanupConfirmed: true,
    outputComplete: true,
    sequence: 0,
    truncated: false,
    chunks: [],
  } satisfies ExecutionSnapshot);
});
afterEach(() => {
  cleanup();
  resetExecutionActions();
  vi.restoreAllMocks();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("#101 mounted provider through real Run preparation and launch boundary", () => {
  it.each([false, true])(
    "launches exactly once after verified file-only/combined different-file save (combined=%s)",
    async (combined) => {
      const fixture = await mount();
      if (combined) await editDeclaration();
      const editor = await editFile();
      const draft = (editor as HTMLTextAreaElement).value;
      await run();
      await waitFor(() => expect(native.start).toHaveBeenCalledTimes(1));
      expect(fixture.saveFile).toHaveBeenCalledTimes(1);
      expect(fixture.saveSource).toHaveBeenCalledTimes(combined ? 1 : 0);
      expect(
        (await fixture.adapter.readWorkspaceFile(fixtureSession.path, "notes.txt")).content,
      ).toBe(draft);
      await waitFor(() => expect(readWorkspacePreparationSnapshot()?.dirty).toBe(false));
      expect(
        native.invoke.mock.calls.filter(([command]) => command === "prepare_run_source"),
      ).toHaveLength(1);
      expect(native.start.mock.calls[0]?.[2]).toMatchObject({ repoPath: fixtureSession.path });
    },
    15000,
  );

  it("refuses same-file declaration/file overlap before either save and preserves both drafts", async () => {
    const fixture = await mount();
    const declaration = await editDeclaration();
    const editor = await editFile("src/helm/ui/api.py", "# independent full-file draft\n");
    await run();
    await refused(/both edit the same file/);
    expect(fixture.saveFile).not.toHaveBeenCalled();
    expect(fixture.saveSource).not.toHaveBeenCalled();
    expect(declaration.editor).toHaveValue(declaration.draft);
    expect(editor).toHaveValue("# independent full-file draft\n");
  });

  it.each(["resolved-error", "permission", "stale-version"] as const)(
    "refuses %s without launch or draft loss",
    async (failure) => {
      const fixture = await mount();
      const editor = await editFile();
      const draft = (editor as HTMLTextAreaElement).value;
      if (failure === "resolved-error")
        fixture.saveFile.mockResolvedValueOnce({
          error: "not saved",
        } as unknown as WorkspaceFileMutationResult);
      if (failure === "permission")
        fixture.saveFile.mockRejectedValueOnce(new Error("Permission denied: notes.txt"));
      if (failure === "stale-version") {
        const baseline = await fixture.adapter.readWorkspaceFile(fixtureSession.path, "notes.txt");
        // Independently alter the disk model without delivering a watcher event.
        await fixture.originalFileSave(
          fixtureSession.path,
          "notes.txt",
          "external disk edit",
          baseline.version,
        );
        fixture.saveFile.mockClear();
      }
      await run();
      await refused(
        failure === "resolved-error"
          ? /did not confirm the requested bytes/
          : failure === "permission"
            ? /Permission denied/
            : /changed on disk/,
      );
      expect(editor).toHaveValue(draft);
      expect(fixture.saveFile).toHaveBeenCalledTimes(1);
    },
  );

  it.each([false, true])(
    "keeps the first verified save and Undo when second fails (reply lost after commit=%s), without replay",
    async (lostReply) => {
      const fixture = await mount();
      const declaration = await editDeclaration();
      const editor = await editFile();
      const draft = (editor as HTMLTextAreaElement).value;
      const originalSave = fixture.originalFileSave;
      fixture.saveFile.mockImplementationOnce(async (...args) => {
        if (lostReply) await originalSave.apply(fixture.adapter, args);
        throw new Error(
          lostReply ? "File reply lost after commit" : "Permission denied: second save",
        );
      });
      await run();
      await refused(lostReply ? /File reply lost after commit/ : /Permission denied: second save/);
      expect(fixture.saveSource).toHaveBeenCalledTimes(1);
      expect(fixture.saveFile).toHaveBeenCalledTimes(1);
      expect(declaration.editor).toHaveValue(declaration.draft);
      expect(editor).toHaveValue(draft);
      const undo = useUndoStore.getState().registrations.backend;
      await waitFor(() => expect(undo?.canUndo()).toBe(true));
      expect(undo?.peekEntry?.()?.summary).toMatch(/source|saved|updated/i);
      const source = await fixture.adapter.getEditableNodeSource("module:helm.ui.api");
      expect(source.content).toContain("# retained café 🧭");
      expect(
        (await fixture.adapter.readWorkspaceFile(fixtureSession.path, "notes.txt")).content,
      ).toBe(lostReply ? draft : "baseline\n");
      await act(async () => {
        await Promise.resolve();
      });
      expect(fixture.saveSource).toHaveBeenCalledTimes(1);
      expect(fixture.saveFile).toHaveBeenCalledTimes(1);
    },
    15000,
  );

  it.each(["switch", "close", "cancel-run"] as const)(
    "does not launch after %s during a late file save",
    async (action) => {
      const fixture = await mount();
      await editFile("notes.txt", "");
      const gate = deferred<void>();
      const originalSave = fixture.originalFileSave;
      fixture.saveFile.mockImplementationOnce(async (...args) => {
        await gate.promise;
        return originalSave.apply(fixture.adapter, args);
      });
      await run();
      await waitFor(() => expect(fixture.saveFile).toHaveBeenCalledTimes(1));
      if (action === "switch") {
        act(() =>
          useUiStore.setState({
            repoSession: { ...fixtureSession, id: "replacement", path: "/replacement" },
          }),
        );
      } else if (action === "close") {
        vi.spyOn(window, "confirm").mockReturnValue(true);
        fireEvent.click(
          within(document.querySelector(".workspace-file-editor") as HTMLElement).getByRole(
            "button",
            { name: "Close" },
          ),
        );
      } else act(() => useExecutionActions.getState().stop());
      await act(async () => {
        gate.resolve();
      });
      await waitFor(() => expect(useExecutionActions.getState().canStop).toBe(false));
      expect(native.start).not.toHaveBeenCalled();
      expect(
        native.invoke.mock.calls.filter(([command]) => command === "prepare_run_source"),
      ).toHaveLength(0);
      if (action === "close")
        expect(screen.queryByRole("textbox", { name: "Edit notes.txt" })).not.toBeInTheDocument();
      if (action === "switch") {
        expect(useUiStore.getState().repoSession?.id).toBe("replacement");
        expect(useUndoStore.getState().registrations.backend?.canUndo()).toBe(false);
      }
      if (action === "cancel-run")
        expect(screen.getByRole("textbox", { name: "Edit notes.txt" })).toHaveValue("");
    },
    15000,
  );
});

describe("#102 frontend admission after a delayed accepted native preparation receipt", () => {
  // These cases prove renderer cancellation/ownership only. Native compilation,
  // graph reconciliation and exact source hashes are separately exercised by
  // test_run_preparation_joined.py; this mocked IPC is not compiler evidence.
  it.each(["stop", "replacement"] as const)(
    "refuses late accepted preparation after %s",
    async (action) => {
      const fixture = await mount();
      const originalSource = await fixture.adapter.getEditableNodeSource("module:helm.ui.api");
      const pending = deferred<{ repoPath: string; files: []; indexedSymbols: [] }>();
      const originalInvoke = native.invoke.getMockImplementation()!;
      native.invoke.mockImplementation((command: string, ...args: unknown[]) =>
        command === "prepare_run_source" ? pending.promise : originalInvoke(command, ...args),
      );
      await run();
      await waitFor(() =>
        expect(
          native.invoke.mock.calls.filter(([command]) => command === "prepare_run_source"),
        ).toHaveLength(1),
      );
      if (action === "stop") act(() => useExecutionActions.getState().stop());
      else
        act(() =>
          useUiStore.setState({
            repoSession: { ...fixtureSession, id: "replacement", path: "/replacement" },
          }),
        );
      await act(async () => {
        pending.resolve({ repoPath: fixtureSession.path, files: [], indexedSymbols: [] });
      });
      await waitFor(() => expect(useExecutionActions.getState().canStop).toBe(false));
      expect(native.start).not.toHaveBeenCalled();
      expect(fixture.saveSource).not.toHaveBeenCalled();
      expect(fixture.saveFile).not.toHaveBeenCalled();
      expect((await fixture.adapter.getEditableNodeSource("module:helm.ui.api")).content).toBe(
        originalSource.content,
      );
      expect(useUiStore.getState().repoSession?.id).toBe(
        action === "stop" ? fixtureSession.id : "replacement",
      );
    },
  );
});
