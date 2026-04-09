import type {
  GraphEdgeDto,
  GraphNodeDto,
  GraphNodeKind,
  GraphView,
} from "../../lib/adapter";

export type BlueprintPortKind = "graph" | "control" | "data";

export interface BlueprintPort {
  id: string;
  label: string;
  kind: BlueprintPortKind;
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

function controlPortLabel(edge: GraphEdgeDto, sourceNode: GraphNodeDto): string {
  if ((sourceNode.kind === "branch" || sourceNode.kind === "loop") && edge.label?.trim()) {
    return edge.label.trim();
  }
  return "exec";
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

function flowPortMemberLabel(
  direction: "input" | "output",
  edge: GraphEdgeDto,
  nodeById: Map<string, GraphNodeDto>,
) {
  const adjacentNodeId = direction === "input" ? edge.source : edge.target;
  const adjacentNode = nodeById.get(adjacentNodeId);
  const adjacentLabel = adjacentNode?.label ?? adjacentNodeId;
  const edgeLabel = edge.label?.trim();

  if (!edgeLabel || edgeLabel === adjacentLabel) {
    return adjacentLabel;
  }

  return `${adjacentLabel} · ${edgeLabel}`;
}

function buildFlowPorts(
  node: GraphNodeDto,
  incoming: GraphEdgeDto[],
  outgoing: GraphEdgeDto[],
  nodeById: Map<string, GraphNodeDto>,
): BlueprintNodePorts {
  const inputs: BlueprintPort[] = [];
  const outputs: BlueprintPort[] = [];

  const incomingControlEdges = incoming.filter((edge) => edge.kind === "controls");
  if (incomingControlEdges.length) {
    inputs.push({
      id: controlInputPortId(),
      label: "exec",
      kind: "control",
      memberLabels: incomingControlEdges.map((edge) =>
        flowPortMemberLabel("input", edge, nodeById),
      ),
      memberEdgeIds: incomingControlEdges.map((edge) => edge.id),
    });
  }

  inputs.push(
    ...mergePorts(
      incoming
        .filter((edge) => edge.kind === "data")
        .map((edge) => {
          const label = dataPortLabel(edge, "value");
          return {
            id: dataInputPortId(label),
            label,
            kind: "data" as const,
            memberLabels: [flowPortMemberLabel("input", edge, nodeById)],
            memberEdgeIds: [edge.id],
          };
        }),
    ),
  );

  const outgoingControlPorts = mergePorts(
    outgoing
      .filter((edge) => edge.kind === "controls")
      .map((edge) => {
        const label = controlPortLabel(edge, node);
        return {
          id: controlOutputPortId(label),
          label,
          kind: "control" as const,
          memberLabels: [flowPortMemberLabel("output", edge, nodeById)],
          memberEdgeIds: [edge.id],
        };
      }),
  );
  outputs.push(...outgoingControlPorts);

  const outgoingDataPorts = mergePorts(
    outgoing
      .filter((edge) => edge.kind === "data")
      .map((edge) => {
        const label = dataPortLabel(edge, node.label);
        return {
          id: dataOutputPortId(label),
          label,
          kind: "data" as const,
          memberLabels: [flowPortMemberLabel("output", edge, nodeById)],
          memberEdgeIds: [edge.id],
        };
      }),
  );
  outputs.push(...outgoingDataPorts);

  if (node.kind === "param" && !outgoingDataPorts.length) {
    outputs.push({
      id: dataOutputPortId(node.label),
      label: node.label,
      kind: "data",
    });
  }

  if (node.kind === "entry" && !outgoingControlPorts.length) {
    outputs.push({
      id: controlOutputPortId("exec"),
      label: "exec",
      kind: "control",
    });
  }

  return {
    inputs: mergePorts(inputs),
    outputs: mergePorts(outputs),
  };
}

function resolveEdgeHandles(
  edge: GraphEdgeDto,
  sourceNode: GraphNodeDto,
): BlueprintEdgeHandles {
  if (FLOW_KINDS.has(sourceNode.kind) || edge.kind === "controls" || edge.kind === "data") {
    if (edge.kind === "controls") {
      const label = controlPortLabel(edge, sourceNode);
      return {
        sourceHandle: controlOutputPortId(label),
        targetHandle: controlInputPortId(),
      };
    }

    const label = dataPortLabel(edge, "value");
    return {
      sourceHandle: dataOutputPortId(label),
      targetHandle: dataInputPortId(label),
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

  graph.edges.forEach((edge) => {
    incomingByNodeId.set(edge.target, [...(incomingByNodeId.get(edge.target) ?? []), edge]);
    outgoingByNodeId.set(edge.source, [...(outgoingByNodeId.get(edge.source) ?? []), edge]);
  });

  const nodePorts = new Map<string, BlueprintNodePorts>();
  graph.nodes.forEach((node) => {
    const incoming = incomingByNodeId.get(node.id) ?? [];
    const outgoing = outgoingByNodeId.get(node.id) ?? [];
    nodePorts.set(
      node.id,
      FLOW_KINDS.has(node.kind)
        ? buildFlowPorts(node, incoming, outgoing, nodeById)
        : buildArchitecturePorts(incoming, outgoing, nodeById),
    );
  });

  const edgeHandles = new Map<string, BlueprintEdgeHandles>();
  graph.edges.forEach((edge) => {
    const sourceNode = nodeById.get(edge.source);
    if (!sourceNode) {
      return;
    }
    edgeHandles.set(edge.id, resolveEdgeHandles(edge, sourceNode));
  });

  return { nodePorts, edgeHandles };
}
