import type { BackendStatus, OverviewData, OverviewModule, SearchResult } from "../../lib/adapter";
import { StatusPill } from "../shared/StatusPill";

export function BlueprintSidebar({
  backendStatus,
  overview,
  sidebarQuery,
  searchResults,
  isSearching,
  selectedNodeId,
  onSidebarQueryChange,
  onSelectResult,
  onSelectModule,
  onOpenSavedView,
  onFocusRepoGraph,
  onReindexRepo,
  onOpenRepo,
}: {
  backendStatus?: BackendStatus;
  overview?: OverviewData;
  sidebarQuery: string;
  searchResults: SearchResult[];
  isSearching: boolean;
  selectedNodeId?: string;
  onSidebarQueryChange: (query: string) => void;
  onSelectResult: (result: SearchResult) => void;
  onSelectModule: (module: OverviewModule) => void;
  onOpenSavedView: (nodeId: string, level: "module" | "symbol" | "flow" | "repo") => void;
  onFocusRepoGraph: () => void;
  onReindexRepo: () => void;
  onOpenRepo: (path?: string) => void;
}) {
  return (
    <aside className="pane pane--sidebar blueprint-sidebar">
      <div className="explorer-header">
        <div>
          <span className="window-bar__eyebrow">Architecture Navigator</span>
          <h2>{overview?.repo.name ?? "Repository"}</h2>
          <p>{overview?.repo.path ?? "Open a repo to build the blueprint workspace."}</p>
        </div>
        <StatusPill tone={backendStatus?.mode === "mock" ? "accent" : "default"}>
          {backendStatus?.mode === "mock" ? "Mock" : "Live"}
        </StatusPill>
      </div>

      <div className="explorer-actions blueprint-sidebar__actions">
        <button className="primary-button" type="button" onClick={() => onOpenRepo()}>
          Open Repo
        </button>
        <button className="ghost-button" type="button" onClick={onReindexRepo}>
          Reindex
        </button>
        <button className="ghost-button" type="button" onClick={onFocusRepoGraph}>
          Architecture Map
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
          placeholder="Search modules, symbols, or source utilities"
        />
      </div>

      {sidebarQuery.trim() ? (
        <div className="sidebar-section explorer-results">
          {isSearching ? <p className="muted-copy">Searching current repo...</p> : null}
          {!isSearching && !searchResults.length ? (
            <p className="muted-copy">No modules or symbols matched that query.</p>
          ) : null}
          {searchResults.map((result) => (
            <button
              key={result.id}
              className="list-button"
              type="button"
              onClick={() => onSelectResult(result)}
            >
              <span className="list-button__title">{result.title}</span>
              <span className="list-button__subtitle">
                {result.kind} · {result.subtitle}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <>
          <div className="sidebar-section blueprint-sidebar__section">
            <div className="section-header">
              <h3>Entry Points</h3>
              <span>{overview?.savedViews.length ?? 0}</span>
            </div>
            <div className="stack-list">
              {(overview?.savedViews ?? []).map((view) => (
                <button
                  key={view.id}
                  className="list-button"
                  type="button"
                  onClick={() => onOpenSavedView(view.nodeId, view.level)}
                >
                  <span className="list-button__title">{view.label}</span>
                  <span className="list-button__subtitle">{view.description}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="sidebar-section blueprint-sidebar__section">
            <div className="section-header">
              <h3>Modules</h3>
              <span>{overview?.modules.length ?? 0}</span>
            </div>
            <div className="stack-list">
              {(overview?.modules ?? []).map((module) => (
                <button
                  key={module.id}
                  className={`list-button${selectedNodeId === module.moduleId ? " is-active" : ""}`}
                  type="button"
                  onClick={() => onSelectModule(module)}
                >
                  <span className="list-button__title">{module.moduleName}</span>
                  <span className="list-button__subtitle">
                    {module.relativePath} · {module.symbolCount} symbols · {module.callCount} calls
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="sidebar-section blueprint-sidebar__section">
            <div className="section-header">
              <h3>Hotspots</h3>
              <span>{overview?.hotspots.length ?? 0}</span>
            </div>
            <div className="stack-list">
              {(overview?.hotspots ?? []).map((hotspot) => (
                <div key={hotspot.title} className="info-card">
                  <strong>{hotspot.title}</strong>
                  <p>{hotspot.description}</p>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {backendStatus?.note ? <p className="launch-note">{backendStatus.note}</p> : null}
    </aside>
  );
}
