"""Desktop-facing bridge for repo scans and graph editor actions."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from helm.editor import serialize_edit_request, serialize_undo_transaction
from helm.graph.models import GraphAbstractionLevel
from helm.ui.python_adapter import PythonRepoAdapter


def scan_repo_to_payload(repo: str | Path, top_n: int = 24) -> dict[str, Any]:
    return PythonRepoAdapter.scan(repo).build_payload(top_n=top_n)


def build_graph_view_payload(
    repo: str | Path,
    target_id: str,
    level: GraphAbstractionLevel,
    filters: dict[str, bool] | None = None,
) -> dict[str, Any]:
    adapter = PythonRepoAdapter.scan(repo)
    return adapter.get_graph_view(target_id, level, filters).to_dict()


def build_flow_view_payload(repo: str | Path, symbol_id: str) -> dict[str, Any]:
    adapter = PythonRepoAdapter.scan(repo)
    return adapter.get_flow_view(symbol_id).to_dict()


def apply_edit_to_payload(repo: str | Path, request_payload: str | dict[str, Any]) -> dict[str, Any]:
    adapter = PythonRepoAdapter.scan(repo)
    request = serialize_edit_request(request_payload)
    return adapter.apply_edit(request)


def reveal_source_payload(repo: str | Path, target_id: str) -> dict[str, Any]:
    adapter = PythonRepoAdapter.scan(repo)
    return adapter.reveal_source(target_id)


def editable_node_source_payload(repo: str | Path, target_id: str) -> dict[str, Any]:
    adapter = PythonRepoAdapter.scan(repo)
    return adapter.get_editable_node_source(target_id)


def save_node_source_payload(repo: str | Path, target_id: str, content: str) -> dict[str, Any]:
    adapter = PythonRepoAdapter.scan(repo)
    return adapter.save_node_source(target_id, content)


def apply_undo_to_payload(repo: str | Path, transaction_payload: str | dict[str, Any]) -> dict[str, Any]:
    adapter = PythonRepoAdapter.scan(repo)
    transaction = serialize_undo_transaction(transaction_payload)
    return adapter.apply_undo(transaction)


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

    undo_parser = subparsers.add_parser("apply-undo", help="Apply a serialized undo transaction.")
    undo_parser.add_argument("repo", help="Path to the repository root.")
    undo_parser.add_argument("--transaction-json", required=True, help="Serialized undo transaction JSON.")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_argument_parser()
    args = parser.parse_args(argv)

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
