import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  BlueprintInspectorDrawer,
  clampBlueprintInspectorDrawerHeight,
} from "./BlueprintInspectorDrawer";

describe("BlueprintInspectorDrawer", () => {
  it("clamps drawer height for desktop and narrow layouts", () => {
    expect(clampBlueprintInspectorDrawerHeight(120, 900, false)).toBeGreaterThanOrEqual(280);
    expect(clampBlueprintInspectorDrawerHeight(1200, 900, false)).toBeLessThanOrEqual(558);
    expect(clampBlueprintInspectorDrawerHeight(120, 520, true)).toBeGreaterThanOrEqual(220);
    expect(clampBlueprintInspectorDrawerHeight(900, 520, true)).toBeLessThanOrEqual(374);
  });

  it("follows the measured pane width while the viewport and mounted content stay unchanged", () => {
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(980);
    let resize: (() => void) | undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    const viewport = window.innerWidth;
    try {
      render(
        <BlueprintInspectorDrawer
          drawerHeight={360}
          mode="expanded"
          showDismiss
          statusLabel="Synced"
          subtitle="lf_sample.py"
          title="lf_sample"
          onClose={vi.fn()}
          onCollapse={vi.fn()}
          onExpand={vi.fn()}
          onHeightChange={vi.fn()}
        >
          <textarea aria-label="retained source" defaultValue="unsaved café" />
        </BlueprintInspectorDrawer>,
      );
      const drawer = screen.getByTestId("blueprint-inspector-drawer");
      const editor = screen.getByRole("textbox", { name: "retained source" });
      expect(drawer).toHaveAttribute("data-narrow-layout", "false");
      width.mockReturnValue(380);
      act(() => resize?.());
      expect(drawer).toHaveAttribute("data-narrow-layout", "true");
      expect(screen.getByRole("textbox", { name: "retained source" })).toBe(editor);
      expect(editor).toHaveValue("unsaved café");
      width.mockReturnValue(980);
      act(() => resize?.());
      expect(drawer).toHaveAttribute("data-narrow-layout", "false");
      expect(screen.getByRole("textbox", { name: "retained source" })).toBe(editor);
      expect(window.innerWidth).toBe(viewport);
    } finally {
      width.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("renders a collapsed peek bar with expand and close controls", () => {
    const onExpand = vi.fn();
    const onClose = vi.fn();
    const onOpenFlow = vi.fn();

    render(
      <BlueprintInspectorDrawer
        actions={[
          {
            id: "open-flow",
            label: "Open flow",
            helpId: "inspector.open-flow",
            onClick: onOpenFlow,
          },
        ]}
        drawerHeight={360}
        mode="collapsed"
        showDismiss
        statusLabel="Unsaved"
        statusTone="accent"
        subtitle="expression_parser.py"
        title="to_rpn"
        onClose={onClose}
        onCollapse={vi.fn()}
        onExpand={onExpand}
        onHeightChange={vi.fn()}
      >
        <div>Inspector content</div>
      </BlueprintInspectorDrawer>,
    );

    expect(screen.getByText("to_rpn")).toBeInTheDocument();
    expect(screen.getByText("Unsaved")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open flow" })).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("blueprint-inspector-drawer-toggle"));
    expect(onExpand).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Open flow" }));
    expect(onOpenFlow).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("blueprint-inspector-drawer-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("collapses on rail click and reports resized heights while expanded", () => {
    const onCollapse = vi.fn();
    const onHeightChange = vi.fn();

    render(
      <BlueprintInspectorDrawer
        drawerHeight={320}
        mode="expanded"
        statusLabel="function"
        subtitle="expression_parser.py"
        title="to_rpn"
        onClose={vi.fn()}
        onCollapse={onCollapse}
        onExpand={vi.fn()}
        onHeightChange={onHeightChange}
      >
        <div>Inspector content</div>
      </BlueprintInspectorDrawer>,
    );

    const rail = screen.getByTestId("blueprint-inspector-drawer-toggle");
    fireEvent.click(rail);
    expect(onCollapse).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(rail, { clientY: 300 });
    fireEvent.pointerMove(window, { clientY: 240 });
    fireEvent.pointerUp(window);

    expect(onHeightChange).toHaveBeenCalledWith(expect.any(Number));
  });
});
