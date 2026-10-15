import { createContext, useContext, useMemo, useState } from "react";
import type { PropsWithChildren } from "react";

type FunctionView = "ide" | "issues";
interface FunctionTabsState {
  activeView: FunctionView;
  issuesOpen: boolean;
  activateIde: () => void;
  openIssues: () => void;
  closeIssues: () => void;
}

const FunctionTabsContext = createContext<FunctionTabsState>({
  activeView: "ide",
  issuesOpen: false,
  activateIde: () => {},
  openIssues: () => {},
  closeIssues: () => {},
});

/** Navigation only. Issue credentials, graph data and layouts never enter IDE stores. */
export function FunctionTabsProvider({ children }: PropsWithChildren) {
  const [activeView, setActiveView] = useState<FunctionView>("ide");
  const [issuesOpen, setIssuesOpen] = useState(false);
  const state = useMemo<FunctionTabsState>(
    () => ({
      activeView,
      issuesOpen,
      activateIde: () => setActiveView("ide"),
      openIssues: () => {
        setIssuesOpen(true);
        setActiveView("issues");
      },
      closeIssues: () => {
        setIssuesOpen(false);
        setActiveView("ide");
      },
    }),
    [activeView, issuesOpen],
  );
  return <FunctionTabsContext.Provider value={state}>{children}</FunctionTabsContext.Provider>;
}

export const useFunctionTabs = () => useContext(FunctionTabsContext);
export const useIdeActive = () => useFunctionTabs().activeView === "ide";
