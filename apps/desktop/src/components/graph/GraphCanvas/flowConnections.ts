import type { GraphEdgeKind, GraphNodeDto } from "../../../lib/adapter";

export function resolveFlowEdgeInteraction({
  flowAuthoringEnabled,
  logicalEdgeKind,
  altKey,
}: {
  flowAuthoringEnabled: boolean;
  logicalEdgeKind: GraphEdgeKind;
  altKey: boolean;
}): "ignore" | "select" | "disconnect" {
  if (!flowAuthoringEnabled || logicalEdgeKind !== "controls") {
    return "ignore";
  }
  return altKey ? "disconnect" : "select";
}

function isControlFlowConnectionPair(
  sourceHandle: string | null | undefined,
  targetHandle: string | null | undefined,
) {
  return sourceHandle?.startsWith("out:control:") === true && targetHandle === "in:control:exec";
}

function isDataFlowConnectionPair(
  sourceHandle: string | null | undefined,
  targetHandle: string | null | undefined,
) {
  return (
    sourceHandle?.startsWith("out:data:") === true && targetHandle?.startsWith("in:data:") === true
  );
}

export function isVisualFunctionInputNode(node: GraphNodeDto): boolean {
  return (
    node.kind === "param" &&
    node.metadata["flow_visual"] === true &&
    typeof node.metadata["function_input_id"] === "string"
  );
}

export function isValidFlowCanvasConnection(connection: {
  source?: string | null;
  sourceHandle?: string | null;
  target?: string | null;
  targetHandle?: string | null;
}) {
  if (!connection.source || !connection.target || connection.source === connection.target) {
    return false;
  }

  return (
    isControlFlowConnectionPair(connection.sourceHandle, connection.targetHandle) ||
    isDataFlowConnectionPair(connection.sourceHandle, connection.targetHandle)
  );
}
