import type { Edge, Node } from "@xyflow/react";
import type { FlowExpressionGraph, FlowExpressionNode, FlowInputSlot } from "../../../lib/adapter";
import type { ExpressionTargetHandle } from "../../graph/flowExpressionGraphEditing";
import type { AppContextMenuPosition } from "../../shared/AppContextMenu";

export interface ExpressionCanvasNodeData extends Record<string, unknown> {
  expressionNode: FlowExpressionNode;
  isRoot: boolean;
  targetHandles: ExpressionTargetHandle[];
}

export type ExpressionCanvasNode = Node<ExpressionCanvasNodeData, "expression">;
export type ExpressionCanvasEdge = Edge<Record<string, unknown>, "smoothstep">;

export type ExpressionContextMenuState = AppContextMenuPosition & {
  kind: "node" | "edge" | "pane";
  targetId?: string;
};

export interface FlowExpressionGraphCanvasChangeOptions {
  selectedExpressionNodeId?: string;
}

export interface FlowExpressionGraphCanvasProps {
  diagnostics: string[];
  error?: string | null;
  expression: string;
  graph: FlowExpressionGraph;
  inputSlots: FlowInputSlot[];
  isDraftOnly: boolean;
  isSaving: boolean;
  ownerLabel: string;
  selectedExpressionNodeId?: string;
  onGraphChange: (
    graph: FlowExpressionGraph,
    options?: FlowExpressionGraphCanvasChangeOptions,
  ) => void;
  onNavigateOut: () => void;
  onSelectExpressionNode: (nodeId?: string) => void;
}

export type UpdateExpressionNode = (
  nodeId: string,
  update: (node: FlowExpressionNode) => FlowExpressionNode,
) => void;
