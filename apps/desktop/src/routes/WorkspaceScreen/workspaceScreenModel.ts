import {
  graphLayoutNodeKey,
  type StoredGraphLayout,
} from "../../components/graph/graphLayoutPersistence";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { DEFAULT_BLUEPRINT_INSPECTOR_DRAWER_HEIGHT } from "../../components/workspace/BlueprintInspectorDrawer";
import { metadataString } from "../../components/workspace/blueprintInspectorUtils";
import type {
  BackendStatus,
  EditableNodeSource,
  FlowGraphDocument,
  GraphAbstractionLevel,
  GraphBreadcrumbDto,
  GraphNodeDto,
  GraphNodeKind,
  GraphView,
  OverviewModule,
  RevealedSource,
  SourceRange,
  WorkspaceFileOperationPreview,
  WorkspaceRecoveryEvent,
} from "../../lib/adapter";
import { isInspectableGraphNodeKind } from "../../lib/adapter";
import type { WorkspaceActivity } from "../../store/uiStore";
import type { GraphPathItem, InspectorSourceReason, InspectorSourceTarget } from "./types";

export const INSPECTOR_DRAWER_HEIGHT_STORAGE_KEY = "helm.blueprint.inspectorDrawerHeight";
export const EXPLORER_SIDEBAR_WIDTH_STORAGE_KEY = "helm.blueprint.explorerSidebarWidth";
export const INSPECTOR_SPACE_TAP_THRESHOLD_MS = 220;
export const DEFAULT_EXPLORER_SIDEBAR_WIDTH = 260;
export const MIN_EXPLORER_SIDEBAR_WIDTH = 220;

export function graphNodeRelativePath(
  metadata: Record<string, unknown> | undefined,
  fallback?: string | null,
) {
  const value = metadata?.relative_path ?? metadata?.relativePath;
  if (typeof value === "string" && (value.includes("/") || value.endsWith(".py"))) {
    return value;
  }
  if (fallback?.endsWith(".py")) {
    return fallback;
  }
  return undefined;
}

export function recoveryActivityFromEvents(
  events?: WorkspaceRecoveryEvent[],
): WorkspaceActivity | undefined {
  if (!events?.length) {
    return undefined;
  }
  const event = events[events.length - 1];
  return {
    domain: "backend",
    kind: "recovery",
    summary: `Recovered interrupted ${event.kind} operation.`,
    touchedRelativePaths: event.touchedRelativePaths,
    warnings: event.warnings.length ? event.warnings : [`Recovery outcome: ${event.outcome}.`],
  };
}

export function graphNodeMetadataNumber(
  metadata: Record<string, unknown> | undefined,
  key: string,
) {
  const value =
    metadata?.[key] ??
    metadata?.[key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())];
  return typeof value === "number" ? value : undefined;
}

export function graphNodeSourceRange(node: GraphNodeDto | undefined): SourceRange | undefined {
  if (!node) {
    return undefined;
  }

  const startLine = graphNodeMetadataNumber(node.metadata, "source_start_line");
  const endLine = graphNodeMetadataNumber(node.metadata, "source_end_line");
  if (typeof startLine !== "number" || typeof endLine !== "number") {
    return undefined;
  }

  const startColumn = graphNodeMetadataNumber(node.metadata, "source_start_column");
  const endColumn = graphNodeMetadataNumber(node.metadata, "source_end_column");
  return {
    startLine,
    endLine,
    startColumn,
    endColumn,
  };
}

export function flowFunctionInputIdForParamNode(
  node: GraphNodeDto | undefined,
  document: FlowGraphDocument | undefined,
): string | undefined {
  if (!node || node.kind !== "param" || !document) {
    return undefined;
  }
  const metadataInputId = metadataString(node, "function_input_id");
  if (metadataInputId && document.functionInputs?.some((input) => input.id === metadataInputId)) {
    return metadataInputId;
  }
  return document.functionInputs?.find((input) => input.name === node.label)?.id;
}

export async function confirmFlowRemoval(
  message: string,
  options: {
    cancelLabel?: string;
    okLabel: string;
    title: string;
  },
) {
  try {
    return await confirmDialog(message, {
      cancelLabel: options.cancelLabel ?? "Cancel",
      kind: "warning",
      okLabel: options.okLabel,
      title: options.title,
    });
  } catch {
    return window.confirm(message);
  }
}

export function formatWorkspacePreviewSize(sizeBytes: number) {
  if (sizeBytes < 1024) {
    return `${sizeBytes} bytes`;
  }
  const units = ["KiB", "MiB", "GiB"];
  let value = sizeBytes / 1024;
  for (const unit of units) {
    if (value < 1024 || unit === units[units.length - 1]) {
      return `${value.toFixed(1)} ${unit}`;
    }
    value /= 1024;
  }
  return `${sizeBytes} bytes`;
}

export function workspaceRecursivePreviewMessage(preview: WorkspaceFileOperationPreview) {
  const counts = preview.counts;
  const lines = [
    `${preview.operationKind === "move" ? "Move" : "Delete"} ${preview.sourceRelativePath}?`,
    preview.targetRelativePath ? `Target: ${preview.targetRelativePath}` : undefined,
    `Entries: ${counts.entryCount} (${counts.fileCount} files, ${counts.directoryCount} folders)`,
    `Total staged size: ${formatWorkspacePreviewSize(counts.totalSizeBytes)}`,
    `Python files: ${counts.pythonFileCount}`,
    ...preview.warnings,
    "Undo available after success.",
  ].filter((line): line is string => Boolean(line));
  return lines.join("\n");
}

export function inspectorSourceTargetForNode(
  node: GraphNodeDto | undefined,
  reason: InspectorSourceReason,
): InspectorSourceTarget | undefined {
  if (!node) {
    return undefined;
  }

  if (isInspectableGraphNodeKind(node.kind)) {
    return {
      targetId: node.id,
      fetchMode: "editable",
      node,
      nodeKind: node.kind,
      reason,
    };
  }

  return undefined;
}

export function inspectorSourceTargetForId(
  targetId: string | undefined,
  reason: InspectorSourceReason,
  node?: GraphNodeDto,
): InspectorSourceTarget | undefined {
  if (!targetId) {
    return undefined;
  }

  const nodeTarget = inspectorSourceTargetForNode(node, reason);
  if (nodeTarget) {
    return nodeTarget;
  }

  if (targetId.startsWith("symbol:")) {
    return {
      targetId,
      fetchMode: "editable",
      node,
      nodeKind: node?.kind,
      reason,
    };
  }

  if (targetId.startsWith("module:")) {
    return {
      targetId,
      fetchMode: "editable",
      node,
      nodeKind: "module",
      reason,
    };
  }

  return undefined;
}

export function readonlyEditableSourceFromReveal(
  source: RevealedSource,
  nodeKind: GraphNodeKind | undefined,
): EditableNodeSource {
  return {
    ...source,
    editable: false,
    nodeKind: nodeKind ?? "module",
    reason: "This source is available for review only.",
  };
}

export function isTextEditingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.closest(".monaco-editor, .monaco-diff-editor")) {
    return true;
  }

  const editableHost = target.closest(
    'input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"]',
  );
  return editableHost instanceof HTMLElement;
}

export function isShortcutBypassTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const interactiveHost = target.closest(
    'button, a[href], summary, [role="button"], [role="link"], [role="menuitem"], [role="switch"], [role="tab"]',
  );
  return interactiveHost instanceof HTMLElement;
}

export function shouldTrackInspectorSpaceTap(
  event: Pick<
    KeyboardEvent,
    "key" | "code" | "repeat" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "target"
  >,
) {
  const pressedSpace = event.code === "Space" || event.key === " " || event.key === "Spacebar";
  if (
    !pressedSpace ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    isTextEditingTarget(event.target) ||
    isShortcutBypassTarget(event.target)
  ) {
    return false;
  }

  return true;
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function readStoredInspectorDrawerHeight() {
  if (typeof window === "undefined" || typeof window.localStorage?.getItem !== "function") {
    return DEFAULT_BLUEPRINT_INSPECTOR_DRAWER_HEIGHT;
  }

  const storedValue = window.localStorage.getItem(INSPECTOR_DRAWER_HEIGHT_STORAGE_KEY);
  const parsedHeight = Number(storedValue);
  return Number.isFinite(parsedHeight) && parsedHeight > 0
    ? parsedHeight
    : DEFAULT_BLUEPRINT_INSPECTOR_DRAWER_HEIGHT;
}

export function readStoredExplorerSidebarWidth() {
  if (typeof window === "undefined" || typeof window.localStorage?.getItem !== "function") {
    return DEFAULT_EXPLORER_SIDEBAR_WIDTH;
  }

  const storedValue = window.localStorage.getItem(EXPLORER_SIDEBAR_WIDTH_STORAGE_KEY);
  const parsedWidth = Number(storedValue);
  return Number.isFinite(parsedWidth) && parsedWidth > 0
    ? parsedWidth
    : DEFAULT_EXPLORER_SIDEBAR_WIDTH;
}

export function clampExplorerSidebarWidth(nextWidth: number, containerWidth: number) {
  const safeContainerWidth = Math.max(
    containerWidth || 0,
    typeof window !== "undefined" ? window.innerWidth : 960,
    960,
  );
  const maxWidth = Math.max(
    MIN_EXPLORER_SIDEBAR_WIDTH,
    Math.min(Math.floor(safeContainerWidth * 0.42), safeContainerWidth - 360),
  );
  return clamp(nextWidth, MIN_EXPLORER_SIDEBAR_WIDTH, maxWidth);
}

export function breadcrumbRelativePath(breadcrumb: GraphBreadcrumbDto): string | undefined {
  if (breadcrumb.level !== "module") {
    return undefined;
  }

  if (typeof breadcrumb.subtitle === "string" && breadcrumb.subtitle.trim()) {
    return breadcrumb.subtitle;
  }

  return undefined;
}

export function graphRevealPath(relativePath?: string): string | undefined {
  const normalizedRelative = (relativePath ?? "")
    .replaceAll("\\", "/")
    .replace(/^\/+/u, "")
    .replace(/\/+$/u, "");

  return normalizedRelative || undefined;
}

export function buildGraphPathItems(graph?: GraphView): GraphPathItem[] {
  if (!graph) {
    return [];
  }

  const items: GraphPathItem[] = [];
  const repoBreadcrumb = graph.breadcrumbs.find((breadcrumb) => breadcrumb.level === "repo");
  const moduleBreadcrumb = graph.breadcrumbs.find((breadcrumb) => breadcrumb.level === "module");
  const symbolBreadcrumb = graph.breadcrumbs.find((breadcrumb) => breadcrumb.level === "symbol");
  const flowBreadcrumb =
    graph.level === "flow"
      ? graph.breadcrumbs.find((breadcrumb) => breadcrumb.level === "flow")
      : undefined;

  if (repoBreadcrumb) {
    items.push({
      key: `repo:${repoBreadcrumb.nodeId}`,
      label: repoBreadcrumb.label,
      breadcrumb: repoBreadcrumb,
    });
  }

  let moduleRevealPath: string | undefined;
  if (moduleBreadcrumb) {
    const relativePath = breadcrumbRelativePath(moduleBreadcrumb);
    moduleRevealPath = graphRevealPath(relativePath);
    if (relativePath) {
      const parts = relativePath.split("/").filter(Boolean);
      parts.forEach((segment, index) => {
        items.push({
          key: `module:${moduleBreadcrumb.nodeId}:${index}:${segment}`,
          label: segment,
          breadcrumb: moduleBreadcrumb,
          revealPath: graphRevealPath(parts.slice(0, index + 1).join("/")),
        });
      });
    } else {
      items.push({
        key: `module:${moduleBreadcrumb.nodeId}`,
        label: moduleBreadcrumb.label,
        breadcrumb: moduleBreadcrumb,
        revealPath: moduleRevealPath,
      });
    }
  }

  if (symbolBreadcrumb) {
    items.push({
      key: `symbol:${symbolBreadcrumb.nodeId}`,
      label: symbolBreadcrumb.label,
      breadcrumb: symbolBreadcrumb,
      revealPath: moduleRevealPath,
    });
  }

  if (flowBreadcrumb) {
    items.push({
      key: `flow:${flowBreadcrumb.nodeId}`,
      label: flowBreadcrumb.label,
      breadcrumb: flowBreadcrumb,
      revealPath: moduleRevealPath,
    });
  }

  return items;
}

export function moduleIdFromSymbolId(symbolId: string): string | undefined {
  if (!symbolId.startsWith("symbol:")) {
    return undefined;
  }

  const parts = symbolId.slice("symbol:".length).split(":");
  const moduleName = parts[0];
  if (!moduleName) {
    return undefined;
  }

  return `module:${moduleName}`;
}

export function moduleNameFromModuleId(moduleId: string): string | undefined {
  return moduleId.startsWith("module:") ? moduleId.slice("module:".length) : undefined;
}

export function symbolNameFromSymbolId(symbolId: string): string | undefined {
  if (!symbolId.startsWith("symbol:")) {
    return undefined;
  }

  const parts = symbolId.slice("symbol:".length).split(":");
  return parts[parts.length - 1];
}

export function moduleIdFromRelativePath(relativePath: string): string {
  return `module:${relativePath.replace(/\.py$/i, "").split("/").filter(Boolean).join(".")}`;
}

export function movedWorkspaceRelativePath(
  relativePath: string | undefined,
  sourceRelativePath: string,
  targetRelativePath: string,
): string | undefined {
  if (!relativePath) {
    return undefined;
  }
  if (relativePath === sourceRelativePath) {
    return targetRelativePath;
  }
  if (relativePath.startsWith(`${sourceRelativePath}/`)) {
    return `${targetRelativePath}${relativePath.slice(sourceRelativePath.length)}`;
  }
  return undefined;
}

export function isWorkspacePathAtOrBelow(
  relativePath: string | undefined,
  ancestorRelativePath: string,
): boolean {
  return Boolean(
    relativePath &&
    (relativePath === ancestorRelativePath || relativePath.startsWith(`${ancestorRelativePath}/`)),
  );
}

export function flowLayoutViewKey(symbolId: string) {
  return `flow|${symbolId}`;
}

export function emptyStoredGraphLayout(): StoredGraphLayout {
  return {
    nodes: {},
    reroutes: [],
    pinnedNodeIds: [],
    groups: [],
  };
}

export function synchronizeFlowLayoutWithDocumentMutation({
  currentDocument,
  nextDocument,
  layout,
  seededNodes = [],
}: {
  currentDocument: FlowGraphDocument;
  nextDocument: FlowGraphDocument;
  layout: StoredGraphLayout;
  seededNodes?: Array<{
    nodeId: string;
    kind: GraphNodeKind;
    position: { x: number; y: number };
  }>;
}) {
  const removedNodeIds = new Set(
    currentDocument.nodes
      .filter((node) => !nextDocument.nodes.some((candidate) => candidate.id === node.id))
      .map((node) => node.id),
  );
  const removedEdgeIds = new Set(
    currentDocument.edges
      .filter((edge) => !nextDocument.edges.some((candidate) => candidate.id === edge.id))
      .map((edge) => edge.id),
  );
  const nextEdgeIds = new Set(nextDocument.edges.map((edge) => edge.id));
  const nextLayout: StoredGraphLayout = {
    nodes: { ...layout.nodes },
    reroutes: layout.reroutes.filter(
      (reroute) => !removedEdgeIds.has(reroute.edgeId) && nextEdgeIds.has(reroute.edgeId),
    ),
    pinnedNodeIds: layout.pinnedNodeIds.filter((nodeId) => !removedNodeIds.has(nodeId)),
    groups: layout.groups
      .map((group) => ({
        ...group,
        memberNodeIds: group.memberNodeIds.filter((nodeId) => !removedNodeIds.has(nodeId)),
      }))
      .filter((group) => group.memberNodeIds.length >= 2),
  };

  currentDocument.nodes.forEach((node) => {
    if (!removedNodeIds.has(node.id)) {
      return;
    }
    delete nextLayout.nodes[graphLayoutNodeKey(node.id, node.kind)];
  });

  seededNodes.forEach(({ nodeId, kind, position }) => {
    nextLayout.nodes[graphLayoutNodeKey(nodeId, kind)] = {
      x: position.x,
      y: position.y,
    };
  });

  return nextLayout;
}

export function symbolIdForModuleAndName(moduleId: string, symbolName: string): string | undefined {
  const moduleName = moduleNameFromModuleId(moduleId);
  if (!moduleName) {
    return undefined;
  }
  return `symbol:${moduleName}:${symbolName}`;
}

export function relativePathForModuleId(
  moduleId: string | undefined,
  modules: OverviewModule[],
): string | undefined {
  if (!moduleId) {
    return undefined;
  }

  return modules.find((module) => module.moduleId === moduleId)?.relativePath;
}

export function buildFallbackGraphPathItems(
  repoSession:
    | {
        id: string;
        name: string;
        path: string;
      }
    | undefined,
  targetId: string | undefined,
  level: GraphAbstractionLevel,
  modules: OverviewModule[],
): GraphPathItem[] {
  if (!repoSession) {
    return [];
  }

  const items: GraphPathItem[] = [
    {
      key: `repo:${repoSession.id}`,
      label: repoSession.name,
      breadcrumb: {
        nodeId: repoSession.id,
        level: "repo",
        label: repoSession.name,
      },
    },
  ];

  const moduleId = targetId?.startsWith("module:")
    ? targetId
    : targetId?.startsWith("symbol:")
      ? moduleIdFromSymbolId(targetId)
      : undefined;
  const modulePath = relativePathForModuleId(moduleId, modules);
  const moduleRevealPath = graphRevealPath(modulePath);

  if (moduleId && modulePath) {
    const parts = modulePath.split("/").filter(Boolean);
    const moduleBreadcrumb: GraphBreadcrumbDto = {
      nodeId: moduleId,
      level: "module",
      label: parts[parts.length - 1] ?? modulePath,
      subtitle: modulePath,
    };
    parts.forEach((segment, index) => {
      items.push({
        key: `fallback-module:${moduleId}:${index}:${segment}`,
        label: segment,
        breadcrumb: moduleBreadcrumb,
        revealPath: graphRevealPath(parts.slice(0, index + 1).join("/")),
      });
    });
  }

  if (targetId?.startsWith("symbol:")) {
    const symbolName = symbolNameFromSymbolId(targetId);
    if (symbolName) {
      items.push({
        key: `fallback-symbol:${targetId}`,
        label: symbolName,
        breadcrumb: {
          nodeId: targetId,
          level: "symbol",
          label: symbolName,
        },
        revealPath: moduleRevealPath,
      });
    }

    if (level === "flow") {
      items.push({
        key: `fallback-flow:${targetId}`,
        label: "Flow",
        breadcrumb: {
          nodeId: `flow:${targetId}`,
          level: "flow",
          label: "Flow",
        },
        revealPath: moduleRevealPath,
      });
    }
  }

  return items;
}

export function workspaceWindowSubtitle(
  repoPath: string | undefined,
  backendStatus: BackendStatus | undefined,
) {
  if (!repoPath) {
    return "Open a local repository to begin.";
  }

  const syncState = backendStatus?.syncState;
  if (syncState === "syncing") {
    return `Repo root: ${repoPath} Â· ${backendStatus?.note ?? "Live sync updating"}`;
  }
  if (syncState === "manual_resync_required") {
    return `Repo root: ${repoPath} Â· ${backendStatus?.note ?? "Live sync needs reindex"}`;
  }
  if (syncState === "error") {
    return `Repo root: ${repoPath} Â· ${backendStatus?.note ?? "Live sync error"}`;
  }
  if (syncState === "synced") {
    return `Repo root: ${repoPath} Â· Live sync on`;
  }
  return `Repo root: ${repoPath}`;
}
