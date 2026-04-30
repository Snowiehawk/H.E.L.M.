import type {
  EditableNodeSource,
  FlowFunctionInput,
  GraphActionDto,
  GraphNodeDto,
  RevealedSource,
  SymbolDetails,
} from "../../../lib/adapter";
import { isInspectableGraphNodeKind } from "../../../lib/adapter";
import { inferInspectorLanguage } from "../../editor/inspectorLanguage";
import { metadataBoolean, relativePathForNode, selectionSummary } from "../blueprintInspectorUtils";
import type { InspectorStructuralActions } from "./types";

export type BlueprintInspectorViewModel = InspectorStructuralActions & {
  selectedRelativePath?: string;
  contextRelativePath?: string;
  selectedSummary?: string;
  contextSummary?: string;
  inspectorTitle: string;
  inspectorKind?: GraphNodeDto["kind"];
  moduleRelativePath?: string;
  nodePath?: string;
  contextTargetId?: string;
  sourceLanguage: string;
  editableNodeKind?: GraphNodeDto["kind"];
  canEditInline: boolean;
  dirty: boolean;
  topLevel?: boolean;
  structuralActionsVisible: boolean;
  structuralActionsLockedReason: string | null;
  structuralActionsLocked: boolean;
  sortedDestinationModulePaths: string[];
  inspectorClassName: string;
  sourceSectionVisible: boolean;
  contextSectionVisible: boolean;
  sortedFlowFunctionInputs: FlowFunctionInput[];
  flowInputsVisible: boolean;
};

export function graphActionById(
  node: GraphNodeDto | undefined,
  actionId: string,
): GraphActionDto | undefined {
  return node?.availableActions.find((action) => action.actionId === actionId);
}

export function editableEditorTitle(nodeKind: GraphNodeDto["kind"] | undefined) {
  if (nodeKind === "module") {
    return "Module source";
  }
  if (nodeKind === "class") {
    return "Class source";
  }
  if (nodeKind === "variable") {
    return "Variable source";
  }
  return "Function source";
}

export function editableEditorAriaLabel(nodeKind: GraphNodeDto["kind"] | undefined) {
  if (nodeKind === "module") {
    return "Module source editor";
  }
  if (nodeKind === "class") {
    return "Class source editor";
  }
  if (nodeKind === "variable") {
    return "Variable source editor";
  }
  return "Function source editor";
}

export function sortedUniqueDestinationModulePaths(paths: string[] | undefined) {
  return [...new Set(paths ?? [])].sort((left, right) => left.localeCompare(right));
}

export function sortedFlowFunctionInputs(inputs: FlowFunctionInput[] | undefined) {
  return [...(inputs ?? [])].sort(
    (left, right) => left.index - right.index || left.name.localeCompare(right.name),
  );
}

export function structuralActionsLockedReason({
  dirty,
  draftStale,
  isSavingSource,
}: {
  dirty: boolean;
  draftStale?: boolean;
  isSavingSource: boolean;
}) {
  if (isSavingSource) {
    return "Wait for the current source save to finish before running structural actions.";
  }
  if (draftStale) {
    return "Reload or cancel the stale inline draft before running structural actions.";
  }
  if (dirty) {
    return "Save or cancel inline source edits before running structural actions.";
  }
  return null;
}

export function buildBlueprintInspectorViewModel({
  selectedNode,
  sourceContextNode,
  moduleActionNode,
  destinationModulePaths,
  symbol,
  editableSource,
  editableSourceLoading,
  editableSourceError,
  draftSource,
  draftStale,
  revealedSource,
  isSavingSource,
  flowFunctionInputs,
  hasStructuralEditHandler,
}: {
  selectedNode?: GraphNodeDto;
  sourceContextNode?: GraphNodeDto;
  moduleActionNode?: GraphNodeDto;
  destinationModulePaths?: string[];
  symbol?: SymbolDetails;
  editableSource?: EditableNodeSource;
  editableSourceLoading: boolean;
  editableSourceError?: string | null;
  draftSource: string;
  draftStale?: boolean;
  revealedSource?: RevealedSource;
  isSavingSource: boolean;
  flowFunctionInputs?: FlowFunctionInput[];
  hasStructuralEditHandler: boolean;
}): BlueprintInspectorViewModel {
  const selectedRelativePath = relativePathForNode(selectedNode);
  const contextRelativePath = relativePathForNode(sourceContextNode);
  const selectedSummary = selectionSummary(selectedNode);
  const contextSummary =
    selectionSummary(sourceContextNode) ?? symbol?.qualname ?? editableSource?.path;
  const inspectorTitle =
    selectedNode?.label ??
    sourceContextNode?.label ??
    symbol?.name ??
    editableSource?.title ??
    "Current context";
  const inspectorKind = selectedNode?.kind ?? editableSource?.nodeKind ?? sourceContextNode?.kind;
  const moduleRelativePath = relativePathForNode(moduleActionNode);
  const nodePath =
    editableSource?.path ?? selectedRelativePath ?? contextRelativePath ?? symbol?.filePath;
  const contextTargetId =
    selectedNode?.id ??
    editableSource?.targetId ??
    revealedSource?.targetId ??
    sourceContextNode?.id ??
    symbol?.nodeId;
  const sourceLanguage = inferInspectorLanguage({
    editablePath: editableSource?.path,
    selectedRelativePath: selectedRelativePath ?? contextRelativePath,
    symbolFilePath: symbol?.filePath,
    metadata: selectedNode?.metadata ?? sourceContextNode?.metadata,
  });
  const editableNodeKind =
    editableSource?.nodeKind ?? selectedNode?.kind ?? sourceContextNode?.kind;
  const canEditInline = Boolean(editableSource?.editable);
  const dirty = canEditInline && draftSource !== editableSource?.content;
  const renameAction = graphActionById(selectedNode, "rename_symbol");
  const deleteAction = graphActionById(selectedNode, "delete_symbol");
  const moveAction = graphActionById(selectedNode, "move_symbol");
  const addImportAction = graphActionById(moduleActionNode, "add_import");
  const removeImportAction = graphActionById(moduleActionNode, "remove_import");
  const lockedReason = structuralActionsLockedReason({
    dirty,
    draftStale,
    isSavingSource,
  });
  const sourceSectionVisible = Boolean(
    editableSourceLoading ||
    editableSourceError ||
    editableSource ||
    (selectedNode && isInspectableGraphNodeKind(selectedNode.kind)),
  );
  const sortedInputs = sortedFlowFunctionInputs(flowFunctionInputs);

  return {
    selectedRelativePath,
    contextRelativePath,
    selectedSummary,
    contextSummary,
    inspectorTitle,
    inspectorKind,
    moduleRelativePath,
    nodePath,
    contextTargetId,
    sourceLanguage,
    editableNodeKind,
    canEditInline,
    dirty,
    topLevel: metadataBoolean(selectedNode, "top_level"),
    renameAction,
    deleteAction,
    moveAction,
    addImportAction,
    removeImportAction,
    structuralActionsVisible: Boolean(
      hasStructuralEditHandler &&
      (renameAction || deleteAction || moveAction || addImportAction || removeImportAction),
    ),
    structuralActionsLockedReason: lockedReason,
    structuralActionsLocked: Boolean(lockedReason),
    sortedDestinationModulePaths: sortedUniqueDestinationModulePaths(destinationModulePaths),
    inspectorClassName: `pane pane--inspector blueprint-inspector${revealedSource ? " blueprint-inspector--with-revealed-source" : ""}`,
    sourceSectionVisible,
    contextSectionVisible: Boolean(
      !selectedNode && (sourceContextNode || sourceSectionVisible || symbol),
    ),
    sortedFlowFunctionInputs: sortedInputs,
    flowInputsVisible: selectedNode?.kind === "entry" && Boolean(flowFunctionInputs),
  };
}
