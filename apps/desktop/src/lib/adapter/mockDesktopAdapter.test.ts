import { describe, expect, it } from "vitest";
import { MockDesktopAdapter } from "./mockDesktopAdapter";
import { defaultRepoPath } from "../mocks/mockData";

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
});
