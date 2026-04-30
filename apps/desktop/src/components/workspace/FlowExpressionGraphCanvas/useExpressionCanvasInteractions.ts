import { useCallback, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import type {
  Connection as FlowConnection,
  Edge as FlowEdge,
  EdgeChange as FlowEdgeChange,
  NodeChange as FlowNodeChange,
} from "@xyflow/react";
import { clampAppContextMenuPosition } from "../../shared/AppContextMenu";
import { isEditableEventTarget } from "./domTargets";
import type {
  ExpressionCanvasEdge,
  ExpressionCanvasNode,
  ExpressionContextMenuState,
} from "./types";

export function useExpressionCanvasInteractions({
  applyCanvasEdgeChanges,
  applyCanvasNodeChanges,
  clearExpressionSelection,
  connectExpressionNodes,
  deleteExpressionEdges,
  deleteExpressionNodes,
  isValidConnection,
  moveExpressionNode,
  reconnectExpressionEdge,
  selectExpressionEdge,
  selectExpressionNode,
  selectedEdgeId,
}: {
  applyCanvasEdgeChanges: (changes: FlowEdgeChange<ExpressionCanvasEdge>[]) => void;
  applyCanvasNodeChanges: (changes: FlowNodeChange<ExpressionCanvasNode>[]) => void;
  clearExpressionSelection: () => void;
  connectExpressionNodes: (connection: FlowConnection) => void;
  deleteExpressionEdges: (edgeIds: string[]) => void;
  deleteExpressionNodes: (nodeIds: string[]) => void;
  isValidConnection: (connection: FlowConnection | ExpressionCanvasEdge) => boolean;
  moveExpressionNode: (nodeId: string, position: { x: number; y: number }) => void;
  reconnectExpressionEdge: (oldEdge: FlowEdge, newConnection: FlowConnection) => void;
  selectExpressionEdge: (edgeId: string) => void;
  selectExpressionNode: (nodeId: string) => void;
  selectedEdgeId?: string;
}) {
  const [contextMenu, setContextMenu] = useState<ExpressionContextMenuState | null>(null);
  const [contextActionError, setContextActionError] = useState<string | null>(null);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const openContextMenu = useCallback(
    (
      event: ReactMouseEvent<Element> | MouseEvent,
      kind: ExpressionContextMenuState["kind"],
      targetId?: string,
    ) => {
      event.preventDefault();
      event.stopPropagation();
      setContextActionError(null);
      setContextMenu({
        ...clampAppContextMenuPosition(event.clientX, event.clientY),
        kind,
        targetId,
      });
    },
    [],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (event.key !== "Delete" && event.key !== "Backspace") {
        return;
      }
      if (isEditableEventTarget(event.target)) {
        return;
      }
      if (selectedEdgeId) {
        event.preventDefault();
        deleteExpressionEdges([selectedEdgeId]);
      }
    },
    [deleteExpressionEdges, selectedEdgeId],
  );

  return {
    closeContextMenu,
    contextActionError,
    contextMenu,
    handleConnect: connectExpressionNodes,
    handleEdgeClick: (_: ReactMouseEvent, edge: ExpressionCanvasEdge) => {
      selectExpressionEdge(edge.id);
    },
    handleEdgeContextMenu: (event: ReactMouseEvent<Element>, edge: ExpressionCanvasEdge) => {
      selectExpressionEdge(edge.id);
      openContextMenu(event, "edge", edge.id);
    },
    handleEdgesChange: applyCanvasEdgeChanges,
    handleEdgesDelete: (deletedEdges: ExpressionCanvasEdge[]) => {
      deleteExpressionEdges(deletedEdges.map((edge) => edge.id));
    },
    handleKeyDown,
    handleNodeClick: (_: ReactMouseEvent, node: ExpressionCanvasNode) => {
      selectExpressionNode(node.id);
    },
    handleNodeContextMenu: (event: ReactMouseEvent<Element>, node: ExpressionCanvasNode) => {
      selectExpressionNode(node.id);
      openContextMenu(event, "node", node.id);
    },
    handleNodeDragStop: (_: ReactMouseEvent, node: ExpressionCanvasNode) => {
      moveExpressionNode(node.id, node.position);
    },
    handleNodesChange: applyCanvasNodeChanges,
    handleNodesDelete: (deletedNodes: ExpressionCanvasNode[]) => {
      deleteExpressionNodes(deletedNodes.map((node) => node.id));
    },
    handlePaneClick: clearExpressionSelection,
    handlePaneContextMenu: (event: ReactMouseEvent<Element> | MouseEvent) =>
      openContextMenu(event, "pane"),
    handleReconnect: reconnectExpressionEdge,
    isValidConnection,
    setContextActionError,
  };
}
