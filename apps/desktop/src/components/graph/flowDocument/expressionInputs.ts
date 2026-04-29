import type {
  FlowExpressionEdge,
  FlowExpressionGraph,
  FlowExpressionNode,
} from "../../../lib/adapter";
import { expressionFromFlowExpressionGraph } from "../flowExpressionGraph";

export function withReturnExpressionInputNode(
  payload: Record<string, unknown>,
  slotId: string,
  name: string,
): Record<string, unknown> {
  const graph = flowExpressionGraphFromPayload(payload.expression_graph);
  const existing = graph.nodes.some((node) => {
    const payloadSlotId = node.payload.slot_id ?? node.payload.slotId;
    const payloadName = node.payload.name;
    return (
      node.kind === "input" &&
      (payloadSlotId === slotId || payloadName === name || node.label === name)
    );
  });
  if (existing) {
    return { ...payload, expression_graph: graph };
  }
  const inputNode: FlowExpressionNode = {
    id: nextExpressionNodeId(graph, "input", name),
    kind: "input",
    label: name,
    payload: {
      name,
      slot_id: slotId,
    },
  };
  return {
    ...payload,
    expression_graph: {
      ...graph,
      nodes: [...graph.nodes, inputNode],
    },
  };
}

export function withoutExpressionInputSlots(
  payload: Record<string, unknown>,
  slotIdsToRemove: Set<string>,
  slotNamesToRemove: Set<string>,
): Record<string, unknown> {
  if (!payload.expression_graph) {
    return payload;
  }
  const graph = flowExpressionGraphFromPayload(payload.expression_graph);
  const removedNodeIds = new Set(
    graph.nodes
      .filter((node) => {
        if (node.kind !== "input") {
          return false;
        }
        const payloadSlotId = node.payload.slot_id ?? node.payload.slotId;
        const payloadName = typeof node.payload.name === "string" ? node.payload.name.trim() : "";
        return (
          (typeof payloadSlotId === "string" && slotIdsToRemove.has(payloadSlotId)) ||
          (payloadName && slotNamesToRemove.has(payloadName)) ||
          slotNamesToRemove.has(node.label.trim())
        );
      })
      .map((node) => node.id),
  );
  if (!removedNodeIds.size) {
    return payload;
  }

  const nextGraph = simplifyExpressionGraphWithoutNodes(graph, removedNodeIds);
  const expressionResult = expressionFromFlowExpressionGraph(nextGraph);
  return {
    ...payload,
    expression_graph: nextGraph,
    ...(expressionResult.diagnostics.length ? {} : { expression: expressionResult.expression }),
  };
}

function simplifyExpressionGraphWithoutNodes(
  graph: FlowExpressionGraph,
  removedNodeIds: Set<string>,
): FlowExpressionGraph {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const incomingByTarget = new Map<string, FlowExpressionEdge[]>();
  graph.edges.forEach((edge) => {
    incomingByTarget.set(edge.targetId, [...(incomingByTarget.get(edge.targetId) ?? []), edge]);
  });

  const keptNodes = new Map<string, FlowExpressionNode>();
  const keptEdges = new Map<string, FlowExpressionEdge>();
  const visiting = new Set<string>();

  const keepNode = (node: FlowExpressionNode) => {
    if (!keptNodes.has(node.id)) {
      keptNodes.set(node.id, {
        ...node,
        payload: { ...node.payload },
      });
    }
  };
  const keepEdge = (sourceId: string, targetId: string, targetHandle: string) => {
    const id = `expr-edge:${sourceId}->${targetId}:${targetHandle}`;
    keptEdges.set(id, {
      id,
      sourceId,
      sourceHandle: "value",
      targetId,
      targetHandle,
    });
  };
  const singleChild = (nodeId: string, handle: string) =>
    (incomingByTarget.get(nodeId) ?? []).find((edge) => edge.targetHandle === handle);
  const indexedChildren = (nodeId: string, prefix: string) =>
    (incomingByTarget.get(nodeId) ?? [])
      .filter((edge) => edge.targetHandle.startsWith(prefix))
      .slice()
      .sort((left, right) => left.targetHandle.localeCompare(right.targetHandle));

  const visit = (nodeId: string): string | undefined => {
    if (removedNodeIds.has(nodeId) || visiting.has(nodeId)) {
      return undefined;
    }
    const node = nodeById.get(nodeId);
    if (!node) {
      return undefined;
    }
    visiting.add(nodeId);

    const keepWithRequiredChildren = (
      children: Array<[FlowExpressionEdge | undefined, string]>,
    ) => {
      const resolved = children.map(
        ([edge, handle]) => [edge ? visit(edge.sourceId) : undefined, handle] as const,
      );
      if (resolved.some(([sourceId]) => !sourceId)) {
        visiting.delete(nodeId);
        return undefined;
      }
      keepNode(node);
      resolved.forEach(([sourceId, handle]) => {
        keepEdge(sourceId as string, node.id, handle);
      });
      visiting.delete(nodeId);
      return node.id;
    };

    if (node.kind === "operator") {
      const left = singleChild(node.id, "left");
      const right = singleChild(node.id, "right");
      const leftSourceId = left ? visit(left.sourceId) : undefined;
      const rightSourceId = right ? visit(right.sourceId) : undefined;
      if (!leftSourceId || !rightSourceId) {
        visiting.delete(nodeId);
        return leftSourceId ?? rightSourceId;
      }
      keepNode(node);
      keepEdge(leftSourceId, node.id, "left");
      keepEdge(rightSourceId, node.id, "right");
      visiting.delete(nodeId);
      return node.id;
    }

    if (node.kind === "bool") {
      const children = indexedChildren(node.id, "value:")
        .map((edge) => visit(edge.sourceId))
        .filter((sourceId): sourceId is string => Boolean(sourceId));
      if (children.length <= 1) {
        visiting.delete(nodeId);
        return children[0];
      }
      keepNode(node);
      children.forEach((sourceId, index) => keepEdge(sourceId, node.id, `value:${index}`));
      visiting.delete(nodeId);
      return node.id;
    }

    if (node.kind === "call") {
      const functionEdge = singleChild(node.id, "function");
      const functionSourceId = functionEdge ? visit(functionEdge.sourceId) : undefined;
      if (!functionSourceId) {
        visiting.delete(nodeId);
        return undefined;
      }
      keepNode(node);
      keepEdge(functionSourceId, node.id, "function");
      let argumentIndex = 0;
      indexedChildren(node.id, "arg:").forEach((edge) => {
        const sourceId = visit(edge.sourceId);
        if (sourceId) {
          keepEdge(sourceId, node.id, `arg:${argumentIndex}`);
          argumentIndex += 1;
        }
      });
      (incomingByTarget.get(node.id) ?? [])
        .filter((edge) => edge.targetHandle.startsWith("kwarg:"))
        .forEach((edge) => {
          const sourceId = visit(edge.sourceId);
          if (sourceId) {
            keepEdge(sourceId, node.id, edge.targetHandle);
          }
        });
      visiting.delete(nodeId);
      return node.id;
    }

    if (node.kind === "collection") {
      const childPrefix =
        node.payload.collection_type === "dict" || node.payload.collectionType === "dict"
          ? "value:"
          : "item:";
      const children = indexedChildren(node.id, childPrefix)
        .map((edge) => visit(edge.sourceId))
        .filter((sourceId): sourceId is string => Boolean(sourceId));
      keepNode(node);
      children.forEach((sourceId, index) => keepEdge(sourceId, node.id, `${childPrefix}${index}`));
      visiting.delete(nodeId);
      return node.id;
    }

    if (node.kind === "unary") {
      return keepWithRequiredChildren([[singleChild(node.id, "operand"), "operand"]]);
    }
    if (node.kind === "attribute") {
      return keepWithRequiredChildren([[singleChild(node.id, "value"), "value"]]);
    }
    if (node.kind === "subscript") {
      return keepWithRequiredChildren([
        [singleChild(node.id, "value"), "value"],
        [singleChild(node.id, "slice"), "slice"],
      ]);
    }
    if (node.kind === "conditional") {
      return keepWithRequiredChildren([
        [singleChild(node.id, "test"), "test"],
        [singleChild(node.id, "body"), "body"],
        [singleChild(node.id, "orelse"), "orelse"],
      ]);
    }
    if (node.kind === "compare") {
      const left = singleChild(node.id, "left");
      const leftSourceId = left ? visit(left.sourceId) : undefined;
      const comparators = indexedChildren(node.id, "comparator:")
        .map((edge) => visit(edge.sourceId))
        .filter((sourceId): sourceId is string => Boolean(sourceId));
      if (!leftSourceId) {
        visiting.delete(nodeId);
        return undefined;
      }
      if (!comparators.length) {
        visiting.delete(nodeId);
        return leftSourceId;
      }
      keepNode(node);
      keepEdge(leftSourceId, node.id, "left");
      comparators.forEach((sourceId, index) => keepEdge(sourceId, node.id, `comparator:${index}`));
      visiting.delete(nodeId);
      return node.id;
    }

    keepNode(node);
    visiting.delete(nodeId);
    return node.id;
  };

  const rootId = graph.rootId ? visit(graph.rootId) : undefined;
  const keptNodeIds = new Set(keptNodes.keys());
  const layoutNodes = graph.layout?.nodes
    ? Object.fromEntries(
        Object.entries(graph.layout.nodes).filter(([nodeId]) => keptNodeIds.has(nodeId)),
      )
    : undefined;
  return {
    ...graph,
    rootId: rootId ?? null,
    nodes: graph.nodes
      .filter((node) => keptNodeIds.has(node.id))
      .map((node) => keptNodes.get(node.id) ?? node),
    edges: [...keptEdges.values()],
    ...(layoutNodes && Object.keys(layoutNodes).length ? { layout: { nodes: layoutNodes } } : {}),
  };
}

export function flowExpressionGraphFromPayload(value: unknown): FlowExpressionGraph {
  if (
    value &&
    typeof value === "object" &&
    Array.isArray((value as Partial<FlowExpressionGraph>).nodes) &&
    Array.isArray((value as Partial<FlowExpressionGraph>).edges)
  ) {
    const graph = value as FlowExpressionGraph;
    return {
      version: typeof graph.version === "number" ? graph.version : 1,
      rootId: typeof graph.rootId === "string" ? graph.rootId : null,
      nodes: graph.nodes.map((node) => ({
        id: node.id,
        kind: node.kind,
        label: node.label,
        payload: { ...node.payload },
      })),
      edges: graph.edges.map((edge) => ({ ...edge })),
      ...(graph.layout
        ? {
            layout: {
              ...(graph.layout.nodes ? { nodes: { ...graph.layout.nodes } } : {}),
            },
          }
        : {}),
    };
  }
  return {
    version: 1,
    rootId: null,
    nodes: [],
    edges: [],
  };
}

function nextExpressionNodeId(graph: FlowExpressionGraph, kind: string, label: string): string {
  const safeLabel = label.trim().replace(/[^a-zA-Z0-9_-]+/g, "-") || "value";
  const existingIds = new Set(graph.nodes.map((node) => node.id));
  let index = graph.nodes.length;
  let nodeId = `expr:${kind}:${safeLabel}:${index}`;
  while (existingIds.has(nodeId)) {
    index += 1;
    nodeId = `expr:${kind}:${safeLabel}:${index}`;
  }
  return nodeId;
}
