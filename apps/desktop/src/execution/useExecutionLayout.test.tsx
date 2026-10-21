import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useExecutionLayout } from "./useExecutionLayout";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("measures the allocated container rather than the outer window and disconnects", () => {
  let measured = 1180;
  let notify!: () => void;
  const disconnect = vi.fn();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => ({ width: measured }) as DOMRect,
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        notify = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  function Fixture() {
    const l = useExecutionLayout(640);
    return (
      <div ref={l.ref} data-testid="geometry">
        {JSON.stringify({ width: l.width, max: l.maximumWidth, stacked: l.stacked })}
      </div>
    );
  }
  const mounted = render(<Fixture />);
  expect(screen.getByTestId("geometry")).toHaveTextContent(
    '{"width":540,"max":540,"stacked":false}',
  );
  act(() => {
    measured = 786;
    notify();
  });
  expect(screen.getByTestId("geometry")).toHaveTextContent('"stacked":true');
  act(() => {
    measured = 940;
    notify();
  });
  expect(screen.getByTestId("geometry")).toHaveTextContent(
    '{"width":300,"max":300,"stacked":false}',
  );
  act(() => {
    measured = 1480;
    notify();
  });
  expect(screen.getByTestId("geometry")).toHaveTextContent(
    '{"width":640,"max":640,"stacked":false}',
  );
  mounted.unmount();
  expect(disconnect).toHaveBeenCalledOnce();
});
