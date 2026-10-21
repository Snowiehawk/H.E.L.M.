import { invoke } from "@tauri-apps/api/core";
import type { ExecutionContext, RunConfig } from "./contracts";
import type { PreparedSource } from "./preparation";

export type ExecutionPhase =
  | "starting"
  | "running"
  | "stopping"
  | "exited"
  | "failed"
  | "cleanup-unknown";
export interface ExecutionChunk {
  sequence: number;
  stream: "stdout" | "stderr" | "terminal";
  data: number[];
}
export interface ExecutionSnapshot {
  ownedPid?: number;
  cleanupError?: string | null;
  cleanupRecovery?: string | null;
  id: string;
  kind: "run" | "terminal";
  state: ExecutionPhase;
  exitCode: number | null;
  /** Native signal detail when available; exitCode remains the compatibility status. */
  exitSignal?: number | null;
  /** A confirmed requested stop is distinct from a natural nonzero process exit. */
  completionReason?: "exited" | "stopped" | "failed" | "cleanup-unknown" | null;
  stopRequested?: boolean;
  cleanupConfirmed: boolean;
  outputComplete: boolean;
  sequence: number;
  truncated: boolean;
  chunks: ExecutionChunk[];
}
export interface ExecutionAdapter {
  startRun(
    context: ExecutionContext,
    config: RunConfig,
    preparedSource: PreparedSource,
  ): Promise<ExecutionSnapshot>;
  startTerminal(
    context: ExecutionContext,
    rows: number,
    cols: number,
    executable?: string,
  ): Promise<ExecutionSnapshot>;
  poll(context: ExecutionContext, id: string, after: number): Promise<ExecutionSnapshot>;
  stop(context: ExecutionContext, id: string): Promise<ExecutionSnapshot>;
  write(context: ExecutionContext, id: string, data: string): Promise<void>;
  resize(context: ExecutionContext, id: string, rows: number, cols: number): Promise<void>;
}
export class LiveExecutionAdapter implements ExecutionAdapter {
  startRun(context: ExecutionContext, config: RunConfig, preparedSource: PreparedSource) {
    return invoke<ExecutionSnapshot>("execution_start_run", { context, config, preparedSource });
  }
  startTerminal(context: ExecutionContext, rows: number, cols: number, executable?: string) {
    return invoke<ExecutionSnapshot>("execution_start_terminal", {
      context,
      rows,
      cols,
      executable,
    });
  }
  poll(context: ExecutionContext, id: string, after: number) {
    return invoke<ExecutionSnapshot>("execution_poll", { context, id, after });
  }
  stop(context: ExecutionContext, id: string) {
    return invoke<ExecutionSnapshot>("execution_stop", { context, id });
  }
  write(context: ExecutionContext, id: string, data: string) {
    return invoke<void>("execution_write", { context, id, data });
  }
  resize(context: ExecutionContext, id: string, rows: number, cols: number) {
    return invoke<void>("execution_resize", { context, id, rows, cols });
  }
}
/** Browser mock mode never starts a machine process or pretends native acceptance. */
export class MockExecutionAdapter implements ExecutionAdapter {
  private unavailable(): never {
    throw new Error(
      "Project execution requires the native desktop app. Browser mock mode cannot run projects.",
    );
  }
  async startRun(): Promise<ExecutionSnapshot> {
    return this.unavailable();
  }
  async startTerminal(): Promise<ExecutionSnapshot> {
    return this.unavailable();
  }
  async poll(): Promise<ExecutionSnapshot> {
    return this.unavailable();
  }
  async stop(): Promise<ExecutionSnapshot> {
    return this.unavailable();
  }
  async write(): Promise<void> {
    return this.unavailable();
  }
  async resize(): Promise<void> {
    return this.unavailable();
  }
}
export const executionAdapter: ExecutionAdapter =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
    ? new LiveExecutionAdapter()
    : new MockExecutionAdapter();
