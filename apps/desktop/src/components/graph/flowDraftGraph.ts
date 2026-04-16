import type {
  FlowGraphDocument,
  FlowGraphEdge,
  FlowGraphNode,
  FlowInputBinding,
  FlowInputDisplayMode,
  FlowInputSlot,
  FlowFunctionInput,
  FlowSyncState,
  FlowVisualNodeKind,
  GraphEdgeDto,
  GraphNodeDto,
  GraphNodeKind,
  GraphView,
} from "../../lib/adapter";
import { cloneFlowDocument, flowInputBindingId, isFlowDocumentNodeKind } from "./flowDocument";

export function establishFlowDraftDocument(graph: GraphView | undefined): FlowGraphDocument | undefined {
  if (!graph || graph.level !== "flow") {
    return undefined;
  }

  if (graph.flowState?.document && graph.flowState.editable && graph.flowState.document.editable) {
    return withLegacyInputModelFromBaseGraph(graph, cloneFlowDocument(graph.flowState.document));
  }

  if (graph.flowState && graph.flowState.editable === false) {
    return undefined;
  }

  // Visual flow views may include support nodes like `param` plus data edges. We only
  // synthesize a draft from control-only graphs that already match the persisted
  // authored-flow schema.
  return flowDocumentFromVisualGraph(graph);
}

export function projectFlowDraftGraph(
  baseGraph: GraphView,
  document: FlowGraphDocument,
  inputDisplayMode: FlowInputDisplayMode = "param_nodes",
): GraphView {
  document = withLegacyInputModelFromBaseGraph(baseGraph, document);
  const functionInputs = document.functionInputs ?? [];
  const inputSlots = document.inputSlots ?? [];
  const inputBindings = document.inputBindings ?? [];
  const logicalNodeIds = new Set(document.nodes.map((node) => node.id));
  const functionInputParamNodeIds = new Set(functionInputs.map((input) => functionInputParamNodeId(document.symbolId, input)));
  const preservedNodes = baseGraph.nodes.filter((node) => (
    !logicalNodeIds.has(node.id)
    && !isFlowDocumentNodeKind(node.kind)
    && !functionInputParamNodeIds.has(node.id)
  ));
  const baseNodesById = new Map(baseGraph.nodes.map((node) => [node.id, node] as const));
  const draftNodes = document.nodes.map((node, index) => (
    graphNodeForFlowDraft(
      node,
      index,
      document.qualname,
      document,
      baseNodesById.get(node.id)
        ?? (node.indexedNodeId ? baseNodesById.get(node.indexedNodeId) : undefined),
    )
  ));
  const entryNodeId = document.nodes.find((node) => node.kind === "entry")?.id;
  const projectedDraftNodes = inputDisplayMode === "entry"
    ? draftNodes.map((node) => (
        node.id === entryNodeId
          ? withEntryFunctionInputMetadata(node, functionInputs)
          : node
      ))
    : draftNodes.map((node) => (node.id === entryNodeId ? withoutEntryFunctionInputMetadata(node) : node));
  const inputSourceNodes = inputDisplayMode === "param_nodes"
    ? functionInputs.map((input) => graphNodeForFunctionInput(document.symbolId, input, entryNodeId, baseNodesById.get(functionInputParamNodeId(document.symbolId, input))))
    : [];
  const projectedNodeIds = new Map<string, string>();
  document.nodes.forEach((node) => {
    projectedNodeIds.set(node.id, node.id);
    if (node.indexedNodeId) {
      projectedNodeIds.set(node.indexedNodeId, node.id);
    }
  });
  const visibleNodeIds = new Set([
    ...preservedNodes.map((node) => node.id),
    ...inputSourceNodes.map((node) => node.id),
    ...projectedDraftNodes.map((node) => node.id),
  ]);
  const preservedEdges = baseGraph.edges.flatMap((edge) => {
    if (edge.kind === "controls") {
      return [];
    }
    if (isFunctionInputBindingEdge(edge) || functionInputParamNodeIds.has(edge.source)) {
      return [];
    }
    const source = projectedNodeIds.get(edge.source) ?? edge.source;
    const target = projectedNodeIds.get(edge.target) ?? edge.target;
    if (!visibleNodeIds.has(source) || !visibleNodeIds.has(target)) {
      return [];
    }
    return [{ ...edge, source, target }];
  });
  const baseEdgesById = new Map(baseGraph.edges.map((edge) => [edge.id, edge] as const));
  const draftEdges = document.edges.map((edge) => graphEdgeForFlowDraft(edge, baseEdgesById.get(edge.id)));
  const inputBindingEdges = inputBindings.flatMap((binding) =>
    graphEdgeForInputBinding(document, binding, inputDisplayMode, entryNodeId),
  );

  return {
    ...baseGraph,
    rootNodeId: visibleNodeIds.has(projectedNodeIds.get(baseGraph.rootNodeId) ?? baseGraph.rootNodeId)
      ? (projectedNodeIds.get(baseGraph.rootNodeId) ?? baseGraph.rootNodeId)
      : document.nodes[0]?.id ?? baseGraph.rootNodeId,
    nodes: [...preservedNodes, ...inputSourceNodes, ...projectedDraftNodes],
    edges: [...preservedEdges, ...inputBindingEdges, ...draftEdges],
    flowState: {
      editable: document.editable,
      syncState: document.syncState,
      diagnostics: [...document.diagnostics],
      document: cloneFlowDocument(document),
    },
  };
}

function flowDocumentFromVisualGraph(graph: GraphView): FlowGraphDocument | undefined {
  const symbolId = graph.targetId.startsWith("symbol:") ? graph.targetId : undefined;
  const relativePath = graph.breadcrumbs.find((breadcrumb) => breadcrumb.level === "module")?.subtitle;
  const qualname =
    graph.breadcrumbs.find((breadcrumb) => breadcrumb.level === "symbol")?.subtitle
    ?? graph.breadcrumbs.find((breadcrumb) => breadcrumb.level === "flow")?.subtitle
    ?? graph.focus?.subtitle;
  if (!symbolId || typeof relativePath !== "string" || !relativePath.trim() || typeof qualname !== "string" || !qualname.trim()) {
    return undefined;
  }

  const nodes: FlowGraphNode[] = [];
  for (const graphNode of graph.nodes) {
    const kind = toFlowVisualNodeKind(graphNode.kind);
    if (!kind) {
      return undefined;
    }

    nodes.push({
      id: graphNode.id,
      kind,
      payload: payloadFromGraphNode(graphNode, kind),
      indexedNodeId:
        readNodeMetadataString(graphNode, "indexed_node_id")
        ?? readNodeMetadataString(graphNode, "indexedNodeId")
        ?? (graphNode.id.startsWith("flow:") ? graphNode.id : null),
    });
  }

  const edges: FlowGraphEdge[] = [];
  for (const graphEdge of graph.edges) {
    if (graphEdge.kind !== "controls") {
      return undefined;
    }

    const handles = readFlowGraphHandles(graphEdge);
    if (!handles) {
      return undefined;
    }

    edges.push({
      id: graphEdge.id,
      sourceId: graphEdge.source,
      sourceHandle: handles.sourceHandle,
      targetId: graphEdge.target,
      targetHandle: handles.targetHandle,
    });
  }

  return {
    symbolId,
    relativePath,
    qualname,
    nodes,
    edges,
    functionInputs: [],
    inputSlots: [],
    inputBindings: [],
    syncState: (graph.flowState?.syncState ?? "clean") as FlowSyncState,
    diagnostics: [...(graph.flowState?.diagnostics ?? [])],
    sourceHash: graph.flowState?.document?.sourceHash ?? null,
    editable: graph.flowState?.editable ?? true,
  };
}

function withLegacyInputModelFromBaseGraph(
  baseGraph: GraphView,
  document: FlowGraphDocument,
): FlowGraphDocument {
  const paramNodes = functionInputParamNodesFromBaseGraph(baseGraph);
  const functionInputs = functionInputsFromParamNodes(paramNodes, document);
  if ((document.inputSlots ?? []).length > 0) {
    return (document.functionInputs ?? []).length > 0 || !functionInputs.length
      ? document
      : { ...document, functionInputs };
  }
  if (!functionInputs.length) {
    return document;
  }

  const functionInputByParamNodeId = new Map(
    paramNodes.map((node, index) => [node.id, functionInputs[index]] as const),
  );
  const documentNodeByIdentity = new Map<string, FlowGraphNode>();
  document.nodes.forEach((node) => {
    documentNodeByIdentity.set(flowGraphNodeSourceIdentity(node), node);
    documentNodeByIdentity.set(node.id, node);
  });

  const inputSlots: FlowInputSlot[] = [];
  const inputBindings: FlowInputBinding[] = [];
  const seenSlotIds = new Set<string>();
  const seenBoundSlotIds = new Set<string>();
  baseGraph.edges.forEach((edge) => {
    if (edge.kind !== "data") {
      return;
    }
    const functionInput = functionInputByParamNodeId.get(edge.source);
    if (!functionInput) {
      return;
    }
    const targetNode = documentNodeByIdentity.get(edge.target);
    if (!targetNode) {
      return;
    }
    const slotKey = inputSlotKeyFromEdge(edge, functionInput.name);
    const slotId = flowInputSlotId(flowGraphNodeSourceIdentity(targetNode), slotKey);
    if (seenSlotIds.has(slotId)) {
      return;
    }
    seenSlotIds.add(slotId);
    inputSlots.push({
      id: slotId,
      nodeId: targetNode.id,
      slotKey,
      label: slotKey,
      required: true,
    });
    if (seenBoundSlotIds.has(slotId)) {
      return;
    }
    seenBoundSlotIds.add(slotId);
    inputBindings.push({
      id: flowInputBindingId(slotId, functionInput.id),
      functionInputId: functionInput.id,
      slotId,
    });
  });

  return {
    ...document,
    functionInputs,
    inputSlots,
    inputBindings,
  };
}

function functionInputParamNodesFromBaseGraph(baseGraph: GraphView): GraphNodeDto[] {
  return baseGraph.nodes
    .filter((node) => node.kind === "param")
    .sort((left, right) => (
      (readNodeMetadataNumber(left, "signature_order") ?? Number.MAX_SAFE_INTEGER)
      - (readNodeMetadataNumber(right, "signature_order") ?? Number.MAX_SAFE_INTEGER)
      || left.label.localeCompare(right.label)
    ));
}

function functionInputsFromParamNodes(
  paramNodes: GraphNodeDto[],
  document: FlowGraphDocument,
): FlowFunctionInput[] {
  const existingInputByName = new Map((document.functionInputs ?? []).map((input) => [input.name, input] as const));
  return paramNodes
    .map((node, index) => {
      const existing = existingInputByName.get(node.label);
      return {
        id:
          existing?.id
          ?? readNodeMetadataString(node, "function_input_id")
          ?? readNodeMetadataString(node, "functionInputId")
          ?? `flowinput:${document.symbolId}:${node.label}`,
        name: node.label,
        index,
      };
    });
}

function inputSlotKeyFromEdge(edge: GraphEdgeDto, fallback: string): string {
  return (
    edge.label
    ?? readEdgeMetadataString(edge, "target_label")
    ?? readEdgeMetadataString(edge, "targetLabel")
    ?? readEdgeMetadataString(edge, "source_label")
    ?? readEdgeMetadataString(edge, "sourceLabel")
    ?? fallback
  ).trim() || fallback;
}

function flowInputSlotId(nodeSourceIdentity: string, slotKey: string): string {
  return `flowslot:${nodeSourceIdentity}:${slotKey}`;
}

function flowGraphNodeSourceIdentity(node: FlowGraphNode): string {
  return node.indexedNodeId || node.id;
}

function toFlowVisualNodeKind(kind: GraphNodeKind): FlowVisualNodeKind | undefined {
  return isFlowDocumentNodeKind(kind)
    ? kind
    : undefined;
}

export function functionInputSourceHandle(functionInputId: string): string {
  return `out:data:function-input:${functionInputId}`;
}

export function inputSlotTargetHandle(slotId: string): string {
  return `in:data:input-slot:${slotId}`;
}

export function parseFunctionInputSourceHandle(handleId: string | null | undefined): string | undefined {
  const prefix = "out:data:function-input:";
  return handleId?.startsWith(prefix) ? handleId.slice(prefix.length) : undefined;
}

export function parseInputSlotTargetHandle(handleId: string | null | undefined): string | undefined {
  const prefix = "in:data:input-slot:";
  return handleId?.startsWith(prefix) ? handleId.slice(prefix.length) : undefined;
}

export function flowInputBindingEdgeId(bindingId: string): string {
  return `data:${bindingId}`;
}

function functionInputParamNodeId(symbolId: string, input: FlowFunctionInput): string {
  return `flow:${symbolId}:param:${input.name}`;
}

function functionInputMetadata(input: FlowFunctionInput) {
  return {
    function_input_id: input.id,
    name: input.name,
    index: input.index,
    source_handle: functionInputSourceHandle(input.id),
  };
}

function withEntryFunctionInputMetadata(
  node: GraphNodeDto,
  functionInputs: FlowFunctionInput[],
): GraphNodeDto {
  return {
    ...node,
    metadata: {
      ...node.metadata,
      flow_function_inputs: functionInputs.map(functionInputMetadata),
    },
  };
}

function withoutEntryFunctionInputMetadata(node: GraphNodeDto): GraphNodeDto {
  const { flow_function_inputs: _flowFunctionInputs, ...metadata } = node.metadata;
  return { ...node, metadata };
}

function graphNodeForFunctionInput(
  symbolId: string,
  input: FlowFunctionInput,
  entryNodeId: string | undefined,
  existing: GraphNodeDto | undefined,
): GraphNodeDto {
  return {
    id: functionInputParamNodeId(symbolId, input),
    kind: "param",
    label: input.name,
    subtitle: "signature parameter",
    x: existing?.x ?? 80,
    y: existing?.y ?? -120 - input.index * 120,
    metadata: {
      ...(existing?.metadata ?? {}),
      ...functionInputMetadata(input),
      signature_owner_id: entryNodeId,
      signature_order: input.index,
      flow_visual: true,
    },
    availableActions: existing?.availableActions ?? [],
  };
}

function isFunctionInputBindingEdge(edge: GraphEdgeDto): boolean {
  return edge.kind === "data" && edge.metadata?.flow_input_binding === true;
}

function graphEdgeForInputBinding(
  document: FlowGraphDocument,
  binding: FlowInputBinding,
  inputDisplayMode: FlowInputDisplayMode,
  entryNodeId: string | undefined,
): GraphEdgeDto[] {
  const input = (document.functionInputs ?? []).find((candidate) => candidate.id === binding.functionInputId);
  const slot = (document.inputSlots ?? []).find((candidate) => candidate.id === binding.slotId);
  if (!input || !slot) {
    return [];
  }
  const source = inputDisplayMode === "entry"
    ? entryNodeId
    : functionInputParamNodeId(document.symbolId, input);
  if (!source) {
    return [];
  }
  return [{
    id: flowInputBindingEdgeId(binding.id),
    kind: "data",
    source,
    target: slot.nodeId,
    label: input.name,
    metadata: {
      flow_input_binding: true,
      binding_id: binding.id,
      function_input_id: input.id,
      slot_id: slot.id,
      source_label: input.name,
      target_label: slot.label,
      source_handle: functionInputSourceHandle(input.id),
      target_handle: inputSlotTargetHandle(slot.id),
    },
  }];
}

function payloadFromGraphNode(
  node: GraphNodeDto,
  kind: FlowVisualNodeKind,
): Record<string, unknown> {
  if (kind === "entry" || kind === "exit") {
    return {};
  }
  if (kind === "assign" || kind === "call") {
    return { source: node.label };
  }
  if (kind === "branch") {
    return { condition: node.label.replace(/^if\s+/i, "") };
  }
  if (kind === "loop") {
    return { header: node.label };
  }
  return { expression: node.label.replace(/^return\s+/i, "") };
}

function graphNodeForFlowDraft(
  node: FlowGraphNode,
  index: number,
  qualname: string,
  document: FlowGraphDocument,
  existing: GraphNodeDto | undefined,
): GraphNodeDto {
  const inputSlots = (document.inputSlots ?? [])
    .filter((slot) => slot.nodeId === node.id)
    .map((slot) => ({
      slot_id: slot.id,
      slot_key: slot.slotKey,
      label: slot.label,
      target_handle: inputSlotTargetHandle(slot.id),
    }));
  return {
    id: node.id,
    kind: node.kind as GraphNodeKind,
    label: flowDraftNodeLabel(node.kind, node.payload),
    subtitle: flowDraftNodeSubtitle(node.kind, node.payload, qualname),
    x: existing?.x ?? 260 + Math.max(1, index) * 220,
    y: existing?.y ?? (node.kind === "branch" || node.kind === "loop" ? 120 : 180),
    metadata: {
      ...(existing?.metadata ?? {}),
      flow_visual: true,
      flow_order: index,
      ...(node.indexedNodeId ? { indexed_node_id: node.indexedNodeId } : {}),
      ...(inputSlots.length ? { flow_input_slots: inputSlots } : {}),
    },
    availableActions: existing?.availableActions ?? [],
  };
}

function graphEdgeForFlowDraft(
  edge: FlowGraphEdge,
  existing: GraphEdgeDto | undefined,
): GraphEdgeDto {
  const pathLabel = flowDraftPathLabel(edge.sourceHandle);
  return {
    id: edge.id,
    kind: "controls",
    source: edge.sourceId,
    target: edge.targetId,
    ...(pathLabel ? { label: pathLabel } : {}),
    metadata: {
      ...(existing?.metadata ?? {}),
      source_handle: edge.sourceHandle,
      target_handle: edge.targetHandle,
      ...(pathLabel
        ? {
            path_key: pathLabel,
            path_label: pathLabel,
          }
        : {}),
    },
  };
}

function flowDraftNodeLabel(kind: FlowVisualNodeKind, payload: Record<string, unknown>) {
  if (kind === "entry") {
    return "Entry";
  }
  if (kind === "exit") {
    return "Exit";
  }
  if (kind === "assign" || kind === "call") {
    return typeof payload.source === "string" && payload.source.trim() ? payload.source.trim() : kind;
  }
  if (kind === "branch") {
    const condition = typeof payload.condition === "string" ? payload.condition.trim() : "";
    return condition ? `if ${condition}` : "if ...";
  }
  if (kind === "loop") {
    const header = typeof payload.header === "string" ? payload.header.trim() : "";
    return header || "loop";
  }
  const expression = typeof payload.expression === "string" ? payload.expression.trim() : "";
  return expression ? `return ${expression}` : "return";
}

function flowDraftNodeSubtitle(
  kind: FlowVisualNodeKind,
  payload: Record<string, unknown>,
  qualname: string,
) {
  if (kind === "entry") {
    return qualname;
  }
  if (kind === "exit") {
    return "terminal path";
  }
  if (kind === "assign") {
    return "assignment";
  }
  if (kind === "call") {
    return "call";
  }
  if (kind === "branch") {
    return "conditional branch";
  }
  if (kind === "loop") {
    return "loop";
  }
  return "return";
}

function flowDraftPathLabel(sourceHandle: string) {
  return sourceHandle === "start" || sourceHandle === "next" ? undefined : sourceHandle;
}

function readFlowGraphHandles(
  edge: GraphEdgeDto,
): { sourceHandle: string; targetHandle: string } | undefined {
  const sourceHandle =
    readEdgeMetadataString(edge, "source_handle")
    ?? readEdgeMetadataString(edge, "sourceHandle")
    ?? parseFlowEdgeId(edge.id)?.sourceHandle;
  const targetHandle =
    readEdgeMetadataString(edge, "target_handle")
    ?? readEdgeMetadataString(edge, "targetHandle")
    ?? parseFlowEdgeId(edge.id)?.targetHandle;
  if (!sourceHandle || !targetHandle) {
    return undefined;
  }
  return {
    sourceHandle,
    targetHandle,
  };
}

function readEdgeMetadataString(edge: GraphEdgeDto, key: string) {
  const value = edge.metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNodeMetadataString(node: GraphNodeDto, key: string) {
  const value = node.metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNodeMetadataNumber(node: GraphNodeDto, key: string) {
  const value = node.metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseFlowEdgeId(edgeId: string) {
  const match = /^controls:(.+):([^:]+)->(.+):([^:]+)$/.exec(edgeId);
  if (!match) {
    return undefined;
  }
  return {
    sourceId: match[1],
    sourceHandle: match[2],
    targetId: match[3],
    targetHandle: match[4],
  };
}
