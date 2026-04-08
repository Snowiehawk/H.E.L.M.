import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { GraphNodeKind } from "../../lib/adapter";
import type { BlueprintPort } from "./blueprintPorts";

export interface BlueprintNodeData extends Record<string, unknown> {
  kind: GraphNodeKind;
  label: string;
  summary?: string;
  inputPorts: BlueprintPort[];
  outputPorts: BlueprintPort[];
  primaryActionLabel?: string;
  onPrimaryAction?: () => void;
}

function PortList({
  direction,
  ports,
}: {
  direction: "input" | "output";
  ports: BlueprintPort[];
}) {
  return (
    <div
      className={`graph-node__ports graph-node__ports--${direction}${ports.length ? "" : " is-empty"}`}
    >
      {ports.map((port) => {
        const memberCount = port.memberLabels?.length ?? 0;
        const showBadge = memberCount > 1;
        const badge = showBadge ? (
          <span
            aria-label={`${memberCount} ${port.label} connections: ${port.memberLabels?.join(", ")}`}
            className="graph-node__port-badge"
            title={port.memberLabels?.join("\n")}
          >
            {memberCount}
          </span>
        ) : null;

        return (
          <div
            key={port.id}
            className={`graph-node__port graph-node__port--${direction} graph-node__port--${port.kind}`}
          >
            {direction === "input" ? (
              <Handle
                id={port.id}
                className={`graph-node__handle graph-node__handle--${port.kind}`}
                type="target"
                position={Position.Left}
                isConnectable={false}
              />
            ) : null}
            {direction === "input" ? badge : null}
            <span className="graph-node__port-label">{port.label}</span>
            {direction === "output" ? badge : null}
            {direction === "output" ? (
              <Handle
                id={port.id}
                className={`graph-node__handle graph-node__handle--${port.kind}`}
                type="source"
                position={Position.Right}
                isConnectable={false}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export const BlueprintNode = memo(function BlueprintNode({
  data,
}: NodeProps) {
  const blueprintData = data as unknown as BlueprintNodeData;

  return (
    <div className={`graph-node graph-node--${blueprintData.kind}`}>
      <PortList direction="input" ports={blueprintData.inputPorts} />

      <div className="graph-node__body">
        <div className="graph-node__header">
          <span className="graph-node__kind">{blueprintData.kind}</span>
          {blueprintData.primaryActionLabel && blueprintData.onPrimaryAction ? (
            <button
              className="graph-node__action nodrag"
              type="button"
              onPointerDown={(event) => {
                event.stopPropagation();
              }}
              onDoubleClick={(event) => {
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.stopPropagation();
                blueprintData.onPrimaryAction?.();
              }}
            >
              {blueprintData.primaryActionLabel}
            </button>
          ) : null}
        </div>
        <strong className="graph-node__title" title={blueprintData.label}>
          {blueprintData.label}
        </strong>
        {blueprintData.summary ? (
          <span className="graph-node__subtitle" title={blueprintData.summary}>
            {blueprintData.summary}
          </span>
        ) : null}
      </div>

      <PortList direction="output" ports={blueprintData.outputPorts} />
    </div>
  );
});
