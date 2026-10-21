use crate::execution_work::ExecutionWork;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::env;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

const BACKEND_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);

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
        let lease = ExecutionWork::new(crate::maintenance::work()?);
        self.bridge
            .request(command, params, on_progress, lease)
            .map_err(|failure| {
                if failure.ownership_uncertain() {
                    self.mark_manual_resync_required(failure.message().to_string());
                }
                failure.into_message()
            })
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
    stdin: Option<BufWriter<ChildStdin>>,
    stdout: Option<BufReader<ChildStdout>>,
    next_request_id: u64,
    shutdown_started: bool,
    shutdown_confirmed: bool,
    descendants_unknown: bool,
    request_lease: Option<Arc<ExecutionWork>>,
    uncertain_command: Option<String>,
    request_stage: RequestStage,
    first_failure: Option<FirstFailure>,
}

#[derive(Clone, Copy)]
enum RequestStage {
    Stdio,
    Write,
    Flush,
    Read,
    Eof,
    Decode,
    Identity,
    HelperCleanup,
    Progress,
    Result,
}

impl RequestStage {
    fn description(self) -> &'static str {
        match self {
            Self::Stdio => "stdio capture",
            Self::Write => "request encoding/write",
            Self::Flush => "request flush",
            Self::Read => "response read",
            Self::Eof => "response EOF",
            Self::Decode => "response decoding",
            Self::Identity => "response identity",
            Self::HelperCleanup => "reported helper cleanup",
            Self::Progress => "progress decoding",
            Self::Result => "response result shape",
        }
    }
}

// Store only native protocol metadata. Params, response content and stderr can
// contain private project/environment values and must never enter this record.
struct FirstFailure {
    request_id: u64,
    stage: RequestStage,
    leader_before_cleanup: LeaderObservation,
    leader_reaped: bool,
}

enum LeaderObservation {
    Running,
    Exited(i32),
    #[cfg(unix)]
    Signal(i32),
    ExitedWithoutCode,
    Unavailable,
}

impl LeaderObservation {
    fn capture(child: &mut Child) -> Self {
        match child.try_wait() {
            Ok(None) => Self::Running,
            Ok(Some(status)) => {
                if let Some(code) = status.code() {
                    return Self::Exited(code);
                }
                #[cfg(unix)]
                {
                    use std::os::unix::process::ExitStatusExt;
                    if let Some(signal) = status.signal() {
                        return Self::Signal(signal);
                    }
                }
                Self::ExitedWithoutCode
            }
            Err(_) => Self::Unavailable,
        }
    }

    fn description(&self) -> String {
        match self {
            Self::Running => "running".into(),
            Self::Exited(code) => format!("exited with code {code}"),
            #[cfg(unix)]
            Self::Signal(signal) => format!("exited with signal {signal}"),
            Self::ExitedWithoutCode => "exited without an available code".into(),
            Self::Unavailable => "unavailable".into(),
        }
    }
}

trait BackendChildOwner {
    fn reaped(&mut self) -> Result<bool, String>;
    fn terminate(&mut self) -> Result<(), String>;
}
impl BackendChildOwner for Child {
    fn reaped(&mut self) -> Result<bool, String> {
        self.try_wait().map(|status| status.is_some()).map_err(|_| {
            "Backend exit status could not be checked. Exact ownership was retained.".into()
        })
    }
    fn terminate(&mut self) -> Result<(), String> {
        self.kill()
            .map_err(|_| "Backend termination was not confirmed.".into())
    }
}

/// Reaping is an OS-owned-child observation, not a PID existence check. The
/// injected bounded wait makes timeout/kill-race behavior deterministic in tests.
fn checked_backend_reap(
    owner: &mut impl BackendChildOwner,
    mut wait_next: impl FnMut() -> bool,
) -> Result<(), String> {
    if owner.reaped()? {
        return Ok(());
    }
    let termination_error = owner.terminate().err();
    loop {
        // A child may have exited between try_wait and kill, so a failed kill
        // is not itself failure when this same handle is independently reaped.
        if owner.reaped()? {
            return Ok(());
        }
        if !wait_next() {
            return Err(termination_error.unwrap_or_else(|| {
                "Backend cleanup did not finish within two seconds. Installation was refused; exact ownership was retained for retry.".into()
            }));
        }
    }
}

impl BridgeProcess {
    fn from_spawned_child(child: Child) -> Self {
        // Establish an owner before extracting/allocating stdio wrappers. Pipe
        // absence is diagnosed only after this owner reaches the durable slot.
        let mut owned = Self {
            child,
            stdin: None,
            stdout: None,
            next_request_id: 1,
            shutdown_started: false,
            shutdown_confirmed: false,
            descendants_unknown: false,
            request_lease: None,
            uncertain_command: None,
            request_stage: RequestStage::Stdio,
            first_failure: None,
        };
        owned.stdin = owned.child.stdin.take().map(BufWriter::new);
        owned.stdout = owned.child.stdout.take().map(BufReader::new);
        owned
    }

    fn uncertain_message(&self) -> String {
        let first = self.first_failure.as_ref().map(|failure| {
            format!(" First failure: {} (request #{}); leader before cleanup: {}; bounded Python leader cleanup {}.",
                failure.stage.description(), failure.request_id,
                failure.leader_before_cleanup.description(),
                if failure.leader_reaped { "confirmed" } else { "unconfirmed" })
        }).unwrap_or_default();
        format!("Backend request ownership is uncertain (recorded backend owner PID {}, request {}).{} Python leader cleanup is not proof that separate-session Git/helpers exited. Their identities were not reported by this protocol. Update and worker replacement remain blocked; manually inspect the recorded owner and helper work before restarting or replacing HELM. Restart alone is not cleanup proof.", self.child.id(), self.uncertain_command.as_deref().unwrap_or("unavailable"), first)
    }

    fn shutdown_checked(&mut self) -> Result<(), String> {
        if self.shutdown_confirmed {
            return Ok(());
        }
        self.shutdown_started = true;
        // Closing an idle worker's input is safe. Do not write/flush a shutdown
        // message into a full pipe or let BufWriter::drop perform an unbounded
        // flush of a failed request. No mutation is replayed here.
        if let Some(stdin) = self.stdin.take() {
            let (pipe, _unsent) = stdin.into_parts();
            drop(pipe);
        }
        let deadline = Instant::now() + BACKEND_SHUTDOWN_TIMEOUT;
        checked_backend_reap(&mut self.child, || {
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                return false;
            };
            std::thread::sleep(remaining.min(Duration::from_millis(10)));
            true
        })?;
        self.shutdown_confirmed = true;
        Ok(())
    }
}

impl Drop for BridgeProcess {
    fn drop(&mut self) {
        // Best effort only. Request failure uses shutdown_checked and retains
        // uncertain owners in PersistentPythonBridge rather than invoking Drop.
        let _ = self.shutdown_checked();
    }
}

#[derive(Debug)]
enum BridgeReply {
    Success(Value),
    Rejected(String),
    OwnershipUncertain(String),
}

#[derive(Debug)]
enum BridgeFailure {
    /// The launch failed before a child owner was created; only this class retries.
    NoOwner(String),
    Rejected(String),
    /// Existing quarantine was observed before the new request sent any input.
    Quarantined(String),
    /// The original request lease and exact owner must outlive this error.
    OwnershipUncertain(String),
}
impl BridgeFailure {
    fn message(&self) -> &str {
        match self {
            Self::NoOwner(message)
            | Self::Rejected(message)
            | Self::Quarantined(message)
            | Self::OwnershipUncertain(message) => message,
        }
    }
    fn into_message(self) -> String {
        match self {
            Self::NoOwner(message)
            | Self::Rejected(message)
            | Self::Quarantined(message)
            | Self::OwnershipUncertain(message) => message,
        }
    }
    fn ownership_uncertain(&self) -> bool {
        matches!(self, Self::OwnershipUncertain(_) | Self::Quarantined(_))
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
    #[serde(default)]
    ownership_uncertain: bool,
}

impl PersistentPythonBridge {
    fn request<F>(
        &self,
        command: &str,
        params: Value,
        mut on_progress: Option<F>,
        lease: Arc<ExecutionWork>,
    ) -> Result<Value, BridgeFailure>
    where
        F: FnMut(WorkerProgressPayload),
    {
        let reply = retry_bridge_request(command, || {
            let mut process = self
                .process
                .lock()
                .map_err(|_| BridgeFailure::OwnershipUncertain("Backend ownership state is unavailable. Update and replacement remain blocked; inspect/restart HELM manually.".into()))?;
            if process.is_none() {
                *process = Some(spawn_bridge_process().map_err(BridgeFailure::NoOwner)?);
            }
            if process.as_ref().is_some_and(|bridge| {
                bridge.shutdown_started
                    || bridge.descendants_unknown
                    || bridge.request_lease.is_some()
            }) {
                let message = process.as_ref().map(BridgeProcess::uncertain_message).unwrap_or_else(|| "Backend cleanup ownership is unavailable; update/replacement remain blocked pending manual inspection.".into());
                return Err(BridgeFailure::Quarantined(message));
            }
            let owned = process.as_mut().ok_or_else(|| {
                BridgeFailure::OwnershipUncertain(
                    "Backend owner disappeared before request admission.".into(),
                )
            })?;
            // Attach before any input/callback. Unexpected unwind retains this
            // same lease through the exact owner or ExecutionWork's fail-closed Drop.
            owned.request_lease = Some(lease.clone());
            owned.uncertain_command = Some(command.to_string());
            let request_id = owned.next_request_id;
            let result = send_bridge_request(
                owned,
                command,
                params.clone(),
                on_progress
                    .as_mut()
                    .map(|callback| callback as &mut dyn FnMut(WorkerProgressPayload)),
            );
            match result {
                Ok(BridgeReply::Success(value)) => {
                    drop(owned.request_lease.take());
                    Ok(BridgeReply::Success(value))
                }
                Ok(BridgeReply::Rejected(message)) => {
                    drop(owned.request_lease.take());
                    Ok(BridgeReply::Rejected(message))
                }
                Ok(BridgeReply::OwnershipUncertain(message)) | Err(message) => {
                    owned.descendants_unknown = true;
                    owned.uncertain_command = Some(command.to_string());
                    let leader_before_cleanup = LeaderObservation::capture(&mut owned.child);
                    // Record before cleanup and keep the original category/id
                    // when later health requests observe the quarantine.
                    owned.first_failure.get_or_insert(FirstFailure {
                        request_id,
                        stage: owned.request_stage,
                        leader_before_cleanup,
                        leader_reaped: false,
                    });
                    // Reaping Python does not prove separate-session Git helpers
                    // exited. Retain exact owner AND original request lease even
                    // when this bounded leader cleanup succeeds.
                    let _ = owned.shutdown_checked();
                    if let Some(failure) = owned.first_failure.as_mut() {
                        failure.leader_reaped = owned.shutdown_confirmed;
                    }
                    Err(BridgeFailure::OwnershipUncertain(format!(
                        "{message} {}",
                        owned.uncertain_message()
                    )))
                }
            }
        });
        match reply {
            Ok(BridgeReply::Success(value)) => {
                lease.confirmed_cleanup();
                Ok(value)
            }
            Ok(BridgeReply::Rejected(error)) => {
                lease.confirmed_cleanup();
                Err(BridgeFailure::Rejected(error))
            }
            Ok(BridgeReply::OwnershipUncertain(message)) => {
                Err(BridgeFailure::OwnershipUncertain(message))
            }
            Err(error @ BridgeFailure::NoOwner(_)) | Err(error @ BridgeFailure::Quarantined(_)) => {
                // This invocation created/sent nothing; an older quarantined
                // request, if any, keeps its distinct original lease.
                lease.confirmed_cleanup();
                Err(error)
            }
            Err(error) => Err(error),
        }
    }
}

fn retry_bridge_request<T>(
    command: &str,
    mut operation: impl FnMut() -> Result<T, BridgeFailure>,
) -> Result<T, BridgeFailure> {
    // A worker may commit a mutation before its response pipe fails. Replaying
    // that request could insert twice or undo a different state. Only known
    // read/index operations may retry only proven no-created-owner spawn failures.
    // No transport failure or abnormal leader exit permits worker replacement.
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
            Err(error @ BridgeFailure::NoOwner(_)) => last_error = Some(error),
            Err(error) => return Err(error),
        }
    }
    Err(last_error
        .unwrap_or_else(|| BridgeFailure::NoOwner("Python bridge is unavailable.".into())))
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
    let child = command
        .spawn()
        .map_err(|err| format!("Unable to launch {}: {}", python_command, err))?;
    Ok(BridgeProcess::from_spawned_child(child))
}

fn send_bridge_request(
    bridge: &mut BridgeProcess,
    command: &str,
    params: Value,
    mut on_progress: Option<&mut dyn FnMut(WorkerProgressPayload)>,
) -> Result<BridgeReply, String> {
    bridge.request_stage = RequestStage::Stdio;
    if bridge.stdin.is_none() || bridge.stdout.is_none() {
        return Err("Unable to capture the Python bridge stdio. Its exact child remains owned until checked cleanup completes.".into());
    }
    let request_id = bridge.next_request_id;
    bridge.next_request_id += 1;
    let request = json!({
        "id": request_id,
        "command": command,
        "params": params,
    });

    let stdin = bridge
        .stdin
        .as_mut()
        .ok_or("Python bridge input is closed for cleanup.")?;
    bridge.request_stage = RequestStage::Write;
    serde_json::to_writer(&mut *stdin, &request)
        .map_err(|err| format!("Unable to encode the Python bridge request: {}", err))?;
    stdin
        .write_all(b"\n")
        .map_err(|err| format!("Unable to write the Python bridge request: {}", err))?;
    bridge.request_stage = RequestStage::Flush;
    stdin
        .flush()
        .map_err(|err| format!("Unable to flush the Python bridge request: {}", err))?;

    loop {
        bridge.request_stage = RequestStage::Read;
        let mut response_line = String::new();
        let bytes = bridge
            .stdout
            .as_mut()
            .ok_or("Python bridge output is unavailable.")?
            .read_line(&mut response_line)
            .map_err(|err| format!("Unable to read the Python bridge response: {}", err))?;
        if bytes == 0 {
            bridge.request_stage = RequestStage::Eof;
            return Err("Python bridge closed unexpectedly.".to_string());
        }

        bridge.request_stage = RequestStage::Decode;
        let response: WorkerResponse = serde_json::from_str(response_line.trim())
            .map_err(|err| format!("Unable to decode the Python bridge response: {}", err))?;
        if response.id != Some(request_id) {
            bridge.request_stage = RequestStage::Identity;
            return Err("Python bridge response id did not match the request.".to_string());
        }
        if response.ownership_uncertain
            || (command == "switch-project-branch"
                && response
                    .result
                    .as_ref()
                    .and_then(|result| result.get("outcome"))
                    .and_then(Value::as_str)
                    == Some("unknown"))
        {
            bridge.request_stage = RequestStage::HelperCleanup;
            return Ok(BridgeReply::OwnershipUncertain(
                response
                    .error
                    .or_else(|| {
                        response
                            .result
                            .as_ref()
                            .and_then(|result| result.get("message"))
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    })
                    .unwrap_or_else(|| {
                        "The backend reported unconfirmed Git/helper cleanup.".into()
                    }),
            ));
        }

        if response.event.as_deref() == Some("progress") {
            bridge.request_stage = RequestStage::Progress;
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

        bridge.request_stage = RequestStage::Result;
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
mod checked_backend_shutdown_tests {
    use super::{checked_backend_reap, BackendChildOwner};
    use std::collections::VecDeque;

    struct Owner {
        identity: u64,
        polls: VecDeque<Result<bool, String>>,
        termination_error: Option<String>,
        termination_calls: usize,
    }
    impl Owner {
        fn new(polls: impl IntoIterator<Item = Result<bool, String>>) -> Self {
            Self {
                identity: 73,
                polls: polls.into_iter().collect(),
                termination_error: None,
                termination_calls: 0,
            }
        }
    }
    impl BackendChildOwner for Owner {
        fn reaped(&mut self) -> Result<bool, String> {
            self.polls.pop_front().unwrap_or(Ok(false))
        }
        fn terminate(&mut self) -> Result<(), String> {
            self.termination_calls += 1;
            self.termination_error.clone().map_or(Ok(()), Err)
        }
    }

    #[test]
    fn already_reaped_worker_needs_no_termination_or_wait() {
        let mut owner = Owner::new([Ok(true)]);
        checked_backend_reap(&mut owner, || panic!("Reaped child cannot need waiting")).unwrap();
        assert_eq!(owner.termination_calls, 0);
    }

    #[test]
    fn termination_error_is_reconciled_by_same_handle_exit_status() {
        let mut owner = Owner::new([Ok(false), Ok(true)]);
        owner.termination_error = Some("exit raced termination".into());
        checked_backend_reap(&mut owner, || false).unwrap();
        assert_eq!(owner.termination_calls, 1);
        assert_eq!(owner.identity, 73);
    }

    #[test]
    fn deadline_failure_retains_exact_owner_for_a_checked_retry() {
        let mut owner = Owner::new([Ok(false), Ok(false)]);
        assert!(checked_backend_reap(&mut owner, || false).is_err());
        assert_eq!(owner.identity, 73);
        assert_eq!(owner.termination_calls, 1);
        owner.polls = [Ok(false), Ok(true)].into_iter().collect();
        checked_backend_reap(&mut owner, || false).unwrap();
        assert_eq!(owner.identity, 73);
        assert_eq!(owner.termination_calls, 2);
    }

    #[test]
    fn failed_exit_observation_is_not_a_cleanup_proof() {
        let mut owner = Owner::new([Err("Exit query failed".into())]);
        assert_eq!(
            checked_backend_reap(&mut owner, || false).unwrap_err(),
            "Exit query failed"
        );
        assert_eq!(owner.termination_calls, 0);
    }

    #[test]
    fn a_resistant_worker_has_a_finite_poll_budget() {
        let mut owner = Owner::new([]);
        let mut remaining = 2;
        assert!(checked_backend_reap(&mut owner, || {
            if remaining == 0 {
                false
            } else {
                remaining -= 1;
                true
            }
        })
        .is_err());
        assert_eq!(remaining, 0);
        assert_eq!(owner.termination_calls, 1);
    }

    #[cfg(unix)]
    #[test]
    fn missing_stdio_is_validated_only_after_partial_child_is_durably_owned() {
        use super::{BridgeProcess, PersistentPythonBridge, WorkerProgressPayload};
        use crate::{execution_work::ExecutionWork, maintenance::Gate};
        use serde_json::json;
        use std::process::{Command, Stdio};
        use std::sync::Mutex;

        for missing_stdin in [false, true] {
            let gate = Gate::default();
            // Disposable child only; no real backend, project, installer or
            // process-global maintenance gate is used by this regression.
            let child = Command::new("/bin/sh")
                .args(["-c", "exit 0"])
                .stdin(if missing_stdin {
                    Stdio::null()
                } else {
                    Stdio::piped()
                })
                .stdout(if missing_stdin {
                    Stdio::piped()
                } else {
                    Stdio::null()
                })
                .spawn()
                .unwrap();
            let bridge = PersistentPythonBridge {
                process: Mutex::new(Some(BridgeProcess::from_spawned_child(child))),
            };
            let error = bridge
                .request(
                    "save-node-source",
                    json!({}),
                    None::<fn(WorkerProgressPayload)>,
                    ExecutionWork::new(gate.work().unwrap()),
                )
                .unwrap_err();
            assert!(error
                .message()
                .contains("Unable to capture the Python bridge stdio"));
            // Even an unusual partial owner cannot be dropped as proof that its
            // startup/helpers were absent. The exact owner and lease survive.
            let owned = bridge.process.lock().unwrap();
            let owned = owned.as_ref().unwrap();
            assert!(owned.descendants_unknown);
            assert!(owned.request_lease.is_some());
            assert!(gate.install().is_err());
        }
    }
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
        let result: Result<Value, BridgeFailure> = retry_bridge_request("apply-edit", || {
            let mut file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .unwrap();
            file.write_all(b"inserted statement\n").unwrap();
            // The worker committed the edit, then closed before sending its response.
            Err(BridgeFailure::OwnershipUncertain(
                "Python bridge closed unexpectedly.".into(),
            ))
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
        let child = Command::new("/bin/sh")
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
        let gate = crate::maintenance::Gate::default();
        let bridge = PersistentPythonBridge {
            process: Mutex::new(Some(BridgeProcess::from_spawned_child(child))),
        };
        assert_eq!(
            bridge
                .request(
                    "save-node-source",
                    json!({}),
                    None::<fn(WorkerProgressPayload)>,
                    ExecutionWork::new(gate.work().unwrap()),
                )
                .unwrap_err()
                .into_message(),
            "Invalid expression."
        );
        assert!(gate.install().is_ok());
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
                .request(
                    "health",
                    json!({}),
                    None::<fn(WorkerProgressPayload)>,
                    ExecutionWork::new(gate.work().unwrap())
                )
                .unwrap(),
            json!({"sameWorker": true})
        );
    }

    #[test]
    fn read_request_retries_only_a_proven_no_owner_launch_failure() {
        let mut attempts = 0;
        let result = retry_bridge_request("graph-view", || {
            attempts += 1;
            if attempts == 1 {
                Err(BridgeFailure::NoOwner(
                    "Launch failed before a child existed.".into(),
                ))
            } else {
                Ok(json!({"nodes": []}))
            }
        });
        assert_eq!(result.unwrap(), json!({"nodes": []}));
        assert_eq!(attempts, 2);
    }

    #[test]
    fn read_transport_uncertainty_is_never_replayed() {
        let mut attempts = 0;
        let result: Result<Value, BridgeFailure> = retry_bridge_request("graph-view", || {
            attempts += 1;
            Err(BridgeFailure::OwnershipUncertain(
                "Simulated separate-session helper uncertainty".into(),
            ))
        });
        assert!(matches!(result, Err(BridgeFailure::OwnershipUncertain(_))));
        assert_eq!(attempts, 1);
    }

    #[cfg(unix)]
    fn synthetic_worker(script: &str) -> PersistentPythonBridge {
        let child = Command::new("/bin/sh")
            .args(["-c", script])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        PersistentPythonBridge {
            process: Mutex::new(Some(BridgeProcess::from_spawned_child(child))),
        }
    }

    #[cfg(unix)]
    #[test]
    fn protocol_loss_and_explicit_git_uncertainty_retain_original_owner_and_gate() {
        for (command, script) in [
            (
                "graph-view",
                "read -r request\nprintf '%s\\n' 'not-json'\nexit 0",
            ),
            (
                "inspect-project",
                r#"read -r request
printf '%s\n' '{"id":1,"ok":false,"error":"Synthetic unknown Git cleanup","ownership_uncertain":true}'
exit 0"#,
            ),
            (
                "switch-project-branch",
                r#"read -r request
printf '%s\n' '{"id":1,"ok":true,"result":{"outcome":"unknown","message":"Synthetic unknown branch cleanup"}}'
exit 0"#,
            ),
        ] {
            // No actual Git descendant is started: these deterministic protocol
            // fixtures simulate the unreported descendant ownership condition.
            let gate = crate::maintenance::Gate::default();
            let bridge = synthetic_worker(script);
            let pid = bridge.process.lock().unwrap().as_ref().unwrap().child.id();
            let lease = ExecutionWork::new(gate.work().unwrap());
            let original = Arc::downgrade(&lease);
            let error = bridge
                .request(command, json!({}), None::<fn(WorkerProgressPayload)>, lease)
                .unwrap_err();
            assert!(matches!(error, BridgeFailure::OwnershipUncertain(_)));
            assert!(gate.install().is_err());
            {
                let state = bridge.process.lock().unwrap();
                let owner = state.as_ref().unwrap();
                assert_eq!(owner.child.id(), pid);
                assert!(owner.shutdown_confirmed); // Python leader was reaped.
                assert!(owner.descendants_unknown); // Helper proof is still absent.
                assert!(Arc::ptr_eq(
                    owner.request_lease.as_ref().unwrap(),
                    &original.upgrade().unwrap()
                ));
            }
            let refusal = bridge
                .request(
                    "health",
                    json!({}),
                    None::<fn(WorkerProgressPayload)>,
                    ExecutionWork::new(gate.work().unwrap()),
                )
                .unwrap_err();
            assert!(matches!(refusal, BridgeFailure::Quarantined(_)));
            assert!(gate.install().is_err());
            drop(bridge);
            assert!(gate.install().is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn quarantine_retains_first_safe_failure_context_across_health_checks() {
        for (script, stage) in [
            ("read -r request\nprintf '%s\\n' 'secret-response-canary'\nexit 0", "response decoding"),
            ("read -r request\nexit 0", "response EOF"),
            ("read -r request\nprintf '%s\\n' '{\"id\":99,\"ok\":true,\"result\":{}}'\nexit 0", "response identity"),
            ("read -r request\nprintf '%s\\n' '{\"id\":1,\"ok\":false,\"ownership_uncertain\":true,\"error\":\"secret-response-canary\"}'\nexit 0", "reported helper cleanup"),
        ] {
            let gate = crate::maintenance::Gate::default();
            let bridge = synthetic_worker(script);
            let pid = bridge.process.lock().unwrap().as_ref().unwrap().child.id();
            let lease = ExecutionWork::new(gate.work().unwrap());
            let original = Arc::downgrade(&lease);
            assert!(bridge.request("inspect-project", json!({"repo":"private-param-canary"}), None::<fn(WorkerProgressPayload)>, lease).is_err());
            for _ in 0..2 {
                let message = bridge.request("health", json!({}), None::<fn(WorkerProgressPayload)>, ExecutionWork::new(gate.work().unwrap())).unwrap_err().into_message();
                assert!(message.contains(stage), "First failure category was lost: {message}");
                assert!(message.contains("request #1"));
                assert!(message.contains("inspect-project"));
                assert!(message.contains("leader before cleanup:"));
                assert!(message.contains("bounded Python leader cleanup confirmed"));
                assert!(!message.contains("secret-response-canary"));
                assert!(!message.contains("private-param-canary"));
                assert!(gate.install().is_err());
            }
            let process = bridge.process.lock().unwrap();
            let owned = process.as_ref().unwrap();
            assert_eq!(owned.child.id(), pid);
            assert!(owned.descendants_unknown && owned.shutdown_confirmed);
            assert!(Arc::ptr_eq(owned.request_lease.as_ref().unwrap(), &original.upgrade().unwrap()));
        }
    }

    #[cfg(unix)]
    #[test]
    fn unexpected_callback_unwind_keeps_the_request_lease_fail_closed() {
        let gate = crate::maintenance::Gate::default();
        let bridge = synthetic_worker(
            r#"read -r request
printf '%s\n' '{"id":1,"event":"progress","payload":{"stage":"parse","status":"running","message":"synthetic"}}'
read -r end"#,
        );
        let lease = ExecutionWork::new(gate.work().unwrap());
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            bridge.request(
                "graph-view",
                json!({}),
                Some(|_: WorkerProgressPayload| panic!("injected callback unwind")),
                lease,
            )
        }));
        assert!(outcome.is_err());
        assert!(bridge.process.lock().is_err());
        assert!(gate.install().is_err());
        drop(bridge); // Best-effort leader cleanup is not descendant proof.
        assert!(gate.install().is_err());
        assert!(crate::maintenance::Gate::default().install().is_ok());
    }
}
