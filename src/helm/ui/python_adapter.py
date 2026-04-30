"""Python-first workspace adapter for the architecture editor."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Literal

from helm.editor import apply_backend_undo, apply_structural_edit
from helm.editor.declaration_support import resolve_declaration_edit_support
from helm.editor.flow_model import expression_graph_from_expression
from helm.editor.models import (
    BackendUndoResult,
    BackendUndoTransaction,
    StructuralEditKind,
    StructuralEditRequest,
    StructuralEditResult,
)
from helm.graph import NodeKind, RepoGraph, build_repo_graph
from helm.graph.models import GraphAbstractionLevel, GraphView
from helm.parser import ParsedModule, PythonModuleParser, discover_python_modules
from helm.ui.api import build_export_payload, build_graph_summary
from helm.ui.flow_projection import get_flow_view as project_flow_view
from helm.ui.graph_projection import (
    default_focus_node_id as project_default_focus_node_id,
    default_level as project_default_level,
    get_graph_view as project_graph_view,
)
from helm.ui.projection_context import ProjectionContext, graph_view_kind_for_symbol
from helm.ui.source_payloads import source_payload_for_node

IndexStage = Literal["discover", "parse", "graph_build", "cache_finalize", "watch_ready"]
ProgressReporter = Callable[[dict[str, Any]], None]

_STAGE_PROGRESS_RANGES: dict[IndexStage, tuple[int, int]] = {
    "discover": (4, 18),
    "parse": (18, 76),
    "graph_build": (76, 88),
    "cache_finalize": (88, 95),
    "watch_ready": (95, 100),
}


def _stage_progress_percent(
    stage: IndexStage,
    *,
    processed_modules: int = 0,
    total_modules: int = 0,
) -> int:
    start, end = _STAGE_PROGRESS_RANGES[stage]
    if total_modules <= 0:
        return start

    bounded_progress = min(max(processed_modules / total_modules, 0), 1)
    return round(start + (end - start) * bounded_progress)


def build_progress_update(
    stage: IndexStage,
    message: str,
    *,
    processed_modules: int = 0,
    total_modules: int = 0,
    symbol_count: int = 0,
    status: str = "running",
    error: str | None = None,
) -> dict[str, Any]:
    progress_percent = (
        100
        if status == "done"
        else _stage_progress_percent(
            stage,
            processed_modules=processed_modules,
            total_modules=total_modules,
        )
    )
    return {
        "stage": stage,
        "status": status,
        "message": message,
        "processed_modules": processed_modules,
        "total_modules": total_modules,
        "symbol_count": symbol_count,
        "progress_percent": progress_percent,
        "error": error,
    }


def emit_progress(
    reporter: ProgressReporter | None,
    stage: IndexStage,
    message: str,
    *,
    processed_modules: int = 0,
    total_modules: int = 0,
    symbol_count: int = 0,
    status: str = "running",
    error: str | None = None,
) -> None:
    if reporter is None:
        return
    reporter(
        build_progress_update(
            stage,
            message,
            processed_modules=processed_modules,
            total_modules=total_modules,
            symbol_count=symbol_count,
            status=status,
            error=error,
        )
    )


@dataclass
class PythonRepoAdapter:
    root_path: Path
    inventory: Any
    parsed_modules: list[ParsedModule]
    graph: RepoGraph

    @classmethod
    def scan(
        cls,
        repo: str | Path,
        *,
        progress: ProgressReporter | None = None,
    ) -> PythonRepoAdapter:
        root_path = Path(repo).resolve()
        emit_progress(
            progress,
            "discover",
            "Discovering Python modules",
            processed_modules=0,
            total_modules=0,
        )
        inventory = discover_python_modules(root_path)
        total_modules = len(inventory.modules)
        emit_progress(
            progress,
            "discover",
            f"Discovered {total_modules} Python module{'s' if total_modules != 1 else ''}",
            processed_modules=total_modules,
            total_modules=total_modules,
        )
        parser = PythonModuleParser()
        parsed_modules: list[ParsedModule] = []
        symbol_count = 0
        for index, module in enumerate(inventory.modules, start=1):
            parsed_module = parser.parse_module(module)
            parsed_modules.append(parsed_module)
            symbol_count += len(parsed_module.symbols)
            emit_progress(
                progress,
                "parse",
                f"Parsed {module.relative_path}",
                processed_modules=index,
                total_modules=total_modules,
                symbol_count=symbol_count,
            )
        emit_progress(
            progress,
            "graph_build",
            "Building the repo graph",
            processed_modules=total_modules,
            total_modules=total_modules,
            symbol_count=symbol_count,
        )
        graph = build_repo_graph(root_path, parsed_modules)
        return cls(
            root_path=root_path, inventory=inventory, parsed_modules=parsed_modules, graph=graph
        )

    def build_payload(
        self,
        top_n: int = 24,
        *,
        progress: ProgressReporter | None = None,
    ) -> dict[str, Any]:
        emit_progress(
            progress,
            "cache_finalize",
            "Finalizing workspace payload",
            processed_modules=self.graph.report.module_count,
            total_modules=self.graph.report.module_count,
            symbol_count=self.graph.report.symbol_count,
        )
        summary = build_graph_summary(self.graph, top_n=top_n)
        payload = build_export_payload(self.graph, summary)
        payload["workspace"] = {
            "language": "python",
            "default_level": self.default_level().value,
            "default_focus_node_id": self.default_focus_node_id(),
            "source_hidden_by_default": True,
            "supported_edit_kinds": [kind.value for kind in StructuralEditKind],
        }
        return payload

    def _projection_context(self) -> ProjectionContext:
        return ProjectionContext(
            root_path=self.root_path,
            graph=self.graph,
            parsed_modules=self.parsed_modules,
        )

    def default_level(self) -> GraphAbstractionLevel:
        return project_default_level(self._projection_context())

    def default_focus_node_id(self) -> str:
        return project_default_focus_node_id(self._projection_context())

    def get_graph_view(
        self,
        target_id: str,
        level: GraphAbstractionLevel,
        filters: dict[str, bool] | None = None,
    ) -> GraphView:
        if level == GraphAbstractionLevel.FLOW:
            return self.get_flow_view(target_id)
        return project_graph_view(self._projection_context(), target_id, level, filters)

    def get_flow_view(self, symbol_id: str) -> GraphView:
        return project_flow_view(self._projection_context(), symbol_id)

    def reveal_source(self, target_id: str) -> dict[str, Any]:
        context = self._projection_context()
        node = context.require_graph_node(target_id)
        if node.file_path is None:
            raise ValueError(f"No source is associated with {target_id}.")

        return source_payload_for_node(context, node, target_id=target_id, exact=False)

    def get_editable_node_source(self, target_id: str) -> dict[str, Any]:
        context = self._projection_context()
        node = context.require_graph_node(target_id)
        if node.kind == NodeKind.MODULE:
            payload = source_payload_for_node(context, node, target_id=target_id, exact=False)
            payload.update(
                {
                    "editable": True,
                    "node_kind": "module",
                }
            )
            return payload

        if node.kind != NodeKind.SYMBOL:
            raise ValueError("Editable source is only available for symbols.")

        _, symbol = context.require_symbol(target_id)
        support = resolve_declaration_edit_support(
            symbol,
            lookup_symbol=context.lookup_symbol,
        )
        payload = source_payload_for_node(context, node, target_id=target_id, exact=True)
        payload.update(
            {
                "editable": support.editable,
                "reason": support.reason,
                "node_kind": graph_view_kind_for_symbol(symbol.kind).value,
            }
        )
        return payload

    def apply_edit(self, request: StructuralEditRequest) -> dict[str, Any]:
        result = apply_structural_edit(
            self.root_path,
            request,
            parsed_modules=self.parsed_modules,
            inbound_dependency_count=self._projection_context().inbound_dependency_count(),
        )
        reparsed = self._reparse_touched_modules(result.touched_relative_paths)
        enriched = StructuralEditResult(
            request=result.request,
            summary=result.summary,
            touched_relative_paths=result.touched_relative_paths,
            reparsed_relative_paths=reparsed,
            changed_node_ids=result.changed_node_ids,
            warnings=result.warnings,
            flow_sync_state=result.flow_sync_state,
            diagnostics=result.diagnostics,
            undo_transaction=result.undo_transaction,
            recovery_events=result.recovery_events,
        )
        return {"edit": enriched.to_dict(), "payload": self.build_payload()}

    def apply_undo(self, transaction: BackendUndoTransaction) -> dict[str, Any]:
        result = apply_backend_undo(self.root_path, transaction)
        self._reparse_touched_modules(result.restored_relative_paths)
        enriched = BackendUndoResult(
            summary=result.summary,
            restored_relative_paths=result.restored_relative_paths,
            warnings=result.warnings,
            focus_target=result.focus_target,
            redo_transaction=result.redo_transaction,
            recovery_events=result.recovery_events,
        )
        return {"undo": enriched.to_dict(), "payload": self.build_payload()}

    def save_node_source(self, target_id: str, content: str) -> dict[str, Any]:
        node = self._projection_context().require_graph_node(target_id)
        if node.kind == NodeKind.MODULE:
            return self.apply_edit(
                StructuralEditRequest(
                    kind=StructuralEditKind.REPLACE_MODULE_SOURCE,
                    target_id=target_id,
                    content=content,
                )
            )

        return self.apply_edit(
            StructuralEditRequest(
                kind=StructuralEditKind.REPLACE_SYMBOL_SOURCE,
                target_id=target_id,
                content=content,
            )
        )

    def parse_flow_expression(
        self,
        expression: str,
        *,
        input_slot_by_name: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        try:
            graph = expression_graph_from_expression(
                expression,
                input_slot_by_name=input_slot_by_name,
            )
        except SyntaxError as exc:
            return {
                "expression": expression,
                "graph": None,
                "diagnostics": [f"Invalid Python expression: {exc.msg}."],
            }
        return {
            "expression": expression.strip(),
            "graph": graph,
            "diagnostics": [],
        }

    def _reparse_touched_modules(self, touched_relative_paths: tuple[str, ...]) -> tuple[str, ...]:
        refreshed_inventory = discover_python_modules(self.root_path)
        previous_by_relative = {
            parsed.module.relative_path: parsed for parsed in self.parsed_modules
        }
        parser = PythonModuleParser()
        reparsed: list[str] = []
        next_parsed_modules: list[ParsedModule] = []
        touched = set(touched_relative_paths)

        for module in refreshed_inventory.modules:
            previous = previous_by_relative.get(module.relative_path)
            needs_reparse = (
                module.relative_path in touched
                or previous is None
                or previous.module.module_name != module.module_name
                or previous.module.file_path != module.file_path
            )
            if needs_reparse:
                next_parsed_modules.append(parser.parse_module(module))
                reparsed.append(module.relative_path)
            else:
                next_parsed_modules.append(previous)

        self.inventory = refreshed_inventory
        self.parsed_modules = next_parsed_modules
        self.graph = build_repo_graph(self.root_path, self.parsed_modules)
        return tuple(reparsed)

