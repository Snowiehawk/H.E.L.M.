import { useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { DesktopWindow } from "../components/layout/DesktopWindow";
import { ThemeCycleButton } from "../components/shared/ThemeCycleButton";
import { StatusPill } from "../components/shared/StatusPill";
import { useIndexingProgress } from "../lib/adapter/useIndexingProgress";
import { useUiStore } from "../store/uiStore";

export function IndexingScreen() {
  const { jobId } = useParams();
  const navigate = useNavigate();
  const session = useUiStore((state) => state.repoSession);
  const progress = useIndexingProgress(jobId);

  useEffect(() => {
    if (progress?.status !== "done") {
      return;
    }

    const timer = window.setTimeout(() => {
      navigate("/workspace");
    }, 700);

    return () => window.clearTimeout(timer);
  }, [navigate, progress?.status]);

  const totalModules = progress?.totalModules ?? 100;
  const processedModules = progress?.processedModules ?? 0;
  const percentage =
    progress?.progressPercent ??
    (totalModules > 0 ? Math.round((processedModules / totalModules) * 100) : 0);

  return (
    <DesktopWindow
      eyebrow="Indexing"
      title="Preparing the workspace."
      subtitle="This is where the desktop shell stays honest about what it knows, what it is still scanning, and when the repo is ready to browse."
      actions={<ThemeCycleButton />}
      compact
    >
      <main className="indexing-layout">
        <section className="hero-card">
          <div>
            <span className="window-bar__eyebrow">Repo</span>
            <h2>{session?.name ?? "Selected repository"}</h2>
            <p>{session?.path ?? "Waiting for repo context."}</p>
          </div>
          <StatusPill
            tone={
              progress?.status === "done"
                ? "accent"
                : progress?.status === "error"
                  ? "warning"
                  : "default"
            }
          >
            {progress?.status ?? "queued"}
          </StatusPill>
        </section>

        <section className="card">
          <div className="progress-copy">
            <h3>{progress?.message ?? "Scheduling index job"}</h3>
            <span>{percentage}% complete</span>
          </div>
          <div className="progress-bar" aria-hidden="true">
            <div className="progress-bar__fill" style={{ width: `${percentage}%` }} />
          </div>
          <div className="metadata-grid">
            <div className="metadata-item">
              <span>Modules</span>
              <strong>
                {totalModules > 0 ? `${processedModules}/${totalModules}` : "pending"}
              </strong>
            </div>
            <div className="metadata-item">
              <span>Symbols</span>
              <strong>{progress?.symbolCount ?? 0}</strong>
            </div>
            <div className="metadata-item">
              <span>Job ID</span>
              <strong>{jobId ?? "pending"}</strong>
            </div>
          </div>
          {progress?.error ? <p className="error-copy">{progress.error}</p> : null}
          {progress?.status === "error" ? (
            <button className="ghost-button" type="button" onClick={() => navigate("/")}>
              Back to Welcome
            </button>
          ) : null}
        </section>

        <section className="overview-grid">
          <article className="card">
            <div className="section-header">
              <h3>Stages</h3>
              <span>Read-only pipeline</span>
            </div>
            <ul className="bullet-list">
              <li>Queue repo scan and normalize the selected path.</li>
              <li>Parse modules, collect symbols, and surface progress counts.</li>
              <li>Resolve graph relationships, then hand off to the workspace.</li>
            </ul>
          </article>
          <article className="card">
            <div className="section-header">
              <h3>What’s next</h3>
              <span>After indexing</span>
            </div>
            <ul className="bullet-list">
              <li>Open straight into the repo graph with the file explorer pinned on the left.</li>
              <li>Select a file or symbol to tighten the graph around that neighborhood.</li>
              <li>Use the command palette for quick jumps once the workspace opens.</li>
            </ul>
          </article>
        </section>
      </main>
    </DesktopWindow>
  );
}
