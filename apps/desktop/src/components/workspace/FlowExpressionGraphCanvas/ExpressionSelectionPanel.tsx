import type {
  FlowExpressionEdge,
  FlowExpressionGraph,
  FlowExpressionNode,
  FlowInputSlot,
} from "../../../lib/adapter";
import {
  BINARY_OPERATOR_OPTIONS,
  BOOL_OPERATOR_OPTIONS,
  COMPARE_OPERATOR_OPTIONS,
  EXPRESSION_INPUT_NODE_KINDS,
  UNARY_OPERATOR_OPTIONS,
  graphSummary,
  slotForInputName,
  type ExpressionTargetHandle,
} from "../../graph/flowExpressionGraphEditing";
import { flowExpressionNodeDisplayLabel } from "../../graph/flowExpressionGraph";
import type { UpdateExpressionNode } from "./types";

export function ExpressionSelectionPanel({
  diagnostics,
  error,
  expression,
  inputSlots,
  isDraftOnly,
  normalizedGraph,
  onDeleteExpressionEdges,
  onDeleteExpressionNode,
  onSetExpressionRoot,
  onUpdateExpressionNode,
  selectedEdge,
  selectedNode,
  selectedTargetHandles,
}: {
  diagnostics: string[];
  error?: string | null;
  expression: string;
  inputSlots: FlowInputSlot[];
  isDraftOnly: boolean;
  normalizedGraph: FlowExpressionGraph;
  onDeleteExpressionEdges: (edgeIds: string[]) => void;
  onDeleteExpressionNode: (nodeId: string) => void;
  onSetExpressionRoot: (nodeId: string) => void;
  onUpdateExpressionNode: UpdateExpressionNode;
  selectedEdge?: FlowExpressionEdge;
  selectedNode?: FlowExpressionNode;
  selectedTargetHandles: ExpressionTargetHandle[];
}) {
  return (
    <aside className="flow-expression-canvas__side">
      <div className="flow-expression-canvas__stat">{graphSummary(normalizedGraph)}</div>
      <div className="flow-expression-canvas__selected">
        <span className="window-bar__eyebrow">Selected</span>
        <strong>
          {selectedNode
            ? flowExpressionNodeDisplayLabel(selectedNode)
            : selectedEdge
              ? "Expression edge"
              : "None"}
        </strong>
        {selectedNode ? (
          <>
            <div className="flow-expression-canvas__selected-actions">
              <button
                className="ghost-button"
                type="button"
                disabled={selectedNode.id === normalizedGraph.rootId}
                onClick={() => onSetExpressionRoot(selectedNode.id)}
              >
                Set root
              </button>
              <button
                className="ghost-button"
                type="button"
                onClick={() => onDeleteExpressionNode(selectedNode.id)}
              >
                Delete
              </button>
            </div>
            {selectedNode.kind === "input" ? (
              <label className="blueprint-field">
                <span className="blueprint-field__label">
                  <strong>Name</strong>
                </span>
                <input
                  aria-label="Expression input name"
                  value={String(selectedNode.payload.name ?? selectedNode.label)}
                  onChange={(event) => {
                    const name = event.target.value;
                    const slot = slotForInputName(inputSlots, name);
                    onUpdateExpressionNode(selectedNode.id, (node) => ({
                      ...node,
                      label: name,
                      payload: {
                        ...node.payload,
                        name,
                        ...(slot ? { slot_id: slot.id } : {}),
                      },
                    }));
                  }}
                />
              </label>
            ) : null}
            {selectedNode.kind === "operator" ? (
              <label className="blueprint-field">
                <span className="blueprint-field__label">
                  <strong>Operator</strong>
                </span>
                <select
                  aria-label="Expression operator"
                  value={String(selectedNode.payload.operator ?? selectedNode.label)}
                  onChange={(event) => {
                    const operator = event.target.value;
                    onUpdateExpressionNode(selectedNode.id, (node) => ({
                      ...node,
                      label: operator,
                      payload: { ...node.payload, operator },
                    }));
                  }}
                >
                  {BINARY_OPERATOR_OPTIONS.map((operator) => (
                    <option key={operator} value={operator}>
                      {operator}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {selectedNode.kind === "unary" ? (
              <label className="blueprint-field">
                <span className="blueprint-field__label">
                  <strong>Unary</strong>
                </span>
                <select
                  aria-label="Expression unary operator"
                  value={String(selectedNode.payload.operator ?? selectedNode.label)}
                  onChange={(event) => {
                    const operator = event.target.value;
                    onUpdateExpressionNode(selectedNode.id, (node) => ({
                      ...node,
                      label: operator,
                      payload: { ...node.payload, operator },
                    }));
                  }}
                >
                  {UNARY_OPERATOR_OPTIONS.map((operator) => (
                    <option key={operator} value={operator}>
                      {operator}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {selectedNode.kind === "bool" ? (
              <label className="blueprint-field">
                <span className="blueprint-field__label">
                  <strong>Boolean</strong>
                </span>
                <select
                  aria-label="Expression boolean operator"
                  value={String(selectedNode.payload.operator ?? selectedNode.label)}
                  onChange={(event) => {
                    const operator = event.target.value;
                    onUpdateExpressionNode(selectedNode.id, (node) => ({
                      ...node,
                      label: operator,
                      payload: { ...node.payload, operator },
                    }));
                  }}
                >
                  {BOOL_OPERATOR_OPTIONS.map((operator) => (
                    <option key={operator} value={operator}>
                      {operator}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {selectedNode.kind === "compare" ? (
              <label className="blueprint-field">
                <span className="blueprint-field__label">
                  <strong>Compare</strong>
                </span>
                <select
                  aria-label="Expression compare operator"
                  value={String(
                    (selectedNode.payload.operators as unknown[] | undefined)?.[0] ??
                      selectedNode.label,
                  )}
                  onChange={(event) => {
                    const operator = event.target.value;
                    onUpdateExpressionNode(selectedNode.id, (node) => ({
                      ...node,
                      label: operator,
                      payload: { ...node.payload, operators: [operator] },
                    }));
                  }}
                >
                  {COMPARE_OPERATOR_OPTIONS.map((operator) => (
                    <option key={operator} value={operator}>
                      {operator}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {selectedNode.kind === "literal" || selectedNode.kind === "raw" ? (
              <label className="blueprint-field">
                <span className="blueprint-field__label">
                  <strong>{selectedNode.kind === "literal" ? "Literal" : "Raw"}</strong>
                </span>
                <input
                  aria-label={`Expression ${selectedNode.kind} source`}
                  value={String(selectedNode.payload.expression ?? selectedNode.label)}
                  onChange={(event) => {
                    const source = event.target.value;
                    onUpdateExpressionNode(selectedNode.id, (node) => ({
                      ...node,
                      label: source,
                      payload: { ...node.payload, expression: source },
                    }));
                  }}
                />
              </label>
            ) : null}
            {!EXPRESSION_INPUT_NODE_KINDS.has(selectedNode.kind) ? (
              <div className="flow-expression-canvas__target-list">
                <span className="window-bar__eyebrow">Inputs</span>
                {selectedTargetHandles.map((targetHandle) => (
                  <span key={targetHandle.id}>{targetHandle.id}</span>
                ))}
              </div>
            ) : null}
          </>
        ) : null}
        {selectedEdge ? (
          <button
            className="ghost-button"
            type="button"
            onClick={() => onDeleteExpressionEdges([selectedEdge.id])}
          >
            Delete edge
          </button>
        ) : null}
      </div>
      <div className="flow-expression-canvas__source">
        <span className="blueprint-field__label">
          <strong>Expression source</strong>
          <span>{isDraftOnly ? "Draft only" : "Generated"}</span>
        </span>
        <code>{expression || "..."}</code>
      </div>
      {diagnostics.length ? (
        <div className="flow-expression-canvas__diagnostics">
          {diagnostics.map((diagnostic) => (
            <span key={diagnostic}>{diagnostic}</span>
          ))}
        </div>
      ) : null}
      {error ? <p className="error-copy">{error}</p> : null}
    </aside>
  );
}
