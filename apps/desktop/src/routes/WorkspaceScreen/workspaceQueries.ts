import type { QueryClient } from "@tanstack/react-query";
import type { GraphAbstractionLevel } from "../../lib/adapter";

export const workspaceQueryKeys = {
  backendStatus: () => ["backend-status"] as const,
  editableNodeSource: (
    repoId: string | undefined,
    fetchMode: string | undefined,
    targetId: string | undefined,
  ) => ["editable-node-source", repoId, fetchMode, targetId] as const,
  graphView: (
    repoId: string | undefined,
    graphTargetId: string | undefined,
    activeLevel: GraphAbstractionLevel,
    graphFilters: unknown,
    graphSettings: unknown,
  ) => ["graph-view", repoId, graphTargetId, activeLevel, graphFilters, graphSettings] as const,
  overview: (repoId: string | undefined) => ["overview", repoId] as const,
  symbol: (symbolId: string | undefined) => ["symbol", symbolId] as const,
  flowOwnerSymbol: (graphTargetId: string | undefined) =>
    ["flow-owner-symbol", graphTargetId] as const,
  workspaceFile: (repoId: string | undefined, relativePath: string | undefined) =>
    ["workspace-file", repoId, relativePath] as const,
  workspaceFiles: (repoId: string | undefined) => ["workspace-files", repoId] as const,
  workspaceSearch: (repoId: string | undefined, query: string) =>
    ["workspace-search", repoId, query] as const,
};

export async function invalidateWorkspaceDataQueries(
  queryClient: QueryClient,
  options: { includeEditableSource?: boolean } = {},
) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["overview"] }),
    queryClient.invalidateQueries({ queryKey: ["workspace-files"] }),
    queryClient.invalidateQueries({ queryKey: ["workspace-file"] }),
    queryClient.invalidateQueries({ queryKey: ["graph-view"] }),
    queryClient.invalidateQueries({ queryKey: ["symbol"] }),
    queryClient.invalidateQueries({ queryKey: ["workspace-search"] }),
    options.includeEditableSource
      ? queryClient.invalidateQueries({ queryKey: ["editable-node-source"] })
      : Promise.resolve(),
  ]);
}

export async function invalidateWorkspaceFileOperationQueries(queryClient: QueryClient) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["workspace-files"] }),
    queryClient.invalidateQueries({ queryKey: ["workspace-file"] }),
    queryClient.invalidateQueries({ queryKey: ["overview"] }),
    queryClient.invalidateQueries({ queryKey: ["graph-view"] }),
    queryClient.invalidateQueries({ queryKey: ["workspace-search"] }),
  ]);
}

export async function invalidateWorkspaceFileSaveQueries(queryClient: QueryClient) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["workspace-files"] }),
    queryClient.invalidateQueries({ queryKey: ["overview"] }),
    queryClient.invalidateQueries({ queryKey: ["graph-view"] }),
    queryClient.invalidateQueries({ queryKey: ["workspace-search"] }),
    queryClient.invalidateQueries({ queryKey: ["editable-node-source"] }),
  ]);
}

export async function invalidateWorkspaceSyncQueries(
  queryClient: QueryClient,
  options: { refreshWorkspaceData: boolean },
) {
  const invalidations = [queryClient.invalidateQueries({ queryKey: ["backend-status"] })];
  if (options.refreshWorkspaceData) {
    invalidations.push(
      queryClient.invalidateQueries({ queryKey: ["overview"] }),
      queryClient.invalidateQueries({ queryKey: ["workspace-files"] }),
      queryClient.invalidateQueries({ queryKey: ["workspace-file"] }),
      queryClient.invalidateQueries({ queryKey: ["graph-view"] }),
      queryClient.invalidateQueries({ queryKey: ["symbol"] }),
      queryClient.invalidateQueries({ queryKey: ["workspace-search"] }),
      queryClient.invalidateQueries({ queryKey: ["editable-node-source"] }),
    );
  }
  await Promise.all(invalidations);
}
