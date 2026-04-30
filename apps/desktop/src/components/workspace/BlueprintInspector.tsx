import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { FlowFunctionInput } from "../../lib/adapter";
import { AppContextMenu, clampAppContextMenuPosition } from "../shared/AppContextMenu";
import { buildInspectorContextMenuItems } from "./BlueprintInspector/contextMenu";
import { FlowInputsPanel } from "./BlueprintInspector/FlowInputsPanel";
import { InspectorEmptyState, InspectorHeader } from "./BlueprintInspector/InspectorHeader";
import { LatestActivityPanel } from "./BlueprintInspector/LatestActivityPanel";
import { RevealedSourcePanel } from "./BlueprintInspector/RevealedSourcePanel";
import { SelectionSummaryPanel } from "./BlueprintInspector/SelectionSummaryPanel";
import { SourcePanel } from "./BlueprintInspector/SourcePanel";
import { StructuralActionsPanel } from "./BlueprintInspector/StructuralActionsPanel";
import type {
  BlueprintInspectorProps,
  FlowFunctionInputDraftState,
  InspectorContextMenuState,
} from "./BlueprintInspector/types";
import { buildBlueprintInspectorViewModel } from "./BlueprintInspector/viewModel";

export function BlueprintInspector({
  selectedNode,
  sourceContextNode,
  moduleActionNode,
  destinationModulePaths,
  symbol,
  editableSource,
  editableSourceLoading,
  editableSourceError,
  draftStale,
  revealedSource,
  lastActivity,
  isSavingSource,
  highlightRange,
  flowFunctionInputs,
  flowInputDisplayMode,
  flowInputsEditable = false,
  onApplyStructuralEdit,
  onAddFlowFunctionInput,
  onUpdateFlowFunctionInput,
  onMoveFlowFunctionInput,
  onRemoveFlowFunctionInput,
  onOpenNodeInDefaultEditor,
  onRevealNodeInFileExplorer,
  onSaveSource,
  onEditorStateChange,
  onDismissSource,
  onClose,
}: BlueprintInspectorProps) {
  const [draftSource, setDraftSource] = useState(() => editableSource?.content ?? "");
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [structuralActionError, setStructuralActionError] = useState<string | null>(null);
  const [contextActionError, setContextActionError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<InspectorContextMenuState | null>(null);
  const [pendingStructuralActionId, setPendingStructuralActionId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [moveDestinationPath, setMoveDestinationPath] = useState("");
  const [addImportModule, setAddImportModule] = useState("");
  const [addImportName, setAddImportName] = useState("");
  const [addImportAlias, setAddImportAlias] = useState("");
  const [removeImportModule, setRemoveImportModule] = useState("");
  const [flowInputDrafts, setFlowInputDrafts] = useState<
    Record<string, FlowFunctionInputDraftState>
  >({});
  const [newFlowInputName, setNewFlowInputName] = useState("");
  const [newFlowInputDefault, setNewFlowInputDefault] = useState("");
  const previousEditableTargetIdRef = useRef<string | undefined>(undefined);

  const viewModel = buildBlueprintInspectorViewModel({
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
    hasStructuralEditHandler: Boolean(onApplyStructuralEdit),
  });

  const closeContextMenu = (restoreFocus = false) => {
    const focusElement = contextMenu?.focusElement;
    setContextMenu(null);
    if (restoreFocus) {
      window.requestAnimationFrame(() => focusElement?.focus());
    }
  };

  const openContextMenu = (
    event: ReactMouseEvent<HTMLElement>,
    targetId = viewModel.contextTargetId,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setContextActionError(null);
    setContextMenu({
      ...clampAppContextMenuPosition(event.clientX, event.clientY),
      targetId,
      focusElement: event.currentTarget,
    });
  };

  const handleSave = async () => {
    if (!editableSource || !viewModel.canEditInline) {
      return;
    }

    if (draftStale) {
      setSourceError(
        "This draft is stale because the file changed outside H.E.L.M. Reload from disk before saving again.",
      );
      return;
    }

    setSourceError(null);
    try {
      await onSaveSource(editableSource.targetId, draftSource);
    } catch (reason) {
      setSourceError(reason instanceof Error ? reason.message : "Unable to save source right now.");
    }
  };

  const handleCancel = () => {
    setDraftSource(editableSource?.content ?? "");
    setSourceError(null);
  };

  const contextMenuItems = () =>
    buildInspectorContextMenuItems({
      canEditInline: viewModel.canEditInline,
      dirty: viewModel.dirty,
      draftStale,
      hasRevealedSource: Boolean(revealedSource),
      inspectorTitle: viewModel.inspectorTitle,
      isSavingSource,
      nodePath: viewModel.nodePath,
      onCancelSource: handleCancel,
      onClose,
      onDismissSource,
      onOpenNodeInDefaultEditor,
      onRevealNodeInFileExplorer,
      onSaveSource: handleSave,
      selectedText: document.getSelection()?.toString().trim() ?? "",
      symbolQualname: symbol?.qualname,
      targetId: contextMenu?.targetId ?? viewModel.contextTargetId,
    });

  useEffect(() => {
    if (!editableSource && editableSourceLoading) {
      return;
    }

    const nextTargetId = editableSource?.targetId;
    if (nextTargetId !== previousEditableTargetIdRef.current) {
      previousEditableTargetIdRef.current = nextTargetId;
      setDraftSource(editableSource?.content ?? "");
      setSourceError(null);
      return;
    }

    if (!viewModel.dirty && !draftStale) {
      setDraftSource(editableSource?.content ?? "");
      setSourceError(null);
    }
  }, [
    draftStale,
    editableSource?.content,
    editableSource?.targetId,
    editableSourceLoading,
    viewModel.dirty,
  ]);

  useEffect(() => {
    if (viewModel.canEditInline) {
      onEditorStateChange(draftSource, viewModel.dirty);
      return;
    }
    onEditorStateChange(undefined, false);
  }, [draftSource, onEditorStateChange, viewModel.canEditInline, viewModel.dirty]);

  useEffect(() => {
    setRenameValue(selectedNode?.label ?? "");
    setMoveDestinationPath("");
    setStructuralActionError(null);
  }, [selectedNode?.id, selectedNode?.label]);

  useEffect(() => {
    setAddImportModule("");
    setAddImportName("");
    setAddImportAlias("");
    setRemoveImportModule("");
    setStructuralActionError(null);
  }, [moduleActionNode?.id]);

  useEffect(() => {
    setFlowInputDrafts(
      Object.fromEntries(
        viewModel.sortedFlowFunctionInputs.map((input) => [
          input.id,
          {
            name: input.name,
            defaultExpression: input.defaultExpression ?? "",
          },
        ]),
      ),
    );
    setNewFlowInputName("");
    setNewFlowInputDefault("");
  }, [flowFunctionInputs]);

  const runStructuralAction = async (
    actionId: string,
    request: Parameters<NonNullable<typeof onApplyStructuralEdit>>[0],
    onSuccess?: () => void,
  ) => {
    if (!onApplyStructuralEdit) {
      return;
    }

    setPendingStructuralActionId(actionId);
    setStructuralActionError(null);
    try {
      await onApplyStructuralEdit(request);
      onSuccess?.();
    } catch (reason) {
      setStructuralActionError(
        reason instanceof Error
          ? reason.message
          : "Unable to apply the requested structural action.",
      );
    } finally {
      setPendingStructuralActionId(null);
    }
  };

  const updateFlowInputDraft = (inputId: string, patch: Partial<FlowFunctionInputDraftState>) => {
    setFlowInputDrafts((current) => ({
      ...current,
      [inputId]: {
        name: current[inputId]?.name ?? "",
        defaultExpression: current[inputId]?.defaultExpression ?? "",
        ...patch,
      },
    }));
  };

  const commitFlowInputDraft = (input: FlowFunctionInput) => {
    const draft = flowInputDrafts[input.id];
    if (!draft || !onUpdateFlowFunctionInput) {
      return;
    }
    const name = draft.name.trim();
    const defaultExpression = draft.defaultExpression.trim();
    onUpdateFlowFunctionInput(input.id, {
      name: name || input.name,
      defaultExpression: defaultExpression || null,
    });
  };

  const flowInputDraftDirty = (input: FlowFunctionInput) => {
    const draft = flowInputDrafts[input.id];
    return Boolean(
      draft &&
      (draft.name !== input.name || draft.defaultExpression !== (input.defaultExpression ?? "")),
    );
  };

  if (!selectedNode && !viewModel.contextSectionVisible) {
    return (
      <aside className="pane pane--inspector blueprint-inspector" onContextMenu={openContextMenu}>
        <InspectorEmptyState onClose={onClose} />
        {contextMenu ? (
          <AppContextMenu
            label="Inspector actions"
            items={contextMenuItems()}
            position={contextMenu}
            onActionError={setContextActionError}
            onClose={closeContextMenu}
          />
        ) : null}
      </aside>
    );
  }

  return (
    <aside className={viewModel.inspectorClassName} onContextMenu={openContextMenu}>
      <InspectorHeader
        contextSummary={viewModel.contextSummary}
        inspectorKind={viewModel.inspectorKind}
        inspectorTitle={viewModel.inspectorTitle}
        nodePath={viewModel.nodePath}
        selectedNode={selectedNode}
        selectedSummary={viewModel.selectedSummary}
        onClose={onClose}
      />

      {contextActionError ? (
        <p className="error-copy inspector-context-error">{contextActionError}</p>
      ) : null}

      <SelectionSummaryPanel
        contextSectionVisible={viewModel.contextSectionVisible}
        contextSummary={viewModel.contextSummary}
        editableSource={editableSource}
        inspectorKind={viewModel.inspectorKind}
        inspectorTitle={viewModel.inspectorTitle}
        selectedNode={selectedNode}
        selectedSummary={viewModel.selectedSummary}
        symbol={symbol}
        topLevel={viewModel.topLevel}
      />

      {viewModel.flowInputsVisible ? (
        <FlowInputsPanel
          flowInputDisplayMode={flowInputDisplayMode}
          flowInputDraftDirty={flowInputDraftDirty}
          flowInputDrafts={flowInputDrafts}
          flowInputsEditable={flowInputsEditable}
          newFlowInputDefault={newFlowInputDefault}
          newFlowInputName={newFlowInputName}
          sortedFlowFunctionInputs={viewModel.sortedFlowFunctionInputs}
          onAddFlowFunctionInput={onAddFlowFunctionInput}
          onChangeNewFlowInputDefault={setNewFlowInputDefault}
          onChangeNewFlowInputName={setNewFlowInputName}
          onCommitFlowInputDraft={commitFlowInputDraft}
          onMoveFlowFunctionInput={onMoveFlowFunctionInput}
          onRemoveFlowFunctionInput={onRemoveFlowFunctionInput}
          onUpdateFlowFunctionInput={onUpdateFlowFunctionInput}
          onUpdateFlowInputDraft={updateFlowInputDraft}
        />
      ) : null}

      {viewModel.sourceSectionVisible ? (
        <SourcePanel
          canEditInline={viewModel.canEditInline}
          contextTargetId={viewModel.contextTargetId}
          dirty={viewModel.dirty}
          draftSource={draftSource}
          draftStale={draftStale}
          editableNodeKind={viewModel.editableNodeKind}
          editableSource={editableSource}
          editableSourceError={editableSourceError}
          editableSourceLoading={editableSourceLoading}
          highlightRange={highlightRange}
          isSavingSource={isSavingSource}
          nodePath={viewModel.nodePath}
          sourceError={sourceError}
          sourceLanguage={viewModel.sourceLanguage}
          onCancel={handleCancel}
          onChangeDraftSource={setDraftSource}
          onOpenContextMenu={openContextMenu}
          onSave={handleSave}
        />
      ) : null}

      {viewModel.structuralActionsVisible ? (
        <StructuralActionsPanel
          addImportAction={viewModel.addImportAction}
          addImportAlias={addImportAlias}
          addImportModule={addImportModule}
          addImportName={addImportName}
          deleteAction={viewModel.deleteAction}
          moduleRelativePath={viewModel.moduleRelativePath}
          moveAction={viewModel.moveAction}
          moveDestinationPath={moveDestinationPath}
          pendingStructuralActionId={pendingStructuralActionId}
          removeImportAction={viewModel.removeImportAction}
          removeImportModule={removeImportModule}
          renameAction={viewModel.renameAction}
          renameValue={renameValue}
          selectedNode={selectedNode}
          sortedDestinationModulePaths={viewModel.sortedDestinationModulePaths}
          structuralActionError={structuralActionError}
          structuralActionsLocked={viewModel.structuralActionsLocked}
          structuralActionsLockedReason={viewModel.structuralActionsLockedReason}
          onAddImportAliasChange={setAddImportAlias}
          onAddImportModuleChange={setAddImportModule}
          onAddImportNameChange={setAddImportName}
          onMoveDestinationPathChange={setMoveDestinationPath}
          onRemoveImportModuleChange={setRemoveImportModule}
          onRenameValueChange={setRenameValue}
          onRunStructuralAction={runStructuralAction}
        />
      ) : null}

      <LatestActivityPanel lastActivity={lastActivity} />

      <RevealedSourcePanel
        revealedSource={revealedSource}
        sourceLanguage={viewModel.sourceLanguage}
        onDismissSource={onDismissSource}
        onOpenContextMenu={openContextMenu}
      />

      {contextMenu ? (
        <AppContextMenu
          label={`${viewModel.inspectorTitle} actions`}
          items={contextMenuItems()}
          position={contextMenu}
          onActionError={setContextActionError}
          onClose={closeContextMenu}
        />
      ) : null}
    </aside>
  );
}
