import { describe, expect, it } from "vitest";
import { AnsiMatchingView, DiagnosticStream, parseDiagnosticLine } from "./diagnostics";

describe("run diagnostic matching", () => {
  it("parses Python and common Unix/Windows locations with one-based coordinates", () => {
    expect(parseDiagnosticLine('  File "src/space Ω/main.py", line 12, in <module>')).toEqual({
      path: "src/space Ω/main.py",
      line: 12,
      column: 1,
    });
    expect(parseDiagnosticLine("C:\\my project Ω\\main.py:17:9: error")).toEqual({
      path: "C:\\my project Ω\\main.py",
      line: 17,
      column: 9,
    });
    expect(parseDiagnosticLine("\\\\server\\share\\a.py:2: error")).toEqual({
      path: "\\\\server\\share\\a.py",
      line: 2,
      column: 1,
    });
    expect(parseDiagnosticLine("src/a.py:3: SyntaxError")).toEqual({
      path: "src/a.py",
      line: 3,
      column: 1,
    });
    for (const line of [
      "http://localhost:3000",
      'File "<string>", line 1',
      "main.py:0: bad",
      "main.py:3:0: bad",
      "main.py:999999999999999999999: bad",
      "x\u0000.py:1: bad",
    ])
      expect(parseDiagnosticLine(line)).toBeUndefined();
  });

  it("preserves separate streams and split ANSI/traceback lines", () => {
    const parser = new DiagnosticStream("run-1");
    expect(parser.push("\u001b[3")).toEqual([]);
    expect(parser.push('1m  File "src/Ω.py", li')).toEqual([]);
    expect(parser.push("other.py:7: good\n", "stdout")).toHaveLength(1);
    const [diagnostic] = parser.push("ne 3, in foo\u001b[0m\r\n");
    expect(diagnostic).toMatchObject({
      runId: "run-1",
      stream: "stderr",
      path: "src/Ω.py",
      line: 3,
      column: 1,
    });
    expect(parser.push('  File "src/Ω.py", line 3, in foo\n')).toEqual([]);
    expect(diagnostic.repetitions).toBe(2);
    parser.push("last.py:9: end");
    expect(parser.finish()[0].line).toBe(9);
    expect(parser.finish()).toEqual([]);
  });

  it("bounds a flood, discards oversized lines as whole records and retains final errors", () => {
    const parser = new DiagnosticStream("run-2", 2);
    parser.push("x".repeat(20_000));
    expect(parser.push("evil.py:1: suffix\n")).toEqual([]);
    parser.push("a.py:1: a\nb.py:2: b\nc.py:3: final\n");
    expect(parser.diagnostics.map((item) => item.path)).toEqual(["b.py", "c.py"]);
    expect(parser.truncated).toBe(true);
    expect(new DiagnosticStream("other-run").diagnostics).toEqual([]);
  });

  it("strips split OSC/C1 metadata only from the matching view", () => {
    const view = new AnsiMatchingView();
    expect(view.push("a\u001b]8;;http://evil")).toBe("a");
    expect(view.push("\u001b\\b\u001b]8;;\u0007\u009b31mc\u009b0m")).toBe("bc");
  });
  it("matches multiline Python/Windows diagnostics at every ANSI and CRLF split", () => {
    const raw =
      '\u001b]0;untrusted title\u0007Traceback (most recent call last):\r\n\u001b[31m  File "src/space Ω/main.py", line 12, in run\u001b[0m\r\n    fail()\r\nC:\\project Ω\\main.py:17:9: error\r\n\\\\server\\share\\a.py:2: error\r\nValueError: final message';
    const expected = [
      { path: "src/space Ω/main.py", line: 12, column: 1 },
      { path: "C:\\project Ω\\main.py", line: 17, column: 9 },
      { path: "\\\\server\\share\\a.py", line: 2, column: 1 },
    ];
    for (let split = 0; split <= raw.length; split++) {
      const parser = new DiagnosticStream(`split-${split}`);
      parser.push(raw.slice(0, split));
      parser.push(raw.slice(split));
      parser.finish();
      expect(parser.diagnostics.map(({ path, line, column }) => ({ path, line, column }))).toEqual(
        expected,
      );
    }
  });
});
