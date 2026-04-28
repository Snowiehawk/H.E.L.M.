import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  PanOnScrollMode,
  Position,
  ReactFlow,
  SelectionMode,
  applyEdgeChanges,
  applyNodeChanges,
  getSmoothStepPath,
  useKeyPress,
  type Connection,
  type ConnectionLineComponentProps,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import type {
  FlowExpressionGraph,
  FlowExpressionNode,
  FlowExpressionNodeKind,
  FlowInputSlot,
} from "../../lib/adapter";
import {
  BINARY_OPERATOR_OPTIONS,
  BOOL_OPERATOR_OPTIONS,
  COMPARE_OPERATOR_OPTIONS,
  EMPTY_EXPRESSION_GRAPH,
  EXPRESSION_INPUT_NODE_KINDS,
  UNARY_OPERATOR_OPTIONS,
  connectExpressionGraphNodes,
  defaultExpressionNode,
  expressionGraphIncomingByTarget,
  graphSummary,
  layoutExpressionGraph,
  normalizeExpressionGraphOrEmpty,
  slotForInputName,
  targetHandlesForExpressionNode,
  withExpressionNodePosition,
  withoutExpressionNodePosition,
  type ExpressionTargetHandle,
} from "../graph/flowExpressionGraphEditing";
import {
  flowExpressionNodeDisplayLabel,
  normalizeFlowExpressionGraph,
} from "../graph/flowExpressionGraph";
import {
  AppContextMenu,
  clampAppContextMenuPosition,
  copyToClipboard,
  type AppContextMenuItem,
  type AppContextMenuPosition,
} from "../shared/AppContextMenu";

interface ExpressionCanvasNodeData extends Record<string, unknown> {
  expressionNode: FlowExpressionNode;
  isRoot: boolean;
  targetHandles: ExpressionTargetHandle[];
}

type ExpressionCanvasNode = Node<ExpressionCanvasNodeData, "expression">;
type ExpressionCanvasEdge = Edge<Record<string, unknown>, "smoothstep">;
type ExpressionContextMenuState = AppContextMenuPosition & {
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

function FlowExpressionConnectionLine({
  connectionStatus,
  fromPosition,
  fromX,
  fromY,
  toPosition,
  toX,
  toY,
}: ConnectionLineComponentProps<ExpressionCanvasNode>) {
  const [edgePath] = getSmoothStepPath({
    sourceX: fromX,
    sourceY: fromY,
    sourcePosition: fromPosition,
    targetX: toX,
    targetY: toY,
    targetPosition: toPosition,
  });
  const statusClass =
    connectionStatus === "invalid"
      ? "is-invalid"
      : connectionStatus === "valid"
        ? "is-valid"
        : "is-pending";

  return (
    <g className={`graph-connection-line ${statusClass}`} data-testid="graph-connection-line">
      <path className="graph-connection-line__halo" d={edgePath} />
      <path className="graph-connection-line__path" d={edgePath} />
      <circle className="graph-connection-line__cursor" cx={toX} cy={toY} r={5.5} />
    </g>
  );
}

function ExpressionNodeView({ data, selected }: NodeProps<ExpressionCanvasNode>) {
  const node = data.expressionNode;
  const label = flowExpressionNodeDisplayLabel(node);
  const minHeight = Math.max(52, data.targetHandles.length * 22 + 18);

  return (
    <div
      className={[
        "flow-expression-canvas__node",
        `flow-expression-canvas__node--${node.kind}`,
        data.isRoot ? "is-root" : "",
        selected ? "is-selected" : "",
        data.targetHandles.length ? "has-targets" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-testid={`flow-expression-node-${node.id}`}
      title={label}
      style={{ minHeight }}
    >
      {data.targetHandles.map((targetHandle, index) => (
        <div
          key={targetHandle.id}
          className="flow-expression-canvas__target"
          style={{ top: 14 + index * 22 }}
        >
          <Handle
            id={targetHandle.id}
            className="flow-expression-canvas__handle flow-expression-canvas__handle--target"
            type="target"
            position={Position.Left}
          />
          <span className="flow-expression-canvas__target-label">{targetHandle.label}</span>
        </div>
      ))}
      <div className="flow-expression-canvas__node-body">
        <span>{node.kind}</span>
        <strong>{label}</strong>
      </div>
      <Handle
        id="value"
        className="flow-expression-canvas__handle flow-expression-canvas__handle--source"
        type="source"
        position={Position.Right}
      />
    </div>
  );
}

const expressionNodeTypes = {
  expression: ExpressionNodeView,
} satisfies NodeTypes;

function expressionNodesForGraph(
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

function expressionEdgesForGraph(
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

function targetHandleForConnection(
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

function selectedNodeTargetHandles(
  graph: FlowExpressionGraph,
  selectedNode: FlowExpressionNode | undefined,
) {
  if (!selectedNode) {
    return [];
  }
  const incomingByTarget = expressionGraphIncomingByTarget(graph);
  return targetHandlesForExpressionNode(selectedNode, incomingByTarget.get(selectedNode.id) ?? []);
}

function isEditableEventTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLButtonElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

export function FlowExpressionGraphCanvas({
  diagnostics,
  error,
  expression,
  graph,
  inputSlots,
  isDraftOnly,
  isSaving,
  ownerLabel,
  selectedExpressionNodeId,
  onGraphChange,
  onNavigateOut,
  onSelectExpressionNode,
}: FlowExpressionGraphCanvasProps) {
  const panelRef = useRef<HTMLElement>(null);
  const normalizedGraph = useMemo(() => normalizeExpressionGraphOrEmpty(graph), [graph]);
  const panModeActive = useKeyPress("Space");
  const [pointerInsidePanel, setPointerInsidePanel] = useState(false);
  const [panPointerDragging, setPanPointerDragging] = useState(false);
  const [nodes, setNodes] = useState<ExpressionCanvasNode[]>(() =>
    expressionNodesForGraph(normalizedGraph, selectedExpressionNodeId),
  );
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | undefined>(undefined);
  const [edges, setEdges] = useState<ExpressionCanvasEdge[]>(() =>
    expressionEdgesForGraph(normalizedGraph),
  );
  const [newInputSlotId, setNewInputSlotId] = useState(() => inputSlots[0]?.id ?? "");
  const [contextMenu, setContextMenu] = useState<ExpressionContextMenuState | null>(null);
  const [contextActionError, setContextActionError] = useState<string | null>(null);
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

  useEffect(() => {
    const handlePointerUp = () => {
      setPanPointerDragging(false);
    };

    window.addEventListener("pointerup", handlePointerUp, true);
    return () => window.removeEventListener("pointerup", handlePointerUp, true);
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    const showPanCursor = panModeActive && (pointerInsidePanel || panPointerDragging);
    document.body.classList.toggle("graph-pan-cursor-active", showPanCursor && !panPointerDragging);
    document.body.classList.toggle(
      "graph-pan-cursor-dragging",
      showPanCursor && panPointerDragging,
    );

    return () => {
      document.body.classList.remove("graph-pan-cursor-active");
      document.body.classList.remove("graph-pan-cursor-dragging");
    };
  }, [panModeActive, panPointerDragging, pointerInsidePanel]);

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
          x: Math.max(24, (selectedCanvasNode?.position.x ?? 24) + (selectedCanvasNode ? 154 : 0)),
          y: Math.max(24, selectedCanvasNode?.position.y ?? 24 + normalizedGraph.nodes.length * 78),
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

  const handleReconnect = useCallback(
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

  const handleNodesChange = useCallback((changes: NodeChange<ExpressionCanvasNode>[]) => {
    setNodes((current) => applyNodeChanges(changes, current));
  }, []);

  const handleEdgesChange = useCallback((changes: EdgeChange<ExpressionCanvasEdge>[]) => {
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

  const closeContextMenu = () => setContextMenu(null);

  const openContextMenu = (
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
  };

  const contextMenuItems = (): AppContextMenuItem[] => {
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
  };

  return (
    <section
      ref={panelRef}
      className={`flow-expression-canvas${panModeActive ? " is-pan-active" : ""}`}
      data-testid="flow-expression-graph-canvas"
      role="region"
      tabIndex={0}
      onPointerOverCapture={() => {
        setPointerInsidePanel(true);
      }}
      onPointerOutCapture={(event) => {
        const nextTarget = event.relatedTarget;
        if (!(nextTarget instanceof globalThis.Node) || !event.currentTarget.contains(nextTarget)) {
          setPointerInsidePanel(false);
        }
      }}
      onPointerDownCapture={(event) => {
        setPointerInsidePanel(true);
        if (!isEditableEventTarget(event.target)) {
          panelRef.current?.focus();
        }
        if (panModeActive && event.button === 0) {
          setPanPointerDragging(true);
        }
      }}
    >
      <header className="flow-expression-canvas__header">
        <div>
          <span className="window-bar__eyebrow">Return graph</span>
          <h3>{ownerLabel}</h3>
        </div>
        <div className="flow-expression-canvas__header-actions">
          <span className={`flow-expression-canvas__status${isDraftOnly ? " is-draft" : ""}`}>
            {isSaving ? "Saving" : isDraftOnly ? "Draft only" : "Live draft"}
          </span>
          <button className="ghost-button" type="button" onClick={onNavigateOut}>
            Back to Flow
          </button>
        </div>
      </header>
      <div className="flow-expression-canvas__toolbar" aria-label="Expression graph tools">
        <label className="flow-expression-canvas__slot-picker">
          <span>Input</span>
          <select
            aria-label="Input node source"
            value={newInputSlotId}
            onChange={(event) => setNewInputSlotId(event.target.value)}
          >
            {inputSlots.length ? (
              inputSlots.map((slot) => (
                <option key={slot.id} value={slot.id}>
                  {slot.label || slot.slotKey}
                </option>
              ))
            ) : (
              <option value="">value</option>
            )}
          </select>
        </label>
        <button
          type="button"
          className="secondary-button"
          onClick={() => addExpressionNode("input")}
        >
          Add input
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={() => addExpressionNode("operator")}
        >
          Add +
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={() => addExpressionNode("call")}
        >
          Add call
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={() => addExpressionNode("literal")}
        >
          Add literal
        </button>
        <button type="button" className="secondary-button" onClick={() => addExpressionNode("raw")}>
          Add raw
        </button>
      </div>
      <div className="flow-expression-canvas__body">
        <div className="flow-expression-canvas__stage">
          <ReactFlow<ExpressionCanvasNode, ExpressionCanvasEdge>
            fitView
            fitViewOptions={{ padding: 0.24 }}
            proOptions={{ hideAttribution: true }}
            nodes={nodes}
            edges={edges}
            nodeTypes={expressionNodeTypes}
            onNodesChange={handleNodesChange}
            onEdgesChange={handleEdgesChange}
            onNodeClick={(_, node) => {
              setSelectedEdgeId(undefined);
              onSelectExpressionNode(node.id);
            }}
            onNodeContextMenu={(event, node) => {
              setSelectedEdgeId(undefined);
              onSelectExpressionNode(node.id);
              openContextMenu(event, "node", node.id);
            }}
            onEdgeClick={(_, edge) => {
              setSelectedEdgeId(edge.id);
              onSelectExpressionNode(undefined);
            }}
            onEdgeContextMenu={(event, edge) => {
              setSelectedEdgeId(edge.id);
              onSelectExpressionNode(undefined);
              openContextMenu(event, "edge", edge.id);
            }}
            onPaneClick={() => {
              setSelectedEdgeId(undefined);
              onSelectExpressionNode(undefined);
            }}
            onPaneContextMenu={(event) => openContextMenu(event, "pane")}
            onNodeDragStop={(_, node) => {
              commitGraph(withExpressionNodePosition(normalizedGraph, node.id, node.position), {
                selectedExpressionNodeId: node.id,
              });
              onSelectExpressionNode(node.id);
            }}
            onNodesDelete={(deletedNodes) => {
              let nextGraph = normalizedGraph;
              deletedNodes.forEach((node) => {
                const nextNodes = nextGraph.nodes.filter((candidate) => candidate.id !== node.id);
                nextGraph = withoutExpressionNodePosition(
                  {
                    ...nextGraph,
                    rootId:
                      nextGraph.rootId === node.id ? (nextNodes[0]?.id ?? null) : nextGraph.rootId,
                    nodes: nextNodes,
                    edges: nextGraph.edges.filter(
                      (edge) => edge.sourceId !== node.id && edge.targetId !== node.id,
                    ),
                  },
                  node.id,
                );
              });
              commitGraph(nextGraph, {
                selectedExpressionNodeId: nextGraph.rootId ?? nextGraph.nodes[0]?.id,
              });
            }}
            onEdgesDelete={(deletedEdges) => {
              deleteExpressionEdges(deletedEdges.map((edge) => edge.id));
            }}
            onConnect={connectExpressionNodes}
            onReconnect={handleReconnect}
            nodesDraggable
            nodesConnectable
            edgesReconnectable
            deleteKeyCode={["Backspace", "Delete"]}
            selectionKeyCode={null}
            multiSelectionKeyCode={["Meta", "Control", "Shift"]}
            selectionOnDrag={!panModeActive}
            selectionMode={SelectionMode.Partial}
            paneClickDistance={4}
            connectionLineComponent={FlowExpressionConnectionLine}
            connectionLineContainerStyle={{ pointerEvents: "none", zIndex: 30 }}
            connectionRadius={28}
            reconnectRadius={20}
            isValidConnection={isValidConnection}
            minZoom={0.25}
            maxZoom={1.8}
            zoomOnScroll={false}
            panOnScroll
            panOnScrollMode={PanOnScrollMode.Free}
            zoomActivationKeyCode="Alt"
            panOnDrag={panModeActive}
            onKeyDown={(event) => {
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
            }}
          >
            <Controls showInteractive={false} />
            <Background gap={24} size={1} color="var(--line-strong)" />
          </ReactFlow>
          {contextActionError ? (
            <p className="error-copy graph-context-error">{contextActionError}</p>
          ) : null}
          {contextMenu ? (
            <AppContextMenu
              label={
                contextMenu.kind === "node"
                  ? "Expression node actions"
                  : contextMenu.kind === "edge"
                    ? "Expression edge actions"
                    : "Expression graph actions"
              }
              items={contextMenuItems()}
              position={contextMenu}
              onActionError={setContextActionError}
              onClose={closeContextMenu}
            />
          ) : null}
        </div>
        <aside className="flow-expression-canvas__side">
          <div className="flow-expression-canvas__stat">{graphSummary(normalizedGraph)}</div>
          <div className="flow-expression-canvas__selected">
            <span className="window-bar__eyebrow">Selected</span>
            <strong>
              {selectedNode
                ? flowExpressionNodeDisplayLabel(selectedNode)
                : selectedEdge
                  ? "Expression edge"
                  : "None"}
            </strong>
            {selectedNode ? (
              <>
                <div className="flow-expression-canvas__selected-actions">
                  <button
                    className="ghost-button"
                    type="button"
                    disabled={selectedNode.id === normalizedGraph.rootId}
                    onClick={() => setExpressionRoot(selectedNode.id)}
                  >
                    Set root
                  </button>
                  <button
                    className="ghost-button"
                    type="button"
                    onClick={() => deleteExpressionNode(selectedNode.id)}
                  >
                    Delete
                  </button>
                </div>
                {selectedNode.kind === "input" ? (
                  <label className="blueprint-field">
                    <span className="blueprint-field__label">
                      <strong>Name</strong>
                    </span>
                    <input
                      aria-label="Expression input name"
                      value={String(selectedNode.payload.name ?? selectedNode.label)}
                      onChange={(event) => {
                        const name = event.target.value;
                        const slot = slotForInputName(inputSlots, name);
                        updateExpressionNode(selectedNode.id, (node) => ({
                          ...node,
                          label: name,
                          payload: {
                            ...node.payload,
                            name,
                            ...(slot ? { slot_id: slot.id } : {}),
                          },
                        }));
                      }}
                    />
                  </label>
                ) : null}
                {selectedNode.kind === "operator" ? (
                  <label className="blueprint-field">
                    <span className="blueprint-field__label">
                      <strong>Operator</strong>
                    </span>
                    <select
                      aria-label="Expression operator"
                      value={String(selectedNode.payload.operator ?? selectedNode.label)}
                      onChange={(event) => {
                        const operator = event.target.value;
                        updateExpressionNode(selectedNode.id, (node) => ({
                          ...node,
                          label: operator,
                          payload: { ...node.payload, operator },
                        }));
                      }}
                    >
                      {BINARY_OPERATOR_OPTIONS.map((operator) => (
                        <option key={operator} value={operator}>
                          {operator}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {selectedNode.kind === "unary" ? (
                  <label className="blueprint-field">
                    <span className="blueprint-field__label">
                      <strong>Unary</strong>
                    </span>
                    <select
                      aria-label="Expression unary operator"
                      value={String(selectedNode.payload.operator ?? selectedNode.label)}
                      onChange={(event) => {
                        const operator = event.target.value;
                        updateExpressionNode(selectedNode.id, (node) => ({
                          ...node,
                          label: operator,
                          payload: { ...node.payload, operator },
                        }));
                      }}
                    >
                      {UNARY_OPERATOR_OPTIONS.map((operator) => (
                        <option key={operator} value={operator}>
                          {operator}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {selectedNode.kind === "bool" ? (
                  <label className="blueprint-field">
                    <span className="blueprint-field__label">
                      <strong>Boolean</strong>
                    </span>
                    <select
                      aria-label="Expression boolean operator"
                      value={String(selectedNode.payload.operator ?? selectedNode.label)}
                      onChange={(event) => {
                        const operator = event.target.value;
                        updateExpressionNode(selectedNode.id, (node) => ({
                          ...node,
                          label: operator,
                          payload: { ...node.payload, operator },
                        }));
                      }}
                    >
                      {BOOL_OPERATOR_OPTIONS.map((operator) => (
                        <option key={operator} value={operator}>
                          {operator}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {selectedNode.kind === "compare" ? (
                  <label className="blueprint-field">
                    <span className="blueprint-field__label">
                      <strong>Compare</strong>
                    </span>
                    <select
                      aria-label="Expression compare operator"
                      value={String(
                        (selectedNode.payload.operators as unknown[] | undefined)?.[0] ??
                          selectedNode.label,
                      )}
                      onChange={(event) => {
                        const operator = event.target.value;
                        updateExpressionNode(selectedNode.id, (node) => ({
                          ...node,
                          label: operator,
                          payload: { ...node.payload, operators: [operator] },
                        }));
                      }}
                    >
                      {COMPARE_OPERATOR_OPTIONS.map((operator) => (
                        <option key={operator} value={operator}>
                          {operator}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {selectedNode.kind === "literal" || selectedNode.kind === "raw" ? (
                  <label className="blueprint-field">
                    <span className="blueprint-field__label">
                      <strong>{selectedNode.kind === "literal" ? "Literal" : "Raw"}</strong>
                    </span>
                    <input
                      aria-label={`Expression ${selectedNode.kind} source`}
                      value={String(selectedNode.payload.expression ?? selectedNode.label)}
                      onChange={(event) => {
                        const source = event.target.value;
                        updateExpressionNode(selectedNode.id, (node) => ({
                          ...node,
                          label: source,
                          payload: { ...node.payload, expression: source },
                        }));
                      }}
                    />
                  </label>
                ) : null}
                {!EXPRESSION_INPUT_NODE_KINDS.has(selectedNode.kind) ? (
                  <div className="flow-expression-canvas__target-list">
                    <span className="window-bar__eyebrow">Inputs</span>
                    {selectedTargetHandles.map((targetHandle) => (
                      <span key={targetHandle.id}>{targetHandle.id}</span>
                    ))}
                  </div>
                ) : null}
              </>
            ) : null}
            {selectedEdge ? (
              <button
                className="ghost-button"
                type="button"
                onClick={() => deleteExpressionEdges([selectedEdge.id])}
              >
                Delete edge
              </button>
            ) : null}
          </div>
          <div className="flow-expression-canvas__source">
            <span className="blueprint-field__label">
              <strong>Expression source</strong>
              <span>{isDraftOnly ? "Draft only" : "Generated"}</span>
            </span>
            <code>{expression || "..."}</code>
          </div>
          {diagnostics.length ? (
            <div className="flow-expression-canvas__diagnostics">
              {diagnostics.map((diagnostic) => (
                <span key={diagnostic}>{diagnostic}</span>
              ))}
            </div>
          ) : null}
          {error ? <p className="error-copy">{error}</p> : null}
        </aside>
      </div>
    </section>
  );
}
