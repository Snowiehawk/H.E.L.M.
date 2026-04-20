import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FlowExpressionGraph, FlowInputSlot } from "../../lib/adapter";
import { FlowExpressionGraphCanvas } from "./FlowExpressionGraphCanvas";

const inputSlots: FlowInputSlot[] = [
  {
    id: "slot:a",
    nodeId: "return:add",
    slotKey: "a",
    label: "a",
    required: true,
  },
  {
    id: "slot:b",
    nodeId: "return:add",
    slotKey: "b",
    label: "b",
    required: true,
  },
  {
    id: "slot:c",
    nodeId: "return:add",
    slotKey: "c",
    label: "c",
    required: true,
  },
];

const addGraph: FlowExpressionGraph = {
  version: 1,
  rootId: "expr:operator:add",
  nodes: [
    {
      id: "expr:input:a",
      kind: "input",
      label: "a",
      payload: { name: "a", slot_id: "slot:a" },
    },
    {
      id: "expr:input:b",
      kind: "input",
      label: "b",
      payload: { name: "b", slot_id: "slot:b" },
    },
    {
      id: "expr:operator:add",
      kind: "operator",
      label: "+",
      payload: { operator: "+" },
    },
  ],
  edges: [
    {
      id: "expr-edge:expr:input:a->expr:operator:add:left",
      sourceId: "expr:input:a",
      sourceHandle: "value",
      targetId: "expr:operator:add",
      targetHandle: "left",
    },
    {
      id: "expr-edge:expr:input:b->expr:operator:add:right",
      sourceId: "expr:input:b",
      sourceHandle: "value",
      targetId: "expr:operator:add",
      targetHandle: "right",
    },
  ],
};

function mockCanvasElementRect() {
  const elementSize = function elementSize(this: HTMLElement) {
    const isHandle = this.classList?.contains("react-flow__handle");
    return {
      width: isHandle ? 12 : 640,
      height: isHandle ? 12 : 420,
    };
  };

  const clientWidthSpy = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function mockClientWidth(this: HTMLElement) {
    return elementSize.call(this).width;
  });
  const clientHeightSpy = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function mockClientHeight(this: HTMLElement) {
    return elementSize.call(this).height;
  });
  const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function mockRect(this: HTMLElement) {
    const { width, height } = elementSize.call(this);
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      width,
      height,
      toJSON: () => ({}),
    } as DOMRect;
  });

  return () => {
    clientWidthSpy.mockRestore();
    clientHeightSpy.mockRestore();
    rectSpy.mockRestore();
  };
}

function renderCanvas(overrides: Partial<Parameters<typeof FlowExpressionGraphCanvas>[0]> = {}) {
  const onGraphChange = vi.fn();
  const onSelectExpressionNode = vi.fn();
  const onNavigateOut = vi.fn();
  render(
    <FlowExpressionGraphCanvas
      diagnostics={[]}
      error={null}
      expression="a + b"
      graph={addGraph}
      inputSlots={inputSlots}
      isDraftOnly={false}
      isSaving={false}
      ownerLabel="add"
      selectedExpressionNodeId="expr:operator:add"
      onGraphChange={onGraphChange}
      onNavigateOut={onNavigateOut}
      onSelectExpressionNode={onSelectExpressionNode}
      {...overrides}
    />,
  );
  return { onGraphChange, onNavigateOut, onSelectExpressionNode };
}

describe("FlowExpressionGraphCanvas", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the nested expression graph as a main canvas, not the old popup editor", async () => {
    mockCanvasElementRect();
    renderCanvas();

    expect(await screen.findByTestId("flow-expression-graph-canvas")).toBeInTheDocument();
    expect(screen.queryByTestId("flow-expression-graph-editor")).not.toBeInTheDocument();
    expect(screen.getByText("a + b")).toBeInTheDocument();
  });

  it("marks the selected expression node distinctly from unselected nodes", async () => {
    mockCanvasElementRect();
    renderCanvas({ selectedExpressionNodeId: "expr:input:a" });

    expect(await screen.findByTestId("flow-expression-node-expr:input:a")).toHaveClass("is-selected");
    expect(screen.getByTestId("flow-expression-node-expr:input:b")).not.toHaveClass("is-selected");
    expect(screen.getByTestId("flow-expression-node-expr:operator:add")).not.toHaveClass("is-selected");
  });

  it("keeps target handle labels inside nodes with reserved label space", async () => {
    mockCanvasElementRect();
    renderCanvas({ selectedExpressionNodeId: "expr:operator:add" });

    const operatorNode = await screen.findByTestId("flow-expression-node-expr:operator:add");
    expect(operatorNode).toHaveClass("has-targets");
    expect(within(operatorNode).getByText("L")).toHaveClass("flow-expression-canvas__target-label");
    expect(within(operatorNode).getByText("R")).toHaveClass("flow-expression-canvas__target-label");
  });

  it("adds expression nodes from canvas controls", async () => {
    mockCanvasElementRect();
    const user = userEvent.setup();
    const { onGraphChange } = renderCanvas();

    await user.selectOptions(screen.getByLabelText("Input node source"), "slot:c");
    await user.click(screen.getByRole("button", { name: "Add input" }));

    await waitFor(() =>
      expect(onGraphChange).toHaveBeenCalledWith(
        expect.objectContaining({
          nodes: expect.arrayContaining([
            expect.objectContaining({
              kind: "input",
              label: "c",
              payload: expect.objectContaining({ slot_id: "slot:c" }),
            }),
          ]),
          layout: expect.objectContaining({
            nodes: expect.any(Object),
          }),
        }),
        expect.objectContaining({
          selectedExpressionNodeId: expect.stringContaining("expr:input:c"),
        }),
      ),
    );
  });

  it("opens an expression graph context menu", async () => {
    mockCanvasElementRect();
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    renderCanvas();

    const operatorNode = await screen.findByTestId("flow-expression-node-expr:operator:add");
    fireEvent.contextMenu(operatorNode, { clientX: 160, clientY: 120 });

    const menu = await screen.findByRole("menu", { name: "Expression node actions" });
    expect(within(menu).getByRole("menuitem", { name: "Delete Node" })).toBeInTheDocument();

    await user.click(within(menu).getByRole("menuitem", { name: "Copy Expression" }));

    expect(writeText).toHaveBeenCalledWith("a + b");
  });

  it("edits selected node payloads without using a source textarea", async () => {
    mockCanvasElementRect();
    const { onGraphChange } = renderCanvas();

    fireEvent.change(screen.getByLabelText("Expression operator"), {
      target: { value: "*" },
    });

    expect(screen.queryByLabelText("Return expression source")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(onGraphChange).toHaveBeenCalledWith(
        expect.objectContaining({
          nodes: expect.arrayContaining([
            expect.objectContaining({
              id: "expr:operator:add",
              label: "*",
              payload: expect.objectContaining({ operator: "*" }),
            }),
          ]),
        }),
        expect.objectContaining({
          selectedExpressionNodeId: "expr:operator:add",
        }),
      ),
    );
  });

  it("shows draft-only diagnostics for invalid local graphs", () => {
    mockCanvasElementRect();
    renderCanvas({
      diagnostics: ["Expression graph needs a root node."],
      isDraftOnly: true,
    });

    expect(screen.getAllByText("Draft only")).not.toHaveLength(0);
    expect(screen.getByText("Expression graph needs a root node.")).toBeInTheDocument();
  });

  it("activates the same Space-to-pan cursor mode as the parent graph", async () => {
    mockCanvasElementRect();
    renderCanvas();

    const canvas = await screen.findByTestId("flow-expression-graph-canvas");
    fireEvent.pointerOver(canvas);
    fireEvent.keyDown(document, { key: " ", code: "Space" });

    await waitFor(() => {
      expect(canvas).toHaveClass("is-pan-active");
      expect(document.body).toHaveClass("graph-pan-cursor-active");
    });

    fireEvent.pointerDown(canvas, { button: 0 });
    await waitFor(() => {
      expect(document.body).toHaveClass("graph-pan-cursor-dragging");
    });

    fireEvent.pointerUp(window);
    fireEvent.keyUp(document, { key: " ", code: "Space" });
    await waitFor(() => {
      expect(document.body).not.toHaveClass("graph-pan-cursor-active");
      expect(document.body).not.toHaveClass("graph-pan-cursor-dragging");
    });
  });
});
