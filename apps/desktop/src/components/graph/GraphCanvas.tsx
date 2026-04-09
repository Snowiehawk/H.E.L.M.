import { useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  MarkerType,
  PanOnScrollMode,
  ReactFlow,
  SelectionMode,
  applyNodeChanges,
  useKeyPress,
  type Edge,
  type EdgeTypes,
  type Node,
  type NodeChange,
  type NodeTypes,
} from "@xyflow/react";
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
  useWorkspaceHelp,
} from "../workspace/workspaceHelp";
import { buildBlueprintPresentation } from "./blueprintPorts";
import { declutterGraphLayout } from "./declutterLayout";
import {
  graphLayoutNodeKey,
  graphLayoutViewKey,
  readStoredGraphLayout,
  type StoredGraphLayout,
  type StoredGraphNodeLayout,
  type StoredGraphReroute,
  writeStoredGraphLayout,
} from "./graphLayoutPersistence";
import { EmptyState } from "../shared/EmptyState";

const REROUTE_NODE_PREFIX = "reroute:";
const REROUTE_NODE_SIZE = 18;

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

function buildNodeShellClassName(
  nodeId: string,
  selectedNodeId: string,
  selectedRelatedNodeIds: Set<string>,
  selectionContextActive: boolean,
) {
  return [
    "graph-node-shell",
    nodeId === selectedNodeId ? "is-active" : "",
    selectionContextActive && selectedRelatedNodeIds.has(nodeId) ? "is-related" : "",
    selectionContextActive && !selectedRelatedNodeIds.has(nodeId) ? "is-dimmed" : "",
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
  highlightedEdgeIds: Set<string>,
  hoverActive: boolean,
  selectedRelatedNodeIds: Set<string>,
  selectionContextActive: boolean,
  onActivateNode: (nodeId: string, kind: GraphNodeKind) => void,
  onInspectNode: (nodeId: string, kind: GraphNodeKind) => void,
  onPortHoverStart: (edgeIds: string[]) => void,
  onPortHoverEnd: () => void,
): SemanticCanvasNode[] {
  const blueprint = buildBlueprintPresentation(graph);
  return graph.nodes.map<SemanticCanvasNode>((node) => {
    const ports = blueprint.nodePorts.get(node.id) ?? { inputs: [], outputs: [] };
    const savedPosition = savedPositions[graphLayoutNodeKey(node.id, node.kind)];
    const actions: BlueprintNodeData["actions"] = [];

    if (isEnterableGraphNodeKind(node.kind)) {
      actions.push({
        id: "enter",
        label: "Enter",
        onAction: () => onActivateNode(node.id, node.kind),
      });
    }

    if (isInspectableGraphNodeKind(node.kind)) {
      actions.push({
        id: "inspect",
        label: "Inspect",
        onAction: () => onInspectNode(node.id, node.kind),
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
  onActivateNode: (nodeId: string, kind: GraphNodeKind) => void,
  onInspectNode: (nodeId: string, kind: GraphNodeKind) => void,
  onPortHoverStart: (edgeIds: string[]) => void,
  onPortHoverEnd: () => void,
): GraphCanvasNode[] {
  const savedNodePositions = layout.nodes ?? {};
  const savedReroutes = layout.reroutes ?? [];
  return [
    ...buildSemanticCanvasNodes(
      graph,
      selectedNodeId,
      savedNodePositions,
      highlightedEdgeIds,
      hoverActive,
      selectedRelatedNodeIds,
      selectionContextActive,
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

function persistGraphLayout(nodes: GraphCanvasNode[]): StoredGraphLayout {
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
  };
}

function applyStoredLayout(nodes: GraphCanvasNode[], layout: StoredGraphLayout) {
  const reroutesById = new Map(
    layout.reroutes.map((reroute) => [rerouteNodeId(reroute.id), reroute] as const),
  );

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
    if (!nextPosition) {
      return node;
    }
    return {
      ...node,
      position: nextPosition,
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
  labelSegments: Array<{
    id: string;
    label: string;
    source: string;
    target: string;
    sourceHandle: string | null | undefined;
    targetHandle: string | null | undefined;
  }>,
) {
  const offsets = new Map<string, { x: number; y: number }>();
  const groups = new Map<string, typeof labelSegments>();

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

  const labelOffsets = buildEdgeLabelOffsets(
    segmentDrafts
      .filter((edge) => typeof edge.label === "string" && edge.label.trim().length > 0)
      .map((edge) => ({
        id: edge.id,
        label: edge.label as string,
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle,
        targetHandle: edge.targetHandle,
      })),
  );

  return segmentDrafts.map<GraphCanvasEdge>((edge) => {
    const offset = labelOffsets.get(edge.id);
    const edgeData = edge.data as BlueprintEdgeData;
    return {
      ...edge,
      data: {
        logicalEdgeId: edgeData.logicalEdgeId,
        logicalEdgeKind: edgeData.logicalEdgeKind,
        logicalEdgeLabel: edgeData.logicalEdgeLabel,
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

export function GraphCanvas({
  repoPath,
  graph,
  activeNodeId,
  graphFilters,
  graphSettings,
  highlightGraphPath,
  showEdgeLabels,
  inspectorOpen,
  onSelectNode,
  onActivateNode,
  onInspectNode,
  onSelectBreadcrumb,
  onSelectLevel,
  onToggleGraphFilter,
  onToggleGraphSetting,
  onToggleGraphPathHighlight,
  onToggleEdgeLabels,
  onToggleInspector,
  onNavigateOut,
  onClearSelection,
}: {
  repoPath?: string;
  graph?: GraphView;
  activeNodeId?: string;
  graphFilters: GraphFilters;
  graphSettings: GraphSettings;
  highlightGraphPath: boolean;
  showEdgeLabels: boolean;
  inspectorOpen: boolean;
  onSelectNode: (nodeId: string, kind: GraphNodeKind) => void;
  onActivateNode: (nodeId: string, kind: GraphNodeKind) => void;
  onInspectNode: (nodeId: string, kind: GraphNodeKind) => void;
  onSelectBreadcrumb: (breadcrumb: GraphBreadcrumbDto) => void;
  onSelectLevel: (level: GraphAbstractionLevel) => void;
  onToggleGraphFilter: (key: keyof GraphFilters) => void;
  onToggleGraphSetting: (key: keyof GraphSettings) => void;
  onToggleGraphPathHighlight: () => void;
  onToggleEdgeLabels: () => void;
  onToggleInspector: () => void;
  onNavigateOut: () => void;
  onClearSelection: () => void;
}) {
  const { setTransientHelpTarget } = useWorkspaceHelp();
  const blueprint = useMemo(
    () => (graph ? buildBlueprintPresentation(graph) : undefined),
    [graph],
  );
  const denseGraph = (graph?.nodes.length ?? 0) > 12;
  const fitViewOptions = !graph
    ? undefined
    : graph.level === "flow"
      ? { padding: 0.1, minZoom: 0.4, maxZoom: 1.08 }
      : graph.level === "symbol"
        ? { padding: 0.08, minZoom: denseGraph ? 0.34 : 0.44, maxZoom: 1.2 }
        : { padding: 0.08, minZoom: denseGraph ? 0.3 : 0.4, maxZoom: 1.14 };
  const graphNodeIds = useMemo(
    () => new Set(graph?.nodes.map((node) => node.id) ?? []),
    [graph],
  );
  const viewKey = graph ? graphLayoutViewKey(graph) : undefined;
  const hydrationGenerationRef = useRef(0);
  const panelRef = useRef<HTMLElement>(null);
  const graphHotkeyActiveRef = useRef(false);
  const [nodes, setNodes] = useState<GraphCanvasNode[]>([]);
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
  const selectedRerouteNodes = useMemo(
    () => nodes.filter((node) => isRerouteCanvasNode(node) && Boolean(node.selected)),
    [nodes],
  );
  const selectedRerouteCount = selectedRerouteNodes.length;
  const selectedNodeId = !graph
    ? ""
    : selectedRerouteCount
      ? ""
      : graphNodeIds.has(activeNodeId ?? "")
        ? activeNodeId ?? ""
        : "";
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

  const clearLocalSelection = () => {
    setNodes((current) =>
      current.some((node) => node.selected)
        ? current.map((node) => (node.selected ? { ...node, selected: false } : node))
        : current,
    );
  };

  const persistCurrentLayout = (nextNodes: GraphCanvasNode[]) => {
    void writeStoredGraphLayout(repoPath, viewKey, persistGraphLayout(nextNodes));
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
      persistCurrentLayout(next);
      return next;
    });
  };

  const handleNavigateOutKey = (event: {
    key: string;
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    target: EventTarget | null;
    preventDefault: () => void;
  }) => {
    if (selectedRerouteCount && shouldHandleRerouteDeleteKey(event)) {
      event.preventDefault();
      removeSelectedReroutes();
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
        || (!shouldHandleNavigateOutKey(event) && !shouldHandleRerouteDeleteKey(event))
      ) {
        return;
      }

      handleNavigateOutKey(event);
    };

    const handlePanelKeyDown = (event: KeyboardEvent) => {
      if (!shouldHandleNavigateOutKey(event) && !shouldHandleRerouteDeleteKey(event)) {
        return;
      }

      handleNavigateOutKey(event);
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
  }, [onNavigateOut, selectedRerouteCount]);

  useEffect(() => {
    if (!selectedRerouteCount) {
      return;
    }
    onClearSelection();
  }, [onClearSelection, selectedRerouteCount]);

  useEffect(() => {
    if (!graph || !viewKey) {
      setNodes([]);
      return;
    }

    const generation = hydrationGenerationRef.current + 1;
    hydrationGenerationRef.current = generation;
    const emptyLayout: StoredGraphLayout = {
      nodes: {},
      reroutes: [],
    };
    setNodes(
      buildCanvasNodes(
        graph,
        selectedNodeId,
        emptyLayout,
        new Set<string>(),
        false,
        selectedRelatedNodeIds,
        selectedConnectedEdgeIds,
        selectionContextActive,
        onActivateNode,
        onInspectNode,
        setHoveredPortEdgeIds,
        () => setHoveredPortEdgeIds([]),
      ),
    );

    let cancelled = false;
    void readStoredGraphLayout(repoPath, viewKey).then((savedLayout) => {
      if (cancelled || hydrationGenerationRef.current !== generation) {
        return;
      }
      setNodes(
        buildCanvasNodes(
          graph,
          selectedNodeId,
          savedLayout,
          new Set<string>(),
          false,
          selectedRelatedNodeIds,
          selectedConnectedEdgeIds,
          selectionContextActive,
          onActivateNode,
          onInspectNode,
          setHoveredPortEdgeIds,
          () => setHoveredPortEdgeIds([]),
        ),
      );
    });

    return () => {
      cancelled = true;
    };
  }, [
    graph,
    onActivateNode,
    repoPath,
    selectedConnectedEdgeIds,
    selectedNodeId,
    selectedRelatedNodeIds,
    selectionContextActive,
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
    onActivateNode,
    onInspectNode,
    selectedConnectedEdgeIds,
    selectedNodeId,
    selectedRelatedNodeIds,
    selectionContextActive,
  ]);

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
    setNodes((current) => applyNodeChanges(changes, current));
  };

  const persistMovedNodes = (movedNodes: GraphCanvasNode[]) => {
    hydrationGenerationRef.current += 1;
    setNodes((current) => {
      const movedPositions = new Map(
        movedNodes.map((node) => [node.id, node.position] as const),
      );
      const next = normalizeRerouteNodeOrders(
        current.map((node) =>
          movedPositions.has(node.id)
            ? {
                ...node,
                position: movedPositions.get(node.id) ?? node.position,
              }
            : node,
        ),
      );
      persistCurrentLayout(next);
      return next;
    });
  };

  const handleNodeDragStop = (_event: unknown, draggedNode: GraphCanvasNode) => {
    setDeclutterUndo(undefined);
    persistMovedNodes([draggedNode]);
  };

  const handleSelectionDragStop = (_event: unknown, movedNodes: GraphCanvasNode[]) => {
    setDeclutterUndo(undefined);
    persistMovedNodes(movedNodes);
  };

  const handleDeclutter = () => {
    if (!graph || !viewKey || !nodes.length) {
      return;
    }

    const previousLayout = persistGraphLayout(nodes);
    const declutterableNodes = nodes.filter(isSemanticCanvasNode);
    const result = declutterGraphLayout(toDeclutterNodes(declutterableNodes), graph.edges);
    if (!result.changed) {
      return;
    }

    const nextNodes = nodes.map((node) => {
      if (!isSemanticCanvasNode(node)) {
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
    setNodes(nextNodes);
    setDeclutterUndo({
      viewKey,
      layout: previousLayout,
    });
    persistCurrentLayout(nextNodes);
  };

  const handleUndoDeclutter = () => {
    if (!viewKey || !declutterUndo || declutterUndo.viewKey !== viewKey) {
      return;
    }

    hydrationGenerationRef.current += 1;
    setNodes((current) => applyStoredLayout(current, declutterUndo.layout));
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
      persistCurrentLayout(next);
      return next;
    });
  };

  if (!graph || !blueprint || !fitViewOptions || !viewKey) {
    return (
      <section className="content-panel graph-panel">
        <EmptyState
          title="Blueprint canvas"
          body="Index a repo to open the architecture map. Modules appear first, then symbols and flow only when you drill down."
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
      onPointerDownCapture={(event) => {
        if (!isEditableEventTarget(event.target)) {
          panelRef.current?.focus();
        }
      }}
      onKeyDown={(event) => {
        handleNavigateOutKey(event);
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
        onNodeClick={(_, node) => {
          if (isRerouteCanvasNode(node)) {
            setNodes((current) =>
              current.map((currentNode) => ({
                ...currentNode,
                selected: currentNode.id === node.id,
              })),
            );
            onClearSelection();
            return;
          }
          setNodes((current) =>
            current.map((currentNode) =>
              isRerouteCanvasNode(currentNode) && currentNode.selected
                ? { ...currentNode, selected: false }
                : currentNode,
            ),
          );
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
        <Controls showInteractive={false} />
        <Background gap={32} size={1} color="var(--line-strong)" />
      </ReactFlow>

      <GraphToolbar
        graph={graph}
        graphFilters={graphFilters}
        graphSettings={graphSettings}
        highlightGraphPath={highlightGraphPath}
        showEdgeLabels={showEdgeLabels}
        inspectorOpen={inspectorOpen}
        canUndoDeclutter={Boolean(declutterUndo && declutterUndo.viewKey === viewKey)}
        onSelectBreadcrumb={onSelectBreadcrumb}
        onSelectLevel={onSelectLevel}
        onDeclutter={handleDeclutter}
        onToggleGraphFilter={onToggleGraphFilter}
        onToggleGraphSetting={onToggleGraphSetting}
        onToggleGraphPathHighlight={onToggleGraphPathHighlight}
        onToggleEdgeLabels={onToggleEdgeLabels}
        onToggleInspector={onToggleInspector}
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
    );
    const ports = blueprint.nodePorts.get(node.id) ?? { inputs: [], outputs: [] };
    const actions: BlueprintNodeData["actions"] = [];

    if (isEnterableGraphNodeKind(graphNode.kind)) {
      actions.push({
        id: "enter",
        label: "Enter",
        onAction: () => onActivateNode(graphNode.id, graphNode.kind),
      });
    }

    if (isInspectableGraphNodeKind(graphNode.kind)) {
      actions.push({
        id: "inspect",
        label: "Inspect",
        onAction: () => onInspectNode(graphNode.id, graphNode.kind),
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
