import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import type {
  EditableNodeSource,
  FlowFunctionInput,
  FlowInputDisplayMode,
  GraphActionDto,
  GraphNodeDto,
  RevealedSource,
  SourceRange,
  StructuralEditRequest,
  SymbolDetails,
} from "../../lib/adapter";
import { isInspectableGraphNodeKind } from "../../lib/adapter";
import type { WorkspaceActivity } from "../../store/uiStore";
import { InspectorCodeSurface } from "../editor/InspectorCodeSurface";
import { inferInspectorLanguage } from "../editor/inspectorLanguage";
import {
  AppContextMenu,
  clampAppContextMenuPosition,
  copyToClipboard,
  systemFileExplorerLabel,
  type AppContextMenuItem,
  type AppContextMenuPosition,
} from "../shared/AppContextMenu";
import { StatusPill } from "../shared/StatusPill";
import { metadataBoolean, relativePathForNode, selectionSummary } from "./blueprintInspectorUtils";
import { helpTargetProps } from "./workspaceHelp";

type FlowFunctionInputPatch = {
  name?: string;
  defaultExpression?: string | null;
};

type FlowFunctionInputDraftState = {
  name: string;
  defaultExpression: string;
};

function graphActionById(
  node: GraphNodeDto | undefined,
  actionId: string,
): GraphActionDto | undefined {
  return node?.availableActions.find((action) => action.actionId === actionId);
}

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
}: {
  selectedNode?: GraphNodeDto;
  sourceContextNode?: GraphNodeDto;
  moduleActionNode?: GraphNodeDto;
  destinationModulePaths?: string[];
  symbol?: SymbolDetails;
  editableSource?: EditableNodeSource;
  editableSourceLoading: boolean;
  editableSourceError?: string | null;
  draftStale?: boolean;
  revealedSource?: RevealedSource;
  lastActivity?: WorkspaceActivity;
  isSavingSource: boolean;
  highlightRange?: SourceRange;
  flowFunctionInputs?: FlowFunctionInput[];
  flowInputDisplayMode?: FlowInputDisplayMode;
  flowInputsEditable?: boolean;
  onApplyStructuralEdit?: (request: StructuralEditRequest) => Promise<unknown>;
  onAddFlowFunctionInput?: (draft: FlowFunctionInputPatch) => void;
  onUpdateFlowFunctionInput?: (inputId: string, patch: FlowFunctionInputPatch) => void;
  onMoveFlowFunctionInput?: (inputId: string, direction: -1 | 1) => void;
  onRemoveFlowFunctionInput?: (inputId: string) => void;
  onOpenNodeInDefaultEditor?: (targetId: string) => void | Promise<void>;
  onRevealNodeInFileExplorer?: (targetId: string) => void | Promise<void>;
  onSaveSource: (targetId: string, content: string) => Promise<void>;
  onEditorStateChange: (content?: string, dirty?: boolean) => void;
  onDismissSource: () => void;
  onClose: () => void;
}) {
  const [draftSource, setDraftSource] = useState(() => editableSource?.content ?? "");
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [structuralActionError, setStructuralActionError] = useState<string | null>(null);
  const [contextActionError, setContextActionError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<
    (AppContextMenuPosition & { targetId?: string; focusElement?: HTMLElement | null }) | null
  >(null);
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
  const topLevel = metadataBoolean(selectedNode, "top_level");
  const renameAction = graphActionById(selectedNode, "rename_symbol");
  const deleteAction = graphActionById(selectedNode, "delete_symbol");
  const moveAction = graphActionById(selectedNode, "move_symbol");
  const addImportAction = graphActionById(moduleActionNode, "add_import");
  const removeImportAction = graphActionById(moduleActionNode, "remove_import");
  const flowDraftActivity = lastActivity?.flowSyncState === "draft";
  const structuralActionsVisible = Boolean(
    onApplyStructuralEdit &&
    (renameAction || deleteAction || moveAction || addImportAction || removeImportAction),
  );
  const structuralActionsLockedReason = isSavingSource
    ? "Wait for the current source save to finish before running structural actions."
    : draftStale
      ? "Reload or cancel the stale inline draft before running structural actions."
      : dirty
        ? "Save or cancel inline source edits before running structural actions."
        : null;
  const structuralActionsLocked = Boolean(structuralActionsLockedReason);
  const sortedDestinationModulePaths = [...new Set(destinationModulePaths ?? [])].sort(
    (left, right) => left.localeCompare(right),
  );
  const inspectorClassName = `pane pane--inspector blueprint-inspector${revealedSource ? " blueprint-inspector--with-revealed-source" : ""}`;
  const sourceSectionVisible = Boolean(
    editableSourceLoading ||
    editableSourceError ||
    editableSource ||
    (selectedNode && isInspectableGraphNodeKind(selectedNode.kind)),
  );
  const contextSectionVisible = Boolean(
    !selectedNode && (sourceContextNode || sourceSectionVisible || symbol),
  );
  const sortedFlowFunctionInputs = [...(flowFunctionInputs ?? [])].sort(
    (left, right) => left.index - right.index || left.name.localeCompare(right.name),
  );
  const flowInputsVisible = selectedNode?.kind === "entry" && Boolean(flowFunctionInputs);

  const closeContextMenu = (restoreFocus = false) => {
    const focusElement = contextMenu?.focusElement;
    setContextMenu(null);
    if (restoreFocus) {
      window.requestAnimationFrame(() => focusElement?.focus());
    }
  };

  const openContextMenu = (event: ReactMouseEvent<HTMLElement>, targetId = contextTargetId) => {
    event.preventDefault();
    event.stopPropagation();
    setContextActionError(null);
    setContextMenu({
      ...clampAppContextMenuPosition(event.clientX, event.clientY),
      targetId,
      focusElement: event.currentTarget,
    });
  };

  const contextMenuItems = (): AppContextMenuItem[] => {
    const targetId = contextMenu?.targetId ?? contextTargetId;
    const selectedText = document.getSelection()?.toString().trim() ?? "";
    const items: AppContextMenuItem[] = [];

    if (targetId && onRevealNodeInFileExplorer) {
      items.push({
        id: "reveal-node",
        label: systemFileExplorerLabel(),
        action: () => onRevealNodeInFileExplorer(targetId),
      });
    }

    if (targetId && onOpenNodeInDefaultEditor) {
      items.push({
        id: "open-default",
        label: "Open in Default Editor",
        action: () => onOpenNodeInDefaultEditor(targetId),
      });
    }

    if (canEditInline) {
      items.push(
        {
          id: "save-source",
          label: isSavingSource ? "Saving..." : "Save Source",
          action: handleSave,
          disabled: draftStale || !dirty || isSavingSource,
          separatorBefore: items.length > 0,
        },
        {
          id: "cancel-source",
          label: draftStale ? "Reload from Disk" : "Cancel Source Changes",
          action: handleCancel,
          disabled: (!dirty && !draftStale) || isSavingSource,
        },
      );
    }

    if (selectedText) {
      items.push({
        id: "copy-selection",
        label: "Copy Selection",
        action: () => copyToClipboard(selectedText),
        separatorBefore: true,
      });
    }

    if (nodePath) {
      items.push({
        id: "copy-path",
        label: "Copy Path",
        action: () => copyToClipboard(nodePath),
        separatorBefore: !selectedText,
      });
    }

    if (inspectorTitle) {
      items.push({
        id: "copy-title",
        label: "Copy Title",
        action: () => copyToClipboard(inspectorTitle),
      });
    }

    if (targetId) {
      items.push({
        id: "copy-target-id",
        label: "Copy Target ID",
        action: () => copyToClipboard(targetId),
      });
    }

    if (symbol?.qualname) {
      items.push({
        id: "copy-qualname",
        label: "Copy Qualified Name",
        action: () => copyToClipboard(symbol.qualname),
      });
    }

    if (revealedSource) {
      items.push({
        id: "hide-revealed-source",
        label: "Hide Revealed Source",
        action: onDismissSource,
        separatorBefore: true,
      });
    }

    items.push({
      id: "close-inspector",
      label: "Collapse Inspector",
      action: onClose,
      separatorBefore: true,
    });

    return items;
  };

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

    if (!dirty && !draftStale) {
      setDraftSource(editableSource?.content ?? "");
      setSourceError(null);
    }
  }, [dirty, draftStale, editableSource?.content, editableSource?.targetId, editableSourceLoading]);

  useEffect(() => {
    if (canEditInline) {
      onEditorStateChange(draftSource, dirty);
      return;
    }
    onEditorStateChange(undefined, false);
  }, [canEditInline, dirty, draftSource, onEditorStateChange]);

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
        sortedFlowFunctionInputs.map((input) => [
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

  const handleSave = async () => {
    if (!editableSource || !canEditInline) {
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

  const runStructuralAction = async (
    actionId: string,
    request: StructuralEditRequest,
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

  if (!selectedNode && !contextSectionVisible) {
    return (
      <aside className="pane pane--inspector blueprint-inspector" onContextMenu={openContextMenu}>
        <section className="sidebar-card blueprint-inspector__card">
          <div className="sidebar-card__header">
            <div>
              <span className="window-bar__eyebrow">Inspector</span>
              <h2>Nothing selected</h2>
            </div>
            <button
              {...helpTargetProps("inspector.toggle")}
              className="ghost-button"
              type="button"
              onClick={onClose}
            >
              Collapse
            </button>
          </div>
          <p>
            Select a graph node to inspect it, or press <strong>C</strong> in the graph to enter
            create mode.
          </p>
        </section>
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
    <aside className={inspectorClassName} onContextMenu={openContextMenu}>
      <section className="sidebar-card blueprint-inspector__card">
        <div className="sidebar-card__header">
          <div>
            <span className="window-bar__eyebrow">Inspector</span>
            <h2>{inspectorTitle}</h2>
          </div>
          <div className="blueprint-inspector__chrome">
            {inspectorKind ? <StatusPill tone="default">{inspectorKind}</StatusPill> : null}
            <button
              {...helpTargetProps("inspector.toggle", { label: inspectorTitle })}
              className="ghost-button"
              data-testid="blueprint-inspector-panel-collapse"
              type="button"
              onClick={onClose}
            >
              Collapse
            </button>
          </div>
        </div>

        <div className="blueprint-inspector__meta">
          <div className="info-card">
            <span className="info-card__label">Path</span>
            <strong>{nodePath ?? "No file path"}</strong>
            {selectedNode && selectedSummary && selectedSummary !== nodePath ? (
              <p>{selectedSummary}</p>
            ) : null}
            {!selectedNode && contextSummary && contextSummary !== nodePath ? (
              <p>{contextSummary}</p>
            ) : null}
          </div>
        </div>
      </section>

      {contextActionError ? (
        <p className="error-copy inspector-context-error">{contextActionError}</p>
      ) : null}

      {selectedNode ? (
        <section className="sidebar-section blueprint-inspector__section blueprint-inspector__section--selection">
          <div className="section-header">
            <h3>Selection</h3>
            <span>{selectedNode.kind}</span>
          </div>
          <div className="info-card">
            <strong>{selectedNode.label}</strong>
            {selectedSummary ? <p>{selectedSummary}</p> : null}
            {topLevel === false && editableSource?.editable === false ? (
              <p className="muted-copy">This symbol is nested and not editable inline in v1.</p>
            ) : null}
          </div>
          {symbol ? (
            <div className="info-card">
              <strong>{symbol.signature}</strong>
              <p>{symbol.docSummary}</p>
            </div>
          ) : null}
        </section>
      ) : contextSectionVisible ? (
        <section className="sidebar-section blueprint-inspector__section blueprint-inspector__section--selection">
          <div className="section-header">
            <h3>Current Context</h3>
            <span>{inspectorKind ?? "source"}</span>
          </div>
          <div className="info-card">
            <strong>{inspectorTitle}</strong>
            {contextSummary ? <p>{contextSummary}</p> : null}
          </div>
          {symbol ? (
            <div className="info-card">
              <strong>{symbol.signature}</strong>
              <p>{symbol.docSummary}</p>
            </div>
          ) : null}
        </section>
      ) : null}

      {flowInputsVisible ? (
        <section className="sidebar-section blueprint-inspector__section blueprint-inspector__section--flow-inputs">
          <div className="section-header">
            <h3>Inputs</h3>
            <span>{flowInputDisplayMode === "param_nodes" ? "parameters" : "entry"}</span>
          </div>

          <form
            className="info-card blueprint-flow-inputs__add"
            onSubmit={(event) => {
              event.preventDefault();
              if (!flowInputsEditable || !onAddFlowFunctionInput) {
                return;
              }
              onAddFlowFunctionInput({
                name: newFlowInputName,
                defaultExpression: newFlowInputDefault,
              });
            }}
          >
            <label className="blueprint-field">
              <span className="blueprint-field__label">
                <strong>New input</strong>
              </span>
              <input
                aria-label="New flow input name"
                type="text"
                value={newFlowInputName}
                disabled={!flowInputsEditable}
                placeholder={`input_${sortedFlowFunctionInputs.length + 1}`}
                onChange={(event) => setNewFlowInputName(event.target.value)}
              />
            </label>
            <label className="blueprint-field">
              <span className="blueprint-field__label">
                <strong>Default</strong>
              </span>
              <input
                aria-label="New flow input default expression"
                type="text"
                value={newFlowInputDefault}
                disabled={!flowInputsEditable}
                placeholder="optional"
                onChange={(event) => setNewFlowInputDefault(event.target.value)}
              />
            </label>
            <div className="blueprint-inspector__editor-actions">
              <button
                className="secondary-button"
                type="submit"
                disabled={!flowInputsEditable || !onAddFlowFunctionInput}
              >
                Add input
              </button>
            </div>
          </form>

          {sortedFlowFunctionInputs.length ? (
            <div className="blueprint-flow-inputs__list">
              {sortedFlowFunctionInputs.map((input, index) => {
                const draft = flowInputDrafts[input.id] ?? {
                  name: input.name,
                  defaultExpression: input.defaultExpression ?? "",
                };
                const dirtyInput = flowInputDraftDirty(input);
                return (
                  <div className="info-card blueprint-flow-inputs__row" key={input.id}>
                    <div className="blueprint-flow-inputs__row-header">
                      <strong>{input.name}</strong>
                      <StatusPill tone="default">
                        {input.kind ?? "positional_or_keyword"}
                      </StatusPill>
                    </div>
                    <label className="blueprint-field">
                      <span className="blueprint-field__label">Name</span>
                      <input
                        aria-label={`Flow input ${input.name} name`}
                        type="text"
                        value={draft.name}
                        disabled={!flowInputsEditable}
                        onChange={(event) =>
                          updateFlowInputDraft(input.id, { name: event.target.value })
                        }
                        onBlur={() => {
                          if (dirtyInput) {
                            commitFlowInputDraft(input);
                          }
                        }}
                      />
                    </label>
                    <label className="blueprint-field">
                      <span className="blueprint-field__label">Default</span>
                      <input
                        aria-label={`Flow input ${input.name} default expression`}
                        type="text"
                        value={draft.defaultExpression}
                        disabled={!flowInputsEditable}
                        placeholder="none"
                        onChange={(event) =>
                          updateFlowInputDraft(input.id, { defaultExpression: event.target.value })
                        }
                        onBlur={() => {
                          if (dirtyInput) {
                            commitFlowInputDraft(input);
                          }
                        }}
                      />
                    </label>
                    <div className="blueprint-flow-inputs__actions">
                      <button
                        aria-label={`Move ${input.name} up`}
                        className="ghost-button"
                        type="button"
                        disabled={!flowInputsEditable || index === 0 || !onMoveFlowFunctionInput}
                        onClick={() => onMoveFlowFunctionInput?.(input.id, -1)}
                      >
                        Up
                      </button>
                      <button
                        aria-label={`Move ${input.name} down`}
                        className="ghost-button"
                        type="button"
                        disabled={
                          !flowInputsEditable ||
                          index === sortedFlowFunctionInputs.length - 1 ||
                          !onMoveFlowFunctionInput
                        }
                        onClick={() => onMoveFlowFunctionInput?.(input.id, 1)}
                      >
                        Down
                      </button>
                      <button
                        className="ghost-button"
                        type="button"
                        disabled={!flowInputsEditable || !dirtyInput || !onUpdateFlowFunctionInput}
                        onClick={() => commitFlowInputDraft(input)}
                      >
                        Save
                      </button>
                      <button
                        className="ghost-button blueprint-flow-inputs__remove"
                        type="button"
                        disabled={!flowInputsEditable || !onRemoveFlowFunctionInput}
                        onClick={() => onRemoveFlowFunctionInput?.(input.id)}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="info-card">
              <p>No inputs yet.</p>
            </div>
          )}
        </section>
      ) : null}

      {sourceSectionVisible ? (
        <section
          className="sidebar-section blueprint-inspector__section blueprint-inspector__section--editor"
          onContextMenu={(event) =>
            openContextMenu(event, editableSource?.targetId ?? contextTargetId)
          }
        >
          <div className="section-header">
            <h3>
              {canEditInline && editableNodeKind === "module"
                ? "Source editor"
                : canEditInline
                  ? "Declaration editor"
                  : "Code details"}
            </h3>
            <span>
              {editableSourceLoading
                ? "loading"
                : canEditInline
                  ? draftStale
                    ? "stale"
                    : dirty
                      ? "dirty"
                      : "saved"
                  : editableSource?.editable === false
                    ? "read only"
                    : "ready"}
            </span>
          </div>

          {editableSourceLoading ? (
            <div className="info-card">
              <p>Loading source...</p>
            </div>
          ) : editableSourceError ? (
            <div className="info-card blueprint-inspector__error-card">
              <strong>Source unavailable</strong>
              <p>{editableSourceError}</p>
            </div>
          ) : canEditInline ? (
            <>
              <div className="blueprint-field blueprint-field--editor">
                <span className="blueprint-field__label">
                  <strong>{editableEditorTitle(editableNodeKind)}</strong>
                  <StatusPill tone={draftStale ? "warning" : dirty ? "accent" : "default"}>
                    {draftStale ? "Stale" : dirty ? "Unsaved" : "Synced"}
                  </StatusPill>
                </span>
                <div {...helpTargetProps("inspector.editor")}>
                  <InspectorCodeSurface
                    ariaLabel={editableEditorAriaLabel(editableNodeKind)}
                    className="blueprint-editor"
                    dataTestId="inspector-inline-editor"
                    height="clamp(280px, 34vh, 420px)"
                    language={sourceLanguage}
                    path={editableSource?.path ?? nodePath}
                    startLine={editableSource?.startLine}
                    startColumn={editableSource?.startColumn}
                    highlightRange={highlightRange}
                    value={draftSource}
                    onChange={setDraftSource}
                    readOnly={false}
                  />
                </div>
              </div>

              {draftStale ? (
                <div className="info-card blueprint-inspector__error-card">
                  <strong>Draft is stale</strong>
                  <p>
                    This file changed outside H.E.L.M. Keep this draft if you need it for reference,
                    then reload from disk before saving again.
                  </p>
                </div>
              ) : null}

              {sourceError ? <p className="error-copy">{sourceError}</p> : null}

              <div className="blueprint-inspector__editor-actions">
                <button
                  {...helpTargetProps("inspector.save")}
                  className="primary-button"
                  type="button"
                  disabled={draftStale || !dirty || isSavingSource}
                  onClick={() => void handleSave()}
                >
                  {isSavingSource ? "Saving..." : "Save"}
                </button>
                <button
                  {...helpTargetProps("inspector.cancel")}
                  className="ghost-button"
                  type="button"
                  disabled={(!dirty && !draftStale) || isSavingSource}
                  onClick={handleCancel}
                >
                  {draftStale ? "Reload from Disk" : "Cancel"}
                </button>
              </div>
            </>
          ) : editableSource ? (
            <>
              <InspectorCodeSurface
                ariaLabel={`Read-only ${editableNodeKind ?? "code"} source`}
                className="blueprint-code-details"
                dataTestId="inspector-readonly-source"
                height="clamp(220px, 28vh, 320px)"
                language={sourceLanguage}
                path={editableSource.path}
                highlightRange={highlightRange}
                readOnly
                startLine={editableSource.startLine}
                startColumn={editableSource.startColumn}
                value={editableSource.content}
              />
              <div className="info-card">
                <strong>{editableSource.nodeKind}</strong>
                <p>
                  {editableSource.reason ??
                    "This node is inspectable but not inline editable in v1."}
                </p>
                <p className="muted-copy">
                  Lines {editableSource.startLine}-{editableSource.endLine}
                </p>
              </div>
            </>
          ) : (
            <div className="info-card">
              <p>Source metadata is not available for this node yet.</p>
            </div>
          )}
        </section>
      ) : null}

      {structuralActionsVisible ? (
        <section className="sidebar-section blueprint-inspector__section blueprint-inspector__section--structural">
          <div className="section-header">
            <h3>Structural Actions</h3>
            <span>{pendingStructuralActionId ? "working" : "ready"}</span>
          </div>

          {structuralActionsLockedReason ? (
            <div className="info-card">
              <strong>Structural edits paused</strong>
              <p>{structuralActionsLockedReason}</p>
            </div>
          ) : null}

          {selectedNode && (renameAction || deleteAction || moveAction) ? (
            <div className="blueprint-structural-actions__group">
              <div className="info-card blueprint-structural-actions__card">
                <strong>Symbol actions</strong>
                <p>{selectedNode.label}</p>
              </div>

              {renameAction ? (
                <div className="info-card blueprint-structural-actions__card">
                  <label className="blueprint-field">
                    <span className="blueprint-field__label">
                      <strong>Rename</strong>
                    </span>
                    <input
                      aria-label="New symbol name"
                      type="text"
                      value={renameValue}
                      disabled={
                        !renameAction.enabled ||
                        structuralActionsLocked ||
                        pendingStructuralActionId !== null
                      }
                      onChange={(event) => setRenameValue(event.target.value)}
                    />
                  </label>
                  <div className="blueprint-inspector__editor-actions">
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={
                        !renameAction.enabled ||
                        structuralActionsLocked ||
                        pendingStructuralActionId !== null ||
                        renameValue.trim().length === 0 ||
                        renameValue.trim() === selectedNode.label
                      }
                      onClick={() => {
                        void runStructuralAction("rename_symbol", {
                          kind: "rename_symbol",
                          targetId: selectedNode.id,
                          newName: renameValue.trim(),
                        });
                      }}
                    >
                      {pendingStructuralActionId === "rename_symbol"
                        ? "Renaming..."
                        : "Rename symbol"}
                    </button>
                    <button
                      className="ghost-button"
                      type="button"
                      disabled={pendingStructuralActionId !== null}
                      onClick={() => setRenameValue(selectedNode.label)}
                    >
                      Reset
                    </button>
                  </div>
                  {!renameAction.enabled && renameAction.reason ? (
                    <p className="muted-copy">{renameAction.reason}</p>
                  ) : null}
                </div>
              ) : null}

              {deleteAction ? (
                <div className="info-card blueprint-structural-actions__card">
                  <strong>Delete</strong>
                  <p>Remove this symbol from {moduleRelativePath ?? "its module"}.</p>
                  <div className="blueprint-inspector__editor-actions">
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={
                        !deleteAction.enabled ||
                        structuralActionsLocked ||
                        pendingStructuralActionId !== null
                      }
                      onClick={() => {
                        if (
                          !window.confirm(
                            `Delete ${selectedNode.label}? This removes the declaration from the current module.`,
                          )
                        ) {
                          return;
                        }
                        void runStructuralAction("delete_symbol", {
                          kind: "delete_symbol",
                          targetId: selectedNode.id,
                        });
                      }}
                    >
                      {pendingStructuralActionId === "delete_symbol"
                        ? "Deleting..."
                        : "Delete symbol"}
                    </button>
                  </div>
                  {!deleteAction.enabled && deleteAction.reason ? (
                    <p className="muted-copy">{deleteAction.reason}</p>
                  ) : null}
                </div>
              ) : null}

              {moveAction ? (
                <div className="info-card blueprint-structural-actions__card">
                  <label className="blueprint-field">
                    <span className="blueprint-field__label">
                      <strong>Move</strong>
                    </span>
                    <select
                      aria-label="Destination module"
                      value={moveDestinationPath}
                      disabled={
                        !moveAction.enabled ||
                        structuralActionsLocked ||
                        pendingStructuralActionId !== null
                      }
                      onChange={(event) => setMoveDestinationPath(event.target.value)}
                    >
                      <option value="">Select destination module</option>
                      {sortedDestinationModulePaths.map((path) => (
                        <option key={path} value={path}>
                          {path}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="blueprint-inspector__editor-actions">
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={
                        !moveAction.enabled ||
                        structuralActionsLocked ||
                        pendingStructuralActionId !== null ||
                        moveDestinationPath.length === 0
                      }
                      onClick={() => {
                        void runStructuralAction("move_symbol", {
                          kind: "move_symbol",
                          targetId: selectedNode.id,
                          destinationRelativePath: moveDestinationPath,
                        });
                      }}
                    >
                      {pendingStructuralActionId === "move_symbol" ? "Moving..." : "Move symbol"}
                    </button>
                  </div>
                  {!sortedDestinationModulePaths.length ? (
                    <p className="muted-copy">No indexed module destinations are available yet.</p>
                  ) : null}
                  {!moveAction.enabled && moveAction.reason ? (
                    <p className="muted-copy">{moveAction.reason}</p>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {(addImportAction || removeImportAction) && moduleRelativePath ? (
            <div className="blueprint-structural-actions__group">
              <div className="info-card blueprint-structural-actions__card">
                <strong>Module actions</strong>
                <p>{moduleRelativePath}</p>
              </div>

              {addImportAction ? (
                <div className="info-card blueprint-structural-actions__card">
                  <label className="blueprint-field">
                    <span className="blueprint-field__label">
                      <strong>Add import</strong>
                    </span>
                    <input
                      aria-label="Imported module"
                      type="text"
                      value={addImportModule}
                      disabled={
                        !addImportAction.enabled ||
                        structuralActionsLocked ||
                        pendingStructuralActionId !== null
                      }
                      onChange={(event) => setAddImportModule(event.target.value)}
                    />
                  </label>
                  <label className="blueprint-field">
                    <span className="blueprint-field__label">
                      <strong>Imported symbol</strong>
                    </span>
                    <input
                      aria-label="Imported symbol"
                      type="text"
                      value={addImportName}
                      disabled={
                        !addImportAction.enabled ||
                        structuralActionsLocked ||
                        pendingStructuralActionId !== null
                      }
                      onChange={(event) => setAddImportName(event.target.value)}
                    />
                  </label>
                  <label className="blueprint-field">
                    <span className="blueprint-field__label">
                      <strong>Alias</strong>
                    </span>
                    <input
                      aria-label="Import alias"
                      type="text"
                      value={addImportAlias}
                      disabled={
                        !addImportAction.enabled ||
                        structuralActionsLocked ||
                        pendingStructuralActionId !== null
                      }
                      onChange={(event) => setAddImportAlias(event.target.value)}
                    />
                  </label>
                  <div className="blueprint-inspector__editor-actions">
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={
                        !addImportAction.enabled ||
                        structuralActionsLocked ||
                        pendingStructuralActionId !== null ||
                        addImportModule.trim().length === 0
                      }
                      onClick={() => {
                        void runStructuralAction(
                          "add_import",
                          {
                            kind: "add_import",
                            relativePath: moduleRelativePath,
                            importedModule: addImportModule.trim(),
                            importedName: addImportName.trim() || undefined,
                            alias: addImportAlias.trim() || undefined,
                          },
                          () => {
                            setAddImportModule("");
                            setAddImportName("");
                            setAddImportAlias("");
                          },
                        );
                      }}
                    >
                      {pendingStructuralActionId === "add_import" ? "Adding..." : "Add import"}
                    </button>
                  </div>
                  {!addImportAction.enabled && addImportAction.reason ? (
                    <p className="muted-copy">{addImportAction.reason}</p>
                  ) : null}
                </div>
              ) : null}

              {removeImportAction ? (
                <div className="info-card blueprint-structural-actions__card">
                  <label className="blueprint-field">
                    <span className="blueprint-field__label">
                      <strong>Remove import</strong>
                    </span>
                    <input
                      aria-label="Imported module to remove"
                      type="text"
                      value={removeImportModule}
                      disabled={
                        !removeImportAction.enabled ||
                        structuralActionsLocked ||
                        pendingStructuralActionId !== null
                      }
                      onChange={(event) => setRemoveImportModule(event.target.value)}
                    />
                  </label>
                  <div className="blueprint-inspector__editor-actions">
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={
                        !removeImportAction.enabled ||
                        structuralActionsLocked ||
                        pendingStructuralActionId !== null ||
                        removeImportModule.trim().length === 0
                      }
                      onClick={() => {
                        void runStructuralAction(
                          "remove_import",
                          {
                            kind: "remove_import",
                            relativePath: moduleRelativePath,
                            importedModule: removeImportModule.trim(),
                          },
                          () => {
                            setRemoveImportModule("");
                          },
                        );
                      }}
                    >
                      {pendingStructuralActionId === "remove_import"
                        ? "Removing..."
                        : "Remove import"}
                    </button>
                  </div>
                  {!removeImportAction.enabled && removeImportAction.reason ? (
                    <p className="muted-copy">{removeImportAction.reason}</p>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {structuralActionError ? <p className="error-copy">{structuralActionError}</p> : null}
        </section>
      ) : null}

      {lastActivity ? (
        <section className="sidebar-section blueprint-inspector__section blueprint-inspector__section--last-edit">
          <div className="section-header">
            <h3>Latest Activity</h3>
            <span>{lastActivity.domain}</span>
          </div>
          <div className="info-card">
            {flowDraftActivity ? (
              <div className="blueprint-inspector__activity-status">
                <StatusPill tone="warning">Draft only</StatusPill>
                <span>Not applied to code</span>
              </div>
            ) : null}
            <strong>{lastActivity.summary}</strong>
            {lastActivity.touchedRelativePaths?.length || lastActivity.warnings?.length ? (
              <p>
                {lastActivity.touchedRelativePaths?.length
                  ? `Touched: ${lastActivity.touchedRelativePaths.join(", ")}.`
                  : ""}
                {lastActivity.warnings?.length
                  ? `${lastActivity.touchedRelativePaths?.length ? " " : ""}Warnings: ${lastActivity.warnings.join(" ")}`
                  : ""}
              </p>
            ) : null}
            {lastActivity.diagnostics?.length ? (
              <ul className="blueprint-inspector__diagnostics">
                {lastActivity.diagnostics.map((diagnostic) => (
                  <li key={diagnostic}>{diagnostic}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </section>
      ) : null}

      {revealedSource ? (
        <section
          className="sidebar-section blueprint-inspector__section blueprint-inspector__section--revealed"
          onContextMenu={(event) => openContextMenu(event, revealedSource.targetId)}
        >
          <div className="section-header">
            <h3>Revealed Source</h3>
            <button
              {...helpTargetProps("inspector.reveal-source")}
              className="ghost-button"
              type="button"
              onClick={onDismissSource}
            >
              Hide
            </button>
          </div>
          <div className="info-card">
            <strong>{revealedSource.path}</strong>
            <p>
              Lines {revealedSource.startLine}-{revealedSource.endLine}
            </p>
          </div>
          <InspectorCodeSurface
            ariaLabel="Revealed source"
            className="blueprint-source-panel"
            dataTestId="inspector-revealed-source"
            height="clamp(220px, 28vh, 320px)"
            language={sourceLanguage}
            path={revealedSource.path}
            readOnly
            startLine={revealedSource.startLine}
            value={revealedSource.content}
          />
        </section>
      ) : null}

      {contextMenu ? (
        <AppContextMenu
          label={`${inspectorTitle} actions`}
          items={contextMenuItems()}
          position={contextMenu}
          onActionError={setContextActionError}
          onClose={closeContextMenu}
        />
      ) : null}
    </aside>
  );
}

function editableEditorTitle(nodeKind: GraphNodeDto["kind"] | undefined) {
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

function editableEditorAriaLabel(nodeKind: GraphNodeDto["kind"] | undefined) {
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
