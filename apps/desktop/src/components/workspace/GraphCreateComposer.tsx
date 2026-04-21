import { useEffect, useMemo, useState } from "react";
import {
  FLOW_AUTHORABLE_NODE_KINDS,
  canonicalFlowLoopHeader,
  flowLoopPayloadFromDraft,
  flowNodeContentFromPayload,
  normalizeFlowLoopPayload,
  type AuthoredFlowNodeKind,
  type FlowLoopDraft,
  type FlowLoopType,
} from "../graph/flowDocument";
import { useClampedFloatingPanel } from "../shared/floatingPanel";

type FlowCreateKind = AuthoredFlowNodeKind | "param";
type LoopStarterOutput = "repeat" | "done";

export interface GraphCreateComposerAnchor {
  x: number;
  y: number;
}

export interface GraphCreateComposerFlowPosition {
  x: number;
  y: number;
}

export interface GraphCreateComposerFlowSeed {
  sourceNodeId: string;
  sourceHandle: "body" | "after";
  label: "Repeat" | "Done";
}

export type GraphCreateComposerState =
  | {
      id: string;
      kind: "repo";
      anchor: GraphCreateComposerAnchor;
      flowPosition: GraphCreateComposerFlowPosition;
    }
  | {
      id: string;
      kind: "symbol";
      anchor: GraphCreateComposerAnchor;
      flowPosition: GraphCreateComposerFlowPosition;
      targetModulePath: string;
    }
  | {
      id: string;
      kind: "flow";
      mode: "create" | "edit";
      anchor: GraphCreateComposerAnchor;
      flowPosition: GraphCreateComposerFlowPosition;
      ownerLabel: string;
      editingNodeId?: string;
      initialFlowNodeKind?: AuthoredFlowNodeKind;
      initialPayload?: Record<string, unknown>;
      initialLoopType?: FlowLoopType;
      seedFlowConnection?: GraphCreateComposerFlowSeed;
    };

export type GraphCreateComposerSubmit =
  | {
      kind: "repo";
      relativePath: string;
      content?: string;
    }
  | {
      kind: "symbol";
      symbolKind: "function" | "class";
      newName: string;
      body?: string;
    }
  | {
      kind: "flow";
      flowNodeKind: AuthoredFlowNodeKind;
      content: string;
      payload?: Record<string, unknown>;
      starterSteps?: FlowStarterStepSubmit[];
    }
  | {
      kind: "flow_param";
      name: string;
      defaultExpression?: string | null;
    };

export interface FlowStarterStepSubmit {
  sourceHandle: "body" | "after";
  flowNodeKind: AuthoredFlowNodeKind;
  payload: Record<string, unknown>;
}

type FlowStepDraft = {
  enabled: boolean;
  flowKind: AuthoredFlowNodeKind;
  statement: string;
  branchCondition: string;
  loopDraft: FlowLoopDraft;
};

const EMPTY_LOOP_DRAFT: FlowLoopDraft = {
  loopType: "while",
  condition: "",
  target: "",
  iterable: "",
};

function emptyFlowStepDraft(): FlowStepDraft {
  return {
    enabled: false,
    flowKind: "assign",
    statement: "",
    branchCondition: "",
    loopDraft: { ...EMPTY_LOOP_DRAFT },
  };
}

export function GraphCreateComposer({
  composer,
  error,
  isSubmitting,
  onCancel,
  onSubmit,
}: {
  composer: GraphCreateComposerState;
  error?: string | null;
  isSubmitting: boolean;
  onCancel: () => void;
  onSubmit: (payload: GraphCreateComposerSubmit) => Promise<void>;
}) {
  const [modulePath, setModulePath] = useState("");
  const [moduleContent, setModuleContent] = useState("");
  const [symbolKind, setSymbolKind] = useState<"function" | "class">("function");
  const [symbolName, setSymbolName] = useState("");
  const [symbolBody, setSymbolBody] = useState("");
  const [flowKind, setFlowKind] = useState<FlowCreateKind>("assign");
  const [flowStatement, setFlowStatement] = useState("");
  const [branchCondition, setBranchCondition] = useState("");
  const [loopDraft, setLoopDraft] = useState<FlowLoopDraft>(EMPTY_LOOP_DRAFT);
  const [repeatStep, setRepeatStep] = useState<FlowStepDraft>(() => emptyFlowStepDraft());
  const [doneStep, setDoneStep] = useState<FlowStepDraft>(() => emptyFlowStepDraft());
  const [parameterName, setParameterName] = useState("");
  const [parameterDefaultExpression, setParameterDefaultExpression] = useState("");

  useEffect(() => {
    setModulePath("");
    setModuleContent("");
    setSymbolKind("function");
    setSymbolName("");
    setSymbolBody("");

    if (composer.kind !== "flow") {
      setFlowKind("assign");
      setFlowStatement("");
      setBranchCondition("");
      setLoopDraft({ ...EMPTY_LOOP_DRAFT });
      setRepeatStep(emptyFlowStepDraft());
      setDoneStep(emptyFlowStepDraft());
      setParameterName("");
      setParameterDefaultExpression("");
      return;
    }

    const nextKind = composer.initialFlowNodeKind ?? "assign";
    const nextPayload = composer.initialPayload ?? {};
    setFlowKind(nextKind);
    setFlowStatement(flowStatementFromComposer(nextKind, nextPayload));
    setBranchCondition(nextKind === "branch" && typeof nextPayload.condition === "string" ? nextPayload.condition : "");
    setLoopDraft(
      nextKind === "loop"
        ? loopDraftFromPayload(nextPayload, composer.initialLoopType)
        : { ...EMPTY_LOOP_DRAFT },
    );
    setRepeatStep(emptyFlowStepDraft());
    setDoneStep(emptyFlowStepDraft());
    setParameterName("");
    setParameterDefaultExpression("");
  }, [composer.id]);

  const title = useMemo(() => {
    if (composer.kind === "repo") {
      return "Create module";
    }
    if (composer.kind === "symbol") {
      return "Create symbol";
    }
    if (composer.mode === "edit" && composer.initialFlowNodeKind === "loop") {
      return "Edit loop";
    }
    if (composer.seedFlowConnection) {
      return `Add ${composer.seedFlowConnection.label} step`;
    }
    return composer.mode === "edit" ? "Edit flow node" : "Create flow node";
  }, [composer]);

  const handleSubmit = async () => {
    if (composer.kind === "repo") {
      await onSubmit({
        kind: "repo",
        relativePath: modulePath.trim(),
        content: moduleContent.trim() ? moduleContent : undefined,
      });
      return;
    }

    if (composer.kind === "symbol") {
      await onSubmit({
        kind: "symbol",
        symbolKind,
        newName: symbolName.trim(),
        body: symbolBody.trim() ? symbolBody : undefined,
      });
      return;
    }

    if (flowKind === "param") {
      await onSubmit({
        kind: "flow_param",
        name: parameterName.trim(),
        defaultExpression: parameterDefaultExpression.trim() || null,
      });
      return;
    }

    const payload = flowPayloadFromDraft({
      flowKind,
      statement: flowStatement,
      branchCondition,
      loopDraft,
    });
    await onSubmit({
      kind: "flow",
      flowNodeKind: flowKind,
      content: flowNodeContentFromPayload(flowKind, payload),
      payload,
      starterSteps: flowKind === "loop" && composer.mode === "create"
        ? buildStarterStepSubmits(repeatStep, doneStep)
        : undefined,
    });
  };

  const canSubmit = (() => {
    if (composer.kind === "repo") {
      return modulePath.trim().length > 0;
    }
    if (composer.kind === "symbol") {
      return symbolName.trim().length > 0;
    }
    if (flowKind === "param") {
      return parameterName.trim().length > 0;
    }
    const mainValid = isFlowDraftValid({
      flowKind,
      statement: flowStatement,
      branchCondition,
      loopDraft,
    });
    return mainValid
      && isStarterStepValid(repeatStep)
      && isStarterStepValid(doneStep);
  })();
  const floatingPanel = useClampedFloatingPanel(composer.anchor);

  return (
    <div
      ref={floatingPanel.ref}
      className="graph-create-composer"
      data-testid="graph-create-composer"
      style={floatingPanel.style}
    >
      <div className="graph-create-composer__header">
        <div>
          <span className="window-bar__eyebrow">
            {composer.kind === "flow" && composer.mode === "edit" ? "Flow draft" : "Create mode"}
          </span>
          <h3>{title}</h3>
        </div>
        <button className="ghost-button" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>

      {composer.kind === "repo" ? (
        <form
          className="blueprint-form"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSubmit();
          }}
        >
          <label className="blueprint-field">
            <span className="blueprint-field__label">
              <strong>Module path</strong>
            </span>
            <input
              aria-label="Module path"
              autoFocus
              autoComplete="off"
              placeholder="pkg/new_module.py"
              spellCheck={false}
              type="text"
              value={modulePath}
              onChange={(event) => setModulePath(event.target.value)}
            />
          </label>
          <label className="blueprint-field">
            <span className="blueprint-field__label">
              <strong>Starter source</strong>
            </span>
            <textarea
              aria-label="Module starter source"
              placeholder="Optional initial module contents"
              rows={5}
              value={moduleContent}
              onChange={(event) => setModuleContent(event.target.value)}
            />
          </label>
          {error ? <p className="error-copy">{error}</p> : null}
          <div className="graph-create-composer__actions">
            <button className="primary-button" type="submit" disabled={!canSubmit || isSubmitting}>
              {isSubmitting ? "Creating..." : "Create module"}
            </button>
          </div>
        </form>
      ) : null}

      {composer.kind === "symbol" ? (
        <form
          className="blueprint-form"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSubmit();
          }}
        >
          <div className="info-card">
            <strong>{composer.targetModulePath}</strong>
            <p>Create a top-level declaration at the clicked spot in this module.</p>
          </div>
          <label className="blueprint-field">
            <span className="blueprint-field__label">
              <strong>Type</strong>
            </span>
            <select
              aria-label="Symbol type"
              value={symbolKind}
              onChange={(event) => setSymbolKind(event.target.value as "function" | "class")}
            >
              <option value="function">Function</option>
              <option value="class">Class</option>
            </select>
          </label>
          <label className="blueprint-field">
            <span className="blueprint-field__label">
              <strong>Name</strong>
            </span>
            <input
              aria-label="Symbol name"
              autoFocus
              autoComplete="off"
              placeholder={symbolKind === "class" ? "GraphBuilder" : "build_graph"}
              spellCheck={false}
              type="text"
              value={symbolName}
              onChange={(event) => setSymbolName(event.target.value)}
            />
          </label>
          <label className="blueprint-field">
            <span className="blueprint-field__label">
              <strong>Optional body</strong>
            </span>
            <textarea
              aria-label="Symbol body"
              placeholder={symbolKind === "class" ? "pass" : "return value"}
              rows={5}
              value={symbolBody}
              onChange={(event) => setSymbolBody(event.target.value)}
            />
          </label>
          {error ? <p className="error-copy">{error}</p> : null}
          <div className="graph-create-composer__actions">
            <button className="primary-button" type="submit" disabled={!canSubmit || isSubmitting}>
              {isSubmitting ? "Creating..." : `Create ${symbolKind}`}
            </button>
          </div>
        </form>
      ) : null}

      {composer.kind === "flow" ? (
        <form
          className="blueprint-form"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSubmit();
          }}
        >
          <div className="info-card">
            <strong>{composer.ownerLabel}</strong>
            <p>
              {composer.mode === "edit"
                ? "Update this flow node in the local draft."
                : composer.seedFlowConnection
                  ? `Create a new node on the ${composer.seedFlowConnection.label} path.`
                  : "Create a new flow node in the local draft."}
            </p>
          </div>
          <label className="blueprint-field">
            <span className="blueprint-field__label">
              <strong>Node kind</strong>
            </span>
            <select
              aria-label="Flow node kind"
              disabled={composer.mode === "edit"}
              value={flowKind}
              onChange={(event) => setFlowKind(event.target.value as typeof flowKind)}
            >
              {FLOW_AUTHORABLE_NODE_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {flowNodeKindLabel(kind)}
                </option>
              ))}
              {composer.mode === "create" && !composer.seedFlowConnection ? <option value="param">Parameter</option> : null}
            </select>
          </label>

          {flowKind === "assign" || flowKind === "call" || flowKind === "return" ? (
            <label className="blueprint-field">
              <span className="blueprint-field__label">
                <strong>Statement</strong>
              </span>
              <textarea
                aria-label="Flow statement"
                autoFocus
                placeholder={
                  flowKind === "assign"
                    ? "result = compute(value)"
                    : flowKind === "call"
                      ? "notify(result)"
                      : "return result"
                }
                rows={3}
                value={flowStatement}
                onChange={(event) => setFlowStatement(event.target.value)}
              />
            </label>
          ) : null}

          {flowKind === "branch" ? (
            <label className="blueprint-field">
              <span className="blueprint-field__label">
                <strong>Condition</strong>
              </span>
              <input
                aria-label="Branch condition"
                autoFocus
                autoComplete="off"
                placeholder="result is not None"
                spellCheck={false}
                type="text"
                value={branchCondition}
                onChange={(event) => setBranchCondition(event.target.value)}
              />
            </label>
          ) : null}

          {flowKind === "loop" ? (
            <>
              <LoopDraftFields
                autoFocus
                draft={loopDraft}
                onChange={setLoopDraft}
              />
              {composer.mode === "create" && !composer.seedFlowConnection ? (
                <div className="graph-create-composer__loop-starters">
                  <LoopStarterStepFields
                    outputLabel="Repeat"
                    step={repeatStep}
                    onChange={setRepeatStep}
                  />
                  <LoopStarterStepFields
                    outputLabel="Done"
                    step={doneStep}
                    onChange={setDoneStep}
                  />
                </div>
              ) : null}
            </>
          ) : null}

          {flowKind === "param" ? (
            <>
              <label className="blueprint-field">
                <span className="blueprint-field__label">
                  <strong>Parameter name</strong>
                </span>
                <input
                  aria-label="Parameter name"
                  autoFocus
                  autoComplete="off"
                  placeholder="repo_path"
                  spellCheck={false}
                  type="text"
                  value={parameterName}
                  onChange={(event) => setParameterName(event.target.value)}
                />
              </label>
              <label className="blueprint-field">
                <span className="blueprint-field__label">
                  <strong>Default expression</strong>
                </span>
                <input
                  aria-label="Parameter default expression"
                  autoComplete="off"
                  placeholder="optional"
                  spellCheck={false}
                  type="text"
                  value={parameterDefaultExpression}
                  onChange={(event) => setParameterDefaultExpression(event.target.value)}
                />
              </label>
            </>
          ) : null}

          {error ? <p className="error-copy">{error}</p> : null}
          <div className="graph-create-composer__actions">
            <button className="primary-button" type="submit" disabled={!canSubmit || isSubmitting}>
              {isSubmitting
                ? composer.mode === "edit"
                  ? "Saving..."
                  : "Creating..."
                : composer.mode === "edit"
                  ? "Save node"
                  : flowKind === "param"
                    ? "Create parameter"
                    : flowKind === "loop"
                      ? "Create loop"
                      : "Create node"}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

function LoopDraftFields({
  autoFocus,
  draft,
  labelPrefix,
  onChange,
}: {
  autoFocus?: boolean;
  draft: FlowLoopDraft;
  labelPrefix?: string;
  onChange: (draft: FlowLoopDraft) => void;
}) {
  const ariaPrefix = labelPrefix ? `${labelPrefix} ` : "";
  const preview = canonicalFlowLoopHeader(draft);
  return (
    <>
      <label className="blueprint-field">
        <span className="blueprint-field__label">
          <strong>Loop type</strong>
        </span>
        <select
          aria-label={`${ariaPrefix}Loop type`}
          autoFocus={autoFocus}
          value={draft.loopType}
          onChange={(event) => onChange({
            ...draft,
            loopType: event.target.value as FlowLoopType,
          })}
        >
          <option value="while">While</option>
          <option value="for">For</option>
        </select>
      </label>

      {draft.loopType === "while" ? (
        <label className="blueprint-field">
          <span className="blueprint-field__label">
            <strong>Continue while</strong>
          </span>
          <input
            aria-label={`${ariaPrefix}Continue while`}
            autoComplete="off"
            placeholder="items"
            spellCheck={false}
            type="text"
            value={draft.condition}
            onChange={(event) => onChange({ ...draft, condition: event.target.value })}
          />
        </label>
      ) : (
        <>
          <label className="blueprint-field">
            <span className="blueprint-field__label">
              <strong>Item target</strong>
            </span>
            <input
              aria-label={`${ariaPrefix}Item target`}
              autoComplete="off"
              placeholder="item"
              spellCheck={false}
              type="text"
              value={draft.target}
              onChange={(event) => onChange({ ...draft, target: event.target.value })}
            />
          </label>
          <label className="blueprint-field">
            <span className="blueprint-field__label">
              <strong>Iterable</strong>
            </span>
            <input
              aria-label={`${ariaPrefix}Iterable`}
              autoComplete="off"
              placeholder="items"
              spellCheck={false}
              type="text"
              value={draft.iterable}
              onChange={(event) => onChange({ ...draft, iterable: event.target.value })}
            />
          </label>
        </>
      )}

      <div className="graph-create-composer__preview" aria-label={`${ariaPrefix}Loop preview`}>
        <span>Preview</span>
        <code>{preview ? `${preview}:` : draft.loopType === "while" ? "while ..." : "for ... in ...:"}</code>
      </div>
    </>
  );
}

function LoopStarterStepFields({
  outputLabel,
  step,
  onChange,
}: {
  outputLabel: "Repeat" | "Done";
  step: FlowStepDraft;
  onChange: (step: FlowStepDraft) => void;
}) {
  const setEnabled = (enabled: boolean) => onChange({ ...step, enabled });
  const setFlowKind = (flowKind: AuthoredFlowNodeKind) => onChange({ ...step, flowKind });
  return (
    <section className="graph-create-composer__starter">
      <label className="graph-create-composer__starter-toggle">
        <input
          aria-label={`Add ${outputLabel} step`}
          checked={step.enabled}
          type="checkbox"
          onChange={(event) => setEnabled(event.target.checked)}
        />
        <span>{outputLabel} step</span>
      </label>

      {step.enabled ? (
        <>
          <label className="blueprint-field">
            <span className="blueprint-field__label">
              <strong>Node kind</strong>
            </span>
            <select
              aria-label={`${outputLabel} step kind`}
              value={step.flowKind}
              onChange={(event) => setFlowKind(event.target.value as AuthoredFlowNodeKind)}
            >
              {FLOW_AUTHORABLE_NODE_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {flowNodeKindLabel(kind)}
                </option>
              ))}
            </select>
          </label>
          <FlowStepBodyFields
            labelPrefix={`${outputLabel} step`}
            step={step}
            onChange={onChange}
          />
        </>
      ) : null}
    </section>
  );
}

function FlowStepBodyFields({
  labelPrefix,
  step,
  onChange,
}: {
  labelPrefix: string;
  step: FlowStepDraft;
  onChange: (step: FlowStepDraft) => void;
}) {
  if (step.flowKind === "assign" || step.flowKind === "call" || step.flowKind === "return") {
    return (
      <label className="blueprint-field">
        <span className="blueprint-field__label">
          <strong>Statement</strong>
        </span>
        <textarea
          aria-label={`${labelPrefix} statement`}
          placeholder={
            step.flowKind === "assign"
              ? "result = compute(value)"
              : step.flowKind === "call"
                ? "notify(result)"
                : "return result"
          }
          rows={3}
          value={step.statement}
          onChange={(event) => onChange({ ...step, statement: event.target.value })}
        />
      </label>
    );
  }

  if (step.flowKind === "branch") {
    return (
      <label className="blueprint-field">
        <span className="blueprint-field__label">
          <strong>Condition</strong>
        </span>
        <input
          aria-label={`${labelPrefix} condition`}
          autoComplete="off"
          placeholder="result is not None"
          spellCheck={false}
          type="text"
          value={step.branchCondition}
          onChange={(event) => onChange({ ...step, branchCondition: event.target.value })}
        />
      </label>
    );
  }

  return (
    <LoopDraftFields
      draft={step.loopDraft}
      labelPrefix={labelPrefix}
      onChange={(loopDraft) => onChange({ ...step, loopDraft })}
    />
  );
}

function flowPayloadFromDraft({
  flowKind,
  statement,
  branchCondition,
  loopDraft,
}: {
  flowKind: AuthoredFlowNodeKind;
  statement: string;
  branchCondition: string;
  loopDraft: FlowLoopDraft;
}): Record<string, unknown> {
  if (flowKind === "assign" || flowKind === "call") {
    return { source: statement.trim() };
  }

  if (flowKind === "branch") {
    return { condition: branchCondition.trim() };
  }

  if (flowKind === "loop") {
    return flowLoopPayloadFromDraft(loopDraft);
  }

  return { expression: statement.trim().replace(/^return\s+/i, "") };
}

function isFlowDraftValid({
  flowKind,
  statement,
  branchCondition,
  loopDraft,
}: {
  flowKind: AuthoredFlowNodeKind;
  statement: string;
  branchCondition: string;
  loopDraft: FlowLoopDraft;
}) {
  if (flowKind === "branch") {
    return branchCondition.trim().length > 0;
  }
  if (flowKind === "loop") {
    return canonicalFlowLoopHeader(loopDraft).length > 0;
  }
  return statement.trim().length > 0;
}

function isStarterStepValid(step: FlowStepDraft) {
  return !step.enabled || isFlowDraftValid({
    flowKind: step.flowKind,
    statement: step.statement,
    branchCondition: step.branchCondition,
    loopDraft: step.loopDraft,
  });
}

function buildStarterStepSubmits(
  repeatStep: FlowStepDraft,
  doneStep: FlowStepDraft,
): FlowStarterStepSubmit[] | undefined {
  const steps: FlowStarterStepSubmit[] = [];
  if (repeatStep.enabled) {
    steps.push({
      sourceHandle: "body",
      flowNodeKind: repeatStep.flowKind,
      payload: flowPayloadFromDraft({
        flowKind: repeatStep.flowKind,
        statement: repeatStep.statement,
        branchCondition: repeatStep.branchCondition,
        loopDraft: repeatStep.loopDraft,
      }),
    });
  }
  if (doneStep.enabled) {
    steps.push({
      sourceHandle: "after",
      flowNodeKind: doneStep.flowKind,
      payload: flowPayloadFromDraft({
        flowKind: doneStep.flowKind,
        statement: doneStep.statement,
        branchCondition: doneStep.branchCondition,
        loopDraft: doneStep.loopDraft,
      }),
    });
  }
  return steps.length ? steps : undefined;
}

function loopDraftFromPayload(
  payload: Record<string, unknown>,
  preferredLoopType?: FlowLoopType,
): FlowLoopDraft {
  const normalized = normalizeFlowLoopPayload(payload);
  if (preferredLoopType && preferredLoopType !== normalized.loopType) {
    return {
      loopType: preferredLoopType,
      condition: "",
      target: "",
      iterable: "",
    };
  }
  return {
    loopType: preferredLoopType ?? normalized.loopType,
    condition: normalized.condition,
    target: normalized.target,
    iterable: normalized.iterable,
  };
}

function flowStatementFromComposer(
  flowKind: AuthoredFlowNodeKind,
  payload: Record<string, unknown>,
) {
  return flowNodeContentFromPayload(flowKind, payload);
}

function flowNodeKindLabel(kind: FlowCreateKind) {
  switch (kind) {
    case "assign":
      return "Assign";
    case "call":
      return "Call";
    case "return":
      return "Return";
    case "branch":
      return "Branch";
    case "loop":
      return "Loop";
    case "param":
      return "Parameter";
  }
}
