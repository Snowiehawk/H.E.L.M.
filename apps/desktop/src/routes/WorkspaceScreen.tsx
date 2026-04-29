import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { CommandPalette } from "../components/CommandPalette";
import {
  GraphCanvas,
  type CreateModeState,
  type GraphCreateIntent,
  type GraphExpressionGraphIntent,
  type GraphFlowConnectionIntent,
  type GraphFlowDeleteIntent,
  type GraphFlowEditIntent,
} from "../components/graph/GraphCanvas";
import {
  establishFlowDraftDocument,
  functionInputParamNodeId,
  parseFunctionInputSourceHandle,
  parseInputSlotTargetHandle,
  parseParameterEntryEdgeInputId,
  parseValueSourceHandle,
  projectFlowDraftGraph,
} from "../components/graph/flowDraftGraph";
import {
  graphLayoutNodeKey,
  peekStoredGraphLayout,
  readStoredGraphLayout,
  type StoredGraphLayout,
  writeStoredGraphLayout,
} from "../components/graph/graphLayoutPersistence";
import {
  addDisconnectedFlowNode,
  addFlowFunctionInput,
  createFlowNode,
  flowDocumentHandleFromBlueprintHandle,
  flowFunctionInputRemovalSummary,
  flowDocumentsEqual,
  flowNodePayloadFromContent,
  insertFlowNodeOnEdge,
  isFlowNodeAuthorableKind,
  mergeFlowDraftWithSourceDocument,
  moveFlowFunctionInput,
  parseReturnInputTargetHandle,
  removeFlowEdges,
  removeFlowFunctionInputAndDownstreamUses,
  removeFlowInputBindings,
  removeFlowNodes,
  updateFlowFunctionInput,
  updateFlowNodePayload,
  upsertFlowConnection,
  upsertFlowInputBinding,
  upsertFlowReturnInputBinding,
  validateFlowConnection,
  validateFlowInputBindingConnection,
  validateFlowReturnInputBindingConnection,
} from "../components/graph/flowDocument";
import { DesktopWindow } from "../components/layout/DesktopWindow";
import { InspectorCodeSurface } from "../components/editor/InspectorCodeSurface";
import { inferInspectorLanguage } from "../components/editor/inspectorLanguage";
import { SidebarPane } from "../components/panes/SidebarPane";
import { AppWindowActions } from "../components/shared/AppWindowActions";
import { StatusPill } from "../components/shared/StatusPill";
import { BlueprintInspector } from "../components/workspace/BlueprintInspector";
import {
  GraphCreateComposer,
  type GraphCreateComposerState,
  type GraphCreateComposerSubmit,
} from "../components/workspace/GraphCreateComposer";
import { FlowExpressionGraphCanvas } from "../components/workspace/FlowExpressionGraphCanvas";
import {
  EMPTY_EXPRESSION_GRAPH,
  normalizeExpressionGraphOrEmpty,
  returnExpressionFromPayload,
} from "../components/graph/flowExpressionGraphEditing";
import {
  expressionFromFlowExpressionGraph,
  normalizeFlowExpressionGraph,
} from "../components/graph/flowExpressionGraph";
import {
  BlueprintInspectorDrawer,
  type BlueprintInspectorDrawerAction,
  DEFAULT_BLUEPRINT_INSPECTOR_DRAWER_HEIGHT,
} from "../components/workspace/BlueprintInspectorDrawer";
import {
  relativePathForNode,
  metadataString,
  revealActionEnabled,
  selectionSummary,
} from "../components/workspace/blueprintInspectorUtils";
import {
  WorkspaceHelpProvider,
  WorkspaceHelpScope,
  helpTargetProps,
} from "../components/workspace/workspaceHelp";
import { useDesktopAdapter } from "../lib/adapter";
import type {
  BackendStatus,
  BackendUndoTransaction,
  EditableNodeSource,
  FlowExpressionGraph,
  FlowGraphDocument,
  FlowInputSlot,
  GraphAbstractionLevel,
  GraphBreadcrumbDto,
  GraphNodeDto,
  GraphNodeKind,
  GraphView,
  OverviewModule,
  RevealedSource,
  SearchResult,
  SourceRange,
  StructuralEditRequest,
  WorkspaceFileContents,
  WorkspaceFileDeleteRequest,
  WorkspaceFileMoveRequest,
  WorkspaceFileMutationRequest,
  WorkspaceRecoveryEvent,
} from "../lib/adapter";
import {
  isEnterableGraphNodeKind,
  isGraphSymbolNodeKind,
  isInspectableGraphNodeKind,
} from "../lib/adapter";
import { useUiStore } from "../store/uiStore";
import type { WorkspaceActivity } from "../store/uiStore";
import { useUndoStore, type UndoEntry } from "../store/undoStore";

function graphNodeRelativePath(
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

function recoveryActivityFromEvents(
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

function graphNodeMetadataNumber(metadata: Record<string, unknown> | undefined, key: string) {
  const value =
    metadata?.[key] ??
    metadata?.[key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())];
  return typeof value === "number" ? value : undefined;
}

function graphNodeSourceRange(node: GraphNodeDto | undefined): SourceRange | undefined {
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

function flowFunctionInputIdForParamNode(
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

async function confirmFlowRemoval(
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

type InspectorSourceFetchMode = "editable" | "revealed";
type InspectorSourceReason = "pinned" | "selected" | "flow-owner" | "module-context";

interface InspectorSourceTarget {
  targetId: string;
  fetchMode: InspectorSourceFetchMode;
  node?: GraphNodeDto;
  nodeKind?: GraphNodeKind;
  reason: InspectorSourceReason;
}

function inspectorSourceTargetForNode(
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

function inspectorSourceTargetForId(
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

function readonlyEditableSourceFromReveal(
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

function isTextEditingTarget(target: EventTarget | null) {
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

function isShortcutBypassTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const interactiveHost = target.closest(
    'button, a[href], summary, [role="button"], [role="link"], [role="menuitem"], [role="switch"], [role="tab"]',
  );
  return interactiveHost instanceof HTMLElement;
}

function shouldTrackInspectorSpaceTap(
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

interface GraphPathItem {
  key: string;
  label: string;
  breadcrumb?: GraphBreadcrumbDto;
  revealPath?: string;
}

type InspectorPanelMode = "hidden" | "collapsed" | "expanded";

interface BackendUndoHistoryEntry {
  transaction: BackendUndoTransaction;
  entry: UndoEntry;
}

type FlowDraftStatus = "idle" | "dirty" | "saving" | "reconcile-pending";

interface FlowDraftState {
  symbolId: string;
  baseDocument: FlowGraphDocument;
  document: FlowGraphDocument;
  status: FlowDraftStatus;
  error: string | null;
  reconcileAfterUpdatedAt?: number;
}

interface ReturnExpressionGraphViewState {
  symbolId: string;
  returnNodeId: string;
  selectedExpressionNodeId?: string;
  draftGraph?: FlowExpressionGraph;
  draftExpression?: string;
  diagnostics: string[];
  isDraftOnly: boolean;
  error: string | null;
}

type ResolvedFlowInputBindingConnection =
  | {
      kind: "slot";
      sourceId: string;
      slotId: string;
    }
  | {
      kind: "return-input";
      sourceId: string;
      targetNodeId: string;
    };

const INSPECTOR_DRAWER_HEIGHT_STORAGE_KEY = "helm.blueprint.inspectorDrawerHeight";
const EXPLORER_SIDEBAR_WIDTH_STORAGE_KEY = "helm.blueprint.explorerSidebarWidth";
const INSPECTOR_SPACE_TAP_THRESHOLD_MS = 220;
const DEFAULT_EXPLORER_SIDEBAR_WIDTH = 260;
const MIN_EXPLORER_SIDEBAR_WIDTH = 220;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function readStoredInspectorDrawerHeight() {
  if (typeof window === "undefined" || typeof window.localStorage?.getItem !== "function") {
    return DEFAULT_BLUEPRINT_INSPECTOR_DRAWER_HEIGHT;
  }

  const storedValue = window.localStorage.getItem(INSPECTOR_DRAWER_HEIGHT_STORAGE_KEY);
  const parsedHeight = Number(storedValue);
  return Number.isFinite(parsedHeight) && parsedHeight > 0
    ? parsedHeight
    : DEFAULT_BLUEPRINT_INSPECTOR_DRAWER_HEIGHT;
}

function readStoredExplorerSidebarWidth() {
  if (typeof window === "undefined" || typeof window.localStorage?.getItem !== "function") {
    return DEFAULT_EXPLORER_SIDEBAR_WIDTH;
  }

  const storedValue = window.localStorage.getItem(EXPLORER_SIDEBAR_WIDTH_STORAGE_KEY);
  const parsedWidth = Number(storedValue);
  return Number.isFinite(parsedWidth) && parsedWidth > 0
    ? parsedWidth
    : DEFAULT_EXPLORER_SIDEBAR_WIDTH;
}

function clampExplorerSidebarWidth(nextWidth: number, containerWidth: number) {
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

function breadcrumbRelativePath(breadcrumb: GraphBreadcrumbDto): string | undefined {
  if (breadcrumb.level !== "module") {
    return undefined;
  }

  if (typeof breadcrumb.subtitle === "string" && breadcrumb.subtitle.trim()) {
    return breadcrumb.subtitle;
  }

  return undefined;
}

function graphRevealPath(relativePath?: string): string | undefined {
  const normalizedRelative = (relativePath ?? "")
    .replaceAll("\\", "/")
    .replace(/^\/+/u, "")
    .replace(/\/+$/u, "");

  return normalizedRelative || undefined;
}

function buildGraphPathItems(graph?: GraphView): GraphPathItem[] {
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

function moduleIdFromSymbolId(symbolId: string): string | undefined {
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

function moduleNameFromModuleId(moduleId: string): string | undefined {
  return moduleId.startsWith("module:") ? moduleId.slice("module:".length) : undefined;
}

function symbolNameFromSymbolId(symbolId: string): string | undefined {
  if (!symbolId.startsWith("symbol:")) {
    return undefined;
  }

  const parts = symbolId.slice("symbol:".length).split(":");
  return parts[parts.length - 1];
}

function moduleIdFromRelativePath(relativePath: string): string {
  return `module:${relativePath.replace(/\.py$/i, "").split("/").filter(Boolean).join(".")}`;
}

function movedWorkspaceRelativePath(
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

function isWorkspacePathAtOrBelow(
  relativePath: string | undefined,
  ancestorRelativePath: string,
): boolean {
  return Boolean(
    relativePath &&
    (relativePath === ancestorRelativePath || relativePath.startsWith(`${ancestorRelativePath}/`)),
  );
}

function flowLayoutViewKey(symbolId: string) {
  return `flow|${symbolId}`;
}

function emptyStoredGraphLayout(): StoredGraphLayout {
  return {
    nodes: {},
    reroutes: [],
    pinnedNodeIds: [],
    groups: [],
  };
}

function synchronizeFlowLayoutWithDocumentMutation({
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

function symbolIdForModuleAndName(moduleId: string, symbolName: string): string | undefined {
  const moduleName = moduleNameFromModuleId(moduleId);
  if (!moduleName) {
    return undefined;
  }
  return `symbol:${moduleName}:${symbolName}`;
}

function relativePathForModuleId(
  moduleId: string | undefined,
  modules: OverviewModule[],
): string | undefined {
  if (!moduleId) {
    return undefined;
  }

  return modules.find((module) => module.moduleId === moduleId)?.relativePath;
}

function buildFallbackGraphPathItems(
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

function workspaceWindowSubtitle(
  repoPath: string | undefined,
  backendStatus: BackendStatus | undefined,
) {
  if (!repoPath) {
    return "Open a local repository to begin.";
  }

  const syncState = backendStatus?.syncState;
  if (syncState === "syncing") {
    return `Repo root: ${repoPath} · ${backendStatus?.note ?? "Live sync updating"}`;
  }
  if (syncState === "manual_resync_required") {
    return `Repo root: ${repoPath} · ${backendStatus?.note ?? "Live sync needs reindex"}`;
  }
  if (syncState === "error") {
    return `Repo root: ${repoPath} · ${backendStatus?.note ?? "Live sync error"}`;
  }
  if (syncState === "synced") {
    return `Repo root: ${repoPath} · Live sync on`;
  }
  return `Repo root: ${repoPath}`;
}

function WorkspaceFileEditorPanel({
  file,
  draft,
  dirty,
  stale,
  error,
  isLoading,
  isSaving,
  saveError,
  onCancel,
  onChange,
  onClose,
  onSave,
}: {
  file?: WorkspaceFileContents;
  draft: string;
  dirty: boolean;
  stale: boolean;
  error?: string | null;
  isLoading: boolean;
  isSaving: boolean;
  saveError?: string | null;
  onCancel: () => void;
  onChange: (content: string) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const language = inferInspectorLanguage({
    editablePath: file?.relativePath,
  });
  const status = stale ? "Stale" : dirty ? "Unsaved" : "Synced";

  return (
    <aside className="workspace-file-editor">
      <div className="workspace-file-editor__header">
        <div>
          <span className="window-bar__eyebrow">File editor</span>
          <h3>{file?.relativePath ?? "Loading file"}</h3>
        </div>
        <button className="ghost-button" type="button" onClick={onClose}>
          Close
        </button>
      </div>

      {isLoading ? (
        <div className="info-card">
          <p>Loading file...</p>
        </div>
      ) : error ? (
        <div className="info-card blueprint-inspector__error-card">
          <strong>File unavailable</strong>
          <p>{error}</p>
        </div>
      ) : file?.editable ? (
        <>
          <div className="workspace-file-editor__meta">
            <span>{file.sizeBytes ?? 0} bytes</span>
            <StatusPill tone={stale ? "warning" : dirty ? "accent" : "default"}>
              {status}
            </StatusPill>
          </div>
          <InspectorCodeSurface
            ariaLabel={`Edit ${file.relativePath}`}
            className="workspace-file-editor__surface"
            dataTestId="workspace-file-editor"
            height="clamp(300px, 42vh, 520px)"
            language={language}
            path={file.relativePath}
            readOnly={false}
            value={draft}
            onChange={onChange}
          />
          {stale ? (
            <div className="info-card blueprint-inspector__error-card">
              <strong>Draft is stale</strong>
              <p>This file changed on disk. Reload it before saving again.</p>
            </div>
          ) : null}
          {saveError ? <p className="error-copy">{saveError}</p> : null}
          <div className="workspace-file-editor__actions">
            <button
              className="primary-button"
              type="button"
              disabled={stale || !dirty || isSaving}
              onClick={onSave}
            >
              {isSaving ? "Saving..." : "Save"}
            </button>
            <button
              className="ghost-button"
              type="button"
              disabled={(!dirty && !stale) || isSaving}
              onClick={onCancel}
            >
              {stale ? "Reload from Disk" : "Cancel"}
            </button>
          </div>
        </>
      ) : file ? (
        <>
          <InspectorCodeSurface
            ariaLabel={`Read-only ${file.relativePath}`}
            className="workspace-file-editor__surface"
            dataTestId="workspace-file-editor-readonly"
            height="clamp(240px, 34vh, 420px)"
            language={language}
            path={file.relativePath}
            readOnly
            value={file.content}
          />
          <div className="info-card">
            <strong>Read only</strong>
            <p>{file.reason ?? "This file is not editable inline."}</p>
          </div>
        </>
      ) : null}
    </aside>
  );
}

export function WorkspaceScreen() {
  const adapter = useDesktopAdapter();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [repoOpenError, setRepoOpenError] = useState<string | null>(null);
  const [inspectorPanelMode, setInspectorPanelMode] = useState<InspectorPanelMode>("hidden");
  const [inspectorTargetId, setInspectorTargetId] = useState<string | undefined>(undefined);
  const [inspectorSnapshot, setInspectorSnapshot] = useState<GraphView["nodes"][number]>();
  const [inspectorDrawerHeight, setInspectorDrawerHeight] = useState(
    readStoredInspectorDrawerHeight,
  );
  const [explorerSidebarWidth, setExplorerSidebarWidth] = useState(readStoredExplorerSidebarWidth);
  const [isSavingSource, setIsSavingSource] = useState(false);
  const [createModeState, setCreateModeState] = useState<CreateModeState>("inactive");
  const [createComposer, setCreateComposer] = useState<GraphCreateComposerState | undefined>(
    undefined,
  );
  const [isSubmittingCreate, setIsSubmittingCreate] = useState(false);
  const [returnExpressionGraphView, setReturnExpressionGraphView] = useState<
    ReturnExpressionGraphViewState | undefined
  >(undefined);
  const [isSubmittingExpressionGraph, setIsSubmittingExpressionGraph] = useState(false);
  const [flowDraftState, setFlowDraftState] = useState<FlowDraftState | undefined>(undefined);
  const [activeWorkspaceFilePath, setActiveWorkspaceFilePath] = useState<string | undefined>(
    undefined,
  );
  const [workspaceFileDraft, setWorkspaceFileDraft] = useState("");
  const [workspaceFileStale, setWorkspaceFileStale] = useState(false);
  const [workspaceFileSaveError, setWorkspaceFileSaveError] = useState<string | null>(null);
  const [isSavingWorkspaceFile, setIsSavingWorkspaceFile] = useState(false);
  const [inspectorDirty, setInspectorDirty] = useState(false);
  const [inspectorDraftStale, setInspectorDraftStale] = useState(false);
  const [inspectorActionError, setInspectorActionError] = useState<string | null>(null);
  const [createModeError, setCreateModeError] = useState<string | null>(null);
  const inspectorSpaceTapRef = useRef<{ startedAt: number; cancelled: boolean } | null>(null);
  const workspaceLayoutRef = useRef<HTMLDivElement>(null);
  const [workspaceLayoutWidth, setWorkspaceLayoutWidth] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth : 1280,
  );
  const [dismissedPeekNodeId, setDismissedPeekNodeId] = useState<string | undefined>(undefined);
  const [pendingCreatedNodeId, setPendingCreatedNodeId] = useState<string | undefined>(undefined);
  const inspectorDraftContentRef = useRef<string | undefined>(undefined);
  const saveInspectorDraftRef = useRef<(targetId: string, draftContent: string) => Promise<void>>(
    async () => {},
  );
  const createModeContextKeyRef = useRef<string | undefined>(undefined);
  const workspaceFileLoadedKeyRef = useRef<string | undefined>(undefined);
  const [graphPathRevealError, setGraphPathRevealError] = useState<string | null>(null);
  const [backendUndoStack, setBackendUndoStack] = useState<BackendUndoHistoryEntry[]>([]);
  const [backendRedoStack, setBackendRedoStack] = useState<BackendUndoHistoryEntry[]>([]);
  const [inspectorEditableSourceOverride, setInspectorEditableSourceOverride] = useState<
    EditableNodeSource | undefined
  >(undefined);
  const [inspectorSourceVersion, setInspectorSourceVersion] = useState(0);
  const repoSession = useUiStore((state) => state.repoSession);
  const graphTargetId = useUiStore((state) => state.graphTargetId);
  const activeLevel = useUiStore((state) => state.activeLevel);
  const activeNodeId = useUiStore((state) => state.activeNodeId);
  const activeSymbolId = useUiStore((state) => state.activeSymbolId);
  const graphFilters = useUiStore((state) => state.graphFilters);
  const graphSettings = useUiStore((state) => state.graphSettings);
  const flowInputDisplayMode = useUiStore((state) => state.flowInputDisplayMode);
  const highlightGraphPath = useUiStore((state) => state.highlightGraphPath);
  const showEdgeLabels = useUiStore((state) => state.showEdgeLabels);
  const sidebarQuery = useUiStore((state) => state.sidebarQuery);
  const revealedSource = useUiStore((state) => state.revealedSource);
  const lastActivity = useUiStore((state) => state.lastActivity);
  const setSidebarQuery = useUiStore((state) => state.setSidebarQuery);
  const setSession = useUiStore((state) => state.setSession);
  const initializeWorkspace = useUiStore((state) => state.initializeWorkspace);
  const selectSearchResult = useUiStore((state) => state.selectSearchResult);
  const focusGraph = useUiStore((state) => state.focusGraph);
  const selectNode = useUiStore((state) => state.selectNode);
  const toggleGraphFilter = useUiStore((state) => state.toggleGraphFilter);
  const toggleGraphSetting = useUiStore((state) => state.toggleGraphSetting);
  const setFlowInputDisplayMode = useUiStore((state) => state.setFlowInputDisplayMode);
  const toggleGraphPathHighlight = useUiStore((state) => state.toggleGraphPathHighlight);
  const toggleEdgeLabels = useUiStore((state) => state.toggleEdgeLabels);
  const setRevealedSource = useUiStore((state) => state.setRevealedSource);
  const setLastEdit = useUiStore((state) => state.setLastEdit);
  const setLastActivity = useUiStore((state) => state.setLastActivity);
  const resetWorkspace = useUiStore((state) => state.resetWorkspace);
  const surfaceRecoveryEvents = useCallback(
    (events?: WorkspaceRecoveryEvent[]) => {
      const activity = recoveryActivityFromEvents(events);
      if (activity) {
        setLastActivity(activity);
      }
    },
    [setLastActivity],
  );

  useEffect(() => {
    if (!repoSession) {
      navigate("/", { replace: true });
    }
  }, [navigate, repoSession]);

  useEffect(() => {
    if (!repoSession) {
      setInspectorPanelMode("hidden");
      setInspectorTargetId(undefined);
      setInspectorSnapshot(undefined);
      inspectorDraftContentRef.current = undefined;
      setInspectorDirty(false);
      setInspectorDraftStale(false);
      setInspectorEditableSourceOverride(undefined);
      setInspectorSourceVersion(0);
      setDismissedPeekNodeId(undefined);
      setCreateModeState("inactive");
      setCreateComposer(undefined);
      setCreateModeError(null);
      setFlowDraftState(undefined);
      setActiveWorkspaceFilePath(undefined);
      setWorkspaceFileDraft("");
      setWorkspaceFileStale(false);
      setWorkspaceFileSaveError(null);
      setIsSavingWorkspaceFile(false);
      setPendingCreatedNodeId(undefined);
      setBackendUndoStack([]);
      setBackendRedoStack([]);
    }
  }, [repoSession]);

  useEffect(() => {
    setBackendUndoStack([]);
    setBackendRedoStack([]);
    setInspectorDraftStale(false);
    setActiveWorkspaceFilePath(undefined);
    setWorkspaceFileDraft("");
    setWorkspaceFileStale(false);
    setWorkspaceFileSaveError(null);
  }, [repoSession?.id]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.localStorage?.setItem !== "function") {
      return;
    }

    window.localStorage.setItem(
      INSPECTOR_DRAWER_HEIGHT_STORAGE_KEY,
      String(Math.round(inspectorDrawerHeight)),
    );
  }, [inspectorDrawerHeight]);

  useEffect(() => {
    const layout = workspaceLayoutRef.current;
    if (!(layout instanceof HTMLElement)) {
      return;
    }

    const updateWidth = () => {
      setWorkspaceLayoutWidth(layout.clientWidth || window.innerWidth || 1280);
    };

    updateWidth();

    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(() => {
        updateWidth();
      });
      observer.observe(layout);
      return () => observer.disconnect();
    }

    window.addEventListener("resize", updateWidth);
    return () => window.removeEventListener("resize", updateWidth);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.localStorage?.setItem !== "function") {
      return;
    }

    window.localStorage.setItem(
      EXPLORER_SIDEBAR_WIDTH_STORAGE_KEY,
      String(Math.round(explorerSidebarWidth)),
    );
  }, [explorerSidebarWidth]);

  const overviewQuery = useQuery({
    queryKey: ["overview", repoSession?.id],
    queryFn: () => adapter.getOverview(),
    enabled: Boolean(repoSession),
  });

  const workspaceFilesQuery = useQuery({
    queryKey: ["workspace-files", repoSession?.id],
    queryFn: () => adapter.listWorkspaceFiles(repoSession!.path),
    enabled: Boolean(repoSession),
  });

  useEffect(() => {
    if (!graphTargetId && overviewQuery.data) {
      initializeWorkspace(overviewQuery.data.defaultFocusNodeId, overviewQuery.data.defaultLevel);
    }
  }, [graphTargetId, initializeWorkspace, overviewQuery.data]);

  const backendStatusQuery = useQuery({
    queryKey: ["backend-status"],
    queryFn: () => adapter.getBackendStatus(),
  });

  const sidebarSearchQuery = useQuery({
    queryKey: ["workspace-search", repoSession?.id, sidebarQuery],
    queryFn: () =>
      adapter.searchRepo(sidebarQuery, {
        includeModules: true,
        includeFiles: true,
        includeSymbols: true,
      }),
    enabled: Boolean(repoSession) && sidebarQuery.trim().length > 0,
  });

  const graphQuery = useQuery({
    queryKey: [
      "graph-view",
      repoSession?.id,
      graphTargetId,
      activeLevel,
      graphFilters,
      graphSettings,
    ],
    queryFn: () => {
      if (activeLevel === "flow") {
        return adapter.getFlowView(graphTargetId as string);
      }
      return adapter.getGraphView(
        graphTargetId as string,
        activeLevel,
        graphFilters,
        graphSettings,
      );
    },
    enabled: Boolean(repoSession && graphTargetId),
  });

  const workspaceFileQuery = useQuery({
    queryKey: ["workspace-file", repoSession?.id, activeWorkspaceFilePath],
    queryFn: () => adapter.readWorkspaceFile(repoSession!.path, activeWorkspaceFilePath!),
    enabled: Boolean(repoSession && activeWorkspaceFilePath),
  });
  const activeWorkspaceFile = workspaceFileQuery.data;
  const workspaceFileDirty = Boolean(
    activeWorkspaceFile?.editable && workspaceFileDraft !== activeWorkspaceFile.content,
  );

  useEffect(() => {
    if (!activeWorkspaceFile) {
      return;
    }

    const loadedKey = `${activeWorkspaceFile.relativePath}:${activeWorkspaceFile.version}`;
    if (workspaceFileLoadedKeyRef.current !== loadedKey) {
      if (workspaceFileLoadedKeyRef.current && workspaceFileDirty) {
        setWorkspaceFileStale(true);
        workspaceFileLoadedKeyRef.current = loadedKey;
        return;
      }

      workspaceFileLoadedKeyRef.current = loadedKey;
      setWorkspaceFileDraft(activeWorkspaceFile.content);
      setWorkspaceFileStale(false);
      setWorkspaceFileSaveError(null);
      return;
    }

    if (!workspaceFileDirty && !workspaceFileStale) {
      setWorkspaceFileDraft(activeWorkspaceFile.content);
    }
  }, [activeWorkspaceFile, workspaceFileDirty, workspaceFileStale]);
  const currentSymbolTargetId = graphTargetId?.startsWith("symbol:") ? graphTargetId : undefined;
  const currentFlowSymbolId = activeLevel === "flow" ? currentSymbolTargetId : undefined;
  const flowDraftSeedDocument = useMemo(
    () => establishFlowDraftDocument(graphQuery.data),
    [graphQuery.data],
  );

  useEffect(() => {
    if (
      !currentSymbolTargetId ||
      !flowDraftState?.symbolId ||
      currentSymbolTargetId === flowDraftState.symbolId
    ) {
      return;
    }

    setFlowDraftState(undefined);
  }, [currentSymbolTargetId, flowDraftState?.symbolId]);

  useEffect(() => {
    if (!currentFlowSymbolId || !flowDraftSeedDocument) {
      return;
    }

    setFlowDraftState((current) => {
      if (!current || current.symbolId !== currentFlowSymbolId) {
        return {
          symbolId: currentFlowSymbolId,
          baseDocument: flowDraftSeedDocument,
          document: flowDraftSeedDocument,
          status: "idle",
          error: null,
        };
      }

      if (current.status === "saving") {
        return current;
      }

      if (
        current.status === "reconcile-pending" &&
        (current.reconcileAfterUpdatedAt ?? 0) >= graphQuery.dataUpdatedAt
      ) {
        return current;
      }

      const mergedDocument = mergeFlowDraftWithSourceDocument(
        current.document,
        current.baseDocument,
        flowDraftSeedDocument,
      );
      const nextStatus = current.status === "reconcile-pending" ? "idle" : current.status;
      const nextError = current.status === "reconcile-pending" ? null : current.error;
      if (
        flowDocumentsEqual(current.baseDocument, flowDraftSeedDocument) &&
        flowDocumentsEqual(current.document, mergedDocument) &&
        current.status === nextStatus &&
        current.error === nextError
      ) {
        return current;
      }

      return {
        symbolId: currentFlowSymbolId,
        baseDocument: flowDraftSeedDocument,
        document: mergedDocument,
        status: nextStatus,
        error: nextError,
        reconcileAfterUpdatedAt: undefined,
      };
    });
  }, [currentFlowSymbolId, flowDraftSeedDocument, graphQuery.dataUpdatedAt]);

  const activeFlowDraft =
    currentFlowSymbolId && flowDraftState?.symbolId === currentFlowSymbolId
      ? flowDraftState
      : undefined;
  const effectiveGraph = useMemo(() => {
    if (activeLevel === "flow" && graphQuery.data && activeFlowDraft) {
      return projectFlowDraftGraph(graphQuery.data, activeFlowDraft.document, flowInputDisplayMode);
    }
    return graphQuery.data;
  }, [activeFlowDraft, activeLevel, flowInputDisplayMode, graphQuery.data]);
  const returnExpressionFlowDocument = useMemo(() => {
    if (!returnExpressionGraphView || activeLevel !== "flow") {
      return undefined;
    }
    if (activeFlowDraft?.symbolId === returnExpressionGraphView.symbolId) {
      return activeFlowDraft.document;
    }
    if (flowDraftSeedDocument?.symbolId === returnExpressionGraphView.symbolId) {
      return flowDraftSeedDocument;
    }
    return undefined;
  }, [activeFlowDraft, activeLevel, flowDraftSeedDocument, returnExpressionGraphView]);

  useEffect(() => {
    if (!returnExpressionGraphView) {
      return;
    }
    const returnNode =
      activeLevel === "flow" &&
      returnExpressionFlowDocument?.symbolId === returnExpressionGraphView.symbolId
        ? returnExpressionFlowDocument.nodes.find(
            (node) => node.id === returnExpressionGraphView.returnNodeId && node.kind === "return",
          )
        : undefined;

    if (!returnNode) {
      setReturnExpressionGraphView(undefined);
      setIsSubmittingExpressionGraph(false);
      return;
    }

    if (returnExpressionGraphView.isDraftOnly) {
      return;
    }

    setReturnExpressionGraphView((current) => {
      if (!current || current.isDraftOnly) {
        return current;
      }
      const selectedExpressionNodeStillExists =
        current.selectedExpressionNodeId &&
        normalizeExpressionGraphOrEmpty(
          returnNode.payload.expression_graph as FlowExpressionGraph | undefined,
        ).nodes.some((node) => node.id === current.selectedExpressionNodeId);
      const nextSelectedExpressionNodeId = selectedExpressionNodeStillExists
        ? current.selectedExpressionNodeId
        : undefined;
      if (
        current.draftGraph === undefined &&
        current.draftExpression === undefined &&
        current.diagnostics.length === 0 &&
        current.error === null &&
        current.selectedExpressionNodeId === nextSelectedExpressionNodeId
      ) {
        return current;
      }
      return {
        ...current,
        draftGraph: undefined,
        draftExpression: undefined,
        diagnostics: [],
        error: null,
        selectedExpressionNodeId: nextSelectedExpressionNodeId,
      };
    });
  }, [activeLevel, returnExpressionFlowDocument, returnExpressionGraphView]);

  const returnExpressionGraphViewNode = useMemo(
    () =>
      returnExpressionGraphView && returnExpressionFlowDocument
        ? returnExpressionFlowDocument.nodes.find(
            (node) => node.id === returnExpressionGraphView.returnNodeId && node.kind === "return",
          )
        : undefined,
    [returnExpressionFlowDocument, returnExpressionGraphView],
  );
  const returnExpressionGraphViewInputSlots = useMemo<FlowInputSlot[]>(() => {
    if (!returnExpressionGraphView || !returnExpressionFlowDocument) {
      return [];
    }
    return (returnExpressionFlowDocument.inputSlots ?? []).filter(
      (slot) => slot.nodeId === returnExpressionGraphView.returnNodeId,
    );
  }, [returnExpressionFlowDocument, returnExpressionGraphView]);
  const returnExpressionGraphViewGraph = useMemo(() => {
    if (!returnExpressionGraphView) {
      return EMPTY_EXPRESSION_GRAPH;
    }
    return normalizeExpressionGraphOrEmpty(
      returnExpressionGraphView.draftGraph ??
        (returnExpressionGraphViewNode?.payload.expression_graph as
          | FlowExpressionGraph
          | undefined),
    );
  }, [returnExpressionGraphView, returnExpressionGraphViewNode?.payload.expression_graph]);
  const returnExpressionGraphViewExpression = useMemo(() => {
    if (!returnExpressionGraphView || !returnExpressionGraphViewNode) {
      return "";
    }
    if (returnExpressionGraphView.draftExpression !== undefined) {
      return returnExpressionGraphView.draftExpression;
    }
    const graphExpression = expressionFromFlowExpressionGraph(returnExpressionGraphViewGraph);
    if (!graphExpression.diagnostics.length && graphExpression.expression.trim()) {
      return graphExpression.expression;
    }
    return returnExpressionFromPayload(returnExpressionGraphViewNode.payload);
  }, [returnExpressionGraphView, returnExpressionGraphViewGraph, returnExpressionGraphViewNode]);

  const selectedGraphNode = effectiveGraph?.nodes.find((node) => node.id === activeNodeId);
  const selectedInspectableNode =
    selectedGraphNode && isInspectableGraphNodeKind(selectedGraphNode.kind)
      ? selectedGraphNode
      : undefined;
  const previewInspectorNode =
    inspectorPanelMode === "hidden" && selectedInspectableNode?.id !== dismissedPeekNodeId
      ? selectedInspectableNode
      : undefined;
  const activeGraphSymbolId =
    selectedGraphNode && isGraphSymbolNodeKind(selectedGraphNode.kind)
      ? selectedGraphNode.id
      : activeSymbolId;
  const selectedFilePath = useMemo(() => {
    if (selectedGraphNode) {
      return graphNodeRelativePath(selectedGraphNode.metadata, selectedGraphNode.subtitle);
    }
    return undefined;
  }, [selectedGraphNode]);
  const currentModuleBreadcrumb = useMemo(
    () =>
      [...(effectiveGraph?.breadcrumbs ?? [])]
        .reverse()
        .find((breadcrumb) => breadcrumb.level === "module"),
    [effectiveGraph?.breadcrumbs],
  );
  const currentModulePath = currentModuleBreadcrumb?.subtitle ?? undefined;
  const currentModuleNode = useMemo(() => {
    const moduleBreadcrumbId = currentModuleBreadcrumb?.nodeId;
    if (!moduleBreadcrumbId) {
      return undefined;
    }
    return effectiveGraph?.nodes.find(
      (node) => node.id === moduleBreadcrumbId && node.kind === "module",
    );
  }, [currentModuleBreadcrumb?.nodeId, effectiveGraph]);
  const narrowWorkspaceLayout = workspaceLayoutWidth <= 920;
  const clampedExplorerSidebarWidth = useMemo(
    () => clampExplorerSidebarWidth(explorerSidebarWidth, workspaceLayoutWidth),
    [explorerSidebarWidth, workspaceLayoutWidth],
  );
  const flowOwnerSymbolQuery = useQuery({
    queryKey: ["flow-owner-symbol", graphTargetId],
    queryFn: () => adapter.getSymbol(graphTargetId as string),
    enabled: Boolean(activeLevel === "flow" && graphTargetId?.startsWith("symbol:")),
  });

  useEffect(() => {
    if (narrowWorkspaceLayout || clampedExplorerSidebarWidth === explorerSidebarWidth) {
      return;
    }

    setExplorerSidebarWidth(clampedExplorerSidebarWidth);
  }, [clampedExplorerSidebarWidth, explorerSidebarWidth, narrowWorkspaceLayout]);

  useEffect(() => {
    if (!inspectorTargetId || !effectiveGraph) {
      return;
    }

    const matching = effectiveGraph.nodes.find((node) => node.id === inspectorTargetId);
    if (matching) {
      setInspectorSnapshot(matching);
    }
  }, [effectiveGraph, inspectorTargetId]);

  useEffect(() => {
    if (!dismissedPeekNodeId) {
      return;
    }

    if (!selectedGraphNode || selectedGraphNode.id !== dismissedPeekNodeId) {
      setDismissedPeekNodeId(undefined);
    }
  }, [dismissedPeekNodeId, selectedGraphNode]);

  useEffect(() => {
    setInspectorActionError(null);
  }, [activeLevel, graphTargetId, inspectorTargetId, selectedGraphNode?.id]);

  const inspectorNode = useMemo(() => {
    if (inspectorTargetId) {
      return (
        effectiveGraph?.nodes.find((node) => node.id === inspectorTargetId) ?? inspectorSnapshot
      );
    }
    if (inspectorPanelMode !== "hidden" && selectedGraphNode) {
      return selectedGraphNode;
    }
    return undefined;
  }, [effectiveGraph, inspectorPanelMode, inspectorSnapshot, inspectorTargetId, selectedGraphNode]);
  const inspectorSelectionNode = inspectorPanelMode !== "hidden" ? selectedGraphNode : undefined;
  const inspectorSourceTarget = useMemo(() => {
    const pinnedTarget = inspectorSourceTargetForId(inspectorTargetId, "pinned", inspectorNode);
    if (pinnedTarget) {
      return pinnedTarget;
    }

    if (activeLevel === "module" || activeLevel === "symbol") {
      const selectedTarget = inspectorSourceTargetForNode(selectedGraphNode, "selected");
      if (selectedTarget) {
        return selectedTarget;
      }
    }

    if (activeLevel === "flow") {
      const flowOwnerTarget = inspectorSourceTargetForId(
        graphTargetId,
        "flow-owner",
        inspectorNode?.id === graphTargetId ? inspectorNode : undefined,
      );
      if (flowOwnerTarget) {
        return flowOwnerTarget;
      }
    }

    if (activeLevel === "module") {
      const moduleContextTarget =
        inspectorSourceTargetForNode(currentModuleNode, "module-context") ??
        inspectorSourceTargetForId(graphTargetId, "module-context", currentModuleNode);
      if (moduleContextTarget) {
        return moduleContextTarget;
      }
    }

    return undefined;
  }, [
    activeLevel,
    currentModuleNode,
    graphTargetId,
    inspectorNode,
    inspectorTargetId,
    selectedGraphNode,
  ]);
  const inspectorSymbolTargetId =
    inspectorSourceTarget?.fetchMode === "editable" &&
    inspectorSourceTarget.targetId.startsWith("symbol:")
      ? inspectorSourceTarget.targetId
      : undefined;
  const symbolQuery = useQuery({
    queryKey: ["symbol", inspectorSymbolTargetId],
    queryFn: () => adapter.getSymbol(inspectorSymbolTargetId as string),
    enabled: Boolean(inspectorSymbolTargetId),
  });
  const shouldShowInspectorDrawer = Boolean(repoSession && (graphTargetId || effectiveGraph));
  const effectiveInspectorDrawerMode =
    inspectorPanelMode === "expanded"
      ? "expanded"
      : shouldShowInspectorDrawer
        ? "collapsed"
        : "hidden";
  const effectiveInspectorNode =
    inspectorPanelMode === "hidden" ? previewInspectorNode : inspectorNode;
  const inspectorHighlightRange = useMemo(
    () =>
      inspectorPanelMode !== "hidden" && activeLevel === "flow"
        ? graphNodeSourceRange(selectedGraphNode)
        : undefined,
    [activeLevel, inspectorPanelMode, selectedGraphNode],
  );

  const editableSourceQuery = useQuery({
    queryKey: [
      "editable-node-source",
      repoSession?.id,
      inspectorSourceTarget?.fetchMode,
      inspectorSourceTarget?.targetId,
    ],
    queryFn: async () => {
      if (!inspectorSourceTarget) {
        throw new Error("Inspector source target is not available.");
      }

      if (inspectorSourceTarget.fetchMode === "editable") {
        return adapter.getEditableNodeSource(inspectorSourceTarget.targetId);
      }

      const source = await adapter.revealSource(inspectorSourceTarget.targetId);
      return readonlyEditableSourceFromReveal(source, inspectorSourceTarget.nodeKind);
    },
    enabled: Boolean(inspectorPanelMode !== "hidden" && inspectorSourceTarget),
  });
  const effectiveEditableSource =
    inspectorEditableSourceOverride?.targetId === inspectorSourceTarget?.targetId
      ? inspectorEditableSourceOverride
      : editableSourceQuery.data;
  const inspectorSourcePath =
    effectiveEditableSource?.path ??
    graphNodeRelativePath(
      inspectorSourceTarget?.node?.metadata,
      inspectorSourceTarget?.node?.subtitle,
    );

  useEffect(() => {
    if (
      inspectorEditableSourceOverride &&
      inspectorEditableSourceOverride.targetId !== inspectorSourceTarget?.targetId
    ) {
      setInspectorEditableSourceOverride(undefined);
    }
  }, [inspectorEditableSourceOverride, inspectorSourceTarget?.targetId]);

  const effectiveBackendStatus = backendStatusQuery.data
    ? {
        ...(overviewQuery.data?.backend ?? {}),
        ...backendStatusQuery.data,
      }
    : overviewQuery.data?.backend;

  useEffect(() => {
    if (!inspectorDirty || !effectiveEditableSource?.targetId) {
      setInspectorDraftStale(false);
      return;
    }

    const currentDraft = inspectorDraftContentRef.current;
    if (
      effectiveEditableSource?.content !== undefined &&
      currentDraft !== undefined &&
      currentDraft === effectiveEditableSource.content
    ) {
      setInspectorDraftStale(false);
    }
  }, [effectiveEditableSource?.content, effectiveEditableSource?.targetId, inspectorDirty]);

  useEffect(
    () =>
      adapter.subscribeWorkspaceSync((event) => {
        if (!repoSession?.path || event.repoPath !== repoSession.path) {
          return;
        }

        const matchingSnapshot = event.snapshot;
        const liveNodeIds = new Set(matchingSnapshot?.nodeIds ?? []);
        const sameFileChanged = Boolean(
          inspectorDirty &&
          inspectorSourcePath &&
          event.changedRelativePaths.includes(inspectorSourcePath),
        );
        if (sameFileChanged) {
          setInspectorDraftStale(true);
        }
        const activeWorkspaceFileChanged = Boolean(
          activeWorkspaceFilePath && event.changedRelativePaths.includes(activeWorkspaceFilePath),
        );
        if (activeWorkspaceFileChanged && workspaceFileDirty) {
          setWorkspaceFileStale(true);
        }

        if (event.status === "synced" && matchingSnapshot) {
          if (activeNodeId && !liveNodeIds.has(activeNodeId)) {
            selectNode(undefined);
          }

          if (graphTargetId && !liveNodeIds.has(graphTargetId)) {
            const fallbackBreadcrumb = [...(effectiveGraph?.breadcrumbs ?? [])]
              .reverse()
              .find(
                (breadcrumb) =>
                  breadcrumb.nodeId !== graphTargetId && liveNodeIds.has(breadcrumb.nodeId),
              );
            if (fallbackBreadcrumb) {
              focusGraph(fallbackBreadcrumb.nodeId, fallbackBreadcrumb.level);
            } else if (liveNodeIds.has(matchingSnapshot.defaultFocusNodeId)) {
              focusGraph(matchingSnapshot.defaultFocusNodeId, matchingSnapshot.defaultLevel);
            } else {
              focusGraph(matchingSnapshot.repoId, "repo");
            }
          }

          if (inspectorTargetId && !liveNodeIds.has(inspectorTargetId) && !sameFileChanged) {
            setInspectorTargetId(undefined);
            setInspectorSnapshot(undefined);
            setInspectorEditableSourceOverride(undefined);
          }
        }

        const invalidations = [queryClient.invalidateQueries({ queryKey: ["backend-status"] })];
        const shouldRefreshWorkspaceData =
          event.status !== "syncing" || Boolean(event.snapshot) || event.needsManualResync;
        if (shouldRefreshWorkspaceData) {
          invalidations.push(
            queryClient.invalidateQueries({ queryKey: ["overview"] }),
            queryClient.invalidateQueries({ queryKey: ["workspace-files"] }),
            queryClient.invalidateQueries({ queryKey: ["workspace-file"] }),
            queryClient.invalidateQueries({ queryKey: ["graph-view"] }),
            queryClient.invalidateQueries({ queryKey: ["symbol"] }),
            queryClient.invalidateQueries({ queryKey: ["workspace-search"] }),
            queryClient.invalidateQueries({ queryKey: ["editable-node-source"] }),
          );
        }

        void Promise.all(invalidations);
      }),
    [
      activeNodeId,
      activeWorkspaceFilePath,
      adapter,
      focusGraph,
      effectiveGraph?.breadcrumbs,
      graphTargetId,
      inspectorDirty,
      inspectorSourcePath,
      inspectorTargetId,
      queryClient,
      repoSession?.path,
      selectNode,
      workspaceFileDirty,
    ],
  );

  const selectSidebarResult = (result: SearchResult) => {
    setActiveWorkspaceFilePath(undefined);
    selectSearchResult(result);
    setSidebarQuery("");
    if (result.level && result.nodeId) {
      focusGraph(result.nodeId, result.level);
    }
  };

  const selectOverviewModule = (module: OverviewModule) => {
    setActiveWorkspaceFilePath(undefined);
    focusGraph(module.moduleId, "module");
  };

  const selectOverviewSymbol = (nodeId: string) => {
    setActiveWorkspaceFilePath(undefined);
    focusGraph(nodeId, "symbol");
  };

  const selectWorkspaceFile = useCallback((relativePath: string) => {
    setActiveWorkspaceFilePath(relativePath);
    setWorkspaceFileDraft("");
    setWorkspaceFileStale(false);
    setWorkspaceFileSaveError(null);
    workspaceFileLoadedKeyRef.current = undefined;
  }, []);

  const createWorkspaceEntry = useCallback(
    async (request: WorkspaceFileMutationRequest) => {
      if (!repoSession) {
        throw new Error("Open a repository before creating files.");
      }

      const result = await adapter.createWorkspaceEntry(repoSession.path, request);
      surfaceRecoveryEvents(result.recoveryEvents);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["workspace-files"] }),
        queryClient.invalidateQueries({ queryKey: ["workspace-file"] }),
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
        queryClient.invalidateQueries({ queryKey: ["graph-view"] }),
        queryClient.invalidateQueries({ queryKey: ["workspace-search"] }),
      ]);

      if (result.kind === "file") {
        if (result.relativePath.endsWith(".py")) {
          focusGraph(moduleIdFromRelativePath(result.relativePath), "module");
          setActiveWorkspaceFilePath(undefined);
        } else {
          selectWorkspaceFile(result.relativePath);
        }
      }
    },
    [adapter, focusGraph, queryClient, repoSession, selectWorkspaceFile, surfaceRecoveryEvents],
  );

  const moveWorkspaceEntry = useCallback(
    async (request: WorkspaceFileMoveRequest) => {
      if (!repoSession) {
        throw new Error("Open a repository before moving files.");
      }

      const targetRelativePath = request.targetDirectoryRelativePath
        ? `${request.targetDirectoryRelativePath}/${request.sourceRelativePath.split("/").pop() ?? request.sourceRelativePath}`
        : (request.sourceRelativePath.split("/").pop() ?? request.sourceRelativePath);
      const movedActiveFilePath = movedWorkspaceRelativePath(
        activeWorkspaceFilePath,
        request.sourceRelativePath,
        targetRelativePath,
      );
      if (movedActiveFilePath && workspaceFileDirty) {
        throw new Error("Save or cancel the open file before moving it.");
      }

      const result = await adapter.moveWorkspaceEntry(repoSession.path, request);
      surfaceRecoveryEvents(result.recoveryEvents);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["workspace-files"] }),
        queryClient.invalidateQueries({ queryKey: ["workspace-file"] }),
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
        queryClient.invalidateQueries({ queryKey: ["graph-view"] }),
        queryClient.invalidateQueries({ queryKey: ["workspace-search"] }),
      ]);

      if (movedActiveFilePath) {
        if (movedActiveFilePath.endsWith(".py")) {
          setActiveWorkspaceFilePath(undefined);
          focusGraph(moduleIdFromRelativePath(movedActiveFilePath), "module");
        } else {
          selectWorkspaceFile(movedActiveFilePath);
        }
        return;
      }

      if (result.kind === "file" && result.relativePath.endsWith(".py")) {
        focusGraph(moduleIdFromRelativePath(result.relativePath), "module");
      }
    },
    [
      activeWorkspaceFilePath,
      adapter,
      focusGraph,
      queryClient,
      repoSession,
      selectWorkspaceFile,
      surfaceRecoveryEvents,
      workspaceFileDirty,
    ],
  );

  const deleteWorkspaceEntry = useCallback(
    async (request: WorkspaceFileDeleteRequest) => {
      if (!repoSession) {
        throw new Error("Open a repository before deleting files.");
      }

      const deletingOpenFile = isWorkspacePathAtOrBelow(
        activeWorkspaceFilePath,
        request.relativePath,
      );
      if (deletingOpenFile && workspaceFileDirty) {
        throw new Error("Save or cancel the open file before deleting it.");
      }

      const confirmed = await confirmFlowRemoval(
        `Delete ${request.relativePath}? This cannot be undone from H.E.L.M.`,
        {
          okLabel: "Delete",
          title: "Delete Workspace Entry",
        },
      );
      if (!confirmed) {
        return;
      }

      const deletingActiveGraphPath =
        isWorkspacePathAtOrBelow(selectedFilePath, request.relativePath) ||
        isWorkspacePathAtOrBelow(currentModulePath, request.relativePath) ||
        isWorkspacePathAtOrBelow(inspectorSourcePath, request.relativePath);

      const deletedOpenFilePath = deletingOpenFile ? activeWorkspaceFilePath : undefined;
      const result = await adapter.deleteWorkspaceEntry(repoSession.path, request);
      surfaceRecoveryEvents(result.recoveryEvents);
      if (deletingOpenFile) {
        setActiveWorkspaceFilePath(undefined);
        setWorkspaceFileDraft("");
        setWorkspaceFileStale(false);
        setWorkspaceFileSaveError(null);
        workspaceFileLoadedKeyRef.current = undefined;
        if (deletedOpenFilePath) {
          queryClient.removeQueries({
            queryKey: ["workspace-file", repoSession.id, deletedOpenFilePath],
            exact: true,
          });
        }
      }

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["workspace-files"] }),
        deletingOpenFile
          ? Promise.resolve()
          : queryClient.invalidateQueries({ queryKey: ["workspace-file"] }),
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
        queryClient.invalidateQueries({ queryKey: ["graph-view"] }),
        queryClient.invalidateQueries({ queryKey: ["workspace-search"] }),
      ]);

      if (
        deletingActiveGraphPath ||
        result.changedRelativePaths.some(
          (path) => path.endsWith(".py") && path === currentModulePath,
        )
      ) {
        focusGraph(repoSession.id, "repo");
      }
    },
    [
      activeWorkspaceFilePath,
      adapter,
      currentModulePath,
      focusGraph,
      inspectorSourcePath,
      queryClient,
      repoSession,
      selectedFilePath,
      surfaceRecoveryEvents,
      workspaceFileDirty,
    ],
  );

  const saveWorkspaceFile = useCallback(async () => {
    if (!repoSession || !activeWorkspaceFile) {
      return;
    }
    if (workspaceFileStale) {
      setWorkspaceFileSaveError("This file changed on disk. Reload it before saving again.");
      return;
    }

    setIsSavingWorkspaceFile(true);
    setWorkspaceFileSaveError(null);
    try {
      const result = await adapter.saveWorkspaceFile(
        repoSession.path,
        activeWorkspaceFile.relativePath,
        workspaceFileDraft,
        activeWorkspaceFile.version,
      );
      surfaceRecoveryEvents(result.recoveryEvents);
      if (result.file) {
        queryClient.setQueryData(
          ["workspace-file", repoSession.id, result.file.relativePath],
          result.file,
        );
        setWorkspaceFileDraft(result.file.content);
        workspaceFileLoadedKeyRef.current = `${result.file.relativePath}:${result.file.version}`;
      }
      setWorkspaceFileStale(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["workspace-files"] }),
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
        queryClient.invalidateQueries({ queryKey: ["graph-view"] }),
        queryClient.invalidateQueries({ queryKey: ["workspace-search"] }),
        queryClient.invalidateQueries({ queryKey: ["editable-node-source"] }),
      ]);
    } catch (reason) {
      setWorkspaceFileSaveError(
        reason instanceof Error ? reason.message : "Unable to save this file.",
      );
    } finally {
      setIsSavingWorkspaceFile(false);
    }
  }, [
    activeWorkspaceFile,
    adapter,
    queryClient,
    repoSession,
    surfaceRecoveryEvents,
    workspaceFileDraft,
    workspaceFileStale,
  ]);

  const openAndIndexRepo = async (path?: string) => {
    setRepoOpenError(null);

    try {
      const session = await adapter.openRepo(path);
      resetWorkspace();
      setSession(session);
      const { jobId } = await adapter.startIndex(session.path);
      navigate(`/indexing/${encodeURIComponent(jobId)}`);
    } catch (reason) {
      const message =
        reason instanceof Error ? reason.message : "Unable to switch repositories right now.";
      setRepoOpenError(message);
    }
  };

  const reindexCurrentRepo = async () => {
    if (!repoSession) {
      return;
    }
    resetWorkspace();
    const { jobId } = await adapter.startIndex(repoSession.path);
    navigate(`/indexing/${encodeURIComponent(jobId)}`);
  };

  const handleGraphSelectNode = (nodeId: string, kind: GraphNodeKind) => {
    selectNode(nodeId);
    if (dismissedPeekNodeId === nodeId) {
      setDismissedPeekNodeId(undefined);
    }

    if (
      inspectorPanelMode !== "hidden" &&
      activeLevel !== "flow" &&
      (isEnterableGraphNodeKind(kind) || isInspectableGraphNodeKind(kind))
    ) {
      const node = effectiveGraph?.nodes.find((candidate) => candidate.id === nodeId);
      if (node) {
        setInspectorTargetId(nodeId);
        setInspectorSnapshot(node);
      }
    }
  };

  const handleGraphActivateNode = useCallback(
    (nodeId: string, kind: GraphNodeKind) => {
      selectNode(nodeId);
      const node = effectiveGraph?.nodes.find((candidate) => candidate.id === nodeId);

      if (isEnterableGraphNodeKind(kind)) {
        setRevealedSource(undefined);
        if (kind === "repo") {
          focusGraph(nodeId, "repo");
          return;
        }
        if (kind === "module") {
          focusGraph(nodeId, "module");
          return;
        }
        focusGraph(nodeId, "symbol");
        return;
      }

      if (isInspectableGraphNodeKind(kind)) {
        if (node) {
          setInspectorSnapshot(node);
        }
        setDismissedPeekNodeId(undefined);
        setInspectorTargetId(nodeId);
        setInspectorPanelMode("expanded");
      }
    },
    [effectiveGraph, focusGraph, selectNode, setRevealedSource],
  );

  const handleGraphInspectNode = useCallback(
    (nodeId: string, kind: GraphNodeKind) => {
      if (!isInspectableGraphNodeKind(kind)) {
        return;
      }

      selectNode(nodeId);
      if (activeLevel === "flow" && inspectorPanelMode !== "hidden") {
        setDismissedPeekNodeId(undefined);
        setInspectorPanelMode("expanded");
        return;
      }

      const node = effectiveGraph?.nodes.find((candidate) => candidate.id === nodeId);
      if (node) {
        setInspectorSnapshot(node);
      }
      setDismissedPeekNodeId(undefined);
      setInspectorTargetId(nodeId);
      setInspectorPanelMode("expanded");
    },
    [activeLevel, effectiveGraph, inspectorPanelMode, selectNode],
  );

  const handleSelectBreadcrumb = (breadcrumb: GraphBreadcrumbDto) => {
    if (breadcrumb.level === "flow") {
      setReturnExpressionGraphView(undefined);
      if (activeGraphSymbolId) {
        focusGraph(activeGraphSymbolId, "flow");
      }
      return;
    }
    setReturnExpressionGraphView(undefined);
    focusGraph(breadcrumb.nodeId, breadcrumb.level);
  };

  const handleSelectLevel = (level: GraphAbstractionLevel) => {
    if (!effectiveGraph) {
      return;
    }

    setReturnExpressionGraphView(undefined);

    if (level === "repo" && repoSession) {
      focusGraph(repoSession.id, "repo");
      return;
    }

    if (level === "module") {
      const moduleBreadcrumb = [...effectiveGraph.breadcrumbs]
        .reverse()
        .find((breadcrumb) => breadcrumb.level === "module");
      focusGraph(moduleBreadcrumb?.nodeId ?? repoSession?.id ?? effectiveGraph.targetId, "module");
      return;
    }

    if (level === "symbol") {
      const symbolBreadcrumb = [...effectiveGraph.breadcrumbs]
        .reverse()
        .find((breadcrumb) => breadcrumb.level === "symbol");
      if (symbolBreadcrumb) {
        focusGraph(symbolBreadcrumb.nodeId, "symbol");
      }
      return;
    }

    if (level === "flow" && activeGraphSymbolId) {
      focusGraph(activeGraphSymbolId, "flow");
    }
  };

  const handleNavigateGraphOut = () => {
    if (!repoSession) {
      return;
    }

    if (returnExpressionGraphView) {
      setReturnExpressionGraphView(undefined);
      return;
    }

    if (activeLevel === "flow") {
      const symbolTarget = graphTargetId?.startsWith("symbol:")
        ? graphTargetId
        : activeGraphSymbolId;
      if (symbolTarget) {
        focusGraph(symbolTarget, "symbol");
      }
      return;
    }

    if (activeLevel === "symbol") {
      const symbolTarget = graphTargetId?.startsWith("symbol:")
        ? graphTargetId
        : activeGraphSymbolId;
      const moduleTarget =
        (symbolTarget ? moduleIdFromSymbolId(symbolTarget) : undefined) ??
        [...(effectiveGraph?.breadcrumbs ?? [])]
          .reverse()
          .find((breadcrumb) => breadcrumb.level === "module")?.nodeId;
      if (moduleTarget) {
        focusGraph(moduleTarget, "module");
        return;
      }
      focusGraph(repoSession.id, "repo");
      return;
    }

    if (activeLevel === "module") {
      focusGraph(repoSession.id, "repo");
    }
  };

  const handleRevealSource = async (nodeId: string) => {
    setInspectorActionError(null);
    const source = await adapter.revealSource(nodeId);
    setDismissedPeekNodeId(undefined);
    setInspectorPanelMode("expanded");
    setRevealedSource(source);
  };

  const handleApplyEdit = async (
    request: StructuralEditRequest,
    options?: { preserveView?: boolean },
  ) => {
    const result = await adapter.applyStructuralEdit(request);
    surfaceRecoveryEvents(result.recoveryEvents);
    const undoTransaction = result.undoTransaction;
    if (undoTransaction) {
      setBackendUndoStack((current) => [
        ...current,
        {
          transaction: undoTransaction,
          entry: {
            domain: "backend",
            summary: result.summary,
            createdAt: Date.now(),
          },
        },
      ]);
      setBackendRedoStack([]);
    }
    setInspectorPanelMode("expanded");
    setLastEdit(result);
    setRevealedSource(undefined);
    setInspectorDirty(false);
    setInspectorDraftStale(false);
    inspectorDraftContentRef.current = undefined;
    if (!options?.preserveView) {
      setInspectorEditableSourceOverride(undefined);
      setInspectorSourceVersion((current) => current + 1);
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["overview"] }),
      queryClient.invalidateQueries({ queryKey: ["workspace-files"] }),
      queryClient.invalidateQueries({ queryKey: ["workspace-file"] }),
      queryClient.invalidateQueries({ queryKey: ["graph-view"] }),
      queryClient.invalidateQueries({ queryKey: ["symbol"] }),
      queryClient.invalidateQueries({ queryKey: ["workspace-search"] }),
      queryClient.invalidateQueries({ queryKey: ["editable-node-source"] }),
    ]);

    if (options?.preserveView) {
      return result;
    }

    let nextFocusTarget:
      | { targetId: string; level: GraphAbstractionLevel; pinInspectorTarget?: boolean }
      | undefined;

    if (request.kind === "rename_symbol" && request.targetId && request.newName) {
      const moduleTarget = moduleIdFromSymbolId(request.targetId);
      const renamedSymbolTarget = moduleTarget
        ? symbolIdForModuleAndName(moduleTarget, request.newName)
        : undefined;
      if (renamedSymbolTarget) {
        nextFocusTarget = {
          targetId: renamedSymbolTarget,
          level: "symbol",
          pinInspectorTarget: true,
        };
      }
    } else if (request.kind === "delete_symbol" && request.targetId) {
      const moduleTarget = moduleIdFromSymbolId(request.targetId);
      if (moduleTarget) {
        nextFocusTarget = { targetId: moduleTarget, level: "module", pinInspectorTarget: true };
      }
    } else if (request.kind === "move_symbol" && request.destinationRelativePath) {
      nextFocusTarget = {
        targetId: moduleIdFromRelativePath(request.destinationRelativePath),
        level: "module",
        pinInspectorTarget: true,
      };
    } else if (
      (request.kind === "add_import" || request.kind === "remove_import") &&
      request.relativePath
    ) {
      nextFocusTarget = {
        targetId: moduleIdFromRelativePath(request.relativePath),
        level: "module",
        pinInspectorTarget: true,
      };
    }

    if (!nextFocusTarget) {
      const changedSymbolId = result.changedNodeIds.find((nodeId) => nodeId.startsWith("symbol:"));
      if (changedSymbolId) {
        nextFocusTarget = { targetId: changedSymbolId, level: "symbol", pinInspectorTarget: true };
      }
    }
    if (!nextFocusTarget) {
      const changedModuleId = result.changedNodeIds.find((nodeId) => nodeId.startsWith("module:"));
      if (changedModuleId) {
        nextFocusTarget = { targetId: changedModuleId, level: "module", pinInspectorTarget: true };
      }
    }

    if (nextFocusTarget) {
      setDismissedPeekNodeId(undefined);
      setInspectorSnapshot(undefined);
      setInspectorTargetId(
        nextFocusTarget.pinInspectorTarget ? nextFocusTarget.targetId : undefined,
      );
      focusGraph(nextFocusTarget.targetId, nextFocusTarget.level);
      return result;
    }
    if (graphTargetId) {
      focusGraph(graphTargetId, activeLevel);
    }
    return result;
  };

  const handleDeleteSymbolNode = useCallback(
    (nodeId: string) => {
      const node = effectiveGraph?.nodes.find((candidate) => candidate.id === nodeId);
      if (!node || !isGraphSymbolNodeKind(node.kind)) {
        return;
      }

      const deleteAction = node.availableActions.find(
        (action) => action.actionId === "delete_symbol",
      );
      if (!deleteAction?.enabled) {
        setInspectorTargetId(node.id);
        setInspectorSnapshot(node);
        setInspectorPanelMode("expanded");
        setInspectorActionError(
          deleteAction?.reason ?? "This symbol cannot be deleted from the graph.",
        );
        return;
      }

      if (isSavingSource || inspectorDraftStale || inspectorDirty) {
        setInspectorTargetId(node.id);
        setInspectorSnapshot(node);
        setInspectorPanelMode("expanded");
        setInspectorActionError("Save or cancel inline source edits before deleting a symbol.");
        return;
      }

      if (
        !window.confirm(
          `Delete ${node.label}? This removes the declaration from the current module.`,
        )
      ) {
        return;
      }

      setInspectorActionError(null);
      void handleApplyEdit({
        kind: "delete_symbol",
        targetId: node.id,
      }).catch((reason) => {
        setInspectorTargetId(node.id);
        setInspectorSnapshot(node);
        setInspectorPanelMode("expanded");
        setInspectorActionError(
          reason instanceof Error ? reason.message : "Unable to delete the selected symbol.",
        );
      });
    },
    [effectiveGraph, handleApplyEdit, inspectorDirty, inspectorDraftStale, isSavingSource],
  );

  const refreshWorkspaceData = useCallback(
    async (editableTargetId?: string) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
        queryClient.invalidateQueries({ queryKey: ["workspace-files"] }),
        queryClient.invalidateQueries({ queryKey: ["workspace-file"] }),
        queryClient.invalidateQueries({ queryKey: ["graph-view"] }),
        queryClient.invalidateQueries({ queryKey: ["symbol"] }),
        queryClient.invalidateQueries({ queryKey: ["workspace-search"] }),
        queryClient.invalidateQueries({ queryKey: ["editable-node-source"] }),
      ]);

      if (editableTargetId) {
        return queryClient.fetchQuery({
          queryKey: ["editable-node-source", repoSession?.id, "editable", editableTargetId],
          queryFn: () => adapter.getEditableNodeSource(editableTargetId),
        });
      }
      return undefined;
    },
    [adapter, queryClient, repoSession?.id],
  );

  const handleSaveNodeSource = async (targetId: string, content: string) => {
    if (inspectorDraftStale) {
      throw new Error(
        "This draft is stale because the file changed outside H.E.L.M. Reload from disk before saving again.",
      );
    }

    setIsSavingSource(true);
    try {
      const result = await adapter.saveNodeSource(targetId, content);
      surfaceRecoveryEvents(result.recoveryEvents);
      const undoTransaction = result.undoTransaction;
      if (undoTransaction) {
        setBackendUndoStack((current) => [
          ...current,
          {
            transaction: undoTransaction,
            entry: {
              domain: "backend",
              summary: result.summary,
              createdAt: Date.now(),
            },
          },
        ]);
        setBackendRedoStack([]);
      }
      setDismissedPeekNodeId(undefined);
      setInspectorPanelMode("expanded");
      setLastEdit(result);
      setRevealedSource(undefined);
      selectNode(targetId);
      setInspectorTargetId(targetId);
      setInspectorDirty(false);
      setInspectorDraftStale(false);
      inspectorDraftContentRef.current = content;
      const refreshedSource = await refreshWorkspaceData(targetId);
      setInspectorEditableSourceOverride(refreshedSource);
      setInspectorSourceVersion((current) => current + 1);
    } finally {
      setIsSavingSource(false);
    }
  };

  useEffect(
    () =>
      useUndoStore.getState().registerDomain("backend", {
        canUndo: () => backendUndoStack.length > 0,
        canRedo: () => backendRedoStack.length > 0,
        peekEntry: () => backendUndoStack[backendUndoStack.length - 1]?.entry,
        peekRedoEntry: () => backendRedoStack[backendRedoStack.length - 1]?.entry,
        undo: async () => {
          const undoEntry = backendUndoStack[backendUndoStack.length - 1];
          if (!undoEntry) {
            return {
              domain: "backend" as const,
              handled: false,
            };
          }

          try {
            const result = await adapter.applyBackendUndo(undoEntry.transaction);
            surfaceRecoveryEvents(result.recoveryEvents);
            setBackendUndoStack((current) => current.slice(0, -1));
            const redoTransaction = result.redoTransaction;
            if (redoTransaction) {
              setBackendRedoStack((current) => [
                ...current,
                {
                  transaction: redoTransaction,
                  entry: {
                    ...undoEntry.entry,
                    createdAt: Date.now(),
                  },
                },
              ]);
            }
            setDismissedPeekNodeId(undefined);
            setInspectorPanelMode("expanded");
            setLastEdit(undefined);
            setLastActivity({
              domain: "backend",
              kind: "undo",
              summary: result.summary,
              touchedRelativePaths: result.restoredRelativePaths,
              warnings: result.warnings,
            });
            setRevealedSource(undefined);
            setInspectorDirty(false);
            inspectorDraftContentRef.current = undefined;
            const refreshedSource = await refreshWorkspaceData(inspectorTargetId);
            setInspectorEditableSourceOverride(refreshedSource);
            setInspectorSourceVersion((current) => current + 1);

            if (result.focusTarget) {
              focusGraph(result.focusTarget.targetId, result.focusTarget.level);
            } else if (graphTargetId) {
              focusGraph(graphTargetId, activeLevel);
            }

            return {
              domain: "backend" as const,
              handled: true,
              summary: result.summary,
            };
          } catch (reason) {
            const summary =
              reason instanceof Error ? reason.message : "Unable to undo the last backend change.";
            setLastActivity({
              domain: "backend",
              kind: "error",
              summary,
            });
            return {
              domain: "backend" as const,
              handled: false,
              summary,
            };
          }
        },
        redo: async () => {
          const redoEntry = backendRedoStack[backendRedoStack.length - 1];
          if (!redoEntry) {
            return {
              domain: "backend" as const,
              handled: false,
            };
          }

          try {
            const result = await adapter.applyBackendUndo(redoEntry.transaction);
            surfaceRecoveryEvents(result.recoveryEvents);
            const summary = `Redid: ${redoEntry.entry.summary}`;
            setBackendRedoStack((current) => current.slice(0, -1));
            const undoTransaction = result.redoTransaction;
            if (undoTransaction) {
              setBackendUndoStack((current) => [
                ...current,
                {
                  transaction: undoTransaction,
                  entry: {
                    ...redoEntry.entry,
                    createdAt: Date.now(),
                  },
                },
              ]);
            }
            setDismissedPeekNodeId(undefined);
            setInspectorPanelMode("expanded");
            setLastEdit(undefined);
            setLastActivity({
              domain: "backend",
              kind: "redo",
              summary,
              touchedRelativePaths: result.restoredRelativePaths,
              warnings: result.warnings,
            });
            setRevealedSource(undefined);
            setInspectorDirty(false);
            inspectorDraftContentRef.current = undefined;
            const refreshedSource = await refreshWorkspaceData(inspectorTargetId);
            setInspectorEditableSourceOverride(refreshedSource);
            setInspectorSourceVersion((current) => current + 1);

            if (result.focusTarget) {
              focusGraph(result.focusTarget.targetId, result.focusTarget.level);
            } else if (graphTargetId) {
              focusGraph(graphTargetId, activeLevel);
            }

            return {
              domain: "backend" as const,
              handled: true,
              summary,
            };
          } catch (reason) {
            const summary =
              reason instanceof Error ? reason.message : "Unable to redo the last backend change.";
            setLastActivity({
              domain: "backend",
              kind: "error",
              summary,
            });
            return {
              domain: "backend" as const,
              handled: false,
              summary,
            };
          }
        },
      }),
    [
      activeLevel,
      adapter,
      backendRedoStack,
      backendUndoStack,
      focusGraph,
      graphTargetId,
      inspectorTargetId,
      refreshWorkspaceData,
      setLastActivity,
      setLastEdit,
      setRevealedSource,
      surfaceRecoveryEvents,
    ],
  );

  const handleInspectorEditorStateChange = useCallback((content?: string, dirty?: boolean) => {
    inspectorDraftContentRef.current = content;
    setInspectorDirty((current) => {
      const next = Boolean(dirty);
      return current === next ? current : next;
    });
  }, []);

  const handleSaveInspectorDraft = useCallback(async (targetId: string, draftContent: string) => {
    await saveInspectorDraftRef.current(targetId, draftContent);
  }, []);

  const handleOpenBlueprint = (symbolId: string) => {
    setInspectorActionError(null);
    setInspectorTargetId(symbolId);
    focusGraph(symbolId, "symbol");
  };

  const handleOpenInDefaultEditor = useCallback(
    async (targetId: string) => {
      setInspectorActionError(null);
      try {
        await adapter.openNodeInDefaultEditor(targetId);
      } catch (reason) {
        setInspectorActionError(
          reason instanceof Error
            ? reason.message
            : "Unable to open the file in the default editor.",
        );
      }
    },
    [adapter],
  );

  const handleOpenNodeInDefaultEditor = useCallback(
    (targetId: string) => adapter.openNodeInDefaultEditor(targetId),
    [adapter],
  );

  const handleRevealNodeInFileExplorer = useCallback(
    (targetId: string) => adapter.revealNodeInFileExplorer(targetId),
    [adapter],
  );

  const inspectorDraftTargetId = effectiveEditableSource?.editable
    ? effectiveEditableSource.targetId
    : undefined;

  const clearSelectionState = useCallback(() => {
    selectNode(undefined);
    setInspectorTargetId(undefined);
    setInspectorSnapshot(undefined);
    inspectorDraftContentRef.current = undefined;
    setInspectorDirty(false);
    setInspectorDraftStale(false);
    setInspectorEditableSourceOverride(undefined);
    setInspectorSourceVersion(0);
    setRevealedSource(undefined);
    setDismissedPeekNodeId(undefined);
  }, [selectNode, setRevealedSource]);

  const requestClearSelectionState = useCallback(async () => {
    const draftContent = inspectorDraftContentRef.current;
    if (inspectorDirty && inspectorDraftTargetId && draftContent !== undefined) {
      if (inspectorDraftStale) {
        const shouldDiscard = window.confirm(
          "This draft is stale because the file changed outside H.E.L.M. Click OK to discard it or Cancel to keep editing.",
        );
        if (!shouldDiscard) {
          return false;
        }
      } else {
        const shouldSave = window.confirm(
          "Save your changes before clearing the selection? Click OK to save or Cancel to discard.",
        );
        if (shouldSave) {
          try {
            await saveInspectorDraftRef.current(inspectorDraftTargetId, draftContent);
          } catch {
            return false;
          }
        }
      }
    }

    clearSelectionState();
    return true;
  }, [clearSelectionState, inspectorDraftTargetId, inspectorDirty, inspectorDraftStale]);

  const structuralDestinationModulePaths = useMemo(
    () => overviewQuery.data?.modules.map((module) => module.relativePath) ?? [],
    [overviewQuery.data?.modules],
  );
  const flowOwnerKind = flowOwnerSymbolQuery.data?.kind;
  const flowCreateEnabled =
    activeLevel === "flow" &&
    (flowOwnerKind === "function" ||
      flowOwnerKind === "async_function" ||
      flowOwnerKind === "method" ||
      flowOwnerKind === "async_method");
  const flowEditable =
    flowCreateEnabled &&
    (effectiveGraph?.flowState?.editable ?? activeFlowDraft?.document.editable ?? false);
  const flowDraftBackedCreateEnabled = flowEditable && Boolean(activeFlowDraft?.document);
  const createModeCanvasEnabled =
    activeLevel === "repo" ||
    ((activeLevel === "module" || activeLevel === "symbol") && Boolean(currentModulePath)) ||
    flowDraftBackedCreateEnabled;
  const createModeHint =
    createModeState === "inactive"
      ? undefined
      : activeLevel === "repo"
        ? "Click the graph to place a new Python module."
        : activeLevel === "module" || activeLevel === "symbol"
          ? currentModulePath
            ? `Click the graph to create a function or class in ${currentModulePath}.`
            : "Create mode needs a concrete module target in this view."
          : flowDraftBackedCreateEnabled
            ? "Click empty canvas to create a flow node in this draft."
            : "Create mode only writes inside function or method flows in v1.";
  const createModeContextKey = [
    activeLevel,
    graphTargetId ?? "",
    currentModulePath ?? "",
    flowOwnerKind ?? "",
  ].join("|");
  const createModeSupported =
    activeLevel === "repo" ||
    ((activeLevel === "module" || activeLevel === "symbol") && Boolean(currentModulePath)) ||
    flowDraftBackedCreateEnabled;

  const handleExitCreateMode = useCallback(() => {
    setCreateComposer(undefined);
    setCreateModeError(null);
    setReturnExpressionGraphView(undefined);
    setCreateModeState("inactive");
  }, []);

  const handleOpenCreateComposer = useCallback(
    (intent: GraphCreateIntent) => {
      setCreateModeError(null);
      setReturnExpressionGraphView(undefined);
      const composerAnchor = {
        x: intent.panelPosition.x,
        y: intent.panelPosition.y,
      };
      if (activeLevel === "repo") {
        setCreateComposer({
          id: `${Date.now()}:repo`,
          kind: "repo",
          anchor: composerAnchor,
          flowPosition: intent.flowPosition,
        });
        setCreateModeState("composing");
        return;
      }

      if ((activeLevel === "module" || activeLevel === "symbol") && currentModulePath) {
        setCreateComposer({
          id: `${Date.now()}:symbol`,
          kind: "symbol",
          anchor: composerAnchor,
          flowPosition: intent.flowPosition,
          targetModulePath: currentModulePath,
        });
        setCreateModeState("composing");
        return;
      }

      if (activeLevel === "flow" && flowDraftBackedCreateEnabled) {
        setCreateComposer({
          id: `${Date.now()}:flow`,
          kind: "flow",
          mode: "create",
          anchor: composerAnchor,
          flowPosition: intent.flowPosition,
          ownerLabel: flowOwnerSymbolQuery.data?.qualname ?? effectiveGraph?.focus?.label ?? "Flow",
          initialFlowNodeKind: "assign",
          initialPayload: { source: "" },
          seedFlowConnection: intent.seedFlowConnection,
        });
        setCreateModeState("composing");
      }
    },
    [
      activeLevel,
      currentModulePath,
      flowDraftBackedCreateEnabled,
      flowOwnerSymbolQuery.data?.qualname,
      effectiveGraph?.focus?.label,
    ],
  );

  const handleToggleCreateMode = useCallback(async () => {
    if (createModeState !== "inactive") {
      handleExitCreateMode();
      return;
    }

    if (!createModeSupported) {
      return;
    }

    const cleared = await requestClearSelectionState();
    if (!cleared) {
      return;
    }

    setCreateModeError(null);
    setCreateComposer(undefined);
    setReturnExpressionGraphView(undefined);
    setCreateModeState("active");
  }, [createModeState, createModeSupported, handleExitCreateMode, requestClearSelectionState]);

  const seedCreatedNodeLayout = useCallback(
    async (
      nodeId: string,
      nodeKind: GraphNodeKind | undefined,
      composerState: GraphCreateComposerState,
      override: { targetId: string; level: GraphAbstractionLevel } | undefined = undefined,
    ) => {
      if (!repoSession?.path) {
        return;
      }

      const targetId = override?.targetId ?? graphTargetId;
      const level = override?.level ?? activeLevel;
      if (!targetId) {
        return;
      }

      const viewKey = level === "repo" ? "repo|repo-root" : `${level}|${targetId}`;
      const nextLayout =
        peekStoredGraphLayout(repoSession.path, viewKey) ??
        (await readStoredGraphLayout(repoSession.path, viewKey));
      nextLayout.nodes[graphLayoutNodeKey(nodeId, nodeKind)] = {
        x: composerState.flowPosition.x,
        y: composerState.flowPosition.y,
      };
      void writeStoredGraphLayout(repoSession.path, viewKey, nextLayout);
    },
    [activeLevel, graphTargetId, repoSession?.path],
  );

  const syncFlowDraftLayout = useCallback(
    async (
      currentDocument: FlowGraphDocument,
      nextDocument: FlowGraphDocument,
      seededNodes: Array<{
        nodeId: string;
        kind: GraphNodeKind;
        position: { x: number; y: number };
      }> = [],
    ) => {
      if (!repoSession?.path || !graphTargetId?.startsWith("symbol:")) {
        return;
      }

      const viewKey = flowLayoutViewKey(graphTargetId);
      const layout =
        peekStoredGraphLayout(repoSession.path, viewKey) ??
        (await readStoredGraphLayout(repoSession.path, viewKey)) ??
        emptyStoredGraphLayout();
      const nextLayout = synchronizeFlowLayoutWithDocumentMutation({
        currentDocument,
        nextDocument,
        layout,
        seededNodes,
      });
      await writeStoredGraphLayout(repoSession.path, viewKey, nextLayout);
    },
    [graphTargetId, repoSession?.path],
  );

  const applyFlowDraftMutation = useCallback(
    async ({
      transform,
      seededNodes,
      selectedNodeId,
    }: {
      transform: (document: FlowGraphDocument) => FlowGraphDocument;
      seededNodes?: Array<{
        nodeId: string;
        kind: GraphNodeKind;
        position: { x: number; y: number };
      }>;
      selectedNodeId?: string;
    }) => {
      if (!graphTargetId?.startsWith("symbol:") || activeFlowDraft?.symbolId !== graphTargetId) {
        throw new Error("Editable flow draft state is no longer available for this symbol.");
      }

      const flowTargetId = graphTargetId;
      const currentDocument = activeFlowDraft.document;
      const nextDocument = transform(currentDocument);
      if (flowDocumentsEqual(currentDocument, nextDocument)) {
        return {
          document: currentDocument,
          result: undefined,
        };
      }
      const optimisticDocument: FlowGraphDocument = {
        ...nextDocument,
        syncState: currentDocument.syncState,
        diagnostics: [...currentDocument.diagnostics],
        sourceHash: nextDocument.sourceHash ?? currentDocument.sourceHash ?? null,
        editable: currentDocument.editable,
      };

      await syncFlowDraftLayout(currentDocument, optimisticDocument, seededNodes);
      setFlowDraftState({
        symbolId: flowTargetId,
        baseDocument: activeFlowDraft.baseDocument,
        document: optimisticDocument,
        status: "saving",
        error: null,
      });
      if (selectedNodeId) {
        selectNode(selectedNodeId);
      }

      try {
        const result = await handleApplyEdit(
          {
            kind: "replace_flow_graph",
            targetId: flowTargetId,
            flowGraph: optimisticDocument,
          },
          { preserveView: true },
        );

        if (
          result.flowSyncState === "clean" &&
          inspectorSourceTarget?.fetchMode === "editable" &&
          inspectorSourceTarget.targetId === flowTargetId
        ) {
          try {
            const refreshedSource = await queryClient.fetchQuery({
              queryKey: ["editable-node-source", repoSession?.id, "editable", flowTargetId],
              queryFn: () => adapter.getEditableNodeSource(flowTargetId),
            });
            setInspectorEditableSourceOverride(refreshedSource);
            setInspectorSourceVersion((current) => current + 1);
            setInspectorActionError(null);
          } catch (reason) {
            setInspectorActionError(
              reason instanceof Error
                ? `Graph updated, but source refresh failed: ${reason.message}`
                : "Graph updated, but source refresh failed.",
            );
          }
        }

        setFlowDraftState((current) => {
          if (!current || current.symbolId !== flowTargetId) {
            return current;
          }

          return {
            symbolId: current.symbolId,
            baseDocument: current.baseDocument,
            document: {
              ...optimisticDocument,
              syncState: result.flowSyncState ?? optimisticDocument.syncState,
              diagnostics: [...result.diagnostics],
            },
            status: "reconcile-pending",
            error: null,
            reconcileAfterUpdatedAt: graphQuery.dataUpdatedAt,
          };
        });

        return {
          document: optimisticDocument,
          result,
        };
      } catch (reason) {
        const message =
          reason instanceof Error ? reason.message : "Unable to update the current visual flow.";
        setFlowDraftState((current) => {
          if (!current || current.symbolId !== flowTargetId) {
            return current;
          }

          return {
            ...current,
            document: optimisticDocument,
            status: "dirty",
            error: message,
          };
        });
        throw reason;
      }
    },
    [
      activeFlowDraft,
      adapter,
      graphQuery.dataUpdatedAt,
      graphTargetId,
      handleApplyEdit,
      inspectorSourceTarget?.fetchMode,
      inspectorSourceTarget?.targetId,
      queryClient,
      repoSession?.id,
      selectNode,
      syncFlowDraftLayout,
    ],
  );

  const selectedFlowEntryNodeId = activeFlowDraft?.document.nodes.find(
    (node) => node.kind === "entry",
  )?.id;

  const handleAddFlowFunctionInput = useCallback(
    (draft: { name?: string; defaultExpression?: string | null }) => {
      void applyFlowDraftMutation({
        transform: (document) => addFlowFunctionInput(document, draft),
        selectedNodeId: selectedFlowEntryNodeId,
      }).catch((reason) => {
        const message = reason instanceof Error ? reason.message : "Unable to add the flow input.";
        setCreateModeError(message);
      });
    },
    [applyFlowDraftMutation, selectedFlowEntryNodeId],
  );

  const handleUpdateFlowFunctionInput = useCallback(
    (
      inputId: string,
      patch: {
        name?: string;
        defaultExpression?: string | null;
      },
    ) => {
      void applyFlowDraftMutation({
        transform: (document) => updateFlowFunctionInput(document, inputId, patch),
        selectedNodeId: selectedFlowEntryNodeId,
      }).catch((reason) => {
        const message =
          reason instanceof Error ? reason.message : "Unable to update the flow input.";
        setCreateModeError(message);
      });
    },
    [applyFlowDraftMutation, selectedFlowEntryNodeId],
  );

  const handleMoveFlowFunctionInput = useCallback(
    (inputId: string, direction: -1 | 1) => {
      void applyFlowDraftMutation({
        transform: (document) => moveFlowFunctionInput(document, inputId, direction),
        selectedNodeId: selectedFlowEntryNodeId,
      }).catch((reason) => {
        const message =
          reason instanceof Error ? reason.message : "Unable to reorder the flow input.";
        setCreateModeError(message);
      });
    },
    [applyFlowDraftMutation, selectedFlowEntryNodeId],
  );

  const confirmFlowFunctionInputRemoval = useCallback(
    (
      inputIds: string[],
      subjectLabel: "input" | "param node" = "input",
    ): Promise<string[] | undefined> => {
      if (!activeFlowDraft) {
        return Promise.resolve(undefined);
      }
      return (async () => {
        const uniqueInputIds = [...new Set(inputIds)];
        for (const inputId of uniqueInputIds) {
          const summary = flowFunctionInputRemovalSummary(activeFlowDraft.document, inputId);
          if (!summary.input) {
            continue;
          }
          const downstreamUseCount = summary.downstreamUseCount;
          const connectionCount = summary.connectionCount;
          const shouldDelete = await confirmFlowRemoval(
            `Are you sure you would like to delete ${subjectLabel} "${summary.input.name}"? It has ${downstreamUseCount} downstream use${downstreamUseCount === 1 ? "" : "s"} and ${connectionCount} connection${connectionCount === 1 ? "" : "s"}.`,
            {
              okLabel: subjectLabel === "param node" ? "Delete param" : "Delete input",
              title: subjectLabel === "param node" ? "Delete param node" : "Delete input",
            },
          );
          if (!shouldDelete) {
            return undefined;
          }
          if (!downstreamUseCount && !connectionCount) {
            continue;
          }
          const shouldRemoveDownstream = await confirmFlowRemoval(
            `Would you like to remove downstream uses and connections for "${summary.input.name}"?`,
            {
              okLabel: "Remove downstream",
              title: "Remove downstream uses",
            },
          );
          if (!shouldRemoveDownstream) {
            return undefined;
          }
        }
        return uniqueInputIds.filter((inputId) =>
          Boolean(flowFunctionInputRemovalSummary(activeFlowDraft.document, inputId).input),
        );
      })();
    },
    [activeFlowDraft],
  );

  const removeFlowFunctionInputWithConfirmation = useCallback(
    async (inputId: string) => {
      if (!activeFlowDraft) {
        return;
      }
      const inputIdsToRemove = await confirmFlowFunctionInputRemoval([inputId], "input");
      if (!inputIdsToRemove?.length) {
        return;
      }
      await applyFlowDraftMutation({
        transform: (document) =>
          inputIdsToRemove.reduce(
            (nextDocument, nextInputId) =>
              removeFlowFunctionInputAndDownstreamUses(nextDocument, nextInputId),
            document,
          ),
        selectedNodeId: selectedFlowEntryNodeId,
      }).catch((reason) => {
        const message =
          reason instanceof Error ? reason.message : "Unable to remove the flow input.";
        setCreateModeError(message);
      });
    },
    [
      activeFlowDraft,
      applyFlowDraftMutation,
      confirmFlowFunctionInputRemoval,
      selectedFlowEntryNodeId,
    ],
  );

  saveInspectorDraftRef.current = async (targetId: string, draftContent: string) => {
    await handleSaveNodeSource(targetId, draftContent);
  };

  const handleCreateSubmit = useCallback(
    async (payload: GraphCreateComposerSubmit) => {
      if (!createComposer) {
        return;
      }

      const resumeCreateMode = createModeState === "composing";
      setCreateModeError(null);
      setIsSubmittingCreate(true);
      try {
        let request: StructuralEditRequest;
        let createdNodeKind: GraphNodeKind | undefined;
        let nextFocus: { targetId: string; level: GraphAbstractionLevel } | undefined;

        if (payload.kind === "repo") {
          request = {
            kind: "create_module",
            relativePath: payload.relativePath,
            content: payload.content,
          };
          createdNodeKind = "module";
        } else if (payload.kind === "symbol" && createComposer.kind === "symbol") {
          request = {
            kind: "create_symbol",
            relativePath: createComposer.targetModulePath,
            newName: payload.newName,
            symbolKind: payload.symbolKind,
            body: payload.body,
          };
          createdNodeKind = payload.symbolKind;
          if (activeLevel === "symbol" && graphTargetId?.startsWith("symbol:")) {
            const moduleTarget = moduleIdFromSymbolId(graphTargetId);
            if (moduleTarget) {
              nextFocus = { targetId: moduleTarget, level: "module" };
            }
          }
        } else if (
          (payload.kind === "flow" || payload.kind === "flow_param") &&
          createComposer.kind === "flow" &&
          graphTargetId?.startsWith("symbol:")
        ) {
          if (activeFlowDraft?.symbolId !== graphTargetId) {
            throw new Error("Editable flow draft state is no longer available for this symbol.");
          }

          if (payload.kind === "flow_param") {
            let createdParamNodeId: string | undefined;
            const seededNodes: Array<{
              nodeId: string;
              kind: GraphNodeKind;
              position: { x: number; y: number };
            }> = [];
            await applyFlowDraftMutation({
              transform: (document) => {
                const previousInputIds = new Set(
                  (document.functionInputs ?? []).map((input) => input.id),
                );
                const nextDocument = addFlowFunctionInput(document, {
                  name: payload.name,
                  defaultExpression: payload.defaultExpression,
                });
                const createdInput = (nextDocument.functionInputs ?? []).find(
                  (input) => !previousInputIds.has(input.id),
                );
                if (createdInput) {
                  createdParamNodeId = functionInputParamNodeId(
                    nextDocument.symbolId,
                    createdInput,
                  );
                  seededNodes.push({
                    nodeId: createdParamNodeId,
                    kind: "param",
                    position: createComposer.flowPosition,
                  });
                }
                return nextDocument;
              },
              seededNodes,
            });

            if (createdParamNodeId) {
              setFlowInputDisplayMode("param_nodes");
              selectNode(createdParamNodeId);
              setPendingCreatedNodeId(createdParamNodeId);
            }
            setCreateComposer(undefined);
            setCreateModeState("active");
            return;
          }

          if (createComposer.mode === "edit" && createComposer.editingNodeId) {
            const nextPayload =
              payload.payload ?? flowNodePayloadFromContent(payload.flowNodeKind, payload.content);
            await applyFlowDraftMutation({
              transform: (document) =>
                updateFlowNodePayload(
                  document,
                  createComposer.editingNodeId as string,
                  nextPayload,
                ),
              selectedNodeId: createComposer.editingNodeId,
            });
            setCreateComposer(undefined);
            setCreateModeState(resumeCreateMode ? "active" : "inactive");
            return;
          }

          createdNodeKind = payload.flowNodeKind;
          const nextNode = {
            ...createFlowNode(graphTargetId, payload.flowNodeKind),
            payload:
              payload.payload ?? flowNodePayloadFromContent(payload.flowNodeKind, payload.content),
          };
          const seededNodes: Array<{
            nodeId: string;
            kind: GraphNodeKind;
            position: { x: number; y: number };
          }> = [
            {
              nodeId: nextNode.id,
              kind: nextNode.kind,
              position: createComposer.flowPosition,
            },
          ];
          await applyFlowDraftMutation({
            transform: (document) => {
              let nextDocument = addDisconnectedFlowNode(document, nextNode);
              if (createComposer.seedFlowConnection) {
                const existingEdge = document.edges.find(
                  (edge) =>
                    edge.sourceId === createComposer.seedFlowConnection?.sourceNodeId &&
                    edge.sourceHandle === createComposer.seedFlowConnection?.sourceHandle,
                );
                nextDocument = existingEdge
                  ? insertFlowNodeOnEdge(document, nextNode, existingEdge.id)
                  : upsertFlowConnection(nextDocument, {
                      sourceId: createComposer.seedFlowConnection.sourceNodeId,
                      sourceHandle: createComposer.seedFlowConnection.sourceHandle,
                      targetId: nextNode.id,
                      targetHandle: "in",
                    });
              }

              (payload.starterSteps ?? []).forEach((starterStep, index) => {
                const starterNode = {
                  ...createFlowNode(graphTargetId, starterStep.flowNodeKind),
                  payload: starterStep.payload,
                };
                const starterPosition = {
                  x: createComposer.flowPosition.x + 280,
                  y:
                    createComposer.flowPosition.y +
                    (starterStep.sourceHandle === "body" ? -150 : 150) +
                    index * 32,
                };
                seededNodes.push({
                  nodeId: starterNode.id,
                  kind: starterNode.kind,
                  position: starterPosition,
                });
                nextDocument = upsertFlowConnection(
                  addDisconnectedFlowNode(nextDocument, starterNode),
                  {
                    sourceId: nextNode.id,
                    sourceHandle: starterStep.sourceHandle,
                    targetId: starterNode.id,
                    targetHandle: "in",
                  },
                );
              });
              return nextDocument;
            },
            seededNodes,
            selectedNodeId: nextNode.id,
          });
          setPendingCreatedNodeId(undefined);
          setCreateComposer(undefined);
          setCreateModeState("active");
          return;
        } else {
          throw new Error("Create-mode context no longer matches the requested action.");
        }

        const result = await handleApplyEdit(request, { preserveView: true });
        const changedNodeId = result.changedNodeIds[0];
        if (changedNodeId) {
          await seedCreatedNodeLayout(changedNodeId, createdNodeKind, createComposer, nextFocus);
          selectNode(changedNodeId);
          setPendingCreatedNodeId(changedNodeId);
        }

        if (nextFocus) {
          focusGraph(nextFocus.targetId, nextFocus.level);
        }
        setCreateComposer(undefined);
        setCreateModeState(resumeCreateMode ? "active" : "inactive");
      } catch (reason) {
        const message =
          reason instanceof Error
            ? reason.message
            : "Unable to create from the current graph context.";
        setCreateModeError(message);
        if (
          (payload.kind === "flow" || payload.kind === "flow_param") &&
          graphTargetId?.startsWith("symbol:")
        ) {
          setFlowDraftState((current) => {
            if (!current || current.symbolId !== graphTargetId) {
              return current;
            }

            return {
              ...current,
              status: "dirty",
              error: message,
            };
          });
        }
      } finally {
        setIsSubmittingCreate(false);
      }
    },
    [
      activeLevel,
      activeFlowDraft,
      applyFlowDraftMutation,
      createComposer,
      createModeState,
      focusGraph,
      graphTargetId,
      handleApplyEdit,
      seedCreatedNodeLayout,
      selectNode,
      setFlowInputDisplayMode,
    ],
  );

  const resolveFlowDocumentConnection = useCallback(
    (connection: GraphFlowConnectionIntent) => {
      if (!activeFlowDraft) {
        return undefined;
      }

      const sourceHandle = flowDocumentHandleFromBlueprintHandle(connection.sourceHandle, "source");
      const targetHandle = flowDocumentHandleFromBlueprintHandle(connection.targetHandle, "target");
      if (!sourceHandle || !targetHandle) {
        return undefined;
      }

      const liveNodeIds = new Set(activeFlowDraft.document.nodes.map((node) => node.id));
      if (!liveNodeIds.has(connection.sourceId) || !liveNodeIds.has(connection.targetId)) {
        return undefined;
      }

      return {
        sourceId: connection.sourceId,
        sourceHandle,
        targetId: connection.targetId,
        targetHandle,
      };
    },
    [activeFlowDraft],
  );

  const resolveFlowInputBindingConnection = useCallback(
    (connection: GraphFlowConnectionIntent): ResolvedFlowInputBindingConnection | undefined => {
      if (!activeFlowDraft) {
        return undefined;
      }

      const sourceId =
        parseFunctionInputSourceHandle(connection.sourceHandle) ??
        parseValueSourceHandle(connection.sourceHandle) ??
        (() => {
          const sourceNode = effectiveGraph?.nodes.find((node) => node.id === connection.sourceId);
          const value =
            sourceNode?.metadata.source_id ??
            sourceNode?.metadata.sourceId ??
            sourceNode?.metadata.value_source_id ??
            sourceNode?.metadata.valueSourceId ??
            sourceNode?.metadata.function_input_id ??
            sourceNode?.metadata.functionInputId;
          return typeof value === "string" ? value : undefined;
        })();
      const slotId = parseInputSlotTargetHandle(connection.targetHandle);
      if (!sourceId) {
        return undefined;
      }
      if (slotId) {
        return {
          kind: "slot",
          sourceId,
          slotId,
        };
      }
      const targetNodeId = parseReturnInputTargetHandle(connection.targetHandle);
      if (
        targetNodeId &&
        activeFlowDraft.document.nodes.some(
          (node) => node.id === targetNodeId && node.kind === "return",
        )
      ) {
        return {
          kind: "return-input",
          sourceId,
          targetNodeId,
        };
      }
      return undefined;
    },
    [activeFlowDraft, effectiveGraph?.nodes],
  );

  const handleOpenFlowEditComposer = useCallback(
    (intent: GraphFlowEditIntent) => {
      if (
        activeLevel !== "flow" ||
        !graphTargetId?.startsWith("symbol:") ||
        activeFlowDraft?.symbolId !== graphTargetId ||
        !activeFlowDraft.document.editable
      ) {
        return;
      }

      const targetNode = activeFlowDraft.document.nodes.find((node) => node.id === intent.nodeId);
      if (!targetNode || !isFlowNodeAuthorableKind(targetNode.kind)) {
        return;
      }

      setCreateModeError(null);
      setReturnExpressionGraphView(undefined);
      setCreateComposer({
        id: `${Date.now()}:flow:edit:${targetNode.id}`,
        kind: "flow",
        mode: "edit",
        anchor: {
          x: intent.panelPosition.x,
          y: intent.panelPosition.y,
        },
        flowPosition: intent.flowPosition,
        ownerLabel: flowOwnerSymbolQuery.data?.qualname ?? effectiveGraph?.focus?.label ?? "Flow",
        editingNodeId: targetNode.id,
        initialFlowNodeKind: targetNode.kind,
        initialPayload: targetNode.payload,
        initialLoopType: intent.initialLoopType,
      });
      if (createModeState === "active") {
        setCreateModeState("composing");
      }
    },
    [
      activeFlowDraft,
      activeLevel,
      createModeState,
      effectiveGraph?.focus?.label,
      flowDraftBackedCreateEnabled,
      flowOwnerSymbolQuery.data?.qualname,
      graphTargetId,
    ],
  );

  const handleOpenExpressionGraphEditor = useCallback(
    (intent: GraphExpressionGraphIntent) => {
      const draftDocument =
        activeFlowDraft && activeFlowDraft.symbolId === graphTargetId
          ? activeFlowDraft.document
          : flowDraftSeedDocument?.symbolId === graphTargetId
            ? flowDraftSeedDocument
            : undefined;

      if (
        activeLevel !== "flow" ||
        !graphTargetId?.startsWith("symbol:") ||
        !draftDocument?.editable
      ) {
        return;
      }

      const targetNode = draftDocument.nodes.find(
        (node) => node.id === intent.nodeId && node.kind === "return",
      );
      if (!targetNode) {
        return;
      }

      if (activeFlowDraft?.symbolId !== graphTargetId) {
        setFlowDraftState({
          symbolId: graphTargetId,
          baseDocument: draftDocument,
          document: draftDocument,
          status: "idle",
          error: null,
        });
      }
      setCreateComposer(undefined);
      setCreateModeError(null);
      selectNode(targetNode.id);
      const expressionGraph = normalizeExpressionGraphOrEmpty(
        targetNode.payload.expression_graph as FlowExpressionGraph | undefined,
      );
      setReturnExpressionGraphView({
        symbolId: graphTargetId,
        returnNodeId: targetNode.id,
        selectedExpressionNodeId:
          intent.expressionNodeId ?? expressionGraph.rootId ?? expressionGraph.nodes[0]?.id,
        diagnostics: [],
        isDraftOnly: false,
        error: null,
      });
      if (createModeState !== "inactive") {
        setCreateModeState("inactive");
      }
    },
    [
      activeFlowDraft,
      activeLevel,
      createModeState,
      flowDraftSeedDocument,
      graphTargetId,
      selectNode,
    ],
  );

  const handleExitReturnExpressionGraph = useCallback(() => {
    setReturnExpressionGraphView(undefined);
  }, []);

  const handleSelectReturnExpressionNode = useCallback((nodeId?: string) => {
    setReturnExpressionGraphView((current) =>
      current ? { ...current, selectedExpressionNodeId: nodeId } : current,
    );
  }, []);

  const handleReturnExpressionGraphChange = useCallback(
    (nextGraph: FlowExpressionGraph, options?: { selectedExpressionNodeId?: string }) => {
      const view = returnExpressionGraphView;
      if (!view) {
        return;
      }

      const normalizedGraph = normalizeFlowExpressionGraph(nextGraph) ?? EMPTY_EXPRESSION_GRAPH;
      const sourceResult = expressionFromFlowExpressionGraph(normalizedGraph);
      const selectedExpressionNodeId = options?.selectedExpressionNodeId;

      if (sourceResult.diagnostics.length || !sourceResult.expression.trim()) {
        setReturnExpressionGraphView({
          ...view,
          selectedExpressionNodeId,
          draftGraph: normalizedGraph,
          draftExpression: sourceResult.expression,
          diagnostics: sourceResult.diagnostics,
          isDraftOnly: true,
          error: null,
        });
        return;
      }

      setReturnExpressionGraphView({
        ...view,
        selectedExpressionNodeId,
        draftGraph: normalizedGraph,
        draftExpression: sourceResult.expression,
        diagnostics: [],
        isDraftOnly: false,
        error: null,
      });
      setIsSubmittingExpressionGraph(true);
      void (async () => {
        try {
          await applyFlowDraftMutation({
            transform: (document) => {
              const targetNode = document.nodes.find(
                (node) => node.id === view.returnNodeId && node.kind === "return",
              );
              if (!targetNode) {
                throw new Error("Return node is no longer available in this flow draft.");
              }
              return updateFlowNodePayload(document, view.returnNodeId, {
                ...targetNode.payload,
                expression: sourceResult.expression,
                expression_graph: normalizedGraph,
              });
            },
            selectedNodeId: view.returnNodeId,
          });
          setReturnExpressionGraphView((current) =>
            current && current.returnNodeId === view.returnNodeId
              ? {
                  ...current,
                  diagnostics: [],
                  isDraftOnly: false,
                  error: null,
                }
              : current,
          );
        } catch (reason) {
          const message =
            reason instanceof Error
              ? reason.message
              : "Unable to save the return expression graph.";
          setReturnExpressionGraphView((current) =>
            current && current.returnNodeId === view.returnNodeId
              ? {
                  ...current,
                  draftGraph: normalizedGraph,
                  draftExpression: sourceResult.expression,
                  diagnostics: [],
                  isDraftOnly: true,
                  error: message,
                }
              : current,
          );
        } finally {
          setIsSubmittingExpressionGraph(false);
        }
      })();
    },
    [applyFlowDraftMutation, returnExpressionGraphView],
  );

  const handleConnectFlowEdge = useCallback(
    (connectionIntent: GraphFlowConnectionIntent) => {
      if (!activeFlowDraft) {
        return;
      }
      const inputBindingConnection = resolveFlowInputBindingConnection(connectionIntent);
      if (inputBindingConnection) {
        const validation =
          inputBindingConnection.kind === "return-input"
            ? validateFlowReturnInputBindingConnection(
                activeFlowDraft.document,
                inputBindingConnection,
              )
            : validateFlowInputBindingConnection(activeFlowDraft.document, inputBindingConnection);
        if (!validation.ok) {
          setCreateModeError(validation.message);
          return;
        }
        void applyFlowDraftMutation({
          transform: (document) =>
            inputBindingConnection.kind === "return-input"
              ? upsertFlowReturnInputBinding(document, inputBindingConnection)
              : upsertFlowInputBinding(document, inputBindingConnection),
        }).catch((reason) => {
          const message =
            reason instanceof Error ? reason.message : "Unable to bind the selected value source.";
          setCreateModeError(message);
        });
        return;
      }
      const connection = resolveFlowDocumentConnection(connectionIntent);
      if (!connection) {
        return;
      }

      const validation = validateFlowConnection(activeFlowDraft.document, connection);
      if (!validation.ok) {
        setCreateModeError(validation.message);
        return;
      }

      void applyFlowDraftMutation({
        transform: (document) => upsertFlowConnection(document, connection),
      }).catch((reason) => {
        const message =
          reason instanceof Error ? reason.message : "Unable to connect the selected flow nodes.";
        setCreateModeError(message);
      });
    },
    [
      activeFlowDraft,
      applyFlowDraftMutation,
      resolveFlowDocumentConnection,
      resolveFlowInputBindingConnection,
    ],
  );

  const handleReconnectFlowEdge = useCallback(
    (edgeId: string, connectionIntent: GraphFlowConnectionIntent) => {
      if (!activeFlowDraft) {
        return;
      }
      const inputBindingConnection = resolveFlowInputBindingConnection(connectionIntent);
      if (inputBindingConnection) {
        const validation =
          inputBindingConnection.kind === "return-input"
            ? validateFlowReturnInputBindingConnection(
                activeFlowDraft.document,
                inputBindingConnection,
              )
            : validateFlowInputBindingConnection(activeFlowDraft.document, inputBindingConnection);
        if (!validation.ok) {
          setCreateModeError(validation.message);
          return;
        }
        const previousBindingId = edgeId.startsWith("data:")
          ? edgeId.slice("data:".length)
          : undefined;
        void applyFlowDraftMutation({
          transform: (document) =>
            inputBindingConnection.kind === "return-input"
              ? upsertFlowReturnInputBinding(document, inputBindingConnection, previousBindingId)
              : upsertFlowInputBinding(document, inputBindingConnection, previousBindingId),
        }).catch((reason) => {
          const message =
            reason instanceof Error
              ? reason.message
              : "Unable to reconnect the selected value source.";
          setCreateModeError(message);
        });
        return;
      }
      const connection = resolveFlowDocumentConnection(connectionIntent);
      if (!connection) {
        return;
      }

      const validation = validateFlowConnection(activeFlowDraft.document, connection, edgeId);
      if (!validation.ok) {
        setCreateModeError(validation.message);
        return;
      }

      void applyFlowDraftMutation({
        transform: (document) => upsertFlowConnection(document, connection, edgeId),
      }).catch((reason) => {
        const message =
          reason instanceof Error ? reason.message : "Unable to reconnect the selected flow edge.";
        setCreateModeError(message);
      });
    },
    [
      activeFlowDraft,
      applyFlowDraftMutation,
      resolveFlowDocumentConnection,
      resolveFlowInputBindingConnection,
    ],
  );

  const handleDisconnectFlowEdge = useCallback(
    (edgeId: string) => {
      const functionInputId = parseParameterEntryEdgeInputId(edgeId);
      if (functionInputId) {
        void removeFlowFunctionInputWithConfirmation(functionInputId);
        return;
      }
      if (edgeId.startsWith("data:")) {
        const bindingId = edgeId.slice("data:".length);
        void applyFlowDraftMutation({
          transform: (document) => removeFlowInputBindings(document, [bindingId]),
        }).catch((reason) => {
          const message =
            reason instanceof Error
              ? reason.message
              : "Unable to disconnect the selected value binding.";
          setCreateModeError(message);
        });
        return;
      }
      void applyFlowDraftMutation({
        transform: (document) => removeFlowEdges(document, [edgeId]),
      }).catch((reason) => {
        const message =
          reason instanceof Error ? reason.message : "Unable to disconnect the selected flow edge.";
        setCreateModeError(message);
      });
    },
    [applyFlowDraftMutation, removeFlowFunctionInputWithConfirmation],
  );

  const handleDeleteFlowSelection = useCallback(
    (selection: GraphFlowDeleteIntent) => {
      if (!selection.nodeIds.length && !selection.edgeIds.length) {
        return;
      }

      void (async () => {
        const selectedNodeById = new Map(
          (effectiveGraph?.nodes ?? []).map((node) => [node.id, node] as const),
        );
        const functionInputIdsFromParamNodes = activeFlowDraft
          ? selection.nodeIds.flatMap((nodeId) => {
              const functionInputId = flowFunctionInputIdForParamNode(
                selectedNodeById.get(nodeId),
                activeFlowDraft.document,
              );
              return functionInputId ? [functionInputId] : [];
            })
          : [];
        const functionInputIdsFromEdges = selection.edgeIds.flatMap((edgeId) => {
          const functionInputId = parseParameterEntryEdgeInputId(edgeId);
          return functionInputId ? [functionInputId] : [];
        });
        const functionInputIdsToRemove = [
          ...new Set([...functionInputIdsFromParamNodes, ...functionInputIdsFromEdges]),
        ];
        let confirmedFunctionInputIdsToRemove = functionInputIdsToRemove;
        if (functionInputIdsToRemove.length) {
          const confirmedInputIds = await confirmFlowFunctionInputRemoval(
            functionInputIdsToRemove,
            functionInputIdsFromParamNodes.length ? "param node" : "input",
          );
          if (!confirmedInputIds?.length) {
            return;
          }
          confirmedFunctionInputIdsToRemove = confirmedInputIds;
        }

        const cleared = await requestClearSelectionState();
        if (!cleared) {
          return;
        }

        try {
          await applyFlowDraftMutation({
            transform: (document) => {
              let nextDocument = document;
              if (selection.nodeIds.length) {
                nextDocument = removeFlowNodes(nextDocument, selection.nodeIds);
              }
              if (selection.edgeIds.length) {
                const dataBindingIds = selection.edgeIds
                  .filter(
                    (edgeId) =>
                      edgeId.startsWith("data:") && !parseParameterEntryEdgeInputId(edgeId),
                  )
                  .map((edgeId) => edgeId.slice("data:".length));
                const controlEdgeIds = selection.edgeIds.filter(
                  (edgeId) => !edgeId.startsWith("data:"),
                );
                nextDocument = removeFlowInputBindings(nextDocument, dataBindingIds);
                nextDocument = removeFlowEdges(nextDocument, controlEdgeIds);
              }
              confirmedFunctionInputIdsToRemove.forEach((functionInputId) => {
                nextDocument = removeFlowFunctionInputAndDownstreamUses(
                  nextDocument,
                  functionInputId,
                );
              });
              return nextDocument;
            },
          });
        } catch (reason) {
          const message =
            reason instanceof Error ? reason.message : "Unable to delete the selected flow items.";
          setCreateModeError(message);
        }
      })();
    },
    [
      activeFlowDraft,
      applyFlowDraftMutation,
      confirmFlowFunctionInputRemoval,
      effectiveGraph,
      requestClearSelectionState,
    ],
  );

  const requestInspectorClose = useCallback(async () => {
    const draftContent = inspectorDraftContentRef.current;
    if (inspectorDirty && inspectorDraftTargetId && draftContent !== undefined) {
      if (inspectorDraftStale) {
        const shouldDiscard = window.confirm(
          "This draft is stale because the file changed outside H.E.L.M. Click OK to discard it or Cancel to keep editing.",
        );
        if (!shouldDiscard) {
          return false;
        }
      } else {
        const shouldSave = window.confirm(
          "Save your changes before closing the inspector? Click OK to save or Cancel to discard.",
        );
        if (shouldSave) {
          try {
            await handleSaveInspectorDraft(inspectorDraftTargetId, draftContent);
          } catch {
            return false;
          }
        }
      }
    }

    setInspectorPanelMode("hidden");
    setInspectorTargetId(undefined);
    setInspectorSnapshot(undefined);
    inspectorDraftContentRef.current = undefined;
    setInspectorDirty(false);
    setInspectorDraftStale(false);
    setInspectorEditableSourceOverride(undefined);
    setInspectorSourceVersion(0);
    setRevealedSource(undefined);
    setDismissedPeekNodeId(selectedGraphNode?.id ?? inspectorTargetId);
    return true;
  }, [
    handleSaveInspectorDraft,
    inspectorDraftTargetId,
    inspectorDirty,
    inspectorDraftStale,
    inspectorTargetId,
    selectedGraphNode?.id,
    setRevealedSource,
  ]);

  const handleCollapseInspector = useCallback(() => {
    setInspectorPanelMode((current) => (current === "expanded" ? "collapsed" : current));
  }, []);

  const handleExpandInspector = useCallback(() => {
    const nextNode = previewInspectorNode ?? selectedGraphNode ?? inspectorSnapshot;
    if (nextNode) {
      setInspectorTargetId(nextNode.id);
      setInspectorSnapshot(nextNode);
    }
    setDismissedPeekNodeId(undefined);
    setInspectorPanelMode("expanded");
  }, [inspectorSnapshot, previewInspectorNode, selectedGraphNode]);

  const handleClearGraphSelection = useCallback(async () => {
    await requestClearSelectionState();
  }, [requestClearSelectionState]);

  const handleExplorerSidebarResize = useCallback(
    (nextWidth: number) => {
      setExplorerSidebarWidth(clampExplorerSidebarWidth(nextWidth, workspaceLayoutWidth));
    },
    [workspaceLayoutWidth],
  );

  const handleExplorerResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (narrowWorkspaceLayout) {
        return;
      }

      const layoutLeft = workspaceLayoutRef.current?.getBoundingClientRect().left ?? 0;

      event.preventDefault();

      const resizeFromClientX = (clientX: number) => {
        if (!Number.isFinite(clientX)) {
          return;
        }

        handleExplorerSidebarResize(clientX - layoutLeft);
      };

      const handlePointerMove = (moveEvent: PointerEvent) => {
        resizeFromClientX(moveEvent.clientX);
      };

      const handleMouseMove = (moveEvent: MouseEvent) => {
        resizeFromClientX(moveEvent.clientX);
      };

      const stopResize = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", stopResize);
        window.removeEventListener("pointercancel", stopResize);
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", stopResize);
      };

      resizeFromClientX(event.clientX);
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", stopResize);
      window.addEventListener("pointercancel", stopResize);
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", stopResize);
    },
    [handleExplorerSidebarResize, narrowWorkspaceLayout],
  );

  const handleExplorerResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (narrowWorkspaceLayout) {
        return;
      }

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        handleExplorerSidebarResize(clampedExplorerSidebarWidth - 24);
        return;
      }

      if (event.key === "ArrowRight") {
        event.preventDefault();
        handleExplorerSidebarResize(clampedExplorerSidebarWidth + 24);
        return;
      }

      if (event.key === "Home") {
        event.preventDefault();
        handleExplorerSidebarResize(DEFAULT_EXPLORER_SIDEBAR_WIDTH);
      }
    },
    [clampedExplorerSidebarWidth, handleExplorerSidebarResize, narrowWorkspaceLayout],
  );

  const workspaceLayoutStyle = useMemo(
    () =>
      narrowWorkspaceLayout
        ? undefined
        : {
            gridTemplateColumns: `${Math.round(clampedExplorerSidebarWidth)}px 12px minmax(0, 1fr)`,
          },
    [clampedExplorerSidebarWidth, narrowWorkspaceLayout],
  );

  const titleCopy = useMemo(() => {
    if (returnExpressionGraphView) {
      return "Return graph";
    }
    if (activeLevel === "flow") {
      return "Internal flow";
    }
    if (activeLevel === "symbol") {
      return "Symbol blueprint";
    }
    if (activeLevel === "repo") {
      return "Architecture graph";
    }
    return "Architecture graph";
  }, [activeLevel, returnExpressionGraphView]);
  const graphPathItems = useMemo(() => {
    const baseItems = effectiveGraph
      ? buildGraphPathItems(effectiveGraph)
      : buildFallbackGraphPathItems(
          repoSession
            ? {
                id: repoSession.id,
                name: repoSession.name,
                path: repoSession.path,
              }
            : undefined,
          graphTargetId,
          activeLevel,
          overviewQuery.data?.modules ?? [],
        );
    if (!returnExpressionGraphView) {
      return baseItems;
    }
    return [
      ...baseItems,
      {
        key: `return-expression:${returnExpressionGraphView.returnNodeId}`,
        label: "return",
      },
    ];
  }, [
    activeLevel,
    effectiveGraph,
    graphTargetId,
    overviewQuery.data?.modules,
    repoSession,
    returnExpressionGraphView,
  ]);
  useEffect(() => {
    const previousContextKey = createModeContextKeyRef.current;
    createModeContextKeyRef.current = createModeContextKey;
    setCreateModeError(null);
    if (previousContextKey && previousContextKey !== createModeContextKey) {
      setCreateComposer(undefined);
      setCreateModeState((current) => (current === "inactive" ? current : "active"));
    }
  }, [createModeContextKey]);
  useEffect(() => {
    if (createModeState === "inactive") {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      ) {
        return;
      }

      event.preventDefault();
      if (createModeState === "composing") {
        setCreateComposer(undefined);
        setCreateModeError(null);
        setCreateModeState("active");
        return;
      }

      handleExitCreateMode();
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [createModeState, handleExitCreateMode]);
  useEffect(() => {
    if (
      !pendingCreatedNodeId ||
      !effectiveGraph?.nodes.some((node) => node.id === pendingCreatedNodeId)
    ) {
      return;
    }

    selectNode(pendingCreatedNodeId);
    setPendingCreatedNodeId(undefined);
  }, [effectiveGraph, pendingCreatedNodeId, selectNode]);
  const inspectorDrawerStatus = isSavingSource
    ? { label: "Saving", tone: "warning" as const }
    : inspectorDirty
      ? { label: "Unsaved", tone: "accent" as const }
      : createModeState !== "inactive"
        ? { label: "create", tone: "accent" as const }
        : { label: effectiveInspectorNode?.kind ?? activeLevel, tone: "default" as const };
  const graphContextPath = graphPathItems.map((item) => item.label).join(" / ");
  const graphContextTitle =
    effectiveGraph?.focus?.label ??
    graphPathItems[graphPathItems.length - 1]?.label ??
    repoSession?.name ??
    "Inspector";
  const graphContextSubtitle = effectiveGraph?.focus?.subtitle ?? (graphContextPath || titleCopy);
  const inspectorSummaryText = selectionSummary(effectiveInspectorNode);
  const drawerTitle = effectiveInspectorNode?.label ?? graphContextTitle;
  const drawerSubtitle = effectiveInspectorNode
    ? inspectorSummaryText && inspectorSummaryText !== effectiveInspectorNode.label
      ? inspectorSummaryText
      : graphContextSubtitle
    : graphContextSubtitle;
  const drawerActionNode =
    activeLevel === "flow" &&
    selectedGraphNode &&
    (isEnterableGraphNodeKind(selectedGraphNode.kind) ||
      isInspectableGraphNodeKind(selectedGraphNode.kind))
      ? selectedGraphNode
      : effectiveInspectorNode;
  const drawerNodePath =
    relativePathForNode(drawerActionNode) ??
    (drawerActionNode?.subtitle?.endsWith(".py") ? drawerActionNode.subtitle : undefined);
  const effectiveDrawerNodePath = drawerNodePath ?? currentModulePath;
  const drawerActions: BlueprintInspectorDrawerAction[] = [];
  if (drawerActionNode) {
    if (effectiveDrawerNodePath) {
      drawerActions.push({
        id: "open-default-editor",
        label: "Open File In Default Editor",
        helpId: "inspector.open-default-editor",
        tone: "secondary",
        onClick: () => {
          void handleOpenInDefaultEditor(drawerActionNode.id);
        },
      });
    }

    if (drawerActionNode.kind === "function") {
      drawerActions.push({
        id: "open-blueprint",
        label: "Open blueprint",
        helpId: "inspector.open-blueprint",
        onClick: () => handleOpenBlueprint(drawerActionNode.id),
      });
    }

    if (drawerActionNode.kind === "function" || drawerActionNode.kind === "class") {
      drawerActions.push({
        id: "open-flow",
        label: "Open flow",
        helpId: "inspector.open-flow",
        onClick: () => {
          setDismissedPeekNodeId(undefined);
          setInspectorTargetId(drawerActionNode.id);
          focusGraph(drawerActionNode.id, "flow");
        },
      });
    }

    if (revealActionEnabled(drawerActionNode)) {
      drawerActions.push({
        id: "reveal-source",
        label:
          revealedSource?.targetId === drawerActionNode.id ? "Refresh source" : "Reveal source",
        helpId: "inspector.reveal-source",
        onClick: () => {
          void handleRevealSource(drawerActionNode.id);
        },
      });
    }
  }

  const handleWorkspaceKeyDownCapture = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!shouldTrackInspectorSpaceTap(event.nativeEvent)) {
      return;
    }

    if (event.nativeEvent.repeat) {
      if (inspectorSpaceTapRef.current) {
        inspectorSpaceTapRef.current.cancelled = true;
      }
      return;
    }

    inspectorSpaceTapRef.current = {
      startedAt: Date.now(),
      cancelled: false,
    };
    event.preventDefault();
  };

  const handleWorkspaceKeyUpCapture = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!shouldTrackInspectorSpaceTap(event.nativeEvent)) {
      return;
    }

    const trackedTap = inspectorSpaceTapRef.current;
    inspectorSpaceTapRef.current = null;
    if (!trackedTap || trackedTap.cancelled) {
      return;
    }

    if (Date.now() - trackedTap.startedAt > INSPECTOR_SPACE_TAP_THRESHOLD_MS) {
      return;
    }

    event.preventDefault();
    if (effectiveInspectorDrawerMode === "expanded") {
      handleCollapseInspector();
      return;
    }

    handleExpandInspector();
  };

  const handleWorkspacePointerDownCapture = () => {
    if (inspectorSpaceTapRef.current) {
      inspectorSpaceTapRef.current.cancelled = true;
    }
  };

  const handleRevealGraphPath = useCallback(
    async (relativePath: string) => {
      setGraphPathRevealError(null);
      try {
        await adapter.revealPathInFileExplorer(relativePath);
      } catch (reason) {
        setGraphPathRevealError(
          reason instanceof Error
            ? reason.message
            : "Unable to reveal the current path in the system file explorer.",
        );
      }
    },
    [adapter],
  );

  const handleRevealExplorerPath = useCallback(
    (relativePath: string) => adapter.revealPathInFileExplorer(relativePath),
    [adapter],
  );

  const handleOpenExplorerPathInDefaultEditor = useCallback(
    (relativePath: string) => adapter.openPathInDefaultEditor(relativePath),
    [adapter],
  );

  const handleGraphPathItemClick = (
    event: ReactMouseEvent<HTMLButtonElement>,
    item: GraphPathItem,
  ) => {
    if ((event.metaKey || event.ctrlKey) && item.revealPath) {
      event.preventDefault();
      void handleRevealGraphPath(item.revealPath);
      return;
    }

    if (item.breadcrumb) {
      handleSelectBreadcrumb(item.breadcrumb);
    }
  };

  useEffect(() => {
    setGraphPathRevealError(null);
  }, [activeLevel, graphTargetId]);

  const handleCancelWorkspaceFileEdit = useCallback(() => {
    if (workspaceFileStale) {
      setWorkspaceFileSaveError(null);
      setWorkspaceFileStale(false);
      void workspaceFileQuery.refetch();
      return;
    }

    setWorkspaceFileDraft(activeWorkspaceFile?.content ?? "");
    setWorkspaceFileSaveError(null);
  }, [activeWorkspaceFile?.content, workspaceFileQuery, workspaceFileStale]);

  const handleCloseWorkspaceFileEditor = useCallback(() => {
    if (workspaceFileDirty || workspaceFileStale) {
      const shouldClose = window.confirm("Close this file editor and discard the current draft?");
      if (!shouldClose) {
        return;
      }
    }
    setActiveWorkspaceFilePath(undefined);
    setWorkspaceFileDraft("");
    setWorkspaceFileStale(false);
    setWorkspaceFileSaveError(null);
    workspaceFileLoadedKeyRef.current = undefined;
  }, [workspaceFileDirty, workspaceFileStale]);

  const workspaceFileError =
    workspaceFileQuery.error instanceof Error
      ? workspaceFileQuery.error.message
      : workspaceFileQuery.error
        ? "Unable to load this file."
        : null;

  return (
    <DesktopWindow
      eyebrow="Blueprint Editor"
      title={repoSession?.name ?? "H.E.L.M."}
      subtitle={workspaceWindowSubtitle(repoSession?.path, effectiveBackendStatus)}
      actions={<AppWindowActions />}
      dense
    >
      <WorkspaceHelpProvider>
        <WorkspaceHelpScope
          onKeyUpCapture={handleWorkspaceKeyUpCapture}
          onKeyDownCapture={handleWorkspaceKeyDownCapture}
          onPointerDownCapture={handleWorkspacePointerDownCapture}
        >
          <div
            ref={workspaceLayoutRef}
            className="workspace-layout workspace-layout--blueprint"
            data-testid="workspace-layout"
            style={workspaceLayoutStyle}
          >
            <SidebarPane
              backendStatus={effectiveBackendStatus}
              overview={overviewQuery.data}
              workspaceFiles={workspaceFilesQuery.data}
              sidebarQuery={sidebarQuery}
              searchResults={sidebarSearchQuery.data ?? []}
              isSearching={sidebarSearchQuery.isFetching}
              selectedFilePath={
                activeWorkspaceFilePath ??
                selectedFilePath ??
                inspectorSourcePath ??
                graphNodeRelativePath(inspectorNode?.metadata, inspectorNode?.subtitle)
              }
              selectedNodeId={activeNodeId}
              onSidebarQueryChange={setSidebarQuery}
              onSelectResult={selectSidebarResult}
              onSelectModule={selectOverviewModule}
              onSelectSymbol={selectOverviewSymbol}
              onSelectWorkspaceFile={selectWorkspaceFile}
              onCreateWorkspaceEntry={createWorkspaceEntry}
              onMoveWorkspaceEntry={moveWorkspaceEntry}
              onDeleteWorkspaceEntry={(relativePath) => deleteWorkspaceEntry({ relativePath })}
              onFocusRepoGraph={() => {
                setActiveWorkspaceFilePath(undefined);
                if (repoSession) {
                  focusGraph(repoSession.id, "repo");
                }
              }}
              onReindexRepo={reindexCurrentRepo}
              onOpenRepo={openAndIndexRepo}
              onOpenPathInDefaultEditor={handleOpenExplorerPathInDefaultEditor}
              onRevealPathInFileExplorer={handleRevealExplorerPath}
            />

            {!narrowWorkspaceLayout ? (
              <button
                aria-label="Resize explorer panel"
                className="workspace-layout__resize-rail"
                data-testid="workspace-sidebar-resize"
                type="button"
                onDoubleClick={() => handleExplorerSidebarResize(DEFAULT_EXPLORER_SIDEBAR_WIDTH)}
                onKeyDown={handleExplorerResizeKeyDown}
                onPointerDown={handleExplorerResizePointerDown}
              >
                <span aria-hidden="true" className="workspace-layout__resize-rail-handle" />
              </button>
            ) : null}

            <section className="pane pane--main blueprint-main">
              {repoOpenError ? (
                <p className="error-copy graph-stage__error">{repoOpenError}</p>
              ) : null}
              <div className="blueprint-stage__header">
                <div className="blueprint-stage__header-copy">
                  <span className="window-bar__eyebrow">Workspace</span>
                  <h2>{titleCopy}</h2>
                </div>

                {graphPathItems.length ? (
                  <div className="graph-location">
                    <span className="graph-location__label">Graph path</span>
                    <nav aria-label="Graph path" className="graph-location__trail">
                      {graphPathItems.map((item, index) => {
                        const isCurrent = index === graphPathItems.length - 1;
                        const itemHelpId =
                          item.key.startsWith("module:") || item.key.startsWith("fallback-module:")
                            ? "graph.path.file"
                            : item.breadcrumb?.level === "repo"
                              ? "graph.path.repo"
                              : item.breadcrumb?.level === "symbol"
                                ? "graph.path.symbol"
                                : item.breadcrumb?.level === "flow"
                                  ? "graph.path.flow"
                                  : undefined;
                        const itemClassName = `graph-location__button${
                          item.revealPath ? " graph-location__button--revealable" : ""
                        }${isCurrent ? " is-current" : ""}`;

                        return (
                          <div key={item.key} className="graph-location__item">
                            {index > 0 ? (
                              <span aria-hidden="true" className="graph-location__separator">
                                /
                              </span>
                            ) : null}

                            {item.breadcrumb ? (
                              <button
                                {...helpTargetProps(itemHelpId ?? "graph.path.symbol", {
                                  label: item.label,
                                })}
                                aria-current={isCurrent ? "page" : undefined}
                                className={itemClassName}
                                type="button"
                                title={
                                  item.revealPath
                                    ? "Click to navigate. Cmd/Ctrl-click to reveal in Finder/Explorer."
                                    : "Click to navigate."
                                }
                                onClick={(event) => handleGraphPathItemClick(event, item)}
                              >
                                {item.label}
                              </button>
                            ) : (
                              <span
                                {...helpTargetProps(
                                  itemHelpId ??
                                    (isCurrent && activeLevel === "flow"
                                      ? "graph.path.flow"
                                      : "graph.path.symbol"),
                                  { label: item.label },
                                )}
                                aria-current={isCurrent ? "page" : undefined}
                                className={`graph-location__segment${isCurrent ? " is-current" : ""}`}
                              >
                                {item.label}
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </nav>
                    {graphPathRevealError ? (
                      <p className="error-copy">{graphPathRevealError}</p>
                    ) : null}
                  </div>
                ) : null}
              </div>

              <div className="blueprint-main__body">
                <div
                  className={`blueprint-graph-shell blueprint-graph-shell--${effectiveInspectorDrawerMode}`}
                  data-inspector-mode={effectiveInspectorDrawerMode}
                >
                  <div className="blueprint-graph-shell__canvas">
                    {returnExpressionGraphView && returnExpressionGraphViewNode ? (
                      <FlowExpressionGraphCanvas
                        diagnostics={returnExpressionGraphView.diagnostics}
                        error={returnExpressionGraphView.error}
                        expression={returnExpressionGraphViewExpression}
                        graph={returnExpressionGraphViewGraph}
                        inputSlots={returnExpressionGraphViewInputSlots}
                        isDraftOnly={returnExpressionGraphView.isDraftOnly}
                        isSaving={isSubmittingExpressionGraph}
                        ownerLabel={
                          flowOwnerSymbolQuery.data?.qualname ??
                          effectiveGraph?.focus?.label ??
                          "Return"
                        }
                        selectedExpressionNodeId={
                          returnExpressionGraphView.selectedExpressionNodeId
                        }
                        onGraphChange={handleReturnExpressionGraphChange}
                        onNavigateOut={handleExitReturnExpressionGraph}
                        onSelectExpressionNode={handleSelectReturnExpressionNode}
                      />
                    ) : (
                      <GraphCanvas
                        repoPath={repoSession?.path}
                        graph={effectiveGraph}
                        isLoading={!effectiveGraph && graphQuery.isFetching}
                        errorMessage={
                          !effectiveGraph
                            ? graphQuery.error instanceof Error
                              ? graphQuery.error.message
                              : graphQuery.error
                                ? "Unable to load the current graph."
                                : null
                            : null
                        }
                        activeNodeId={activeNodeId}
                        graphFilters={graphFilters}
                        graphSettings={graphSettings}
                        flowInputDisplayMode={flowInputDisplayMode}
                        highlightGraphPath={highlightGraphPath}
                        showEdgeLabels={showEdgeLabels}
                        onSelectNode={handleGraphSelectNode}
                        onActivateNode={handleGraphActivateNode}
                        onInspectNode={handleGraphInspectNode}
                        onOpenNodeInDefaultEditor={handleOpenNodeInDefaultEditor}
                        onRevealNodeInFileExplorer={handleRevealNodeInFileExplorer}
                        onSelectBreadcrumb={handleSelectBreadcrumb}
                        onSelectLevel={handleSelectLevel}
                        onToggleGraphFilter={toggleGraphFilter}
                        onToggleGraphSetting={toggleGraphSetting}
                        onSetFlowInputDisplayMode={setFlowInputDisplayMode}
                        onToggleGraphPathHighlight={toggleGraphPathHighlight}
                        onToggleEdgeLabels={toggleEdgeLabels}
                        onNavigateOut={handleNavigateGraphOut}
                        onClearSelection={() => void handleClearGraphSelection()}
                        createModeState={createModeState}
                        createModeCanvasEnabled={createModeCanvasEnabled}
                        createModeHint={createModeHint}
                        onToggleCreateMode={() => {
                          void handleToggleCreateMode();
                        }}
                        onCreateIntent={handleOpenCreateComposer}
                        onEditFlowNodeIntent={handleOpenFlowEditComposer}
                        onOpenExpressionGraphIntent={handleOpenExpressionGraphEditor}
                        onConnectFlowEdge={handleConnectFlowEdge}
                        onReconnectFlowEdge={handleReconnectFlowEdge}
                        onDisconnectFlowEdge={handleDisconnectFlowEdge}
                        onDeleteFlowSelection={handleDeleteFlowSelection}
                        onDeleteSymbolNode={handleDeleteSymbolNode}
                      />
                    )}
                    {createComposer && !returnExpressionGraphView ? (
                      <GraphCreateComposer
                        key={createComposer.id}
                        composer={createComposer}
                        error={createModeError}
                        isSubmitting={isSubmittingCreate}
                        onCancel={() => {
                          setCreateComposer(undefined);
                          setCreateModeError(null);
                          setCreateModeState((current) =>
                            current === "composing" ? "active" : current,
                          );
                        }}
                        onSubmit={handleCreateSubmit}
                      />
                    ) : null}
                  </div>

                  {activeWorkspaceFilePath ? (
                    <WorkspaceFileEditorPanel
                      file={activeWorkspaceFile}
                      draft={workspaceFileDraft}
                      dirty={workspaceFileDirty}
                      stale={workspaceFileStale}
                      error={workspaceFileError}
                      isLoading={workspaceFileQuery.isFetching && !activeWorkspaceFile}
                      isSaving={isSavingWorkspaceFile}
                      saveError={workspaceFileSaveError}
                      onCancel={handleCancelWorkspaceFileEdit}
                      onChange={(content) => {
                        setWorkspaceFileDraft(content);
                        setWorkspaceFileSaveError(null);
                      }}
                      onClose={handleCloseWorkspaceFileEditor}
                      onSave={() => {
                        void saveWorkspaceFile();
                      }}
                    />
                  ) : null}

                  {effectiveInspectorDrawerMode !== "hidden" ? (
                    <BlueprintInspectorDrawer
                      actionError={inspectorActionError}
                      actions={drawerActions}
                      drawerHeight={inspectorDrawerHeight}
                      mode={effectiveInspectorDrawerMode}
                      showDismiss={Boolean(effectiveInspectorNode)}
                      statusLabel={inspectorDrawerStatus.label}
                      statusTone={inspectorDrawerStatus.tone}
                      subtitle={drawerSubtitle}
                      title={drawerTitle}
                      onClose={() => {
                        if (inspectorPanelMode === "hidden" && effectiveInspectorNode) {
                          setDismissedPeekNodeId(effectiveInspectorNode.id);
                          return;
                        }
                        if (inspectorPanelMode !== "hidden") {
                          void requestInspectorClose();
                        }
                      }}
                      onCollapse={handleCollapseInspector}
                      onExpand={handleExpandInspector}
                      onHeightChange={setInspectorDrawerHeight}
                    >
                      {inspectorPanelMode !== "hidden" ? (
                        <BlueprintInspector
                          key={`inspector:${inspectorSelectionNode?.id ?? "none"}:${inspectorSourceTarget?.targetId ?? "no-source"}:${inspectorSourceVersion}`}
                          selectedNode={inspectorSelectionNode}
                          sourceContextNode={inspectorSourceTarget?.node}
                          symbol={symbolQuery.data}
                          editableSource={effectiveEditableSource}
                          editableSourceLoading={editableSourceQuery.isFetching}
                          editableSourceError={
                            editableSourceQuery.error instanceof Error
                              ? editableSourceQuery.error.message
                              : editableSourceQuery.error
                                ? "Unable to load editable source."
                                : null
                          }
                          draftStale={inspectorDraftStale}
                          revealedSource={revealedSource}
                          lastActivity={lastActivity}
                          isSavingSource={isSavingSource}
                          moduleActionNode={currentModuleNode}
                          destinationModulePaths={structuralDestinationModulePaths}
                          highlightRange={inspectorHighlightRange}
                          flowFunctionInputs={activeFlowDraft?.document.functionInputs ?? []}
                          flowInputDisplayMode={flowInputDisplayMode}
                          flowInputsEditable={Boolean(activeFlowDraft?.document.editable)}
                          onApplyStructuralEdit={handleApplyEdit}
                          onAddFlowFunctionInput={handleAddFlowFunctionInput}
                          onUpdateFlowFunctionInput={handleUpdateFlowFunctionInput}
                          onMoveFlowFunctionInput={handleMoveFlowFunctionInput}
                          onRemoveFlowFunctionInput={removeFlowFunctionInputWithConfirmation}
                          onOpenNodeInDefaultEditor={handleOpenNodeInDefaultEditor}
                          onRevealNodeInFileExplorer={handleRevealNodeInFileExplorer}
                          onSaveSource={handleSaveNodeSource}
                          onEditorStateChange={handleInspectorEditorStateChange}
                          onDismissSource={() => setRevealedSource(undefined)}
                          onClose={handleCollapseInspector}
                        />
                      ) : null}
                    </BlueprintInspectorDrawer>
                  ) : null}
                </div>
              </div>
            </section>
          </div>
        </WorkspaceHelpScope>
      </WorkspaceHelpProvider>
      <CommandPalette />
    </DesktopWindow>
  );
}
