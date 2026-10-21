import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  RunOutputNavigation as ActualRunOutputNavigation,
  type RunOutputNavigationProps,
} from "./RunOutputNavigation";
import { registerExecutionNavigation } from "./navigation";
import type { ExecutionSnapshot } from "./adapter";
import { outputText } from "./output";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
// These parser/navigation fixtures explicitly retain live browser permission.
// Revoked and missing permission are exercised by the dedicated admission join.
function RunOutputNavigation(props: Omit<RunOutputNavigationProps, "canActivateBrowser">) {
  return <ActualRunOutputNavigation {...props} canActivateBrowser={() => true} />;
}
const context = {
  contextId: "captured-context",
  repoPath: "/fixture",
  generation: "captured-session",
  trustRevision: 1,
  trusted: true,
};
const preparedSource = {
  repoPath: "/fixture",
  files: [{ relativePath: "main.py", sha256: "a".repeat(64) }],
  indexedSymbols: [],
};
const snapshot = (text: string): ExecutionSnapshot => ({
  id: "run-one",
  kind: "run",
  state: "exited",
  exitCode: 1,
  cleanupConfirmed: true,
  outputComplete: true,
  sequence: 1,
  truncated: false,
  chunks: [{ sequence: 1, stream: "stderr", data: Array.from(new TextEncoder().encode(text)) }],
});
const location = {
  relativePath: "main.py",
  line: 3,
  column: 1,
  currentHash: "a".repeat(64),
  sourceMatches: true,
};
afterEach(() => vi.mocked(invoke).mockReset());

describe("Run Output navigation", () => {
  it.each(["ValueError without a supported location\n", "main.py:0: invalid coordinate\n"])(
    "keeps unsupported output readable and marks source navigation unavailable: %s",
    (text) => {
      const value = snapshot(text);
      render(
        <>
          <pre aria-label="Raw run output">{outputText(value)}</pre>
          <RunOutputNavigation
            snapshot={value}
            context={context}
            cwd="/fixture"
            preparedSource={preparedSource}
            onError={vi.fn()}
          />
        </>,
      );
      expect(screen.getByLabelText("Raw run output").textContent).toBe(text);
      expect(screen.getByRole("status")).toHaveTextContent("Source navigation is unavailable");
      expect(invoke).not.toHaveBeenCalled();
    },
  );
  it("reconstructs UTF-8 diagnostic paths across every byte split without altering retained raw output", () => {
    const text = '\u001b[31m  File "src/Ω 🧭.py", line 3, in run\u001b[0m\r\n';
    const bytes = [...new TextEncoder().encode(text)];
    for (let split = 0; split <= bytes.length; split++) {
      const value = {
        ...snapshot(text),
        chunks: [
          { sequence: 1, stream: "stderr" as const, data: bytes.slice(0, split) },
          { sequence: 2, stream: "stderr" as const, data: bytes.slice(split) },
        ],
      };
      const view = render(
        <RunOutputNavigation
          snapshot={value}
          context={context}
          cwd="/fixture"
          preparedSource={preparedSource}
          onError={vi.fn()}
        />,
      );
      expect(screen.getByRole("button", { name: "src/Ω 🧭.py:3:1" })).toBeEnabled();
      expect(outputText(value)).toBe(text);
      view.unmount();
    }
    expect(invoke).not.toHaveBeenCalled();
  });
  it.each(["run", "context"])(
    "retires a pending click on %s replacement without locking the new output",
    async (replacement) => {
      let oldReply!: (value: unknown) => void;
      let newReply!: (value: unknown) => void;
      vi.mocked(invoke)
        .mockReturnValueOnce(
          new Promise((resolve) => {
            oldReply = resolve;
          }),
        )
        .mockReturnValueOnce(
          new Promise((resolve) => {
            newReply = resolve;
          }),
        )
        .mockResolvedValue(location);
      const navigate = vi.fn().mockResolvedValue({ status: "unmapped", reason: "Validated file." });
      const dispose = registerExecutionNavigation(navigate);
      const props = {
        snapshot: snapshot("main.py:3: error\n"),
        context,
        cwd: "/fixture",
        preparedSource,
        onError: vi.fn(),
      };
      const view = render(<RunOutputNavigation {...props} />);
      try {
        fireEvent.click(screen.getByRole("button", { name: "main.py:3:1" }));
        expect(invoke).toHaveBeenCalledTimes(1);
        const nextContext =
          replacement === "context"
            ? { ...context, contextId: "new-context", generation: "new-session" }
            : context;
        view.rerender(
          <RunOutputNavigation
            {...props}
            context={nextContext}
            snapshot={{
              ...snapshot("main.py:4: next error\n"),
              id: replacement === "run" ? "next-run" : "run-one",
            }}
          />,
        );
        expect(screen.getByRole("button", { name: "main.py:4:1" })).toBeEnabled();
        fireEvent.click(screen.getByRole("button", { name: "main.py:4:1" }));
        await act(async () => {
          oldReply(location);
        });
        expect(navigate).not.toHaveBeenCalled();
        expect(screen.getByRole("button", { name: "main.py:4:1" })).toBeDisabled();
        await act(async () => {
          newReply(location);
        });
        await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
        expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ context: nextContext }));
        expect(props.onError).not.toHaveBeenCalled();
        expect(
          vi
            .mocked(invoke)
            .mock.calls.every(([command]) => command === "execution_resolve_diagnostic"),
        ).toBe(true);
      } finally {
        oldReply(location);
        view.unmount();
        dispose();
      }
    },
  );
  it("validates a clicked diagnostic twice and retains its captured run context", async () => {
    vi.mocked(invoke).mockResolvedValue(location);
    const navigate = vi.fn().mockResolvedValue({
      status: "symbol",
      nodeId: "symbol:main:run",
      reason: "Source-matched enclosing symbol.",
    });
    const dispose = registerExecutionNavigation(navigate);
    const onError = vi.fn();
    render(
      <RunOutputNavigation
        snapshot={snapshot('  File "main.py", line 3, in run\n')}
        context={context}
        cwd="/fixture"
        preparedSource={preparedSource}
        onError={onError}
      />,
    );
    expect(invoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "main.py:3:1" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      "execution_resolve_diagnostic",
      expect.objectContaining({ context, cwd: "/fixture", expectedHash: "a".repeat(64) }),
    );
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ context, location, preparedSource }),
    );
    expect(onError).not.toHaveBeenCalled();
    dispose();
  });

  it("refused paths and unmounted pending navigation never touch the IDE", async () => {
    const navigate = vi.fn();
    const dispose = registerExecutionNavigation(navigate);
    const onError = vi.fn();
    vi.mocked(invoke).mockRejectedValueOnce(new Error("Outside workspace"));
    const first = render(
      <RunOutputNavigation
        snapshot={snapshot("outside.py:1: error\n")}
        context={context}
        cwd="/fixture"
        preparedSource={preparedSource}
        onError={onError}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "outside.py:1:1" }));
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(navigate).not.toHaveBeenCalled();
    first.unmount();
    let complete!: (value: unknown) => void;
    vi.mocked(invoke).mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const second = render(
      <RunOutputNavigation
        snapshot={snapshot("main.py:3: error\n")}
        context={context}
        cwd="/fixture"
        preparedSource={preparedSource}
        onError={onError}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "main.py:3:1" }));
    second.unmount();
    await act(async () => {
      complete(location);
    });
    expect(navigate).not.toHaveBeenCalled();
    dispose();
  });

  it("opens only an actual loopback target after a deliberate click", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    render(
      <RunOutputNavigation
        snapshot={snapshot(
          "http://localhost:3000/\n\u001b]8;;https://evil.example/\u0007Safe label\u001b]8;;\u0007\n",
        )}
        context={context}
        cwd="/fixture"
        preparedSource={preparedSource}
        onError={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "https://evil.example/" })).toBeDisabled();
    expect(invoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "http://localhost:3000/" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("execution_open_loopback", {
        context,
        url: "http://localhost:3000/",
      }),
    );
  });
});
