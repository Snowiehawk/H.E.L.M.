import { hasPendingGraphLayoutWrites } from "../components/graph/graphLayoutPersistence";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useDesktopAdapter } from "../lib/adapter";
import { useUiStore } from "../store/uiStore";
import { useUndoStore } from "../store/undoStore";
import { useFunctionTabs } from "../app/FunctionTabs";
import {
  assertClean,
  assertDraftsClean,
  decodeProjectRecord,
  freshProjectRecord,
  PROJECT_STORAGE_KEY,
  repositoryIdentity,
  serializeProjectRecord,
  type Association,
  type DraftSnapshot,
  type ProjectInspection,
  type ProjectRecord,
} from "./model";

interface ProjectContextState {
  record: ProjectRecord;
  inspection?: ProjectInspection;
  error?: string;
  busy: boolean;
  applying: boolean;
  cancelTransition: () => void;
  setLinked: (linked: boolean) => void;
  chooseAssociation: (association: Association) => void;
  setIssueRepository: (repository: string) => void;
  inspect: (path: string) => Promise<ProjectInspection>;
  activate: (path: string, branch?: string) => Promise<void>;
  registerDraftProvider: (provider: () => DraftSnapshot) => () => void;
  saveDrafts: () => Promise<void>;
  clearSaved: () => void;
}
const ProjectContext = createContext<ProjectContextState | undefined>(undefined);
export const useProjectContext = () => useContext(ProjectContext);
export function ProjectContextProvider({ children }: PropsWithChildren) {
  const adapter = useDesktopAdapter(),
    navigate = useNavigate(),
    queries = useQueryClient(),
    tabs = useFunctionTabs();
  const session = useUiStore((s) => s.repoSession);
  const [initial] = useState(() => {
    try {
      return {
        record: decodeProjectRecord(localStorage.getItem(PROJECT_STORAGE_KEY)),
        error: undefined as string | undefined,
      };
    } catch (e) {
      return { record: freshProjectRecord(), error: String(e) };
    }
  });
  const [record, setRecord] = useState(initial.record),
    [error, setError] = useState(initial.error);
  const [inspection, setInspection] = useState<ProjectInspection>(),
    [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const cancelled = useRef(false);
  const provider = useRef<(() => DraftSnapshot) | undefined>(undefined),
    generation = useRef(0),
    locked = useRef(false);
  const recordRef = useRef(record);
  recordRef.current = record;
  const storageBlocked = useRef(Boolean(initial.error));
  const persist = useCallback((next: ProjectRecord) => {
    setRecord(next);
    recordRef.current = next;
    if (storageBlocked.current) {
      setError(
        "Saved context needs repair before new associations can be persisted. Existing data was retained.",
      );
      return;
    }
    try {
      localStorage.setItem(PROJECT_STORAGE_KEY, serializeProjectRecord(next));
    } catch {
      setError(
        "Project associations could not be saved. The previous stored record was retained; this session remains usable.",
      );
    }
  }, []);
  const inspect = useCallback(
    (path: string) => invoke<ProjectInspection>("inspect_project", { repoPath: path }),
    [],
  );
  useEffect(() => {
    const current = ++generation.current;
    setInspection(undefined);
    if (!session || adapter.isMock) return;
    void inspect(session.path)
      .then((info) => {
        if (generation.current !== current) return;
        setInspection(info);
        const activeSession = useUiStore.getState().repoSession;
        if (
          activeSession?.path === info.path &&
          activeSession.branch !== (info.branch ?? "detached HEAD")
        )
          useUiStore.setState({
            repoSession: { ...activeSession, branch: info.branch ?? "detached HEAD" },
          });
        const saved = recordRef.current.associations.find((a) => a.path === info.path);
        if (
          saved &&
          saved.repository &&
          !info.remotes.some(
            (r) =>
              r.kind === "fetch" && r.name === saved.remote && r.repository === saved.repository,
          )
        )
          setError("The saved checkout remote changed. Select its verified remote again.");
      })
      .catch(() => {
        if (generation.current === current)
          setError(
            "This path could not be inspected as a Git checkout. Local code remains available; shared transitions require a verified repository root.",
          );
      });
    return () => {
      generation.current++;
    };
  }, [adapter.isMock, inspect, session?.id, session?.path]);
  const chooseAssociation = (association: Association) => {
    persist({
      ...recordRef.current,
      selectedPath: association.path,
      associations: [
        ...recordRef.current.associations.filter((a) => a.path !== association.path),
        association,
      ],
      ...(recordRef.current.linked && association.repository
        ? { issueRepository: association.repository }
        : {}),
    });
  };
  const setIssueRepository = (value: string) => {
    const repository = repositoryIdentity(value);
    if (repository) persist({ ...recordRef.current, issueRepository: repository });
  };
  const activate = async (path: string, branch?: string) => {
    if (locked.current) return;
    cancelled.current = false;
    locked.current = true;
    setBusy(true);
    setError(undefined);
    const selectedSession = useUiStore.getState().repoSession;
    const currentGeneration = generation.current;
    const getDraft = () => provider.current?.();
    const validate = () => {
      if (cancelled.current)
        throw new Error(
          "Project transition canceled before apply. The current workspace was preserved.",
        );
      if (
        generation.current !== currentGeneration ||
        useUiStore.getState().repoSession?.id !== selectedSession?.id
      )
        throw new Error("The active project changed. Review the new context and retry.");
      assertDraftsClean(getDraft(), selectedSession?.path);
      if (
        (selectedSession && hasPendingGraphLayoutWrites(selectedSession.path)) ||
        adapter.hasPendingProjectMutation?.()
      )
        throw new Error("An IDE mutation is still pending. Wait for its result, then retry.");
    };
    let gitStarted = false;
    try {
      validate();
      const old = selectedSession ? await inspect(selectedSession.path) : undefined;
      if (old) assertClean(old);
      const target = await inspect(path);
      const association = recordRef.current.associations.find((a) => a.path === target.path);
      if (!association)
        throw new Error("Register this verified checkout and choose its remote first.");
      if (
        association.repository &&
        !target.remotes.some(
          (r) =>
            r.kind === "fetch" &&
            r.name === association.remote &&
            r.repository === association.repository,
        )
      )
        throw new Error(
          "This checkout no longer matches the selected repository/remote. Register its current identity before opening it.",
        );
      if (
        recordRef.current.linked &&
        recordRef.current.issueRepository &&
        association.repository !== recordRef.current.issueRepository
      )
        throw new Error(
          "The selected local copy does not match the linked issue repository. Choose a matching copy or unlink the tabs.",
        );
      validate();
      if (old) {
        const rechecked = await inspect(old.path);
        assertClean(rechecked);
        if (old.fingerprint !== rechecked.fingerprint)
          throw new Error("Git state changed during inspection. Retry.");
      }
      const targetNow = await inspect(target.path);
      if (targetNow.fingerprint !== target.fingerprint)
        throw new Error(
          "The selected checkout changed before apply. Verify its association and retry.",
        );
      validate();
      let actualInspection = targetNow;
      if (branch) {
        if (!selectedSession || selectedSession.path !== target.path)
          throw new Error("Open this checkout before switching its branch.");
        assertClean(target);
        if (target.blocked.length) throw new Error(target.blocked.join(" "));
        setApplying(true);
        gitStarted = true;
        const result = await invoke<{
          outcome: string;
          actual: ProjectInspection | null;
          contextEpoch: number;
          message?: string;
        }>("switch_project_branch", {
          repoPath: target.path,
          branch,
          fingerprint: target.fingerprint,
        });
        adapter.acceptProjectContextEpoch?.(result.contextEpoch);
        setInspection(result.actual ?? undefined);
        if (result.actual) actualInspection = result.actual;
        if (result.outcome !== "switched")
          setError(
            result.message ?? "Git refused the transition. Actual state requires inspection.",
          );
        if (!result.actual) {
          useUiStore.getState().resetWorkspace();
          navigate("/");
          throw new Error("Git state is unknown. Inspect the checkout before reindexing.");
        }
      }
      // No await between the final draft check and admission for project replacement.
      if (!gitStarted) validate();
      await queries.cancelQueries();
      queries.removeQueries({
        predicate: (q) => q.queryKey[0] !== "backend-status" && q.queryKey[0] !== "recent-repos",
      });
      if (!gitStarted) validate();
      setApplying(true);
      const opened = await adapter.openRepo(target.path);
      const epochSession = {
        ...opened,
        branch: actualInspection.branch ?? "detached HEAD",
        id: `${opened.id}:project:${++generation.current}`,
      };
      useUndoStore.getState().resetSession(epochSession.id);
      useUiStore.getState().resetWorkspace();
      useUiStore.getState().setSession(epochSession);
      persist({ ...recordRef.current, selectedPath: target.path });
      const { jobId } = await adapter.startIndex(target.path);
      tabs.activateIde();
      navigate(`/indexing/${encodeURIComponent(jobId)}`);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Project transition failed. Review the actual checkout and retry.",
      );
    } finally {
      locked.current = false;
      setBusy(false);
      setApplying(false);
    }
  };
  return (
    <ProjectContext.Provider
      value={{
        applying,
        cancelTransition: () => {
          if (!applying) cancelled.current = true;
        },
        record,
        inspection,
        error,
        busy,
        inspect,
        activate,
        chooseAssociation,
        setIssueRepository,
        setLinked: (linked) => persist({ ...recordRef.current, linked }),
        registerDraftProvider: (callback) => {
          provider.current = callback;
          return () => {
            if (provider.current === callback) provider.current = undefined;
          };
        },
        saveDrafts: async () => {
          try {
            if (!provider.current) throw new Error("Open the IDE workspace before saving drafts.");
            await provider.current().save();
            setError(
              "Draft save attempted. Review any editor errors and retry the transition; Git changes may still block it.",
            );
          } catch (e) {
            setError(String(e));
          }
        },
        clearSaved: () => {
          try {
            localStorage.removeItem(PROJECT_STORAGE_KEY);
            storageBlocked.current = false;
            setError(undefined);
            persist(freshProjectRecord());
          } catch {
            setError("Saved associations could not be cleared.");
          }
        },
      }}
    >
      {children}
    </ProjectContext.Provider>
  );
}
