import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphView } from "../../lib/adapter";
import { GraphToolbar } from "./GraphToolbar";

const baseGraph: GraphView = {
  rootNodeId: "repo:/workspace/project",
  targetId: "module:helm.ui.graph",
  level: "module",
  nodes: [],
  edges: [],
  breadcrumbs: [
    {
      nodeId: "repo:/workspace/project",
      level: "repo",
      label: "project",
    },
  ],
  focus: {
    targetId: "module:helm.ui.graph",
    level: "module",
    label: "helm.ui.graph",
    availableLevels: ["repo", "module", "symbol"],
  },
  truncated: false,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderMeasuredToolbar(observerAvailable = true) {
  const size = { width: 1000, height: 600, toolbarWidth: 320, toolbarHeight: 52 };
  const observers = new Set<{ callback: ResizeObserverCallback; targets: Set<Element> }>();
  class ControlledResizeObserver {
    targets = new Set<Element>();
    constructor(public callback: ResizeObserverCallback) {
      observers.add(this);
    }
    observe(target: Element) {
      this.targets.add(target);
    }
    disconnect() {
      observers.delete(this);
    }
  }
  vi.stubGlobal("ResizeObserver", observerAvailable ? ControlledResizeObserver : undefined);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => size.width);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => size.height);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(() => size.toolbarWidth);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
    () => size.toolbarHeight,
  );
  const view = render(
    <div data-testid="toolbar-container">
      <GraphToolbar
        graph={baseGraph}
        graphFilters={{ includeCalls: true, includeDefines: true, includeImports: true }}
        graphSettings={{ includeExternalDependencies: false }}
        highlightGraphPath={false}
        showEdgeLabels={false}
        canUndoLayout={false}
        onSelectLevel={vi.fn()}
        onDeclutter={vi.fn()}
        onFitView={vi.fn()}
        onToggleGraphFilter={vi.fn()}
        onToggleGraphSetting={vi.fn()}
        onToggleGraphPathHighlight={vi.fn()}
        onToggleEdgeLabels={vi.fn()}
        onUndoLayout={vi.fn()}
      />
    </div>,
  );
  const toolbar = view.container.querySelector(".graph-toolbar") as HTMLElement;
  const notify = () =>
    act(() => {
      for (const observer of observers)
        observer.callback([], observer as unknown as ResizeObserver);
    });
  return { ...view, toolbar, size, observers, notify };
}

describe("GraphToolbar", () => {
  it.each([833, 600, 480])(
    "reanchors without a graph change when zoom/resize shrinks the container to %ipx",
    (width) => {
      const view = renderMeasuredToolbar();
      expect(view.toolbar.style.left).toBe("664px");
      view.size.width = width;
      view.notify();
      expect(view.toolbar.style.left).toBe(`${width - 320 - 16}px`);
      view.size.width = 1000;
      view.notify();
      expect(view.toolbar.style.left).toBe("664px");
    },
  );

  it("preserves a dragged position until resize or toolbar growth requires clamping", () => {
    const view = renderMeasuredToolbar();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Move graph controls" }), {
      clientX: 664,
      clientY: 16,
    });
    fireEvent.pointerMove(window, { clientX: 400, clientY: 400 });
    fireEvent.pointerUp(window);
    expect(view.toolbar.style.left).toBe("400px");
    expect(view.toolbar.style.top).toBe("400px");
    view.size.width = 800;
    view.notify();
    expect(view.toolbar.style.left).toBe("400px");
    view.size.width = 600;
    view.size.height = 300;
    view.notify();
    expect(view.toolbar.style.left).toBe("264px");
    expect(view.toolbar.style.top).toBe("232px");
    view.size.toolbarHeight = 180;
    view.notify();
    expect(view.toolbar.style.top).toBe("104px");
    view.size.width = 1000;
    view.notify();
    expect(view.toolbar.style.left).toBe("264px");
  });

  it("keeps window resize functional without ResizeObserver and removes subscriptions on unmount", () => {
    const view = renderMeasuredToolbar(false);
    view.size.width = 600;
    fireEvent(window, new Event("resize"));
    expect(view.toolbar.style.left).toBe("264px");
    const remove = vi.spyOn(window, "removeEventListener");
    view.unmount();
    expect(remove).toHaveBeenCalledWith("resize", expect.any(Function));
  });

  it("observes both container and toolbar size and disconnects on unmount", () => {
    const view = renderMeasuredToolbar();
    expect(view.observers.size).toBe(1);
    const [observer] = view.observers;
    expect(observer.targets.has(view.toolbar)).toBe(true);
    expect(observer.targets.has(screen.getByTestId("toolbar-container"))).toBe(true);
    view.unmount();
    expect(view.observers.size).toBe(0);
  });

  it("renders useful graph controls inline and forwards clicks", async () => {
    const user = userEvent.setup();
    const onToggleGraphFilter = vi.fn();
    const onToggleGraphSetting = vi.fn();
    const onDeclutter = vi.fn();
    const onUndoLayout = vi.fn();
    const onFitView = vi.fn();

    render(
      <div>
        <GraphToolbar
          graph={baseGraph}
          graphFilters={{
            includeCalls: true,
            includeDefines: true,
            includeImports: true,
          }}
          graphSettings={{
            includeExternalDependencies: false,
          }}
          highlightGraphPath={false}
          showEdgeLabels={false}
          canUndoLayout
          onSelectLevel={vi.fn()}
          onDeclutter={onDeclutter}
          onFitView={onFitView}
          onToggleGraphFilter={onToggleGraphFilter}
          onToggleGraphSetting={onToggleGraphSetting}
          onToggleGraphPathHighlight={vi.fn()}
          onToggleEdgeLabels={vi.fn()}
          onUndoLayout={onUndoLayout}
        />
      </div>,
    );

    await user.click(screen.getByRole("button", { name: "Fit view" }));
    await user.click(screen.getByRole("button", { name: /helm\.ui\.graph/i }));
    await user.click(screen.getByRole("button", { name: "Calls" }));
    await user.click(screen.getByRole("button", { name: "Declutter" }));
    await user.click(screen.getByRole("button", { name: "Undo layout" }));
    await user.click(screen.getByRole("button", { name: "External" }));

    expect(onFitView).toHaveBeenCalledTimes(1);
    expect(onToggleGraphFilter).toHaveBeenCalledWith("includeCalls");
    expect(onDeclutter).toHaveBeenCalledTimes(1);
    expect(onUndoLayout).toHaveBeenCalledTimes(1);
    expect(onToggleGraphSetting).toHaveBeenCalledWith("includeExternalDependencies");
    expect(screen.getByText("0 nodes")).toBeInTheDocument();
    expect(screen.getByText("0 edges")).toBeInTheDocument();
  });

  it("shows the editable flow input mode switch only for editable flow views", async () => {
    const user = userEvent.setup();
    const onSetFlowInputDisplayMode = vi.fn();
    const flowGraph: GraphView = {
      ...baseGraph,
      targetId: "symbol:calculator:add",
      level: "flow",
      focus: {
        targetId: "symbol:calculator:add",
        level: "flow",
        label: "add",
        availableLevels: ["symbol", "flow"],
      },
      flowState: {
        editable: true,
        syncState: "draft",
        diagnostics: [],
        document: undefined,
      },
    };

    render(
      <GraphToolbar
        graph={flowGraph}
        graphFilters={{
          includeCalls: true,
          includeDefines: true,
          includeImports: true,
        }}
        graphSettings={{
          includeExternalDependencies: false,
        }}
        flowInputDisplayMode="entry"
        highlightGraphPath
        showEdgeLabels
        canUndoLayout={false}
        onSelectLevel={vi.fn()}
        onDeclutter={vi.fn()}
        onFitView={vi.fn()}
        onToggleGraphFilter={vi.fn()}
        onToggleGraphSetting={vi.fn()}
        onSetFlowInputDisplayMode={onSetFlowInputDisplayMode}
        onToggleGraphPathHighlight={vi.fn()}
        onToggleEdgeLabels={vi.fn()}
        onUndoLayout={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /add flow view/i }));
    expect(screen.getByRole("button", { name: "Entry inputs" })).toHaveClass("is-active");
    await user.click(screen.getByRole("button", { name: "Parameters" }));

    expect(onSetFlowInputDisplayMode).toHaveBeenCalledWith("param_nodes");
  });
});
