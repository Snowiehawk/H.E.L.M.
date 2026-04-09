import { useEffect, useMemo, useState } from "react";
import type {
  EditableNodeSource,
  GraphNodeDto,
  RevealedSource,
  StructuralEditResult,
  SymbolDetails,
} from "../../lib/adapter";
import {
  isGraphSymbolNodeKind,
  isInspectableGraphNodeKind,
} from "../../lib/adapter";
import { StatusPill } from "../shared/StatusPill";
import { helpTargetProps } from "./workspaceHelp";

function metadataString(node: GraphNodeDto | undefined, key: string): string | undefined {
  const camelKey = key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
  const value = node?.metadata[key] ?? node?.metadata[camelKey];
  return typeof value === "string" ? value : undefined;
}

function metadataBoolean(node: GraphNodeDto | undefined, key: string): boolean | undefined {
  const camelKey = key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
  const value = node?.metadata[key] ?? node?.metadata[camelKey];
  return typeof value === "boolean" ? value : undefined;
}

function relativePathForNode(node: GraphNodeDto | undefined): string | undefined {
  return metadataString(node, "relative_path")
    ?? (node?.kind === "module" && node.subtitle?.endsWith(".py") ? node.subtitle : undefined);
}

function selectionSummary(node: GraphNodeDto | undefined): string | undefined {
  if (!node) {
    return undefined;
  }
  const relativePath = relativePathForNode(node);
  if (node.kind === "module" && relativePath) {
    return relativePath;
  }
  if (isGraphSymbolNodeKind(node.kind)) {
    return metadataString(node, "qualname") ?? node.subtitle ?? undefined;
  }
  return node.subtitle ?? undefined;
}

function revealActionEnabled(node?: GraphNodeDto): boolean {
  return Boolean(node?.availableActions.find((action) => action.actionId === "reveal_source")?.enabled);
}

export function BlueprintInspector({
  selectedNode,
  symbol,
  editableSource,
  editableSourceLoading,
  editableSourceError,
  revealedSource,
  lastEdit,
  isSavingSource,
  onSaveSource,
  onEditorStateChange,
  onOpenFlow,
  onOpenBlueprint,
  onRevealSource,
  onOpenInDefaultEditor,
  onDismissSource,
  onClose,
}: {
  selectedNode?: GraphNodeDto;
  symbol?: SymbolDetails;
  editableSource?: EditableNodeSource;
  editableSourceLoading: boolean;
  editableSourceError?: string | null;
  revealedSource?: RevealedSource;
  lastEdit?: StructuralEditResult;
  isSavingSource: boolean;
  onSaveSource: (targetId: string, content: string) => Promise<void>;
  onEditorStateChange: (content?: string, dirty?: boolean) => void;
  onOpenFlow: (symbolId: string) => void;
  onOpenBlueprint: (symbolId: string) => void;
  onRevealSource: (nodeId: string) => void;
  onOpenInDefaultEditor: (targetId: string) => Promise<void>;
  onDismissSource: () => void;
  onClose: () => void;
}) {
  const [draftSource, setDraftSource] = useState("");
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [openInEditorError, setOpenInEditorError] = useState<string | null>(null);
  const selectedRelativePath = relativePathForNode(selectedNode);
  const selectedSummary = selectionSummary(selectedNode);
  const nodePath = editableSource?.path ?? selectedRelativePath ?? symbol?.filePath;
  const canEditInline = Boolean(
    selectedNode
    && editableSource
    && editableSource.editable
    && (selectedNode.kind === "function" || selectedNode.kind === "variable"),
  );
  const dirty = canEditInline && draftSource !== editableSource?.content;
  const topLevel = metadataBoolean(selectedNode, "top_level");

  useEffect(() => {
    setDraftSource(editableSource?.content ?? "");
    setSourceError(null);
  }, [editableSource?.targetId, editableSource?.content]);

  useEffect(() => {
    if (canEditInline) {
      onEditorStateChange(draftSource, dirty);
      return;
    }
    onEditorStateChange(undefined, false);
  }, [canEditInline, dirty, draftSource, onEditorStateChange]);

  useEffect(() => {
    setOpenInEditorError(null);
  }, [selectedNode?.id]);

  const quickActions = useMemo(() => {
    if (!selectedNode) {
      return [];
    }

    const actions: Array<{
      id: string;
      label: string;
      onClick: () => void;
    }> = [];

    if (selectedNode.kind === "function") {
      actions.push({
        id: "open-blueprint",
        label: "Open blueprint",
        onClick: () => onOpenBlueprint(selectedNode.id),
      });
    }

    if (selectedNode.kind === "function" || selectedNode.kind === "class") {
      actions.push({
        id: "open-flow",
        label: "Open flow",
        onClick: () => onOpenFlow(selectedNode.id),
      });
    }

    if (revealActionEnabled(selectedNode)) {
      actions.push({
        id: "reveal-source",
        label: revealedSource?.targetId === selectedNode.id ? "Refresh source" : "Reveal source",
        onClick: () => onRevealSource(selectedNode.id),
      });
    }

    return actions;
  }, [onOpenBlueprint, onOpenFlow, onRevealSource, revealedSource?.targetId, selectedNode]);

  const handleSave = async () => {
    if (!selectedNode || !canEditInline) {
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

  const handleOpenInEditor = async () => {
    if (!selectedNode) {
      return;
    }

    setOpenInEditorError(null);
    try {
      await onOpenInDefaultEditor(selectedNode.id);
    } catch (reason) {
      setOpenInEditorError(
        reason instanceof Error ? reason.message : "Unable to open the file in the default editor.",
      );
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
              {...helpTargetProps("inspector.close")}
              className="ghost-button"
              type="button"
              onClick={onClose}
            >
              Close
            </button>
          </div>
          <p>Select a graph node, then inspect or enter it explicitly from the canvas.</p>
        </section>
      </aside>
    );
  }

  return (
    <aside className="pane pane--inspector blueprint-inspector">
      <section className="sidebar-card blueprint-inspector__card">
        <div className="sidebar-card__header">
          <div>
            <span className="window-bar__eyebrow">Inspector</span>
            <h2>{selectedNode.label}</h2>
          </div>
          <div className="blueprint-inspector__chrome">
            <StatusPill tone="default">{selectedNode.kind}</StatusPill>
            <button
              {...helpTargetProps("inspector.close")}
              className="ghost-button"
              type="button"
              onClick={onClose}
            >
              Close
            </button>
          </div>
        </div>

        <div className="blueprint-inspector__meta">
          <div className="info-card">
            <span className="info-card__label">Path</span>
            <strong>{nodePath ?? "No file path"}</strong>
            {selectedSummary && selectedSummary !== nodePath ? <p>{selectedSummary}</p> : null}
          </div>

          <div className="blueprint-inspector__header-actions">
            {nodePath ? (
              <button
                {...helpTargetProps("inspector.open-default-editor")}
                className="secondary-button"
                type="button"
                onClick={() => void handleOpenInEditor()}
              >
                Open File In Default Editor
              </button>
            ) : null}
            {quickActions.map((action) => (
              <button
                key={action.id}
                {...helpTargetProps(
                  action.id === "open-flow"
                    ? "inspector.open-flow"
                    : action.id === "open-blueprint"
                      ? "inspector.open-blueprint"
                      : "inspector.reveal-source",
                )}
                className="ghost-button"
                type="button"
                onClick={action.onClick}
              >
                {action.label}
              </button>
            ))}
          </div>

          {openInEditorError ? <p className="error-copy">{openInEditorError}</p> : null}
        </div>
      </section>

      <section className="sidebar-section blueprint-inspector__section">
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
        <section className="sidebar-section blueprint-inspector__section">
          <div className="section-header">
            <h3>{canEditInline ? "Declaration editor" : "Code details"}</h3>
            <span>
              {editableSourceLoading
                ? "loading"
                : canEditInline
                  ? dirty
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
              <label className="blueprint-field blueprint-field--editor">
                <span className="blueprint-field__label">
                  <strong>{selectedNode.kind === "function" ? "Function source" : "Variable source"}</strong>
                  <StatusPill tone={dirty ? "accent" : "default"}>{dirty ? "Unsaved" : "Synced"}</StatusPill>
                </span>
                <textarea
                  {...helpTargetProps("inspector.editor")}
                  className="blueprint-editor"
                  spellCheck={false}
                  value={draftSource}
                  onChange={(event) => setDraftSource(event.target.value)}
                  rows={14}
                />
              </label>

              {sourceError ? <p className="error-copy">{sourceError}</p> : null}

              <div className="blueprint-inspector__editor-actions">
                <button
                  {...helpTargetProps("inspector.save")}
                  className="primary-button"
                  type="button"
                  disabled={!dirty || isSavingSource}
                  onClick={() => void handleSave()}
                >
                  {isSavingSource ? "Saving..." : "Save"}
                </button>
                <button
                  {...helpTargetProps("inspector.cancel")}
                  className="ghost-button"
                  type="button"
                  disabled={!dirty || isSavingSource}
                  onClick={handleCancel}
                >
                  Cancel
                </button>
              </div>
            </>
          ) : editableSource ? (
            <div className="info-card">
              <strong>{editableSource.nodeKind}</strong>
              <p>{editableSource.reason ?? "This node is inspectable but not inline editable in v1."}</p>
              <p className="muted-copy">
                Lines {editableSource.startLine}-{editableSource.endLine}
              </p>
            </div>
          ) : (
            <div className="info-card">
              <p>Source metadata is not available for this node yet.</p>
            </div>
          )}
        </section>
      ) : null}

      {lastEdit ? (
        <section className="sidebar-section blueprint-inspector__section">
          <div className="section-header">
            <h3>Last Edit</h3>
            <span>{lastEdit.touchedRelativePaths.length} files</span>
          </div>
          <div className="info-card">
            <strong>{lastEdit.summary}</strong>
            <p>
              Touched: {lastEdit.touchedRelativePaths.join(", ") || "none"}.
              {lastEdit.warnings.length ? ` Warnings: ${lastEdit.warnings.join(" ")}` : ""}
            </p>
          </div>
        </section>
      ) : null}

      {revealedSource ? (
        <section className="sidebar-section blueprint-inspector__section">
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
          <pre className="code-panel blueprint-source-panel">
            <code>{revealedSource.content}</code>
          </pre>
        </section>
      ) : null}
    </aside>
  );
}
