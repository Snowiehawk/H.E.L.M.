import { useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  PanOnScrollMode,
  Position,
  ReactFlow,
  applyNodeChanges,
} from "@xyflow/react";
import type { Node, NodeProps, ReactFlowInstance } from "@xyflow/react";
import type { IssueGraph, IssueGraphNode } from "./issueGraph";

type IssueFlowNode = Node<{ issue: IssueGraphNode }, "issue">;

function IssueCard({ data }: NodeProps<IssueFlowNode>) {
  return (
    <div className={`issue-graph-card${data.issue.external ? " is-external" : ""}`}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <span className="window-bar__eyebrow">
        #{data.issue.number} · {data.issue.state.toLowerCase()}
        {data.issue.external ? " · external" : ""}
      </span>
      <strong>{data.issue.title}</strong>
      <small>
        {data.issue.repository}
        {data.issue.partial ? " · partial blockers" : ""}
      </small>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}
const nodeTypes = { issue: IssueCard };

export function IssueGraphCanvas({
  graph,
  selectedId,
  onSelect,
}: {
  graph: IssueGraph;
  selectedId?: string;
  onSelect: (id?: string) => void;
}) {
  const instance = useRef<ReactFlowInstance<IssueFlowNode> | null>(null);
  const [nodes, setNodes] = useState<IssueFlowNode[]>([]);
  useEffect(() => {
    setNodes((previous) => {
      const positions = new Map(previous.map((node) => [node.id, node.position]));
      return graph.nodes.map((issue) => ({
        id: issue.id,
        type: "issue",
        position: positions.get(issue.id) ?? issue.position,
        data: { issue },
        selected: issue.id === selectedId,
        ariaLabel: `Issue ${issue.number}: ${issue.title}`,
      }));
    });
  }, [graph, selectedId]);
  const edges = useMemo(
    () =>
      graph.edges.map((edge) => ({
        ...edge,
        ariaLabel: "blocks",
        type: "smoothstep",
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { stroke: "var(--accent-strong)" },
      })),
    [graph],
  );
  return (
    <section
      className="issue-graph-panel"
      aria-label="GitHub issue graph"
      data-layout-namespace={graph.namespace}
    >
      <div className="issue-graph-toolbar">
        <span>Arrows run from blocker to blocked issue.</span>
        {graph.partial ? (
          <span className="error-copy">Partial snapshot: blocker links may be missing.</span>
        ) : null}
        <button
          className="secondary-button"
          onClick={() => void instance.current?.fitView({ padding: 0.15, duration: 200 })}
        >
          Fit issues
        </button>
        <button
          className="secondary-button"
          disabled={!selectedId}
          onClick={() => {
            if (selectedId)
              void instance.current?.fitView({
                nodes: [{ id: selectedId }],
                padding: 0.35,
                maxZoom: 1,
                duration: 200,
              });
          }}
        >
          Center selected issue
        </button>
      </div>
      <div className="issue-graph-surface">
        <ReactFlow<IssueFlowNode>
          id="github-issue-flow"
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
          onInit={(flow) => {
            instance.current = flow;
          }}
          onNodesChange={(changes) => setNodes((current) => applyNodeChanges(changes, current))}
          onNodeClick={(_event, node) => onSelect(node.id)}
          onPaneClick={() => onSelect(undefined)}
          nodesConnectable={false}
          edgesReconnectable={false}
          deleteKeyCode={null}
          zoomOnScroll={false}
          panOnScroll
          panOnScrollMode={PanOnScrollMode.Free}
          zoomActivationKeyCode="Alt"
          minZoom={0.001}
          maxZoom={1.5}
          proOptions={{ hideAttribution: true }}
        >
          <Controls showInteractive={false} />
          <Background gap={32} color="var(--line)" />
        </ReactFlow>
      </div>
    </section>
  );
}
