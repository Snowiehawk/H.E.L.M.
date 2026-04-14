import { useEffect, useRef, useState } from "react";
import type {
  EditableNodeSource,
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
import { StatusPill } from "../shared/StatusPill";
import {
  metadataBoolean,
  relativePathForNode,
  selectionSummary,
} from "./blueprintInspectorUtils";
import { helpTargetProps } from "./workspaceHelp";

function graphActionById(
  node: GraphNodeDto | undefined,
  actionId: string,
): GraphActionDto | undefined {
  return node?.availableActions.find((action) => action.actionId === actionId);
}

export function BlueprintInspector({
  selectedNode,
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
  onApplyStructuralEdit,
  onSaveSource,
  onEditorStateChange,
  onDismissSource,
  onClose,
}: {
  selectedNode?: GraphNodeDto;
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
  onApplyStructuralEdit?: (request: StructuralEditRequest) => Promise<unknown>;
  onSaveSource: (targetId: string, content: string) => Promise<void>;
  onEditorStateChange: (content?: string, dirty?: boolean) => void;
  onDismissSource: () => void;
  onClose: () => void;
}) {
  const [draftSource, setDraftSource] = useState("");
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [structuralActionError, setStructuralActionError] = useState<string | null>(null);
  const [pendingStructuralActionId, setPendingStructuralActionId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [moveDestinationPath, setMoveDestinationPath] = useState("");
  const [addImportModule, setAddImportModule] = useState("");
  const [addImportName, setAddImportName] = useState("");
  const [addImportAlias, setAddImportAlias] = useState("");
  const [removeImportModule, setRemoveImportModule] = useState("");
  const previousEditableTargetIdRef = useRef<string | undefined>(undefined);
  const selectedRelativePath = relativePathForNode(selectedNode);
  const selectedSummary = selectionSummary(selectedNode);
  const moduleRelativePath = relativePathForNode(moduleActionNode);
  const nodePath = editableSource?.path ?? selectedRelativePath ?? symbol?.filePath;
  const sourceLanguage = inferInspectorLanguage({
    editablePath: editableSource?.path,
    selectedRelativePath,
    symbolFilePath: symbol?.filePath,
    metadata: selectedNode?.metadata,
  });
  const canEditInline = Boolean(
    selectedNode
    && editableSource
    && editableSource.editable
    && (selectedNode.kind === "function" || selectedNode.kind === "variable"),
  );
  const dirty = canEditInline && draftSource !== editableSource?.content;
  const topLevel = metadataBoolean(selectedNode, "top_level");
  const renameAction = graphActionById(selectedNode, "rename_symbol");
  const deleteAction = graphActionById(selectedNode, "delete_symbol");
  const moveAction = graphActionById(selectedNode, "move_symbol");
  const addImportAction = graphActionById(moduleActionNode, "add_import");
  const removeImportAction = graphActionById(moduleActionNode, "remove_import");
  const structuralActionsVisible = Boolean(
    onApplyStructuralEdit
    && (renameAction || deleteAction || moveAction || addImportAction || removeImportAction),
  );
  const structuralActionsLockedReason = isSavingSource
    ? "Wait for the current source save to finish before running structural actions."
    : draftStale
      ? "Reload or cancel the stale inline draft before running structural actions."
      : dirty
        ? "Save or cancel inline source edits before running structural actions."
        : null;
  const structuralActionsLocked = Boolean(structuralActionsLockedReason);
  const sortedDestinationModulePaths = [...new Set(destinationModulePaths ?? [])].sort((left, right) =>
    left.localeCompare(right),
  );
  const inspectorClassName = `pane pane--inspector blueprint-inspector${revealedSource ? " blueprint-inspector--with-revealed-source" : ""}`;

  useEffect(() => {
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
  }, [dirty, draftStale, editableSource?.content, editableSource?.targetId]);

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

  const handleSave = async () => {
    if (!selectedNode || !canEditInline) {
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
      await onSaveSource(selectedNode.id, draftSource);
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
        reason instanceof Error ? reason.message : "Unable to apply the requested structural action.",
      );
    } finally {
      setPendingStructuralActionId(null);
    }
  };

  if (!selectedNode) {
    return (
      <aside className="pane pane--inspector blueprint-inspector">
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
          <p>Select a graph node to inspect it, or press <strong>C</strong> in the graph to enter create mode.</p>
        </section>
      </aside>
    );
  }

  return (
    <aside className={inspectorClassName}>
      <section className="sidebar-card blueprint-inspector__card">
        <div className="sidebar-card__header">
          <div>
            <span className="window-bar__eyebrow">Inspector</span>
            <h2>{selectedNode.label}</h2>
          </div>
          <div className="blueprint-inspector__chrome">
            <StatusPill tone="default">{selectedNode.kind}</StatusPill>
            <button
              {...helpTargetProps("inspector.toggle", { label: selectedNode.label })}
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
            {selectedSummary && selectedSummary !== nodePath ? <p>{selectedSummary}</p> : null}
          </div>
        </div>
      </section>

      <section className="sidebar-section blueprint-inspector__section blueprint-inspector__section--selection">
        <div className="section-header">
          <h3>Selection</h3>
          <span>{selectedNode.kind}</span>
        </div>
        <div className="info-card">
          <strong>{selectedNode.label}</strong>
          {selectedSummary ? <p>{selectedSummary}</p> : null}
          {topLevel === false ? (
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

      {isInspectableGraphNodeKind(selectedNode.kind) ? (
        <section className="sidebar-section blueprint-inspector__section blueprint-inspector__section--editor">
          <div className="section-header">
            <h3>{canEditInline ? "Declaration editor" : "Code details"}</h3>
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
              <p>Loading declaration source…</p>
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
                  <strong>{selectedNode.kind === "function" ? "Function source" : "Variable source"}</strong>
                  <StatusPill tone={draftStale ? "warning" : dirty ? "accent" : "default"}>
                    {draftStale ? "Stale" : dirty ? "Unsaved" : "Synced"}
                  </StatusPill>
                </span>
                <div {...helpTargetProps("inspector.editor")}>
                  <InspectorCodeSurface
                    ariaLabel={
                      selectedNode.kind === "function"
                        ? "Function source editor"
                        : "Variable source editor"
                    }
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
                ariaLabel={`Read-only ${selectedNode.kind} source`}
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
                <p>{editableSource.reason ?? "This node is inspectable but not inline editable in v1."}</p>
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

          {(renameAction || deleteAction || moveAction) ? (
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
                      disabled={!renameAction.enabled || structuralActionsLocked || pendingStructuralActionId !== null}
                      onChange={(event) => setRenameValue(event.target.value)}
                    />
                  </label>
                  <div className="blueprint-inspector__editor-actions">
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={
                        !renameAction.enabled
                        || structuralActionsLocked
                        || pendingStructuralActionId !== null
                        || renameValue.trim().length === 0
                        || renameValue.trim() === selectedNode.label
                      }
                      onClick={() => {
                        void runStructuralAction("rename_symbol", {
                          kind: "rename_symbol",
                          targetId: selectedNode.id,
                          newName: renameValue.trim(),
                        });
                      }}
                    >
                      {pendingStructuralActionId === "rename_symbol" ? "Renaming..." : "Rename symbol"}
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
                      disabled={!deleteAction.enabled || structuralActionsLocked || pendingStructuralActionId !== null}
                      onClick={() => {
                        if (!window.confirm(`Delete ${selectedNode.label}? This removes the declaration from the current module.`)) {
                          return;
                        }
                        void runStructuralAction("delete_symbol", {
                          kind: "delete_symbol",
                          targetId: selectedNode.id,
                        });
                      }}
                    >
                      {pendingStructuralActionId === "delete_symbol" ? "Deleting..." : "Delete symbol"}
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
                      disabled={!moveAction.enabled || structuralActionsLocked || pendingStructuralActionId !== null}
                      onChange={(event) => setMoveDestinationPath(event.target.value)}
                    >
                      <option value="">Select destination module</option>
                      {sortedDestinationModulePaths.map((path) => (
                        <option key={path} value={path}>{path}</option>
                      ))}
                    </select>
                  </label>
                  <div className="blueprint-inspector__editor-actions">
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={
                        !moveAction.enabled
                        || structuralActionsLocked
                        || pendingStructuralActionId !== null
                        || moveDestinationPath.length === 0
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
                      disabled={!addImportAction.enabled || structuralActionsLocked || pendingStructuralActionId !== null}
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
                      disabled={!addImportAction.enabled || structuralActionsLocked || pendingStructuralActionId !== null}
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
                      disabled={!addImportAction.enabled || structuralActionsLocked || pendingStructuralActionId !== null}
                      onChange={(event) => setAddImportAlias(event.target.value)}
                    />
                  </label>
                  <div className="blueprint-inspector__editor-actions">
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={
                        !addImportAction.enabled
                        || structuralActionsLocked
                        || pendingStructuralActionId !== null
                        || addImportModule.trim().length === 0
                      }
                      onClick={() => {
                        void runStructuralAction("add_import", {
                          kind: "add_import",
                          relativePath: moduleRelativePath,
                          importedModule: addImportModule.trim(),
                          importedName: addImportName.trim() || undefined,
                          alias: addImportAlias.trim() || undefined,
                        }, () => {
                          setAddImportModule("");
                          setAddImportName("");
                          setAddImportAlias("");
                        });
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
                      disabled={!removeImportAction.enabled || structuralActionsLocked || pendingStructuralActionId !== null}
                      onChange={(event) => setRemoveImportModule(event.target.value)}
                    />
                  </label>
                  <div className="blueprint-inspector__editor-actions">
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={
                        !removeImportAction.enabled
                        || structuralActionsLocked
                        || pendingStructuralActionId !== null
                        || removeImportModule.trim().length === 0
                      }
                      onClick={() => {
                        void runStructuralAction("remove_import", {
                          kind: "remove_import",
                          relativePath: moduleRelativePath,
                          importedModule: removeImportModule.trim(),
                        }, () => {
                          setRemoveImportModule("");
                        });
                      }}
                    >
                      {pendingStructuralActionId === "remove_import" ? "Removing..." : "Remove import"}
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
          </div>
        </section>
      ) : null}

      {revealedSource ? (
        <section className="sidebar-section blueprint-inspector__section blueprint-inspector__section--revealed">
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
    </aside>
  );
}
