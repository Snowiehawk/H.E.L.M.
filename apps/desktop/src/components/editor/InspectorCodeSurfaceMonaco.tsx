import Editor from "@monaco-editor/react";
import type { Monaco } from "@monaco-editor/react";
import type { editor as MonacoEditor } from "monaco-editor";
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { useUiStore } from "../../store/uiStore";
import { useUndoStore } from "../../store/undoStore";
import type { InspectorCodeSurfaceProps } from "./InspectorCodeSurface";
import { ensureHelmMonacoThemes, ensureMonacoSetup, type MonacoEditorOptions } from "./monacoSetup";
import { normalizeHighlightRange } from "./inspectorCodeRange";

ensureMonacoSetup();

export const InspectorCodeSurfaceMonaco = memo(function InspectorCodeSurfaceMonaco({
  ariaLabel,
  className,
  dataTestId,
  height,
  language,
  onChange,
  path,
  readOnly,
  highlightRange,
  startLine,
  startColumn,
  value,
}: InspectorCodeSurfaceProps) {
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const decorationIdsRef = useRef<string[]>([]);
  const theme = useResolvedMonacoTheme();
  const modelPath = useMemo(
    () => buildModelPath(path, language, readOnly, startLine),
    [language, path, readOnly, startLine],
  );
  const editorOptions = useMemo<MonacoEditorOptions>(() => {
    const lineOffset = Math.max((startLine ?? 1) - 1, 0);

    return {
      automaticLayout: true,
      readOnly,
      minimap: { enabled: false },
      lineNumbers: (lineNumber: number) => String(lineNumber + lineOffset),
      lineNumbersMinChars: 3,
      glyphMargin: false,
      folding: false,
      scrollBeyondLastLine: false,
      renderLineHighlight: "none",
      wordWrap: "on",
      wrappingIndent: "same",
      stickyScroll: { enabled: false },
      overviewRulerBorder: false,
      hideCursorInOverviewRuler: true,
      overviewRulerLanes: 0,
      renderValidationDecorations: "off",
      guides: {
        highlightActiveIndentation: true,
        indentation: true,
      },
      padding: {
        top: 12,
        bottom: 12,
      },
      scrollbar: {
        alwaysConsumeMouseWheel: false,
        horizontalScrollbarSize: 8,
        verticalScrollbarSize: 8,
      },
      fontFamily: '"SF Mono", "JetBrains Mono", "Fira Code", monospace',
      fontSize: 12.5,
      lineHeight: 20,
      tabSize: 2,
      insertSpaces: true,
      contextmenu: true,
      domReadOnly: readOnly,
    };
  }, [readOnly, startLine]);
  const handleMount = useCallback(
    (editorInstance: MonacoEditor.IStandaloneCodeEditor, monacoInstance: Monaco) => {
      editorRef.current = editorInstance;
      monacoRef.current = monacoInstance;
      const model = editorInstance.getModel();
      if (model) {
        monacoInstance.editor.setModelLanguage(model, language);
      }
    },
    [language],
  );

  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (!model || !monacoRef.current) {
      return;
    }
    monacoRef.current.editor.setModelLanguage(model, language);
  }, [language, modelPath]);

  useEffect(() => {
    const editorInstance = editorRef.current;
    const monacoInstance = monacoRef.current;
    const model = editorInstance?.getModel();
    if (!editorInstance || !monacoInstance || !model) {
      return;
    }

    const normalizedRange = normalizeHighlightRange(
      highlightRange,
      model,
      startLine,
      startColumn ?? 0,
    );
    const nextDecorations = normalizedRange
      ? [
          {
            range: normalizedRange,
            options: {
              className: "inspector-code-surface__range-highlight",
              inlineClassName: "inspector-code-surface__range-highlight-inline",
              stickiness: monacoInstance.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
            },
          },
        ]
      : [];

    decorationIdsRef.current = editorInstance.deltaDecorations(
      decorationIdsRef.current,
      nextDecorations,
    );

    if (normalizedRange) {
      editorInstance.revealRangeInCenterIfOutsideViewport(normalizedRange);
    }
  }, [highlightRange, startColumn, startLine, value]);

  useEffect(
    () => () => {
      const editorInstance = editorRef.current;
      if (!editorInstance || decorationIdsRef.current.length === 0) {
        return;
      }
      decorationIdsRef.current = editorInstance.deltaDecorations(decorationIdsRef.current, []);
    },
    [],
  );

  useEffect(() => {
    if (readOnly) {
      return;
    }

    return useUndoStore.getState().registerDomain("editor", {
      canUndo: () => Boolean(editorRef.current?.getModel()?.canUndo()),
      canRedo: () => Boolean(editorRef.current?.getModel()?.canRedo()),
      ownsFocus: () => Boolean(editorRef.current?.hasTextFocus()),
      undo: async () => {
        const model = editorRef.current?.getModel();
        if (!model?.canUndo()) {
          return {
            domain: "editor" as const,
            handled: false,
          };
        }

        await model.undo();
        return {
          domain: "editor" as const,
          handled: true,
        };
      },
      redo: async () => {
        const model = editorRef.current?.getModel();
        if (!model?.canRedo()) {
          return {
            domain: "editor" as const,
            handled: false,
          };
        }

        await model.redo();
        return {
          domain: "editor" as const,
          handled: true,
        };
      },
    });
  }, [readOnly, modelPath]);

  return (
    <div
      aria-label={ariaLabel}
      className={[
        "inspector-code-surface",
        readOnly ? "inspector-code-surface--readonly" : "inspector-code-surface--editable",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      data-testid={dataTestId}
      role="group"
      style={height === undefined ? undefined : { height }}
    >
      <Editor
        beforeMount={configureMonaco}
        className="inspector-code-surface__editor"
        height="100%"
        language={language}
        loading={<div className="inspector-code-surface__loading">Loading source editor…</div>}
        options={editorOptions}
        path={modelPath}
        theme={theme}
        value={value}
        width="100%"
        onChange={(nextValue) => onChange?.(nextValue ?? "")}
        onMount={handleMount}
      />
    </div>
  );
});

function configureMonaco(monaco: Monaco) {
  ensureHelmMonacoThemes(monaco);
}

function useResolvedMonacoTheme() {
  const theme = useUiStore((state) => state.theme);
  if (theme === "dark") {
    return "helm-dark";
  }
  if (theme === "light") {
    return "helm-light";
  }

  const prefersDark =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  return prefersDark ? "helm-dark" : "helm-light";
}

function buildModelPath(
  path: string | undefined,
  language: string,
  readOnly: boolean,
  startLine: number | undefined,
) {
  const normalizedPath = (path ?? `untitled.${language || "txt"}`)
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const mode = readOnly ? "readonly" : "editable";
  return `inmemory://helm-inspector/${mode}/${normalizedPath}?startLine=${startLine ?? 1}`;
}
