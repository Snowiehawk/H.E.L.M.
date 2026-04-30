import { describe, expect, it } from "vitest";
import type { EditableNodeSource, FlowFunctionInput, GraphNodeDto } from "../../../lib/adapter";
import {
  buildBlueprintInspectorViewModel,
  editableEditorAriaLabel,
  editableEditorTitle,
  graphActionById,
  sortedFlowFunctionInputs,
  sortedUniqueDestinationModulePaths,
  structuralActionsLockedReason,
} from "./viewModel";

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

describe("BlueprintInspector view model helpers", () => {
  it("labels editable source surfaces by node kind", () => {
    expect(editableEditorTitle("module")).toBe("Module source");
    expect(editableEditorTitle("class")).toBe("Class source");
    expect(editableEditorTitle("variable")).toBe("Variable source");
    expect(editableEditorTitle("function")).toBe("Function source");

    expect(editableEditorAriaLabel("module")).toBe("Module source editor");
    expect(editableEditorAriaLabel("class")).toBe("Class source editor");
    expect(editableEditorAriaLabel("variable")).toBe("Variable source editor");
    expect(editableEditorAriaLabel("function")).toBe("Function source editor");
  });

  it("sorts destination modules and flow inputs deterministically", () => {
    const inputs: FlowFunctionInput[] = [
      {
        id: "flowinput:symbol:service:run:z",
        name: "zeta",
        index: 1,
        kind: "positional_or_keyword",
      },
      {
        id: "flowinput:symbol:service:run:a",
        name: "alpha",
        index: 0,
        kind: "positional_or_keyword",
      },
      {
        id: "flowinput:symbol:service:run:b",
        name: "beta",
        index: 0,
        kind: "positional_or_keyword",
      },
    ];

    expect(sortedUniqueDestinationModulePaths(["z.py", "a.py", "z.py"])).toEqual(["a.py", "z.py"]);
    expect(sortedFlowFunctionInputs(inputs).map((input) => input.name)).toEqual([
      "alpha",
      "beta",
      "zeta",
    ]);
  });

  it("prioritizes structural action lock reasons", () => {
    expect(
      structuralActionsLockedReason({
        dirty: true,
        draftStale: true,
        isSavingSource: true,
      }),
    ).toMatch(/current source save/i);
    expect(
      structuralActionsLockedReason({
        dirty: true,
        draftStale: true,
        isSavingSource: false,
      }),
    ).toMatch(/stale inline draft/i);
    expect(
      structuralActionsLockedReason({
        dirty: true,
        isSavingSource: false,
      }),
    ).toMatch(/inline source edits/i);
  });

  it("derives context and action visibility without mutating inputs", () => {
    const renameAction = {
      actionId: "rename_symbol",
      label: "Rename",
      enabled: true,
      payload: {},
    };
    const selectedNode = buildNode({
      metadata: { relative_path: "calculator.py", top_level: false },
      availableActions: [renameAction],
    });
    const editableSource = buildEditableSource({
      editable: false,
      reason: "Nested symbol editing is not supported.",
    });

    const viewModel = buildBlueprintInspectorViewModel({
      selectedNode,
      editableSource,
      editableSourceLoading: false,
      draftSource: editableSource.content,
      isSavingSource: false,
      destinationModulePaths: ["z.py", "a.py", "z.py"],
      hasStructuralEditHandler: true,
    });

    expect(graphActionById(selectedNode, "rename_symbol")).toBe(renameAction);
    expect(viewModel.inspectorTitle).toBe("calculate");
    expect(viewModel.nodePath).toBe("calculator.py");
    expect(viewModel.topLevel).toBe(false);
    expect(viewModel.renameAction).toBe(renameAction);
    expect(viewModel.structuralActionsVisible).toBe(true);
    expect(viewModel.sortedDestinationModulePaths).toEqual(["a.py", "z.py"]);
  });
});
