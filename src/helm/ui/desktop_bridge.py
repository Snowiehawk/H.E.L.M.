"""Desktop-facing bridge for repo scans and graph editor actions."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, TextIO

from helm.graph.models import GraphAbstractionLevel
from helm.ui.workspace_session import WorkspaceSession, WorkspaceSessionManager

_SESSION_MANAGER = WorkspaceSessionManager()


class _WorkerProgressReporter:
    def __init__(self, request_id: Any, output_stream: TextIO) -> None:
        self._request_id = request_id
        self._output_stream = output_stream
        self._last_payload: dict[str, Any] | None = None

    def emit(self, payload: dict[str, Any]) -> None:
        self._last_payload = payload
        self._write_frame(
            {
                "id": self._request_id,
                "event": "progress",
                "payload": payload,
            }
        )

    def emit_error(self, message: str) -> None:
        previous = self._last_payload or {}
        self.emit(
            {
                "stage": previous.get("stage", "discover"),
                "status": "error",
                "message": previous.get("message", "Indexing failed"),
                "processed_modules": previous.get("processed_modules", 0),
                "total_modules": previous.get("total_modules", 0),
                "symbol_count": previous.get("symbol_count", 0),
                "progress_percent": previous.get("progress_percent", 100),
                "error": message,
            }
        )

    def _write_frame(self, frame: dict[str, Any]) -> None:
        self._output_stream.write(json.dumps(frame, sort_keys=True))
        self._output_stream.write("\n")
        self._output_stream.flush()


def scan_repo_to_payload(repo: str | Path, top_n: int = 24) -> dict[str, Any]:
    return WorkspaceSession.open(repo).build_payload(top_n=top_n)


def build_graph_view_payload(
    repo: str | Path,
    target_id: str,
    level: GraphAbstractionLevel,
    filters: dict[str, bool] | None = None,
) -> dict[str, Any]:
    session = WorkspaceSession.open(repo)
    return session.get_graph_view(target_id, level, filters)


def build_flow_view_payload(repo: str | Path, symbol_id: str) -> dict[str, Any]:
    session = WorkspaceSession.open(repo)
    return session.get_flow_view(symbol_id)


def apply_edit_to_payload(repo: str | Path, request_payload: str | dict[str, Any]) -> dict[str, Any]:
    session = WorkspaceSession.open(repo)
    return session.apply_edit(request_payload)


def reveal_source_payload(repo: str | Path, target_id: str) -> dict[str, Any]:
    session = WorkspaceSession.open(repo)
    return session.reveal_source(target_id)


def editable_node_source_payload(repo: str | Path, target_id: str) -> dict[str, Any]:
    session = WorkspaceSession.open(repo)
    return session.get_editable_node_source(target_id)


def save_node_source_payload(repo: str | Path, target_id: str, content: str) -> dict[str, Any]:
    session = WorkspaceSession.open(repo)
    return session.save_node_source(target_id, content)


def parse_flow_expression_payload(
    repo: str | Path,
    expression: str,
    input_slot_by_name: dict[str, str] | None = None,
) -> dict[str, Any]:
    session = WorkspaceSession.open(repo)
    return session.parse_flow_expression(
        expression,
        input_slot_by_name=input_slot_by_name,
    )


def list_workspace_files_payload(repo: str | Path) -> dict[str, Any]:
    session = WorkspaceSession.open(repo)
    return session.list_workspace_files()


def read_workspace_file_payload(repo: str | Path, relative_path: str) -> dict[str, Any]:
    session = WorkspaceSession.open(repo)
    return session.read_workspace_file(relative_path)


def create_workspace_entry_payload(
    repo: str | Path,
    *,
    kind: str,
    relative_path: str,
    content: str | None = None,
) -> dict[str, Any]:
    session = WorkspaceSession.open(repo)
    return session.create_workspace_entry(
        kind=kind,
        relative_path=relative_path,
        content=content,
    )


def save_workspace_file_payload(
    repo: str | Path,
    *,
    relative_path: str,
    content: str,
    expected_version: str,
) -> dict[str, Any]:
    session = WorkspaceSession.open(repo)
    return session.save_workspace_file(
        relative_path=relative_path,
        content=content,
        expected_version=expected_version,
    )


def apply_undo_to_payload(repo: str | Path, transaction_payload: str | dict[str, Any]) -> dict[str, Any]:
    session = WorkspaceSession.open(repo)
    return session.apply_undo(transaction_payload)


def _handle_worker_command(
    command: str,
    params: dict[str, Any],
    *,
    progress: _WorkerProgressReporter | None = None,
) -> dict[str, Any]:
    repo = params.get("repo")
    if not isinstance(repo, str) and command != "shutdown":
        raise ValueError("Worker command requires a 'repo' string parameter.")

    top_n = params.get("top_n", 24)
    if not isinstance(top_n, int):
        raise ValueError("Worker command requires 'top_n' to be an integer.")

    if command == "scan":
        session = _SESSION_MANAGER.ensure_session(repo)
        return session.build_payload(top_n=top_n, progress=progress.emit if progress else None)

    if command == "full-resync":
        return _SESSION_MANAGER.full_resync(
            repo,
            top_n=top_n,
            progress=progress.emit if progress else None,
        )

    session = _SESSION_MANAGER.ensure_session(repo)
    if command == "graph-view":
        target_id = params.get("target_id")
        level = params.get("level")
        if not isinstance(target_id, str) or not isinstance(level, str):
            raise ValueError("graph-view requires 'target_id' and 'level' string parameters.")
        filters = params.get("filters")
        if filters is not None and not isinstance(filters, dict):
            raise ValueError("graph-view 'filters' must be an object.")
        return session.get_graph_view(target_id, GraphAbstractionLevel(level), filters)

    if command == "flow-view":
        symbol_id = params.get("symbol_id")
        if not isinstance(symbol_id, str):
            raise ValueError("flow-view requires a 'symbol_id' string parameter.")
        return session.get_flow_view(symbol_id)

    if command == "apply-edit":
        request_json = params.get("request_json")
        if not isinstance(request_json, str):
            raise ValueError("apply-edit requires a 'request_json' string parameter.")
        return session.apply_edit(request_json)

    if command == "reveal-source":
        target_id = params.get("target_id")
        if not isinstance(target_id, str):
            raise ValueError("reveal-source requires a 'target_id' string parameter.")
        return session.reveal_source(target_id)

    if command == "editable-source":
        target_id = params.get("target_id")
        if not isinstance(target_id, str):
            raise ValueError("editable-source requires a 'target_id' string parameter.")
        return session.get_editable_node_source(target_id)

    if command == "save-node-source":
        target_id = params.get("target_id")
        content = params.get("content")
        if not isinstance(target_id, str) or not isinstance(content, str):
            raise ValueError("save-node-source requires 'target_id' and 'content' string parameters.")
        return session.save_node_source(target_id, content)

    if command == "parse-flow-expression":
        expression = params.get("expression")
        input_slot_by_name = params.get("input_slot_by_name")
        if not isinstance(expression, str):
            raise ValueError("parse-flow-expression requires an 'expression' string parameter.")
        if input_slot_by_name is not None and not isinstance(input_slot_by_name, dict):
            raise ValueError("parse-flow-expression 'input_slot_by_name' must be an object when provided.")
        return session.parse_flow_expression(
            expression,
            input_slot_by_name={
                str(key): str(value)
                for key, value in (input_slot_by_name or {}).items()
                if isinstance(key, str) and isinstance(value, str)
            },
        )

    if command == "apply-undo":
        transaction_json = params.get("transaction_json")
        if not isinstance(transaction_json, str):
            raise ValueError("apply-undo requires a 'transaction_json' string parameter.")
        return session.apply_undo(transaction_json)

    if command == "list-workspace-files":
        return session.list_workspace_files()

    if command == "read-workspace-file":
        relative_path = params.get("relative_path")
        if not isinstance(relative_path, str):
            raise ValueError("read-workspace-file requires a 'relative_path' string parameter.")
        return session.read_workspace_file(relative_path)

    if command == "create-workspace-entry":
        kind = params.get("kind")
        relative_path = params.get("relative_path")
        content = params.get("content")
        if not isinstance(kind, str) or not isinstance(relative_path, str):
            raise ValueError("create-workspace-entry requires 'kind' and 'relative_path' string parameters.")
        if content is not None and not isinstance(content, str):
            raise ValueError("create-workspace-entry 'content' must be a string when provided.")
        return session.create_workspace_entry(
            kind=kind,
            relative_path=relative_path,
            content=content,
            top_n=top_n,
            progress=progress.emit if progress else None,
        )

    if command == "save-workspace-file":
        relative_path = params.get("relative_path")
        content = params.get("content")
        expected_version = params.get("expected_version")
        if not isinstance(relative_path, str) or not isinstance(content, str) or not isinstance(expected_version, str):
            raise ValueError(
                "save-workspace-file requires 'relative_path', 'content', and 'expected_version' string parameters."
            )
        return session.save_workspace_file(
            relative_path=relative_path,
            content=content,
            expected_version=expected_version,
            top_n=top_n,
            progress=progress.emit if progress else None,
        )

    if command == "refresh-paths":
        relative_paths = params.get("relative_paths", [])
        if not isinstance(relative_paths, list) or not all(
            isinstance(path, str) for path in relative_paths
        ):
            raise ValueError("refresh-paths requires a 'relative_paths' string list parameter.")
        return session.refresh_paths(
            relative_paths,
            top_n=top_n,
            progress=progress.emit if progress else None,
        )

    raise ValueError(f"Unsupported desktop bridge worker command: {command}")


def run_worker(stdin: Any = None, stdout: Any = None) -> int:
    input_stream = stdin or sys.stdin
    output_stream = stdout or sys.stdout

    for raw_line in input_stream:
        line = raw_line.strip()
        if not line:
            continue

        request_id: Any = None
        progress_reporter: _WorkerProgressReporter | None = None
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("Bridge request must be a JSON object.")
            request_id = request.get("id")
            command = request.get("command")
            params = request.get("params", {})
            if not isinstance(command, str):
                raise ValueError("Bridge request requires a string 'command'.")
            if not isinstance(params, dict):
                raise ValueError("Bridge request 'params' must be a JSON object.")
            if params.get("emit_progress") is True:
                progress_reporter = _WorkerProgressReporter(request_id, output_stream)
            if command == "shutdown":
                response = {"id": request_id, "ok": True, "result": {"shutdown": True}}
                output_stream.write(json.dumps(response, sort_keys=True))
                output_stream.write("\n")
                output_stream.flush()
                break
            result = _handle_worker_command(command, params, progress=progress_reporter)
            response = {"id": request_id, "ok": True, "result": result}
        except Exception as exc:  # pragma: no cover - defensive protocol guard
            if progress_reporter is not None:
                progress_reporter.emit_error(str(exc))
            response = {"id": request_id, "ok": False, "error": str(exc)}

        output_stream.write(json.dumps(response, sort_keys=True))
        output_stream.write("\n")
        output_stream.flush()

    return 0


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m helm.ui.desktop_bridge",
        description="Export repo graph data and graph-editor actions as JSON.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    scan_parser = subparsers.add_parser("scan", help="Scan a repository and export the workspace payload.")
    scan_parser.add_argument("repo", help="Path to the repository root.")
    scan_parser.add_argument("--top", type=int, default=24, help="Top modules to include in the summary payload.")

    graph_parser = subparsers.add_parser("graph-view", help="Build a graph view for a target node.")
    graph_parser.add_argument("repo", help="Path to the repository root.")
    graph_parser.add_argument("target_id", help="Target graph node id.")
    graph_parser.add_argument("level", choices=[level.value for level in GraphAbstractionLevel])
    graph_parser.add_argument(
        "--filters-json",
        default="{}",
        help="JSON object with includeImports/includeCalls/includeDefines flags.",
    )

    flow_parser = subparsers.add_parser("flow-view", help="Build a flow graph for a symbol.")
    flow_parser.add_argument("repo", help="Path to the repository root.")
    flow_parser.add_argument("symbol_id", help="Symbol id to expand.")

    edit_parser = subparsers.add_parser("apply-edit", help="Apply a structural edit and return a refreshed payload.")
    edit_parser.add_argument("repo", help="Path to the repository root.")
    edit_parser.add_argument("--request-json", required=True, help="Serialized edit request JSON.")

    reveal_parser = subparsers.add_parser("reveal-source", help="Reveal the source for a graph node.")
    reveal_parser.add_argument("repo", help="Path to the repository root.")
    reveal_parser.add_argument("target_id", help="Target graph node id.")

    editable_parser = subparsers.add_parser(
        "editable-source",
        help="Return editable source info for a graph node.",
    )
    editable_parser.add_argument("repo", help="Path to the repository root.")
    editable_parser.add_argument("target_id", help="Target graph node id.")

    save_parser = subparsers.add_parser(
        "save-node-source",
        help="Replace the source declaration for an editable graph node.",
    )
    save_parser.add_argument("repo", help="Path to the repository root.")
    save_parser.add_argument("target_id", help="Target graph node id.")
    save_parser.add_argument("--content-json", required=True, help="Serialized replacement source string.")

    expression_parser = subparsers.add_parser(
        "parse-flow-expression",
        help="Parse a Python expression into a visual expression graph.",
    )
    expression_parser.add_argument("repo", help="Path to the repository root.")
    expression_parser.add_argument("expression", help="Python expression source.")
    expression_parser.add_argument(
        "--input-slots-json",
        default="{}",
        help="Serialized mapping from input name to flow input slot id.",
    )

    undo_parser = subparsers.add_parser("apply-undo", help="Apply a serialized undo transaction.")
    undo_parser.add_argument("repo", help="Path to the repository root.")
    undo_parser.add_argument("--transaction-json", required=True, help="Serialized undo transaction JSON.")

    subparsers.add_parser(
        "serve",
        help="Run the persistent desktop bridge worker on stdin/stdout.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_argument_parser()
    args = parser.parse_args(argv)

    if args.command == "serve":
        return run_worker()

    try:
        if args.command == "scan":
            payload = scan_repo_to_payload(args.repo, top_n=args.top)
        elif args.command == "graph-view":
            payload = build_graph_view_payload(
                args.repo,
                args.target_id,
                GraphAbstractionLevel(args.level),
                json.loads(args.filters_json),
            )
        elif args.command == "flow-view":
            payload = build_flow_view_payload(args.repo, args.symbol_id)
        elif args.command == "apply-edit":
            payload = apply_edit_to_payload(args.repo, args.request_json)
        elif args.command == "reveal-source":
            payload = reveal_source_payload(args.repo, args.target_id)
        elif args.command == "editable-source":
            payload = editable_node_source_payload(args.repo, args.target_id)
        elif args.command == "save-node-source":
            payload = save_node_source_payload(
                args.repo,
                args.target_id,
                json.loads(args.content_json),
            )
        elif args.command == "parse-flow-expression":
            payload = parse_flow_expression_payload(
                args.repo,
                args.expression,
                json.loads(args.input_slots_json),
            )
        elif args.command == "apply-undo":
            payload = apply_undo_to_payload(args.repo, args.transaction_json)
        else:
            raise ValueError(f"Unsupported desktop bridge command: {args.command}")
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    print(json.dumps(payload, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
