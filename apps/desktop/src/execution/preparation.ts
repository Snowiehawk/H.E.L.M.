import {
  assertWorkspaceMutationAdmission,
  isWorkspaceInstallationFrozen,
  workspaceMutationState,
} from "./mutationTracking";

/** The only Save and Run barrier. Rendering or selecting a config never calls it. */
export interface PreparedSourceFile {
  relativePath: string;
  sha256: string;
}

export interface PreparedIndexedSymbol {
  nodeId: string;
  relativePath: string;
  sourceHash: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface PreparedSource {
  preparationId?: string;
  repoPath: string;
  files: PreparedSourceFile[];
  indexedSymbols: PreparedIndexedSymbol[];
}

export interface WorkspacePreparationSnapshot {
  repoPath: string;
  sessionId: string;
  availability: "ready" | "loading" | "error" | "unavailable";
  dirty: boolean;
  stale: boolean;
  busy: boolean;
  /** Exact draft contents/targets, independent of dirty/save status booleans. */
  revision: string;
  blockers: string[];
  /** Each callback must reject on failure and verify authoritative saved bytes. */
  saves: (() => Promise<void | VerifiedSaveRevision>)[];
}

/** Only an authoritative save may certify its exact, expected editor normalization. */
export interface VerifiedSaveRevision {
  previousRevision: string;
  revision: string;
}

function afterVerifiedSave(revision: string, saved: void | VerifiedSaveRevision): string {
  if (!saved) return revision;
  if (saved.previousRevision !== revision)
    throw new Error("Edits changed before the verified save. Review them and retry.");
  return saved.revision;
}

export interface PreparationReceipt {
  repoPath: string;
  sessionId: string;
  revision: string;
  mutationRevision: number;
  preparedSource: PreparedSource;
}

let provider: (() => WorkspacePreparationSnapshot) | undefined;
let preparationActive = false;
const receiptProviders = new WeakMap<PreparationReceipt, () => WorkspacePreparationSnapshot>();

export function registerWorkspacePreparation(next: () => WorkspacePreparationSnapshot) {
  provider = next;
  return () => {
    if (provider === next) provider = undefined;
  };
}

function readPreparationSnapshot(): WorkspacePreparationSnapshot | undefined {
  const snapshot = provider?.();
  return (
    snapshot && {
      ...snapshot,
      revision: JSON.stringify([snapshot.revision, workspaceMutationState().started]),
      blockers: [
        ...snapshot.blockers,
        ...(isWorkspaceInstallationFrozen()
          ? ["Workspace admission is frozen. Source navigation and Run are paused."]
          : []),
        ...(workspaceMutationState().active
          ? ["Wait for the current workspace mutation to finish before Run."]
          : []),
      ],
    }
  );
}

export function readWorkspacePreparationSnapshot(): WorkspacePreparationSnapshot | undefined {
  return readPreparationSnapshot();
}

function assertCurrent(
  initial: Pick<PreparationReceipt, "repoPath" | "sessionId" | "revision" | "mutationRevision">,
  owner: () => WorkspacePreparationSnapshot,
  signal?: AbortSignal,
) {
  if (signal?.aborted) throw new Error("Run preparation canceled. Saved edits remain saved.");
  if (provider !== owner) throw new Error("The workspace changed during run preparation.");
  const mutations = workspaceMutationState();
  if (mutations.active || mutations.started !== initial.mutationRevision)
    throw new Error(
      "A workspace mutation changed during preparation. Wait for it to finish and retry Run.",
    );
  const current = owner();
  if (
    current.repoPath !== initial.repoPath ||
    current.sessionId !== initial.sessionId ||
    current.revision !== initial.revision
  )
    throw new Error("Edits changed during run preparation. Review them and retry Run.");
  // The saves themselves may still have a React render pending. Their explicit
  // byte/version verification is the save proof, never a resolved Promise<void>.
  return current;
}

export function assertWorkspacePreparationCurrent(receipt: PreparationReceipt) {
  assertWorkspaceMutationAdmission();
  const owner = receiptProviders.get(receipt);
  if (!owner) throw new Error("Run preparation receipt is unavailable. Prepare again.");
  const current = assertCurrent(receipt, owner);
  if (current.blockers.length) throw new Error(current.blockers.join(" "));
}

export async function prepareWorkspaceToRun(
  repoPath: string,
  sessionId: string,
  freezeSource: () => Promise<PreparedSource>,
  signal?: AbortSignal,
): Promise<PreparationReceipt> {
  assertWorkspaceMutationAdmission();
  if (preparationActive) throw new Error("Run preparation is already in progress.");
  const owner = provider;
  if (!owner) throw new Error("Open the IDE workspace before using Save and Run.");
  const captured = owner();
  const initial = {
    ...captured,
    blockers: readWorkspacePreparationSnapshot()!.blockers,
    saves: [...captured.saves],
    mutationRevision: workspaceMutationState().started,
  };
  if (initial.repoPath !== repoPath || initial.sessionId !== sessionId)
    throw new Error("The selected workspace changed. Retry Run from its IDE.");
  if (initial.availability !== "ready" || initial.stale !== false || initial.busy !== false)
    throw new Error(
      "Workspace source is loading, unavailable, stale or busy. Resolve it before Run.",
    );
  if (initial.blockers.length) throw new Error(initial.blockers.join(" "));
  assertCurrent(initial, owner, signal);
  preparationActive = true;
  try {
    for (const save of initial.saves) {
      assertCurrent(initial, owner, signal);
      // The verified save synchronously enters its adapter write before yielding.
      // Record that single owned write; any later/concurrent write invalidates
      // admission even if its dirty boolean returns to the same value.
      const saving = save();
      const launched = workspaceMutationState();
      if (launched.started > initial.mutationRevision + 1) {
        await saving.catch(() => {});
        throw new Error(
          "More than one workspace mutation began during save. Retry Run after reconciliation.",
        );
      }
      initial.mutationRevision = launched.started;
      const saved = await saving;
      initial.revision = afterVerifiedSave(initial.revision, saved);
      assertCurrent(initial, owner, signal);
    }
    const preparedSource = await freezeSource();
    assertCurrent(initial, owner, signal);
    // Native canonical path may use a different Windows spelling. Its owner
    // validates it; do not substitute the renderer spelling into its proof.
    const receipt: PreparationReceipt = {
      repoPath,
      sessionId,
      revision: initial.revision,
      mutationRevision: initial.mutationRevision,
      preparedSource,
    };
    receiptProviders.set(receipt, owner);
    return receipt;
  } finally {
    preparationActive = false;
  }
}
