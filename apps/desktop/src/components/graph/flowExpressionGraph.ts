import type {
  FlowExpressionEdge,
  FlowExpressionGraph,
  FlowExpressionGraphLayout,
  FlowExpressionNode,
  FlowExpressionNodeKind,
} from "../../lib/adapter";

const FLOW_EXPRESSION_NODE_KINDS = new Set<FlowExpressionNodeKind>([
  "input",
  "literal",
  "operator",
  "unary",
  "bool",
  "compare",
  "call",
  "attribute",
  "subscript",
  "conditional",
  "collection",
  "raw",
]);

const FLOW_EXPRESSION_ATOM_NODE_KINDS = new Set<FlowExpressionNodeKind>([
  "input",
  "literal",
  "raw",
]);

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function expressionNodeKind(value: unknown): FlowExpressionNodeKind | undefined {
  return typeof value === "string" && FLOW_EXPRESSION_NODE_KINDS.has(value as FlowExpressionNodeKind)
    ? value as FlowExpressionNodeKind
    : undefined;
}

function inferFlowExpressionRootId(
  nodes: FlowExpressionNode[],
  edges: FlowExpressionEdge[],
  rootId: string | null,
) {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const currentRootId = rootId && nodeIds.has(rootId) ? rootId : null;
  const outgoingNodeIds = new Set(edges.map((edge) => edge.sourceId));
  if (currentRootId && !outgoingNodeIds.has(currentRootId)) {
    return currentRootId;
  }

  const terminalNodes = nodes.filter((node) => !outgoingNodeIds.has(node.id));
  if (terminalNodes.length === 1) {
    return terminalNodes[0]!.id;
  }

  const terminalCompositeNodes = terminalNodes.filter(
    (node) => !FLOW_EXPRESSION_ATOM_NODE_KINDS.has(node.kind),
  );
  if (terminalCompositeNodes.length === 1) {
    return terminalCompositeNodes[0]!.id;
  }

  return currentRootId;
}

export function normalizeFlowExpressionGraph(value: unknown): FlowExpressionGraph | null {
  const graph = recordValue(value);
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    return null;
  }

  const nodes = graph.nodes.flatMap<FlowExpressionNode>((rawNode) => {
    const node = recordValue(rawNode);
    const kind = expressionNodeKind(node?.kind);
    const id = stringValue(node?.id);
    if (!node || !id || !kind) {
      return [];
    }
    const payload = recordValue(node.payload) ?? {};
    return [{
      id,
      kind,
      label: stringValue(node.label) ?? kind,
      payload: { ...payload },
    }];
  });
  const nodeIds = new Set(nodes.map((node) => node.id));

  const edges = graph.edges.flatMap<FlowExpressionEdge>((rawEdge) => {
    const edge = recordValue(rawEdge);
    const sourceId = stringValue(edge?.sourceId) ?? stringValue(edge?.source_id);
    const sourceHandle = stringValue(edge?.sourceHandle) ?? stringValue(edge?.source_handle);
    const targetId = stringValue(edge?.targetId) ?? stringValue(edge?.target_id);
    const targetHandle = stringValue(edge?.targetHandle) ?? stringValue(edge?.target_handle);
    if (
      !edge
      || !sourceId
      || !sourceHandle
      || !targetId
      || !targetHandle
      || !nodeIds.has(sourceId)
      || !nodeIds.has(targetId)
    ) {
      return [];
    }
    return [{
      id: stringValue(edge.id) ?? `expr-edge:${sourceId}->${targetId}:${targetHandle}`,
      sourceId,
      sourceHandle,
      targetId,
      targetHandle,
    }];
  });

  const rootId = stringValue(graph.rootId) ?? stringValue(graph.root_id) ?? null;
  const inferredRootId = inferFlowExpressionRootId(nodes, edges, rootId);
  const layoutRecord = recordValue(graph.layout);
  const layoutNodesRecord = recordValue(layoutRecord?.nodes);
  const layoutNodes = layoutNodesRecord
    ? Object.entries(layoutNodesRecord).reduce<NonNullable<FlowExpressionGraphLayout["nodes"]>>(
      (current, [nodeId, rawPosition]) => {
        if (!nodeIds.has(nodeId)) {
          return current;
        }
        const position = recordValue(rawPosition);
        const x = numberValue(position?.x);
        const y = numberValue(position?.y);
        if (x === undefined || y === undefined) {
          return current;
        }
        current[nodeId] = { x, y };
        return current;
      },
      {},
    )
    : undefined;

  return {
    version: typeof graph.version === "number" ? graph.version : 1,
    rootId: inferredRootId,
    nodes,
    edges,
    ...(layoutNodes && Object.keys(layoutNodes).length ? { layout: { nodes: layoutNodes } } : {}),
  };
}

export function flowExpressionNodeDisplayLabel(node: FlowExpressionNode): string {
  const payloadName = stringValue(node.payload.name);
  const payloadOperator = stringValue(node.payload.operator);
  const payloadValue = node.payload.value;
  return (
    payloadName
    ?? payloadOperator
    ?? (typeof payloadValue === "string" || typeof payloadValue === "number" || typeof payloadValue === "boolean"
      ? String(payloadValue)
      : undefined)
    ?? node.label
    ?? node.kind
  );
}

export interface FlowExpressionGraphSourceResult {
  diagnostics: string[];
  expression: string;
}

interface CompiledExpressionNode {
  precedence: number;
  source: string;
}

const ATOM_PRECEDENCE = 100;
const CALL_PRECEDENCE = 95;
const UNARY_PRECEDENCE = 80;
const POWER_PRECEDENCE = 90;
const FACTOR_PRECEDENCE = 70;
const TERM_PRECEDENCE = 60;
const COMPARE_PRECEDENCE = 50;
const BOOL_AND_PRECEDENCE = 40;
const BOOL_OR_PRECEDENCE = 30;
const CONDITIONAL_PRECEDENCE = 20;

const BINARY_OPERATOR_PRECEDENCE: Record<string, number> = {
  "**": POWER_PRECEDENCE,
  "*": FACTOR_PRECEDENCE,
  "/": FACTOR_PRECEDENCE,
  "//": FACTOR_PRECEDENCE,
  "%": FACTOR_PRECEDENCE,
  "+": TERM_PRECEDENCE,
  "-": TERM_PRECEDENCE,
};

function expressionNodeSourceValue(node: FlowExpressionNode) {
  const expression = stringValue(node.payload.expression);
  if (expression?.trim()) {
    return expression.trim();
  }
  const name = stringValue(node.payload.name);
  if (name?.trim()) {
    return name.trim();
  }
  const value = node.payload.value;
  if (
    typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  return node.label.trim();
}

function expressionNodeOperator(node: FlowExpressionNode) {
  return stringValue(node.payload.operator)?.trim() || node.label.trim();
}

function incomingExpressionEdgesByTarget(graph: FlowExpressionGraph) {
  const incoming = new Map<string, FlowExpressionEdge[]>();
  graph.edges.forEach((edge) => {
    incoming.set(edge.targetId, [...(incoming.get(edge.targetId) ?? []), edge]);
  });
  return incoming;
}

function sortedIndexedEdges(
  edges: FlowExpressionEdge[],
  prefix: string,
): FlowExpressionEdge[] {
  return edges
    .filter((edge) => edge.targetHandle.startsWith(prefix))
    .slice()
    .sort((left, right) => {
      const leftIndex = Number.parseInt(left.targetHandle.slice(prefix.length).split(":", 1)[0] ?? "", 10);
      const rightIndex = Number.parseInt(right.targetHandle.slice(prefix.length).split(":", 1)[0] ?? "", 10);
      if (Number.isNaN(leftIndex) || Number.isNaN(rightIndex)) {
        return left.targetHandle.localeCompare(right.targetHandle);
      }
      return leftIndex - rightIndex;
    });
}

function childSource(
  child: CompiledExpressionNode,
  parentPrecedence: number,
  options: { force?: boolean; rightAssociative?: boolean } = {},
) {
  if (options.force || child.precedence < parentPrecedence) {
    return `(${child.source})`;
  }
  if (options.rightAssociative && child.precedence === parentPrecedence) {
    return `(${child.source})`;
  }
  return child.source;
}

function uniqueExpressionEdgeId(
  sourceId: string,
  targetId: string,
  targetHandle: string,
) {
  return `expr-edge:${sourceId}->${targetId}:${targetHandle}`;
}

export function expressionFromFlowExpressionGraph(
  graph: FlowExpressionGraph,
): FlowExpressionGraphSourceResult {
  const normalized = normalizeFlowExpressionGraph(graph);
  if (!normalized) {
    return {
      diagnostics: ["Expression graph is not valid."],
      expression: "",
    };
  }
  if (!normalized.rootId) {
    return {
      diagnostics: ["Expression graph needs a root node."],
      expression: "",
    };
  }

  const nodesById = new Map(normalized.nodes.map((node) => [node.id, node]));
  const incomingByTarget = incomingExpressionEdgesByTarget(normalized);
  const visiting = new Set<string>();
  const diagnostics: string[] = [];

  function compile(nodeId: string): CompiledExpressionNode {
    if (visiting.has(nodeId)) {
      diagnostics.push(`Expression graph has a cycle at ${nodeId}.`);
      return { precedence: ATOM_PRECEDENCE, source: "..." };
    }

    const node = nodesById.get(nodeId);
    if (!node) {
      diagnostics.push(`Expression graph references missing node ${nodeId}.`);
      return { precedence: ATOM_PRECEDENCE, source: "..." };
    }
    const currentNode = node;

    visiting.add(nodeId);
    const incomingEdges = incomingByTarget.get(nodeId) ?? [];

    function singleChild(handle: string): CompiledExpressionNode {
      const candidates = incomingEdges.filter((edge) => edge.targetHandle === handle);
      if (candidates.length !== 1) {
        diagnostics.push(`${flowExpressionNodeDisplayLabel(currentNode)} needs one ${handle} input.`);
        return { precedence: ATOM_PRECEDENCE, source: "..." };
      }
      return compile(candidates[0]!.sourceId);
    }

    function indexedChildren(prefix: string) {
      return sortedIndexedEdges(incomingEdges, prefix).map((edge) => compile(edge.sourceId));
    }

    try {
      if (node.kind === "input") {
        const name = stringValue(node.payload.name) ?? node.label;
        if (!name.trim()) {
          diagnostics.push(`Input node ${node.id} needs a name.`);
          return { precedence: ATOM_PRECEDENCE, source: "..." };
        }
        return { precedence: ATOM_PRECEDENCE, source: name.trim() };
      }

      if (node.kind === "literal" || node.kind === "raw") {
        const source = expressionNodeSourceValue(node);
        if (!source.trim()) {
          diagnostics.push(`${node.kind} node ${node.id} needs expression text.`);
          return { precedence: ATOM_PRECEDENCE, source: "..." };
        }
        return { precedence: ATOM_PRECEDENCE, source };
      }

      if (node.kind === "operator") {
        const operator = expressionNodeOperator(node);
        const precedence = BINARY_OPERATOR_PRECEDENCE[operator];
        if (!precedence) {
          diagnostics.push(`Operator node ${node.id} has an unsupported operator.`);
          return { precedence: ATOM_PRECEDENCE, source: "..." };
        }
        const left = singleChild("left");
        const right = singleChild("right");
        return {
          precedence,
          source: `${childSource(left, precedence)} ${operator} ${childSource(right, precedence, {
            rightAssociative: operator !== "**",
          })}`,
        };
      }

      if (node.kind === "unary") {
        const operator = expressionNodeOperator(node);
        const operand = singleChild("operand");
        return {
          precedence: UNARY_PRECEDENCE,
          source: `${operator} ${childSource(operand, UNARY_PRECEDENCE)}`,
        };
      }

      if (node.kind === "bool") {
        const operator = expressionNodeOperator(node);
        const precedence = operator === "and" ? BOOL_AND_PRECEDENCE : BOOL_OR_PRECEDENCE;
        const values = indexedChildren("value:");
        if (values.length < 2) {
          diagnostics.push(`Boolean node ${node.id} needs at least two values.`);
        }
        return {
          precedence,
          source: values.map((value) => childSource(value, precedence)).join(` ${operator} `) || "...",
        };
      }

      if (node.kind === "compare") {
        const left = singleChild("left");
        const operators = Array.isArray(node.payload.operators)
          ? node.payload.operators.map(String)
          : [expressionNodeOperator(node)];
        const comparators = indexedChildren("comparator:");
        if (operators.length !== comparators.length) {
          diagnostics.push(`Compare node ${node.id} has mismatched operators and comparators.`);
        }
        const parts = [childSource(left, COMPARE_PRECEDENCE)];
        comparators.forEach((comparator, index) => {
          parts.push(operators[index] ?? "==", childSource(comparator, COMPARE_PRECEDENCE));
        });
        return { precedence: COMPARE_PRECEDENCE, source: parts.join(" ") };
      }

      if (node.kind === "call") {
        const functionSource = childSource(singleChild("function"), CALL_PRECEDENCE);
        const args = indexedChildren("arg:").map((argument) => argument.source);
        const kwargs = incomingEdges
          .filter((edge) => edge.targetHandle.startsWith("kwarg:"))
          .slice()
          .sort((left, right) => left.targetHandle.localeCompare(right.targetHandle))
          .map((edge) => {
            const value = compile(edge.sourceId).source;
            const keyword = edge.targetHandle.split(":", 3)[2];
            return keyword && keyword !== "**" ? `${keyword}=${value}` : `**${value}`;
          });
        return {
          precedence: CALL_PRECEDENCE,
          source: `${functionSource}(${[...args, ...kwargs].join(", ")})`,
        };
      }

      if (node.kind === "attribute") {
        const attr = stringValue(node.payload.attr) ?? node.label.replace(/^\./, "");
        return {
          precedence: CALL_PRECEDENCE,
          source: `${childSource(singleChild("value"), CALL_PRECEDENCE)}.${attr}`,
        };
      }

      if (node.kind === "subscript") {
        return {
          precedence: CALL_PRECEDENCE,
          source: `${childSource(singleChild("value"), CALL_PRECEDENCE)}[${singleChild("slice").source}]`,
        };
      }

      if (node.kind === "conditional") {
        const body = singleChild("body");
        const test = singleChild("test");
        const orelse = singleChild("orelse");
        return {
          precedence: CONDITIONAL_PRECEDENCE,
          source: `${childSource(body, CONDITIONAL_PRECEDENCE)} if ${test.source} else ${childSource(orelse, CONDITIONAL_PRECEDENCE)}`,
        };
      }

      if (node.kind === "collection") {
        const collectionType = stringValue(node.payload.collection_type)
          ?? stringValue(node.payload.collectionType)
          ?? node.label;
        if (collectionType === "dict") {
          const keyEdges = sortedIndexedEdges(incomingEdges, "key:");
          const valueEdges = sortedIndexedEdges(incomingEdges, "value:");
          const pairs = valueEdges.map((valueEdge, index) => {
            const keyEdge = keyEdges[index];
            const key = keyEdge ? compile(keyEdge.sourceId).source : "...";
            return `${key}: ${compile(valueEdge.sourceId).source}`;
          });
          return { precedence: ATOM_PRECEDENCE, source: `{${pairs.join(", ")}}` };
        }
        const items = indexedChildren("item:").map((item) => item.source);
        if (collectionType === "tuple") {
          return { precedence: ATOM_PRECEDENCE, source: `(${items.join(", ")}${items.length === 1 ? "," : ""})` };
        }
        if (collectionType === "set") {
          return { precedence: ATOM_PRECEDENCE, source: `{${items.join(", ")}}` };
        }
        return { precedence: ATOM_PRECEDENCE, source: `[${items.join(", ")}]` };
      }

      diagnostics.push(`Expression node ${node.id} has an unsupported kind.`);
      return { precedence: ATOM_PRECEDENCE, source: "..." };
    } finally {
      visiting.delete(nodeId);
    }
  }

  const expression = compile(normalized.rootId).source;
  return {
    diagnostics: [...new Set(diagnostics)],
    expression: diagnostics.length ? "" : expression,
  };
}

export function createFlowExpressionEdge(
  sourceId: string,
  targetId: string,
  targetHandle: string,
): FlowExpressionEdge {
  return {
    id: uniqueExpressionEdgeId(sourceId, targetId, targetHandle),
    sourceId,
    sourceHandle: "value",
    targetId,
    targetHandle,
  };
}
