import { useCallback, useEffect, useMemo, useState } from "react";
import {
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
} from "@xyflow/react";
import type {
  FlowExpressionGraph,
  FlowExpressionNode,
  FlowExpressionNodeKind,
  FlowInputSlot,
} from "../../../lib/adapter";
import {
  EMPTY_EXPRESSION_GRAPH,
  EXPRESSION_COLUMN_GAP,
  EXPRESSION_ROW_GAP,
  connectExpressionGraphNodes,
  defaultExpressionNode,
  normalizeExpressionGraphOrEmpty,
  withExpressionNodePosition,
  withoutExpressionNodePosition,
} from "../../graph/flowExpressionGraphEditing";
import { normalizeFlowExpressionGraph } from "../../graph/flowExpressionGraph";
import {
  expressionEdgesForGraph,
  expressionNodesForGraph,
  selectedNodeTargetHandles,
  targetHandleForConnection,
} from "./projection";
import type {
  ExpressionCanvasEdge,
  ExpressionCanvasNode,
  FlowExpressionGraphCanvasChangeOptions,
} from "./types";

export function useExpressionGraphModel({
  graph,
  inputSlots,
  onGraphChange,
  onSelectExpressionNode,
  selectedExpressionNodeId,
}: {
  graph: FlowExpressionGraph;
  inputSlots: FlowInputSlot[];
  onGraphChange: (
    graph: FlowExpressionGraph,
    options?: FlowExpressionGraphCanvasChangeOptions,
  ) => void;
  onSelectExpressionNode: (nodeId?: string) => void;
  selectedExpressionNodeId?: string;
}) {
  const normalizedGraph = useMemo(() => normalizeExpressionGraphOrEmpty(graph), [graph]);
  const [nodes, setNodes] = useState<ExpressionCanvasNode[]>(() =>
    expressionNodesForGraph(normalizedGraph, selectedExpressionNodeId),
  );
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | undefined>(undefined);
  const [edges, setEdges] = useState<ExpressionCanvasEdge[]>(() =>
    expressionEdgesForGraph(normalizedGraph),
  );
  const [newInputSlotId, setNewInputSlotId] = useState(() => inputSlots[0]?.id ?? "");

  const selectedNode = useMemo(
    () => normalizedGraph.nodes.find((node) => node.id === selectedExpressionNodeId),
    [normalizedGraph.nodes, selectedExpressionNodeId],
  );
  const selectedEdge = useMemo(
    () => normalizedGraph.edges.find((edge) => edge.id === selectedEdgeId),
    [normalizedGraph.edges, selectedEdgeId],
  );
  const selectedTargetHandles = useMemo(
    () => selectedNodeTargetHandles(normalizedGraph, selectedNode),
    [normalizedGraph, selectedNode],
  );

  useEffect(() => {
    setNodes(expressionNodesForGraph(normalizedGraph, selectedExpressionNodeId));
  }, [normalizedGraph, selectedExpressionNodeId]);

  useEffect(() => {
    setEdges(expressionEdgesForGraph(normalizedGraph, selectedEdgeId));
  }, [normalizedGraph, selectedEdgeId]);

  useEffect(() => {
    setNewInputSlotId((current) =>
      current && inputSlots.some((slot) => slot.id === current)
        ? current
        : (inputSlots[0]?.id ?? ""),
    );
  }, [inputSlots]);

  const commitGraph = useCallback(
    (nextGraph: FlowExpressionGraph, options?: FlowExpressionGraphCanvasChangeOptions) => {
      const normalized = normalizeFlowExpressionGraph(nextGraph) ?? EMPTY_EXPRESSION_GRAPH;
      onGraphChange(normalized, options);
    },
    [onGraphChange],
  );

  const addExpressionNode = useCallback(
    (kind: FlowExpressionNodeKind) => {
      const inputSlot =
        kind === "input"
          ? (inputSlots.find((slot) => slot.id === newInputSlotId) ?? inputSlots[0])
          : undefined;
      const node = defaultExpressionNode(normalizedGraph, kind, inputSlot);
      const selectedCanvasNode = selectedExpressionNodeId
        ? nodes.find((candidate) => candidate.id === selectedExpressionNodeId)
        : undefined;
      const positionedGraph = withExpressionNodePosition(
        {
          ...normalizedGraph,
          rootId: normalizedGraph.rootId ?? node.id,
          nodes: [...normalizedGraph.nodes, node],
        },
        node.id,
        {
          x: Math.max(
            24,
            (selectedCanvasNode?.position.x ?? 24) +
              (selectedCanvasNode ? EXPRESSION_COLUMN_GAP : 0),
          ),
          y: Math.max(
            24,
            selectedCanvasNode?.position.y ??
              24 + normalizedGraph.nodes.length * EXPRESSION_ROW_GAP,
          ),
        },
      );
      setSelectedEdgeId(undefined);
      commitGraph(positionedGraph, { selectedExpressionNodeId: node.id });
      onSelectExpressionNode(node.id);
    },
    [
      commitGraph,
      inputSlots,
      newInputSlotId,
      nodes,
      normalizedGraph,
      onSelectExpressionNode,
      selectedExpressionNodeId,
    ],
  );

  const updateExpressionNode = useCallback(
    (nodeId: string, update: (node: FlowExpressionNode) => FlowExpressionNode) => {
      commitGraph(
        {
          ...normalizedGraph,
          nodes: normalizedGraph.nodes.map((node) => (node.id === nodeId ? update(node) : node)),
        },
        { selectedExpressionNodeId: nodeId },
      );
    },
    [commitGraph, normalizedGraph],
  );

  const deleteExpressionNode = useCallback(
    (nodeId: string) => {
      const nextNodes = normalizedGraph.nodes.filter((node) => node.id !== nodeId);
      const nextGraph = withoutExpressionNodePosition(
        {
          ...normalizedGraph,
          rootId:
            normalizedGraph.rootId === nodeId ? (nextNodes[0]?.id ?? null) : normalizedGraph.rootId,
          nodes: nextNodes,
          edges: normalizedGraph.edges.filter(
            (edge) => edge.sourceId !== nodeId && edge.targetId !== nodeId,
          ),
        },
        nodeId,
      );
      setSelectedEdgeId(undefined);
      commitGraph(nextGraph, {
        selectedExpressionNodeId: nextGraph.rootId ?? nextGraph.nodes[0]?.id,
      });
    },
    [commitGraph, normalizedGraph],
  );

  const deleteExpressionNodes = useCallback(
    (nodeIds: string[]) => {
      let nextGraph = normalizedGraph;
      nodeIds.forEach((nodeId) => {
        const nextNodes = nextGraph.nodes.filter((candidate) => candidate.id !== nodeId);
        nextGraph = withoutExpressionNodePosition(
          {
            ...nextGraph,
            rootId: nextGraph.rootId === nodeId ? (nextNodes[0]?.id ?? null) : nextGraph.rootId,
            nodes: nextNodes,
            edges: nextGraph.edges.filter(
              (edge) => edge.sourceId !== nodeId && edge.targetId !== nodeId,
            ),
          },
          nodeId,
        );
      });
      commitGraph(nextGraph, {
        selectedExpressionNodeId: nextGraph.rootId ?? nextGraph.nodes[0]?.id,
      });
    },
    [commitGraph, normalizedGraph],
  );

  const deleteExpressionEdges = useCallback(
    (edgeIds: string[]) => {
      if (!edgeIds.length) {
        return;
      }
      const edgeIdSet = new Set(edgeIds);
      commitGraph(
        {
          ...normalizedGraph,
          edges: normalizedGraph.edges.filter((edge) => !edgeIdSet.has(edge.id)),
        },
        { selectedExpressionNodeId },
      );
      setSelectedEdgeId(undefined);
    },
    [commitGraph, normalizedGraph, selectedExpressionNodeId],
  );

  const setExpressionRoot = useCallback(
    (nodeId: string) => {
      commitGraph({ ...normalizedGraph, rootId: nodeId }, { selectedExpressionNodeId: nodeId });
      onSelectExpressionNode(nodeId);
    },
    [commitGraph, normalizedGraph, onSelectExpressionNode],
  );

  const connectExpressionNodes = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target || connection.source === connection.target) {
        return;
      }
      const targetHandle = targetHandleForConnection(normalizedGraph, connection);
      if (!targetHandle) {
        return;
      }
      const nextGraph = connectExpressionGraphNodes(
        normalizedGraph,
        connection.source,
        connection.target,
        targetHandle,
      );
      setSelectedEdgeId(undefined);
      commitGraph(nextGraph, { selectedExpressionNodeId: connection.target });
      onSelectExpressionNode(connection.target);
    },
    [commitGraph, normalizedGraph, onSelectExpressionNode],
  );

  const reconnectExpressionEdge = useCallback(
    (oldEdge: Edge, newConnection: Connection) => {
      if (
        !newConnection.source ||
        !newConnection.target ||
        newConnection.source === newConnection.target
      ) {
        return;
      }
      const graphWithoutOldEdge = {
        ...normalizedGraph,
        edges: normalizedGraph.edges.filter((edge) => edge.id !== oldEdge.id),
      };
      const targetHandle = targetHandleForConnection(graphWithoutOldEdge, newConnection);
      if (!targetHandle) {
        return;
      }
      const nextGraph = connectExpressionGraphNodes(
        graphWithoutOldEdge,
        newConnection.source,
        newConnection.target,
        targetHandle,
      );
      setSelectedEdgeId(undefined);
      commitGraph(nextGraph, { selectedExpressionNodeId: newConnection.target });
      onSelectExpressionNode(newConnection.target);
    },
    [commitGraph, normalizedGraph, onSelectExpressionNode],
  );

  const moveExpressionNode = useCallback(
    (nodeId: string, position: { x: number; y: number }) => {
      commitGraph(withExpressionNodePosition(normalizedGraph, nodeId, position), {
        selectedExpressionNodeId: nodeId,
      });
      onSelectExpressionNode(nodeId);
    },
    [commitGraph, normalizedGraph, onSelectExpressionNode],
  );

  const applyCanvasNodeChanges = useCallback((changes: NodeChange<ExpressionCanvasNode>[]) => {
    setNodes((current) => applyNodeChanges(changes, current));
  }, []);

  const applyCanvasEdgeChanges = useCallback((changes: EdgeChange<ExpressionCanvasEdge>[]) => {
    setEdges((current) => applyEdgeChanges(changes, current));
  }, []);

  const isValidConnection = useCallback(
    (connection: Connection | ExpressionCanvasEdge) => {
      if (!connection.source || !connection.target || connection.source === connection.target) {
        return false;
      }
      return Boolean(targetHandleForConnection(normalizedGraph, connection));
    },
    [normalizedGraph],
  );

  const selectExpressionNode = useCallback(
    (nodeId: string) => {
      setSelectedEdgeId(undefined);
      onSelectExpressionNode(nodeId);
    },
    [onSelectExpressionNode],
  );

  const selectExpressionEdge = useCallback(
    (edgeId: string) => {
      setSelectedEdgeId(edgeId);
      onSelectExpressionNode(undefined);
    },
    [onSelectExpressionNode],
  );

  const clearExpressionSelection = useCallback(() => {
    setSelectedEdgeId(undefined);
    onSelectExpressionNode(undefined);
  }, [onSelectExpressionNode]);

  return {
    addExpressionNode,
    applyCanvasEdgeChanges,
    applyCanvasNodeChanges,
    clearExpressionSelection,
    connectExpressionNodes,
    deleteExpressionEdges,
    deleteExpressionNode,
    deleteExpressionNodes,
    edges,
    isValidConnection,
    moveExpressionNode,
    newInputSlotId,
    nodes,
    normalizedGraph,
    reconnectExpressionEdge,
    selectExpressionEdge,
    selectExpressionNode,
    selectedEdge,
    selectedEdgeId,
    selectedNode,
    selectedTargetHandles,
    setExpressionRoot,
    setNewInputSlotId,
    updateExpressionNode,
  };
}
