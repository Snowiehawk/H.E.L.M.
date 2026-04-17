"""Graph-to-source structural mutation helpers."""

from __future__ import annotations

import ast
import keyword
from dataclasses import dataclass, replace as dataclass_replace
from pathlib import Path, PurePosixPath
from typing import Callable, Iterable

from helm._vendor import ensure_vendor_packages
from helm.editor.declaration_support import require_editable_declaration_support
from helm.editor.flow_model import (
    FLOW_MODEL_RELATIVE_PATH,
    FlowImportError,
    compile_flow_document,
    find_ast_symbol,
    flow_document_from_payload,
    function_inputs_from_function_source,
    function_source_for_qualname,
    function_source_hash,
    import_flow_document_from_function_source,
    indexed_flow_entry_node_id,
    read_flow_document,
    with_flow_document_inherited_input_model,
    with_flow_document_indexed_node_ids,
    with_flow_document_status,
    without_flow_return_completion_edges,
    write_flow_document,
)
from helm.editor.models import (
    BackendUndoResult,
    BackendUndoTransaction,
    StructuralEditKind,
    StructuralEditRequest,
    StructuralEditResult,
    UndoFileSnapshot,
    UndoFocusTarget,
)
from helm.parser.symbols import ParsedModule, SymbolDef, SymbolKind, make_module_id, make_symbol_id

ensure_vendor_packages()

import libcst as cst


@dataclass(frozen=True)
class EditContext:
    root_path: Path
    parsed_by_symbol_id: dict[str, tuple[ParsedModule, SymbolDef]]
    parsed_by_relative_path: dict[str, ParsedModule]
    inbound_dependency_count: dict[str, int]


@dataclass(frozen=True)
class _PendingFlowInsertEdge:
    source_id: str
    path_key: str | None = None
    path_label: str | None = None
    path_order: int | None = None


@dataclass(frozen=True)
class _FlowStatementLocation:
    container_path: tuple[tuple[int, str], ...]
    local_index: int
    statement: ast.stmt


@dataclass(frozen=True)
class _FlowInsertTarget:
    container_path: tuple[tuple[int, str], ...]
    insert_index: int


def apply_structural_edit(
    root: Path | str,
    request: StructuralEditRequest,
    *,
    parsed_modules: Iterable[ParsedModule],
    inbound_dependency_count: dict[str, int] | None = None,
) -> StructuralEditResult:
    """Apply a validated structural edit to source files in ``root``."""

    root_path = Path(root).resolve()
    parsed_sequence = tuple(parsed_modules)
    symbol_map: dict[str, tuple[ParsedModule, SymbolDef]] = {}
    parsed_by_relative_path = {
        parsed.module.relative_path: parsed for parsed in parsed_sequence
    }
    for parsed in parsed_sequence:
        for symbol in parsed.symbols:
            symbol_map[symbol.symbol_id] = (parsed, symbol)

    context = EditContext(
        root_path=root_path,
        parsed_by_symbol_id=symbol_map,
        parsed_by_relative_path=parsed_by_relative_path,
        inbound_dependency_count=inbound_dependency_count or {},
    )

    undo_snapshot_paths = _undo_snapshot_paths_for_request(context, request)
    pre_edit_snapshots = _capture_undo_file_snapshots(root_path, undo_snapshot_paths)

    if request.kind == StructuralEditKind.CREATE_MODULE:
        result = _create_module(context, request)
    elif request.kind == StructuralEditKind.RENAME_SYMBOL:
        result = _rename_symbol(context, request)
    elif request.kind == StructuralEditKind.CREATE_SYMBOL:
        result = _create_symbol(context, request)
    elif request.kind == StructuralEditKind.DELETE_SYMBOL:
        result = _delete_symbol(context, request)
    elif request.kind == StructuralEditKind.MOVE_SYMBOL:
        result = _move_symbol(context, request)
    elif request.kind == StructuralEditKind.ADD_IMPORT:
        result = _add_import(context, request)
    elif request.kind == StructuralEditKind.REMOVE_IMPORT:
        result = _remove_import(context, request)
    elif request.kind == StructuralEditKind.REPLACE_SYMBOL_SOURCE:
        result = _replace_symbol_source(context, request)
    elif request.kind == StructuralEditKind.INSERT_FLOW_STATEMENT:
        result = _insert_flow_statement(context, request)
    elif request.kind == StructuralEditKind.REPLACE_FLOW_GRAPH:
        result = _replace_flow_graph(context, request)
    else:
        raise ValueError(f"Unsupported edit kind: {request.kind.value}")

    return StructuralEditResult(
        request=result.request,
        summary=result.summary,
        touched_relative_paths=result.touched_relative_paths,
        reparsed_relative_paths=result.reparsed_relative_paths,
        changed_node_ids=result.changed_node_ids,
        warnings=result.warnings,
        flow_sync_state=result.flow_sync_state,
        diagnostics=result.diagnostics,
        undo_transaction=BackendUndoTransaction(
            summary=result.summary,
            request_kind=request.kind.value,
            file_snapshots=pre_edit_snapshots,
            changed_node_ids=result.changed_node_ids,
            focus_target=_undo_focus_target_for_request(context, request),
        ),
    )


def apply_backend_undo(
    root: Path | str,
    transaction: BackendUndoTransaction,
) -> BackendUndoResult:
    """Restore repo files from a serialized undo transaction."""

    root_path = Path(root).resolve()
    current_snapshots = _capture_undo_file_snapshots(
        root_path,
        tuple(snapshot.relative_path for snapshot in transaction.file_snapshots),
    )

    try:
        for snapshot in transaction.file_snapshots:
            _restore_undo_snapshot(root_path, snapshot)
    except Exception as exc:
        for snapshot in current_snapshots:
            _restore_undo_snapshot(root_path, snapshot)
        raise ValueError(f"Unable to apply backend undo safely: {exc}") from exc

    return BackendUndoResult(
        summary=f"Undid: {transaction.summary}",
        restored_relative_paths=tuple(
            snapshot.relative_path for snapshot in transaction.file_snapshots
        ),
        focus_target=transaction.focus_target,
    )


def _undo_snapshot_paths_for_request(
    context: EditContext,
    request: StructuralEditRequest,
) -> tuple[str, ...]:
    if request.kind == StructuralEditKind.CREATE_MODULE:
        return (_validated_module_relative_path(request.relative_path or ""),)

    if request.kind == StructuralEditKind.CREATE_SYMBOL:
        parsed = _require_module(context, request.relative_path or "")
        return (parsed.module.relative_path,)

    if request.kind in {StructuralEditKind.ADD_IMPORT, StructuralEditKind.REMOVE_IMPORT}:
        parsed = _require_module(context, request.relative_path or "")
        return (parsed.module.relative_path,)

    if request.kind in {
        StructuralEditKind.RENAME_SYMBOL,
        StructuralEditKind.DELETE_SYMBOL,
        StructuralEditKind.MOVE_SYMBOL,
    }:
        parsed, symbol = _require_top_level_symbol(context, request.target_id or "")
        paths = [parsed.module.relative_path]
        if request.kind == StructuralEditKind.MOVE_SYMBOL:
            destination = _require_module(context, request.destination_relative_path or "")
            if destination.module.relative_path not in paths:
                paths.append(destination.module.relative_path)
        return tuple(paths)

    if request.kind == StructuralEditKind.REPLACE_SYMBOL_SOURCE:
        parsed, symbol = _require_symbol(context, request.target_id or "")
        paths = [parsed.module.relative_path]
        if _tracks_flow_document(symbol.kind) and FLOW_MODEL_RELATIVE_PATH not in paths:
            paths.append(FLOW_MODEL_RELATIVE_PATH)
        return tuple(paths)

    if request.kind == StructuralEditKind.INSERT_FLOW_STATEMENT:
        parsed, _ = _require_symbol(context, request.target_id or "")
        return (parsed.module.relative_path,)

    if request.kind == StructuralEditKind.REPLACE_FLOW_GRAPH:
        parsed, _ = _require_symbol(context, request.target_id or "")
        return (parsed.module.relative_path, FLOW_MODEL_RELATIVE_PATH)

    raise ValueError(f"Unsupported edit kind: {request.kind.value}")


def _capture_undo_file_snapshots(
    root_path: Path,
    relative_paths: tuple[str, ...],
) -> tuple[UndoFileSnapshot, ...]:
    snapshots: list[UndoFileSnapshot] = []
    seen_relative_paths: set[str] = set()
    for relative_path in relative_paths:
        normalized_relative_path = _validated_repo_relative_path(relative_path)
        if normalized_relative_path in seen_relative_paths:
            continue
        seen_relative_paths.add(normalized_relative_path)
        source_path = _resolve_repo_relative_path(root_path, normalized_relative_path)
        if source_path.exists():
            snapshots.append(
                UndoFileSnapshot(
                    relative_path=normalized_relative_path,
                    existed=True,
                    content=source_path.read_text(encoding="utf-8"),
                )
            )
            continue
        snapshots.append(
            UndoFileSnapshot(
                relative_path=normalized_relative_path,
                existed=False,
                content=None,
            )
        )
    return tuple(snapshots)


def _restore_undo_snapshot(root_path: Path, snapshot: UndoFileSnapshot) -> None:
    source_path = _resolve_repo_relative_path(root_path, snapshot.relative_path)
    if snapshot.existed:
        if snapshot.content is None:
            raise ValueError(
                f"Undo snapshot for '{snapshot.relative_path}' is missing file content."
            )
        source_path.parent.mkdir(parents=True, exist_ok=True)
        source_path.write_text(snapshot.content, encoding="utf-8")
        return

    if source_path.exists():
        if source_path.is_dir():
            raise ValueError(
                f"Undo snapshot expected a file path for '{snapshot.relative_path}', but found a directory."
            )
        source_path.unlink()
        _cleanup_empty_parent_dirs(root_path, source_path.parent)


def _cleanup_empty_parent_dirs(root_path: Path, directory: Path) -> None:
    current = directory
    while current != root_path and current.exists():
        try:
            current.rmdir()
        except OSError:
            break
        current = current.parent


def _validated_repo_relative_path(relative_path: str) -> str:
    raw = relative_path.strip()
    if not raw:
        raise ValueError("Repo-relative path cannot be empty.")

    path = PurePosixPath(raw)
    if path.is_absolute():
        raise ValueError("Repo-relative paths must be relative to the repo root.")
    if any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError("Repo-relative paths must not contain empty, '.', or '..' segments.")
    return path.as_posix()


def _resolve_repo_relative_path(root_path: Path, relative_path: str) -> Path:
    normalized_relative_path = _validated_repo_relative_path(relative_path)
    source_path = (root_path / normalized_relative_path).resolve()
    try:
        source_path.relative_to(root_path)
    except ValueError as exc:
        raise ValueError(
            f"Repo-relative path '{normalized_relative_path}' escapes the repo root."
        ) from exc
    return source_path


def _undo_focus_target_for_request(
    context: EditContext,
    request: StructuralEditRequest,
) -> UndoFocusTarget:
    if request.kind == StructuralEditKind.CREATE_MODULE:
        return UndoFocusTarget(
            target_id=f"repo:{context.root_path.as_posix()}",
            level="repo",
        )

    if request.kind == StructuralEditKind.CREATE_SYMBOL:
        parsed = _require_module(context, request.relative_path or "")
        return UndoFocusTarget(
            target_id=make_module_id(parsed.module.module_name),
            level="module",
        )

    if request.kind in {StructuralEditKind.ADD_IMPORT, StructuralEditKind.REMOVE_IMPORT}:
        parsed = _require_module(context, request.relative_path or "")
        return UndoFocusTarget(
            target_id=make_module_id(parsed.module.module_name),
            level="module",
        )

    if request.kind in {
        StructuralEditKind.RENAME_SYMBOL,
        StructuralEditKind.DELETE_SYMBOL,
        StructuralEditKind.MOVE_SYMBOL,
        StructuralEditKind.REPLACE_SYMBOL_SOURCE,
    }:
        return UndoFocusTarget(
            target_id=request.target_id or "",
            level="symbol",
        )

    if request.kind in {
        StructuralEditKind.INSERT_FLOW_STATEMENT,
        StructuralEditKind.REPLACE_FLOW_GRAPH,
    }:
        return UndoFocusTarget(
            target_id=request.target_id or "",
            level="flow",
        )

    return UndoFocusTarget(
        target_id=f"repo:{context.root_path.as_posix()}",
        level="repo",
    )


def _create_module(context: EditContext, request: StructuralEditRequest) -> StructuralEditResult:
    relative_path = _validated_module_relative_path(request.relative_path or "")
    destination_path = (context.root_path / relative_path).resolve()
    if destination_path.exists():
        raise ValueError(f"Module path '{relative_path}' already exists.")

    destination_path.parent.mkdir(parents=True, exist_ok=True)
    destination_path.write_text(_normalized_module_content(request.content), encoding="utf-8")
    module_name = _module_name_from_relative_path(PurePosixPath(relative_path))
    return StructuralEditResult(
        request=request,
        summary=f"Created module {relative_path}.",
        touched_relative_paths=(relative_path,),
        changed_node_ids=(make_module_id(module_name),),
    )


def _rename_symbol(context: EditContext, request: StructuralEditRequest) -> StructuralEditResult:
    parsed, symbol = _require_top_level_symbol(context, request.target_id or "")
    dependency_count = context.inbound_dependency_count.get(symbol.symbol_id, 0)
    if dependency_count > 0:
        raise ValueError(
            f"Cannot safely rename {symbol.qualname}; {dependency_count} inbound dependency links would need coordinated updates."
        )

    source_path = Path(parsed.module.file_path)
    module = cst.parse_module(source_path.read_text(encoding="utf-8"))
    updated = module.with_changes(
        body=[
            _rename_statement_name(statement, symbol.name, request.new_name or "")
            for statement in module.body
        ]
    )
    source_path.write_text(updated.code, encoding="utf-8")
    return StructuralEditResult(
        request=request,
        summary=f"Renamed {symbol.qualname} to {request.new_name}.",
        touched_relative_paths=(parsed.module.relative_path,),
        changed_node_ids=(symbol.symbol_id,),
    )


def _create_symbol(context: EditContext, request: StructuralEditRequest) -> StructuralEditResult:
    parsed = _require_module(context, request.relative_path or "")
    new_name = request.new_name or "new_symbol"
    _validate_created_symbol_name(parsed, new_name)
    source_path = Path(parsed.module.file_path)
    module = cst.parse_module(source_path.read_text(encoding="utf-8"))
    snippet = _symbol_template(
        request.symbol_kind or "function",
        new_name,
        request.body,
    )
    statement = cst.parse_module(snippet).body[0]
    updated = module.with_changes(body=[*module.body, _append_spacing(statement)])
    source_path.write_text(updated.code, encoding="utf-8")
    return StructuralEditResult(
        request=request,
        summary=f"Created {request.symbol_kind} {new_name} in {parsed.module.relative_path}.",
        touched_relative_paths=(parsed.module.relative_path,),
        changed_node_ids=(make_symbol_id(parsed.module.module_name, new_name),),
    )


def _delete_symbol(context: EditContext, request: StructuralEditRequest) -> StructuralEditResult:
    parsed, symbol = _require_top_level_symbol(context, request.target_id or "")
    dependency_count = context.inbound_dependency_count.get(symbol.symbol_id, 0)
    if dependency_count > 0:
        raise ValueError(
            f"Cannot safely delete {symbol.qualname}; {dependency_count} inbound dependency links still point at it."
        )

    source_path = Path(parsed.module.file_path)
    module = cst.parse_module(source_path.read_text(encoding="utf-8"))
    updated_body = [
        statement
        for statement in module.body
        if not _statement_matches_symbol(statement, symbol.name)
    ]
    if len(updated_body) == len(module.body):
        raise ValueError(f"Unable to find top-level symbol {symbol.qualname} in source.")
    source_path.write_text(module.with_changes(body=updated_body).code, encoding="utf-8")
    return StructuralEditResult(
        request=request,
        summary=f"Deleted {symbol.qualname}.",
        touched_relative_paths=(parsed.module.relative_path,),
        changed_node_ids=(symbol.symbol_id,),
    )


def _move_symbol(context: EditContext, request: StructuralEditRequest) -> StructuralEditResult:
    parsed, symbol = _require_top_level_symbol(context, request.target_id or "")
    dependency_count = context.inbound_dependency_count.get(symbol.symbol_id, 0)
    if dependency_count > 0:
        raise ValueError(
            f"Cannot safely move {symbol.qualname}; {dependency_count} inbound dependency links would need coordinated updates."
        )

    destination = _require_module(context, request.destination_relative_path or "")
    if destination.module.relative_path == parsed.module.relative_path:
        raise ValueError("Destination module must be different from the source module.")

    source_path = Path(parsed.module.file_path)
    destination_path = Path(destination.module.file_path)
    source_module = cst.parse_module(source_path.read_text(encoding="utf-8"))
    destination_module = cst.parse_module(destination_path.read_text(encoding="utf-8"))
    moved_statement = _extract_statement(source_module.body, symbol.name)
    source_body = [
        statement
        for statement in source_module.body
        if not _statement_matches_symbol(statement, symbol.name)
    ]
    updated_source = source_module.with_changes(body=source_body)
    updated_destination = destination_module.with_changes(
        body=[*destination_module.body, _append_spacing(moved_statement)]
    )
    source_path.write_text(updated_source.code, encoding="utf-8")
    destination_path.write_text(updated_destination.code, encoding="utf-8")
    return StructuralEditResult(
        request=request,
        summary=(
            f"Moved {symbol.qualname} from {parsed.module.relative_path} "
            f"to {destination.module.relative_path}."
        ),
        touched_relative_paths=(
            parsed.module.relative_path,
            destination.module.relative_path,
        ),
        changed_node_ids=(symbol.symbol_id,),
    )


def _add_import(context: EditContext, request: StructuralEditRequest) -> StructuralEditResult:
    parsed = _require_module(context, request.relative_path or "")
    source_path = Path(parsed.module.file_path)
    source = source_path.read_text(encoding="utf-8")
    module = cst.parse_module(source)
    new_statement = _build_import_statement(request)
    insertion_index = _import_insertion_index(module.body)
    updated_body = [
        *module.body[:insertion_index],
        _append_spacing(new_statement),
        *module.body[insertion_index:],
    ]
    source_path.write_text(module.with_changes(body=updated_body).code, encoding="utf-8")
    return StructuralEditResult(
        request=request,
        summary=f"Added import to {parsed.module.relative_path}.",
        touched_relative_paths=(parsed.module.relative_path,),
    )


def _remove_import(context: EditContext, request: StructuralEditRequest) -> StructuralEditResult:
    parsed = _require_module(context, request.relative_path or "")
    source_path = Path(parsed.module.file_path)
    module = cst.parse_module(source_path.read_text(encoding="utf-8"))
    updated_body = [
        statement
        for statement in module.body
        if not _statement_matches_import(
            statement,
            imported_module=request.imported_module or "",
            imported_name=request.imported_name,
            alias=request.alias,
        )
    ]
    if len(updated_body) == len(module.body):
        raise ValueError("No matching import statement was found to remove.")
    source_path.write_text(module.with_changes(body=updated_body).code, encoding="utf-8")
    return StructuralEditResult(
        request=request,
        summary=f"Removed import from {parsed.module.relative_path}.",
        touched_relative_paths=(parsed.module.relative_path,),
    )


def _replace_symbol_source(
    context: EditContext,
    request: StructuralEditRequest,
) -> StructuralEditResult:
    parsed, symbol = _require_symbol(context, request.target_id or "")
    require_editable_declaration_support(
        symbol,
        lookup_symbol=lambda symbol_id: _lookup_symbol_from_context(context, symbol_id),
    )

    source_path = Path(parsed.module.file_path)
    module = cst.parse_module(source_path.read_text(encoding="utf-8"))
    replacement = _parse_replacement_statement(symbol, request.content or "")
    if symbol.kind == SymbolKind.VARIABLE:
        replaced = False
        updated_body: list[cst.CSTNode] = []

        for statement in module.body:
            if _statement_matches_symbol(statement, symbol.name):
                updated_body.append(_preserve_statement_spacing(statement, replacement))
                replaced = True
            else:
                updated_body.append(statement)

        if not replaced:
            raise ValueError(f"Unable to find top-level symbol {symbol.qualname} in source.")

        updated_module = module.with_changes(body=updated_body)
    else:
        updated_module = _replace_qualname_declaration(
            module,
            symbol.qualname.split("."),
            lambda declaration: replacement,
        )

    source_path.write_text(updated_module.code, encoding="utf-8")
    flow_sync_state: str | None = None
    diagnostics: tuple[str, ...] = tuple()
    if _tracks_flow_document(symbol.kind):
        flow_sync_state, diagnostics = _sync_flow_document_from_symbol_source(
            context,
            parsed=parsed,
            symbol=symbol,
        )
    return StructuralEditResult(
        request=request,
        summary=f"Updated {symbol.qualname} source.",
        touched_relative_paths=(
            parsed.module.relative_path,
            *( (FLOW_MODEL_RELATIVE_PATH,) if flow_sync_state is not None else tuple() ),
        ),
        changed_node_ids=(symbol.symbol_id,),
        flow_sync_state=flow_sync_state,
        diagnostics=diagnostics,
    )


def _insert_flow_statement(
    context: EditContext,
    request: StructuralEditRequest,
) -> StructuralEditResult:
    parsed, symbol = _require_symbol(context, request.target_id or "")
    if not _is_flow_insertable_symbol(symbol.kind):
        raise ValueError("Flow insertion is only available for functions and methods in v1.")

    source_path = Path(parsed.module.file_path)
    source = source_path.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=parsed.module.file_path)
    function_node = find_ast_symbol(tree, symbol.qualname)
    if not isinstance(function_node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        raise ValueError(f"Unable to resolve flow for {symbol.qualname}.")

    insert_targets = _build_flow_insert_targets(symbol.symbol_id, function_node.body)
    insert_target = insert_targets.get(request.anchor_edge_id or "")
    if insert_target is None:
        raise ValueError("Unknown control-flow anchor edge for flow insertion.")

    statement = _parse_flow_insert_statement(request.content or "")
    module = cst.parse_module(source)
    updated = _replace_qualname_declaration(
        module,
        symbol.qualname.split("."),
        lambda declaration: _insert_statement_into_declaration(declaration, insert_target, statement),
    )
    source_path.write_text(updated.code, encoding="utf-8")
    updated_tree = ast.parse(updated.code, filename=parsed.module.file_path)
    updated_function = find_ast_symbol(updated_tree, symbol.qualname)
    changed_node_ids: tuple[str, ...] = tuple()
    if isinstance(updated_function, (ast.FunctionDef, ast.AsyncFunctionDef)):
        inserted_node_id = _resolve_flow_node_id_at_insert_target(
            symbol.symbol_id,
            updated_function.body,
            insert_target,
        )
        if inserted_node_id:
            changed_node_ids = (inserted_node_id,)
    return StructuralEditResult(
        request=request,
        summary=f"Inserted flow statement into {symbol.qualname}.",
        touched_relative_paths=(parsed.module.relative_path,),
        changed_node_ids=changed_node_ids,
    )


def _replace_flow_graph(
    context: EditContext,
    request: StructuralEditRequest,
) -> StructuralEditResult:
    parsed, symbol = _require_symbol(context, request.target_id or "")
    if not _is_flow_insertable_symbol(symbol.kind):
        raise ValueError("Visual flow editing is only available for functions and methods in v1.")
    if request.flow_graph is None:
        raise ValueError("replace_flow_graph requires a flow graph payload.")

    source_path = Path(parsed.module.file_path)
    source = source_path.read_text(encoding="utf-8")
    current_function_source = function_source_for_qualname(source, symbol.qualname)
    document = without_flow_return_completion_edges(flow_document_from_payload(request.flow_graph))
    if document.symbol_id != symbol.symbol_id:
        raise ValueError("Flow graph payload does not match the requested symbol.")
    try:
        source_document = import_flow_document_from_function_source(
            symbol_id=symbol.symbol_id,
            relative_path=parsed.module.relative_path,
            qualname=symbol.qualname,
            module_source=source,
        )
    except FlowImportError:
        source_document = None
    if source_document is not None:
        document = with_flow_document_inherited_input_model(
            document,
            source_document=source_document,
        )
    document = with_flow_document_status(
        document,
        sync_state=document.sync_state,
        diagnostics=document.diagnostics,
        source_hash=function_source_hash(current_function_source),
        editable=True,
    )
    compiled = compile_flow_document(document)
    touched_relative_paths: tuple[str, ...]
    if compiled.body_source is not None:
        module = cst.parse_module(source)
        updated = _replace_qualname_declaration(
            module,
            symbol.qualname.split("."),
            lambda declaration: _replace_function_body_with_source(
                declaration,
                compiled.body_source or "pass",
            ),
        )
        source_path.write_text(updated.code, encoding="utf-8")
        updated_source = source_path.read_text(encoding="utf-8")
        updated_function_source = function_source_for_qualname(updated_source, symbol.qualname)
        imported_document = import_flow_document_from_function_source(
            symbol_id=symbol.symbol_id,
            relative_path=parsed.module.relative_path,
            qualname=symbol.qualname,
            module_source=updated_source,
        )
        compiled_document = with_flow_document_status(
            with_flow_document_indexed_node_ids(
                compiled.document,
                source_document=imported_document,
            ),
            sync_state="clean",
            diagnostics=(),
            source_hash=function_source_hash(updated_function_source),
            editable=True,
        )
        write_flow_document(context.root_path, compiled_document)
        touched_relative_paths = (parsed.module.relative_path, FLOW_MODEL_RELATIVE_PATH)
        return StructuralEditResult(
            request=request,
            summary=f"Updated visual flow for {symbol.qualname}.",
            touched_relative_paths=touched_relative_paths,
            changed_node_ids=(symbol.symbol_id, *(node.node_id for node in compiled_document.nodes)),
            flow_sync_state="clean",
            diagnostics=(),
        )

    draft_document = with_flow_document_status(
        compiled.document,
        sync_state="draft",
        diagnostics=compiled.diagnostics,
        source_hash=function_source_hash(current_function_source),
        editable=True,
    )
    write_flow_document(context.root_path, draft_document)
    return StructuralEditResult(
        request=request,
        summary=f"Saved draft visual flow for {symbol.qualname}.",
        touched_relative_paths=(FLOW_MODEL_RELATIVE_PATH,),
        changed_node_ids=(symbol.symbol_id, *(node.node_id for node in draft_document.nodes)),
        flow_sync_state="draft",
        diagnostics=draft_document.diagnostics,
        warnings=("Python source was left unchanged until the flow graph validates cleanly.",),
    )


def _require_top_level_symbol(
    context: EditContext,
    symbol_id: str,
) -> tuple[ParsedModule, SymbolDef]:
    match = context.parsed_by_symbol_id.get(symbol_id)
    if match is None:
        raise ValueError(f"Unknown symbol id: {symbol_id}")
    parsed, symbol = match
    if symbol.parent_symbol_id is not None:
        raise ValueError("Only top-level functions and classes are editable in v1.")
    return parsed, symbol


def _require_symbol(
    context: EditContext,
    symbol_id: str,
) -> tuple[ParsedModule, SymbolDef]:
    match = context.parsed_by_symbol_id.get(symbol_id)
    if match is None:
        raise ValueError(f"Unknown symbol id: {symbol_id}")
    return match


def _require_module(context: EditContext, relative_path: str) -> ParsedModule:
    parsed = context.parsed_by_relative_path.get(relative_path)
    if parsed is None:
        raise ValueError(f"Unknown module path: {relative_path}")
    return parsed


def _validated_module_relative_path(relative_path: str) -> str:
    raw = relative_path.strip()
    if not raw:
        raise ValueError("Module path cannot be empty.")

    path = PurePosixPath(raw)
    if path.is_absolute():
        raise ValueError("Module path must be relative to the repo root.")
    if path.suffix != ".py":
        raise ValueError("Module path must point to a Python source file ending in '.py'.")
    if any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError("Module path must not contain empty, '.' or '..' segments.")
    return path.as_posix()


def _normalized_module_content(content: str | None) -> str:
    if content is None or not content:
        return ""
    return content if content.endswith("\n") else f"{content}\n"


def _module_name_from_relative_path(relative_path: PurePosixPath) -> str:
    without_suffix = relative_path.with_suffix("")
    parts = list(without_suffix.parts)
    if not parts:
        raise ValueError("Expected a non-empty relative path for module creation.")
    if parts[-1] == "__init__":
        package_parts = parts[:-1]
        return ".".join(package_parts) if package_parts else "__init__"
    return ".".join(parts)


def _rename_statement_name(
    statement: cst.CSTNode,
    old_name: str,
    new_name: str,
) -> cst.CSTNode:
    if isinstance(statement, cst.FunctionDef) and statement.name.value == old_name:
        return statement.with_changes(name=cst.Name(new_name))
    if isinstance(statement, cst.ClassDef) and statement.name.value == old_name:
        return statement.with_changes(name=cst.Name(new_name))
    return statement


def _statement_matches_symbol(statement: cst.CSTNode, symbol_name: str) -> bool:
    if isinstance(statement, cst.FunctionDef):
        return statement.name.value == symbol_name
    if isinstance(statement, cst.ClassDef):
        return statement.name.value == symbol_name
    if isinstance(statement, cst.SimpleStatementLine) and len(statement.body) == 1:
        small = statement.body[0]
        if isinstance(small, cst.Assign) and len(small.targets) == 1:
            target = small.targets[0].target
            return isinstance(target, cst.Name) and target.value == symbol_name
        if isinstance(small, cst.AnnAssign):
            target = small.target
            return isinstance(target, cst.Name) and target.value == symbol_name
    return False


def _extract_statement(body: Iterable[cst.CSTNode], symbol_name: str) -> cst.CSTNode:
    for statement in body:
        if _statement_matches_symbol(statement, symbol_name):
            return statement
    raise ValueError(f"Unable to find top-level symbol '{symbol_name}' in source.")


def _build_import_statement(request: StructuralEditRequest) -> cst.CSTNode:
    if request.imported_name:
        alias_fragment = f" as {request.alias}" if request.alias else ""
        snippet = (
            f"from {request.imported_module} import {request.imported_name}{alias_fragment}\n"
        )
    else:
        alias_fragment = f" as {request.alias}" if request.alias else ""
        snippet = f"import {request.imported_module}{alias_fragment}\n"
    return cst.parse_module(snippet).body[0]


def _statement_matches_import(
    statement: cst.CSTNode,
    *,
    imported_module: str,
    imported_name: str | None,
    alias: str | None,
) -> bool:
    if not isinstance(statement, cst.SimpleStatementLine) or len(statement.body) != 1:
        return False

    small = statement.body[0]
    if imported_name is None and isinstance(small, cst.Import):
        for alias_node in small.names:
            if not isinstance(alias_node.name, cst.Name):
                continue
            if alias_node.name.value != imported_module:
                continue
            current_alias = alias_node.asname.name.value if alias_node.asname else None
            return current_alias == alias
        return False

    if imported_name is not None and isinstance(small, cst.ImportFrom):
        module_name = _node_code(small.module) if small.module is not None else ""
        if module_name != imported_module or isinstance(small.names, cst.ImportStar):
            return False
        for alias_node in tuple(small.names):
            if not isinstance(alias_node, cst.ImportAlias):
                continue
            if not isinstance(alias_node.name, cst.Name):
                continue
            if alias_node.name.value != imported_name:
                continue
            current_alias = alias_node.asname.name.value if alias_node.asname else None
            return current_alias == alias
    return False


def _import_insertion_index(body: tuple[cst.CSTNode, ...]) -> int:
    index = 0
    if body and isinstance(body[0], cst.SimpleStatementLine):
        first_line = body[0]
        if (
            len(first_line.body) == 1
            and isinstance(first_line.body[0], cst.Expr)
            and isinstance(first_line.body[0].value, cst.SimpleString)
        ):
            index = 1

    while index < len(body):
        statement = body[index]
        if isinstance(statement, cst.SimpleStatementLine) and all(
            isinstance(item, (cst.Import, cst.ImportFrom)) for item in statement.body
        ):
            index += 1
            continue
        break
    return index


def _append_spacing(statement: cst.CSTNode) -> cst.CSTNode:
    if isinstance(statement, (cst.FunctionDef, cst.ClassDef)):
        return statement.with_changes(leading_lines=[cst.EmptyLine(), *statement.leading_lines])
    if isinstance(statement, cst.SimpleStatementLine):
        return statement.with_changes(leading_lines=[cst.EmptyLine(), *statement.leading_lines])
    return statement


def _preserve_statement_spacing(
    original: cst.CSTNode,
    replacement: cst.CSTNode,
) -> cst.CSTNode:
    if isinstance(original, cst.FunctionDef) and isinstance(
        replacement, (cst.FunctionDef, cst.ClassDef)
    ):
        return replacement.with_changes(leading_lines=original.leading_lines)
    if isinstance(original, cst.ClassDef) and isinstance(
        replacement, (cst.FunctionDef, cst.ClassDef)
    ):
        return replacement.with_changes(leading_lines=original.leading_lines)
    if isinstance(original, cst.SimpleStatementLine) and isinstance(
        replacement, cst.SimpleStatementLine
    ):
        return replacement.with_changes(leading_lines=original.leading_lines)
    return replacement


def _node_code(node: cst.CSTNode) -> str:
    return cst.Module(body=[]).code_for_node(node)


def _symbol_template(symbol_kind: str, name: str, body: str | None) -> str:
    if symbol_kind == "class":
        class_body = body.strip() if body else "pass"
        indented = "\n".join(f"    {line}" for line in class_body.splitlines())
        return f"class {name}:\n{indented}\n"
    function_body = body.strip() if body else "pass"
    indented = "\n".join(f"    {line}" for line in function_body.splitlines())
    return f"def {name}():\n{indented}\n"


def _parse_replacement_statement(symbol: SymbolDef, content: str) -> cst.CSTNode:
    snippet = content.strip()
    if not snippet:
        raise ValueError("Replacement source cannot be empty.")

    parsed = cst.parse_module(f"{snippet}\n")
    if len(parsed.body) != 1:
        raise ValueError("Replacement source must contain exactly one top-level declaration.")

    statement = parsed.body[0]

    if symbol.kind in {
        SymbolKind.FUNCTION,
        SymbolKind.ASYNC_FUNCTION,
        SymbolKind.METHOD,
        SymbolKind.ASYNC_METHOD,
    }:
        if not isinstance(statement, cst.FunctionDef):
            raise ValueError("Function replacements must parse as exactly one top-level function.")
        if statement.name.value != symbol.name:
            raise ValueError(
                f"Function replacement must keep the original name '{symbol.name}'."
            )
        return statement

    if symbol.kind == SymbolKind.CLASS:
        if not isinstance(statement, cst.ClassDef):
            raise ValueError("Class replacements must parse as exactly one top-level class.")
        if statement.name.value != symbol.name:
            raise ValueError(
                f"Class replacement must keep the original name '{symbol.name}'."
            )
        return statement

    if isinstance(statement, cst.SimpleStatementLine) and len(statement.body) == 1:
        small = statement.body[0]
        if isinstance(small, cst.Assign) and len(small.targets) == 1:
            target = small.targets[0].target
            if isinstance(target, cst.Name) and target.value == symbol.name:
                return statement
        if isinstance(small, cst.AnnAssign):
            target = small.target
            if isinstance(target, cst.Name) and target.value == symbol.name:
                return statement

    raise ValueError(
        f"Variable replacement must be a single top-level assignment targeting '{symbol.name}'."
    )


def _validate_created_symbol_name(parsed: ParsedModule, name: str) -> None:
    if not name.isidentifier():
        raise ValueError(f"Created symbol name '{name}' must be a valid Python identifier.")
    if keyword.iskeyword(name):
        raise ValueError(f"Created symbol name '{name}' cannot be a Python keyword.")
    if any(
        symbol.parent_symbol_id is None and symbol.name == name
        for symbol in parsed.symbols
    ):
        raise ValueError(
            f"Top-level symbol '{name}' already exists in {parsed.module.relative_path}."
        )


def _is_flow_insertable_symbol(symbol_kind: SymbolKind) -> bool:
    return symbol_kind in {
        SymbolKind.FUNCTION,
        SymbolKind.ASYNC_FUNCTION,
        SymbolKind.METHOD,
        SymbolKind.ASYNC_METHOD,
    }


def _build_flow_insert_targets(
    symbol_id: str,
    statements: list[ast.stmt],
) -> dict[str, _FlowInsertTarget]:
    entry_id = f"flow:{symbol_id}:entry"
    statement_locations: dict[str, _FlowStatementLocation] = {}
    insert_targets: dict[str, _FlowInsertTarget] = {}

    def record_edges(
        pending_links: list[_PendingFlowInsertEdge],
        *,
        target_id: str,
        target_location: _FlowStatementLocation | None,
    ) -> None:
        for pending in pending_links:
            insert_targets[
                _control_edge_id(pending.source_id, target_id, pending.path_key)
            ] = _flow_insert_target_for_pending(
                pending,
                entry_id=entry_id,
                statement_locations=statement_locations,
                target_location=target_location,
            )

    def append_statement_block(
        current_statements: list[ast.stmt],
        *,
        container_path: tuple[tuple[int, str], ...],
        pending_links: list[_PendingFlowInsertEdge],
        statement_index: int,
    ) -> tuple[list[_PendingFlowInsertEdge], int]:
        current_links = pending_links
        next_statement_index = statement_index
        for local_index, statement in enumerate(current_statements):
            current_links, next_statement_index = append_statement_flow(
                statement=statement,
                container_path=container_path,
                local_index=local_index,
                pending_links=current_links,
                statement_index=next_statement_index,
            )
        return current_links, next_statement_index

    def append_statement_flow(
        *,
        statement: ast.stmt,
        container_path: tuple[tuple[int, str], ...],
        local_index: int,
        pending_links: list[_PendingFlowInsertEdge],
        statement_index: int,
    ) -> tuple[list[_PendingFlowInsertEdge], int]:
        node_id = f"flow:{symbol_id}:statement:{statement_index}"
        location = _FlowStatementLocation(
            container_path=container_path,
            local_index=local_index,
            statement=statement,
        )
        statement_locations[node_id] = location
        record_edges(pending_links, target_id=node_id, target_location=location)
        statement_index += 1

        if isinstance(statement, ast.If):
            true_exits, statement_index = append_statement_block(
                statement.body,
                container_path=(*container_path, (local_index, "body")),
                pending_links=[_pending_flow_edge(node_id, "true", "true", 0)],
                statement_index=statement_index,
            )
            false_exits, statement_index = append_statement_block(
                statement.orelse,
                container_path=(*container_path, (local_index, "orelse")),
                pending_links=[_pending_flow_edge(node_id, "false", "false", 1)],
                statement_index=statement_index,
            )
            return [*true_exits, *false_exits], statement_index

        if isinstance(statement, (ast.For, ast.AsyncFor, ast.While)):
            body_exits, statement_index = append_statement_block(
                statement.body,
                container_path=(*container_path, (local_index, "body")),
                pending_links=[_pending_flow_edge(node_id, "body", "body", 0)],
                statement_index=statement_index,
            )
            if statement.body:
                record_edges(
                    _strip_pending_flow_paths(body_exits),
                    target_id=node_id,
                    target_location=None,
                )
            return [_pending_flow_edge(node_id, "exit", "exit", 1)], statement_index

        return [_PendingFlowInsertEdge(source_id=node_id)], statement_index

    append_statement_block(
        statements,
        container_path=tuple(),
        pending_links=[_PendingFlowInsertEdge(source_id=entry_id)],
        statement_index=0,
    )
    return insert_targets


def _pending_flow_edge(
    source_id: str,
    path_key: str,
    path_label: str,
    path_order: int,
) -> _PendingFlowInsertEdge:
    return _PendingFlowInsertEdge(
        source_id=source_id,
        path_key=path_key,
        path_label=path_label,
        path_order=path_order,
    )


def _strip_pending_flow_paths(
    pending_links: list[_PendingFlowInsertEdge],
) -> list[_PendingFlowInsertEdge]:
    return [_PendingFlowInsertEdge(source_id=pending.source_id) for pending in pending_links]


def _flow_insert_target_for_pending(
    pending: _PendingFlowInsertEdge,
    *,
    entry_id: str,
    statement_locations: dict[str, _FlowStatementLocation],
    target_location: _FlowStatementLocation | None,
) -> _FlowInsertTarget:
    if pending.source_id == entry_id:
        if target_location is None:
            return _FlowInsertTarget(container_path=tuple(), insert_index=0)
        return _FlowInsertTarget(
            container_path=target_location.container_path,
            insert_index=target_location.local_index,
        )

    source_location = statement_locations.get(pending.source_id)
    if source_location is None:
        raise ValueError(f"Unknown source flow node for edge insertion: {pending.source_id}")

    if pending.path_key == "true":
        return _FlowInsertTarget(
            container_path=(*source_location.container_path, (source_location.local_index, "body")),
            insert_index=0,
        )
    if pending.path_key == "false":
        return _FlowInsertTarget(
            container_path=(*source_location.container_path, (source_location.local_index, "orelse")),
            insert_index=0,
        )
    if pending.path_key == "body":
        return _FlowInsertTarget(
            container_path=(*source_location.container_path, (source_location.local_index, "body")),
            insert_index=0,
        )
    if pending.path_key == "exit":
        return _FlowInsertTarget(
            container_path=source_location.container_path,
            insert_index=source_location.local_index + 1,
        )
    if target_location is not None:
        return _FlowInsertTarget(
            container_path=target_location.container_path,
            insert_index=target_location.local_index,
        )
    return _FlowInsertTarget(
        container_path=source_location.container_path,
        insert_index=source_location.local_index + 1,
    )


def _control_edge_id(source_id: str, target_id: str, path_key: str | None) -> str:
    suffix = f":{path_key}" if path_key else ""
    return f"controls:{source_id}->{target_id}{suffix}"


def _resolve_flow_node_id_at_insert_target(
    symbol_id: str,
    statements: list[ast.stmt],
    insert_target: _FlowInsertTarget,
) -> str | None:
    def visit(
        current_statements: list[ast.stmt],
        *,
        container_path: tuple[tuple[int, str], ...],
        statement_index: int,
    ) -> tuple[str | None, int]:
        next_statement_index = statement_index
        for local_index, statement in enumerate(current_statements):
            node_id = f"flow:{symbol_id}:statement:{next_statement_index}"
            if (
                container_path == insert_target.container_path
                and local_index == insert_target.insert_index
            ):
                return node_id, next_statement_index + 1

            next_statement_index += 1
            if isinstance(statement, ast.If):
                found, next_statement_index = visit(
                    statement.body,
                    container_path=(*container_path, (local_index, "body")),
                    statement_index=next_statement_index,
                )
                if found:
                    return found, next_statement_index
                found, next_statement_index = visit(
                    statement.orelse,
                    container_path=(*container_path, (local_index, "orelse")),
                    statement_index=next_statement_index,
                )
                if found:
                    return found, next_statement_index
                continue

            if isinstance(statement, (ast.For, ast.AsyncFor, ast.While)):
                found, next_statement_index = visit(
                    statement.body,
                    container_path=(*container_path, (local_index, "body")),
                    statement_index=next_statement_index,
                )
                if found:
                    return found, next_statement_index
        return None, next_statement_index

    found_node_id, _ = visit(
        statements,
        container_path=tuple(),
        statement_index=0,
    )
    return found_node_id


def _parse_flow_insert_statement(content: str) -> cst.BaseStatement:
    snippet = content.strip()
    if not snippet:
        raise ValueError("Flow insertion content cannot be empty.")

    parsed = cst.parse_module(f"{snippet}\n")
    if len(parsed.body) != 1:
        raise ValueError("Flow insertion must contain exactly one statement.")

    ast_statement = ast.parse(f"{snippet}\n").body[0]
    if not _is_supported_flow_statement(ast_statement):
        raise ValueError(
            "Flow insertion only supports assignment, call, return, branch, and loop statements in v1."
        )
    return parsed.body[0]


def _is_supported_flow_statement(statement: ast.stmt) -> bool:
    if isinstance(statement, ast.Return):
        return True
    if isinstance(statement, (ast.If, ast.For, ast.AsyncFor, ast.While)):
        return True
    if isinstance(statement, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
        return True
    if isinstance(statement, ast.Expr):
        return any(isinstance(node, ast.Call) for node in ast.walk(statement))
    return False


def _replace_function_body_with_source(
    declaration: cst.FunctionDef | cst.ClassDef,
    body_source: str,
) -> cst.FunctionDef | cst.ClassDef:
    if not isinstance(declaration, cst.FunctionDef):
        raise ValueError("Visual flow replacement only supports function declarations.")
    suite = _suite_to_block(declaration.body)
    temp_module = cst.parse_module(f"def _flow_temp():\n{_indent_block(body_source)}\n")
    temp_function = temp_module.body[0]
    if not isinstance(temp_function, cst.FunctionDef):
        raise ValueError("Unable to parse generated flow function body.")
    return declaration.with_changes(body=suite.with_changes(body=_suite_to_block(temp_function.body).body))


def _indent_block(block: str) -> str:
    lines = (block.strip() or "pass").splitlines()
    return "\n".join(f"    {line}" for line in lines)


def _sync_flow_document_from_symbol_source(
    context: EditContext,
    *,
    parsed: ParsedModule,
    symbol: SymbolDef,
) -> tuple[str | None, tuple[str, ...]]:
    source_path = Path(parsed.module.file_path)
    source = source_path.read_text(encoding="utf-8")
    try:
        imported = import_flow_document_from_function_source(
            symbol_id=symbol.symbol_id,
            relative_path=parsed.module.relative_path,
            qualname=symbol.qualname,
            module_source=source,
        )
    except FlowImportError as exc:
        current_function_source = function_source_for_qualname(source, symbol.qualname)
        existing_document = read_flow_document(context.root_path, symbol.symbol_id)
        try:
            current_function_inputs = function_inputs_from_function_source(
                symbol_id=symbol.symbol_id,
                qualname=symbol.qualname,
                module_source=source,
            )
        except SyntaxError:
            current_function_inputs = ()
        if existing_document is not None:
            failure_source = existing_document
            if current_function_inputs:
                failure_source = dataclass_replace(
                    failure_source,
                    function_inputs=current_function_inputs,
                )
        else:
            failure_source = flow_document_from_payload(
                {
                    "symbol_id": symbol.symbol_id,
                    "relative_path": parsed.module.relative_path,
                    "qualname": symbol.qualname,
                    "nodes": [
                        {
                            "id": f"flowdoc:{symbol.symbol_id}:entry",
                            "kind": "entry",
                            "payload": {},
                            "indexed_node_id": indexed_flow_entry_node_id(symbol.symbol_id),
                        },
                        {"id": f"flowdoc:{symbol.symbol_id}:exit", "kind": "exit", "payload": {}},
                    ],
                    "edges": [],
                    "function_inputs": [function_input.to_dict() for function_input in current_function_inputs],
                    "editable": False,
                }
            )
        failure_document = with_flow_document_status(
            failure_source,
            sync_state="import_error",
            diagnostics=(str(exc),),
            source_hash=function_source_hash(current_function_source),
            editable=False,
        )
        write_flow_document(context.root_path, failure_document)
        return "import_error", failure_document.diagnostics

    write_flow_document(context.root_path, imported)
    return "clean", ()


def _replace_qualname_declaration(
    module: cst.Module,
    qualname_parts: list[str],
    updater: Callable[[cst.FunctionDef | cst.ClassDef], cst.FunctionDef | cst.ClassDef],
) -> cst.Module:
    updated_body, replaced = _replace_qualname_in_body(module.body, qualname_parts, updater)
    if not replaced:
        raise ValueError(f"Unable to resolve declaration for {'.'.join(qualname_parts)}.")
    return module.with_changes(body=updated_body)


def _replace_qualname_in_body(
    body: tuple[cst.BaseStatement, ...],
    qualname_parts: list[str],
    updater: Callable[[cst.FunctionDef | cst.ClassDef], cst.FunctionDef | cst.ClassDef],
) -> tuple[tuple[cst.BaseStatement, ...], bool]:
    current_part = qualname_parts[0]
    for index, statement in enumerate(body):
        if not isinstance(statement, (cst.FunctionDef, cst.ClassDef)):
            continue
        if statement.name.value != current_part:
            continue
        if len(qualname_parts) == 1:
            replacement = _preserve_statement_spacing(statement, updater(statement))
        else:
            nested_body = _suite_to_block(statement.body).body
            updated_nested_body, replaced = _replace_qualname_in_body(
                nested_body,
                qualname_parts[1:],
                updater,
            )
            if not replaced:
                return body, False
            replacement = statement.with_changes(
                body=_suite_to_block(statement.body).with_changes(body=updated_nested_body)
            )
        return (
            (*body[:index], replacement, *body[index + 1:]),
            True,
        )
    return body, False


def _lookup_symbol_from_context(
    context: EditContext,
    symbol_id: str,
) -> SymbolDef | None:
    match = context.parsed_by_symbol_id.get(symbol_id)
    if match is None:
        return None
    return match[1]


def _tracks_flow_document(symbol_kind: SymbolKind) -> bool:
    return symbol_kind in {
        SymbolKind.FUNCTION,
        SymbolKind.ASYNC_FUNCTION,
        SymbolKind.METHOD,
        SymbolKind.ASYNC_METHOD,
    }


def _insert_statement_into_declaration(
    declaration: cst.FunctionDef | cst.ClassDef,
    insert_target: _FlowInsertTarget,
    statement: cst.BaseStatement,
) -> cst.FunctionDef | cst.ClassDef:
    if not isinstance(declaration, cst.FunctionDef):
        raise ValueError("Flow insertion only supports function and method declarations.")
    suite = _suite_to_block(declaration.body)
    updated_body = _insert_statement_into_body(
        suite.body,
        insert_target.container_path,
        insert_target.insert_index,
        statement,
    )
    return declaration.with_changes(body=suite.with_changes(body=updated_body))


def _insert_statement_into_body(
    body: tuple[cst.BaseStatement, ...],
    container_path: tuple[tuple[int, str], ...],
    insert_index: int,
    statement: cst.BaseStatement,
) -> tuple[cst.BaseStatement, ...]:
    if not container_path:
        clamped_index = max(0, min(insert_index, len(body)))
        return (*body[:clamped_index], statement, *body[clamped_index:])

    statement_index, attr = container_path[0]
    if statement_index < 0 or statement_index >= len(body):
        raise ValueError("Resolved flow insertion path is out of bounds.")

    updated_statement = _insert_statement_into_nested_suite(
        body[statement_index],
        attr,
        container_path[1:],
        insert_index,
        statement,
    )
    return (*body[:statement_index], updated_statement, *body[statement_index + 1:])


def _insert_statement_into_nested_suite(
    statement: cst.BaseStatement,
    attr: str,
    container_path: tuple[tuple[int, str], ...],
    insert_index: int,
    new_statement: cst.BaseStatement,
) -> cst.BaseStatement:
    if attr == "body":
        if not isinstance(statement, (cst.FunctionDef, cst.ClassDef, cst.If, cst.For, cst.While)):
            raise ValueError("Resolved flow insertion path does not point at a body suite.")
        suite = _suite_to_block(statement.body)
        updated_body = _insert_statement_into_body(
            suite.body,
            container_path,
            insert_index,
            new_statement,
        )
        return statement.with_changes(body=suite.with_changes(body=updated_body))

    if attr != "orelse" or not isinstance(statement, cst.If):
        raise ValueError("Resolved flow insertion path does not point at a supported flow suite.")

    current_orelse = statement.orelse
    if isinstance(current_orelse, cst.Else):
        suite = _suite_to_block(current_orelse.body)
        updated_body = _insert_statement_into_body(
            suite.body,
            container_path,
            insert_index,
            new_statement,
        )
        return statement.with_changes(orelse=current_orelse.with_changes(body=suite.with_changes(body=updated_body)))

    synthetic_else_body = (current_orelse,) if isinstance(current_orelse, cst.If) else tuple()
    updated_body = _insert_statement_into_body(
        synthetic_else_body,
        container_path,
        insert_index,
        new_statement,
    )
    return statement.with_changes(
        orelse=cst.Else(body=cst.IndentedBlock(body=updated_body))
    )


def _suite_to_block(suite: cst.BaseSuite) -> cst.IndentedBlock:
    if isinstance(suite, cst.IndentedBlock):
        return suite
    if isinstance(suite, cst.SimpleStatementSuite):
        return cst.IndentedBlock(body=(cst.SimpleStatementLine(body=tuple(suite.body)),))
    raise ValueError("Unsupported suite shape for flow insertion.")
