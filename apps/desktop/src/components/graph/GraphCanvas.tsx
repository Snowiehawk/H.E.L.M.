import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import {
  Background,
  Controls,
  MarkerType,
  PanOnScrollMode,
  ReactFlow,
  SelectionMode,
  ViewportPortal,
  applyNodeChanges,
  getSmoothStepPath,
  useReactFlow,
  useKeyPress,
  type Connection,
  type ConnectionLineComponentProps,
  type Edge,
  type EdgeTypes,
  type Node,
  type NodeChange,
  type NodeTypes,
  type ReactFlowInstance,
} from "@xyflow/react";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import type {
  GraphAbstractionLevel,
  GraphBreadcrumbDto,
  GraphEdgeKind,
  GraphFilters,
  FlowInputDisplayMode,
  GraphNodeKind,
  GraphNodeDto,
  GraphSettings,
  GraphView,
} from "../../lib/adapter";
import {
  isEnterableGraphNodeKind,
  isGraphSymbolNodeKind,
  isInspectableGraphNodeKind,
} from "../../lib/adapter";
import { isFlowNodeAuthorableKind, type FlowLoopType } from "./flowDocument";
import { GraphToolbar } from "./GraphToolbar";
import { BlueprintNode, type BlueprintNodeData, type BlueprintNodePort } from "./BlueprintNode";
import { BlueprintEdge, type BlueprintEdgeData } from "./BlueprintEdge";
import { RerouteNode, type RerouteNodeData } from "./RerouteNode";
import {
  helpIdForGraphEdgeKind,
  helpTargetProps,
  type HelpDescriptorId,
  useWorkspaceHelp,
} from "../workspace/workspaceHelp";
import { buildBlueprintPresentation } from "./blueprintPorts";
import { declutterGraphLayout } from "./declutterLayout";
import {
  flowExpressionNodeDisplayLabel,
  normalizeFlowExpressionGraph,
} from "./flowExpressionGraph";
import { layoutFlowGraph } from "./flowLayout";
import {
  graphLayoutNodeKey,
  graphLayoutViewKey,
  peekStoredGraphLayout,
  readStoredGraphLayout,
  type StoredGraphGroup,
  type StoredGraphLayout,
  type StoredGraphNodeLayout,
  type StoredGraphReroute,
  writeStoredGraphLayout,
} from "./graphLayoutPersistence";
import { organizeGroupedNodes, type GroupOrganizeMode } from "./groupOrganizeLayout";
import { EmptyState } from "../shared/EmptyState";
import {
  AppContextMenu,
  clampAppContextMenuPosition,
  copyToClipboard,
  systemFileExplorerLabel,
  type AppContextMenuItem,
  type AppContextMenuPosition,
} from "../shared/AppContextMenu";
import { useUiStore } from "../../store/uiStore";
import { useUndoStore, type UndoEntry } from "../../store/undoStore";

const REROUTE_NODE_PREFIX = "reroute:";
const REROUTE_NODE_SIZE = 18;
const GROUP_BOX_PADDING = 24;
const GROUP_TITLE_OFFSET = 12;
const DEFAULT_GROUP_TITLE = "Group";
const FALLBACK_GROUP_NODE_WIDTH = 252;
const FALLBACK_GROUP_NODE_HEIGHT = 96;
const EMPTY_STRING_SET = new Set<string>();
const GROUP_ORGANIZE_OPTIONS: Array<{ mode: GroupOrganizeMode; label: string }> = [
  { mode: "column", label: "Column" },
  { mode: "row", label: "Row" },
  { mode: "grid", label: "Grid" },
  { mode: "tidy", label: "Tidy" },
  { mode: "kind", label: "By kind" },
];

const nodeTypes: NodeTypes = {
  blueprint: BlueprintNode,
  reroute: RerouteNode,
};

const edgeTypes: EdgeTypes = {
  blueprint: BlueprintEdge,
};

const MIN_GRAPH_ZOOM = 0.12;
const MAX_GRAPH_ZOOM = 1.8;
const FLOW_CONNECTION_RADIUS = 32;
const FLOW_RECONNECT_RADIUS = 16;
const noopExpressionGraphIntent = () => {};

type SemanticCanvasNode = Node<BlueprintNodeData, "blueprint">;
type RerouteCanvasNode = Node<RerouteNodeData, "reroute">;
type GraphCanvasNode = SemanticCanvasNode | RerouteCanvasNode;
type GraphCanvasEdge = Edge<BlueprintEdgeData, "blueprint">;
type GraphContextMenuState =
  | (AppContextMenuPosition & {
      kind: "node";
      nodeId: string;
      focusElement?: HTMLElement | null;
    })
  | (AppContextMenuPosition & {
      kind: "edge";
      edgeId: string;
      edgeKind: GraphEdgeKind;
      edgeLabel?: string;
      segmentIndex: number;
      flowPosition: { x: number; y: number };
      focusElement?: HTMLElement | null;
    })
  | (AppContextMenuPosition & {
      kind: "pane";
      flowPosition: { x: number; y: number };
      focusElement?: HTMLElement | null;
    });
export type CreateModeState = "inactive" | "active" | "composing";
export interface GraphCreateIntent {
  flowPosition: { x: number; y: number };
  panelPosition: { x: number; y: number };
  seedFlowConnection?: {
    sourceNodeId: string;
    sourceHandle: "body" | "after";
    label: "Repeat" | "Done";
  };
}
export interface GraphFlowEditIntent {
  nodeId: string;
  flowPosition: { x: number; y: number };
  panelPosition: { x: number; y: number };
  initialLoopType?: FlowLoopType;
}
export interface GraphExpressionGraphIntent {
  nodeId: string;
  expressionNodeId?: string;
  flowPosition: { x: number; y: number };
  panelPosition: { x: number; y: number };
}
export interface GraphFlowConnectionIntent {
  sourceId: string;
  sourceHandle?: string | null;
  targetId: string;
  targetHandle?: string | null;
}
export interface GraphFlowDeleteIntent {
  nodeIds: string[];
  edgeIds: string[];
}

export function resolveFlowEdgeInteraction({
  flowAuthoringEnabled,
  logicalEdgeKind,
  altKey,
}: {
  flowAuthoringEnabled: boolean;
  logicalEdgeKind: GraphEdgeKind;
  altKey: boolean;
}): "ignore" | "select" | "disconnect" {
  if (!flowAuthoringEnabled || logicalEdgeKind !== "controls") {
    return "ignore";
  }
  return altKey ? "disconnect" : "select";
}
type EdgeLabelSegment = {
  id: string;
  label: string;
  source: string;
  target: string;
  sourceHandle: string | null | undefined;
  targetHandle: string | null | undefined;
};

interface CollapsedEdgeLabel {
  label?: string;
  count?: number;
}

interface GroupMembership {
  groupByNodeId: Map<string, string>;
  memberNodeIdsByGroupId: Map<string, string[]>;
}

interface GraphGroupBounds extends StoredGraphGroup {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface MergeGroupsForSelectionResult {
  changed: boolean;
  nextGroupId?: string;
  nextGroups: StoredGraphGroup[];
}

interface UngroupGroupsForSelectionResult {
  changed: boolean;
  nextGroups: StoredGraphGroup[];
  removedGroupIds: string[];
}

interface LayoutUndoStackEntry {
  viewKey: string;
  layout: StoredGraphLayout;
  entry: UndoEntry;
}

function isSemanticCanvasNode(node: GraphCanvasNode): node is SemanticCanvasNode {
  return node.type === "blueprint";
}

function isRerouteCanvasNode(node: GraphCanvasNode): node is RerouteCanvasNode {
  return node.type === "reroute";
}

function isControlFlowConnectionPair(
  sourceHandle: string | null | undefined,
  targetHandle: string | null | undefined,
) {
  return sourceHandle?.startsWith("out:control:") === true && targetHandle === "in:control:exec";
}

function isDataFlowConnectionPair(
  sourceHandle: string | null | undefined,
  targetHandle: string | null | undefined,
) {
  return (
    sourceHandle?.startsWith("out:data:") === true && targetHandle?.startsWith("in:data:") === true
  );
}

function isVisualFunctionInputNode(node: GraphNodeDto): boolean {
  return (
    node.kind === "param" &&
    node.metadata["flow_visual"] === true &&
    typeof node.metadata["function_input_id"] === "string"
  );
}

export function isValidFlowCanvasConnection(connection: {
  source?: string | null;
  sourceHandle?: string | null;
  target?: string | null;
  targetHandle?: string | null;
}) {
  if (!connection.source || !connection.target || connection.source === connection.target) {
    return false;
  }

  return (
    isControlFlowConnectionPair(connection.sourceHandle, connection.targetHandle) ||
    isDataFlowConnectionPair(connection.sourceHandle, connection.targetHandle)
  );
}

function BlueprintConnectionLine({
  connectionStatus,
  fromPosition,
  fromX,
  fromY,
  toPosition,
  toX,
  toY,
}: ConnectionLineComponentProps<GraphCanvasNode>) {
  const [edgePath] = getSmoothStepPath({
    sourceX: fromX,
    sourceY: fromY,
    sourcePosition: fromPosition,
    targetX: toX,
    targetY: toY,
    targetPosition: toPosition,
  });
  const statusClass =
    connectionStatus === "invalid"
      ? "is-invalid"
      : connectionStatus === "valid"
        ? "is-valid"
        : "is-pending";

  return (
    <g className={`graph-connection-line ${statusClass}`} data-testid="graph-connection-line">
      <path className="graph-connection-line__halo" d={edgePath} />
      <path className="graph-connection-line__path" d={edgePath} />
      <circle className="graph-connection-line__cursor" cx={toX} cy={toY} r={5.5} />
    </g>
  );
}

function metadataNumber(node: GraphNodeDto, key: string): number | undefined {
  const value =
    node.metadata[key] ??
    node.metadata[key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())];
  return typeof value === "number" ? value : undefined;
}

function metadataString(node: GraphNodeDto, key: string): string | undefined {
  const value =
    node.metadata[key] ??
    node.metadata[key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())];
  return typeof value === "string" ? value : undefined;
}

function looksLikeSourcePath(value: string): boolean {
  return value.includes("/") || value.endsWith(".py");
}

function relativePathForGraphNode(node: GraphNodeDto): string | undefined {
  const relativePath = metadataString(node, "relative_path");
  if (relativePath && looksLikeSourcePath(relativePath)) {
    return relativePath;
  }
  if (node.kind === "module" && node.subtitle && looksLikeSourcePath(node.subtitle)) {
    return node.subtitle;
  }
  return undefined;
}

function moduleDisplayLabel(node: GraphNodeDto): string {
  if (node.kind !== "module") {
    return node.label;
  }

  const relativePath = metadataString(node, "relative_path");
  if (!relativePath || !looksLikeSourcePath(relativePath)) {
    return node.label;
  }

  const segments = relativePath.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? node.label;
}

function nodeSummary(node: GraphNodeDto): string | undefined {
  if (node.kind === "repo") {
    return "Architecture map";
  }
  if (node.kind === "module") {
    const symbolCount = metadataNumber(node, "symbol_count");
    const callCount = metadataNumber(node, "call_count");
    if (typeof symbolCount === "number" && typeof callCount === "number") {
      return `${symbolCount} symbols · ${callCount} calls`;
    }
  }
  if (isGraphSymbolNodeKind(node.kind)) {
    const symbolKind =
      metadataString(node, "symbol_kind") ?? (node.kind === "symbol" ? undefined : node.kind);
    const moduleName = metadataString(node, "module_name");
    if (symbolKind && moduleName) {
      return `${symbolKind.replaceAll("_", " ")} · ${moduleName}`;
    }
  }
  return node.subtitle ?? undefined;
}

function expressionPreviewForNode(
  node: GraphNodeDto,
): BlueprintNodeData["expressionPreview"] | undefined {
  if (node.kind !== "return") {
    return undefined;
  }
  const graph = normalizeFlowExpressionGraph(
    node.metadata.flow_expression_graph ?? node.metadata.flowExpressionGraph,
  );
  if (!graph?.nodes.length) {
    return undefined;
  }
  const rootId = graph.rootId;
  const rootNodes = rootId ? graph.nodes.filter((candidate) => candidate.id === rootId) : [];
  const nonRootNodes = graph.nodes.filter((candidate) => candidate.id !== rootId);
  const orderedNodes = [
    ...rootNodes,
    ...nonRootNodes.filter((candidate) => candidate.kind !== "input"),
    ...nonRootNodes.filter((candidate) => candidate.kind === "input"),
  ];
  return {
    nodes: orderedNodes.map((expressionNode) => ({
      id: expressionNode.id,
      kind: expressionNode.kind,
      label: flowExpressionNodeDisplayLabel(expressionNode),
      isRoot: expressionNode.id === rootId,
    })),
    nodeCount: graph.nodes.length,
  };
}

function rerouteNodeId(rerouteId: string) {
  return `${REROUTE_NODE_PREFIX}${rerouteId}`;
}

function rerouteStorageId(nodeId: string) {
  return nodeId.startsWith(REROUTE_NODE_PREFIX) ? nodeId.slice(REROUTE_NODE_PREFIX.length) : nodeId;
}

function createRerouteId(logicalEdgeId: string) {
  const sanitized = logicalEdgeId.replace(/[^a-zA-Z0-9_-]+/g, "-");
  const unique =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  return `${sanitized}-${unique}`;
}

function createGroupId() {
  const unique =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  return `group-${unique}`;
}

function normalizeGroupTitle(title: string | undefined) {
  const normalized = title?.trim();
  return normalized?.length ? normalized : DEFAULT_GROUP_TITLE;
}

function compareNodeIds(left: string, right: string) {
  return left.localeCompare(right);
}

function sortNodeIds(nodeIds: Iterable<string>) {
  return [...nodeIds].sort(compareNodeIds);
}

function sameNodeIds(left: string[], right: string[]) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((nodeId, index) => nodeId === right[index]);
}

function resolveSelectionPreviewNodeIds({
  activeNodeId,
  effectiveSemanticSelection,
  graphNodeIds,
  marqueeSelectionActive,
  selectedGroupId,
  selectedRerouteCount,
}: {
  activeNodeId?: string;
  effectiveSemanticSelection: string[];
  graphNodeIds: Set<string>;
  marqueeSelectionActive: boolean;
  selectedGroupId?: string;
  selectedRerouteCount: number;
}) {
  if (marqueeSelectionActive || selectedRerouteCount || selectedGroupId) {
    return [];
  }

  if (effectiveSemanticSelection.length) {
    return effectiveSemanticSelection;
  }

  return graphNodeIds.has(activeNodeId ?? "") ? [activeNodeId ?? ""] : [];
}

export function resolveSelectionPreviewNodeId({
  activeNodeId,
  effectiveSemanticSelection,
  graphNodeIds,
  marqueeSelectionActive,
  selectedGroupId,
  selectedRerouteCount,
}: {
  activeNodeId?: string;
  effectiveSemanticSelection: string[];
  graphNodeIds: Set<string>;
  marqueeSelectionActive: boolean;
  selectedGroupId?: string;
  selectedRerouteCount: number;
}) {
  const previewNodeIds = resolveSelectionPreviewNodeIds({
    activeNodeId,
    effectiveSemanticSelection,
    graphNodeIds,
    marqueeSelectionActive,
    selectedGroupId,
    selectedRerouteCount,
  });

  return previewNodeIds.length === 1 ? (previewNodeIds[0] ?? "") : "";
}

export function normalizeStoredGroups(
  groups: StoredGraphGroup[] | undefined,
  liveNodeIds: Set<string>,
): StoredGraphGroup[] {
  const claimedNodeIds = new Set<string>();
  const normalized: StoredGraphGroup[] = [];

  (groups ?? []).forEach((group) => {
    if (!group.id) {
      return;
    }

    const memberNodeIds = sortNodeIds(
      new Set(
        (group.memberNodeIds ?? []).filter(
          (memberNodeId) => liveNodeIds.has(memberNodeId) && !claimedNodeIds.has(memberNodeId),
        ),
      ),
    );

    if (memberNodeIds.length < 2) {
      return;
    }

    memberNodeIds.forEach((memberNodeId) => {
      claimedNodeIds.add(memberNodeId);
    });

    normalized.push({
      id: group.id,
      title: normalizeGroupTitle(group.title),
      memberNodeIds,
    });
  });

  return normalized;
}

function buildGroupMembership(groups: StoredGraphGroup[]): GroupMembership {
  const groupByNodeId = new Map<string, string>();
  const memberNodeIdsByGroupId = new Map<string, string[]>();

  groups.forEach((group) => {
    const memberNodeIds = sortNodeIds(group.memberNodeIds);
    memberNodeIdsByGroupId.set(group.id, memberNodeIds);
    memberNodeIds.forEach((memberNodeId) => {
      groupByNodeId.set(memberNodeId, group.id);
    });
  });

  return {
    groupByNodeId,
    memberNodeIdsByGroupId,
  };
}

function touchedGroupIdsForNodeIds(nodeIds: Iterable<string>, groupByNodeId: Map<string, string>) {
  const groupIds = new Set<string>();
  [...nodeIds].forEach((nodeId) => {
    const groupId = groupByNodeId.get(nodeId);
    if (groupId) {
      groupIds.add(groupId);
    }
  });
  return sortNodeIds(groupIds);
}

export function expandGroupedNodeIds(
  nodeIds: Iterable<string>,
  groupByNodeId: Map<string, string>,
  memberNodeIdsByGroupId: Map<string, string[]>,
) {
  const expanded = new Set<string>();
  [...nodeIds].forEach((nodeId) => {
    const groupId = groupByNodeId.get(nodeId);
    if (!groupId) {
      expanded.add(nodeId);
      return;
    }

    (memberNodeIdsByGroupId.get(groupId) ?? []).forEach((memberNodeId) => {
      expanded.add(memberNodeId);
    });
  });

  return sortNodeIds(expanded);
}

function buildNodeShellClassName(
  nodeId: string,
  selectedNodeIds: Set<string>,
  selectedRelatedNodeIds: Set<string>,
  selectionContextActive: boolean,
  groupedNodeIds: Set<string>,
  selectedGroupMemberNodeIds: Set<string>,
) {
  return [
    "graph-node-shell",
    selectedNodeIds.has(nodeId) ? "is-active" : "",
    selectionContextActive && selectedRelatedNodeIds.has(nodeId) ? "is-related" : "",
    selectionContextActive && !selectedRelatedNodeIds.has(nodeId) ? "is-dimmed" : "",
    groupedNodeIds.has(nodeId) ? "is-group-member" : "",
    selectedGroupMemberNodeIds.has(nodeId) ? "is-group-selected" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function buildRerouteShellClassName(
  logicalEdgeId: string,
  highlightedEdgeIds: Set<string>,
  hoverActive: boolean,
  selectedConnectedEdgeIds: Set<string>,
  selectionContextActive: boolean,
) {
  const related = hoverActive
    ? highlightedEdgeIds.has(logicalEdgeId)
    : selectionContextActive
      ? selectedConnectedEdgeIds.has(logicalEdgeId)
      : false;
  const dimmed = hoverActive
    ? !highlightedEdgeIds.has(logicalEdgeId)
    : selectionContextActive
      ? !selectedConnectedEdgeIds.has(logicalEdgeId)
      : false;

  return ["graph-reroute-shell", related ? "is-related" : "", dimmed ? "is-dimmed" : ""]
    .filter(Boolean)
    .join(" ");
}

function decorateNodePorts(
  ports: BlueprintNodePort[],
  highlightedEdgeIds: Set<string>,
  hoverActive: boolean,
  onPortHoverStart: (edgeIds: string[]) => void,
  onPortHoverEnd: () => void,
): BlueprintNodePort[] {
  return ports.map((port) => {
    const portEdgeIds = port.memberEdgeIds ?? [];
    const isHighlighted = portEdgeIds.some((edgeId) => highlightedEdgeIds.has(edgeId));
    return {
      ...port,
      isHighlighted,
      isDimmed: hoverActive && !isHighlighted,
      onHoverStart: portEdgeIds.length ? () => onPortHoverStart(portEdgeIds) : undefined,
      onHoverEnd: portEdgeIds.length ? onPortHoverEnd : undefined,
    };
  });
}

function buildSemanticCanvasNodes(
  graph: GraphView,
  selectedNodeIds: Set<string>,
  savedPositions: StoredGraphNodeLayout,
  pinnedNodeIds: Set<string>,
  highlightedEdgeIds: Set<string>,
  hoverActive: boolean,
  selectedRelatedNodeIds: Set<string>,
  selectionContextActive: boolean,
  groupedNodeIds: Set<string>,
  selectedGroupMemberNodeIds: Set<string>,
  canPinNodes: boolean,
  canConnectFlowHandles: boolean,
  onTogglePinned: (nodeId: string) => void,
  onActivateNode: (nodeId: string, kind: GraphNodeKind) => void,
  onInspectNode: (nodeId: string, kind: GraphNodeKind) => void,
  onOpenExpressionGraph: (nodeId: string, expressionNodeId?: string) => void,
  onPortHoverStart: (edgeIds: string[]) => void,
  onPortHoverEnd: () => void,
): SemanticCanvasNode[] {
  const blueprint = buildBlueprintPresentation(graph);
  return graph.nodes.map<SemanticCanvasNode>((node) => {
    const ports = blueprint.nodePorts.get(node.id) ?? { inputs: [], outputs: [] };
    const savedPosition = savedPositions[graphLayoutNodeKey(node.id, node.kind)];
    const isPinned = pinnedNodeIds.has(node.id);
    const actions: BlueprintNodeData["actions"] = [];

    if (isEnterableGraphNodeKind(node.kind)) {
      actions.push({
        id: "enter",
        label: "Enter",
        helpId: "graph.node.action.enter",
        onAction: () => onActivateNode(node.id, node.kind),
      });
    }

    if (isInspectableGraphNodeKind(node.kind)) {
      actions.push({
        id: "inspect",
        label: "Inspect",
        helpId: "graph.node.action.inspect",
        onAction: () => onInspectNode(node.id, node.kind),
      });
    }

    if (canPinNodes) {
      actions.push({
        id: "pin",
        label: isPinned ? "Unpin" : "Pin",
        helpId: pinActionHelpId(isPinned),
        onAction: () => onTogglePinned(node.id),
      });
    }

    const expressionPreview = expressionPreviewForNode(node);
    return {
      id: node.id,
      position: savedPosition ?? { x: node.x, y: node.y },
      type: "blueprint",
      data: {
        kind: node.kind,
        label: moduleDisplayLabel(node),
        summary: nodeSummary(node),
        expressionPreview: expressionPreview
          ? {
              ...expressionPreview,
              onOpen: (expressionNodeId?: string) =>
                onOpenExpressionGraph(node.id, expressionNodeId),
            }
          : undefined,
        isPinned,
        inputPorts: decorateNodePorts(
          ports.inputs,
          highlightedEdgeIds,
          hoverActive,
          onPortHoverStart,
          onPortHoverEnd,
        ),
        outputPorts: decorateNodePorts(
          ports.outputs,
          highlightedEdgeIds,
          hoverActive,
          onPortHoverStart,
          onPortHoverEnd,
        ),
        connectable: canConnectFlowHandles,
        actions,
        onDefaultAction: actions[0]?.onAction,
      },
      draggable: true,
      selectable: true,
      className: buildNodeShellClassName(
        node.id,
        selectedNodeIds,
        selectedRelatedNodeIds,
        selectionContextActive,
        groupedNodeIds,
        selectedGroupMemberNodeIds,
      ),
    };
  });
}

function buildRerouteCanvasNodes(
  reroutes: StoredGraphReroute[],
  highlightedEdgeIds: Set<string>,
  hoverActive: boolean,
  selectedConnectedEdgeIds: Set<string>,
  selectionContextActive: boolean,
): RerouteCanvasNode[] {
  return reroutes
    .slice()
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    .map<RerouteCanvasNode>((reroute) => ({
      id: rerouteNodeId(reroute.id),
      position: { x: reroute.x, y: reroute.y },
      type: "reroute",
      data: {
        kind: "reroute",
        logicalEdgeId: reroute.edgeId,
        order: reroute.order,
      },
      draggable: true,
      selectable: true,
      className: buildRerouteShellClassName(
        reroute.edgeId,
        highlightedEdgeIds,
        hoverActive,
        selectedConnectedEdgeIds,
        selectionContextActive,
      ),
    }));
}

function buildCanvasNodes(
  graph: GraphView,
  selectedNodeIds: Set<string>,
  layout: StoredGraphLayout,
  highlightedEdgeIds: Set<string>,
  hoverActive: boolean,
  selectedRelatedNodeIds: Set<string>,
  selectedConnectedEdgeIds: Set<string>,
  selectionContextActive: boolean,
  groupedNodeIds: Set<string>,
  selectedGroupMemberNodeIds: Set<string>,
  canPinNodes: boolean,
  canConnectFlowHandles: boolean,
  onTogglePinned: (nodeId: string) => void,
  onActivateNode: (nodeId: string, kind: GraphNodeKind) => void,
  onInspectNode: (nodeId: string, kind: GraphNodeKind) => void,
  onOpenExpressionGraph: (nodeId: string, expressionNodeId?: string) => void,
  onPortHoverStart: (edgeIds: string[]) => void,
  onPortHoverEnd: () => void,
): GraphCanvasNode[] {
  const savedNodePositions = layout.nodes ?? {};
  const savedReroutes = layout.reroutes ?? [];
  const pinnedNodeIds = new Set(layout.pinnedNodeIds ?? []);
  return [
    ...buildSemanticCanvasNodes(
      graph,
      selectedNodeIds,
      savedNodePositions,
      pinnedNodeIds,
      highlightedEdgeIds,
      hoverActive,
      selectedRelatedNodeIds,
      selectionContextActive,
      groupedNodeIds,
      selectedGroupMemberNodeIds,
      canPinNodes,
      canConnectFlowHandles,
      onTogglePinned,
      onActivateNode,
      onInspectNode,
      onOpenExpressionGraph,
      onPortHoverStart,
      onPortHoverEnd,
    ),
    ...buildRerouteCanvasNodes(
      savedReroutes,
      highlightedEdgeIds,
      hoverActive,
      selectedConnectedEdgeIds,
      selectionContextActive,
    ),
  ];
}

function normalizeRerouteNodeOrders(nodes: GraphCanvasNode[]): GraphCanvasNode[] {
  const reroutesByEdge = new Map<string, RerouteCanvasNode[]>();
  nodes.forEach((node) => {
    if (!isRerouteCanvasNode(node)) {
      return;
    }
    const edgeId = node.data.logicalEdgeId;
    const current = reroutesByEdge.get(edgeId) ?? [];
    current.push(node);
    reroutesByEdge.set(edgeId, current);
  });

  if (!reroutesByEdge.size) {
    return nodes;
  }

  const nextOrderByNodeId = new Map<string, number>();
  reroutesByEdge.forEach((reroutes) => {
    reroutes
      .slice()
      .sort((left, right) => left.data.order - right.data.order || left.id.localeCompare(right.id))
      .forEach((node, index) => {
        nextOrderByNodeId.set(node.id, index);
      });
  });

  return nodes.map((node) => {
    if (!isRerouteCanvasNode(node)) {
      return node;
    }

    const nextOrder = nextOrderByNodeId.get(node.id);
    if (nextOrder === undefined || nextOrder === node.data.order) {
      return node;
    }

    return {
      ...node,
      data: {
        ...node.data,
        order: nextOrder,
      },
    };
  });
}

function persistGraphLayout(
  nodes: GraphCanvasNode[],
  groups: StoredGraphGroup[],
): StoredGraphLayout {
  const semanticNodes = nodes.filter(isSemanticCanvasNode);
  const rerouteNodes = normalizeRerouteNodeOrders(nodes).filter(isRerouteCanvasNode);

  return {
    nodes: Object.fromEntries(
      semanticNodes.map((node) => [
        graphLayoutNodeKey(node.id, node.data.kind),
        {
          x: node.position.x,
          y: node.position.y,
        },
      ]),
    ),
    reroutes: rerouteNodes
      .map((node) => ({
        id: rerouteStorageId(node.id),
        edgeId: node.data.logicalEdgeId,
        order: node.data.order,
        x: node.position.x,
        y: node.position.y,
      }))
      .sort(
        (left, right) =>
          left.edgeId.localeCompare(right.edgeId) ||
          left.order - right.order ||
          left.id.localeCompare(right.id),
      ),
    pinnedNodeIds: semanticNodes
      .filter((node) => node.data.isPinned)
      .map((node) => node.id)
      .sort((left, right) => left.localeCompare(right)),
    groups: groups
      .map((group) => ({
        id: group.id,
        title: normalizeGroupTitle(group.title),
        memberNodeIds: sortNodeIds(group.memberNodeIds),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function storedLayoutsEqual(left: StoredGraphLayout, right: StoredGraphLayout) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function applyStoredLayout(nodes: GraphCanvasNode[], layout: StoredGraphLayout) {
  const reroutesById = new Map(
    layout.reroutes.map((reroute) => [rerouteNodeId(reroute.id), reroute] as const),
  );
  const pinnedNodeIds = new Set(layout.pinnedNodeIds ?? []);

  return nodes.map((node) => {
    if (isRerouteCanvasNode(node)) {
      const nextReroute = reroutesById.get(node.id);
      if (!nextReroute) {
        return node;
      }
      return {
        ...node,
        position: {
          x: nextReroute.x,
          y: nextReroute.y,
        },
        data: {
          ...node.data,
          order: nextReroute.order,
        },
      };
    }

    const nextPosition = layout.nodes[graphLayoutNodeKey(node.id, node.data.kind)];
    return {
      ...node,
      position: nextPosition ?? node.position,
      data: {
        ...node.data,
        isPinned: pinnedNodeIds.has(node.id),
        actions: (node.data.actions ?? []).map((action) =>
          action.id === "pin"
            ? {
                ...action,
                label: pinnedNodeIds.has(node.id) ? "Unpin" : "Pin",
                helpId: pinActionHelpId(pinnedNodeIds.has(node.id)),
              }
            : action,
        ),
      },
    };
  });
}

function readMeasuredDimension(node: GraphCanvasNode, key: "width" | "height") {
  const directValue = Reflect.get(node, key);
  if (typeof directValue === "number" && directValue > 0) {
    return directValue;
  }

  const measured = Reflect.get(node, "measured");
  if (measured && typeof measured === "object") {
    const measuredValue = Reflect.get(measured, key);
    if (typeof measuredValue === "number" && measuredValue > 0) {
      return measuredValue;
    }
  }

  if (isRerouteCanvasNode(node)) {
    return REROUTE_NODE_SIZE;
  }

  return undefined;
}

function semanticNodeDimension(node: SemanticCanvasNode, key: "width" | "height") {
  return (
    readMeasuredDimension(node, key) ??
    (key === "width" ? FALLBACK_GROUP_NODE_WIDTH : FALLBACK_GROUP_NODE_HEIGHT)
  );
}

function buildGraphGroupBounds(
  group: StoredGraphGroup,
  nodesById: Map<string, GraphCanvasNode>,
): GraphGroupBounds | undefined {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  group.memberNodeIds.forEach((memberNodeId) => {
    const node = nodesById.get(memberNodeId);
    if (!node || !isSemanticCanvasNode(node)) {
      return;
    }

    const width = semanticNodeDimension(node, "width");
    const height = semanticNodeDimension(node, "height");
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + width);
    maxY = Math.max(maxY, node.position.y + height);
  });

  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(maxY)
  ) {
    return undefined;
  }

  return {
    ...group,
    x: minX - GROUP_BOX_PADDING,
    y: minY - GROUP_BOX_PADDING,
    width: maxX - minX + GROUP_BOX_PADDING * 2,
    height: maxY - minY + GROUP_BOX_PADDING * 2,
  };
}

function buildGraphGroupBoundsList(groups: StoredGraphGroup[], nodes: GraphCanvasNode[]) {
  const nodesById = new Map(nodes.map((node) => [node.id, node] as const));
  return groups.flatMap((group) => {
    const bounds = buildGraphGroupBounds(group, nodesById);
    return bounds ? [bounds] : [];
  });
}

function organizeOptionsForGroup(group: StoredGraphGroup, nodes: GraphCanvasNode[]) {
  const kinds = new Set(
    nodes
      .filter((node) => isSemanticCanvasNode(node) && group.memberNodeIds.includes(node.id))
      .map((node) => node.data.kind),
  );

  return GROUP_ORGANIZE_OPTIONS.filter((option) => option.mode !== "kind" || kinds.size > 1);
}

export function applyMemberNodeDelta(
  nodes: GraphCanvasNode[],
  memberNodeIds: Iterable<string>,
  delta: { x: number; y: number },
  basePositions?: Map<string, { x: number; y: number }>,
) {
  if (!delta.x && !delta.y) {
    return nodes;
  }

  const targetNodeIds = new Set(memberNodeIds);
  return nodes.map((node) => {
    if (!isSemanticCanvasNode(node) || !targetNodeIds.has(node.id)) {
      return node;
    }

    const basePosition = basePositions?.get(node.id) ?? node.position;
    return {
      ...node,
      position: {
        x: basePosition.x + delta.x,
        y: basePosition.y + delta.y,
      },
    };
  });
}

export function applyGroupedPositionChanges(
  currentNodes: GraphCanvasNode[],
  changes: NodeChange<GraphCanvasNode>[],
  groupByNodeId: Map<string, string>,
  _memberNodeIdsByGroupId: Map<string, string[]>,
) {
  const nextNodes = applyNodeChanges(changes, currentNodes);
  const currentNodesById = new Map(currentNodes.map((node) => [node.id, node] as const));
  const groupDeltaByGroupId = new Map<string, { x: number; y: number }>();

  changes.forEach((change) => {
    if (change.type !== "position" || !change.position) {
      return;
    }

    const groupId = groupByNodeId.get(change.id);
    const currentNode = currentNodesById.get(change.id);
    if (!groupId || !currentNode || !isSemanticCanvasNode(currentNode)) {
      return;
    }

    if (!groupDeltaByGroupId.has(groupId)) {
      groupDeltaByGroupId.set(groupId, {
        x: change.position.x - currentNode.position.x,
        y: change.position.y - currentNode.position.y,
      });
    }
  });

  if (!groupDeltaByGroupId.size) {
    return nextNodes;
  }

  return nextNodes.map((node) => {
    if (!isSemanticCanvasNode(node)) {
      return node;
    }

    const groupId = groupByNodeId.get(node.id);
    const delta = groupId ? groupDeltaByGroupId.get(groupId) : undefined;
    const currentNode = currentNodesById.get(node.id);
    if (!delta || !currentNode || !isSemanticCanvasNode(currentNode)) {
      return node;
    }

    return {
      ...node,
      position: {
        x: currentNode.position.x + delta.x,
        y: currentNode.position.y + delta.y,
      },
    };
  });
}

export function applyGroupedLayoutPositions(
  nodes: GraphCanvasNode[],
  nextPositions: Record<string, { x: number; y: number }>,
  memberNodeIdsByGroupId: Map<string, string[]>,
  groupByNodeId: Map<string, string>,
) {
  const groupDeltaByGroupId = new Map<string, { x: number; y: number }>();

  memberNodeIdsByGroupId.forEach((memberNodeIds, groupId) => {
    const anchorNodeId = memberNodeIds.find((memberNodeId) => nextPositions[memberNodeId]);
    if (!anchorNodeId) {
      return;
    }

    const anchorNode = nodes.find((node) => node.id === anchorNodeId);
    const nextAnchorPosition = nextPositions[anchorNodeId];
    if (!anchorNode || !nextAnchorPosition) {
      return;
    }

    groupDeltaByGroupId.set(groupId, {
      x: nextAnchorPosition.x - anchorNode.position.x,
      y: nextAnchorPosition.y - anchorNode.position.y,
    });
  });

  return nodes.map((node) => {
    if (!isSemanticCanvasNode(node)) {
      return node;
    }

    const groupId = groupByNodeId.get(node.id);
    const delta = groupId ? groupDeltaByGroupId.get(groupId) : undefined;
    if (delta) {
      return {
        ...node,
        position: {
          x: node.position.x + delta.x,
          y: node.position.y + delta.y,
        },
      };
    }

    const nextPosition = nextPositions[node.id];
    if (!nextPosition) {
      return node;
    }

    return {
      ...node,
      position: nextPosition,
    };
  });
}

function toDeclutterNodes(nodes: GraphCanvasNode[]) {
  return nodes.filter(isSemanticCanvasNode).map((node) => ({
    id: node.id,
    kind: node.data.kind,
    x: node.position.x,
    y: node.position.y,
    width: readMeasuredDimension(node, "width"),
    height: readMeasuredDimension(node, "height"),
  }));
}

function toFlowLayoutNodes(nodes: GraphCanvasNode[], graph: GraphView) {
  const metadataByNodeId = new Map(graph.nodes.map((node) => [node.id, node.metadata] as const));
  return nodes.filter(isSemanticCanvasNode).map((node) => ({
    id: node.id,
    kind: node.data.kind,
    x: node.position.x,
    y: node.position.y,
    width: readMeasuredDimension(node, "width"),
    height: readMeasuredDimension(node, "height"),
    metadata: metadataByNodeId.get(node.id) ?? {},
  }));
}

function semanticPinnedNodeIds(nodes: GraphCanvasNode[]) {
  return nodes
    .filter(isSemanticCanvasNode)
    .filter((node) => node.data.isPinned)
    .map((node) => node.id);
}

function storedLayoutIsEmpty(layout: StoredGraphLayout) {
  return (
    !Object.keys(layout.nodes).length &&
    !layout.reroutes.length &&
    !(layout.pinnedNodeIds?.length ?? 0) &&
    !(layout.groups?.length ?? 0)
  );
}

function pinActionHelpId(pinned: boolean): HelpDescriptorId {
  return pinned ? "graph.node.action.unpin" : "graph.node.action.pin";
}

export function mergeGroupsForSelection(
  groups: StoredGraphGroup[],
  selectedNodeIds: string[],
  createId: () => string = createGroupId,
): MergeGroupsForSelectionResult {
  const normalizedSelectedNodeIds = sortNodeIds(new Set(selectedNodeIds));
  if (normalizedSelectedNodeIds.length < 2) {
    return {
      changed: false,
      nextGroups: groups,
    };
  }

  const { groupByNodeId, memberNodeIdsByGroupId } = buildGroupMembership(groups);
  const touchedGroupIds = touchedGroupIdsForNodeIds(normalizedSelectedNodeIds, groupByNodeId);
  if (
    touchedGroupIds.length === 1 &&
    sameNodeIds(
      sortNodeIds(memberNodeIdsByGroupId.get(touchedGroupIds[0] ?? "") ?? []),
      normalizedSelectedNodeIds,
    )
  ) {
    return {
      changed: false,
      nextGroups: groups,
    };
  }

  const nextGroupId = createId();
  return {
    changed: true,
    nextGroupId,
    nextGroups: [
      ...groups.filter((group) => !touchedGroupIds.includes(group.id)),
      {
        id: nextGroupId,
        title: DEFAULT_GROUP_TITLE,
        memberNodeIds: expandGroupedNodeIds(
          normalizedSelectedNodeIds,
          groupByNodeId,
          memberNodeIdsByGroupId,
        ),
      },
    ],
  };
}

export function ungroupGroupsForSelection(
  groups: StoredGraphGroup[],
  selectedNodeIds: string[],
  selectedGroupId?: string,
): UngroupGroupsForSelectionResult {
  const { groupByNodeId } = buildGroupMembership(groups);
  const removedGroupIds = selectedGroupId
    ? [selectedGroupId]
    : touchedGroupIdsForNodeIds(selectedNodeIds, groupByNodeId);

  if (!removedGroupIds.length) {
    return {
      changed: false,
      nextGroups: groups,
      removedGroupIds: [],
    };
  }

  return {
    changed: true,
    nextGroups: groups.filter((group) => !removedGroupIds.includes(group.id)),
    removedGroupIds,
  };
}

export function renameGraphGroup(groups: StoredGraphGroup[], groupId: string, title: string) {
  return groups.map((group) =>
    group.id === groupId
      ? {
          ...group,
          title: normalizeGroupTitle(title),
        }
      : group,
  );
}

function isEditableEventTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const editableHost = target.closest(
    'input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"]',
  );
  return editableHost instanceof HTMLElement;
}

function shouldHandleRerouteDeleteKey(event: {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  target: EventTarget | null;
}) {
  return !(
    (event.key !== "Backspace" && event.key !== "Delete") ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    isEditableEventTarget(event.target)
  );
}

function shouldHandlePinKey(event: {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  target: EventTarget | null;
}) {
  return !(
    event.key.toLowerCase() !== "p" ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    isEditableEventTarget(event.target)
  );
}

function shouldHandleCreateModeKey(event: {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  target: EventTarget | null;
}) {
  return !(
    event.key.toLowerCase() !== "c" ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    isEditableEventTarget(event.target)
  );
}

function shouldHandleFitViewKey(event: {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  target: EventTarget | null;
}) {
  return !(
    event.key.toLowerCase() !== "f" ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    isEditableEventTarget(event.target)
  );
}

function shouldHandleGroupKey(event: {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  target: EventTarget | null;
}) {
  return !(
    event.key.toLowerCase() !== "g" ||
    event.altKey ||
    !(event.ctrlKey || event.metaKey) ||
    event.shiftKey ||
    isEditableEventTarget(event.target)
  );
}

function shouldHandleUngroupKey(event: {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  target: EventTarget | null;
}) {
  return !(
    event.key.toLowerCase() !== "g" ||
    event.altKey ||
    !(event.ctrlKey || event.metaKey) ||
    !event.shiftKey ||
    isEditableEventTarget(event.target)
  );
}

function nodeCenter(node: GraphCanvasNode) {
  const width = readMeasuredDimension(node, "width") ?? 0;
  const height = readMeasuredDimension(node, "height") ?? 0;
  return {
    x: node.position.x + width / 2,
    y: node.position.y + height / 2,
  };
}

function rerouteHandleId(
  type: "source" | "target",
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  const deltaX = to.x - from.x;
  const deltaY = to.y - from.y;
  if (Math.abs(deltaX) >= Math.abs(deltaY)) {
    return `${type}:${deltaX >= 0 ? "right" : "left"}`;
  }
  return `${type}:${deltaY >= 0 ? "bottom" : "top"}`;
}

function buildLogicalEdgeGroups(nodes: GraphCanvasNode[]) {
  const nodeLookup = new Map(nodes.map((node) => [node.id, node] as const));
  const reroutesByEdge = new Map<string, RerouteCanvasNode[]>();

  nodes.forEach((node) => {
    if (!isRerouteCanvasNode(node)) {
      return;
    }
    const edgeId = node.data.logicalEdgeId;
    const current = reroutesByEdge.get(edgeId) ?? [];
    current.push(node);
    reroutesByEdge.set(edgeId, current);
  });

  reroutesByEdge.forEach((reroutes, edgeId) => {
    reroutesByEdge.set(
      edgeId,
      reroutes
        .slice()
        .sort(
          (left, right) => left.data.order - right.data.order || left.id.localeCompare(right.id),
        ),
    );
  });

  return {
    nodeLookup,
    reroutesByEdge,
  };
}

function buildEdgeStroke(kind: GraphEdgeKind, highlighted: boolean) {
  if (kind === "contains") {
    return "color-mix(in srgb, var(--line-strong) 52%, transparent)";
  }
  if (kind === "data") {
    return "var(--accent-strong)";
  }
  if (kind === "controls") {
    return "color-mix(in srgb, #ffbf5a 72%, var(--line-strong) 28%)";
  }
  return highlighted ? "var(--accent-strong)" : "var(--line-strong)";
}

function estimateEdgeLabelWidth(label: string) {
  return Math.max(48, Math.round(label.trim().length * 7.2) + 22);
}

function inferLabelOffsetAxis(
  sourceHandle: string | null | undefined,
  targetHandle: string | null | undefined,
) {
  const handleSignature = `${sourceHandle ?? ""}|${targetHandle ?? ""}`;
  if (handleSignature.includes("top") || handleSignature.includes("bottom")) {
    return "y" as const;
  }
  return "x" as const;
}

function buildLabelLaneKey(
  source: string,
  target: string,
  sourceHandle: string | null | undefined,
  targetHandle: string | null | undefined,
) {
  return `${source}->${target}|${sourceHandle ?? ""}|${targetHandle ?? ""}`;
}

export function buildEdgeLabelOffsets(labelSegments: EdgeLabelSegment[]) {
  const offsets = new Map<string, { x: number; y: number }>();
  const groups = new Map<string, EdgeLabelSegment[]>();

  labelSegments.forEach((segment) => {
    const key = buildLabelLaneKey(
      segment.source,
      segment.target,
      segment.sourceHandle,
      segment.targetHandle,
    );
    const current = groups.get(key) ?? [];
    current.push(segment);
    groups.set(key, current);
  });

  groups.forEach((group) => {
    if (group.length <= 1) {
      return;
    }

    const axis = inferLabelOffsetAxis(group[0]?.sourceHandle, group[0]?.targetHandle);
    const ordered = group
      .slice()
      .sort(
        (left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id),
      );
    const gap = 12;
    const widths = ordered.map((segment) => estimateEdgeLabelWidth(segment.label));
    const totalWidth = widths.reduce((sum, width) => sum + width, 0) + gap * (ordered.length - 1);
    let cursor = -totalWidth / 2;

    ordered.forEach((segment, index) => {
      const width = widths[index] ?? 0;
      const centerOffset = cursor + width / 2;
      offsets.set(
        segment.id,
        axis === "x" ? { x: centerOffset, y: -10 } : { x: 14, y: centerOffset },
      );
      cursor += width + gap;
    });
  });

  return offsets;
}

export function collapseDuplicateEdgeLabels(labelSegments: EdgeLabelSegment[]) {
  const collapsedLabels = new Map<string, CollapsedEdgeLabel>();
  const visibleSegments: EdgeLabelSegment[] = [];
  const groups = new Map<string, EdgeLabelSegment[]>();

  labelSegments.forEach((segment) => {
    const normalizedLabel = segment.label.trim();
    const key = buildLabelLaneKey(
      segment.source,
      segment.target,
      segment.sourceHandle,
      segment.targetHandle,
    );
    const current = groups.get(key) ?? [];
    current.push({
      ...segment,
      label: normalizedLabel,
    });
    groups.set(key, current);
  });

  groups.forEach((group) => {
    const labelsByText = new Map<string, EdgeLabelSegment[]>();

    group.forEach((segment) => {
      const current = labelsByText.get(segment.label) ?? [];
      current.push(segment);
      labelsByText.set(segment.label, current);
    });

    labelsByText.forEach((matchingSegments) => {
      const ordered = matchingSegments
        .slice()
        .sort((left, right) => left.id.localeCompare(right.id));
      const anchor = ordered[0];

      if (!anchor) {
        return;
      }

      visibleSegments.push(anchor);
      collapsedLabels.set(anchor.id, {
        label: anchor.label,
        count: ordered.length > 1 ? ordered.length : undefined,
      });

      ordered.slice(1).forEach((segment) => {
        collapsedLabels.set(segment.id, {});
      });
    });
  });

  return {
    collapsedLabels,
    visibleSegments,
  };
}

function buildCanvasEdges({
  blueprint,
  graph,
  highlightedEdgeIds,
  hoverActive,
  nodes,
  onEdgeClick,
  onEdgeContextMenu,
  onEdgeHoverEnd,
  onEdgeHoverStart,
  onInsertReroute,
  selectedControlEdgeIds,
  selectedConnectedEdgeIds,
  selectionContextActive,
  showEdgeLabels,
  highlightGraphPath,
}: {
  blueprint: ReturnType<typeof buildBlueprintPresentation>;
  graph: GraphView;
  highlightedEdgeIds: Set<string>;
  hoverActive: boolean;
  nodes: GraphCanvasNode[];
  onEdgeClick: (
    logicalEdgeId: string,
    logicalEdgeKind: GraphEdgeKind,
    position: { x: number; y: number },
    clientPosition: { x: number; y: number },
    modifiers: { altKey: boolean },
    logicalEdgeLabel?: string,
  ) => void;
  onEdgeContextMenu: (
    logicalEdgeId: string,
    logicalEdgeKind: GraphEdgeKind,
    segmentIndex: number,
    position: { x: number; y: number },
    clientPosition: { x: number; y: number },
    logicalEdgeLabel?: string,
  ) => void;
  onEdgeHoverEnd: () => void;
  onEdgeHoverStart: (
    logicalEdgeId: string,
    logicalEdgeKind: GraphEdgeKind,
    logicalEdgeLabel?: string,
  ) => void;
  onInsertReroute: (
    logicalEdgeId: string,
    segmentIndex: number,
    position: { x: number; y: number },
  ) => void;
  selectedControlEdgeIds: Set<string>;
  selectedConnectedEdgeIds: Set<string>;
  selectionContextActive: boolean;
  showEdgeLabels: boolean;
  highlightGraphPath: boolean;
}): GraphCanvasEdge[] {
  const { nodeLookup, reroutesByEdge } = buildLogicalEdgeGroups(nodes);
  const segmentDrafts = graph.edges.flatMap<GraphCanvasEdge>((edge) => {
    const reroutes = reroutesByEdge.get(edge.id) ?? [];
    const handles = blueprint.edgeHandles.get(edge.id);
    const connected = selectedConnectedEdgeIds.has(edge.id);
    const explicitlySelected = selectedControlEdgeIds.has(edge.id);
    const edgeHovered = highlightedEdgeIds.has(edge.id);
    const selectionHighlighted = selectionContextActive && connected;
    const highlighted = hoverActive
      ? edgeHovered
      : explicitlySelected
        ? true
        : selectionContextActive
          ? selectionHighlighted
          : highlightGraphPath && connected;
    const dimmed = hoverActive
      ? !edgeHovered
      : selectedControlEdgeIds.size > 0
        ? !explicitlySelected
        : selectionContextActive
          ? !selectionHighlighted
          : false;
    const stroke = buildEdgeStroke(edge.kind, highlighted);
    const segmentCount = reroutes.length + 1;
    const labelSegmentIndex = Math.floor(segmentCount / 2);

    return Array.from({ length: segmentCount }, (_, segmentIndex) => {
      const previousReroute = reroutes[segmentIndex - 1];
      const nextReroute = reroutes[segmentIndex];
      const sourceNodeId = previousReroute ? previousReroute.id : edge.source;
      const targetNodeId = nextReroute ? nextReroute.id : edge.target;
      const sourceNode = nodeLookup.get(sourceNodeId);
      const targetNode = nodeLookup.get(targetNodeId);
      const sourceCenter = sourceNode ? nodeCenter(sourceNode) : { x: 0, y: 0 };
      const targetCenter = targetNode ? nodeCenter(targetNode) : { x: 0, y: 0 };
      const isLastSegment = segmentIndex === segmentCount - 1;
      const sourceHandle = previousReroute
        ? rerouteHandleId("source", sourceCenter, targetCenter)
        : handles?.sourceHandle;
      const targetHandle = nextReroute
        ? rerouteHandleId("target", targetCenter, sourceCenter)
        : handles?.targetHandle;
      const label =
        showEdgeLabels && segmentIndex === labelSegmentIndex && (!dimmed || highlighted)
          ? edge.label
          : undefined;

      return {
        id: `${edge.id}::segment:${segmentIndex}`,
        type: "blueprint" as const,
        source: sourceNodeId,
        target: targetNodeId,
        sourceHandle,
        targetHandle,
        data: {
          logicalEdgeId: edge.id,
          logicalEdgeKind: edge.kind,
          logicalEdgeLabel: edge.label,
          segmentIndex,
          onClick: onEdgeClick,
          onContextMenu: onEdgeContextMenu,
          onHoverStart: onEdgeHoverStart,
          onHoverEnd: onEdgeHoverEnd,
          onInsertReroute,
        },
        label,
        animated: highlighted && (edge.kind === "calls" || edge.kind === "controls"),
        style: {
          stroke,
          strokeWidth: highlighted
            ? 2.8
            : edge.kind === "data"
              ? 1.8
              : edge.kind === "contains"
                ? 1
                : 1.2,
          strokeDasharray:
            edge.kind === "data" ? "8 6" : edge.kind === "controls" ? "0" : undefined,
          opacity: dimmed ? 0.18 : highlighted ? 1 : selectionContextActive ? 0.92 : 0.84,
        },
        labelShowBg: false,
        labelBgPadding: [5, 9] as [number, number],
        labelBgBorderRadius: 999,
        labelBgStyle: {
          fill: "var(--surface-solid)",
          stroke: highlighted ? "var(--accent-strong)" : "var(--line-strong)",
          strokeWidth: 1,
          opacity: dimmed ? 0.2 : 0.92,
        },
        labelStyle: {
          fill: highlighted ? "var(--text)" : "var(--text-muted)",
          fontSize: 11,
          fontWeight: 600,
          opacity: dimmed ? 0.24 : 1,
        },
        markerEnd: isLastSegment
          ? {
              type: MarkerType.ArrowClosed,
              color: stroke,
            }
          : undefined,
        reconnectable: edge.id.startsWith("data:flowparam:") ? false : undefined,
      };
    });
  });

  const rawLabelSegments = segmentDrafts
    .filter((edge) => typeof edge.label === "string" && edge.label.trim().length > 0)
    .map((edge) => ({
      id: edge.id,
      label: edge.label as string,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
    }));
  const { collapsedLabels, visibleSegments } = collapseDuplicateEdgeLabels(rawLabelSegments);
  const labelOffsets = buildEdgeLabelOffsets(visibleSegments);

  return segmentDrafts.map<GraphCanvasEdge>((edge) => {
    const offset = labelOffsets.get(edge.id);
    const edgeData = edge.data as BlueprintEdgeData;
    const collapsedLabel = collapsedLabels.get(edge.id);
    return {
      ...edge,
      label: collapsedLabel ? collapsedLabel.label : edge.label,
      data: {
        logicalEdgeId: edgeData.logicalEdgeId,
        logicalEdgeKind: edgeData.logicalEdgeKind,
        logicalEdgeLabel: edgeData.logicalEdgeLabel,
        labelCount: collapsedLabel?.count,
        segmentIndex: edgeData.segmentIndex,
        onHoverStart: edgeData.onHoverStart,
        onHoverEnd: edgeData.onHoverEnd,
        onClick: edgeData.onClick,
        onContextMenu: edgeData.onContextMenu,
        onInsertReroute: edgeData.onInsertReroute,
        labelOffsetX: offset?.x ?? 0,
        labelOffsetY: offset?.y ?? 0,
      },
    };
  });
}

function GraphGroupLayer({
  groupBounds,
  nodes,
  selectedGroupId,
  editingGroupId,
  organizeGroupId,
  editingGroupTitle,
  onChangeEditingGroupTitle,
  onApplyOrganizeMode,
  onFinishGroupTitleEditing,
  onGroupMoveEnd,
  onPreviewGroupMove,
  onSelectGroup,
  onStartEditingGroup,
  onToggleOrganizeGroup,
  onUngroupGroup,
}: {
  groupBounds: GraphGroupBounds[];
  nodes: GraphCanvasNode[];
  selectedGroupId?: string;
  editingGroupId?: string;
  organizeGroupId?: string;
  editingGroupTitle: string;
  onChangeEditingGroupTitle: (title: string) => void;
  onApplyOrganizeMode: (groupId: string, mode: GroupOrganizeMode) => void;
  onFinishGroupTitleEditing: (groupId: string, mode: "save" | "cancel") => void;
  onGroupMoveEnd: () => void;
  onPreviewGroupMove: (
    groupId: string,
    delta: { x: number; y: number },
    basePositions: Map<string, { x: number; y: number }>,
  ) => void;
  onSelectGroup: (groupId: string) => void;
  onStartEditingGroup: (groupId: string) => void;
  onToggleOrganizeGroup: (groupId: string) => void;
  onUngroupGroup: (groupId: string, title: string) => void;
}) {
  const { screenToFlowPosition } = useReactFlow<GraphCanvasNode, GraphCanvasEdge>();
  const beginGroupInteraction = (
    event: {
      button: number;
      clientX: number;
      clientY: number;
      preventDefault: () => void;
      stopPropagation: () => void;
    },
    group: GraphGroupBounds,
  ) => {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    onSelectGroup(group.id);

    const startFlowPosition = screenToFlowPosition({
      x: event.clientX,
      y: event.clientY,
    });
    const memberNodeIds = new Set(group.memberNodeIds);
    const basePositions = new Map(
      nodes
        .filter((node) => isSemanticCanvasNode(node) && memberNodeIds.has(node.id))
        .map((node) => [node.id, { x: node.position.x, y: node.position.y }] as const),
    );
    let moved = false;

    const handleMove = (moveEvent: PointerEvent) => {
      const currentFlowPosition = screenToFlowPosition({
        x: moveEvent.clientX,
        y: moveEvent.clientY,
      });
      const delta = {
        x: currentFlowPosition.x - startFlowPosition.x,
        y: currentFlowPosition.y - startFlowPosition.y,
      };
      if (delta.x || delta.y) {
        moved = true;
      }
      onPreviewGroupMove(group.id, delta, basePositions);
    };

    const handleUp = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      if (moved) {
        onGroupMoveEnd();
      }
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  };

  return (
    <ViewportPortal>
      {groupBounds.map((group) => {
        const nodeCount = group.memberNodeIds.length;
        const nodeCountLabel = `${nodeCount} ${nodeCount === 1 ? "node" : "nodes"} grouped`;

        return (
          <div
            key={group.id}
            data-testid={`graph-group-${group.id}`}
            {...helpTargetProps("graph.group.box", {
              label: group.title,
            })}
            className={`graph-group${selectedGroupId === group.id ? " is-selected" : ""}${editingGroupId === group.id ? " is-editing" : ""}`}
            style={{
              transform: `translate(${group.x}px, ${group.y}px)`,
              width: `${group.width}px`,
              height: `${group.height}px`,
            }}
          >
            <div className="graph-group__frame" />
            <div
              data-testid={`graph-group-hit-area-${group.id}-top`}
              {...helpTargetProps("graph.group.box", {
                label: group.title,
              })}
              aria-hidden="true"
              className="graph-group__hit-area graph-group__hit-area--top"
              onPointerDown={(event) => {
                beginGroupInteraction(event, group);
              }}
            />
            <div
              data-testid={`graph-group-hit-area-${group.id}-right`}
              {...helpTargetProps("graph.group.box", {
                label: group.title,
              })}
              aria-hidden="true"
              className="graph-group__hit-area graph-group__hit-area--right"
              onPointerDown={(event) => {
                beginGroupInteraction(event, group);
              }}
            />
            <div
              data-testid={`graph-group-hit-area-${group.id}-bottom`}
              {...helpTargetProps("graph.group.box", {
                label: group.title,
              })}
              aria-hidden="true"
              className="graph-group__hit-area graph-group__hit-area--bottom"
              onPointerDown={(event) => {
                beginGroupInteraction(event, group);
              }}
            />
            <div
              data-testid={`graph-group-hit-area-${group.id}-left`}
              {...helpTargetProps("graph.group.box", {
                label: group.title,
              })}
              aria-hidden="true"
              className="graph-group__hit-area graph-group__hit-area--left"
              onPointerDown={(event) => {
                beginGroupInteraction(event, group);
              }}
            />
            <div
              {...helpTargetProps("graph.group.box", {
                label: group.title,
              })}
              className="graph-group__title-anchor"
              style={{
                transform: `translate(${GROUP_BOX_PADDING}px, calc(-100% - ${GROUP_TITLE_OFFSET}px))`,
              }}
              onPointerDown={(event) => {
                beginGroupInteraction(event, group);
              }}
            >
              {editingGroupId === group.id ? (
                <input
                  autoFocus
                  className="graph-group__title-input"
                  data-testid={`graph-group-title-input-${group.id}`}
                  value={editingGroupTitle}
                  onBlur={() => onFinishGroupTitleEditing(group.id, "save")}
                  onChange={(event) => onChangeEditingGroupTitle(event.target.value)}
                  onFocus={(event) => {
                    event.currentTarget.select();
                  }}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === "Enter") {
                      event.preventDefault();
                      onFinishGroupTitleEditing(group.id, "save");
                      return;
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      onFinishGroupTitleEditing(group.id, "cancel");
                    }
                  }}
                  onPointerDown={(event) => {
                    event.stopPropagation();
                  }}
                />
              ) : (
                <div className="graph-group__header">
                  <div className="graph-group__title-row">
                    <div
                      className="graph-group__title"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onStartEditingGroup(group.id);
                      }}
                      onDoubleClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onStartEditingGroup(group.id);
                      }}
                      onPointerDown={(event) => {
                        event.stopPropagation();
                      }}
                    >
                      {group.title}
                    </div>
                    <div
                      aria-label={nodeCountLabel}
                      className="graph-group__count"
                      title={nodeCountLabel}
                    >
                      {nodeCount}
                    </div>
                    <div className="graph-group__actions">
                      <button
                        {...helpTargetProps("graph.group.organize")}
                        className={`graph-group__action${organizeGroupId === group.id ? " is-active" : ""}`}
                        type="button"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          onToggleOrganizeGroup(group.id);
                        }}
                        onPointerDown={(event) => {
                          event.stopPropagation();
                        }}
                      >
                        Organize
                      </button>
                      <button
                        className="graph-group__action graph-group__action--ungroup"
                        type="button"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          onUngroupGroup(group.id, group.title);
                        }}
                        onPointerDown={(event) => {
                          event.stopPropagation();
                        }}
                      >
                        Ungroup
                      </button>
                    </div>
                  </div>
                  {organizeGroupId === group.id ? (
                    <div
                      className="graph-group__organize-row"
                      data-testid={`graph-group-organize-${group.id}`}
                      onPointerDown={(event) => {
                        event.stopPropagation();
                      }}
                    >
                      {organizeOptionsForGroup(group, nodes).map((option) => (
                        <button
                          key={option.mode}
                          {...helpTargetProps("graph.group.organize", {
                            label: option.label,
                          })}
                          className="graph-group__mode"
                          data-testid={`graph-group-organize-${group.id}-${option.mode}`}
                          type="button"
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            onApplyOrganizeMode(group.id, option.mode);
                          }}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </ViewportPortal>
  );
}

export function GraphCanvas({
  repoPath,
  graph,
  isLoading = false,
  errorMessage,
  activeNodeId,
  graphFilters,
  graphSettings,
  flowInputDisplayMode = "param_nodes",
  highlightGraphPath,
  showEdgeLabels,
  onSelectNode,
  onActivateNode,
  onInspectNode,
  onOpenNodeInDefaultEditor,
  onRevealNodeInFileExplorer,
  onSelectBreadcrumb: _onSelectBreadcrumb,
  onSelectLevel,
  onToggleGraphFilter,
  onToggleGraphSetting,
  onSetFlowInputDisplayMode = () => {},
  onToggleGraphPathHighlight,
  onToggleEdgeLabels,
  onClearSelection,
  createModeState = "inactive",
  createModeCanvasEnabled = false,
  createModeHint,
  onToggleCreateMode = () => {},
  onCreateIntent = () => {},
  onEditFlowNodeIntent = () => {},
  onOpenExpressionGraphIntent = noopExpressionGraphIntent,
  onConnectFlowEdge = () => {},
  onReconnectFlowEdge = () => {},
  onDisconnectFlowEdge = () => {},
  onDeleteFlowSelection = () => {},
  onDeleteSymbolNode = () => {},
}: {
  repoPath?: string;
  graph?: GraphView;
  isLoading?: boolean;
  errorMessage?: string | null;
  activeNodeId?: string;
  graphFilters: GraphFilters;
  graphSettings: GraphSettings;
  flowInputDisplayMode?: FlowInputDisplayMode;
  highlightGraphPath: boolean;
  showEdgeLabels: boolean;
  onSelectNode: (nodeId: string, kind: GraphNodeKind) => void;
  onActivateNode: (nodeId: string, kind: GraphNodeKind) => void;
  onInspectNode: (nodeId: string, kind: GraphNodeKind) => void;
  onOpenNodeInDefaultEditor?: (nodeId: string) => void | Promise<void>;
  onRevealNodeInFileExplorer?: (nodeId: string) => void | Promise<void>;
  onSelectBreadcrumb: (breadcrumb: GraphBreadcrumbDto) => void;
  onSelectLevel: (level: GraphAbstractionLevel) => void;
  onToggleGraphFilter: (key: keyof GraphFilters) => void;
  onToggleGraphSetting: (key: keyof GraphSettings) => void;
  onSetFlowInputDisplayMode?: (mode: FlowInputDisplayMode) => void;
  onToggleGraphPathHighlight: () => void;
  onToggleEdgeLabels: () => void;
  onNavigateOut: () => void;
  onClearSelection: () => void;
  createModeState?: CreateModeState;
  createModeCanvasEnabled?: boolean;
  createModeHint?: string;
  onToggleCreateMode?: () => void;
  onCreateIntent?: (intent: GraphCreateIntent) => void;
  onEditFlowNodeIntent?: (intent: GraphFlowEditIntent) => void;
  onOpenExpressionGraphIntent?: (intent: GraphExpressionGraphIntent) => void;
  onConnectFlowEdge?: (connection: GraphFlowConnectionIntent) => void;
  onReconnectFlowEdge?: (edgeId: string, connection: GraphFlowConnectionIntent) => void;
  onDisconnectFlowEdge?: (edgeId: string) => void;
  onDeleteFlowSelection?: (selection: GraphFlowDeleteIntent) => void;
  onDeleteSymbolNode?: (nodeId: string) => void;
}) {
  const { setTransientHelpTarget } = useWorkspaceHelp();
  const blueprint = useMemo(() => (graph ? buildBlueprintPresentation(graph) : undefined), [graph]);
  const denseGraph = (graph?.nodes.length ?? 0) > 12;
  const fitViewOptions = useMemo(
    () =>
      !graph
        ? undefined
        : graph.level === "flow"
          ? { padding: 0.1, minZoom: 0.4, maxZoom: 1.08 }
          : graph.level === "symbol"
            ? { padding: 0.08, minZoom: denseGraph ? 0.34 : 0.44, maxZoom: 1.2 }
            : { padding: 0.08, minZoom: denseGraph ? 0.3 : 0.4, maxZoom: 1.14 },
    [denseGraph, graph],
  );
  const graphNodeIds = useMemo(() => new Set(graph?.nodes.map((node) => node.id) ?? []), [graph]);
  const graphNodeById = useMemo(
    () => new Map(graph?.nodes.map((node) => [node.id, node] as const) ?? []),
    [graph],
  );
  const viewKey = graph ? graphLayoutViewKey(graph) : undefined;
  const hydrationGenerationRef = useRef(0);
  const panelRef = useRef<HTMLElement>(null);
  const reactFlowInstanceRef = useRef<ReactFlowInstance<GraphCanvasNode, GraphCanvasEdge> | null>(
    null,
  );
  const graphHotkeyActiveRef = useRef(false);
  const skipNextSelectionSyncRef = useRef(false);
  const shiftPressedRef = useRef(false);
  const pendingLayoutUndoRef = useRef<LayoutUndoStackEntry | undefined>(undefined);
  const createModeActive = createModeState !== "inactive";
  const createModeReady = createModeState === "active";
  const [nodes, setNodes] = useState<GraphCanvasNode[]>([]);
  const nodesRef = useRef<GraphCanvasNode[]>([]);
  const [groups, setGroups] = useState<StoredGraphGroup[]>([]);
  const [selectedSemanticNodeIds, setSelectedSemanticNodeIds] = useState<string[]>([]);
  const [selectedControlEdgeIds, setSelectedControlEdgeIds] = useState<string[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string | undefined>(undefined);
  const [editingGroupId, setEditingGroupId] = useState<string | undefined>(undefined);
  const [organizeGroupId, setOrganizeGroupId] = useState<string | undefined>(undefined);
  const [editingGroupTitle, setEditingGroupTitle] = useState(DEFAULT_GROUP_TITLE);
  const [marqueeSelectionActive, setMarqueeSelectionActive] = useState(false);
  const [layoutUndoStacks, setLayoutUndoStacks] = useState<Record<string, LayoutUndoStackEntry[]>>(
    {},
  );
  const [layoutRedoStacks, setLayoutRedoStacks] = useState<Record<string, LayoutUndoStackEntry[]>>(
    {},
  );
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | undefined>(undefined);
  const [hoveredPortEdgeIds, setHoveredPortEdgeIds] = useState<string[]>([]);
  const [contextMenu, setContextMenu] = useState<GraphContextMenuState | null>(null);
  const [contextActionError, setContextActionError] = useState<string | null>(null);
  const setLastActivity = useUiStore((state) => state.setLastActivity);
  const panModeActive = useKeyPress("Space");
  const [pointerInsidePanel, setPointerInsidePanel] = useState(false);
  const [panPointerDragging, setPanPointerDragging] = useState(false);
  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);
  const selectedRerouteNodes = useMemo(
    () => nodes.filter((node) => isRerouteCanvasNode(node) && Boolean(node.selected)),
    [nodes],
  );
  const selectedRerouteCount = selectedRerouteNodes.length;
  const selectedControlEdgeIdSet = useMemo(
    () => new Set(selectedControlEdgeIds),
    [selectedControlEdgeIds],
  );
  const flowAuthoringEnabled =
    graph?.level === "flow" &&
    graph.flowState?.editable === true &&
    Boolean(graph.flowState?.document);
  const authorableFlowNodeIds = useMemo(
    () =>
      new Set(
        (graph?.flowState?.document?.nodes ?? [])
          .filter((node) => isFlowNodeAuthorableKind(node.kind))
          .map((node) => node.id),
      ),
    [graph?.flowState?.document],
  );
  const deletableVisualFlowNodeIds = useMemo(
    () =>
      new Set(
        graph?.level === "flow"
          ? (graph.nodes ?? []).filter(isVisualFunctionInputNode).map((node) => node.id)
          : [],
      ),
    [graph],
  );
  const { groupByNodeId, memberNodeIdsByGroupId } = useMemo(
    () => buildGroupMembership(groups),
    [groups],
  );
  const groupedNodeIds = useMemo(() => new Set(sortNodeIds(groupByNodeId.keys())), [groupByNodeId]);
  const semanticSelection = useMemo(
    () => sortNodeIds(selectedSemanticNodeIds.filter((nodeId) => graphNodeIds.has(nodeId))),
    [graphNodeIds, selectedSemanticNodeIds],
  );
  const currentLayoutUndoStack = useMemo(
    () => (viewKey ? (layoutUndoStacks[viewKey] ?? []) : []),
    [layoutUndoStacks, viewKey],
  );
  const currentLayoutRedoStack = useMemo(
    () => (viewKey ? (layoutRedoStacks[viewKey] ?? []) : []),
    [layoutRedoStacks, viewKey],
  );
  const semanticSelectionFromNodes = useMemo(
    () =>
      sortNodeIds(
        nodes
          .filter((node) => isSemanticCanvasNode(node) && Boolean(node.selected))
          .map((node) => node.id),
      ),
    [nodes],
  );
  const effectiveSemanticSelection = semanticSelection.length
    ? semanticSelection
    : semanticSelectionFromNodes;
  const effectiveSemanticSelectionKey = effectiveSemanticSelection.join("\0");
  const selectedGroupMemberNodeIds = useMemo(
    () => new Set(selectedGroupId ? (memberNodeIdsByGroupId.get(selectedGroupId) ?? []) : []),
    [memberNodeIdsByGroupId, selectedGroupId],
  );
  const selectionPreviewNodeIds = useMemo(
    () =>
      !graph
        ? []
        : resolveSelectionPreviewNodeIds({
            activeNodeId,
            effectiveSemanticSelection,
            graphNodeIds,
            marqueeSelectionActive,
            selectedGroupId,
            selectedRerouteCount,
          }),
    [
      activeNodeId,
      effectiveSemanticSelectionKey,
      graph,
      graphNodeIds,
      marqueeSelectionActive,
      selectedGroupId,
      selectedRerouteCount,
    ],
  );
  const selectionPreviewNodeIdsKey = selectionPreviewNodeIds.join("\0");
  const selectedPreviewNodeIds = useMemo(
    () => new Set(selectionPreviewNodeIds),
    [selectionPreviewNodeIdsKey],
  );
  const selectedNodeId = !graph
    ? ""
    : resolveSelectionPreviewNodeId({
        activeNodeId,
        effectiveSemanticSelection,
        graphNodeIds,
        marqueeSelectionActive,
        selectedGroupId,
        selectedRerouteCount,
      });
  const highlightedEdgeIds = useMemo(
    () =>
      new Set(
        hoveredPortEdgeIds.length ? hoveredPortEdgeIds : hoveredEdgeId ? [hoveredEdgeId] : [],
      ),
    [hoveredEdgeId, hoveredPortEdgeIds],
  );
  const hoverActive = highlightedEdgeIds.size > 0;
  const selectedConnectedEdgeIds = useMemo(
    () =>
      new Set(
        (graph?.edges ?? [])
          .filter(
            (edge) =>
              selectedPreviewNodeIds.has(edge.source) || selectedPreviewNodeIds.has(edge.target),
          )
          .map((edge) => edge.id),
      ),
    [graph?.edges, selectedPreviewNodeIds],
  );
  const selectedRelatedNodeIds = useMemo(() => {
    const related = new Set<string>();
    if (!selectionPreviewNodeIds.length) {
      return related;
    }

    selectionPreviewNodeIds.forEach((nodeId) => {
      related.add(nodeId);
    });
    (graph?.edges ?? []).forEach((edge) => {
      if (selectedPreviewNodeIds.has(edge.source) || selectedPreviewNodeIds.has(edge.target)) {
        related.add(edge.source);
        related.add(edge.target);
      }
    });
    return related;
  }, [graph?.edges, selectionPreviewNodeIdsKey, selectedPreviewNodeIds]);
  const selectionContextActive = selectionPreviewNodeIds.length > 0;
  const canPinNodes = graph?.level === "flow";
  const selectedDeletableFlowNodeIds = useMemo(
    () =>
      effectiveSemanticSelection.filter(
        (nodeId) => authorableFlowNodeIds.has(nodeId) || deletableVisualFlowNodeIds.has(nodeId),
      ),
    [authorableFlowNodeIds, deletableVisualFlowNodeIds, effectiveSemanticSelection],
  );
  const selectedDeletableSymbolNodeId = useMemo(() => {
    if (!graph || !selectedNodeId) {
      return undefined;
    }
    const selectedNode = graph.nodes.find((node) => node.id === selectedNodeId);
    if (!selectedNode || !isGraphSymbolNodeKind(selectedNode.kind)) {
      return undefined;
    }
    const deleteAction = selectedNode.availableActions.find(
      (action) => action.actionId === "delete_symbol",
    );
    return deleteAction?.enabled ? selectedNode.id : undefined;
  }, [graph, selectedNodeId]);

  const clearLocalSelection = () => {
    setSelectedSemanticNodeIds([]);
    setSelectedControlEdgeIds([]);
    setSelectedGroupId(undefined);
    setOrganizeGroupId(undefined);
    setNodes((current) =>
      current.some((node) => node.selected)
        ? current.map((node) => (node.selected ? { ...node, selected: false } : node))
        : current,
    );
  };

  const requestCreateIntent = (
    clientPosition: { x: number; y: number },
    flowPosition: { x: number; y: number },
  ) => {
    const panelBounds = panelRef.current?.getBoundingClientRect();
    onCreateIntent({
      flowPosition,
      panelPosition: {
        x: panelBounds ? clientPosition.x - panelBounds.left : clientPosition.x,
        y: panelBounds ? clientPosition.y - panelBounds.top : clientPosition.y,
      },
    });
  };

  const screenToFlowPosition = useCallback(
    (clientPosition: { x: number; y: number }) =>
      reactFlowInstanceRef.current?.screenToFlowPosition(clientPosition) ?? {
        x: clientPosition.x,
        y: clientPosition.y,
      },
    [],
  );
  const requestExpressionGraphIntent = useCallback(
    (nodeId: string, expressionNodeId?: string, clientPosition?: { x: number; y: number }) => {
      const panelBounds = panelRef.current?.getBoundingClientRect();
      const canvasNode = nodesRef.current.find((node) => node.id === nodeId);
      const fallbackFlowPosition = canvasNode
        ? { x: canvasNode.position.x + 220, y: canvasNode.position.y + 48 }
        : { x: 0, y: 0 };
      const projectedPosition =
        clientPosition ??
        (canvasNode && reactFlowInstanceRef.current?.flowToScreenPosition
          ? reactFlowInstanceRef.current.flowToScreenPosition(fallbackFlowPosition)
          : undefined);
      onOpenExpressionGraphIntent({
        nodeId,
        expressionNodeId,
        flowPosition: projectedPosition
          ? screenToFlowPosition(projectedPosition)
          : fallbackFlowPosition,
        panelPosition: {
          x:
            projectedPosition && panelBounds
              ? projectedPosition.x - panelBounds.left
              : (projectedPosition?.x ?? 24),
          y:
            projectedPosition && panelBounds
              ? projectedPosition.y - panelBounds.top
              : (projectedPosition?.y ?? 24),
        },
      });
    },
    [onOpenExpressionGraphIntent, screenToFlowPosition],
  );
  const selectControlEdge = useCallback(
    (edgeId: string) => {
      setSelectedControlEdgeIds([edgeId]);
      setSelectedGroupId(undefined);
      setOrganizeGroupId(undefined);
      setSelectedSemanticNodeIds([]);
      setNodes((current) =>
        current.some((node) => node.selected)
          ? current.map((node) => (node.selected ? { ...node, selected: false } : node))
          : current,
      );
      onClearSelection();
    },
    [onClearSelection],
  );

  const closeContextMenu = useCallback(
    (restoreFocus = false) => {
      const focusElement = contextMenu?.focusElement;
      setContextMenu(null);
      if (restoreFocus) {
        window.requestAnimationFrame(() => {
          focusElement?.focus();
          panelRef.current?.focus();
        });
      }
    },
    [contextMenu?.focusElement],
  );

  const openPaneContextMenu = useCallback(
    (event: ReactMouseEvent<Element> | MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const position = clampAppContextMenuPosition(event.clientX, event.clientY);
      setContextActionError(null);
      setContextMenu({
        kind: "pane",
        ...position,
        flowPosition: screenToFlowPosition({ x: event.clientX, y: event.clientY }),
        focusElement: panelRef.current,
      });
    },
    [screenToFlowPosition],
  );

  const openEdgeContextMenu = useCallback(
    (
      edgeId: string,
      edgeKind: GraphEdgeKind,
      segmentIndex: number,
      flowPosition: { x: number; y: number },
      clientPosition: { x: number; y: number },
      edgeLabel?: string,
    ) => {
      const position = clampAppContextMenuPosition(clientPosition.x, clientPosition.y);
      setContextActionError(null);
      setContextMenu({
        kind: "edge",
        edgeId,
        edgeKind,
        edgeLabel,
        segmentIndex,
        flowPosition,
        ...position,
        focusElement: panelRef.current,
      });
    },
    [],
  );

  const openNodeContextMenu = useCallback(
    (event: ReactMouseEvent<Element>, node: GraphCanvasNode) => {
      event.preventDefault();
      event.stopPropagation();
      const position = clampAppContextMenuPosition(event.clientX, event.clientY);
      setContextActionError(null);

      if (isRerouteCanvasNode(node)) {
        setSelectedControlEdgeIds([]);
        setSelectedGroupId(undefined);
        setOrganizeGroupId(undefined);
        setSelectedSemanticNodeIds([]);
        setNodes((current) =>
          current.map((currentNode) => ({
            ...currentNode,
            selected: currentNode.id === node.id,
          })),
        );
        onClearSelection();
        setContextMenu({
          kind: "node",
          nodeId: node.id,
          ...position,
          focusElement: event.currentTarget as HTMLElement,
        });
        return;
      }

      if (!selectedSemanticNodeIds.includes(node.id)) {
        setSelectedControlEdgeIds([]);
        setSelectedGroupId(undefined);
        setOrganizeGroupId(undefined);
        setSelectedSemanticNodeIds([node.id]);
        setNodes((current) =>
          current.map((currentNode) => {
            if (isRerouteCanvasNode(currentNode)) {
              return currentNode.selected ? { ...currentNode, selected: false } : currentNode;
            }
            return {
              ...currentNode,
              selected: currentNode.id === node.id,
            };
          }),
        );
        onSelectNode(node.id, node.data.kind);
      }

      setContextMenu({
        kind: "node",
        nodeId: node.id,
        ...position,
        focusElement: event.currentTarget as HTMLElement,
      });
    },
    [onClearSelection, onSelectNode, selectedSemanticNodeIds],
  );
  const persistCurrentLayout = (
    nextNodes: GraphCanvasNode[],
    nextGroups: StoredGraphGroup[] = groups,
  ) => {
    void writeStoredGraphLayout(repoPath, viewKey, persistGraphLayout(nextNodes, nextGroups));
  };

  const pushLayoutUndoEntry = (
    summary: string,
    previousLayout: StoredGraphLayout,
    targetViewKey = viewKey,
  ) => {
    if (!targetViewKey) {
      return;
    }

    setLayoutUndoStacks((current) => ({
      ...current,
      [targetViewKey]: [
        ...(current[targetViewKey] ?? []),
        {
          viewKey: targetViewKey,
          layout: previousLayout,
          entry: {
            domain: "layout",
            summary,
            createdAt: Date.now(),
          },
        },
      ],
    }));
    setLayoutRedoStacks((current) => ({
      ...current,
      [targetViewKey]: [],
    }));
  };

  const capturePendingLayoutUndo = (summary: string) => {
    if (!viewKey || pendingLayoutUndoRef.current) {
      return;
    }

    pendingLayoutUndoRef.current = {
      viewKey,
      layout: persistGraphLayout(nodes, groups),
      entry: {
        domain: "layout",
        summary,
        createdAt: Date.now(),
      },
    };
  };

  const finalizePendingLayoutUndo = () => {
    const pendingUndo = pendingLayoutUndoRef.current;
    pendingLayoutUndoRef.current = undefined;
    if (!pendingUndo || pendingUndo.viewKey !== viewKey) {
      return;
    }

    const currentLayout = persistGraphLayout(nodes, groups);
    if (storedLayoutsEqual(pendingUndo.layout, currentLayout)) {
      return;
    }

    pushLayoutUndoEntry(pendingUndo.entry.summary, pendingUndo.layout, pendingUndo.viewKey);
  };

  const applyLayoutHistoryEntry = (
    layoutHistory: LayoutUndoStackEntry,
    direction: "undo" | "redo",
  ) => {
    const inverseLayout = persistGraphLayout(nodes, groups);
    const inverseEntry: LayoutUndoStackEntry = {
      viewKey: layoutHistory.viewKey,
      layout: inverseLayout,
      entry: {
        ...layoutHistory.entry,
        createdAt: Date.now(),
      },
    };

    hydrationGenerationRef.current += 1;
    setNodes((current) => applyStoredLayout(current, layoutHistory.layout));
    setGroups(layoutHistory.layout.groups ?? []);
    setOrganizeGroupId(undefined);
    setEditingGroupId(undefined);
    setEditingGroupTitle(DEFAULT_GROUP_TITLE);
    void writeStoredGraphLayout(repoPath, layoutHistory.viewKey, layoutHistory.layout);

    if (direction === "undo") {
      setLayoutUndoStacks((current) => ({
        ...current,
        [layoutHistory.viewKey]: (current[layoutHistory.viewKey] ?? []).slice(0, -1),
      }));
      setLayoutRedoStacks((current) => ({
        ...current,
        [layoutHistory.viewKey]: [...(current[layoutHistory.viewKey] ?? []), inverseEntry],
      }));
    } else {
      setLayoutRedoStacks((current) => ({
        ...current,
        [layoutHistory.viewKey]: (current[layoutHistory.viewKey] ?? []).slice(0, -1),
      }));
      setLayoutUndoStacks((current) => ({
        ...current,
        [layoutHistory.viewKey]: [...(current[layoutHistory.viewKey] ?? []), inverseEntry],
      }));
    }

    setLastActivity({
      domain: "layout",
      kind: direction,
      summary: `${direction === "undo" ? "Undid" : "Redid"} layout: ${layoutHistory.entry.summary}`,
    });
  };

  const persistCurrentCanvasState = () => {
    hydrationGenerationRef.current += 1;
    setNodes((current) => {
      persistCurrentLayout(current, groups);
      return current;
    });
  };

  const selectGroup = (groupId: string) => {
    setSelectedControlEdgeIds([]);
    setSelectedGroupId(groupId);
    setOrganizeGroupId((current) => (current === groupId ? current : undefined));
    setSelectedSemanticNodeIds([]);
    setNodes((current) =>
      current.some((node) => node.selected)
        ? current.map((node) => (node.selected ? { ...node, selected: false } : node))
        : current,
    );
  };

  const beginGroupTitleEditing = (groupId: string) => {
    const group = groups.find((candidate) => candidate.id === groupId);
    if (!group) {
      return;
    }
    selectGroup(groupId);
    setOrganizeGroupId(undefined);
    setEditingGroupId(groupId);
    setEditingGroupTitle(group.title);
  };

  const finishGroupTitleEditing = (groupId: string, mode: "save" | "cancel") => {
    if (editingGroupId !== groupId) {
      return;
    }

    if (mode === "cancel") {
      setEditingGroupId(undefined);
      setEditingGroupTitle(DEFAULT_GROUP_TITLE);
      return;
    }

    const previousLayout = persistGraphLayout(nodes, groups);
    const nextGroups = renameGraphGroup(groups, groupId, editingGroupTitle);
    const nextLayout = persistGraphLayout(nodes, nextGroups);
    hydrationGenerationRef.current += 1;
    setGroups(nextGroups);
    persistCurrentLayout(nodes, nextGroups);
    setEditingGroupId(undefined);
    setEditingGroupTitle(DEFAULT_GROUP_TITLE);
    if (!storedLayoutsEqual(previousLayout, nextLayout)) {
      pushLayoutUndoEntry(`Renamed group ${groupId}.`, previousLayout);
    }
  };

  const toggleOrganizeGroup = (groupId: string) => {
    selectGroup(groupId);
    setEditingGroupId(undefined);
    setEditingGroupTitle(DEFAULT_GROUP_TITLE);
    setOrganizeGroupId((current) => (current === groupId ? undefined : groupId));
  };

  const applyOrganizeGroup = (groupId: string, mode: GroupOrganizeMode) => {
    if (!graph || !viewKey) {
      return;
    }

    const group = groups.find((candidate) => candidate.id === groupId);
    if (!group) {
      setOrganizeGroupId(undefined);
      return;
    }

    const groupMemberNodeIds = new Set(group.memberNodeIds);
    const graphNodesById = new Map(graph.nodes.map((node) => [node.id, node] as const));
    const groupNodes = nodes.flatMap((node) => {
      if (!isSemanticCanvasNode(node) || !groupMemberNodeIds.has(node.id)) {
        return [];
      }

      const graphNode = graphNodesById.get(node.id);
      return [
        {
          id: node.id,
          kind: node.data.kind,
          x: node.position.x,
          y: node.position.y,
          width: semanticNodeDimension(node, "width"),
          height: semanticNodeDimension(node, "height"),
          metadata: graphNode?.metadata ?? {},
        },
      ];
    });

    setOrganizeGroupId(undefined);
    if (groupNodes.length < 2) {
      return;
    }

    const result = organizeGroupedNodes({
      mode,
      nodes: groupNodes,
      edges: graph.edges,
    });
    if (!result.changed) {
      return;
    }

    const previousLayout = persistGraphLayout(nodes, groups);
    const nextNodes = nodes.map((node) => {
      if (!isSemanticCanvasNode(node) || !groupMemberNodeIds.has(node.id)) {
        return node;
      }

      const nextPosition = result.positions[node.id];
      if (!nextPosition) {
        return node;
      }

      return {
        ...node,
        position: nextPosition,
      };
    });

    hydrationGenerationRef.current += 1;
    setSelectedGroupId(groupId);
    setSelectedSemanticNodeIds([]);
    setNodes(nextNodes);
    pushLayoutUndoEntry(`Organized group ${groupId}.`, previousLayout);
    persistCurrentLayout(nextNodes, groups);
  };

  const togglePinnedNodes = (nodeIds: string[]) => {
    if (!canPinNodes || !nodeIds.length) {
      return;
    }

    hydrationGenerationRef.current += 1;
    let previousLayout: StoredGraphLayout | undefined;
    let nextLayout: StoredGraphLayout | undefined;
    setNodes((current) => {
      previousLayout = persistGraphLayout(current, groups);
      const targetNodeIds = expandGroupedNodeIds(nodeIds, groupByNodeId, memberNodeIdsByGroupId);
      const semanticNodesById = new Map(
        current.filter(isSemanticCanvasNode).map((node) => [node.id, node] as const),
      );
      const nextPinnedByNodeId = new Map<string, boolean>();
      const nextPinnedByGroupId = new Map<string, boolean>();

      targetNodeIds.forEach((targetNodeId) => {
        const groupId = groupByNodeId.get(targetNodeId);
        if (!groupId) {
          const targetNode = semanticNodesById.get(targetNodeId);
          if (targetNode) {
            nextPinnedByNodeId.set(targetNodeId, !targetNode.data.isPinned);
          }
          return;
        }

        if (!nextPinnedByGroupId.has(groupId)) {
          const memberNodeIds = memberNodeIdsByGroupId.get(groupId) ?? [targetNodeId];
          const shouldPin = memberNodeIds.some(
            (memberNodeId) => !semanticNodesById.get(memberNodeId)?.data.isPinned,
          );
          nextPinnedByGroupId.set(groupId, shouldPin);
        }
      });

      const next = current.map((node) => {
        if (!isSemanticCanvasNode(node)) {
          return node;
        }

        const groupId = groupByNodeId.get(node.id);
        const nextPinned = groupId
          ? nextPinnedByGroupId.get(groupId)
          : nextPinnedByNodeId.get(node.id);
        if (nextPinned === undefined) {
          return node;
        }

        return {
          ...node,
          data: {
            ...node.data,
            isPinned: nextPinned,
            actions: (node.data.actions ?? []).map((action) =>
              action.id === "pin"
                ? {
                    ...action,
                    label: nextPinned ? "Unpin" : "Pin",
                    helpId: pinActionHelpId(nextPinned),
                  }
                : action,
            ),
          },
        };
      });
      nextLayout = persistGraphLayout(next, groups);
      persistCurrentLayout(next);
      return next;
    });
    if (previousLayout && nextLayout && !storedLayoutsEqual(previousLayout, nextLayout)) {
      pushLayoutUndoEntry("Updated pinned layout nodes.", previousLayout);
    }
  };
  const togglePinnedNode = (nodeId: string) => {
    togglePinnedNodes([nodeId]);
  };

  const createGroupFromSelection = () => {
    const { changed, nextGroupId, nextGroups } = mergeGroupsForSelection(
      groups,
      effectiveSemanticSelection,
    );
    if (!changed || !nextGroupId) {
      return;
    }

    const previousLayout = persistGraphLayout(nodes, groups);
    hydrationGenerationRef.current += 1;
    setNodes((current) =>
      current.some((node) => node.selected)
        ? current.map((node) => (node.selected ? { ...node, selected: false } : node))
        : current,
    );
    setGroups(nextGroups);
    setSelectedSemanticNodeIds([]);
    setSelectedGroupId(nextGroupId);
    setOrganizeGroupId(undefined);
    setEditingGroupId(nextGroupId);
    setEditingGroupTitle(DEFAULT_GROUP_TITLE);
    persistCurrentLayout(nodes, nextGroups);
    pushLayoutUndoEntry(`Grouped nodes into ${nextGroupId}.`, previousLayout);
  };

  const ungroupSelection = () => {
    const { changed, nextGroups, removedGroupIds } = ungroupGroupsForSelection(
      groups,
      effectiveSemanticSelection,
      selectedGroupId,
    );
    if (!changed) {
      return;
    }

    const previousLayout = persistGraphLayout(nodes, groups);
    hydrationGenerationRef.current += 1;
    setGroups(nextGroups);
    if (selectedGroupId && removedGroupIds.includes(selectedGroupId)) {
      setSelectedGroupId(undefined);
    }
    if (organizeGroupId && removedGroupIds.includes(organizeGroupId)) {
      setOrganizeGroupId(undefined);
    }
    if (editingGroupId && removedGroupIds.includes(editingGroupId)) {
      setEditingGroupId(undefined);
      setEditingGroupTitle(DEFAULT_GROUP_TITLE);
    }
    persistCurrentLayout(nodes, nextGroups);
    pushLayoutUndoEntry("Ungrouped selected nodes.", previousLayout);
  };

  const ungroupGroup = async (groupId: string, title: string) => {
    const confirmed = await confirmDialog(`Ungroup "${title}"?`, {
      title: "Ungroup nodes",
      kind: "warning",
      okLabel: "Ungroup",
      cancelLabel: "Cancel",
    });
    if (!confirmed) {
      return;
    }

    const { changed, nextGroups, removedGroupIds } = ungroupGroupsForSelection(groups, [], groupId);
    if (!changed) {
      return;
    }

    const previousLayout = persistGraphLayout(nodes, groups);
    hydrationGenerationRef.current += 1;
    setGroups(nextGroups);
    if (selectedGroupId && removedGroupIds.includes(selectedGroupId)) {
      setSelectedGroupId(undefined);
    }
    if (organizeGroupId && removedGroupIds.includes(organizeGroupId)) {
      setOrganizeGroupId(undefined);
    }
    if (editingGroupId && removedGroupIds.includes(editingGroupId)) {
      setEditingGroupId(undefined);
      setEditingGroupTitle(DEFAULT_GROUP_TITLE);
    }
    persistCurrentLayout(nodes, nextGroups);
    pushLayoutUndoEntry(`Ungrouped ${title}.`, previousLayout);
  };

  const removeSelectedReroutes = () => {
    hydrationGenerationRef.current += 1;
    let previousLayout: StoredGraphLayout | undefined;
    let nextLayout: StoredGraphLayout | undefined;
    setNodes((current) => {
      previousLayout = persistGraphLayout(current, groups);
      const selectedIds = new Set(
        current
          .filter((node) => isRerouteCanvasNode(node) && Boolean(node.selected))
          .map((node) => node.id),
      );
      if (!selectedIds.size) {
        return current;
      }

      const next = normalizeRerouteNodeOrders(current.filter((node) => !selectedIds.has(node.id)));
      nextLayout = persistGraphLayout(next, groups);
      persistCurrentLayout(next, groups);
      return next;
    });
    if (previousLayout && nextLayout && !storedLayoutsEqual(previousLayout, nextLayout)) {
      pushLayoutUndoEntry("Removed reroute nodes.", previousLayout);
    }
  };

  const handleFitView = () => {
    const fitViewButton = panelRef.current?.querySelector<HTMLButtonElement>(
      ".react-flow__controls-fitview",
    );
    if (!fitViewButton) {
      return false;
    }

    fitViewButton.click();
    return true;
  };

  const handleGraphShortcutKey = (event: {
    key: string;
    altKey: boolean;
    ctrlKey: boolean;
    defaultPrevented: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    target: EventTarget | null;
    preventDefault: () => void;
  }) => {
    if (event.defaultPrevented) {
      return;
    }

    if (shouldHandleCreateModeKey(event)) {
      event.preventDefault();
      onToggleCreateMode();
      return;
    }

    if (shouldHandleFitViewKey(event)) {
      if (!handleFitView()) {
        return;
      }

      event.preventDefault();
      return;
    }

    if (selectedRerouteCount && shouldHandleRerouteDeleteKey(event)) {
      event.preventDefault();
      removeSelectedReroutes();
      return;
    }

    if (
      flowAuthoringEnabled &&
      shouldHandleRerouteDeleteKey(event) &&
      (selectedControlEdgeIds.length || selectedDeletableFlowNodeIds.length)
    ) {
      event.preventDefault();
      onDeleteFlowSelection({
        nodeIds: selectedDeletableFlowNodeIds,
        edgeIds: selectedControlEdgeIds,
      });
      setSelectedControlEdgeIds([]);
      return;
    }

    if (shouldHandleRerouteDeleteKey(event)) {
      event.preventDefault();
      if (selectedDeletableSymbolNodeId) {
        onDeleteSymbolNode(selectedDeletableSymbolNodeId);
      }
      return;
    }

    if (shouldHandleUngroupKey(event)) {
      event.preventDefault();
      ungroupSelection();
      return;
    }

    if (shouldHandleGroupKey(event)) {
      event.preventDefault();
      createGroupFromSelection();
      return;
    }

    if (selectedGroupId && shouldHandlePinKey(event) && canPinNodes) {
      event.preventDefault();
      togglePinnedNodes(memberNodeIdsByGroupId.get(selectedGroupId) ?? []);
      return;
    }

    if (selectedNodeId && shouldHandlePinKey(event) && canPinNodes) {
      event.preventDefault();
      togglePinnedNodes([selectedNodeId]);
    }
  };

  useEffect(() => {
    const panel = panelRef.current;

    const handleFocusIn = (event: FocusEvent) => {
      graphHotkeyActiveRef.current = Boolean(
        panelRef.current && event.target instanceof Node && panelRef.current.contains(event.target),
      );
    };

    const handlePointerDown = (event: PointerEvent) => {
      graphHotkeyActiveRef.current = Boolean(
        panelRef.current && event.target instanceof Node && panelRef.current.contains(event.target),
      );
    };

    const handleWindowKeyDown = (event: KeyboardEvent) => {
      const panelContainsTarget = Boolean(
        panelRef.current && event.target instanceof Node && panelRef.current.contains(event.target),
      );
      const panelContainsFocus = Boolean(
        panelRef.current &&
        document.activeElement instanceof Node &&
        panelRef.current.contains(document.activeElement),
      );

      if (
        !(graphHotkeyActiveRef.current || panelContainsTarget || panelContainsFocus) ||
        (!shouldHandleFitViewKey(event) &&
          !shouldHandleCreateModeKey(event) &&
          !shouldHandleRerouteDeleteKey(event) &&
          !shouldHandlePinKey(event) &&
          !shouldHandleGroupKey(event) &&
          !shouldHandleUngroupKey(event))
      ) {
        return;
      }

      handleGraphShortcutKey(event);
    };

    const handlePanelKeyDown = (event: KeyboardEvent) => {
      if (
        !shouldHandleFitViewKey(event) &&
        !shouldHandleCreateModeKey(event) &&
        !shouldHandleRerouteDeleteKey(event) &&
        !shouldHandlePinKey(event) &&
        !shouldHandleGroupKey(event) &&
        !shouldHandleUngroupKey(event)
      ) {
        return;
      }

      handleGraphShortcutKey(event);
    };

    window.addEventListener("focusin", handleFocusIn);
    window.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleWindowKeyDown, true);
    panel?.addEventListener("keydown", handlePanelKeyDown);
    return () => {
      window.removeEventListener("focusin", handleFocusIn);
      window.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleWindowKeyDown, true);
      panel?.removeEventListener("keydown", handlePanelKeyDown);
    };
  }, [
    canPinNodes,
    createGroupFromSelection,
    memberNodeIdsByGroupId,
    selectedGroupId,
    selectedNodeId,
    selectedDeletableSymbolNodeId,
    selectedRerouteCount,
    onToggleCreateMode,
    onDeleteSymbolNode,
    togglePinnedNodes,
    ungroupSelection,
    fitViewOptions,
  ]);

  useEffect(() => {
    const handlePointerUp = () => {
      setPanPointerDragging(false);
    };

    window.addEventListener("pointerup", handlePointerUp, true);
    return () => window.removeEventListener("pointerup", handlePointerUp, true);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Shift") {
        shiftPressedRef.current = true;
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Shift") {
        shiftPressedRef.current = false;
      }
    };

    const handleBlur = () => {
      shiftPressedRef.current = false;
    };

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("blur", handleBlur);
    };
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    const showPanCursor = panModeActive && (pointerInsidePanel || panPointerDragging);
    document.body.classList.toggle("graph-pan-cursor-active", showPanCursor && !panPointerDragging);
    document.body.classList.toggle(
      "graph-pan-cursor-dragging",
      showPanCursor && panPointerDragging,
    );

    return () => {
      document.body.classList.remove("graph-pan-cursor-active");
      document.body.classList.remove("graph-pan-cursor-dragging");
    };
  }, [panModeActive, panPointerDragging, pointerInsidePanel]);

  useEffect(() => {
    if (!selectedRerouteCount) {
      return;
    }
    onClearSelection();
  }, [onClearSelection, selectedRerouteCount]);

  useEffect(() => {
    if (!createModeActive) {
      return;
    }
    clearLocalSelection();
  }, [createModeActive]);

  useEffect(() => {
    if (!graph || !viewKey) {
      setNodes([]);
      setGroups([]);
      setSelectedSemanticNodeIds([]);
      setSelectedGroupId(undefined);
      setEditingGroupId(undefined);
      setOrganizeGroupId(undefined);
      setEditingGroupTitle(DEFAULT_GROUP_TITLE);
      setMarqueeSelectionActive(false);
      return;
    }

    const generation = hydrationGenerationRef.current + 1;
    hydrationGenerationRef.current = generation;
    const emptyLayout: StoredGraphLayout = {
      nodes: {},
      reroutes: [],
      pinnedNodeIds: [],
      groups: [],
    };
    const cachedLayout = peekStoredGraphLayout(repoPath, viewKey);
    const initialGroups = normalizeStoredGroups(cachedLayout?.groups, graphNodeIds);
    const initialLayout: StoredGraphLayout = cachedLayout
      ? {
          ...cachedLayout,
          groups: initialGroups,
        }
      : emptyLayout;
    const initialNodes = buildCanvasNodes(
      graph,
      EMPTY_STRING_SET,
      initialLayout,
      EMPTY_STRING_SET,
      false,
      EMPTY_STRING_SET,
      EMPTY_STRING_SET,
      false,
      new Set(initialGroups.flatMap((group) => group.memberNodeIds)),
      EMPTY_STRING_SET,
      canPinNodes,
      flowAuthoringEnabled,
      togglePinnedNode,
      onActivateNode,
      onInspectNode,
      requestExpressionGraphIntent,
      setHoveredPortEdgeIds,
      () => setHoveredPortEdgeIds([]),
    );
    setNodes(initialNodes);
    setGroups(initialGroups);
    setSelectedSemanticNodeIds([]);
    setSelectedGroupId(undefined);
    setEditingGroupId(undefined);
    setOrganizeGroupId(undefined);
    setEditingGroupTitle(DEFAULT_GROUP_TITLE);

    let cancelled = false;
    void readStoredGraphLayout(repoPath, viewKey).then((savedLayout) => {
      if (cancelled || hydrationGenerationRef.current !== generation) {
        return;
      }

      if (graph.level === "flow" && storedLayoutIsEmpty(savedLayout)) {
        const initialLayoutResult = layoutFlowGraph(
          toFlowLayoutNodes(initialNodes, graph),
          graph.edges,
        );
        const initializedLayout: StoredGraphLayout = {
          nodes: initialLayoutResult.positions,
          reroutes: [],
          pinnedNodeIds: [],
          groups: [],
        };
        setNodes(
          buildCanvasNodes(
            graph,
            EMPTY_STRING_SET,
            initializedLayout,
            EMPTY_STRING_SET,
            false,
            EMPTY_STRING_SET,
            EMPTY_STRING_SET,
            false,
            EMPTY_STRING_SET,
            EMPTY_STRING_SET,
            canPinNodes,
            flowAuthoringEnabled,
            togglePinnedNode,
            onActivateNode,
            onInspectNode,
            requestExpressionGraphIntent,
            setHoveredPortEdgeIds,
            () => setHoveredPortEdgeIds([]),
          ),
        );
        setGroups([]);
        void writeStoredGraphLayout(repoPath, viewKey, initializedLayout);
        return;
      }

      const normalizedGroups = normalizeStoredGroups(savedLayout.groups, graphNodeIds);
      const normalizedLayout: StoredGraphLayout = {
        ...savedLayout,
        groups: normalizedGroups,
      };

      setNodes(
        buildCanvasNodes(
          graph,
          EMPTY_STRING_SET,
          normalizedLayout,
          EMPTY_STRING_SET,
          false,
          EMPTY_STRING_SET,
          EMPTY_STRING_SET,
          false,
          new Set(normalizedGroups.flatMap((group) => group.memberNodeIds)),
          EMPTY_STRING_SET,
          canPinNodes,
          flowAuthoringEnabled,
          togglePinnedNode,
          onActivateNode,
          onInspectNode,
          requestExpressionGraphIntent,
          setHoveredPortEdgeIds,
          () => setHoveredPortEdgeIds([]),
        ),
      );
      setGroups(normalizedGroups);
    });

    return () => {
      cancelled = true;
    };
  }, [
    graph,
    canPinNodes,
    flowAuthoringEnabled,
    onActivateNode,
    onInspectNode,
    requestExpressionGraphIntent,
    repoPath,
    graphNodeIds,
    viewKey,
  ]);

  useEffect(() => {
    if (!graph) {
      return;
    }
    setNodes((current) =>
      applyNodeDecorations(
        current,
        graph,
        selectedPreviewNodeIds,
        highlightedEdgeIds,
        hoverActive,
        selectedRelatedNodeIds,
        selectedConnectedEdgeIds,
        selectionContextActive,
        groupedNodeIds,
        selectedGroupMemberNodeIds,
        canPinNodes,
        flowAuthoringEnabled,
        togglePinnedNode,
        onActivateNode,
        onInspectNode,
        requestExpressionGraphIntent,
        setHoveredPortEdgeIds,
        () => setHoveredPortEdgeIds([]),
      ),
    );
  }, [
    graph,
    highlightedEdgeIds,
    hoverActive,
    canPinNodes,
    flowAuthoringEnabled,
    onActivateNode,
    onInspectNode,
    requestExpressionGraphIntent,
    selectedConnectedEdgeIds,
    groupedNodeIds,
    selectedPreviewNodeIds,
    selectedGroupMemberNodeIds,
    selectedRelatedNodeIds,
    selectionContextActive,
  ]);

  useEffect(() => {
    if (selectedGroupId && !groups.some((group) => group.id === selectedGroupId)) {
      setSelectedGroupId(undefined);
    }
    if (organizeGroupId && !groups.some((group) => group.id === organizeGroupId)) {
      setOrganizeGroupId(undefined);
    }
    if (editingGroupId && !groups.some((group) => group.id === editingGroupId)) {
      setEditingGroupId(undefined);
      setEditingGroupTitle(DEFAULT_GROUP_TITLE);
    }
  }, [editingGroupId, groups, organizeGroupId, selectedGroupId]);

  useEffect(() => {
    const liveDeletableEdgeIds = new Set(
      (graph?.edges ?? [])
        .filter(
          (edge) =>
            edge.kind === "controls" ||
            (edge.kind === "data" &&
              (edge.id.startsWith("data:flowbinding:") || edge.id.startsWith("data:flowparam:"))),
        )
        .map((edge) => edge.id),
    );
    setSelectedControlEdgeIds((current) =>
      current.filter((edgeId) => liveDeletableEdgeIds.has(edgeId)),
    );
  }, [graph?.edges]);

  useEffect(() => {
    pendingLayoutUndoRef.current = undefined;
  }, [viewKey]);

  useEffect(() => {
    setLayoutUndoStacks({});
    setLayoutRedoStacks({});
    pendingLayoutUndoRef.current = undefined;
  }, [repoPath]);

  useEffect(
    () =>
      useUndoStore.getState().registerDomain("layout", {
        canUndo: () => currentLayoutUndoStack.length > 0,
        canRedo: () => currentLayoutRedoStack.length > 0,
        peekEntry: () => currentLayoutUndoStack[currentLayoutUndoStack.length - 1]?.entry,
        peekRedoEntry: () => currentLayoutRedoStack[currentLayoutRedoStack.length - 1]?.entry,
        undo: async () => {
          const layoutUndo = currentLayoutUndoStack[currentLayoutUndoStack.length - 1];
          if (!layoutUndo) {
            return {
              domain: "layout" as const,
              handled: false,
            };
          }

          applyLayoutHistoryEntry(layoutUndo, "undo");
          return {
            domain: "layout" as const,
            handled: true,
            summary: layoutUndo.entry.summary,
          };
        },
        redo: async () => {
          const layoutRedo = currentLayoutRedoStack[currentLayoutRedoStack.length - 1];
          if (!layoutRedo) {
            return {
              domain: "layout" as const,
              handled: false,
            };
          }

          applyLayoutHistoryEntry(layoutRedo, "redo");
          return {
            domain: "layout" as const,
            handled: true,
            summary: layoutRedo.entry.summary,
          };
        },
      }),
    [applyLayoutHistoryEntry, currentLayoutRedoStack, currentLayoutUndoStack],
  );

  useEffect(() => {
    setHoveredEdgeId(undefined);
    setHoveredPortEdgeIds([]);
    setTransientHelpTarget(null);
  }, [setTransientHelpTarget, viewKey]);

  useEffect(
    () => () => {
      setTransientHelpTarget(null);
    },
    [setTransientHelpTarget],
  );

  const handleNodesChange = (changes: NodeChange<GraphCanvasNode>[]) => {
    setNodes((current) =>
      applyGroupedPositionChanges(current, changes, groupByNodeId, memberNodeIdsByGroupId),
    );
  };

  const handleNodeDragStart = () => {
    capturePendingLayoutUndo("Moved layout nodes.");
  };

  const handleSelectionDragStart = () => {
    capturePendingLayoutUndo("Moved selected layout nodes.");
  };

  const handleNodeDragStop = () => {
    finalizePendingLayoutUndo();
    persistCurrentCanvasState();
  };

  const handleSelectionDragStop = () => {
    finalizePendingLayoutUndo();
    persistCurrentCanvasState();
  };

  const handleDeclutter = () => {
    if (!graph || !viewKey || !nodes.length) {
      return;
    }

    const previousLayout = persistGraphLayout(nodes, groups);
    const result =
      graph.level === "flow"
        ? layoutFlowGraph(
            toFlowLayoutNodes(nodes, graph),
            graph.edges,
            semanticPinnedNodeIds(nodes),
          )
        : declutterGraphLayout(toDeclutterNodes(nodes.filter(isSemanticCanvasNode)), graph.edges);
    if (!result.changed) {
      return;
    }

    const nextNodes = applyGroupedLayoutPositions(
      nodes,
      result.positions,
      memberNodeIdsByGroupId,
      groupByNodeId,
    );

    hydrationGenerationRef.current += 1;
    setNodes(nextNodes);
    pushLayoutUndoEntry("Decluttered layout.", previousLayout);
    persistCurrentLayout(nextNodes, groups);
  };

  const handleUndoLayout = () => {
    const layoutUndo = currentLayoutUndoStack[currentLayoutUndoStack.length - 1];
    if (!viewKey || !layoutUndo || layoutUndo.viewKey !== viewKey) {
      return;
    }

    applyLayoutHistoryEntry(layoutUndo, "undo");
  };

  const handleInsertReroute = (
    logicalEdgeId: string,
    segmentIndex: number,
    position: { x: number; y: number },
  ) => {
    if (!viewKey) {
      return;
    }

    hydrationGenerationRef.current += 1;
    let previousLayout: StoredGraphLayout | undefined;
    let nextLayout: StoredGraphLayout | undefined;
    setNodes((current) => {
      previousLayout = persistGraphLayout(current, groups);
      const edgeReroutes = current
        .filter(
          (node): node is RerouteCanvasNode =>
            isRerouteCanvasNode(node) && node.data.logicalEdgeId === logicalEdgeId,
        )
        .sort(
          (left, right) => left.data.order - right.data.order || left.id.localeCompare(right.id),
        );
      const insertAt = Math.max(0, Math.min(segmentIndex, edgeReroutes.length));
      const next = normalizeRerouteNodeOrders([
        ...current.map((node) => {
          if (
            !isRerouteCanvasNode(node) ||
            node.data.logicalEdgeId !== logicalEdgeId ||
            node.data.order < insertAt
          ) {
            return node;
          }
          return {
            ...node,
            data: {
              ...node.data,
              order: node.data.order + 1,
            },
          };
        }),
        {
          id: rerouteNodeId(createRerouteId(logicalEdgeId)),
          type: "reroute",
          position,
          draggable: true,
          selectable: true,
          className: buildRerouteShellClassName(
            logicalEdgeId,
            highlightedEdgeIds,
            hoverActive,
            selectedConnectedEdgeIds,
            selectionContextActive,
          ),
          data: {
            kind: "reroute",
            logicalEdgeId,
            order: insertAt,
          },
        } satisfies RerouteCanvasNode,
      ]);
      nextLayout = persistGraphLayout(next, groups);
      persistCurrentLayout(next, groups);
      return next;
    });
    if (previousLayout && nextLayout && !storedLayoutsEqual(previousLayout, nextLayout)) {
      pushLayoutUndoEntry(`Inserted reroute on ${logicalEdgeId}.`, previousLayout);
    }
  };

  const panelPositionForContext = (position: AppContextMenuPosition) => {
    const panelBounds = panelRef.current?.getBoundingClientRect();
    return {
      x: panelBounds ? position.x - panelBounds.left : position.x,
      y: panelBounds ? position.y - panelBounds.top : position.y,
    };
  };

  const deleteSelectedFlowItems = () => {
    if (!flowAuthoringEnabled) {
      return;
    }
    onDeleteFlowSelection({
      nodeIds: selectedDeletableFlowNodeIds,
      edgeIds: selectedControlEdgeIds,
    });
    setSelectedControlEdgeIds([]);
  };

  const buildNodeContextMenuItems = (
    menu: Extract<GraphContextMenuState, { kind: "node" }>,
  ): AppContextMenuItem[] => {
    const canvasNode = nodes.find((node) => node.id === menu.nodeId);
    if (!canvasNode) {
      return [];
    }

    if (isRerouteCanvasNode(canvasNode)) {
      return [
        {
          id: "remove-reroute",
          label: "Remove Reroute",
          action: removeSelectedReroutes,
        },
        {
          id: "copy-reroute-id",
          label: "Copy Reroute ID",
          action: () => copyToClipboard(canvasNode.id),
          separatorBefore: true,
        },
        {
          id: "copy-reroute-edge-id",
          label: "Copy Edge ID",
          action: () => copyToClipboard(canvasNode.data.logicalEdgeId),
        },
      ];
    }

    const graphNode = graphNodeById.get(menu.nodeId);
    if (!graphNode) {
      return [];
    }

    const relativePath = relativePathForGraphNode(graphNode);
    const qualname = metadataString(graphNode, "qualname");
    const sourceBacked =
      Boolean(relativePath) || graphNode.kind === "module" || isGraphSymbolNodeKind(graphNode.kind);
    const groupId = groupByNodeId.get(graphNode.id);
    const selectedGroupMemberIds = groupId ? (memberNodeIdsByGroupId.get(groupId) ?? []) : [];
    const canDeleteFlowItems =
      flowAuthoringEnabled &&
      (selectedControlEdgeIds.length > 0 || selectedDeletableFlowNodeIds.length > 0);
    const items: AppContextMenuItem[] = [];

    if (isEnterableGraphNodeKind(graphNode.kind)) {
      items.push({
        id: "enter",
        label: "Enter Node",
        action: () => onActivateNode(graphNode.id, graphNode.kind),
      });
    }

    if (isInspectableGraphNodeKind(graphNode.kind)) {
      items.push({
        id: "inspect",
        label: "Inspect Source",
        action: () => onInspectNode(graphNode.id, graphNode.kind),
      });
    }

    if (flowAuthoringEnabled && graphNode.kind === "return") {
      items.push({
        id: "open-expression-graph",
        label: "Open Expression Graph",
        action: () =>
          requestExpressionGraphIntent(graphNode.id, undefined, {
            x: menu.x,
            y: menu.y,
          }),
      });
    }

    if (flowAuthoringEnabled && authorableFlowNodeIds.has(graphNode.id)) {
      const openFlowNodeEditor = (initialLoopType?: FlowLoopType) =>
        onEditFlowNodeIntent({
          nodeId: graphNode.id,
          flowPosition: screenToFlowPosition({ x: menu.x, y: menu.y }),
          panelPosition: panelPositionForContext(menu),
          initialLoopType,
        });
      if (graphNode.kind === "loop") {
        items.push(
          {
            id: "edit-loop",
            label: "Edit Loop",
            action: () => openFlowNodeEditor(),
          },
          {
            id: "change-loop-while",
            label: "Change to While Loop",
            action: () => openFlowNodeEditor("while"),
          },
          {
            id: "change-loop-for",
            label: "Change to For Loop",
            action: () => openFlowNodeEditor("for"),
          },
          {
            id: "add-repeat-step",
            label: "Add Repeat Step",
            action: () =>
              onCreateIntent({
                flowPosition: screenToFlowPosition({ x: menu.x, y: menu.y }),
                panelPosition: panelPositionForContext(menu),
                seedFlowConnection: {
                  sourceNodeId: graphNode.id,
                  sourceHandle: "body",
                  label: "Repeat",
                },
              }),
          },
          {
            id: "add-done-step",
            label: "Add Done Step",
            action: () =>
              onCreateIntent({
                flowPosition: screenToFlowPosition({ x: menu.x, y: menu.y }),
                panelPosition: panelPositionForContext(menu),
                seedFlowConnection: {
                  sourceNodeId: graphNode.id,
                  sourceHandle: "after",
                  label: "Done",
                },
              }),
          },
        );
      } else {
        items.push({
          id: "edit-flow-node",
          label: "Edit Flow Node",
          action: () => openFlowNodeEditor(),
        });
      }
    }

    if (canPinNodes) {
      items.push({
        id: "toggle-pin",
        label: canvasNode.data.isPinned ? "Unpin Node" : "Pin Node",
        action: () => togglePinnedNodes([graphNode.id]),
        separatorBefore: items.length > 0,
      });
    }

    if (effectiveSemanticSelection.length > 1) {
      items.push({
        id: "group-selection",
        label: "Group Selection",
        action: createGroupFromSelection,
        separatorBefore: items.length > 0,
      });
    }

    if (groupId) {
      items.push(
        {
          id: "select-group",
          label: "Select Group",
          action: () => selectGroup(groupId),
          separatorBefore: effectiveSemanticSelection.length <= 1 && items.length > 0,
        },
        {
          id: "ungroup-node-group",
          label: "Ungroup",
          action: () => {
            setSelectedSemanticNodeIds(selectedGroupMemberIds);
            void ungroupGroup(
              groupId,
              groups.find((group) => group.id === groupId)?.title ?? groupId,
            );
          },
        },
      );
    }

    if (canDeleteFlowItems) {
      items.push({
        id: "delete-flow-selection",
        label: "Delete Flow Selection",
        action: deleteSelectedFlowItems,
        separatorBefore: items.length > 0,
      });
    }

    if (sourceBacked && onRevealNodeInFileExplorer) {
      items.push({
        id: "reveal-node",
        label: systemFileExplorerLabel(),
        action: () => onRevealNodeInFileExplorer(graphNode.id),
        separatorBefore: items.length > 0,
      });
    }

    if (sourceBacked && onOpenNodeInDefaultEditor) {
      items.push({
        id: "open-default",
        label: "Open in Default Editor",
        action: () => onOpenNodeInDefaultEditor(graphNode.id),
      });
    }

    items.push(
      {
        id: "copy-label",
        label: "Copy Label",
        action: () => copyToClipboard(graphNode.label),
        separatorBefore: true,
      },
      {
        id: "copy-node-id",
        label: "Copy Node ID",
        action: () => copyToClipboard(graphNode.id),
      },
      {
        id: "copy-kind",
        label: "Copy Kind",
        action: () => copyToClipboard(graphNode.kind),
      },
    );

    if (relativePath) {
      items.push({
        id: "copy-relative-path",
        label: "Copy Relative Path",
        action: () => copyToClipboard(relativePath),
      });
    }

    if (qualname) {
      items.push({
        id: "copy-qualname",
        label: "Copy Qualified Name",
        action: () => copyToClipboard(qualname),
      });
    }

    return items;
  };

  const buildEdgeContextMenuItems = (
    menu: Extract<GraphContextMenuState, { kind: "edge" }>,
  ): AppContextMenuItem[] => {
    const canModifyFlowEdge =
      flowAuthoringEnabled &&
      (menu.edgeKind === "controls" ||
        menu.edgeId.startsWith("data:flowbinding:") ||
        menu.edgeId.startsWith("data:flowparam:"));
    const items: AppContextMenuItem[] = [];

    if (canModifyFlowEdge) {
      items.push(
        {
          id: "select-edge",
          label: "Select Edge",
          action: () => selectControlEdge(menu.edgeId),
        },
        {
          id: "disconnect-edge",
          label: "Disconnect Edge",
          action: () => {
            onDisconnectFlowEdge(menu.edgeId);
            setSelectedControlEdgeIds((current) =>
              current.filter((edgeId) => edgeId !== menu.edgeId),
            );
          },
        },
      );
    }

    items.push({
      id: "insert-reroute",
      label: "Insert Reroute",
      action: () => handleInsertReroute(menu.edgeId, menu.segmentIndex, menu.flowPosition),
      separatorBefore: items.length > 0,
    });

    items.push(
      {
        id: "copy-edge-id",
        label: "Copy Edge ID",
        action: () => copyToClipboard(menu.edgeId),
        separatorBefore: true,
      },
      {
        id: "copy-edge-kind",
        label: "Copy Edge Kind",
        action: () => copyToClipboard(menu.edgeKind),
      },
    );

    if (menu.edgeLabel) {
      items.push({
        id: "copy-edge-label",
        label: "Copy Edge Label",
        action: () => copyToClipboard(menu.edgeLabel ?? ""),
      });
    }

    return items;
  };

  const buildPaneContextMenuItems = (
    menu: Extract<GraphContextMenuState, { kind: "pane" }>,
  ): AppContextMenuItem[] => {
    if (!graph) {
      return [];
    }

    const canDeleteFlowItems =
      flowAuthoringEnabled &&
      (selectedControlEdgeIds.length > 0 || selectedDeletableFlowNodeIds.length > 0);
    const items: AppContextMenuItem[] = [];

    if (flowAuthoringEnabled) {
      items.push({
        id: "create-flow-node",
        label: "Create Flow Node Here",
        action: () =>
          onCreateIntent({
            flowPosition: menu.flowPosition,
            panelPosition: panelPositionForContext(menu),
          }),
      });
    }

    items.push(
      {
        id: "fit-view",
        label: "Fit View",
        action: () => {
          handleFitView();
        },
        separatorBefore: items.length > 0,
      },
      {
        id: "declutter",
        label: graph.level === "flow" ? "Auto Layout Flow" : "Declutter Layout",
        action: handleDeclutter,
      },
      {
        id: "undo-layout",
        label: "Undo Layout",
        action: handleUndoLayout,
        disabled: currentLayoutUndoStack.length === 0,
      },
    );

    if (effectiveSemanticSelection.length > 1) {
      items.push({
        id: "group-selection",
        label: "Group Selection",
        action: createGroupFromSelection,
        separatorBefore: true,
      });
    }

    if (
      selectedGroupId ||
      effectiveSemanticSelection.some((nodeId) => groupedNodeIds.has(nodeId))
    ) {
      items.push({
        id: "ungroup-selection",
        label: "Ungroup Selection",
        action: ungroupSelection,
        separatorBefore: effectiveSemanticSelection.length <= 1,
      });
    }

    if (canDeleteFlowItems) {
      items.push({
        id: "delete-flow-selection",
        label: "Delete Flow Selection",
        action: deleteSelectedFlowItems,
        separatorBefore: true,
      });
    }

    if (
      effectiveSemanticSelection.length ||
      selectedControlEdgeIds.length ||
      selectedRerouteCount ||
      selectedGroupId
    ) {
      items.push({
        id: "clear-selection",
        label: "Clear Selection",
        action: () => {
          clearLocalSelection();
          onClearSelection();
        },
        separatorBefore: !canDeleteFlowItems,
      });
    }

    items.push(
      {
        id: "toggle-create-mode",
        label: createModeActive ? "Exit Create Mode" : "Enter Create Mode",
        action: onToggleCreateMode,
        separatorBefore: true,
      },
      {
        id: "copy-graph-target",
        label: "Copy Graph Target ID",
        action: () => copyToClipboard(graph.targetId),
        separatorBefore: true,
      },
      {
        id: "copy-graph-level",
        label: "Copy Graph Level",
        action: () => copyToClipboard(graph.level),
      },
    );

    return items;
  };

  const contextMenuItems = contextMenu
    ? contextMenu.kind === "node"
      ? buildNodeContextMenuItems(contextMenu)
      : contextMenu.kind === "edge"
        ? buildEdgeContextMenuItems(contextMenu)
        : buildPaneContextMenuItems(contextMenu)
    : [];

  const contextMenuLabel = contextMenu
    ? contextMenu.kind === "node"
      ? `${graphNodeById.get(contextMenu.nodeId)?.label ?? "Node"} actions`
      : contextMenu.kind === "edge"
        ? `${contextMenu.edgeLabel ?? contextMenu.edgeKind} edge actions`
        : "Graph actions"
    : "Graph actions";

  const groupBounds = useMemo(() => buildGraphGroupBoundsList(groups, nodes), [groups, nodes]);

  const handlePreviewGroupMove = (
    groupId: string,
    delta: { x: number; y: number },
    basePositions: Map<string, { x: number; y: number }>,
  ) => {
    setSelectedGroupId(groupId);
    setOrganizeGroupId((current) => (current === groupId ? current : undefined));
    setSelectedSemanticNodeIds([]);
    capturePendingLayoutUndo(`Moved group ${groupId}.`);
    setNodes((current) =>
      applyMemberNodeDelta(
        current,
        memberNodeIdsByGroupId.get(groupId) ?? [],
        delta,
        basePositions,
      ),
    );
  };

  const handleGroupMoveEnd = () => {
    finalizePendingLayoutUndo();
    persistCurrentCanvasState();
  };

  if (!graph || !blueprint || !fitViewOptions || !viewKey) {
    const emptyStateTitle = errorMessage
      ? "Unable to open graph"
      : isLoading
        ? "Loading graph"
        : "Blueprint canvas";
    const emptyStateBody =
      errorMessage ??
      (isLoading
        ? "Building the current graph view."
        : "Index a repo to open the architecture map. Modules appear first, then symbols and flow only when you drill down.");
    return (
      <section className="content-panel graph-panel">
        <EmptyState title={emptyStateTitle} body={emptyStateBody} />
      </section>
    );
  }

  const edges = buildCanvasEdges({
    blueprint,
    graph,
    highlightedEdgeIds,
    hoverActive,
    nodes,
    onEdgeClick: (logicalEdgeId, logicalEdgeKind, _position, _clientPosition, modifiers) => {
      if (
        logicalEdgeKind === "data" &&
        (logicalEdgeId.startsWith("data:flowbinding:") ||
          logicalEdgeId.startsWith("data:flowparam:"))
      ) {
        if (modifiers.altKey) {
          onDisconnectFlowEdge(logicalEdgeId);
          setSelectedControlEdgeIds((current) =>
            current.filter((edgeId) => edgeId !== logicalEdgeId),
          );
          return;
        }
        selectControlEdge(logicalEdgeId);
        return;
      }
      const edgeInteraction = resolveFlowEdgeInteraction({
        flowAuthoringEnabled,
        logicalEdgeKind,
        altKey: modifiers.altKey,
      });
      if (edgeInteraction === "ignore") {
        return;
      }
      if (edgeInteraction === "disconnect") {
        onDisconnectFlowEdge(logicalEdgeId);
        setSelectedControlEdgeIds((current) =>
          current.filter((edgeId) => edgeId !== logicalEdgeId),
        );
        return;
      }
      selectControlEdge(logicalEdgeId);
    },
    onEdgeContextMenu: openEdgeContextMenu,
    onEdgeHoverEnd: () => {
      setHoveredEdgeId(undefined);
      setTransientHelpTarget(null);
    },
    onEdgeHoverStart: (logicalEdgeId, logicalEdgeKind, logicalEdgeLabel) => {
      setHoveredEdgeId(logicalEdgeId);
      setTransientHelpTarget({
        id: helpIdForGraphEdgeKind(logicalEdgeKind),
        args: {
          label: logicalEdgeLabel,
        },
      });
    },
    onInsertReroute: handleInsertReroute,
    selectedControlEdgeIds: selectedControlEdgeIdSet,
    selectedConnectedEdgeIds,
    selectionContextActive,
    showEdgeLabels,
    highlightGraphPath,
  });

  return (
    <section
      ref={panelRef}
      {...helpTargetProps("graph.canvas")}
      aria-label="Graph canvas"
      className={`content-panel graph-panel${panModeActive ? " is-pan-active" : ""}${createModeActive ? " is-create-mode" : ""}`}
      data-create-mode={createModeState}
      role="region"
      tabIndex={0}
      onFocusCapture={() => {
        graphHotkeyActiveRef.current = true;
      }}
      onPointerOverCapture={() => {
        setPointerInsidePanel(true);
      }}
      onPointerOutCapture={(event) => {
        const nextTarget = event.relatedTarget;
        if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
          setPointerInsidePanel(false);
        }
      }}
      onPointerDownCapture={(event) => {
        setPointerInsidePanel(true);
        if (!isEditableEventTarget(event.target)) {
          panelRef.current?.focus();
        }
        if (panModeActive && event.button === 0) {
          setPanPointerDragging(true);
        }
      }}
      onKeyDown={(event) => {
        handleGraphShortcutKey(event);
      }}
    >
      <ReactFlow<GraphCanvasNode, GraphCanvasEdge>
        key={viewKey}
        fitView
        fitViewOptions={fitViewOptions}
        proOptions={{ hideAttribution: true }}
        onInit={(instance) => {
          reactFlowInstanceRef.current = instance;
        }}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={handleNodesChange}
        onNodeDragStart={handleNodeDragStart}
        onNodeDragStop={handleNodeDragStop}
        onSelectionDragStart={handleSelectionDragStart}
        onSelectionDragStop={handleSelectionDragStop}
        onSelectionStart={() => {
          setMarqueeSelectionActive(true);
        }}
        onSelectionEnd={() => {
          setMarqueeSelectionActive(false);
        }}
        onSelectionChange={({ nodes: selectedNodes }) => {
          if (skipNextSelectionSyncRef.current) {
            skipNextSelectionSyncRef.current = false;
            return;
          }

          const nextSelectedSemanticNodeIds = sortNodeIds(
            selectedNodes.filter(isSemanticCanvasNode).map((node) => node.id),
          );
          const hasLocalNodeSelection =
            nextSelectedSemanticNodeIds.length > 0 || selectedNodes.some(isRerouteCanvasNode);

          setSelectedSemanticNodeIds((current) =>
            sameNodeIds(current, nextSelectedSemanticNodeIds)
              ? current
              : nextSelectedSemanticNodeIds,
          );
          if (hasLocalNodeSelection && selectedControlEdgeIds.length) {
            setSelectedControlEdgeIds([]);
          }
          if (hasLocalNodeSelection && selectedGroupId) {
            setSelectedGroupId(undefined);
          }
          if (hasLocalNodeSelection && organizeGroupId) {
            setOrganizeGroupId(undefined);
          }
        }}
        nodesDraggable
        nodesConnectable={flowAuthoringEnabled}
        edgesReconnectable={flowAuthoringEnabled}
        connectionLineComponent={BlueprintConnectionLine}
        connectionLineContainerStyle={{ pointerEvents: "none", zIndex: 30 }}
        connectionRadius={FLOW_CONNECTION_RADIUS}
        reconnectRadius={FLOW_RECONNECT_RADIUS}
        deleteKeyCode={null}
        isValidConnection={(connection) =>
          flowAuthoringEnabled && isValidFlowCanvasConnection(connection)
        }
        selectionKeyCode={null}
        multiSelectionKeyCode={["Meta", "Control", "Shift"]}
        selectionOnDrag={!panModeActive && !createModeActive}
        selectionMode={SelectionMode.Partial}
        paneClickDistance={4}
        minZoom={MIN_GRAPH_ZOOM}
        maxZoom={MAX_GRAPH_ZOOM}
        zoomOnScroll={false}
        panOnScroll
        panOnScrollMode={PanOnScrollMode.Free}
        zoomActivationKeyCode="Alt"
        panOnDrag={panModeActive}
        onConnect={(connection: Connection) => {
          if (
            !flowAuthoringEnabled ||
            !connection.source ||
            !connection.target ||
            !isValidFlowCanvasConnection(connection)
          ) {
            return;
          }
          onConnectFlowEdge({
            sourceId: connection.source,
            sourceHandle: connection.sourceHandle,
            targetId: connection.target,
            targetHandle: connection.targetHandle,
          });
          setSelectedControlEdgeIds([]);
        }}
        onReconnect={(oldEdge, newConnection) => {
          const logicalEdgeId = (oldEdge.data as BlueprintEdgeData | undefined)?.logicalEdgeId;
          if (
            !flowAuthoringEnabled ||
            !logicalEdgeId ||
            !newConnection.source ||
            !newConnection.target ||
            !isValidFlowCanvasConnection(newConnection)
          ) {
            return;
          }
          onReconnectFlowEdge(logicalEdgeId, {
            sourceId: newConnection.source,
            sourceHandle: newConnection.sourceHandle,
            targetId: newConnection.target,
            targetHandle: newConnection.targetHandle,
          });
          setSelectedControlEdgeIds([]);
        }}
        onNodeClick={(event, node) => {
          const flowCreateModeSelectionOnly = createModeActive && graph.level === "flow";
          if (createModeActive && !flowCreateModeSelectionOnly) {
            if (createModeReady && createModeCanvasEnabled) {
              requestCreateIntent(
                { x: event.clientX, y: event.clientY },
                screenToFlowPosition({ x: event.clientX, y: event.clientY }),
              );
            }
            return;
          }

          if (selectedControlEdgeIds.length) {
            setSelectedControlEdgeIds([]);
          }

          if (isRerouteCanvasNode(node)) {
            setSelectedGroupId(undefined);
            setOrganizeGroupId(undefined);
            setSelectedSemanticNodeIds([]);
            setNodes((current) =>
              current.map((currentNode) => ({
                ...currentNode,
                selected: currentNode.id === node.id,
              })),
            );
            onClearSelection();
            return;
          }

          const toggleSelectionModifier = event.metaKey || event.ctrlKey;
          const shiftSelectionModifier = event.shiftKey || shiftPressedRef.current;
          const additiveSelection = toggleSelectionModifier || shiftSelectionModifier;
          const shiftOnlySelection = shiftSelectionModifier && !toggleSelectionModifier;
          const wasSelectedBeforeClick = selectedSemanticNodeIds.includes(node.id);
          skipNextSelectionSyncRef.current = additiveSelection;
          setSelectedGroupId(undefined);
          setOrganizeGroupId(undefined);
          setNodes((current) =>
            current.map((currentNode) => {
              if (isRerouteCanvasNode(currentNode)) {
                return currentNode.selected ? { ...currentNode, selected: false } : currentNode;
              }

              if (currentNode.id === node.id) {
                return {
                  ...currentNode,
                  selected: additiveSelection
                    ? shiftOnlySelection
                      ? true
                      : !wasSelectedBeforeClick
                    : true,
                };
              }

              return additiveSelection
                ? currentNode
                : {
                    ...currentNode,
                    selected: false,
                  };
            }),
          );
          setSelectedSemanticNodeIds((current) => {
            if (!additiveSelection) {
              return [node.id];
            }

            if (shiftOnlySelection) {
              return sortNodeIds(new Set([...current, node.id]));
            }

            const next = new Set(current);
            if (next.has(node.id)) {
              next.delete(node.id);
            } else {
              next.add(node.id);
            }
            return sortNodeIds(next);
          });
          onSelectNode(node.id, node.data.kind);
        }}
        onNodeDoubleClick={(event, node) => {
          if (isRerouteCanvasNode(node)) {
            return;
          }
          if (flowAuthoringEnabled && node.data.kind === "return") {
            requestExpressionGraphIntent(node.id, undefined, {
              x: event.clientX,
              y: event.clientY,
            });
            return;
          }
          if (flowAuthoringEnabled && authorableFlowNodeIds.has(node.id)) {
            onEditFlowNodeIntent({
              nodeId: node.id,
              flowPosition: screenToFlowPosition({ x: event.clientX, y: event.clientY }),
              panelPosition: {
                x: event.clientX - (panelRef.current?.getBoundingClientRect().left ?? 0),
                y: event.clientY - (panelRef.current?.getBoundingClientRect().top ?? 0),
              },
            });
            return;
          }
          node.data.onDefaultAction?.();
        }}
        onNodeContextMenu={openNodeContextMenu}
        onPaneContextMenu={openPaneContextMenu}
        onPaneClick={(event) => {
          if (createModeActive) {
            if (createModeReady && createModeCanvasEnabled) {
              requestCreateIntent(
                { x: event.clientX, y: event.clientY },
                screenToFlowPosition({ x: event.clientX, y: event.clientY }),
              );
            }
            return;
          }
          if (selectedControlEdgeIds.length) {
            setSelectedControlEdgeIds([]);
          }
          clearLocalSelection();
          onClearSelection();
        }}
      >
        <GraphGroupLayer
          groupBounds={groupBounds}
          nodes={nodes}
          selectedGroupId={selectedGroupId}
          editingGroupId={editingGroupId}
          organizeGroupId={organizeGroupId}
          editingGroupTitle={editingGroupTitle}
          onChangeEditingGroupTitle={setEditingGroupTitle}
          onApplyOrganizeMode={applyOrganizeGroup}
          onFinishGroupTitleEditing={finishGroupTitleEditing}
          onGroupMoveEnd={handleGroupMoveEnd}
          onPreviewGroupMove={handlePreviewGroupMove}
          onSelectGroup={selectGroup}
          onStartEditingGroup={beginGroupTitleEditing}
          onToggleOrganizeGroup={toggleOrganizeGroup}
          onUngroupGroup={ungroupGroup}
        />
        <Controls showInteractive={false} />
        <Background
          gap={32}
          size={1}
          color={createModeActive ? "var(--accent-strong)" : "var(--line-strong)"}
        />
      </ReactFlow>

      {contextActionError ? (
        <p className="error-copy graph-context-error">{contextActionError}</p>
      ) : null}

      {contextMenu ? (
        <AppContextMenu
          label={contextMenuLabel}
          items={contextMenuItems}
          position={contextMenu}
          onActionError={setContextActionError}
          onClose={closeContextMenu}
        />
      ) : null}

      {createModeActive ? (
        <>
          <div aria-hidden="true" className="graph-create-mode__tint" />
          <div className="graph-create-mode__badge" data-testid="graph-create-mode-badge">
            Create mode
          </div>
          <div className="graph-create-mode__watermark" data-testid="graph-create-mode-watermark">
            CREATE MODE
          </div>
          {createModeHint ? (
            <div className="graph-create-mode__hint" data-testid="graph-create-mode-hint">
              {createModeHint}
            </div>
          ) : null}
        </>
      ) : null}

      <GraphToolbar
        graph={graph}
        graphFilters={graphFilters}
        graphSettings={graphSettings}
        flowInputDisplayMode={flowInputDisplayMode}
        highlightGraphPath={highlightGraphPath}
        showEdgeLabels={showEdgeLabels}
        canUndoLayout={currentLayoutUndoStack.length > 0}
        onSelectLevel={onSelectLevel}
        onDeclutter={handleDeclutter}
        onFitView={handleFitView}
        onToggleGraphFilter={onToggleGraphFilter}
        onToggleGraphSetting={onToggleGraphSetting}
        onSetFlowInputDisplayMode={onSetFlowInputDisplayMode}
        onToggleGraphPathHighlight={onToggleGraphPathHighlight}
        onToggleEdgeLabels={onToggleEdgeLabels}
        onUndoLayout={handleUndoLayout}
      />
    </section>
  );
}

function applyNodeDecorations(
  nodes: GraphCanvasNode[],
  graph: GraphView,
  selectedNodeIds: Set<string>,
  highlightedEdgeIds: Set<string>,
  hoverActive: boolean,
  selectedRelatedNodeIds: Set<string>,
  selectedConnectedEdgeIds: Set<string>,
  selectionContextActive: boolean,
  groupedNodeIds: Set<string>,
  selectedGroupMemberNodeIds: Set<string>,
  canPinNodes: boolean,
  canConnectFlowHandles: boolean,
  onTogglePinned: (nodeId: string) => void,
  onActivateNode: (nodeId: string, kind: GraphNodeKind) => void,
  onInspectNode: (nodeId: string, kind: GraphNodeKind) => void,
  onOpenExpressionGraph: (nodeId: string, expressionNodeId?: string) => void,
  onPortHoverStart: (edgeIds: string[]) => void,
  onPortHoverEnd: () => void,
) {
  const graphNodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const blueprint = buildBlueprintPresentation(graph);

  return nodes.map((node) => {
    if (isRerouteCanvasNode(node)) {
      return {
        ...node,
        className: buildRerouteShellClassName(
          node.data.logicalEdgeId,
          highlightedEdgeIds,
          hoverActive,
          selectedConnectedEdgeIds,
          selectionContextActive,
        ),
      };
    }

    const graphNode = graphNodeById.get(node.id);
    if (!graphNode) {
      return node;
    }

    const nextClassName = buildNodeShellClassName(
      node.id,
      selectedNodeIds,
      selectedRelatedNodeIds,
      selectionContextActive,
      groupedNodeIds,
      selectedGroupMemberNodeIds,
    );
    const ports = blueprint.nodePorts.get(node.id) ?? { inputs: [], outputs: [] };
    const actions: BlueprintNodeData["actions"] = [];

    if (isEnterableGraphNodeKind(graphNode.kind)) {
      actions.push({
        id: "enter",
        label: "Enter",
        helpId: "graph.node.action.enter",
        onAction: () => onActivateNode(graphNode.id, graphNode.kind),
      });
    }

    if (isInspectableGraphNodeKind(graphNode.kind)) {
      actions.push({
        id: "inspect",
        label: "Inspect",
        helpId: "graph.node.action.inspect",
        onAction: () => onInspectNode(graphNode.id, graphNode.kind),
      });
    }

    if (canPinNodes) {
      actions.push({
        id: "pin",
        label: node.data.isPinned ? "Unpin" : "Pin",
        helpId: pinActionHelpId(Boolean(node.data.isPinned)),
        onAction: () => onTogglePinned(graphNode.id),
      });
    }

    const expressionPreview = expressionPreviewForNode(graphNode);
    return {
      ...node,
      className: nextClassName,
      data: {
        ...node.data,
        kind: graphNode.kind,
        label: moduleDisplayLabel(graphNode),
        summary: nodeSummary(graphNode),
        expressionPreview: expressionPreview
          ? {
              ...expressionPreview,
              onOpen: (expressionNodeId?: string) =>
                onOpenExpressionGraph(graphNode.id, expressionNodeId),
            }
          : undefined,
        isPinned: node.data.isPinned,
        inputPorts: decorateNodePorts(
          ports.inputs,
          highlightedEdgeIds,
          hoverActive,
          onPortHoverStart,
          onPortHoverEnd,
        ),
        outputPorts: decorateNodePorts(
          ports.outputs,
          highlightedEdgeIds,
          hoverActive,
          onPortHoverStart,
          onPortHoverEnd,
        ),
        connectable: canConnectFlowHandles,
        actions,
        onDefaultAction: actions[0]?.onAction,
      },
    };
  });
}
