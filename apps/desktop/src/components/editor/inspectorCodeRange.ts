import type { SourceRange } from "../../lib/adapter";

export interface HighlightableCodeModel {
  getLineCount(): number;
  getLineMaxColumn(lineNumber: number): number;
}

export interface EditorHighlightRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

export function normalizeHighlightRange(
  highlightRange: SourceRange | undefined,
  model: HighlightableCodeModel,
  snippetStartLine: number | undefined,
  snippetStartColumn: number,
): EditorHighlightRange | undefined {
  if (!highlightRange) {
    return undefined;
  }

  const absoluteSnippetStartLine = Math.max(snippetStartLine ?? 1, 1);
  const absoluteSnippetEndLine = absoluteSnippetStartLine + model.getLineCount() - 1;
  if (
    highlightRange.endLine < absoluteSnippetStartLine
    || highlightRange.startLine > absoluteSnippetEndLine
  ) {
    return undefined;
  }

  const absoluteStartLine = Math.max(highlightRange.startLine, absoluteSnippetStartLine);
  const absoluteEndLine = Math.min(highlightRange.endLine, absoluteSnippetEndLine);
  const startLine = absoluteStartLine - absoluteSnippetStartLine + 1;
  const endLine = absoluteEndLine - absoluteSnippetStartLine + 1;
  const startColumn = clampRangeColumn(
    model,
    startLine,
    toModelColumn(
      absoluteStartLine,
      absoluteStartLine === highlightRange.startLine
        ? highlightRange.startColumn ?? 0
        : 0,
      absoluteSnippetStartLine,
      snippetStartColumn,
    ),
  );
  const defaultEndColumn = model.getLineMaxColumn(endLine);
  const endColumn = clampRangeColumn(
    model,
    endLine,
    highlightRange.endColumn === undefined || absoluteEndLine !== highlightRange.endLine
      ? defaultEndColumn
      : toModelColumn(
          absoluteEndLine,
          highlightRange.endColumn,
          absoluteSnippetStartLine,
          snippetStartColumn,
        ),
  );

  if (startLine === endLine && endColumn <= startColumn) {
    return {
      startLineNumber: startLine,
      startColumn,
      endLineNumber: endLine,
      endColumn: Math.min(model.getLineMaxColumn(endLine), startColumn + 1),
    };
  }

  return {
    startLineNumber: startLine,
    startColumn,
    endLineNumber: endLine,
    endColumn,
  };
}

function toModelColumn(
  _absoluteLine: number,
  absoluteColumn: number,
  _absoluteSnippetStartLine: number,
  snippetStartColumn: number,
) {
  return absoluteColumn - snippetStartColumn + 1;
}

function clampRangeColumn(
  model: HighlightableCodeModel,
  lineNumber: number,
  column: number,
) {
  return Math.min(Math.max(column, 1), model.getLineMaxColumn(lineNumber));
}
