import { useEffect, useId, useMemo, useState, useSyncExternalStore } from "react";
import type { FormEvent } from "react";
import { dependencyEdges } from "./dependencies";
import { IssueRepositoryAdapter } from "./IssueRepositoryAdapter";

export function IssueImportPanel({
  adapter: suppliedAdapter,
}: {
  adapter?: IssueRepositoryAdapter;
}) {
  const [adapter] = useState(() => suppliedAdapter ?? new IssueRepositoryAdapter());
  const state = useSyncExternalStore(adapter.subscribe, adapter.getState);
  const [repository, setRepository] = useState("");
  const [token, setToken] = useState("");
  const id = useId();
  const loading = state.status === "loading";
  const edges = useMemo(() => dependencyEdges(state.snapshot?.issues ?? []), [state.snapshot]);

  useEffect(() => () => adapter.clear(), [adapter]);

  const load = (event: FormEvent) => {
    event.preventDefault();
    const submittedToken = token;
    setToken("");
    void adapter.load(repository, submittedToken);
  };

  return (
    <section className="issue-import-panel" aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`}>GitHub issues</h3>
      <p>Read-only import. Load or refresh to fetch the latest issues and native blockers.</p>
      <form className="issue-import-form" onSubmit={load}>
        <label htmlFor={`${id}-repo`}>Repository URL or owner/name</label>
        <input
          id={`${id}-repo`}
          value={repository}
          onChange={(event) => setRepository(event.target.value)}
          placeholder="owner/repository"
          autoComplete="off"
          spellCheck={false}
          required
        />
        <label htmlFor={`${id}-token`}>Personal access token</label>
        <input
          id={`${id}-token`}
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          required
        />
        <p className="launch-note">
          Use a token with Issues read access. It stays in memory on this computer until you
          disconnect or close the issue viewer.
        </p>
        <div className="hero-card__actions">
          <button className="primary-button" type="submit" disabled={loading}>
            Load issues
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={!state.canRefresh || loading}
            onClick={() => void adapter.refresh()}
          >
            Refresh issues
          </button>
          {loading ? (
            <button className="ghost-button" type="button" onClick={adapter.cancel}>
              Cancel import
            </button>
          ) : null}
          <button
            className="ghost-button"
            type="button"
            onClick={() => {
              adapter.clear();
              setToken("");
              setRepository("");
            }}
          >
            Disconnect
          </button>
        </div>
      </form>
      <div role="status" aria-live="polite">
        {loading ? (
          <p>
            Loading {state.progress?.loaded ?? 0} of {state.progress?.total ?? 0} issues…
          </p>
        ) : null}
        {state.snapshot ? (
          <>
            <p>
              {state.snapshot.repository.nameWithOwner}: {state.snapshot.issues.length} issues,{" "}
              {edges.length} native blocker links.
            </p>
            <p>
              Last successful load: {new Date(state.snapshot.fetchedAt).toLocaleString()}. Changes
              appear after Refresh issues.
            </p>
            {state.snapshot.completeness.issues === "partial" ? (
              <p className="error-copy">
                Issue data is partial ({state.snapshot.issues.length} of{" "}
                {state.snapshot.expectedIssueCount}); the repository may have changed during
                loading. Refresh to try again.
              </p>
            ) : null}
            {state.snapshot.completeness.dependencies === "partial" ? (
              <p className="error-copy">
                Dependency data is partial. Reachability and blocker counts may be incomplete.
              </p>
            ) : null}
          </>
        ) : null}
      </div>
      {state.error ? (
        <p className="error-copy" role="alert">
          {state.error}
          {state.snapshot ? " Showing the previous successful load." : ""}
        </p>
      ) : null}
      <p className="launch-note">
        At most 100 blocked-by and 100 blocking relationships are fetched per issue. Hierarchy is
        not loaded.
      </p>
    </section>
  );
}
