import type { GraphFilters, GraphSettings, GraphView } from "../contracts";

export function filterGraphView(
  graph: GraphView,
  filters: GraphFilters,
  settings: GraphSettings,
): GraphView {
  const externalNodeIds = new Set(
    graph.nodes.filter((node) => node.metadata.isExternal === true).map((node) => node.id),
  );
  const edges = graph.edges.filter((edge) => {
    if (
      !settings.includeExternalDependencies &&
      (externalNodeIds.has(edge.source) || externalNodeIds.has(edge.target))
    ) {
      return false;
    }
    if (edge.kind === "imports") {
      return filters.includeImports;
    }
    if (edge.kind === "calls") {
      return filters.includeCalls;
    }
    if (edge.kind === "defines") {
      return filters.includeDefines;
    }
    return true;
  });

  const connectedNodeIds = new Set<string>([graph.rootNodeId, graph.targetId]);
  edges.forEach((edge) => {
    connectedNodeIds.add(edge.source);
    connectedNodeIds.add(edge.target);
  });

  return {
    ...graph,
    edges,
    nodes: graph.nodes.filter(
      (node) =>
        connectedNodeIds.has(node.id) &&
        (settings.includeExternalDependencies || node.metadata.isExternal !== true),
    ),
  };
}
