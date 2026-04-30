import type { FlowFunctionInput, FlowInputDisplayMode } from "../../../lib/adapter";
import { StatusPill } from "../../shared/StatusPill";
import type { FlowFunctionInputDraftState, FlowFunctionInputPatch } from "./types";

export function FlowInputsPanel({
  flowInputDisplayMode,
  flowInputDraftDirty,
  flowInputDrafts,
  flowInputsEditable,
  newFlowInputDefault,
  newFlowInputName,
  sortedFlowFunctionInputs,
  onAddFlowFunctionInput,
  onChangeNewFlowInputDefault,
  onChangeNewFlowInputName,
  onCommitFlowInputDraft,
  onMoveFlowFunctionInput,
  onRemoveFlowFunctionInput,
  onUpdateFlowFunctionInput,
  onUpdateFlowInputDraft,
}: {
  flowInputDisplayMode?: FlowInputDisplayMode;
  flowInputDraftDirty: (input: FlowFunctionInput) => boolean;
  flowInputDrafts: Record<string, FlowFunctionInputDraftState>;
  flowInputsEditable: boolean;
  newFlowInputDefault: string;
  newFlowInputName: string;
  sortedFlowFunctionInputs: FlowFunctionInput[];
  onAddFlowFunctionInput?: (draft: FlowFunctionInputPatch) => void;
  onChangeNewFlowInputDefault: (value: string) => void;
  onChangeNewFlowInputName: (value: string) => void;
  onCommitFlowInputDraft: (input: FlowFunctionInput) => void;
  onMoveFlowFunctionInput?: (inputId: string, direction: -1 | 1) => void;
  onRemoveFlowFunctionInput?: (inputId: string) => void;
  onUpdateFlowFunctionInput?: (inputId: string, patch: FlowFunctionInputPatch) => void;
  onUpdateFlowInputDraft: (inputId: string, patch: Partial<FlowFunctionInputDraftState>) => void;
}) {
  return (
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
            onChange={(event) => onChangeNewFlowInputName(event.target.value)}
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
            onChange={(event) => onChangeNewFlowInputDefault(event.target.value)}
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
                  <StatusPill tone="default">{input.kind ?? "positional_or_keyword"}</StatusPill>
                </div>
                <label className="blueprint-field">
                  <span className="blueprint-field__label">Name</span>
                  <input
                    aria-label={`Flow input ${input.name} name`}
                    type="text"
                    value={draft.name}
                    disabled={!flowInputsEditable}
                    onChange={(event) =>
                      onUpdateFlowInputDraft(input.id, { name: event.target.value })
                    }
                    onBlur={() => {
                      if (dirtyInput) {
                        onCommitFlowInputDraft(input);
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
                      onUpdateFlowInputDraft(input.id, {
                        defaultExpression: event.target.value,
                      })
                    }
                    onBlur={() => {
                      if (dirtyInput) {
                        onCommitFlowInputDraft(input);
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
                    onClick={() => onCommitFlowInputDraft(input)}
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
  );
}
