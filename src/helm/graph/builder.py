"""Transform parsed modules into the H.E.L.M. domain graph."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from helm.graph.models import (
    BuildReport,
    EdgeKind,
    GraphEdge,
    GraphNode,
    NodeKind,
    RepoGraph,
    UnresolvedCall,
    make_repo_id,
)
from helm.parser.symbols import ModuleRef, ParsedModule, ReferenceConfidence, SymbolDef


@dataclass(frozen=True)
class _Binding:
    kind: str
    target_module: str | None
    target_qualname: str | None
    required_prefix: tuple[str, ...] = ()


def build_repo_graph(root: Path | str, parsed_modules: list[ParsedModule] | tuple[ParsedModule, ...]) -> RepoGraph:
    root_path = str(Path(root).resolve())
    repo_id = make_repo_id(root_path)
    node_map: dict[str, GraphNode] = {}
    edge_map: dict[str, GraphEdge] = {}
    unresolved_calls: list[UnresolvedCall] = []
    diagnostics = tuple(
        diagnostic
        for parsed_module in parsed_modules
        for diagnostic in parsed_module.diagnostics
    )

    repo_node = GraphNode(
        node_id=repo_id,
        kind=NodeKind.REPO,
        name=Path(root_path).name or root_path,
        display_name=root_path,
        file_path=root_path,
    )
    node_map[repo_id] = repo_node

    modules_by_name = {parsed.module.module_name: parsed for parsed in parsed_modules}
    module_name_set = set(modules_by_name)
    symbol_defs: dict[str, SymbolDef] = {
        symbol.symbol_id: symbol
        for parsed in parsed_modules
        for symbol in parsed.symbols
    }
    symbol_lookup = _build_symbol_lookup(parsed_modules)
    top_level_symbols = _build_top_level_symbol_lookup(parsed_modules)
    imports_by_scope = _build_import_bindings(parsed_modules, module_name_set)

    for parsed_module in parsed_modules:
        module = parsed_module.module
        node_map[module.module_id] = GraphNode(
            node_id=module.module_id,
            kind=NodeKind.MODULE,
            name=module.module_name,
            display_name=module.relative_path,
            file_path=module.file_path,
            module_name=module.module_name,
            metadata={"relative_path": module.relative_path, "is_package": module.is_package},
        )
        _add_edge(
            edge_map,
            GraphEdge(
                edge_id=f"{EdgeKind.CONTAINS.value}:{repo_id}->{module.module_id}",
                kind=EdgeKind.CONTAINS,
                source_id=repo_id,
                target_id=module.module_id,
            ),
        )

    for parsed_module in parsed_modules:
        module = parsed_module.module
        for symbol in parsed_module.symbols:
            node_map[symbol.symbol_id] = GraphNode(
                node_id=symbol.symbol_id,
                kind=NodeKind.SYMBOL,
                name=symbol.name,
                display_name=symbol.qualname,
                file_path=module.file_path,
                module_name=module.module_name,
                qualname=symbol.qualname,
                span=symbol.span,
                metadata={"symbol_kind": symbol.kind.value},
            )
            if symbol.parent_symbol_id is not None:
                source_id = symbol.parent_symbol_id
                edge_kind = EdgeKind.CONTAINS
            else:
                source_id = module.module_id
                edge_kind = EdgeKind.DEFINES
            _add_edge(
                edge_map,
                GraphEdge(
                    edge_id=f"{edge_kind.value}:{source_id}->{symbol.symbol_id}",
                    kind=edge_kind,
                    source_id=source_id,
                    target_id=symbol.symbol_id,
                ),
            )

        for import_ref in parsed_module.imports:
            binding = imports_by_scope[module.module_id][import_ref.owner_symbol_id][
                import_ref.local_name
            ]
            dependency_module = binding.target_module
            if dependency_module is None:
                continue
            target_node = _ensure_module_node(
                dependency_module,
                modules_by_name,
                node_map,
            )
            source_id = import_ref.owner_symbol_id or module.module_id
            _add_edge(
                edge_map,
                GraphEdge(
                    edge_id=(
                        f"{EdgeKind.IMPORTS.value}:{source_id}->{target_node.node_id}:"
                        f"{import_ref.local_name}:{import_ref.span.start_line}:{import_ref.span.start_column}"
                    ),
                    kind=EdgeKind.IMPORTS,
                    source_id=source_id,
                    target_id=target_node.node_id,
                    metadata={
                        "local_name": import_ref.local_name,
                        "imported_name": import_ref.imported_name,
                        "level": import_ref.level,
                    },
                ),
            )

        symbol_parent_map = {
            symbol.symbol_id: symbol.parent_symbol_id for symbol in parsed_module.symbols
        }
        for call in parsed_module.calls:
            source_id = call.owner_symbol_id or module.module_id
            resolution = _resolve_call(
                parsed_module,
                call,
                imports_by_scope[module.module_id],
                symbol_defs,
                symbol_lookup,
                top_level_symbols,
                symbol_parent_map,
                module_name_set,
            )
            if resolution is None:
                unresolved_calls.append(
                    UnresolvedCall(
                        call_id=call.call_id,
                        source_id=source_id,
                        module_id=call.module_id,
                        owner_symbol_id=call.owner_symbol_id,
                        callee_expr=call.callee_expr,
                        reason="Unable to resolve callee conservatively.",
                        span=call.span,
                    )
                )
                continue

            target_symbol_id, confidence, reason = resolution
            if target_symbol_id is None:
                unresolved_calls.append(
                    UnresolvedCall(
                        call_id=call.call_id,
                        source_id=source_id,
                        module_id=call.module_id,
                        owner_symbol_id=call.owner_symbol_id,
                        callee_expr=call.callee_expr,
                        reason=reason,
                        span=call.span,
                    )
                )
                continue

            _add_edge(
                edge_map,
                GraphEdge(
                    edge_id=f"{EdgeKind.CALLS.value}:{source_id}->{target_symbol_id}:{call.call_id}",
                    kind=EdgeKind.CALLS,
                    source_id=source_id,
                    target_id=target_symbol_id,
                    metadata={
                        "callee_expr": call.callee_expr,
                        "confidence": confidence.value,
                    },
                ),
            )

    edges = tuple(sorted(edge_map.values(), key=lambda edge: edge.edge_id))
    report = BuildReport(
        module_count=len(parsed_modules),
        symbol_count=len(symbol_defs),
        import_edge_count=sum(1 for edge in edges if edge.kind == EdgeKind.IMPORTS),
        call_edge_count=sum(1 for edge in edges if edge.kind == EdgeKind.CALLS),
        unresolved_call_count=len(unresolved_calls),
        diagnostic_count=len(diagnostics),
    )
    return RepoGraph(
        root_path=root_path,
        repo_id=repo_id,
        nodes=node_map,
        edges=edges,
        diagnostics=diagnostics,
        unresolved_calls=tuple(unresolved_calls),
        report=report,
    )


def _build_symbol_lookup(
    parsed_modules: list[ParsedModule] | tuple[ParsedModule, ...]
) -> dict[str, dict[str, SymbolDef]]:
    lookup: dict[str, dict[str, SymbolDef]] = {}
    for parsed in parsed_modules:
        lookup[parsed.module.module_name] = {
            symbol.qualname: symbol for symbol in parsed.symbols
        }
    return lookup


def _build_top_level_symbol_lookup(
    parsed_modules: list[ParsedModule] | tuple[ParsedModule, ...]
) -> dict[str, dict[str, SymbolDef]]:
    lookup: dict[str, dict[str, SymbolDef]] = {}
    for parsed in parsed_modules:
        lookup[parsed.module.module_name] = {
            symbol.name: symbol for symbol in parsed.symbols if symbol.parent_symbol_id is None
        }
    return lookup


def _build_import_bindings(
    parsed_modules: list[ParsedModule] | tuple[ParsedModule, ...],
    module_name_set: set[str],
) -> dict[str, dict[str | None, dict[str, _Binding]]]:
    bindings: dict[str, dict[str | None, dict[str, _Binding]]] = {}
    for parsed in parsed_modules:
        module_bindings: dict[str | None, dict[str, _Binding]] = {None: {}}
        for symbol in parsed.symbols:
            module_bindings.setdefault(symbol.symbol_id, {})
        for import_ref in parsed.imports:
            scope_id = import_ref.owner_symbol_id
            module_bindings.setdefault(scope_id, {})
            module_bindings[scope_id][import_ref.local_name] = _binding_for_import(
                parsed.module,
                import_ref,
                module_name_set,
            )
        bindings[parsed.module.module_id] = module_bindings
    return bindings


def _binding_for_import(module: ModuleRef, import_ref, module_name_set: set[str]) -> _Binding:
    if import_ref.imported_name is None:
        imported_module = import_ref.imported_module
        if imported_module is None:
            return _Binding(kind="unknown", target_module=None, target_qualname=None)
        if import_ref.alias:
            return _Binding(
                kind="module",
                target_module=imported_module,
                target_qualname=None,
                required_prefix=(),
            )
        module_parts = imported_module.split(".")
        local_name = import_ref.local_name
        try:
            local_index = module_parts.index(local_name)
        except ValueError:
            local_index = 0
        return _Binding(
            kind="module",
            target_module=imported_module,
            target_qualname=None,
            required_prefix=tuple(module_parts[local_index + 1 :]),
        )

    base_module = _resolve_relative_module(module, import_ref.imported_module, import_ref.level)
    if not base_module and import_ref.imported_module:
        base_module = import_ref.imported_module
    if not base_module and import_ref.imported_name:
        base_module = import_ref.imported_name

    candidate_module = (
        f"{base_module}.{import_ref.imported_name}" if base_module else import_ref.imported_name
    )
    if candidate_module and candidate_module in module_name_set:
        return _Binding(
            kind="module",
            target_module=candidate_module,
            target_qualname=None,
            required_prefix=(),
        )

    return _Binding(
        kind="symbol",
        target_module=base_module,
        target_qualname=import_ref.imported_name,
        required_prefix=(),
    )


def _resolve_relative_module(
    module: ModuleRef,
    imported_module: str | None,
    level: int,
) -> str | None:
    if level == 0:
        return imported_module

    container = module.module_name if module.is_package else module.module_name.rpartition(".")[0]
    parts = container.split(".") if container else []
    up_levels = max(level - 1, 0)
    if up_levels > len(parts):
        base_parts: list[str] = []
    elif up_levels == 0:
        base_parts = parts
    else:
        base_parts = parts[:-up_levels]

    if imported_module:
        return ".".join([*base_parts, *imported_module.split(".")]).strip(".") or None
    return ".".join(base_parts).strip(".") or None


def _ensure_module_node(
    module_name: str,
    modules_by_name: dict[str, ParsedModule],
    node_map: dict[str, GraphNode],
) -> GraphNode:
    parsed_module = modules_by_name.get(module_name)
    if parsed_module is not None:
        return node_map[parsed_module.module.module_id]

    external_node_id = f"module:{module_name}"
    if external_node_id not in node_map:
        node_map[external_node_id] = GraphNode(
            node_id=external_node_id,
            kind=NodeKind.MODULE,
            name=module_name,
            display_name=module_name,
            module_name=module_name,
            is_external=True,
        )
    return node_map[external_node_id]


def _resolve_call(
    parsed_module: ParsedModule,
    call,
    scoped_bindings: dict[str | None, dict[str, _Binding]],
    symbol_defs: dict[str, SymbolDef],
    symbol_lookup: dict[str, dict[str, SymbolDef]],
    top_level_symbols: dict[str, dict[str, SymbolDef]],
    symbol_parent_map: dict[str, str | None],
    module_name_set: set[str],
) -> tuple[str | None, ReferenceConfidence, str] | None:
    if call.root_name is None:
        return None

    module_name = parsed_module.module.module_name
    symbol_chain = _scope_chain(call.owner_symbol_id, symbol_parent_map)
    binding = None
    for scope_id in symbol_chain:
        binding = scoped_bindings.get(scope_id, {}).get(call.root_name)
        if binding is not None:
            break

    if binding is not None:
        if binding.kind == "symbol":
            if call.attribute_path:
                return None, ReferenceConfidence.LOW, "Imported symbol is used as an object."
            if not binding.target_module or not binding.target_qualname:
                return None, ReferenceConfidence.LOW, "Imported symbol target is incomplete."
            target = symbol_lookup.get(binding.target_module, {}).get(binding.target_qualname)
            if target is None:
                return None, ReferenceConfidence.LOW, "Imported symbol is outside the scanned repo."
            return target.symbol_id, ReferenceConfidence.HIGH, ""

        if binding.kind == "module":
            return _resolve_module_binding_call(
                binding,
                call.attribute_path,
                symbol_lookup,
                module_name_set,
            )

    if call.root_name in {"self", "cls"} and call.attribute_path and call.owner_symbol_id:
        class_symbol = _nearest_class_symbol(call.owner_symbol_id, symbol_defs)
        if class_symbol is not None:
            candidate_qualname = ".".join((class_symbol.qualname, *call.attribute_path))
            candidate = symbol_lookup.get(module_name, {}).get(candidate_qualname)
            if candidate is not None:
                return candidate.symbol_id, ReferenceConfidence.MEDIUM, ""

    top_level = top_level_symbols.get(module_name, {}).get(call.root_name)
    if top_level is not None:
        if not call.attribute_path:
            return top_level.symbol_id, ReferenceConfidence.LOW, ""
        candidate_qualname = ".".join((top_level.qualname, *call.attribute_path))
        candidate = symbol_lookup.get(module_name, {}).get(candidate_qualname)
        if candidate is not None:
            return candidate.symbol_id, ReferenceConfidence.MEDIUM, ""

    return None, ReferenceConfidence.LOW, "No conservative resolution rule matched."


def _resolve_module_binding_call(
    binding: _Binding,
    attribute_path: tuple[str, ...],
    symbol_lookup: dict[str, dict[str, SymbolDef]],
    module_name_set: set[str],
) -> tuple[str | None, ReferenceConfidence, str]:
    if binding.target_module is None:
        return None, ReferenceConfidence.LOW, "Imported module target is incomplete."

    if not attribute_path and not binding.required_prefix:
        return None, ReferenceConfidence.LOW, "Module references are not directly callable."

    if binding.required_prefix:
        if attribute_path[: len(binding.required_prefix)] != binding.required_prefix:
            return None, ReferenceConfidence.LOW, "Call path does not match imported module prefix."
        remaining_path = attribute_path[len(binding.required_prefix) :]
    else:
        remaining_path = attribute_path

    target_module = binding.target_module
    symbol_parts = list(remaining_path)
    for index in range(len(remaining_path), 0, -1):
        candidate_module = ".".join((binding.target_module, *remaining_path[:index]))
        if candidate_module in module_name_set:
            target_module = candidate_module
            symbol_parts = list(remaining_path[index:])
            break

    if not symbol_parts:
        return None, ReferenceConfidence.LOW, "Module references are not directly callable."

    candidate_qualname = ".".join(symbol_parts)
    target = symbol_lookup.get(target_module, {}).get(candidate_qualname)
    if target is None:
        return None, ReferenceConfidence.LOW, "Target symbol was not found in the scanned repo."
    return target.symbol_id, ReferenceConfidence.HIGH, ""


def _nearest_class_symbol(symbol_id: str, symbol_defs: dict[str, SymbolDef]) -> SymbolDef | None:
    current_id = symbol_id
    while current_id is not None:
        symbol = symbol_defs[current_id]
        if symbol.kind.value == "class":
            return symbol
        current_id = symbol.parent_symbol_id
    return None


def _scope_chain(
    owner_symbol_id: str | None,
    symbol_parent_map: dict[str, str | None],
) -> list[str | None]:
    chain: list[str | None] = []
    current = owner_symbol_id
    while current is not None:
        chain.append(current)
        current = symbol_parent_map.get(current)
    chain.append(None)
    return chain


def _add_edge(edge_map: dict[str, GraphEdge], edge: GraphEdge) -> None:
    edge_map.setdefault(edge.edge_id, edge)
