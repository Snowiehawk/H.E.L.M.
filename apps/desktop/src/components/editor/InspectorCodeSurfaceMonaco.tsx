import Editor from "@monaco-editor/react";
import type { Monaco } from "@monaco-editor/react";
import { memo, useMemo } from "react";
import { useUiStore } from "../../store/uiStore";
import type { InspectorCodeSurfaceProps } from "./InspectorCodeSurface";
import {
  ensureHelmMonacoThemes,
  ensureMonacoSetup,
  type MonacoEditorOptions,
} from "./monacoSetup";

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
  startLine,
  value,
}: InspectorCodeSurfaceProps) {
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
      lineNumbers: (lineNumber) => String(lineNumber + lineOffset),
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
      fontFamily: "\"SF Mono\", \"JetBrains Mono\", \"Fira Code\", monospace",
      fontSize: 12.5,
      lineHeight: 20,
      tabSize: 2,
      insertSpaces: true,
      contextmenu: true,
      domReadOnly: readOnly,
    };
  }, [readOnly, startLine]);

  return (
    <div
      className={[
        "inspector-code-surface",
        readOnly ? "inspector-code-surface--readonly" : "inspector-code-surface--editable",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      data-testid={dataTestId}
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
        aria-label={ariaLabel}
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
    typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-color-scheme: dark)").matches;
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
