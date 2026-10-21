import { ProjectSelector } from "../projects/ProjectSelector";
import { useProjectContext } from "../projects/ProjectContext";
import type { PropsWithChildren } from "react";
import { IssueViewer } from "../issues/IssueViewer";
import type { IssueRepositoryAdapter } from "../issues/IssueRepositoryAdapter";
import { useFunctionTabs } from "./FunctionTabs";

export function FunctionTabsShell({
  children,
  issueAdapter,
}: PropsWithChildren<{ issueAdapter?: IssueRepositoryAdapter }>) {
  const project = useProjectContext();
  const { activeView, issuesOpen, activateIde, openIssues, closeIssues } = useFunctionTabs();
  return (
    <div className="function-tabs-shell">
      <ProjectSelector />
      <div
        className="function-workspace-panels"
        {...(project?.busy ? { inert: "" } : {})}
        aria-busy={project?.busy || undefined}
      >
        <nav
          className="function-tabs"
          role="tablist"
          aria-label="H.E.L.M. views"
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            if (activeView === "ide") {
              openIssues();
              document.getElementById("issues-function-tab")?.focus();
            } else {
              activateIde();
              document.getElementById("ide-function-tab")?.focus();
            }
          }}
        >
          <button
            id="ide-function-tab"
            role="tab"
            aria-selected={activeView === "ide"}
            aria-controls="ide-function-panel"
            tabIndex={activeView === "ide" ? 0 : -1}
            onClick={activateIde}
          >
            IDE
          </button>
          <button
            id="issues-function-tab"
            role="tab"
            aria-selected={activeView === "issues"}
            aria-controls={issuesOpen ? "issues-function-panel" : undefined}
            tabIndex={activeView === "issues" ? 0 : -1}
            onClick={openIssues}
          >
            GitHub issues
          </button>
        </nav>
        <div
          className="function-panel"
          id="ide-function-panel"
          role="tabpanel"
          aria-labelledby="ide-function-tab"
          hidden={activeView !== "ide"}
        >
          {children}
        </div>
        {issuesOpen ? (
          <div
            className="function-panel"
            id="issues-function-panel"
            role="tabpanel"
            aria-labelledby="issues-function-tab"
            hidden={activeView !== "issues"}
          >
            <IssueViewer
              adapter={issueAdapter}
              onClose={() => {
                closeIssues();
                document.getElementById("ide-function-tab")?.focus();
              }}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
