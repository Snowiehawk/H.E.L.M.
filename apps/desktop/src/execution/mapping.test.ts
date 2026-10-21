import { describe, expect, it } from "vitest";
import type { GraphNodeDto } from "../lib/adapter/contracts";
import { resolveGraphDiagnostic, resolvePreparedGraphDiagnostic } from "./mapping";

const node = (
  id: string,
  kind: GraphNodeDto["kind"],
  path: string,
  start: number,
  end: number,
  startColumn = 0,
  endColumn = 30,
): GraphNodeDto => ({
  id,
  kind,
  label: "duplicated",
  x: 0,
  y: 0,
  availableActions: [],
  metadata: {
    relative_path: path,
    source_start_line: start,
    source_start_column: startColumn,
    source_end_line: end,
    source_end_column: endColumn,
  },
});
const nodes = [
  node("symbol:src/a.py:Outer", "class", "src/a.py", 1, 30),
  node("symbol:src/a.py:Outer.inner", "function", "src/a.py", 5, 10),
  node("symbol:src/b.py:Outer.inner", "function", "src/b.py", 5, 10),
  node("flow:src/a.py:ret", "return", "src/a.py", 8, 8, 4, 14),
];
const input = {
  relativePath: "src/a.py",
  line: 8,
  column: 6,
  sourceLineText: "    return 123",
  runSourceHash: "same",
  currentSourceHash: "same",
  indexedSourceHash: "same",
  nodes,
};

describe("source-proven diagnostic graph mapping", () => {
  it("converts editor UTF-16 columns to Python UTF-8 byte offsets", () => {
    const unicodeNodes = [
      node("symbol:unicode:run", "function", "unicode.py", 1, 3),
      node("flow:unicode:call", "call", "unicode.py", 2, 2, 6, 12),
    ];
    expect(
      resolveGraphDiagnostic({
        ...input,
        relativePath: "unicode.py",
        line: 2,
        column: 6,
        sourceLineText: "Ω(); fail()",
        nodes: unicodeNodes,
      }),
    ).toMatchObject({ status: "exact", nodeId: "flow:unicode:call" });
    expect(
      resolveGraphDiagnostic({
        ...input,
        relativePath: "unicode.py",
        line: 2,
        column: 6,
        sourceLineText: undefined,
        nodes: unicodeNodes,
      }),
    ).toMatchObject({ status: "symbol", nodeId: "symbol:unicode:run" });
  });
  it("selects the independently expected narrowest span, not a duplicated name", () => {
    expect(resolveGraphDiagnostic(input)).toMatchObject({
      status: "exact",
      nodeId: "flow:src/a.py:ret",
    });
    expect(resolveGraphDiagnostic({ ...input, line: 7 })).toMatchObject({
      status: "symbol",
      nodeId: "symbol:src/a.py:Outer.inner",
    });
    expect(resolveGraphDiagnostic({ ...input, relativePath: "src\\b.py", line: 7 })).toMatchObject({
      status: "symbol",
      nodeId: "symbol:src/b.py:Outer.inner",
    });
  });
  it("uses parser zero-based exclusive-end columns and rejects equal ambiguous spans", () => {
    expect(resolveGraphDiagnostic({ ...input, column: 15 })).toMatchObject({
      status: "symbol",
      nodeId: "symbol:src/a.py:Outer.inner",
    });
    expect(
      resolveGraphDiagnostic({
        ...input,
        nodes: [...nodes, node("flow:src/a.py:duplicate", "return", "src/a.py", 8, 8, 4, 14)],
      }),
    ).toMatchObject({ status: "ambiguous" });
  });
  it("never claims exact mapping for missing/stale proof or issue-domain nodes", () => {
    expect(resolveGraphDiagnostic({ ...input, indexedSourceHash: undefined }).status).toBe(
      "unmapped",
    );
    expect(resolveGraphDiagnostic({ ...input, currentSourceHash: "edited" }).status).toBe("stale");
    expect(
      resolveGraphDiagnostic({ ...input, nodes: [node("issue:42", "function", "src/a.py", 1, 20)] })
        .status,
    ).toBe("unmapped");
    expect(resolveGraphDiagnostic({ ...input, relativePath: "deleted.py" }).status).toBe(
      "unmapped",
    );
  });
  it("requires frozen parser IDs/spans to match the current graph before symbol fallback", () => {
    const indexedSymbols = [
      {
        nodeId: "symbol:src/a.py:Outer.inner",
        relativePath: "src/a.py",
        sourceHash: "same",
        startLine: 5,
        startColumn: 0,
        endLine: 10,
        endColumn: 30,
      },
    ];
    expect(resolvePreparedGraphDiagnostic({ ...input, indexedSymbols })).toMatchObject({
      status: "symbol",
      nodeId: "symbol:src/a.py:Outer.inner",
    });
    expect(
      resolvePreparedGraphDiagnostic({
        ...input,
        indexedSymbols: [{ ...indexedSymbols[0], startLine: 6 }],
      }).status,
    ).toBe("unmapped");
  });
});
