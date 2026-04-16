import { memo } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  useReactFlow,
  type EdgeProps,
} from "@xyflow/react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import type { GraphEdgeKind } from "../../lib/adapter";

export interface BlueprintEdgeData extends Record<string, unknown> {
  logicalEdgeId: string;
  logicalEdgeKind: GraphEdgeKind;
  logicalEdgeLabel?: string;
  labelCount?: number;
  segmentIndex: number;
  labelOffsetX?: number;
  labelOffsetY?: number;
  onClick?: (
    logicalEdgeId: string,
    logicalEdgeKind: GraphEdgeKind,
    position: { x: number; y: number },
    clientPosition: { x: number; y: number },
    modifiers: { altKey: boolean },
    logicalEdgeLabel?: string,
  ) => void;
  onHoverStart?: (
    logicalEdgeId: string,
    logicalEdgeKind: GraphEdgeKind,
    logicalEdgeLabel?: string,
  ) => void;
  onHoverEnd?: () => void;
  onInsertReroute?: (
    logicalEdgeId: string,
    segmentIndex: number,
    position: { x: number; y: number },
  ) => void;
}

function labelStyles(
  x: number,
  y: number,
  dimmed: boolean,
  offsetX: number,
  offsetY: number,
  labelStyle?: CSSProperties,
  labelBgStyle?: CSSProperties,
) {
  return {
    wrapper: {
      position: "absolute",
      transform: `translate(-50%, -50%) translate(${x + offsetX}px, ${y + offsetY}px)`,
      pointerEvents: "none",
      opacity: dimmed ? 0.24 : 1,
    } satisfies CSSProperties,
    bubble: {
      padding: "5px 9px",
      borderRadius: 999,
      display: "flex",
      alignItems: "center",
      gap: 6,
      background: labelBgStyle?.fill ?? "var(--surface-solid)",
      border: `${labelBgStyle?.strokeWidth ?? 1}px solid ${labelBgStyle?.stroke ?? "var(--line-strong)"}`,
      color: labelStyle?.fill ?? "var(--text-muted)",
      fontSize: labelStyle?.fontSize ?? 11,
      fontWeight: labelStyle?.fontWeight ?? 600,
      lineHeight: 1,
      whiteSpace: "nowrap",
      boxSizing: "border-box",
    } satisfies CSSProperties,
    count: {
      minWidth: 18,
      padding: "2px 6px",
      borderRadius: 999,
      background: labelStyle?.fill ?? "var(--text-muted)",
      color: labelBgStyle?.fill ?? "var(--surface-solid)",
      fontSize: 10,
      fontWeight: 700,
      lineHeight: 1.1,
      textAlign: "center",
      boxSizing: "border-box",
    } satisfies CSSProperties,
  };
}

export const BlueprintEdge = memo(function BlueprintEdge({
  id,
  data,
  label,
  labelStyle,
  labelBgStyle,
  markerEnd,
  sourceX,
  sourceY,
  sourcePosition,
  style,
  targetX,
  targetY,
  targetPosition,
}: EdgeProps) {
  const edgeData = data as BlueprintEdgeData | undefined;
  const { screenToFlowPosition } = useReactFlow();
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const handleHoverStart = () => {
    edgeData?.onHoverStart?.(
      edgeData.logicalEdgeId,
      edgeData.logicalEdgeKind,
      edgeData.logicalEdgeLabel,
    );
  };

  const handleDoubleClick = (event: ReactMouseEvent<SVGPathElement>) => {
    if (!edgeData?.onInsertReroute) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const position = screenToFlowPosition({
      x: event.clientX,
      y: event.clientY,
    });
    edgeData.onInsertReroute(edgeData.logicalEdgeId, edgeData.segmentIndex, position);
  };

  const handleClick = (event: ReactMouseEvent<SVGPathElement>) => {
    if (!edgeData?.onClick) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    edgeData.onClick(
      edgeData.logicalEdgeId,
      edgeData.logicalEdgeKind,
      screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      }),
      {
        x: event.clientX,
        y: event.clientY,
      },
      {
        altKey: event.altKey,
      },
      edgeData.logicalEdgeLabel,
    );
  };

  const labelText = typeof label === "string" ? label : undefined;
  const labelCount = typeof edgeData?.labelCount === "number" && edgeData.labelCount > 1
    ? edgeData.labelCount
    : undefined;
  const edgeOpacity = typeof style?.opacity === "number" ? style.opacity : 1;
  const styles = labelText
    ? labelStyles(
        labelX,
        labelY,
        edgeOpacity < 0.3,
        edgeData?.labelOffsetX ?? 0,
        edgeData?.labelOffsetY ?? 0,
        labelStyle as CSSProperties,
        labelBgStyle as CSSProperties,
      )
    : undefined;

  return (
    <>
      <BaseEdge id={id} markerEnd={markerEnd} path={edgePath} style={style} />
      <path
        d={edgePath}
        data-testid={`graph-edge-hitarea:${id}`}
        className="graph-edge__interaction"
        fill="none"
        stroke="transparent"
        strokeWidth={20}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onMouseEnter={handleHoverStart}
        onMouseLeave={() => edgeData?.onHoverEnd?.()}
      />
      {labelText && styles ? (
        <EdgeLabelRenderer>
          <div style={styles.wrapper}>
            <div style={styles.bubble}>
              <span>{labelText}</span>
              {labelCount ? <span style={styles.count}>{labelCount}</span> : null}
            </div>
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
});
