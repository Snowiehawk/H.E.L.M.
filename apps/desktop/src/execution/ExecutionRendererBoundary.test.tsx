import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ExecutionRendererBoundary } from "./ExecutionRendererBoundary";

it("keeps native cleanup controls usable after terminal renderer failure", () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const close = vi.fn();
  function FailedRenderer(): never {
    throw new Error("chunk load failed");
  }
  try {
    render(
      <section>
        <button onClick={close}>Close session</button>
        <ExecutionRendererBoundary>
          <FailedRenderer />
        </ExecutionRendererBoundary>
      </section>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Terminal display is unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Close session" }));
    expect(close).toHaveBeenCalledOnce();
  } finally {
    consoleError.mockRestore();
  }
});
