import { useState } from "react";
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
  currentNodeLabel,
  canNavigateUp,
  canNavigateRoot,
  graphDepth,
  graphFilters,
  highlightGraphPath,
  showEdgeLabels,
  onSelectNode,
  onNavigateUp,
  onNavigateRoot,
  onExpandDepth,
  onReduceDepth,
  onToggleGraphFilter,
  onToggleGraphPathHighlight,
  onToggleEdgeLabels,
}: {
  graph?: GraphNeighborhood;
  activeNodeId?: string;
  currentNodeLabel?: string;
  canNavigateUp: boolean;
  canNavigateRoot: boolean;
  graphDepth: number;
  graphFilters: GraphFilters;
  highlightGraphPath: boolean;
  showEdgeLabels: boolean;
  onSelectNode: (nodeId: string, kind: GraphNodeKind) => void;
  onNavigateUp: () => void;
  onNavigateRoot: () => void;
  onExpandDepth: () => void;
  onReduceDepth: () => void;
  onToggleGraphFilter: (key: keyof GraphFilters) => void;
  onToggleGraphPathHighlight: () => void;
  onToggleEdgeLabels: () => void;
}) {
  const [controlsExpanded, setControlsExpanded] = useState(false);

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
      label: showEdgeLabels ? edge.label : undefined,
      animated: highlighted,
      style: {
        stroke: highlighted ? "var(--accent-strong)" : "var(--line-strong)",
        strokeWidth: highlighted ? 2.1 : 1.1,
      },
      labelShowBg: Boolean(showEdgeLabels && edge.label),
      labelBgPadding: [5, 9] as [number, number],
      labelBgBorderRadius: 999,
      labelBgStyle: {
        fill: highlighted ? "var(--surface-strong)" : "var(--surface-solid)",
        stroke: highlighted ? "var(--accent-strong)" : "var(--line-strong)",
        strokeWidth: 1,
        opacity: highlighted ? 0.96 : 0.88,
      },
      labelStyle: {
        fill: highlighted ? "var(--text)" : "var(--text-muted)",
        fontSize: 11,
        fontWeight: 600,
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
          <div
            className={`graph-hud${controlsExpanded ? " is-expanded" : " is-collapsed"}`}
          >
            <div className="graph-hud__bar">
              <div className="graph-hud__focus">
                <span className="window-bar__eyebrow">Graph</span>
                <strong>{currentNodeLabel ?? "Current focus"}</strong>
              </div>
              <div className="graph-hud__actions">
                {canNavigateUp || canNavigateRoot ? (
                  <div className="graph-hud__nav">
                    {canNavigateUp ? (
                      <button className="ghost-button" type="button" onClick={onNavigateUp}>
                        Up
                      </button>
                    ) : null}
                    {canNavigateRoot ? (
                      <button className="ghost-button" type="button" onClick={onNavigateRoot}>
                        Root
                      </button>
                    ) : null}
                  </div>
                ) : null}
                <button
                  className={`graph-hud__toggle${controlsExpanded ? " is-active" : ""}`}
                  type="button"
                  onClick={() => setControlsExpanded((current) => !current)}
                >
                  {controlsExpanded ? "Hide controls" : "Graph controls"}
                </button>
              </div>
            </div>

            {controlsExpanded ? (
              <div className="graph-hud__panel">
                <div className="graph-hud__section">
                  <span className="window-bar__eyebrow">Depth</span>
                  <div className="graph-depth">
                    <button className="ghost-button" type="button" onClick={onReduceDepth}>
                      Less
                    </button>
                    <span className="graph-depth__value">{graphDepth}</span>
                    <button className="ghost-button" type="button" onClick={onExpandDepth}>
                      More
                    </button>
                  </div>
                </div>

                <div className="graph-hud__section">
                  <span className="window-bar__eyebrow">Layers</span>
                  <div className="graph-filters">
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
                    <button
                      className={`toggle-button${showEdgeLabels ? " is-active" : ""}`}
                      type="button"
                      onClick={onToggleEdgeLabels}
                    >
                      Labels
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </Panel>
      </ReactFlow>
    </section>
  );
}
