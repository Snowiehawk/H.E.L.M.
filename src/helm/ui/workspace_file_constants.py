"""Shared constants for desktop workspace file operations."""

from __future__ import annotations

MAX_INLINE_TEXT_BYTES = 2 * 1024 * 1024
TEXT_PROBE_BYTES = 8192
IGNORED_DIRECTORY_NAMES = {
    ".cache",
    ".git",
    ".hg",
    ".helm",
    ".mypy_cache",
    ".nox",
    ".next",
    ".parcel-cache",
    ".pytest_cache",
    ".ruff_cache",
    ".svn",
    ".turbo",
    ".tox",
    ".venv",
    "__pycache__",
    "build",
    "coverage",
    "dist",
    "env",
    "node_modules",
    "vendor",
    "venv",
}
VCS_CONTROL_DIRECTORY_NAMES = {".git", ".hg", ".svn"}
PROTECTED_WORKSPACE_DIRECTORY_NAMES = {*VCS_CONTROL_DIRECTORY_NAMES, ".helm"}
RECURSIVE_WARNING_ENTRY_THRESHOLD = 500
RECURSIVE_WARNING_SIZE_BYTES = 50 * 1024 * 1024
MAX_AFFECTED_PATHS_SUMMARY = 40
