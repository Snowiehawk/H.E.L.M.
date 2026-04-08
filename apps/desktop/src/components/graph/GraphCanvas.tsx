import { useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  SelectionMode,
  applyNodeChanges,
  useKeyPress,
  type Node,
  type NodeChange,
  type NodeTypes,
} from "@xyflow/react";
import type {
  GraphAbstractionLevel,
  GraphBreadcrumbDto,
  GraphFilters,
  GraphNodeKind,
  GraphNodeDto,
  GraphSettings,
  GraphView,
} from "../../lib/adapter";
import {
  isEnterableGraphNodeKind,
  isGraphSymbolNodeKind,
  isInspectableGraphNodeKind,
} from "../../lib/adapter";
import { GraphToolbar } from "./GraphToolbar";
import { BlueprintNode, type BlueprintNodeData } from "./BlueprintNode";
import { buildBlueprintPresentation } from "./blueprintPorts";
import {
  graphLayoutNodeKey,
  graphLayoutViewKey,
  readStoredGraphLayout,
  writeStoredGraphLayout,
} from "./graphLayoutPersistence";
import { EmptyState } from "../shared/EmptyState";

const nodeTypes: NodeTypes = {
  blueprint: BlueprintNode,
};

type GraphCanvasNode = Node<BlueprintNodeData, "blueprint">;

function metadataNumber(node: GraphNodeDto, key: string): number | undefined {
  const value =
    node.metadata[key] ??
    node.metadata[key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())];
  return typeof value === "number" ? value : undefined;
}

function metadataString(node: GraphNodeDto, key: string): string | undefined {
  const value =
    node.metadata[key] ??
    node.metadata[key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())];
  return typeof value === "string" ? value : undefined;
}

function looksLikeSourcePath(value: string): boolean {
  return value.includes("/") || value.endsWith(".py");
}

function moduleDisplayLabel(node: GraphNodeDto): string {
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

function nodeSummary(node: GraphNodeDto): string | undefined {
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
      metadataString(node, "symbol_kind")
      ?? (node.kind === "symbol" ? undefined : node.kind);
    const moduleName = metadataString(node, "module_name");
    if (symbolKind && moduleName) {
      return `${symbolKind.replaceAll("_", " ")} · ${moduleName}`;
    }
  }
  return node.subtitle ?? undefined;
}

function buildGraphCanvasNodes(
  graph: GraphView,
  selectedNodeId: string,
  savedPositions: Record<string, { x: number; y: number }>,
  onActivateNode: (nodeId: string, kind: GraphNodeKind) => void,
) {
  const blueprint = buildBlueprintPresentation(graph);
  return graph.nodes.map<GraphCanvasNode>((node) => {
    const ports = blueprint.nodePorts.get(node.id) ?? { inputs: [], outputs: [] };
    const savedPosition = savedPositions[graphLayoutNodeKey(node.id, node.kind)];
    return {
      id: node.id,
      position: savedPosition ?? { x: node.x, y: node.y },
      type: "blueprint",
      data: {
        kind: node.kind,
        label: moduleDisplayLabel(node),
        summary: nodeSummary(node),
        inputPorts: ports.inputs,
        outputPorts: ports.outputs,
        primaryActionLabel: isEnterableGraphNodeKind(node.kind)
          ? "Enter"
          : isInspectableGraphNodeKind(node.kind)
            ? "Inspect"
            : undefined,
        onPrimaryAction:
          isEnterableGraphNodeKind(node.kind) || isInspectableGraphNodeKind(node.kind)
            ? () => onActivateNode(node.id, node.kind)
            : undefined,
      },
      draggable: true,
      selectable: true,
      className: node.id === selectedNodeId ? "graph-node-shell is-active" : "graph-node-shell",
    };
  });
}

function applySelectedNodeClass(nodes: GraphCanvasNode[], selectedNodeId: string) {
  return nodes.map((node) => {
    const nextClassName =
      node.id === selectedNodeId ? "graph-node-shell is-active" : "graph-node-shell";
    if (node.className === nextClassName) {
      return node;
    }
    return {
      ...node,
      className: nextClassName,
    };
  });
}

function persistNodePositions(nodes: GraphCanvasNode[]) {
  return Object.fromEntries(
    nodes.map((node) => [
      graphLayoutNodeKey(node.id, node.data.kind),
      {
        x: node.position.x,
        y: node.position.y,
      },
    ]),
  );
}

function isEditableEventTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const editableHost = target.closest(
    'input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"]',
  );
  return editableHost instanceof HTMLElement;
}

function isCanvasBackgroundTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (!target.closest(".react-flow__pane")) {
    return false;
  }

  return !target.closest(
    [
      ".react-flow__node",
      ".react-flow__edge",
      ".react-flow__controls",
      ".react-flow__selection",
      ".react-flow__nodesselection-rect",
      ".graph-toolbar",
    ].join(", "),
  );
}

function shouldHandleNavigateOutKey(event: {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  target: EventTarget | null;
}) {
  return !(
    event.key !== "Backspace"
    || event.altKey
    || event.ctrlKey
    || event.metaKey
    || event.shiftKey
    || isEditableEventTarget(event.target)
  );
}

export function GraphCanvas({
  repoPath,
  graph,
  activeNodeId,
  graphFilters,
  graphSettings,
  highlightGraphPath,
  showEdgeLabels,
  inspectorOpen,
  onSelectNode,
  onActivateNode,
  onSelectBreadcrumb,
  onSelectLevel,
  onToggleGraphFilter,
  onToggleGraphSetting,
  onToggleGraphPathHighlight,
  onToggleEdgeLabels,
  onToggleInspector,
  onNavigateOut,
  onClearSelection,
}: {
  repoPath?: string;
  graph?: GraphView;
  activeNodeId?: string;
  graphFilters: GraphFilters;
  graphSettings: GraphSettings;
  highlightGraphPath: boolean;
  showEdgeLabels: boolean;
  inspectorOpen: boolean;
  onSelectNode: (nodeId: string, kind: GraphNodeKind) => void;
  onActivateNode: (nodeId: string, kind: GraphNodeKind) => void;
  onSelectBreadcrumb: (breadcrumb: GraphBreadcrumbDto) => void;
  onSelectLevel: (level: GraphAbstractionLevel) => void;
  onToggleGraphFilter: (key: keyof GraphFilters) => void;
  onToggleGraphSetting: (key: keyof GraphSettings) => void;
  onToggleGraphPathHighlight: () => void;
  onToggleEdgeLabels: () => void;
  onToggleInspector: () => void;
  onNavigateOut: () => void;
  onClearSelection: () => void;
}) {
  const blueprint = useMemo(
    () => (graph ? buildBlueprintPresentation(graph) : undefined),
    [graph],
  );
  const denseGraph = (graph?.nodes.length ?? 0) > 12;
  const fitViewOptions = !graph
    ? undefined
    : graph.level === "flow"
      ? { padding: 0.1, minZoom: 0.68, maxZoom: 1.08 }
      : graph.level === "symbol"
        ? { padding: 0.08, minZoom: denseGraph ? 0.72 : 0.86, maxZoom: 1.2 }
        : { padding: 0.08, minZoom: denseGraph ? 0.72 : 0.82, maxZoom: 1.14 };
  const graphNodeIds = useMemo(
    () => new Set(graph?.nodes.map((node) => node.id) ?? []),
    [graph],
  );
  const selectedNodeId = !graph
    ? ""
    : graphNodeIds.has(activeNodeId ?? "")
      ? activeNodeId ?? ""
      : "";
  const viewKey = graph ? graphLayoutViewKey(graph) : undefined;
  const hydrationGenerationRef = useRef(0);
  const panelRef = useRef<HTMLElement>(null);
  const graphHotkeyActiveRef = useRef(false);
  const [nodes, setNodes] = useState<GraphCanvasNode[]>([]);
  const panModeActive = useKeyPress("Space");

  const handleNavigateOutKey = (event: {
    key: string;
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    target: EventTarget | null;
    preventDefault: () => void;
  }) => {
    if (!shouldHandleNavigateOutKey(event)) {
      return;
    }

    event.preventDefault();
    onNavigateOut();
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
        panelRef.current
        && event.target instanceof Node
        && panelRef.current.contains(event.target),
      );
      const panelContainsFocus = Boolean(
        panelRef.current
        && document.activeElement instanceof Node
        && panelRef.current.contains(document.activeElement),
      );

      if (
        !(graphHotkeyActiveRef.current || panelContainsTarget || panelContainsFocus)
        || !shouldHandleNavigateOutKey(event)
      ) {
        return;
      }

      handleNavigateOutKey(event);
    };

    const handlePanelKeyDown = (event: KeyboardEvent) => {
      if (!shouldHandleNavigateOutKey(event)) {
        return;
      }

      handleNavigateOutKey(event);
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
  }, [onNavigateOut]);

  useEffect(() => {
    if (!graph || !viewKey) {
      setNodes([]);
      return;
    }

    const generation = hydrationGenerationRef.current + 1;
    hydrationGenerationRef.current = generation;
    setNodes(buildGraphCanvasNodes(graph, selectedNodeId, {}, onActivateNode));

    let cancelled = false;
    void readStoredGraphLayout(repoPath, viewKey).then((savedPositions) => {
      if (cancelled || hydrationGenerationRef.current !== generation) {
        return;
      }
      setNodes(buildGraphCanvasNodes(graph, selectedNodeId, savedPositions, onActivateNode));
    });

    return () => {
      cancelled = true;
    };
  }, [graph, onActivateNode, repoPath, viewKey]);

  useEffect(() => {
    setNodes((current) => applySelectedNodeClass(current, selectedNodeId));
  }, [selectedNodeId]);

  const handleNodesChange = (changes: NodeChange<GraphCanvasNode>[]) => {
    setNodes((current) => applyNodeChanges(changes, current));
  };

  const persistMovedNodes = (movedNodes: GraphCanvasNode[]) => {
    hydrationGenerationRef.current += 1;
    setNodes((current) => {
      const movedPositions = new Map(
        movedNodes.map((node) => [node.id, node.position] as const),
      );
      const next = current.map((node) =>
        movedPositions.has(node.id)
          ? {
              ...node,
              position: movedPositions.get(node.id) ?? node.position,
            }
          : node,
      );
      void writeStoredGraphLayout(repoPath, viewKey, persistNodePositions(next));
      return next;
    });
  };

  const handleNodeDragStop = (_event: unknown, draggedNode: GraphCanvasNode) => {
    persistMovedNodes([draggedNode]);
  };

  const handleSelectionDragStop = (_event: unknown, movedNodes: GraphCanvasNode[]) => {
    persistMovedNodes(movedNodes);
  };

  if (!graph || !blueprint || !fitViewOptions || !viewKey) {
    return (
      <section className="content-panel graph-panel">
        <EmptyState
          title="Blueprint canvas"
          body="Index a repo to open the architecture map. Modules appear first, then symbols and flow only when you drill down."
        />
      </section>
    );
  }

  const edges = graph.edges.map((edge) => {
    const connected = edge.source === selectedNodeId || edge.target === selectedNodeId;
    const highlighted = highlightGraphPath && connected;
    const handles = blueprint.edgeHandles.get(edge.id);
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: handles?.sourceHandle,
      targetHandle: handles?.targetHandle,
      type: "smoothstep",
      label: showEdgeLabels ? edge.label : undefined,
      animated: highlighted && (edge.kind === "calls" || edge.kind === "controls"),
      style: {
        stroke:
          edge.kind === "contains"
            ? "color-mix(in srgb, var(--line-strong) 52%, transparent)"
            : edge.kind === "data"
            ? "var(--accent-strong)"
            : edge.kind === "controls"
            ? "color-mix(in srgb, #ffbf5a 72%, var(--line-strong) 28%)"
            : highlighted
              ? "var(--accent-strong)"
              : "var(--line-strong)",
        strokeWidth: highlighted ? 2.4 : edge.kind === "data" ? 1.8 : edge.kind === "contains" ? 1 : 1.2,
        strokeDasharray: edge.kind === "data" ? "8 6" : edge.kind === "controls" ? "0" : undefined,
      },
      labelShowBg: Boolean(showEdgeLabels && edge.label),
      labelBgPadding: [5, 9] as [number, number],
      labelBgBorderRadius: 999,
      labelBgStyle: {
        fill: "var(--surface-solid)",
        stroke: highlighted ? "var(--accent-strong)" : "var(--line-strong)",
        strokeWidth: 1,
        opacity: 0.92,
      },
      labelStyle: {
        fill: highlighted ? "var(--text)" : "var(--text-muted)",
        fontSize: 11,
        fontWeight: 600,
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color:
          edge.kind === "data"
            ? "var(--accent-strong)"
            : edge.kind === "controls"
              ? "color-mix(in srgb, #ffbf5a 72%, var(--line-strong) 28%)"
            : highlighted
              ? "var(--accent-strong)"
              : "var(--line-strong)",
      },
    };
  });

  return (
    <section
      ref={panelRef}
      aria-label="Graph canvas"
      className={`content-panel graph-panel${panModeActive ? " is-pan-active" : ""}`}
      role="region"
      tabIndex={0}
      onFocusCapture={() => {
        graphHotkeyActiveRef.current = true;
      }}
      onPointerDownCapture={(event) => {
        if (!isEditableEventTarget(event.target)) {
          panelRef.current?.focus();
        }
      }}
      onClickCapture={(event) => {
        if (isCanvasBackgroundTarget(event.target)) {
          void onClearSelection();
        }
      }}
      onKeyDown={(event) => {
        handleNavigateOutKey(event);
      }}
    >
      <ReactFlow<GraphCanvasNode>
        key={viewKey}
        fitView
        fitViewOptions={fitViewOptions}
        proOptions={{ hideAttribution: true }}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={handleNodesChange}
        onNodeDragStop={handleNodeDragStop}
        onSelectionDragStop={handleSelectionDragStop}
        nodesDraggable
        nodesConnectable={false}
        selectionKeyCode={null}
        selectionOnDrag
        selectionMode={SelectionMode.Partial}
        panOnDrag={false}
        onNodeClick={(_, node) =>
          onSelectNode(node.id, (node.data as { kind: GraphNodeKind }).kind)
        }
        onNodeDoubleClick={(_, node) =>
          onActivateNode(node.id, (node.data as { kind: GraphNodeKind }).kind)
        }
      >
        <Controls showInteractive={false} />
        <Background gap={32} size={1} color="var(--line-strong)" />
      </ReactFlow>

      <GraphToolbar
        graph={graph}
        graphFilters={graphFilters}
        graphSettings={graphSettings}
        highlightGraphPath={highlightGraphPath}
        showEdgeLabels={showEdgeLabels}
        inspectorOpen={inspectorOpen}
        onSelectBreadcrumb={onSelectBreadcrumb}
        onSelectLevel={onSelectLevel}
        onToggleGraphFilter={onToggleGraphFilter}
        onToggleGraphSetting={onToggleGraphSetting}
        onToggleGraphPathHighlight={onToggleGraphPathHighlight}
        onToggleEdgeLabels={onToggleEdgeLabels}
        onToggleInspector={onToggleInspector}
      />
    </section>
  );
}
