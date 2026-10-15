// Adapted from Issue Atlas (MIT), copyright (c) 2026 Chris Cheney.
// See third_party/issue-atlas.LICENSE and docs/github-issues.md.
import type { IssueDependencyEdge, IssueRecord } from "./types";

/** Native blockers only; hierarchy and body references never become blocker edges. */
export function dependencyEdges(issues: readonly IssueRecord[]): IssueDependencyEdge[] {
  const edges = new Map<string, IssueDependencyEdge>();
  const add = (source: string, target: string) => {
    const id = `${source}->${target}`;
    edges.set(id, { id, source, target });
  };
  for (const issue of issues) {
    for (const blocker of issue.blockedBy) add(blocker.key, issue.key);
    for (const blocked of issue.blocking) add(issue.key, blocked.key);
  }
  return [...edges.values()].sort((left, right) => left.id.localeCompare(right.id));
}
