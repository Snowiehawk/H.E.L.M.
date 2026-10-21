import { useProjectContext } from "../projects/ProjectContext";
import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useDesktopAdapter, type RepoSession } from "../lib/adapter";
import { useUiStore } from "../store/uiStore";

export function useWorkspaceLauncher() {
  const project = useProjectContext();
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
      resetWorkspace();
      setSession(session);
      try {
        const { jobId } = await adapter.startIndex(session.path);
        if (useUiStore.getState().repoSession?.id !== session.id) return;
        useUiStore.setState({ indexingSession: { sessionId: session.id, jobId } });
        navigate(`/indexing/${encodeURIComponent(jobId)}`);
      } catch (reason) {
        // This newly admitted session never became an editable workspace.
        if (useUiStore.getState().repoSession?.id === session.id) {
          resetWorkspace();
          useUiStore.setState({ repoSession: undefined });
        }
        throw reason;
      }
    },
    [adapter, navigate, resetWorkspace, setSession],
  );

  const openAndIndexRepo = useCallback(
    async (path?: string) => {
      setError(null);
      setIsOpening(true);

      try {
        if (project?.busy)
          throw new Error(
            "A project transition is in progress. Wait for its result before opening another project.",
          );
        if (project && useUiStore.getState().repoSession) {
          if (!path)
            throw new Error(
              "Use Project context to inspect and choose an existing copy before replacing this workspace.",
            );
          await project.activate(path);
          return;
        }
        const session = await adapter.openRepo(path);
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
    [adapter, indexSession, setLastActivity, project],
  );

  const createAndIndexProject = useCallback(async () => {
    setError(null);
    setIsCreating(true);

    try {
      if (project?.busy)
        throw new Error(
          "A project transition is in progress. Wait for its result before creating another project.",
        );
      if (project && useUiStore.getState().repoSession)
        throw new Error(
          "Preserve the active workspace first. Project context must guard replacement before creating and activating another project.",
        );
      const session = await adapter.createProject();
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
  }, [adapter, indexSession, setLastActivity, project]);

  return {
    error,
    isCreating,
    isOpening,
    openAndIndexRepo,
    createAndIndexProject,
  };
}
