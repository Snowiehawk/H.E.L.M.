"""AST-backed Python parser for building H.E.L.M.'s normalized IR."""

from __future__ import annotations

import ast
from dataclasses import dataclass
from pathlib import Path

from helm.parser.symbols import (
    CallSite,
    ImportRef,
    ModuleRef,
    ParseDiagnostic,
    ParsedModule,
    SourceSpan,
    SymbolDef,
    SymbolKind,
    make_call_id,
    make_import_id,
    make_symbol_id,
)


class PythonModuleParser:
    """Parse Python modules into a graph-friendly intermediate representation."""

    def parse_module(self, module: ModuleRef) -> ParsedModule:
        source_path = Path(module.file_path)
        try:
            source = source_path.read_text(encoding="utf-8")
        except OSError as exc:
            diagnostic = ParseDiagnostic(
                code="read_error",
                message=str(exc),
                file_path=str(source_path),
            )
            return ParsedModule(module=module, diagnostics=(diagnostic,))
        except UnicodeDecodeError as exc:
            diagnostic = ParseDiagnostic(
                code="decode_error",
                message=str(exc),
                file_path=str(source_path),
            )
            return ParsedModule(module=module, diagnostics=(diagnostic,))

        line_starts = _line_starts(source)
        try:
            tree = ast.parse(source, filename=str(source_path))
        except SyntaxError as exc:
            diagnostic = ParseDiagnostic(
                code="syntax_error",
                message=exc.msg,
                file_path=str(source_path),
                line=exc.lineno,
                column=(exc.offset - 1) if exc.offset else None,
                span=_syntax_error_span(str(source_path), source, line_starts, exc),
            )
            return ParsedModule(module=module, diagnostics=(diagnostic,))

        visitor = _ModuleVisitor(module=module, source=source, line_starts=line_starts)
        visitor.visit(tree)
        return ParsedModule(
            module=module,
            symbols=tuple(visitor.symbols),
            imports=tuple(visitor.imports),
            calls=tuple(visitor.calls),
            diagnostics=tuple(visitor.diagnostics),
        )


@dataclass
class _ModuleVisitor(ast.NodeVisitor):
    module: ModuleRef
    source: str
    line_starts: list[int]

    def __post_init__(self) -> None:
        self.symbols: list[SymbolDef] = []
        self.imports: list[ImportRef] = []
        self.calls: list[CallSite] = []
        self.diagnostics: list[ParseDiagnostic] = []
        self._symbol_stack: list[SymbolDef] = []

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        symbol = self._make_symbol(node.name, self._class_symbol_kind(node), node)
        self._symbol_stack.append(symbol)
        for statement in node.body:
            if symbol.kind == SymbolKind.CLASS:
                self._record_direct_class_body_symbol(statement)
            self.visit(statement)
        self._symbol_stack.pop()

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        kind = SymbolKind.METHOD if self._direct_parent_is_class_like() else SymbolKind.FUNCTION
        symbol = self._make_symbol(node.name, kind, node)
        self._symbol_stack.append(symbol)
        for statement in node.body:
            self.visit(statement)
        self._symbol_stack.pop()

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        kind = (
            SymbolKind.ASYNC_METHOD
            if self._direct_parent_is_class_like()
            else SymbolKind.ASYNC_FUNCTION
        )
        symbol = self._make_symbol(node.name, kind, node)
        self._symbol_stack.append(symbol)
        for statement in node.body:
            self.visit(statement)
        self._symbol_stack.pop()

    def visit_Assign(self, node: ast.Assign) -> None:
        if not self._symbol_stack:
            for name in _assignment_target_names(node):
                self._make_symbol(name, SymbolKind.VARIABLE, node)
        self.generic_visit(node)

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
        if not self._symbol_stack and isinstance(node.target, ast.Name):
            self._make_symbol(node.target.id, SymbolKind.VARIABLE, node)
        self.generic_visit(node)

    def visit_Import(self, node: ast.Import) -> None:
        owner_symbol_id = self._current_symbol_id()
        span = self._span_for(node)
        for alias in node.names:
            local_name = alias.asname or alias.name.split(".")[0]
            self.imports.append(
                ImportRef(
                    import_id=make_import_id(
                        self.module.module_name,
                        local_name,
                        span.start_line,
                        span.start_column,
                    ),
                    module_id=self.module.module_id,
                    owner_symbol_id=owner_symbol_id,
                    local_name=local_name,
                    imported_module=alias.name,
                    imported_name=None,
                    alias=alias.asname,
                    level=0,
                    span=span,
                )
            )

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        owner_symbol_id = self._current_symbol_id()
        span = self._span_for(node)
        for alias in node.names:
            local_name = alias.asname or alias.name
            self.imports.append(
                ImportRef(
                    import_id=make_import_id(
                        self.module.module_name,
                        local_name,
                        span.start_line,
                        span.start_column,
                    ),
                    module_id=self.module.module_id,
                    owner_symbol_id=owner_symbol_id,
                    local_name=local_name,
                    imported_module=node.module,
                    imported_name=alias.name,
                    alias=alias.asname,
                    level=node.level,
                    span=span,
                )
            )

    def visit_Call(self, node: ast.Call) -> None:
        span = self._span_for(node)
        callee_expr = _safe_unparse(node.func)
        root_name, attribute_path = _extract_call_path(node.func)
        self.calls.append(
            CallSite(
                call_id=make_call_id(
                    self.module.module_name,
                    callee_expr,
                    span.start_line,
                    span.start_column,
                ),
                module_id=self.module.module_id,
                owner_symbol_id=self._current_symbol_id(),
                callee_expr=callee_expr,
                root_name=root_name,
                attribute_path=attribute_path,
                span=span,
            )
        )
        self.generic_visit(node)

    def _make_symbol(
        self,
        name: str,
        kind: SymbolKind,
        node: ast.AST,
    ) -> SymbolDef:
        parent_symbol_id = self._current_symbol_id()
        parent_qualname = self._current_qualname()
        qualname = f"{parent_qualname}.{name}" if parent_qualname else name
        symbol = SymbolDef(
            symbol_id=make_symbol_id(self.module.module_name, qualname),
            module_id=self.module.module_id,
            qualname=qualname,
            name=name,
            kind=kind,
            parent_symbol_id=parent_symbol_id,
            span=self._span_for(node),
        )
        self.symbols.append(symbol)
        return symbol

    def _current_qualname(self) -> str | None:
        if not self._symbol_stack:
            return None
        return self._symbol_stack[-1].qualname

    def _current_symbol_id(self) -> str | None:
        if not self._symbol_stack:
            return None
        return self._symbol_stack[-1].symbol_id

    def _class_symbol_kind(self, node: ast.ClassDef) -> SymbolKind:
        if any(_is_enum_base(base) for base in node.bases):
            return SymbolKind.ENUM
        return SymbolKind.CLASS

    def _direct_parent_is_class_like(self) -> bool:
        return bool(
            self._symbol_stack
            and self._symbol_stack[-1].kind in {SymbolKind.CLASS, SymbolKind.ENUM}
        )

    def _span_for(self, node: ast.AST) -> SourceSpan:
        return _span_for_node(self.module.file_path, self.source, self.line_starts, node)

    def _record_direct_class_body_symbol(self, statement: ast.stmt) -> None:
        if isinstance(statement, ast.Assign):
            for name in _assignment_target_names(statement):
                self._make_symbol(name, SymbolKind.VARIABLE, statement)
            return
        if isinstance(statement, ast.AnnAssign) and isinstance(statement.target, ast.Name):
            self._make_symbol(statement.target.id, SymbolKind.VARIABLE, statement)


def _extract_call_path(node: ast.AST) -> tuple[str | None, tuple[str, ...]]:
    if isinstance(node, ast.Name):
        return node.id, ()
    if isinstance(node, ast.Attribute):
        parts: list[str] = []
        current: ast.AST = node
        while isinstance(current, ast.Attribute):
            parts.append(current.attr)
            current = current.value
        if isinstance(current, ast.Name):
            return current.id, tuple(reversed(parts))
    return None, ()


def _assignment_target_names(node: ast.Assign) -> list[str]:
    names: list[str] = []
    for target in node.targets:
        if isinstance(target, ast.Name):
            names.append(target.id)
    return names


def _is_enum_base(node: ast.AST) -> bool:
    dotted_name = _dotted_name(node)
    if dotted_name is None:
        return False
    return dotted_name.split(".")[-1] in {"Enum", "IntEnum", "StrEnum", "Flag", "IntFlag"}


def _dotted_name(node: ast.AST) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        root = _dotted_name(node.value)
        if root is None:
            return None
        return f"{root}.{node.attr}"
    return None


def _line_starts(source: str) -> list[int]:
    starts = [0]
    for index, character in enumerate(source):
        if character == "\n":
            starts.append(index + 1)
    return starts


def _offset_for_position(line_starts: list[int], line: int, column: int) -> int:
    line_index = max(line - 1, 0)
    if line_index >= len(line_starts):
        return line_starts[-1] if line_starts else 0
    return line_starts[line_index] + max(column, 0)


def _span_for_node(file_path: str, source: str, line_starts: list[int], node: ast.AST) -> SourceSpan:
    start_line = getattr(node, "lineno", 1)
    start_column = getattr(node, "col_offset", 0)
    end_line = getattr(node, "end_lineno", start_line)
    end_column = getattr(node, "end_col_offset", start_column)
    start_offset = _offset_for_position(line_starts, start_line, start_column)
    end_offset = _offset_for_position(line_starts, end_line, end_column)
    source_length = len(source)
    return SourceSpan(
        file_path=file_path,
        start_line=start_line,
        start_column=start_column,
        end_line=end_line,
        end_column=end_column,
        start_offset=min(start_offset, source_length),
        end_offset=min(end_offset, source_length),
    )


def _syntax_error_span(
    file_path: str,
    source: str,
    line_starts: list[int],
    exc: SyntaxError,
) -> SourceSpan | None:
    if exc.lineno is None or exc.offset is None:
        return None
    start_line = exc.lineno
    start_column = max(exc.offset - 1, 0)
    start_offset = _offset_for_position(line_starts, start_line, start_column)
    end_offset = min(start_offset + 1, len(source))
    return SourceSpan(
        file_path=file_path,
        start_line=start_line,
        start_column=start_column,
        end_line=start_line,
        end_column=start_column + 1,
        start_offset=start_offset,
        end_offset=end_offset,
    )


def _safe_unparse(node: ast.AST) -> str:
    try:
        return ast.unparse(node)
    except Exception:
        return node.__class__.__name__
