import type {
  BackendStatus,
  FileContents,
  GraphAbstractionLevel,
  OverviewData,
  OverviewModule,
  OverviewOutlineItem,
  RelationshipItem,
  RepoSession,
  SearchFilters,
  SearchResult,
  SymbolDetails,
} from "../contracts";
import type { RawGraphEdge, RawGraphNode, RawScanPayload, ScanCache } from "./rawTypes";
import { capitalize, languageFromPath, normalizePath, type InvokeCommand } from "./shared";

export function buildScanCache(
  payload: RawScanPayload,
  session: RepoSession,
  backend: BackendStatus,
): ScanCache {
  const nodeById = new Map(payload.graph.nodes.map((node) => [node.node_id, node]));
  const edgesBySource = new Map<string, RawGraphEdge[]>();
  const edgesByTarget = new Map<string, RawGraphEdge[]>();
  const degreeByNodeId = new Map<string, number>();
  const moduleByRelativePath = new Map<string, RawGraphNode>();
  const relativePathByAbsolute = new Map<string, string>();
  const absolutePathByRelative = new Map<string, string>();

  payload.graph.edges.forEach((edge) => {
    edgesBySource.set(edge.source_id, [...(edgesBySource.get(edge.source_id) ?? []), edge]);
    edgesByTarget.set(edge.target_id, [...(edgesByTarget.get(edge.target_id) ?? []), edge]);
    degreeByNodeId.set(edge.source_id, (degreeByNodeId.get(edge.source_id) ?? 0) + 1);
    degreeByNodeId.set(edge.target_id, (degreeByNodeId.get(edge.target_id) ?? 0) + 1);
  });

  payload.graph.nodes.forEach((node) => {
    const relativePath = relativePathForRawNode(node, payload.graph.root_path);
    if (node.kind === "module" && !node.is_external) {
      moduleByRelativePath.set(relativePath, node);
    }
    if (node.file_path) {
      relativePathByAbsolute.set(normalizePath(node.file_path), relativePath);
      absolutePathByRelative.set(relativePath, normalizePath(node.file_path));
    }
  });

  const cache: ScanCache = {
    payload,
    session,
    backend,
    nodeById,
    edgesBySource,
    edgesByTarget,
    degreeByNodeId,
    moduleByRelativePath,
    relativePathByAbsolute,
    absolutePathByRelative,
    searchEntries: [],
  };
  cache.searchEntries = buildSearchEntries(cache);
  return cache;
}

function buildSearchEntries(cache: ScanCache): SearchResult[] {
  const moduleEntries = cache.payload.graph.nodes
    .filter((node) => node.kind === "module" && !node.is_external)
    .map((node) => {
      const filePath = relativePathForNode(node, cache);
      return {
        id: node.node_id,
        kind: "module" as const,
        title: node.module_name ?? node.name,
        subtitle: filePath,
        score: 0,
        filePath,
        nodeId: node.node_id,
        level: "module" as GraphAbstractionLevel,
      };
    });
  const fileEntries = cache.payload.graph.nodes
    .filter((node) => node.kind === "module" && !node.is_external)
    .map((node) => {
      const filePath = relativePathForNode(node, cache);
      return {
        id: `file:${filePath}`,
        kind: "file" as const,
        title: filePath,
        subtitle: "Raw source utility",
        score: 0,
        filePath,
        nodeId: node.node_id,
        level: "module" as GraphAbstractionLevel,
      };
    });
  const symbolEntries = cache.payload.graph.nodes
    .filter((node) => node.kind === "symbol")
    .map((node) => ({
      id: node.node_id,
      kind: "symbol" as const,
      title: node.name,
      subtitle: node.qualname ?? node.display_name,
      score: 0,
      filePath: relativePathForNode(node, cache),
      symbolId: node.node_id,
      nodeId: node.node_id,
      level: "symbol" as GraphAbstractionLevel,
    }));

  return [...symbolEntries, ...moduleEntries, ...fileEntries];
}

function relativePathForRawNode(node: RawGraphNode, rootPath: string): string {
  if (typeof node.metadata.relative_path === "string") {
    return node.metadata.relative_path;
  }
  if (!node.file_path) {
    return node.display_name;
  }
  const normalizedRoot = normalizePath(rootPath);
  const normalizedFile = normalizePath(node.file_path);
  if (normalizedFile.startsWith(`${normalizedRoot}/`)) {
    return normalizedFile.slice(normalizedRoot.length + 1);
  }
  return normalizedFile;
}

export function relativePathForNode(node: RawGraphNode, cache: ScanCache): string {
  if (typeof node.metadata.relative_path === "string") {
    return node.metadata.relative_path;
  }
  if (!node.file_path) {
    return node.display_name;
  }
  return cache.relativePathByAbsolute.get(normalizePath(node.file_path)) ?? node.display_name;
}

function toRelationship(nodeId: string, cache: ScanCache): RelationshipItem {
  const node = cache.nodeById.get(nodeId);
  if (!node) {
    return {
      id: nodeId,
      label: nodeId,
      subtitle: "Unavailable node",
      nodeId,
    };
  }

  return {
    id: node.node_id,
    label: node.name,
    subtitle:
      node.kind === "symbol"
        ? (node.qualname ?? node.display_name)
        : relativePathForNode(node, cache),
    nodeId: node.node_id,
    symbolId: node.kind === "symbol" ? node.node_id : undefined,
  };
}

function buildSignature(node: RawGraphNode): string {
  const symbolKind = String(node.metadata.symbol_kind ?? "symbol");
  if (symbolKind === "class") {
    return `${node.qualname ?? node.display_name} class`;
  }
  if (symbolKind === "enum") {
    return `${node.qualname ?? node.display_name} enum`;
  }
  if (symbolKind === "variable") {
    return `${node.qualname ?? node.display_name} value`;
  }
  return `${node.qualname ?? node.display_name}(...)`;
}

function buildDocSummary(node: RawGraphNode, cache: ScanCache): string {
  const symbolKind = String(node.metadata.symbol_kind ?? "symbol");
  const inboundCalls = (cache.edgesByTarget.get(node.node_id) ?? []).filter(
    (edge) => edge.kind === "calls",
  ).length;
  const outboundCalls = (cache.edgesBySource.get(node.node_id) ?? []).filter(
    (edge) => edge.kind === "calls",
  ).length;

  return `${capitalize(symbolKind)} in ${node.module_name ?? "this module"} with ${inboundCalls} inbound and ${outboundCalls} outbound structural call links in the current scan.`;
}

function topSymbolResults(cache: ScanCache, limit: number): SearchResult[] {
  return cache.searchEntries
    .filter((entry) => entry.kind === "symbol")
    .sort(
      (left, right) =>
        (cache.degreeByNodeId.get(right.nodeId ?? right.id) ?? 0) -
        (cache.degreeByNodeId.get(left.nodeId ?? left.id) ?? 0),
    )
    .slice(0, limit);
}

function buildHotspots(cache: ScanCache) {
  const topModule = cache.payload.summary.modules[0];
  const hotspots = [];
  if (topModule) {
    hotspots.push({
      title: `${topModule.module_name} anchors the architecture map`,
      description: `${topModule.relative_path} currently leads the scan with ${topModule.symbol_count} symbols and ${topModule.outgoing_call_count} outgoing calls.`,
    });
  }
  hotspots.push({
    title: `${cache.payload.workspace.default_level} is the default opening level`,
    description:
      cache.payload.workspace.default_level === "module"
        ? "This repo is large enough to open at the module architecture layer first."
        : "This repo is compact enough to open directly at the symbol layer.",
  });
  hotspots.push({
    title: `${cache.payload.graph.report.diagnostic_count} parser diagnostics`,
    description:
      cache.payload.graph.report.diagnostic_count > 0
        ? "Diagnostics are surfaced in the overview so you can validate parser edge cases without leaving the graph editor."
        : "No parser diagnostics were surfaced in the last scan.",
  });
  return hotspots;
}

function buildOverviewModules(cache: ScanCache): OverviewModule[] {
  const symbolCountByModule = new Map<string, number>();
  const importCountByModule = new Map<string, number>();
  const callCountByModule = new Map<string, number>();

  cache.payload.graph.nodes.forEach((node) => {
    if (node.kind === "symbol" && node.module_name) {
      const moduleId = `module:${node.module_name}`;
      symbolCountByModule.set(moduleId, (symbolCountByModule.get(moduleId) ?? 0) + 1);
    }
  });

  cache.payload.graph.edges.forEach((edge) => {
    const sourceNode = cache.nodeById.get(edge.source_id);
    const targetNode = cache.nodeById.get(edge.target_id);
    const moduleName =
      sourceNode?.kind === "module" ? sourceNode.module_name : sourceNode?.module_name;
    if (!moduleName) {
      return;
    }
    const moduleId = `module:${moduleName}`;
    if (edge.kind === "imports" && targetNode?.is_external !== true) {
      importCountByModule.set(moduleId, (importCountByModule.get(moduleId) ?? 0) + 1);
    }
    if (edge.kind === "calls") {
      callCountByModule.set(moduleId, (callCountByModule.get(moduleId) ?? 0) + 1);
    }
  });

  return cache.payload.graph.nodes
    .filter((node) => node.kind === "module" && !node.is_external)
    .sort((left, right) =>
      relativePathForNode(left, cache).localeCompare(relativePathForNode(right, cache)),
    )
    .map((node) => ({
      id: `module:${node.node_id}`,
      moduleId: node.node_id,
      moduleName: node.module_name ?? node.name,
      relativePath: relativePathForNode(node, cache),
      symbolCount: symbolCountByModule.get(node.node_id) ?? 0,
      importCount: importCountByModule.get(node.node_id) ?? 0,
      callCount: callCountByModule.get(node.node_id) ?? 0,
      outline: buildModuleOutline(node, cache),
    }));
}

function buildModuleOutline(moduleNode: RawGraphNode, cache: ScanCache): OverviewOutlineItem[] {
  return (cache.edgesBySource.get(moduleNode.node_id) ?? [])
    .filter((edge) => edge.kind === "defines")
    .map((edge) => cache.nodeById.get(edge.target_id))
    .filter((node): node is RawGraphNode => {
      if (!node || node.kind !== "symbol" || node.is_external) {
        return false;
      }
      return isOutlineSymbolKind(String(node.metadata.symbol_kind ?? ""));
    })
    .sort((left, right) => {
      const lineDelta =
        (left.span?.start_line ?? Number.MAX_SAFE_INTEGER) -
        (right.span?.start_line ?? Number.MAX_SAFE_INTEGER);
      if (lineDelta !== 0) {
        return lineDelta;
      }
      return left.name.localeCompare(right.name);
    })
    .map((node) => ({
      id: `outline:${node.node_id}`,
      nodeId: node.node_id,
      label: node.name,
      kind: String(node.metadata.symbol_kind ?? "function") as OverviewOutlineItem["kind"],
      startLine: node.span?.start_line ?? 0,
      topLevel: true,
    }));
}

function isOutlineSymbolKind(value: string): value is OverviewOutlineItem["kind"] {
  return (
    value === "function" ||
    value === "async_function" ||
    value === "class" ||
    value === "enum" ||
    value === "variable"
  );
}

function scoreSearchResult(
  result: SearchResult,
  query: string,
  degreeByNodeId: Map<string, number>,
): number {
  const degree = degreeByNodeId.get(result.nodeId ?? result.id) ?? 0;
  const kindWeight = result.kind === "symbol" ? 18 : result.kind === "module" ? 12 : 2;
  if (!query) {
    return degree + kindWeight;
  }

  const haystacks = [result.title.toLowerCase(), result.subtitle.toLowerCase(), result.filePath];
  let score = degree + kindWeight;
  if (haystacks.some((value) => value === query)) {
    score += 60;
  }
  if (haystacks.some((value) => value.startsWith(query))) {
    score += 30;
  }
  if (haystacks.some((value) => value.includes(query))) {
    score += 12;
  }
  return score;
}

export function searchScanCache(
  cache: ScanCache,
  query: string,
  filters: SearchFilters,
): SearchResult[] {
  const normalized = query.trim().toLowerCase();
  const results = cache.searchEntries.filter((entry) => {
    if (entry.kind === "file" && !filters.includeFiles) return false;
    if (entry.kind === "module" && !filters.includeModules) return false;
    if (entry.kind === "symbol" && !filters.includeSymbols) return false;
    if (!normalized) return true;
    return (
      entry.title.toLowerCase().includes(normalized) ||
      entry.subtitle.toLowerCase().includes(normalized) ||
      entry.filePath.toLowerCase().includes(normalized)
    );
  });
  return results
    .map((result) => ({
      ...result,
      score: scoreSearchResult(result, normalized, cache.degreeByNodeId),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 24);
}

export async function getFileContents(
  invokeCommand: InvokeCommand,
  cache: ScanCache,
  path: string,
): Promise<FileContents> {
  const relativePath = normalizePath(path);
  if (!cache.absolutePathByRelative.has(relativePath)) {
    throw new Error("No indexed file matched " + relativePath + ".");
  }
  const content = await invokeCommand<string>("read_repo_file", {
    repoPath: cache.session.path,
    relativePath,
  });
  const linkedSymbols = cache.searchEntries
    .filter((entry) => entry.kind === "symbol" && entry.filePath === relativePath)
    .slice(0, 12);
  return {
    path: relativePath,
    language: languageFromPath(relativePath),
    lineCount: content ? content.split("\n").length : 0,
    sizeBytes: new TextEncoder().encode(content).length,
    content,
    linkedSymbols,
  };
}

export function getSymbolDetails(cache: ScanCache, symbolId: string): SymbolDetails {
  const node = cache.nodeById.get(symbolId);
  if (!node || node.kind !== "symbol") {
    throw new Error("No indexed symbol matched " + symbolId + ".");
  }
  const callers = (cache.edgesByTarget.get(symbolId) ?? [])
    .filter((edge) => edge.kind === "calls")
    .map((edge) => toRelationship(edge.source_id, cache));
  const callees = (cache.edgesBySource.get(symbolId) ?? [])
    .filter((edge) => edge.kind === "calls")
    .map((edge) => toRelationship(edge.target_id, cache));
  const references = [
    ...(cache.edgesByTarget.get(symbolId) ?? []).filter(
      (edge) => edge.kind === "defines" || edge.kind === "contains",
    ),
    ...(cache.edgesBySource.get(symbolId) ?? []).filter((edge) => edge.kind === "imports"),
  ].map((edge) =>
    toRelationship(edge.source_id === symbolId ? edge.target_id : edge.source_id, cache),
  );
  const filePath = relativePathForNode(node, cache);
  const startLine = node.span?.start_line ?? 1;
  const endLine = node.span?.end_line ?? startLine;
  const kind = String(node.metadata.symbol_kind ?? "symbol");
  return {
    symbolId: node.node_id,
    nodeId: node.node_id,
    kind,
    name: node.name,
    qualname: node.qualname ?? node.display_name,
    moduleName: node.module_name ?? "unknown",
    filePath,
    signature: buildSignature(node),
    docSummary: buildDocSummary(node, cache),
    startLine,
    endLine,
    callers,
    callees,
    references,
    metadata: {
      Module: node.module_name ?? "unknown",
      File: filePath,
      External: node.is_external ? "yes" : "no",
      Kind: kind,
    },
  };
}

export function getOverviewData(cache: ScanCache): OverviewData {
  const topSymbols = topSymbolResults(cache, 5);
  const savedViews = [
    {
      id: "saved:architecture",
      label: "Architecture Map",
      description: "Start at the repo boundary and inspect module interactions.",
      nodeId: cache.payload.graph.repo_id,
      level: "repo" as GraphAbstractionLevel,
    },
    ...topSymbols.slice(0, 2).map((symbol, index) => ({
      id: "saved:" + symbol.id,
      label: index === 0 ? "Primary Blueprint" : "Focus " + (index + 1),
      description: "Inspect " + symbol.subtitle + " without opening raw source.",
      nodeId: symbol.nodeId ?? symbol.id,
      level: "symbol" as GraphAbstractionLevel,
    })),
  ];
  const modules = buildOverviewModules(cache);
  const diagnostics = cache.payload.graph.diagnostics
    .slice(0, 3)
    .map((diagnostic) => diagnostic.code + ": " + diagnostic.message);
  if (!diagnostics.length) {
    diagnostics.push("No parser diagnostics were reported in the last scan.");
  }
  return {
    repo: cache.session,
    metrics: [
      { label: "Modules", value: String(cache.payload.summary.module_count) },
      { label: "Symbols", value: String(cache.payload.summary.symbol_count) },
      { label: "Calls", value: String(cache.payload.summary.call_edge_count), tone: "accent" },
      { label: "Diagnostics", value: String(cache.payload.summary.diagnostic_count) },
    ],
    modules,
    hotspots: buildHotspots(cache),
    savedViews,
    focusSymbols: topSymbols,
    diagnostics,
    backend: cache.backend,
    defaultLevel: cache.payload.workspace.default_level,
    defaultFocusNodeId: cache.payload.workspace.default_focus_node_id,
  };
}
