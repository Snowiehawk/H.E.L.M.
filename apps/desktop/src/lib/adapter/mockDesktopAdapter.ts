import type {
  BackendStatus,
  DesktopAdapter,
  FileContents,
  GraphFilters,
  GraphNeighborhood,
  IndexingJobState,
  OverviewData,
  RecentRepo,
  RepoSession,
  SearchFilters,
  SearchResult,
  SymbolDetails,
} from "./contracts";
import {
  buildGraph,
  buildIndexingStates,
  buildOverview,
  buildRepoSession,
  defaultRepoPath,
  files,
  mockBackendStatus,
  recentRepos,
  searchResults,
  symbols,
} from "../mocks/mockData";

const delay = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

export class MockDesktopAdapter implements DesktopAdapter {
  readonly isMock = true;
  private currentSession = buildRepoSession(defaultRepoPath);

  async openRepo(path?: string): Promise<RepoSession> {
    await delay(220);
    this.currentSession = buildRepoSession(path ?? defaultRepoPath);
    return this.currentSession;
  }

  async listRecentRepos(): Promise<RecentRepo[]> {
    await delay(120);
    return recentRepos;
  }

  async getBackendStatus(): Promise<BackendStatus> {
    await delay(80);
    return mockBackendStatus;
  }

  async startIndex(repoPath: string): Promise<{ jobId: string }> {
    await delay(180);
    return {
      jobId: `index:${repoPath}:${Date.now()}`,
    };
  }

  subscribeIndexProgress(
    jobId: string,
    onUpdate: (state: IndexingJobState) => void,
  ): () => void {
    const frames = buildIndexingStates(jobId, this.currentSession.path);
    let index = 0;

    onUpdate(frames[index]);
    const timer = window.setInterval(() => {
      index += 1;
      onUpdate(frames[Math.min(index, frames.length - 1)]);
      if (index >= frames.length - 1) {
        window.clearInterval(timer);
      }
    }, 900);

    return () => window.clearInterval(timer);
  }

  async searchRepo(query: string, filters: SearchFilters): Promise<SearchResult[]> {
    await delay(120);
    const normalized = query.trim().toLowerCase();
    const filtered = searchResults.filter((result) => {
      if (result.kind === "file" && !filters.includeFiles) {
        return false;
      }
      if (result.kind === "symbol" && !filters.includeSymbols) {
        return false;
      }
      if (!normalized) {
        return true;
      }
      return (
        result.title.toLowerCase().includes(normalized) ||
        result.subtitle.toLowerCase().includes(normalized) ||
        result.filePath.toLowerCase().includes(normalized)
      );
    });

    return filtered.sort((left, right) => right.score - left.score);
  }

  async getFile(path: string): Promise<FileContents> {
    await delay(140);
    const file = files[path];
    if (!file) {
      throw new Error(`Unknown file requested: ${path}`);
    }
    return file;
  }

  async getSymbol(symbolId: string): Promise<SymbolDetails> {
    await delay(150);
    const symbol = symbols[symbolId];
    if (!symbol) {
      throw new Error(`Unknown symbol requested: ${symbolId}`);
    }
    return symbol;
  }

  async getGraphNeighborhood(
    nodeId: string,
    depth: number,
    filters: GraphFilters,
  ): Promise<GraphNeighborhood> {
    await delay(180);
    const graph = buildGraph(nodeId);
    const edges = graph.edges.filter((edge) => {
      if (edge.kind === "imports") {
        return filters.includeImports;
      }
      if (edge.kind === "calls") {
        return filters.includeCalls;
      }
      if (edge.kind === "defines") {
        return filters.includeDefines;
      }
      return true;
    });

    const connectedNodeIds = new Set<string>([nodeId]);
    edges.forEach((edge) => {
      connectedNodeIds.add(edge.source);
      connectedNodeIds.add(edge.target);
    });

    return {
      ...graph,
      rootNodeId: nodeId,
      depth,
      truncated: depth < 2,
      edges,
      nodes: graph.nodes.filter((node) => connectedNodeIds.has(node.id)),
    };
  }

  async getOverview(): Promise<OverviewData> {
    await delay(180);
    return buildOverview(this.currentSession);
  }
}
