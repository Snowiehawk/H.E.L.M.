// Adapted from Issue Atlas (MIT), copyright (c) 2026 Chris Cheney.
// See third_party/issue-atlas.LICENSE and docs/github-issues.md.
export type IssueState = "OPEN" | "CLOSED";

export interface RepositoryRef {
  owner: string;
  name: string;
  nameWithOwner: string;
  url: string;
}

export interface IssueLabel {
  name: string;
  color: string;
  description: string | null;
}

export interface IssueActor {
  login: string;
  avatarUrl: string;
  url: string;
}

export interface DependencyRef {
  id: string;
  key: string;
  number: number;
  repository: string;
  state: IssueState;
  title: string;
  url: string;
}

export interface IssueRecord {
  key: string;
  id: string;
  number: number;
  repository: string;
  title: string;
  url: string;
  state: IssueState;
  stateReason: string | null;
  body: string | null;
  author: IssueActor | null;
  assignees: IssueActor[];
  labels: IssueLabel[];
  milestone: { title: string; url: string } | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  blockedBy: DependencyRef[];
  blocking: DependencyRef[];
  dependencyDataTruncated: boolean;
  isExternal: boolean;
}

export interface RateLimit {
  cost: number;
  remaining: number;
  resetAt: string;
}

export interface RepositorySnapshot {
  repository: RepositoryRef & { id: string };
  description: string | null;
  isPrivate: boolean;
  issues: IssueRecord[];
  fetchedAt: string;
  rateLimit: RateLimit | null;
  expectedIssueCount: number;
  completeness: {
    issues: "complete" | "partial";
    dependencies: "complete" | "partial";
    dependencyConnectionLimit: 100;
    hierarchy: "not-loaded";
  };
}

export interface IssueDependencyEdge {
  id: string;
  source: string;
  target: string;
}

export interface LoadProgress {
  loaded: number;
  total: number;
}

export interface RepositoryLoadUpdate {
  progress: LoadProgress;
}

export const issueKey = (repository: string, number: number): string =>
  `${repository.toLowerCase()}#${number}`;
