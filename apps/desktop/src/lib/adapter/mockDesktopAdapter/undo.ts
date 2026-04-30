import type { BackendUndoTransaction, StructuralEditResult } from "../contracts";
import {
  buildRepoSession,
  defaultRepoPath,
  type MockWorkspaceState,
} from "../../mocks/mockData/state";

export function cloneWorkspaceState(state: MockWorkspaceState): MockWorkspaceState {
  return JSON.parse(JSON.stringify(state)) as MockWorkspaceState;
}

export function cloneBackendUndoTransaction(
  transaction: BackendUndoTransaction,
): BackendUndoTransaction {
  return JSON.parse(JSON.stringify(transaction)) as BackendUndoTransaction;
}

export function backendUndoTransactionsEqual(
  left: BackendUndoTransaction,
  right: BackendUndoTransaction,
) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function buildMockUndoTransaction(result: StructuralEditResult): BackendUndoTransaction {
  return {
    summary: result.summary,
    requestKind: result.request.kind,
    fileSnapshots: result.touchedRelativePaths.map((relativePath) => ({
      relativePath,
      existed: true,
      content: "",
    })),
    changedNodeIds: result.changedNodeIds,
    focusTarget: inferMockUndoFocusTarget(result),
  };
}

export function buildMockWorkspaceUndoTransaction(
  summary: string,
  requestKind: BackendUndoTransaction["requestKind"],
  touchedRelativePaths: string[],
): BackendUndoTransaction {
  return {
    summary,
    requestKind,
    fileSnapshots: touchedRelativePaths.map((relativePath) => ({
      relativePath,
      existed: true,
      content: "",
    })),
    changedNodeIds: [],
    touchedRelativePaths,
  };
}

export function inferMockUndoFocusTarget(
  result: StructuralEditResult,
): BackendUndoTransaction["focusTarget"] {
  if (result.request.kind === "create_module") {
    return {
      targetId: buildRepoSession(defaultRepoPath).id,
      level: "repo",
    };
  }

  if (
    result.request.kind === "create_symbol" ||
    result.request.kind === "add_import" ||
    result.request.kind === "remove_import" ||
    result.request.kind === "replace_module_source"
  ) {
    const relativePath = result.request.relative_path ?? result.touchedRelativePaths[0];
    const moduleName = relativePath ? mockModuleNameForFocusPath(relativePath) : "helm.ui.api";
    return {
      targetId: `module:${moduleName}`,
      level: "module",
    };
  }

  if (
    result.request.kind === "insert_flow_statement" ||
    result.request.kind === "replace_flow_graph"
  ) {
    return result.request.target_id
      ? {
          targetId: result.request.target_id,
          level: "flow",
        }
      : undefined;
  }

  return result.request.target_id
    ? {
        targetId: result.request.target_id,
        level: "symbol",
      }
    : undefined;
}

function mockModuleNameForFocusPath(relativePath: string) {
  switch (relativePath) {
    case "src/helm/cli.py":
      return "helm.cli";
    case "src/helm/ui/api.py":
      return "helm.ui.api";
    case "src/helm/graph/models.py":
      return "helm.graph.models";
    default:
      return relativePath.replace(/\.py$/, "").replaceAll("/", ".");
  }
}
