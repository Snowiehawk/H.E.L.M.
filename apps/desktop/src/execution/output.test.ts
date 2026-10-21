import { describe, expect, it } from "vitest";
import { executionStatus, mergeExecutionSnapshot, outputText, OUTPUT_RETAIN_BYTES } from "./output";
import type { ExecutionSnapshot } from "./adapter";
const snapshot = (id = "run-1"): ExecutionSnapshot => ({
  id,
  kind: "run",
  state: "running",
  exitCode: null,
  cleanupConfirmed: false,
  outputComplete: false,
  sequence: 0,
  truncated: false,
  chunks: [],
});
describe("bounded project output", () => {
  it("keeps split Unicode separate between stdout and stderr", () => {
    const value = snapshot();
    value.chunks = [
      { sequence: 1, stream: "stdout", data: [0xe2] },
      { sequence: 2, stream: "stderr", data: [0xe2, 0x9c, 0x93] },
      { sequence: 3, stream: "stdout", data: [0x82, 0xac] },
    ];
    expect(outputText(value)).toBe("✓€");
  });
  it("deduplicates polled chunks and truncates within a fixed memory budget", () => {
    const value = snapshot();
    value.sequence = 40;
    value.chunks = Array.from({ length: 40 }, (_, index) => ({
      sequence: index + 1,
      stream: "stdout" as const,
      data: Array(8192).fill(65),
    }));
    const merged = mergeExecutionSnapshot(undefined, value);
    expect(merged.truncated).toBe(true);
    expect(merged.chunks.reduce((n, c) => n + c.data.length, 0)).toBeLessThanOrEqual(
      OUTPUT_RETAIN_BYTES,
    );
    expect(mergeExecutionSnapshot(merged, value).chunks).toEqual(merged.chunks);
  });
  it("does not rewind consumed output on a Stop snapshot or resurrect an exited run", () => {
    const prior = snapshot();
    prior.sequence = 100;
    prior.chunks = [{ sequence: 100, stream: "stdout", data: [65] }];
    const stopped = {
      ...snapshot(),
      state: "exited" as const,
      completionReason: "stopped" as const,
      stopRequested: true,
      exitSignal: 15,
      cleanupConfirmed: true,
      sequence: 8,
      chunks: [{ sequence: 8, stream: "stdout" as const, data: [66] }],
    };
    const merged = mergeExecutionSnapshot(prior, stopped);
    expect(merged.sequence).toBe(100);
    expect(merged.chunks).toEqual(prior.chunks);
    const late = {
      ...snapshot(),
      sequence: 108,
      chunks: [{ sequence: 108, stream: "stdout" as const, data: [67] }],
    };
    const after = mergeExecutionSnapshot(merged, late);
    expect(after.sequence).toBe(108);
    expect(after.state).toBe("exited");
    expect(after.cleanupConfirmed).toBe(true);
    expect(after.completionReason).toBe("stopped");
    expect(after.stopRequested).toBe(true);
    expect(after.exitSignal).toBe(15);
    expect(after.chunks.map((chunk) => chunk.sequence)).toEqual([100, 108]);
  });
  it("labels a confirmed requested stop separately from failure and keeps raw exit detail", () => {
    const value = {
      ...snapshot(),
      state: "exited" as const,
      completionReason: "stopped" as const,
      stopRequested: true,
      cleanupConfirmed: true,
      exitCode: 1,
      exitSignal: 15,
    };
    expect(executionStatus(value)).toBe("stopped · signal 15");
    expect(executionStatus({ ...value, exitSignal: null })).toBe("stopped · exit 1");
    expect(
      executionStatus({ ...value, state: "failed", completionReason: "failed", exitSignal: null }),
    ).toBe("failed · exit 1");
    expect(executionStatus({ ...value, state: "cleanup-unknown", cleanupConfirmed: false })).toBe(
      "cleanup-unknown · signal 15",
    );
  });
  it("keeps cleanup diagnosis through late polls and clears it only on confirmed recovery", () => {
    const unknown: ExecutionSnapshot = {
      ...snapshot(),
      state: "cleanup-unknown",
      completionReason: "cleanup-unknown",
      ownedPid: 123,
      cleanupError: "Owned listener remains active",
      cleanupRecovery: "Retry cleanup before restarting",
    };
    const late = mergeExecutionSnapshot(unknown, snapshot());
    expect(late.state).toBe("cleanup-unknown");
    expect(late.cleanupError).toBe(unknown.cleanupError);
    expect(late.cleanupRecovery).toBe(unknown.cleanupRecovery);
    expect(late.ownedPid).toBe(123);
    const recovered = mergeExecutionSnapshot(late, {
      ...unknown,
      state: "exited",
      completionReason: "stopped",
      cleanupConfirmed: true,
      cleanupError: null,
      cleanupRecovery: null,
    });
    const stale = mergeExecutionSnapshot(recovered, unknown);
    expect(stale.completionReason).toBe("stopped");
    expect(stale.cleanupConfirmed).toBe(true);
    expect(stale.cleanupError).toBeNull();
    expect(stale.cleanupRecovery).toBeNull();
  });
  it("never carries output from the previous run into a new ID", () => {
    const prior = snapshot();
    prior.chunks = [{ sequence: 1, stream: "stderr", data: [65] }];
    prior.sequence = 1;
    expect(mergeExecutionSnapshot(prior, snapshot("run-2")).chunks).toEqual([]);
  });
});
