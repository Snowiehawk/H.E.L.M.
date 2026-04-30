import type {
  FlowExpressionParseResult,
  FlowGraphDocument,
  GraphAbstractionLevel,
  GraphActionDto,
  GraphBreadcrumbDto,
  GraphFilters,
  GraphFocusDto,
  GraphSettings,
  GraphView,
} from "../contracts";
import type {
  RawFlowExpressionParseResult,
  RawGraphAction,
  RawGraphView,
  RawGraphViewEdge,
  RawGraphViewNode,
  ScanCache,
} from "./rawTypes";
import type { InvokeCommand } from "./shared";

export async function getGraphViewCommand(
  invokeCommand: InvokeCommand,
  cache: ScanCache,
  targetId: string,
  level: GraphAbstractionLevel,
  filters: GraphFilters,
  settings: GraphSettings,
): Promise<GraphView> {
  const raw = await invokeCommand<RawGraphView>("graph_view", {
    repoPath: cache.session.path,
    targetId,
    level,
    filtersJson: JSON.stringify({
      ...filters,
      includeExternalDependencies: settings.includeExternalDependencies,
    }),
  });
  return layoutGraphView(raw);
}

export async function getFlowViewCommand(
  invokeCommand: InvokeCommand,
  cache: ScanCache,
  symbolId: string,
): Promise<GraphView> {
  const raw = await invokeCommand<RawGraphView>("flow_view", {
    repoPath: cache.session.path,
    symbolId,
  });
  return layoutGraphView(raw);
}

export async function parseFlowExpressionCommand(
  invokeCommand: InvokeCommand,
  cache: ScanCache,
  expression: string,
  inputSlotByName: Record<string, string> = {},
): Promise<FlowExpressionParseResult> {
  const raw = await invokeCommand<RawFlowExpressionParseResult>("parse_flow_expression", {
    repoPath: cache.session.path,
    expression,
    inputSlotsJson: JSON.stringify(inputSlotByName),
  });
  return {
    expression: raw.expression,
    graph: raw.graph
      ? {
          version: raw.graph.version,
          rootId: raw.graph.rootId ?? raw.graph.root_id ?? null,
          nodes: raw.graph.nodes.map((node) => ({
            id: node.id,
            kind: node.kind,
            label: node.label,
            payload: node.payload,
          })),
          edges: raw.graph.edges.map((edge) => ({
            id: edge.id,
            sourceId: edge.sourceId ?? edge.source_id ?? "",
            sourceHandle: edge.sourceHandle ?? edge.source_handle ?? "",
            targetId: edge.targetId ?? edge.target_id ?? "",
            targetHandle: edge.targetHandle ?? edge.target_handle ?? "",
          })),
        }
      : null,
    diagnostics: raw.diagnostics ?? [],
  };
}

export function layoutGraphView(raw: RawGraphView): GraphView {
  const architectureView = raw.level === "repo" || raw.level === "module";
  const flowView = raw.level === "flow";
  const layoutEdges = architectureView
    ? raw.edges.filter((edge) => edge.kind !== "contains")
    : raw.edges;
  const edgesForLevels = layoutEdges.length ? layoutEdges : raw.edges;
  const levels = architectureView
    ? buildArchitectureLevels(raw.nodes, edgesForLevels)
    : flowView
      ? buildFlowLevels(raw.nodes, edgesForLevels)
      : buildBreadthLevels(raw.root_node_id, edgesForLevels);
  const repoNode = raw.nodes.find((node) => node.kind === "repo");
  const positioned = flowView
    ? layoutLightweightFlowGraph(raw.nodes, raw.edges, levels)
    : layoutRelaxedDirectedGraph(raw.nodes, raw.edges, levels, {
        architectureView,
        flowView,
        repoNodeId: architectureView ? repoNode?.node_id : undefined,
      });

  return {
    rootNodeId: raw.root_node_id,
    targetId: raw.target_id,
    level: raw.level,
    nodes: raw.nodes.map((node) => ({
      id: node.node_id,
      kind: node.kind,
      label: node.label,
      subtitle: node.subtitle ?? "",
      metadata: node.metadata,
      availableActions: node.available_actions.map(toGraphAction),
      x: positioned.get(node.node_id)?.x ?? 0,
      y: positioned.get(node.node_id)?.y ?? 0,
    })),
    edges: raw.edges.map((edge) => ({
      id: edge.edge_id,
      kind: edge.kind,
      source: edge.source_id,
      target: edge.target_id,
      label: edge.label ?? undefined,
      metadata: edge.metadata,
    })),
    breadcrumbs: raw.breadcrumbs.map(
      (breadcrumb): GraphBreadcrumbDto => ({
        nodeId: breadcrumb.node_id,
        level: breadcrumb.level,
        label: breadcrumb.label,
        subtitle: breadcrumb.subtitle ?? undefined,
      }),
    ),
    focus: raw.focus
      ? ({
          targetId: raw.focus.target_id,
          level: raw.focus.level,
          label: raw.focus.label,
          subtitle: raw.focus.subtitle ?? undefined,
          availableLevels: raw.focus.available_levels,
        } satisfies GraphFocusDto)
      : undefined,
    truncated: raw.truncated,
    flowState: raw.flow_state
      ? {
          editable: raw.flow_state.editable,
          syncState: raw.flow_state.sync_state,
          diagnostics: raw.flow_state.diagnostics,
          document: raw.flow_state.document
            ? toFlowGraphDocument(raw.flow_state.document)
            : undefined,
        }
      : undefined,
  };
}

export function toFlowGraphDocument(
  raw: NonNullable<NonNullable<RawGraphView["flow_state"]>["document"]>,
): FlowGraphDocument {
  return {
    symbolId: raw.symbol_id,
    relativePath: raw.relative_path,
    qualname: raw.qualname,
    nodes: raw.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      payload: node.payload,
      indexedNodeId: node.indexed_node_id ?? null,
    })),
    edges: raw.edges.map((edge) => ({
      id: edge.id,
      sourceId: edge.source_id,
      sourceHandle: edge.source_handle,
      targetId: edge.target_id,
      targetHandle: edge.target_handle,
    })),
    valueModelVersion: raw.value_model_version ?? null,
    ...(raw.function_inputs
      ? {
          functionInputs: raw.function_inputs.map((input) => ({
            id: input.id,
            name: input.name,
            index: input.index,
            ...(input.kind ? { kind: input.kind } : {}),
            ...(input.default_expression !== undefined
              ? { defaultExpression: input.default_expression }
              : {}),
          })),
        }
      : {}),
    ...(raw.value_sources
      ? {
          valueSources: raw.value_sources.map((source) => ({
            id: source.id,
            nodeId: source.node_id,
            name: source.name,
            label: source.label,
            ...(source.emitted_name !== undefined ? { emittedName: source.emitted_name } : {}),
          })),
        }
      : {}),
    ...(raw.input_slots
      ? {
          inputSlots: raw.input_slots.map((slot) => ({
            id: slot.id,
            nodeId: slot.node_id,
            slotKey: slot.slot_key,
            label: slot.label,
            required: slot.required,
          })),
        }
      : {}),
    ...(raw.input_bindings
      ? {
          inputBindings: raw.input_bindings.map((binding) => ({
            id: binding.id,
            sourceId: binding.source_id ?? binding.function_input_id ?? "",
            ...(binding.function_input_id ? { functionInputId: binding.function_input_id } : {}),
            slotId: binding.slot_id,
          })),
        }
      : {}),
    syncState: raw.sync_state,
    diagnostics: raw.diagnostics,
    sourceHash: raw.source_hash,
    editable: raw.editable,
  };
}

function buildBreadthLevels(rootNodeId: string, edges: RawGraphViewEdge[]): Map<string, number> {
  const adjacency = new Map<string, Set<string>>();
  const connect = (left: string, right: string) => {
    adjacency.set(left, new Set([...(adjacency.get(left) ?? []), right]));
  };

  edges.forEach((edge) => {
    connect(edge.source_id, edge.target_id);
    connect(edge.target_id, edge.source_id);
  });

  const levels = new Map<string, number>([[rootNodeId, 0]]);
  const queue = [rootNodeId];
  while (queue.length) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    const currentLevel = levels.get(current) ?? 0;
    for (const next of adjacency.get(current) ?? []) {
      if (levels.has(next)) {
        continue;
      }
      levels.set(next, currentLevel + 1);
      queue.push(next);
    }
  }

  return levels;
}

function buildFlowLevels(
  nodes: RawGraphViewNode[],
  edges: RawGraphViewEdge[],
): Map<string, number> {
  const levels = new Map<string, number>();
  const controlEdges = edges.filter((edge) => edge.kind === "controls");
  const nodeById = new Map(nodes.map((node) => [node.node_id, node] as const));
  const orderedFlowNodes = nodes
    .map((node) => [node, rawFlowOrder(node)] as const)
    .filter((entry): entry is readonly [RawGraphViewNode, number] => entry[1] !== undefined)
    .sort((left, right) => left[1] - right[1] || left[0].label.localeCompare(right[0].label));

  if (!controlEdges.length && orderedFlowNodes.length) {
    orderedFlowNodes.forEach(([node, order]) => {
      levels.set(node.node_id, order);
    });
    nodes.forEach((node) => {
      if (!levels.has(node.node_id)) {
        levels.set(node.node_id, node.kind === "entry" ? 0 : 1);
      }
    });
    return levels;
  }

  const outgoingForwardEdges = new Map<string, RawGraphViewEdge[]>();
  controlEdges
    .filter((edge) => {
      const sourceNode = nodeById.get(edge.source_id);
      const targetNode = nodeById.get(edge.target_id);
      const sourceOrder = sourceNode ? rawFlowOrder(sourceNode) : undefined;
      const targetOrder = targetNode ? rawFlowOrder(targetNode) : undefined;
      if (sourceOrder === undefined || targetOrder === undefined) {
        return true;
      }
      return targetOrder >= sourceOrder;
    })
    .forEach((edge) => {
      outgoingForwardEdges.set(edge.source_id, [
        ...(outgoingForwardEdges.get(edge.source_id) ?? []),
        edge,
      ]);
    });

  const orderedNodes = nodes
    .slice()
    .sort(
      (left, right) =>
        (rawFlowOrder(left) ?? Number.MAX_SAFE_INTEGER) -
          (rawFlowOrder(right) ?? Number.MAX_SAFE_INTEGER) ||
        `${left.kind}:${left.label}`.localeCompare(`${right.kind}:${right.label}`),
    );
  orderedNodes.forEach((node) => {
    const baseLevel =
      levels.get(node.node_id) ?? (node.kind === "entry" || node.kind === "param" ? 0 : 1);
    levels.set(node.node_id, baseLevel);
    for (const edge of outgoingForwardEdges.get(node.node_id) ?? []) {
      const nextLevel = baseLevel + 1;
      levels.set(edge.target_id, Math.max(levels.get(edge.target_id) ?? 0, nextLevel));
    }
  });

  nodes.forEach((node) => {
    if (!levels.has(node.node_id)) {
      levels.set(node.node_id, node.kind === "param" ? 0 : 1);
    }
  });

  return levels;
}

function layoutLightweightFlowGraph(
  nodes: RawGraphViewNode[],
  edges: RawGraphViewEdge[],
  levels: Map<string, number>,
): Map<string, { x: number; y: number }> {
  const orderedNodes = nodes
    .slice()
    .sort(
      (left, right) =>
        (rawFlowOrder(left) ?? Number.MAX_SAFE_INTEGER) -
          (rawFlowOrder(right) ?? Number.MAX_SAFE_INTEGER) ||
        `${left.kind}:${left.label}`.localeCompare(`${right.kind}:${right.label}`),
    );
  const positions = new Map<string, { x: number; y: number }>();
  const controlEdges = edges.filter((edge) => edge.kind === "controls");

  if (!controlEdges.length) {
    orderedNodes.forEach((node, index) => {
      positions.set(node.node_id, {
        x: index * 280,
        y: 0,
      });
    });
    return positions;
  }

  const controlNodeIds = new Set<string>();
  controlEdges.forEach((edge) => {
    controlNodeIds.add(edge.source_id);
    controlNodeIds.add(edge.target_id);
  });

  const mainFlowNodes = orderedNodes.filter(
    (node) => node.kind === "entry" || controlNodeIds.has(node.node_id),
  );
  const buckets = new Map<number, RawGraphViewNode[]>();
  mainFlowNodes.forEach((node) => {
    const level = levels.get(node.node_id) ?? 0;
    buckets.set(level, [...(buckets.get(level) ?? []), node]);
  });

  [...buckets.entries()]
    .sort((left, right) => left[0] - right[0])
    .forEach(([level, group]) => {
      const sortedGroup = group
        .slice()
        .sort(
          (left, right) =>
            (rawFlowOrder(left) ?? Number.MAX_SAFE_INTEGER) -
              (rawFlowOrder(right) ?? Number.MAX_SAFE_INTEGER) ||
            `${left.kind}:${left.label}`.localeCompare(`${right.kind}:${right.label}`),
        );
      sortedGroup.forEach((node, index) => {
        const centeredIndex = index - (sortedGroup.length - 1) / 2;
        positions.set(node.node_id, {
          x: level * 320,
          y: centeredIndex * 150,
        });
      });
    });

  const controlColumnByNodeId = new Map<string, number>(
    Array.from(positions.entries()).map(
      ([nodeId, position]) => [nodeId, Math.round(position.x / 320)] as const,
    ),
  );
  const supportAboveDepthByColumn = new Map<number, number>();
  const supportBelowDepthByColumn = new Map<number, number>();

  orderedNodes
    .filter((node) => !positions.has(node.node_id))
    .forEach((node) => {
      const relatedColumns = edges.flatMap((edge) => {
        if (edge.source_id === node.node_id && controlColumnByNodeId.has(edge.target_id)) {
          return [controlColumnByNodeId.get(edge.target_id) as number];
        }
        if (edge.target_id === node.node_id && controlColumnByNodeId.has(edge.source_id)) {
          return [controlColumnByNodeId.get(edge.source_id) as number];
        }
        return [];
      });
      const column = relatedColumns.length
        ? Math.round(relatedColumns.reduce((sum, value) => sum + value, 0) / relatedColumns.length)
        : (levels.get(node.node_id) ?? 0);
      const above = node.kind === "param";
      const depthByColumn = above ? supportAboveDepthByColumn : supportBelowDepthByColumn;
      const depth = depthByColumn.get(column) ?? 0;
      depthByColumn.set(column, depth + 1);
      positions.set(node.node_id, {
        x: column * 320 + (above ? -72 : 72),
        y: above ? -180 - depth * 132 : 180 + depth * 132,
      });
    });

  return positions;
}

function buildArchitectureLevels(
  nodes: RawGraphViewNode[],
  edges: RawGraphViewEdge[],
): Map<string, number> {
  const moduleLikeNodes = nodes.filter((node) => node.kind !== "repo");
  const nodeIds = new Set(moduleLikeNodes.map((node) => node.node_id));
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();

  moduleLikeNodes.forEach((node) => indegree.set(node.node_id, 0));

  edges.forEach((edge) => {
    if (!nodeIds.has(edge.source_id) || !nodeIds.has(edge.target_id)) {
      return;
    }
    outgoing.set(edge.source_id, [...(outgoing.get(edge.source_id) ?? []), edge.target_id]);
    indegree.set(edge.target_id, (indegree.get(edge.target_id) ?? 0) + 1);
  });

  const queue = Array.from(indegree.entries())
    .filter(([, count]) => count === 0)
    .map(([nodeId]) => nodeId);
  const levels = new Map<string, number>();

  if (!queue.length) {
    moduleLikeNodes.forEach((node) => levels.set(node.node_id, 0));
    return levels;
  }

  queue.forEach((nodeId) => levels.set(nodeId, 0));
  while (queue.length) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    const currentLevel = levels.get(current) ?? 0;
    for (const next of outgoing.get(current) ?? []) {
      levels.set(next, Math.max(levels.get(next) ?? 0, currentLevel + 1));
      const nextDegree = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, nextDegree);
      if (nextDegree === 0) {
        queue.push(next);
      }
    }
  }

  moduleLikeNodes.forEach((node) => {
    if (!levels.has(node.node_id)) {
      levels.set(node.node_id, 0);
    }
  });
  return levels;
}

function layoutRelaxedDirectedGraph(
  nodes: RawGraphViewNode[],
  edges: RawGraphViewEdge[],
  levels: Map<string, number>,
  options: {
    architectureView: boolean;
    flowView: boolean;
    repoNodeId?: string;
  },
): Map<string, { x: number; y: number }> {
  const nodeIds = new Set(nodes.map((node) => node.node_id));
  const relevantEdges = edges.filter(
    (edge) => nodeIds.has(edge.source_id) && nodeIds.has(edge.target_id),
  );
  const buckets = new Map<number, RawGraphViewNode[]>();

  nodes.forEach((node) => {
    const baseLevel = node.node_id === options.repoNodeId ? -1 : (levels.get(node.node_id) ?? 0);
    buckets.set(baseLevel, [...(buckets.get(baseLevel) ?? []), node]);
  });

  const sortedLevels = Array.from(buckets.keys()).sort((left, right) => left - right);
  const minLevel = sortedLevels[0] ?? 0;
  const levelGap = options.architectureView ? 420 : options.flowView ? 340 : 380;
  const rowGap = options.architectureView ? 210 : options.flowView ? 170 : 190;
  const positions = new Map<string, { x: number; y: number }>();
  const fixedNodeIds = new Set<string>(options.repoNodeId ? [options.repoNodeId] : []);

  sortedLevels.forEach((level) => {
    const group = [...(buckets.get(level) ?? [])].sort(
      (left, right) =>
        (options.flowView
          ? (rawFlowOrder(left) ?? Number.MAX_SAFE_INTEGER) -
            (rawFlowOrder(right) ?? Number.MAX_SAFE_INTEGER)
          : 0) || `${left.kind}:${left.label}`.localeCompare(`${right.kind}:${right.label}`),
    );
    group.forEach((node, index) => {
      const centeredIndex = index - (group.length - 1) / 2;
      positions.set(node.node_id, {
        x:
          (level - minLevel) * levelGap + centeredIndex * 54 + stableLayoutOffset(node.node_id, 82),
        y: centeredIndex * rowGap + stableLayoutOffset(node.node_id, 96),
      });
    });
  });

  if (options.repoNodeId && positions.has(options.repoNodeId)) {
    positions.set(options.repoNodeId, { x: -levelGap * 1.15, y: 0 });
  }

  for (let iteration = 0; iteration < 140; iteration += 1) {
    const displacement = new Map<string, { x: number; y: number }>();
    nodes.forEach((node) => displacement.set(node.node_id, { x: 0, y: 0 }));

    for (let index = 0; index < nodes.length; index += 1) {
      const left = nodes[index];
      const leftPosition = positions.get(left.node_id);
      if (!leftPosition) {
        continue;
      }

      for (let otherIndex = index + 1; otherIndex < nodes.length; otherIndex += 1) {
        const right = nodes[otherIndex];
        const rightPosition = positions.get(right.node_id);
        if (!rightPosition) {
          continue;
        }

        const dx = rightPosition.x - leftPosition.x;
        const dy = rightPosition.y - leftPosition.y;
        const distance = Math.max(Math.hypot(dx, dy), 1);
        const repulsion = Math.min(180000 / (distance * distance), 22);
        const unitX = dx / distance;
        const unitY = dy / distance;

        displacement.get(left.node_id)!.x -= unitX * repulsion;
        displacement.get(left.node_id)!.y -= unitY * repulsion;
        displacement.get(right.node_id)!.x += unitX * repulsion;
        displacement.get(right.node_id)!.y += unitY * repulsion;
      }
    }

    relevantEdges.forEach((edge) => {
      const sourcePosition = positions.get(edge.source_id);
      const targetPosition = positions.get(edge.target_id);
      if (!sourcePosition || !targetPosition) {
        return;
      }

      const desiredGap = desiredHorizontalGap(edge, options.flowView);
      const dx = targetPosition.x - sourcePosition.x;
      const dy = targetPosition.y - sourcePosition.y;
      const xError = dx - desiredGap;
      const yError = dy;
      const xAdjust = xError * 0.05;
      const yAdjust = yError * 0.025;

      displacement.get(edge.source_id)!.x += xAdjust * 0.5;
      displacement.get(edge.target_id)!.x -= xAdjust * 0.5;
      displacement.get(edge.source_id)!.y += yAdjust * 0.5;
      displacement.get(edge.target_id)!.y -= yAdjust * 0.5;
    });

    nodes.forEach((node) => {
      const position = positions.get(node.node_id);
      const change = displacement.get(node.node_id);
      if (!position || !change) {
        return;
      }

      if (fixedNodeIds.has(node.node_id)) {
        position.y += clampLayoutDelta((0 - position.y) * 0.08, 20);
        return;
      }

      const nodeLevel = node.node_id === options.repoNodeId ? -1 : (levels.get(node.node_id) ?? 0);
      const anchorX = (nodeLevel - minLevel) * levelGap + stableLayoutOffset(node.node_id, 82);

      position.x += clampLayoutDelta(change.x + (anchorX - position.x) * 0.02, 28);
      position.y += clampLayoutDelta(change.y + (0 - position.y) * 0.003, 24);
    });
  }

  return positions;
}

function rawFlowOrder(node: RawGraphViewNode): number | undefined {
  const value = node.metadata.flow_order ?? node.metadata.flowOrder;
  return typeof value === "number" ? value : undefined;
}

function stableLayoutOffset(nodeId: string, spread: number): number {
  let hash = 0;
  for (let index = 0; index < nodeId.length; index += 1) {
    hash = (hash * 31 + nodeId.charCodeAt(index)) >>> 0;
  }
  return (hash / 0xffffffff - 0.5) * spread;
}

function desiredHorizontalGap(edge: RawGraphViewEdge, flowView: boolean): number {
  if (edge.kind === "defines") {
    return flowView ? 250 : 320;
  }
  if (edge.kind === "controls") {
    return 240;
  }
  if (edge.kind === "data") {
    return 210;
  }
  if (edge.kind === "calls") {
    return flowView ? 260 : 380;
  }
  if (edge.kind === "imports") {
    return 360;
  }
  return 300;
}

function clampLayoutDelta(value: number, maxMagnitude: number): number {
  return Math.max(-maxMagnitude, Math.min(maxMagnitude, value));
}

function toGraphAction(action: RawGraphAction): GraphActionDto {
  return {
    actionId: action.action_id,
    label: action.label,
    enabled: action.enabled,
    reason: action.reason ?? undefined,
    payload: action.payload,
  };
}
