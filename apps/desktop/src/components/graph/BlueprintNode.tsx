import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { GraphNodeKind } from "../../lib/adapter";
import type { BlueprintPort } from "./blueprintPorts";
import {
  type HelpDescriptorId,
  helpIdForGraphNodeKind,
  helpIdForPort,
  helpTargetProps,
} from "../workspace/workspaceHelp";

export interface BlueprintNodePort extends BlueprintPort {
  isHighlighted?: boolean;
  isDimmed?: boolean;
  onHoverStart?: () => void;
  onHoverEnd?: () => void;
}

export interface BlueprintNodeData extends Record<string, unknown> {
  kind: GraphNodeKind;
  label: string;
  summary?: string;
  isPinned?: boolean;
  connectable?: boolean;
  inputPorts: BlueprintNodePort[];
  outputPorts: BlueprintNodePort[];
  actions?: Array<{
    id: "enter" | "inspect" | "pin";
    label: string;
    helpId: HelpDescriptorId;
    onAction: () => void;
  }>;
  onDefaultAction?: () => void;
}

function PortList({
  direction,
  ports,
  connectable = false,
}: {
  direction: "input" | "output";
  ports: BlueprintNodePort[];
  connectable?: boolean;
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
            {...helpTargetProps(helpIdForPort(port.kind, port.label), {
              label: port.label,
            })}
            className={[
              "graph-node__port",
              `graph-node__port--${direction}`,
              `graph-node__port--${port.kind}`,
              port.isHighlighted ? "is-highlighted" : "",
              port.isDimmed ? "is-dimmed" : "",
            ].filter(Boolean).join(" ")}
            onMouseEnter={port.onHoverStart}
            onMouseLeave={port.onHoverEnd}
          >
            {direction === "input" ? (
              <Handle
                id={port.id}
                className={[
                  "graph-node__handle",
                  `graph-node__handle--${port.kind}`,
                  port.isHighlighted ? "is-highlighted" : "",
                  port.isDimmed ? "is-dimmed" : "",
                ].filter(Boolean).join(" ")}
                type="target"
                position={Position.Left}
                isConnectable={(port.kind === "control" || port.kind === "data") && connectable}
              />
            ) : null}
            {direction === "input" ? badge : null}
            <span className="graph-node__port-label">{port.label}</span>
            {direction === "output" ? badge : null}
            {direction === "output" ? (
              <Handle
                id={port.id}
                className={[
                  "graph-node__handle",
                  `graph-node__handle--${port.kind}`,
                  port.isHighlighted ? "is-highlighted" : "",
                  port.isDimmed ? "is-dimmed" : "",
                ].filter(Boolean).join(" ")}
                type="source"
                position={Position.Right}
                isConnectable={(port.kind === "control" || port.kind === "data") && connectable}
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
  const actions = blueprintData.actions ?? [];

  return (
    <div
      {...helpTargetProps(helpIdForGraphNodeKind(blueprintData.kind), {
        label: blueprintData.label,
      })}
      className={`graph-node graph-node--${blueprintData.kind}${blueprintData.isPinned ? " graph-node--pinned" : ""}`}
    >
      <PortList
        direction="input"
        ports={blueprintData.inputPorts}
        connectable={blueprintData.connectable}
      />

      <div className="graph-node__body">
        <div className="graph-node__header">
          <span className="graph-node__kind">{blueprintData.kind}</span>
          {actions.length ? (
            <div className="graph-node__actions">
              {actions.map((action) => (
                <button
                  key={action.id}
                  {...helpTargetProps(action.helpId)}
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
                    action.onAction();
                  }}
                >
                  {action.label}
                </button>
              ))}
            </div>
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

      <PortList
        direction="output"
        ports={blueprintData.outputPorts}
        connectable={blueprintData.connectable}
      />
    </div>
  );
});
