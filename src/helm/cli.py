"""CLI entrypoint for scanning Python repositories into structural graphs."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from helm.config import ScanConfig
from helm.graph import build_repo_graph
from helm.parser import PythonModuleParser, discover_python_modules
from helm.ui import build_export_payload, build_graph_summary, render_text_summary
from helm.utils import configure_logging


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="helm", description="Scan Python repos into structural graphs."
    )
    subparsers = parser.add_subparsers(dest="command")

    scan_parser = subparsers.add_parser("scan", help="Scan a repository and print a summary.")
    scan_parser.add_argument("repo", nargs="?", default=".", help="Path to the repository root.")
    scan_parser.add_argument(
        "--json-out",
        type=Path,
        help="Optional file path for JSON export.",
    )
    scan_parser.add_argument(
        "--top",
        type=int,
        default=10,
        help="Number of modules to include in the printed summary.",
    )
    scan_parser.add_argument(
        "--verbose",
        action="store_true",
        help="Enable verbose logging.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_argument_parser()
    args = parser.parse_args(argv)

    if args.command != "scan":
        parser.print_help()
        return 1

    configure_logging(verbose=args.verbose)
    repo_root = Path(args.repo)
    scan_config = ScanConfig(root=repo_root)
    try:
        inventory = discover_python_modules(repo_root, config=scan_config)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    parsed_modules = [PythonModuleParser().parse_module(module) for module in inventory.modules]
    graph = build_repo_graph(scan_config.normalized_root(), parsed_modules)
    summary = build_graph_summary(graph, top_n=args.top)
    print(render_text_summary(summary))

    if args.json_out is not None:
        payload = build_export_payload(graph, summary)
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
