"""Graph-to-source structural mutation helpers."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from helm._vendor import ensure_vendor_packages
from helm.editor.models import StructuralEditKind, StructuralEditRequest, StructuralEditResult
from helm.parser.symbols import ParsedModule, SymbolDef, SymbolKind

ensure_vendor_packages()

import libcst as cst


@dataclass(frozen=True)
class EditContext:
    root_path: Path
    parsed_by_symbol_id: dict[str, tuple[ParsedModule, SymbolDef]]
    parsed_by_relative_path: dict[str, ParsedModule]
    inbound_dependency_count: dict[str, int]


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

    if request.kind == StructuralEditKind.RENAME_SYMBOL:
        return _rename_symbol(context, request)
    if request.kind == StructuralEditKind.CREATE_SYMBOL:
        return _create_symbol(context, request)
    if request.kind == StructuralEditKind.DELETE_SYMBOL:
        return _delete_symbol(context, request)
    if request.kind == StructuralEditKind.MOVE_SYMBOL:
        return _move_symbol(context, request)
    if request.kind == StructuralEditKind.ADD_IMPORT:
        return _add_import(context, request)
    if request.kind == StructuralEditKind.REMOVE_IMPORT:
        return _remove_import(context, request)
    if request.kind == StructuralEditKind.REPLACE_SYMBOL_SOURCE:
        return _replace_symbol_source(context, request)
    raise ValueError(f"Unsupported edit kind: {request.kind.value}")


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
    source_path = Path(parsed.module.file_path)
    module = cst.parse_module(source_path.read_text(encoding="utf-8"))
    snippet = _symbol_template(
        request.symbol_kind or "function",
        request.new_name or "new_symbol",
        request.body,
    )
    statement = cst.parse_module(snippet).body[0]
    updated = module.with_changes(body=[*module.body, _append_spacing(statement)])
    source_path.write_text(updated.code, encoding="utf-8")
    return StructuralEditResult(
        request=request,
        summary=f"Created {request.symbol_kind} {request.new_name} in {parsed.module.relative_path}.",
        touched_relative_paths=(parsed.module.relative_path,),
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
    parsed, symbol = _require_top_level_symbol(context, request.target_id or "")
    if symbol.kind not in {
        SymbolKind.FUNCTION,
        SymbolKind.ASYNC_FUNCTION,
        SymbolKind.VARIABLE,
    }:
        raise ValueError(
            "Inline source editing only supports top-level functions and variables in v1."
        )

    source_path = Path(parsed.module.file_path)
    module = cst.parse_module(source_path.read_text(encoding="utf-8"))
    replacement = _parse_replacement_statement(symbol, request.content or "")
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

    source_path.write_text(module.with_changes(body=updated_body).code, encoding="utf-8")
    return StructuralEditResult(
        request=request,
        summary=f"Updated {symbol.qualname} source.",
        touched_relative_paths=(parsed.module.relative_path,),
        changed_node_ids=(symbol.symbol_id,),
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


def _require_module(context: EditContext, relative_path: str) -> ParsedModule:
    parsed = context.parsed_by_relative_path.get(relative_path)
    if parsed is None:
        raise ValueError(f"Unknown module path: {relative_path}")
    return parsed


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

    if symbol.kind in {SymbolKind.FUNCTION, SymbolKind.ASYNC_FUNCTION}:
        if not isinstance(statement, cst.FunctionDef):
            raise ValueError("Function replacements must parse as exactly one top-level function.")
        if statement.name.value != symbol.name:
            raise ValueError(
                f"Function replacement must keep the original name '{symbol.name}'."
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
