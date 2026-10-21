import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { RunOutputNavigation } from "./RunOutputNavigation";
import type { ExecutionSnapshot } from "./adapter";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
afterEach(() => {
  cleanup();
  vi.mocked(invoke).mockClear();
});
const context = {
  contextId: "owned-run",
  repoPath: "/fixture",
  generation: "owned-session",
  trustRevision: 1,
  trusted: true,
};
const url = "http://localhost:43111/owned-output";
const snapshot: ExecutionSnapshot = {
  id: "owned-run",
  kind: "run",
  state: "exited",
  exitCode: 0,
  cleanupConfirmed: true,
  outputComplete: true,
  sequence: 1,
  truncated: false,
  chunks: [{ sequence: 1, stream: "stdout", data: [...new TextEncoder().encode(url + "\n")] }],
};

describe("#93 captured Run Output browser callback", () => {
  it("rechecks the live revocation latch before the actual native browser call without requiring a render", async () => {
    let trusted = true;
    const canActivateBrowser = vi.fn(() => trusted);
    const onError = vi.fn();
    render(
      <RunOutputNavigation
        snapshot={snapshot}
        context={context}
        cwd="/fixture"
        preparedSource={{ repoPath: "/fixture", files: [], indexedSymbols: [] }}
        canActivateBrowser={canActivateBrowser}
        onError={onError}
      />,
    );
    const capturedButton = screen.getByRole("button", { name: url });
    trusted = false;
    await act(async () => {
      fireEvent.click(capturedButton);
      await Promise.resolve();
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(canActivateBrowser).toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it("positive control opens a deliberately clicked owned link while the live gate allows it", async () => {
    render(
      <RunOutputNavigation
        snapshot={snapshot}
        context={context}
        cwd="/fixture"
        preparedSource={{ repoPath: "/fixture", files: [], indexedSymbols: [] }}
        canActivateBrowser={() => true}
        onError={vi.fn()}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: url }));
      await Promise.resolve();
    });
    expect(invoke).toHaveBeenCalledExactlyOnceWith("execution_open_loopback", { context, url });
  });
});
