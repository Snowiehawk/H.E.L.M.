import { useEffect } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionWorkspace } from "./ExecutionWorkspace";
import { resetExecutionActions, useExecutionActions } from "./actions";
import { registerWorkspacePreparation } from "./preparation";
import type { ExecutionContext } from "./contracts";
import type { ExecutionSnapshot } from "./adapter";
import { useUiStore } from "../store/uiStore";

const edge = vi.hoisted(() => ({
  bind: vi.fn(),
  setTrust: vi.fn(),
  invoke: vi.fn(),
  startRun: vi.fn(),
  startTerminal: vi.fn(),
  stop: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
  poll: vi.fn(),
  terminalCallbacks: undefined as
    | undefined
    | {
        input: (data: string) => Promise<void>;
        resize: (rows: number, cols: number) => Promise<void>;
        link: (url: string) => void;
      },
  contexts: new Map<string, ExecutionContext>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: edge.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("./adapter", () => ({
  executionAdapter: {
    startRun: edge.startRun,
    startTerminal: edge.startTerminal,
    stop: edge.stop,
    write: edge.write,
    resize: edge.resize,
    poll: edge.poll,
  },
}));
vi.mock("./RunOutputNavigation", () => ({ RunOutputNavigation: () => null }));
vi.mock("./TerminalView", () => ({
  TerminalView: ({
    onInput,
    onResize,
    onLink,
  }: {
    onInput: (data: string) => Promise<void>;
    onResize: (rows: number, cols: number) => Promise<void>;
    onLink: (url: string) => void;
  }) => {
    edge.terminalCallbacks = { input: onInput, resize: onResize, link: onLink };
    return <div>Fixture terminal display</div>;
  },
}));
vi.mock("./configService", () => ({
  executionConfigService: {
    bind: edge.bind,
    setTrust: edge.setTrust,
    read: vi.fn(async () => ({
      schemaVersion: 1,
      revision: 1,
      defaultId: "app",
      configs: [
        {
          id: "app",
          name: "App",
          kind: "app",
          mode: "executable",
          executable: "fixture",
          args: [],
          command: "",
          cwd: ".",
          env: {},
          secretNames: [],
        },
      ],
    })),
    suggestions: vi.fn(async () => []),
  },
}));

const owner = (id = "first", trusted = true, trustRevision = 1): ExecutionContext => ({
  contextId: id,
  repoPath: `/fixture/${id}`,
  generation: id,
  trusted,
  trustRevision,
});
const snapshot = (kind: "run" | "terminal", complete = false): ExecutionSnapshot => ({
  id: `${kind}-owned`,
  kind,
  state: complete ? "exited" : "running",
  exitCode: complete ? 0 : null,
  cleanupConfirmed: complete,
  outputComplete: complete,
  sequence: 0,
  truncated: false,
  chunks: [],
});
function select(id = "first") {
  useUiStore.setState({
    repoSession: {
      id,
      path: `/fixture/${id}`,
      name: id,
      branch: "fixture",
      primaryLanguage: "Python",
      openedAt: "now",
    },
    indexingSession: undefined,
  });
}
let releaseAll: (() => void)[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function Preparation({ saving }: { saving?: Promise<void> }) {
  useEffect(
    () =>
      registerWorkspacePreparation(() => ({
        repoPath: "/fixture/first",
        sessionId: "first",
        availability: "ready",
        dirty: Boolean(saving),
        stale: false,
        busy: false,
        revision: "owned-draft",
        blockers: [],
        saves: saving
          ? [
              async () => {
                await saving;
              },
            ]
          : [],
      })),
    [saving],
  );
  return null;
}
async function mount(saving?: Promise<void>) {
  const view = render(
    <>
      <Preparation saving={saving} />
      <ExecutionWorkspace />
    </>,
  );
  await waitFor(() => expect(useExecutionActions.getState().canRun).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "Terminal / output" }));
  return view;
}
async function untrusted() {
  await screen.findByText("Project execution is disabled until trusted.");
}
const revokeButton = () => screen.getByRole("button", { name: "Revoke trust and stop work" });

beforeEach(() => {
  releaseAll = [];
  for (const mock of [
    edge.bind,
    edge.setTrust,
    edge.invoke,
    edge.startRun,
    edge.startTerminal,
    edge.stop,
    edge.write,
    edge.resize,
    edge.poll,
  ])
    mock.mockReset();
  edge.contexts.clear();
  edge.terminalCallbacks = undefined;
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  useUiStore.getState().resetWorkspace();
  select();
  resetExecutionActions();
  edge.bind.mockImplementation(
    async (_repo: string, id: string) => edge.contexts.get(id) ?? owner(id),
  );
  edge.setTrust.mockImplementation(async (context: ExecutionContext, trusted: boolean) => {
    const next = { ...context, trusted, trustRevision: context.trustRevision + 1 };
    edge.contexts.set(context.generation, next);
    return next;
  });
  edge.invoke.mockImplementation(async (command: string, args: { context: ExecutionContext }) => {
    if (command === "prepare_run_source")
      return { repoPath: args.context.repoPath, files: [], indexedSymbols: [] };
    if (command === "execution_cancel_run") return args.context;
    if (command === "execution_open_loopback") return undefined;
    throw new Error(`Unexpected native fixture command: ${command}`);
  });
  edge.startRun.mockResolvedValue(snapshot("run", true));
  edge.startTerminal.mockResolvedValue(snapshot("terminal"));
  edge.stop.mockResolvedValue(snapshot("terminal", true));
  edge.write.mockResolvedValue(undefined);
  edge.resize.mockResolvedValue(undefined);
  edge.poll.mockResolvedValue(snapshot("terminal"));
});
afterEach(async () => {
  await act(async () => {
    for (const release of releaseAll) release();
    await Promise.resolve();
  });
  cleanup();
  resetExecutionActions();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("#93 controller revocation admission", () => {
  it("does not start new save or preparation when Revoke occurs during Restart's pending Stop", async () => {
    await mount();
    const save = vi.fn(async () => {});
    const unregister = registerWorkspacePreparation(() => ({
      repoPath: "/fixture/first",
      sessionId: "first",
      availability: "ready",
      dirty: true,
      stale: false,
      busy: false,
      revision: "restart-owned-draft",
      blockers: [],
      saves: [save],
    }));
    const stopped = deferred<ExecutionSnapshot>();
    releaseAll.push(() => stopped.resolve(snapshot("run", true)));
    edge.startRun.mockResolvedValue(snapshot("run"));
    try {
      act(() => useExecutionActions.getState().run());
      await waitFor(() => expect(edge.startRun).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(useExecutionActions.getState().canRestart).toBe(true));
      save.mockClear();
      edge.invoke.mockClear();
      edge.startRun.mockClear();
      edge.stop.mockReturnValue(stopped.promise);
      act(() => useExecutionActions.getState().restart());
      await waitFor(() => expect(edge.stop).toHaveBeenCalledTimes(1));
      expect(revokeButton()).toBeEnabled();
      fireEvent.click(revokeButton());
      await untrusted();
      await act(async () => {
        stopped.resolve(snapshot("run", true));
      });
      await waitFor(() => expect(useExecutionActions.getState().canStop).toBe(false));
      expect(save).not.toHaveBeenCalled();
      expect(edge.invoke.mock.calls.some(([command]) => command === "prepare_run_source")).toBe(
        false,
      );
      expect(edge.startRun).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it("revokes independently of a pending save and immediately disables grant/admission", async () => {
    const save = deferred<void>();
    releaseAll.push(() => save.resolve());
    await mount(save.promise);
    act(() => useExecutionActions.getState().run());
    await waitFor(() => expect(useExecutionActions.getState().canStop).toBe(true));
    expect(revokeButton()).toBeEnabled();
    fireEvent.click(revokeButton());
    await untrusted();
    expect(
      screen.getByRole("button", { name: "Trust this project for this session" }),
    ).toBeDisabled();
    await act(async () => {
      save.resolve();
    });
    await waitFor(() => expect(useExecutionActions.getState().canStop).toBe(false));
    expect(edge.setTrust).toHaveBeenCalledExactlyOnceWith(owner(), false);
    expect(edge.startRun).not.toHaveBeenCalled();
    expect(edge.invoke.mock.calls.some(([command]) => command === "prepare_run_source")).toBe(
      false,
    );
  });

  it("keeps local trust revoked when native revocation fails and bind still reports trusted", async () => {
    edge.setTrust.mockRejectedValue(new Error("cleanup-unknown: original owned tree retained"));
    await mount();
    const oldRun = useExecutionActions.getState().run;
    fireEvent.click(revokeButton());
    await untrusted();
    await screen.findByText(/cleanup-unknown: original owned tree retained/);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Retry revocation and cleanup" })).toBeEnabled(),
    );
    act(() => oldRun());
    await waitFor(() => expect(useExecutionActions.getState().canStop).toBe(false));
    expect(useExecutionActions.getState().canRun).toBe(false);
    expect(edge.startRun).not.toHaveBeenCalled();
    expect(edge.setTrust.mock.calls.every(([, trusted]) => trusted === false)).toBe(true);
    expect(screen.getByText(/cleanup-unknown: original owned tree retained/)).toBeInTheDocument();
  });

  it("requires an explicit false retry acknowledgment before offering a new grant", async () => {
    edge.setTrust.mockRejectedValueOnce(new Error("cleanup-unknown: retry required"));
    await mount();
    fireEvent.click(revokeButton());
    await untrusted();
    const retry = await screen.findByRole("button", { name: "Retry revocation and cleanup" });
    expect(edge.setTrust).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: "Trust this project for this session" }),
    ).not.toBeInTheDocument();
    fireEvent.click(retry);
    await waitFor(() => expect(edge.setTrust).toHaveBeenCalledTimes(2));
    expect(edge.setTrust.mock.calls.every(([, trusted]) => trusted === false)).toBe(true);
    const grant = await screen.findByRole("button", {
      name: "Trust this project for this session",
    });
    expect(grant).toBeEnabled();
    expect(screen.queryByText(/cleanup-unknown: retry required/)).not.toBeInTheDocument();
    fireEvent.click(grant);
    await screen.findByText("Trusted for this session");
    expect(edge.setTrust.mock.calls.map(([, trusted]) => trusted)).toEqual([false, false, true]);
  });

  it.each([false, true])(
    "keeps revocation failure authoritative after a late save and trusted rebind=%s",
    async (trusted) => {
      const save = deferred<void>();
      releaseAll.push(() => save.resolve());
      edge.setTrust.mockImplementation(async () => {
        edge.contexts.set("first", owner("first", trusted, 2));
        throw new Error("cleanup-unknown: retry exact owned process");
      });
      await mount(save.promise);
      act(() => useExecutionActions.getState().run());
      await waitFor(() => expect(useExecutionActions.getState().canStop).toBe(true));
      expect(revokeButton()).toBeEnabled();
      fireEvent.click(revokeButton());
      await screen.findByText(/cleanup-unknown: retry exact owned process/);
      await act(async () => {
        save.resolve();
      });
      await waitFor(() => expect(useExecutionActions.getState().canStop).toBe(false));
      await untrusted();
      expect(screen.getByText(/cleanup-unknown: retry exact owned process/)).toBeInTheDocument();
      expect(edge.startRun).not.toHaveBeenCalled();
    },
  );

  it("serializes duplicate revocation attempts and does not adopt an old response into a replacement", async () => {
    const revoked = deferred<ExecutionContext>();
    releaseAll.push(() => revoked.resolve(owner("first", false, 2)));
    edge.setTrust.mockReturnValue(revoked.promise);
    await mount();
    const button = revokeButton();
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    await untrusted();
    expect(edge.setTrust).toHaveBeenCalledTimes(1);
    act(() => select("replacement"));
    await waitFor(() => expect(useExecutionActions.getState().canRun).toBe(true));
    await act(async () => {
      revoked.resolve(owner("first", false, 2));
    });
    expect(useUiStore.getState().repoSession?.id).toBe("replacement");
    expect(screen.getByText("Trusted for this session")).toBeInTheDocument();
    expect(edge.setTrust).toHaveBeenCalledTimes(1);
  });

  it("does not let an older Stop reply restore trust after revocation", async () => {
    const save = deferred<void>();
    releaseAll.push(() => save.resolve());
    const stopped = deferred<ExecutionContext>();
    releaseAll.push(() => stopped.resolve(owner()));
    edge.invoke.mockImplementation(async (command: string) => {
      if (command === "execution_cancel_run") return stopped.promise;
      throw new Error(`Unexpected stale Stop fixture command: ${command}`);
    });
    await mount(save.promise);
    act(() => useExecutionActions.getState().run());
    act(() => useExecutionActions.getState().stop());
    expect(revokeButton()).toBeEnabled();
    fireEvent.click(revokeButton());
    await untrusted();
    await act(async () => {
      stopped.resolve(owner());
      save.resolve();
    });
    await waitFor(() => expect(useExecutionActions.getState().canStop).toBe(false));
    await untrusted();
    expect(useExecutionActions.getState().canRun).toBe(false);
    expect(edge.startRun).not.toHaveBeenCalled();
  });

  it("refuses captured terminal input/resize and browser activation immediately after Revoke", async () => {
    const revoked = deferred<ExecutionContext>();
    releaseAll.push(() => revoked.resolve(owner("first", false, 2)));
    edge.setTrust.mockReturnValue(revoked.promise);
    await mount();
    fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));
    fireEvent.click(screen.getByRole("button", { name: "Start terminal" }));
    await screen.findByText("Fixture terminal display");
    const captured = edge.terminalCallbacks!;
    act(() => captured.link("http://localhost:43111/fixture"));
    const browser = screen.getByRole("button", { name: "Open in browser" });
    const revoke = revokeButton();
    await act(async () => {
      fireEvent.click(revoke);
      fireEvent.click(browser);
      await captured.input("must-not-write\r");
      await captured.resize(31, 99);
      captured.link("http://localhost:43111/late");
    });
    await untrusted();
    expect(edge.write).not.toHaveBeenCalled();
    expect(edge.resize).not.toHaveBeenCalled();
    expect(edge.invoke.mock.calls.some(([command]) => command === "execution_open_loopback")).toBe(
      false,
    );
    expect(screen.queryByRole("button", { name: "Open in browser" })).not.toBeInTheDocument();
    // Exact owned cleanup remains available while input/launch admission is shut.
    expect(screen.getByRole("button", { name: "Close session" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Close session" }));
    await waitFor(() =>
      expect(edge.stop).toHaveBeenCalledExactlyOnceWith(owner("first", false), "terminal-owned"),
    );
  });

  it("revokes during a pending runtime probe and ignores its late successful result", async () => {
    const probe = deferred<unknown>();
    releaseAll.push(() =>
      probe.resolve({ tool: {}, outcome: "success", output: "late probe output", exitCode: 0 }),
    );
    edge.invoke.mockImplementation(async (command: string) => {
      if (command === "execution_probe_tool") return probe.promise;
      throw new Error(`Unexpected probe fixture command: ${command}`);
    });
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Probe version" }));
    await waitFor(() => expect(edge.invoke).toHaveBeenCalledTimes(1));
    expect(revokeButton()).toBeEnabled();
    fireEvent.click(revokeButton());
    await untrusted();
    await act(async () => {
      probe.resolve({ tool: {}, outcome: "success", output: "late probe output", exitCode: 0 });
    });
    await waitFor(() => expect(useExecutionActions.getState().canStop).toBe(false));
    expect(screen.queryByText(/late probe output/)).not.toBeInTheDocument();
    expect(edge.startRun).not.toHaveBeenCalled();
  });
});
