"""Desktop-facing bridge for repo scans.

This stays intentionally thin: the desktop shell can call it as a subprocess
without depending on CLI-only output formatting.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from helm.config import ScanConfig
from helm.graph import build_repo_graph
from helm.parser import PythonModuleParser, discover_python_modules
from helm.ui.api import build_export_payload, build_graph_summary


def scan_repo_to_payload(repo: str | Path, top_n: int = 24) -> dict[str, Any]:
    repo_root = Path(repo)
    scan_config = ScanConfig(root=repo_root)
    inventory = discover_python_modules(repo_root, config=scan_config)
    parsed_modules = [PythonModuleParser().parse_module(module) for module in inventory.modules]
    graph = build_repo_graph(scan_config.normalized_root(), parsed_modules)
    summary = build_graph_summary(graph, top_n=top_n)
    return build_export_payload(graph, summary)


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m helm.ui.desktop_bridge",
        description="Export a repo scan as JSON for the desktop shell.",
    )
    parser.add_argument("repo", help="Path to the repository root.")
    parser.add_argument(
        "--top",
        type=int,
        default=24,
        help="Number of ranked modules to include in the summary payload.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_argument_parser()
    args = parser.parse_args(argv)

    try:
        payload = scan_repo_to_payload(args.repo, top_n=args.top)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    print(json.dumps(payload, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
