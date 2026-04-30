import type { BackendStatus, OverviewData } from "../../../lib/adapter";
import { StatusPill } from "../../shared/StatusPill";
import { helpTargetProps } from "../../workspace/workspaceHelp";

export function ExplorerHeader({
  backendStatus,
  overview,
  onFocusRepoGraph,
  onOpenRepo,
  onReindexRepo,
}: {
  backendStatus?: BackendStatus;
  overview?: OverviewData;
  onFocusRepoGraph: () => void;
  onOpenRepo: (path?: string) => void;
  onReindexRepo: () => void;
}) {
  return (
    <>
      <div className="explorer-header">
        <div>
          <span className="window-bar__eyebrow">Explorer</span>
          <h2>{overview?.repo.name ?? "Repository"}</h2>
          <p>{overview?.repo.path ?? "Open a repo to build the graph."}</p>
        </div>
        <StatusPill tone={backendStatus?.mode === "mock" ? "accent" : "default"}>
          {backendStatus?.mode === "mock" ? "Mock" : "Live"}
        </StatusPill>
      </div>

      <div className="explorer-actions">
        <button
          {...helpTargetProps("explorer.open-repo")}
          className="primary-button"
          type="button"
          onClick={() => onOpenRepo()}
        >
          Open Repo
        </button>
        <button
          {...helpTargetProps("explorer.reindex")}
          className="ghost-button"
          type="button"
          onClick={onReindexRepo}
        >
          Reindex
        </button>
        <button
          {...helpTargetProps("explorer.repo-graph")}
          className="ghost-button"
          type="button"
          onClick={onFocusRepoGraph}
        >
          Repo Graph
        </button>
      </div>
    </>
  );
}
