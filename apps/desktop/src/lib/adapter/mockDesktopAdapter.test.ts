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

    expect(result.flowSyncState).toBe("draft");
    expect(result.diagnostics.some((diagnostic) => diagnostic.includes("disconnected"))).toBe(true);
    expect(updated.flowState?.document?.nodes.some((node) => node.id.endsWith(":assign:disconnected"))).toBe(true);
    expect(updated.nodes.some((node) => node.id.endsWith(":assign:disconnected"))).toBe(true);
  });
});
