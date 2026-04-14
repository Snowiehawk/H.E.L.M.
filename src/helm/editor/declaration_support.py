"""Shared declaration edit support rules for inline source editing."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Optional

from helm.parser.symbols import SymbolDef, SymbolKind


@dataclass(frozen=True)
class DeclarationEditSupport:
    editable: bool
    reason: str | None = None


SymbolLookup = Callable[[str], Optional[SymbolDef]]


def resolve_declaration_edit_support(
    symbol: SymbolDef,
    *,
    lookup_symbol: SymbolLookup,
) -> DeclarationEditSupport:
    if symbol.kind == SymbolKind.ENUM:
        return DeclarationEditSupport(
            editable=False,
            reason="Enum declarations are not inline editable yet.",
        )

    if symbol.kind in {SymbolKind.FUNCTION, SymbolKind.ASYNC_FUNCTION}:
        return DeclarationEditSupport(editable=True)

    if symbol.kind == SymbolKind.CLASS:
        return DeclarationEditSupport(editable=True)

    if symbol.kind in {SymbolKind.METHOD, SymbolKind.ASYNC_METHOD}:
        parent_symbol = _parent_symbol(symbol, lookup_symbol)
        if parent_symbol is None:
            return DeclarationEditSupport(
                editable=False,
                reason="Methods without a class owner are not inline editable.",
            )
        if parent_symbol.kind == SymbolKind.ENUM:
            return DeclarationEditSupport(
                editable=False,
                reason="Methods inside enum declarations are not inline editable yet.",
            )
        if parent_symbol.kind != SymbolKind.CLASS:
            return DeclarationEditSupport(
                editable=False,
                reason="Only class methods are inline editable.",
            )
        return DeclarationEditSupport(editable=True)

    if symbol.kind == SymbolKind.VARIABLE:
        parent_symbol = _parent_symbol(symbol, lookup_symbol)
        if parent_symbol is None:
            return DeclarationEditSupport(editable=True)
        if parent_symbol.kind == SymbolKind.CLASS:
            return DeclarationEditSupport(
                editable=False,
                reason="Class attribute declarations are not inline editable yet.",
            )
        if parent_symbol.kind == SymbolKind.ENUM:
            return DeclarationEditSupport(
                editable=False,
                reason="Enum members are not inline editable yet.",
            )
        return DeclarationEditSupport(
            editable=False,
            reason="Nested variable declarations are not inline editable yet.",
        )

    return DeclarationEditSupport(
        editable=False,
        reason="This declaration is not inline editable yet.",
    )


def require_editable_declaration_support(
    symbol: SymbolDef,
    *,
    lookup_symbol: SymbolLookup,
) -> DeclarationEditSupport:
    support = resolve_declaration_edit_support(symbol, lookup_symbol=lookup_symbol)
    if not support.editable:
        raise ValueError(support.reason or "This declaration is not inline editable yet.")
    return support


def _parent_symbol(
    symbol: SymbolDef,
    lookup_symbol: SymbolLookup,
) -> SymbolDef | None:
    if symbol.parent_symbol_id is None:
        return None
    return lookup_symbol(symbol.parent_symbol_id)
