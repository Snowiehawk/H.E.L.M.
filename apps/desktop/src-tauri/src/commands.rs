use crate::app_menu::{self, GraphViewMenuState};
use crate::bridge::{self, BackendHealth, BackendService, WorkerProgressPayload};
use crate::events::{emit_index_progress_event, IndexProgressEventPayload};
use crate::graph_layout_storage::{
    read_repo_graph_layouts, write_repo_graph_layouts, StoredGraphViewLayout,
};
use crate::project_scaffold::{
    create_python_package_project, validate_new_project_path, NewProjectResult,
};
use crate::repo_boundary::{canonicalize_repo_root, normalize_path, ActiveRepoBoundary};
use crate::repo_file_actions::{
    open_path_in_default_editor, read_text_file, reveal_path_in_file_explorer,
};
use crate::watcher::{ActiveRepoWatcher, WORKSPACE_SYNC_TOP_N};
use serde_json::{json, Value};
use std::path::Path;
use tauri::{AppHandle, State, Wry};

fn to_index_progress_event(
    job_id: &str,
    repo_path: &str,
    progress: WorkerProgressPayload,
) -> IndexProgressEventPayload {
    IndexProgressEventPayload {
        job_id: job_id.to_string(),
        repo_path: repo_path.to_string(),
        status: progress.status,
        stage: progress.stage,
        processed_modules: progress.processed_modules,
        total_modules: progress.total_modules,
        symbol_count: progress.symbol_count,
        message: progress.message,
        progress_percent: progress.progress_percent,
        error: progress.error,
    }
}

#[tauri::command]
pub(crate) fn backend_health(service: State<'_, BackendService>) -> Result<BackendHealth, String> {
    bridge::backend_health(service.inner())
}

#[tauri::command]
pub(crate) fn scan_repo_payload(
    app: AppHandle<Wry>,
    service: State<'_, BackendService>,
    watcher: State<'_, ActiveRepoWatcher>,
    active_repo: State<'_, ActiveRepoBoundary>,
    repo_path: String,
    job_id: String,
) -> Result<Value, String> {
    let canonical_repo_root = canonicalize_repo_root(&repo_path)?;
    let repo_path = normalize_path(&canonical_repo_root);
    let progress_app = app.clone();
    let progress_job_id = job_id.clone();
    let progress_repo_path = repo_path.clone();
    let payload = service.request_with_progress(
        "full-resync",
        json!({
            "repo": repo_path.clone(),
            "top_n": WORKSPACE_SYNC_TOP_N,
            "emit_progress": true,
        }),
        Some(move |progress: WorkerProgressPayload| {
            emit_index_progress_event(
                &progress_app,
                to_index_progress_event(&progress_job_id, &progress_repo_path, progress),
            );
        }),
    )?;

    let module_count = payload
        .get("graph")
        .and_then(|graph| graph.get("report"))
        .and_then(|report| report.get("module_count"))
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .unwrap_or(0);
    let symbol_count = payload
        .get("graph")
        .and_then(|graph| graph.get("report"))
        .and_then(|report| report.get("symbol_count"))
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .unwrap_or(0);

    active_repo.set_active_repo(canonical_repo_root)?;
    let watch_ready_message = match watcher.watch_repo(&app, service.inner().clone(), &repo_path) {
        Ok(()) => {
            service.mark_synced();
            "Workspace ready. Watching for workspace changes.".to_string()
        }
        Err(err) => {
            service.mark_manual_resync_required(err);
            "Workspace ready. Live sync needs manual reindex.".to_string()
        }
    };

    emit_index_progress_event(
        &app,
        IndexProgressEventPayload {
            job_id,
            repo_path: repo_path.clone(),
            status: "done".to_string(),
            stage: "watch_ready".to_string(),
            processed_modules: module_count,
            total_modules: module_count,
            symbol_count,
            message: watch_ready_message,
            progress_percent: Some(100),
            error: None,
        },
    );

    Ok(payload)
}

#[tauri::command]
pub(crate) fn graph_view(
    service: State<'_, BackendService>,
    active_repo: State<'_, ActiveRepoBoundary>,
    repo_path: String,
    target_id: String,
    level: String,
    filters_json: String,
) -> Result<Value, String> {
    let repo_path = active_repo.command_repo_path(&repo_path)?;
    let filters: Value = serde_json::from_str(&filters_json)
        .map_err(|err| format!("Unable to decode graph filters: {}", err))?;
    service.request(
        "graph-view",
        json!({
            "repo": repo_path,
            "target_id": target_id,
            "level": level,
            "filters": filters,
        }),
    )
}

#[tauri::command]
pub(crate) fn flow_view(
    service: State<'_, BackendService>,
    active_repo: State<'_, ActiveRepoBoundary>,
    repo_path: String,
    symbol_id: String,
) -> Result<Value, String> {
    let repo_path = active_repo.command_repo_path(&repo_path)?;
    service.request(
        "flow-view",
        json!({
            "repo": repo_path,
            "symbol_id": symbol_id,
        }),
    )
}

#[tauri::command]
pub(crate) fn apply_structural_edit(
    service: State<'_, BackendService>,
    active_repo: State<'_, ActiveRepoBoundary>,
    repo_path: String,
    request_json: String,
) -> Result<Value, String> {
    let repo_path = active_repo.command_repo_path(&repo_path)?;
    service.request(
        "apply-edit",
        json!({
            "repo": repo_path,
            "request_json": request_json,
        }),
    )
}

#[tauri::command]
pub(crate) fn reveal_source(
    service: State<'_, BackendService>,
    active_repo: State<'_, ActiveRepoBoundary>,
    repo_path: String,
    target_id: String,
) -> Result<Value, String> {
    let repo_path = active_repo.command_repo_path(&repo_path)?;
    service.request(
        "reveal-source",
        json!({
            "repo": repo_path,
            "target_id": target_id,
        }),
    )
}

#[tauri::command]
pub(crate) fn editable_node_source(
    service: State<'_, BackendService>,
    active_repo: State<'_, ActiveRepoBoundary>,
    repo_path: String,
    target_id: String,
) -> Result<Value, String> {
    let repo_path = active_repo.command_repo_path(&repo_path)?;
    service.request(
        "editable-source",
        json!({
            "repo": repo_path,
            "target_id": target_id,
        }),
    )
}

#[tauri::command]
pub(crate) fn save_node_source(
    service: State<'_, BackendService>,
    active_repo: State<'_, ActiveRepoBoundary>,
    repo_path: String,
    target_id: String,
    content_json: String,
) -> Result<Value, String> {
    let repo_path = active_repo.command_repo_path(&repo_path)?;
    let content: Value = serde_json::from_str(&content_json)
        .map_err(|err| format!("Unable to decode replacement source: {}", err))?;
    let content = content
        .as_str()
        .ok_or_else(|| "Replacement source payload must be a string.".to_string())?;
    service.request(
        "save-node-source",
        json!({
            "repo": repo_path,
            "target_id": target_id,
            "content": content,
        }),
    )
}

#[tauri::command]
pub(crate) fn parse_flow_expression(
    service: State<'_, BackendService>,
    active_repo: State<'_, ActiveRepoBoundary>,
    repo_path: String,
    expression: String,
    input_slots_json: String,
) -> Result<Value, String> {
    let repo_path = active_repo.command_repo_path(&repo_path)?;
    let input_slot_by_name: Value = serde_json::from_str(&input_slots_json)
        .map_err(|err| format!("Unable to decode expression input slots: {}", err))?;
    service.request(
        "parse-flow-expression",
        json!({
            "repo": repo_path,
            "expression": expression,
            "input_slot_by_name": input_slot_by_name,
        }),
    )
}

#[tauri::command]
pub(crate) fn apply_backend_undo(
    service: State<'_, BackendService>,
    active_repo: State<'_, ActiveRepoBoundary>,
    repo_path: String,
    transaction_json: String,
) -> Result<Value, String> {
    let repo_path = active_repo.command_repo_path(&repo_path)?;
    service.request(
        "apply-undo",
        json!({
            "repo": repo_path,
            "transaction_json": transaction_json,
        }),
    )
}

#[tauri::command]
pub(crate) fn read_repo_graph_layout(
    active_repo: State<'_, ActiveRepoBoundary>,
    repo_path: String,
    view_key: String,
) -> Result<StoredGraphViewLayout, String> {
    let repo_root = active_repo.command_repo_root(&repo_path)?;
    let layouts = read_repo_graph_layouts(&repo_root)?;
    Ok(layouts.views.get(&view_key).cloned().unwrap_or_default())
}

#[tauri::command]
pub(crate) fn write_repo_graph_layout(
    active_repo: State<'_, ActiveRepoBoundary>,
    repo_path: String,
    view_key: String,
    layout_json: String,
) -> Result<(), String> {
    let repo_root = active_repo.command_repo_root(&repo_path)?;
    let layout: StoredGraphViewLayout = serde_json::from_str(&layout_json)
        .map_err(|err| format!("Unable to decode graph layout payload: {}", err))?;
    let mut layouts = read_repo_graph_layouts(&repo_root)?;
    layouts.views.insert(view_key, layout);
    write_repo_graph_layouts(&repo_root, &layouts)
}

#[tauri::command]
pub(crate) fn read_repo_file(
    active_repo: State<'_, ActiveRepoBoundary>,
    repo_path: String,
    relative_path: String,
) -> Result<String, String> {
    let target = active_repo.resolve_existing_target(&repo_path, &relative_path)?;
    read_text_file(&target.target_path, &target.relative_path)
}

#[tauri::command]
pub(crate) fn create_new_project(project_path: String) -> Result<NewProjectResult, String> {
    let path = validate_new_project_path(&project_path)?;
    create_python_package_project(&path)
}

#[tauri::command]
pub(crate) fn list_workspace_files(
    service: State<'_, BackendService>,
    active_repo: State<'_, ActiveRepoBoundary>,
    repo_path: String,
) -> Result<Value, String> {
    let repo_path = active_repo.command_repo_path(&repo_path)?;
    service.request(
        "list-workspace-files",
        json!({
            "repo": repo_path,
        }),
    )
}

#[tauri::command]
pub(crate) fn read_workspace_file(
    service: State<'_, BackendService>,
    active_repo: State<'_, ActiveRepoBoundary>,
    repo_path: String,
    relative_path: String,
) -> Result<Value, String> {
    let repo_path = active_repo.command_repo_path(&repo_path)?;
    let target = active_repo.resolve_existing_target(&repo_path, &relative_path)?;
    service.request(
        "read-workspace-file",
        json!({
            "repo": repo_path,
            "relative_path": target.relative_path,
        }),
    )
}

#[tauri::command]
pub(crate) fn preview_workspace_file_operation(
    service: State<'_, BackendService>,
    active_repo: State<'_, ActiveRepoBoundary>,
    repo_path: String,
    operation: String,
    relative_path: Option<String>,
    source_relative_path: Option<String>,
    target_directory_relative_path: Option<String>,
) -> Result<Value, String> {
    let repo_path = active_repo.command_repo_path(&repo_path)?;
    let relative_path = relative_path
        .map(|path| active_repo.resolve_existing_target(&repo_path, &path))
        .transpose()?
        .map(|target| target.relative_path);
    let source_relative_path = source_relative_path
        .map(|path| active_repo.resolve_existing_target(&repo_path, &path))
        .transpose()?
        .map(|target| target.relative_path);
    let target_directory_relative_path = match target_directory_relative_path {
        Some(path) if path.trim().is_empty() => Some(String::new()),
        Some(path) => Some(
            active_repo
                .resolve_existing_target(&repo_path, &path)?
                .relative_path,
        ),
        None => None,
    };
    service.request(
        "preview-workspace-file-operation",
        json!({
            "repo": repo_path,
            "operation": operation,
            "relative_path": relative_path,
            "source_relative_path": source_relative_path,
            "target_directory_relative_path": target_directory_relative_path,
        }),
    )
}

#[tauri::command]
pub(crate) fn create_workspace_entry(
    service: State<'_, BackendService>,
    active_repo: State<'_, ActiveRepoBoundary>,
    repo_path: String,
    kind: String,
    relative_path: String,
    content: Option<String>,
) -> Result<Value, String> {
    let repo_path = active_repo.command_repo_path(&repo_path)?;
    let target = active_repo.resolve_creatable_target(&repo_path, &relative_path)?;
    service.request(
        "create-workspace-entry",
        json!({
            "repo": repo_path,
            "kind": kind,
            "relative_path": target.relative_path,
            "content": content,
            "top_n": WORKSPACE_SYNC_TOP_N,
        }),
    )
}

#[tauri::command]
pub(crate) fn save_workspace_file(
    service: State<'_, BackendService>,
    active_repo: State<'_, ActiveRepoBoundary>,
    repo_path: String,
    relative_path: String,
    content: String,
    expected_version: String,
) -> Result<Value, String> {
    let repo_path = active_repo.command_repo_path(&repo_path)?;
    let target = active_repo.resolve_creatable_target(&repo_path, &relative_path)?;
    service.request(
        "save-workspace-file",
        json!({
            "repo": repo_path,
            "relative_path": target.relative_path,
            "content": content,
            "expected_version": expected_version,
            "top_n": WORKSPACE_SYNC_TOP_N,
        }),
    )
}

#[tauri::command]
pub(crate) fn move_workspace_entry(
    service: State<'_, BackendService>,
    active_repo: State<'_, ActiveRepoBoundary>,
    repo_path: String,
    source_relative_path: String,
    target_directory_relative_path: String,
    expected_impact_fingerprint: Option<String>,
) -> Result<Value, String> {
    let repo_path = active_repo.command_repo_path(&repo_path)?;
    let source = active_repo.resolve_existing_target(&repo_path, &source_relative_path)?;
    let target_directory_relative_path = if target_directory_relative_path.trim().is_empty() {
        String::new()
    } else {
        active_repo
            .resolve_existing_target(&repo_path, &target_directory_relative_path)?
            .relative_path
    };
    let moved_name = Path::new(&source.relative_path)
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Source path must include a file or folder name.".to_string())?;
    let moved_relative_path = if target_directory_relative_path.is_empty() {
        moved_name.to_string()
    } else {
        format!("{}/{}", target_directory_relative_path, moved_name)
    };
    active_repo.resolve_creatable_target(&repo_path, &moved_relative_path)?;
    service.request(
        "move-workspace-entry",
        json!({
            "repo": repo_path,
            "source_relative_path": source.relative_path,
            "target_directory_relative_path": target_directory_relative_path,
            "expected_impact_fingerprint": expected_impact_fingerprint,
            "top_n": WORKSPACE_SYNC_TOP_N,
        }),
    )
}

#[tauri::command]
pub(crate) fn delete_workspace_entry(
    service: State<'_, BackendService>,
    active_repo: State<'_, ActiveRepoBoundary>,
    repo_path: String,
    relative_path: String,
    expected_impact_fingerprint: Option<String>,
) -> Result<Value, String> {
    let repo_path = active_repo.command_repo_path(&repo_path)?;
    let target = active_repo.resolve_existing_target(&repo_path, &relative_path)?;
    service.request(
        "delete-workspace-entry",
        json!({
            "repo": repo_path,
            "relative_path": target.relative_path,
            "expected_impact_fingerprint": expected_impact_fingerprint,
            "top_n": WORKSPACE_SYNC_TOP_N,
        }),
    )
}

#[tauri::command]
pub(crate) fn open_repo_path_in_default_editor(
    active_repo: State<'_, ActiveRepoBoundary>,
    repo_path: String,
    relative_path: String,
) -> Result<(), String> {
    let target = active_repo.resolve_existing_target(&repo_path, &relative_path)?;
    open_path_in_default_editor(&target.target_path)
}

#[tauri::command]
pub(crate) fn reveal_repo_path_in_file_explorer(
    active_repo: State<'_, ActiveRepoBoundary>,
    repo_path: String,
    relative_path: String,
) -> Result<(), String> {
    let target = active_repo.resolve_existing_target(&repo_path, &relative_path)?;
    reveal_path_in_file_explorer(&target.target_path)
}

#[tauri::command]
pub(crate) fn sync_graph_view_menu_state(
    state: tauri::State<'_, GraphViewMenuState>,
    state_json: String,
) -> Result<(), String> {
    app_menu::sync_graph_view_menu_state(state.inner(), &state_json)
}
