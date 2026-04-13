import { useMemo, useState } from "react";

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
      anchor: GraphCreateComposerAnchor;
      flowPosition: GraphCreateComposerFlowPosition;
      anchorEdgeId: string;
      anchorLabel?: string;
      ownerLabel: string;
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
      anchorEdgeId: string;
      flowNodeKind: "assign" | "call" | "return" | "branch" | "loop";
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
  const [flowKind, setFlowKind] = useState<"assign" | "call" | "return" | "branch" | "loop">("assign");
  const [flowStatement, setFlowStatement] = useState("");
  const [branchCondition, setBranchCondition] = useState("");
  const [branchTrueBody, setBranchTrueBody] = useState("");
  const [branchFalseBody, setBranchFalseBody] = useState("");
  const [loopHeader, setLoopHeader] = useState("");
  const [loopBody, setLoopBody] = useState("");

  const title = useMemo(() => {
    if (composer.kind === "repo") {
      return "Create module";
    }
    if (composer.kind === "symbol") {
      return "Create symbol";
    }
    return "Insert flow node";
  }, [composer.kind]);

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
      anchorEdgeId: composer.anchorEdgeId,
      flowNodeKind: flowKind,
      content: buildFlowContent({
        flowKind,
        statement: flowStatement,
        branchCondition,
        branchTrueBody,
        branchFalseBody,
        loopHeader,
        loopBody,
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

  return (
    <div
      className="graph-create-composer"
      data-testid="graph-create-composer"
      style={{
        left: `${composer.anchor.x}px`,
        top: `${composer.anchor.y}px`,
      }}
    >
      <div className="graph-create-composer__header">
        <div>
          <span className="window-bar__eyebrow">Create mode</span>
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
            <p>{composer.anchorLabel ? `Path: ${composer.anchorLabel}` : "Insert on the clicked control path."}</p>
          </div>
          <label className="blueprint-field">
            <span className="blueprint-field__label">
              <strong>Node kind</strong>
            </span>
            <select
              aria-label="Flow node kind"
              value={flowKind}
              onChange={(event) => setFlowKind(event.target.value as typeof flowKind)}
            >
              <option value="assign">Assign</option>
              <option value="call">Call</option>
              <option value="return">Return</option>
              <option value="branch">Branch</option>
              <option value="loop">Loop</option>
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
            <>
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
              <label className="blueprint-field">
                <span className="blueprint-field__label">
                  <strong>True body</strong>
                </span>
                <textarea
                  aria-label="Branch true body"
                  placeholder="process(result)"
                  rows={4}
                  value={branchTrueBody}
                  onChange={(event) => setBranchTrueBody(event.target.value)}
                />
              </label>
              <label className="blueprint-field">
                <span className="blueprint-field__label">
                  <strong>False body</strong>
                </span>
                <textarea
                  aria-label="Branch false body"
                  placeholder="pass"
                  rows={4}
                  value={branchFalseBody}
                  onChange={(event) => setBranchFalseBody(event.target.value)}
                />
              </label>
            </>
          ) : null}

          {flowKind === "loop" ? (
            <>
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
              <label className="blueprint-field">
                <span className="blueprint-field__label">
                  <strong>Loop body</strong>
                </span>
                <textarea
                  aria-label="Loop body"
                  placeholder="total += item"
                  rows={4}
                  value={loopBody}
                  onChange={(event) => setLoopBody(event.target.value)}
                />
              </label>
            </>
          ) : null}

          {error ? <p className="error-copy">{error}</p> : null}
          <div className="graph-create-composer__actions">
            <button className="primary-button" type="submit" disabled={!canSubmit || isSubmitting}>
              {isSubmitting ? "Creating..." : "Insert node"}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

function indentBlock(block: string) {
  const trimmed = block.trim();
  const lines = (trimmed || "pass").split("\n");
  return lines.map((line) => `    ${line}`).join("\n");
}

function buildFlowContent({
  flowKind,
  statement,
  branchCondition,
  branchTrueBody,
  branchFalseBody,
  loopHeader,
  loopBody,
}: {
  flowKind: "assign" | "call" | "return" | "branch" | "loop";
  statement: string;
  branchCondition: string;
  branchTrueBody: string;
  branchFalseBody: string;
  loopHeader: string;
  loopBody: string;
}) {
  if (flowKind === "assign" || flowKind === "call" || flowKind === "return") {
    return statement.trim();
  }

  if (flowKind === "branch") {
    return [
      `if ${branchCondition.trim()}:`,
      indentBlock(branchTrueBody),
      "else:",
      indentBlock(branchFalseBody),
    ].join("\n");
  }

  const normalizedHeader = loopHeader.trim().replace(/:$/, "");
  return [
    `${normalizedHeader}:`,
    indentBlock(loopBody),
  ].join("\n");
}
