import type { FormEvent, RefObject } from "react";
import type { ExplorerCreateDraft } from "./types";

export function WorkspaceCreateForm({
  createDraft,
  createDraftLabel,
  inputRef,
  onCancel,
  onChangeRelativePath,
  onSubmit,
}: {
  createDraft: ExplorerCreateDraft;
  createDraftLabel: string;
  inputRef: RefObject<HTMLInputElement>;
  onCancel: () => void;
  onChangeRelativePath: (relativePath: string) => void;
  onSubmit: (event?: FormEvent<HTMLFormElement>) => void | Promise<void>;
}) {
  return (
    <form
      className="explorer-create-form"
      onSubmit={(event) => {
        void onSubmit(event);
      }}
    >
      <label className="explorer-create-form__label">
        <span>{`New ${createDraftLabel}`}</span>
        <input
          ref={inputRef}
          aria-label={`New ${createDraftLabel} path`}
          className="explorer-create-form__input"
          value={createDraft.relativePath}
          disabled={createDraft.isSubmitting}
          onChange={(event) => onChangeRelativePath(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onCancel();
            }
          }}
        />
      </label>
      {createDraft.error ? (
        <p className="error-copy explorer-create-form__error">{createDraft.error}</p>
      ) : null}
      <div className="explorer-create-form__actions">
        <button
          className="primary-button primary-button--compact"
          type="submit"
          disabled={createDraft.isSubmitting}
        >
          {createDraft.isSubmitting ? "Creating..." : "Create"}
        </button>
        <button
          className="ghost-button ghost-button--compact"
          type="button"
          disabled={createDraft.isSubmitting}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
