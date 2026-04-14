import { useEffect, useRef, useState } from "react";
import type {
  EditableNodeSource,
  GraphNodeDto,
  RevealedSource,
  SourceRange,
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

export function BlueprintInspector({
  selectedNode,
  symbol,
  editableSource,
  editableSourceLoading,
  editableSourceError,
  draftStale,
  revealedSource,
  lastActivity,
  isSavingSource,
  createFunctionTargetPath,
  createFunctionError,
  isCreatingFunction,
  highlightRange,
  onCreateFunction,
  onSaveSource,
  onEditorStateChange,
  onDismissSource,
  onClose,
}: {
  selectedNode?: GraphNodeDto;
  symbol?: SymbolDetails;
  editableSource?: EditableNodeSource;
  editableSourceLoading: boolean;
  editableSourceError?: string | null;
  draftStale?: boolean;
  revealedSource?: RevealedSource;
  lastActivity?: WorkspaceActivity;
  isSavingSource: boolean;
  createFunctionTargetPath?: string;
  createFunctionError?: string | null;
  isCreatingFunction?: boolean;
  highlightRange?: SourceRange;
  onCreateFunction?: (relativePath: string, newName: string) => Promise<void>;
  onSaveSource: (targetId: string, content: string) => Promise<void>;
  onEditorStateChange: (content?: string, dirty?: boolean) => void;
  onDismissSource: () => void;
  onClose: () => void;
}) {
  const [draftSource, setDraftSource] = useState("");
  const [sourceError, setSourceError] = useState<string | null>(null);
  const previousEditableTargetIdRef = useRef<string | undefined>(undefined);
  const selectedRelativePath = relativePathForNode(selectedNode);
  const selectedSummary = selectionSummary(selectedNode);
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
          {createFunctionTargetPath ? (
            <div className="info-card">
              <strong>{createFunctionTargetPath}</strong>
              <p>Module and symbol views can create new declarations directly from the graph.</p>
            </div>
          ) : null}
          {createFunctionError ? <p className="error-copy">{createFunctionError}</p> : null}
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
