import type {
  FlowExpressionEdge,
  FlowExpressionGraph,
  FlowExpressionNode,
  FlowExpressionNodeKind,
  FlowInputSlot,
} from "../../lib/adapter";
import {
  createFlowExpressionEdge,
  normalizeFlowExpressionGraph,
} from "./flowExpressionGraph";

export interface ExpressionGraphPosition {
  x: number;
  y: number;
}

export interface ExpressionGraphLayoutNode {
  node: FlowExpressionNode;
  x: number;
  y: number;
}

export interface ExpressionTargetHandle {
  id: string;
  label: string;
  replaceExisting: boolean;
}

export const EMPTY_EXPRESSION_GRAPH: FlowExpressionGraph = {
  version: 1,
  rootId: null,
  nodes: [],
  edges: [],
};

export const EXPRESSION_NODE_WIDTH = 126;
export const EXPRESSION_NODE_HEIGHT = 52;
export const EXPRESSION_COLUMN_GAP = 154;
export const EXPRESSION_ROW_GAP = 78;

export const EXPRESSION_INPUT_NODE_KINDS = new Set<FlowExpressionNodeKind>([
  "input",
  "literal",
  "raw",
]);

export const BINARY_OPERATOR_OPTIONS = ["+", "-", "*", "/", "//", "%", "**"];
export const UNARY_OPERATOR_OPTIONS = ["-", "+", "not"];
export const BOOL_OPERATOR_OPTIONS = ["and", "or"];
export const COMPARE_OPERATOR_OPTIONS = ["==", "!=", "<", "<=", ">", ">=", "is", "is not", "in", "not in"];

export function expressionInputSlotByName(inputSlots: FlowInputSlot[]) {
  return inputSlots.reduce<Record<string, string>>((slotByName, slot) => {
    if (slot.label.trim()) {
      slotByName[slot.label] = slot.id;
    }
    if (slot.slotKey.trim()) {
      slotByName[slot.slotKey] = slot.id;
    }
    return slotByName;
  }, {});
}

export function returnExpressionFromPayload(payload: Record<string, unknown>) {
  const expression = typeof payload.expression === "string" ? payload.expression : "";
  return expression.replace(/^return\s+/i, "").trim();
}

export function layoutExpressionGraph(
  graph: FlowExpressionGraph,
  nodePositions: Record<string, ExpressionGraphPosition> = graph.layout?.nodes ?? {},
): {
  nodes: ExpressionGraphLayoutNode[];
  width: number;
  height: number;
} {
  if (!graph.nodes.length) {
    return { nodes: [], width: 520, height: 260 };
  }

  const depthById = new Map(graph.nodes.map((node) => [node.id, 0]));
  for (let pass = 0; pass < graph.nodes.length; pass += 1) {
    let changed = false;
    graph.edges.forEach((edge) => {
      const sourceDepth = depthById.get(edge.sourceId) ?? 0;
      const targetDepth = depthById.get(edge.targetId) ?? 0;
      if (targetDepth < sourceDepth + 1) {
        depthById.set(edge.targetId, sourceDepth + 1);
        changed = true;
      }
    });
    if (!changed) {
      break;
    }
  }

  const nodesByDepth = new Map<number, FlowExpressionNode[]>();
  graph.nodes.forEach((node) => {
    const depth = depthById.get(node.id) ?? 0;
    nodesByDepth.set(depth, [...(nodesByDepth.get(depth) ?? []), node]);
  });

  const layoutNodes = [...nodesByDepth.entries()].flatMap<ExpressionGraphLayoutNode>(([depth, nodesAtDepth]) => (
    nodesAtDepth
      .slice()
      .sort((left, right) => {
        if (left.id === graph.rootId) {
          return -1;
        }
        if (right.id === graph.rootId) {
          return 1;
        }
        return left.id.localeCompare(right.id);
      })
      .map((node, row) => {
        const manualPosition = nodePositions[node.id];
        return {
          node,
          x: manualPosition?.x ?? 24 + depth * EXPRESSION_COLUMN_GAP,
          y: manualPosition?.y ?? 24 + row * EXPRESSION_ROW_GAP,
        };
      })
  ));
  const maxX = Math.max(...layoutNodes.map((node) => node.x), 24);
  const maxY = Math.max(...layoutNodes.map((node) => node.y), 24);
  return {
    nodes: layoutNodes,
    width: Math.max(640, maxX + EXPRESSION_NODE_WIDTH + 72),
    height: Math.max(320, maxY + EXPRESSION_NODE_HEIGHT + 72),
  };
}

export function graphSummary(graph: FlowExpressionGraph | null | undefined) {
  if (!graph) {
    return "No graph";
  }
  return `${graph.nodes.length} nodes, ${graph.edges.length} edges`;
}

export function expressionGraphIncomingByTarget(graph: FlowExpressionGraph | null | undefined) {
  const incoming = new Map<string, FlowExpressionEdge[]>();
  (graph?.edges ?? []).forEach((edge) => {
    incoming.set(edge.targetId, [...(incoming.get(edge.targetId) ?? []), edge]);
  });
  return incoming;
}

function indexedTargetHandles(
  incomingEdges: FlowExpressionEdge[],
  prefix: string,
  minimumCount: number,
  nextLabel: string,
) {
  const indexes = incomingEdges
    .filter((edge) => edge.targetHandle.startsWith(prefix))
    .map((edge) => Number.parseInt(edge.targetHandle.slice(prefix.length).split(":", 1)[0] ?? "", 10))
    .filter((index) => !Number.isNaN(index));
  const maxIndex = Math.max(minimumCount - 1, ...indexes, -1);
  const handles: ExpressionTargetHandle[] = [];
  for (let index = 0; index <= maxIndex; index += 1) {
    handles.push({
      id: `${prefix}${index}`,
      label: `${index + 1}`,
      replaceExisting: true,
    });
  }
  handles.push({
    id: `${prefix}${maxIndex + 1}`,
    label: nextLabel,
    replaceExisting: false,
  });
  return handles;
}

export function targetHandlesForExpressionNode(
  node: FlowExpressionNode,
  incomingEdges: FlowExpressionEdge[],
): ExpressionTargetHandle[] {
  if (node.kind === "operator") {
    return [
      { id: "left", label: "L", replaceExisting: true },
      { id: "right", label: "R", replaceExisting: true },
    ];
  }
  if (node.kind === "unary") {
    return [{ id: "operand", label: "in", replaceExisting: true }];
  }
  if (node.kind === "bool") {
    return indexedTargetHandles(incomingEdges, "value:", 2, "+");
  }
  if (node.kind === "compare") {
    return [
      { id: "left", label: "L", replaceExisting: true },
      ...indexedTargetHandles(incomingEdges, "comparator:", 1, "+"),
    ];
  }
  if (node.kind === "call") {
    return [
      { id: "function", label: "fn", replaceExisting: true },
      ...indexedTargetHandles(incomingEdges, "arg:", 0, "+"),
    ];
  }
  if (node.kind === "attribute") {
    return [{ id: "value", label: "obj", replaceExisting: true }];
  }
  if (node.kind === "subscript") {
    return [
      { id: "value", label: "obj", replaceExisting: true },
      { id: "slice", label: "key", replaceExisting: true },
    ];
  }
  if (node.kind === "conditional") {
    return [
      { id: "body", label: "yes", replaceExisting: true },
      { id: "test", label: "if", replaceExisting: true },
      { id: "orelse", label: "no", replaceExisting: true },
    ];
  }
  if (node.kind === "collection") {
    return indexedTargetHandles(incomingEdges, "item:", 0, "+");
  }
  return [];
}

export function nextExpressionNodeId(graph: FlowExpressionGraph, kind: FlowExpressionNodeKind, label: string) {
  const safeLabel = label.trim().replace(/[^a-zA-Z0-9_-]+/g, "-") || "value";
  const existingIds = new Set(graph.nodes.map((node) => node.id));
  let index = graph.nodes.length;
  let nodeId = `expr:${kind}:${safeLabel}:${index}`;
  while (existingIds.has(nodeId)) {
    index += 1;
    nodeId = `expr:${kind}:${safeLabel}:${index}`;
  }
  return nodeId;
}

export function defaultExpressionNode(
  graph: FlowExpressionGraph,
  kind: FlowExpressionNodeKind,
  inputSlot?: FlowInputSlot,
): FlowExpressionNode {
  const inputName = inputSlot?.label || inputSlot?.slotKey || "value";
  if (kind === "input") {
    return {
      id: nextExpressionNodeId(graph, "input", inputName),
      kind: "input",
      label: inputName,
      payload: {
        name: inputName,
        ...(inputSlot ? { slot_id: inputSlot.id } : {}),
      },
    };
  }
  if (kind === "literal") {
    return {
      id: nextExpressionNodeId(graph, "literal", "0"),
      kind: "literal",
      label: "0",
      payload: { expression: "0", value: 0 },
    };
  }
  if (kind === "raw") {
    return {
      id: nextExpressionNodeId(graph, "raw", "value"),
      kind: "raw",
      label: "value",
      payload: { expression: "value" },
    };
  }
  if (kind === "call") {
    return {
      id: nextExpressionNodeId(graph, "call", "call"),
      kind: "call",
      label: "call",
      payload: {},
    };
  }
  return {
    id: nextExpressionNodeId(graph, kind, "+"),
    kind,
    label: kind === "bool" ? "and" : kind === "unary" ? "-" : kind === "compare" ? "==" : "+",
    payload: kind === "compare"
      ? { operators: ["=="] }
      : { operator: kind === "bool" ? "and" : kind === "unary" ? "-" : "+" },
  };
}

export function slotForInputName(inputSlots: FlowInputSlot[], name: string) {
  return inputSlots.find((slot) => slot.label === name || slot.slotKey === name);
}

export function normalizeExpressionGraphOrEmpty(graph: FlowExpressionGraph | null | undefined) {
  return normalizeFlowExpressionGraph(graph) ?? EMPTY_EXPRESSION_GRAPH;
}

export function withExpressionNodePosition(
  graph: FlowExpressionGraph,
  nodeId: string,
  position: ExpressionGraphPosition,
): FlowExpressionGraph {
  return {
    ...graph,
    layout: {
      ...(graph.layout ?? {}),
      nodes: {
        ...(graph.layout?.nodes ?? {}),
        [nodeId]: position,
      },
    },
  };
}

export function withoutExpressionNodePosition(
  graph: FlowExpressionGraph,
  nodeId: string,
): FlowExpressionGraph {
  const { [nodeId]: _removed, ...rest } = graph.layout?.nodes ?? {};
  return {
    ...graph,
    layout: Object.keys(rest).length ? { ...(graph.layout ?? {}), nodes: rest } : undefined,
  };
}

export function connectExpressionGraphNodes(
  graph: FlowExpressionGraph,
  sourceId: string,
  targetId: string,
  targetHandle: ExpressionTargetHandle | string,
): FlowExpressionGraph {
  if (sourceId === targetId) {
    return graph;
  }
  const handle = typeof targetHandle === "string"
    ? { id: targetHandle, replaceExisting: true }
    : targetHandle;
  const nextEdge = createFlowExpressionEdge(sourceId, targetId, handle.id);
  const nextEdges = graph.edges.filter((edge) => {
    if (edge.id === nextEdge.id) {
      return false;
    }
    return !(handle.replaceExisting && edge.targetId === targetId && edge.targetHandle === handle.id);
  });
  const edges = [...nextEdges, nextEdge];
  const targetNode = graph.nodes.find((node) => node.id === targetId);
  const targetHasOutgoingEdge = edges.some((edge) => edge.sourceId === targetId);
  const shouldPromoteTargetToRoot =
    targetNode
    && !EXPRESSION_INPUT_NODE_KINDS.has(targetNode.kind)
    && !targetHasOutgoingEdge;

  return {
    ...graph,
    rootId: shouldPromoteTargetToRoot ? targetId : graph.rootId,
    edges,
  };
}
