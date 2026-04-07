import { Background, Controls, MarkerType, Panel, ReactFlow } from "@xyflow/react";
import type {
  GraphFilters,
  GraphNeighborhood,
  GraphNodeKind,
} from "../../lib/adapter";
import { EmptyState } from "../shared/EmptyState";

export function GraphCanvas({
  graph,
  activeNodeId,
  graphDepth,
  graphFilters,
  highlightGraphPath,
  onSelectNode,
  onExpandDepth,
  onReduceDepth,
  onToggleGraphFilter,
  onToggleGraphPathHighlight,
}: {
  graph?: GraphNeighborhood;
  activeNodeId?: string;
  graphDepth: number;
  graphFilters: GraphFilters;
  highlightGraphPath: boolean;
  onSelectNode: (nodeId: string, kind: GraphNodeKind) => void;
  onExpandDepth: () => void;
  onReduceDepth: () => void;
  onToggleGraphFilter: (key: keyof GraphFilters) => void;
  onToggleGraphPathHighlight: () => void;
}) {
  if (!graph) {
    return (
      <section className="content-panel graph-panel">
        <EmptyState
          title="Seed the graph"
          body="Open a repo and the graph becomes the workspace. Select a file or symbol to focus its neighborhood."
        />
      </section>
    );
  }

  const selectedNodeId = activeNodeId ?? graph.rootNodeId;
  const nodes = graph.nodes.map((node) => ({
    id: node.id,
    position: { x: node.x, y: node.y },
    data: {
      kind: node.kind,
      label: (
        <div className={`graph-node graph-node--${node.kind}`}>
          <span className="graph-node__kind">{node.kind}</span>
          <strong>{node.label}</strong>
          <span>{node.subtitle}</span>
        </div>
      ),
    },
    draggable: false,
    selectable: true,
    className: node.id === selectedNodeId ? "graph-node-shell is-active" : "graph-node-shell",
  }));

  const edges = graph.edges.map((edge) => {
    const connected = edge.source === selectedNodeId || edge.target === selectedNodeId;
    const highlighted = highlightGraphPath && connected;
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.label,
      animated: highlighted,
      style: {
        stroke: highlighted ? "var(--accent-strong)" : "var(--line-strong)",
        strokeWidth: highlighted ? 2.1 : 1.1,
      },
      labelStyle: {
        fill: "var(--text-muted)",
        fontSize: 11,
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: highlighted ? "var(--accent-strong)" : "var(--line-strong)",
      },
    };
  });

  return (
    <section className="content-panel graph-panel">
      <ReactFlow
        fitView
        nodes={nodes}
        edges={edges}
        nodesDraggable={false}
        nodesConnectable={false}
        onNodeClick={(_, node) =>
          onSelectNode(
            node.id,
            (node.data as { kind: GraphNodeKind }).kind,
          )
        }
      >
        <Controls showInteractive={false} />
        <Background gap={28} size={1} color="var(--line-strong)" />
        <Panel position="top-left">
          <div className="graph-toolbar">
            <div className="graph-toolbar__copy">
              <span className="window-bar__eyebrow">Code Graph</span>
              <h3>Node-based workspace</h3>
              <p>Pan, zoom, and click any file or symbol to tighten the graph around it.</p>
            </div>
            <div className="graph-filters">
              <button className="ghost-button" type="button" onClick={onReduceDepth}>
                Depth -
              </button>
              <span>Depth {graphDepth}</span>
              <button className="ghost-button" type="button" onClick={onExpandDepth}>
                Depth +
              </button>
              <button
                className={`toggle-button${graphFilters.includeCalls ? " is-active" : ""}`}
                type="button"
                onClick={() => onToggleGraphFilter("includeCalls")}
              >
                Calls
              </button>
              <button
                className={`toggle-button${graphFilters.includeImports ? " is-active" : ""}`}
                type="button"
                onClick={() => onToggleGraphFilter("includeImports")}
              >
                Imports
              </button>
              <button
                className={`toggle-button${graphFilters.includeDefines ? " is-active" : ""}`}
                type="button"
                onClick={() => onToggleGraphFilter("includeDefines")}
              >
                Defines
              </button>
              <button
                className={`toggle-button${highlightGraphPath ? " is-active" : ""}`}
                type="button"
                onClick={onToggleGraphPathHighlight}
              >
                Path
              </button>
            </div>
          </div>
        </Panel>
      </ReactFlow>
    </section>
  );
}
