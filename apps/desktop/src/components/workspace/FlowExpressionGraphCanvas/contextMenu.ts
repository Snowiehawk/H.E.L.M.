import type { FlowExpressionGraph, FlowExpressionNodeKind } from "../../../lib/adapter";
import { copyToClipboard, type AppContextMenuItem } from "../../shared/AppContextMenu";
import type { ExpressionContextMenuState } from "./types";

export interface ExpressionContextMenuDeps {
  addExpressionNode: (kind: FlowExpressionNodeKind) => void;
  deleteExpressionEdges: (edgeIds: string[]) => void;
  deleteExpressionNode: (nodeId: string) => void;
  expression: string;
  normalizedGraph: FlowExpressionGraph;
  onNavigateOut: () => void;
  setExpressionRoot: (nodeId: string) => void;
}

export function buildExpressionContextMenuItems(
  contextMenu: ExpressionContextMenuState | null,
  {
    addExpressionNode,
    deleteExpressionEdges,
    deleteExpressionNode,
    expression,
    normalizedGraph,
    onNavigateOut,
    setExpressionRoot,
  }: ExpressionContextMenuDeps,
): AppContextMenuItem[] {
  const items: AppContextMenuItem[] = [];
  const targetNode =
    contextMenu?.kind === "node"
      ? normalizedGraph.nodes.find((node) => node.id === contextMenu.targetId)
      : undefined;
  const targetEdge =
    contextMenu?.kind === "edge"
      ? normalizedGraph.edges.find((edge) => edge.id === contextMenu.targetId)
      : undefined;

  if (targetNode) {
    items.push(
      {
        id: "set-root",
        label: "Set as Root",
        action: () => setExpressionRoot(targetNode.id),
        disabled: normalizedGraph.rootId === targetNode.id,
      },
      {
        id: "delete-node",
        label: "Delete Node",
        action: () => deleteExpressionNode(targetNode.id),
      },
    );
  }

  if (targetEdge) {
    items.push({
      id: "delete-edge",
      label: "Delete Edge",
      action: () => deleteExpressionEdges([targetEdge.id]),
    });
  }

  items.push(
    {
      id: "add-input",
      label: "Add Input",
      action: () => addExpressionNode("input"),
      separatorBefore: items.length > 0,
    },
    {
      id: "add-operator",
      label: "Add Operator",
      action: () => addExpressionNode("operator"),
    },
    {
      id: "add-call",
      label: "Add Call",
      action: () => addExpressionNode("call"),
    },
    {
      id: "add-literal",
      label: "Add Literal",
      action: () => addExpressionNode("literal"),
    },
    {
      id: "add-raw",
      label: "Add Raw",
      action: () => addExpressionNode("raw"),
    },
    {
      id: "back-to-flow",
      label: "Back to Flow",
      action: onNavigateOut,
      separatorBefore: true,
    },
    {
      id: "copy-expression",
      label: "Copy Expression",
      action: () => copyToClipboard(expression),
      separatorBefore: true,
    },
    {
      id: "copy-graph-json",
      label: "Copy Graph JSON",
      action: () => copyToClipboard(JSON.stringify(normalizedGraph, null, 2)),
    },
  );

  if (targetNode) {
    items.push({
      id: "copy-node-id",
      label: "Copy Node ID",
      action: () => copyToClipboard(targetNode.id),
    });
  }

  if (targetEdge) {
    items.push({
      id: "copy-edge-id",
      label: "Copy Edge ID",
      action: () => copyToClipboard(targetEdge.id),
    });
  }

  return items;
}

export function expressionContextMenuLabel(contextMenu: ExpressionContextMenuState) {
  return contextMenu.kind === "node"
    ? "Expression node actions"
    : contextMenu.kind === "edge"
      ? "Expression edge actions"
      : "Expression graph actions";
}
