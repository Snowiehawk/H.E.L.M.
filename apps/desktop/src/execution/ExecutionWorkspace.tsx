import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type PropsWithChildren,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { RunOutputNavigation } from "./RunOutputNavigation";
import { validateLoopbackUrl } from "./links";
import { useUiStore } from "../store/uiStore";
import { executionConfigService } from "./configService";
import {
  emptyRunConfigs,
  type ExecutionContext,
  type RunConfigDocument,
  type RunSuggestion,
  type ToolInfo,
} from "./contracts";
import { executionAdapter, type ExecutionSnapshot } from "./adapter";
import {
  assertWorkspacePreparationCurrent,
  prepareWorkspaceToRun,
  type PreparedSource,
} from "./preparation";
import { ExecutionRendererBoundary } from "./ExecutionRendererBoundary";
import { RunConfigEditor } from "./RunConfigEditor";
import { executionStatus, mergeExecutionSnapshot, outputText } from "./output";
import { resetExecutionActions, useExecutionActions } from "./actions";
import { listen } from "@tauri-apps/api/event";
import { useExecutionLayout } from "./useExecutionLayout";
import "./execution.css";

const TerminalView = lazy(() =>
  import("./TerminalView").then((module) => ({ default: module.TerminalView })),
);

const native = () => "__TAURI_INTERNALS__" in window;
const active = (value?: ExecutionSnapshot) => value && !value.cleanupConfirmed;
const reason = (value: unknown) => (value instanceof Error ? value.message : String(value));
const consentOwner = (value: ExecutionContext) =>
  JSON.stringify([value.repoPath, value.generation]);
const sameContext = (left: ExecutionContext, right: ExecutionContext) =>
  left.contextId === right.contextId && consentOwner(left) === consentOwner(right);
export function ExecutionWorkspace({ children }: PropsWithChildren) {
  const session = useUiStore((state) => state.repoSession);
  const indexing = useUiStore((state) => state.indexingSession);
  const [context, setContext] = useState<ExecutionContext>();
  const currentContext = useRef<ExecutionContext>();
  const indexingAdmissionSuspended = useRef(false);
  if (indexing?.sessionId === session?.id && indexing) indexingAdmissionSuspended.current = true;
  currentContext.current = context;
  const revokedOwners = useRef(new Set<string>());
  const revocationEpoch = useRef(0);
  const revokeLock = useRef(false);
  const [revoking, setRevoking] = useState(false);
  const revocationFailure = useRef<{ owner: string; message: string }>();
  const [document, setDocument] = useState<RunConfigDocument>(emptyRunConfigs);
  const [selectedId, setSelectedId] = useState<string>();
  const [suggestions, setSuggestions] = useState<RunSuggestion[]>([]);
  const [tool, setTool] = useState<ToolInfo>();
  const [terminalExecutable, setTerminalExecutable] = useState("");
  const [runMetadata, setRunMetadata] = useState<{
    id: string;
    context: ExecutionContext;
    cwd: string;
    preparedSource: PreparedSource;
    configName: string;
  }>();
  const [terminalContext, setTerminalContext] = useState<ExecutionContext>();
  const [link, setLink] = useState<{ context: ExecutionContext; url: string }>();
  const [run, setRun] = useState<ExecutionSnapshot>();
  const [terminal, setTerminal] = useState<ExecutionSnapshot>();
  const [tab, setTab] = useState<"terminal" | "run">("run");
  const [shown, setShown] = useState(false);
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<string>();
  const [width, setWidth] = useState(() => {
    try {
      return Math.max(
        300,
        Math.min(640, Number(localStorage.getItem("helm.execution.width")) || 420),
      );
    } catch {
      return 420;
    }
  });
  const layout = useExecutionLayout(width);
  const visible = shown && Boolean(session) && !(context && context.generation !== session?.id);
  const resizeCleanup = useRef<() => void>();
  useEffect(() => {
    resizeCleanup.current?.();
  }, [layout.stacked, layout.maximumWidth, visible, session?.id]);
  useEffect(() => () => resizeCleanup.current?.(), []);
  const operation = useRef<AbortController>();
  const lock = useRef(false);
  const stopLock = useRef(false);
  const panel = useRef<HTMLElement>(null);
  const output = outputText(run);
  const selected = document.configs.find(
    (config) => config.id === (selectedId ?? document.defaultId),
  );
  const report = useCallback((value: unknown) => {
    const failed = revocationFailure.current;
    setError(
      failed && currentContext.current && failed.owner === consentOwner(currentContext.current)
        ? failed.message
        : reason(value),
    );
  }, []);
  const ownsContext = useCallback((owner: ExecutionContext) => {
    const selected = useUiStore.getState().repoSession;
    return (
      currentContext.current?.contextId === owner.contextId &&
      selected?.id === owner.generation &&
      selected.path === owner.repoPath
    );
  }, []);
  // A passive rebind, canceled operation or stale Stop reply cannot restore a
  // consent grant that this owner explicitly revoked. Only a new explicit grant
  // may remove this latch, after native admission acknowledges that request.
  const adoptContext = useCallback((next?: ExecutionContext) => {
    if (next) {
      const selected = useUiStore.getState().repoSession;
      if (selected?.id !== next.generation || selected.path !== next.repoPath) return;
      const previous = currentContext.current;
      if (previous && sameContext(previous, next) && next.trustRevision < previous.trustRevision)
        next = previous;
      if (revokedOwners.current.has(consentOwner(next)) || indexingAdmissionSuspended.current)
        next = { ...next, trusted: false };
    }
    currentContext.current = next;
    setContext(next);
    return next;
  }, []);
  const trustedOwner = useCallback(
    (owner: ExecutionContext) =>
      ownsContext(owner) &&
      !indexingAdmissionSuspended.current &&
      useUiStore.getState().indexingSession?.sessionId !== owner.generation &&
      currentContext.current?.trusted === true &&
      currentContext.current.trustRevision === owner.trustRevision &&
      !revokedOwners.current.has(consentOwner(owner)),
    [ownsContext],
  );
  useEffect(() => {
    operation.current?.abort();
    const previous = currentContext.current;
    indexingAdmissionSuspended.current =
      useUiStore.getState().indexingSession?.sessionId === session?.id && Boolean(session);
    adoptContext(undefined);
    setRun(undefined);
    setRunMetadata(undefined);
    setTerminalContext(undefined);
    setLink(undefined);
    setTerminal(undefined);
    setDocument(emptyRunConfigs());
    setSuggestions([]);
    setSelectedId(undefined);
    setTool(undefined);
    setError(undefined);
    setEditing(false);
    if (!native()) return;
    if (!session) {
      if (previous) void invoke("execution_stop_all", { context: previous }).catch(report);
      return;
    }
    return () => operation.current?.abort();
  }, [session?.id, session?.path, report, adoptContext]);
  useEffect(() => {
    const abort = new AbortController();
    // Every explicit native scan invalidates execution consent, including a
    // same-path reindex. Preserve owned cleanup snapshots, but admit no input,
    // probe, save preparation or launch until current readiness rebinds consent.
    if (!native() || !session) return;
    if (indexing?.sessionId === session.id) {
      operation.current?.abort();
      revocationEpoch.current += 1;
      const owner = currentContext.current;
      if (owner) adoptContext({ ...owner, trusted: false });
      return;
    }
    if (currentContext.current?.generation === session.id && !indexingAdmissionSuspended.current)
      return;
    void (async () => {
      const bound = await executionConfigService.bind(session.path, session.id);
      if (abort.signal.aborted) return;
      const [saved, proposed] = await Promise.all([
        executionConfigService.read(bound),
        executionConfigService.suggestions(bound).then(
          (items) => ({ items, warning: undefined as string | undefined }),
          (value) => ({
            items: [] as RunSuggestion[],
            warning: `Run suggestions unavailable: ${reason(value)} Add or edit a manual configuration in Run settings.`,
          }),
        ),
      ]);
      if (abort.signal.aborted) return;
      indexingAdmissionSuspended.current = false;
      adoptContext(bound);
      setError(proposed.warning);
      setDocument(saved);
      setSelectedId(saved.defaultId ?? undefined);
      setSuggestions(proposed.items);
    })().catch((value) => {
      if (!abort.signal.aborted) report(value);
    });
    return () => {
      abort.abort();
    };
  }, [session?.id, session?.path, indexing?.sessionId, indexing?.jobId, report, adoptContext]);
  const update = useCallback(
    (value: ExecutionSnapshot, owner: ExecutionContext) => {
      if (!ownsContext(owner)) return;
      (value.kind === "run" ? setRun : setTerminal)((previous) =>
        mergeExecutionSnapshot(previous, value),
      );
    },
    [ownsContext],
  );
  useEffect(() => {
    if (!context) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        for (const snapshot of [run, terminal]) {
          if (!snapshot || (snapshot.cleanupConfirmed && snapshot.outputComplete) || cancelled)
            continue;
          const latest = await executionAdapter.poll(context, snapshot.id, snapshot.sequence);
          if (!cancelled) update(latest, context);
        }
      } catch (value) {
        if (!cancelled) report(value);
      }
      if (!cancelled)
        timer = setTimeout(() => {
          void tick();
        }, 120);
    };
    timer = setTimeout(() => {
      void tick();
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [context, run, terminal, update, report]);
  const act = async (label: string, action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setPending(label);
    setError(undefined);
    const owner = currentContext.current;
    const epoch = revocationEpoch.current;
    try {
      await action();
    } catch (value) {
      if (epoch === revocationEpoch.current && (!owner || ownsContext(owner))) {
        report(value);
        if (owner && !indexingAdmissionSuspended.current) {
          try {
            const refreshed = await executionConfigService.bind(owner.repoPath, owner.generation);
            if (epoch === revocationEpoch.current && ownsContext(owner)) adoptContext(refreshed);
          } catch {
            /* keep original failure visible */
          }
        }
      }
    } finally {
      lock.current = false;
      setPending(undefined);
    }
  };
  const revokeTrust = async (captured: ExecutionContext) => {
    if (!ownsContext(captured) || revokeLock.current) return;
    const owner = currentContext.current!;
    revokeLock.current = true;
    setRevoking(true);
    const epoch = ++revocationEpoch.current;
    operation.current?.abort();
    revokedOwners.current.add(consentOwner(owner));
    adoptContext({ ...owner, trusted: false });
    setLink(undefined);
    setTool(undefined);
    try {
      const updated = await executionConfigService.setTrust(owner, false);
      if (!ownsContext(owner) || epoch !== revocationEpoch.current) return;
      if (
        !sameContext(updated, owner) ||
        updated.trusted ||
        updated.trustRevision <= owner.trustRevision ||
        updated.trustRevision < (currentContext.current?.trustRevision ?? 0)
      )
        throw new Error("Revocation confirmation changed. Retry revocation and cleanup.");
      adoptContext(updated);
      revocationFailure.current = undefined;
      setError(undefined);
    } catch (value) {
      if (!ownsContext(owner) || epoch !== revocationEpoch.current) return;
      revocationFailure.current = { owner: consentOwner(owner), message: reason(value) };
      setError(reason(value));
      try {
        if (indexingAdmissionSuspended.current) return;
        const refreshed = await executionConfigService.bind(owner.repoPath, owner.generation);
        if (ownsContext(owner) && epoch === revocationEpoch.current) adoptContext(refreshed);
      } catch {
        // Neither a failed refresh nor trusted native metadata confirms cleanup.
        // Keep the local refusal and require an explicit false retry.
      }
    } finally {
      revokeLock.current = false;
      setRevoking(false);
    }
  };
  const grantTrust = async (owner: ExecutionContext) => {
    if (
      !ownsContext(owner) ||
      owner.trusted ||
      currentContext.current?.trustRevision !== owner.trustRevision ||
      revokeLock.current ||
      indexingAdmissionSuspended.current ||
      useUiStore.getState().indexingSession?.sessionId === owner.generation ||
      revocationFailure.current?.owner === consentOwner(owner)
    )
      return;
    const epoch = revocationEpoch.current;
    const updated = await executionConfigService.setTrust(owner, true);
    if (!ownsContext(owner) || epoch !== revocationEpoch.current) return;
    if (
      !sameContext(updated, owner) ||
      !updated.trusted ||
      currentContext.current?.trustRevision !== owner.trustRevision ||
      updated.trustRevision <= owner.trustRevision
    )
      throw new Error(
        "Execution consent changed. Review this project before granting trust again.",
      );
    revokedOwners.current.delete(consentOwner(owner));
    adoptContext(updated);
  };
  const startRun = async (restart = false) => {
    if (!context || !session || !selected)
      throw new Error("Choose a saved run configuration first.");
    if (!trustedOwner(context))
      throw new Error("Execution consent changed. Trust this project explicitly before Run.");
    if (restart && run && active(run)) {
      const stopped = await executionAdapter.stop(context, run.id);
      update(stopped, context);
      if (!stopped.cleanupConfirmed)
        throw new Error("Prior run cleanup is unconfirmed. Restart is blocked.");
      if (!trustedOwner(context))
        throw new Error(
          "Execution consent changed while stopping the prior run. Restart was canceled.",
        );
    }
    const abort = new AbortController();
    operation.current = abort;
    setTab("run");
    setShown(true);
    const receipt = await prepareWorkspaceToRun(
      session.path,
      session.id,
      () => invoke<PreparedSource>("prepare_run_source", { context }),
      abort.signal,
    );
    if (abort.signal.aborted) throw new Error("Run preparation canceled. No launch was admitted.");
    if (!trustedOwner(context)) throw new Error("Execution consent changed during preparation.");
    assertWorkspacePreparationCurrent(receipt);
    const started = await executionAdapter.startRun(
      context,
      structuredClone(selected),
      receipt.preparedSource,
    );
    if (trustedOwner(context)) {
      setRunMetadata({
        id: started.id,
        context: structuredClone(context),
        cwd: /^(?:[A-Za-z]:[\\/]|[\\/])/.test(selected.cwd)
          ? selected.cwd
          : `${context.repoPath}/${selected.cwd}`,
        preparedSource: receipt.preparedSource,
        configName: selected.name,
      });
      update(started, context);
    }
  };
  const stopRun = async () => {
    if (stopLock.current || !context || !ownsContext(context)) return;
    stopLock.current = true;
    operation.current?.abort();
    const owner = currentContext.current;
    try {
      if (owner && pending) {
        const refreshed = await invoke<ExecutionContext>("execution_cancel_run", {
          context: owner,
        });
        if (ownsContext(owner)) {
          const adopted = adoptContext(refreshed);
          if (adopted && terminalContext?.contextId === owner.contextId)
            setTerminalContext(adopted);
        }
        return;
      }
      if (owner && run && active(run)) update(await executionAdapter.stop(owner, run.id), owner);
    } catch (value) {
      // A retired reply must not rebind native ownership to its old generation.
      if (!owner || !ownsContext(owner)) return;
      if (owner && !indexingAdmissionSuspended.current) {
        try {
          const fresh = await executionConfigService.bind(owner.repoPath, owner.generation);
          if (ownsContext(owner)) adoptContext(fresh);
        } catch {
          /* original failure retained */
        }
      }
      throw value;
    } finally {
      stopLock.current = false;
    }
  };
  const stopTerminal = async () => {
    const owner = currentContext.current;
    if (
      stopLock.current ||
      !owner ||
      !terminal ||
      !active(terminal) ||
      !terminalContext ||
      !ownsContext(terminalContext)
    )
      return;
    stopLock.current = true;
    try {
      update(await executionAdapter.stop(owner, terminal.id), owner);
    } catch (value) {
      if (ownsContext(owner)) throw value;
    } finally {
      stopLock.current = false;
    }
  };
  useEffect(() => {
    useExecutionActions.setState({
      configName: selected?.name,
      canRun: Boolean(native() && context?.trusted && selected && !pending && !active(run)),
      canStop: Boolean(pending || active(run)),
      canRestart: Boolean(
        native() && context?.trusted && selected && !pending && run?.state !== "cleanup-unknown",
      ),
      run: () => {
        void act("Preparing", () => startRun());
      },
      stop: () => {
        void stopRun().catch(report);
      },
      restart: () => {
        void act("Restarting", () => startRun(true));
      },
      show: () => setShown(true),
    });
    return resetExecutionActions;
  });
  useEffect(() => {
    if (!native()) return;
    let disposed = false;
    let detach: (() => void) | undefined;
    void listen<string>("helm://execution-cleanup-error", (event) => {
      report(event.payload);
      setShown(true);
      const owner = currentContext.current;
      if (owner && ownsContext(owner) && !indexingAdmissionSuspended.current)
        void executionConfigService
          .bind(owner.repoPath, owner.generation)
          .then((fresh) => {
            if (ownsContext(owner)) adoptContext(fresh);
          })
          .catch(() => {});
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else detach = unlisten;
      })
      .catch(report);
    return () => {
      disposed = true;
      detach?.();
    };
  }, [ownsContext, report, adoptContext]);
  const activateLink = (url: string) => {
    const owner = terminalContext;
    if (owner && trustedOwner(owner)) setLink({ context: owner, url });
  };
  const setPaneWidth = (value: number) => {
    const next = Math.max(300, Math.min(layout.maximumWidth, value));
    setWidth(next);
    try {
      localStorage.setItem("helm.execution.width", String(next));
    } catch {
      /* visual preference only */
    }
  };
  const resizePointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    resizeCleanup.current?.();
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const origin = event.clientX;
    const before = layout.width;
    const move = (value: PointerEvent) => setPaneWidth(before + origin - value.clientX);
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      resizeCleanup.current = undefined;
    };
    resizeCleanup.current = finish;
    window.addEventListener("pointercancel", finish, { once: true });
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
  };
  return (
    <div
      ref={layout.ref}
      className={`execution-workspace${visible ? " execution-workspace--sidebar-open" : ""}${visible && layout.stacked ? " execution-workspace--stacked" : ""}`}
      style={{ "--execution-width": `${layout.width}px` } as CSSProperties}
    >
      <div className="execution-workspace-main">
        {session && (
          <div className="execution-toolbar" role="toolbar" aria-label="Project execution">
            <select
              aria-label="Run configuration"
              disabled={Boolean(pending)}
              value={selected?.id ?? ""}
              onChange={(event) => {
                setSelectedId(event.target.value);
                setTool(undefined);
              }}
            >
              <option value="" disabled>
                Choose run configuration
              </option>
              {document.configs.map((config) => (
                <option key={config.id} value={config.id}>
                  {config.name}
                  {config.id === document.defaultId ? " (default)" : ""}
                </option>
              ))}
            </select>
            <button
              disabled={
                !native() ||
                !context?.trusted ||
                !selected ||
                Boolean(pending) ||
                Boolean(active(run))
              }
              onClick={() => {
                void act("Preparing", () => startRun());
              }}
            >
              Save and Run
            </button>
            <button
              disabled={!pending && !active(run)}
              onClick={() => {
                void stopRun().catch(report);
              }}
            >
              {run?.state === "cleanup-unknown" ? "Retry run cleanup" : "Stop"}
            </button>
            <button
              disabled={
                !native() ||
                !context?.trusted ||
                !selected ||
                Boolean(pending) ||
                run?.state === "cleanup-unknown"
              }
              onClick={() => {
                void act("Restarting", () => startRun(true));
              }}
            >
              Restart
            </button>
            <button
              disabled={!context || Boolean(pending)}
              onClick={() => {
                setEditing(true);
                setShown(true);
              }}
            >
              Run settings
            </button>
            <button
              aria-expanded={shown}
              aria-controls="execution-sidebar"
              onClick={() => {
                setShown((value) => !value);
                if (shown) panel.current?.blur();
              }}
            >
              {shown ? "Hide terminal / output" : "Terminal / output"}
            </button>
            <span role="status">{pending ?? (run ? executionStatus(run) : "Ready")}</span>
          </div>
        )}
        {children}
      </div>
      <aside
        ref={panel}
        id="execution-sidebar"
        className="execution-sidebar"
        hidden={!visible}
        aria-label="Terminal and Run Output"
      >
        {!layout.stacked && (
          <div
            className="execution-resizer"
            role="separator"
            aria-label="Resize terminal sidebar"
            aria-orientation="vertical"
            aria-valuemin={300}
            aria-valuemax={layout.maximumWidth}
            aria-valuenow={layout.width}
            tabIndex={0}
            onPointerDown={resizePointer}
            onLostPointerCapture={() => resizeCleanup.current?.()}
            onKeyDown={(event) => {
              if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
                event.preventDefault();
                setPaneWidth(
                  event.key === "Home"
                    ? 300
                    : event.key === "End"
                      ? layout.maximumWidth
                      : layout.width + (event.key === "ArrowLeft" ? 20 : -20),
                );
              }
            }}
          />
        )}
        <div className="execution-panel-body">
          {!native() ? (
            <p>Project execution is available in the native desktop app.</p>
          ) : (
            context && (
              <div className="execution-trust">
                <span>
                  {context.trusted
                    ? "Trusted for this session"
                    : "Project execution is disabled until trusted."}
                </span>
                <p>
                  Trust allows this project and its shell to run code with your user permissions. It
                  is not a sandbox.
                </p>
                <button
                  disabled={
                    revoking ||
                    (!(
                      context.trusted || revocationFailure.current?.owner === consentOwner(context)
                    ) &&
                      (Boolean(pending) || indexingAdmissionSuspended.current))
                  }
                  onClick={() => {
                    if (
                      context.trusted ||
                      revocationFailure.current?.owner === consentOwner(context)
                    )
                      void revokeTrust(context);
                    else void act("Updating trust", () => grantTrust(context));
                  }}
                >
                  {context.trusted
                    ? "Revoke trust and stop work"
                    : revocationFailure.current?.owner === consentOwner(context)
                      ? "Retry revocation and cleanup"
                      : "Trust this project for this session"}
                </button>
              </div>
            )
          )}
          {link && (
            <div className="execution-link-preview">
              <p>
                Browser destination: <code>{link.url}</code>
              </p>
              <button
                disabled={!validateLoopbackUrl(link.url).ok || !trustedOwner(link.context)}
                onClick={() => {
                  if (!trustedOwner(link.context)) return;
                  void invoke("execution_open_loopback", { context: link.context, url: link.url })
                    .then(() => setLink(undefined))
                    .catch(report);
                }}
              >
                Open in browser
              </button>
              <button onClick={() => setLink(undefined)}>Cancel</button>
              {!validateLoopbackUrl(link.url).ok && <p>Only validated localhost links can open.</p>}
            </div>
          )}
          {error && (
            <p role="alert" className="execution-error">
              {error}
            </p>
          )}
          {editing && context ? (
            <RunConfigEditor
              key={context.contextId}
              document={document}
              suggestions={suggestions}
              trusted={context.trusted}
              onClose={() => setEditing(false)}
              onSave={async (next) => {
                const saved = await executionConfigService.save(context, next);
                if (!ownsContext(context)) return;
                setDocument(saved);
                setSelectedId(saved.defaultId ?? undefined);
              }}
              onSecrets={(configId, values) =>
                executionConfigService.setSecrets(context, configId, values)
              }
              onImportEnv={(configId, relativePath) =>
                invoke<string[]>("execution_import_env", { context, configId, relativePath })
              }
            />
          ) : null}
          <div className="execution-preserved-views" hidden={editing}>
            <div
              className="execution-tabs"
              role="tablist"
              aria-label="Execution views"
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                  event.preventDefault();
                  const next = tab === "run" ? "terminal" : "run";
                  setTab(next);
                  window.document.getElementById(`execution-${next}-tab`)?.focus();
                }
              }}
            >
              <button
                id="execution-terminal-tab"
                role="tab"
                aria-selected={tab === "terminal"}
                aria-controls="execution-terminal-panel"
                tabIndex={tab === "terminal" ? 0 : -1}
                onClick={() => setTab("terminal")}
              >
                Terminal
              </button>
              <button
                id="execution-run-tab"
                role="tab"
                aria-selected={tab === "run"}
                aria-controls="execution-run-panel"
                tabIndex={tab === "run" ? 0 : -1}
                onClick={() => setTab("run")}
              >
                Run Output
              </button>
            </div>
            <div
              id="execution-terminal-panel"
              role="tabpanel"
              aria-labelledby="execution-terminal-tab"
              hidden={tab !== "terminal"}
              className="execution-tab-panel"
            >
              <label>
                Shell executable (blank uses system default)
                <input
                  aria-label="Terminal shell executable"
                  value={terminalExecutable}
                  onChange={(event) => setTerminalExecutable(event.target.value)}
                  disabled={Boolean(active(terminal))}
                  placeholder="System shell"
                />
              </label>
              <div className="execution-actions">
                <button
                  disabled={!context?.trusted || Boolean(pending) || Boolean(active(terminal))}
                  onClick={() => {
                    void act("Starting terminal", async () => {
                      if (context) {
                        if (!trustedOwner(context))
                          throw new Error(
                            "Execution consent changed. Trust this project explicitly before starting a terminal.",
                          );
                        const started = await executionAdapter.startTerminal(
                          context,
                          24,
                          80,
                          terminalExecutable || undefined,
                        );
                        if (trustedOwner(context)) {
                          setTerminalContext(structuredClone(context));
                          update(started, context);
                        }
                      }
                    });
                  }}
                >
                  Start terminal
                </button>
                <button
                  disabled={!active(terminal)}
                  onClick={() => {
                    void stopTerminal().catch(report);
                  }}
                >
                  {terminal?.state === "cleanup-unknown"
                    ? "Retry terminal cleanup"
                    : "Close session"}
                </button>
                <span>{terminal ? executionStatus(terminal) : "No shell started"}</span>
              </div>
              {terminal?.state === "cleanup-unknown" && (
                <p role="alert">
                  {terminal.cleanupError} · owned PID {terminal.ownedPid ?? "unavailable"}.{" "}
                  {terminal.cleanupRecovery}
                </p>
              )}
              {terminal && terminalContext?.generation === session?.id ? (
                <ExecutionRendererBoundary key={terminal.id}>
                  <Suspense fallback={<p>Loading terminal…</p>}>
                    <TerminalView
                      key={context?.contextId ?? session?.id ?? "no-workspace"}
                      snapshot={terminal}
                      visible={shown && tab === "terminal"}
                      onInput={async (data) => {
                        if (context && trustedOwner(context) && terminal && active(terminal))
                          await executionAdapter.write(context, terminal.id, data);
                      }}
                      onResize={async (rows, cols) => {
                        if (context && trustedOwner(context) && terminal && active(terminal))
                          await executionAdapter.resize(context, terminal.id, rows, cols);
                      }}
                      onLink={activateLink}
                      onError={report}
                    />
                  </Suspense>
                </ExecutionRendererBoundary>
              ) : (
                <p>No interactive shell has been started.</p>
              )}
            </div>
            <div
              id="execution-run-panel"
              role="tabpanel"
              aria-labelledby="execution-run-tab"
              hidden={tab !== "run"}
              className="execution-tab-panel"
            >
              <div className="execution-actions">
                <button
                  disabled={!selected || !context?.trusted || Boolean(pending)}
                  onClick={() => {
                    void act("Discovering runtime", async () => {
                      if (context && selected) {
                        if (!trustedOwner(context))
                          throw new Error(
                            "Execution consent changed. Trust this project explicitly before discovering a runtime.",
                          );
                        const resolved = await executionConfigService.resolveTool(
                          context,
                          selected,
                        );
                        if (trustedOwner(context)) setTool(resolved);
                      }
                    });
                  }}
                >
                  Discover runtime
                </button>
                <button
                  disabled={
                    !selected ||
                    selected.mode !== "executable" ||
                    !context?.trusted ||
                    Boolean(pending)
                  }
                  onClick={() => {
                    void act("Probing version", async () => {
                      if (!context || !selected) return;
                      if (!trustedOwner(context))
                        throw new Error(
                          "Execution consent changed. Trust this project explicitly before probing a runtime.",
                        );
                      const result = await invoke<{
                        tool: ToolInfo;
                        outcome: string;
                        output: string;
                        exitCode: number | null;
                      }>("execution_probe_tool", { context, config: selected });
                      if (trustedOwner(context)) {
                        setTool({
                          ...result.tool,
                          version:
                            result.outcome === "available"
                              ? result.output
                              : `${result.outcome} (exit ${result.exitCode ?? "unknown"})`,
                        });
                        if (result.outcome !== "available")
                          throw new Error(
                            `Version probe ${result.outcome}. Choose an executable or inspect its dependencies.`,
                          );
                      }
                    });
                  }}
                >
                  Probe version
                </button>
                <button disabled={Boolean(active(run))} onClick={() => setRun(undefined)}>
                  Clear output
                </button>
              </div>
              {tool && (
                <p className="execution-runtime">
                  {tool.path}
                  <br />
                  {tool.provenance} · {tool.architecture} · {tool.version ?? "version not probed"}
                </p>
              )}
              {runMetadata?.id === run?.id && (
                <p>
                  {runMetadata?.configName} · {run?.id}
                </p>
              )}
              {run?.state === "cleanup-unknown" && (
                <p role="alert">
                  {run.cleanupError} · owned PID {run.ownedPid ?? "unavailable"}.{" "}
                  {run.cleanupRecovery}
                </p>
              )}
              {run?.truncated && (
                <p role="status">Earlier output was truncated to keep controls responsive.</p>
              )}
              {run && runMetadata?.id === run.id && (
                <RunOutputNavigation
                  key={run.id}
                  snapshot={run}
                  context={runMetadata.context}
                  cwd={runMetadata.cwd}
                  preparedSource={runMetadata.preparedSource}
                  canActivateBrowser={() => trustedOwner(runMetadata.context)}
                  onError={report}
                />
              )}
              <pre className="execution-output" tabIndex={0} aria-label="Configured run output">
                {output || "Save and Run starts the selected configuration after preparation."}
              </pre>
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}
