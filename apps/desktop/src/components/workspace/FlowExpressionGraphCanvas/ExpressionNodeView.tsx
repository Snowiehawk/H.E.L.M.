import { Handle, Position, type NodeProps, type NodeTypes } from "@xyflow/react";
import { flowExpressionNodeDisplayLabel } from "../../graph/flowExpressionGraph";
import type { ExpressionCanvasNode } from "./types";

export function ExpressionNodeView({ data, selected }: NodeProps<ExpressionCanvasNode>) {
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

export const expressionNodeTypes = {
  expression: ExpressionNodeView,
} satisfies NodeTypes;
