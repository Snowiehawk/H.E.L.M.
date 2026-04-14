import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BlueprintInspector } from "./BlueprintInspector";
import type { EditableNodeSource, GraphNodeDto, SourceRange } from "../../lib/adapter";

vi.mock("../editor/InspectorCodeSurface", () => ({
  InspectorCodeSurface: ({
    ariaLabel,
    className,
    dataTestId,
    highlightRange,
    readOnly,
    value,
  }: {
    ariaLabel: string;
    className?: string;
    dataTestId?: string;
    highlightRange?: SourceRange;
    readOnly: boolean;
    value: string;
  }) => (
    <div
      aria-label={ariaLabel}
      className={className}
      data-highlight-end-line={highlightRange?.endLine}
      data-highlight-start-line={highlightRange?.startLine}
      data-read-only={readOnly ? "true" : "false"}
      data-testid={dataTestId}
    >
      {value}
    </div>
  ),
}));

function buildNode(overrides: Partial<GraphNodeDto> = {}): GraphNodeDto {
  return {
    id: "node:calculate",
    kind: "function",
    label: "calculate",
    subtitle: "calculator.py",
    x: 0,
    y: 0,
    metadata: {},
    availableActions: [],
    ...overrides,
  };
}

function buildEditableSource(overrides: Partial<EditableNodeSource> = {}): EditableNodeSource {
  return {
    targetId: "node:calculate",
    title: "calculate",
    path: "calculator.py",
    startLine: 20,
    endLine: 31,
    content: "def calculate(a, b):\n    return a + b\n",
    editable: true,
    nodeKind: "function",
    ...overrides,
  };
}

describe("BlueprintInspector", () => {
  it("renders the inline editor for editable function nodes", () => {
    render(
      <BlueprintInspector
        selectedNode={buildNode()}
        editableSource={buildEditableSource()}
        editableSourceLoading={false}
        isSavingSource={false}
        onClose={vi.fn()}
        onDismissSource={vi.fn()}
        onEditorStateChange={vi.fn()}
        onSaveSource={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: /Declaration editor/i })).toBeInTheDocument();
    expect(screen.getByTestId("inspector-inline-editor")).toHaveAttribute("data-read-only", "false");
    expect(screen.getByLabelText(/Function source editor/i)).toHaveTextContent("def calculate");
  });

  it("renders the inline editor for editable class nodes", () => {
    render(
      <BlueprintInspector
        selectedNode={buildNode({ kind: "class", label: "GraphSummary" })}
        editableSource={buildEditableSource({
          nodeKind: "class",
          title: "GraphSummary",
          content: "class GraphSummary:\n    repo_path: str\n",
        })}
        editableSourceLoading={false}
        isSavingSource={false}
        onClose={vi.fn()}
        onDismissSource={vi.fn()}
        onEditorStateChange={vi.fn()}
        onSaveSource={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: /Declaration editor/i })).toBeInTheDocument();
    expect(screen.getByTestId("inspector-inline-editor")).toHaveAttribute("data-read-only", "false");
    expect(screen.getByLabelText(/Class source editor/i)).toHaveTextContent("class GraphSummary");
  });

  it("shows read-only source immediately for inspectable nodes that are not inline editable", () => {
    render(
      <BlueprintInspector
        selectedNode={buildNode({ kind: "variable", label: "repo_path" })}
        editableSource={buildEditableSource({
          editable: false,
          nodeKind: "variable",
          title: "repo_path",
          content: "repo_path: str\n",
          reason: "Class attribute declarations are not inline editable yet.",
        })}
        editableSourceLoading={false}
        isSavingSource={false}
        onClose={vi.fn()}
        onDismissSource={vi.fn()}
        onEditorStateChange={vi.fn()}
        onSaveSource={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: /Code details/i })).toBeInTheDocument();
    expect(screen.getByTestId("inspector-readonly-source")).toHaveAttribute("data-read-only", "true");
    expect(screen.getByLabelText(/Read-only variable source/i)).toHaveTextContent("repo_path: str");
    expect(screen.getByText(/Class attribute declarations are not inline editable yet\./i)).toBeInTheDocument();
  });

  it("passes the selected flow highlight range through to the source surface", () => {
    render(
      <BlueprintInspector
        selectedNode={buildNode()}
        editableSource={buildEditableSource()}
        editableSourceLoading={false}
        highlightRange={{ startLine: 21, endLine: 21 }}
        isSavingSource={false}
        onClose={vi.fn()}
        onDismissSource={vi.fn()}
        onEditorStateChange={vi.fn()}
        onSaveSource={vi.fn()}
      />,
    );

    expect(screen.getByTestId("inspector-inline-editor")).toHaveAttribute("data-highlight-start-line", "21");
    expect(screen.getByTestId("inspector-inline-editor")).toHaveAttribute("data-highlight-end-line", "21");
  });

  it("marks stale inline drafts as reload-only after outside file changes", () => {
    render(
      <BlueprintInspector
        selectedNode={buildNode()}
        editableSource={buildEditableSource()}
        editableSourceLoading={false}
        draftStale
        isSavingSource={false}
        onClose={vi.fn()}
        onDismissSource={vi.fn()}
        onEditorStateChange={vi.fn()}
        onSaveSource={vi.fn()}
      />,
    );

    expect(screen.getByText(/Draft is stale/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Reload from Disk/i })).toBeEnabled();
  });
});
