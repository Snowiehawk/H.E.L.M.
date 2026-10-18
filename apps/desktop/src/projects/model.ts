export interface ProjectInspection {
  path: string;
  head: string;
  branch: string | null;
  branches: string[];
  remoteBranches: string[];
  remotes: { name: string; repository: string | null; kind: "fetch" | "push" }[];
  staged: number;
  unstaged: number;
  untracked: number;
  conflicts: number;
  operations: string[];
  blocked: string[];
  fingerprint: string;
}
export interface Association {
  path: string;
  repository: string | null;
  remote: string | null;
}
export interface ProjectRecord {
  version: 1;
  linked: boolean;
  selectedPath?: string;
  issueRepository?: string;
  associations: Association[];
}
export const PROJECT_STORAGE_KEY = "helm.project-context.v1";
export const freshProjectRecord = (): ProjectRecord => ({
  version: 1,
  linked: false,
  associations: [],
});
export function repositoryIdentity(value: string): string | undefined {
  if (!/^[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/.test(value)) return;
  if ([".", ".."].includes(value.split("/")[1])) return;
  return value.toLowerCase();
}
export function decodeProjectRecord(raw: string | null): ProjectRecord {
  if (!raw) return freshProjectRecord();
  const value = JSON.parse(raw);
  if (
    value.version !== 1 ||
    typeof value.linked !== "boolean" ||
    !Array.isArray(value.associations)
  )
    throw new Error(
      "Saved project context is invalid or from an unsupported version. It was retained; repair it before saving new associations.",
    );
  const associations = value.associations.map((entry: Association) => {
    if (
      typeof entry.path !== "string" ||
      !entry.path ||
      /[\0\r\n]/.test(entry.path) ||
      (entry.repository !== null && repositoryIdentity(entry.repository) !== entry.repository) ||
      (entry.remote !== null &&
        (typeof entry.remote !== "string" || !/^[\w.-]+$/.test(entry.remote)))
    )
      throw new Error("Saved project association is invalid. Its previous record was retained.");
    return { path: entry.path, repository: entry.repository, remote: entry.remote };
  });
  if (
    value.selectedPath !== undefined &&
    (typeof value.selectedPath !== "string" ||
      !associations.some((a: Association) => a.path === value.selectedPath))
  )
    throw new Error("Saved local selection needs repair.");
  if (
    value.issueRepository !== undefined &&
    repositoryIdentity(value.issueRepository) !== value.issueRepository
  )
    throw new Error("Saved issue repository needs repair.");
  // Reconstruct a whitelist; credential/payload/unknown fields are never reserialized.
  return {
    version: 1,
    linked: value.linked,
    selectedPath: value.selectedPath,
    issueRepository: value.issueRepository,
    associations,
  };
}
export function serializeProjectRecord(record: ProjectRecord): string {
  return JSON.stringify(decodeProjectRecord(JSON.stringify(record)));
}
export function verifiedMatches(
  repository: string,
  associations: Association[],
  inspections: ProjectInspection[],
): Association[] {
  return associations.filter(
    (a) =>
      a.repository === repository &&
      inspections.some(
        (i) =>
          i.path === a.path &&
          i.remotes.some(
            (r) => r.kind === "fetch" && r.name === a.remote && r.repository === repository,
          ),
      ),
  );
}
export function assertClean(inspection: ProjectInspection) {
  if (
    inspection.staged ||
    inspection.unstaged ||
    inspection.untracked ||
    inspection.conflicts ||
    inspection.operations.length
  )
    throw new Error(
      `Git work blocks this transition: ${inspection.staged} staged, ${inspection.unstaged} unstaged, ${inspection.untracked} untracked, ${inspection.conflicts} conflicts. Preserve it in Git, then retry. No automatic stash or discard.`,
    );
}
export interface DraftSnapshot {
  path: string;
  revision: string;
  declaration: boolean;
  workspaceFile: boolean;
  flow: boolean;
  busy: boolean;
  save: () => Promise<void>;
}
export function assertDraftsClean(snapshot: DraftSnapshot | undefined, path?: string) {
  if (!path) return;
  if (!snapshot || snapshot.path !== path)
    throw new Error(
      "Draft status is unavailable while the IDE is loading. Return to the workspace and retry.",
    );
  const dirty = [
    snapshot.declaration && "declaration",
    snapshot.workspaceFile && "workspace file",
    snapshot.flow && "flow/composer",
  ].filter(Boolean);
  if (snapshot.busy || dirty.length)
    throw new Error(
      `Transition blocked by ${snapshot.busy ? "an active IDE operation" : `unsaved ${dirty.join(", ")} drafts`}. Save drafts and retry, or stay in this checkout.`,
    );
}
