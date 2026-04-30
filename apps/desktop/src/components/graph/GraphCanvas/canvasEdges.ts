import { MarkerType } from "@xyflow/react";
import type { GraphEdgeKind, GraphView } from "../../../lib/adapter";
import { buildBlueprintPresentation } from "../blueprintPorts";
import type { BlueprintEdgeData } from "../BlueprintEdge";
import { readMeasuredDimension } from "./layoutHelpers";
import type {
  CollapsedEdgeLabel,
  EdgeLabelSegment,
  GraphCanvasEdge,
  GraphCanvasNode,
  RerouteCanvasNode,
} from "./types";
import { isRerouteCanvasNode } from "./types";

export function nodeCenter(node: GraphCanvasNode) {
  const width = readMeasuredDimension(node, "width") ?? 0;
  const height = readMeasuredDimension(node, "height") ?? 0;
  return {
    x: node.position.x + width / 2,
    y: node.position.y + height / 2,
  };
}

export function rerouteHandleId(
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

export function buildLogicalEdgeGroups(nodes: GraphCanvasNode[]) {
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

export function buildEdgeStroke(kind: GraphEdgeKind, highlighted: boolean) {
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

export function estimateEdgeLabelWidth(label: string) {
  return Math.max(48, Math.round(label.trim().length * 7.2) + 22);
}

export function inferLabelOffsetAxis(
  sourceHandle: string | null | undefined,
  targetHandle: string | null | undefined,
) {
  const handleSignature = `${sourceHandle ?? ""}|${targetHandle ?? ""}`;
  if (handleSignature.includes("top") || handleSignature.includes("bottom")) {
    return "y" as const;
  }
  return "x" as const;
}

export function buildLabelLaneKey(
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

export function buildCanvasEdges({
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
