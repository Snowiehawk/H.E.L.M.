import { getSmoothStepPath, type ConnectionLineComponentProps } from "@xyflow/react";
import type { ExpressionCanvasNode } from "./types";

export function FlowExpressionConnectionLine({
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
