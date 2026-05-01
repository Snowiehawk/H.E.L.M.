#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app_menu;
mod atomic_file;
mod bridge;
mod commands;
mod events;
mod graph_layout_storage;
mod project_scaffold;
mod repo_boundary;
mod repo_file_actions;
mod watcher;

use app_menu::{GraphViewMenuActionPayload, GraphViewMenuState};
use bridge::BackendService;
use commands::{
    apply_backend_undo, apply_structural_edit, backend_health, create_new_project,
    create_workspace_entry, delete_workspace_entry, editable_node_source, flow_view, graph_view,
    list_workspace_files, move_workspace_entry, open_repo_path_in_default_editor,
    parse_flow_expression, preview_workspace_file_operation, read_repo_file,
    read_repo_graph_layout, read_workspace_file, reveal_repo_path_in_file_explorer, reveal_source,
    save_node_source, save_workspace_file, scan_repo_payload, sync_graph_view_menu_state,
    write_repo_graph_layout,
};
use events::APP_MENU_EVENT;
use repo_boundary::ActiveRepoBoundary;
use tauri::Emitter;
#[cfg(target_os = "macos")]
use tauri::Manager;
use watcher::ActiveRepoWatcher;

fn main() {
    let builder = tauri::Builder::default()
        .manage(GraphViewMenuState::default())
        .manage(BackendService::default())
        .manage(ActiveRepoBoundary::default())
        .manage(ActiveRepoWatcher::default());
    #[cfg(target_os = "macos")]
    let builder = builder.menu(|app| {
        let menu_state = app.state::<GraphViewMenuState>();
        app_menu::build_macos_app_menu(app, menu_state.inner())
    });

    builder
        .on_menu_event(|app, event| {
            if let Some(action) = app_menu::menu_action_for_id(event.id().as_ref()) {
                let _ = app.emit(APP_MENU_EVENT, GraphViewMenuActionPayload { action });
            }
        })
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            backend_health,
            create_new_project,
            scan_repo_payload,
            graph_view,
            flow_view,
            apply_structural_edit,
            apply_backend_undo,
            reveal_source,
            editable_node_source,
            save_node_source,
            parse_flow_expression,
            read_repo_graph_layout,
            write_repo_graph_layout,
            read_repo_file,
            list_workspace_files,
            read_workspace_file,
            preview_workspace_file_operation,
            create_workspace_entry,
            save_workspace_file,
            move_workspace_entry,
            delete_workspace_entry,
            open_repo_path_in_default_editor,
            reveal_repo_path_in_file_explorer,
            sync_graph_view_menu_state
        ])
        .run(tauri::generate_context!())
        .expect("failed to run H.E.L.M. desktop shell");
}
