import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { useUiStore } from "../store/uiStore";
import { useDesktopAdapter } from "../lib/adapter";
import { useProjectContext } from "./ProjectContext";
import { repositoryIdentity, verifiedMatches, type ProjectInspection } from "./model";

export function ProjectSelector() {
  const project = useProjectContext(),
    adapter = useDesktopAdapter();
  const session = useUiStore((s) => s.repoSession);
  const [path, setPath] = useState(""),
    [candidate, setCandidate] = useState<ProjectInspection>();
  const [remote, setRemote] = useState(""),
    [selected, setSelected] = useState(project?.record.selectedPath ?? "");
  const [status, setStatus] = useState<string>(),
    [branch, setBranch] = useState("");
  const [transport, setTransport] = useState("https"),
    [destination, setDestination] = useState("");
  const [cloning, setCloning] = useState(false),
    [finding, setFinding] = useState(false);
  const cancelRequested = useRef(false);
  const request = useRef(0),
    cloneId = useRef<string>();
  useEffect(
    () => () => {
      request.current++;
      const pendingClone = cloneId.current;
      cloneId.current = undefined;
      if (pendingClone) void invoke("cancel_project_clone", { attemptId: pendingClone });
    },
    [],
  );
  if (!project) return null;
  const check = async () => {
    const id = ++request.current;
    try {
      const info = await project.inspect(path);
      if (request.current === id) {
        setCandidate(info);
        setRemote("");
        setStatus(undefined);
      }
    } catch {
      if (request.current === id) {
        setCandidate(undefined);
        setStatus(
          "Could not verify this Git root. Check its path, permissions and Git installation.",
        );
      }
    }
  };
  const find = async () => {
    const id = ++request.current;
    setFinding(true);
    try {
      const results = await Promise.allSettled(
        project.record.associations.map((a) => project.inspect(a.path)),
      );
      if (request.current !== id) return;
      const matches = verifiedMatches(
        project.record.issueRepository ?? "",
        project.record.associations,
        results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : [])),
      );
      setStatus(
        matches.length
          ? `Verified ${matches.length} matching local ${matches.length === 1 ? "copy" : "copies"}. Choose one explicitly: ${matches.map((m) => m.path).join("; ")}`
          : "No verified matching registered copy. Add an existing checkout or choose an explicit clone destination.",
      );
    } finally {
      if (request.current === id) setFinding(false);
    }
  };
  const clone = async () => {
    const repository = repositoryIdentity(project.record.issueRepository ?? "");
    if (!repository || !destination || cloning) return;
    cancelRequested.current = false;
    setCloning(true);
    setStatus(undefined);
    const id = crypto.randomUUID();
    cloneId.current = id;
    try {
      const copies = await Promise.allSettled(
        project.record.associations.map((a) => project.inspect(a.path)),
      );
      if (cloneId.current !== id) return;
      if (cancelRequested.current) {
        setStatus("Clone canceled before start. No destination was created.");
        return;
      }
      if (
        verifiedMatches(
          repository,
          project.record.associations,
          copies.flatMap((r) => (r.status === "fulfilled" ? [r.value] : [])),
        ).length
      )
        throw new Error(
          "A verified matching copy already exists. Choose it explicitly; this first slice refuses duplicate clones.",
        );
      const result = await invoke<{ outcome: string; path?: string; message?: string }>(
        "clone_project",
        { attemptId: id, repository, destination, transport },
      );
      if (cloneId.current !== id) return;
      setStatus(result.message ?? result.outcome);
      if (result.outcome === "cloned" && result.path) {
        const info = await project.inspect(result.path);
        const chosen = info.remotes.find((r) => r.kind === "fetch" && r.repository === repository);
        if (!chosen)
          throw new Error(
            "Clone completed but its remote identity did not verify. It was not registered or activated; inspect the destination.",
          );
        project.chooseAssociation({ path: info.path, repository, remote: chosen.name });
        setSelected(info.path);
      }
    } catch (e) {
      setStatus(
        e instanceof Error
          ? e.message
          : "Clone failed. Inspect the destination; existing files were preserved.",
      );
    } finally {
      if (cloneId.current === id) cloneId.current = undefined;
      setCloning(false);
    }
  };
  return (
    <details className="project-context-panel">
      <summary>
        Project context ·{" "}
        {project.inspection?.branch ?? (project.inspection ? "detached HEAD" : "select a checkout")}
      </summary>
      <fieldset disabled={project.busy || cloning || adapter.isMock}>
        <label>
          <input
            type="checkbox"
            checked={project.record.linked}
            onChange={(e) => project.setLinked(e.target.checked)}
          />{" "}
          Link repositories across tabs
        </label>
        <p>
          IDE: {session?.path ?? "none"} · actual branch:{" "}
          {project.inspection?.branch ?? (project.inspection ? "detached HEAD" : "not inspected")}
        </p>
        <p>
          Issues target: {project.record.issueRepository ?? "none"} · repository-wide, independent
          graph
        </p>
        {adapter.isMock ? <p>Shared Git operations require the native desktop backend.</p> : null}
        {project.inspection ? (
          <button
            onClick={() => {
              setCandidate(project.inspection);
              setPath(project.inspection!.path);
              setRemote("");
            }}
          >
            Choose active checkout association
          </button>
        ) : null}
        <label>
          Local checkout path{" "}
          <input
            aria-label="Local checkout path"
            value={path}
            onChange={(e) => {
              request.current++;
              setPath(e.target.value);
              setCandidate(undefined);
            }}
          />
        </label>
        <button
          onClick={() =>
            void open({
              directory: true,
              multiple: false,
              title: "Choose an existing checkout",
            }).then((p) => {
              if (typeof p === "string") {
                request.current++;
                setPath(p);
                setCandidate(undefined);
              }
            })
          }
        >
          Browse local copy
        </button>
        <button onClick={() => void check()}>Inspect local copy</button>
        {candidate ? (
          <div>
            <p>
              Verified root: {candidate.path} · {candidate.branch ?? "detached HEAD"}
            </p>
            <label>
              Repository remote{" "}
              <select
                aria-label="Repository remote"
                value={remote}
                onChange={(e) => setRemote(e.target.value)}
              >
                <option value="">Choose explicitly</option>
                <option value="local-only">Local only</option>
                {candidate.remotes
                  .filter((r) => r.kind === "fetch" && r.repository)
                  .map((r) => (
                    <option key={r.name} value={r.name}>
                      {r.name} · {r.repository}
                    </option>
                  ))}
              </select>
            </label>
            <button
              disabled={!remote}
              onClick={() => {
                const chosen = candidate.remotes.find(
                  (r) => r.name === remote && r.kind === "fetch",
                );
                project.chooseAssociation({
                  path: candidate.path,
                  repository: chosen?.repository ?? null,
                  remote: chosen?.name ?? null,
                });
                setSelected(candidate.path);
                setStatus(
                  "Association saved. Open this copy explicitly when ready; issue loading remains manual.",
                );
              }}
            >
              Register selected association
            </button>
          </div>
        ) : null}
        <label>
          Known local copy{" "}
          <select
            aria-label="Known local copy"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            <option value="">Choose a copy</option>
            {project.record.associations.map((a) => (
              <option key={a.path} value={a.path}>
                {a.repository ?? "local only"} · {a.path}
              </option>
            ))}
          </select>
        </label>
        <button disabled={!selected} onClick={() => void project.activate(selected)}>
          Open selected copy
        </button>
        <button disabled={!project.record.issueRepository || finding} onClick={() => void find()}>
          Find matching known copies
        </button>
        <label>
          Existing local branch{" "}
          <select
            aria-label="Existing local branch"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
          >
            <option value="">Choose a branch</option>
            {project.inspection?.branches.map((b) => (
              <option key={b}>{b}</option>
            ))}
          </select>
        </label>
        <button
          disabled={!session || !branch || !project.inspection}
          onClick={() => void project.activate(session!.path, branch)}
        >
          Switch actual local branch
        </button>
        <p>
          Remote-only branches require a separate explicit fetch/tracking setup. No fetch, pull,
          push or stash is performed here.
        </p>
        <button onClick={() => void project.saveDrafts()}>Save drafts before retrying</button>
        <label>
          Clone authentication{" "}
          <select value={transport} onChange={(e) => setTransport(e.target.value)}>
            <option value="https">Existing HTTPS Git credentials</option>
            <option value="ssh">Existing SSH agent / known host</option>
          </select>
        </label>
        <label>
          New clone destination{" "}
          <input
            aria-label="New clone destination"
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
          />
        </label>
        <button
          onClick={() =>
            void save({ title: "Choose a new clone directory", canCreateDirectories: true }).then(
              (p) => {
                if (p) setDestination(p);
              },
            )
          }
        >
          Choose clone destination
        </button>
        <p>
          Clone {project.record.issueRepository ?? "(select an issue repository)"} to{" "}
          {destination || "(choose a new directory)"} using {transport}. Issue tokens are never
          clone credentials. Existing destinations are refused; failed/canceled output is retained
          for inspection.
        </p>
        <button
          disabled={!project.record.issueRepository || !destination}
          onClick={() => void clone()}
        >
          Clone to this new destination
        </button>
        <button onClick={project.clearSaved}>Clear saved associations</button>
      </fieldset>
      {cloning ? (
        <button
          onClick={() => {
            cancelRequested.current = true;
            if (cloneId.current)
              void invoke("cancel_project_clone", { attemptId: cloneId.current });
          }}
        >
          Cancel clone
        </button>
      ) : null}
      {project.busy && !project.applying ? (
        <button onClick={project.cancelTransition}>Cancel transition and stay</button>
      ) : null}
      {project.busy ? (
        <p role="status">
          Inspecting/applying the selected transition. Once Git starts, its actual result is
          reconciled; no rollback is implied.
        </p>
      ) : null}
      {project.error ? <p role="alert">{project.error}</p> : null}
      {status ? <p role="status">{status}</p> : null}
    </details>
  );
}
