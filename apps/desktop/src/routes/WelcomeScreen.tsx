import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { DesktopWindow } from "../components/layout/DesktopWindow";
import { AppWindowActions } from "../components/shared/AppWindowActions";
import { StatusPill } from "../components/shared/StatusPill";
import { useDesktopAdapter } from "../lib/adapter";
import { useUiStore } from "../store/uiStore";

export function WelcomeScreen() {
  const adapter = useDesktopAdapter();
  const navigate = useNavigate();
  const setSession = useUiStore((state) => state.setSession);
  const resetWorkspace = useUiStore((state) => state.resetWorkspace);
  const recentReposQuery = useQuery({
    queryKey: ["recent-repos"],
    queryFn: () => adapter.listRecentRepos(),
  });
  const backendStatusQuery = useQuery({
    queryKey: ["backend-status"],
    queryFn: () => adapter.getBackendStatus(),
  });
  const [error, setError] = useState<string | null>(null);
  const [isOpening, setIsOpening] = useState(false);

  const openAndIndexRepo = async (path?: string) => {
    setError(null);
    setIsOpening(true);

    try {
      const session = await adapter.openRepo(path);
      resetWorkspace();
      setSession(session);
      const { jobId } = await adapter.startIndex(session.path);
      navigate(`/indexing/${encodeURIComponent(jobId)}`);
    } catch (reason) {
      const message =
        reason instanceof Error ? reason.message : "Unable to open the selected repository.";
      setError(message);
    } finally {
      setIsOpening(false);
    }
  };

  return (
    <DesktopWindow
      eyebrow="H.E.L.M."
      title="Open a repo."
      subtitle="Index it, then live inside the blueprint."
      actions={<AppWindowActions />}
      compact
    >
      <main className="launch-layout">
        <section className="launch-card">
          <span className="window-bar__eyebrow">Desktop Blueprint Shell</span>
          <h2>One action to start.</h2>
          <p>
            Open a local repository and H.E.L.M. will index it, open at the architecture layer,
            and let you drill into symbols and flow only when you choose.
          </p>
          <div className="hero-card__actions">
            <button className="primary-button" type="button" onClick={() => openAndIndexRepo()}>
              {isOpening ? "Opening..." : "Open Local Repo"}
            </button>
            <StatusPill tone={backendStatusQuery.data?.mode === "mock" ? "accent" : "default"}>
              {backendStatusQuery.data?.mode === "mock" ? "Mock transport" : "Live backend"}
            </StatusPill>
          </div>
          {backendStatusQuery.data?.note ? (
            <p className="launch-note">{backendStatusQuery.data.note}</p>
          ) : null}
          {backendStatusQuery.data?.lastError ? (
            <p className="error-copy">{backendStatusQuery.data.lastError}</p>
          ) : null}
          {error ? <p className="error-copy">{error}</p> : null}
        </section>

        <section className="launch-secondary">
          <div className="section-header">
            <h3>Recent repos</h3>
            <span>{recentReposQuery.data?.length ?? 0}</span>
          </div>
          <div className="launch-recent">
            {(recentReposQuery.data ?? []).map((repo) => (
              <button
                key={repo.path}
                className="list-button"
                type="button"
                onClick={() => openAndIndexRepo(repo.path)}
              >
                <span className="list-button__title">{repo.name}</span>
                <span className="list-button__subtitle">{repo.path}</span>
              </button>
            ))}
          </div>
        </section>
      </main>
    </DesktopWindow>
  );
}
