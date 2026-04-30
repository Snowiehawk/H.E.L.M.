import { InspectorCodeSurface } from "../../components/editor/InspectorCodeSurface";
import { inferInspectorLanguage } from "../../components/editor/inspectorLanguage";
import { StatusPill } from "../../components/shared/StatusPill";
import type { WorkspaceFileContents } from "../../lib/adapter";

export function WorkspaceFileEditorPanel({
  file,
  draft,
  dirty,
  stale,
  error,
  isLoading,
  isSaving,
  saveError,
  onCancel,
  onChange,
  onClose,
  onSave,
}: {
  file?: WorkspaceFileContents;
  draft: string;
  dirty: boolean;
  stale: boolean;
  error?: string | null;
  isLoading: boolean;
  isSaving: boolean;
  saveError?: string | null;
  onCancel: () => void;
  onChange: (content: string) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const language = inferInspectorLanguage({
    editablePath: file?.relativePath,
  });
  const status = stale ? "Stale" : dirty ? "Unsaved" : "Synced";

  return (
    <aside className="workspace-file-editor">
      <div className="workspace-file-editor__header">
        <div>
          <span className="window-bar__eyebrow">File editor</span>
          <h3>{file?.relativePath ?? "Loading file"}</h3>
        </div>
        <button className="ghost-button" type="button" onClick={onClose}>
          Close
        </button>
      </div>

      {isLoading ? (
        <div className="info-card">
          <p>Loading file...</p>
        </div>
      ) : error ? (
        <div className="info-card blueprint-inspector__error-card">
          <strong>File unavailable</strong>
          <p>{error}</p>
        </div>
      ) : file?.editable ? (
        <>
          <div className="workspace-file-editor__meta">
            <span>{file.sizeBytes ?? 0} bytes</span>
            <StatusPill tone={stale ? "warning" : dirty ? "accent" : "default"}>
              {status}
            </StatusPill>
          </div>
          <InspectorCodeSurface
            ariaLabel={`Edit ${file.relativePath}`}
            className="workspace-file-editor__surface"
            dataTestId="workspace-file-editor"
            height="clamp(300px, 42vh, 520px)"
            language={language}
            path={file.relativePath}
            readOnly={false}
            value={draft}
            onChange={onChange}
          />
          {stale ? (
            <div className="info-card blueprint-inspector__error-card">
              <strong>Draft is stale</strong>
              <p>This file changed on disk. Reload it before saving again.</p>
            </div>
          ) : null}
          {saveError ? <p className="error-copy">{saveError}</p> : null}
          <div className="workspace-file-editor__actions">
            <button
              className="primary-button"
              type="button"
              disabled={stale || !dirty || isSaving}
              onClick={onSave}
            >
              {isSaving ? "Saving..." : "Save"}
            </button>
            <button
              className="ghost-button"
              type="button"
              disabled={(!dirty && !stale) || isSaving}
              onClick={onCancel}
            >
              {stale ? "Reload from Disk" : "Cancel"}
            </button>
          </div>
        </>
      ) : file ? (
        <>
          <InspectorCodeSurface
            ariaLabel={`Read-only ${file.relativePath}`}
            className="workspace-file-editor__surface"
            dataTestId="workspace-file-editor-readonly"
            height="clamp(240px, 34vh, 420px)"
            language={language}
            path={file.relativePath}
            readOnly
            value={file.content}
          />
          <div className="info-card">
            <strong>Read only</strong>
            <p>{file.reason ?? "This file is not editable inline."}</p>
          </div>
        </>
      ) : null}
    </aside>
  );
}
