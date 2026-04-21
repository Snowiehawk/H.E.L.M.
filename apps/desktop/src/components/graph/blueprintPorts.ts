import type {
  GraphEdgeDto,
  GraphNodeDto,
  GraphNodeKind,
  GraphView,
} from "../../lib/adapter";
import { flowControlPathLabel } from "./flowDocument";

export type BlueprintPortKind = "graph" | "control" | "data";

export interface BlueprintPort {
  id: string;
  label: string;
  kind: BlueprintPortKind;
  tooltip?: string;
  memberLabels?: string[];
  memberEdgeIds?: string[];
}

export interface BlueprintNodePorts {
  inputs: BlueprintPort[];
  outputs: BlueprintPort[];
}

export interface BlueprintEdgeHandles {
  sourceHandle?: string;
  targetHandle?: string;
}

export interface BlueprintPresentation {
  nodePorts: Map<string, BlueprintNodePorts>;
  edgeHandles: Map<string, BlueprintEdgeHandles>;
}

const FLOW_KINDS = new Set<GraphNodeKind>([
  "entry",
  "param",
  "assign",
  "call",
  "branch",
  "loop",
  "return",
  "exit",
]);

const FLOW_CONTROL_INPUT_KINDS = new Set<GraphNodeKind>([
  "assign",
  "call",
  "branch",
  "loop",
  "return",
  "exit",
]);

function normalizePortKey(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "port";
}

function mergePorts(ports: BlueprintPort[]): BlueprintPort[] {
  const merged = new Map<string, BlueprintPort>();

  ports.forEach((port) => {
    const existing = merged.get(port.id);
    if (!existing) {
      merged.set(port.id, {
        ...port,
        memberLabels: [...(port.memberLabels ?? [])],
        memberEdgeIds: [...(port.memberEdgeIds ?? [])],
      });
      return;
    }

    merged.set(port.id, {
      ...existing,
      tooltip: existing.tooltip ?? port.tooltip,
      memberLabels: [
        ...(existing.memberLabels ?? []),
        ...(port.memberLabels ?? []),
      ],
      memberEdgeIds: [
        ...(existing.memberEdgeIds ?? []),
        ...(port.memberEdgeIds ?? []),
      ],
    });
  });

  return Array.from(merged.values()).map((port) => ({
    ...port,
    memberLabels: port.memberLabels?.filter(
      (label, index, all) => all.indexOf(label) === index,
    ),
    memberEdgeIds: port.memberEdgeIds?.filter(
      (edgeId, index, all) => all.indexOf(edgeId) === index,
    ),
  }));
}

function graphPortLabel(kind: GraphEdgeDto["kind"]): string {
  if (kind === "imports") {
    return "imports";
  }
  if (kind === "defines") {
    return "defines";
  }
  if (kind === "calls") {
    return "calls";
  }
  if (kind === "contains") {
    return "contains";
  }
  if (kind === "controls") {
    return "exec";
  }
  return "data";
}

function dataPortLabel(edge: GraphEdgeDto, fallback: string): string {
  return edge.label?.trim() || fallback;
}

function edgeMetadataString(edge: GraphEdgeDto, key: string): string | undefined {
  const value =
    edge.metadata?.[key]
    ?? edge.metadata?.[key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())];
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function edgeMetadataNumber(edge: GraphEdgeDto, key: string): number | undefined {
  const value =
    edge.metadata?.[key]
    ?? edge.metadata?.[key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())];
  return typeof value === "number" ? value : undefined;
}

function controlPathSortKey(edge: GraphEdgeDto): [number, string, string] {
  const explicitOrder = edgeMetadataNumber(edge, "path_order");
  const label = edgeMetadataString(edge, "path_label") ?? edge.label?.trim() ?? "";
  return [explicitOrder ?? Number.MAX_SAFE_INTEGER, label.toLowerCase(), edge.id];
}

function resolveControlPortLabels(
  sourceNode: GraphNodeDto,
  controlEdges: GraphEdgeDto[],
): Map<string, string> {
  if (!controlEdges.length) {
    return new Map();
  }

  const ordered = controlEdges.slice().sort((left, right) => {
    const leftKey = controlPathSortKey(left);
    const rightKey = controlPathSortKey(right);
    return leftKey[0] - rightKey[0] || leftKey[1].localeCompare(rightKey[1]) || leftKey[2].localeCompare(rightKey[2]);
  });
  const labels = new Map<string, string>();
  const needsDistinctLabels = ordered.length > 1;

  ordered.forEach((edge, index) => {
    const explicitLabel =
      edgeMetadataString(edge, "path_label")
      ?? (sourceNode.metadata["flow_visual"] === true ? edgeMetadataString(edge, "source_handle") : undefined)
      ?? edge.label?.trim()
      ?? ((sourceNode.kind === "branch" || sourceNode.kind === "loop") ? undefined : undefined);
    const sourceHandle = flowControlSourceHandle(edge);
    const fallbackLabel = explicitLabel || (needsDistinctLabels ? `path ${index + 1}` : "exec");
    labels.set(edge.id, sourceHandle ? flowControlPathLabel(sourceNode.kind, sourceHandle) : fallbackLabel);
  });

  return labels;
}

function graphInputPortId(edgeKind: GraphEdgeDto["kind"]): string {
  return `in:graph:${edgeKind}`;
}

function graphOutputPortId(edgeKind: GraphEdgeDto["kind"]): string {
  return `out:graph:${edgeKind}`;
}

function controlInputPortId(): string {
  return "in:control:exec";
}

function controlOutputPortId(label: string): string {
  return `out:control:${normalizePortKey(label)}`;
}

function dataInputPortId(label: string): string {
  return `in:data:${normalizePortKey(label)}`;
}

function dataOutputPortId(label: string): string {
  return `out:data:${normalizePortKey(label)}`;
}

function nodeMetadataList(node: GraphNodeDto, key: string): Array<Record<string, unknown>> {
  const value =
    node.metadata[key]
    ?? node.metadata[key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())];
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function metadataStringFromRecord(value: Record<string, unknown>, key: string): string | undefined {
  const raw =
    value[key]
    ?? value[key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())];
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function entryArgumentPortLabel(argumentInput: Record<string, unknown>): string {
  const label = metadataStringFromRecord(argumentInput, "label");
  return label === "arguments" ? "args" : label ?? "args";
}

function entryArgumentPortTooltip(argumentInput: Record<string, unknown>): string | undefined {
  return metadataStringFromRecord(argumentInput, "full_label")
    ?? metadataStringFromRecord(argumentInput, "tooltip")
    ?? (metadataStringFromRecord(argumentInput, "label") === "arguments" ? "arguments" : undefined);
}

function nodeMetadataString(node: GraphNodeDto, key: string): string | undefined {
  const value =
    node.metadata[key]
    ?? node.metadata[key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function architecturePortMemberLabel(
  direction: "input" | "output",
  edge: GraphEdgeDto,
  nodeById: Map<string, GraphNodeDto>,
): string {
  const adjacentNodeId = direction === "input" ? edge.source : edge.target;
  const adjacentNode = nodeById.get(adjacentNodeId);
  const adjacentLabel = adjacentNode?.label ?? adjacentNodeId;
  const edgeLabel = edge.label?.trim();

  if (!edgeLabel) {
    return adjacentLabel;
  }

  return `${adjacentLabel} · ${edgeLabel}`;
}

function buildArchitecturePortList(
  direction: "input" | "output",
  edges: GraphEdgeDto[],
  nodeById: Map<string, GraphNodeDto>,
): BlueprintPort[] {
  const edgesByKind = new Map<GraphEdgeDto["kind"], GraphEdgeDto[]>();

  edges.forEach((edge) => {
    edgesByKind.set(edge.kind, [...(edgesByKind.get(edge.kind) ?? []), edge]);
  });

  return [...edgesByKind.entries()].map(([edgeKind, groupedEdges]) => ({
    id: direction === "input" ? graphInputPortId(edgeKind) : graphOutputPortId(edgeKind),
    label: graphPortLabel(edgeKind),
    kind: "graph" as const,
    memberLabels: groupedEdges.map((edge) =>
      architecturePortMemberLabel(direction, edge, nodeById),
    ),
    memberEdgeIds: groupedEdges.map((edge) => edge.id),
  }));
}

function buildArchitecturePorts(
  incoming: GraphEdgeDto[],
  outgoing: GraphEdgeDto[],
  nodeById: Map<string, GraphNodeDto>,
): BlueprintNodePorts {
  return {
    inputs: mergePorts(buildArchitecturePortList("input", incoming, nodeById)),
    outputs: mergePorts(buildArchitecturePortList("output", outgoing, nodeById)),
  };
}

function flowControlSourceHandle(edge: GraphEdgeDto): string | undefined {
  return edgeMetadataString(edge, "source_handle")
    ?? edgeMetadataString(edge, "path_key")
    ?? edge.label?.trim()
    ?? undefined;
}

function normalizeLegacyBranchAfterEdge(
  edge: GraphEdgeDto,
  nodeById: Map<string, GraphNodeDto>,
): GraphEdgeDto {
  const sourceNode = nodeById.get(edge.source);
  if (
    edge.kind !== "controls"
    || sourceNode?.kind !== "branch"
    || flowControlSourceHandle(edge) !== "after"
  ) {
    return edge;
  }

  return {
    ...edge,
    label: edge.label === "after" || !edge.label ? "false" : edge.label,
    metadata: {
      ...edge.metadata,
      source_handle: "false",
      path_key: "false",
      path_label: "false",
      path_order: edgeMetadataNumber(edge, "path_order") ?? 1,
    },
  };
}

function flowPortMemberLabel(
  direction: "input" | "output",
  edge: GraphEdgeDto,
  nodeById: Map<string, GraphNodeDto>,
) {
  const adjacentNodeId = direction === "input" ? edge.source : edge.target;
  const adjacentNode = nodeById.get(adjacentNodeId);
  const adjacentLabel = adjacentNode?.label ?? adjacentNodeId;
  const edgeLabel = edge.label?.trim();
  const displayEdgeLabel = direction === "output"
    ? (() => {
        const sourceNode = nodeById.get(edge.source);
        const sourceHandle = flowControlSourceHandle(edge);
        return sourceNode && sourceHandle
          ? flowControlPathLabel(sourceNode.kind, sourceHandle)
          : edgeLabel;
      })()
    : edgeLabel;

  if (!displayEdgeLabel || displayEdgeLabel === adjacentLabel) {
    return adjacentLabel;
  }

  return `${adjacentLabel} · ${displayEdgeLabel}`;
}

function buildFlowPorts(
  node: GraphNodeDto,
  incoming: GraphEdgeDto[],
  outgoing: GraphEdgeDto[],
  nodeById: Map<string, GraphNodeDto>,
  controlPortLabels: Map<string, string>,
): BlueprintNodePorts {
  const visualFlow = node.metadata["flow_visual"] === true;
  const inputs: BlueprintPort[] = [];
  const outputs: BlueprintPort[] = [];
  const incomingGraphEdges = incoming.filter((edge) => edge.kind !== "controls" && edge.kind !== "data");
  const outgoingGraphEdges = outgoing.filter((edge) => edge.kind !== "controls" && edge.kind !== "data");

  const incomingControlEdges = incoming.filter((edge) => edge.kind === "controls");
  if (FLOW_CONTROL_INPUT_KINDS.has(node.kind) && (incomingControlEdges.length || visualFlow)) {
    inputs.push(buildControlPort("input", "exec", incomingControlEdges, nodeById));
  }

  inputs.push(
    ...mergePorts(
      incoming
        .filter((edge) => edge.kind === "data")
        .map((edge) => {
          const label = edgeMetadataString(edge, "target_label") ?? dataPortLabel(edge, "value");
          return {
            id: edgeMetadataString(edge, "target_handle") ?? dataInputPortId(label),
            label,
            kind: "data" as const,
            tooltip: edgeMetadataString(edge, "target_full_label") ?? edgeMetadataString(edge, "target_tooltip"),
            memberLabels: [flowPortMemberLabel("input", edge, nodeById)],
            memberEdgeIds: [edge.id],
          };
      }),
    ),
  );
  inputs.push(
    ...nodeMetadataList(node, "flow_input_slots").map((slot) => {
      const label = metadataStringFromRecord(slot, "label") ?? "value";
      return {
        id: metadataStringFromRecord(slot, "target_handle") ?? dataInputPortId(label),
        label,
        kind: "data" as const,
      };
    }),
  );
  if (visualFlow && node.kind === "return") {
    inputs.push({
      id: nodeMetadataString(node, "flow_return_input_handle") ?? `in:data:return-input:${node.id}`,
      label: "input",
      kind: "data",
    });
  }
  if (node.kind === "entry") {
    inputs.push(
      ...nodeMetadataList(node, "flow_entry_arguments").map((argumentInput) => {
        const label = entryArgumentPortLabel(argumentInput);
        return {
          id: metadataStringFromRecord(argumentInput, "target_handle") ?? dataInputPortId(label),
          label,
          kind: "data" as const,
          tooltip: entryArgumentPortTooltip(argumentInput),
        };
      }),
    );
  }
  inputs.push(...buildArchitecturePortList("input", incomingGraphEdges, nodeById));

  const outgoingControlPortsFromEdges = mergePorts(
    outgoing
      .filter((edge) => edge.kind === "controls")
      .map((edge) => {
        const sourceHandle = flowControlSourceHandle(edge);
        const label = controlPortLabels.get(edge.id) ?? "exec";
        return {
          id: controlOutputPortId(sourceHandle ?? label),
          label,
          kind: "control" as const,
          memberLabels: [flowPortMemberLabel("output", edge, nodeById)],
          memberEdgeIds: [edge.id],
        };
      }),
  );
  const outgoingControlPorts = visualFlow
    ? mergePorts([
        ...outgoingControlPortsFromEdges,
        ...fixedFlowOutputHandles(node.kind).map((handle) => {
          const label = flowControlPathLabel(node.kind, handle);
          const existing = outgoing.filter((edge) =>
            edge.kind === "controls"
            && (flowControlSourceHandle(edge) ?? controlPortLabels.get(edge.id) ?? "exec") === handle,
          );
          return buildControlPort("output", label, existing, nodeById, handle);
        }),
      ])
    : outgoingControlPortsFromEdges;
  outputs.push(
    ...(node.kind === "entry" && !visualFlow && !outgoingControlPorts.length
      ? [{
          id: controlOutputPortId("exec"),
          label: "exec",
          kind: "control" as const,
        }]
      : outgoingControlPorts),
  );

  const outgoingDataPorts = mergePorts(
    outgoing
      .filter((edge) => edge.kind === "data")
      .map((edge) => {
        const label = edgeMetadataString(edge, "source_label") ?? dataPortLabel(edge, node.label);
        return {
          id: edgeMetadataString(edge, "source_handle") ?? dataOutputPortId(label),
          label,
          kind: "data" as const,
          memberLabels: [flowPortMemberLabel("output", edge, nodeById)],
          memberEdgeIds: [edge.id],
        };
      }),
  );
  outputs.push(...outgoingDataPorts);
  outputs.push(
    ...nodeMetadataList(node, "flow_value_sources").map((source) => {
      const label = metadataStringFromRecord(source, "label") ?? metadataStringFromRecord(source, "name") ?? "value";
      const sourceId = metadataStringFromRecord(source, "source_id");
      return {
        id: metadataStringFromRecord(source, "source_handle")
          ?? (sourceId ? `out:data:value-source:${sourceId}` : dataOutputPortId(label)),
        label,
        kind: "data" as const,
      };
    }),
  );

  if (node.kind === "param" && !outgoingDataPorts.length) {
    const functionInputId = nodeMetadataString(node, "function_input_id");
    outputs.push({
      id: nodeMetadataString(node, "source_handle")
        ?? (functionInputId ? `out:data:function-input:${functionInputId}` : dataOutputPortId(node.label)),
      label: node.label,
      kind: "data",
    });
  }

  if (node.kind === "entry") {
    outputs.push(
      ...nodeMetadataList(node, "flow_function_inputs").map((input) => {
        const label = metadataStringFromRecord(input, "name") ?? "value";
        return {
          id: metadataStringFromRecord(input, "source_handle") ?? dataOutputPortId(label),
          label,
          kind: "data" as const,
        };
      }),
    );
  }

  outputs.push(...buildArchitecturePortList("output", outgoingGraphEdges, nodeById));

  return {
    inputs: mergePorts(inputs),
    outputs: mergePorts(outputs),
  };
}

function resolveEdgeHandles(
  edge: GraphEdgeDto,
  controlPortLabels: Map<string, string>,
): BlueprintEdgeHandles {
  if (edge.kind === "controls") {
    const label =
      edgeMetadataString(edge, "source_handle")
      ?? controlPortLabels.get(edge.id)
      ?? "exec";
    return {
      sourceHandle: controlOutputPortId(label),
      targetHandle:
        edgeMetadataString(edge, "target_handle") === "in"
          ? controlInputPortId()
          : controlInputPortId(),
    };
  }

  if (edge.kind === "data") {
    const sourceLabel = edgeMetadataString(edge, "source_label") ?? dataPortLabel(edge, "value");
    const targetLabel = edgeMetadataString(edge, "target_label") ?? dataPortLabel(edge, "value");
    return {
      sourceHandle: edgeMetadataString(edge, "source_handle") ?? dataOutputPortId(sourceLabel),
      targetHandle: edgeMetadataString(edge, "target_handle") ?? dataInputPortId(targetLabel),
    };
  }

  return {
    sourceHandle: graphOutputPortId(edge.kind),
    targetHandle: graphInputPortId(edge.kind),
  };
}

export function buildBlueprintPresentation(graph: GraphView): BlueprintPresentation {
  const incomingByNodeId = new Map<string, GraphEdgeDto[]>();
  const outgoingByNodeId = new Map<string, GraphEdgeDto[]>();
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const edges = graph.edges.map((edge) => normalizeLegacyBranchAfterEdge(edge, nodeById));

  edges.forEach((edge) => {
    incomingByNodeId.set(edge.target, [...(incomingByNodeId.get(edge.target) ?? []), edge]);
    outgoingByNodeId.set(edge.source, [...(outgoingByNodeId.get(edge.source) ?? []), edge]);
  });

  const nodePorts = new Map<string, BlueprintNodePorts>();
  const controlPortLabelsByEdgeId = new Map<string, string>();
  graph.nodes.forEach((node) => {
    const incoming = incomingByNodeId.get(node.id) ?? [];
    const outgoing = outgoingByNodeId.get(node.id) ?? [];
    const controlPortLabels = resolveControlPortLabels(
      node,
      outgoing.filter((edge) => edge.kind === "controls"),
    );
    controlPortLabels.forEach((label, edgeId) => {
      controlPortLabelsByEdgeId.set(edgeId, label);
    });
    nodePorts.set(
      node.id,
      FLOW_KINDS.has(node.kind)
        ? buildFlowPorts(node, incoming, outgoing, nodeById, controlPortLabels)
        : buildArchitecturePorts(incoming, outgoing, nodeById),
    );
  });

  const edgeHandles = new Map<string, BlueprintEdgeHandles>();
  edges.forEach((edge) => {
    edgeHandles.set(edge.id, resolveEdgeHandles(edge, controlPortLabelsByEdgeId));
  });

  return { nodePorts, edgeHandles };
}

function fixedFlowOutputHandles(kind: GraphNodeKind): string[] {
  if (kind === "entry") {
    return ["start"];
  }
  if (kind === "assign" || kind === "call") {
    return ["next"];
  }
  if (kind === "branch") {
    return ["true", "false"];
  }
  if (kind === "loop") {
    return ["body", "after"];
  }
  if (kind === "return") {
    return ["exit"];
  }
  return [];
}

function buildControlPort(
  direction: "input" | "output",
  label: string,
  edges: GraphEdgeDto[],
  nodeById: Map<string, GraphNodeDto>,
  handle: string = label,
): BlueprintPort {
  return {
    id: direction === "input" ? controlInputPortId() : controlOutputPortId(handle),
    label,
    kind: "control",
    memberLabels: edges.map((edge) => flowPortMemberLabel(direction, edge, nodeById)),
    memberEdgeIds: edges.map((edge) => edge.id),
  };
}
