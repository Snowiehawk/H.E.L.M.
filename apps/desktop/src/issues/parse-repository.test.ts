// Adapted from Issue Atlas (MIT), copyright (c) 2026 Chris Cheney.
// See third_party/issue-atlas.LICENSE.
import { describe, expect, it } from "vitest";
import { parseRepositoryInput, RepositoryInputError } from "./github/parse-repository";

describe("parseRepositoryInput", () => {
  it.each([
    ["owner/repo", "owner/repo"],
    ["https://github.com/owner/repo/issues/14", "owner/repo"],
    ["git@github.com:owner/repo.git", "owner/repo"],
    ["example/A.B.", "example/A.B."],
    ["https://github.com/example/A.B.", "example/A.B."],
    ["https://github.com/example/A.B./issues/190", "example/A.B."],
    ["git@github.com:example/A.B..git", "example/A.B."],
    ["owner/repo-", "owner/repo-"],
    ["owner/repo_", "owner/repo_"],
    ["owner/a", "owner/a"],
    [`owner/${"a".repeat(100)}`, `owner/${"a".repeat(100)}`],
  ])("parses %s", (input, expected) => {
    expect(parseRepositoryInput(input).nameWithOwner).toBe(expected);
  });

  it("preserves every part of the dotted repository identity", () => {
    expect(parseRepositoryInput("https://github.com/example/A.B.")).toEqual({
      owner: "example",
      name: "A.B.",
      nameWithOwner: "example/A.B.",
      url: "https://github.com/example/A.B.",
    });
  });

  it.each([
    "",
    "https://gitlab.com/owner/repo",
    "owner",
    "owner/repo name",
    "owner./repo",
    "owner-/repo",
    "owner/repo%2E",
    "owner/repo@",
    "owner/repo\\name",
    `owner/${"a".repeat(101)}`,
  ])("rejects %s", (input) =>
    expect(() => parseRepositoryInput(input)).toThrow(RepositoryInputError),
  );
});
