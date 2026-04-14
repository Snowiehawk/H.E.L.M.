"""Persistent desktop workspace sessions for live repo sync."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

from helm.editor import serialize_edit_request, serialize_undo_transaction
from helm.graph import build_repo_graph
from helm.graph.models import GraphAbstractionLevel
from helm.parser import ParsedModule, PythonModuleParser, discover_python_modules
from helm.ui.python_adapter import PythonRepoAdapter


def _normalized_relative_paths(paths: Iterable[str]) -> tuple[str, ...]:
    normalized: set[str] = set()
    for path in paths:
        value = Path(path).as_posix().lstrip("./")
        if value:
            normalized.add(value)
    return tuple(sorted(normalized))


def _diagnostic_messages(payload: dict[str, Any]) -> list[str]:
    graph = payload.get("graph")
    if not isinstance(graph, dict):
        return []
    diagnostics = graph.get("diagnostics")
    if not isinstance(diagnostics, list):
        return []

    messages: list[str] = []
    for diagnostic in diagnostics:
        if not isinstance(diagnostic, dict):
            continue
        code = diagnostic.get("code")
        message = diagnostic.get("message")
        if isinstance(code, str) and isinstance(message, str):
            messages.append(f"{code}: {message}")
        elif isinstance(message, str):
            messages.append(message)
    return messages


@dataclass
class WorkspaceSession:
    adapter: PythonRepoAdapter
    session_version: int = 1

    @classmethod
    def open(cls, repo: str | Path) -> WorkspaceSession:
        return cls(adapter=PythonRepoAdapter.scan(repo), session_version=1)

    @property
    def root_path(self) -> Path:
        return self.adapter.root_path

    def build_payload(self, top_n: int = 24) -> dict[str, Any]:
        payload = self.adapter.build_payload(top_n=top_n)
        workspace = payload.setdefault("workspace", {})
        workspace["session_version"] = self.session_version
        return payload

    def get_graph_view(
        self,
        target_id: str,
        level: GraphAbstractionLevel,
        filters: dict[str, bool] | None = None,
    ) -> dict[str, Any]:
        return self.adapter.get_graph_view(target_id, level, filters).to_dict()

    def get_flow_view(self, symbol_id: str) -> dict[str, Any]:
        return self.adapter.get_flow_view(symbol_id).to_dict()

    def reveal_source(self, target_id: str) -> dict[str, Any]:
        return self.adapter.reveal_source(target_id)

    def get_editable_node_source(self, target_id: str) -> dict[str, Any]:
        return self.adapter.get_editable_node_source(target_id)

    def apply_edit(self, request_payload: str | dict[str, Any]) -> dict[str, Any]:
        request = serialize_edit_request(request_payload)
        response = self.adapter.apply_edit(request)
        self.session_version += 1
        response["payload"] = self.build_payload()
        return response

    def apply_undo(self, transaction_payload: str | dict[str, Any]) -> dict[str, Any]:
        transaction = serialize_undo_transaction(transaction_payload)
        response = self.adapter.apply_undo(transaction)
        self.session_version += 1
        response["payload"] = self.build_payload()
        return response

    def save_node_source(self, target_id: str, content: str) -> dict[str, Any]:
        response = self.adapter.save_node_source(target_id, content)
        self.session_version += 1
        response["payload"] = self.build_payload()
        return response

    def full_resync(self, top_n: int = 24) -> dict[str, Any]:
        refreshed = PythonRepoAdapter.scan(self.root_path)
        self.adapter = refreshed
        self.session_version += 1
        return self.build_payload(top_n=top_n)

    def refresh_paths(
        self,
        changed_relative_paths: Iterable[str],
        top_n: int = 24,
    ) -> dict[str, Any]:
        normalized_paths = _normalized_relative_paths(changed_relative_paths)
        previous_by_relative = {
            parsed.module.relative_path: parsed for parsed in self.adapter.parsed_modules
        }
        refreshed_inventory = discover_python_modules(self.root_path)
        refreshed_by_relative = {
            module.relative_path: module for module in refreshed_inventory.modules
        }

        previous_relative_paths = set(previous_by_relative)
        refreshed_relative_paths = set(refreshed_by_relative)
        added_relative_paths = refreshed_relative_paths - previous_relative_paths
        removed_relative_paths = previous_relative_paths - refreshed_relative_paths
        modules_to_reparse = set(normalized_paths) & refreshed_relative_paths

        for relative_path in refreshed_relative_paths & previous_relative_paths:
            current_module = refreshed_by_relative[relative_path]
            previous_module = previous_by_relative[relative_path].module
            if (
                current_module.module_name != previous_module.module_name
                or current_module.file_path != previous_module.file_path
                or current_module.is_package != previous_module.is_package
            ):
                modules_to_reparse.add(relative_path)

        parser = PythonModuleParser()
        reparsed_relative_paths: list[str] = []
        next_parsed_modules: list[ParsedModule] = []
        for module in refreshed_inventory.modules:
            previous = previous_by_relative.get(module.relative_path)
            needs_reparse = module.relative_path in modules_to_reparse or previous is None
            if needs_reparse:
                next_parsed_modules.append(parser.parse_module(module))
                reparsed_relative_paths.append(module.relative_path)
            else:
                next_parsed_modules.append(previous)

        self.adapter.inventory = refreshed_inventory
        self.adapter.parsed_modules = next_parsed_modules
        self.adapter.graph = build_repo_graph(self.root_path, self.adapter.parsed_modules)

        changed_paths = tuple(
            sorted(
                set(normalized_paths)
                | added_relative_paths
                | removed_relative_paths
            )
        )
        if changed_paths or reparsed_relative_paths:
            self.session_version += 1

        payload = self.build_payload(top_n=top_n)
        return {
            "payload": payload,
            "changed_relative_paths": list(changed_paths),
            "reparsed_relative_paths": reparsed_relative_paths,
            "diagnostics": _diagnostic_messages(payload),
            "session_version": self.session_version,
        }


@dataclass
class WorkspaceSessionManager:
    _sessions: dict[str, WorkspaceSession] = field(default_factory=dict)

    def ensure_session(self, repo: str | Path) -> WorkspaceSession:
        root_path = Path(repo).resolve().as_posix()
        session = self._sessions.get(root_path)
        if session is None:
            session = WorkspaceSession.open(root_path)
            self._sessions[root_path] = session
        return session

