import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { DesktopWindow } from "../components/layout/DesktopWindow";
import { AppWindowActions } from "../components/shared/AppWindowActions";
import { EmptyState } from "../components/shared/EmptyState";
import { StatusPill } from "../components/shared/StatusPill";
import { IssueImportPanel } from "./IssueImportPanel";
import { IssueRepositoryAdapter } from "./IssueRepositoryAdapter";
import { IssueGraphCanvas } from "./IssueGraphCanvas";
import { projectIssueGraph } from "./issueGraph";

export function IssueViewer({
  adapter: suppliedAdapter,
  onClose,
}: {
  adapter?: IssueRepositoryAdapter;
  onClose: () => void;
}) {
  const [adapter] = useState(() => suppliedAdapter ?? new IssueRepositoryAdapter());
  const state = useSyncExternalStore(adapter.subscribe, adapter.getState);
  const [selectedId, setSelectedId] = useState<string>();
  const graph = useMemo(
    () => (state.snapshot ? projectIssueGraph(state.snapshot) : undefined),
    [state.snapshot],
  );
  useEffect(() => {
    if (!state.snapshot) setSelectedId(undefined);
  }, [state.snapshot]);
  const selected = graph?.nodes.find((node) => node.id === selectedId);
  const detailsRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (detailsRef.current) detailsRef.current.scrollTop = 0;
  }, [selected?.id]);
  const related = (direction: "source" | "target") => {
    if (!selected || !graph) return [];
    const ids = new Set(
      graph.edges
        .filter((edge) => edge[direction === "source" ? "target" : "source"] === selected.id)
        .map((edge) => edge[direction]),
    );
    return graph.nodes.filter((node) => ids.has(node.id));
  };
  return (
    <DesktopWindow
      eyebrow="GitHub issue viewer"
      title="GitHub issues"
      subtitle="Read-only snapshots · manual refresh · separate from the IDE"
      actions={
        <>
          <button className="ghost-button" onClick={onClose}>
            Close issue viewer
          </button>
          <AppWindowActions />
        </>
      }
      dense
    >
      <main className="issue-viewer-layout">
        <aside className="issue-viewer-controls">
          <IssueImportPanel adapter={adapter} />
          {graph ? (
            <section aria-label="Imported issues">
              <h3>Issues and boundary references</h3>
              <div className="issue-viewer-list">
                {graph.nodes.map((node) => (
                  <button
                    className="list-button"
                    key={node.id}
                    aria-pressed={selected?.id === node.id}
                    onClick={() => setSelectedId(node.id)}
                  >
                    <span>
                      #{node.number} · {node.title}
                    </span>
                    <small>
                      {node.repository}
                      {node.external ? " · external" : ""}
                    </small>
                  </button>
                ))}
              </div>
            </section>
          ) : null}
        </aside>
        {graph?.nodes.length ? (
          <IssueGraphCanvas
            key={graph.namespace}
            graph={graph}
            selectedId={selected?.id}
            onSelect={setSelectedId}
          />
        ) : (
          <EmptyState
            title={graph ? "No issues in this snapshot" : "Load a GitHub repository"}
            body="Enter its URL and a read-only personal access token. The issue graph stays separate from your code workspace."
          />
        )}
        <aside ref={detailsRef} className="issue-viewer-details" aria-label="Issue details">
          {selected ? (
            <>
              <h2>
                #{selected.number}: {selected.title}
              </h2>
              <StatusPill>{selected.state.toLowerCase()}</StatusPill>
              <p>{selected.repository}</p>
              <p className="issue-viewer-url">{selected.url}</p>
              {selected.external ? (
                <p>Boundary reference. This repository has not been loaded recursively.</p>
              ) : null}
              {selected.partial ? (
                <p className="error-copy">This issue has incomplete blocker data.</p>
              ) : null}
              <h3>Blocked by</h3>
              {related("source").length ? (
                related("source").map((node) => (
                  <button
                    className="list-button"
                    key={node.id}
                    onClick={() => setSelectedId(node.id)}
                  >
                    #{node.number}: {node.title}
                  </button>
                ))
              ) : (
                <p>No blockers returned.</p>
              )}
              <h3>Blocking</h3>
              {related("target").length ? (
                related("target").map((node) => (
                  <button
                    className="list-button"
                    key={node.id}
                    onClick={() => setSelectedId(node.id)}
                  >
                    #{node.number}: {node.title}
                  </button>
                ))
              ) : (
                <p>No blocked issues returned.</p>
              )}
              <p className="launch-note">
                Details reflect the last successful load. Hierarchy is not loaded.
              </p>
            </>
          ) : (
            <EmptyState
              title="Select an issue"
              body="Click a graph node or select an issue from the list to inspect its native blocker links."
            />
          )}
        </aside>
      </main>
    </DesktopWindow>
  );
}
