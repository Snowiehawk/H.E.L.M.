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

export interface StoredGraphGroup {
  id: string;
  title: string;
  memberNodeIds: string[];
}

export interface StoredGraphLayout {
  nodes: StoredGraphNodeLayout;
  reroutes: StoredGraphReroute[];
  pinnedNodeIds: string[];
  groups: StoredGraphGroup[];
}

const storedGraphLayoutSnapshots = new Map<string, StoredGraphLayout>();

function emptyStoredGraphLayout(): StoredGraphLayout {
  return {
    nodes: {},
    reroutes: [],
    pinnedNodeIds: [],
    groups: [],
  };
}

function cloneStoredGraphLayout(layout: StoredGraphLayout): StoredGraphLayout {
  return {
    nodes: Object.fromEntries(
      Object.entries(layout.nodes).map(([nodeId, position]) => [
        nodeId,
        { x: position.x, y: position.y },
      ]),
    ),
    reroutes: layout.reroutes.map((reroute) => ({
      id: reroute.id,
      edgeId: reroute.edgeId,
      order: reroute.order,
      x: reroute.x,
      y: reroute.y,
    })),
    pinnedNodeIds: [...layout.pinnedNodeIds],
    groups: layout.groups.map((group) => ({
      id: group.id,
      title: group.title,
      memberNodeIds: [...group.memberNodeIds],
    })),
  };
}

function storedGraphLayoutSnapshotKey(
  repoPath: string | undefined,
  viewKey: string | undefined,
): string | undefined {
  if (!repoPath || !viewKey) {
    return undefined;
  }

  return `${repoPath}\u0000${viewKey}`;
}

function getStoredGraphLayoutSnapshot(
  repoPath: string | undefined,
  viewKey: string | undefined,
): StoredGraphLayout | undefined {
  const snapshotKey = storedGraphLayoutSnapshotKey(repoPath, viewKey);
  if (!snapshotKey) {
    return undefined;
  }

  const snapshot = storedGraphLayoutSnapshots.get(snapshotKey);
  return snapshot ? cloneStoredGraphLayout(snapshot) : undefined;
}

function setStoredGraphLayoutSnapshot(
  repoPath: string | undefined,
  viewKey: string | undefined,
  layout: StoredGraphLayout,
) {
  const snapshotKey = storedGraphLayoutSnapshotKey(repoPath, viewKey);
  if (!snapshotKey) {
    return;
  }

  storedGraphLayoutSnapshots.set(snapshotKey, cloneStoredGraphLayout(layout));
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
  const maybeGroups = Reflect.get(value, "groups");

  if (
    maybeNodes !== undefined
    || maybeReroutes !== undefined
    || maybePinnedNodeIds !== undefined
    || maybeGroups !== undefined
  ) {
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
      groups: Array.isArray(maybeGroups)
        ? maybeGroups.flatMap((item) => {
            if (!item || typeof item !== "object") {
              return [];
            }

            const id = Reflect.get(item, "id");
            const title = Reflect.get(item, "title");
            const memberNodeIds = Reflect.get(item, "memberNodeIds");

            if (
              typeof id !== "string"
              || typeof title !== "string"
              || !Array.isArray(memberNodeIds)
            ) {
              return [];
            }

            return [{
              id,
              title,
              memberNodeIds: memberNodeIds.filter((memberId): memberId is string => typeof memberId === "string"),
            } satisfies StoredGraphGroup];
          })
        : [],
    };
  }

  return {
    nodes: normalizeNodeLayout(value),
    reroutes: [],
    pinnedNodeIds: [],
    groups: [],
  };
}

export function graphLayoutViewKey(graph: GraphView): string {
  const targetKey = graph.level === "repo" ? "repo-root" : graph.targetId;
  return [graph.level, targetKey].join("|");
}

export function peekStoredGraphLayout(
  repoPath: string | undefined,
  viewKey: string | undefined,
): StoredGraphLayout | undefined {
  return getStoredGraphLayoutSnapshot(repoPath, viewKey);
}

export function clearStoredGraphLayoutSnapshotCache() {
  storedGraphLayoutSnapshots.clear();
}

export async function readStoredGraphLayout(
  repoPath: string | undefined,
  viewKey: string | undefined,
): Promise<StoredGraphLayout> {
  if (!repoPath || !viewKey) {
    return emptyStoredGraphLayout();
  }

  const cachedLayout = getStoredGraphLayoutSnapshot(repoPath, viewKey);
  if (cachedLayout) {
    return cachedLayout;
  }

  try {
    const layout = normalizeLayout(await invoke<unknown>("read_repo_graph_layout", {
      repoPath,
      viewKey,
    }));
    setStoredGraphLayoutSnapshot(repoPath, viewKey, layout);
    return cloneStoredGraphLayout(layout);
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

  const normalizedLayout = normalizeLayout(layout);
  setStoredGraphLayoutSnapshot(repoPath, viewKey, normalizedLayout);

  try {
    await invoke("write_repo_graph_layout", {
      repoPath,
      viewKey,
      layoutJson: JSON.stringify(normalizedLayout),
    });
  } catch {
    // Ignore persistence failures and keep dragging interactive.
  }
}
