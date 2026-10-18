import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GraphCanvas } from "../GraphCanvas";
import { IssueGraphCanvas } from "../../../issues/IssueGraphCanvas";
import { FunctionTabsProvider, useFunctionTabs } from "../../../app/FunctionTabs";

function Canvases() {
  const tabs = useFunctionTabs();
  return (
    <>
      <button onClick={tabs.openIssues}>Issues</button>
      <button onClick={tabs.activateIde}>IDE</button>
      <div hidden={tabs.activeView !== "ide"}>
        <GraphCanvas
          graph={{
            rootNodeId: "repo",
            targetId: "repo",
            level: "repo",
            nodes: [],
            edges: [],
            breadcrumbs: [],
            truncated: false,
          }}
          graphFilters={{ includeCalls: true, includeDefines: true, includeImports: true }}
          graphSettings={{ includeExternalDependencies: false }}
          highlightGraphPath={false}
          showEdgeLabels={false}
          onSelectNode={vi.fn()}
          onActivateNode={vi.fn()}
          onInspectNode={vi.fn()}
          onSelectBreadcrumb={vi.fn()}
          onSelectLevel={vi.fn()}
          onToggleGraphFilter={vi.fn()}
          onToggleGraphSetting={vi.fn()}
          onToggleGraphPathHighlight={vi.fn()}
          onToggleEdgeLabels={vi.fn()}
          onNavigateOut={vi.fn()}
          onClearSelection={vi.fn()}
        />
      </div>
      <div hidden={tabs.activeView !== "issues"}>
        <IssueGraphCanvas
          graph={{ namespace: "synthetic", nodes: [], edges: [], partial: false }}
          onSelect={vi.fn()}
        />
      </div>
    </>
  );
}
const viewport = (surface: Element) => {
  const transform = surface.querySelector<HTMLElement>(".react-flow__viewport")!.style.transform;
  const numbers = transform.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/g)!.map(Number);
  return { x: numbers[0], y: numbers[1], zoom: numbers[2] };
};
function wheel(surface: Element, deltaY: number, timeStamp: number, extras: WheelEventInit = {}) {
  const event = new WheelEvent("wheel", {
    deltaY,
    clientX: 300,
    clientY: 200,
    bubbles: true,
    cancelable: true,
    ...extras,
  });
  Object.defineProperty(event, "timeStamp", { value: timeStamp });
  fireEvent(surface.querySelector(".react-flow__pane")!, event);
  return event;
}
beforeEach(() => {
  for (const property of ["offsetWidth", "clientWidth"] as const)
    vi.spyOn(HTMLElement.prototype, property, "get").mockReturnValue(800);
  for (const property of ["offsetHeight", "clientHeight"] as const)
    vi.spyOn(HTMLElement.prototype, property, "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 800,
    bottom: 600,
    width: 800,
    height: 600,
    toJSON: () => ({}),
  });
});
afterEach(() => vi.restoreAllMocks());
describe("actual React Flow event-to-viewport boundary in both consumers", () => {
  it.each(["ide", "issues"])(
    "routes wheel, pan, pinch and modifier once in %s; isolates hidden graph",
    async (graph) => {
      const ui = render(
        <FunctionTabsProvider>
          <Canvases />
        </FunctionTabsProvider>,
      );
      if (graph === "issues") fireEvent.click(ui.getByText("Issues", { exact: true }));
      const surfaces = ui.container.querySelectorAll(".react-flow");
      const surface = surfaces[graph === "ide" ? 0 : 1],
        other = surfaces[graph === "ide" ? 1 : 0];
      await waitFor(() => expect(surface.querySelector(".react-flow__viewport")).toBeTruthy());
      const start = viewport(surface),
        hidden = viewport(other);
      expect(wheel(surface, 100, 0).defaultPrevented).toBe(true);
      await waitFor(() => expect(viewport(surface).zoom).toBeCloseTo(start.zoom * Math.exp(-0.2)));
      const zoomed = viewport(surface);
      expect((300 - zoomed.x) / zoomed.zoom).toBeCloseTo((300 - start.x) / start.zoom);
      wheel(surface, 8, 300, { deltaX: 4 });
      await waitFor(() => expect(viewport(surface).x).toBeCloseTo(zoomed.x - 4));
      expect(viewport(surface).zoom).toBe(zoomed.zoom);
      wheel(surface, -5, 600, { ctrlKey: true });
      await waitFor(() => expect(viewport(surface).zoom).toBeGreaterThan(zoomed.zoom));
      const pinched = viewport(surface);
      wheel(surface, 10, 620); // released modifier inertia is ignored
      expect(viewport(surface)).toEqual(pinched);
      wheel(surface, 100, 900, { metaKey: true, ctrlKey: true });
      await waitFor(() => expect(viewport(surface).zoom).toBeLessThan(pinched.zoom));
      wheel(other, 100, 1000);
      expect(viewport(other)).toEqual(hidden);
      const beforeControl = viewport(surface);
      fireEvent.wheel(surface.querySelector("select")!, { deltaY: 100 });
      expect(viewport(surface)).toEqual(beforeControl);
      fireEvent.click(ui.getByText(graph === "ide" ? "Issues" : "IDE", { exact: true }));
      wheel(surface, -100, 1300);
      expect(viewport(surface)).toEqual(beforeControl);
    },
  );
  it("deduplicates WebKit gesture + wheel and removes ownership on unmount", async () => {
    const ui = render(
      <FunctionTabsProvider>
        <Canvases />
      </FunctionTabsProvider>,
    );
    const surface = ui.container.querySelector(".react-flow")!;
    await waitFor(() => expect(surface.querySelector(".react-flow__viewport")).toBeTruthy());
    const start = viewport(surface);
    const gesture = (type: string, scale: number, timeStamp: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        scale: { value: scale },
        clientX: { value: 300 },
        clientY: { value: 200 },
        timeStamp: { value: timeStamp },
      });
      fireEvent(surface.querySelector(".react-flow__pane")!, event);
    };
    gesture("gesturestart", 1, 0);
    gesture("gesturechange", 1.1, 10);
    await waitFor(() => expect(viewport(surface).zoom).toBeCloseTo(start.zoom * 1.1));
    const pinched = viewport(surface);
    wheel(surface, -100, 11, { ctrlKey: true });
    expect(viewport(surface)).toEqual(pinched);
    gesture("gestureend", 1.1, 20);
    wheel(surface, -100, 30, { ctrlKey: true });
    expect(viewport(surface)).toEqual(pinched);
    const removed = vi.spyOn(surface, "removeEventListener");
    ui.unmount();
    expect(removed).toHaveBeenCalledWith("wheel", expect.any(Function), true);
    wheel(surface, 100, 400);
    expect(viewport(surface)).toEqual(pinched);
  });
});
