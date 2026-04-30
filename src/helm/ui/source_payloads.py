"""Source payload shaping for Python workspace UI adapters."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from helm.graph import GraphNode
from helm.parser.symbols import SourceSpan
from helm.ui.projection_context import ProjectionContext


def source_payload_for_node(
    context: ProjectionContext,
    node: GraphNode,
    *,
    target_id: str,
    exact: bool,
) -> dict[str, Any]:
    if node.file_path is None:
        raise ValueError(f"No source is associated with {target_id}.")

    source_path = Path(node.file_path)
    content = source_path.read_text(encoding="utf-8")
    lines = content.splitlines()
    if node.span is None:
        start_line = 1
        end_line = len(lines)
        snippet = content
    elif exact:
        start_line = node.span.start_line
        end_line = node.span.end_line
        snippet = _exact_source_snippet(content, node.span)
    else:
        start_line = node.span.start_line
        end_line = node.span.end_line
        snippet = "\n".join(lines[start_line - 1 : end_line])

    return {
        "target_id": target_id,
        "title": node.display_name,
        "path": context.relative_path_for(node),
        "start_line": start_line,
        "end_line": end_line,
        **(
            {
                "start_column": node.span.start_column,
                "end_column": node.span.end_column,
            }
            if exact and node.span is not None
            else {}
        ),
        "content": snippet,
    }


def _exact_source_snippet(content: str, span: SourceSpan) -> str:
    line_starts = _line_start_offsets(content)
    start_offset = line_starts[max(min(span.start_line - 1, len(line_starts) - 1), 0)]
    raw = content[start_offset : span.end_offset]
    if span.start_column <= 0:
        return raw
    return _strip_base_indentation(raw, span.start_column)


def _line_start_offsets(content: str) -> list[int]:
    offsets = [0]
    for index, character in enumerate(content):
        if character == "\n":
            offsets.append(index + 1)
    return offsets


def _strip_base_indentation(snippet: str, base_indent: int) -> str:
    if base_indent <= 0:
        return snippet

    prefix = " " * base_indent
    stripped_lines: list[str] = []
    for line in snippet.splitlines(keepends=True):
        if line.startswith(prefix):
            stripped_lines.append(line[base_indent:])
        else:
            stripped_lines.append(line)
    return "".join(stripped_lines)
