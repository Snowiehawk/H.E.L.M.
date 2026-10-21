import type { ExecutionChunk, ExecutionSnapshot } from "./adapter";
export const OUTPUT_RETAIN_BYTES = 256 * 1024;
export function mergeExecutionSnapshot(
  previous: ExecutionSnapshot | undefined,
  incoming: ExecutionSnapshot,
): ExecutionSnapshot {
  const prior = previous?.id === incoming.id ? previous : undefined;
  const chunks: ExecutionChunk[] = [
    ...(prior?.chunks ?? []),
    ...incoming.chunks.filter((chunk) => !prior || chunk.sequence > prior.sequence),
  ];
  let bytes = chunks.reduce((total, chunk) => total + chunk.data.length, 0);
  let truncated = Boolean(prior?.truncated || incoming.truncated);
  while (bytes > OUTPUT_RETAIN_BYTES && chunks.length > 1) {
    bytes -= chunks.shift()!.data.length;
    truncated = true;
  }
  const lifecycle =
    prior &&
    (prior.cleanupConfirmed || prior.state === "cleanup-unknown") &&
    !incoming.cleanupConfirmed
      ? prior
      : incoming;
  return {
    ...incoming,
    state: lifecycle.state,
    exitCode: lifecycle.exitCode,
    exitSignal: lifecycle.exitSignal,
    completionReason: lifecycle.completionReason,
    stopRequested: lifecycle.stopRequested,
    cleanupConfirmed: lifecycle.cleanupConfirmed,
    cleanupError: lifecycle.cleanupError,
    cleanupRecovery: lifecycle.cleanupRecovery,
    ownedPid: lifecycle.ownedPid,
    sequence: Math.max(prior?.sequence ?? 0, incoming.sequence),
    outputComplete:
      prior && incoming.sequence < prior.sequence ? prior.outputComplete : incoming.outputComplete,
    chunks,
    truncated,
  };
}
export function executionStatus(snapshot: ExecutionSnapshot): string {
  const state =
    snapshot.cleanupConfirmed && snapshot.completionReason === "stopped"
      ? "stopped"
      : snapshot.state;
  if (snapshot.exitSignal != null) return `${state} · signal ${snapshot.exitSignal}`;
  return snapshot.exitCode !== null ? `${state} · exit ${snapshot.exitCode}` : state;
}
export function outputText(snapshot?: ExecutionSnapshot): string {
  if (!snapshot) return "";
  const decoders = {
    stdout: new TextDecoder(),
    stderr: new TextDecoder(),
    terminal: new TextDecoder(),
  };
  return (
    snapshot.chunks
      .map((chunk) => decoders[chunk.stream].decode(new Uint8Array(chunk.data), { stream: true }))
      .join("") +
    Object.values(decoders)
      .map((decoder) => decoder.decode())
      .join("")
  );
}
