use crate::bridge::{BackendService, WorkerProgressPayload};
use crate::events::{
    emit_workspace_sync_event, extract_session_version, extract_string_vec,
    workspace_sync_snapshot, WorkspaceSyncEventPayload,
};
use crate::repo_boundary::normalize_path;
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::json;
use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};
use std::sync::{mpsc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tauri::{AppHandle, Wry};

const WORKSPACE_SYNC_DEBOUNCE_MS: u64 = 250;
pub(crate) const WORKSPACE_SYNC_TOP_N: usize = 24;
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

#[derive(Default)]
pub(crate) struct ActiveRepoWatcher {
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
    pub(crate) fn watch_repo(
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

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, Flag, ModifyKind, RemoveKind};

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
