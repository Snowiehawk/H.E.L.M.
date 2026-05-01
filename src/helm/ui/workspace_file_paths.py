"""Path validation and guardrails for desktop workspace file operations."""

from __future__ import annotations

from pathlib import Path, PurePosixPath
from typing import Any

from helm.ui.workspace_file_constants import (
    PROTECTED_WORKSPACE_DIRECTORY_NAMES,
    VCS_CONTROL_DIRECTORY_NAMES,
)


def _validated_root(root: str | Path) -> Path:
    root_path = Path(root).resolve()
    if not root_path.exists():
        raise ValueError(f"Repository root does not exist: {root_path}")
    if not root_path.is_dir():
        raise ValueError(f"Repository root is not a directory: {root_path}")
    return root_path


def _validated_repo_relative_path(relative_path: str) -> str:
    raw = relative_path.strip().replace("\\", "/")
    if not raw or raw == ".":
        raise ValueError("Repo-relative path cannot be empty.")
    if "//" in raw:
        raise ValueError("Repo-relative paths must not contain empty segments.")

    path = PurePosixPath(raw)
    if path.is_absolute():
        raise ValueError("Repo-relative paths must be relative to the repo root.")
    if any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError("Repo-relative paths must not contain empty, '.', or '..' segments.")
    return path.as_posix()


def _validated_repo_directory_path(relative_path: str) -> str:
    raw = relative_path.strip().replace("\\", "/")
    if not raw:
        return ""
    return _validated_repo_relative_path(raw)


def _reject_protected_workspace_mutation_path(relative_path: str, operation: str) -> None:
    normalized = _validated_repo_relative_path(relative_path)
    parts = PurePosixPath(normalized).parts
    if not parts:
        raise ValueError(f"Cannot {operation} the repository root.")
    if parts[0] in PROTECTED_WORKSPACE_DIRECTORY_NAMES:
        raise ValueError(
            f"Cannot {operation} protected workspace metadata or VCS directory '{parts[0]}'."
        )
    if any(
        parts[index] == ".helm" and index + 1 < len(parts) and parts[index + 1] == "recovery"
        for index in range(len(parts))
    ):
        raise ValueError("Cannot mutate HELM recovery storage from workspace operations.")


def _reject_protected_recursive_manifest_paths(
    manifest_entries: list[dict[str, Any]], operation: str
) -> None:
    for entry in manifest_entries:
        relative_path = str(entry.get("relative_path") or "")
        if not relative_path:
            continue
        parts = PurePosixPath(relative_path).parts
        for protected_name in VCS_CONTROL_DIRECTORY_NAMES:
            if protected_name in parts:
                raise ValueError(
                    f"Cannot {operation} recursive workspace trees containing "
                    f"VCS control directory '{protected_name}': {relative_path}"
                )
        if any(
            parts[index] == ".helm" and index + 1 < len(parts) and parts[index + 1] == "recovery"
            for index in range(len(parts))
        ):
            raise ValueError(
                "Cannot mutate HELM recovery storage from recursive workspace operations: "
                f"{relative_path}"
            )


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


def _reject_symlinked_directory_source(
    root_path: Path,
    relative_path: str,
    operation: str,
) -> None:
    lexical_path = root_path / _validated_repo_relative_path(relative_path)
    if lexical_path.is_symlink() and lexical_path.is_dir():
        raise ValueError(
            f"Cannot {operation} symlinked workspace folders until safe recovery is supported."
        )


def _reject_symlinked_directories_in_tree(path: Path, relative_path: str) -> None:
    for child in path.rglob("*"):
        if child.is_symlink() and child.is_dir():
            child_relative = child.relative_to(path).as_posix()
            raise ValueError(
                "Destructive symlinked directory operations are not supported: "
                f"{relative_path}/{child_relative}"
            )


def _is_path_at_or_below(path: Path, ancestor: Path) -> bool:
    try:
        path.relative_to(ancestor)
    except ValueError:
        return False
    return True
