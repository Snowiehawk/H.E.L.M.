import type {
  FlowFunctionInput,
  FlowGraphDocument,
  FlowSyncState,
  FlowVisualNodeKind,
  GraphView,
  RepoSession,
  SymbolDetails,
} from "../../adapter/contracts";
import { normalizeFlowLoopPayload } from "../../../components/graph/flowDocument";
import type { MockWorkspaceState } from "./state";
import {
  edge,
  graphSummaryToPayloadSymbolId,
  node,
  sourceSpanMetadataForTargetId,
  symbolId,
} from "./ids";

export function cloneFlowDocument(document: FlowGraphDocument): FlowGraphDocument {
  return {
    ...document,
    diagnostics: [...document.diagnostics],
    nodes: document.nodes.map((node) => ({
      ...node,
      payload: { ...node.payload },
    })),
    edges: document.edges.map((edge) => ({ ...edge })),
    valueModelVersion: document.valueModelVersion ?? null,
    functionInputs: (document.functionInputs ?? []).map((input) => ({ ...input })),
    valueSources: (document.valueSources ?? []).map((source) => ({ ...source })),
    inputSlots: (document.inputSlots ?? []).map((slot) => ({ ...slot })),
    inputBindings: (document.inputBindings ?? []).map((binding) => ({ ...binding })),
  };
}

function mockFunctionInputId(symbolIdValue: string, name: string) {
  return `flowinput:${symbolIdValue}:${name}`;
}

function mockInputSlotId(nodeId: string, slotKey: string) {
  return `flowslot:${nodeId}:${slotKey}`;
}

function mockInputBindingId(slotId: string, sourceId: string) {
  return `flowbinding:${slotId}->${sourceId}`;
}

function mockInputModel(
  symbolIdValue: string,
  inputNames: string[],
  slots: Array<{ nodeId: string; slotKey: string; inputName?: string }>,
): Pick<FlowGraphDocument, "functionInputs" | "inputSlots" | "inputBindings"> {
  const functionInputs = inputNames.map((name, index) => ({
    id: mockFunctionInputId(symbolIdValue, name),
    name,
    index,
  }));
  const inputSlots = slots.map((slot) => ({
    id: mockInputSlotId(slot.nodeId, slot.slotKey),
    nodeId: slot.nodeId,
    slotKey: slot.slotKey,
    label: slot.slotKey,
    required: true,
  }));
  const inputBindings = slots.flatMap((slot) => {
    const functionInputId = mockFunctionInputId(symbolIdValue, slot.inputName ?? slot.slotKey);
    const slotId = mockInputSlotId(slot.nodeId, slot.slotKey);
    return functionInputs.some((input) => input.id === functionInputId)
      ? [
          {
            id: mockInputBindingId(slotId, functionInputId),
            sourceId: functionInputId,
            functionInputId,
            slotId,
          },
        ]
      : [];
  });
  return { functionInputs, inputSlots, inputBindings };
}

function flowDocumentEdge(
  sourceId: string,
  sourceHandle: string,
  targetId: string,
  targetHandle = "in",
) {
  return {
    id: `controls:${sourceId}:${sourceHandle}->${targetId}:${targetHandle}`,
    sourceId,
    sourceHandle,
    targetId,
    targetHandle,
  };
}

function defaultMockFlowDocument(
  state: MockWorkspaceState,
  symbol: SymbolDetails,
): FlowGraphDocument {
  const entryId = `flow:${symbol.nodeId}:entry`;
  const exitId = `flow:${symbol.nodeId}:exit`;
  if (symbol.nodeId === symbolId("helm.ui.api", state.primarySummarySymbolName)) {
    const assignId = `flow:${symbol.nodeId}:assign:modules`;
    const callId = `flow:${symbol.nodeId}:call:rank`;
    const returnId = `flow:${symbol.nodeId}:return`;
    const moduleSummariesSourceId = `flowsource:${assignId}:module_summaries`;
    const moduleSummariesSlotId = mockInputSlotId(callId, "module_summaries");
    const returnModuleSummariesSlotId = mockInputSlotId(returnId, "module_summaries");
    const inputModel = mockInputModel(
      symbol.nodeId,
      ["graph", "top_n"],
      [
        { nodeId: assignId, slotKey: "graph" },
        { nodeId: callId, slotKey: "top_n" },
      ],
    );
    return {
      symbolId: symbol.nodeId,
      relativePath: symbol.filePath,
      qualname: symbol.qualname,
      editable: true,
      syncState: "clean",
      diagnostics: [],
      sourceHash: null,
      valueModelVersion: 1,
      nodes: [
        { id: entryId, kind: "entry", payload: {}, indexedNodeId: entryId },
        {
          id: assignId,
          kind: "assign",
          payload: { source: "module_summaries = collect_module_stats(graph)" },
          indexedNodeId: assignId,
        },
        {
          id: callId,
          kind: "call",
          payload: { source: "sorted(module_summaries, key=score_module)[:top_n]" },
          indexedNodeId: callId,
        },
        {
          id: returnId,
          kind: "return",
          payload: { expression: "GraphSummary(module_summaries)" },
          indexedNodeId: returnId,
        },
        { id: exitId, kind: "exit", payload: {}, indexedNodeId: exitId },
      ],
      edges: [
        flowDocumentEdge(entryId, "start", assignId),
        flowDocumentEdge(assignId, "next", callId),
        flowDocumentEdge(callId, "next", returnId),
      ],
      ...inputModel,
      valueSources: [
        {
          id: moduleSummariesSourceId,
          nodeId: assignId,
          name: "module_summaries",
          label: "module_summaries",
        },
      ],
      inputSlots: [
        ...(inputModel.inputSlots ?? []),
        {
          id: moduleSummariesSlotId,
          nodeId: callId,
          slotKey: "module_summaries",
          label: "module_summaries",
          required: true,
        },
        {
          id: returnModuleSummariesSlotId,
          nodeId: returnId,
          slotKey: "module_summaries",
          label: "module_summaries",
          required: true,
        },
      ],
      inputBindings: [
        ...(inputModel.inputBindings ?? []),
        {
          id: mockInputBindingId(moduleSummariesSlotId, moduleSummariesSourceId),
          sourceId: moduleSummariesSourceId,
          slotId: moduleSummariesSlotId,
        },
        {
          id: mockInputBindingId(returnModuleSummariesSlotId, moduleSummariesSourceId),
          sourceId: moduleSummariesSourceId,
          slotId: returnModuleSummariesSlotId,
        },
      ],
    };
  }

  if (symbol.nodeId === graphSummaryToPayloadSymbolId()) {
    const returnId = `flow:${symbol.nodeId}:return`;
    return {
      symbolId: symbol.nodeId,
      relativePath: symbol.filePath,
      qualname: symbol.qualname,
      editable: true,
      syncState: "clean",
      diagnostics: [],
      sourceHash: null,
      valueModelVersion: 1,
      nodes: [
        { id: entryId, kind: "entry", payload: {}, indexedNodeId: entryId },
        {
          id: returnId,
          kind: "return",
          payload: { expression: "{'repo_path': self.repo_path}" },
          indexedNodeId: returnId,
        },
        { id: exitId, kind: "exit", payload: {}, indexedNodeId: exitId },
      ],
      edges: [flowDocumentEdge(entryId, "start", returnId)],
      ...mockInputModel(symbol.nodeId, ["self"], [{ nodeId: returnId, slotKey: "self" }]),
    };
  }

  const returnId = `flow:${symbol.nodeId}:return`;
  return {
    symbolId: symbol.nodeId,
    relativePath: symbol.filePath,
    qualname: symbol.qualname,
    editable: true,
    syncState: "clean",
    diagnostics: [],
    sourceHash: null,
    valueModelVersion: 1,
    nodes: [
      { id: entryId, kind: "entry", payload: {}, indexedNodeId: entryId },
      { id: returnId, kind: "return", payload: { expression: "" }, indexedNodeId: returnId },
      { id: exitId, kind: "exit", payload: {}, indexedNodeId: exitId },
    ],
    edges: [flowDocumentEdge(entryId, "start", returnId)],
    ...mockInputModel(symbol.nodeId, [], []),
  };
}

export function getMockFlowDocument(
  state: MockWorkspaceState,
  symbol: SymbolDetails,
): FlowGraphDocument {
  const existing = state.flowDocumentsBySymbolId[symbol.nodeId];
  if (existing) {
    return cloneFlowDocument(existing);
  }
  const created = defaultMockFlowDocument(state, symbol);
  state.flowDocumentsBySymbolId[symbol.nodeId] = cloneFlowDocument(created);
  return cloneFlowDocument(created);
}

function mockVisualFlowNodeLabel(kind: FlowVisualNodeKind, payload: Record<string, unknown>) {
  if (kind === "entry") {
    return "Entry";
  }
  if (kind === "exit") {
    return "Exit";
  }
  if (kind === "assign" || kind === "call") {
    const source = typeof payload.source === "string" ? payload.source.trim() : "";
    return source || kind;
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

function mockVisualFlowNodeSubtitle(
  kind: FlowVisualNodeKind,
  payload: Record<string, unknown>,
  symbol: SymbolDetails,
) {
  if (kind === "entry") {
    return symbol.qualname;
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

function mockVisualFlowNodePosition(nodeId: string, kind: FlowVisualNodeKind, index: number) {
  if (nodeId.endsWith(":entry")) {
    return { x: 0, y: 180 };
  }
  if (nodeId.includes(":assign:modules")) {
    return { x: 470, y: 80 };
  }
  if (nodeId.includes(":call:rank")) {
    return { x: 720, y: 80 };
  }
  if (nodeId.endsWith(":return")) {
    return { x: 970, y: 180 };
  }

  const column = Math.max(1, index);
  return {
    x: 260 + column * 220,
    y: kind === "branch" || kind === "loop" ? 120 : 180,
  };
}

export function validateMockFlowDocument(document: FlowGraphDocument): {
  syncState: FlowSyncState;
  diagnostics: string[];
} {
  const diagnostics: string[] = [];
  const incomingByTarget = new Map<string, number>();
  const outgoingBySource = new Map<string, string[]>();
  document.edges.forEach((edge) => {
    incomingByTarget.set(edge.targetId, (incomingByTarget.get(edge.targetId) ?? 0) + 1);
    outgoingBySource.set(edge.sourceId, [
      ...(outgoingBySource.get(edge.sourceId) ?? []),
      edge.sourceHandle,
    ]);
  });

  document.nodes.forEach((node) => {
    if (
      node.kind !== "entry" &&
      node.kind !== "exit" &&
      (incomingByTarget.get(node.id) ?? 0) === 0
    ) {
      diagnostics.push(`${node.id} is disconnected.`);
    }
    if (node.kind === "assign" || node.kind === "call") {
      const source = typeof node.payload.source === "string" ? node.payload.source.trim() : "";
      if (!source) {
        diagnostics.push(`${node.id} needs source code.`);
      }
    }
    if (node.kind === "branch") {
      const condition =
        typeof node.payload.condition === "string" ? node.payload.condition.trim() : "";
      if (!condition) {
        diagnostics.push(`${node.id} needs a condition.`);
      }
      if (!(outgoingBySource.get(node.id) ?? []).includes("true")) {
        diagnostics.push(`${node.id} needs a true branch.`);
      }
    }
    if (node.kind === "loop") {
      const loop = normalizeFlowLoopPayload(node.payload);
      if (loop.loopType === "for") {
        if (!loop.target) {
          diagnostics.push(`${node.id} needs an item target.`);
        }
        if (!loop.iterable) {
          diagnostics.push(`${node.id} needs an iterable.`);
        }
      } else if (!loop.condition) {
        diagnostics.push(`${node.id} needs a condition.`);
      }
      if (!loop.header) {
        diagnostics.push(`${node.id} needs a loop header.`);
      }
      if (!(outgoingBySource.get(node.id) ?? []).includes("body")) {
        diagnostics.push(`${node.id} needs a Repeat path.`);
      }
    }
  });
  const boundSlotIds = new Set((document.inputBindings ?? []).map((binding) => binding.slotId));
  (document.inputSlots ?? []).forEach((slot) => {
    if (slot.required && !boundSlotIds.has(slot.id)) {
      diagnostics.push(`${slot.id} needs a value binding.`);
    }
  });

  return {
    syncState: diagnostics.length ? "draft" : "clean",
    diagnostics,
  };
}

export function mockFlowDocumentSource(
  symbol: SymbolDetails,
  document: FlowGraphDocument,
): string | undefined {
  if (
    symbol.kind !== "function" &&
    symbol.kind !== "async_function" &&
    symbol.kind !== "method" &&
    symbol.kind !== "async_method"
  ) {
    return undefined;
  }

  const signaturePrefix =
    symbol.kind === "async_function" || symbol.kind === "async_method" ? "async def" : "def";
  const inputs = [...(document.functionInputs ?? [])]
    .sort((left, right) => left.index - right.index)
    .map((input) => {
      const prefix = input.kind === "vararg" ? "*" : input.kind === "kwarg" ? "**" : "";
      const defaultExpression = input.defaultExpression ? ` = ${input.defaultExpression}` : "";
      return `${prefix}${input.name}${defaultExpression}`;
    });
  const bodyLines = mockFlowDocumentBodyLines(document);
  const indentedBody = (bodyLines.length ? bodyLines : ["pass"])
    .map((line) => `    ${line}`)
    .join("\n");
  return `${signaturePrefix} ${symbol.name}(${inputs.join(", ")}):\n${indentedBody}`;
}

function mockFlowDocumentBodyLines(document: FlowGraphDocument): string[] {
  const nodeById = new Map(document.nodes.map((node) => [node.id, node] as const));
  const outputEdgeByHandle = new Map(
    document.edges.map((edge) => [`${edge.sourceId}\u0000${edge.sourceHandle}`, edge] as const),
  );
  const entryNode = document.nodes.find((node) => node.kind === "entry");
  const exitNode = document.nodes.find((node) => node.kind === "exit");

  const nextNodeId = (sourceId: string, handle: string) =>
    outputEdgeByHandle.get(`${sourceId}\u0000${handle}`)?.targetId;
  const indent = (lines: string[]) =>
    (lines.length ? lines : ["pass"]).map((line) => `    ${line}`);

  const compileFrom = (nodeId: string | undefined, visited = new Set<string>()): string[] => {
    if (!nodeId || nodeId === exitNode?.id || visited.has(nodeId)) {
      return [];
    }

    const node = nodeById.get(nodeId);
    if (!node) {
      return [];
    }

    const nextVisited = new Set(visited);
    nextVisited.add(nodeId);

    if (node.kind === "entry") {
      return compileFrom(nextNodeId(node.id, "start"), nextVisited);
    }

    if (node.kind === "assign" || node.kind === "call") {
      const source = typeof node.payload.source === "string" ? node.payload.source.trim() : "";
      return [
        ...(source ? source.split("\n") : []),
        ...compileFrom(nextNodeId(node.id, "next"), nextVisited),
      ];
    }

    if (node.kind === "return") {
      const expression =
        typeof node.payload.expression === "string" ? node.payload.expression.trim() : "";
      return [expression ? `return ${expression}` : "return"];
    }

    if (node.kind === "branch") {
      const condition =
        typeof node.payload.condition === "string" ? node.payload.condition.trim() : "condition";
      const trueLines = compileFrom(nextNodeId(node.id, "true"), nextVisited);
      const falseLines = compileFrom(nextNodeId(node.id, "false"), nextVisited);
      return [
        `if ${condition}:`,
        ...indent(trueLines),
        ...(falseLines.length ? ["else:", ...indent(falseLines)] : []),
      ];
    }

    if (node.kind === "loop") {
      const header = normalizeFlowLoopPayload(node.payload).header || "while condition";
      const normalizedHeader = header.endsWith(":") ? header : `${header}:`;
      return [
        normalizedHeader,
        ...indent(compileFrom(nextNodeId(node.id, "body"), nextVisited)),
        ...compileFrom(nextNodeId(node.id, "after"), nextVisited),
      ];
    }

    return [];
  };

  return compileFrom(entryNode?.id);
}

export function mockFlowDocumentFromFunctionSource(
  symbol: SymbolDetails,
  source: string,
): FlowGraphDocument | undefined {
  if (
    symbol.kind !== "function" &&
    symbol.kind !== "async_function" &&
    symbol.kind !== "method" &&
    symbol.kind !== "async_method"
  ) {
    return undefined;
  }

  const signatureMatch = source.match(/^\s*(?:async\s+)?def\s+\w+\(([^)]*)\)\s*(?:->\s*[^:]+)?:/m);
  if (!signatureMatch) {
    return undefined;
  }

  const entryId = `flow:${symbol.nodeId}:entry`;
  const exitId = `flow:${symbol.nodeId}:exit`;
  const functionInputs = mockFunctionInputsFromSignature(symbol.nodeId, signatureMatch[1] ?? "");
  const bodySource = source.slice((signatureMatch.index ?? 0) + signatureMatch[0].length);
  const bodyLines = bodySource
    .split("\n")
    .map((line) => line.replace(/^\s{4}/, "").trimEnd())
    .filter((line) => line.trim().length > 0 && !line.trimStart().startsWith("#"));
  const nodes: FlowGraphDocument["nodes"] = [
    { id: entryId, kind: "entry", payload: {}, indexedNodeId: entryId },
  ];
  const edges: FlowGraphDocument["edges"] = [];
  let previousNodeId = entryId;
  let previousHandle = "start";

  bodyLines.forEach((line, index) => {
    const trimmed = line.trim();
    const kind =
      trimmed.startsWith("return ") || trimmed === "return"
        ? "return"
        : /^[A-Za-z_][\w.]*\s*=/.test(trimmed)
          ? "assign"
          : "call";
    const nodeId = `flowdoc:${symbol.nodeId}:${kind}:${index}`;
    nodes.push({
      id: nodeId,
      kind,
      payload:
        kind === "return"
          ? { expression: trimmed.replace(/^return\b/, "").trim() }
          : { source: trimmed },
      indexedNodeId: `flow:${symbol.nodeId}:statement:${index}`,
    });
    edges.push(flowDocumentEdge(previousNodeId, previousHandle, nodeId));
    previousNodeId = nodeId;
    previousHandle = "next";
  });

  nodes.push({ id: exitId, kind: "exit", payload: {}, indexedNodeId: exitId });
  if (previousNodeId === entryId) {
    edges.push(flowDocumentEdge(entryId, "start", exitId));
  }

  return {
    symbolId: symbol.nodeId,
    relativePath: symbol.filePath,
    qualname: symbol.qualname,
    editable: true,
    syncState: "clean",
    diagnostics: [],
    sourceHash: null,
    valueModelVersion: 1,
    nodes,
    edges,
    functionInputs,
    valueSources: [],
    inputSlots: [],
    inputBindings: [],
  };
}

function mockFunctionInputsFromSignature(
  symbolId: string,
  parametersSource: string,
): FlowGraphDocument["functionInputs"] {
  return parametersSource
    .split(",")
    .map((parameter) => parameter.trim())
    .filter((parameter) => parameter && parameter !== "/" && parameter !== "*")
    .map((parameter, index) => {
      const [nameFragment, defaultExpression] = parameter.split("=", 2);
      const rawName = (nameFragment ?? "").split(":", 1)[0]?.trim() ?? "";
      const prefixlessName = rawName.replace(/^\*\*/, "").replace(/^\*/, "");
      const kind: NonNullable<FlowFunctionInput["kind"]> = rawName.startsWith("**")
        ? "kwarg"
        : rawName.startsWith("*")
          ? "vararg"
          : "positional_or_keyword";
      return {
        id: `flowinput:${symbolId}:${prefixlessName}`,
        name: prefixlessName,
        index,
        kind,
        defaultExpression: defaultExpression?.trim() || null,
      };
    })
    .filter((input) => input.name.length > 0);
}

export function _buildMockVisualFlowView(
  session: RepoSession,
  state: MockWorkspaceState,
  symbol: SymbolDetails,
): GraphView {
  const document = getMockFlowDocument(state, symbol);
  return {
    rootNodeId: document.nodes[0]?.id ?? `flow:${symbol.nodeId}:entry`,
    targetId: symbol.nodeId,
    level: "flow",
    truncated: false,
    breadcrumbs: [
      { nodeId: session.id, level: "repo", label: session.name, subtitle: "Architecture map" },
      {
        nodeId: `module:${symbol.moduleName}`,
        level: "module",
        label: symbol.moduleName,
        subtitle: symbol.filePath,
      },
      { nodeId: symbol.nodeId, level: "symbol", label: symbol.name, subtitle: symbol.qualname },
      { nodeId: `flow:${symbol.nodeId}`, level: "flow", label: "Flow", subtitle: symbol.qualname },
    ],
    focus: {
      targetId: symbol.nodeId,
      level: "flow",
      label: symbol.name,
      subtitle: "Visual flow graph",
      availableLevels: ["repo", "module", "symbol", "flow"],
    },
    nodes: document.nodes.map((flowNode, index) => {
      const position = mockVisualFlowNodePosition(flowNode.id, flowNode.kind, index);
      return node(
        flowNode.id,
        flowNode.kind === "exit" ? "exit" : flowNode.kind,
        mockVisualFlowNodeLabel(flowNode.kind, flowNode.payload),
        mockVisualFlowNodeSubtitle(flowNode.kind, flowNode.payload, symbol),
        position.x,
        position.y,
        {
          flow_visual: true,
          flow_order: index,
          ...(flowNode.indexedNodeId ? { indexed_node_id: flowNode.indexedNodeId } : {}),
          ...sourceSpanMetadataForTargetId(flowNode.id, state),
        },
      );
    }),
    edges: document.edges.map((flowEdge) =>
      edge(flowEdge.id, "controls", flowEdge.sourceId, flowEdge.targetId, flowEdge.sourceHandle, {
        source_handle: flowEdge.sourceHandle,
        target_handle: flowEdge.targetHandle,
        path_label: flowEdge.sourceHandle,
      }),
    ),
    flowState: {
      editable: true,
      syncState: document.syncState,
      diagnostics: [...document.diagnostics],
      document: cloneFlowDocument(document),
    },
  };
}

export function mockFlowNodeKindFromContent(
  content: string,
): "assign" | "call" | "return" | "branch" | "loop" {
  const normalized = content.trim();
  if (normalized.startsWith("if ")) {
    return "branch";
  }
  if (normalized.startsWith("for ") || normalized.startsWith("while ")) {
    return "loop";
  }
  if (normalized.startsWith("return")) {
    return "return";
  }
  if (normalized.includes("=")) {
    return "assign";
  }
  return "call";
}
