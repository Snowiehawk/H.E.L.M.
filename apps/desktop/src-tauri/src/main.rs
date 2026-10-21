#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app_menu;
mod atomic_file;
mod bridge;
mod commands;
mod events;
mod execution_navigation;
mod execution_policy;
mod execution_preparation;
mod execution_supervisor;
mod execution_work;
mod graph_layout_storage;
#[cfg(target_os = "macos")]
mod macos_termination;
mod maintenance;
mod project_scaffold;
mod repo_boundary;
mod repo_file_actions;
mod run_config;
mod watcher;

use app_menu::{GraphViewMenuActionPayload, GraphViewMenuState};
use bridge::BackendService;
use commands::{
    apply_backend_undo, apply_structural_edit, backend_health, canonicalize_repo_path,
    create_new_project, create_workspace_entry, delete_workspace_entry, editable_node_source,
    flow_view, graph_view, list_workspace_files, move_workspace_entry,
    open_repo_path_in_default_editor, parse_flow_expression, preview_workspace_file_operation,
    read_repo_file, read_repo_graph_layout, read_workspace_file, reveal_repo_path_in_file_explorer,
    reveal_source, save_node_source, save_workspace_file, scan_repo_payload,
    sync_graph_view_menu_state, write_repo_graph_layout,
};
use events::APP_MENU_EVENT;
use execution_navigation::{execution_open_loopback, execution_resolve_diagnostic};
use execution_policy::{
    execution_bind, execution_import_env, execution_set_secrets, ExecutionPolicy,
};
use execution_preparation::prepare_run_source;
use execution_supervisor::{
    execution_cancel_run, execution_poll, execution_probe_tool, execution_resize,
    execution_set_trust, execution_start_run, execution_start_terminal, execution_stop,
    execution_stop_all, execution_write, ExecutionSupervisor,
};
use repo_boundary::ActiveRepoBoundary;
use run_config::{
    execution_read_configs, execution_resolve_tool, execution_save_configs, execution_suggestions,
    RunConfigStore,
};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{Emitter, Manager};
use watcher::ActiveRepoWatcher;

fn main() {
    let builder = tauri::Builder::default()
        .manage(GraphViewMenuState::default())
        .manage(BackendService::default())
        .manage(ExecutionPolicy::default())
        .manage(execution_preparation::PreparationReceipts::default())
        .manage(RunConfigStore::default())
        .manage(ExecutionSupervisor::default())
        .manage(ActiveRepoBoundary::default())
        .manage(ActiveRepoWatcher::default());
    #[cfg(target_os = "macos")]
    let builder = builder.menu(|app| {
        let menu_state = app.state::<GraphViewMenuState>();
        app_menu::build_macos_app_menu(app, menu_state.inner())
    });

    builder
        .setup(|app| {
            bridge::set_resource_dir(app.path().resource_dir()?);
            #[cfg(target_os = "macos")]
            macos_termination::install(app.handle())?;
            Ok(())
        })
        .on_menu_event(
            |app, event| match app_menu::native_menu_action(event.id().as_ref()) {
                Some(app_menu::NativeMenuAction::RequestQuit) => app.exit(0),
                Some(app_menu::NativeMenuAction::Renderer(action)) => {
                    let _ = app.emit(APP_MENU_EVENT, GraphViewMenuActionPayload { action });
                }
                None => {}
            },
        )
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() != "main" {
                    return;
                }
                if window.app_handle().state::<ExecutionPolicy>().is_closing() {
                    // Only a native, already-proven transition can seal this.
                    // A proved native exit must not start duplicate Close cleanup.
                    return;
                }
                api.prevent_close();
                let app = window.app_handle().clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let policy = app.state::<ExecutionPolicy>();
                    let result = (|| -> Result<(), String> {
                        let transition = policy.begin_transition()?;
                        app.state::<ExecutionSupervisor>().shutdown_all()?;
                        // v1 main-window Close has the same cleanup/exit policy as Quit.
                        transition.seal();
                        app.exit(0);
                        Ok(())
                    })();
                    if let Err(message) = result {
                        let _ = app.emit("helm://execution-cleanup-error", message);
                    }
                });
            }
        })
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            execution_bind,
            execution_set_secrets,
            execution_set_trust,
            execution_import_env,
            execution_probe_tool,
            execution_read_configs,
            execution_save_configs,
            execution_suggestions,
            execution_resolve_tool,
            execution_start_run,
            execution_start_terminal,
            execution_poll,
            execution_stop,
            execution_write,
            execution_resize,
            execution_resolve_diagnostic,
            execution_open_loopback,
            prepare_run_source,
            execution_stop_all,
            execution_cancel_run,
            backend_health,
            create_new_project,
            canonicalize_repo_path,
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
        .build(tauri::generate_context!())
        .expect("failed to build H.E.L.M. desktop shell")
        .run({
            let exiting = Arc::new(AtomicBool::new(false));
            move |app, event| {
                #[cfg(target_os = "macos")]
                if matches!(event, tauri::RunEvent::Exit) {
                    // Drop the retained handle; cleanup must already have succeeded
                    // at a preventable exit boundary, never at this late notification.
                    macos_termination::clear();
                }
                if let tauri::RunEvent::ExitRequested { api, .. } = event {
                    // Main-window Close and Quit seal admission only after proving
                    // cleanup. The queued exit request may now finish normally.
                    if exiting.load(Ordering::SeqCst) || app.state::<ExecutionPolicy>().is_closing()
                    {
                        return;
                    }
                    api.prevent_exit();
                    let app = app.clone();
                    let exiting = exiting.clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        let policy = app.state::<ExecutionPolicy>();
                        let result = (|| -> Result<(), String> {
                            let transition = policy.begin_transition()?;
                            app.state::<ExecutionSupervisor>().shutdown_all()?;
                            transition.seal();
                            exiting.store(true, Ordering::SeqCst);
                            app.exit(0);
                            Ok(())
                        })();
                        if let Err(message) = result {
                            let _ = app.emit("helm://execution-cleanup-error", message);
                        }
                    });
                }
            }
        });
}
