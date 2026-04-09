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
  segmentIndex: number;
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
  labelStyle?: CSSProperties,
  labelBgStyle?: CSSProperties,
) {
  return {
    wrapper: {
      position: "absolute",
      transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`,
      pointerEvents: "none",
      opacity: dimmed ? 0.24 : 1,
    } satisfies CSSProperties,
    bubble: {
      padding: "5px 9px",
      borderRadius: 999,
      background: labelBgStyle?.fill ?? "var(--surface-solid)",
      border: `${labelBgStyle?.strokeWidth ?? 1}px solid ${labelBgStyle?.stroke ?? "var(--line-strong)"}`,
      color: labelStyle?.fill ?? "var(--text-muted)",
      fontSize: labelStyle?.fontSize ?? 11,
      fontWeight: labelStyle?.fontWeight ?? 600,
      lineHeight: 1,
      whiteSpace: "nowrap",
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

  const labelText = typeof label === "string" ? label : undefined;
  const edgeOpacity = typeof style?.opacity === "number" ? style.opacity : 1;
  const styles = labelText
    ? labelStyles(
        labelX,
        labelY,
        edgeOpacity < 0.3,
        labelStyle as CSSProperties,
        labelBgStyle as CSSProperties,
      )
    : undefined;

  return (
    <>
      <BaseEdge id={id} markerEnd={markerEnd} path={edgePath} style={style} />
      <path
        d={edgePath}
        data-testid={`graph-edge:${id}`}
        className="graph-edge__interaction"
        fill="none"
        stroke="transparent"
        strokeWidth={20}
        onDoubleClick={handleDoubleClick}
        onMouseEnter={handleHoverStart}
        onMouseLeave={() => edgeData?.onHoverEnd?.()}
      />
      {labelText && styles ? (
        <EdgeLabelRenderer>
          <div style={styles.wrapper}>
            <div style={styles.bubble}>{labelText}</div>
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
});
