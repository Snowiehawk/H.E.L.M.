import { ExecutionWorkspace } from "../execution/ExecutionWorkspace";
import type { PropsWithChildren } from "react";
import { IssueViewer } from "../issues/IssueViewer";
import type { IssueRepositoryAdapter } from "../issues/IssueRepositoryAdapter";
import { useFunctionTabs } from "./FunctionTabs";

export function FunctionTabsShell({
  children,
  issueAdapter,
}: PropsWithChildren<{ issueAdapter?: IssueRepositoryAdapter }>) {
  const { activeView, issuesOpen, activateIde, openIssues, closeIssues } = useFunctionTabs();
  return (
    <ExecutionWorkspace>
      <div className="function-tabs-shell">
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
    </ExecutionWorkspace>
  );
}
