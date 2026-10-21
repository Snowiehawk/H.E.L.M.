import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  newRunConfig,
  type RunConfig,
  type RunConfigDocument,
  type RunSuggestion,
} from "./contracts";
import {
  assertConfigurationDraftAdmission,
  registerConfigurationDraftOwner,
} from "./configurationDrafts";

export interface RunConfigEditorProps {
  document: RunConfigDocument;
  suggestions: RunSuggestion[];
  trusted: boolean;
  onSave: (document: RunConfigDocument) => Promise<void>;
  onSecrets: (configId: string, values: Record<string, string | null>) => Promise<void>;
  onClose: () => void;
  onImportEnv?: (configId: string, relativePath: string) => Promise<string[]>;
}
interface ConfigDraft {
  config: RunConfig;
  args: string;
  env: string;
  secrets: string;
}
function draftFor(config: RunConfig): ConfigDraft {
  return {
    config: {
      ...config,
      args: [...config.args],
      env: { ...config.env },
      secretNames: [...config.secretNames],
    },
    args: JSON.stringify(config.args),
    env: JSON.stringify(config.env, null, 2),
    secrets: config.secretNames.join("\n"),
  };
}
const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;
function validateDraft(draft: ConfigDraft): RunConfig {
  const config = { ...draft.config, name: draft.config.name.trim() };
  if (!config.name || config.name.length > 128)
    throw new Error("Name must contain 1–128 characters.");
  if (!config.cwd.trim() || /[\0\r\n]/.test(config.cwd))
    throw new Error(
      `${config.name}: working directory is required and cannot contain control characters.`,
    );
  if (
    config.mode === "executable" &&
    (!config.executable.trim() || /[\0\r\n]/.test(config.executable))
  )
    throw new Error(`${config.name}: choose an executable or interpreter path.`);
  if (config.mode === "shell" && (!config.command.trim() || config.command.includes("\0")))
    throw new Error(`${config.name}: enter the shell command explicitly.`);
  let args: unknown;
  let env: unknown;
  try {
    args = JSON.parse(draft.args);
  } catch {
    throw new Error(
      `${config.name}: arguments must be a JSON array of strings, for example ["main.py", "two words"].`,
    );
  }
  if (
    !Array.isArray(args) ||
    args.some((value) => typeof value !== "string" || value.includes("\0"))
  )
    throw new Error(
      `${config.name}: arguments must be a JSON array of strings without null bytes.`,
    );
  try {
    env = JSON.parse(draft.env);
  } catch {
    throw new Error(
      `${config.name}: environment must be a JSON object of nonsecret strings or null.`,
    );
  }
  if (
    !env ||
    Array.isArray(env) ||
    typeof env !== "object" ||
    Object.entries(env).some(
      ([key, value]) =>
        !envName.test(key) ||
        (value !== null && (typeof value !== "string" || value.includes("\0"))),
    )
  )
    throw new Error(
      `${config.name}: environment names must be valid variable names and values must be strings or null.`,
    );
  const secretNames = draft.secrets
    .split(/[\r\n,]+/)
    .map((name) => name.trim())
    .filter(Boolean);
  if (
    new Set(secretNames.map((name) => name.toUpperCase())).size !== secretNames.length ||
    secretNames.some((name) => !envName.test(name))
  )
    throw new Error(
      `${config.name}: private variable names must be unique valid environment names.`,
    );
  const environmentNames = Object.keys(env);
  if (new Set(environmentNames.map((name) => name.toUpperCase())).size !== environmentNames.length)
    throw new Error(`${config.name}: environment names must be unique, including letter case.`);
  if (
    secretNames.some((name) =>
      environmentNames.some((key) => key.toUpperCase() === name.toUpperCase()),
    )
  )
    throw new Error(`${config.name}: a private variable cannot also have a nonsecret override.`);
  return {
    ...config,
    executable: config.executable.trim(),
    cwd: config.cwd.trim(),
    args: args as string[],
    env: env as Record<string, string | null>,
    secretNames,
  };
}
function nextId() {
  return `run-${crypto.randomUUID()}`;
}

/** Passive editor: saving never starts a project process or installs a dependency. */
export function RunConfigEditor({
  document,
  suggestions,
  trusted,
  onSave,
  onSecrets,
  onClose,
  onImportEnv,
}: RunConfigEditorProps) {
  const [drafts, setDrafts] = useState<ConfigDraft[]>(() => document.configs.map(draftFor));
  const [defaultId, setDefaultId] = useState(document.defaultId);
  const [selectedId, setSelectedId] = useState(document.defaultId ?? document.configs[0]?.id);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [privateValues, setPrivateValues] = useState<Record<string, string>>({});
  const [importPath, setImportPath] = useState(".env");
  const nameRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef(true);
  const revision = useRef(document.revision);
  const previousFocus = useRef<HTMLElement | null>(null);
  const owner = useRef<ReturnType<typeof registerConfigurationDraftOwner>>();
  const draftState = useRef({ configuration: false, privateValues: false, importPath: false });
  const busyRef = useRef(false);
  const editRevision = useRef(0);
  const current = useRef({ trusted, documentRevision: document.revision });
  current.current = { trusted, documentRevision: document.revision };
  function publish() {
    owner.current?.update({
      available: current.current.documentRevision === revision.current,
      dirty: Object.values(draftState.current).some(Boolean),
      busy: busyRef.current,
    });
  }
  function edited(kind?: keyof typeof draftState.current) {
    if (kind) draftState.current[kind] = true;
    editRevision.current += 1;
    // Preserve even programmatic/ref edits while installation is frozen. The
    // changed epoch makes the installer's final passive validation refuse.
    publish();
  }
  useLayoutEffect(() => {
    activeRef.current = true;
    owner.current = registerConfigurationDraftOwner({
      available: current.current.documentRevision === revision.current,
      dirty: Object.values(draftState.current).some(Boolean),
      busy: busyRef.current,
    });
    return () => {
      activeRef.current = false;
      owner.current?.unregister();
      owner.current = undefined;
    };
  }, []);
  useLayoutEffect(() => {
    publish();
  }, [document.revision]);
  useEffect(() => {
    previousFocus.current =
      window.document.activeElement instanceof HTMLElement ? window.document.activeElement : null;
    nameRef.current?.focus();
    return () => {
      previousFocus.current?.focus();
    };
  }, []);
  useEffect(() => {
    if (!trusted) {
      setPrivateValues({});
      // Trust revocation must clear sensitive buffers, but it is not the user's
      // Save/Cancel decision for an unresolved editor draft.
      draftState.current.configuration ||= draftState.current.privateValues;
      draftState.current.privateValues = false;
      edited();
    }
  }, [trusted]);
  const selected = drafts.find((draft) => draft.config.id === selectedId);
  const saved = document.configs.find((config) => config.id === selectedId);
  const changedRemotely = document.revision !== revision.current;
  function update(patch: Partial<ConfigDraft>, configPatch: Partial<RunConfig> = {}) {
    edited("configuration");
    setDrafts((current) =>
      current.map((draft) =>
        draft.config.id === selectedId
          ? { ...draft, ...patch, config: { ...draft.config, ...configPatch } }
          : draft,
      ),
    );
    setError(undefined);
    setNotice(undefined);
  }
  function select(id: string) {
    draftState.current.configuration ||= draftState.current.privateValues;
    draftState.current.privateValues = false;
    edited();
    setSelectedId(id);
    setPrivateValues({});
    setError(undefined);
    setNotice(undefined);
  }
  function add(config: RunConfig) {
    edited("configuration");
    const copy = { ...config, id: nextId() };
    setDrafts((current) => [...current, draftFor(copy)]);
    select(copy.id);
  }
  function close() {
    if (busyRef.current) return;
    setPrivateValues({});
    draftState.current = { configuration: false, privateValues: false, importPath: false };
    edited();
    onClose();
  }
  function beginOperation() {
    if (busyRef.current || !activeRef.current) return undefined;
    assertConfigurationDraftAdmission();
    if (current.current.documentRevision !== revision.current)
      throw new Error("Run settings changed elsewhere. Cancel and reopen before saving.");
    busyRef.current = true;
    publish();
    setBusy(true);
    return { revision: editRevision.current, documentRevision: current.current.documentRevision };
  }
  function assertOperationCurrent(
    operation: { revision: number; documentRevision: number },
    privateOperation = false,
  ) {
    assertConfigurationDraftAdmission();
    if (
      !activeRef.current ||
      editRevision.current !== operation.revision ||
      (privateOperation &&
        (!current.current.trusted ||
          current.current.documentRevision !== operation.documentRevision))
    )
      throw new Error(
        "Run settings changed during the operation. Review the retained draft and retry.",
      );
  }
  function finishOperation() {
    if (!busyRef.current) return;
    busyRef.current = false;
    publish();
    if (activeRef.current) setBusy(false);
  }
  async function save() {
    if (busyRef.current) return;
    setError(undefined);
    if (changedRemotely) {
      setError(
        "Run settings changed elsewhere. Cancel and reopen the editor to review the latest settings; this draft has been preserved.",
      );
      return;
    }
    try {
      const configs = drafts.map(validateDraft);
      if (defaultId !== null && !configs.some((config) => config.id === defaultId))
        throw new Error("Choose a default configuration or No default.");
      const operation = beginOperation();
      if (!operation) return;
      await onSave({ schemaVersion: 1, revision: revision.current, defaultId, configs });
      assertOperationCurrent(operation);
      finishOperation();
      close();
    } catch (reason) {
      if (activeRef.current)
        setError(
          reason instanceof Error
            ? reason.message
            : "Run settings could not be saved. Your draft is retained.",
        );
    } finally {
      finishOperation();
    }
  }
  async function savePrivate(clear = false) {
    if (!saved || !trusted || busyRef.current) return;
    setError(undefined);
    setNotice(undefined);
    const values: Record<string, string | null> = Object.create(null);
    for (const key of saved.secretNames) {
      if (clear) values[key] = null;
      else if (Object.prototype.hasOwnProperty.call(privateValues, key))
        values[key] = privateValues[key];
    }
    try {
      const operation = beginOperation();
      if (!operation) return;
      await onSecrets(saved.id, values);
      assertOperationCurrent(operation, true);
      setPrivateValues({});
      draftState.current.privateValues = false;
      edited();
      setNotice(
        clear
          ? "Private values cleared for this configuration."
          : "Private values updated for this session.",
      );
    } catch {
      if (activeRef.current)
        setError(
          "Private values could not be updated. Review project trust and retry; no values are shown in errors.",
        );
    } finally {
      finishOperation();
    }
  }
  async function importPrivateEnv() {
    if (!saved || !trusted || !onImportEnv || busyRef.current) return;
    if (!importPath.trim() || /[\0\r\n]/.test(importPath)) {
      setError("Choose a private environment file inside this checkout.");
      return;
    }
    setError(undefined);
    setNotice(undefined);
    try {
      const operation = beginOperation();
      if (!operation) return;
      const names = await onImportEnv(saved.id, importPath.trim());
      assertOperationCurrent(operation, true);
      if (activeRef.current) {
        edited("configuration");
        setDrafts((current) =>
          current.map((draft) =>
            draft.config.id === saved.id
              ? {
                  ...draft,
                  secrets: [
                    ...new Map(
                      [
                        ...draft.secrets
                          .split(/[\r\n,]+/)
                          .map((name) => name.trim())
                          .filter(Boolean),
                        ...names,
                      ].map((name) => [name.toUpperCase(), name]),
                    ).values(),
                  ].join("\n"),
                }
              : draft,
          ),
        );
        setNotice(
          `Imported ${names.length} private variable name(s) for this session. Save configurations to retain the names; values stay in memory.`,
        );
      }
    } catch {
      if (activeRef.current)
        setError(
          "The private environment file could not be imported. Check its path, literal NAME=value syntax and project trust. Your existing configuration remains available.",
        );
    } finally {
      finishOperation();
    }
  }
  return (
    <section
      className="execution-config-editor"
      aria-label="Run configuration editor"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busyRef.current) {
          event.preventDefault();
          close();
        }
      }}
    >
      <h3>Run configurations</h3>
      <p>Settings are saved privately for this checkout. Commands run only when you choose Run.</p>
      {changedRemotely ? (
        <p role="status">Settings changed elsewhere. Cancel and reopen before saving.</p>
      ) : null}
      <div className="execution-config-actions">
        <button type="button" disabled={busy} onClick={() => add(newRunConfig(nextId()))}>
          Add configuration
        </button>
        <button
          type="button"
          disabled={busy || !selected}
          onClick={() => {
            if (!selected) return;
            edited("configuration");
            const id = nextId();
            setDrafts((current) => [
              ...current,
              {
                ...selected,
                config: { ...selected.config, id, name: `${selected.config.name} copy` },
              },
            ]);
            select(id);
          }}
        >
          Duplicate
        </button>
        <button
          type="button"
          disabled={busy || !selected}
          onClick={() => {
            edited("configuration");
            const remaining = drafts.filter((draft) => draft.config.id !== selectedId);
            setDrafts(remaining);
            setSelectedId(remaining[0]?.config.id);
            setPrivateValues({});
            draftState.current.privateValues = false;
            publish();
            if (defaultId === selectedId) setDefaultId(null);
          }}
        >
          Delete configuration
        </button>
      </div>
      <label className="execution-config-field">
        Configuration
        <select
          disabled={busy || !drafts.length}
          value={selectedId ?? ""}
          onChange={(event) => select(event.target.value)}
        >
          {!drafts.length ? <option value="">No configurations</option> : null}
          {drafts.map((draft) => (
            <option key={draft.config.id} value={draft.config.id}>
              {draft.config.name || "Unnamed configuration"}
            </option>
          ))}
        </select>
      </label>
      <label className="execution-config-field">
        Default configuration
        <select
          disabled={busy}
          value={defaultId ?? ""}
          onChange={(event) => {
            edited("configuration");
            setDefaultId(event.target.value || null);
          }}
        >
          <option value="">No default</option>
          {drafts.map((draft) => (
            <option key={draft.config.id} value={draft.config.id}>
              {draft.config.name || "Unnamed configuration"}
            </option>
          ))}
        </select>
      </label>
      {selected ? (
        <fieldset className="execution-config-form" disabled={busy}>
          <legend>Edit {selected.config.name || "configuration"}</legend>
          <label className="execution-config-field">
            Name
            <input
              ref={nameRef}
              maxLength={128}
              value={selected.config.name}
              onChange={(event) => update({}, { name: event.target.value })}
            />
          </label>
          <label className="execution-config-field">
            Kind
            <select
              value={selected.config.kind}
              onChange={(event) => update({}, { kind: event.target.value as RunConfig["kind"] })}
            >
              <option value="app">App</option>
              <option value="tests">Tests</option>
              <option value="build">Build</option>
            </select>
          </label>
          <label className="execution-config-field">
            Command mode
            <select
              value={selected.config.mode}
              onChange={(event) => update({}, { mode: event.target.value as RunConfig["mode"] })}
            >
              <option value="executable">Executable and arguments</option>
              <option value="shell">System shell command</option>
            </select>
          </label>
          {selected.config.mode === "executable" ? (
            <>
              <label className="execution-config-field">
                Executable or interpreter
                <input
                  autoComplete="off"
                  spellCheck={false}
                  value={selected.config.executable}
                  onChange={(event) => update({}, { executable: event.target.value })}
                  placeholder="python3 or an absolute executable path"
                />
              </label>
              <label className="execution-config-field">
                Arguments (JSON array)
                <textarea
                  spellCheck={false}
                  value={selected.args}
                  onChange={(event) => update({ args: event.target.value })}
                />
              </label>
              <p>
                Each array entry is one argument, including paths with spaces. No shell expansion
                occurs.
              </p>
            </>
          ) : (
            <>
              <label className="execution-config-field">
                System shell command
                <textarea
                  spellCheck={false}
                  value={selected.config.command}
                  onChange={(event) => update({}, { command: event.target.value })}
                />
              </label>
              <p>
                This command is interpreted by the system shell. Review repository suggestions
                before saving.
              </p>
            </>
          )}
          <label className="execution-config-field">
            Working directory
            <input
              autoComplete="off"
              spellCheck={false}
              value={selected.config.cwd}
              onChange={(event) => update({}, { cwd: event.target.value })}
            />
          </label>
          <p>Use a directory inside this checkout. A relative path starts at the project root.</p>
          <label className="execution-config-field">
            Nonsecret environment (JSON object)
            <textarea
              spellCheck={false}
              value={selected.env}
              onChange={(event) => update({ env: event.target.value })}
            />
          </label>
          <p>
            Values are stored in settings. Use null to remove an inherited variable. Enter
            credentials below as private session values.
          </p>
          <label className="execution-config-field">
            Private environment names
            <textarea
              spellCheck={false}
              value={selected.secrets}
              onChange={(event) => update({ secrets: event.target.value })}
              placeholder="One variable name per line"
            />
          </label>
          <p>
            Only names are saved. Save new names, reopen settings, then enter their private values.
          </p>
        </fieldset>
      ) : (
        <p>Create a configuration manually or choose an editable suggestion below.</p>
      )}
      {saved?.secretNames.length ? (
        <fieldset disabled={busy || !trusted} className="execution-config-form">
          <legend>Private values for saved {saved.name}</legend>
          <p>
            Kept only in this trusted session. A project can print its own values to output. Blank
            fields leave existing values unchanged until you enter a replacement.
          </p>
          {saved.secretNames.map((name) => (
            <label key={name} className="execution-config-field">
              {name}
              <input
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                value={privateValues[name] ?? ""}
                onChange={(event) => {
                  edited("privateValues");
                  setPrivateValues((values) => ({ ...values, [name]: event.target.value }));
                }}
              />
            </label>
          ))}
          <div className="execution-config-actions">
            <button
              type="button"
              disabled={busy || !trusted || !Object.keys(privateValues).length}
              onClick={() => void savePrivate()}
            >
              Apply private values
            </button>
            <button
              type="button"
              disabled={busy || !trusted}
              onClick={() => void savePrivate(true)}
            >
              Clear private values
            </button>
          </div>
          {!trusted ? <p>Trust this project before setting private values.</p> : null}
        </fieldset>
      ) : null}
      {saved && onImportEnv ? (
        <fieldset disabled={busy || !trusted || changedRemotely} className="execution-config-form">
          <legend>Import private environment</legend>
          <label className="execution-config-field">
            Private .env path (relative to checkout)
            <input
              autoComplete="off"
              spellCheck={false}
              value={importPath}
              onChange={(event) => {
                edited("importPath");
                setImportPath(event.target.value);
              }}
            />
          </label>
          <p>
            Import happens only on this button click. Values stay in session memory and replace
            matching private names for this configuration. Only literal NAME=value syntax is
            supported; no shell expansion or commands.
          </p>
          <button
            type="button"
            disabled={busy || !trusted || changedRemotely}
            onClick={() => void importPrivateEnv()}
          >
            Import private values
          </button>
          {!trusted ? <p>Trust this project before importing private values.</p> : null}
        </fieldset>
      ) : null}
      {suggestions.length ? (
        <details>
          <summary>Editable manifest suggestions ({suggestions.length})</summary>
          <p>Suggestions are passive project data. They never replace your saved commands.</p>
          {suggestions.map((suggestion, index) => (
            <div key={`${suggestion.source}:${index}`}>
              <span>
                {suggestion.config.name} — {suggestion.source}
              </span>
              <button type="button" disabled={busy} onClick={() => add(suggestion.config)}>
                Use suggestion {suggestion.config.name}
              </button>
            </div>
          ))}
        </details>
      ) : (
        <p>
          No supported manifest suggestions. Configure a command manually; dependencies are never
          installed automatically.
        </p>
      )}
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      <div className="execution-config-actions">
        <button type="button" disabled={busy || changedRemotely} onClick={() => void save()}>
          {busy ? "Saving…" : "Save configurations"}
        </button>
        <button type="button" disabled={busy} onClick={close}>
          Cancel
        </button>
      </div>
    </section>
  );
}
