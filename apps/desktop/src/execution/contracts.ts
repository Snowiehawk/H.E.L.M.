/** Execution is admitted by the native service, never by a renderer boolean. */
export interface ExecutionContext {
  contextId: string;
  repoPath: string;
  generation: string;
  trustRevision: number;
  trusted: boolean;
}
export interface RunConfig {
  id: string;
  name: string;
  kind: "app" | "tests" | "build";
  mode: "executable" | "shell";
  executable: string;
  args: string[];
  command: string;
  cwd: string;
  /** Nonsecret overrides. null removes an inherited value. */
  env: Record<string, string | null>;
  /** Values live in native session memory and are never returned by IPC. */
  secretNames: string[];
}
export interface RunConfigDocument {
  schemaVersion: 1;
  revision: number;
  defaultId: string | null;
  configs: RunConfig[];
}
export interface ToolInfo {
  path: string;
  provenance: "selected-path" | "project-venv" | "system-search" | "system-shell";
  architecture: string;
  version: string | null;
  searchPathSource: string;
}
export interface RunSuggestion {
  source: string;
  config: RunConfig;
}
export const emptyRunConfigs = (): RunConfigDocument => ({
  schemaVersion: 1,
  revision: 0,
  defaultId: null,
  configs: [],
});
export const newRunConfig = (id: string): RunConfig => ({
  id,
  name: "App",
  kind: "app",
  mode: "executable",
  executable: "",
  args: [],
  command: "",
  cwd: ".",
  env: {},
  secretNames: [],
});
