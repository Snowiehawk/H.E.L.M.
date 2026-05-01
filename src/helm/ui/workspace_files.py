"""Public façade for repo-scoped desktop workspace file operations."""

from __future__ import annotations

from helm.ui.workspace_file_constants import (
    IGNORED_DIRECTORY_NAMES,
    MAX_AFFECTED_PATHS_SUMMARY,
    MAX_INLINE_TEXT_BYTES,
    PROTECTED_WORKSPACE_DIRECTORY_NAMES,
    RECURSIVE_WARNING_ENTRY_THRESHOLD,
    RECURSIVE_WARNING_SIZE_BYTES,
    TEXT_PROBE_BYTES,
    VCS_CONTROL_DIRECTORY_NAMES,
)
from helm.ui.workspace_file_listing import list_workspace_files, read_workspace_file
from helm.ui.workspace_file_mutations import (
    create_workspace_entry,
    delete_workspace_entry,
    move_workspace_entry,
    save_workspace_file,
)
from helm.ui.workspace_file_previews import preview_workspace_file_operation

__all__ = [
    "IGNORED_DIRECTORY_NAMES",
    "MAX_AFFECTED_PATHS_SUMMARY",
    "MAX_INLINE_TEXT_BYTES",
    "PROTECTED_WORKSPACE_DIRECTORY_NAMES",
    "RECURSIVE_WARNING_ENTRY_THRESHOLD",
    "RECURSIVE_WARNING_SIZE_BYTES",
    "TEXT_PROBE_BYTES",
    "VCS_CONTROL_DIRECTORY_NAMES",
    "create_workspace_entry",
    "delete_workspace_entry",
    "list_workspace_files",
    "move_workspace_entry",
    "preview_workspace_file_operation",
    "read_workspace_file",
    "save_workspace_file",
]
