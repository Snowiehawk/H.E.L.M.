import { invoke } from "@tauri-apps/api/core";
import type {
  ExecutionContext,
  RunConfig,
  RunConfigDocument,
  RunSuggestion,
  ToolInfo,
} from "./contracts";

/** These commands never execute a project. Resolution only inspects the filesystem. */
export const executionConfigService = {
  bind: (repoPath: string, generation: string) =>
    invoke<ExecutionContext>("execution_bind", { repoPath, generation }),
  setTrust: (context: ExecutionContext, trusted: boolean) =>
    invoke<ExecutionContext>("execution_set_trust", { context, trusted }),
  read: (context: ExecutionContext) =>
    invoke<RunConfigDocument>("execution_read_configs", { context }),
  save: (context: ExecutionContext, document: RunConfigDocument) =>
    invoke<RunConfigDocument>("execution_save_configs", { context, document }),
  setSecrets: (
    context: ExecutionContext,
    configId: string,
    values: Record<string, string | null>,
  ) => invoke<void>("execution_set_secrets", { context, configId, values }),
  importEnv: (context: ExecutionContext, configId: string, relativePath: string) =>
    invoke<string[]>("execution_import_env", { context, configId, relativePath }),
  suggestions: (context: ExecutionContext) =>
    invoke<RunSuggestion[]>("execution_suggestions", { context }),
  resolveTool: (context: ExecutionContext, config: RunConfig) =>
    invoke<ToolInfo>("execution_resolve_tool", { context, config }),
};
