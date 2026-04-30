import type { GraphNodeDto, GraphNodeKind, GraphView } from "../../../lib/adapter";
import {
  isEnterableGraphNodeKind,
  isGraphSymbolNodeKind,
  isInspectableGraphNodeKind,
} from "../../../lib/adapter";
import { buildBlueprintPresentation } from "../blueprintPorts";
import type { BlueprintNodeData, BlueprintNodePort } from "../BlueprintNode";
import {
  flowExpressionNodeDisplayLabel,
  normalizeFlowExpressionGraph,
} from "../flowExpressionGraph";
import {
  graphLayoutNodeKey,
  type StoredGraphLayout,
  type StoredGraphNodeLayout,
  type StoredGraphReroute,
} from "../graphLayoutPersistence";
import { pinActionHelpId, rerouteNodeId } from "./layoutHelpers";
import type { GraphCanvasNode, RerouteCanvasNode, SemanticCanvasNode } from "./types";
import { isRerouteCanvasNode } from "./types";

export function metadataNumber(node: GraphNodeDto, key: string): number | undefined {
  const value =
    node.metadata[key] ??
    node.metadata[key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())];
  return typeof value === "number" ? value : undefined;
}

export function metadataString(node: GraphNodeDto, key: string): string | undefined {
  const value =
    node.metadata[key] ??
    node.metadata[key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())];
  return typeof value === "string" ? value : undefined;
}

export function looksLikeSourcePath(value: string): boolean {
  return value.includes("/") || value.endsWith(".py");
}

export function relativePathForGraphNode(node: GraphNodeDto): string | undefined {
  const relativePath = metadataString(node, "relative_path");
  if (relativePath && looksLikeSourcePath(relativePath)) {
    return relativePath;
  }
  if (node.kind === "module" && node.subtitle && looksLikeSourcePath(node.subtitle)) {
    return node.subtitle;
  }
  return undefined;
}

export function moduleDisplayLabel(node: GraphNodeDto): string {
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

export function nodeSummary(node: GraphNodeDto): string | undefined {
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

export function expressionPreviewForNode(
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

export function buildNodeShellClassName(
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

export function buildRerouteShellClassName(
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

export function decorateNodePorts(
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

export function buildSemanticCanvasNodes(
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

export function buildRerouteCanvasNodes(
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

export function buildCanvasNodes(
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

export function applyNodeDecorations(
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
