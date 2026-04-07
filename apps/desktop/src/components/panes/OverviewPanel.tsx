import type { BackendStatus, OverviewData, OverviewModule } from "../../lib/adapter";
import { MetricTile } from "../shared/MetricTile";
import { StatusPill } from "../shared/StatusPill";

export function OverviewPanel({
  backendStatus,
  overview,
  onOpenModule,
  onOpenSavedView,
  onReindex,
}: {
  backendStatus?: BackendStatus;
  overview?: OverviewData;
  onOpenModule: (module: OverviewModule) => void;
  onOpenSavedView: (nodeId: string) => void;
  onReindex: () => void;
}) {
  if (!overview) {
    return (
      <section className="content-panel">
        <div className="empty-state">
          <h3>Loading overview</h3>
          <p>Pulling the repo summary, top modules, and saved graph entry points.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="content-panel content-panel--overview">
      <div className="hero-card">
        <div>
          <span className="window-bar__eyebrow">Default landing view</span>
          <h2>{overview.repo.name}</h2>
          <p>
            Start broad, then drill into files, symbols, and a bounded graph neighborhood without
            losing context.
          </p>
        </div>
        <div className="metric-grid">
          {overview.metrics.map((metric) => (
            <MetricTile
              key={metric.label}
              label={metric.label}
              value={metric.value}
              accent={metric.tone === "accent"}
            />
          ))}
        </div>
      </div>

      <div className="overview-grid">
        <article className="card">
          <div className="section-header">
            <h3>Top Modules</h3>
            <span>Prioritize where to inspect next</span>
          </div>
          <div className="table-list">
            {overview.modules.map((module) => (
              <button
                key={module.id}
                className="table-row"
                type="button"
                onClick={() => onOpenModule(module)}
              >
                <span>{module.moduleName}</span>
                <span>{module.relativePath}</span>
                <span>{module.symbolCount} symbols</span>
                <span>{module.callCount} calls</span>
              </button>
            ))}
          </div>
        </article>

        <article className="card">
          <div className="section-header">
            <h3>Backend</h3>
            <StatusPill tone={backendStatus?.mode === "mock" ? "accent" : "default"}>
              {backendStatus?.mode === "mock" ? "Mock" : "Live"}
            </StatusPill>
          </div>
          <div className="metadata-grid">
            <div className="metadata-item">
              <span>Python</span>
              <strong>{backendStatus?.pythonCommand ?? "mock"}</strong>
            </div>
            <div className="metadata-item">
              <span>Last scan</span>
              <strong>
                {backendStatus?.lastScanDurationMs
                  ? `${backendStatus.lastScanDurationMs} ms`
                  : "Not run yet"}
              </strong>
            </div>
          </div>
          <p>{backendStatus?.note ?? "Waiting on backend status."}</p>
          {backendStatus?.lastError ? <p className="error-copy">{backendStatus.lastError}</p> : null}
          <button className="ghost-button" type="button" onClick={onReindex}>
            Reindex From UI
          </button>
        </article>
      </div>

      <div className="overview-grid">
        <article className="card">
          <div className="section-header">
            <h3>Hotspots</h3>
            <span>Architectural read-through cues</span>
          </div>
          <div className="stack-list">
            {overview.hotspots.map((hotspot) => (
              <div key={hotspot.title} className="info-card">
                <strong>{hotspot.title}</strong>
                <p>{hotspot.description}</p>
              </div>
            ))}
          </div>
        </article>

        <article className="card">
          <div className="section-header">
            <h3>Saved Graph Starts</h3>
            <span>Curated ways into the dependency map</span>
          </div>
          <div className="chip-list">
            {overview.savedViews.map((view) => (
              <button
                key={view.id}
                className="chip-button"
                type="button"
                onClick={() => onOpenSavedView(view.nodeId)}
              >
                <strong>{view.label}</strong>
                <span>{view.description}</span>
              </button>
            ))}
          </div>
        </article>

      </div>

      <div className="overview-grid">
        <article className="card">
          <div className="section-header">
            <h3>Diagnostics</h3>
            <span>Known state of the current shell</span>
          </div>
          <ul className="bullet-list">
            {overview.diagnostics.map((diagnostic) => (
              <li key={diagnostic}>{diagnostic}</li>
            ))}
          </ul>
        </article>
      </div>
    </section>
  );
}
