import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { helpTargetProps } from "../workspace/workspaceHelp";

export interface RerouteNodeData extends Record<string, unknown> {
  kind: "reroute";
  logicalEdgeId: string;
  order: number;
}

function RerouteHandles({ type }: { type: "source" | "target" }) {
  return (
    <>
      <Handle
        id={`${type}:left`}
        className="graph-reroute-node__handle"
        type={type}
        position={Position.Left}
        isConnectable={false}
      />
      <Handle
        id={`${type}:right`}
        className="graph-reroute-node__handle"
        type={type}
        position={Position.Right}
        isConnectable={false}
      />
      <Handle
        id={`${type}:top`}
        className="graph-reroute-node__handle"
        type={type}
        position={Position.Top}
        isConnectable={false}
      />
      <Handle
        id={`${type}:bottom`}
        className="graph-reroute-node__handle"
        type={type}
        position={Position.Bottom}
        isConnectable={false}
      />
    </>
  );
}

export const RerouteNode = memo(function RerouteNode({ selected }: NodeProps) {
  return (
    <div
      {...helpTargetProps("graph.node.reroute")}
      className={`graph-reroute-node${selected ? " is-selected" : ""}`}
    >
      <RerouteHandles type="target" />
      <RerouteHandles type="source" />
      <span className="graph-reroute-node__dot" />
    </div>
  );
});
