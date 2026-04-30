import type {
  GraphActionDto,
  GraphSymbolNodeKind,
  GraphView,
  SymbolDetails,
} from "../../adapter/contracts";
import { isGraphSymbolNodeKind } from "../../adapter/contracts";
import type { MockWorkspaceState } from "./state";

export function graphSummarySymbolId() {
  return symbolId("helm.ui.api", "GraphSummary");
}

export function graphSummaryRepoPathSymbolId() {
  return symbolId("helm.ui.api", "GraphSummary.repo_path");
}

export function graphSummaryModuleCountSymbolId() {
  return symbolId("helm.ui.api", "GraphSummary.module_count");
}

export function graphSummaryToPayloadSymbolId() {
  return symbolId("helm.ui.api", "GraphSummary.to_payload");
}

export function moduleId(moduleName: string): string {
  return `module:${moduleName}`;
}

export function moduleNameFromRelativePath(relativePath: string): string {
  return relativePath.replace(/\.py$/i, "").split("/").filter(Boolean).join(".");
}

export function moduleNameForMockFile(relativePath: string): string {
  switch (relativePath) {
    case "src/helm/cli.py":
      return "helm.cli";
    case "src/helm/ui/api.py":
      return "helm.ui.api";
    case "src/helm/graph/models.py":
      return "helm.graph.models";
    default:
      return moduleNameFromRelativePath(relativePath);
  }
}

export function parseMockSymbolId(targetId: string) {
  if (!targetId.startsWith("symbol:")) {
    return undefined;
  }

  const parts = targetId.slice("symbol:".length).split(":");
  const moduleName = parts[0];
  const qualname = parts.slice(1).join(":");
  if (!moduleName || !qualname) {
    return undefined;
  }

  return {
    moduleName,
    qualname,
    name: qualname.split(".").pop() ?? qualname,
  };
}

export function symbolId(moduleName: string, qualname: string): string {
  return `symbol:${moduleName}:${qualname}`;
}

export function sourceSpanForTargetId(
  targetId: string,
  state?: MockWorkspaceState,
):
  | {
      startLine: number;
      startColumn: number;
      endLine: number;
      endColumn: number;
    }
  | undefined {
  const primarySymbolId = state
    ? symbolId("helm.ui.api", state.primarySummarySymbolName)
    : undefined;
  switch (targetId) {
    case primarySymbolId:
      return { startLine: 18, startColumn: 0, endLine: 21, endColumn: 82 };
    case graphSummarySymbolId():
      return { startLine: 6, startColumn: 0, endLine: 15, endColumn: 9 };
    case graphSummaryRepoPathSymbolId():
      return { startLine: 8, startColumn: 4, endLine: 8, endColumn: 18 };
    case graphSummaryModuleCountSymbolId():
      return { startLine: 9, startColumn: 4, endLine: 9, endColumn: 21 };
    case graphSummaryToPayloadSymbolId():
      return { startLine: 11, startColumn: 4, endLine: 15, endColumn: 9 };
    case symbolId("helm.ui.api", "build_export_payload"):
      return { startLine: 24, startColumn: 0, endLine: 25, endColumn: 27 };
    case symbolId("helm.cli", "main"):
      return { startLine: 4, startColumn: 0, endLine: 6, endColumn: 12 };
    case symbolId("helm.graph.models", "RepoGraph"):
      return { startLine: 4, startColumn: 0, endLine: 8, endColumn: 26 };
    case primarySymbolId ? `flow:${primarySymbolId}:param:graph` : "":
      return { startLine: 18, startColumn: 24, endLine: 18, endColumn: 29 };
    case primarySymbolId ? `flow:${primarySymbolId}:param:top_n` : "":
      return { startLine: 18, startColumn: 42, endLine: 18, endColumn: 47 };
    case primarySymbolId ? `flow:${primarySymbolId}:assign:modules` : "":
      return { startLine: 19, startColumn: 4, endLine: 19, endColumn: 24 };
    case primarySymbolId ? `flow:${primarySymbolId}:call:rank` : "":
      return { startLine: 20, startColumn: 4, endLine: 20, endColumn: 52 };
    case primarySymbolId ? `flow:${primarySymbolId}:return` : "":
      return { startLine: 21, startColumn: 4, endLine: 21, endColumn: 78 };
    case `flow:${graphSummaryToPayloadSymbolId()}:param:self`:
      return { startLine: 11, startColumn: 19, endLine: 11, endColumn: 23 };
    case `flow:${graphSummaryToPayloadSymbolId()}:return`:
      return { startLine: 12, startColumn: 8, endLine: 15, endColumn: 9 };
    default:
      return undefined;
  }
}

export function sourceSpanMetadataForTargetId(
  targetId: string,
  state?: MockWorkspaceState,
): Record<string, number> {
  const sourceSpan = sourceSpanForTargetId(targetId, state);
  if (!sourceSpan) {
    return {};
  }

  return {
    source_start_line: sourceSpan.startLine,
    source_start_column: sourceSpan.startColumn,
    source_end_line: sourceSpan.endLine,
    source_end_column: sourceSpan.endColumn,
  };
}

export function node(
  id: string,
  kind: GraphView["nodes"][number]["kind"],
  label: string,
  subtitle: string,
  x: number,
  y: number,
  metadata: Record<string, unknown> = {},
  availableActions: GraphActionDto[] = [],
) {
  const enrichedMetadata = { ...metadata };
  if (kind === "module" && !("relative_path" in enrichedMetadata)) {
    enrichedMetadata.relative_path = subtitle;
  }
  if (isGraphSymbolNodeKind(kind)) {
    if (!("qualname" in enrichedMetadata)) {
      enrichedMetadata.qualname = subtitle;
    }
    if (!("module_name" in enrichedMetadata) && subtitle.includes(".")) {
      enrichedMetadata.module_name = subtitle.split(".").slice(0, -1).join(".");
    }
  }
  return {
    id,
    kind,
    label,
    subtitle,
    x,
    y,
    metadata: enrichedMetadata,
    availableActions,
  };
}

export function edge(
  id: string,
  kind: GraphView["edges"][number]["kind"],
  source: string,
  target: string,
  label?: string,
  metadata: Record<string, unknown> = {},
) {
  return {
    id,
    kind,
    source,
    target,
    label,
    metadata,
  };
}

export function controlEdgeId(source: string, target: string, pathKey?: string) {
  return `controls:${source}->${target}${pathKey ? `:${pathKey}` : ""}`;
}

export function moduleActions() {
  return [
    { actionId: "add_import", label: "Add import", enabled: true, reason: null, payload: {} },
    { actionId: "remove_import", label: "Remove import", enabled: true, reason: null, payload: {} },
    { actionId: "reveal_source", label: "Reveal source", enabled: true, reason: null, payload: {} },
  ];
}

export function mockSymbolEditable(symbol?: SymbolDetails) {
  return Boolean(
    symbol && symbol.kind === "function" && !symbol.qualname.includes("GraphSummary."),
  );
}

export function mockDeclarationEditSupport(symbol?: SymbolDetails) {
  if (!symbol) {
    return {
      editable: false,
      reason: "This declaration is not inline editable yet.",
    };
  }
  const localQualname = symbol.nodeId.split(":").slice(2).join(":");
  const nested = localQualname.includes(".");

  if (symbol.kind === "enum") {
    return {
      editable: false,
      reason: "Enum declarations are not inline editable yet.",
    };
  }

  if (symbol.kind === "class" || symbol.kind === "function") {
    return {
      editable: true,
      reason: undefined,
    };
  }

  if (symbol.kind === "variable") {
    if (!nested) {
      return {
        editable: true,
        reason: undefined,
      };
    }
    return {
      editable: false,
      reason: "Class attribute declarations are not inline editable yet.",
    };
  }

  return {
    editable: false,
    reason: "This declaration is not inline editable yet.",
  };
}

export function flowEnabledForSymbol(symbol?: SymbolDetails) {
  return symbol?.kind === "function" || symbol?.kind === "class";
}

export function symbolActions(editable: boolean, flowEnabled = true) {
  return [
    {
      actionId: "rename_symbol",
      label: "Rename symbol",
      enabled: editable,
      reason: editable ? null : "Only dependency-free top-level symbols are writable in v1.",
      payload: {},
    },
    {
      actionId: "delete_symbol",
      label: "Delete symbol",
      enabled: editable,
      reason: editable ? null : "Only dependency-free top-level symbols are writable in v1.",
      payload: {},
    },
    {
      actionId: "move_symbol",
      label: "Move symbol",
      enabled: editable,
      reason: editable ? null : "Only dependency-free top-level symbols are writable in v1.",
      payload: {},
    },
    {
      actionId: "open_flow",
      label: "Open flow",
      enabled: flowEnabled,
      reason: flowEnabled ? null : "Flow only exists for functions, methods, and classes.",
      payload: {},
    },
    {
      actionId: "reveal_source",
      label: "Reveal source",
      enabled: true,
      reason: null,
      payload: {},
    },
  ];
}

export function graphNodeKindForSymbolKind(kind: SymbolDetails["kind"]): GraphSymbolNodeKind {
  if (kind === "class") {
    return "class";
  }
  if (kind === "enum") {
    return "enum";
  }
  if (kind === "variable") {
    return "variable";
  }
  return "function";
}
