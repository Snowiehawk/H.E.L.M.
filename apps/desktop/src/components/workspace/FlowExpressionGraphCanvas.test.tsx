import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
});
