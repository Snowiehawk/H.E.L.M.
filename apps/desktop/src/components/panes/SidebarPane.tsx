import type {
  BackendStatus,
  OverviewData,
  OverviewModule,
  SearchResult,
} from "../../lib/adapter";
import { StatusPill } from "../shared/StatusPill";

interface ExplorerRow {
  key: string;
  label: string;
  path: string;
  depth: number;
  kind: "directory" | "file";
  module?: OverviewModule;
}

function buildExplorerRows(modules: OverviewModule[]): ExplorerRow[] {
  const rows: ExplorerRow[] = [];
  const seenDirectories = new Set<string>();

  [...modules]
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    .forEach((module) => {
      const parts = module.relativePath.split("/");

      parts.slice(0, -1).forEach((part, index) => {
        const path = parts.slice(0, index + 1).join("/");
        if (seenDirectories.has(path)) {
          return;
        }

        seenDirectories.add(path);
        rows.push({
          key: `dir:${path}`,
          label: part,
          path,
          depth: index,
          kind: "directory",
        });
      });

      rows.push({
        key: module.id,
        label: parts[parts.length - 1] ?? module.relativePath,
        path: module.relativePath,
        depth: Math.max(parts.length - 1, 0),
        kind: "file",
        module,
      });
    });

  return rows;
}

export function SidebarPane({
  backendStatus,
  overview,
  sidebarQuery,
  searchResults,
  isSearching,
  selectedFilePath,
  selectedNodeId,
  onSidebarQueryChange,
  onSelectResult,
  onSelectModule,
  onFocusRepoGraph,
  onReindexRepo,
  onOpenRepo,
}: {
  backendStatus?: BackendStatus;
  overview?: OverviewData;
  sidebarQuery: string;
  searchResults: SearchResult[];
  isSearching: boolean;
  selectedFilePath?: string;
  selectedNodeId?: string;
  onSidebarQueryChange: (query: string) => void;
  onSelectResult: (result: SearchResult) => void;
  onSelectModule: (module: OverviewModule) => void;
  onFocusRepoGraph: () => void;
  onReindexRepo: () => void;
  onOpenRepo: (path?: string) => void;
}) {
  const explorerRows = buildExplorerRows(overview?.modules ?? []);

  return (
    <aside className="pane pane--sidebar explorer-shell">
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
        <button className="primary-button" type="button" onClick={() => onOpenRepo()}>
          Open Repo
        </button>
        <button className="ghost-button" type="button" onClick={onReindexRepo}>
          Reindex
        </button>
        <button className="ghost-button" type="button" onClick={onFocusRepoGraph}>
          Repo Graph
        </button>
      </div>

      <div className="sidebar-section">
        <div className="section-header">
          <h3>Search</h3>
          <span>Cmd/Ctrl + K</span>
        </div>
        <input
          className="sidebar-search"
          value={sidebarQuery}
          onChange={(event) => onSidebarQueryChange(event.target.value)}
          placeholder="Jump to file or symbol"
        />
      </div>

      {sidebarQuery.trim() ? (
        <div className="sidebar-section explorer-results">
          {isSearching ? <p className="muted-copy">Searching current repo...</p> : null}
          {!isSearching && !searchResults.length ? (
            <p className="muted-copy">No files or symbols matched that query.</p>
          ) : null}
          {searchResults.map((result) => (
            <button
              key={result.id}
              className="list-button"
              type="button"
              onClick={() => onSelectResult(result)}
            >
              <span className="list-button__title">{result.title}</span>
              <span className="list-button__subtitle">{result.subtitle}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="sidebar-section explorer-tree">
          <div className="section-header">
            <h3>Files</h3>
            <span>{overview?.modules.length ?? 0}</span>
          </div>

          {explorerRows.length ? (
            explorerRows.map((row) =>
              row.kind === "directory" ? (
                <div
                  key={row.key}
                  className="explorer-row explorer-row--directory"
                  style={{ paddingLeft: `${16 + row.depth * 16}px` }}
                >
                  <span>{row.label}</span>
                </div>
              ) : (
                <button
                  key={row.key}
                  className={`explorer-row explorer-row--file${
                    selectedFilePath === row.path || selectedNodeId === row.module?.moduleId
                      ? " is-active"
                      : ""
                  }`}
                  type="button"
                  style={{ paddingLeft: `${16 + row.depth * 16}px` }}
                  onClick={() => row.module && onSelectModule(row.module)}
                >
                  <span>{row.label}</span>
                </button>
              ),
            )
          ) : (
            <p className="muted-copy">
              Files will appear here as soon as indexing finishes.
            </p>
          )}
        </div>
      )}

      {backendStatus?.note ? <p className="launch-note">{backendStatus.note}</p> : null}
    </aside>
  );
}
