import { useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { DesktopWindow } from "../components/layout/DesktopWindow";
import { ThemeCycleButton } from "../components/shared/ThemeCycleButton";
import { StatusPill } from "../components/shared/StatusPill";
import { useIndexingProgress } from "../lib/adapter/useIndexingProgress";
import { useUiStore } from "../store/uiStore";

const INDEX_STAGES = [
  {
    id: "discover",
    label: "Discover",
    description: "Find Python modules in the selected repo.",
  },
  {
    id: "parse",
    label: "Parse",
    description: "Parse modules and collect symbol counts.",
  },
  {
    id: "graph_build",
    label: "Graph Build",
    description: "Build the structural graph from parsed modules.",
  },
  {
    id: "cache_finalize",
    label: "Finalize",
    description: "Prepare the workspace payload for the desktop shell.",
  },
  {
    id: "watch_ready",
    label: "Watch Ready",
    description: "Finish setup and hand off to the workspace.",
  },
] as const;

function indexStageLabel(stage: (typeof INDEX_STAGES)[number]["id"]) {
  return INDEX_STAGES.find((item) => item.id === stage)?.label ?? "Discover";
}

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

  const totalModules = progress?.totalModules ?? 0;
  const processedModules = progress?.processedModules ?? 0;
  const activeStage = progress?.stage ?? "discover";
  const activeStageIndex = INDEX_STAGES.findIndex((stage) => stage.id === activeStage);
  const modulesCopy =
    totalModules > 0
      ? `${processedModules}/${totalModules}`
      : processedModules > 0
        ? `${processedModules} discovered`
        : "pending";
  const percentage =
    progress?.progressPercent ??
    (totalModules > 0 ? Math.round((processedModules / totalModules) * 100) : 0);

  return (
    <DesktopWindow
      eyebrow="Indexing"
      title="Preparing the workspace."
      subtitle="This is where the desktop shell stays honest about what it knows, what it is still scanning, and when the blueprint is ready."
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
            <span className="window-bar__eyebrow">{indexStageLabel(activeStage)}</span>
            <h3>{progress?.message ?? "Waiting for backend indexing updates"}</h3>
            <span>{percentage}% complete</span>
          </div>
          <div className="progress-bar" aria-hidden="true">
            <div className="progress-bar__fill" style={{ width: `${percentage}%` }} />
          </div>
          <div className="metadata-grid">
            <div className="metadata-item">
              <span>Stage</span>
              <strong>{indexStageLabel(activeStage)}</strong>
            </div>
            <div className="metadata-item">
              <span>Modules</span>
              <strong>{modulesCopy}</strong>
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
              <h3>Pipeline</h3>
              <span>Backend-driven progress</span>
            </div>
            <ul className="bullet-list">
              {INDEX_STAGES.map((stage, index) => {
                const prefix =
                  index < activeStageIndex
                    ? "Complete"
                    : index === activeStageIndex
                      ? "Current"
                      : "Next";
                return (
                  <li key={stage.id}>
                    {prefix}: {stage.label}. {stage.description}
                  </li>
                );
              })}
            </ul>
          </article>
          <article className="card">
            <div className="section-header">
              <h3>What’s next</h3>
              <span>After indexing</span>
            </div>
            <ul className="bullet-list">
              <li>Open straight into the architecture map at the right abstraction level.</li>
              <li>Select a module or symbol to tighten the blueprint around that structure.</li>
              <li>Reveal source only when you explicitly ask for it.</li>
            </ul>
          </article>
        </section>
      </main>
    </DesktopWindow>
  );
}
