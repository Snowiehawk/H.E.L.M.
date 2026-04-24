import { useQuery } from "@tanstack/react-query";
import { DesktopWindow } from "../components/layout/DesktopWindow";
import { AppWindowActions } from "../components/shared/AppWindowActions";
import { StatusPill } from "../components/shared/StatusPill";
import { useDesktopAdapter } from "../lib/adapter";
import { useWorkspaceLauncher } from "./useWorkspaceLauncher";

export function WelcomeScreen() {
  const adapter = useDesktopAdapter();
  const {
    createAndIndexProject,
    error,
    isCreating,
    isOpening,
    openAndIndexRepo,
  } = useWorkspaceLauncher();
  const recentReposQuery = useQuery({
    queryKey: ["recent-repos"],
    queryFn: () => adapter.listRecentRepos(),
  });
  const backendStatusQuery = useQuery({
    queryKey: ["backend-status"],
    queryFn: () => adapter.getBackendStatus(),
  });

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
          <h2>Start a workspace.</h2>
          <p>
            Create a starter project or open a local repository and H.E.L.M. will index it,
            open at the architecture layer, and let you drill into symbols and flow only when you choose.
          </p>
          <div className="hero-card__actions">
            <button
              className="secondary-button"
              type="button"
              onClick={() => createAndIndexProject()}
            >
              {isCreating ? "Creating..." : "New Project"}
            </button>
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
