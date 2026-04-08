import { invoke } from "@tauri-apps/api/core";
import type { GraphNodeKind, GraphView } from "../../lib/adapter";

export interface StoredGraphNodePosition {
  x: number;
  y: number;
}

export type StoredGraphLayout = Record<string, StoredGraphNodePosition>;

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

function normalizeLayout(value: unknown): StoredGraphLayout {
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

export function graphLayoutViewKey(graph: GraphView): string {
  const targetKey = graph.level === "repo" ? "repo-root" : graph.targetId;
  return [graph.level, targetKey].join("|");
}

export async function readStoredGraphLayout(
  repoPath: string | undefined,
  viewKey: string | undefined,
): Promise<StoredGraphLayout> {
  if (!repoPath || !viewKey) {
    return {};
  }

  try {
    const layout = await invoke<unknown>("read_repo_graph_layout", {
      repoPath,
      viewKey,
    });
    return normalizeLayout(layout);
  } catch {
    return {};
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
