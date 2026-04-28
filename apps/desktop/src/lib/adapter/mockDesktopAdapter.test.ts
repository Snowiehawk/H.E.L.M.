import { describe, expect, it } from "vitest";
import { MockDesktopAdapter } from "./mockDesktopAdapter";
import { defaultRepoPath } from "../mocks/mockData";
import type { FlowGraphDocument } from "./contracts";

describe("MockDesktopAdapter", () => {
  it("returns symbol-only results when file search is disabled", async () => {
    const adapter = new MockDesktopAdapter();
    const results = await adapter.searchRepo("graph", {
      includeModules: false,
      includeFiles: false,
      includeSymbols: true,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((result) => result.kind === "symbol")).toBe(true);
  });

  it("filters graph edges by the active graph toggles", async () => {
    const adapter = new MockDesktopAdapter();
    const graph = await adapter.getGraphView(
      "module:helm.ui.api",
      "module",
      {
        includeCalls: false,
        includeImports: true,
        includeDefines: true,
      },
      {
        includeExternalDependencies: false,
      },
    );

    expect(graph.edges.some((edge) => edge.kind === "calls")).toBe(false);
    expect(graph.edges.some((edge) => edge.kind === "imports")).toBe(true);
  });

  it("hides external dependency nodes by default and reveals them from advanced settings", async () => {
    const adapter = new MockDesktopAdapter();

    const defaultGraph = await adapter.getGraphView(
      `repo:${defaultRepoPath}`,
      "module",
      {
        includeCalls: true,
        includeImports: true,
        includeDefines: true,
      },
      {
        includeExternalDependencies: false,
      },
    );
    const expandedGraph = await adapter.getGraphView(
      `repo:${defaultRepoPath}`,
      "module",
      {
        includeCalls: true,
        includeImports: true,
        includeDefines: true,
      },
      {
        includeExternalDependencies: true,
      },
    );

    expect(defaultGraph.nodes.some((node) => node.label === "rich.console")).toBe(false);
    expect(expandedGraph.nodes.some((node) => node.label === "rich.console")).toBe(true);
  });

  it("round-trips disconnected flow draft nodes through replace_flow_graph", async () => {
    const adapter = new MockDesktopAdapter();
    const original = await adapter.getFlowView("symbol:helm.ui.api:build_graph_summary");
    const baseDocument = original.flowState?.document;
    if (!baseDocument) {
      throw new Error("Expected the mock flow view to expose a draft-capable flow document.");
    }

    const disconnectedDocument: FlowGraphDocument = {
      ...baseDocument,
      nodes: [
        ...baseDocument.nodes,
        {
          id: "flowdoc:symbol:helm.ui.api:build_graph_summary:assign:disconnected",
          kind: "assign",
          payload: { source: "helper = rank_modules(graph)" },
        },
      ],
    };

    const result = await adapter.applyStructuralEdit({
      kind: "replace_flow_graph",
      targetId: "symbol:helm.ui.api:build_graph_summary",
      flowGraph: disconnectedDocument,
    });
    const updated = await adapter.getFlowView("symbol:helm.ui.api:build_graph_summary");
    const source = await adapter.getEditableNodeSource("symbol:helm.ui.api:build_graph_summary");

    expect(result.flowSyncState).toBe("draft");
    expect(result.touchedRelativePaths).toEqual([".helm/flow-models.v1.json"]);
    expect(result.diagnostics.some((diagnostic) => diagnostic.includes("disconnected"))).toBe(true);
    expect(updated.flowState?.syncState).toBe("draft");
    expect(
      updated.flowState?.document?.nodes.some((node) => node.id.endsWith(":assign:disconnected")),
    ).toBe(true);
    expect(updated.nodes.some((node) => node.id.endsWith(":assign:disconnected"))).toBe(true);
    expect(source.content).not.toContain("helper = rank_modules(graph)");
  });

  it("round-trips clean flow replacements through replace_flow_graph with source and flow-model touches", async () => {
    const adapter = new MockDesktopAdapter();
    const original = await adapter.getFlowView("symbol:helm.ui.api:build_graph_summary");
    const baseDocument = original.flowState?.document;
    if (!baseDocument) {
      throw new Error("Expected the mock flow view to expose a draft-capable flow document.");
    }

    const cleanDocument: FlowGraphDocument = {
      ...baseDocument,
      nodes: baseDocument.nodes.map((node) =>
        node.id === "flow:symbol:helm.ui.api:build_graph_summary:call:rank"
          ? {
              ...node,
              payload: { source: "rank_modules(module_summaries, top_n)" },
            }
          : node,
      ),
    };

    const result = await adapter.applyStructuralEdit({
      kind: "replace_flow_graph",
      targetId: "symbol:helm.ui.api:build_graph_summary",
      flowGraph: cleanDocument,
    });
    const updated = await adapter.getFlowView("symbol:helm.ui.api:build_graph_summary");
    const source = await adapter.getEditableNodeSource("symbol:helm.ui.api:build_graph_summary");

    expect(result.flowSyncState).toBe("clean");
    expect(result.diagnostics).toEqual([]);
    expect(result.touchedRelativePaths).toEqual([
      "src/helm/ui/api.py",
      ".helm/flow-models.v1.json",
    ]);
    expect(updated.flowState?.syncState).toBe("clean");
    expect(
      updated.flowState?.document?.nodes.find(
        (node) => node.id === "flow:symbol:helm.ui.api:build_graph_summary:call:rank",
      )?.payload,
    ).toEqual({ source: "rank_modules(module_summaries, top_n)" });
    expect(
      updated.nodes.some((node) => node.label.includes("rank_modules(module_summaries, top_n)")),
    ).toBe(true);
    expect(source.content).toContain("rank_modules(module_summaries, top_n)");
  });
});
