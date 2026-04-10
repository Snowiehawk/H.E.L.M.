import { useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  MarkerType,
  PanOnScrollMode,
  ReactFlow,
  SelectionMode,
  ViewportPortal,
  applyNodeChanges,
  useReactFlow,
  useKeyPress,
  type Edge,
  type EdgeTypes,
  type Node,
  type NodeChange,
  type NodeTypes,
} from "@xyflow/react";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import type {
  GraphAbstractionLevel,
  GraphBreadcrumbDto,
  GraphEdgeKind,
  GraphFilters,
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
import { GraphToolbar } from "./GraphToolbar";
import {
  BlueprintNode,
  type BlueprintNodeData,
  type BlueprintNodePort,
} from "./BlueprintNode";
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
import { layoutFlowGraph } from "./flowLayout";
import {
  graphLayoutNodeKey,
  graphLayoutViewKey,
  readStoredGraphLayout,
  type StoredGraphGroup,
  type StoredGraphLayout,
  type StoredGraphNodeLayout,
  type StoredGraphReroute,
  writeStoredGraphLayout,
} from "./graphLayoutPersistence";
import { EmptyState } from "../shared/EmptyState";

const REROUTE_NODE_PREFIX = "reroute:";
const REROUTE_NODE_SIZE = 18;
const GROUP_BOX_PADDING = 24;
const GROUP_TITLE_OFFSET = 12;
const DEFAULT_GROUP_TITLE = "Group";
const FALLBACK_GROUP_NODE_WIDTH = 252;
const FALLBACK_GROUP_NODE_HEIGHT = 96;
const EMPTY_STRING_SET = new Set<string>();

const nodeTypes: NodeTypes = {
  blueprint: BlueprintNode,
  reroute: RerouteNode,
};

const edgeTypes: EdgeTypes = {
  blueprint: BlueprintEdge,
};

const MIN_GRAPH_ZOOM = 0.12;
const MAX_GRAPH_ZOOM = 1.8;

type SemanticCanvasNode = Node<BlueprintNodeData, "blueprint">;
type RerouteCanvasNode = Node<RerouteNodeData, "reroute">;
type GraphCanvasNode = SemanticCanvasNode | RerouteCanvasNode;
type GraphCanvasEdge = Edge<BlueprintEdgeData, "blueprint">;
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

function isSemanticCanvasNode(node: GraphCanvasNode): node is SemanticCanvasNode {
  return node.type === "blueprint";
}

function isRerouteCanvasNode(node: GraphCanvasNode): node is RerouteCanvasNode {
  return node.type === "reroute";
}

function metadataNumber(node: GraphNodeDto, key: string): number | undefined {
  const value =
    node.metadata[key]
    ?? node.metadata[key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())];
  return typeof value === "number" ? value : undefined;
}

function metadataString(node: GraphNodeDto, key: string): string | undefined {
  const value =
    node.metadata[key]
    ?? node.metadata[key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())];
  return typeof value === "string" ? value : undefined;
}

function looksLikeSourcePath(value: string): boolean {
  return value.includes("/") || value.endsWith(".py");
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
      metadataString(node, "symbol_kind")
      ?? (node.kind === "symbol" ? undefined : node.kind);
    const moduleName = metadataString(node, "module_name");
    if (symbolKind && moduleName) {
      return `${symbolKind.replaceAll("_", " ")} · ${moduleName}`;
    }
  }
  return node.subtitle ?? undefined;
}

function rerouteNodeId(rerouteId: string) {
  return `${REROUTE_NODE_PREFIX}${rerouteId}`;
}

function rerouteStorageId(nodeId: string) {
  return nodeId.startsWith(REROUTE_NODE_PREFIX)
    ? nodeId.slice(REROUTE_NODE_PREFIX.length)
    : nodeId;
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
  if (
    marqueeSelectionActive
    || selectedRerouteCount
    || selectedGroupId
    || effectiveSemanticSelection.length > 1
  ) {
    return "";
  }

  return effectiveSemanticSelection[0]
    ?? (graphNodeIds.has(activeNodeId ?? "") ? activeNodeId ?? "" : "");
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
        (group.memberNodeIds ?? []).filter((memberNodeId) => (
          liveNodeIds.has(memberNodeId)
          && !claimedNodeIds.has(memberNodeId)
        )),
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

function touchedGroupIdsForNodeIds(
  nodeIds: Iterable<string>,
  groupByNodeId: Map<string, string>,
) {
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
  selectedNodeId: string,
  selectedRelatedNodeIds: Set<string>,
  selectionContextActive: boolean,
  groupedNodeIds: Set<string>,
  selectedGroupMemberNodeIds: Set<string>,
) {
  return [
    "graph-node-shell",
    nodeId === selectedNodeId ? "is-active" : "",
    selectionContextActive && selectedRelatedNodeIds.has(nodeId) ? "is-related" : "",
    selectionContextActive && !selectedRelatedNodeIds.has(nodeId) ? "is-dimmed" : "",
    groupedNodeIds.has(nodeId) ? "is-group-member" : "",
    selectedGroupMemberNodeIds.has(nodeId) ? "is-group-selected" : "",
  ].filter(Boolean).join(" ");
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

  return [
    "graph-reroute-shell",
    related ? "is-related" : "",
    dimmed ? "is-dimmed" : "",
  ].filter(Boolean).join(" ");
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
  selectedNodeId: string,
  savedPositions: StoredGraphNodeLayout,
  pinnedNodeIds: Set<string>,
  highlightedEdgeIds: Set<string>,
  hoverActive: boolean,
  selectedRelatedNodeIds: Set<string>,
  selectionContextActive: boolean,
  groupedNodeIds: Set<string>,
  selectedGroupMemberNodeIds: Set<string>,
  canPinNodes: boolean,
  onTogglePinned: (nodeId: string) => void,
  onActivateNode: (nodeId: string, kind: GraphNodeKind) => void,
  onInspectNode: (nodeId: string, kind: GraphNodeKind) => void,
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

    return {
      id: node.id,
      position: savedPosition ?? { x: node.x, y: node.y },
      type: "blueprint",
      data: {
        kind: node.kind,
        label: moduleDisplayLabel(node),
        summary: nodeSummary(node),
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
        actions,
        onDefaultAction: actions[0]?.onAction,
      },
      draggable: true,
      selectable: true,
      className: buildNodeShellClassName(
        node.id,
        selectedNodeId,
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
  selectedNodeId: string,
  layout: StoredGraphLayout,
  highlightedEdgeIds: Set<string>,
  hoverActive: boolean,
  selectedRelatedNodeIds: Set<string>,
  selectedConnectedEdgeIds: Set<string>,
  selectionContextActive: boolean,
  groupedNodeIds: Set<string>,
  selectedGroupMemberNodeIds: Set<string>,
  canPinNodes: boolean,
  onTogglePinned: (nodeId: string) => void,
  onActivateNode: (nodeId: string, kind: GraphNodeKind) => void,
  onInspectNode: (nodeId: string, kind: GraphNodeKind) => void,
  onPortHoverStart: (edgeIds: string[]) => void,
  onPortHoverEnd: () => void,
): GraphCanvasNode[] {
  const savedNodePositions = layout.nodes ?? {};
  const savedReroutes = layout.reroutes ?? [];
  const pinnedNodeIds = new Set(layout.pinnedNodeIds ?? []);
  return [
    ...buildSemanticCanvasNodes(
      graph,
      selectedNodeId,
      savedNodePositions,
      pinnedNodeIds,
      highlightedEdgeIds,
      hoverActive,
      selectedRelatedNodeIds,
      selectionContextActive,
      groupedNodeIds,
      selectedGroupMemberNodeIds,
      canPinNodes,
      onTogglePinned,
      onActivateNode,
      onInspectNode,
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
          left.edgeId.localeCompare(right.edgeId)
          || left.order - right.order
          || left.id.localeCompare(right.id),
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

function readMeasuredDimension(
  node: GraphCanvasNode,
  key: "width" | "height",
) {
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

function semanticNodeDimension(
  node: SemanticCanvasNode,
  key: "width" | "height",
) {
  return readMeasuredDimension(node, key)
    ?? (key === "width" ? FALLBACK_GROUP_NODE_WIDTH : FALLBACK_GROUP_NODE_HEIGHT);
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
    !Number.isFinite(minX)
    || !Number.isFinite(minY)
    || !Number.isFinite(maxX)
    || !Number.isFinite(maxY)
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

function buildGraphGroupBoundsList(
  groups: StoredGraphGroup[],
  nodes: GraphCanvasNode[],
) {
  const nodesById = new Map(nodes.map((node) => [node.id, node] as const));
  return groups.flatMap((group) => {
    const bounds = buildGraphGroupBounds(group, nodesById);
    return bounds ? [bounds] : [];
  });
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
  memberNodeIdsByGroupId: Map<string, string[]>,
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
  return nodes
    .filter(isSemanticCanvasNode)
    .map((node) => ({
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
    !Object.keys(layout.nodes).length
    && !layout.reroutes.length
    && !(layout.pinnedNodeIds?.length ?? 0)
    && !(layout.groups?.length ?? 0)
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
    touchedGroupIds.length === 1
    && sameNodeIds(
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

export function renameGraphGroup(
  groups: StoredGraphGroup[],
  groupId: string,
  title: string,
) {
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

function shouldHandleNavigateOutKey(event: {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  target: EventTarget | null;
}) {
  return !(
    event.key !== "Backspace"
    || event.altKey
    || event.ctrlKey
    || event.metaKey
    || event.shiftKey
    || isEditableEventTarget(event.target)
  );
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
    (event.key !== "Backspace" && event.key !== "Delete")
    || event.altKey
    || event.ctrlKey
    || event.metaKey
    || event.shiftKey
    || isEditableEventTarget(event.target)
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
    event.key.toLowerCase() !== "p"
    || event.altKey
    || event.ctrlKey
    || event.metaKey
    || isEditableEventTarget(event.target)
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
    event.key.toLowerCase() !== "f"
    || event.altKey
    || event.ctrlKey
    || event.metaKey
    || event.shiftKey
    || isEditableEventTarget(event.target)
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
    event.key.toLowerCase() !== "g"
    || event.altKey
    || !(event.ctrlKey || event.metaKey)
    || event.shiftKey
    || isEditableEventTarget(event.target)
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
    event.key.toLowerCase() !== "g"
    || event.altKey
    || !(event.ctrlKey || event.metaKey)
    || !event.shiftKey
    || isEditableEventTarget(event.target)
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
        .sort((left, right) => left.data.order - right.data.order || left.id.localeCompare(right.id)),
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

export function buildEdgeLabelOffsets(
  labelSegments: EdgeLabelSegment[],
) {
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
        (left, right) =>
          left.label.localeCompare(right.label)
          || left.id.localeCompare(right.id),
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
        axis === "x"
          ? { x: centerOffset, y: -10 }
          : { x: 14, y: centerOffset },
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
  onEdgeHoverEnd,
  onEdgeHoverStart,
  onInsertReroute,
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
    const edgeHovered = highlightedEdgeIds.has(edge.id);
    const selectionHighlighted = selectionContextActive && connected;
    const highlighted = hoverActive
      ? edgeHovered
      : selectionContextActive
        ? selectionHighlighted
        : highlightGraphPath && connected;
    const dimmed = hoverActive
      ? !edgeHovered
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
          onHoverStart: onEdgeHoverStart,
          onHoverEnd: onEdgeHoverEnd,
          onInsertReroute,
        },
        label,
        animated: highlighted && (edge.kind === "calls" || edge.kind === "controls"),
        style: {
          stroke,
          strokeWidth: highlighted ? 2.8 : edge.kind === "data" ? 1.8 : edge.kind === "contains" ? 1 : 1.2,
          strokeDasharray: edge.kind === "data" ? "8 6" : edge.kind === "controls" ? "0" : undefined,
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
  editingGroupTitle,
  onChangeEditingGroupTitle,
  onFinishGroupTitleEditing,
  onGroupMoveEnd,
  onPreviewGroupMove,
  onSelectGroup,
  onStartEditingGroup,
  onUngroupGroup,
}: {
  groupBounds: GraphGroupBounds[];
  nodes: GraphCanvasNode[];
  selectedGroupId?: string;
  editingGroupId?: string;
  editingGroupTitle: string;
  onChangeEditingGroupTitle: (title: string) => void;
  onFinishGroupTitleEditing: (groupId: string, mode: "save" | "cancel") => void;
  onGroupMoveEnd: () => void;
  onPreviewGroupMove: (
    groupId: string,
    delta: { x: number; y: number },
    basePositions: Map<string, { x: number; y: number }>,
  ) => void;
  onSelectGroup: (groupId: string) => void;
  onStartEditingGroup: (groupId: string) => void;
  onUngroupGroup: (groupId: string, title: string) => void;
}) {
  const { screenToFlowPosition } = useReactFlow<GraphCanvasNode, GraphCanvasEdge>();

  return (
    <ViewportPortal>
      {groupBounds.map((group) => (
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
          onPointerDown={(event) => {
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
          }}
        >
          <div className="graph-group__frame" />
          <div
            className="graph-group__title-anchor"
            style={{
              transform: `translate(${GROUP_BOX_PADDING}px, calc(-100% - ${GROUP_TITLE_OFFSET}px))`,
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
            )}
          </div>
        </div>
      ))}
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
  highlightGraphPath,
  showEdgeLabels,
  onSelectNode,
  onActivateNode,
  onInspectNode,
  onSelectBreadcrumb,
  onSelectLevel,
  onToggleGraphFilter,
  onToggleGraphSetting,
  onToggleGraphPathHighlight,
  onToggleEdgeLabels,
  onNavigateOut,
  onClearSelection,
}: {
  repoPath?: string;
  graph?: GraphView;
  isLoading?: boolean;
  errorMessage?: string | null;
  activeNodeId?: string;
  graphFilters: GraphFilters;
  graphSettings: GraphSettings;
  highlightGraphPath: boolean;
  showEdgeLabels: boolean;
  onSelectNode: (nodeId: string, kind: GraphNodeKind) => void;
  onActivateNode: (nodeId: string, kind: GraphNodeKind) => void;
  onInspectNode: (nodeId: string, kind: GraphNodeKind) => void;
  onSelectBreadcrumb: (breadcrumb: GraphBreadcrumbDto) => void;
  onSelectLevel: (level: GraphAbstractionLevel) => void;
  onToggleGraphFilter: (key: keyof GraphFilters) => void;
  onToggleGraphSetting: (key: keyof GraphSettings) => void;
  onToggleGraphPathHighlight: () => void;
  onToggleEdgeLabels: () => void;
  onNavigateOut: () => void;
  onClearSelection: () => void;
}) {
  const { setTransientHelpTarget } = useWorkspaceHelp();
  const blueprint = useMemo(
    () => (graph ? buildBlueprintPresentation(graph) : undefined),
    [graph],
  );
  const denseGraph = (graph?.nodes.length ?? 0) > 12;
  const fitViewOptions = useMemo(
    () => !graph
      ? undefined
      : graph.level === "flow"
        ? { padding: 0.1, minZoom: 0.4, maxZoom: 1.08 }
        : graph.level === "symbol"
          ? { padding: 0.08, minZoom: denseGraph ? 0.34 : 0.44, maxZoom: 1.2 }
          : { padding: 0.08, minZoom: denseGraph ? 0.3 : 0.4, maxZoom: 1.14 },
    [denseGraph, graph],
  );
  const graphNodeIds = useMemo(
    () => new Set(graph?.nodes.map((node) => node.id) ?? []),
    [graph],
  );
  const viewKey = graph ? graphLayoutViewKey(graph) : undefined;
  const hydrationGenerationRef = useRef(0);
  const panelRef = useRef<HTMLElement>(null);
  const graphHotkeyActiveRef = useRef(false);
  const [nodes, setNodes] = useState<GraphCanvasNode[]>([]);
  const [groups, setGroups] = useState<StoredGraphGroup[]>([]);
  const [selectedSemanticNodeIds, setSelectedSemanticNodeIds] = useState<string[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string | undefined>(undefined);
  const [editingGroupId, setEditingGroupId] = useState<string | undefined>(undefined);
  const [editingGroupTitle, setEditingGroupTitle] = useState(DEFAULT_GROUP_TITLE);
  const [marqueeSelectionActive, setMarqueeSelectionActive] = useState(false);
  const [declutterUndo, setDeclutterUndo] = useState<
    | {
        viewKey: string;
        layout: StoredGraphLayout;
      }
    | undefined
  >(undefined);
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | undefined>(undefined);
  const [hoveredPortEdgeIds, setHoveredPortEdgeIds] = useState<string[]>([]);
  const panModeActive = useKeyPress("Space");
  const [pointerInsidePanel, setPointerInsidePanel] = useState(false);
  const [panPointerDragging, setPanPointerDragging] = useState(false);
  const selectedRerouteNodes = useMemo(
    () => nodes.filter((node) => isRerouteCanvasNode(node) && Boolean(node.selected)),
    [nodes],
  );
  const selectedRerouteCount = selectedRerouteNodes.length;
  const { groupByNodeId, memberNodeIdsByGroupId } = useMemo(
    () => buildGroupMembership(groups),
    [groups],
  );
  const groupedNodeIds = useMemo(
    () => new Set(sortNodeIds(groupByNodeId.keys())),
    [groupByNodeId],
  );
  const semanticSelection = useMemo(
    () => sortNodeIds(selectedSemanticNodeIds.filter((nodeId) => graphNodeIds.has(nodeId))),
    [graphNodeIds, selectedSemanticNodeIds],
  );
  const semanticSelectionFromNodes = useMemo(
    () => sortNodeIds(
      nodes
        .filter((node) => isSemanticCanvasNode(node) && Boolean(node.selected))
        .map((node) => node.id),
    ),
    [nodes],
  );
  const effectiveSemanticSelection = semanticSelection.length
    ? semanticSelection
    : semanticSelectionFromNodes;
  const selectedGroupMemberNodeIds = useMemo(
    () => new Set(selectedGroupId ? memberNodeIdsByGroupId.get(selectedGroupId) ?? [] : []),
    [memberNodeIdsByGroupId, selectedGroupId],
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
    () => new Set(
      hoveredPortEdgeIds.length
        ? hoveredPortEdgeIds
        : hoveredEdgeId
          ? [hoveredEdgeId]
          : [],
    ),
    [hoveredEdgeId, hoveredPortEdgeIds],
  );
  const hoverActive = highlightedEdgeIds.size > 0;
  const selectedConnectedEdgeIds = useMemo(
    () =>
      new Set(
        (graph?.edges ?? [])
          .filter((edge) => edge.source === selectedNodeId || edge.target === selectedNodeId)
          .map((edge) => edge.id),
      ),
    [graph?.edges, selectedNodeId],
  );
  const selectedRelatedNodeIds = useMemo(() => {
    const related = new Set<string>();
    if (!selectedNodeId) {
      return related;
    }

    related.add(selectedNodeId);
    (graph?.edges ?? []).forEach((edge) => {
      if (edge.source === selectedNodeId || edge.target === selectedNodeId) {
        related.add(edge.source);
        related.add(edge.target);
      }
    });
    return related;
  }, [graph?.edges, selectedNodeId]);
  const selectionContextActive = Boolean(selectedNodeId);
  const canPinNodes = graph?.level === "flow";

  const clearLocalSelection = () => {
    setSelectedSemanticNodeIds([]);
    setSelectedGroupId(undefined);
    setNodes((current) =>
      current.some((node) => node.selected)
        ? current.map((node) => (node.selected ? { ...node, selected: false } : node))
        : current,
    );
  };

  const persistCurrentLayout = (
    nextNodes: GraphCanvasNode[],
    nextGroups: StoredGraphGroup[] = groups,
  ) => {
    void writeStoredGraphLayout(repoPath, viewKey, persistGraphLayout(nextNodes, nextGroups));
  };

  const persistCurrentCanvasState = () => {
    hydrationGenerationRef.current += 1;
    setNodes((current) => {
      persistCurrentLayout(current, groups);
      return current;
    });
  };

  const selectGroup = (groupId: string) => {
    setSelectedGroupId(groupId);
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
    setEditingGroupId(groupId);
    setEditingGroupTitle(group.title);
  };

  const finishGroupTitleEditing = (
    groupId: string,
    mode: "save" | "cancel",
  ) => {
    if (editingGroupId !== groupId) {
      return;
    }

    if (mode === "cancel") {
      setEditingGroupId(undefined);
      setEditingGroupTitle(DEFAULT_GROUP_TITLE);
      return;
    }

    const nextGroups = renameGraphGroup(groups, groupId, editingGroupTitle);
    hydrationGenerationRef.current += 1;
    setGroups(nextGroups);
    persistCurrentLayout(nodes, nextGroups);
    setEditingGroupId(undefined);
    setEditingGroupTitle(DEFAULT_GROUP_TITLE);
  };

  const togglePinnedNodes = (nodeIds: string[]) => {
    if (!canPinNodes || !nodeIds.length) {
      return;
    }

    hydrationGenerationRef.current += 1;
    setDeclutterUndo(undefined);
    setNodes((current) => {
      const targetNodeIds = expandGroupedNodeIds(nodeIds, groupByNodeId, memberNodeIdsByGroupId);
      const semanticNodesById = new Map(
        current
          .filter(isSemanticCanvasNode)
          .map((node) => [node.id, node] as const),
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
          const shouldPin = memberNodeIds.some((memberNodeId) => (
            !semanticNodesById.get(memberNodeId)?.data.isPinned
          ));
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
      persistCurrentLayout(next);
      return next;
    });
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

    hydrationGenerationRef.current += 1;
    setDeclutterUndo(undefined);
    setNodes((current) =>
      current.some((node) => node.selected)
        ? current.map((node) => (node.selected ? { ...node, selected: false } : node))
        : current,
    );
    setGroups(nextGroups);
    setSelectedSemanticNodeIds([]);
    setSelectedGroupId(nextGroupId);
    setEditingGroupId(nextGroupId);
    setEditingGroupTitle(DEFAULT_GROUP_TITLE);
    persistCurrentLayout(nodes, nextGroups);
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

    hydrationGenerationRef.current += 1;
    setDeclutterUndo(undefined);
    setGroups(nextGroups);
    if (selectedGroupId && removedGroupIds.includes(selectedGroupId)) {
      setSelectedGroupId(undefined);
    }
    if (editingGroupId && removedGroupIds.includes(editingGroupId)) {
      setEditingGroupId(undefined);
      setEditingGroupTitle(DEFAULT_GROUP_TITLE);
    }
    persistCurrentLayout(nodes, nextGroups);
  };

  const ungroupGroup = async (groupId: string, title: string) => {
    const confirmed = await confirmDialog(
      `Ungroup "${title}"?`,
      {
        title: "Ungroup nodes",
        kind: "warning",
        okLabel: "Ungroup",
        cancelLabel: "Cancel",
      },
    );
    if (!confirmed) {
      return;
    }

    const { changed, nextGroups, removedGroupIds } = ungroupGroupsForSelection(groups, [], groupId);
    if (!changed) {
      return;
    }

    hydrationGenerationRef.current += 1;
    setDeclutterUndo(undefined);
    setGroups(nextGroups);
    if (selectedGroupId && removedGroupIds.includes(selectedGroupId)) {
      setSelectedGroupId(undefined);
    }
    if (editingGroupId && removedGroupIds.includes(editingGroupId)) {
      setEditingGroupId(undefined);
      setEditingGroupTitle(DEFAULT_GROUP_TITLE);
    }
    persistCurrentLayout(nodes, nextGroups);
  };

  const removeSelectedReroutes = () => {
    hydrationGenerationRef.current += 1;
    setDeclutterUndo(undefined);
    setNodes((current) => {
      const selectedIds = new Set(
        current
          .filter((node) => isRerouteCanvasNode(node) && Boolean(node.selected))
          .map((node) => node.id),
      );
      if (!selectedIds.size) {
        return current;
      }

      const next = normalizeRerouteNodeOrders(
        current.filter((node) => !selectedIds.has(node.id)),
      );
      persistCurrentLayout(next, groups);
      return next;
    });
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
      return;
    }

    if (!shouldHandleNavigateOutKey(event)) {
      return;
    }

    event.preventDefault();
    onNavigateOut();
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
        panelRef.current
        && event.target instanceof Node
        && panelRef.current.contains(event.target),
      );
      const panelContainsFocus = Boolean(
        panelRef.current
        && document.activeElement instanceof Node
        && panelRef.current.contains(document.activeElement),
      );

      if (
        !(graphHotkeyActiveRef.current || panelContainsTarget || panelContainsFocus)
        || (!shouldHandleFitViewKey(event)
          && !shouldHandleNavigateOutKey(event)
          && !shouldHandleRerouteDeleteKey(event)
          && !shouldHandlePinKey(event)
          && !shouldHandleGroupKey(event)
          && !shouldHandleUngroupKey(event))
      ) {
        return;
      }

      handleGraphShortcutKey(event);
    };

    const handlePanelKeyDown = (event: KeyboardEvent) => {
      if (
        !shouldHandleFitViewKey(event)
        && !shouldHandleNavigateOutKey(event)
        && !shouldHandleRerouteDeleteKey(event)
        && !shouldHandlePinKey(event)
        && !shouldHandleGroupKey(event)
        && !shouldHandleUngroupKey(event)
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
    onNavigateOut,
    selectedGroupId,
    selectedNodeId,
    selectedRerouteCount,
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
    if (typeof document === "undefined") {
      return;
    }

    const showPanCursor = panModeActive && (pointerInsidePanel || panPointerDragging);
    document.body.classList.toggle("graph-pan-cursor-active", showPanCursor && !panPointerDragging);
    document.body.classList.toggle("graph-pan-cursor-dragging", showPanCursor && panPointerDragging);

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
    if (!graph || !viewKey) {
      setNodes([]);
      setGroups([]);
      setSelectedSemanticNodeIds([]);
      setSelectedGroupId(undefined);
      setEditingGroupId(undefined);
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
    const initialNodes = buildCanvasNodes(
      graph,
      "",
      emptyLayout,
      EMPTY_STRING_SET,
      false,
      EMPTY_STRING_SET,
      EMPTY_STRING_SET,
      false,
      EMPTY_STRING_SET,
      EMPTY_STRING_SET,
      canPinNodes,
      togglePinnedNode,
      onActivateNode,
      onInspectNode,
      setHoveredPortEdgeIds,
      () => setHoveredPortEdgeIds([]),
    );
    setNodes(initialNodes);
    setGroups([]);
    setSelectedSemanticNodeIds([]);
    setSelectedGroupId(undefined);
    setEditingGroupId(undefined);
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
            "",
            initializedLayout,
            EMPTY_STRING_SET,
            false,
            EMPTY_STRING_SET,
            EMPTY_STRING_SET,
            false,
            EMPTY_STRING_SET,
            EMPTY_STRING_SET,
            canPinNodes,
            togglePinnedNode,
            onActivateNode,
            onInspectNode,
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
          "",
          normalizedLayout,
          EMPTY_STRING_SET,
          false,
          EMPTY_STRING_SET,
          EMPTY_STRING_SET,
          false,
          new Set(normalizedGroups.flatMap((group) => group.memberNodeIds)),
          EMPTY_STRING_SET,
          canPinNodes,
          togglePinnedNode,
          onActivateNode,
          onInspectNode,
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
    onActivateNode,
    onInspectNode,
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
        selectedNodeId,
        highlightedEdgeIds,
        hoverActive,
        selectedRelatedNodeIds,
        selectedConnectedEdgeIds,
        selectionContextActive,
        groupedNodeIds,
        selectedGroupMemberNodeIds,
        canPinNodes,
        togglePinnedNode,
        onActivateNode,
        onInspectNode,
        setHoveredPortEdgeIds,
        () => setHoveredPortEdgeIds([]),
      ),
    );
  }, [
    graph,
    highlightedEdgeIds,
    hoverActive,
    canPinNodes,
    onActivateNode,
    onInspectNode,
    selectedConnectedEdgeIds,
    groupedNodeIds,
    selectedNodeId,
    selectedGroupMemberNodeIds,
    selectedRelatedNodeIds,
    selectionContextActive,
  ]);

  useEffect(() => {
    if (selectedGroupId && !groups.some((group) => group.id === selectedGroupId)) {
      setSelectedGroupId(undefined);
    }
    if (editingGroupId && !groups.some((group) => group.id === editingGroupId)) {
      setEditingGroupId(undefined);
      setEditingGroupTitle(DEFAULT_GROUP_TITLE);
    }
  }, [editingGroupId, groups, selectedGroupId]);

  useEffect(() => {
    setDeclutterUndo(undefined);
  }, [viewKey]);

  useEffect(() => {
    setHoveredEdgeId(undefined);
    setHoveredPortEdgeIds([]);
    setTransientHelpTarget(null);
  }, [setTransientHelpTarget, viewKey]);

  useEffect(() => () => {
    setTransientHelpTarget(null);
  }, [setTransientHelpTarget]);

  const handleNodesChange = (changes: NodeChange<GraphCanvasNode>[]) => {
    setNodes((current) =>
      applyGroupedPositionChanges(
        current,
        changes,
        groupByNodeId,
        memberNodeIdsByGroupId,
      ),
    );
  };

  const handleNodeDragStop = () => {
    setDeclutterUndo(undefined);
    persistCurrentCanvasState();
  };

  const handleSelectionDragStop = () => {
    setDeclutterUndo(undefined);
    persistCurrentCanvasState();
  };

  const handleDeclutter = () => {
    if (!graph || !viewKey || !nodes.length) {
      return;
    }

    const previousLayout = persistGraphLayout(nodes, groups);
    const result = graph.level === "flow"
      ? layoutFlowGraph(toFlowLayoutNodes(nodes, graph), graph.edges, semanticPinnedNodeIds(nodes))
      : declutterGraphLayout(
          toDeclutterNodes(nodes.filter(isSemanticCanvasNode)),
          graph.edges,
        );
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
    setDeclutterUndo({
      viewKey,
      layout: previousLayout,
    });
    persistCurrentLayout(nextNodes, groups);
  };

  const handleUndoDeclutter = () => {
    if (!viewKey || !declutterUndo || declutterUndo.viewKey !== viewKey) {
      return;
    }

    hydrationGenerationRef.current += 1;
    setNodes((current) => applyStoredLayout(current, declutterUndo.layout));
    setGroups(declutterUndo.layout.groups ?? []);
    void writeStoredGraphLayout(repoPath, viewKey, declutterUndo.layout);
    setDeclutterUndo(undefined);
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
    setDeclutterUndo(undefined);
    setNodes((current) => {
      const edgeReroutes = current
        .filter(
          (node): node is RerouteCanvasNode =>
            isRerouteCanvasNode(node) && node.data.logicalEdgeId === logicalEdgeId,
        )
        .sort((left, right) => left.data.order - right.data.order || left.id.localeCompare(right.id));
      const insertAt = Math.max(0, Math.min(segmentIndex, edgeReroutes.length));
      const next = normalizeRerouteNodeOrders([
        ...current.map((node) => {
          if (
            !isRerouteCanvasNode(node)
            || node.data.logicalEdgeId !== logicalEdgeId
            || node.data.order < insertAt
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
      persistCurrentLayout(next, groups);
      return next;
    });
  };

  const groupBounds = useMemo(
    () => buildGraphGroupBoundsList(groups, nodes),
    [groups, nodes],
  );

  const handlePreviewGroupMove = (
    groupId: string,
    delta: { x: number; y: number },
    basePositions: Map<string, { x: number; y: number }>,
  ) => {
    setSelectedGroupId(groupId);
    setSelectedSemanticNodeIds([]);
    setDeclutterUndo(undefined);
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
    persistCurrentCanvasState();
  };

  if (!graph || !blueprint || !fitViewOptions || !viewKey) {
    const emptyStateTitle = errorMessage
      ? "Unable to open graph"
      : isLoading
        ? "Loading graph"
        : "Blueprint canvas";
    const emptyStateBody = errorMessage
      ?? (isLoading
        ? "Building the current graph view."
        : "Index a repo to open the architecture map. Modules appear first, then symbols and flow only when you drill down.");
    return (
      <section className="content-panel graph-panel">
        <EmptyState
          title={emptyStateTitle}
          body={emptyStateBody}
        />
      </section>
    );
  }

  const edges = buildCanvasEdges({
    blueprint,
    graph,
    highlightedEdgeIds,
    hoverActive,
    nodes,
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
      className={`content-panel graph-panel${panModeActive ? " is-pan-active" : ""}`}
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
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={handleNodesChange}
        onNodeDragStop={handleNodeDragStop}
        onSelectionDragStop={handleSelectionDragStop}
        onSelectionStart={() => {
          setMarqueeSelectionActive(true);
        }}
        onSelectionEnd={() => {
          setMarqueeSelectionActive(false);
        }}
        onSelectionChange={({ nodes: selectedNodes }) => {
          const nextSelectedSemanticNodeIds = sortNodeIds(
            selectedNodes
              .filter(isSemanticCanvasNode)
              .map((node) => node.id),
          );
          const hasLocalNodeSelection = nextSelectedSemanticNodeIds.length > 0
            || selectedNodes.some(isRerouteCanvasNode);

          setSelectedSemanticNodeIds((current) =>
            sameNodeIds(current, nextSelectedSemanticNodeIds)
              ? current
              : nextSelectedSemanticNodeIds,
          );
          if (hasLocalNodeSelection && selectedGroupId) {
            setSelectedGroupId(undefined);
          }
        }}
        nodesDraggable
        nodesConnectable={false}
        selectionKeyCode={null}
        selectionOnDrag={!panModeActive}
        selectionMode={SelectionMode.Partial}
        paneClickDistance={4}
        minZoom={MIN_GRAPH_ZOOM}
        maxZoom={MAX_GRAPH_ZOOM}
        zoomOnScroll={false}
        panOnScroll
        panOnScrollMode={PanOnScrollMode.Free}
        zoomActivationKeyCode="Alt"
        panOnDrag={panModeActive}
        onNodeClick={(event, node) => {
          if (isRerouteCanvasNode(node)) {
            setSelectedGroupId(undefined);
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

          const additiveSelection = event.metaKey || event.ctrlKey;
          setSelectedGroupId(undefined);
          setNodes((current) =>
            current.map((currentNode) => {
              if (isRerouteCanvasNode(currentNode)) {
                return currentNode.selected
                  ? { ...currentNode, selected: false }
                  : currentNode;
              }

              if (currentNode.id === node.id) {
                return {
                  ...currentNode,
                  selected: additiveSelection ? !Boolean(currentNode.selected) : true,
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
        onNodeDoubleClick={(_, node) => {
          if (isRerouteCanvasNode(node)) {
            return;
          }
          node.data.onDefaultAction?.();
        }}
        onPaneClick={() => {
          clearLocalSelection();
          onClearSelection();
        }}
      >
        <GraphGroupLayer
          groupBounds={groupBounds}
          nodes={nodes}
          selectedGroupId={selectedGroupId}
          editingGroupId={editingGroupId}
          editingGroupTitle={editingGroupTitle}
          onChangeEditingGroupTitle={setEditingGroupTitle}
          onFinishGroupTitleEditing={finishGroupTitleEditing}
          onGroupMoveEnd={handleGroupMoveEnd}
          onPreviewGroupMove={handlePreviewGroupMove}
          onSelectGroup={selectGroup}
          onStartEditingGroup={beginGroupTitleEditing}
          onUngroupGroup={ungroupGroup}
        />
        <Controls showInteractive={false} />
        <Background gap={32} size={1} color="var(--line-strong)" />
      </ReactFlow>

      <GraphToolbar
        graph={graph}
        graphFilters={graphFilters}
        graphSettings={graphSettings}
        highlightGraphPath={highlightGraphPath}
        showEdgeLabels={showEdgeLabels}
        canUndoDeclutter={Boolean(declutterUndo && declutterUndo.viewKey === viewKey)}
        onSelectLevel={onSelectLevel}
        onDeclutter={handleDeclutter}
        onFitView={handleFitView}
        onToggleGraphFilter={onToggleGraphFilter}
        onToggleGraphSetting={onToggleGraphSetting}
        onToggleGraphPathHighlight={onToggleGraphPathHighlight}
        onToggleEdgeLabels={onToggleEdgeLabels}
        onUndoDeclutter={handleUndoDeclutter}
      />
    </section>
  );
}

function applyNodeDecorations(
  nodes: GraphCanvasNode[],
  graph: GraphView,
  selectedNodeId: string,
  highlightedEdgeIds: Set<string>,
  hoverActive: boolean,
  selectedRelatedNodeIds: Set<string>,
  selectedConnectedEdgeIds: Set<string>,
  selectionContextActive: boolean,
  groupedNodeIds: Set<string>,
  selectedGroupMemberNodeIds: Set<string>,
  canPinNodes: boolean,
  onTogglePinned: (nodeId: string) => void,
  onActivateNode: (nodeId: string, kind: GraphNodeKind) => void,
  onInspectNode: (nodeId: string, kind: GraphNodeKind) => void,
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
      selectedNodeId,
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

    return {
      ...node,
      className: nextClassName,
      data: {
        ...node.data,
        kind: graphNode.kind,
        label: moduleDisplayLabel(graphNode),
        summary: nodeSummary(graphNode),
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
        actions,
        onDefaultAction: actions[0]?.onAction,
      },
    };
  });
}
