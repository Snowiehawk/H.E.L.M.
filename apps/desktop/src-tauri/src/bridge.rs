use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::env;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};

static RESOURCE_DIR: OnceLock<PathBuf> = OnceLock::new();

pub(crate) fn set_resource_dir(path: PathBuf) {
    let _ = RESOURCE_DIR.set(path);
}

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

#[derive(Debug)]
enum BridgeReply {
    Success(Value),
    Rejected(String),
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
        let reply = retry_bridge_request(command, || {
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
            if result.is_err() {
                *process = None;
            }
            result
        })?;
        match reply {
            BridgeReply::Success(value) => Ok(value),
            BridgeReply::Rejected(error) => Err(error),
        }
    }
}

fn retry_bridge_request<T>(
    command: &str,
    mut operation: impl FnMut() -> Result<T, String>,
) -> Result<T, String> {
    // A worker may commit a mutation before its response pipe fails. Replaying
    // that request could insert twice or undo a different state. Only known
    // read/index operations may restart automatically; new commands fail closed.
    let attempts = if matches!(
        command,
        "health"
            | "scan"
            | "full-resync"
            | "refresh-paths"
            | "graph-view"
            | "flow-view"
            | "reveal-source"
            | "editable-source"
            | "parse-flow-expression"
            | "list-workspace-files"
            | "read-workspace-file"
            | "preview-workspace-file-operation"
    ) {
        2
    } else {
        1
    };
    let mut last_error = None;
    for _ in 0..attempts {
        match operation() {
            Ok(value) => return Ok(value),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| "Python bridge is unavailable.".to_string()))
}

fn spawn_bridge_process() -> Result<BridgeProcess, String> {
    let workspace_root = workspace_root()?;
    let python_command = resolve_python_command();
    let python_path = python_path(&workspace_root)?;
    let mut command = Command::new(&python_command);
    if std::env::var_os("HELM_PYTHON_BIN").is_none()
        && RESOURCE_DIR
            .get()
            .and_then(|path| packaged_python_command(path, std::env::consts::OS))
            .is_some()
    {
        command.arg("-I");
    }
    command
        .current_dir(&workspace_root)
        .env_remove("PYTHONHOME")
        .env_remove("PYTHONSTARTUP")
        .env("PYTHONPATH", &python_path)
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .env("PYTHONUNBUFFERED", "1")
        .arg("-B")
        .arg("-X")
        .arg("utf8")
        .arg("-c")
        // Embedded Python deliberately ignores PYTHONPATH. Supply the selected
        // backend explicitly, so relocated bundles and explicit overrides agree.
        .arg("import runpy,sys;sys.path.insert(0,sys.argv.pop(1));runpy.run_module('helm.ui.desktop_bridge',run_name='__main__')")
        .arg(workspace_root.join("src"))
        .arg("serve")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW; persistent stdio only.
    }
    let mut child = command
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
) -> Result<BridgeReply, String> {
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
                .map(BridgeReply::Success)
                .ok_or_else(|| "Python bridge returned no result payload.".to_string());
        }

        if response.ok == Some(false) {
            return Ok(BridgeReply::Rejected(response.error.unwrap_or_else(|| {
                "Python bridge returned an unknown error.".to_string()
            })));
        }
        return Err("Python bridge response had no result status.".to_string());
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
    if let Ok(explicit) = std::env::var("HELM_PYTHON_BIN") {
        return explicit;
    }
    if let Some(resources) = RESOURCE_DIR.get() {
        if let Some(python) = packaged_python_command(resources, std::env::consts::OS) {
            return python.to_string_lossy().into_owned();
        }
    }
    "python3".to_string()
}

fn packaged_python_command(resources: &Path, target_os: &str) -> Option<PathBuf> {
    let runtime = resources.join("helm-runtime");
    if !runtime.join("backend").is_dir() {
        return None;
    }
    match target_os {
        "windows" => Some(runtime.join("python/python.exe")),
        "macos" => {
            let python = runtime.join("python/bin/python3");
            let declares_external_python = std::fs::read(runtime.join("runtime-manifest.json"))
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                .and_then(|manifest| {
                    manifest
                        .get("target")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .is_some_and(|target| target == "external-python");
            // A declared bundled runtime must fail at its installed path if damaged.
            // Older external-Python bundles retain their documented contract.
            (python.is_file() || !declares_external_python).then_some(python)
        }
        _ => None,
    }
}

fn choose_workspace_root(
    explicit: Option<PathBuf>,
    resources: Option<&Path>,
    developer_root: Option<PathBuf>,
) -> Result<PathBuf, String> {
    let has_backend = |path: &Path| path.join("src/helm/ui/desktop_bridge.py").is_file();
    if let Some(path) = explicit {
        if has_backend(&path) {
            return Ok(path);
        }
        return Err(format!(
            "HELM_WORKSPACE_ROOT has no HELM backend: {}",
            path.display()
        ));
    }
    if let Some(resources) = resources {
        let path = resources.join("helm-runtime/backend");
        if has_backend(&path) {
            return Ok(path);
        }
    }
    if let Some(path) = developer_root {
        if has_backend(&path) {
            return Ok(path);
        }
    }
    Err("The installed HELM backend resources are missing. Repair or reinstall HELM.".to_string())
}

pub(crate) fn workspace_root() -> Result<PathBuf, String> {
    // A checkout fallback is only for an unbundled debug executable in an actual
    // Cargo output directory. An installed debug/NSIS build must not depend on it.
    let is_cargo_binary = cfg!(debug_assertions)
        && std::env::current_exe().ok().is_some_and(|path| {
            path.parent()
                .is_some_and(|parent| parent.join(".cargo-lock").is_file())
        });
    let developer_root = is_cargo_binary
        .then(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .ancestors()
                .nth(3)
                .map(Path::to_path_buf)
        })
        .flatten();
    choose_workspace_root(
        std::env::var_os("HELM_WORKSPACE_ROOT").map(PathBuf::from),
        RESOURCE_DIR.get().map(PathBuf::as_path),
        developer_root,
    )
}

pub(crate) fn backend_health(service: &BackendService) -> Result<BackendHealth, String> {
    let workspace_root = workspace_root()?;
    let python_command = resolve_python_command();
    // A real persistent-stdio response proves the selected backend and its
    // imports work, rather than merely finding an unrelated Python executable.
    let health = service.request("health", json!({}))?;
    let expected = workspace_root.join("src/helm/ui/desktop_bridge.py");
    let actual = health
        .get("backend_module")
        .and_then(Value::as_str)
        .ok_or_else(|| "Python bridge health response has no module path.".to_string())?;
    if expected.canonicalize().ok() != Path::new(actual).canonicalize().ok() || !expected.is_file()
    {
        return Err(
            "Python bridge loaded a different HELM backend than the selected resources."
                .to_string(),
        );
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

#[cfg(test)]
mod runtime_path_tests {
    use super::{choose_workspace_root, packaged_python_command};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT: AtomicUsize = AtomicUsize::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "helm-runtime-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn backend(path: &Path) {
        let entry = path.join("src/helm/ui/desktop_bridge.py");
        std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
        std::fs::write(entry, "# runtime fixture\n").unwrap();
    }

    #[test]
    fn bundled_mac_interpreter_relocates_with_resources() {
        let fixture = Fixture::new();
        let resources = fixture.0.join("Installed Ω with spaces");
        backend(&resources.join("helm-runtime/backend"));
        let python = resources.join("helm-runtime/python/bin/python3");
        std::fs::create_dir_all(python.parent().unwrap()).unwrap();
        std::fs::write(&python, "runtime fixture").unwrap();
        assert_eq!(packaged_python_command(&resources, "macos"), Some(python));
        let moved = fixture.0.join("Relocated Ω");
        std::fs::rename(resources, &moved).unwrap();
        assert_eq!(
            packaged_python_command(&moved, "macos"),
            Some(moved.join("helm-runtime/python/bin/python3"))
        );
    }

    #[test]
    fn declared_mac_runtime_does_not_fall_back_when_interpreter_is_missing() {
        let fixture = Fixture::new();
        backend(&fixture.0.join("helm-runtime/backend"));
        std::fs::write(
            fixture.0.join("helm-runtime/runtime-manifest.json"),
            r#"{"target":"macos-aarch64"}"#,
        )
        .unwrap();
        assert_eq!(
            packaged_python_command(&fixture.0, "macos"),
            Some(fixture.0.join("helm-runtime/python/bin/python3"))
        );
    }

    #[test]
    fn legacy_external_mac_bundle_keeps_external_interpreter_contract() {
        let fixture = Fixture::new();
        backend(&fixture.0.join("helm-runtime/backend"));
        std::fs::write(
            fixture.0.join("helm-runtime/runtime-manifest.json"),
            r#"{"target":"external-python"}"#,
        )
        .unwrap();
        assert_eq!(packaged_python_command(&fixture.0, "macos"), None);
    }

    #[test]
    fn missing_or_corrupt_mac_manifest_does_not_choose_external_python() {
        let fixture = Fixture::new();
        backend(&fixture.0.join("helm-runtime/backend"));
        let expected = Some(fixture.0.join("helm-runtime/python/bin/python3"));
        assert_eq!(packaged_python_command(&fixture.0, "macos"), expected);
        std::fs::write(
            fixture.0.join("helm-runtime/runtime-manifest.json"),
            "invalid json",
        )
        .unwrap();
        assert_eq!(packaged_python_command(&fixture.0, "macos"), expected);
    }

    #[test]
    fn windows_bundled_interpreter_stays_at_installed_path_even_if_missing() {
        let fixture = Fixture::new();
        backend(&fixture.0.join("helm-runtime/backend"));
        assert_eq!(
            packaged_python_command(&fixture.0, "windows"),
            Some(fixture.0.join("helm-runtime/python/python.exe"))
        );
    }

    #[test]
    fn resources_relocate_with_spaces_and_unicode_and_precede_checkout() {
        let fixture = Fixture::new();
        let resources = fixture.0.join("Installed Ω with spaces");
        let packaged = resources.join("helm-runtime/backend");
        let checkout = fixture.0.join("original-build-checkout");
        backend(&packaged);
        backend(&checkout);
        assert_eq!(
            choose_workspace_root(None, Some(&resources), Some(checkout)).unwrap(),
            packaged
        );
        let moved = fixture.0.join("Relocated Ω");
        std::fs::rename(&resources, &moved).unwrap();
        assert_eq!(
            choose_workspace_root(None, Some(&moved), None).unwrap(),
            moved.join("helm-runtime/backend")
        );
    }

    #[test]
    fn explicit_override_is_validated_and_never_silently_ignored() {
        let fixture = Fixture::new();
        let resources = fixture.0.join("resources");
        backend(&resources.join("helm-runtime/backend"));
        let explicit = fixture.0.join("override");
        backend(&explicit);
        assert_eq!(
            choose_workspace_root(Some(explicit.clone()), Some(&resources), None).unwrap(),
            explicit
        );
        let invalid = fixture.0.join("empty-existing-directory");
        std::fs::create_dir_all(&invalid).unwrap();
        assert!(choose_workspace_root(Some(invalid), Some(&resources), None)
            .unwrap_err()
            .contains("no HELM backend"));
    }

    #[test]
    fn installed_mode_fails_closed_when_packaged_backend_is_missing() {
        let fixture = Fixture::new();
        let resources = fixture.0.join("damaged-install");
        std::fs::create_dir_all(&resources).unwrap();
        assert!(choose_workspace_root(None, Some(&resources), None)
            .unwrap_err()
            .contains("Repair or reinstall"));
    }
}

#[cfg(test)]
mod retry_tests {
    use super::*;
    use std::fs::OpenOptions;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn mutation_is_not_replayed_when_response_is_lost_after_a_write() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "helm-bridge-retry-{}-{}",
            std::process::id(),
            nonce
        ));
        let result: Result<Value, String> = retry_bridge_request("apply-edit", || {
            let mut file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .unwrap();
            file.write_all(b"inserted statement\n").unwrap();
            // The worker committed the edit, then closed before sending its response.
            Err("Python bridge closed unexpectedly.".to_string())
        });
        let saved = std::fs::read_to_string(&path).unwrap();
        std::fs::remove_file(path).unwrap();
        assert!(result.is_err());
        assert_eq!(saved, "inserted statement\n");
    }

    #[test]
    fn validation_rejection_is_not_a_transport_retry() {
        let mut attempts = 0;
        let reply = retry_bridge_request("parse-flow-expression", || {
            attempts += 1;
            Ok(BridgeReply::Rejected("Invalid expression.".to_string()))
        })
        .unwrap();
        assert!(matches!(reply, BridgeReply::Rejected(_)));
        assert_eq!(attempts, 1);
    }

    #[cfg(unix)]
    #[test]
    fn validation_rejection_keeps_the_same_worker_for_the_next_request() {
        let mut child = Command::new("/bin/sh")
            .args([
                "-c",
                r#"read -r first
printf '%s\n' '{"id":1,"ok":false,"error":"Invalid expression."}'
read -r second
printf '%s\n' '{"id":2,"ok":true,"result":{"sameWorker":true}}'
read -r shutdown"#,
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let pid = child.id();
        let stdin = BufWriter::new(child.stdin.take().unwrap());
        let stdout = BufReader::new(child.stdout.take().unwrap());
        let bridge = PersistentPythonBridge {
            process: Mutex::new(Some(BridgeProcess {
                child,
                stdin,
                stdout,
                next_request_id: 1,
            })),
        };
        assert_eq!(
            bridge
                .request(
                    "save-node-source",
                    json!({}),
                    None::<fn(WorkerProgressPayload)>
                )
                .unwrap_err(),
            "Invalid expression."
        );
        assert_eq!(
            bridge
                .process
                .lock()
                .unwrap()
                .as_ref()
                .map(|process| process.child.id()),
            Some(pid)
        );
        assert_eq!(
            bridge
                .request("health", json!({}), None::<fn(WorkerProgressPayload)>)
                .unwrap(),
            json!({"sameWorker": true})
        );
    }

    #[test]
    fn read_request_can_recover_after_one_bridge_restart() {
        let mut attempts = 0;
        let result = retry_bridge_request("graph-view", || {
            attempts += 1;
            if attempts == 1 {
                Err("Python bridge closed unexpectedly.".to_string())
            } else {
                Ok(json!({"nodes": []}))
            }
        });
        assert_eq!(result.unwrap(), json!({"nodes": []}));
        assert_eq!(attempts, 2);
    }
}
