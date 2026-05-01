from __future__ import annotations

from pathlib import Path


TAURI_SRC = Path("apps/desktop/src-tauri/src")

EXTRACTED_MODULES = {
    "app_menu.rs",
    "atomic_file.rs",
    "bridge.rs",
    "commands.rs",
    "events.rs",
    "graph_layout_storage.rs",
    "project_scaffold.rs",
    "repo_boundary.rs",
    "repo_file_actions.rs",
    "watcher.rs",
}


def _source(repo_root: Path, module_name: str) -> str:
    return (repo_root / TAURI_SRC / module_name).read_text(encoding="utf-8")


def test_tauri_modules_do_not_import_main_or_forbidden_siblings() -> None:
    repo_root = Path(__file__).resolve().parents[1]

    for module_name in EXTRACTED_MODULES:
        source = _source(repo_root, module_name)
        assert "crate::main" not in source, module_name
        assert "super::main" not in source, module_name
        assert "mod main" not in source, module_name

    bridge = _source(repo_root, "bridge.rs")
    events = _source(repo_root, "events.rs")
    assert "crate::events" not in bridge
    assert "crate::bridge" not in events


def test_tauri_atomic_write_owner_is_reused_by_storage_and_scaffold() -> None:
    repo_root = Path(__file__).resolve().parents[1]

    graph_layout_storage = _source(repo_root, "graph_layout_storage.rs")
    project_scaffold = _source(repo_root, "project_scaffold.rs")

    assert "crate::atomic_file::atomic_write_text" in graph_layout_storage
    assert "crate::atomic_file::{atomic_write_text, unique_temp_sibling}" in project_scaffold


def test_tauri_commands_remain_bridge_and_filesystem_glue_only() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    commands = _source(repo_root, "commands.rs")

    forbidden_implementation_markers = {
        "RecommendedWatcher",
        "MoveFileExW",
        "helm.ui.desktop_bridge",
        "graph-layouts.v1.json",
        "atomic_write_text",
        "create_dir_all",
    }
    for marker in forbidden_implementation_markers:
        assert marker not in commands
