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

function uniquePorts(ports: BlueprintPort[]): BlueprintPort[] {
  const seen = new Set<string>();
  return ports.filter((port) => {
    if (seen.has(port.id)) {
      return false;
    }
    seen.add(port.id);
    return true;
  });
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
  }));
}

function buildArchitecturePorts(
  incoming: GraphEdgeDto[],
  outgoing: GraphEdgeDto[],
  nodeById: Map<string, GraphNodeDto>,
): BlueprintNodePorts {
  return {
    inputs: uniquePorts(buildArchitecturePortList("input", incoming, nodeById)),
    outputs: uniquePorts(buildArchitecturePortList("output", outgoing, nodeById)),
  };
}

function buildFlowPorts(
  node: GraphNodeDto,
  incoming: GraphEdgeDto[],
  outgoing: GraphEdgeDto[],
): BlueprintNodePorts {
  const inputs: BlueprintPort[] = [];
  const outputs: BlueprintPort[] = [];

  if (incoming.some((edge) => edge.kind === "controls")) {
    inputs.push({
      id: controlInputPortId(),
      label: "exec",
      kind: "control",
    });
  }

  inputs.push(
    ...uniquePorts(
      incoming
        .filter((edge) => edge.kind === "data")
        .map((edge) => {
          const label = dataPortLabel(edge, "value");
          return {
            id: dataInputPortId(label),
            label,
            kind: "data" as const,
          };
        }),
    ),
  );

  const outgoingControlPorts = uniquePorts(
    outgoing
      .filter((edge) => edge.kind === "controls")
      .map((edge) => {
        const label = controlPortLabel(edge, node);
        return {
          id: controlOutputPortId(label),
          label,
          kind: "control" as const,
        };
      }),
  );
  outputs.push(...outgoingControlPorts);

  const outgoingDataPorts = uniquePorts(
    outgoing
      .filter((edge) => edge.kind === "data")
      .map((edge) => {
        const label = dataPortLabel(edge, node.label);
        return {
          id: dataOutputPortId(label),
          label,
          kind: "data" as const,
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
    inputs: uniquePorts(inputs),
    outputs: uniquePorts(outputs),
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
        ? buildFlowPorts(node, incoming, outgoing)
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
