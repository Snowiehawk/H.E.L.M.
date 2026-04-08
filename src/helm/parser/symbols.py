"""Normalized parser IR shared across the repo scanner and graph builder."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class SymbolKind(str, Enum):
    CLASS = "class"
    ENUM = "enum"
    VARIABLE = "variable"
    FUNCTION = "function"
    METHOD = "method"
    ASYNC_FUNCTION = "async_function"
    ASYNC_METHOD = "async_method"


class ReferenceConfidence(str, Enum):
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


def make_module_id(module_name: str) -> str:
    return f"module:{module_name}"


def make_symbol_id(module_name: str, qualname: str) -> str:
    return f"symbol:{module_name}:{qualname}"


def make_import_id(module_name: str, local_name: str, line: int, column: int) -> str:
    return f"import:{module_name}:{local_name}:{line}:{column}"


def make_call_id(module_name: str, callee_expr: str, line: int, column: int) -> str:
    return f"call:{module_name}:{callee_expr}:{line}:{column}"


@dataclass(frozen=True)
class SourceSpan:
    """A source slice using 1-based lines and 0-based columns."""

    file_path: str
    start_line: int
    start_column: int
    end_line: int
    end_column: int
    start_offset: int
    end_offset: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "file_path": self.file_path,
            "start_line": self.start_line,
            "start_column": self.start_column,
            "end_line": self.end_line,
            "end_column": self.end_column,
            "start_offset": self.start_offset,
            "end_offset": self.end_offset,
        }


@dataclass(frozen=True)
class ModuleRef:
    module_id: str
    module_name: str
    file_path: str
    relative_path: str
    is_package: bool

    def to_dict(self) -> dict[str, Any]:
        return {
            "module_id": self.module_id,
            "module_name": self.module_name,
            "file_path": self.file_path,
            "relative_path": self.relative_path,
            "is_package": self.is_package,
        }


@dataclass(frozen=True)
class ImportRef:
    import_id: str
    module_id: str
    owner_symbol_id: str | None
    local_name: str
    imported_module: str | None
    imported_name: str | None
    alias: str | None
    level: int
    span: SourceSpan

    def to_dict(self) -> dict[str, Any]:
        return {
            "import_id": self.import_id,
            "module_id": self.module_id,
            "owner_symbol_id": self.owner_symbol_id,
            "local_name": self.local_name,
            "imported_module": self.imported_module,
            "imported_name": self.imported_name,
            "alias": self.alias,
            "level": self.level,
            "span": self.span.to_dict(),
        }


@dataclass(frozen=True)
class SymbolDef:
    symbol_id: str
    module_id: str
    qualname: str
    name: str
    kind: SymbolKind
    parent_symbol_id: str | None
    span: SourceSpan

    def to_dict(self) -> dict[str, Any]:
        return {
            "symbol_id": self.symbol_id,
            "module_id": self.module_id,
            "qualname": self.qualname,
            "name": self.name,
            "kind": self.kind.value,
            "parent_symbol_id": self.parent_symbol_id,
            "span": self.span.to_dict(),
        }


@dataclass(frozen=True)
class CallSite:
    call_id: str
    module_id: str
    owner_symbol_id: str | None
    callee_expr: str
    root_name: str | None
    attribute_path: tuple[str, ...]
    span: SourceSpan

    def to_dict(self) -> dict[str, Any]:
        return {
            "call_id": self.call_id,
            "module_id": self.module_id,
            "owner_symbol_id": self.owner_symbol_id,
            "callee_expr": self.callee_expr,
            "root_name": self.root_name,
            "attribute_path": list(self.attribute_path),
            "span": self.span.to_dict(),
        }


@dataclass(frozen=True)
class ParseDiagnostic:
    code: str
    message: str
    file_path: str
    severity: str = "error"
    line: int | None = None
    column: int | None = None
    span: SourceSpan | None = None

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "code": self.code,
            "message": self.message,
            "file_path": self.file_path,
            "severity": self.severity,
            "line": self.line,
            "column": self.column,
        }
        if self.span is not None:
            payload["span"] = self.span.to_dict()
        return payload


@dataclass(frozen=True)
class ParsedModule:
    module: ModuleRef
    symbols: tuple[SymbolDef, ...] = field(default_factory=tuple)
    imports: tuple[ImportRef, ...] = field(default_factory=tuple)
    calls: tuple[CallSite, ...] = field(default_factory=tuple)
    diagnostics: tuple[ParseDiagnostic, ...] = field(default_factory=tuple)

    def to_dict(self) -> dict[str, Any]:
        return {
            "module": self.module.to_dict(),
            "symbols": [symbol.to_dict() for symbol in self.symbols],
            "imports": [import_ref.to_dict() for import_ref in self.imports],
            "calls": [call.to_dict() for call in self.calls],
            "diagnostics": [diagnostic.to_dict() for diagnostic in self.diagnostics],
        }
