use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::env;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackendHealth {
    mode: String,
    python_command: String,
    workspace_root: String,
    available: bool,
    note: String,
    live_sync_enabled: bool,
    sync_state: String,
    last_sync_error: Option<String>,
}

#[derive(Clone, Deserialize)]
pub(crate) struct WorkerProgressPayload {
    pub(crate) stage: String,
    pub(crate) status: String,
    pub(crate) message: String,
    #[serde(default)]
    pub(crate) processed_modules: usize,
    #[serde(default)]
    pub(crate) total_modules: usize,
    #[serde(default)]
    pub(crate) symbol_count: usize,
    pub(crate) progress_percent: Option<usize>,
    pub(crate) error: Option<String>,
}

#[derive(Clone)]
pub(crate) struct LiveSyncState {
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
pub(crate) struct BackendService {
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
    pub(crate) fn request(&self, command: &str, params: Value) -> Result<Value, String> {
        self.request_with_progress(command, params, None::<fn(WorkerProgressPayload)>)
    }

    pub(crate) fn request_with_progress<F>(
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

    pub(crate) fn health_snapshot(&self) -> LiveSyncState {
        self.sync_state
            .lock()
            .map(|state| state.clone())
            .unwrap_or_default()
    }

    pub(crate) fn mark_synced(&self) {
        self.update_sync_state(true, "synced", None, None);
    }

    pub(crate) fn mark_syncing_with_note(&self, note: String) {
        self.update_sync_state(true, "syncing", None, Some(note));
    }

    pub(crate) fn mark_manual_resync_required(&self, message: String) {
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

fn python_path(workspace_root: &Path) -> Result<String, String> {
    let src_root = workspace_root.join("src");
    let joined = env::join_paths([src_root])
        .map_err(|err| format!("Unable to build PYTHONPATH: {}", err))?;
    joined
        .into_string()
        .map_err(|_| "Unable to encode PYTHONPATH for the Python bridge.".to_string())
}

pub(crate) fn resolve_python_command() -> String {
    std::env::var("HELM_PYTHON_BIN").unwrap_or_else(|_| "python3".to_string())
}

pub(crate) fn workspace_root() -> Result<PathBuf, String> {
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

pub(crate) fn backend_health(service: &BackendService) -> Result<BackendHealth, String> {
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
