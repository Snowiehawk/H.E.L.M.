// Synthetic contract fixtures, adapted from Issue Atlas (MIT), copyright (c) 2026 Chris Cheney.
// See third_party/issue-atlas.LICENSE. No real repository content or credentials.
export const TEST_TOKEN = "synthetic-test-token";
export const repositoryName = "example/A.B.";

export const reference = (number: number, repository = repositoryName) => ({
  id: `synthetic-${repository}-${number}`,
  number,
  state: "OPEN" as const,
  title: `Synthetic issue ${number}`,
  url: `https://github.com/${repository}/issues/${number}`,
  repository: { nameWithOwner: repository },
});

export const issue = (number: number, blockers: number[] = [], blocking: number[] = []) => ({
  ...reference(number),
  stateReason: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  closedAt: null,
  author: null,
  assignees: { nodes: [] },
  labels: { nodes: [] },
  milestone: null,
  blockedBy: { totalCount: blockers.length, nodes: blockers.map((number) => reference(number)) },
  blocking: { totalCount: blocking.length, nodes: blocking.map((number) => reference(number)) },
});

export function page(
  nodes = [issue(1)],
  options: { total?: number; cursor?: string | null; hasNext?: boolean; name?: string } = {},
) {
  const name = options.name ?? repositoryName;
  return {
    data: {
      repository: {
        id: `synthetic-repository-${name}`,
        nameWithOwner: name,
        url: `https://github.com/${name}`,
        description: "Synthetic repository",
        isPrivate: true,
        issues: {
          totalCount: options.total ?? nodes.length,
          pageInfo: { hasNextPage: options.hasNext ?? false, endCursor: options.cursor ?? null },
          nodes,
        },
      },
      rateLimit: { cost: 1, remaining: 4999, resetAt: "2026-01-01T01:00:00Z" },
    },
  };
}

export const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
