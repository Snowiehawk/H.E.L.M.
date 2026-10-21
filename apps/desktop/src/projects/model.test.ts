import { describe, expect, it } from "vitest";
import {
  assertClean,
  assertDraftsClean,
  decodeProjectRecord,
  freshProjectRecord,
  repositoryIdentity,
  serializeProjectRecord,
  verifiedMatches,
  type DraftSnapshot,
  type ProjectInspection,
} from "./model";
const inspection: ProjectInspection = {
  path: "/synthetic/ü repo",
  head: "abc",
  branch: "dev",
  branches: ["dev"],
  remoteBranches: [],
  remotes: [{ name: "origin", repository: "example/h.e.l.m.", kind: "fetch" }],
  staged: 0,
  unstaged: 0,
  untracked: 0,
  conflicts: 0,
  operations: [],
  blocked: [],
  fingerprint: "revision",
};
const draft: DraftSnapshot = {
  path: inspection.path,
  revision: "1",
  declaration: false,
  workspaceFile: false,
  flow: false,
  busy: false,
  save: async () => {},
};
describe("shared project contract", () => {
  it("starts unlinked; preserves trailing-dot/fork identity and whitelists persistence", () => {
    expect(freshProjectRecord().linked).toBe(false);
    expect(repositoryIdentity("Example/H.E.L.M.")).toBe("example/h.e.l.m.");
    expect(repositoryIdentity("https://token@github.com/example/repo")).toBeUndefined();
    const raw = JSON.stringify({
      version: 1,
      linked: true,
      selectedPath: inspection.path,
      issueRepository: "example/h.e.l.m.",
      associations: [
        {
          path: inspection.path,
          repository: "example/h.e.l.m.",
          remote: "origin",
          token: "NEVER-PERSIST",
        },
      ],
      token: "NEVER-PERSIST",
      snapshot: "NEVER-PERSIST",
    });
    expect(serializeProjectRecord(decodeProjectRecord(raw))).not.toContain("NEVER-PERSIST");
  });
  it("refuses corrupt/unsupported versions and malformed association identities", () => {
    for (const raw of [
      "invalid",
      '{"version":2}',
      JSON.stringify({
        version: 1,
        linked: true,
        associations: [{ path: "/x", repository: "token@github.com/repo", remote: "origin" }],
      }),
    ])
      expect(() => decodeProjectRecord(raw)).toThrow();
  });
  it("returns every verified local copy and never treats names/forks/stale remotes as matches", () => {
    const associations = [inspection.path, "/second", "/stale", "/fork"].map((path) => ({
      path,
      repository: "example/h.e.l.m.",
      remote: "origin",
    }));
    const results = [
      inspection,
      { ...inspection, path: "/second" },
      { ...inspection, path: "/stale", remotes: [] },
      {
        ...inspection,
        path: "/fork",
        remotes: [{ name: "origin", repository: "fork/h.e.l.m.", kind: "fetch" as const }],
      },
    ];
    expect(verifiedMatches("example/h.e.l.m.", associations, results).map((a) => a.path)).toEqual([
      inspection.path,
      "/second",
    ]);
  });
  it.each(["staged", "unstaged", "untracked", "conflicts"] as const)(
    "blocks %s work independently",
    (key) => {
      expect(() => assertClean({ ...inspection, [key]: 1 })).toThrow("Git work");
    },
  );
  it.each(["declaration", "workspaceFile", "flow", "busy"] as const)(
    "blocks %s draft/busy state and unknown providers",
    (key) => {
      expect(() => assertDraftsClean({ ...draft, [key]: true }, inspection.path)).toThrow(
        "blocked",
      );
      expect(() => assertDraftsClean(undefined, inspection.path)).toThrow("unavailable");
      expect(() => assertDraftsClean(draft, "/other")).toThrow("unavailable");
      expect(() => assertDraftsClean(draft, inspection.path)).not.toThrow();
    },
  );
});
