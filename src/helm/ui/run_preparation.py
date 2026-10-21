"""Passive, bounded source proof for an explicitly requested project run.

This module reads source; it never imports a project module, runs hooks, compiles
new source, or repairs recovery records. Native execution revalidates its hashes.
"""

from __future__ import annotations

import ast
import hashlib
import json
import os
from pathlib import Path
from typing import Any

from helm.editor.flow_model import (
    FLOW_MODEL_RELATIVE_PATH,
    FLOW_MODEL_VERSION,
    compile_flow_document,
    flow_document_from_payload,
    function_source_for_qualname,
    function_source_hash,
)
from helm.parser import ModuleRef, PythonModuleParser, make_module_id
from helm.parser.repo_loader import (
    _GitIgnoreRule,
    _is_gitignored,
    _module_name_from_relative_path,
)
from helm.ui.workspace_file_constants import IGNORED_DIRECTORY_NAMES

MAX_SOURCE_FILES = 5000
MAX_SOURCE_BYTES = 64 * 1024 * 1024
MAX_FILE_BYTES = 8 * 1024 * 1024
MAX_INVENTORY_ENTRIES = 50000


def prepare_run_source(repo: str | Path) -> dict[str, Any]:
    """Freeze contained regular files and reject known unsynchronized flows.

    The file inventory excludes the explorer's dependency/build/control folders,
    plus HELM's own development environment. It includes arbitrary-language source
    and configuration files. Symlinks are refused rather than silently omitting
    executable content. The flow store itself is always part of the proof.
    """
    root = Path(repo).resolve(strict=True)
    if not root.is_dir():
        raise ValueError("Run preparation requires a repository directory.")
    _require_recovery_clear(root)
    files: dict[str, bytes] = {}
    total_bytes = 0
    for child in _inventory_paths(root):
        relative = child.relative_to(root).as_posix()
        raw = _read_source_file(root, child)
        total_bytes += len(raw)
        if len(files) >= MAX_SOURCE_FILES or total_bytes > MAX_SOURCE_BYTES:
            raise ValueError(
                "Run source exceeds the 5000 file / 64 MiB verification limit. Use a smaller checkout."
            )
        files[relative] = raw

    flow_path = root / FLOW_MODEL_RELATIVE_PATH
    if flow_path.exists() or flow_path.is_symlink():
        if (root / ".helm").is_symlink():
            raise ValueError("Run preparation refuses a symlinked .helm directory.")
        flow_bytes = _read_source_file(root, flow_path)
        if len(files) >= MAX_SOURCE_FILES or total_bytes + len(flow_bytes) > MAX_SOURCE_BYTES:
            raise ValueError(
                "Run source exceeds the 5000 file / 64 MiB verification limit. Use a smaller checkout."
            )
        files[FLOW_MODEL_RELATIVE_PATH] = flow_bytes
        _validate_flows(root, files)

    indexed_symbols: list[dict[str, Any]] = []
    parser = PythonModuleParser()
    for module in _module_refs_from_inventory(root, files):
        raw = files[module.relative_path]
        try:
            source = raw.decode("utf-8")
        except UnicodeDecodeError:
            # Match parse_module's unsupported-encoding behavior: freeze the
            # source but publish no unsupported graph mapping for this file.
            continue
        # Path.read_text used universal newlines before this bounded source seam.
        source = source.replace("\r\n", "\n").replace("\r", "\n")
        parsed = parser.parse_source(module, source)
        if _read_source_file(root, root / module.relative_path) != raw:
            raise ValueError(f"Source changed while preparing: {module.relative_path}. Retry Run.")
        source_hash = _sha256(raw)
        for symbol in parsed.symbols:
            indexed_symbols.append(
                {
                    "nodeId": symbol.symbol_id,
                    "relativePath": module.relative_path,
                    "sourceHash": source_hash,
                    "startLine": symbol.span.start_line,
                    "startColumn": symbol.span.start_column,
                    "endLine": symbol.span.end_line,
                    "endColumn": symbol.span.end_column,
                }
            )

    # No known old source may be admitted while a writer raced the snapshot.
    for relative, raw in files.items():
        if _read_source_file(root, root / relative) != raw:
            raise ValueError(f"Source changed while preparing: {relative}. Retry Run.")
    current_paths = {path.relative_to(root).as_posix() for path in _inventory_paths(root)}
    if flow_path.exists() or flow_path.is_symlink():
        current_paths.add(FLOW_MODEL_RELATIVE_PATH)
    if current_paths != set(files):
        raise ValueError("Run source inventory changed while preparing. Retry Run.")
    _require_recovery_clear(root)
    return {
        "repoPath": root.as_posix(),
        "files": [
            {"relativePath": relative, "sha256": _sha256(raw)}
            for relative, raw in sorted(files.items())
        ],
        "indexedSymbols": indexed_symbols,
    }


def _require_recovery_clear(root: Path) -> None:
    for metadata in (root / ".helm", root / ".helm/recovery", root / ".helm/recovery/journals"):
        if metadata.is_symlink():
            raise ValueError("Run preparation refuses symlinked HELM metadata.")
    journals = root / ".helm/recovery/journals"
    if journals.exists() and any(journals.glob("*.json")):
        raise ValueError(
            "Run blocked: a recovery journal is pending. Reopen or reconcile the workspace first."
        )


def _module_refs_from_inventory(root: Path, files: dict[str, bytes]) -> list[ModuleRef]:
    # Never run a second discovery walk: it has different exclusions and can
    # inspect unbounded ignored trees. Preserve the IDE's module IDs and ignore
    # decisions using only files already admitted by the bounded snapshot.
    rules_by_directory: dict[Path, tuple[_GitIgnoreRule, ...] | None] = {
        root: _frozen_gitignore_rules(root, root, files),
    }
    modules = []
    for relative in sorted(files):
        path = Path(relative)
        if path.suffix != ".py":
            continue
        directory = root
        active_rules = rules_by_directory[root]
        for part in path.parts[:-1]:
            child = directory / part
            if child not in rules_by_directory:
                rules_by_directory[child] = (
                    None
                    if active_rules is None
                    or _is_gitignored(child, is_dir=True, rules=active_rules)
                    else (*active_rules, *_frozen_gitignore_rules(root, child, files))
                )
            directory = child
            active_rules = rules_by_directory[child]
            if active_rules is None:
                break
        if active_rules is None or _is_gitignored(root / path, is_dir=False, rules=active_rules):
            continue
        module_name, is_package = _module_name_from_relative_path(path)
        modules.append(
            ModuleRef(
                module_id=make_module_id(module_name),
                module_name=module_name,
                file_path=str(root / path),
                relative_path=relative,
                is_package=is_package,
            )
        )
    return modules


def _frozen_gitignore_rules(
    root: Path, directory: Path, files: dict[str, bytes]
) -> tuple[_GitIgnoreRule, ...]:
    relative = (directory.relative_to(root) / ".gitignore").as_posix()
    raw = files.get(relative)
    if raw is None:
        return ()
    rules = []
    # Keep repo_loader's rule interpretation, without reopening a file whose
    # current size/content may differ from the bounded bytes above.
    for raw_line in raw.decode("utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        negated = line.startswith("!")
        if negated:
            line = line[1:].strip()
        if not line:
            continue
        directory_only = line.endswith("/")
        pattern = line.lstrip("/").rstrip("/")
        if pattern:
            rules.append(
                _GitIgnoreRule(directory, pattern, negated, directory_only, "/" not in pattern)
            )
    return tuple(rules)


def _inventory_paths(root: Path) -> list[Path]:
    def failed_walk(_error: OSError) -> None:
        raise ValueError("Run source inventory could not be read. Retry Run.")

    files: list[Path] = []
    visited = 0
    for directory, dirnames, filenames in os.walk(root, followlinks=False, onerror=failed_walk):
        visited += len(dirnames) + len(filenames)
        if visited > MAX_INVENTORY_ENTRIES:
            raise ValueError("Run source inventory exceeds the verification entry limit.")
        parent = Path(directory)
        kept_directories = []
        for name in sorted(dirnames):
            if name in IGNORED_DIRECTORY_NAMES or name in {".venv-helm-dev", "target"}:
                continue
            child = parent / name
            if child.is_symlink():
                raise ValueError(
                    f"Run preparation cannot verify symlink directory: {child.relative_to(root)}"
                )
            kept_directories.append(name)
        dirnames[:] = kept_directories
        for name in sorted(filenames):
            child = parent / name
            if child.is_symlink():
                raise ValueError(
                    f"Run preparation cannot verify symlink file: {child.relative_to(root)}"
                )
            if not child.is_file():
                raise ValueError(
                    f"Run preparation requires regular files: {child.relative_to(root)}"
                )
            files.append(child)
            if len(files) > MAX_SOURCE_FILES:
                raise ValueError("Run source exceeds the 5000 file verification limit.")
    return files


def _read_source_file(root: Path, path: Path) -> bytes:
    if path.is_symlink():
        raise ValueError(f"Run preparation cannot verify symlink file: {path.relative_to(root)}")
    path.resolve(strict=True).relative_to(root)
    if not path.is_file():
        raise ValueError(f"Run preparation requires regular files: {path.relative_to(root)}")
    if path.stat().st_size > MAX_FILE_BYTES:
        raise ValueError(f"Run source file exceeds 8 MiB: {path.relative_to(root)}")
    with path.open("rb") as stream:
        raw = stream.read(MAX_FILE_BYTES + 1)
    if len(raw) > MAX_FILE_BYTES:
        raise ValueError(f"Run source file exceeds 8 MiB: {path.relative_to(root)}")
    return raw


def _sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _validate_flows(root: Path, files: dict[str, bytes]) -> None:
    try:
        store = json.loads(files[FLOW_MODEL_RELATIVE_PATH])
    except (ValueError, UnicodeDecodeError) as exc:
        raise ValueError(
            "Run blocked: the flow store cannot be decoded. Reconcile it in the IDE."
        ) from exc
    if (
        not isinstance(store, dict)
        or store.get("version") != FLOW_MODEL_VERSION
        or not isinstance(store.get("symbols"), dict)
    ):
        raise ValueError("Run blocked: unsupported or invalid flow store. Reconcile it in the IDE.")
    for symbol_id, payload in store["symbols"].items():
        if not isinstance(payload, dict) or payload.get("sync_state") != "clean":
            raise ValueError(
                f"Run blocked: flow {symbol_id} is not synchronized. Finish its draft in the flow editor."
            )
        document = flow_document_from_payload(payload)
        if document.symbol_id != symbol_id or not document.source_hash:
            raise ValueError(f"Run blocked: flow {symbol_id} has no matching source proof.")
        source_bytes = files.get(document.relative_path)
        if source_bytes is None:
            raise ValueError(f"Run blocked: flow source is unavailable: {document.relative_path}.")
        try:
            current_function = function_source_for_qualname(
                source_bytes.decode("utf-8"), document.qualname
            )
        except (ValueError, SyntaxError, UnicodeDecodeError) as exc:
            raise ValueError(
                f"Run blocked: flow source cannot be reconciled: {document.relative_path}."
            ) from exc
        if function_source_hash(current_function) != document.source_hash:
            raise ValueError(
                f"Run blocked: flow source changed: {document.relative_path}. Reconcile it in the IDE."
            )
        compiled = compile_flow_document(document)
        if compiled.sync_state != "clean" or compiled.body_source is None:
            raise ValueError(
                f"Run blocked: flow {symbol_id} does not compile cleanly. Finish it in the flow editor."
            )
        function_node = ast.parse(current_function).body[0]
        current_body = ast.Module(body=function_node.body, type_ignores=[])
        if ast.dump(current_body) != ast.dump(ast.parse(compiled.body_source)):
            raise ValueError(
                f"Run blocked: flow {symbol_id} differs from its generated source. Reconcile it in the IDE."
            )
