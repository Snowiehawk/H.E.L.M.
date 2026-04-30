import type { RecentRepo, RepoSession, WorkspaceRecoveryEvent } from "../contracts";
import type { RawRecoveryEvent } from "./rawTypes";

export type InvokeCommand = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export const RECENT_REPOS_STORAGE_KEY = "helm.desktop.recentRepos";
export const DEFAULT_PYTHON_COMMAND = "python3";

export function buildRepoSessionFromPath(path: string): RepoSession {
  const normalizedPath = normalizePath(path);
  const segments = normalizedPath.split("/").filter(Boolean);
  const name = segments[segments.length - 1] ?? "repo";
  return {
    id: `repo:${normalizedPath}`,
    name,
    path: normalizedPath,
    branch: "local",
    primaryLanguage: "Python",
    openedAt: new Date().toISOString(),
  };
}

export function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

export function toRecoveryEvents(raw?: RawRecoveryEvent[] | null): WorkspaceRecoveryEvent[] {
  return (raw ?? []).map((event) => ({
    operationId: event.operation_id,
    kind: event.kind,
    outcome: event.outcome,
    touchedRelativePaths: event.touched_relative_paths ?? [],
    warnings: event.warnings ?? [],
  }));
}

export function loadRecentRepos(): RecentRepo[] {
  try {
    const raw = window.localStorage.getItem(RECENT_REPOS_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function rememberRecentRepo(session: RepoSession) {
  const current = loadRecentRepos();
  const next: RecentRepo[] = [
    {
      name: session.name,
      path: session.path,
      branch: session.branch,
      lastOpenedAt: new Date().toISOString(),
    },
    ...current.filter((repo) => repo.path !== session.path),
  ].slice(0, 8);
  window.localStorage.setItem(RECENT_REPOS_STORAGE_KEY, JSON.stringify(next));
}

export function languageFromPath(path: string): string {
  if (path.endsWith(".py")) {
    return "python";
  }
  if (path.endsWith(".ts") || path.endsWith(".tsx")) {
    return "typescript";
  }
  return "text";
}

export function capitalize(value: string): string {
  if (!value) {
    return value;
  }
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function toMessage(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.message;
  }
  if (typeof reason === "string") {
    return reason;
  }
  return "Unknown desktop bridge failure.";
}
