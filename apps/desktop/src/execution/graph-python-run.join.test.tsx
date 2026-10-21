/// <reference types="node" />
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Readable } from "node:stream";
import { useEffect } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionWorkspace } from "./ExecutionWorkspace";
import { resetExecutionActions, useExecutionActions } from "./actions";
import {
  registerWorkspacePreparation,
  type PreparedSource,
  type WorkspacePreparationSnapshot,
} from "./preparation";
import type { ExecutionContext } from "./contracts";
import { useUiStore } from "../store/uiStore";

// This opt-in join owns only disposable fixtures and an approved Python child.
// The provider is a fixture; the preparation registry/barrier and Run controller
// are production code. Python graph compilation and worker replies are real.
// No Rust process supervisor, GUI, or project entry point is executed here.
const python = process.env.HELM_TEST_PYTHON;
const sourceRoot = process.env.HELM_TEST_SOURCE_ROOT;
const enabled = Boolean(python && sourceRoot);
const boundary = vi.hoisted(() => ({
  invoke: vi.fn(),
  start: vi.fn(),
  bind: vi.fn(),
  setTrust: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: boundary.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("./adapter", () => ({ executionAdapter: { startRun: boundary.start } }));
vi.mock("./RunOutputNavigation", () => ({ RunOutputNavigation: () => null }));
vi.mock("./TerminalView", () => ({ TerminalView: () => null }));
vi.mock("./configService", () => ({
  executionConfigService: {
    bind: boundary.bind,
    setTrust: boundary.setTrust,
    read: vi.fn(async () => ({
      schemaVersion: 1,
      revision: 1,
      defaultId: "app",
      configs: [
        {
          id: "app",
          name: "Synthetic graph join",
          kind: "app",
          mode: "executable",
          executable: "never-executed",
          args: ["service.py"],
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

interface WorkerRequest {
  id: number;
  command: string;
  params: { request_json: string; [key: string]: unknown };
}
interface Ready {
  event: "ready";
  repoPath: string;
  workerRequest: WorkerRequest;
  initialSourceHash: string;
  symbolId: string;
  flowStoreRelativePath: string;
}
interface Committed {
  event: "committed";
  sourceContent: string;
  sourceSha256: string;
  flowStoreSha256: string;
  flowSyncState: string;
  undoTransaction: Record<string, unknown>;
  journalCount: number;
  applyCount: number;
  replyLost: boolean;
  replyLossErrno: number | null;
  preparedSource: PreparedSource;
}
interface WorkerReply {
  id: number;
  ok: boolean;
  result?: { edit: { undo_transaction: Record<string, unknown> } };
  error?: string;
}
type Control =
  | Ready
  | Committed
  | { event: "before_compile" }
  | { event: "error"; message: string };
type Exit = { code: number | null; signal: NodeJS.Signals | null };

function deadline<T>(operation: Promise<T>, label: string, milliseconds = 15000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} exceeded ${milliseconds}ms`)),
      milliseconds,
    );
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (reason) => {
        clearTimeout(timer);
        reject(reason);
      },
    );
  });
}

class PythonGraphBridge {
  readonly child: ChildProcess;
  readonly closed: Promise<Exit>;
  readonly ready: Promise<Ready>;
  private frames = new Map<string, Control>();
  private listeners = new Map<
    string,
    { resolve: (frame: Control) => void; reject: (reason: Error) => void }[]
  >();
  private exit?: Exit;
  private spawnFailure?: Error;
  private diagnostic = "";
  private timer: ReturnType<typeof setTimeout>;
  stdoutReply?: WorkerReply;
  submitted = 0;

  constructor(readonly repoPath: string) {
    if (!python || !sourceRoot || !isAbsolute(python) || !isAbsolute(sourceRoot))
      throw new Error(
        "The graph join requires absolute HELM_TEST_PYTHON and HELM_TEST_SOURCE_ROOT paths.",
      );
    // Literal argv, no shell, no project command, no inherited credentials or
    // HELM runtime overrides. -I requires the helper's explicit source-root arg.
    const env: NodeJS.ProcessEnv = { PATH: process.platform === "win32" ? "" : "/usr/bin:/bin" };
    if (process.platform === "win32" && process.env.SYSTEMROOT)
      env.SYSTEMROOT = process.env.SYSTEMROOT;
    this.child = spawn(
      python,
      [
        "-I",
        "-B",
        join(sourceRoot, "tests/fixtures/graph_run_join_worker.py"),
        "--source-root",
        sourceRoot,
        "--repo",
        repoPath,
        "--timeout",
        "10",
      ],
      {
        cwd: repoPath,
        env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe", "pipe"],
      },
    );
    this.closed = new Promise((resolve) => {
      this.child.once("error", (error) => {
        this.spawnFailure = error;
      });
      this.child.once("close", (code, signal) => {
        this.exit = { code, signal };
        clearTimeout(this.timer);
        const error =
          this.spawnFailure ??
          new Error(
            `Python graph worker closed (exit ${code}, signal ${signal ?? "none"}): ${this.diagnostic}`,
          );
        for (const listeners of this.listeners.values())
          for (const listener of listeners) listener.reject(error);
        this.listeners.clear();
        resolve(this.exit);
      });
    });
    this.timer = setTimeout(() => this.child.kill("SIGKILL"), 15000);
    const parseLines = (stream: Readable, control: boolean) => {
      let pending = "";
      let bytes = 0;
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 5 * 1024 * 1024) {
          this.spawnFailure = new Error("Graph join output exceeded its bound.");
          this.child.kill("SIGKILL");
          return;
        }
        pending += chunk;
        let newline: number;
        while ((newline = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (!line.trim()) continue;
          try {
            if (control) {
              const frame = JSON.parse(line) as Control;
              if (frame.event === "error") this.spawnFailure = new Error(frame.message);
              this.frames.set(frame.event, frame);
              for (const listener of this.listeners.get(frame.event) ?? []) listener.resolve(frame);
              this.listeners.delete(frame.event);
            } else this.stdoutReply = JSON.parse(line) as WorkerReply;
          } catch {
            this.spawnFailure = new Error("Graph join emitted invalid JSON.");
            this.child.kill("SIGKILL");
          }
        }
      });
      stream.on("error", (error) => {
        this.spawnFailure = error;
      });
    };
    parseLines(this.child.stdout!, false);
    parseLines(this.child.stdio[3] as Readable, true);
    this.child.stderr!.setEncoding("utf8");
    this.child.stderr!.on("data", (chunk: string) => {
      this.diagnostic = (this.diagnostic + chunk).slice(-65536);
    });
    // Closing stdout intentionally is the loss mechanism, not a mocked throw.
    this.child.stdin!.on("error", (error) => {
      this.spawnFailure ??= error;
    });
    this.ready = this.frame("ready");
  }

  frame(event: "ready"): Promise<Ready>;
  frame(event: "committed"): Promise<Committed>;
  frame(event: "before_compile"): Promise<{ event: "before_compile" }>;
  frame(event: Control["event"]): Promise<Control> {
    const existing = this.frames.get(event);
    if (existing) return Promise.resolve(existing);
    if (this.exit)
      return Promise.reject(
        this.spawnFailure ??
          new Error(`Python graph worker already closed with exit ${this.exit.code}.`),
      );
    return deadline(
      new Promise<Control>((resolve, reject) => {
        this.listeners.set(event, [...(this.listeners.get(event) ?? []), { resolve, reject }]);
      }),
      `Python graph ${event}`,
    );
  }

  async compile(): Promise<Committed> {
    const ready = await this.ready;
    this.submitted += 1;
    this.child.stdin!.write(JSON.stringify(ready.workerRequest) + "\n");
    const exit = await deadline(this.closed, "Python graph worker reap");
    const committed = this.frames.get("committed") as Committed | undefined;
    if (this.spawnFailure || exit.code !== 0 || exit.signal || !this.stdoutReply?.ok || !committed)
      throw (
        this.spawnFailure ??
        new Error(
          `Python graph worker transport failed (exit ${exit.code}, replyLost=${committed?.replyLost ?? false}).`,
        )
      );
    return committed;
  }

  release() {
    this.child.stdin!.end(JSON.stringify({ command: "release" }) + "\n");
  }
  async loseActualReplyReader() {
    const closed = new Promise<void>((resolve) => this.child.stdout!.once("close", resolve));
    this.child.stdout!.destroy();
    await deadline(closed, "Close actual worker stdout reader", 2000);
  }
  async dispose() {
    if (!this.exit) this.child.kill("SIGKILL");
    await deadline(this.closed, "Reap owned Python graph worker", 3000);
    clearTimeout(this.timer);
  }
}

interface ProviderModel {
  repoPath: string;
  sessionId: string;
  draft: string;
  dirty: boolean;
  busy: boolean;
  error?: string;
  confirmedUndo: Record<string, unknown>[];
  save: () => Promise<void>;
}
function MountedPreparationProvider({ model }: { model: ProviderModel }) {
  useEffect(
    () =>
      registerWorkspacePreparation(
        (): WorkspacePreparationSnapshot => ({
          repoPath: model.repoPath,
          sessionId: model.sessionId,
          availability: "ready",
          dirty: model.dirty,
          stale: false,
          busy: model.busy,
          revision: model.draft,
          blockers: [],
          saves: model.dirty ? [model.save] : [],
        }),
      ),
    [model],
  );
  return <output aria-label="Owned graph draft">{model.draft}</output>;
}
function selectSession(model: ProviderModel) {
  useUiStore.setState({
    repoSession: {
      id: model.sessionId,
      path: model.repoPath,
      name: "graph-join",
      branch: "fixture",
      primaryLanguage: "Python",
      openedAt: "now",
    },
    indexingSession: undefined,
  });
}
let owned: { bridge: PythonGraphBridge; directory: string }[] = [];
let committedSource: PreparedSource | undefined;

async function mountJoin() {
  const directory = await mkdtemp(join(tmpdir(), "helm-graph-run-join-"));
  const bridge = new PythonGraphBridge(directory);
  owned.push({ bridge, directory });
  const ready = await bridge.ready;
  const model: ProviderModel = {
    repoPath: ready.repoPath,
    sessionId: "original-graph-owner",
    draft: ready.workerRequest.params.request_json,
    dirty: true,
    busy: false,
    confirmedUndo: [],
    save: async () => {
      model.busy = true;
      try {
        const committed = await bridge.compile();
        const acknowledgedUndo = bridge.stdoutReply?.result?.edit.undo_transaction;
        if (!acknowledgedUndo)
          throw new Error("The actual worker reply did not acknowledge its Undo transaction.");
        model.confirmedUndo.push(acknowledgedUndo);
        model.dirty = false;
        committedSource = committed.preparedSource;
      } catch (error) {
        model.error = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        model.busy = false;
      }
    },
  };
  selectSession(model);
  const view = render(
    <>
      <MountedPreparationProvider model={model} />
      <ExecutionWorkspace />
    </>,
  );
  await waitFor(() => expect(useExecutionActions.getState().canRun).toBe(true));
  return { bridge, ready, model, view };
}
async function assertRealCommit(bridge: PythonGraphBridge, ready: Ready) {
  const committed = await bridge.frame("committed");
  expect(committed.applyCount).toBe(1);
  expect(committed.flowSyncState).toBe("clean");
  expect(committed.journalCount).toBe(0);
  expect(committed.undoTransaction).toHaveProperty("file_snapshots");
  expect(committed.sourceContent).toContain("return a");
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const sourceHash = hash(await readFile(join(ready.repoPath, "service.py")));
  const flowHash = hash(await readFile(join(ready.repoPath, ready.flowStoreRelativePath)));
  expect(sourceHash).toBe(committed.sourceSha256);
  expect(sourceHash).not.toBe(ready.initialSourceHash);
  expect(flowHash).toBe(committed.flowStoreSha256);
  expect(committed.preparedSource.files).toContainEqual({
    relativePath: "service.py",
    sha256: sourceHash,
  });
  expect(committed.preparedSource.files).toContainEqual({
    relativePath: ready.flowStoreRelativePath,
    sha256: flowHash,
  });
  expect(bridge.submitted).toBe(1);
  return committed;
}

beforeEach(() => {
  boundary.invoke.mockReset();
  boundary.start.mockReset();
  boundary.bind.mockReset();
  boundary.setTrust.mockReset();
  committedSource = undefined;
  resetExecutionActions();
  useUiStore.getState().resetWorkspace();
  useUiStore.setState({ repoSession: undefined, indexingSession: undefined });
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  boundary.bind.mockImplementation(
    async (repoPath: string, generation: string): Promise<ExecutionContext> => ({
      repoPath,
      generation,
      contextId: generation,
      trustRevision: 1,
      trusted: true,
    }),
  );
  boundary.invoke.mockImplementation(
    async (command: string, args: { context: ExecutionContext }) => {
      if (command === "execution_cancel_run") return args.context;
      if (command === "prepare_run_source") {
        if (!committedSource) throw new Error("No actual compiled source manifest is available.");
        return committedSource;
      }
      throw new Error(`Unexpected native test command: ${command}`);
    },
  );
  boundary.start.mockResolvedValue({
    id: "spy-only",
    kind: "run",
    state: "exited",
    exitCode: 0,
    cleanupConfirmed: true,
    outputComplete: true,
    sequence: 0,
    truncated: false,
    chunks: [],
  });
});
afterEach(async () => {
  cleanup();
  resetExecutionActions();
  // Do not delete a fixture while its exact owned child has unconfirmed teardown.
  for (const fixture of owned) {
    await fixture.bridge.dispose();
    await rm(fixture.directory, { recursive: true, force: true });
  }
  owned = [];
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe.skipIf(!enabled)(
  "#102 actual Python graph compile joined to production preparation/Run controller (opt-in HELM_TEST_PYTHON + HELM_TEST_SOURCE_ROOT)",
  () => {
    it("does not launch or replay when an actual stdout pipe loses the reply after real graph commit", async () => {
      const fixture = await mountJoin();
      const originalDraft = fixture.model.draft;
      act(() => useExecutionActions.getState().run());
      await fixture.bridge.frame("before_compile");
      await fixture.bridge.loseActualReplyReader();
      fixture.bridge.release();
      await fixture.bridge.closed;
      await waitFor(() => expect(useExecutionActions.getState().canStop).toBe(false));
      const committed = await assertRealCommit(fixture.bridge, fixture.ready);
      expect(committed.replyLost).toBe(true);
      expect(process.platform === "win32" ? [22, 32] : [32]).toContain(committed.replyLossErrno);
      expect(fixture.bridge.stdoutReply).toBeUndefined();
      expect((await fixture.bridge.closed).code).toBe(74);
      expect(fixture.model.error).toMatch(/transport failed.*74/);
      expect(fixture.model.dirty).toBe(true);
      expect(fixture.model.draft).toBe(originalDraft);
      // Forensic Undo from fd3 is not fabricated as an acknowledged app reply.
      expect(fixture.model.confirmedUndo).toEqual([]);
      expect(
        boundary.invoke.mock.calls.filter(([command]) => command === "prepare_run_source"),
      ).toHaveLength(0);
      expect(boundary.start).not.toHaveBeenCalled();
      await act(async () => {
        await Promise.resolve();
      });
      expect(fixture.bridge.submitted).toBe(1);
    }, 20000);

    it.each(["stop", "replacement"] as const)(
      "does not launch after %s happens before the actual graph compiler is released",
      async (action) => {
        const fixture = await mountJoin();
        const originalDraft = fixture.model.draft;
        act(() => useExecutionActions.getState().run());
        await fixture.bridge.frame("before_compile");
        expect(fixture.model.busy).toBe(true);
        expect(fixture.model.confirmedUndo).toEqual([]);
        expect(
          createHash("sha256")
            .update(await readFile(join(fixture.ready.repoPath, "service.py")))
            .digest("hex"),
        ).toBe(fixture.ready.initialSourceHash);
        await expect(
          readFile(join(fixture.ready.repoPath, fixture.ready.flowStoreRelativePath)),
        ).rejects.toMatchObject({ code: "ENOENT" });
        const replacement: ProviderModel = {
          ...fixture.model,
          sessionId: "replacement-graph-owner",
          repoPath: join(fixture.ready.repoPath, "replacement"),
          draft: "replacement graph draft Ω",
          confirmedUndo: [],
          busy: false,
          save: async () => {
            throw new Error("A replacement owner was unexpectedly saved.");
          },
        };
        if (action === "stop") act(() => useExecutionActions.getState().stop());
        else
          act(() => {
            selectSession(replacement);
            fixture.view.rerender(
              <>
                <MountedPreparationProvider model={replacement} />
                <ExecutionWorkspace />
              </>,
            );
          });
        fixture.bridge.release();
        await fixture.bridge.closed;
        await waitFor(() => expect(useExecutionActions.getState().canStop).toBe(false));
        const committed = await assertRealCommit(fixture.bridge, fixture.ready);
        expect(committed.replyLost).toBe(false);
        expect(committed.replyLossErrno).toBeNull();
        expect(fixture.bridge.stdoutReply?.ok).toBe(true);
        expect(fixture.model.draft).toBe(originalDraft);
        expect(fixture.model.dirty).toBe(false);
        expect(fixture.model.confirmedUndo).toEqual([committed.undoTransaction]);
        if (action === "replacement") {
          expect(useUiStore.getState().repoSession?.id).toBe(replacement.sessionId);
          expect(replacement.dirty).toBe(true);
          expect(replacement.draft).toBe("replacement graph draft Ω");
          expect(replacement.confirmedUndo).toEqual([]);
        }
        expect(
          boundary.invoke.mock.calls.filter(([command]) => command === "prepare_run_source"),
        ).toHaveLength(0);
        expect(boundary.start).not.toHaveBeenCalled();
      },
      20000,
    );

    it("positive control admits one launch spy with the actual compiled and independently hashed source manifest", async () => {
      const fixture = await mountJoin();
      act(() => useExecutionActions.getState().run());
      await fixture.bridge.frame("before_compile");
      fixture.bridge.release();
      await fixture.bridge.closed;
      await waitFor(() => expect(boundary.start).toHaveBeenCalledTimes(1));
      const committed = await assertRealCommit(fixture.bridge, fixture.ready);
      expect(
        boundary.invoke.mock.calls.filter(([command]) => command === "prepare_run_source"),
      ).toHaveLength(1);
      expect(boundary.start.mock.calls[0]?.[2]).toEqual(committed.preparedSource);
      expect(fixture.model.confirmedUndo).toEqual([committed.undoTransaction]);
    }, 20000);

    it("#93 allows the actual Revoke trust button during a real pending graph compile and never launches its late result", async () => {
      const fixture = await mountJoin();
      boundary.setTrust.mockImplementation(async (context: ExecutionContext, trusted: boolean) => {
        const updated = { ...context, trustRevision: context.trustRevision + 1, trusted };
        boundary.bind.mockResolvedValue(updated);
        return updated;
      });
      act(() => useExecutionActions.getState().run());
      await fixture.bridge.frame("before_compile");
      const revoke = screen.getByRole("button", { name: "Revoke trust and stop work" });
      expect(revoke).toBeEnabled();
      fireEvent.click(revoke);
      await waitFor(() => expect(boundary.setTrust).toHaveBeenCalledTimes(1));
      expect(boundary.setTrust.mock.calls[0]?.[1]).toBe(false);
      await screen.findByText("Project execution is disabled until trusted.");
      expect(
        screen.getByRole("button", { name: "Trust this project for this session" }),
      ).toBeDisabled();
      fixture.bridge.release();
      await fixture.bridge.closed;
      await waitFor(() => expect(useExecutionActions.getState().canStop).toBe(false));
      await assertRealCommit(fixture.bridge, fixture.ready);
      expect(screen.getByText("Project execution is disabled until trusted.")).toBeInTheDocument();
      expect(useExecutionActions.getState().canRun).toBe(false);
      expect(
        boundary.invoke.mock.calls.filter(([command]) => command === "prepare_run_source"),
      ).toHaveLength(0);
      expect(boundary.start).not.toHaveBeenCalled();
      expect(boundary.setTrust.mock.calls.every(([, trusted]) => trusted === false)).toBe(true);
    }, 20000);
  },
);
