#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::menu::CheckMenuItem;
#[cfg(target_os = "macos")]
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
#[cfg(target_os = "macos")]
use tauri::Manager;
use tauri::{AppHandle, Emitter, State, Wry};

const APP_MENU_EVENT: &str = "helm://app-menu";
const INDEX_PROGRESS_EVENT: &str = "helm://index-progress";
const WORKSPACE_SYNC_EVENT: &str = "helm://workspace-sync";
const MENU_ID_SHOW_CALLS: &str = "graph-view.show-calls";
const MENU_ID_SHOW_IMPORTS: &str = "graph-view.show-imports";
const MENU_ID_SHOW_DEFINES: &str = "graph-view.show-defines";
const MENU_ID_HIGHLIGHT_PATH: &str = "graph-view.highlight-path";
const MENU_ID_SHOW_EDGE_LABELS: &str = "graph-view.show-edge-labels";
const MENU_ID_NEW_PROJECT: &str = "app.new-project";
const MENU_ID_UNDO: &str = "app.undo";
const MENU_ID_REDO: &str = "app.redo";
const MENU_ID_PREFERENCES: &str = "app.preferences";
const MENU_ID_ZOOM_IN: &str = "app.zoom-in";
const MENU_ID_ZOOM_OUT: &str = "app.zoom-out";
const MENU_ID_ZOOM_RESET: &str = "app.zoom-reset";
const WORKSPACE_SYNC_DEBOUNCE_MS: u64 = 250;
const WORKSPACE_SYNC_TOP_N: usize = 24;
const IGNORED_WATCH_DIRS: &[&str] = &[
    ".cache",
    ".git",
    ".hg",
    ".mypy_cache",
    ".nox",
    ".next",
    ".parcel-cache",
    ".pytest_cache",
    ".ruff_cache",
    ".svn",
    ".turbo",
    ".vendor",
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
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendHealth {
    mode: String,
    python_command: String,
    workspace_root: String,
    available: bool,
    note: String,
    live_sync_enabled: bool,
    sync_state: String,
    last_sync_error: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct StoredGraphNodePosition {
    x: f64,
    y: f64,
}

type StoredGraphNodeLayout = BTreeMap<String, StoredGraphNodePosition>;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredGraphRerouteNode {
    id: String,
    edge_id: String,
    order: usize,
    x: f64,
    y: f64,
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct StoredGraphGroup {
    id: String,
    title: String,
    #[serde(default)]
    member_node_ids: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize, Default)]
struct StoredGraphViewLayout {
    #[serde(default)]
    nodes: StoredGraphNodeLayout,
    #[serde(default)]
    reroutes: Vec<StoredGraphRerouteNode>,
    #[serde(default)]
    pinned_node_ids: Vec<String>,
    #[serde(default)]
    groups: Vec<StoredGraphGroup>,
}

#[derive(Default, Serialize, Deserialize)]
struct RepoGraphLayouts {
    views: BTreeMap<String, StoredGraphViewLayout>,
}

#[derive(Default)]
struct GraphViewMenuState {
    show_calls: Mutex<Option<CheckMenuItem<Wry>>>,
    show_imports: Mutex<Option<CheckMenuItem<Wry>>>,
    show_defines: Mutex<Option<CheckMenuItem<Wry>>>,
    highlight_path: Mutex<Option<CheckMenuItem<Wry>>>,
    show_edge_labels: Mutex<Option<CheckMenuItem<Wry>>>,
}

#[derive(Debug)]
struct ResolvedRepoPath {
    relative_path: String,
    target_path: PathBuf,
}

#[derive(Default)]
struct ActiveRepoBoundary {
    repo_root: Mutex<Option<PathBuf>>,
}

impl ActiveRepoBoundary {
    fn set_active_repo(&self, repo_root: PathBuf) -> Result<(), String> {
        let mut active = self
            .repo_root
            .lock()
            .map_err(|_| "Unable to lock the active repository state.".to_string())?;
        *active = Some(repo_root);
        Ok(())
    }

    #[cfg(test)]
    fn activate_repo_path(&self, repo_path: &str) -> Result<PathBuf, String> {
        let repo_root = canonicalize_repo_root(repo_path)?;
        self.set_active_repo(repo_root.clone())?;
        Ok(repo_root)
    }

    fn command_repo_root(&self, repo_path: &str) -> Result<PathBuf, String> {
        let renderer_repo_root = canonicalize_repo_root(repo_path)?;
        let active_repo_root = self
            .repo_root
            .lock()
            .map_err(|_| "Unable to lock the active repository state.".to_string())?
            .clone()
            .ok_or_else(|| {
                "No active repository is available. Open or reindex a repository first.".to_string()
            })?;

        if renderer_repo_root != active_repo_root {
            return Err(
                "Repository path does not match the active repository. Reopen or reindex the repository."
                    .to_string(),
            );
        }

        Ok(active_repo_root)
    }

    fn command_repo_path(&self, repo_path: &str) -> Result<String, String> {
        self.command_repo_root(repo_path)
            .map(|repo_root| normalize_path(&repo_root))
    }

    fn resolve_existing_target(
        &self,
        repo_path: &str,
        relative_path: &str,
    ) -> Result<ResolvedRepoPath, String> {
        let repo_root = self.command_repo_root(repo_path)?;
        let relative_path = normalize_repo_relative_path(relative_path)?;
        let candidate = repo_root.join(Path::new(&relative_path));
        let target_path = candidate.canonicalize().map_err(|err| {
            format!(
                "Unable to resolve repo-relative path {}: {}",
                relative_path, err
            )
        })?;
        ensure_canonical_path_inside_repo(&target_path, &repo_root, "Repo-relative path")?;
        Ok(ResolvedRepoPath {
            relative_path,
            target_path,
        })
    }

    fn resolve_creatable_target(
        &self,
        repo_path: &str,
        relative_path: &str,
    ) -> Result<ResolvedRepoPath, String> {
        let repo_root = self.command_repo_root(repo_path)?;
        let relative_path = normalize_repo_relative_path(relative_path)?;
        let target_path = repo_root.join(Path::new(&relative_path));
        if target_path.exists() {
            let canonical_target = target_path.canonicalize().map_err(|err| {
                format!(
                    "Unable to resolve repo-relative path {}: {}",
                    relative_path, err
                )
            })?;
            ensure_canonical_path_inside_repo(&canonical_target, &repo_root, "Repo-relative path")?;
            return Ok(ResolvedRepoPath {
                relative_path,
                target_path,
            });
        }

        let mut nearest_parent = target_path
            .parent()
            .ok_or_else(|| "Repo-relative path must include a parent folder.".to_string())?
            .to_path_buf();

        while !nearest_parent.exists() {
            let parent = nearest_parent.parent().ok_or_else(|| {
                format!(
                    "Unable to resolve parent folder for repo-relative path {}.",
                    relative_path
                )
            })?;
            nearest_parent = parent.to_path_buf();
        }

        let canonical_parent = nearest_parent.canonicalize().map_err(|err| {
            format!(
                "Unable to resolve parent folder {}: {}",
                nearest_parent.display(),
                err
            )
        })?;
        ensure_canonical_path_inside_repo(&canonical_parent, &repo_root, "Parent folder")?;

        Ok(ResolvedRepoPath {
            relative_path,
            target_path,
        })
    }
}

fn canonicalize_repo_root(repo_path: &str) -> Result<PathBuf, String> {
    let trimmed_path = repo_path.trim();
    if trimmed_path.is_empty() {
        return Err("Repository path cannot be empty.".to_string());
    }
    if trimmed_path.contains('\0') {
        return Err("Repository path cannot contain null bytes.".to_string());
    }

    let path = PathBuf::from(trimmed_path);
    if !path.is_absolute() {
        return Err("Repository path must be absolute.".to_string());
    }

    let canonical = path.canonicalize().map_err(|err| {
        format!(
            "Unable to resolve repository path {}: {}",
            path.display(),
            err
        )
    })?;
    if !canonical.is_dir() {
        return Err(format!(
            "Repository path is not a directory: {}",
            canonical.display()
        ));
    }

    Ok(canonical)
}

fn normalize_repo_relative_path(relative_path: &str) -> Result<String, String> {
    let trimmed_path = relative_path.trim();
    if trimmed_path.is_empty() {
        return Err("Repo-relative path cannot be empty.".to_string());
    }
    if trimmed_path.contains('\0') {
        return Err("Repo-relative path cannot contain null bytes.".to_string());
    }

    let normalized = trimmed_path.replace('\\', "/");
    if normalized == "." || normalized == ".." {
        return Err("Repo-relative path cannot be '.' or '..'.".to_string());
    }
    if normalized
        .as_bytes()
        .get(1)
        .is_some_and(|value| *value == b':')
        && normalized
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphabetic)
    {
        return Err("Repo-relative path cannot include a drive prefix.".to_string());
    }
    if normalized.split('/').any(|part| part.is_empty()) {
        return Err("Repo-relative path has malformed separators.".to_string());
    }

    let path = Path::new(&normalized);
    if path.is_absolute() {
        return Err("Repo-relative path cannot be absolute.".to_string());
    }

    for component in path.components() {
        match component {
            Component::Normal(_) => {}
            Component::CurDir | Component::ParentDir => {
                return Err("Repo-relative path cannot contain '.' or '..'.".to_string());
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err("Repo-relative path cannot be rooted.".to_string());
            }
        }
    }

    Ok(normalized)
}

fn ensure_canonical_path_inside_repo(
    path: &Path,
    repo_root: &Path,
    label: &str,
) -> Result<(), String> {
    if path == repo_root || path.strip_prefix(repo_root).is_ok() {
        return Ok(());
    }

    Err(format!("{} must stay inside the active repository.", label))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GraphViewMenuActionPayload {
    action: &'static str,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceSyncSnapshot {
    repo_id: String,
    default_focus_node_id: String,
    default_level: String,
    node_ids: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceSyncEventPayload {
    repo_path: String,
    session_version: u64,
    reason: String,
    status: String,
    changed_relative_paths: Vec<String>,
    needs_manual_resync: bool,
    payload: Option<Value>,
    snapshot: Option<WorkspaceSyncSnapshot>,
    message: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct IndexProgressEventPayload {
    job_id: String,
    repo_path: String,
    status: String,
    stage: String,
    processed_modules: usize,
    total_modules: usize,
    symbol_count: usize,
    message: String,
    progress_percent: Option<usize>,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NewProjectResult {
    project_path: String,
    package_name: String,
}

#[derive(Clone, Deserialize)]
struct WorkerProgressPayload {
    stage: String,
    status: String,
    message: String,
    #[serde(default)]
    processed_modules: usize,
    #[serde(default)]
    total_modules: usize,
    #[serde(default)]
    symbol_count: usize,
    progress_percent: Option<usize>,
    error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphViewMenuSyncPayload {
    include_calls: bool,
    include_imports: bool,
    include_defines: bool,
    highlight_graph_path: bool,
    show_edge_labels: bool,
}

#[derive(Clone)]
struct LiveSyncState {
    live_sync_enabled: bool,
    sync_state: String,
    last_sync_error: Option<String>,
    sync_note: Option<String>,
}

impl Default for LiveSyncState {
    fn default() -> Self {
        Self {
            live_sync_enabled: false,
            sync_state: "idle".to_string(),
            last_sync_error: None,
            sync_note: None,
        }
    }
}

#[derive(Clone)]
struct BackendService {
    bridge: Arc<PersistentPythonBridge>,
    sync_state: Arc<Mutex<LiveSyncState>>,
}

impl Default for BackendService {
    fn default() -> Self {
        Self {
            bridge: Arc::new(PersistentPythonBridge::default()),
            sync_state: Arc::new(Mutex::new(LiveSyncState::default())),
        }
    }
}

impl BackendService {
    fn request(&self, command: &str, params: Value) -> Result<Value, String> {
        self.request_with_progress(command, params, None::<fn(WorkerProgressPayload)>)
    }

    fn request_with_progress<F>(
        &self,
        command: &str,
        params: Value,
        on_progress: Option<F>,
    ) -> Result<Value, String>
    where
        F: FnMut(WorkerProgressPayload),
    {
        self.bridge.request(command, params, on_progress)
    }

    fn health_snapshot(&self) -> LiveSyncState {
        self.sync_state
            .lock()
            .map(|state| state.clone())
            .unwrap_or_default()
    }

    fn mark_synced(&self) {
        self.update_sync_state(true, "synced", None, None);
    }

    fn mark_syncing_with_note(&self, note: String) {
        self.update_sync_state(true, "syncing", None, Some(note));
    }

    fn mark_manual_resync_required(&self, message: String) {
        self.update_sync_state(false, "manual_resync_required", Some(message), None);
    }

    fn update_sync_state(
        &self,
        live_sync_enabled: bool,
        sync_state: &str,
        last_sync_error: Option<String>,
        sync_note: Option<String>,
    ) {
        if let Ok(mut state) = self.sync_state.lock() {
            state.live_sync_enabled = live_sync_enabled;
            state.sync_state = sync_state.to_string();
            state.last_sync_error = last_sync_error;
            state.sync_note = sync_note;
        }
    }
}

#[derive(Default)]
struct PersistentPythonBridge {
    process: Mutex<Option<BridgeProcess>>,
}

struct BridgeProcess {
    child: Child,
    stdin: BufWriter<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    next_request_id: u64,
}

impl Drop for BridgeProcess {
    fn drop(&mut self) {
        let shutdown = json!({
            "id": 0,
            "command": "shutdown",
            "params": {},
        });
        let _ = serde_json::to_writer(&mut self.stdin, &shutdown);
        let _ = self.stdin.write_all(b"\n");
        let _ = self.stdin.flush();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Deserialize)]
struct WorkerResponse {
    id: Option<u64>,
    ok: Option<bool>,
    event: Option<String>,
    payload: Option<Value>,
    result: Option<Value>,
    error: Option<String>,
}

impl PersistentPythonBridge {
    fn request<F>(
        &self,
        command: &str,
        params: Value,
        mut on_progress: Option<F>,
    ) -> Result<Value, String>
    where
        F: FnMut(WorkerProgressPayload),
    {
        let mut last_error: Option<String> = None;
        for _ in 0..2 {
            let mut process = self
                .process
                .lock()
                .map_err(|_| "Unable to lock the Python bridge state.".to_string())?;
            if process.is_none() {
                *process = Some(spawn_bridge_process()?);
            }

            let result = process
                .as_mut()
                .ok_or_else(|| "Python bridge is unavailable.".to_string())
                .and_then(|bridge| {
                    send_bridge_request(
                        bridge,
                        command,
                        params.clone(),
                        on_progress
                            .as_mut()
                            .map(|callback| callback as &mut dyn FnMut(WorkerProgressPayload)),
                    )
                });
            match result {
                Ok(value) => return Ok(value),
                Err(err) => {
                    last_error = Some(err);
                    *process = None;
                }
            }
        }

        Err(last_error.unwrap_or_else(|| "Python bridge is unavailable.".to_string()))
    }
}

#[derive(Default)]
struct ActiveRepoWatcher {
    handle: Mutex<Option<RepoWatcherHandle>>,
}

struct RepoWatcherHandle {
    repo_path: String,
    stop_tx: mpsc::Sender<()>,
    thread: Option<JoinHandle<()>>,
    _watcher: RecommendedWatcher,
}

impl Drop for RepoWatcherHandle {
    fn drop(&mut self) {
        let _ = self.stop_tx.send(());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl ActiveRepoWatcher {
    fn watch_repo(
        &self,
        app: &AppHandle<Wry>,
        service: BackendService,
        repo_path: &str,
    ) -> Result<(), String> {
        let repo_root = PathBuf::from(repo_path);
        if !repo_root.exists() {
            return Err(format!(
                "Repository path does not exist for live sync: {}",
                repo_root.display()
            ));
        }

        let normalized_repo_root = repo_root
            .canonicalize()
            .map_err(|err| format!("Unable to resolve {}: {}", repo_root.display(), err))?;
        let normalized_repo_path = normalize_path(&normalized_repo_root);

        let old_handle = {
            let mut handle = self
                .handle
                .lock()
                .map_err(|_| "Unable to lock the live repo watcher.".to_string())?;
            if handle
                .as_ref()
                .map(|current| current.repo_path == normalized_repo_path)
                .unwrap_or(false)
            {
                return Ok(());
            }
            handle.take()
        };
        drop(old_handle);

        let (event_tx, event_rx) = mpsc::channel::<notify::Result<Event>>();
        let mut watcher = RecommendedWatcher::new(
            move |result| {
                let _ = event_tx.send(result);
            },
            Config::default(),
        )
        .map_err(|err| format!("Unable to start the repo watcher: {}", err))?;
        watcher
            .watch(&normalized_repo_root, RecursiveMode::Recursive)
            .map_err(|err| {
                format!(
                    "Unable to watch {}: {}",
                    normalized_repo_root.display(),
                    err
                )
            })?;

        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let thread_app = app.clone();
        let thread_service = service.clone();
        let thread_repo_root = normalized_repo_root.clone();
        let thread_repo_path = normalized_repo_path.clone();
        let thread = thread::spawn(move || {
            run_repo_watch_loop(
                thread_app,
                thread_service,
                thread_repo_root,
                thread_repo_path,
                event_rx,
                stop_rx,
            )
        });

        let new_handle = RepoWatcherHandle {
            repo_path: normalized_repo_path,
            stop_tx,
            thread: Some(thread),
            _watcher: watcher,
        };
        let old_handle = {
            let mut handle = self
                .handle
                .lock()
                .map_err(|_| "Unable to lock the live repo watcher.".to_string())?;
            handle.replace(new_handle)
        };
        drop(old_handle);
        Ok(())
    }
}

fn run_repo_watch_loop(
    app: AppHandle<Wry>,
    service: BackendService,
    repo_root: PathBuf,
    repo_path: String,
    event_rx: mpsc::Receiver<notify::Result<Event>>,
    stop_rx: mpsc::Receiver<()>,
) {
    let mut pending_relative_paths = BTreeSet::new();
    loop {
        if stop_rx.try_recv().is_ok() {
            break;
        }

        match event_rx.recv_timeout(Duration::from_millis(WORKSPACE_SYNC_DEBOUNCE_MS)) {
            Ok(Ok(event)) => {
                if watch_event_requires_manual_resync(&event) {
                    let message = "Live sync watcher requested a rescan. Reindex the repo to recover the workspace session.".to_string();
                    service.mark_manual_resync_required(message.clone());
                    emit_workspace_sync_event(
                        &app,
                        WorkspaceSyncEventPayload {
                            repo_path: repo_path.clone(),
                            session_version: 0,
                            reason: "watcher-rescan".to_string(),
                            status: "manual_resync_required".to_string(),
                            changed_relative_paths: Vec::new(),
                            needs_manual_resync: true,
                            payload: None,
                            snapshot: None,
                            message: Some(message),
                        },
                    );
                    break;
                }
                pending_relative_paths.extend(collect_relevant_relative_paths(&repo_root, &event));
            }
            Ok(Err(err)) => {
                let message = format!("Live sync watcher failed: {}", err);
                service.mark_manual_resync_required(message.clone());
                emit_workspace_sync_event(
                    &app,
                    WorkspaceSyncEventPayload {
                        repo_path: repo_path.clone(),
                        session_version: 0,
                        reason: "watcher-error".to_string(),
                        status: "manual_resync_required".to_string(),
                        changed_relative_paths: Vec::new(),
                        needs_manual_resync: true,
                        payload: None,
                        snapshot: None,
                        message: Some(message),
                    },
                );
                break;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if pending_relative_paths.is_empty() {
                    continue;
                }

                let changed_relative_paths =
                    pending_relative_paths.iter().cloned().collect::<Vec<_>>();
                pending_relative_paths.clear();

                let starting_message = "Preparing incremental refresh".to_string();
                service.mark_syncing_with_note(starting_message.clone());
                emit_workspace_sync_event(
                    &app,
                    WorkspaceSyncEventPayload {
                        repo_path: repo_path.clone(),
                        session_version: 0,
                        reason: "external-change".to_string(),
                        status: "syncing".to_string(),
                        changed_relative_paths: changed_relative_paths.clone(),
                        needs_manual_resync: false,
                        payload: None,
                        snapshot: None,
                        message: Some(starting_message),
                    },
                );

                let progress_app = app.clone();
                let progress_repo_path = repo_path.clone();
                let progress_changed_relative_paths = changed_relative_paths.clone();
                let progress_service = service.clone();
                match service.request_with_progress(
                    "refresh-paths",
                    json!({
                        "repo": repo_path.clone(),
                        "relative_paths": changed_relative_paths.clone(),
                        "top_n": WORKSPACE_SYNC_TOP_N,
                        "emit_progress": true,
                    }),
                    Some(move |progress: WorkerProgressPayload| {
                        if progress.status == "error" {
                            return;
                        }

                        progress_service.mark_syncing_with_note(progress.message.clone());
                        emit_workspace_sync_event(
                            &progress_app,
                            WorkspaceSyncEventPayload {
                                repo_path: progress_repo_path.clone(),
                                session_version: 0,
                                reason: "external-change".to_string(),
                                status: "syncing".to_string(),
                                changed_relative_paths: progress_changed_relative_paths.clone(),
                                needs_manual_resync: false,
                                payload: None,
                                snapshot: None,
                                message: Some(progress.message),
                            },
                        );
                    }),
                ) {
                    Ok(result) => {
                        let payload = result.get("payload").cloned();
                        let session_version = extract_session_version(&result, payload.as_ref());
                        let changed_relative_paths =
                            extract_string_vec(result.get("changed_relative_paths"))
                                .unwrap_or_default();
                        let snapshot = payload.as_ref().and_then(workspace_sync_snapshot);
                        service.mark_synced();
                        emit_workspace_sync_event(
                            &app,
                            WorkspaceSyncEventPayload {
                                repo_path: repo_path.clone(),
                                session_version,
                                reason: "external-change".to_string(),
                                status: "synced".to_string(),
                                changed_relative_paths,
                                needs_manual_resync: false,
                                payload,
                                snapshot,
                                message: None,
                            },
                        );
                    }
                    Err(err) => {
                        service.mark_manual_resync_required(err.clone());
                        emit_workspace_sync_event(
                            &app,
                            WorkspaceSyncEventPayload {
                                repo_path: repo_path.clone(),
                                session_version: 0,
                                reason: "external-change".to_string(),
                                status: "manual_resync_required".to_string(),
                                changed_relative_paths: changed_relative_paths.clone(),
                                needs_manual_resync: true,
                                payload: None,
                                snapshot: None,
                                message: Some(err),
                            },
                        );
                        break;
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
}

fn spawn_bridge_process() -> Result<BridgeProcess, String> {
    let workspace_root = workspace_root()?;
    let python_command = resolve_python_command();
    let python_path = python_path(&workspace_root)?;
    let mut child = Command::new(&python_command)
        .current_dir(&workspace_root)
        .env("PYTHONPATH", python_path)
        .env("PYTHONUNBUFFERED", "1")
        .arg("-m")
        .arg("helm.ui.desktop_bridge")
        .arg("serve")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| format!("Unable to launch {}: {}", python_command, err))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Unable to capture the Python bridge stdin.".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Unable to capture the Python bridge stdout.".to_string())?;

    Ok(BridgeProcess {
        child,
        stdin: BufWriter::new(stdin),
        stdout: BufReader::new(stdout),
        next_request_id: 1,
    })
}

fn send_bridge_request(
    bridge: &mut BridgeProcess,
    command: &str,
    params: Value,
    mut on_progress: Option<&mut dyn FnMut(WorkerProgressPayload)>,
) -> Result<Value, String> {
    let request_id = bridge.next_request_id;
    bridge.next_request_id += 1;
    let request = json!({
        "id": request_id,
        "command": command,
        "params": params,
    });

    serde_json::to_writer(&mut bridge.stdin, &request)
        .map_err(|err| format!("Unable to encode the Python bridge request: {}", err))?;
    bridge
        .stdin
        .write_all(b"\n")
        .map_err(|err| format!("Unable to write the Python bridge request: {}", err))?;
    bridge
        .stdin
        .flush()
        .map_err(|err| format!("Unable to flush the Python bridge request: {}", err))?;

    loop {
        let mut response_line = String::new();
        let bytes = bridge
            .stdout
            .read_line(&mut response_line)
            .map_err(|err| format!("Unable to read the Python bridge response: {}", err))?;
        if bytes == 0 {
            return Err("Python bridge closed unexpectedly.".to_string());
        }

        let response: WorkerResponse = serde_json::from_str(response_line.trim())
            .map_err(|err| format!("Unable to decode the Python bridge response: {}", err))?;
        if response.id != Some(request_id) {
            return Err("Python bridge response id did not match the request.".to_string());
        }

        if response.event.as_deref() == Some("progress") {
            if let Some(callback) = on_progress.as_mut() {
                let payload = response.payload.ok_or_else(|| {
                    "Python bridge progress frame was missing a payload.".to_string()
                })?;
                let progress: WorkerProgressPayload =
                    serde_json::from_value(payload).map_err(|err| {
                        format!("Unable to decode the Python bridge progress frame: {}", err)
                    })?;
                callback(progress);
            }
            continue;
        }

        if response.ok == Some(true) {
            return response
                .result
                .ok_or_else(|| "Python bridge returned no result payload.".to_string());
        }

        return Err(response
            .error
            .unwrap_or_else(|| "Python bridge returned an unknown error.".to_string()));
    }
}

fn collect_relevant_relative_paths(repo_root: &Path, event: &Event) -> BTreeSet<String> {
    if !is_relevant_watch_event_kind(&event.kind) {
        return BTreeSet::new();
    }

    event.paths.iter().fold(BTreeSet::new(), |mut paths, path| {
        if let Some(relative_path) = normalize_relevant_change_path(repo_root, path) {
            paths.insert(relative_path);
        }
        paths
    })
}

fn watch_event_requires_manual_resync(event: &Event) -> bool {
    event.need_rescan()
}

fn is_relevant_watch_event_kind(kind: &EventKind) -> bool {
    matches!(
        kind,
        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
    )
}

fn normalize_relevant_change_path(repo_root: &Path, path: &Path) -> Option<String> {
    let absolute_path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        repo_root.join(path)
    };
    let relative_path = absolute_path.strip_prefix(repo_root).ok()?;
    if relative_path
        .components()
        .any(|component| matches_ignored_watch_dir(component))
    {
        return None;
    }

    let normalized = normalize_path(relative_path);
    if normalized.is_empty() {
        return None;
    }
    Some(normalized)
}

fn matches_ignored_watch_dir(component: Component<'_>) -> bool {
    let Component::Normal(name) = component else {
        return false;
    };
    let Some(value) = name.to_str() else {
        return false;
    };
    IGNORED_WATCH_DIRS.contains(&value)
}

fn normalize_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn extract_string_vec(value: Option<&Value>) -> Option<Vec<String>> {
    value.and_then(Value::as_array).map(|items| {
        items
            .iter()
            .filter_map(|item| item.as_str().map(ToOwned::to_owned))
            .collect()
    })
}

fn extract_session_version(result: &Value, payload: Option<&Value>) -> u64 {
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

fn workspace_sync_snapshot(payload: &Value) -> Option<WorkspaceSyncSnapshot> {
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

fn emit_index_progress_event(app: &AppHandle<Wry>, payload: IndexProgressEventPayload) {
    let _ = app.emit(INDEX_PROGRESS_EVENT, payload);
}

fn emit_workspace_sync_event(app: &AppHandle<Wry>, payload: WorkspaceSyncEventPayload) {
    let _ = app.emit(WORKSPACE_SYNC_EVENT, payload);
}

fn backend_note(sync_state: &LiveSyncState) -> String {
    match sync_state.sync_state.as_str() {
        "syncing" => sync_state
            .sync_note
            .clone()
            .unwrap_or_else(|| "Applying external repo changes to the live workspace.".to_string()),
        "synced" => "Watching the active repo for workspace changes.".to_string(),
        "manual_resync_required" => {
            "Live sync needs a manual reindex to recover the workspace session.".to_string()
        }
        "error" => "Live sync encountered an error.".to_string(),
        _ => "Persistent Python bridge is ready. Open a repo to enable live sync.".to_string(),
    }
}

#[tauri::command]
fn backend_health(service: State<'_, BackendService>) -> Result<BackendHealth, String> {
    let workspace_root = workspace_root()?;
    let python_command = resolve_python_command();
    let output = Command::new(&python_command)
        .arg("--version")
        .output()
        .map_err(|err| format!("Unable to launch {}: {}", python_command, err))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("{} exited unsuccessfully", python_command)
        } else {
            stderr
        });
    }

    let sync_state = service.health_snapshot();
    Ok(BackendHealth {
        mode: "live".to_string(),
        python_command,
        workspace_root: workspace_root.display().to_string(),
        available: true,
        note: backend_note(&sync_state),
        live_sync_enabled: sync_state.live_sync_enabled,
        sync_state: sync_state.sync_state,
        last_sync_error: sync_state.last_sync_error,
    })
}

#[tauri::command]
fn scan_repo_payload(
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
fn graph_view(
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
fn flow_view(
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
fn apply_structural_edit(
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
fn reveal_source(
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
fn editable_node_source(
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
fn save_node_source(
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
fn parse_flow_expression(
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
fn apply_backend_undo(
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
fn read_repo_graph_layout(
    active_repo: State<'_, ActiveRepoBoundary>,
    repo_path: String,
    view_key: String,
) -> Result<StoredGraphViewLayout, String> {
    let repo_root = active_repo.command_repo_root(&repo_path)?;
    let layouts = read_repo_graph_layouts(&repo_root)?;
    Ok(layouts.views.get(&view_key).cloned().unwrap_or_default())
}

#[tauri::command]
fn write_repo_graph_layout(
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
fn read_repo_file(
    active_repo: State<'_, ActiveRepoBoundary>,
    repo_path: String,
    relative_path: String,
) -> Result<String, String> {
    let target = active_repo.resolve_existing_target(&repo_path, &relative_path)?;
    fs::read_to_string(&target.target_path)
        .map_err(|err| format!("Unable to read {}: {}", target.relative_path, err))
}

#[tauri::command]
fn create_new_project(project_path: String) -> Result<NewProjectResult, String> {
    let path = validate_new_project_path(&project_path)?;
    create_python_package_project(&path)
}

#[tauri::command]
fn list_workspace_files(
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
fn read_workspace_file(
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
fn preview_workspace_file_operation(
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
fn create_workspace_entry(
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
fn save_workspace_file(
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
fn move_workspace_entry(
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
fn delete_workspace_entry(
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
fn open_repo_path_in_default_editor(
    active_repo: State<'_, ActiveRepoBoundary>,
    repo_path: String,
    relative_path: String,
) -> Result<(), String> {
    let target = active_repo.resolve_existing_target(&repo_path, &relative_path)?;
    open_path_in_default_editor(&target.target_path)
}

fn open_path_in_default_editor(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("File does not exist: {}", path.display()));
    }

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(path);
        command
    };

    #[cfg(target_os = "windows")]
    let mut command = {
        let display = path.display().to_string();
        let mut command = Command::new("cmd");
        command.args(["/C", "start", "", &display]);
        command
    };

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(path);
        command
    };

    command
        .status()
        .map_err(|err| format!("Unable to open {}: {}", path.display(), err))
        .and_then(|status| {
            if status.success() {
                Ok(())
            } else {
                Err(format!(
                    "Default editor command failed for {}",
                    path.display()
                ))
            }
        })
}

#[tauri::command]
fn reveal_repo_path_in_file_explorer(
    active_repo: State<'_, ActiveRepoBoundary>,
    repo_path: String,
    relative_path: String,
) -> Result<(), String> {
    let target = active_repo.resolve_existing_target(&repo_path, &relative_path)?;
    reveal_path_in_file_explorer(&target.target_path)
}

fn reveal_path_in_file_explorer(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("File does not exist: {}", path.display()));
    }

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.args(["-R"]).arg(path);
        command
    };

    #[cfg(target_os = "windows")]
    let mut command = {
        let display = path.display().to_string();
        let mut command = Command::new("explorer");
        command.arg(format!("/select,{}", display));
        command
    };

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        let target = if path.is_dir() {
            path.to_path_buf()
        } else {
            path.parent().unwrap_or(path).to_path_buf()
        };
        command.arg(target);
        command
    };

    command
        .status()
        .map_err(|err| format!("Unable to reveal {}: {}", path.display(), err))
        .and_then(|status| {
            if status.success() {
                Ok(())
            } else {
                Err(format!(
                    "File explorer command failed for {}",
                    path.display()
                ))
            }
        })
}

fn validate_new_project_path(project_path: &str) -> Result<PathBuf, String> {
    let trimmed_path = project_path.trim();
    if trimmed_path.is_empty() {
        return Err("Project path cannot be empty.".to_string());
    }
    if trimmed_path.contains('\0') {
        return Err("Project path cannot contain null bytes.".to_string());
    }

    let path = PathBuf::from(trimmed_path);
    if !path.is_absolute() {
        return Err("Project path must be absolute.".to_string());
    }
    if path.exists() {
        return Err(format!("Project folder already exists: {}", path.display()));
    }

    let file_name = path
        .file_name()
        .ok_or_else(|| "Project path must include a folder name.".to_string())?;
    let file_name_text = file_name
        .to_str()
        .ok_or_else(|| "Project folder name must be valid Unicode.".to_string())?
        .trim();
    if file_name_text.is_empty() || file_name_text == "." || file_name_text == ".." {
        return Err("Project folder name is not safe.".to_string());
    }

    let parent = path
        .parent()
        .ok_or_else(|| "Project path must include a parent folder.".to_string())?;
    let canonical_parent = parent.canonicalize().map_err(|err| {
        format!(
            "Unable to resolve project parent folder {}: {}",
            parent.display(),
            err
        )
    })?;
    if !canonical_parent.is_dir() {
        return Err(format!(
            "Parent path is not a folder: {}",
            canonical_parent.display()
        ));
    }

    Ok(canonical_parent.join(file_name))
}

fn create_python_package_project(project_path: &Path) -> Result<NewProjectResult, String> {
    let parent = project_path
        .parent()
        .ok_or_else(|| "Project path must include a parent folder.".to_string())?;
    if !parent.exists() {
        return Err(format!(
            "Parent folder does not exist: {}",
            parent.display()
        ));
    }
    if !parent.is_dir() {
        return Err(format!("Parent path is not a folder: {}", parent.display()));
    }
    if project_path.exists() {
        return Err(format!(
            "Project folder already exists: {}",
            project_path.display()
        ));
    }

    let project_name = project_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Project folder name must be valid Unicode.".to_string())?;
    let project_name = project_name.trim();
    if project_name.is_empty() {
        return Err("Project folder name cannot be empty.".to_string());
    }

    let package_name = sanitize_python_package_name(project_name);
    let temp_project_path = unique_temp_sibling(parent)?;
    fs::create_dir(&temp_project_path).map_err(|err| {
        format!(
            "Unable to create temporary project folder {}: {}",
            temp_project_path.display(),
            err
        )
    })?;

    let scaffold_result =
        write_python_package_scaffold(&temp_project_path, project_name, &package_name);
    if let Err(err) = scaffold_result {
        let _ = fs::remove_dir_all(&temp_project_path);
        return Err(err);
    }

    if let Err(err) = fs::rename(&temp_project_path, project_path) {
        let _ = fs::remove_dir_all(&temp_project_path);
        return Err(format!(
            "Unable to finalize project folder {}: {}",
            project_path.display(),
            err
        ));
    }

    Ok(NewProjectResult {
        project_path: project_path
            .canonicalize()
            .unwrap_or_else(|_| project_path.to_path_buf())
            .to_string_lossy()
            .into_owned(),
        package_name,
    })
}

fn write_python_package_scaffold(
    project_path: &Path,
    project_name: &str,
    package_name: &str,
) -> Result<(), String> {
    let package_dir = project_path.join("src").join(package_name);
    let tests_dir = project_path.join("tests");
    fs::create_dir_all(&package_dir).map_err(|err| {
        format!(
            "Unable to create package folder {}: {}",
            package_dir.display(),
            err
        )
    })?;
    fs::create_dir_all(&tests_dir).map_err(|err| {
        format!(
            "Unable to create tests folder {}: {}",
            tests_dir.display(),
            err
        )
    })?;

    let distribution_name = package_name.replace('_', "-");
    write_project_file(
        &project_path.join("README.md"),
        format!(
            "# {}\n\nA Python project created with H.E.L.M.\n",
            project_name
        ),
    )?;
    write_project_file(
        &project_path.join(".gitignore"),
        ".venv/\n__pycache__/\n.pytest_cache/\n*.py[cod]\ndist/\nbuild/\n*.egg-info/\n.helm/recovery/\n".to_string(),
    )?;
    write_project_file(
        &project_path.join("pyproject.toml"),
        format!(
            "[build-system]\n\
             requires = [\"setuptools>=61\"]\n\
             build-backend = \"setuptools.build_meta\"\n\n\
             [project]\n\
             name = \"{}\"\n\
             version = \"0.1.0\"\n\
             description = \"A Python project created with H.E.L.M.\"\n\
             readme = \"README.md\"\n\
             requires-python = \">=3.9\"\n\n\
             [tool.setuptools]\n\
             package-dir = {{ \"\" = \"src\" }}\n\n\
             [tool.setuptools.packages.find]\n\
             where = [\"src\"]\n",
            distribution_name
        ),
    )?;
    write_project_file(
        &package_dir.join("__init__.py"),
        "from .main import greet\n\n__all__ = [\"greet\"]\n".to_string(),
    )?;
    write_project_file(
        &package_dir.join("main.py"),
        r#"def greet(name: str = "world") -> str:
    return f"Hello, {name}!"


def main() -> None:
    print(greet())


if __name__ == "__main__":
    main()
"#
        .to_string(),
    )?;
    write_project_file(
        &tests_dir.join("test_smoke.py"),
        format!(
            "from {}.main import greet\n\n\n\
def test_greet_returns_name():\n\
    assert greet(\"H.E.L.M.\") == \"Hello, H.E.L.M.!\"\n",
            package_name
        ),
    )?;

    Ok(())
}

fn write_project_file(path: &Path, content: String) -> Result<(), String> {
    atomic_write_text(path, &content)
}

fn atomic_write_text(path: &Path, content: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Path must include a parent folder: {}", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|err| format!("Unable to create {}: {}", parent.display(), err))?;

    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("file");
    let temp_path = unique_temp_file_path(parent, file_name)?;
    let write_result = (|| -> Result<(), String> {
        let mut temp_file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .map_err(|err| format!("Unable to create {}: {}", temp_path.display(), err))?;
        temp_file
            .write_all(content.as_bytes())
            .map_err(|err| format!("Unable to write {}: {}", temp_path.display(), err))?;
        temp_file
            .sync_all()
            .map_err(|err| format!("Unable to sync {}: {}", temp_path.display(), err))?;
        drop(temp_file);
        replace_file(&temp_path, path)?;
        sync_parent_directory(parent);
        Ok(())
    })();

    if write_result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }

    write_result
}

fn replace_file(temp_path: &Path, target_path: &Path) -> Result<(), String> {
    replace_file_platform(temp_path, target_path).map_err(|err| {
        format!(
            "Unable to replace {} with {}: {}",
            target_path.display(),
            temp_path.display(),
            err
        )
    })
}

#[cfg(not(target_os = "windows"))]
fn replace_file_platform(temp_path: &Path, target_path: &Path) -> std::io::Result<()> {
    fs::rename(temp_path, target_path)
}

#[cfg(target_os = "windows")]
fn replace_file_platform(temp_path: &Path, target_path: &Path) -> std::io::Result<()> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    fn wide_null(value: &OsStr) -> Vec<u16> {
        value.encode_wide().chain(std::iter::once(0)).collect()
    }

    let from = wide_null(temp_path.as_os_str());
    let to = wide_null(target_path.as_os_str());
    let replaced = unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if replaced == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn unique_temp_file_path(parent: &Path, file_name: &str) -> Result<PathBuf, String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| format!("Unable to read system time: {}", err))?
        .as_nanos();
    let process_id = std::process::id();
    for attempt in 0..100 {
        let candidate = parent.join(format!(
            ".{}.helm-tmp-{}-{}-{}",
            file_name, process_id, timestamp, attempt
        ));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(format!(
        "Unable to reserve a temporary file path in {}",
        parent.display()
    ))
}

fn unique_temp_sibling(parent: &Path) -> Result<PathBuf, String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| format!("Unable to read system time: {}", err))?
        .as_nanos();
    let process_id = std::process::id();
    for attempt in 0..100 {
        let candidate = parent.join(format!(
            ".helm-new-project-{}-{}-{}",
            process_id, timestamp, attempt
        ));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(format!(
        "Unable to reserve a temporary project folder in {}",
        parent.display()
    ))
}

#[cfg(not(target_os = "windows"))]
fn sync_parent_directory(parent: &Path) {
    if let Ok(directory) = fs::File::open(parent) {
        let _ = directory.sync_all();
    }
}

#[cfg(target_os = "windows")]
fn sync_parent_directory(_parent: &Path) {
    // Rust stdlib does not expose a direct portable directory fsync on Windows.
}

fn sanitize_python_package_name(name: &str) -> String {
    let mut normalized = String::new();
    let mut last_was_underscore = false;

    for character in name.trim().chars() {
        if character.is_ascii_alphanumeric() {
            normalized.push(character.to_ascii_lowercase());
            last_was_underscore = false;
            continue;
        }

        if !last_was_underscore && !normalized.is_empty() {
            normalized.push('_');
            last_was_underscore = true;
        }
    }

    let trimmed = normalized.trim_matches('_').to_string();
    let mut candidate = if trimmed.is_empty() {
        "project".to_string()
    } else {
        trimmed
    };

    if !candidate
        .chars()
        .next()
        .map(|character| character.is_ascii_alphabetic())
        .unwrap_or(false)
        || is_python_keyword(&candidate)
    {
        candidate = format!("project_{}", candidate);
    }

    candidate
}

fn is_python_keyword(value: &str) -> bool {
    matches!(
        value,
        "false"
            | "none"
            | "true"
            | "and"
            | "as"
            | "assert"
            | "async"
            | "await"
            | "break"
            | "class"
            | "continue"
            | "def"
            | "del"
            | "elif"
            | "else"
            | "except"
            | "finally"
            | "for"
            | "from"
            | "global"
            | "if"
            | "import"
            | "in"
            | "is"
            | "lambda"
            | "nonlocal"
            | "not"
            | "or"
            | "pass"
            | "raise"
            | "return"
            | "try"
            | "while"
            | "with"
            | "yield"
    )
}

#[tauri::command]
fn sync_graph_view_menu_state(
    state: tauri::State<'_, GraphViewMenuState>,
    state_json: String,
) -> Result<(), String> {
    let payload: GraphViewMenuSyncPayload = serde_json::from_str(&state_json)
        .map_err(|err| format!("Unable to decode graph view menu state: {}", err))?;

    sync_graph_view_menu_items(state.inner(), &payload)
}

fn python_path(workspace_root: &Path) -> Result<String, String> {
    let src_root = workspace_root.join("src");
    let vendor_root = workspace_root.join(".vendor").join("libcst");
    let joined = env::join_paths([src_root, vendor_root])
        .map_err(|err| format!("Unable to build PYTHONPATH: {}", err))?;
    joined
        .into_string()
        .map_err(|_| "Unable to encode PYTHONPATH for the Python bridge.".to_string())
}

fn resolve_python_command() -> String {
    std::env::var("HELM_PYTHON_BIN").unwrap_or_else(|_| "python3".to_string())
}

fn workspace_root() -> Result<PathBuf, String> {
    if let Ok(explicit_root) = std::env::var("HELM_WORKSPACE_ROOT") {
        let path = PathBuf::from(explicit_root);
        if path.exists() {
            return Ok(path);
        }
        return Err(format!(
            "HELM_WORKSPACE_ROOT does not exist: {}",
            path.display()
        ));
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let root = manifest_dir
        .ancestors()
        .nth(3)
        .map(Path::to_path_buf)
        .ok_or_else(|| "Unable to resolve workspace root.".to_string())?;

    if !root.exists() {
        return Err(format!(
            "Resolved workspace root does not exist: {}",
            root.display()
        ));
    }

    Ok(root)
}

fn repo_graph_layout_path(repo_root: &Path) -> Result<PathBuf, String> {
    let layout_path = repo_root.join(".helm").join("graph-layouts.v1.json");
    if layout_path.exists() {
        let canonical_layout = layout_path.canonicalize().map_err(|err| {
            format!(
                "Unable to resolve graph layout file {}: {}",
                layout_path.display(),
                err
            )
        })?;
        ensure_canonical_path_inside_repo(&canonical_layout, repo_root, "Graph layout file")?;
        return Ok(layout_path);
    }

    let mut nearest_parent = layout_path
        .parent()
        .ok_or_else(|| "Graph layout path must include a parent folder.".to_string())?
        .to_path_buf();
    while !nearest_parent.exists() {
        let parent = nearest_parent
            .parent()
            .ok_or_else(|| "Unable to resolve graph layout parent folder.".to_string())?;
        nearest_parent = parent.to_path_buf();
    }

    let canonical_parent = nearest_parent.canonicalize().map_err(|err| {
        format!(
            "Unable to resolve graph layout parent folder {}: {}",
            nearest_parent.display(),
            err
        )
    })?;
    ensure_canonical_path_inside_repo(&canonical_parent, repo_root, "Graph layout parent folder")?;
    Ok(layout_path)
}

fn read_repo_graph_layouts(repo_root: &Path) -> Result<RepoGraphLayouts, String> {
    let layout_path = repo_graph_layout_path(repo_root)?;
    if !layout_path.exists() {
        return Ok(RepoGraphLayouts::default());
    }

    let raw = fs::read_to_string(&layout_path)
        .map_err(|err| format!("Unable to read {}: {}", layout_path.display(), err))?;
    let parsed: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    Ok(normalize_repo_graph_layouts(parsed))
}

fn write_repo_graph_layouts(repo_root: &Path, layouts: &RepoGraphLayouts) -> Result<(), String> {
    let layout_path = repo_graph_layout_path(repo_root)?;
    if let Some(parent) = layout_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Unable to create {}: {}", parent.display(), err))?;
    }

    let serialized = serde_json::to_string_pretty(layouts)
        .map_err(|err| format!("Unable to encode graph layout file: {}", err))?;
    atomic_write_text(&layout_path, &serialized)
}

fn normalize_repo_graph_layouts(value: Value) -> RepoGraphLayouts {
    let mut layouts = RepoGraphLayouts::default();
    let Some(views) = value.get("views").and_then(Value::as_object) else {
        return layouts;
    };

    views.iter().for_each(|(view_key, raw_layout)| {
        layouts
            .views
            .insert(view_key.clone(), normalize_graph_view_layout(raw_layout));
    });

    layouts
}

fn normalize_graph_view_layout(value: &Value) -> StoredGraphViewLayout {
    if let Some(object) = value.as_object() {
        if object.contains_key("nodes")
            || object.contains_key("reroutes")
            || object.contains_key("pinnedNodeIds")
            || object.contains_key("groups")
        {
            return StoredGraphViewLayout {
                nodes: normalize_node_layout(object.get("nodes")),
                reroutes: normalize_reroutes(object.get("reroutes")),
                pinned_node_ids: normalize_pinned_node_ids(object.get("pinnedNodeIds")),
                groups: normalize_groups(object.get("groups")),
            };
        }
    }

    StoredGraphViewLayout {
        nodes: normalize_node_layout(Some(value)),
        reroutes: Vec::new(),
        pinned_node_ids: Vec::new(),
        groups: Vec::new(),
    }
}

fn normalize_node_layout(value: Option<&Value>) -> StoredGraphNodeLayout {
    let mut layout = StoredGraphNodeLayout::new();
    let Some(entries) = value.and_then(Value::as_object) else {
        return layout;
    };

    entries.iter().for_each(|(node_id, position)| {
        let Some(object) = position.as_object() else {
            return;
        };

        let Some(x) = object.get("x").and_then(Value::as_f64) else {
            return;
        };
        let Some(y) = object.get("y").and_then(Value::as_f64) else {
            return;
        };

        layout.insert(node_id.clone(), StoredGraphNodePosition { x, y });
    });

    layout
}

fn normalize_reroutes(value: Option<&Value>) -> Vec<StoredGraphRerouteNode> {
    let Some(items) = value.and_then(Value::as_array) else {
        return Vec::new();
    };

    items
        .iter()
        .filter_map(|item| {
            let object = item.as_object()?;
            let id = object.get("id")?.as_str()?.to_string();
            let edge_id = object.get("edgeId")?.as_str()?.to_string();
            let order = usize::try_from(object.get("order")?.as_u64()?).ok()?;
            let x = object.get("x")?.as_f64()?;
            let y = object.get("y")?.as_f64()?;

            Some(StoredGraphRerouteNode {
                id,
                edge_id,
                order,
                x,
                y,
            })
        })
        .collect()
}

fn normalize_pinned_node_ids(value: Option<&Value>) -> Vec<String> {
    let Some(items) = value.and_then(Value::as_array) else {
        return Vec::new();
    };

    items
        .iter()
        .filter_map(|item| item.as_str().map(ToOwned::to_owned))
        .collect()
}

fn normalize_groups(value: Option<&Value>) -> Vec<StoredGraphGroup> {
    let Some(items) = value.and_then(Value::as_array) else {
        return Vec::new();
    };

    items
        .iter()
        .filter_map(|item| {
            let object = item.as_object()?;
            let id = object.get("id")?.as_str()?.to_string();
            let title = object.get("title")?.as_str()?.to_string();
            let member_node_ids = object
                .get("memberNodeIds")?
                .as_array()?
                .iter()
                .filter_map(|member| member.as_str().map(ToOwned::to_owned))
                .collect();

            Some(StoredGraphGroup {
                id,
                title,
                member_node_ids,
            })
        })
        .collect()
}

fn set_graph_view_menu_item(
    item: &Mutex<Option<CheckMenuItem<Wry>>>,
    checked: bool,
) -> Result<(), String> {
    let handle = item
        .lock()
        .map_err(|_| "Unable to lock graph view menu state.".to_string())?;

    if let Some(item) = handle.as_ref() {
        item.set_checked(checked)
            .map_err(|err| format!("Unable to update graph view menu item: {}", err))?;
    }

    Ok(())
}

fn sync_graph_view_menu_items(
    state: &GraphViewMenuState,
    payload: &GraphViewMenuSyncPayload,
) -> Result<(), String> {
    set_graph_view_menu_item(&state.show_calls, payload.include_calls)?;
    set_graph_view_menu_item(&state.show_imports, payload.include_imports)?;
    set_graph_view_menu_item(&state.show_defines, payload.include_defines)?;
    set_graph_view_menu_item(&state.highlight_path, payload.highlight_graph_path)?;
    set_graph_view_menu_item(&state.show_edge_labels, payload.show_edge_labels)?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn build_macos_app_menu(
    app: &AppHandle<Wry>,
    state: &GraphViewMenuState,
) -> tauri::Result<Menu<Wry>> {
    let pkg_info = app.package_info();
    let config = app.config();
    let about_metadata = AboutMetadata {
        name: Some(pkg_info.name.clone()),
        version: Some(pkg_info.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config
            .bundle
            .publisher
            .clone()
            .map(|publisher| vec![publisher]),
        ..Default::default()
    };

    let show_calls = CheckMenuItem::with_id(
        app,
        MENU_ID_SHOW_CALLS,
        "Show Calls",
        true,
        true,
        None::<&str>,
    )?;
    let show_imports = CheckMenuItem::with_id(
        app,
        MENU_ID_SHOW_IMPORTS,
        "Show Imports",
        true,
        true,
        None::<&str>,
    )?;
    let show_defines = CheckMenuItem::with_id(
        app,
        MENU_ID_SHOW_DEFINES,
        "Show Defines",
        true,
        true,
        None::<&str>,
    )?;
    let highlight_path = CheckMenuItem::with_id(
        app,
        MENU_ID_HIGHLIGHT_PATH,
        "Highlight Current Path",
        true,
        true,
        None::<&str>,
    )?;
    let show_edge_labels = CheckMenuItem::with_id(
        app,
        MENU_ID_SHOW_EDGE_LABELS,
        "Show Edge Labels",
        true,
        true,
        None::<&str>,
    )?;
    let zoom_in = MenuItem::with_id(
        app,
        MENU_ID_ZOOM_IN,
        "Zoom In",
        true,
        Some("CmdOrCtrl+Shift+="),
    )?;
    let undo = MenuItem::with_id(app, MENU_ID_UNDO, "Undo", true, Some("CmdOrCtrl+Z"))?;
    let redo = MenuItem::with_id(app, MENU_ID_REDO, "Redo", true, Some("CmdOrCtrl+Shift+Z"))?;
    let preferences = MenuItem::with_id(
        app,
        MENU_ID_PREFERENCES,
        "Preferences...",
        true,
        Some("CmdOrCtrl+,"),
    )?;
    let zoom_out = MenuItem::with_id(app, MENU_ID_ZOOM_OUT, "Zoom Out", true, Some("CmdOrCtrl+-"))?;
    let zoom_reset = MenuItem::with_id(
        app,
        MENU_ID_ZOOM_RESET,
        "Actual Size",
        true,
        Some("CmdOrCtrl+0"),
    )?;
    let new_project = MenuItem::with_id(
        app,
        MENU_ID_NEW_PROJECT,
        "New Project...",
        true,
        Some("CmdOrCtrl+Shift+N"),
    )?;

    if let Ok(mut item) = state.show_calls.lock() {
        *item = Some(show_calls.clone());
    }
    if let Ok(mut item) = state.show_imports.lock() {
        *item = Some(show_imports.clone());
    }
    if let Ok(mut item) = state.show_defines.lock() {
        *item = Some(show_defines.clone());
    }
    if let Ok(mut item) = state.highlight_path.lock() {
        *item = Some(highlight_path.clone());
    }
    if let Ok(mut item) = state.show_edge_labels.lock() {
        *item = Some(show_edge_labels.clone());
    }

    Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                pkg_info.name.clone(),
                true,
                &[
                    &PredefinedMenuItem::about(app, None, Some(about_metadata))?,
                    &PredefinedMenuItem::separator(app)?,
                    &preferences,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "File",
                true,
                &[
                    &new_project,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::close_window(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &undo,
                    &redo,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "View",
                true,
                &[
                    &zoom_in,
                    &zoom_out,
                    &zoom_reset,
                    &PredefinedMenuItem::separator(app)?,
                    &show_calls,
                    &show_imports,
                    &show_defines,
                    &PredefinedMenuItem::separator(app)?,
                    &highlight_path,
                    &show_edge_labels,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::fullscreen(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "Window",
                true,
                &[
                    &PredefinedMenuItem::minimize(app, None)?,
                    &PredefinedMenuItem::maximize(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::close_window(app, None)?,
                ],
            )?,
            &Submenu::with_items(app, "Help", true, &[])?,
        ],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, Flag, ModifyKind, RemoveKind};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_test_project_parent(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after UNIX_EPOCH")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "helm-desktop-{}-{}-{}",
            label,
            std::process::id(),
            nonce
        ))
    }

    fn active_boundary_for_repo(repo_root: &Path) -> ActiveRepoBoundary {
        let boundary = ActiveRepoBoundary::default();
        boundary
            .activate_repo_path(repo_root.to_str().expect("test path should be unicode"))
            .expect("test repo should activate");
        boundary
    }

    #[test]
    fn active_repo_boundary_accepts_existing_repo_relative_targets() {
        let repo_root = unique_test_project_parent("boundary-existing");
        let file_path = repo_root.join("src/app.py");
        fs::create_dir_all(file_path.parent().expect("file should have parent"))
            .expect("test directory should be created");
        fs::write(&file_path, "print('hello')\n").expect("test file should be written");
        let boundary = active_boundary_for_repo(&repo_root);

        let resolved = boundary
            .resolve_existing_target(
                repo_root.to_str().expect("test path should be unicode"),
                "src/app.py",
            )
            .expect("repo-relative file should resolve");

        assert_eq!(resolved.relative_path, "src/app.py");
        assert_eq!(
            resolved.target_path,
            file_path
                .canonicalize()
                .expect("test file should canonicalize")
        );
        fs::remove_dir_all(repo_root).expect("test repo should be removed");
    }

    #[test]
    fn active_repo_boundary_rejects_unsafe_relative_targets_and_repo_mismatches() {
        let repo_root = unique_test_project_parent("boundary-rejects");
        let other_root = unique_test_project_parent("boundary-other");
        fs::create_dir_all(repo_root.join("src")).expect("test repo should be created");
        fs::create_dir_all(&other_root).expect("other repo should be created");
        fs::write(repo_root.join("src/app.py"), "print('hello')\n")
            .expect("test file should be written");
        let boundary = active_boundary_for_repo(&repo_root);
        let repo = repo_root.to_str().expect("test path should be unicode");

        for relative_path in [
            "",
            ".",
            "..",
            "../secret.txt",
            "/tmp/secret.txt",
            "src//app.py",
        ] {
            assert!(
                boundary
                    .resolve_existing_target(repo, relative_path)
                    .is_err(),
                "{relative_path:?} should be rejected"
            );
        }

        let mismatch = boundary
            .resolve_existing_target(
                other_root.to_str().expect("test path should be unicode"),
                "src/app.py",
            )
            .expect_err("stale repo paths should be rejected");
        assert!(mismatch.contains("active repository"));

        fs::remove_dir_all(repo_root).expect("test repo should be removed");
        fs::remove_dir_all(other_root).expect("other repo should be removed");
    }

    #[test]
    fn active_repo_boundary_accepts_creatable_targets_under_existing_repo_parent() {
        let repo_root = unique_test_project_parent("boundary-creatable");
        fs::create_dir_all(repo_root.join("src")).expect("test repo should be created");
        let boundary = active_boundary_for_repo(&repo_root);

        let resolved = boundary
            .resolve_creatable_target(
                repo_root.to_str().expect("test path should be unicode"),
                "src/new/module.py",
            )
            .expect("creatable target should resolve through nearest existing parent");

        assert_eq!(resolved.relative_path, "src/new/module.py");
        assert_eq!(
            resolved.target_path,
            repo_root
                .canonicalize()
                .expect("test repo should canonicalize")
                .join("src")
                .join("new")
                .join("module.py")
        );
        fs::remove_dir_all(repo_root).expect("test repo should be removed");
    }

    #[test]
    fn graph_layout_path_stays_under_helm_directory_in_active_repo() {
        let repo_root = unique_test_project_parent("layout-path");
        fs::create_dir_all(&repo_root).expect("test repo should be created");
        let canonical_repo = repo_root
            .canonicalize()
            .expect("test repo should canonicalize");

        let layout_path =
            repo_graph_layout_path(&canonical_repo).expect("layout path should stay inside repo");

        assert_eq!(
            layout_path,
            canonical_repo.join(".helm").join("graph-layouts.v1.json")
        );
        fs::remove_dir_all(repo_root).expect("test repo should be removed");
    }

    #[test]
    fn atomic_write_text_replaces_existing_file_without_temp_leftovers() {
        let repo_root = unique_test_project_parent("atomic-write");
        fs::create_dir_all(&repo_root).expect("test repo should be created");
        let target_path = repo_root.join("notes.txt");
        fs::write(&target_path, "old\n").expect("test file should be written");

        atomic_write_text(&target_path, "new\n").expect("atomic write should replace content");

        assert_eq!(
            fs::read_to_string(&target_path).expect("test file should be readable"),
            "new\n"
        );
        let leftovers = fs::read_dir(&repo_root)
            .expect("test repo should be readable")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains("helm-tmp"))
            .count();
        assert_eq!(leftovers, 0);
        fs::remove_dir_all(repo_root).expect("test repo should be removed");
    }

    #[test]
    fn write_repo_graph_layouts_persists_with_atomic_helper() {
        let repo_root = unique_test_project_parent("layout-write");
        fs::create_dir_all(&repo_root).expect("test repo should be created");
        let canonical_repo = repo_root
            .canonicalize()
            .expect("test repo should canonicalize");
        let mut layouts = RepoGraphLayouts::default();
        let mut view = StoredGraphViewLayout::default();
        view.nodes.insert(
            "node:service".to_string(),
            StoredGraphNodePosition { x: 1.0, y: 2.0 },
        );
        layouts.views.insert("repo".to_string(), view);

        write_repo_graph_layouts(&canonical_repo, &layouts).expect("layout write should succeed");

        let layout_path = canonical_repo.join(".helm").join("graph-layouts.v1.json");
        assert!(layout_path.is_file());
        let decoded = read_repo_graph_layouts(&canonical_repo).expect("layout file should decode");
        assert_eq!(
            decoded
                .views
                .get("repo")
                .and_then(|view| view.nodes.get("node:service"))
                .map(|position| (position.x, position.y)),
            Some((1.0, 2.0))
        );
        let leftovers = fs::read_dir(
            layout_path
                .parent()
                .expect("layout path should have parent"),
        )
        .expect("layout parent should be readable")
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().contains("helm-tmp"))
        .count();
        assert_eq!(leftovers, 0);
        fs::remove_dir_all(repo_root).expect("test repo should be removed");
    }

    #[cfg(unix)]
    #[test]
    fn active_repo_boundary_rejects_symlink_escapes() {
        use std::os::unix::fs::symlink;

        let repo_root = unique_test_project_parent("boundary-symlink");
        let outside_root = unique_test_project_parent("boundary-outside");
        fs::create_dir_all(&repo_root).expect("test repo should be created");
        fs::create_dir_all(&outside_root).expect("outside dir should be created");
        fs::write(outside_root.join("secret.txt"), "secret\n").expect("outside file should exist");
        symlink(&outside_root, repo_root.join("linked"))
            .expect("test symlink should be created on unix");
        symlink(
            outside_root.join("secret.txt"),
            repo_root.join("linked-file.txt"),
        )
        .expect("test file symlink should be created on unix");
        let boundary = active_boundary_for_repo(&repo_root);
        let repo = repo_root.to_str().expect("test path should be unicode");

        assert!(boundary
            .resolve_existing_target(repo, "linked/secret.txt")
            .is_err());
        assert!(boundary
            .resolve_creatable_target(repo, "linked/new.txt")
            .is_err());
        assert!(boundary
            .resolve_creatable_target(repo, "linked-file.txt")
            .is_err());

        fs::remove_dir_all(repo_root).expect("test repo should be removed");
        fs::remove_dir_all(outside_root).expect("outside dir should be removed");
    }

    #[test]
    fn sanitize_python_package_name_keeps_valid_identifiers() {
        assert_eq!(sanitize_python_package_name("Cool App"), "cool_app");
        assert_eq!(
            sanitize_python_package_name("123 Cool-App!"),
            "project_123_cool_app"
        );
        assert_eq!(sanitize_python_package_name("class"), "project_class");
        assert_eq!(sanitize_python_package_name("!!!"), "project");
    }

    #[test]
    fn create_python_package_project_writes_template_files() {
        let parent = unique_test_project_parent("scaffold");
        let project_path = parent.join("Cool App");
        fs::create_dir_all(&parent).expect("test parent should be created");

        let result = create_python_package_project(&project_path)
            .expect("project scaffold should be created");

        assert_eq!(result.package_name, "cool_app");
        assert!(project_path.join("README.md").is_file());
        assert!(project_path.join(".gitignore").is_file());
        assert!(project_path.join("pyproject.toml").is_file());
        assert!(project_path.join("src/cool_app/__init__.py").is_file());
        assert!(project_path.join("src/cool_app/main.py").is_file());
        assert!(project_path.join("tests/test_smoke.py").is_file());
        let gitignore = fs::read_to_string(project_path.join(".gitignore"))
            .expect(".gitignore should be readable");
        assert!(gitignore.contains(".helm/recovery/"));
        assert_eq!(helm_new_project_temp_sibling_count(&parent), 0);

        let main_source = fs::read_to_string(project_path.join("src/cool_app/main.py"))
            .expect("main.py should be readable");
        assert!(main_source.contains("def greet"));
        assert!(main_source.contains("return f\"Hello, {name}!\""));

        fs::remove_dir_all(parent).expect("test project should be removed");
    }

    fn helm_new_project_temp_sibling_count(parent: &Path) -> usize {
        fs::read_dir(parent)
            .expect("test parent should be readable")
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".helm-new-project-")
            })
            .count()
    }

    #[test]
    fn create_python_package_project_rejects_existing_folder() {
        let parent = unique_test_project_parent("existing");
        let project_path = parent.join("Existing App");
        fs::create_dir_all(&project_path).expect("existing project folder should be created");

        let error = create_python_package_project(&project_path)
            .expect_err("existing project folder should be rejected");

        assert!(error.contains("already exists"));
        fs::remove_dir_all(parent).expect("test project should be removed");
    }

    #[test]
    fn collect_relevant_relative_paths_keeps_workspace_files() {
        let repo_root = Path::new("/tmp/project");
        let mut event = Event::new(EventKind::Modify(ModifyKind::Any));
        event.paths = vec![
            repo_root.join("src/app.py"),
            repo_root.join("src/app.ts"),
            repo_root.join("notes.txt"),
        ];

        let changed = collect_relevant_relative_paths(repo_root, &event);

        assert_eq!(
            changed.into_iter().collect::<Vec<_>>(),
            vec![
                "notes.txt".to_string(),
                "src/app.py".to_string(),
                "src/app.ts".to_string(),
            ]
        );
    }

    #[test]
    fn collect_relevant_relative_paths_ignores_noise_and_outside_paths() {
        let repo_root = Path::new("/tmp/project");
        let mut event = Event::new(EventKind::Create(CreateKind::Any));
        event.paths = vec![
            repo_root.join(".git/index"),
            repo_root.join("node_modules/pkg/index.py"),
            repo_root.join("src/__pycache__/cached.py"),
            PathBuf::from("/tmp/elsewhere/service.py"),
            repo_root.join("README.md"),
            repo_root.join("src/service.py"),
        ];

        let changed = collect_relevant_relative_paths(repo_root, &event);

        assert_eq!(
            changed.into_iter().collect::<Vec<_>>(),
            vec!["README.md".to_string(), "src/service.py".to_string()]
        );
    }

    #[test]
    fn collect_relevant_relative_paths_accepts_removed_python_files() {
        let repo_root = Path::new("/tmp/project");
        let mut event = Event::new(EventKind::Remove(RemoveKind::Any));
        event.paths = vec![repo_root.join("src/deleted_module.py")];

        let changed = collect_relevant_relative_paths(repo_root, &event);

        assert_eq!(
            changed.into_iter().collect::<Vec<_>>(),
            vec!["src/deleted_module.py".to_string()]
        );
    }

    #[test]
    fn watch_event_requires_manual_resync_for_rescan_flags() {
        let mut event = Event::new(EventKind::Modify(ModifyKind::Any));
        event.attrs.set_flag(Flag::Rescan);

        assert!(watch_event_requires_manual_resync(&event));
    }

    #[test]
    fn watch_event_does_not_require_manual_resync_without_rescan_flag() {
        let event = Event::new(EventKind::Modify(ModifyKind::Any));

        assert!(!watch_event_requires_manual_resync(&event));
    }
}

fn main() {
    let builder = tauri::Builder::default()
        .manage(GraphViewMenuState::default())
        .manage(BackendService::default())
        .manage(ActiveRepoBoundary::default())
        .manage(ActiveRepoWatcher::default());
    #[cfg(target_os = "macos")]
    let builder = builder.menu(|app| {
        let menu_state = app.state::<GraphViewMenuState>();
        build_macos_app_menu(app, menu_state.inner())
    });

    builder
        .on_menu_event(|app, event| {
            let action = match event.id().as_ref() {
                MENU_ID_NEW_PROJECT => Some("new-project"),
                MENU_ID_UNDO => Some("undo"),
                MENU_ID_REDO => Some("redo"),
                MENU_ID_PREFERENCES => Some("preferences"),
                MENU_ID_ZOOM_IN => Some("zoom-in"),
                MENU_ID_ZOOM_OUT => Some("zoom-out"),
                MENU_ID_ZOOM_RESET => Some("zoom-reset"),
                MENU_ID_SHOW_CALLS => Some("toggle-calls"),
                MENU_ID_SHOW_IMPORTS => Some("toggle-imports"),
                MENU_ID_SHOW_DEFINES => Some("toggle-defines"),
                MENU_ID_HIGHLIGHT_PATH => Some("toggle-path-highlight"),
                MENU_ID_SHOW_EDGE_LABELS => Some("toggle-edge-labels"),
                _ => None,
            };

            if let Some(action) = action {
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
