import type { GraphNodeDto } from "../lib/adapter/contracts";

export interface DiagnosticGraphInput {
  relativePath: string;
  line: number;
  column?: number;
  /** Current UTF-8 file line as decoded text, for UTF-16 -> Python byte-column conversion. */
  sourceLineText?: string;
  runSourceHash?: string;
  currentSourceHash?: string;
  /** Hash of the exact file bytes represented by these indexed graph spans. */
  indexedSourceHash?: string;
  nodes: readonly GraphNodeDto[];
}
export interface IndexedSymbolProof {
  nodeId: string;
  relativePath: string;
  sourceHash: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}
export type DiagnosticGraphMapping =
  | { status: "exact" | "symbol"; nodeId: string; reason: string }
  | { status: "stale" | "ambiguous" | "unmapped"; reason: string };

const symbolKinds = new Set(["symbol", "function", "class", "enum", "variable"]);
const statementKinds = new Set(["assign", "call", "branch", "loop", "return"]);
const normalizedPath = (path: string) => path.replace(/\\/g, "/");

/** Match frozen parser facts to current graph metadata before using any span. */
export function resolvePreparedGraphDiagnostic(
  input: Omit<DiagnosticGraphInput, "indexedSourceHash"> & {
    indexedSymbols: readonly IndexedSymbolProof[];
  },
): DiagnosticGraphMapping {
  const provenNodes = input.nodes.filter((node) =>
    input.indexedSymbols.some(
      (proof) =>
        proof.nodeId === node.id &&
        proof.sourceHash === input.runSourceHash &&
        normalizedPath(proof.relativePath) === normalizedPath(input.relativePath) &&
        node.metadata.source_start_line === proof.startLine &&
        node.metadata.source_start_column === proof.startColumn &&
        node.metadata.source_end_line === proof.endLine &&
        node.metadata.source_end_column === proof.endColumn,
    ),
  );
  return resolveGraphDiagnostic({
    ...input,
    nodes: provenNodes,
    indexedSourceHash: provenNodes.length ? input.runSourceHash : undefined,
  });
}

export function resolveGraphDiagnostic(input: DiagnosticGraphInput): DiagnosticGraphMapping {
  if (!input.runSourceHash || !input.currentSourceHash || !input.indexedSourceHash)
    return {
      status: "unmapped",
      reason: "File location is available; graph source-version proof is unavailable.",
    };
  if (
    input.runSourceHash !== input.currentSourceHash ||
    input.runSourceHash !== input.indexedSourceHash
  )
    return {
      status: "stale",
      reason:
        "Source or its graph changed after this run. Open the file location without selecting a graph node.",
    };
  if (
    !Number.isSafeInteger(input.line) ||
    input.line < 1 ||
    (input.column !== undefined && (!Number.isSafeInteger(input.column) || input.column < 1))
  )
    return { status: "unmapped", reason: "The diagnostic location is invalid." };
  const candidates: { node: GraphNodeDto; lines: number; columns: number }[] = [];
  for (const node of input.nodes) {
    // No issue nodes, ordinal guesses, labels or synthetic entry/exit nodes.
    if (!(symbolKinds.has(node.kind) || statementKinds.has(node.kind))) continue;
    // AST columns are UTF-8 byte offsets, whereas editor columns count UTF-16
    // units. Without the actual line, only an enclosing symbol is defensible.
    if (statementKinds.has(node.kind) && input.sourceLineText === undefined) continue;
    if (!(node.id.startsWith("symbol:") || node.id.startsWith("flow:"))) continue;
    const metadata = node.metadata;
    if (
      metadata.is_external ||
      typeof metadata.relative_path !== "string" ||
      normalizedPath(metadata.relative_path) !== normalizedPath(input.relativePath)
    )
      continue;
    const start = metadata.source_start_line;
    const end = metadata.source_end_line;
    const startColumn = metadata.source_start_column;
    const endColumn = metadata.source_end_column;
    if (
      ![start, end, startColumn, endColumn].every(
        (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
      )
    )
      continue;
    const [s, e, sc, ec] = [start, end, startColumn, endColumn] as number[];
    if (s < 1 || e < s || (s === e && ec < sc) || input.line < s || input.line > e) continue;
    // Parser columns are zero-based and end-exclusive; diagnostic columns are one-based.
    const column =
      input.column === undefined || input.sourceLineText === undefined
        ? undefined
        : new TextEncoder().encode(input.sourceLineText.slice(0, input.column - 1)).length;
    if (
      column !== undefined &&
      ((input.line === s && column < sc) || (input.line === e && column >= ec))
    )
      continue;
    candidates.push({ node, lines: e - s, columns: e === s ? ec - sc : Number.MAX_SAFE_INTEGER });
  }
  if (!candidates.length)
    return { status: "unmapped", reason: "No supported graph span covers this file location." };
  candidates.sort(
    (a, b) => a.lines - b.lines || a.columns - b.columns || a.node.id.localeCompare(b.node.id),
  );
  const best = candidates[0];
  if (
    candidates.some(
      (other, i) => i > 0 && other.lines === best.lines && other.columns === best.columns,
    )
  )
    return {
      status: "ambiguous",
      reason:
        "Several graph nodes cover this location equally. Open the file location without guessing a node.",
    };
  const status = statementKinds.has(best.node.kind) ? "exact" : "symbol";
  return {
    status,
    nodeId: best.node.id,
    reason:
      status === "exact"
        ? "Source-matched statement span."
        : "Source-matched enclosing symbol; exact statement mapping is unavailable.",
  };
}
