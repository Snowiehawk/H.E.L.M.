import type {
  EditableNodeSource,
  FileContents,
  RevealedSource,
  SymbolDetails,
} from "../../adapter/contracts";
import {
  graphNodeKindForSymbolKind,
  graphSummaryModuleCountSymbolId,
  graphSummaryRepoPathSymbolId,
  graphSummarySymbolId,
  graphSummaryToPayloadSymbolId,
  mockDeclarationEditSupport,
  moduleId,
  moduleNameForMockFile,
  sourceSpanForTargetId,
  symbolId,
} from "./ids";
import { appendModuleBlocks, moduleExtraBlocks } from "./moduleFixtures";
import type { MockWorkspaceState } from "./state";
import { buildSearchResults, buildSymbols } from "./graphFixtures";

export function buildFiles(state: MockWorkspaceState): Record<string, FileContents> {
  const searchResults = buildSearchResults(state);
  const cliSource = buildCliSource(state);
  const uiApiSource = buildUiApiSource(state);
  const graphModelsSource = appendModuleBlocks(
    "from dataclasses import dataclass\n\n\n@dataclass(frozen=True)\nclass RepoGraph:\n    root_path: str\n    repo_id: str\n    nodes: dict[str, object]\n    edges: tuple[object, ...]\n",
    moduleExtraBlocks(state, "helm.graph.models"),
  );
  const files: Record<string, FileContents> = {
    "src/helm/cli.py": {
      path: "src/helm/cli.py",
      language: "python",
      lineCount: cliSource.split("\n").length,
      sizeBytes: new TextEncoder().encode(cliSource).length,
      linkedSymbols: searchResults.filter((result) => result.filePath === "src/helm/cli.py"),
      content: cliSource,
    },
    "src/helm/ui/api.py": {
      path: "src/helm/ui/api.py",
      language: "python",
      lineCount: uiApiSource.split("\n").length,
      sizeBytes: new TextEncoder().encode(uiApiSource).length,
      linkedSymbols: searchResults.filter((result) => result.filePath === "src/helm/ui/api.py"),
      content: uiApiSource,
    },
    "src/helm/graph/models.py": {
      path: "src/helm/graph/models.py",
      language: "python",
      lineCount: graphModelsSource.split("\n").length,
      sizeBytes: new TextEncoder().encode(graphModelsSource).length,
      linkedSymbols: searchResults.filter(
        (result) => result.filePath === "src/helm/graph/models.py",
      ),
      content: graphModelsSource,
    },
  };

  state.extraModules.forEach((module) => {
    const moduleContent = appendModuleBlocks(
      module.content,
      moduleExtraBlocks(state, module.moduleName),
    );
    files[module.relativePath] = {
      path: module.relativePath,
      language: "python",
      lineCount: moduleContent.split("\n").length,
      sizeBytes: new TextEncoder().encode(moduleContent).length,
      linkedSymbols: searchResults.filter((result) => result.filePath === module.relativePath),
      content: moduleContent,
    };
  });

  return files;
}

export function buildRevealedSource(state: MockWorkspaceState, targetId: string): RevealedSource {
  if (targetId.startsWith("symbol:")) {
    return buildEditableNodeSource(state, targetId);
  }
  const files = buildFiles(state);
  if (targetId === moduleId("helm.ui.api")) {
    return {
      targetId,
      title: "helm.ui.api",
      path: "src/helm/ui/api.py",
      startLine: 1,
      endLine: files["src/helm/ui/api.py"].lineCount,
      content: files["src/helm/ui/api.py"].content,
    };
  }

  if (targetId.startsWith("module:")) {
    const matchingModule = state.extraModules.find(
      (module) => moduleId(module.moduleName) === targetId,
    );
    if (matchingModule) {
      return {
        targetId,
        title: matchingModule.moduleName,
        path: matchingModule.relativePath,
        startLine: 1,
        endLine: files[matchingModule.relativePath].lineCount,
        content: files[matchingModule.relativePath].content,
      };
    }
  }

  return {
    targetId,
    title: state.primarySummarySymbolName,
    path: "src/helm/ui/api.py",
    startLine: 18,
    endLine: 21,
    content: `def ${state.primarySummarySymbolName}(graph: RepoGraph, top_n: int = 10) -> GraphSummary:\n    module_summaries = []\n    return GraphSummary(repo_path=graph.root_path, module_count=len(module_summaries))`,
  };
}

export function buildEditableNodeSource(
  state: MockWorkspaceState,
  targetId: string,
): EditableNodeSource {
  if (targetId.startsWith("module:")) {
    const files = buildFiles(state);
    const matchingModule = state.extraModules.find(
      (module) => moduleId(module.moduleName) === targetId,
    );
    const matchingFile = Object.values(files).find(
      (file) => moduleId(moduleNameForMockFile(file.path)) === targetId,
    );
    const modulePath = matchingModule?.relativePath ?? matchingFile?.path;
    const file = modulePath ? files[modulePath] : undefined;
    if (!modulePath || !file) {
      throw new Error(`Unknown editable module source target: ${targetId}`);
    }
    const content =
      state.workspaceFiles[modulePath]?.kind === "file"
        ? (state.workspaceFiles[modulePath].content ?? "")
        : file.content;
    return {
      targetId,
      title: matchingModule?.moduleName ?? targetId.replace(/^module:/, ""),
      path: modulePath,
      startLine: 1,
      endLine: content.split("\n").length,
      content,
      editable: true,
      nodeKind: "module",
    };
  }

  const symbols = buildSymbols(state);
  const symbol = symbols[targetId];
  if (!symbol) {
    throw new Error(`Unknown editable source target: ${targetId}`);
  }
  const support = mockDeclarationEditSupport(symbol);

  const defaultContent = state.editedSources[targetId] ?? defaultSymbolSource(state, symbol);
  const sourceSpan = sourceSpanForTargetId(targetId, state);

  return {
    targetId,
    title: symbol.name,
    path: symbol.filePath,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
    startColumn: sourceSpan?.startColumn,
    endColumn: sourceSpan?.endColumn,
    content: defaultContent,
    editable: support.editable,
    nodeKind: graphNodeKindForSymbolKind(symbol.kind),
    reason: support.reason,
  };
}

function buildCliSource(state: MockWorkspaceState): string {
  return appendModuleBlocks(
    `from helm.ui.api import ${state.primarySummarySymbolName}\n\n\ndef main(argv: list[str] | None = None) -> int:\n    summary = ${state.primarySummarySymbolName}(graph=RepoGraph(root_path='.', repo_id='repo', nodes={}, edges=()))\n    return 0\n`,
    moduleExtraBlocks(state, "helm.cli"),
  );
}

function buildUiApiSource(state: MockWorkspaceState): string {
  return appendModuleBlocks(
    `${state.uiApiImports.join("\n")}\n\n\n@dataclass(frozen=True)\nclass GraphSummary:\n    repo_path: str\n    module_count: int\n\n    def to_payload(self) -> dict[str, object]:\n        return {\n            "repo_path": self.repo_path,\n            "module_count": self.module_count,\n        }\n\n\ndef ${state.primarySummarySymbolName}(graph: RepoGraph, top_n: int = 10) -> GraphSummary:\n    module_summaries = []\n    ranked_modules = sorted(module_summaries)[:top_n]\n    return GraphSummary(repo_path=graph.root_path, module_count=len(ranked_modules))\n\n\ndef build_export_payload(graph: RepoGraph) -> dict[str, object]:\n    return {"graph": graph}\n`,
    moduleExtraBlocks(state, "helm.ui.api"),
  );
}

function defaultSymbolSource(state: MockWorkspaceState, symbol: SymbolDetails): string {
  if (symbol.nodeId === symbolId("helm.ui.api", state.primarySummarySymbolName)) {
    return `def ${state.primarySummarySymbolName}(graph: RepoGraph, top_n: int = 10) -> GraphSummary:\n    module_summaries = []\n    ranked_modules = sorted(module_summaries)[:top_n]\n    return GraphSummary(repo_path=graph.root_path, module_count=len(ranked_modules))`;
  }
  if (symbol.nodeId === graphSummarySymbolId()) {
    return 'class GraphSummary:\n    repo_path: str\n    module_count: int\n\n    def to_payload(self) -> dict[str, object]:\n        return {\n            "repo_path": self.repo_path,\n            "module_count": self.module_count,\n        }';
  }
  if (symbol.nodeId === graphSummaryRepoPathSymbolId()) {
    return "repo_path: str";
  }
  if (symbol.nodeId === graphSummaryModuleCountSymbolId()) {
    return "module_count: int";
  }
  if (symbol.nodeId === graphSummaryToPayloadSymbolId()) {
    return 'def to_payload(self) -> dict[str, object]:\n    return {\n        "repo_path": self.repo_path,\n        "module_count": self.module_count,\n    }';
  }
  if (symbol.nodeId === symbolId("helm.ui.api", "build_export_payload")) {
    return 'def build_export_payload(graph: RepoGraph) -> dict[str, object]:\n    return {"graph": graph}';
  }
  if (symbol.nodeId === symbolId("helm.cli", "main")) {
    return `def main(argv: list[str] | None = None) -> int:\n    summary = ${state.primarySummarySymbolName}(graph=RepoGraph(root_path='.', repo_id='repo', nodes={}, edges=()))\n    return 0`;
  }
  if (symbol.kind === "class" || symbol.kind === "enum") {
    return `class ${symbol.name}:\n    pass`;
  }
  if (symbol.kind === "variable") {
    return `${symbol.name} = True`;
  }
  return `def ${symbol.name}() -> None:\n    pass`;
}
