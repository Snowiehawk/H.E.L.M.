import { useEffect } from "react";
import type { QueryClient } from "@tanstack/react-query";
import type {
  DesktopAdapter,
  EditableNodeSource,
  GraphAbstractionLevel,
  GraphBreadcrumbDto,
  GraphNodeDto,
  GraphView,
} from "../../lib/adapter";
import { invalidateWorkspaceSyncQueries } from "./workspaceQueries";

export function useWorkspaceSyncEffects({
  activeNodeId,
  activeWorkspaceFilePath,
  adapter,
  breadcrumbs,
  focusGraph,
  graphTargetId,
  inspectorDirty,
  inspectorSourcePath,
  inspectorTargetId,
  queryClient,
  repoSessionPath,
  selectNode,
  setInspectorDraftStale,
  setInspectorEditableSourceOverride,
  setInspectorSnapshot,
  setInspectorTargetId,
  setWorkspaceFileStale,
  workspaceFileDirty,
}: {
  activeNodeId?: string;
  activeWorkspaceFilePath?: string;
  adapter: DesktopAdapter;
  breadcrumbs?: GraphView["breadcrumbs"];
  focusGraph: (nodeId: string, level: GraphAbstractionLevel) => void;
  graphTargetId?: string;
  inspectorDirty: boolean;
  inspectorSourcePath?: string;
  inspectorTargetId?: string;
  queryClient: QueryClient;
  repoSessionPath?: string;
  selectNode: (nodeId?: string) => void;
  setInspectorDraftStale: (stale: boolean) => void;
  setInspectorEditableSourceOverride: (source?: EditableNodeSource) => void;
  setInspectorSnapshot: (node?: GraphNodeDto) => void;
  setInspectorTargetId: (targetId?: string) => void;
  setWorkspaceFileStale: (stale: boolean) => void;
  workspaceFileDirty: boolean;
}) {
  useEffect(
    () =>
      adapter.subscribeWorkspaceSync((event) => {
        if (!repoSessionPath || event.repoPath !== repoSessionPath) {
          return;
        }

        const matchingSnapshot = event.snapshot;
        const liveNodeIds = new Set(matchingSnapshot?.nodeIds ?? []);
        const sameFileChanged = Boolean(
          inspectorDirty &&
          inspectorSourcePath &&
          event.changedRelativePaths.includes(inspectorSourcePath),
        );
        if (sameFileChanged) {
          setInspectorDraftStale(true);
        }
        const activeWorkspaceFileChanged = Boolean(
          activeWorkspaceFilePath && event.changedRelativePaths.includes(activeWorkspaceFilePath),
        );
        if (activeWorkspaceFileChanged && workspaceFileDirty) {
          setWorkspaceFileStale(true);
        }

        if (event.status === "synced" && matchingSnapshot) {
          if (activeNodeId && !liveNodeIds.has(activeNodeId)) {
            selectNode(undefined);
          }

          if (graphTargetId && !liveNodeIds.has(graphTargetId)) {
            const fallbackBreadcrumb = [...(breadcrumbs ?? [])]
              .reverse()
              .find(
                (breadcrumb: GraphBreadcrumbDto) =>
                  breadcrumb.nodeId !== graphTargetId && liveNodeIds.has(breadcrumb.nodeId),
              );
            if (fallbackBreadcrumb) {
              focusGraph(fallbackBreadcrumb.nodeId, fallbackBreadcrumb.level);
            } else if (liveNodeIds.has(matchingSnapshot.defaultFocusNodeId)) {
              focusGraph(matchingSnapshot.defaultFocusNodeId, matchingSnapshot.defaultLevel);
            } else {
              focusGraph(matchingSnapshot.repoId, "repo");
            }
          }

          if (inspectorTargetId && !liveNodeIds.has(inspectorTargetId) && !sameFileChanged) {
            setInspectorTargetId(undefined);
            setInspectorSnapshot(undefined);
            setInspectorEditableSourceOverride(undefined);
          }
        }

        const shouldRefreshWorkspaceData =
          event.status !== "syncing" || Boolean(event.snapshot) || event.needsManualResync;
        void invalidateWorkspaceSyncQueries(queryClient, {
          refreshWorkspaceData: shouldRefreshWorkspaceData,
        });
      }),
    [
      activeNodeId,
      activeWorkspaceFilePath,
      adapter,
      breadcrumbs,
      focusGraph,
      graphTargetId,
      inspectorDirty,
      inspectorSourcePath,
      inspectorTargetId,
      queryClient,
      repoSessionPath,
      selectNode,
      setInspectorDraftStale,
      setInspectorEditableSourceOverride,
      setInspectorSnapshot,
      setInspectorTargetId,
      setWorkspaceFileStale,
      workspaceFileDirty,
    ],
  );
}
