import type { FlowExpressionNodeKind, FlowInputSlot } from "../../../lib/adapter";

export function ExpressionGraphToolbar({
  inputSlots,
  newInputSlotId,
  onAddExpressionNode,
  onChangeNewInputSlotId,
}: {
  inputSlots: FlowInputSlot[];
  newInputSlotId: string;
  onAddExpressionNode: (kind: FlowExpressionNodeKind) => void;
  onChangeNewInputSlotId: (slotId: string) => void;
}) {
  return (
    <div className="flow-expression-canvas__toolbar" aria-label="Expression graph tools">
      <label className="flow-expression-canvas__slot-picker">
        <span>Input</span>
        <select
          aria-label="Input node source"
          value={newInputSlotId}
          onChange={(event) => onChangeNewInputSlotId(event.target.value)}
        >
          {inputSlots.length ? (
            inputSlots.map((slot) => (
              <option key={slot.id} value={slot.id}>
                {slot.label || slot.slotKey}
              </option>
            ))
          ) : (
            <option value="">value</option>
          )}
        </select>
      </label>
      <button
        type="button"
        className="secondary-button"
        onClick={() => onAddExpressionNode("input")}
      >
        Add input
      </button>
      <button
        type="button"
        className="secondary-button"
        onClick={() => onAddExpressionNode("operator")}
      >
        Add +
      </button>
      <button
        type="button"
        className="secondary-button"
        onClick={() => onAddExpressionNode("call")}
      >
        Add call
      </button>
      <button
        type="button"
        className="secondary-button"
        onClick={() => onAddExpressionNode("literal")}
      >
        Add literal
      </button>
      <button type="button" className="secondary-button" onClick={() => onAddExpressionNode("raw")}>
        Add raw
      </button>
    </div>
  );
}
