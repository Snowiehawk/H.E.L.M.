import type { EditableNodeSource, GraphNodeDto, SourceRange } from "../../../lib/adapter";
import { InspectorCodeSurface } from "../../editor/InspectorCodeSurface";
import { StatusPill } from "../../shared/StatusPill";
import { helpTargetProps } from "../workspaceHelp";
import type { OpenInspectorContextMenu } from "./types";
import { editableEditorAriaLabel, editableEditorTitle } from "./viewModel";

export function SourcePanel({
  canEditInline,
  contextTargetId,
  dirty,
  draftSource,
  draftStale,
  editableNodeKind,
  editableSource,
  editableSourceError,
  editableSourceLoading,
  highlightRange,
  isSavingSource,
  nodePath,
  sourceError,
  sourceLanguage,
  onCancel,
  onChangeDraftSource,
  onOpenContextMenu,
  onSave,
}: {
  canEditInline: boolean;
  contextTargetId?: string;
  dirty: boolean;
  draftSource: string;
  draftStale?: boolean;
  editableNodeKind?: GraphNodeDto["kind"];
  editableSource?: EditableNodeSource;
  editableSourceError?: string | null;
  editableSourceLoading: boolean;
  highlightRange?: SourceRange;
  isSavingSource: boolean;
  nodePath?: string;
  sourceError?: string | null;
  sourceLanguage: string;
  onCancel: () => void;
  onChangeDraftSource: (value: string) => void;
  onOpenContextMenu: OpenInspectorContextMenu;
  onSave: () => void | Promise<void>;
}) {
  return (
    <section
      className="sidebar-section blueprint-inspector__section blueprint-inspector__section--editor"
      onContextMenu={(event) =>
        onOpenContextMenu(event, editableSource?.targetId ?? contextTargetId)
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
                onChange={onChangeDraftSource}
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
              onClick={() => void onSave()}
            >
              {isSavingSource ? "Saving..." : "Save"}
            </button>
            <button
              {...helpTargetProps("inspector.cancel")}
              className="ghost-button"
              type="button"
              disabled={(!dirty && !draftStale) || isSavingSource}
              onClick={onCancel}
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
              {editableSource.reason ?? "This node is inspectable but not inline editable in v1."}
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
  );
}
