import type {
  FlowGraphDocument,
  FlowGraphEdge,
  FlowGraphNode,
  FlowSyncState,
  FlowVisualNodeKind,
  GraphEdgeDto,
  GraphNodeDto,
  GraphNodeKind,
  GraphView,
} from "../../lib/adapter";
import { cloneFlowDocument } from "./flowDocument";

const FLOW_VISUAL_NODE_KINDS = new Set<FlowVisualNodeKind>([
  "entry",
  "assign",
  "call",
  "branch",
  "loop",
  "return",
  "exit",
]);

export function establishFlowDraftDocument(graph: GraphView | undefined): FlowGraphDocument | undefined {
  if (!graph || graph.level !== "flow") {
    return undefined;
  }

  if (graph.flowState?.document) {
    return cloneFlowDocument(graph.flowState.document);
  }

  return flowDocumentFromVisualGraph(graph);
}

export function projectFlowDraftGraph(
  baseGraph: GraphView,
  document: FlowGraphDocument,
): GraphView {
  const logicalNodeIds = new Set(document.nodes.map((node) => node.id));
  const preservedNodes = baseGraph.nodes.filter((node) => (
    !logicalNodeIds.has(node.id)
    && !FLOW_VISUAL_NODE_KINDS.has(node.kind as FlowVisualNodeKind)
  ));
  const baseNodesById = new Map(baseGraph.nodes.map((node) => [node.id, node] as const));
  const draftNodes = document.nodes.map((node, index) => (
    graphNodeForFlowDraft(node, index, document.qualname, baseNodesById.get(node.id))
  ));
  const visibleNodeIds = new Set([
    ...preservedNodes.map((node) => node.id),
    ...draftNodes.map((node) => node.id),
  ]);
  const preservedEdges = baseGraph.edges.filter((edge) => (
    edge.kind !== "controls"
    && visibleNodeIds.has(edge.source)
    && visibleNodeIds.has(edge.target)
  ));
  const baseEdgesById = new Map(baseGraph.edges.map((edge) => [edge.id, edge] as const));
  const draftEdges = document.edges.map((edge) => graphEdgeForFlowDraft(edge, baseEdgesById.get(edge.id)));

  return {
    ...baseGraph,
    rootNodeId: visibleNodeIds.has(baseGraph.rootNodeId)
      ? baseGraph.rootNodeId
      : document.nodes[0]?.id ?? baseGraph.rootNodeId,
    nodes: [...preservedNodes, ...draftNodes],
    edges: [...preservedEdges, ...draftEdges],
    flowState: {
      editable: document.editable,
      syncState: document.syncState,
      diagnostics: [...document.diagnostics],
      document: cloneFlowDocument(document),
    },
  };
}

function flowDocumentFromVisualGraph(graph: GraphView): FlowGraphDocument | undefined {
  const symbolId = graph.targetId.startsWith("symbol:") ? graph.targetId : undefined;
  const relativePath = graph.breadcrumbs.find((breadcrumb) => breadcrumb.level === "module")?.subtitle;
  const qualname =
    graph.breadcrumbs.find((breadcrumb) => breadcrumb.level === "symbol")?.subtitle
    ?? graph.breadcrumbs.find((breadcrumb) => breadcrumb.level === "flow")?.subtitle
    ?? graph.focus?.subtitle;
  if (!symbolId || typeof relativePath !== "string" || !relativePath.trim() || typeof qualname !== "string" || !qualname.trim()) {
    return undefined;
  }

  const nodes: FlowGraphNode[] = [];
  for (const graphNode of graph.nodes) {
    const kind = toFlowVisualNodeKind(graphNode.kind);
    if (!kind) {
      return undefined;
    }

    nodes.push({
      id: graphNode.id,
      kind,
      payload: payloadFromGraphNode(graphNode, kind),
    });
  }

  const edges: FlowGraphEdge[] = [];
  for (const graphEdge of graph.edges) {
    if (graphEdge.kind !== "controls") {
      return undefined;
    }

    const handles = readFlowGraphHandles(graphEdge);
    if (!handles) {
      return undefined;
    }

    edges.push({
      id: graphEdge.id,
      sourceId: graphEdge.source,
      sourceHandle: handles.sourceHandle,
      targetId: graphEdge.target,
      targetHandle: handles.targetHandle,
    });
  }

  return {
    symbolId,
    relativePath,
    qualname,
    nodes,
    edges,
    syncState: (graph.flowState?.syncState ?? "clean") as FlowSyncState,
    diagnostics: [...(graph.flowState?.diagnostics ?? [])],
    sourceHash: graph.flowState?.document?.sourceHash ?? null,
    editable: graph.flowState?.editable ?? true,
  };
}

function toFlowVisualNodeKind(kind: GraphNodeKind): FlowVisualNodeKind | undefined {
  return FLOW_VISUAL_NODE_KINDS.has(kind as FlowVisualNodeKind)
    ? kind as FlowVisualNodeKind
    : undefined;
}

function payloadFromGraphNode(
  node: GraphNodeDto,
  kind: FlowVisualNodeKind,
): Record<string, unknown> {
  if (kind === "entry" || kind === "exit") {
    return {};
  }
  if (kind === "assign" || kind === "call") {
    return { source: node.label };
  }
  if (kind === "branch") {
    return { condition: node.label.replace(/^if\s+/i, "") };
  }
  if (kind === "loop") {
    return { header: node.label };
  }
  return { expression: node.label.replace(/^return\s+/i, "") };
}

function graphNodeForFlowDraft(
  node: FlowGraphNode,
  index: number,
  qualname: string,
  existing: GraphNodeDto | undefined,
): GraphNodeDto {
  return {
    id: node.id,
    kind: node.kind as GraphNodeKind,
    label: flowDraftNodeLabel(node.kind, node.payload),
    subtitle: flowDraftNodeSubtitle(node.kind, node.payload, qualname),
    x: existing?.x ?? 260 + Math.max(1, index) * 220,
    y: existing?.y ?? (node.kind === "branch" || node.kind === "loop" ? 120 : 180),
    metadata: {
      ...(existing?.metadata ?? {}),
      flow_visual: true,
      flow_order: index,
    },
    availableActions: existing?.availableActions ?? [],
  };
}

function graphEdgeForFlowDraft(
  edge: FlowGraphEdge,
  existing: GraphEdgeDto | undefined,
): GraphEdgeDto {
  const pathLabel = flowDraftPathLabel(edge.sourceHandle);
  return {
    id: edge.id,
    kind: "controls",
    source: edge.sourceId,
    target: edge.targetId,
    ...(pathLabel ? { label: pathLabel } : {}),
    metadata: {
      ...(existing?.metadata ?? {}),
      source_handle: edge.sourceHandle,
      target_handle: edge.targetHandle,
      ...(pathLabel
        ? {
            path_key: pathLabel,
            path_label: pathLabel,
          }
        : {}),
    },
  };
}

function flowDraftNodeLabel(kind: FlowVisualNodeKind, payload: Record<string, unknown>) {
  if (kind === "entry") {
    return "Entry";
  }
  if (kind === "exit") {
    return "Exit";
  }
  if (kind === "assign" || kind === "call") {
    return typeof payload.source === "string" && payload.source.trim() ? payload.source.trim() : kind;
  }
  if (kind === "branch") {
    const condition = typeof payload.condition === "string" ? payload.condition.trim() : "";
    return condition ? `if ${condition}` : "if ...";
  }
  if (kind === "loop") {
    const header = typeof payload.header === "string" ? payload.header.trim() : "";
    return header || "loop";
  }
  const expression = typeof payload.expression === "string" ? payload.expression.trim() : "";
  return expression ? `return ${expression}` : "return";
}

function flowDraftNodeSubtitle(
  kind: FlowVisualNodeKind,
  payload: Record<string, unknown>,
  qualname: string,
) {
  if (kind === "entry") {
    return qualname;
  }
  if (kind === "exit") {
    return "terminal path";
  }
  if (kind === "assign") {
    return "assignment";
  }
  if (kind === "call") {
    return "call";
  }
  if (kind === "branch") {
    return "conditional branch";
  }
  if (kind === "loop") {
    return "loop";
  }
  return "return";
}

function flowDraftPathLabel(sourceHandle: string) {
  return sourceHandle === "start" || sourceHandle === "next" ? undefined : sourceHandle;
}

function readFlowGraphHandles(
  edge: GraphEdgeDto,
): { sourceHandle: string; targetHandle: string } | undefined {
  const sourceHandle =
    readEdgeMetadataString(edge, "source_handle")
    ?? readEdgeMetadataString(edge, "sourceHandle")
    ?? parseFlowEdgeId(edge.id)?.sourceHandle;
  const targetHandle =
    readEdgeMetadataString(edge, "target_handle")
    ?? readEdgeMetadataString(edge, "targetHandle")
    ?? parseFlowEdgeId(edge.id)?.targetHandle;
  if (!sourceHandle || !targetHandle) {
    return undefined;
  }
  return {
    sourceHandle,
    targetHandle,
  };
}

function readEdgeMetadataString(edge: GraphEdgeDto, key: string) {
  const value = edge.metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseFlowEdgeId(edgeId: string) {
  const match = /^controls:(.+):([^:]+)->(.+):([^:]+)$/.exec(edgeId);
  if (!match) {
    return undefined;
  }
  return {
    sourceId: match[1],
    sourceHandle: match[2],
    targetId: match[3],
    targetHandle: match[4],
  };
}
