import type { DependencyRef, IssueRecord, RepositorySnapshot } from "./types";

export interface IssueGraphNode {
  id: string;
  nativeId: string;
  number: number;
  title: string;
  repository: string;
  state: "OPEN" | "CLOSED";
  url: string;
  external: boolean;
  partial: boolean;
  position: { x: number; y: number };
}
export interface IssueGraphEdge {
  id: string;
  kind: "blocks";
  source: string;
  target: string;
}
export interface IssueGraph {
  namespace: string;
  partial: boolean;
  nodes: IssueGraphNode[];
  edges: IssueGraphEdge[];
}

export const issueNodeId = (nativeId: string) => `github-issue:${nativeId}`;

/** A separate, read-only projection. No code-graph DTOs or persistence adapter. */
export function projectIssueGraph(snapshot: RepositorySnapshot): IssueGraph {
  const nodes = new Map<string, IssueGraphNode>();
  const edges = new Map<string, IssueGraphEdge>();
  const addNode = (issue: IssueRecord | DependencyRef, external: boolean) => {
    const id = issueNodeId(issue.id);
    if (nodes.has(id)) return;
    nodes.set(id, {
      id,
      nativeId: issue.id,
      number: issue.number,
      title: issue.title,
      repository: issue.repository,
      state: issue.state,
      url: issue.url,
      external,
      partial: "dependencyDataTruncated" in issue && issue.dependencyDataTruncated,
      position: { x: 0, y: 0 },
    });
  };
  snapshot.issues.forEach((issue) => addNode(issue, false));
  const addEdge = (source: string, target: string) => {
    const id = `github-blocks:${source}->${target}`;
    edges.set(id, { id, kind: "blocks", source: issueNodeId(source), target: issueNodeId(target) });
  };
  for (const issue of snapshot.issues) {
    for (const blocker of issue.blockedBy) {
      addNode(blocker, true);
      addEdge(blocker.id, issue.id);
    }
    for (const blocked of issue.blocking) {
      addNode(blocked, true);
      addEdge(issue.id, blocked.id);
    }
  }
  const orderedNodes = [...nodes.values()].sort(
    (a, b) => a.repository.localeCompare(b.repository) || a.number - b.number,
  );
  const orderedEdges = [...edges.values()].sort((a, b) => a.id.localeCompare(b.id));
  const incoming = new Map(orderedNodes.map((node) => [node.id, 0]));
  const outgoing = new Map(orderedNodes.map((node) => [node.id, [] as string[]]));
  for (const edge of orderedEdges) {
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    outgoing.get(edge.source)?.push(edge.target);
  }
  const queue = orderedNodes.filter((node) => incoming.get(node.id) === 0).map((node) => node.id);
  const ranks = new Map<string, number>();
  for (const id of queue) {
    const rank = ranks.get(id) ?? 0;
    ranks.set(id, rank);
    for (const next of outgoing.get(id) ?? []) {
      ranks.set(next, Math.max(ranks.get(next) ?? 0, rank + 1));
      incoming.set(next, (incoming.get(next) ?? 1) - 1);
      if (incoming.get(next) === 0) queue.push(next);
    }
  }
  // Cycles and their unresolved dependents remain visible in a fallback column.
  const cyclicRank = Math.max(0, ...ranks.values()) + 1;
  const rows = new Map<number, number>();
  for (const node of orderedNodes) {
    const rank = incoming.get(node.id) ? cyclicRank : (ranks.get(node.id) ?? 0);
    const row = rows.get(rank) ?? 0;
    node.position = { x: rank * 350, y: row * 150 };
    rows.set(rank, row + 1);
  }
  return {
    namespace: `github-issues|${snapshot.repository.id}|overview`,
    partial:
      snapshot.completeness.issues === "partial" ||
      snapshot.completeness.dependencies === "partial",
    nodes: orderedNodes,
    edges: orderedEdges,
  };
}
