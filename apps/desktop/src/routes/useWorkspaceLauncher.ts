import {
  assertWorkspaceMutationAdmission,
  isWorkspaceInstallationFrozen,
} from "../execution/mutationTracking";
import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useDesktopAdapter, type RepoSession } from "../lib/adapter";
import { useUiStore } from "../store/uiStore";

export function useWorkspaceLauncher() {
  const adapter = useDesktopAdapter();
  const navigate = useNavigate();
  const setSession = useUiStore((state) => state.setSession);
  const resetWorkspace = useUiStore((state) => state.resetWorkspace);
  const setLastActivity = useUiStore((state) => state.setLastActivity);
  const [error, setError] = useState<string | null>(null);
  const [isOpening, setIsOpening] = useState(false);
  const [isCreating, setIsCreating] = useState(false);

  const indexSession = useCallback(
    async (session: RepoSession) => {
      assertWorkspaceMutationAdmission();
      resetWorkspace();
      setSession(session);
      let jobId: string;
      try {
        ({ jobId } = await adapter.startIndex(session.path));
      } catch (reason) {
        if (
          !isWorkspaceInstallationFrozen() &&
          useUiStore.getState().repoSession?.id === session.id
        ) {
          resetWorkspace();
          useUiStore.setState({ repoSession: undefined });
        }
        throw reason;
      }
      assertWorkspaceMutationAdmission();
      if (useUiStore.getState().repoSession?.id !== session.id) return;
      useUiStore.setState({ indexingSession: { sessionId: session.id, jobId } });
      navigate(`/indexing/${encodeURIComponent(jobId)}`);
    },
    [adapter, navigate, resetWorkspace, setSession],
  );

  const openAndIndexRepo = useCallback(
    async (path?: string) => {
      if (isWorkspaceInstallationFrozen()) return;
      setError(null);
      setIsOpening(true);

      try {
        const session = await adapter.openRepo(path);
        assertWorkspaceMutationAdmission();
        await indexSession(session);
      } catch (reason) {
        const message =
          reason instanceof Error ? reason.message : "Unable to open the selected repository.";
        setError(message);
        setLastActivity({
          domain: "backend",
          kind: "error",
          summary: message,
        });
      } finally {
        setIsOpening(false);
      }
    },
    [adapter, indexSession, setLastActivity],
  );

  const createAndIndexProject = useCallback(async () => {
    if (isWorkspaceInstallationFrozen()) return;
    setError(null);
    setIsCreating(true);

    try {
      const session = await adapter.createProject();
      assertWorkspaceMutationAdmission();
      if (!session) {
        return;
      }
      await indexSession(session);
    } catch (reason) {
      const message =
        reason instanceof Error ? reason.message : "Unable to create the new project.";
      setError(message);
      setLastActivity({
        domain: "backend",
        kind: "error",
        summary: message,
      });
    } finally {
      setIsCreating(false);
    }
  }, [adapter, indexSession, setLastActivity]);

  return {
    error,
    isCreating,
    isOpening,
    openAndIndexRepo,
    createAndIndexProject,
  };
}
