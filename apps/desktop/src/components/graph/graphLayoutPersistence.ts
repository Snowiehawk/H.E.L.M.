import { invoke } from "@tauri-apps/api/core";
import type { GraphNodeKind, GraphView } from "../../lib/adapter";

export interface StoredGraphNodePosition {
  x: number;
  y: number;
}

export type StoredGraphNodeLayout = Record<string, StoredGraphNodePosition>;

export interface StoredGraphReroute {
  id: string;
  edgeId: string;
  order: number;
  x: number;
  y: number;
}

export interface StoredGraphLayout {
  nodes: StoredGraphNodeLayout;
  reroutes: StoredGraphReroute[];
  pinnedNodeIds: string[];
}

function emptyStoredGraphLayout(): StoredGraphLayout {
  return {
    nodes: {},
    reroutes: [],
    pinnedNodeIds: [],
  };
}

export function graphLayoutNodeKey(
  nodeId: string,
  kind?: GraphNodeKind,
): string {
  return kind === "repo" || nodeId.startsWith("repo:") ? "repo-root" : nodeId;
}

function normalizePosition(value: unknown): StoredGraphNodePosition | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const x = Reflect.get(value, "x");
  const y = Reflect.get(value, "y");
  if (typeof x !== "number" || typeof y !== "number") {
    return null;
  }

  return { x, y };
}

function normalizeNodeLayout(value: unknown): StoredGraphNodeLayout {
  if (!value || typeof value !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([nodeId, position]) => {
      const normalized = normalizePosition(position);
      return normalized ? [[nodeId, normalized] as const] : [];
    }),
  );
}

function normalizeReroute(value: unknown): StoredGraphReroute | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const id = Reflect.get(value, "id");
  const edgeId = Reflect.get(value, "edgeId");
  const order = Reflect.get(value, "order");
  const x = Reflect.get(value, "x");
  const y = Reflect.get(value, "y");

  if (
    typeof id !== "string"
    || typeof edgeId !== "string"
    || typeof order !== "number"
    || typeof x !== "number"
    || typeof y !== "number"
  ) {
    return null;
  }

  return {
    id,
    edgeId,
    order,
    x,
    y,
  };
}

function normalizeLayout(value: unknown): StoredGraphLayout {
  if (!value || typeof value !== "object") {
    return emptyStoredGraphLayout();
  }

  const maybeNodes = Reflect.get(value, "nodes");
  const maybeReroutes = Reflect.get(value, "reroutes");
  const maybePinnedNodeIds = Reflect.get(value, "pinnedNodeIds");

  if (maybeNodes !== undefined || maybeReroutes !== undefined || maybePinnedNodeIds !== undefined) {
    return {
      nodes: normalizeNodeLayout(maybeNodes),
      reroutes: Array.isArray(maybeReroutes)
        ? maybeReroutes.flatMap((item) => {
            const normalized = normalizeReroute(item);
            return normalized ? [normalized] : [];
          })
        : [],
      pinnedNodeIds: Array.isArray(maybePinnedNodeIds)
        ? maybePinnedNodeIds.filter((item): item is string => typeof item === "string")
        : [],
    };
  }

  return {
    nodes: normalizeNodeLayout(value),
    reroutes: [],
    pinnedNodeIds: [],
  };
}

export function graphLayoutViewKey(graph: GraphView): string {
  const targetKey = graph.level === "repo" ? "repo-root" : graph.targetId;
  return [graph.level, targetKey].join("|");
}

export async function readStoredGraphLayout(
  repoPath: string | undefined,
  viewKey: string | undefined,
): Promise<StoredGraphLayout> {
  if (!repoPath || !viewKey) {
    return emptyStoredGraphLayout();
  }

  try {
    const layout = await invoke<unknown>("read_repo_graph_layout", {
      repoPath,
      viewKey,
    });
    return normalizeLayout(layout);
  } catch {
    return emptyStoredGraphLayout();
  }
}

export async function writeStoredGraphLayout(
  repoPath: string | undefined,
  viewKey: string | undefined,
  layout: StoredGraphLayout,
): Promise<void> {
  if (!repoPath || !viewKey) {
    return;
  }

  try {
    await invoke("write_repo_graph_layout", {
      repoPath,
      viewKey,
      layoutJson: JSON.stringify(layout),
    });
  } catch {
    // Ignore persistence failures and keep dragging interactive.
  }
}
