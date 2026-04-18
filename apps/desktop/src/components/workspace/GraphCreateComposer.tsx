import { useEffect, useMemo, useState } from "react";
import {
  FLOW_AUTHORABLE_NODE_KINDS,
  flowNodeContentFromPayload,
  type AuthoredFlowNodeKind,
} from "../graph/flowDocument";
import { useClampedFloatingPanel } from "../shared/floatingPanel";

export interface GraphCreateComposerAnchor {
  x: number;
  y: number;
}

export interface GraphCreateComposerFlowPosition {
  x: number;
  y: number;
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
    };

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
  const [flowKind, setFlowKind] = useState<AuthoredFlowNodeKind>("assign");
  const [flowStatement, setFlowStatement] = useState("");
  const [branchCondition, setBranchCondition] = useState("");
  const [loopHeader, setLoopHeader] = useState("");

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
      setLoopHeader("");
      return;
    }

    const nextKind = composer.initialFlowNodeKind ?? "assign";
    const nextPayload = composer.initialPayload ?? {};
    setFlowKind(nextKind);
    setFlowStatement(flowStatementFromComposer(nextKind, nextPayload));
    setBranchCondition(nextKind === "branch" && typeof nextPayload.condition === "string" ? nextPayload.condition : "");
    setLoopHeader(nextKind === "loop" && typeof nextPayload.header === "string" ? nextPayload.header : "");
  }, [composer.id]);

  const title = useMemo(() => {
    if (composer.kind === "repo") {
      return "Create module";
    }
    if (composer.kind === "symbol") {
      return "Create symbol";
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

    await onSubmit({
      kind: "flow",
      flowNodeKind: flowKind,
      content: buildFlowContent({
        flowKind,
        statement: flowStatement,
        branchCondition,
        loopHeader,
      }),
    });
  };

  const canSubmit = (() => {
    if (composer.kind === "repo") {
      return modulePath.trim().length > 0;
    }
    if (composer.kind === "symbol") {
      return symbolName.trim().length > 0;
    }
    if (flowKind === "branch") {
      return branchCondition.trim().length > 0;
    }
    if (flowKind === "loop") {
      return loopHeader.trim().length > 0;
    }
    return flowStatement.trim().length > 0;
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
            <label className="blueprint-field">
              <span className="blueprint-field__label">
                <strong>Loop header</strong>
              </span>
              <input
                aria-label="Loop header"
                autoFocus
                autoComplete="off"
                placeholder="for item in items"
                spellCheck={false}
                type="text"
                value={loopHeader}
                onChange={(event) => setLoopHeader(event.target.value)}
              />
            </label>
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
                  : "Create node"}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

function buildFlowContent({
  flowKind,
  statement,
  branchCondition,
  loopHeader,
}: {
  flowKind: AuthoredFlowNodeKind;
  statement: string;
  branchCondition: string;
  loopHeader: string;
}) {
  if (flowKind === "assign" || flowKind === "call" || flowKind === "return") {
    return statement.trim();
  }

  if (flowKind === "branch") {
    return branchCondition.trim();
  }

  return loopHeader.trim();
}

function flowStatementFromComposer(
  flowKind: AuthoredFlowNodeKind,
  payload: Record<string, unknown>,
) {
  return flowNodeContentFromPayload(flowKind, payload);
}

function flowNodeKindLabel(kind: AuthoredFlowNodeKind) {
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
  }
}
