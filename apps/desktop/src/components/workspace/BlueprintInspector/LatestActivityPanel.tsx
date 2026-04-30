import type { WorkspaceActivity } from "../../../store/uiStore";
import { StatusPill } from "../../shared/StatusPill";

export function LatestActivityPanel({ lastActivity }: { lastActivity?: WorkspaceActivity }) {
  if (!lastActivity) {
    return null;
  }

  const flowDraftActivity = lastActivity.flowSyncState === "draft";

  return (
    <section className="sidebar-section blueprint-inspector__section blueprint-inspector__section--last-edit">
      <div className="section-header">
        <h3>Latest Activity</h3>
        <span>{lastActivity.domain}</span>
      </div>
      <div className="info-card">
        {flowDraftActivity ? (
          <div className="blueprint-inspector__activity-status">
            <StatusPill tone="warning">Draft only</StatusPill>
            <span>Not applied to code</span>
          </div>
        ) : null}
        <strong>{lastActivity.summary}</strong>
        {lastActivity.touchedRelativePaths?.length || lastActivity.warnings?.length ? (
          <p>
            {lastActivity.touchedRelativePaths?.length
              ? `Touched: ${lastActivity.touchedRelativePaths.join(", ")}.`
              : ""}
            {lastActivity.warnings?.length
              ? `${lastActivity.touchedRelativePaths?.length ? " " : ""}Warnings: ${lastActivity.warnings.join(" ")}`
              : ""}
          </p>
        ) : null}
        {lastActivity.diagnostics?.length ? (
          <ul className="blueprint-inspector__diagnostics">
            {lastActivity.diagnostics.map((diagnostic) => (
              <li key={diagnostic}>{diagnostic}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
