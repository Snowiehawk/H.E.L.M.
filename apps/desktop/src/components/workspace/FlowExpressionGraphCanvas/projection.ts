import { MarkerType } from "@xyflow/react";
import type { FlowExpressionGraph, FlowExpressionNode } from "../../../lib/adapter";
import {
  expressionGraphIncomingByTarget,
  layoutExpressionGraph,
  targetHandlesForExpressionNode,
  type ExpressionTargetHandle,
} from "../../graph/flowExpressionGraphEditing";
import type { ExpressionCanvasEdge, ExpressionCanvasNode } from "./types";

export function expressionNodesForGraph(
  graph: FlowExpressionGraph,
  selectedExpressionNodeId: string | undefined,
): ExpressionCanvasNode[] {
  const incomingByTarget = expressionGraphIncomingByTarget(graph);
  const layout = layoutExpressionGraph(graph);
  return layout.nodes.map(({ node, x, y }) => ({
    id: node.id,
    type: "expression",
    position: { x, y },
    selected: node.id === selectedExpressionNodeId,
    data: {
      expressionNode: node,
      isRoot: node.id === graph.rootId,
      targetHandles: targetHandlesForExpressionNode(node, incomingByTarget.get(node.id) ?? []),
    },
  }));
}

export function expressionEdgesForGraph(
  graph: FlowExpressionGraph,
  selectedEdgeId?: string,
): ExpressionCanvasEdge[] {
  return graph.edges.map((edge) => ({
    id: edge.id,
    type: "smoothstep",
    source: edge.sourceId,
    sourceHandle: edge.sourceHandle,
    target: edge.targetId,
    targetHandle: edge.targetHandle,
    selected: edge.id === selectedEdgeId,
    reconnectable: true,
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: "var(--accent-strong)",
    },
    className: "flow-expression-canvas__edge",
  }));
}

export function targetHandleForConnection(
  graph: FlowExpressionGraph,
  connection: { target?: string | null; targetHandle?: string | null },
): ExpressionTargetHandle | undefined {
  if (!connection.target || !connection.targetHandle) {
    return undefined;
  }
  const target = graph.nodes.find((node) => node.id === connection.target);
  if (!target) {
    return undefined;
  }
  const incomingByTarget = expressionGraphIncomingByTarget(graph);
  return targetHandlesForExpressionNode(target, incomingByTarget.get(target.id) ?? []).find(
    (handle) => handle.id === connection.targetHandle,
  );
}

export function selectedNodeTargetHandles(
  graph: FlowExpressionGraph,
  selectedNode: FlowExpressionNode | undefined,
) {
  if (!selectedNode) {
    return [];
  }
  const incomingByTarget = expressionGraphIncomingByTarget(graph);
  return targetHandlesForExpressionNode(selectedNode, incomingByTarget.get(selectedNode.id) ?? []);
}
