import type {
  FlowGraphDocument,
  StructuralEditRequest,
  StructuralEditResult,
} from "../../adapter/contracts";
import {
  flowNodePayloadFromContent,
  insertFlowNodeOnEdge,
} from "../../../components/graph/flowDocument";
import {
  cloneFlowDocument,
  getMockFlowDocument,
  mockFlowDocumentFromFunctionSource,
  mockFlowDocumentSource,
  mockFlowNodeKindFromContent,
  validateMockFlowDocument,
} from "./flowFixtures";
import { buildGraphView, buildSymbols } from "./graphFixtures";
import { buildFiles } from "./workspaceFixtures";
import {
  moduleId,
  moduleNameForMockFile,
  moduleNameFromRelativePath,
  mockDeclarationEditSupport,
  parseMockSymbolId,
  symbolId,
} from "./ids";
import {
  buildRepoSession,
  defaultRepoPath,
  pythonKeywords,
  type MockModuleSymbolSeed,
  type MockWorkspaceState,
} from "./state";

function moveEditedSourceDraft(
  state: MockWorkspaceState,
  previousTargetId: string,
  nextTargetId: string,
) {
  if (!(previousTargetId in state.editedSources)) {
    return;
  }

  state.editedSources[nextTargetId] = state.editedSources[previousTargetId];
  delete state.editedSources[previousTargetId];
}

function renameMockSymbol(state: MockWorkspaceState, targetId: string, newName: string) {
  if (targetId === symbolId("helm.ui.api", state.primarySummarySymbolName)) {
    state.primarySummarySymbolName = newName;
    const nextTargetId = symbolId("helm.ui.api", newName);
    moveEditedSourceDraft(state, targetId, nextTargetId);
    return {
      relativePath: "src/helm/ui/api.py",
      nextTargetId,
    };
  }

  const parsed = parseMockSymbolId(targetId);
  if (!parsed) {
    return undefined;
  }

  const uiSymbolIndex =
    parsed.moduleName === "helm.ui.api"
      ? state.uiApiExtraSymbols.findIndex((symbol) => symbol.name === parsed.name)
      : -1;
  if (uiSymbolIndex >= 0) {
    state.uiApiExtraSymbols[uiSymbolIndex] = {
      ...state.uiApiExtraSymbols[uiSymbolIndex],
      name: newName,
    };
    const nextTargetId = symbolId("helm.ui.api", newName);
    moveEditedSourceDraft(state, targetId, nextTargetId);
    return {
      relativePath: "src/helm/ui/api.py",
      nextTargetId,
    };
  }

  const moduleSymbolIndex = state.moduleExtraSymbols.findIndex(
    (symbol) => symbol.moduleName === parsed.moduleName && symbol.name === parsed.name,
  );
  if (moduleSymbolIndex >= 0) {
    const current = state.moduleExtraSymbols[moduleSymbolIndex];
    state.moduleExtraSymbols[moduleSymbolIndex] = {
      ...current,
      name: newName,
    };
    const nextTargetId = symbolId(current.moduleName, newName);
    moveEditedSourceDraft(state, targetId, nextTargetId);
    return {
      relativePath: current.relativePath,
      nextTargetId,
    };
  }

  return undefined;
}

function deleteMockSymbol(state: MockWorkspaceState, targetId: string) {
  const parsed = parseMockSymbolId(targetId);
  if (!parsed) {
    return undefined;
  }

  if (parsed.moduleName === "helm.ui.api") {
    const uiSymbolIndex = state.uiApiExtraSymbols.findIndex(
      (symbol) => symbol.name === parsed.name,
    );
    if (uiSymbolIndex >= 0) {
      state.uiApiExtraSymbols.splice(uiSymbolIndex, 1);
      delete state.editedSources[targetId];
      return {
        relativePath: "src/helm/ui/api.py",
        moduleNodeId: moduleId("helm.ui.api"),
      };
    }
  }

  const moduleSymbolIndex = state.moduleExtraSymbols.findIndex(
    (symbol) => symbol.moduleName === parsed.moduleName && symbol.name === parsed.name,
  );
  if (moduleSymbolIndex >= 0) {
    const [removed] = state.moduleExtraSymbols.splice(moduleSymbolIndex, 1);
    delete state.editedSources[targetId];
    return {
      relativePath: removed.relativePath,
      moduleNodeId: moduleId(removed.moduleName),
    };
  }

  return undefined;
}

function moveMockSymbol(
  state: MockWorkspaceState,
  targetId: string,
  destinationRelativePath: string,
) {
  const parsed = parseMockSymbolId(targetId);
  if (!parsed) {
    return undefined;
  }

  const normalizedDestination = destinationRelativePath.trim();
  const destinationModuleName = moduleNameFromRelativePath(normalizedDestination);
  if (!buildFiles(state)[normalizedDestination]) {
    throw new Error(`Destination module '${normalizedDestination}' does not exist.`);
  }

  let source: MockModuleSymbolSeed | undefined;
  if (parsed.moduleName === "helm.ui.api") {
    const uiSymbolIndex = state.uiApiExtraSymbols.findIndex(
      (symbol) => symbol.name === parsed.name,
    );
    if (uiSymbolIndex >= 0) {
      const [removed] = state.uiApiExtraSymbols.splice(uiSymbolIndex, 1);
      source = {
        ...removed,
        moduleName: "helm.ui.api",
        relativePath: "src/helm/ui/api.py",
      };
    }
  }

  if (!source) {
    const moduleSymbolIndex = state.moduleExtraSymbols.findIndex(
      (symbol) => symbol.moduleName === parsed.moduleName && symbol.name === parsed.name,
    );
    if (moduleSymbolIndex >= 0) {
      const [removed] = state.moduleExtraSymbols.splice(moduleSymbolIndex, 1);
      source = removed;
    }
  }

  if (!source) {
    return undefined;
  }

  if (source.relativePath === normalizedDestination) {
    throw new Error("Destination module must differ from the current module.");
  }

  const nextTargetId = symbolId(destinationModuleName, source.name);
  if (normalizedDestination === "src/helm/ui/api.py") {
    state.uiApiExtraSymbols.push({ name: source.name, kind: source.kind });
  } else {
    state.moduleExtraSymbols.push({
      name: source.name,
      kind: source.kind,
      moduleName: destinationModuleName,
      relativePath: normalizedDestination,
    });
  }
  moveEditedSourceDraft(state, targetId, nextTargetId);
  return {
    sourceRelativePath: source.relativePath,
    destinationRelativePath: normalizedDestination,
    destinationModuleNodeId: moduleId(destinationModuleName),
    nextTargetId,
  };
}

export function applyMockEdit(
  state: MockWorkspaceState,
  request: StructuralEditRequest,
): StructuralEditResult {
  if (request.kind === "rename_symbol" && request.targetId) {
    if (request.newName) {
      const renamed = renameMockSymbol(state, request.targetId, request.newName);
      if (renamed) {
        return {
          request: {
            kind: "rename_symbol",
            target_id: request.targetId,
            new_name: request.newName,
          },
          summary: `Renamed symbol to ${request.newName}.`,
          touchedRelativePaths: [renamed.relativePath],
          reparsedRelativePaths: [renamed.relativePath],
          changedNodeIds: [renamed.nextTargetId],
          warnings: [],
          diagnostics: [],
        };
      }
    }
  }

  if (request.kind === "delete_symbol" && request.targetId) {
    const deleted = deleteMockSymbol(state, request.targetId);
    if (deleted) {
      return {
        request: {
          kind: "delete_symbol",
          target_id: request.targetId,
        },
        summary: `Deleted ${request.targetId}.`,
        touchedRelativePaths: [deleted.relativePath],
        reparsedRelativePaths: [deleted.relativePath],
        changedNodeIds: [deleted.moduleNodeId],
        warnings: [],
        diagnostics: [],
      };
    }
  }

  if (request.kind === "move_symbol" && request.targetId && request.destinationRelativePath) {
    const moved = moveMockSymbol(state, request.targetId, request.destinationRelativePath);
    if (moved) {
      return {
        request: {
          kind: "move_symbol",
          target_id: request.targetId,
          destination_relative_path: request.destinationRelativePath,
        },
        summary: `Moved symbol to ${request.destinationRelativePath}.`,
        touchedRelativePaths: [moved.sourceRelativePath, moved.destinationRelativePath],
        reparsedRelativePaths: [moved.sourceRelativePath, moved.destinationRelativePath],
        changedNodeIds: [moved.nextTargetId],
        warnings: [],
        diagnostics: [],
      };
    }
  }

  if (
    request.kind === "create_symbol" &&
    request.relativePath &&
    request.newName &&
    request.symbolKind
  ) {
    validateMockCreateSymbolRequest(state, request.relativePath, request.newName);
    if (request.relativePath !== "src/helm/ui/api.py") {
      throw new Error("Mock symbol creation is only seeded for src/helm/ui/api.py.");
    }
    state.uiApiExtraSymbols.push({ name: request.newName, kind: request.symbolKind });
    return {
      request: {
        kind: "create_symbol",
        relative_path: request.relativePath,
        new_name: request.newName,
        symbol_kind: request.symbolKind,
      },
      summary: `Created ${request.symbolKind} ${request.newName}.`,
      touchedRelativePaths: ["src/helm/ui/api.py"],
      reparsedRelativePaths: ["src/helm/ui/api.py"],
      changedNodeIds: [symbolId("helm.ui.api", request.newName)],
      warnings: [],
      diagnostics: [],
    };
  }

  if (request.kind === "create_module" && request.relativePath) {
    validateMockCreateModuleRequest(state, request.relativePath);
    const relativePath = request.relativePath.trim();
    const moduleName = moduleNameFromRelativePath(relativePath);
    state.extraModules.push({
      moduleName,
      relativePath,
      content: normalizedMockModuleContent(request.content),
    });
    return {
      request: {
        kind: "create_module",
        relative_path: relativePath,
        content: request.content,
      },
      summary: `Created module ${moduleName}.`,
      touchedRelativePaths: [relativePath],
      reparsedRelativePaths: [relativePath],
      changedNodeIds: [moduleId(moduleName)],
      warnings: [],
      diagnostics: [],
    };
  }

  if (
    request.kind === "insert_flow_statement" &&
    request.targetId &&
    request.anchorEdgeId &&
    request.content
  ) {
    const symbols = buildSymbols(state);
    const symbol = symbols[request.targetId];
    if (!symbol || (symbol.kind !== "function" && symbol.kind !== "class")) {
      throw new Error("Mock flow insertion is only available for seeded functions and methods.");
    }

    const currentFlow = buildGraphView(
      buildRepoSession(defaultRepoPath),
      state,
      request.targetId,
      "flow",
    );
    if (
      !currentFlow.edges.some(
        (edgeCandidate) =>
          edgeCandidate.id === request.anchorEdgeId && edgeCandidate.kind === "controls",
      )
    ) {
      throw new Error(`Unknown control-flow anchor '${request.anchorEdgeId}'.`);
    }

    const kind = mockFlowNodeKindFromContent(request.content);
    const baseDocument = getMockFlowDocument(state, symbol);
    const nextIndex = baseDocument.nodes.filter((node) =>
      node.id.startsWith(`flow:${request.targetId}:created:`),
    ).length;
    const nodeId = `flow:${request.targetId}:created:${nextIndex + 1}`;
    const nextDocument = insertFlowNodeOnEdge(
      baseDocument,
      {
        id: nodeId,
        kind,
        payload: flowNodePayloadFromContent(kind, request.content),
      },
      request.anchorEdgeId,
    );
    const validation = validateMockFlowDocument(nextDocument);
    state.flowDocumentsBySymbolId[request.targetId] = cloneFlowDocument({
      ...nextDocument,
      syncState: validation.syncState,
      diagnostics: validation.diagnostics,
      editable: true,
    });
    return {
      request: {
        kind: "insert_flow_statement",
        target_id: request.targetId,
        anchor_edge_id: request.anchorEdgeId,
        content: request.content,
      },
      summary: `Inserted ${kind} node into ${symbol.name}.`,
      touchedRelativePaths: [symbol.filePath],
      reparsedRelativePaths: [symbol.filePath],
      changedNodeIds: [nodeId],
      warnings: [],
      diagnostics: validation.diagnostics,
      flowSyncState: validation.syncState,
    };
  }

  if (request.kind === "replace_flow_graph" && request.targetId && request.flowGraph) {
    const symbols = buildSymbols(state);
    const symbol = symbols[request.targetId];
    if (!symbol || (symbol.kind !== "function" && symbol.kind !== "class")) {
      throw new Error(
        "Mock visual flow editing is only available for seeded functions and methods.",
      );
    }

    const previousDocument = state.flowDocumentsBySymbolId[request.targetId];
    const nextDocument = cloneFlowDocument(request.flowGraph);
    if (nextDocument.symbolId !== request.targetId) {
      throw new Error("Flow graph payload does not match the requested symbol.");
    }

    const validation = validateMockFlowDocument(nextDocument);
    const persistedDocument: FlowGraphDocument = {
      ...nextDocument,
      syncState: validation.syncState,
      diagnostics: validation.diagnostics,
      editable: true,
    };
    state.flowDocumentsBySymbolId[request.targetId] = cloneFlowDocument(persistedDocument);
    if (validation.syncState === "clean") {
      const compiledSource = mockFlowDocumentSource(symbol, persistedDocument);
      if (compiledSource) {
        state.editedSources[request.targetId] = compiledSource;
      }
    }
    const changedNodeIds = persistedDocument.nodes
      .filter((node) => !previousDocument?.nodes.some((candidate) => candidate.id === node.id))
      .map((node) => node.id);

    return {
      request: {
        kind: "replace_flow_graph",
        target_id: request.targetId,
        flow_graph: request.flowGraph as unknown as Record<string, unknown>,
      },
      summary:
        validation.syncState === "clean"
          ? `Updated visual flow for ${symbol.name}.`
          : `Saved draft visual flow for ${symbol.name}.`,
      touchedRelativePaths:
        validation.syncState === "clean"
          ? [symbol.filePath, ".helm/flow-models.v1.json"]
          : [".helm/flow-models.v1.json"],
      reparsedRelativePaths: validation.syncState === "clean" ? [symbol.filePath] : [],
      changedNodeIds: changedNodeIds.length ? changedNodeIds : [request.targetId],
      warnings:
        validation.syncState === "clean"
          ? []
          : ["Python source was left unchanged until the flow graph validates cleanly."],
      flowSyncState: validation.syncState,
      diagnostics: validation.diagnostics,
    };
  }

  if (
    request.kind === "add_import" &&
    request.relativePath === "src/helm/ui/api.py" &&
    request.importedModule
  ) {
    const importLine = request.importedName
      ? `from ${request.importedModule} import ${request.importedName}${request.alias ? ` as ${request.alias}` : ""}`
      : `import ${request.importedModule}${request.alias ? ` as ${request.alias}` : ""}`;
    state.uiApiImports.push(importLine);
    return {
      request: {
        kind: "add_import",
        relative_path: request.relativePath,
        imported_module: request.importedModule,
        imported_name: request.importedName,
        alias: request.alias,
      },
      summary: `Added import ${importLine}.`,
      touchedRelativePaths: ["src/helm/ui/api.py"],
      reparsedRelativePaths: ["src/helm/ui/api.py"],
      changedNodeIds: ["module:helm.ui.api"],
      warnings: [],
      diagnostics: [],
    };
  }

  if (
    request.kind === "remove_import" &&
    request.relativePath === "src/helm/ui/api.py" &&
    request.importedModule
  ) {
    state.uiApiImports = state.uiApiImports.filter(
      (line) => !line.includes(request.importedModule!),
    );
    return {
      request: {
        kind: "remove_import",
        relative_path: request.relativePath,
        imported_module: request.importedModule,
      },
      summary: `Removed import from ${request.relativePath}.`,
      touchedRelativePaths: ["src/helm/ui/api.py"],
      reparsedRelativePaths: ["src/helm/ui/api.py"],
      changedNodeIds: ["module:helm.ui.api"],
      warnings: [],
      diagnostics: [],
    };
  }

  if (request.kind === "replace_symbol_source" && request.targetId && request.content) {
    const symbols = buildSymbols(state);
    const symbol = symbols[request.targetId];
    if (!symbol) {
      throw new Error(`Unknown editable source target: ${request.targetId}`);
    }
    const support = mockDeclarationEditSupport(symbol);
    if (!support.editable) {
      throw new Error(support.reason ?? "This declaration is not inline editable yet.");
    }
    state.editedSources[request.targetId] = request.content;
    const syncedFlowDocument = mockFlowDocumentFromFunctionSource(symbol, request.content);
    if (syncedFlowDocument) {
      state.flowDocumentsBySymbolId[request.targetId] = cloneFlowDocument(syncedFlowDocument);
    }
    return {
      request: {
        kind: "replace_symbol_source",
        target_id: request.targetId,
        content: request.content,
      },
      summary: `Updated source for ${request.targetId}.`,
      touchedRelativePaths: ["src/helm/ui/api.py"],
      reparsedRelativePaths: ["src/helm/ui/api.py"],
      changedNodeIds: [request.targetId],
      warnings: ["This edit is simulated in the mock adapter."],
      diagnostics: [],
      flowSyncState: syncedFlowDocument ? "clean" : undefined,
    };
  }

  if (
    request.kind === "replace_module_source" &&
    request.targetId &&
    request.content !== undefined
  ) {
    const moduleName = request.targetId.replace(/^module:/, "");
    const matchingModule = state.extraModules.find((module) => module.moduleName === moduleName);
    const relativePath =
      matchingModule?.relativePath ??
      Object.keys(buildFiles(state)).find(
        (filePath) => moduleNameForMockFile(filePath) === moduleName,
      );
    if (!relativePath) {
      throw new Error(`Unknown editable module source target: ${request.targetId}`);
    }
    if (matchingModule) {
      matchingModule.content = request.content;
    } else {
      state.workspaceFiles[relativePath] = {
        kind: "file",
        content: request.content,
      };
    }
    return {
      request: {
        kind: "replace_module_source",
        target_id: request.targetId,
        content: request.content,
      },
      summary: `Updated source for ${request.targetId}.`,
      touchedRelativePaths: [relativePath],
      reparsedRelativePaths: [relativePath],
      changedNodeIds: [request.targetId],
      warnings: ["This edit is simulated in the mock adapter."],
      diagnostics: [],
    };
  }

  return {
    request: {
      kind: request.kind,
      target_id: request.targetId,
      relative_path: request.relativePath,
      new_name: request.newName,
      symbol_kind: request.symbolKind,
      destination_relative_path: request.destinationRelativePath,
      imported_module: request.importedModule,
      imported_name: request.importedName,
      alias: request.alias,
      body: request.body,
      content: request.content,
      anchor_edge_id: request.anchorEdgeId,
    },
    summary: `Mock adapter acknowledged ${request.kind}.`,
    touchedRelativePaths: request.relativePath ? [request.relativePath] : [],
    reparsedRelativePaths: request.relativePath ? [request.relativePath] : [],
    changedNodeIds: request.targetId ? [request.targetId] : [],
    warnings: ["This edit is simulated in the mock adapter."],
    diagnostics: [],
  };
}

function validateMockCreateModuleRequest(state: MockWorkspaceState, relativePath: string) {
  const normalized = relativePath.trim();
  if (!normalized || normalized.startsWith("/") || normalized.includes("\\")) {
    throw new Error("Module path must be a relative Python file path.");
  }
  if (!normalized.endsWith(".py")) {
    throw new Error("Module path must end with .py.");
  }
  if (
    normalized
      .split("/")
      .some((segment) => segment === "." || segment === ".." || segment.length === 0)
  ) {
    throw new Error("Module path must stay within the repo.");
  }
  if (buildFiles(state)[normalized]) {
    throw new Error(`Module '${normalized}' already exists.`);
  }
}

function validateMockCreateSymbolRequest(
  state: MockWorkspaceState,
  relativePath: string,
  newName: string,
) {
  if (!/^[_A-Za-z][_A-Za-z0-9]*$/.test(newName)) {
    throw new Error(`Created symbol name '${newName}' must be a valid Python identifier.`);
  }
  if (pythonKeywords.has(newName)) {
    throw new Error(`Created symbol name '${newName}' cannot be a Python keyword.`);
  }

  const existing = Object.values(buildSymbols(state)).some((symbol) => {
    if (symbol.filePath !== relativePath) {
      return false;
    }
    const modulePrefix = `${symbol.moduleName}.`;
    const localQualname = symbol.qualname.startsWith(modulePrefix)
      ? symbol.qualname.slice(modulePrefix.length)
      : symbol.qualname;
    return !localQualname.includes(".") && symbol.name === newName;
  });

  if (existing) {
    throw new Error(`Top-level symbol '${newName}' already exists in ${relativePath}.`);
  }
}

function normalizedMockModuleContent(content?: string) {
  const trimmed = content?.trimEnd();
  return trimmed && trimmed.length > 0 ? `${trimmed}\n` : "";
}
