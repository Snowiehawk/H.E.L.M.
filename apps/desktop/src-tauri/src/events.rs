use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Wry};

pub(crate) const APP_MENU_EVENT: &str = "helm://app-menu";
pub(crate) const INDEX_PROGRESS_EVENT: &str = "helm://index-progress";
pub(crate) const WORKSPACE_SYNC_EVENT: &str = "helm://workspace-sync";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceSyncSnapshot {
    repo_id: String,
    default_focus_node_id: String,
    default_level: String,
    node_ids: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceSyncEventPayload {
    pub(crate) repo_path: String,
    pub(crate) session_version: u64,
    pub(crate) reason: String,
    pub(crate) status: String,
    pub(crate) changed_relative_paths: Vec<String>,
    pub(crate) needs_manual_resync: bool,
    pub(crate) payload: Option<Value>,
    pub(crate) snapshot: Option<WorkspaceSyncSnapshot>,
    pub(crate) message: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IndexProgressEventPayload {
    pub(crate) job_id: String,
    pub(crate) repo_path: String,
    pub(crate) status: String,
    pub(crate) stage: String,
    pub(crate) processed_modules: usize,
    pub(crate) total_modules: usize,
    pub(crate) symbol_count: usize,
    pub(crate) message: String,
    pub(crate) progress_percent: Option<usize>,
    pub(crate) error: Option<String>,
}

pub(crate) fn extract_string_vec(value: Option<&Value>) -> Option<Vec<String>> {
    value.and_then(Value::as_array).map(|items| {
        items
            .iter()
            .filter_map(|item| item.as_str().map(ToOwned::to_owned))
            .collect()
    })
}

pub(crate) fn extract_session_version(result: &Value, payload: Option<&Value>) -> u64 {
    result
        .get("session_version")
        .and_then(Value::as_u64)
        .or_else(|| {
            payload
                .and_then(|payload| payload.get("workspace"))
                .and_then(|workspace| workspace.get("session_version"))
                .and_then(Value::as_u64)
        })
        .unwrap_or(0)
}

pub(crate) fn workspace_sync_snapshot(payload: &Value) -> Option<WorkspaceSyncSnapshot> {
    let graph = payload.get("graph")?;
    let workspace = payload.get("workspace")?;
    let repo_id = graph.get("repo_id")?.as_str()?.to_string();
    let default_focus_node_id = workspace
        .get("default_focus_node_id")?
        .as_str()?
        .to_string();
    let default_level = workspace.get("default_level")?.as_str()?.to_string();
    let node_ids = graph
        .get("nodes")?
        .as_array()?
        .iter()
        .filter_map(|node| node.get("node_id")?.as_str().map(ToOwned::to_owned))
        .collect();

    Some(WorkspaceSyncSnapshot {
        repo_id,
        default_focus_node_id,
        default_level,
        node_ids,
    })
}

pub(crate) fn emit_index_progress_event(app: &AppHandle<Wry>, payload: IndexProgressEventPayload) {
    let _ = app.emit(INDEX_PROGRESS_EVENT, payload);
}

pub(crate) fn emit_workspace_sync_event(app: &AppHandle<Wry>, payload: WorkspaceSyncEventPayload) {
    let _ = app.emit(WORKSPACE_SYNC_EVENT, payload);
}
