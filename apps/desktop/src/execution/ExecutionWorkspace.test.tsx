import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionSnapshot } from "./adapter";
import type { ExecutionContext, RunConfigDocument } from "./contracts";
import type { PreparationReceipt } from "./preparation";
import { ExecutionWorkspace } from "./ExecutionWorkspace";
import { useExecutionActions } from "./actions";
import { useUiStore } from "../store/uiStore";

const api = vi.hoisted(() => ({
  invoke: vi.fn(),
  bind: vi.fn(),
  read: vi.fn(),
  save: vi.fn(),
  suggestions: vi.fn(),
  setTrust: vi.fn(),
  prepare: vi.fn(),
  assertCurrent: vi.fn(),
  startRun: vi.fn(),
  startTerminal: vi.fn(),
  poll: vi.fn(),
  stop: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
  contexts: new Map<string, ExecutionContext>(),
  terminalMount: 0,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: api.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("./configService", () => ({
  executionConfigService: {
    bind: api.bind,
    read: api.read,
    suggestions: api.suggestions,
    setTrust: api.setTrust,
    save: api.save,
    setSecrets: vi.fn(),
    resolveTool: vi.fn(),
  },
}));
vi.mock("./adapter", () => ({
  executionAdapter: {
    startRun: api.startRun,
    startTerminal: api.startTerminal,
    poll: api.poll,
    stop: api.stop,
    write: api.write,
    resize: api.resize,
  },
}));
vi.mock("./preparation", () => ({
  prepareWorkspaceToRun: api.prepare,
  assertWorkspacePreparationCurrent: api.assertCurrent,
}));
vi.mock("./RunConfigEditor", () => ({
  RunConfigEditor: ({
    document,
    onSave,
    onClose,
  }: {
    document: RunConfigDocument;
    onSave(document: RunConfigDocument): Promise<void>;
    onClose(): void;
  }) => (
    <section aria-label="Mock run settings">
      <button
        onClick={async () => {
          await onSave({
            ...document,
            configs: document.configs.map((config) => ({
              ...config,
              name: "Next configuration",
              args: ["changed Ω.py"],
              env: { MODE: "next" },
            })),
          });
          onClose();
        }}
      >
        Save changed configuration
      </button>
      <button onClick={onClose}>Close settings</button>
    </section>
  ),
}));
vi.mock("./RunOutputNavigation", () => ({
  RunOutputNavigation: () => <div>Mock output navigation</div>,
}));
vi.mock("./TerminalView", async () => {
  const { useRef } = await import("react");
  return {
    TerminalView: ({
      snapshot,
      onLink,
    }: {
      snapshot?: ExecutionSnapshot;
      onLink(url: string): void;
    }) => {
      const mounted = useRef(++api.terminalMount);
      const buffer = useRef("");
      // Simulate a durable renderer buffer: undefined snapshots do not clear it.
      // The workspace identity key must cause a fresh renderer on replacement.
      if (snapshot?.chunks.length)
        buffer.current = new TextDecoder().decode(
          new Uint8Array(snapshot.chunks.flatMap((chunk) => chunk.data)),
        );
      return (
        <div data-testid="terminal-renderer" data-mount={mounted.current}>
          <span>{buffer.current}</span>
          <button onClick={() => onLink("http://localhost:43111/old-workspace")}>
            Mock terminal link
          </button>
        </div>
      );
    },
  };
});

const config: RunConfigDocument = {
  schemaVersion: 1,
  revision: 1,
  defaultId: "app",
  configs: [
    {
      id: "app",
      name: "App",
      kind: "app",
      mode: "executable",
      executable: "python3",
      args: ["main.py"],
      command: "",
      cwd: ".",
      env: {},
      secretNames: [],
    },
  ],
};
const source = { repoPath: "/fixture/first", files: [], indexedSymbols: [] };
const receipt = (): PreparationReceipt => ({
  repoPath: source.repoPath,
  sessionId: "first",
  revision: "saved",
  mutationRevision: 0,
  preparedSource: source,
});
const snapshot = (
  kind: "run" | "terminal",
  overrides: Partial<ExecutionSnapshot> = {},
): ExecutionSnapshot => ({
  id: `${kind}-1`,
  kind,
  state: "running",
  exitCode: null,
  cleanupConfirmed: false,
  outputComplete: false,
  sequence: 0,
  truncated: false,
  chunks: [],
  ...overrides,
});
const setSession = (id = "first") =>
  useUiStore.setState({
    repoSession: {
      id,
      name: id,
      path: `/fixture/${id}`,
      branch: "dev",
      primaryLanguage: "Python",
      openedAt: "2026-10-20T00:00:00Z",
    },
  });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function mount() {
  render(
    <ExecutionWorkspace>
      <div>IDE remains mounted</div>
    </ExecutionWorkspace>,
  );
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Run configuration" })).toHaveValue("app"),
  );
}
async function trust() {
  if (
    screen.getByRole("button", { name: "Terminal / output" }).getAttribute("aria-expanded") ===
    "false"
  )
    fireEvent.click(screen.getByRole("button", { name: "Terminal / output" }));
  fireEvent.click(screen.getByRole("button", { name: "Trust this project for this session" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Save and Run" })).toBeEnabled());
}
async function startTerminal() {
  fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));
  fireEvent.click(screen.getByRole("button", { name: "Start terminal" }));
  await screen.findByText("from first workspace");
}
beforeEach(() => {
  vi.clearAllMocks();
  api.contexts.clear();
  api.terminalMount = 0;
  localStorage.clear();
  Object.defineProperty(window, "innerWidth", { value: 1480, writable: true, configurable: true });
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
  setSession();
  useUiStore.setState({ indexingSession: undefined });
  api.bind.mockImplementation(async (repoPath: string, generation: string) => {
    const key = `${repoPath}:${generation}`;
    if (!api.contexts.has(key))
      api.contexts.set(key, {
        contextId: `context-${generation}`,
        repoPath,
        generation,
        trusted: false,
        trustRevision: 0,
      });
    return api.contexts.get(key)!;
  });
  api.setTrust.mockImplementation(async (context: ExecutionContext, trusted: boolean) => {
    const fresh = { ...context, trusted, trustRevision: context.trustRevision + 1 };
    api.contexts.set(`${context.repoPath}:${context.generation}`, fresh);
    return fresh;
  });
  api.read.mockResolvedValue(structuredClone(config));
  api.save.mockImplementation(async (_context: ExecutionContext, document: RunConfigDocument) => ({
    ...document,
    revision: document.revision + 1,
  }));
  api.suggestions.mockResolvedValue([]);
  api.invoke.mockImplementation(
    async (command: string, payload: { context?: ExecutionContext }) => {
      if (command === "prepare_run_source") return source;
      if (command === "execution_cancel_run" && payload.context) {
        const fresh = { ...payload.context, trustRevision: payload.context.trustRevision + 1 };
        api.contexts.set(`${fresh.repoPath}:${fresh.generation}`, fresh);
        return fresh;
      }
      return undefined;
    },
  );
  api.prepare.mockImplementation(async (_path, _id, freeze: () => Promise<unknown>) => {
    await freeze();
    return receipt();
  });
  api.startRun.mockResolvedValue(snapshot("run"));
  api.startTerminal.mockResolvedValue(
    snapshot("terminal", {
      sequence: 1,
      chunks: [
        {
          sequence: 1,
          stream: "terminal",
          data: [...new TextEncoder().encode("from first workspace")],
        },
      ],
    }),
  );
  api.poll.mockImplementation(async (_context, id: string) =>
    snapshot(id.startsWith("terminal") ? "terminal" : "run"),
  );
  api.stop.mockResolvedValue(
    snapshot("run", { state: "exited", cleanupConfirmed: true, outputComplete: true, exitCode: 0 }),
  );
});
afterEach(() => {
  cleanup();
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("execution workspace admission and view lifetime", () => {
  it("clamps the displayed pane, preserves its preference on shrink and restores it", async () => {
    localStorage.setItem("helm.execution.width", "640");
    await mount();
    await trust();
    const resize = (width: number) =>
      act(() => {
        window.innerWidth = width;
        window.dispatchEvent(new Event("resize"));
      });
    const separator = () => screen.getByRole("separator", { name: "Resize terminal sidebar" });
    expect(separator()).toHaveAttribute("aria-valuenow", "640");
    resize(1180);
    expect(separator()).toHaveAttribute("aria-valuenow", "540");
    expect(separator()).toHaveAttribute("aria-valuemax", "540");
    expect(localStorage.getItem("helm.execution.width")).toBe("640");
    resize(983);
    expect(separator()).toHaveAttribute("aria-valuenow", "343");
    resize(1480);
    expect(separator()).toHaveAttribute("aria-valuenow", "640");
    resize(1180);
    fireEvent.keyDown(separator(), { key: "ArrowRight" });
    expect(separator()).toHaveAttribute("aria-valuenow", "520");
    expect(localStorage.getItem("helm.execution.width")).toBe("520");
    fireEvent.keyDown(separator(), { key: "Home" });
    expect(separator()).toHaveAttribute("aria-valuenow", "300");
    fireEvent.keyDown(separator(), { key: "End" });
    expect(separator()).toHaveAttribute("aria-valuenow", "540");
  });
  it("stacks without replacing the live terminal or changing trust/process ownership", async () => {
    await mount();
    await trust();
    await startTerminal();
    const renderer = screen.getByTestId("terminal-renderer");
    const resize = (width: number) =>
      act(() => {
        window.innerWidth = width;
        window.dispatchEvent(new Event("resize"));
      });
    resize(939);
    expect(document.querySelector(".execution-workspace")).toHaveClass(
      "execution-workspace--stacked",
    );
    expect(
      screen.queryByRole("separator", { name: "Resize terminal sidebar" }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("terminal-renderer")).toBe(renderer);
    fireEvent.click(screen.getByRole("button", { name: "Hide terminal / output" }));
    expect(document.querySelector(".execution-workspace")).not.toHaveClass(
      "execution-workspace--stacked",
    );
    fireEvent.click(screen.getByRole("button", { name: "Terminal / output" }));
    resize(940);
    expect(screen.getByRole("separator", { name: "Resize terminal sidebar" })).toHaveAttribute(
      "aria-valuenow",
      "300",
    );
    expect(screen.getByTestId("terminal-renderer")).toBe(renderer);
    expect(api.startTerminal).toHaveBeenCalledOnce();
    expect(api.stop).not.toHaveBeenCalled();
    expect(api.setTrust).toHaveBeenCalledOnce();
    expect(api.bind).toHaveBeenCalledOnce();
  });
  it.each(["cancel", "lost capture", "stack", "hide", "unmount"])(
    "ends an owned width drag on %s",
    async (end) => {
      await mount();
      await trust();
      const separator = screen.getByRole("separator", { name: "Resize terminal sidebar" });
      separator.setPointerCapture = vi.fn();
      fireEvent.pointerDown(separator, { pointerId: 1, clientX: 700 });
      if (end === "cancel") fireEvent.pointerCancel(window);
      else if (end === "lost capture") fireEvent.lostPointerCapture(separator);
      else if (end === "stack")
        act(() => {
          window.innerWidth = 900;
          window.dispatchEvent(new Event("resize"));
        });
      else if (end === "hide")
        fireEvent.click(screen.getByRole("button", { name: "Hide terminal / output" }));
      else cleanup();
      fireEvent.pointerMove(window, { clientX: 200 });
      expect(localStorage.getItem("helm.execution.width")).toBeNull();
    },
  );
  it("keeps saved manual configurations editable when passive suggestions fail", async () => {
    api.suggestions.mockRejectedValueOnce(new Error("package.json is malformed."));
    await mount();
    expect(screen.getByRole("button", { name: "Run settings" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Terminal / output" }));
    expect(
      await screen.findByText(/Run suggestions unavailable:.*package.json is malformed/),
    ).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Run configuration" })).toHaveValue("app");
    fireEvent.click(screen.getByRole("button", { name: "Run settings" }));
    expect(await screen.findByRole("region", { name: "Mock run settings" })).toBeVisible();
    expect(api.startRun).not.toHaveBeenCalled();
  });
  it("recovers binding after native index readiness without a new session", async () => {
    api.bind.mockRejectedValueOnce(new Error("No active repository is available."));
    render(
      <ExecutionWorkspace>
        <div>IDE remains mounted</div>
      </ExecutionWorkspace>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Terminal / output" }));
    await screen.findByText("No active repository is available.");
    await act(async () =>
      useUiStore.setState({ indexingSession: { sessionId: "first", jobId: "index-first" } }),
    );
    expect(api.bind).toHaveBeenCalledOnce();
    await act(async () => useUiStore.setState({ indexingSession: undefined }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Run settings" })).toBeEnabled());
    expect(api.bind).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("No active repository is available.")).not.toBeInTheDocument();
    expect(api.startRun).not.toHaveBeenCalled();
    expect(api.startTerminal).not.toHaveBeenCalled();
  });
  it("preserves owned terminal cleanup feedback while same-session reindex invalidates admission", async () => {
    await mount();
    await trust();
    await startTerminal();
    const renderer = screen.getByTestId("terminal-renderer");
    const mounted = renderer.getAttribute("data-mount");
    const before = api.contexts.get("/fixture/first:first")!;
    await act(async () =>
      useUiStore.setState({ indexingSession: { sessionId: "first", jobId: "reindex-first" } }),
    );
    expect(screen.getByTestId("terminal-renderer")).toHaveAttribute("data-mount", mounted);
    expect(screen.getByRole("button", { name: "Save and Run" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close session" })).toBeEnabled();
    // Model the authoritative native scan's consent invalidation, not an
    // automatic renderer grant or a new project-coordinator callback.
    api.contexts.set("/fixture/first:first", {
      ...before,
      trusted: false,
      trustRevision: before.trustRevision + 1,
    });
    await act(async () => useUiStore.setState({ indexingSession: undefined }));
    await waitFor(() => expect(api.bind).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("terminal-renderer")).toHaveAttribute("data-mount", mounted);
    expect(api.stop).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save and Run" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close session" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Close session" }));
    await waitFor(() => expect(api.stop).toHaveBeenCalledOnce());
    expect(api.stop.mock.calls[0][0]).toMatchObject({
      trusted: false,
      trustRevision: before.trustRevision + 1,
    });
  });
  it("passively binds settings/suggestions without starting a process or granting trust", async () => {
    await mount();
    expect(api.bind).toHaveBeenCalledWith("/fixture/first", "first");
    expect(api.read).toHaveBeenCalledOnce();
    expect(api.suggestions).toHaveBeenCalledOnce();
    expect(api.setTrust).not.toHaveBeenCalled();
    expect(api.prepare).not.toHaveBeenCalled();
    expect(api.startRun).not.toHaveBeenCalled();
    expect(api.startTerminal).not.toHaveBeenCalled();
    expect(api.invoke).not.toHaveBeenCalled();
    expect(screen.queryByTestId("terminal-renderer")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save and Run" })).toBeDisabled();
  });
  it("requires explicit trust and refuses launch after a preparation failure", async () => {
    api.prepare.mockRejectedValue(new Error("Unsynchronized flow draft"));
    await mount();
    await trust();
    expect(api.setTrust).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Save and Run" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Unsynchronized flow draft");
    expect(api.startRun).not.toHaveBeenCalled();
    expect(api.startTerminal).not.toHaveBeenCalled();
  });
  it("preserves the same terminal renderer and session through hide, tabs and settings", async () => {
    await mount();
    await trust();
    await startTerminal();
    const renderer = screen.getByTestId("terminal-renderer");
    fireEvent.click(screen.getByRole("button", { name: "Hide terminal / output" }));
    fireEvent.click(screen.getByRole("button", { name: "Terminal / output" }));
    fireEvent.click(screen.getByRole("tab", { name: "Run Output" }));
    fireEvent.click(screen.getByRole("button", { name: "Run settings" }));
    expect(screen.getByTestId("terminal-renderer")).toBe(renderer);
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));
    expect(screen.getByTestId("terminal-renderer")).toBe(renderer);
    expect(screen.getByText("from first workspace")).toBeVisible();
    expect(api.stop).not.toHaveBeenCalled();
    expect(api.invoke.mock.calls.some(([command]) => command === "execution_cancel_run")).toBe(
      false,
    );
    expect(api.startTerminal).toHaveBeenCalledOnce();
  });
  it.each(["same", "different"])(
    "does not restore an old Stop result after %s-checkout replacement",
    async (checkout) => {
      await mount();
      await trust();
      fireEvent.click(screen.getByRole("button", { name: "Save and Run" }));
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/running/i));
      const stopping = deferred<ExecutionSnapshot>();
      api.stop.mockReturnValueOnce(stopping.promise);
      fireEvent.click(screen.getByRole("button", { name: "Stop" }));
      await waitFor(() => expect(api.stop).toHaveBeenCalledOnce());
      await act(async () => {
        setSession("second");
        if (checkout === "same")
          useUiStore.setState({
            repoSession: { ...useUiStore.getState().repoSession!, path: "/fixture/first" },
          });
      });
      await waitFor(() =>
        expect(api.bind).toHaveBeenCalledWith(
          checkout === "same" ? "/fixture/first" : "/fixture/second",
          "second",
        ),
      );
      await act(async () =>
        stopping.resolve(
          snapshot("run", {
            state: "exited",
            cleanupConfirmed: true,
            outputComplete: true,
            exitCode: 0,
          }),
        ),
      );
      expect(screen.getByRole("status")).toHaveTextContent("Ready");
      expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
    },
  );

  it.each(["same", "different"])(
    "does not rebind an obsolete owner when Stop rejects after %s-checkout replacement",
    async (checkout) => {
      await mount();
      await trust();
      fireEvent.click(screen.getByRole("button", { name: "Save and Run" }));
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/running/i));
      let reject!: (reason: Error) => void;
      api.stop.mockReturnValueOnce(
        new Promise<ExecutionSnapshot>((_resolve, fail) => {
          reject = fail;
        }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Stop" }));
      await waitFor(() => expect(api.stop).toHaveBeenCalledOnce());
      await act(async () => {
        setSession("second");
        if (checkout === "same")
          useUiStore.setState({
            repoSession: { ...useUiStore.getState().repoSession!, path: "/fixture/first" },
          });
      });
      await waitFor(() => expect(api.bind).toHaveBeenCalledTimes(2));
      await act(async () => reject(new Error("Retired Stop reply")));
      expect(api.bind).toHaveBeenCalledTimes(2);
      expect(screen.queryByText("Retired Stop reply")).not.toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent("Ready");
    },
  );

  it.each(["same", "different"])(
    "does not restore old trust consent after %s-checkout replacement",
    async (checkout) => {
      await mount();
      fireEvent.click(screen.getByRole("button", { name: "Terminal / output" }));
      const consent = deferred<ExecutionContext>();
      api.setTrust.mockReturnValueOnce(consent.promise);
      fireEvent.click(screen.getByRole("button", { name: "Trust this project for this session" }));
      await waitFor(() => expect(api.setTrust).toHaveBeenCalledOnce());
      const old = api.setTrust.mock.calls[0][0] as ExecutionContext;
      await act(async () => {
        setSession("second");
        if (checkout === "same")
          useUiStore.setState({
            repoSession: { ...useUiStore.getState().repoSession!, path: "/fixture/first" },
          });
      });
      await waitFor(() =>
        expect(api.bind).toHaveBeenCalledWith(
          checkout === "same" ? "/fixture/first" : "/fixture/second",
          "second",
        ),
      );
      await act(async () => consent.resolve({ ...old, trusted: true, trustRevision: 1 }));
      expect(screen.getByRole("button", { name: "Save and Run" })).toBeDisabled();
      expect(
        screen.getByRole("button", { name: "Trust this project for this session" }),
      ).toBeVisible();
      expect(api.startRun).not.toHaveBeenCalled();
    },
  );

  it("replaces a terminal renderer and clears old output/link authority on workspace replacement", async () => {
    await mount();
    await trust();
    await startTerminal();
    const previous = screen.getByTestId("terminal-renderer");
    fireEvent.click(screen.getByRole("button", { name: "Mock terminal link" }));
    expect(screen.getByText("http://localhost:43111/old-workspace")).toBeVisible();
    act(() => setSession("second"));
    await waitFor(() => expect(api.bind).toHaveBeenCalledWith("/fixture/second", "second"));
    await waitFor(() => expect(screen.queryByTestId("terminal-renderer")).not.toBeInTheDocument());
    expect(previous).not.toBeInTheDocument();
    expect(screen.queryByText("from first workspace")).not.toBeInTheDocument();
    expect(screen.queryByText("http://localhost:43111/old-workspace")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mock terminal link" })).not.toBeInTheDocument();
    expect(screen.queryByText("http://localhost:43111/old-workspace")).not.toBeInTheDocument();
    expect(api.invoke.mock.calls.some(([command]) => command === "execution_open_loopback")).toBe(
      false,
    );
  });
  it("serializes duplicate Run actions while preparation is pending", async () => {
    const preparing = deferred<PreparationReceipt>();
    api.prepare.mockReturnValue(preparing.promise);
    await mount();
    await trust();
    const run = useExecutionActions.getState().run;
    act(() => {
      run();
      run();
    });
    expect(api.prepare).toHaveBeenCalledOnce();
    expect(api.startRun).not.toHaveBeenCalled();
    await act(async () => preparing.resolve(receipt()));
    await waitFor(() => expect(api.startRun).toHaveBeenCalledOnce());
    expect(api.assertCurrent).toHaveBeenCalledOnce();
  });
  it("cancels pending preparation on Stop and a late success never launches", async () => {
    const preparing = deferred<PreparationReceipt>();
    api.prepare.mockReturnValue(preparing.promise);
    await mount();
    await trust();
    fireEvent.click(screen.getByRole("button", { name: "Save and Run" }));
    await waitFor(() => expect(api.prepare).toHaveBeenCalledOnce());
    const signal = api.prepare.mock.calls[0][3] as AbortSignal;
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(signal.aborted).toBe(true);
    await act(async () => preparing.resolve(receipt()));
    await waitFor(() =>
      expect(api.invoke.mock.calls.some(([command]) => command === "execution_cancel_run")).toBe(
        true,
      ),
    );
    expect(api.startRun).not.toHaveBeenCalled();
  });
  it("shows a confirmed requested Stop separately from a process failure", async () => {
    await mount();
    await trust();
    fireEvent.click(screen.getByRole("button", { name: "Save and Run" }));
    await waitFor(() => expect(api.startRun).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole("button", { name: "Restart" })).toBeEnabled());
    api.stop.mockResolvedValue(
      snapshot("run", {
        state: "exited",
        completionReason: "stopped",
        stopRequested: true,
        exitCode: 1,
        exitSignal: 15,
        cleanupConfirmed: true,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(await screen.findByText("stopped · signal 15")).toBeVisible();
    expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Restart" })).toBeEnabled();
  });
  it("blocks Restart after unconfirmed cleanup without preparing or spawning again", async () => {
    await mount();
    await trust();
    fireEvent.click(screen.getByRole("button", { name: "Save and Run" }));
    await waitFor(() => expect(api.startRun).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole("button", { name: "Restart" })).toBeEnabled());
    api.stop.mockResolvedValue(
      snapshot("run", { state: "cleanup-unknown", cleanupConfirmed: false }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    expect(
      await screen.findByText("Prior run cleanup is unconfirmed. Restart is blocked."),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Restart" })).toBeDisabled();
    expect(api.prepare).toHaveBeenCalledOnce();
    expect(api.startRun).toHaveBeenCalledOnce();
  });
  it("mid-run configuration edits leave the active snapshot intact and Restart prepares the new saved config", async () => {
    await mount();
    await trust();
    fireEvent.click(screen.getByRole("button", { name: "Save and Run" }));
    await waitFor(() => expect(api.startRun).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole("button", { name: "Restart" })).toBeEnabled());
    const firstConfig = api.startRun.mock.calls[0][1];
    fireEvent.click(screen.getByRole("button", { name: "Run settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changed configuration" }));
    await waitFor(() => expect(api.save).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Mock run settings" })).not.toBeInTheDocument(),
    );
    expect(firstConfig).toMatchObject({ args: ["main.py"], env: {}, name: "App" });
    expect(api.startRun).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    await waitFor(() => expect(api.startRun).toHaveBeenCalledTimes(2));
    expect(api.stop).toHaveBeenCalledOnce();
    expect(api.prepare).toHaveBeenCalledTimes(2);
    expect(api.startRun.mock.calls[1][1]).toMatchObject({
      id: "app",
      args: ["changed Ω.py"],
      env: { MODE: "next" },
      name: "Next configuration",
    });
    expect(firstConfig).toMatchObject({ args: ["main.py"], env: {}, name: "App" });
  });
});
