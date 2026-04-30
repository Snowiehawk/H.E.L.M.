import type { GraphActionDto, GraphNodeDto } from "../../../lib/adapter";
import type { RunStructuralAction } from "./types";

export function StructuralActionsPanel({
  addImportAction,
  addImportAlias,
  addImportModule,
  addImportName,
  deleteAction,
  moduleRelativePath,
  moveAction,
  moveDestinationPath,
  pendingStructuralActionId,
  removeImportAction,
  removeImportModule,
  renameAction,
  renameValue,
  selectedNode,
  sortedDestinationModulePaths,
  structuralActionError,
  structuralActionsLocked,
  structuralActionsLockedReason,
  onAddImportAliasChange,
  onAddImportModuleChange,
  onAddImportNameChange,
  onMoveDestinationPathChange,
  onRemoveImportModuleChange,
  onRenameValueChange,
  onRunStructuralAction,
}: {
  addImportAction?: GraphActionDto;
  addImportAlias: string;
  addImportModule: string;
  addImportName: string;
  deleteAction?: GraphActionDto;
  moduleRelativePath?: string;
  moveAction?: GraphActionDto;
  moveDestinationPath: string;
  pendingStructuralActionId: string | null;
  removeImportAction?: GraphActionDto;
  removeImportModule: string;
  renameAction?: GraphActionDto;
  renameValue: string;
  selectedNode?: GraphNodeDto;
  sortedDestinationModulePaths: string[];
  structuralActionError?: string | null;
  structuralActionsLocked: boolean;
  structuralActionsLockedReason: string | null;
  onAddImportAliasChange: (value: string) => void;
  onAddImportModuleChange: (value: string) => void;
  onAddImportNameChange: (value: string) => void;
  onMoveDestinationPathChange: (value: string) => void;
  onRemoveImportModuleChange: (value: string) => void;
  onRenameValueChange: (value: string) => void;
  onRunStructuralAction: RunStructuralAction;
}) {
  return (
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
                  onChange={(event) => onRenameValueChange(event.target.value)}
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
                    void onRunStructuralAction("rename_symbol", {
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
                  onClick={() => onRenameValueChange(selectedNode.label)}
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
                    void onRunStructuralAction("delete_symbol", {
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
                  disabled={
                    !moveAction.enabled ||
                    structuralActionsLocked ||
                    pendingStructuralActionId !== null
                  }
                  onChange={(event) => onMoveDestinationPathChange(event.target.value)}
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
                    void onRunStructuralAction("move_symbol", {
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
                  onChange={(event) => onAddImportModuleChange(event.target.value)}
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
                  onChange={(event) => onAddImportNameChange(event.target.value)}
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
                  onChange={(event) => onAddImportAliasChange(event.target.value)}
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
                    void onRunStructuralAction(
                      "add_import",
                      {
                        kind: "add_import",
                        relativePath: moduleRelativePath,
                        importedModule: addImportModule.trim(),
                        importedName: addImportName.trim() || undefined,
                        alias: addImportAlias.trim() || undefined,
                      },
                      () => {
                        onAddImportModuleChange("");
                        onAddImportNameChange("");
                        onAddImportAliasChange("");
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
                  onChange={(event) => onRemoveImportModuleChange(event.target.value)}
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
                    void onRunStructuralAction(
                      "remove_import",
                      {
                        kind: "remove_import",
                        relativePath: moduleRelativePath,
                        importedModule: removeImportModule.trim(),
                      },
                      () => {
                        onRemoveImportModuleChange("");
                      },
                    );
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
  );
}
