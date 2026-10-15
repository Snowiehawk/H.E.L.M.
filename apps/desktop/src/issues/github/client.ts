// Adapted from Issue Atlas (MIT), copyright (c) 2026 Chris Cheney.
// See third_party/issue-atlas.LICENSE and docs/github-issues.md.
import type { ZodType } from "zod";
import type { RepositoryLoadUpdate, RepositoryRef, RepositorySnapshot } from "../types";
import { type DependencyRef, type IssueRecord, issueKey } from "../types";
import { type RepositoryPageResponse, repositoryPageSchema } from "./schemas";

const GRAPHQL_ENDPOINT = "https://api.github.com/graphql";
export const DEPENDENCY_CONNECTION_LIMIT = 100;

const REPOSITORY_PAGE_QUERY = `
  query RepositoryIssueDependencies($owner: String!, $name: String!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      id
      nameWithOwner
      url
      description
      isPrivate
      issues(first: 100, after: $cursor, orderBy: {field: CREATED_AT, direction: ASC}) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          id number title url state stateReason createdAt updatedAt closedAt
          author { login avatarUrl url }
          assignees(first: 20) { nodes { login avatarUrl url } }
          labels(first: 50) { nodes { name color description } }
          milestone { title url }
          blockedBy(first: 100) {
            totalCount
            nodes { id number state title url repository { nameWithOwner } }
          }
          blocking(first: 100) {
            totalCount
            nodes { id number state title url repository { nameWithOwner } }
          }
        }
      }
    }
    rateLimit { cost remaining resetAt }
  }
`;

interface GraphQlEnvelope {
  data?: unknown;
  errors?: unknown[];
}

export class GitHubGraphQlError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GitHubGraphQlError";
  }
}

const request = async <T>(
  token: string,
  query: string,
  variables: Readonly<Record<string, unknown>>,
  schema: ZodType<T>,
  signal?: AbortSignal,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<T> => {
  throwIfAborted(signal);
  let response: Response;
  try {
    response = await fetcher(GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2026-03-10",
      },
      body: JSON.stringify({ query, variables }),
      cache: "no-store",
      ...(signal === undefined ? {} : { signal }),
      redirect: "error",
      credentials: "omit",
    });
  } catch {
    throwIfAborted(signal);
    throw new GitHubGraphQlError(
      "Unable to reach GitHub. Check your connection and desktop network policy.",
    );
  }
  throwIfAborted(signal);

  let envelope: GraphQlEnvelope;
  try {
    envelope = (await response.json()) as GraphQlEnvelope;
  } catch {
    throwIfAborted(signal);
    throw new GitHubGraphQlError(
      response.ok
        ? "GitHub returned an unexpected GraphQL response."
        : `GitHub returned HTTP ${response.status}.`,
    );
  }
  throwIfAborted(signal);
  if (!response.ok) {
    throw new GitHubGraphQlError(`GitHub returned HTTP ${response.status}.`);
  }
  if (
    !envelope ||
    typeof envelope !== "object" ||
    envelope.data === undefined ||
    (envelope.errors !== undefined &&
      (!Array.isArray(envelope.errors) || envelope.errors.length > 0))
  ) {
    throw new GitHubGraphQlError("GitHub rejected the GraphQL request.");
  }

  const result = schema.safeParse(envelope.data);
  if (!result.success) {
    throw new GitHubGraphQlError("GitHub returned an unexpected issue dependency response.");
  }
  return result.data;
};

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new DOMException("Issue loading was cancelled.", "AbortError");
};

const dependencyRef = (dependency: {
  id: string;
  number: number;
  repository: { nameWithOwner: string };
  state: "OPEN" | "CLOSED";
  title: string;
  url: string;
}): DependencyRef => ({
  ...dependency,
  repository: dependency.repository.nameWithOwner,
  key: issueKey(dependency.repository.nameWithOwner, dependency.number),
});

const issueRecord = (
  repository: string,
  issue: NonNullable<RepositoryPageResponse["repository"]>["issues"]["nodes"][number],
): IssueRecord => ({
  ...issue,
  key: issueKey(repository, issue.number),
  repository,
  body: null,
  assignees: issue.assignees.nodes,
  labels: issue.labels.nodes,
  blockedBy: issue.blockedBy.nodes.map(dependencyRef),
  blocking: issue.blocking.nodes.map(dependencyRef),
  dependencyDataTruncated:
    issue.blockedBy.totalCount > issue.blockedBy.nodes.length ||
    issue.blocking.totalCount > issue.blocking.nodes.length,
  isExternal: false,
});

export const fetchRepositorySnapshot = async (
  repository: RepositoryRef,
  token: string,
  onUpdate: (update: RepositoryLoadUpdate) => void,
  signal?: AbortSignal,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<RepositorySnapshot> => {
  const issues = new Map<string, IssueRecord>();
  const seenCursors = new Set<string>();
  let firstTotal: number | undefined;
  let totalChanged = false;
  let cursor: string | null = null;
  let hasNextPage = true;
  let snapshot: RepositorySnapshot | null = null;

  while (hasNextPage) {
    const page: RepositoryPageResponse = await request(
      token,
      REPOSITORY_PAGE_QUERY,
      { owner: repository.owner, name: repository.name, cursor },
      repositoryPageSchema,
      signal,
      fetcher,
    );
    if (page.repository === null) {
      throw new GitHubGraphQlError("Repository not found or the token cannot access it.");
    }

    const { issues: connection, ...repositoryData } = page.repository;
    if (snapshot && snapshot.repository.nameWithOwner !== repositoryData.nameWithOwner) {
      throw new GitHubGraphQlError(
        "GitHub changed repository identity during loading. Please reload.",
      );
    }
    firstTotal ??= connection.totalCount;
    totalChanged ||= firstTotal !== connection.totalCount;
    for (const issue of connection.nodes) {
      const record = issueRecord(repositoryData.nameWithOwner, issue);
      issues.set(record.key, record);
    }
    const nextCursor = connection.pageInfo.endCursor;
    hasNextPage = connection.pageInfo.hasNextPage;
    if (hasNextPage && (nextCursor === null || seenCursors.has(nextCursor))) {
      throw new GitHubGraphQlError("GitHub returned invalid pagination metadata.");
    }
    if (nextCursor !== null) seenCursors.add(nextCursor);
    cursor = nextCursor;
    const records = [...issues.values()];
    snapshot = {
      repository: {
        id: repositoryData.id,
        owner: repository.owner,
        name: repository.name,
        nameWithOwner: repositoryData.nameWithOwner,
        url: repositoryData.url,
      },
      description: repositoryData.description,
      isPrivate: repositoryData.isPrivate,
      issues: records,
      fetchedAt: new Date().toISOString(),
      rateLimit: page.rateLimit,
      expectedIssueCount: connection.totalCount,
      completeness: {
        issues:
          !hasNextPage && !totalChanged && records.length === connection.totalCount
            ? "complete"
            : "partial",
        dependencies:
          hasNextPage ||
          totalChanged ||
          records.length !== connection.totalCount ||
          records.some((issue) => issue.dependencyDataTruncated)
            ? "partial"
            : "complete",
        dependencyConnectionLimit: DEPENDENCY_CONNECTION_LIMIT,
        hierarchy: "not-loaded",
      },
    };
    onUpdate({
      progress: { loaded: issues.size, total: connection.totalCount },
    });
  }

  if (snapshot === null) {
    throw new GitHubGraphQlError("GitHub returned no repository data.");
  }
  throwIfAborted(signal);
  return snapshot;
};
