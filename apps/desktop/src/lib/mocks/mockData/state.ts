import type {
  BackendStatus,
  FlowGraphDocument,
  RecentRepo,
  RepoSession,
} from "../../adapter/contracts";

export const defaultRepoPath = "/Users/noahphillips/Documents/git-repos/H.E.L.M.";

export const recentRepos: RecentRepo[] = [
  {
    name: "H.E.L.M.",
    path: defaultRepoPath,
    branch: "main",
    lastOpenedAt: "2026-04-06T20:48:00.000Z",
  },
  {
    name: "atlas-docs",
    path: "/Users/noahphillips/Documents/git-repos/atlas-docs",
    branch: "design-refresh",
    lastOpenedAt: "2026-04-05T18:14:00.000Z",
  },
];

export const mockBackendStatus: BackendStatus = {
  mode: "mock",
  available: true,
  pythonCommand: "mock",
  liveSyncEnabled: false,
  syncState: "idle",
  note: "Browser-only mode is using seeded data. Run the Tauri shell to exercise the real Python backbone from the UI.",
};

export interface MockTopLevelSymbolSeed {
  name: string;
  kind: "function" | "class";
}

export interface MockModuleSymbolSeed extends MockTopLevelSymbolSeed {
  moduleName: string;
  relativePath: string;
}

export interface MockWorkspaceState {
  primarySummarySymbolName: string;
  uiApiImports: string[];
  uiApiExtraSymbols: MockTopLevelSymbolSeed[];
  moduleExtraSymbols: MockModuleSymbolSeed[];
  workspaceFiles: Record<
    string,
    {
      kind: "file" | "directory";
      content?: string;
    }
  >;
  extraModules: Array<{
    moduleName: string;
    relativePath: string;
    content: string;
  }>;
  flowInsertionsBySymbolId: Record<
    string,
    Array<{
      nodeId: string;
      kind: "assign" | "call" | "return" | "branch" | "loop";
      label: string;
      subtitle: string;
      anchorEdgeId: string;
      content: string;
    }>
  >;
  flowDocumentsBySymbolId: Record<string, FlowGraphDocument>;
  editedSources: Record<string, string>;
}

export const pythonKeywords = new Set([
  "False",
  "None",
  "True",
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
]);

export function buildRepoSession(path = defaultRepoPath): RepoSession {
  const segments = path.split("/").filter(Boolean);
  const name = segments[segments.length - 1] ?? "repo";

  return {
    id: `repo:${path}`,
    name,
    path,
    branch: "main",
    primaryLanguage: "Python",
    openedAt: new Date().toISOString(),
  };
}

export function createMockWorkspaceState(): MockWorkspaceState {
  return {
    primarySummarySymbolName: "build_graph_summary",
    uiApiImports: [
      "from dataclasses import dataclass, field",
      "from typing import Any",
      "from helm.graph.models import RepoGraph",
    ],
    uiApiExtraSymbols: [],
    moduleExtraSymbols: [],
    workspaceFiles: {},
    extraModules: [],
    flowInsertionsBySymbolId: {},
    flowDocumentsBySymbolId: {},
    editedSources: {},
  };
}
