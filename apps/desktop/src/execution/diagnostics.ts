export type OutputStream = "stdout" | "stderr";

export interface RunDiagnostic {
  id: string;
  runId: string;
  stream: OutputStream;
  path: string;
  /** Diagnostic and Monaco coordinates are one-based. */
  line: number;
  column: number;
  text: string;
  repetitions: number;
}

/** Matching only: callers retain original output bytes for display. */
export class AnsiMatchingView {
  private state: "text" | "escape" | "csi" | "osc" | "oscEscape" = "text";

  push(chunk: string): string {
    let result = "";
    for (const character of chunk) {
      if (this.state === "text") {
        if (character === "\u001b") this.state = "escape";
        else if (character === "\u009b") this.state = "csi";
        else if (character === "\u009d") this.state = "osc";
        else if (character === "\n" || character === "\r" || character === "\t" || character >= " ")
          result += character;
      } else if (this.state === "escape") {
        this.state = character === "[" ? "csi" : character === "]" ? "osc" : "text";
      } else if (this.state === "csi") {
        if (character >= "@" && character <= "~") this.state = "text";
      } else if (this.state === "osc") {
        if (character === "\u0007" || character === "\u009c") this.state = "text";
        else if (character === "\u001b") this.state = "oscEscape";
      } else {
        this.state = character === "\\" ? "text" : "osc";
      }
    }
    return result;
  }
}

export function parseDiagnosticLine(
  text: string,
): Pick<RunDiagnostic, "path" | "line" | "column"> | undefined {
  if (text.length > 16_384) return undefined;
  const traceback = /^\s*File "([^"\r\n]+)", line (\d+)(?:,|\s|$)/.exec(text);
  const common = traceback ? undefined : /^\s*(.+?):(\d+)(?::(\d+))?(?::|\s|$)/.exec(text);
  const match = traceback ?? common;
  if (!match) return undefined;
  let path = match[1].trim();
  if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
  if (
    !path ||
    path.startsWith("<") ||
    path.includes("://") ||
    // eslint-disable-next-line no-control-regex -- Reject literal terminal controls in filenames.
    /[\u0000-\u001f\u007f-\u009f]/.test(path)
  )
    return undefined;
  const line = Number(match[2]);
  const column = traceback ? 1 : Number(match[3] ?? 1);
  if (!Number.isSafeInteger(line) || line < 1 || !Number.isSafeInteger(column) || column < 1)
    return undefined;
  return { path, line, column };
}

/** One instance per immutable run. Streams never share partial lines or ANSI state. */
export class DiagnosticStream {
  private streams = {
    stdout: { ansi: new AnsiMatchingView(), pending: "", oversized: false },
    stderr: { ansi: new AnsiMatchingView(), pending: "", oversized: false },
  };
  private nextId = 0;
  private retained: RunDiagnostic[] = [];
  private keys = new Map<string, RunDiagnostic>();
  truncated = false;

  constructor(
    readonly runId: string,
    readonly maximum = 256,
  ) {}

  get diagnostics(): readonly RunDiagnostic[] {
    return this.retained;
  }

  push(chunk: string, stream: OutputStream = "stderr"): RunDiagnostic[] {
    const state = this.streams[stream];
    const added: RunDiagnostic[] = [];
    const plain = state.ansi.push(chunk);
    for (const character of plain) {
      if (character === "\n") {
        if (!state.oversized) {
          const diagnostic = this.add(state.pending.replace(/\r$/, ""), stream);
          if (diagnostic) added.push(diagnostic);
        }
        state.pending = "";
        state.oversized = false;
      } else if (!state.oversized) {
        state.pending += character;
        if (state.pending.length > 16_384) {
          state.pending = "";
          state.oversized = true;
          this.truncated = true;
        }
      }
    }
    return added;
  }

  finish(stream: OutputStream = "stderr"): RunDiagnostic[] {
    const state = this.streams[stream];
    const diagnostic = state.oversized ? undefined : this.add(state.pending, stream);
    state.pending = "";
    state.oversized = false;
    return diagnostic ? [diagnostic] : [];
  }

  private add(text: string, stream: OutputStream): RunDiagnostic | undefined {
    const parsed = parseDiagnosticLine(text);
    if (!parsed) return undefined;
    const key = JSON.stringify([stream, parsed.path, parsed.line, parsed.column, text]);
    const previous = this.keys.get(key);
    if (previous) {
      previous.repetitions += 1;
      return undefined;
    }
    const diagnostic: RunDiagnostic = {
      ...parsed,
      text,
      stream,
      runId: this.runId,
      id: `${this.runId}:diagnostic:${++this.nextId}`,
      repetitions: 1,
    };
    if (this.retained.length >= Math.max(1, Math.min(this.maximum, 1024))) {
      const removed = this.retained.shift()!;
      for (const [oldKey, value] of this.keys) if (value === removed) this.keys.delete(oldKey);
      this.truncated = true;
    }
    this.keys.set(key, diagnostic);
    this.retained.push(diagnostic);
    return diagnostic;
  }
}
