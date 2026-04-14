import { describe, expect, it } from "vitest";
import { normalizeHighlightRange } from "./inspectorCodeRange";

function createModel(lines: string[]) {
  return {
    getLineCount() {
      return lines.length;
    },
    getLineMaxColumn(lineNumber: number) {
      return (lines[lineNumber - 1] ?? "").length + 1;
    },
  };
}

describe("normalizeHighlightRange", () => {
  it("returns a Monaco-compatible range shape", () => {
    const range = normalizeHighlightRange(
      {
        startLine: 20,
        endLine: 20,
        startColumn: 4,
        endColumn: 10,
      },
      createModel(["    ranked_modules = sorted(module_summaries)[:top_n]"]),
      20,
      0,
    );

    expect(range).toEqual({
      startLineNumber: 1,
      startColumn: 5,
      endLineNumber: 1,
      endColumn: 11,
    });
  });

  it("normalizes a highlighted member inside an exact nested snippet", () => {
    const range = normalizeHighlightRange(
      {
        startLine: 12,
        endLine: 15,
        startColumn: 8,
        endColumn: 9,
      },
      createModel([
        "def to_payload(self) -> dict[str, object]:",
        "    return {",
        '        "repo_path": self.repo_path,',
        '        "module_count": self.module_count,',
        "    }",
      ]),
      11,
      4,
    );

    expect(range).toEqual({
      startLineNumber: 2,
      startColumn: 5,
      endLineNumber: 5,
      endColumn: 6,
    });
  });
});
