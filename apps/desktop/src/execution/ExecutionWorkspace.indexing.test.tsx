import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ExecutionWorkspace } from "./ExecutionWorkspace";
import { resetExecutionActions, useExecutionActions } from "./actions";
import { registerWorkspacePreparation, type WorkspacePreparationSnapshot } from "./preparation";
import { newRunConfig, type ExecutionContext } from "./contracts";
import { useUiStore } from "../store/uiStore";

const edge = vi.hoisted(() => ({
  bind: vi.fn(),
  invoke: vi.fn(),
  read: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: edge.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("./configService", () => ({
  executionConfigService: {
    bind: edge.bind,
    read: edge.read,
    suggestions: vi.fn(async () => []),
  },
}));
vi.mock("./adapter", () => ({
  executionAdapter: { startRun: edge.start, stop: edge.stop, poll: vi.fn() },
}));
vi.mock("./TerminalView", () => ({ TerminalView: () => null }));
vi.mock("./RunOutputNavigation", () => ({ RunOutputNavigation: () => null }));

const session = {
  id: "same-repository",
  path: "/fixture/repository",
  name: "Repository",
  branch: "dev",
  primaryLanguage: "Python",
  openedAt: "2026-10-21T00:00:00Z",
};
const context: ExecutionContext = {
  contextId: "native-owner",
  repoPath: session.path,
  generation: session.id,
  trustRevision: 1,
  trusted: true,
};
const config = {
  schemaVersion: 1 as const,
  revision: 1,
  defaultId: "app",
  configs: [{ ...newRunConfig("app"), executable: "python3" }],
};
let unregister: (() => void) | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  useUiStore.getState().resetWorkspace();
  useUiStore.setState({ repoSession: session });
  edge.bind.mockResolvedValue(context);
  edge.read.mockResolvedValue(config);
  edge.invoke.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  unregister?.();
  unregister = undefined;
  resetExecutionActions();
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

async function mount() {
  render(
    <ExecutionWorkspace>
      <p>Existing IDE</p>
    </ExecutionWorkspace>,
  );
  await waitFor(() => expect(screen.getByRole("button", { name: "Save and Run" })).toBeEnabled());
}

it("same-path reindex retires a pending real preparation without saving twice or losing the draft", async () => {
  let finish!: () => void;
  const save = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const draft: WorkspacePreparationSnapshot = {
    repoPath: session.path,
    sessionId: session.id,
    availability: "ready",
    dirty: true,
    stale: false,
    busy: false,
    revision: "retained unsaved source Ω",
    blockers: [],
    saves: [save],
  };
  unregister = registerWorkspacePreparation(() => draft);
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Save and Run" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  act(() => useUiStore.setState({ indexingSession: { sessionId: session.id, jobId: "reindex" } }));
  await act(async () => finish());
  await waitFor(() => expect(screen.getByRole("button", { name: "Save and Run" })).toBeDisabled());
  expect(save).toHaveBeenCalledOnce();
  expect(draft.revision).toBe("retained unsaved source Ω");
  expect(draft.dirty).toBe(true);
  expect(
    edge.invoke.mock.calls.filter(([command]) => command === "prepare_run_source"),
  ).toHaveLength(0);
  expect(edge.start).not.toHaveBeenCalled();
  expect(edge.bind).toHaveBeenCalledOnce();
});

it("same-path pending or failed indexing rejects old callbacks, then successful readiness rebinds untrusted", async () => {
  const save = vi.fn(async () => {});
  unregister = registerWorkspacePreparation(() => ({
    repoPath: session.path,
    sessionId: session.id,
    availability: "ready",
    dirty: true,
    stale: false,
    busy: false,
    revision: "draft",
    blockers: [],
    saves: [save],
  }));
  await mount();
  const capturedRun = useExecutionActions.getState().run;
  act(() =>
    useUiStore.setState({ indexingSession: { sessionId: session.id, jobId: "failed-index" } }),
  );
  await act(async () => capturedRun());
  expect(save).not.toHaveBeenCalled();
  expect(edge.start).not.toHaveBeenCalled();
  expect(edge.bind).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Save and Run" })).toBeDisabled();
  // Failed IndexingScreen retains its owned indexingSession until explicit
  // abandonment; only successful current readiness clears it for rebind.
  edge.bind.mockResolvedValue({ ...context, trustRevision: 2, trusted: false });
  act(() => useUiStore.setState({ indexingSession: undefined }));
  await waitFor(() => expect(edge.bind).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getByRole("button", { name: "Save and Run" })).toBeDisabled());
  expect(save).not.toHaveBeenCalled();
  expect(edge.start).not.toHaveBeenCalled();
});

it("an initial owned index cannot bind execution before current readiness", async () => {
  useUiStore.setState({ indexingSession: { sessionId: session.id, jobId: "initial" } });
  render(
    <ExecutionWorkspace>
      <p>Indexing</p>
    </ExecutionWorkspace>,
  );
  expect(edge.bind).not.toHaveBeenCalled();
  edge.bind.mockResolvedValue({ ...context, trusted: false });
  act(() => useUiStore.setState({ indexingSession: undefined }));
  await waitFor(() => expect(edge.bind).toHaveBeenCalledOnce());
  expect(screen.getByRole("button", { name: "Save and Run" })).toBeDisabled();
});

it("a failed readiness rebind keeps the existing draft and rejects a captured Run callback", async () => {
  const save = vi.fn(async () => {});
  const snapshot: WorkspacePreparationSnapshot = {
    repoPath: session.path,
    sessionId: session.id,
    availability: "ready",
    dirty: true,
    stale: false,
    busy: false,
    revision: "unchanged draft",
    blockers: [],
    saves: [save],
  };
  unregister = registerWorkspacePreparation(() => snapshot);
  await mount();
  const capturedRun = useExecutionActions.getState().run;
  act(() => useUiStore.setState({ indexingSession: { sessionId: session.id, jobId: "reindex" } }));
  edge.bind.mockRejectedValueOnce(new Error("Native execution readiness unavailable"));
  act(() => useUiStore.setState({ indexingSession: undefined }));
  await screen.findByText("Native execution readiness unavailable");
  await act(async () => capturedRun());
  expect(save).not.toHaveBeenCalled();
  expect(snapshot.revision).toBe("unchanged draft");
  expect(snapshot.dirty).toBe(true);
  expect(edge.bind).toHaveBeenCalledTimes(2);
  expect(edge.start).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Save and Run" })).toBeDisabled();
});
