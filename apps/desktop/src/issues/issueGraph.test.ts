import { describe, expect, it, vi } from "vitest";
import { fetchRepositorySnapshot } from "./github/client";
import { parseRepositoryInput } from "./github/parse-repository";
import { issueNodeId, projectIssueGraph } from "./issueGraph";
import {
  issue,
  page,
  reference,
  repositoryName,
  response,
  TEST_TOKEN,
} from "./test-fixtures/github";

async function snapshot(nodes = [issue(1)]) {
  return fetchRepositorySnapshot(
    parseRepositoryInput(repositoryName),
    TEST_TOKEN,
    vi.fn(),
    undefined,
    vi.fn<typeof fetch>().mockResolvedValue(response(page(nodes))),
  );
}

describe("separate issue graph projection", () => {
  it("uses native IDs, deduplicates both relation directions and draws blocker -> blocked", async () => {
    const graph = projectIssueGraph(await snapshot([issue(1, [], [2]), issue(2, [1])]));
    expect(graph.nodes).toHaveLength(2);
    expect(graph.namespace).toBe(`github-issues|synthetic-repository-${repositoryName}|overview`);
    expect(graph.edges).toEqual([
      {
        id: `github-blocks:${reference(1).id}->${reference(2).id}`,
        kind: "blocks",
        source: issueNodeId(reference(1).id),
        target: issueNodeId(reference(2).id),
      },
    ]);
    expect(graph.nodes[0].position.x).toBeLessThan(graph.nodes[1].position.x);
  });

  it("preserves native identity across a repository rename and does not use local paths", async () => {
    const original = await snapshot();
    const renamed = {
      ...original,
      repository: { ...original.repository, nameWithOwner: "example/renamed" },
      issues: original.issues.map((node) => ({
        ...node,
        repository: "example/renamed",
        key: "example/renamed#1",
      })),
    };
    expect(projectIssueGraph(renamed).namespace).toBe(projectIssueGraph(original).namespace);
    expect(projectIssueGraph(renamed).nodes[0].id).toBe(projectIssueGraph(original).nodes[0].id);
    expect(JSON.stringify(projectIssueGraph(original))).not.toContain("repo:");
  });

  it("keeps external boundary references and their stable IDs without recursive loading", async () => {
    const node = issue(1);
    node.blockedBy = { totalCount: 1, nodes: [reference(8, "example/other")] };
    const graph = projectIssueGraph(await snapshot([node]));
    expect(
      graph.nodes.find((item) => item.nativeId === reference(8, "example/other").id),
    ).toMatchObject({ external: true, repository: "example/other", number: 8 });
    expect(graph.edges[0].target).toBe(issueNodeId(node.id));
  });

  it("retains all cyclic nodes/edges, incomplete flags and finite fallback positions", async () => {
    const first = issue(1, [2]);
    first.blockedBy.totalCount = 101;
    const graph = projectIssueGraph(await snapshot([first, issue(2, [1]), issue(3, [2])]));
    expect(graph.nodes).toHaveLength(3);
    expect(graph.edges).toHaveLength(3);
    expect(graph.nodes.find((node) => node.nativeId === first.id)?.partial).toBe(true);
    expect(
      graph.nodes.every(
        (node) => Number.isFinite(node.position.x) && Number.isFinite(node.position.y),
      ),
    ).toBe(true);
    expect(new Set(graph.nodes.map((node) => `${node.position.x},${node.position.y}`)).size).toBe(
      3,
    );
  });

  it("handles an empty repository and never emits code or hierarchy edge kinds", async () => {
    expect(projectIssueGraph(await snapshot([]))).toMatchObject({ nodes: [], edges: [] });
    expect(
      projectIssueGraph(await snapshot([issue(1, [], [2]), issue(2)])).edges.every(
        (edge) => edge.kind === "blocks",
      ),
    ).toBe(true);
  });

  it("retains 235 synthetic nodes and 1130 distinct blocker links without implying hierarchy", async () => {
    const nodes = Array.from({ length: 235 }, (_, index) => issue(index + 1));
    let count = 0;
    for (let target = 1; target < nodes.length && count < 1130; target++) {
      for (let source = Math.max(0, target - 10); source < target && count < 1130; source++) {
        nodes[target].blockedBy.nodes.push(reference(source + 1));
        nodes[source].blocking.nodes.push(reference(target + 1));
        count++;
      }
    }
    nodes.forEach((node) => {
      node.blockedBy.totalCount = node.blockedBy.nodes.length;
      node.blocking.totalCount = node.blocking.nodes.length;
    });
    const fetcher = vi.fn<typeof fetch>();
    for (let offset = 0; offset < nodes.length; offset += 100) {
      fetcher.mockResolvedValueOnce(
        response(
          page(nodes.slice(offset, offset + 100), {
            total: nodes.length,
            hasNext: offset + 100 < nodes.length,
            cursor: offset + 100 < nodes.length ? String(offset + 100) : null,
          }),
        ),
      );
    }
    const data = await fetchRepositorySnapshot(
      parseRepositoryInput(repositoryName),
      TEST_TOKEN,
      vi.fn(),
      undefined,
      fetcher,
    );
    const graph = projectIssueGraph(data);
    expect(graph.nodes).toHaveLength(235);
    expect(graph.edges).toHaveLength(1130);
    expect(graph.edges.every((edge) => edge.kind === "blocks")).toBe(true);
    expect(graph.partial).toBe(false);
    expect(data.completeness.hierarchy).toBe("not-loaded");
  });
});
