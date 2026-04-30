import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import {
  Background,
  Controls,
  PanOnScrollMode,
  ReactFlow,
  SelectionMode,
  getSmoothStepPath,
  useKeyPress,
  type Connection,
  type ConnectionLineComponentProps,
  type EdgeTypes,
  type NodeChange,
  type NodeTypes,
  type ReactFlowInstance,
} from "@xyflow/react";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import type {
  GraphAbstractionLevel,
  GraphBreadcrumbDto,
  GraphEdgeKind,
  GraphFilters,
  FlowInputDisplayMode,
  GraphNodeKind,
  GraphSettings,
  GraphView,
} from "../../lib/adapter";
import { isGraphSymbolNodeKind } from "../../lib/adapter";
import { isFlowNodeAuthorableKind } from "./flowDocument";
import { GraphToolbar } from "./GraphToolbar";
import { BlueprintNode } from "./BlueprintNode";
import { BlueprintEdge, type BlueprintEdgeData } from "./BlueprintEdge";
import { RerouteNode } from "./RerouteNode";
import {
  helpIdForGraphEdgeKind,
  helpTargetProps,
  useWorkspaceHelp,
} from "../workspace/workspaceHelp";
import { buildBlueprintPresentation } from "./blueprintPorts";
import { declutterGraphLayout } from "./declutterLayout";
import { layoutFlowGraph } from "./flowLayout";
import {
  graphLayoutViewKey,
  peekStoredGraphLayout,
  readStoredGraphLayout,
  type StoredGraphGroup,
  type StoredGraphLayout,
  writeStoredGraphLayout,
} from "./graphLayoutPersistence";
import { organizeGroupedNodes, type GroupOrganizeMode } from "./groupOrganizeLayout";
import { EmptyState } from "../shared/EmptyState";
import {
  AppContextMenu,
  clampAppContextMenuPosition,
  type AppContextMenuPosition,
} from "../shared/AppContextMenu";
import { useUiStore } from "../../store/uiStore";
import { useUndoStore } from "../../store/undoStore";

import {
  EMPTY_STRING_SET,
  DEFAULT_GROUP_TITLE,
  FLOW_CONNECTION_RADIUS,
  FLOW_RECONNECT_RADIUS,
  MAX_GRAPH_ZOOM,
  MIN_GRAPH_ZOOM,
} from "./GraphCanvas/constants";
import { GraphGroupLayer } from "./GraphCanvas/GraphGroupLayer";
import {
  shouldHandleCreateModeKey,
  shouldHandleFitViewKey,
  shouldHandleGroupKey,
  shouldHandlePinKey,
  shouldHandleRerouteDeleteKey,
  shouldHandleUngroupKey,
  isEditableEventTarget,
} from "./GraphCanvas/keyboard";
import {
  applyStoredLayout,
  buildGraphGroupBoundsList,
  createRerouteId,
  normalizeRerouteNodeOrders,
  persistGraphLayout,
  pinActionHelpId,
  semanticNodeDimension,
  semanticPinnedNodeIds,
  storedLayoutIsEmpty,
  storedLayoutsEqual,
  toDeclutterNodes,
  toFlowLayoutNodes,
  rerouteNodeId,
} from "./GraphCanvas/layoutHelpers";
import {
  buildCanvasNodes,
  applyNodeDecorations,
  buildRerouteShellClassName,
} from "./GraphCanvas/canvasNodes";
import { buildGraphContextMenuItems, buildGraphContextMenuLabel } from "./GraphCanvas/contextMenu";
import { buildCanvasEdges } from "./GraphCanvas/canvasEdges";
import {
  resolveFlowEdgeInteraction,
  isValidFlowCanvasConnection,
  isVisualFunctionInputNode,
} from "./GraphCanvas/flowConnections";
import {
  applyGroupedLayoutPositions,
  applyGroupedPositionChanges,
  applyMemberNodeDelta,
  buildGroupMembership,
  expandGroupedNodeIds,
  mergeGroupsForSelection,
  normalizeStoredGroups,
  renameGraphGroup,
  ungroupGroupsForSelection,
} from "./GraphCanvas/grouping";
import {
  resolveSelectionPreviewNodeId,
  resolveSelectionPreviewNodeIds,
  sameNodeIds,
  sortNodeIds,
} from "./GraphCanvas/selection";
import type {
  CreateModeState,
  GraphCanvasEdge,
  GraphCanvasNode,
  GraphContextMenuState,
  GraphCreateIntent,
  GraphExpressionGraphIntent,
  GraphFlowConnectionIntent,
  GraphFlowDeleteIntent,
  GraphFlowEditIntent,
  LayoutUndoStackEntry,
  RerouteCanvasNode,
  SemanticCanvasNode,
} from "./GraphCanvas/types";
export type {
  CreateModeState,
  GraphCreateIntent,
  GraphExpressionGraphIntent,
  GraphFlowConnectionIntent,
  GraphFlowDeleteIntent,
  GraphFlowEditIntent,
} from "./GraphCanvas/types";
export { buildEdgeLabelOffsets, collapseDuplicateEdgeLabels } from "./GraphCanvas/canvasEdges";
export {
  resolveFlowEdgeInteraction,
  isValidFlowCanvasConnection,
} from "./GraphCanvas/flowConnections";
export {
  applyGroupedLayoutPositions,
  applyGroupedPositionChanges,
  applyMemberNodeDelta,
  expandGroupedNodeIds,
  mergeGroupsForSelection,
  normalizeStoredGroups,
  renameGraphGroup,
  ungroupGroupsForSelection,
} from "./GraphCanvas/grouping";
export { resolveSelectionPreviewNodeId } from "./GraphCanvas/selection";

const nodeTypes: NodeTypes = {
  blueprint: BlueprintNode,
  reroute: RerouteNode,
};

const edgeTypes: EdgeTypes = {
  blueprint: BlueprintEdge,
};

const noopExpressionGraphIntent = () => {};

function isSemanticCanvasNode(node: GraphCanvasNode): node is SemanticCanvasNode {
  return node.type === "blueprint";
}

function isRerouteCanvasNode(node: GraphCanvasNode): node is RerouteCanvasNode {
  return node.type === "reroute";
}

function BlueprintConnectionLine({
  connectionStatus,
  fromPosition,
  fromX,
  fromY,
  toPosition,
  toX,
  toY,
}: ConnectionLineComponentProps<GraphCanvasNode>) {
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
export function GraphCanvas({
  repoPath,
  graph,
  isLoading = false,
  errorMessage,
  activeNodeId,
  graphFilters,
  graphSettings,
  flowInputDisplayMode = "param_nodes",
  highlightGraphPath,
  showEdgeLabels,
  onSelectNode,
  onActivateNode,
  onInspectNode,
  onOpenNodeInDefaultEditor,
  onRevealNodeInFileExplorer,
  onSelectBreadcrumb: _onSelectBreadcrumb,
  onSelectLevel,
  onToggleGraphFilter,
  onToggleGraphSetting,
  onSetFlowInputDisplayMode = () => {},
  onToggleGraphPathHighlight,
  onToggleEdgeLabels,
  onClearSelection,
  createModeState = "inactive",
  createModeCanvasEnabled = false,
  createModeHint,
  onToggleCreateMode = () => {},
  onCreateIntent = () => {},
  onEditFlowNodeIntent = () => {},
  onOpenExpressionGraphIntent = noopExpressionGraphIntent,
  onConnectFlowEdge = () => {},
  onReconnectFlowEdge = () => {},
  onDisconnectFlowEdge = () => {},
  onDeleteFlowSelection = () => {},
  onDeleteSymbolNode = () => {},
}: {
  repoPath?: string;
  graph?: GraphView;
  isLoading?: boolean;
  errorMessage?: string | null;
  activeNodeId?: string;
  graphFilters: GraphFilters;
  graphSettings: GraphSettings;
  flowInputDisplayMode?: FlowInputDisplayMode;
  highlightGraphPath: boolean;
  showEdgeLabels: boolean;
  onSelectNode: (nodeId: string, kind: GraphNodeKind) => void;
  onActivateNode: (nodeId: string, kind: GraphNodeKind) => void;
  onInspectNode: (nodeId: string, kind: GraphNodeKind) => void;
  onOpenNodeInDefaultEditor?: (nodeId: string) => void | Promise<void>;
  onRevealNodeInFileExplorer?: (nodeId: string) => void | Promise<void>;
  onSelectBreadcrumb: (breadcrumb: GraphBreadcrumbDto) => void;
  onSelectLevel: (level: GraphAbstractionLevel) => void;
  onToggleGraphFilter: (key: keyof GraphFilters) => void;
  onToggleGraphSetting: (key: keyof GraphSettings) => void;
  onSetFlowInputDisplayMode?: (mode: FlowInputDisplayMode) => void;
  onToggleGraphPathHighlight: () => void;
  onToggleEdgeLabels: () => void;
  onNavigateOut: () => void;
  onClearSelection: () => void;
  createModeState?: CreateModeState;
  createModeCanvasEnabled?: boolean;
  createModeHint?: string;
  onToggleCreateMode?: () => void;
  onCreateIntent?: (intent: GraphCreateIntent) => void;
  onEditFlowNodeIntent?: (intent: GraphFlowEditIntent) => void;
  onOpenExpressionGraphIntent?: (intent: GraphExpressionGraphIntent) => void;
  onConnectFlowEdge?: (connection: GraphFlowConnectionIntent) => void;
  onReconnectFlowEdge?: (edgeId: string, connection: GraphFlowConnectionIntent) => void;
  onDisconnectFlowEdge?: (edgeId: string) => void;
  onDeleteFlowSelection?: (selection: GraphFlowDeleteIntent) => void;
  onDeleteSymbolNode?: (nodeId: string) => void;
}) {
  const { setTransientHelpTarget } = useWorkspaceHelp();
  const blueprint = useMemo(() => (graph ? buildBlueprintPresentation(graph) : undefined), [graph]);
  const denseGraph = (graph?.nodes.length ?? 0) > 12;
  const fitViewOptions = useMemo(
    () =>
      !graph
        ? undefined
        : graph.level === "flow"
          ? { padding: 0.1, minZoom: 0.4, maxZoom: 1.08 }
          : graph.level === "symbol"
            ? { padding: 0.08, minZoom: denseGraph ? 0.34 : 0.44, maxZoom: 1.2 }
            : { padding: 0.08, minZoom: denseGraph ? 0.3 : 0.4, maxZoom: 1.14 },
    [denseGraph, graph],
  );
  const graphNodeIds = useMemo(() => new Set(graph?.nodes.map((node) => node.id) ?? []), [graph]);
  const graphNodeById = useMemo(
    () => new Map(graph?.nodes.map((node) => [node.id, node] as const) ?? []),
    [graph],
  );
  const viewKey = graph ? graphLayoutViewKey(graph) : undefined;
  const hydrationGenerationRef = useRef(0);
  const panelRef = useRef<HTMLElement>(null);
  const reactFlowInstanceRef = useRef<ReactFlowInstance<GraphCanvasNode, GraphCanvasEdge> | null>(
    null,
  );
  const graphHotkeyActiveRef = useRef(false);
  const skipNextSelectionSyncRef = useRef(false);
  const shiftPressedRef = useRef(false);
  const pendingLayoutUndoRef = useRef<LayoutUndoStackEntry | undefined>(undefined);
  const createModeActive = createModeState !== "inactive";
  const createModeReady = createModeState === "active";
  const [nodes, setNodes] = useState<GraphCanvasNode[]>([]);
  const nodesRef = useRef<GraphCanvasNode[]>([]);
  const [groups, setGroups] = useState<StoredGraphGroup[]>([]);
  const [selectedSemanticNodeIds, setSelectedSemanticNodeIds] = useState<string[]>([]);
  const [selectedControlEdgeIds, setSelectedControlEdgeIds] = useState<string[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string | undefined>(undefined);
  const [editingGroupId, setEditingGroupId] = useState<string | undefined>(undefined);
  const [organizeGroupId, setOrganizeGroupId] = useState<string | undefined>(undefined);
  const [editingGroupTitle, setEditingGroupTitle] = useState(DEFAULT_GROUP_TITLE);
  const [marqueeSelectionActive, setMarqueeSelectionActive] = useState(false);
  const [layoutUndoStacks, setLayoutUndoStacks] = useState<Record<string, LayoutUndoStackEntry[]>>(
    {},
  );
  const [layoutRedoStacks, setLayoutRedoStacks] = useState<Record<string, LayoutUndoStackEntry[]>>(
    {},
  );
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | undefined>(undefined);
  const [hoveredPortEdgeIds, setHoveredPortEdgeIds] = useState<string[]>([]);
  const [contextMenu, setContextMenu] = useState<GraphContextMenuState | null>(null);
  const [contextActionError, setContextActionError] = useState<string | null>(null);
  const setLastActivity = useUiStore((state) => state.setLastActivity);
  const panModeActive = useKeyPress("Space");
  const [pointerInsidePanel, setPointerInsidePanel] = useState(false);
  const [panPointerDragging, setPanPointerDragging] = useState(false);
  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);
  const selectedRerouteNodes = useMemo(
    () => nodes.filter((node) => isRerouteCanvasNode(node) && Boolean(node.selected)),
    [nodes],
  );
  const selectedRerouteCount = selectedRerouteNodes.length;
  const selectedControlEdgeIdSet = useMemo(
    () => new Set(selectedControlEdgeIds),
    [selectedControlEdgeIds],
  );
  const flowAuthoringEnabled =
    graph?.level === "flow" &&
    graph.flowState?.editable === true &&
    Boolean(graph.flowState?.document);
  const authorableFlowNodeIds = useMemo(
    () =>
      new Set(
        (graph?.flowState?.document?.nodes ?? [])
          .filter((node) => isFlowNodeAuthorableKind(node.kind))
          .map((node) => node.id),
      ),
    [graph?.flowState?.document],
  );
  const deletableVisualFlowNodeIds = useMemo(
    () =>
      new Set(
        graph?.level === "flow"
          ? (graph.nodes ?? []).filter(isVisualFunctionInputNode).map((node) => node.id)
          : [],
      ),
    [graph],
  );
  const { groupByNodeId, memberNodeIdsByGroupId } = useMemo(
    () => buildGroupMembership(groups),
    [groups],
  );
  const groupedNodeIds = useMemo(() => new Set(sortNodeIds(groupByNodeId.keys())), [groupByNodeId]);
  const semanticSelection = useMemo(
    () => sortNodeIds(selectedSemanticNodeIds.filter((nodeId) => graphNodeIds.has(nodeId))),
    [graphNodeIds, selectedSemanticNodeIds],
  );
  const currentLayoutUndoStack = useMemo(
    () => (viewKey ? (layoutUndoStacks[viewKey] ?? []) : []),
    [layoutUndoStacks, viewKey],
  );
  const currentLayoutRedoStack = useMemo(
    () => (viewKey ? (layoutRedoStacks[viewKey] ?? []) : []),
    [layoutRedoStacks, viewKey],
  );
  const semanticSelectionFromNodes = useMemo(
    () =>
      sortNodeIds(
        nodes
          .filter((node) => isSemanticCanvasNode(node) && Boolean(node.selected))
          .map((node) => node.id),
      ),
    [nodes],
  );
  const effectiveSemanticSelection = semanticSelection.length
    ? semanticSelection
    : semanticSelectionFromNodes;
  const effectiveSemanticSelectionKey = effectiveSemanticSelection.join("\0");
  const selectedGroupMemberNodeIds = useMemo(
    () => new Set(selectedGroupId ? (memberNodeIdsByGroupId.get(selectedGroupId) ?? []) : []),
    [memberNodeIdsByGroupId, selectedGroupId],
  );
  const selectionPreviewNodeIds = useMemo(
    () =>
      !graph
        ? []
        : resolveSelectionPreviewNodeIds({
            activeNodeId,
            effectiveSemanticSelection,
            graphNodeIds,
            marqueeSelectionActive,
            selectedGroupId,
            selectedRerouteCount,
          }),
    [
      activeNodeId,
      effectiveSemanticSelectionKey,
      graph,
      graphNodeIds,
      marqueeSelectionActive,
      selectedGroupId,
      selectedRerouteCount,
    ],
  );
  const selectionPreviewNodeIdsKey = selectionPreviewNodeIds.join("\0");
  const selectedPreviewNodeIds = useMemo(
    () => new Set(selectionPreviewNodeIds),
    [selectionPreviewNodeIdsKey],
  );
  const selectedNodeId = !graph
    ? ""
    : resolveSelectionPreviewNodeId({
        activeNodeId,
        effectiveSemanticSelection,
        graphNodeIds,
        marqueeSelectionActive,
        selectedGroupId,
        selectedRerouteCount,
      });
  const highlightedEdgeIds = useMemo(
    () =>
      new Set(
        hoveredPortEdgeIds.length ? hoveredPortEdgeIds : hoveredEdgeId ? [hoveredEdgeId] : [],
      ),
    [hoveredEdgeId, hoveredPortEdgeIds],
  );
  const hoverActive = highlightedEdgeIds.size > 0;
  const selectedConnectedEdgeIds = useMemo(
    () =>
      new Set(
        (graph?.edges ?? [])
          .filter(
            (edge) =>
              selectedPreviewNodeIds.has(edge.source) || selectedPreviewNodeIds.has(edge.target),
          )
          .map((edge) => edge.id),
      ),
    [graph?.edges, selectedPreviewNodeIds],
  );
  const selectedRelatedNodeIds = useMemo(() => {
    const related = new Set<string>();
    if (!selectionPreviewNodeIds.length) {
      return related;
    }

    selectionPreviewNodeIds.forEach((nodeId) => {
      related.add(nodeId);
    });
    (graph?.edges ?? []).forEach((edge) => {
      if (selectedPreviewNodeIds.has(edge.source) || selectedPreviewNodeIds.has(edge.target)) {
        related.add(edge.source);
        related.add(edge.target);
      }
    });
    return related;
  }, [graph?.edges, selectionPreviewNodeIdsKey, selectedPreviewNodeIds]);
  const selectionContextActive = selectionPreviewNodeIds.length > 0;
  const canPinNodes = graph?.level === "flow";
  const selectedDeletableFlowNodeIds = useMemo(
    () =>
      effectiveSemanticSelection.filter(
        (nodeId) => authorableFlowNodeIds.has(nodeId) || deletableVisualFlowNodeIds.has(nodeId),
      ),
    [authorableFlowNodeIds, deletableVisualFlowNodeIds, effectiveSemanticSelection],
  );
  const selectedDeletableSymbolNodeId = useMemo(() => {
    if (!graph || !selectedNodeId) {
      return undefined;
    }
    const selectedNode = graph.nodes.find((node) => node.id === selectedNodeId);
    if (!selectedNode || !isGraphSymbolNodeKind(selectedNode.kind)) {
      return undefined;
    }
    const deleteAction = selectedNode.availableActions.find(
      (action) => action.actionId === "delete_symbol",
    );
    return deleteAction?.enabled ? selectedNode.id : undefined;
  }, [graph, selectedNodeId]);

  const clearLocalSelection = () => {
    setSelectedSemanticNodeIds([]);
    setSelectedControlEdgeIds([]);
    setSelectedGroupId(undefined);
    setOrganizeGroupId(undefined);
    setNodes((current) =>
      current.some((node) => node.selected)
        ? current.map((node) => (node.selected ? { ...node, selected: false } : node))
        : current,
    );
  };

  const requestCreateIntent = (
    clientPosition: { x: number; y: number },
    flowPosition: { x: number; y: number },
  ) => {
    const panelBounds = panelRef.current?.getBoundingClientRect();
    onCreateIntent({
      flowPosition,
      panelPosition: {
        x: panelBounds ? clientPosition.x - panelBounds.left : clientPosition.x,
        y: panelBounds ? clientPosition.y - panelBounds.top : clientPosition.y,
      },
    });
  };

  const screenToFlowPosition = useCallback(
    (clientPosition: { x: number; y: number }) =>
      reactFlowInstanceRef.current?.screenToFlowPosition(clientPosition) ?? {
        x: clientPosition.x,
        y: clientPosition.y,
      },
    [],
  );
  const requestExpressionGraphIntent = useCallback(
    (nodeId: string, expressionNodeId?: string, clientPosition?: { x: number; y: number }) => {
      const panelBounds = panelRef.current?.getBoundingClientRect();
      const canvasNode = nodesRef.current.find((node) => node.id === nodeId);
      const fallbackFlowPosition = canvasNode
        ? { x: canvasNode.position.x + 220, y: canvasNode.position.y + 48 }
        : { x: 0, y: 0 };
      const projectedPosition =
        clientPosition ??
        (canvasNode && reactFlowInstanceRef.current?.flowToScreenPosition
          ? reactFlowInstanceRef.current.flowToScreenPosition(fallbackFlowPosition)
          : undefined);
      onOpenExpressionGraphIntent({
        nodeId,
        expressionNodeId,
        flowPosition: projectedPosition
          ? screenToFlowPosition(projectedPosition)
          : fallbackFlowPosition,
        panelPosition: {
          x:
            projectedPosition && panelBounds
              ? projectedPosition.x - panelBounds.left
              : (projectedPosition?.x ?? 24),
          y:
            projectedPosition && panelBounds
              ? projectedPosition.y - panelBounds.top
              : (projectedPosition?.y ?? 24),
        },
      });
    },
    [onOpenExpressionGraphIntent, screenToFlowPosition],
  );
  const selectControlEdge = useCallback(
    (edgeId: string) => {
      setSelectedControlEdgeIds([edgeId]);
      setSelectedGroupId(undefined);
      setOrganizeGroupId(undefined);
      setSelectedSemanticNodeIds([]);
      setNodes((current) =>
        current.some((node) => node.selected)
          ? current.map((node) => (node.selected ? { ...node, selected: false } : node))
          : current,
      );
      onClearSelection();
    },
    [onClearSelection],
  );

  const closeContextMenu = useCallback(
    (restoreFocus = false) => {
      const focusElement = contextMenu?.focusElement;
      setContextMenu(null);
      if (restoreFocus) {
        window.requestAnimationFrame(() => {
          focusElement?.focus();
          panelRef.current?.focus();
        });
      }
    },
    [contextMenu?.focusElement],
  );

  const openPaneContextMenu = useCallback(
    (event: ReactMouseEvent<Element> | MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const position = clampAppContextMenuPosition(event.clientX, event.clientY);
      setContextActionError(null);
      setContextMenu({
        kind: "pane",
        ...position,
        flowPosition: screenToFlowPosition({ x: event.clientX, y: event.clientY }),
        focusElement: panelRef.current,
      });
    },
    [screenToFlowPosition],
  );

  const openEdgeContextMenu = useCallback(
    (
      edgeId: string,
      edgeKind: GraphEdgeKind,
      segmentIndex: number,
      flowPosition: { x: number; y: number },
      clientPosition: { x: number; y: number },
      edgeLabel?: string,
    ) => {
      const position = clampAppContextMenuPosition(clientPosition.x, clientPosition.y);
      setContextActionError(null);
      setContextMenu({
        kind: "edge",
        edgeId,
        edgeKind,
        edgeLabel,
        segmentIndex,
        flowPosition,
        ...position,
        focusElement: panelRef.current,
      });
    },
    [],
  );

  const openNodeContextMenu = useCallback(
    (event: ReactMouseEvent<Element>, node: GraphCanvasNode) => {
      event.preventDefault();
      event.stopPropagation();
      const position = clampAppContextMenuPosition(event.clientX, event.clientY);
      setContextActionError(null);

      if (isRerouteCanvasNode(node)) {
        setSelectedControlEdgeIds([]);
        setSelectedGroupId(undefined);
        setOrganizeGroupId(undefined);
        setSelectedSemanticNodeIds([]);
        setNodes((current) =>
          current.map((currentNode) => ({
            ...currentNode,
            selected: currentNode.id === node.id,
          })),
        );
        onClearSelection();
        setContextMenu({
          kind: "node",
          nodeId: node.id,
          ...position,
          focusElement: event.currentTarget as HTMLElement,
        });
        return;
      }

      if (!selectedSemanticNodeIds.includes(node.id)) {
        setSelectedControlEdgeIds([]);
        setSelectedGroupId(undefined);
        setOrganizeGroupId(undefined);
        setSelectedSemanticNodeIds([node.id]);
        setNodes((current) =>
          current.map((currentNode) => {
            if (isRerouteCanvasNode(currentNode)) {
              return currentNode.selected ? { ...currentNode, selected: false } : currentNode;
            }
            return {
              ...currentNode,
              selected: currentNode.id === node.id,
            };
          }),
        );
        onSelectNode(node.id, node.data.kind);
      }

      setContextMenu({
        kind: "node",
        nodeId: node.id,
        ...position,
        focusElement: event.currentTarget as HTMLElement,
      });
    },
    [onClearSelection, onSelectNode, selectedSemanticNodeIds],
  );
  const persistCurrentLayout = (
    nextNodes: GraphCanvasNode[],
    nextGroups: StoredGraphGroup[] = groups,
  ) => {
    void writeStoredGraphLayout(repoPath, viewKey, persistGraphLayout(nextNodes, nextGroups));
  };

  const pushLayoutUndoEntry = (
    summary: string,
    previousLayout: StoredGraphLayout,
    targetViewKey = viewKey,
  ) => {
    if (!targetViewKey) {
      return;
    }

    setLayoutUndoStacks((current) => ({
      ...current,
      [targetViewKey]: [
        ...(current[targetViewKey] ?? []),
        {
          viewKey: targetViewKey,
          layout: previousLayout,
          entry: {
            domain: "layout",
            summary,
            createdAt: Date.now(),
          },
        },
      ],
    }));
    setLayoutRedoStacks((current) => ({
      ...current,
      [targetViewKey]: [],
    }));
  };

  const capturePendingLayoutUndo = (summary: string) => {
    if (!viewKey || pendingLayoutUndoRef.current) {
      return;
    }

    pendingLayoutUndoRef.current = {
      viewKey,
      layout: persistGraphLayout(nodes, groups),
      entry: {
        domain: "layout",
        summary,
        createdAt: Date.now(),
      },
    };
  };

  const finalizePendingLayoutUndo = () => {
    const pendingUndo = pendingLayoutUndoRef.current;
    pendingLayoutUndoRef.current = undefined;
    if (!pendingUndo || pendingUndo.viewKey !== viewKey) {
      return;
    }

    const currentLayout = persistGraphLayout(nodes, groups);
    if (storedLayoutsEqual(pendingUndo.layout, currentLayout)) {
      return;
    }

    pushLayoutUndoEntry(pendingUndo.entry.summary, pendingUndo.layout, pendingUndo.viewKey);
  };

  const applyLayoutHistoryEntry = (
    layoutHistory: LayoutUndoStackEntry,
    direction: "undo" | "redo",
  ) => {
    const inverseLayout = persistGraphLayout(nodes, groups);
    const inverseEntry: LayoutUndoStackEntry = {
      viewKey: layoutHistory.viewKey,
      layout: inverseLayout,
      entry: {
        ...layoutHistory.entry,
        createdAt: Date.now(),
      },
    };

    hydrationGenerationRef.current += 1;
    setNodes((current) => applyStoredLayout(current, layoutHistory.layout));
    setGroups(layoutHistory.layout.groups ?? []);
    setOrganizeGroupId(undefined);
    setEditingGroupId(undefined);
    setEditingGroupTitle(DEFAULT_GROUP_TITLE);
    void writeStoredGraphLayout(repoPath, layoutHistory.viewKey, layoutHistory.layout);

    if (direction === "undo") {
      setLayoutUndoStacks((current) => ({
        ...current,
        [layoutHistory.viewKey]: (current[layoutHistory.viewKey] ?? []).slice(0, -1),
      }));
      setLayoutRedoStacks((current) => ({
        ...current,
        [layoutHistory.viewKey]: [...(current[layoutHistory.viewKey] ?? []), inverseEntry],
      }));
    } else {
      setLayoutRedoStacks((current) => ({
        ...current,
        [layoutHistory.viewKey]: (current[layoutHistory.viewKey] ?? []).slice(0, -1),
      }));
      setLayoutUndoStacks((current) => ({
        ...current,
        [layoutHistory.viewKey]: [...(current[layoutHistory.viewKey] ?? []), inverseEntry],
      }));
    }

    setLastActivity({
      domain: "layout",
      kind: direction,
      summary: `${direction === "undo" ? "Undid" : "Redid"} layout: ${layoutHistory.entry.summary}`,
    });
  };

  const persistCurrentCanvasState = () => {
    hydrationGenerationRef.current += 1;
    setNodes((current) => {
      persistCurrentLayout(current, groups);
      return current;
    });
  };

  const selectGroup = (groupId: string) => {
    setSelectedControlEdgeIds([]);
    setSelectedGroupId(groupId);
    setOrganizeGroupId((current) => (current === groupId ? current : undefined));
    setSelectedSemanticNodeIds([]);
    setNodes((current) =>
      current.some((node) => node.selected)
        ? current.map((node) => (node.selected ? { ...node, selected: false } : node))
        : current,
    );
  };

  const beginGroupTitleEditing = (groupId: string) => {
    const group = groups.find((candidate) => candidate.id === groupId);
    if (!group) {
      return;
    }
    selectGroup(groupId);
    setOrganizeGroupId(undefined);
    setEditingGroupId(groupId);
    setEditingGroupTitle(group.title);
  };

  const finishGroupTitleEditing = (groupId: string, mode: "save" | "cancel") => {
    if (editingGroupId !== groupId) {
      return;
    }

    if (mode === "cancel") {
      setEditingGroupId(undefined);
      setEditingGroupTitle(DEFAULT_GROUP_TITLE);
      return;
    }

    const previousLayout = persistGraphLayout(nodes, groups);
    const nextGroups = renameGraphGroup(groups, groupId, editingGroupTitle);
    const nextLayout = persistGraphLayout(nodes, nextGroups);
    hydrationGenerationRef.current += 1;
    setGroups(nextGroups);
    persistCurrentLayout(nodes, nextGroups);
    setEditingGroupId(undefined);
    setEditingGroupTitle(DEFAULT_GROUP_TITLE);
    if (!storedLayoutsEqual(previousLayout, nextLayout)) {
      pushLayoutUndoEntry(`Renamed group ${groupId}.`, previousLayout);
    }
  };

  const toggleOrganizeGroup = (groupId: string) => {
    selectGroup(groupId);
    setEditingGroupId(undefined);
    setEditingGroupTitle(DEFAULT_GROUP_TITLE);
    setOrganizeGroupId((current) => (current === groupId ? undefined : groupId));
  };

  const applyOrganizeGroup = (groupId: string, mode: GroupOrganizeMode) => {
    if (!graph || !viewKey) {
      return;
    }

    const group = groups.find((candidate) => candidate.id === groupId);
    if (!group) {
      setOrganizeGroupId(undefined);
      return;
    }

    const groupMemberNodeIds = new Set(group.memberNodeIds);
    const graphNodesById = new Map(graph.nodes.map((node) => [node.id, node] as const));
    const groupNodes = nodes.flatMap((node) => {
      if (!isSemanticCanvasNode(node) || !groupMemberNodeIds.has(node.id)) {
        return [];
      }

      const graphNode = graphNodesById.get(node.id);
      return [
        {
          id: node.id,
          kind: node.data.kind,
          x: node.position.x,
          y: node.position.y,
          width: semanticNodeDimension(node, "width"),
          height: semanticNodeDimension(node, "height"),
          metadata: graphNode?.metadata ?? {},
        },
      ];
    });

    setOrganizeGroupId(undefined);
    if (groupNodes.length < 2) {
      return;
    }

    const result = organizeGroupedNodes({
      mode,
      nodes: groupNodes,
      edges: graph.edges,
    });
    if (!result.changed) {
      return;
    }

    const previousLayout = persistGraphLayout(nodes, groups);
    const nextNodes = nodes.map((node) => {
      if (!isSemanticCanvasNode(node) || !groupMemberNodeIds.has(node.id)) {
        return node;
      }

      const nextPosition = result.positions[node.id];
      if (!nextPosition) {
        return node;
      }

      return {
        ...node,
        position: nextPosition,
      };
    });

    hydrationGenerationRef.current += 1;
    setSelectedGroupId(groupId);
    setSelectedSemanticNodeIds([]);
    setNodes(nextNodes);
    pushLayoutUndoEntry(`Organized group ${groupId}.`, previousLayout);
    persistCurrentLayout(nextNodes, groups);
  };

  const togglePinnedNodes = (nodeIds: string[]) => {
    if (!canPinNodes || !nodeIds.length) {
      return;
    }

    hydrationGenerationRef.current += 1;
    let previousLayout: StoredGraphLayout | undefined;
    let nextLayout: StoredGraphLayout | undefined;
    setNodes((current) => {
      previousLayout = persistGraphLayout(current, groups);
      const targetNodeIds = expandGroupedNodeIds(nodeIds, groupByNodeId, memberNodeIdsByGroupId);
      const semanticNodesById = new Map(
        current.filter(isSemanticCanvasNode).map((node) => [node.id, node] as const),
      );
      const nextPinnedByNodeId = new Map<string, boolean>();
      const nextPinnedByGroupId = new Map<string, boolean>();

      targetNodeIds.forEach((targetNodeId) => {
        const groupId = groupByNodeId.get(targetNodeId);
        if (!groupId) {
          const targetNode = semanticNodesById.get(targetNodeId);
          if (targetNode) {
            nextPinnedByNodeId.set(targetNodeId, !targetNode.data.isPinned);
          }
          return;
        }

        if (!nextPinnedByGroupId.has(groupId)) {
          const memberNodeIds = memberNodeIdsByGroupId.get(groupId) ?? [targetNodeId];
          const shouldPin = memberNodeIds.some(
            (memberNodeId) => !semanticNodesById.get(memberNodeId)?.data.isPinned,
          );
          nextPinnedByGroupId.set(groupId, shouldPin);
        }
      });

      const next = current.map((node) => {
        if (!isSemanticCanvasNode(node)) {
          return node;
        }

        const groupId = groupByNodeId.get(node.id);
        const nextPinned = groupId
          ? nextPinnedByGroupId.get(groupId)
          : nextPinnedByNodeId.get(node.id);
        if (nextPinned === undefined) {
          return node;
        }

        return {
          ...node,
          data: {
            ...node.data,
            isPinned: nextPinned,
            actions: (node.data.actions ?? []).map((action) =>
              action.id === "pin"
                ? {
                    ...action,
                    label: nextPinned ? "Unpin" : "Pin",
                    helpId: pinActionHelpId(nextPinned),
                  }
                : action,
            ),
          },
        };
      });
      nextLayout = persistGraphLayout(next, groups);
      persistCurrentLayout(next);
      return next;
    });
    if (previousLayout && nextLayout && !storedLayoutsEqual(previousLayout, nextLayout)) {
      pushLayoutUndoEntry("Updated pinned layout nodes.", previousLayout);
    }
  };
  const togglePinnedNode = (nodeId: string) => {
    togglePinnedNodes([nodeId]);
  };

  const createGroupFromSelection = () => {
    const { changed, nextGroupId, nextGroups } = mergeGroupsForSelection(
      groups,
      effectiveSemanticSelection,
    );
    if (!changed || !nextGroupId) {
      return;
    }

    const previousLayout = persistGraphLayout(nodes, groups);
    hydrationGenerationRef.current += 1;
    setNodes((current) =>
      current.some((node) => node.selected)
        ? current.map((node) => (node.selected ? { ...node, selected: false } : node))
        : current,
    );
    setGroups(nextGroups);
    setSelectedSemanticNodeIds([]);
    setSelectedGroupId(nextGroupId);
    setOrganizeGroupId(undefined);
    setEditingGroupId(nextGroupId);
    setEditingGroupTitle(DEFAULT_GROUP_TITLE);
    persistCurrentLayout(nodes, nextGroups);
    pushLayoutUndoEntry(`Grouped nodes into ${nextGroupId}.`, previousLayout);
  };

  const ungroupSelection = () => {
    const { changed, nextGroups, removedGroupIds } = ungroupGroupsForSelection(
      groups,
      effectiveSemanticSelection,
      selectedGroupId,
    );
    if (!changed) {
      return;
    }

    const previousLayout = persistGraphLayout(nodes, groups);
    hydrationGenerationRef.current += 1;
    setGroups(nextGroups);
    if (selectedGroupId && removedGroupIds.includes(selectedGroupId)) {
      setSelectedGroupId(undefined);
    }
    if (organizeGroupId && removedGroupIds.includes(organizeGroupId)) {
      setOrganizeGroupId(undefined);
    }
    if (editingGroupId && removedGroupIds.includes(editingGroupId)) {
      setEditingGroupId(undefined);
      setEditingGroupTitle(DEFAULT_GROUP_TITLE);
    }
    persistCurrentLayout(nodes, nextGroups);
    pushLayoutUndoEntry("Ungrouped selected nodes.", previousLayout);
  };

  const ungroupGroup = async (groupId: string, title: string) => {
    const confirmed = await confirmDialog(`Ungroup "${title}"?`, {
      title: "Ungroup nodes",
      kind: "warning",
      okLabel: "Ungroup",
      cancelLabel: "Cancel",
    });
    if (!confirmed) {
      return;
    }

    const { changed, nextGroups, removedGroupIds } = ungroupGroupsForSelection(groups, [], groupId);
    if (!changed) {
      return;
    }

    const previousLayout = persistGraphLayout(nodes, groups);
    hydrationGenerationRef.current += 1;
    setGroups(nextGroups);
    if (selectedGroupId && removedGroupIds.includes(selectedGroupId)) {
      setSelectedGroupId(undefined);
    }
    if (organizeGroupId && removedGroupIds.includes(organizeGroupId)) {
      setOrganizeGroupId(undefined);
    }
    if (editingGroupId && removedGroupIds.includes(editingGroupId)) {
      setEditingGroupId(undefined);
      setEditingGroupTitle(DEFAULT_GROUP_TITLE);
    }
    persistCurrentLayout(nodes, nextGroups);
    pushLayoutUndoEntry(`Ungrouped ${title}.`, previousLayout);
  };

  const removeSelectedReroutes = () => {
    hydrationGenerationRef.current += 1;
    let previousLayout: StoredGraphLayout | undefined;
    let nextLayout: StoredGraphLayout | undefined;
    setNodes((current) => {
      previousLayout = persistGraphLayout(current, groups);
      const selectedIds = new Set(
        current
          .filter((node) => isRerouteCanvasNode(node) && Boolean(node.selected))
          .map((node) => node.id),
      );
      if (!selectedIds.size) {
        return current;
      }

      const next = normalizeRerouteNodeOrders(current.filter((node) => !selectedIds.has(node.id)));
      nextLayout = persistGraphLayout(next, groups);
      persistCurrentLayout(next, groups);
      return next;
    });
    if (previousLayout && nextLayout && !storedLayoutsEqual(previousLayout, nextLayout)) {
      pushLayoutUndoEntry("Removed reroute nodes.", previousLayout);
    }
  };

  const handleFitView = () => {
    const fitViewButton = panelRef.current?.querySelector<HTMLButtonElement>(
      ".react-flow__controls-fitview",
    );
    if (!fitViewButton) {
      return false;
    }

    fitViewButton.click();
    return true;
  };

  const handleGraphShortcutKey = (event: {
    key: string;
    altKey: boolean;
    ctrlKey: boolean;
    defaultPrevented: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    target: EventTarget | null;
    preventDefault: () => void;
  }) => {
    if (event.defaultPrevented) {
      return;
    }

    if (shouldHandleCreateModeKey(event)) {
      event.preventDefault();
      onToggleCreateMode();
      return;
    }

    if (shouldHandleFitViewKey(event)) {
      if (!handleFitView()) {
        return;
      }

      event.preventDefault();
      return;
    }

    if (selectedRerouteCount && shouldHandleRerouteDeleteKey(event)) {
      event.preventDefault();
      removeSelectedReroutes();
      return;
    }

    if (
      flowAuthoringEnabled &&
      shouldHandleRerouteDeleteKey(event) &&
      (selectedControlEdgeIds.length || selectedDeletableFlowNodeIds.length)
    ) {
      event.preventDefault();
      onDeleteFlowSelection({
        nodeIds: selectedDeletableFlowNodeIds,
        edgeIds: selectedControlEdgeIds,
      });
      setSelectedControlEdgeIds([]);
      return;
    }

    if (shouldHandleRerouteDeleteKey(event)) {
      event.preventDefault();
      if (selectedDeletableSymbolNodeId) {
        onDeleteSymbolNode(selectedDeletableSymbolNodeId);
      }
      return;
    }

    if (shouldHandleUngroupKey(event)) {
      event.preventDefault();
      ungroupSelection();
      return;
    }

    if (shouldHandleGroupKey(event)) {
      event.preventDefault();
      createGroupFromSelection();
      return;
    }

    if (selectedGroupId && shouldHandlePinKey(event) && canPinNodes) {
      event.preventDefault();
      togglePinnedNodes(memberNodeIdsByGroupId.get(selectedGroupId) ?? []);
      return;
    }

    if (selectedNodeId && shouldHandlePinKey(event) && canPinNodes) {
      event.preventDefault();
      togglePinnedNodes([selectedNodeId]);
    }
  };

  useEffect(() => {
    const panel = panelRef.current;

    const handleFocusIn = (event: FocusEvent) => {
      graphHotkeyActiveRef.current = Boolean(
        panelRef.current && event.target instanceof Node && panelRef.current.contains(event.target),
      );
    };

    const handlePointerDown = (event: PointerEvent) => {
      graphHotkeyActiveRef.current = Boolean(
        panelRef.current && event.target instanceof Node && panelRef.current.contains(event.target),
      );
    };

    const handleWindowKeyDown = (event: KeyboardEvent) => {
      const panelContainsTarget = Boolean(
        panelRef.current && event.target instanceof Node && panelRef.current.contains(event.target),
      );
      const panelContainsFocus = Boolean(
        panelRef.current &&
        document.activeElement instanceof Node &&
        panelRef.current.contains(document.activeElement),
      );

      if (
        !(graphHotkeyActiveRef.current || panelContainsTarget || panelContainsFocus) ||
        (!shouldHandleFitViewKey(event) &&
          !shouldHandleCreateModeKey(event) &&
          !shouldHandleRerouteDeleteKey(event) &&
          !shouldHandlePinKey(event) &&
          !shouldHandleGroupKey(event) &&
          !shouldHandleUngroupKey(event))
      ) {
        return;
      }

      handleGraphShortcutKey(event);
    };

    const handlePanelKeyDown = (event: KeyboardEvent) => {
      if (
        !shouldHandleFitViewKey(event) &&
        !shouldHandleCreateModeKey(event) &&
        !shouldHandleRerouteDeleteKey(event) &&
        !shouldHandlePinKey(event) &&
        !shouldHandleGroupKey(event) &&
        !shouldHandleUngroupKey(event)
      ) {
        return;
      }

      handleGraphShortcutKey(event);
    };

    window.addEventListener("focusin", handleFocusIn);
    window.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleWindowKeyDown, true);
    panel?.addEventListener("keydown", handlePanelKeyDown);
    return () => {
      window.removeEventListener("focusin", handleFocusIn);
      window.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleWindowKeyDown, true);
      panel?.removeEventListener("keydown", handlePanelKeyDown);
    };
  }, [
    canPinNodes,
    createGroupFromSelection,
    memberNodeIdsByGroupId,
    selectedGroupId,
    selectedNodeId,
    selectedDeletableSymbolNodeId,
    selectedRerouteCount,
    onToggleCreateMode,
    onDeleteSymbolNode,
    togglePinnedNodes,
    ungroupSelection,
    fitViewOptions,
  ]);

  useEffect(() => {
    const handlePointerUp = () => {
      setPanPointerDragging(false);
    };

    window.addEventListener("pointerup", handlePointerUp, true);
    return () => window.removeEventListener("pointerup", handlePointerUp, true);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Shift") {
        shiftPressedRef.current = true;
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Shift") {
        shiftPressedRef.current = false;
      }
    };

    const handleBlur = () => {
      shiftPressedRef.current = false;
    };

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("blur", handleBlur);
    };
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

  useEffect(() => {
    if (!selectedRerouteCount) {
      return;
    }
    onClearSelection();
  }, [onClearSelection, selectedRerouteCount]);

  useEffect(() => {
    if (!createModeActive) {
      return;
    }
    clearLocalSelection();
  }, [createModeActive]);

  useEffect(() => {
    if (!graph || !viewKey) {
      setNodes([]);
      setGroups([]);
      setSelectedSemanticNodeIds([]);
      setSelectedGroupId(undefined);
      setEditingGroupId(undefined);
      setOrganizeGroupId(undefined);
      setEditingGroupTitle(DEFAULT_GROUP_TITLE);
      setMarqueeSelectionActive(false);
      return;
    }

    const generation = hydrationGenerationRef.current + 1;
    hydrationGenerationRef.current = generation;
    const emptyLayout: StoredGraphLayout = {
      nodes: {},
      reroutes: [],
      pinnedNodeIds: [],
      groups: [],
    };
    const cachedLayout = peekStoredGraphLayout(repoPath, viewKey);
    const initialGroups = normalizeStoredGroups(cachedLayout?.groups, graphNodeIds);
    const initialLayout: StoredGraphLayout = cachedLayout
      ? {
          ...cachedLayout,
          groups: initialGroups,
        }
      : emptyLayout;
    const initialNodes = buildCanvasNodes(
      graph,
      EMPTY_STRING_SET,
      initialLayout,
      EMPTY_STRING_SET,
      false,
      EMPTY_STRING_SET,
      EMPTY_STRING_SET,
      false,
      new Set(initialGroups.flatMap((group) => group.memberNodeIds)),
      EMPTY_STRING_SET,
      canPinNodes,
      flowAuthoringEnabled,
      togglePinnedNode,
      onActivateNode,
      onInspectNode,
      requestExpressionGraphIntent,
      setHoveredPortEdgeIds,
      () => setHoveredPortEdgeIds([]),
    );
    setNodes(initialNodes);
    setGroups(initialGroups);
    setSelectedSemanticNodeIds([]);
    setSelectedGroupId(undefined);
    setEditingGroupId(undefined);
    setOrganizeGroupId(undefined);
    setEditingGroupTitle(DEFAULT_GROUP_TITLE);

    let cancelled = false;
    void readStoredGraphLayout(repoPath, viewKey).then((savedLayout) => {
      if (cancelled || hydrationGenerationRef.current !== generation) {
        return;
      }

      if (graph.level === "flow" && storedLayoutIsEmpty(savedLayout)) {
        const initialLayoutResult = layoutFlowGraph(
          toFlowLayoutNodes(initialNodes, graph),
          graph.edges,
        );
        const initializedLayout: StoredGraphLayout = {
          nodes: initialLayoutResult.positions,
          reroutes: [],
          pinnedNodeIds: [],
          groups: [],
        };
        setNodes(
          buildCanvasNodes(
            graph,
            EMPTY_STRING_SET,
            initializedLayout,
            EMPTY_STRING_SET,
            false,
            EMPTY_STRING_SET,
            EMPTY_STRING_SET,
            false,
            EMPTY_STRING_SET,
            EMPTY_STRING_SET,
            canPinNodes,
            flowAuthoringEnabled,
            togglePinnedNode,
            onActivateNode,
            onInspectNode,
            requestExpressionGraphIntent,
            setHoveredPortEdgeIds,
            () => setHoveredPortEdgeIds([]),
          ),
        );
        setGroups([]);
        void writeStoredGraphLayout(repoPath, viewKey, initializedLayout);
        return;
      }

      const normalizedGroups = normalizeStoredGroups(savedLayout.groups, graphNodeIds);
      const normalizedLayout: StoredGraphLayout = {
        ...savedLayout,
        groups: normalizedGroups,
      };

      setNodes(
        buildCanvasNodes(
          graph,
          EMPTY_STRING_SET,
          normalizedLayout,
          EMPTY_STRING_SET,
          false,
          EMPTY_STRING_SET,
          EMPTY_STRING_SET,
          false,
          new Set(normalizedGroups.flatMap((group) => group.memberNodeIds)),
          EMPTY_STRING_SET,
          canPinNodes,
          flowAuthoringEnabled,
          togglePinnedNode,
          onActivateNode,
          onInspectNode,
          requestExpressionGraphIntent,
          setHoveredPortEdgeIds,
          () => setHoveredPortEdgeIds([]),
        ),
      );
      setGroups(normalizedGroups);
    });

    return () => {
      cancelled = true;
    };
  }, [
    graph,
    canPinNodes,
    flowAuthoringEnabled,
    onActivateNode,
    onInspectNode,
    requestExpressionGraphIntent,
    repoPath,
    graphNodeIds,
    viewKey,
  ]);

  useEffect(() => {
    if (!graph) {
      return;
    }
    setNodes((current) =>
      applyNodeDecorations(
        current,
        graph,
        selectedPreviewNodeIds,
        highlightedEdgeIds,
        hoverActive,
        selectedRelatedNodeIds,
        selectedConnectedEdgeIds,
        selectionContextActive,
        groupedNodeIds,
        selectedGroupMemberNodeIds,
        canPinNodes,
        flowAuthoringEnabled,
        togglePinnedNode,
        onActivateNode,
        onInspectNode,
        requestExpressionGraphIntent,
        setHoveredPortEdgeIds,
        () => setHoveredPortEdgeIds([]),
      ),
    );
  }, [
    graph,
    highlightedEdgeIds,
    hoverActive,
    canPinNodes,
    flowAuthoringEnabled,
    onActivateNode,
    onInspectNode,
    requestExpressionGraphIntent,
    selectedConnectedEdgeIds,
    groupedNodeIds,
    selectedPreviewNodeIds,
    selectedGroupMemberNodeIds,
    selectedRelatedNodeIds,
    selectionContextActive,
  ]);

  useEffect(() => {
    if (selectedGroupId && !groups.some((group) => group.id === selectedGroupId)) {
      setSelectedGroupId(undefined);
    }
    if (organizeGroupId && !groups.some((group) => group.id === organizeGroupId)) {
      setOrganizeGroupId(undefined);
    }
    if (editingGroupId && !groups.some((group) => group.id === editingGroupId)) {
      setEditingGroupId(undefined);
      setEditingGroupTitle(DEFAULT_GROUP_TITLE);
    }
  }, [editingGroupId, groups, organizeGroupId, selectedGroupId]);

  useEffect(() => {
    const liveDeletableEdgeIds = new Set(
      (graph?.edges ?? [])
        .filter(
          (edge) =>
            edge.kind === "controls" ||
            (edge.kind === "data" &&
              (edge.id.startsWith("data:flowbinding:") || edge.id.startsWith("data:flowparam:"))),
        )
        .map((edge) => edge.id),
    );
    setSelectedControlEdgeIds((current) =>
      current.filter((edgeId) => liveDeletableEdgeIds.has(edgeId)),
    );
  }, [graph?.edges]);

  useEffect(() => {
    pendingLayoutUndoRef.current = undefined;
  }, [viewKey]);

  useEffect(() => {
    setLayoutUndoStacks({});
    setLayoutRedoStacks({});
    pendingLayoutUndoRef.current = undefined;
  }, [repoPath]);

  useEffect(
    () =>
      useUndoStore.getState().registerDomain("layout", {
        canUndo: () => currentLayoutUndoStack.length > 0,
        canRedo: () => currentLayoutRedoStack.length > 0,
        peekEntry: () => currentLayoutUndoStack[currentLayoutUndoStack.length - 1]?.entry,
        peekRedoEntry: () => currentLayoutRedoStack[currentLayoutRedoStack.length - 1]?.entry,
        undo: async () => {
          const layoutUndo = currentLayoutUndoStack[currentLayoutUndoStack.length - 1];
          if (!layoutUndo) {
            return {
              domain: "layout" as const,
              handled: false,
            };
          }

          applyLayoutHistoryEntry(layoutUndo, "undo");
          return {
            domain: "layout" as const,
            handled: true,
            summary: layoutUndo.entry.summary,
          };
        },
        redo: async () => {
          const layoutRedo = currentLayoutRedoStack[currentLayoutRedoStack.length - 1];
          if (!layoutRedo) {
            return {
              domain: "layout" as const,
              handled: false,
            };
          }

          applyLayoutHistoryEntry(layoutRedo, "redo");
          return {
            domain: "layout" as const,
            handled: true,
            summary: layoutRedo.entry.summary,
          };
        },
      }),
    [applyLayoutHistoryEntry, currentLayoutRedoStack, currentLayoutUndoStack],
  );

  useEffect(() => {
    setHoveredEdgeId(undefined);
    setHoveredPortEdgeIds([]);
    setTransientHelpTarget(null);
  }, [setTransientHelpTarget, viewKey]);

  useEffect(
    () => () => {
      setTransientHelpTarget(null);
    },
    [setTransientHelpTarget],
  );

  const handleNodesChange = (changes: NodeChange<GraphCanvasNode>[]) => {
    setNodes((current) =>
      applyGroupedPositionChanges(current, changes, groupByNodeId, memberNodeIdsByGroupId),
    );
  };

  const handleNodeDragStart = () => {
    capturePendingLayoutUndo("Moved layout nodes.");
  };

  const handleSelectionDragStart = () => {
    capturePendingLayoutUndo("Moved selected layout nodes.");
  };

  const handleNodeDragStop = () => {
    finalizePendingLayoutUndo();
    persistCurrentCanvasState();
  };

  const handleSelectionDragStop = () => {
    finalizePendingLayoutUndo();
    persistCurrentCanvasState();
  };

  const handleDeclutter = () => {
    if (!graph || !viewKey || !nodes.length) {
      return;
    }

    const previousLayout = persistGraphLayout(nodes, groups);
    const result =
      graph.level === "flow"
        ? layoutFlowGraph(
            toFlowLayoutNodes(nodes, graph),
            graph.edges,
            semanticPinnedNodeIds(nodes),
          )
        : declutterGraphLayout(toDeclutterNodes(nodes.filter(isSemanticCanvasNode)), graph.edges);
    if (!result.changed) {
      return;
    }

    const nextNodes = applyGroupedLayoutPositions(
      nodes,
      result.positions,
      memberNodeIdsByGroupId,
      groupByNodeId,
    );

    hydrationGenerationRef.current += 1;
    setNodes(nextNodes);
    pushLayoutUndoEntry("Decluttered layout.", previousLayout);
    persistCurrentLayout(nextNodes, groups);
  };

  const handleUndoLayout = () => {
    const layoutUndo = currentLayoutUndoStack[currentLayoutUndoStack.length - 1];
    if (!viewKey || !layoutUndo || layoutUndo.viewKey !== viewKey) {
      return;
    }

    applyLayoutHistoryEntry(layoutUndo, "undo");
  };

  const handleInsertReroute = (
    logicalEdgeId: string,
    segmentIndex: number,
    position: { x: number; y: number },
  ) => {
    if (!viewKey) {
      return;
    }

    hydrationGenerationRef.current += 1;
    let previousLayout: StoredGraphLayout | undefined;
    let nextLayout: StoredGraphLayout | undefined;
    setNodes((current) => {
      previousLayout = persistGraphLayout(current, groups);
      const edgeReroutes = current
        .filter(
          (node): node is RerouteCanvasNode =>
            isRerouteCanvasNode(node) && node.data.logicalEdgeId === logicalEdgeId,
        )
        .sort(
          (left, right) => left.data.order - right.data.order || left.id.localeCompare(right.id),
        );
      const insertAt = Math.max(0, Math.min(segmentIndex, edgeReroutes.length));
      const next = normalizeRerouteNodeOrders([
        ...current.map((node) => {
          if (
            !isRerouteCanvasNode(node) ||
            node.data.logicalEdgeId !== logicalEdgeId ||
            node.data.order < insertAt
          ) {
            return node;
          }
          return {
            ...node,
            data: {
              ...node.data,
              order: node.data.order + 1,
            },
          };
        }),
        {
          id: rerouteNodeId(createRerouteId(logicalEdgeId)),
          type: "reroute",
          position,
          draggable: true,
          selectable: true,
          className: buildRerouteShellClassName(
            logicalEdgeId,
            highlightedEdgeIds,
            hoverActive,
            selectedConnectedEdgeIds,
            selectionContextActive,
          ),
          data: {
            kind: "reroute",
            logicalEdgeId,
            order: insertAt,
          },
        } satisfies RerouteCanvasNode,
      ]);
      nextLayout = persistGraphLayout(next, groups);
      persistCurrentLayout(next, groups);
      return next;
    });
    if (previousLayout && nextLayout && !storedLayoutsEqual(previousLayout, nextLayout)) {
      pushLayoutUndoEntry(`Inserted reroute on ${logicalEdgeId}.`, previousLayout);
    }
  };

  const panelPositionForContext = (position: AppContextMenuPosition) => {
    const panelBounds = panelRef.current?.getBoundingClientRect();
    return {
      x: panelBounds ? position.x - panelBounds.left : position.x,
      y: panelBounds ? position.y - panelBounds.top : position.y,
    };
  };

  const deleteSelectedFlowItems = () => {
    if (!flowAuthoringEnabled) {
      return;
    }
    onDeleteFlowSelection({
      nodeIds: selectedDeletableFlowNodeIds,
      edgeIds: selectedControlEdgeIds,
    });
    setSelectedControlEdgeIds([]);
  };

  const contextMenuItems = contextMenu
    ? buildGraphContextMenuItems(contextMenu, {
        graph,
        nodes,
        graphNodeById,
        groupByNodeId,
        memberNodeIdsByGroupId,
        groups,
        flowAuthoringEnabled,
        selectedControlEdgeIds,
        selectedDeletableFlowNodeIds,
        authorableFlowNodeIds,
        canPinNodes,
        effectiveSemanticSelection,
        groupedNodeIds,
        selectedGroupId,
        selectedRerouteCount,
        currentLayoutUndoStackLength: currentLayoutUndoStack.length,
        createModeActive,
        screenToFlowPosition,
        panelPositionForContext,
        removeSelectedReroutes,
        onActivateNode,
        onInspectNode,
        requestExpressionGraphIntent,
        onEditFlowNodeIntent,
        onCreateIntent,
        togglePinnedNodes,
        createGroupFromSelection,
        selectGroup,
        setSelectedSemanticNodeIds,
        ungroupGroup,
        deleteSelectedFlowItems,
        onRevealNodeInFileExplorer,
        onOpenNodeInDefaultEditor,
        selectControlEdge,
        onDisconnectFlowEdge,
        clearSelectedControlEdge: (edgeId) => {
          setSelectedControlEdgeIds((current) =>
            current.filter((selectedEdgeId) => selectedEdgeId !== edgeId),
          );
        },
        handleInsertReroute,
        handleFitView,
        handleDeclutter,
        handleUndoLayout,
        ungroupSelection,
        clearLocalSelection,
        onClearSelection,
        onToggleCreateMode,
      })
    : [];

  const contextMenuLabel = buildGraphContextMenuLabel(contextMenu, graphNodeById);

  const groupBounds = useMemo(() => buildGraphGroupBoundsList(groups, nodes), [groups, nodes]);

  const handlePreviewGroupMove = (
    groupId: string,
    delta: { x: number; y: number },
    basePositions: Map<string, { x: number; y: number }>,
  ) => {
    setSelectedGroupId(groupId);
    setOrganizeGroupId((current) => (current === groupId ? current : undefined));
    setSelectedSemanticNodeIds([]);
    capturePendingLayoutUndo(`Moved group ${groupId}.`);
    setNodes((current) =>
      applyMemberNodeDelta(
        current,
        memberNodeIdsByGroupId.get(groupId) ?? [],
        delta,
        basePositions,
      ),
    );
  };

  const handleGroupMoveEnd = () => {
    finalizePendingLayoutUndo();
    persistCurrentCanvasState();
  };

  if (!graph || !blueprint || !fitViewOptions || !viewKey) {
    const emptyStateTitle = errorMessage
      ? "Unable to open graph"
      : isLoading
        ? "Loading graph"
        : "Blueprint canvas";
    const emptyStateBody =
      errorMessage ??
      (isLoading
        ? "Building the current graph view."
        : "Index a repo to open the architecture map. Modules appear first, then symbols and flow only when you drill down.");
    return (
      <section className="content-panel graph-panel">
        <EmptyState title={emptyStateTitle} body={emptyStateBody} />
      </section>
    );
  }

  const edges = buildCanvasEdges({
    blueprint,
    graph,
    highlightedEdgeIds,
    hoverActive,
    nodes,
    onEdgeClick: (logicalEdgeId, logicalEdgeKind, _position, _clientPosition, modifiers) => {
      if (
        logicalEdgeKind === "data" &&
        (logicalEdgeId.startsWith("data:flowbinding:") ||
          logicalEdgeId.startsWith("data:flowparam:"))
      ) {
        if (modifiers.altKey) {
          onDisconnectFlowEdge(logicalEdgeId);
          setSelectedControlEdgeIds((current) =>
            current.filter((edgeId) => edgeId !== logicalEdgeId),
          );
          return;
        }
        selectControlEdge(logicalEdgeId);
        return;
      }
      const edgeInteraction = resolveFlowEdgeInteraction({
        flowAuthoringEnabled,
        logicalEdgeKind,
        altKey: modifiers.altKey,
      });
      if (edgeInteraction === "ignore") {
        return;
      }
      if (edgeInteraction === "disconnect") {
        onDisconnectFlowEdge(logicalEdgeId);
        setSelectedControlEdgeIds((current) =>
          current.filter((edgeId) => edgeId !== logicalEdgeId),
        );
        return;
      }
      selectControlEdge(logicalEdgeId);
    },
    onEdgeContextMenu: openEdgeContextMenu,
    onEdgeHoverEnd: () => {
      setHoveredEdgeId(undefined);
      setTransientHelpTarget(null);
    },
    onEdgeHoverStart: (logicalEdgeId, logicalEdgeKind, logicalEdgeLabel) => {
      setHoveredEdgeId(logicalEdgeId);
      setTransientHelpTarget({
        id: helpIdForGraphEdgeKind(logicalEdgeKind),
        args: {
          label: logicalEdgeLabel,
        },
      });
    },
    onInsertReroute: handleInsertReroute,
    selectedControlEdgeIds: selectedControlEdgeIdSet,
    selectedConnectedEdgeIds,
    selectionContextActive,
    showEdgeLabels,
    highlightGraphPath,
  });

  return (
    <section
      ref={panelRef}
      {...helpTargetProps("graph.canvas")}
      aria-label="Graph canvas"
      className={`content-panel graph-panel${panModeActive ? " is-pan-active" : ""}${createModeActive ? " is-create-mode" : ""}`}
      data-create-mode={createModeState}
      role="region"
      tabIndex={0}
      onFocusCapture={() => {
        graphHotkeyActiveRef.current = true;
      }}
      onPointerOverCapture={() => {
        setPointerInsidePanel(true);
      }}
      onPointerOutCapture={(event) => {
        const nextTarget = event.relatedTarget;
        if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
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
      onKeyDown={(event) => {
        handleGraphShortcutKey(event);
      }}
    >
      <ReactFlow<GraphCanvasNode, GraphCanvasEdge>
        key={viewKey}
        fitView
        fitViewOptions={fitViewOptions}
        proOptions={{ hideAttribution: true }}
        onInit={(instance) => {
          reactFlowInstanceRef.current = instance;
        }}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={handleNodesChange}
        onNodeDragStart={handleNodeDragStart}
        onNodeDragStop={handleNodeDragStop}
        onSelectionDragStart={handleSelectionDragStart}
        onSelectionDragStop={handleSelectionDragStop}
        onSelectionStart={() => {
          setMarqueeSelectionActive(true);
        }}
        onSelectionEnd={() => {
          setMarqueeSelectionActive(false);
        }}
        onSelectionChange={({ nodes: selectedNodes }) => {
          if (skipNextSelectionSyncRef.current) {
            skipNextSelectionSyncRef.current = false;
            return;
          }

          const nextSelectedSemanticNodeIds = sortNodeIds(
            selectedNodes.filter(isSemanticCanvasNode).map((node) => node.id),
          );
          const hasLocalNodeSelection =
            nextSelectedSemanticNodeIds.length > 0 || selectedNodes.some(isRerouteCanvasNode);

          setSelectedSemanticNodeIds((current) =>
            sameNodeIds(current, nextSelectedSemanticNodeIds)
              ? current
              : nextSelectedSemanticNodeIds,
          );
          if (hasLocalNodeSelection && selectedControlEdgeIds.length) {
            setSelectedControlEdgeIds([]);
          }
          if (hasLocalNodeSelection && selectedGroupId) {
            setSelectedGroupId(undefined);
          }
          if (hasLocalNodeSelection && organizeGroupId) {
            setOrganizeGroupId(undefined);
          }
        }}
        nodesDraggable
        nodesConnectable={flowAuthoringEnabled}
        edgesReconnectable={flowAuthoringEnabled}
        connectionLineComponent={BlueprintConnectionLine}
        connectionLineContainerStyle={{ pointerEvents: "none", zIndex: 30 }}
        connectionRadius={FLOW_CONNECTION_RADIUS}
        reconnectRadius={FLOW_RECONNECT_RADIUS}
        deleteKeyCode={null}
        isValidConnection={(connection) =>
          flowAuthoringEnabled && isValidFlowCanvasConnection(connection)
        }
        selectionKeyCode={null}
        multiSelectionKeyCode={["Meta", "Control", "Shift"]}
        selectionOnDrag={!panModeActive && !createModeActive}
        selectionMode={SelectionMode.Partial}
        paneClickDistance={4}
        minZoom={MIN_GRAPH_ZOOM}
        maxZoom={MAX_GRAPH_ZOOM}
        zoomOnScroll={false}
        panOnScroll
        panOnScrollMode={PanOnScrollMode.Free}
        zoomActivationKeyCode="Alt"
        panOnDrag={panModeActive}
        onConnect={(connection: Connection) => {
          if (
            !flowAuthoringEnabled ||
            !connection.source ||
            !connection.target ||
            !isValidFlowCanvasConnection(connection)
          ) {
            return;
          }
          onConnectFlowEdge({
            sourceId: connection.source,
            sourceHandle: connection.sourceHandle,
            targetId: connection.target,
            targetHandle: connection.targetHandle,
          });
          setSelectedControlEdgeIds([]);
        }}
        onReconnect={(oldEdge, newConnection) => {
          const logicalEdgeId = (oldEdge.data as BlueprintEdgeData | undefined)?.logicalEdgeId;
          if (
            !flowAuthoringEnabled ||
            !logicalEdgeId ||
            !newConnection.source ||
            !newConnection.target ||
            !isValidFlowCanvasConnection(newConnection)
          ) {
            return;
          }
          onReconnectFlowEdge(logicalEdgeId, {
            sourceId: newConnection.source,
            sourceHandle: newConnection.sourceHandle,
            targetId: newConnection.target,
            targetHandle: newConnection.targetHandle,
          });
          setSelectedControlEdgeIds([]);
        }}
        onNodeClick={(event, node) => {
          const flowCreateModeSelectionOnly = createModeActive && graph.level === "flow";
          if (createModeActive && !flowCreateModeSelectionOnly) {
            if (createModeReady && createModeCanvasEnabled) {
              requestCreateIntent(
                { x: event.clientX, y: event.clientY },
                screenToFlowPosition({ x: event.clientX, y: event.clientY }),
              );
            }
            return;
          }

          if (selectedControlEdgeIds.length) {
            setSelectedControlEdgeIds([]);
          }

          if (isRerouteCanvasNode(node)) {
            setSelectedGroupId(undefined);
            setOrganizeGroupId(undefined);
            setSelectedSemanticNodeIds([]);
            setNodes((current) =>
              current.map((currentNode) => ({
                ...currentNode,
                selected: currentNode.id === node.id,
              })),
            );
            onClearSelection();
            return;
          }

          const toggleSelectionModifier = event.metaKey || event.ctrlKey;
          const shiftSelectionModifier = event.shiftKey || shiftPressedRef.current;
          const additiveSelection = toggleSelectionModifier || shiftSelectionModifier;
          const shiftOnlySelection = shiftSelectionModifier && !toggleSelectionModifier;
          const wasSelectedBeforeClick = selectedSemanticNodeIds.includes(node.id);
          skipNextSelectionSyncRef.current = additiveSelection;
          setSelectedGroupId(undefined);
          setOrganizeGroupId(undefined);
          setNodes((current) =>
            current.map((currentNode) => {
              if (isRerouteCanvasNode(currentNode)) {
                return currentNode.selected ? { ...currentNode, selected: false } : currentNode;
              }

              if (currentNode.id === node.id) {
                return {
                  ...currentNode,
                  selected: additiveSelection
                    ? shiftOnlySelection
                      ? true
                      : !wasSelectedBeforeClick
                    : true,
                };
              }

              return additiveSelection
                ? currentNode
                : {
                    ...currentNode,
                    selected: false,
                  };
            }),
          );
          setSelectedSemanticNodeIds((current) => {
            if (!additiveSelection) {
              return [node.id];
            }

            if (shiftOnlySelection) {
              return sortNodeIds(new Set([...current, node.id]));
            }

            const next = new Set(current);
            if (next.has(node.id)) {
              next.delete(node.id);
            } else {
              next.add(node.id);
            }
            return sortNodeIds(next);
          });
          onSelectNode(node.id, node.data.kind);
        }}
        onNodeDoubleClick={(event, node) => {
          if (isRerouteCanvasNode(node)) {
            return;
          }
          if (flowAuthoringEnabled && node.data.kind === "return") {
            requestExpressionGraphIntent(node.id, undefined, {
              x: event.clientX,
              y: event.clientY,
            });
            return;
          }
          if (flowAuthoringEnabled && authorableFlowNodeIds.has(node.id)) {
            onEditFlowNodeIntent({
              nodeId: node.id,
              flowPosition: screenToFlowPosition({ x: event.clientX, y: event.clientY }),
              panelPosition: {
                x: event.clientX - (panelRef.current?.getBoundingClientRect().left ?? 0),
                y: event.clientY - (panelRef.current?.getBoundingClientRect().top ?? 0),
              },
            });
            return;
          }
          node.data.onDefaultAction?.();
        }}
        onNodeContextMenu={openNodeContextMenu}
        onPaneContextMenu={openPaneContextMenu}
        onPaneClick={(event) => {
          if (createModeActive) {
            if (createModeReady && createModeCanvasEnabled) {
              requestCreateIntent(
                { x: event.clientX, y: event.clientY },
                screenToFlowPosition({ x: event.clientX, y: event.clientY }),
              );
            }
            return;
          }
          if (selectedControlEdgeIds.length) {
            setSelectedControlEdgeIds([]);
          }
          clearLocalSelection();
          onClearSelection();
        }}
      >
        <GraphGroupLayer
          groupBounds={groupBounds}
          nodes={nodes}
          selectedGroupId={selectedGroupId}
          editingGroupId={editingGroupId}
          organizeGroupId={organizeGroupId}
          editingGroupTitle={editingGroupTitle}
          onChangeEditingGroupTitle={setEditingGroupTitle}
          onApplyOrganizeMode={applyOrganizeGroup}
          onFinishGroupTitleEditing={finishGroupTitleEditing}
          onGroupMoveEnd={handleGroupMoveEnd}
          onPreviewGroupMove={handlePreviewGroupMove}
          onSelectGroup={selectGroup}
          onStartEditingGroup={beginGroupTitleEditing}
          onToggleOrganizeGroup={toggleOrganizeGroup}
          onUngroupGroup={ungroupGroup}
        />
        <Controls showInteractive={false} />
        <Background
          gap={32}
          size={1}
          color={createModeActive ? "var(--accent-strong)" : "var(--line-strong)"}
        />
      </ReactFlow>

      {contextActionError ? (
        <p className="error-copy graph-context-error">{contextActionError}</p>
      ) : null}

      {contextMenu ? (
        <AppContextMenu
          label={contextMenuLabel}
          items={contextMenuItems}
          position={contextMenu}
          onActionError={setContextActionError}
          onClose={closeContextMenu}
        />
      ) : null}

      {createModeActive ? (
        <>
          <div aria-hidden="true" className="graph-create-mode__tint" />
          <div className="graph-create-mode__badge" data-testid="graph-create-mode-badge">
            Create mode
          </div>
          <div className="graph-create-mode__watermark" data-testid="graph-create-mode-watermark">
            CREATE MODE
          </div>
          {createModeHint ? (
            <div className="graph-create-mode__hint" data-testid="graph-create-mode-hint">
              {createModeHint}
            </div>
          ) : null}
        </>
      ) : null}

      <GraphToolbar
        graph={graph}
        graphFilters={graphFilters}
        graphSettings={graphSettings}
        flowInputDisplayMode={flowInputDisplayMode}
        highlightGraphPath={highlightGraphPath}
        showEdgeLabels={showEdgeLabels}
        canUndoLayout={currentLayoutUndoStack.length > 0}
        onSelectLevel={onSelectLevel}
        onDeclutter={handleDeclutter}
        onFitView={handleFitView}
        onToggleGraphFilter={onToggleGraphFilter}
        onToggleGraphSetting={onToggleGraphSetting}
        onSetFlowInputDisplayMode={onSetFlowInputDisplayMode}
        onToggleGraphPathHighlight={onToggleGraphPathHighlight}
        onToggleEdgeLabels={onToggleEdgeLabels}
        onUndoLayout={handleUndoLayout}
      />
    </section>
  );
}
