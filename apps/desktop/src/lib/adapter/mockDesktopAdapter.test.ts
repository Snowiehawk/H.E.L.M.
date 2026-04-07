import { describe, expect, it } from "vitest";
import { MockDesktopAdapter } from "./mockDesktopAdapter";

describe("MockDesktopAdapter", () => {
  it("returns symbol-only results when file search is disabled", async () => {
    const adapter = new MockDesktopAdapter();
    const results = await adapter.searchRepo("graph", {
      includeFiles: false,
      includeSymbols: true,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((result) => result.kind === "symbol")).toBe(true);
  });

  it("filters graph edges by the active graph toggles", async () => {
    const adapter = new MockDesktopAdapter();
    const graph = await adapter.getGraphNeighborhood(
      "symbol:helm.ui.api.build_graph_summary",
      2,
      {
        includeCalls: false,
        includeImports: true,
        includeDefines: true,
      },
    );

    expect(graph.edges.some((edge) => edge.kind === "calls")).toBe(false);
    expect(graph.edges.some((edge) => edge.kind === "imports")).toBe(true);
  });
});
