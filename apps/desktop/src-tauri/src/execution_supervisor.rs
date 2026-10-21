//! Project execution owns processes independently from the Python analysis worker.
//! No process starts by constructing, binding, polling or hiding this service.
use crate::execution_policy::{ExecutionContext, ExecutionPolicy};
use crate::execution_preparation::PreparationReceipts;
use crate::execution_work::ExecutionWork;
use crate::repo_boundary::ActiveRepoBoundary;
use crate::run_config::{LaunchSpec, RunConfig};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};
use tauri::{Manager, State, WebviewWindow};

#[cfg(unix)]
#[path = "execution_supervisor/unix.rs"]
mod platform;
#[cfg(windows)]
#[path = "execution_supervisor/windows.rs"]
mod platform;

const RETAIN_BYTES: usize = 512 * 1024;
const POLL_BYTES: usize = 64 * 1024;
const READ_BYTES: usize = 8192;
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ExecutionState {
    Starting,
    Running,
    Stopping,
    Exited,
    Failed,
    CleanupUnknown,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OutputChunk {
    sequence: u64,
    stream: String,
    data: Vec<u8>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExecutionSnapshot {
    pub(crate) id: String,
    kind: String,
    pub(crate) state: ExecutionState,
    exit_code: Option<u32>,
    exit_signal: Option<i32>,
    completion_reason: Option<&'static str>,
    stop_requested: bool,
    pub(crate) cleanup_confirmed: bool,
    owned_pid: u32,
    cleanup_error: Option<String>,
    cleanup_recovery: Option<String>,
    sequence: u64,
    truncated: bool,
    output_complete: bool,
    chunks: Vec<OutputChunk>,
}
struct Output {
    chunks: VecDeque<OutputChunk>,
    bytes: usize,
    sequence: u64,
}
impl Output {
    fn push(&mut self, stream: &str, data: &[u8]) {
        self.sequence += 1;
        self.bytes += data.len();
        self.chunks.push_back(OutputChunk {
            sequence: self.sequence,
            stream: stream.into(),
            data: data.to_vec(),
        });
        while self.bytes > RETAIN_BYTES {
            if let Some(chunk) = self.chunks.pop_front() {
                self.bytes -= chunk.data.len();
            }
        }
    }
}
struct Session {
    id: String,
    kind: String,
    context: ExecutionContext,
    window: String,
    state: Mutex<(ExecutionState, Option<u32>, bool)>,
    termination_requested: AtomicBool,
    exit_signal: Mutex<Option<i32>>,
    owned_pid: u32,
    cleanup_error: Mutex<Option<String>>,
    output: Mutex<Output>,
    stop: AtomicBool,
    io: Mutex<platform::SessionIo>,
    readers: AtomicUsize,
    // Cleanup-unknown keeps exact native handles owned until app teardown/manual
    // investigation. It must not release a slot or rely on a recycled PID.
    retained_process: Mutex<Option<platform::OwnedProcess>>,
    lease: Arc<ExecutionWork>,
    #[cfg(test)]
    handoff_failure: AtomicBool,
    #[cfg(test)]
    worker_panic: AtomicBool,
}
impl Session {
    fn snapshot(&self, after: u64) -> Result<ExecutionSnapshot, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "Execution state unavailable.")?;
        let output = self
            .output
            .lock()
            .map_err(|_| "Execution output unavailable.")?;
        if after > output.sequence {
            return Err("Output cursor is ahead of this execution.".into());
        }
        let mut bytes = 0;
        let chunks: Vec<_> = output
            .chunks
            .iter()
            .filter(|c| c.sequence > after)
            .take_while(|c| {
                bytes += c.data.len();
                bytes <= POLL_BYTES
            })
            .cloned()
            .collect();
        let sequence = chunks.last().map_or(after, |c| c.sequence);
        let stop_requested = self.termination_requested.load(Ordering::SeqCst);
        let completion_reason = if state.0 == ExecutionState::CleanupUnknown {
            Some("cleanup-unknown")
        } else if state.2 {
            Some(if stop_requested {
                "stopped"
            } else if state.0 == ExecutionState::Failed {
                "failed"
            } else {
                "exited"
            })
        } else {
            None
        };
        Ok(ExecutionSnapshot {
            id: self.id.clone(),
            kind: self.kind.clone(),
            state: state.0,
            exit_code: state.1,
            exit_signal: *self
                .exit_signal
                .lock()
                .map_err(|_| "Native exit details unavailable.")?,
            completion_reason,
            stop_requested,
            cleanup_confirmed: state.2,
            owned_pid: self.owned_pid,
            cleanup_error: self
                .cleanup_error
                .lock()
                .map_err(|_| "Cleanup details unavailable.")?
                .clone(),
            cleanup_recovery: if state.0 == ExecutionState::CleanupUnknown {
                Some("Retry cleanup with Stop. If it remains unconfirmed, inspect only the recorded owned process and its descendants before retrying. HELM will keep Restart and workspace replacement blocked.".into())
            } else {
                None
            },
            sequence,
            output_complete: self.readers.load(Ordering::SeqCst) == 0
                && sequence == output.sequence,
            truncated: output
                .chunks
                .front()
                .is_some_and(|c| c.sequence > after.saturating_add(1)),
            chunks,
        })
    }
    fn retry_cleanup_if_unknown(self: &Arc<Self>) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Execution state unavailable.")?;
        if state.0 != ExecutionState::CleanupUnknown {
            return Ok(());
        }
        if self
            .retained_process
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .is_none()
        {
            return Err(
                "Retained native ownership is unavailable; cleanup remains unconfirmed.".into(),
            );
        }
        state.0 = ExecutionState::Stopping;
        drop(state);
        if let Err(error) = launch_worker(self.clone(), true) {
            mark_worker_failure(self, &error);
            return Err(error);
        }
        Ok(())
    }
}

fn mark_worker_failure(session: &Arc<Session>, message: &str) {
    *session
        .cleanup_error
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = Some(
        message
            .chars()
            .filter(|ch| !ch.is_control())
            .take(512)
            .collect(),
    );
    *session
        .state
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = (ExecutionState::CleanupUnknown, None, false);
}
fn worker_entry(session: Arc<Session>, retry: bool) {
    // The process stays in durable Session storage while worker code uses it.
    // Unwinding poisons its lock but does not drop the exact native handle.
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut owner = session
            .retained_process
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let process = owner
            .as_mut()
            .ok_or("Retained execution ownership unavailable.")?;
        #[cfg(test)]
        if session.worker_panic.swap(false, Ordering::SeqCst) {
            panic!("injected worker panic");
        }
        let (result, requested_stop) = if retry {
            (
                process.finish(true),
                session.termination_requested.load(Ordering::SeqCst),
            )
        } else {
            session
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .0 = ExecutionState::Running;
            loop {
                match process.exited() {
                    Ok(true) => break (process.finish(false), false),
                    Ok(false) => {
                        if session.stop.load(Ordering::SeqCst) {
                            match process.exited() {
                                Ok(true) => break (process.finish(false), false),
                                Err(_) => break (process.finish(true), false),
                                Ok(false) => (),
                            }
                            session.termination_requested.store(true, Ordering::SeqCst);
                            session
                                .state
                                .lock()
                                .unwrap_or_else(|error| error.into_inner())
                                .0 = ExecutionState::Stopping;
                            break (process.finish(true), true);
                        }
                        std::thread::sleep(Duration::from_millis(20));
                    }
                    Err(_) => break (process.finish(true), false),
                }
            }
        };
        drop(owner);
        complete_cleanup_attempt(&session, result, requested_stop);
        Ok::<(), String>(())
    }));
    match outcome {
        Ok(Ok(())) => (),
        Ok(Err(message)) => mark_worker_failure(&session, &message),
        Err(_) => mark_worker_failure(
            &session,
            "Native execution worker failed; exact ownership is retained. Retry cleanup with Stop.",
        ),
    }
}
fn launch_worker(session: Arc<Session>, retry: bool) -> Result<(), String> {
    #[cfg(test)]
    if session.handoff_failure.swap(false, Ordering::SeqCst) {
        return Err("Injected native worker handoff failure; exact ownership retained.".into());
    }
    std::thread::Builder::new()
        .name("helm-execution-owner".into())
        .spawn(move || worker_entry(session, retry))
        .map(|_| ())
        .map_err(|_| {
            "Unable to create native cleanup worker; exact ownership is retained. Retry Stop."
                .into()
        })
}
fn complete_cleanup_attempt(
    session: &Arc<Session>,
    mut result: Result<u32, String>,
    requested_stop: bool,
) {
    session
        .termination_requested
        .store(requested_stop, Ordering::SeqCst);
    let exit_signal = session
        .retained_process
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .as_ref()
        .and_then(|process| process.exit_signal());
    // A process proof alone cannot release a still-running native IO helper.
    let io_result = session
        .io
        .lock()
        .map_err(|_| "Native IO ownership unavailable.".to_string())
        .and_then(|mut io| io.close());
    result = result.and_then(|code| io_result.map(|()| code));
    let error = result.as_ref().err().map(|error| {
        error
            .chars()
            .filter(|ch| !ch.is_control())
            .take(512)
            .collect::<String>()
    });
    let drain_deadline = Instant::now() + Duration::from_millis(500);
    while session.readers.load(Ordering::SeqCst) > 0 && Instant::now() < drain_deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    *session
        .cleanup_error
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = error;
    *session
        .exit_signal
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = exit_signal;
    let confirmed = result.is_ok();
    let mut state = session
        .state
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    *state = match result {
        Ok(code) => (
            if requested_stop || code == 0 {
                ExecutionState::Exited
            } else {
                ExecutionState::Failed
            },
            Some(code),
            true,
        ),
        Err(_) => (ExecutionState::CleanupUnknown, None, false),
    };
    if confirmed {
        session
            .retained_process
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        // Passive output drains only append to bounded memory; their final EOF
        // does not own executable or mutable installation resources.
        session.lease.confirmed_cleanup();
    }
    // Readers of lifecycle state cannot observe confirmed cleanup before the
    // corresponding admission release has completed.
    drop(state);
}

fn stop_session(session: &Arc<Session>) -> Result<ExecutionSnapshot, String> {
    session.stop.store(true, Ordering::SeqCst);
    session.retry_cleanup_if_unknown()?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let snapshot = session.snapshot(0)?;
        if snapshot.cleanup_confirmed || snapshot.state == ExecutionState::CleanupUnknown {
            return Ok(snapshot);
        }
        if Instant::now() >= deadline {
            return Err(
                "Stop is still pending. Cleanup is unconfirmed; Restart remains blocked.".into(),
            );
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[derive(Default)]
pub(crate) struct ExecutionSupervisor {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    blocked_slots: Mutex<std::collections::HashSet<(String, String)>>,
    #[cfg(test)]
    fail_next_handoff: AtomicBool,
    #[cfg(test)]
    panic_next_worker: AtomicBool,
}
impl ExecutionSupervisor {
    #[cfg(test)]
    pub(crate) fn mark_partial_cleanup_unknown_fixture(&self) {
        // State-only injection of the durable latch used after partial spawn.
        // No process, native handle or global admission gate is created here.
        self.blocked_slots
            .lock()
            .unwrap()
            .insert(("main".into(), "run".into()));
    }

    fn session(
        &self,
        window: &str,
        context: &ExecutionContext,
        id: &str,
    ) -> Result<Arc<Session>, String> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| "Execution ownership unavailable.")?;
        let session = sessions
            .get(id)
            .ok_or("Execution is no longer available.")?;
        if session.window != window
            || session.context.context_id != context.context_id
            || session.context.repo_path != context.repo_path
            || session.context.generation != context.generation
        {
            return Err("Execution belongs to a different window or workspace generation.".into());
        }
        Ok(session.clone())
    }
    // Keep the admission token explicit at each launch call: it transfers the
    // already-acquired ownership guard separately from process configuration.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn start(
        &self,
        window: &str,
        context: &ExecutionContext,
        spec: LaunchSpec,
        kind: &str,
        rows: u16,
        cols: u16,
        work: crate::maintenance::Work,
    ) -> Result<ExecutionSnapshot, String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "Execution ownership unavailable.")?;
        if self
            .blocked_slots
            .lock()
            .map_err(|_| "Execution cleanup state unavailable.")?
            .contains(&(window.to_string(), kind.to_string()))
        {
            return Err("A partial spawn has unconfirmed cleanup. This execution slot is blocked; inspect the recorded owned process before restarting HELM.".into());
        }
        for session in sessions.values() {
            if session.window == window
                && session.kind == kind
                && !session
                    .state
                    .lock()
                    .map_err(|_| "Execution state unavailable.")?
                    .2
            {
                return Err(
                    "Stop the previous execution and confirm cleanup before starting again.".into(),
                );
            }
        }
        // Retain only the latest completed session per slot; frontend owns bounded displayed history.
        sessions.retain(|_, s| !(s.window == window && s.kind == kind));
        let id = format!(
            "exec-{}-{}",
            std::process::id(),
            NEXT_ID.fetch_add(1, Ordering::Relaxed)
        );
        let lease = ExecutionWork::new(work);
        let spawned = match platform::spawn(&spec, kind == "terminal", rows, cols, lease.clone()) {
            Ok(spawned) => spawned,
            Err(error) => {
                if error.cleanup_unknown {
                    self.blocked_slots
                        .lock()
                        .map_err(|_| "Execution cleanup state unavailable.")?
                        .insert((window.to_string(), kind.to_string()));
                } else {
                    lease.confirmed_cleanup();
                }
                return Err(error.message);
            }
        };
        let session = Arc::new(Session {
            id: id.clone(),
            kind: kind.into(),
            context: context.clone(),
            window: window.into(),
            state: Mutex::new((ExecutionState::Starting, None, false)),
            termination_requested: AtomicBool::new(false),
            exit_signal: Mutex::new(None),
            owned_pid: spawned.process.owned_pid(),
            cleanup_error: Mutex::new(None),
            output: Mutex::new(Output {
                chunks: VecDeque::new(),
                bytes: 0,
                sequence: 0,
            }),
            stop: AtomicBool::new(false),
            io: Mutex::new(spawned.io),
            readers: AtomicUsize::new(0),
            retained_process: Mutex::new(Some(spawned.process)),
            lease,
            #[cfg(test)]
            handoff_failure: AtomicBool::new(self.fail_next_handoff.swap(false, Ordering::SeqCst)),
            #[cfg(test)]
            worker_panic: AtomicBool::new(self.panic_next_worker.swap(false, Ordering::SeqCst)),
        });
        sessions.insert(id, session.clone());
        drop(sessions);
        for (stream, reader) in spawned.readers {
            if let Err(error) = read_output(session.clone(), stream, reader) {
                worker_entry(session.clone(), true);
                return Err(error);
            }
        }
        if let Err(error) = launch_worker(session.clone(), false) {
            // No child is captured by the rejected closure. Clean the durable
            // owner synchronously; failed cleanup remains recorded and counted.
            worker_entry(session.clone(), true);
            return Err(error);
        }
        session.snapshot(0)
    }
    /// Defense in depth after exclusive maintenance admission, never a stop.
    #[cfg(test)]
    pub(crate) fn assert_idle(&self) -> Result<(), String> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| "Execution ownership unavailable.")?;
        if !self
            .blocked_slots
            .lock()
            .map_err(|_| "Execution cleanup state unavailable.")?
            .is_empty()
            || sessions.values().any(|session| {
                !session.state.lock().is_ok_and(|state| state.2)
                    || session
                        .retained_process
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .is_some()
            })
        {
            return Err(
                "Owned execution is active or cleanup is unconfirmed; installation is blocked."
                    .into(),
            );
        }
        platform::assert_no_quarantine()
    }

    pub(crate) fn stop_owned(
        &self,
        window: &str,
        context: &ExecutionContext,
        id: &str,
    ) -> Result<ExecutionSnapshot, String> {
        let session = self.session(window, context, id)?;
        stop_session(&session)
    }
    pub(crate) fn shutdown_all(&self) -> Result<(), String> {
        let partial_unknown = !self
            .blocked_slots
            .lock()
            .map_err(|_| "Execution cleanup state unavailable.")?
            .is_empty();
        let sessions: Vec<_> = self
            .sessions
            .lock()
            .map_err(|_| "Execution ownership unavailable.")?
            .values()
            .cloned()
            .collect();
        for session in &sessions {
            session.stop.store(true, Ordering::SeqCst);
            session.retry_cleanup_if_unknown()?;
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if sessions
                .iter()
                .all(|s| s.state.lock().is_ok_and(|state| state.2))
            {
                return if partial_unknown {
                    Err("Partial process cleanup remains unconfirmed. Inspect the owned process before closing or replacing the workspace.".into())
                } else {
                    Ok(())
                };
            }
            if sessions.iter().any(|s| {
                s.state
                    .lock()
                    .is_ok_and(|state| state.0 == ExecutionState::CleanupUnknown)
            }) || Instant::now() >= deadline
            {
                return Err("Owned execution cleanup is unconfirmed. Close was refused; inspect execution status before retrying.".into());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    fn cancel_run_owned(&self, window: &str, context: &ExecutionContext) -> Result<(), String> {
        let partial_unknown = self
            .blocked_slots
            .lock()
            .map_err(|_| "Execution cleanup state unavailable.")?
            .iter()
            .any(|(owner, kind)| owner == window && matches!(kind.as_str(), "run" | "probe"));
        let sessions: Vec<_> = self
            .sessions
            .lock()
            .map_err(|_| "Execution ownership unavailable.")?
            .values()
            .filter(|session| {
                session.window == window
                    && session.context.context_id == context.context_id
                    && session.context.repo_path == context.repo_path
                    && session.context.generation == context.generation
                    && matches!(session.kind.as_str(), "run" | "probe")
            })
            .cloned()
            .collect();
        for session in &sessions {
            session.stop.store(true, Ordering::SeqCst);
            session.retry_cleanup_if_unknown()?;
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if sessions
                .iter()
                .all(|session| session.state.lock().is_ok_and(|state| state.2))
            {
                return if partial_unknown {
                    Err("A partial run spawn has unconfirmed cleanup. Restart remains blocked; the terminal session is preserved.".into())
                } else {
                    Ok(())
                };
            }
            if sessions.iter().any(|session| {
                session
                    .state
                    .lock()
                    .is_ok_and(|state| state.0 == ExecutionState::CleanupUnknown)
            }) || Instant::now() >= deadline
            {
                return Err("Run cleanup is unconfirmed. Restart remains blocked; the terminal session is preserved.".into());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}
impl Drop for ExecutionSupervisor {
    fn drop(&mut self) {
        let _ = self.shutdown_all();
    }
}
fn read_output(
    session: Arc<Session>,
    stream: String,
    mut reader: Box<dyn Read + Send>,
) -> Result<(), String> {
    let counter = session.clone();
    session.readers.fetch_add(1, Ordering::SeqCst);
    let spawned = std::thread::Builder::new()
        .name("helm-execution-output".into())
        .spawn(move || {
            let mut data = [0u8; READ_BYTES];
            loop {
                match reader.read(&mut data) {
                    Ok(0) | Err(_) => break,
                    Ok(size) => {
                        if let Ok(mut output) = session.output.lock() {
                            output.push(&stream, &data[..size]);
                        }
                    }
                }
            }
            session.readers.fetch_sub(1, Ordering::SeqCst);
        });
    if spawned.is_err() {
        counter.readers.fetch_sub(1, Ordering::SeqCst);
        return Err("Unable to create execution output worker.".into());
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreparedFile {
    relative_path: String,
    sha256: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreparedSource {
    preparation_id: String,
    repo_path: String,
    files: Vec<PreparedFile>,
}
fn verify_source(context: &ExecutionContext, prepared: &PreparedSource) -> Result<(), String> {
    let root = PathBuf::from(&context.repo_path)
        .canonicalize()
        .map_err(|_| "Prepared workspace is unavailable.")?;
    if Path::new(&prepared.repo_path)
        .canonicalize()
        .map_err(|_| "Prepared workspace is unavailable.")?
        != root
        || prepared.files.len() > 10000
    {
        return Err(
            "Prepared source belongs to another workspace or exceeds the file limit.".into(),
        );
    }
    verify_recovery_clear(&root)?;
    let expected: std::collections::BTreeSet<_> = prepared
        .files
        .iter()
        .map(|f| f.relative_path.clone())
        .collect();
    if expected.len() != prepared.files.len() || source_inventory(&root)? != expected {
        return Err("Workspace files changed during preparation. Save and prepare again.".into());
    }
    const MAX_FILE: u64 = 8 * 1024 * 1024;
    let mut total_bytes = 0u64;
    let mut versions = Vec::new();
    for file in &prepared.files {
        let path = Path::new(&file.relative_path);
        if path.is_absolute()
            || path
                .components()
                .any(|c| !matches!(c, std::path::Component::Normal(_)))
            || file.sha256.len() != 64
        {
            return Err("Invalid prepared source manifest.".into());
        }
        let target = root
            .join(path)
            .canonicalize()
            .map_err(|_| "Prepared source was removed; prepare again.")?;
        if !target.starts_with(&root) {
            return Err("Prepared source escaped the workspace.".into());
        }
        let before = file_version(&target)?;
        if before.len > MAX_FILE {
            return Err("Prepared source exceeds the execution verification size limit.".into());
        }
        let mut options = std::fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.custom_flags(
                windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT,
            );
        }
        let mut reader = options
            .open(&target)
            .map_err(|_| "Prepared source could not be read safely.")?;
        if !reader
            .metadata()
            .map_err(|_| "Prepared source metadata unavailable.")?
            .is_file()
        {
            return Err("Prepared source is no longer a regular file.".into());
        }
        let mut hasher = Sha256::new();
        let mut bounded = (&mut reader).take(MAX_FILE + 1);
        let mut length = 0u64;
        let mut buffer = [0u8; 8192];
        loop {
            let count = bounded
                .read(&mut buffer)
                .map_err(|_| "Prepared source could not be read.")?;
            if count == 0 {
                break;
            }
            length += count as u64;
            hasher.update(&buffer[..count]);
        }
        total_bytes = total_bytes.saturating_add(length);
        if length > MAX_FILE || total_bytes > 64 * 1024 * 1024 {
            return Err("Prepared source exceeds the execution verification size limit.".into());
        }
        if before != file_version(&target)?
            || target
                .canonicalize()
                .map_err(|_| "Prepared source moved during verification.")?
                != target
        {
            return Err("Source metadata changed during preparation. Prepare again.".into());
        }
        if format!("{:x}", hasher.finalize()) != file.sha256 {
            return Err(
                "Source changed during preparation. Save and prepare again; nothing was launched."
                    .into(),
            );
        }
        versions.push((target, before));
    }
    if source_inventory(&root)? != expected {
        return Err(
            "Workspace file inventory changed while verifying source. Prepare again.".into(),
        );
    }
    for (path, version) in versions {
        if file_version(&path)? != version {
            return Err("Source changed while verifying another file. Prepare again.".into());
        }
    }
    verify_recovery_clear(&root)?;
    Ok(())
}
fn verify_recovery_clear(root: &Path) -> Result<(), String> {
    for relative in [".helm", ".helm/recovery", ".helm/recovery/journals"] {
        match std::fs::symlink_metadata(root.join(relative)) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err("Run preparation refuses symbolic links in recovery metadata.".into())
            }
            Ok(_) => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(_) => {
                return Err(
                    "Run recovery metadata is unavailable; reconcile the workspace first.".into(),
                )
            }
        }
    }
    let journals = root.join(".helm/recovery/journals");
    if journals.exists() {
        for item in
            std::fs::read_dir(journals).map_err(|_| "Run recovery metadata is unavailable.")?
        {
            let item = item.map_err(|_| "Run recovery metadata changed during verification.")?;
            if item
                .path()
                .extension()
                .is_some_and(|extension| extension == "json")
            {
                return Err(
                    "Run is blocked by a pending recovery journal. Reconcile the workspace first."
                        .into(),
                );
            }
        }
    }
    Ok(())
}
#[derive(PartialEq)]
struct FileVersion {
    len: u64,
    modified: std::time::SystemTime,
    #[cfg(unix)]
    dev: u64,
    #[cfg(unix)]
    inode: u64,
}
fn file_version(path: &Path) -> Result<FileVersion, String> {
    let metadata =
        std::fs::symlink_metadata(path).map_err(|_| "Prepared source metadata unavailable.")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("Prepared source is no longer a regular file.".into());
    }
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;
    Ok(FileVersion {
        len: metadata.len(),
        modified: metadata
            .modified()
            .map_err(|_| "Prepared source version unavailable.")?,
        #[cfg(unix)]
        dev: metadata.dev(),
        #[cfg(unix)]
        inode: metadata.ino(),
    })
}
fn source_inventory(root: &Path) -> Result<std::collections::BTreeSet<String>, String> {
    const IGNORED: &[&str] = &[
        ".cache",
        ".git",
        ".hg",
        ".helm",
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
        ".venv-helm-dev",
        "__pycache__",
        "build",
        "coverage",
        "dist",
        "env",
        "node_modules",
        "target",
        "vendor",
        "venv",
    ];
    let mut files = std::collections::BTreeSet::new();
    let mut pending = vec![root.to_path_buf()];
    let mut visited = 0usize;
    while let Some(directory) = pending.pop() {
        for item in
            std::fs::read_dir(&directory).map_err(|_| "Run source inventory could not be read.")?
        {
            visited += 1;
            if visited > 50000 {
                return Err("Run source inventory exceeds the verification entry limit.".into());
            }
            let item = item.map_err(|_| "Run source inventory changed while reading.")?;
            let name = item.file_name();
            let name = name
                .to_str()
                .ok_or("Run source filenames must be Unicode.")?;
            let metadata = std::fs::symlink_metadata(item.path())
                .map_err(|_| "Run source inventory changed while reading.")?;
            if metadata.is_dir() && IGNORED.contains(&name) {
                continue;
            }
            if metadata.file_type().is_symlink() {
                // Python os.walk lists symlink directories in dirnames and skips
                // explicitly ignored dependency/control names before traversal.
                if IGNORED.contains(&name) && item.path().is_dir() {
                    continue;
                }
                return Err("Run preparation refuses symbolic links in executable source.".into());
            }
            if metadata.is_dir() {
                pending.push(item.path());
                continue;
            }
            if !metadata.is_file() {
                return Err("Run preparation requires regular source files.".into());
            }
            let relative = item
                .path()
                .strip_prefix(root)
                .map_err(|_| "Run source escaped its workspace.")?
                .to_string_lossy()
                .replace('\\', "/");
            files.insert(relative);
            if files.len() > 5000 {
                return Err("Run source exceeds the 5000 file verification limit.".into());
            }
        }
    }
    let flow = root.join(".helm/flow-models.v1.json");
    if flow.exists() {
        if std::fs::symlink_metadata(root.join(".helm"))
            .map_err(|_| "Flow store metadata unavailable.")?
            .file_type()
            .is_symlink()
            || std::fs::symlink_metadata(&flow)
                .map_err(|_| "Flow store metadata unavailable.")?
                .file_type()
                .is_symlink()
        {
            return Err("Run preparation refuses symbolic links in the flow store.".into());
        }
        files.insert(".helm/flow-models.v1.json".into());
    }
    Ok(files)
}

// Both IPC handlers delegate their complete launch path to these private cores.
// The Work acquired first in the blocking closure transfers unchanged into the
// owned session; tests exercise the same admission path with an isolated gate.
struct ExecutionCommandOwner<'a> {
    window: &'a str,
    policy: &'a ExecutionPolicy,
    supervisor: &'a ExecutionSupervisor,
    active_repo: &'a ActiveRepoBoundary,
}
impl ExecutionCommandOwner<'_> {
    fn start_run_owned(
        &self,
        context: &ExecutionContext,
        config: &RunConfig,
        prepared_source: &PreparedSource,
        receipts: &PreparationReceipts,
        work: crate::maintenance::Work,
    ) -> Result<ExecutionSnapshot, String> {
        self.active_repo.command_repo_root(&context.repo_path)?;
        let spec = self.policy.launch_spec(self.window, context, config)?;
        self.policy.with_admission(self.window, context, || {
            let issued = receipts.consume(self.window, context, &prepared_source.preparation_id)?;
            let issued: PreparedSource = serde_json::from_value(issued)
                .map_err(|_| "Native preparation receipt is invalid; prepare again.".to_string())?;
            verify_source(context, &issued)?;
            self.supervisor
                .start(self.window, context, spec, "run", 24, 80, work)
        })
    }

    fn start_terminal_owned(
        &self,
        context: &ExecutionContext,
        executable: Option<String>,
        dimensions: (u16, u16),
        work: crate::maintenance::Work,
    ) -> Result<ExecutionSnapshot, String> {
        self.active_repo.command_repo_root(&context.repo_path)?;
        let (rows, cols) = dimensions;
        if rows == 0 || cols == 0 || rows > 500 || cols > 1000 {
            return Err("Terminal dimensions must be between 1×1 and 1000×500.".into());
        }
        let selected = executable.unwrap_or_else(|| {
            #[cfg(target_os = "macos")]
            {
                "/bin/zsh".into()
            }
            #[cfg(windows)]
            {
                "cmd.exe".into()
            }
            #[cfg(all(unix, not(target_os = "macos")))]
            {
                "/bin/sh".into()
            }
        });
        // Known default shells skip user/project startup scripts. Explicit shell
        // selection does not infer shell-command execution from punctuation.
        let args = match Path::new(&selected)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str()
        {
            "zsh" => vec!["-f".into()],
            "bash" => vec!["--noprofile".into(), "--norc".into()],
            "cmd.exe" | "cmd" => vec!["/D".into()],
            "powershell.exe" | "pwsh.exe" | "pwsh" => vec!["-NoLogo".into(), "-NoProfile".into()],
            _ => vec![],
        };
        let config = RunConfig {
            id: "terminal".into(),
            name: "Terminal".into(),
            kind: "app".into(),
            mode: "executable".into(),
            executable: selected,
            args,
            command: String::new(),
            cwd: ".".into(),
            env: Default::default(),
            secret_names: vec![],
        };
        let spec = self.policy.launch_spec(self.window, context, &config)?;
        self.policy.with_admission(self.window, context, || {
            self.supervisor
                .start(self.window, context, spec, "terminal", rows, cols, work)
        })
    }
}

#[tauri::command]
pub(crate) async fn execution_start_run(
    window: WebviewWindow,
    context: ExecutionContext,
    config: RunConfig,
    prepared_source: PreparedSource,
) -> Result<ExecutionSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let work = crate::maintenance::work()?;
        let app = window.app_handle();
        let policy = app.state::<ExecutionPolicy>();
        let supervisor = app.state::<ExecutionSupervisor>();
        let active_repo = app.state::<ActiveRepoBoundary>();
        let receipts = app.state::<PreparationReceipts>();
        ExecutionCommandOwner {
            window: window.label(),
            policy: &policy,
            supervisor: &supervisor,
            active_repo: &active_repo,
        }
        .start_run_owned(&context, &config, &prepared_source, &receipts, work)
    })
    .await
    .map_err(|_| "Execution startup worker failed; inspect status before retrying.".to_string())?
}
#[tauri::command]
pub(crate) async fn execution_start_terminal(
    window: WebviewWindow,
    context: ExecutionContext,
    executable: Option<String>,
    rows: u16,
    cols: u16,
) -> Result<ExecutionSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let work = crate::maintenance::work()?;
        let app = window.app_handle();
        let policy = app.state::<ExecutionPolicy>();
        let supervisor = app.state::<ExecutionSupervisor>();
        let active_repo = app.state::<ActiveRepoBoundary>();
        ExecutionCommandOwner {
            window: window.label(),
            policy: &policy,
            supervisor: &supervisor,
            active_repo: &active_repo,
        }
        .start_terminal_owned(&context, executable, (rows, cols), work)
    })
    .await
    .map_err(|_| "Terminal startup worker failed; inspect status before retrying.".to_string())?
}
#[tauri::command]
pub(crate) async fn execution_set_trust(
    window: WebviewWindow,
    context: ExecutionContext,
    trusted: bool,
) -> Result<ExecutionContext, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _work = if trusted {
            Some(crate::maintenance::work()?)
        } else {
            None
        };
        let app = window.app_handle();
        let policy = app.state::<ExecutionPolicy>();
        // Revocation first prevents delayed save/probe completions from spawning.
        if trusted {
            app.state::<ActiveRepoBoundary>()
                .command_repo_root(&context.repo_path)?;
        }
        let updated = policy.set_trust(window.label(), &context, trusted)?;
        if !trusted {
            app.state::<ExecutionSupervisor>().shutdown_all()?;
        }
        Ok(updated)
    })
    .await
    .map_err(|_| "Execution consent worker failed; refresh execution state.".to_string())?
}
#[tauri::command]
pub(crate) async fn execution_stop_all(
    window: WebviewWindow,
    context: ExecutionContext,
) -> Result<ExecutionContext, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let app = window.app_handle();
        let policy = app.state::<ExecutionPolicy>();
        policy.validate_owner(window.label(), &context)?;
        // Same consent, new revision: invalidate every in-flight launch before
        // cleanup. A launch already holding admission is owned and stopped here.
        let updated = policy.invalidate_pending(window.label(), &context)?;
        app.state::<ExecutionSupervisor>().shutdown_all()?;
        Ok(updated)
    })
    .await
    .map_err(|_| "Stop worker failed; cleanup remains unconfirmed.".to_string())?
}

#[tauri::command]
pub(crate) async fn execution_cancel_run(
    window: WebviewWindow,
    context: ExecutionContext,
) -> Result<ExecutionContext, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let app = window.app_handle();
        let policy = app.state::<ExecutionPolicy>();
        // Waits behind any launch already holding admission, then invalidates
        // delayed Run/probe completions. Any process already spawned remains
        // owned and is reconciled below; cancellation never claims no spawn.
        let updated = policy.invalidate_pending(window.label(), &context)?;
        app.state::<ExecutionSupervisor>()
            .cancel_run_owned(window.label(), &updated)?;
        Ok(updated)
    })
    .await
    .map_err(|_| "Run cancellation worker failed; run cleanup remains unconfirmed.".to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolProbe {
    tool: crate::run_config::ToolInfo,
    outcome: String,
    exit_code: Option<u32>,
    output: String,
}
#[tauri::command]
pub(crate) async fn execution_probe_tool(
    window: WebviewWindow,
    context: ExecutionContext,
    config: RunConfig,
) -> Result<ToolProbe, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let work = crate::maintenance::work()?;
        let app = window.app_handle(); let policy=app.state::<ExecutionPolicy>(); let supervisor=app.state::<ExecutionSupervisor>();
        let root=app.state::<ActiveRepoBoundary>().command_repo_root(&context.repo_path)?;
        if config.mode != "executable" { return Err("Version probes require an executable configuration; shell commands remain editable and are not guessed.".into()); }
        let selected=policy.launch_spec(window.label(), &context, &config)?;
        let probe_config=RunConfig { executable:selected.tool.path.clone(), args:vec!["--version".into()], command:String::new(), env:Default::default(), secret_names:vec![], ..config };
        let spec=crate::run_config::prepare_launch(&root,&probe_config,&Default::default())?;
        let mut tool=spec.tool.clone();
        let started=policy.with_admission(window.label(), &context, || supervisor.start(window.label(),&context,spec,"probe",24,80,work))?;
        let session=supervisor.session(window.label(),&context,&started.id)?;
        let deadline=Instant::now()+Duration::from_secs(2); let mut timed_out=false;
        loop {
            let snapshot=session.snapshot(0)?;
            if snapshot.cleanup_confirmed || snapshot.state==ExecutionState::CleanupUnknown { break; }
            if Instant::now()>=deadline { timed_out=true; supervisor.stop_owned(window.label(),&context,&started.id)?; break; }
            std::thread::sleep(Duration::from_millis(20));
        }
        let snapshot=session.snapshot(0)?;
        if !snapshot.cleanup_confirmed { return Err("Tool probe cleanup is unconfirmed; no selection was accepted.".into()); }
        policy.with_admission(window.label(),&context,||Ok(()))?;
        let raw:Vec<u8>=snapshot.chunks.iter().flat_map(|c|c.data.iter().copied()).take(4096).collect();
        let output=String::from_utf8_lossy(&raw).chars().filter(|c| *c=='\n' || *c=='\t' || !c.is_control()).collect::<String>();
        let outcome=if timed_out {"timeout"} else if snapshot.exit_code==Some(0) {"available"} else {"failed"}.to_string();
        if outcome=="available" {tool.version=Some(output.trim().to_string());}
        Ok(ToolProbe {tool,outcome,exit_code:snapshot.exit_code,output})
    }).await.map_err(|_|"Tool probe worker failed; verify cleanup before retrying.".to_string())?
}
#[tauri::command]
pub(crate) fn execution_poll(
    window: WebviewWindow,
    policy: State<'_, ExecutionPolicy>,
    supervisor: State<'_, ExecutionSupervisor>,
    context: ExecutionContext,
    id: String,
    after: u64,
) -> Result<ExecutionSnapshot, String> {
    policy.validate_owner(window.label(), &context)?;
    supervisor
        .session(window.label(), &context, &id)?
        .snapshot(after)
}
#[tauri::command]
pub(crate) async fn execution_stop(
    window: WebviewWindow,
    policy: State<'_, ExecutionPolicy>,
    supervisor: State<'_, ExecutionSupervisor>,
    context: ExecutionContext,
    id: String,
) -> Result<ExecutionSnapshot, String> {
    policy.validate_owner(window.label(), &context)?;
    // Blocking command work runs outside the WebView's event loop via async spawn.
    let session = supervisor.session(window.label(), &context, &id)?;
    tauri::async_runtime::spawn_blocking(move || stop_session(&session))
        .await
        .map_err(|_| "Stop worker failed; cleanup remains unconfirmed.".to_string())?
}
#[tauri::command]
pub(crate) fn execution_write(
    window: WebviewWindow,
    policy: State<'_, ExecutionPolicy>,
    supervisor: State<'_, ExecutionSupervisor>,
    active_repo: State<'_, ActiveRepoBoundary>,
    context: ExecutionContext,
    id: String,
    data: String,
) -> Result<(), String> {
    active_repo.command_repo_root(&context.repo_path)?;
    if data.len() > 16384 {
        return Err("Terminal input exceeds 16 KiB; paste smaller blocks.".into());
    }
    policy.with_admission(window.label(), &context, || {
        let session = supervisor.session(window.label(), &context, &id)?;
        if session.kind != "terminal" || session.stop.load(Ordering::SeqCst) {
            return Err("This terminal is not accepting input.".into());
        }
        let mut io = session
            .io
            .lock()
            .map_err(|_| "Terminal input unavailable.")?;
        io.write(data.as_bytes())
    })
}
// Tauri injects owner/state parameters; keep the explicit validated IPC wire fields.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub(crate) fn execution_resize(
    window: WebviewWindow,
    policy: State<'_, ExecutionPolicy>,
    supervisor: State<'_, ExecutionSupervisor>,
    active_repo: State<'_, ActiveRepoBoundary>,
    context: ExecutionContext,
    id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    active_repo.command_repo_root(&context.repo_path)?;
    if rows == 0 || cols == 0 || rows > 500 || cols > 1000 {
        return Err("Terminal dimensions must be between 1×1 and 1000×500.".into());
    }
    policy.with_admission(window.label(), &context, || {
        let session = supervisor.session(window.label(), &context, &id)?;
        let mut io = session
            .io
            .lock()
            .map_err(|_| "Terminal resize unavailable.")?;
        io.resize(rows, cols)
    })
}

#[cfg(test)]
#[path = "execution_command_admission_tests.rs"]
mod command_admission_tests;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn output_retention_and_cursor_are_bounded() {
        let mut output = Output {
            chunks: VecDeque::new(),
            bytes: 0,
            sequence: 0,
        };
        for _ in 0..1000 {
            output.push("stdout", &[b'a'; READ_BYTES]);
        }
        assert!(output.bytes <= RETAIN_BYTES);
        assert_eq!(output.sequence, 1000);
        assert_eq!(output.chunks.back().unwrap().sequence, 1000);
        assert!(output.chunks.front().unwrap().sequence > 1);
    }
    #[test]
    fn source_proof_refuses_changed_content_inventory_and_symlinks() {
        let root = std::env::temp_dir().join(format!(
            "helm-run-proof-{}-{}",
            std::process::id(),
            NEXT_ID.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("main.py"), b"print(1)\n").unwrap();
        let context = ExecutionContext {
            context_id: "proof".into(),
            repo_path: root.to_string_lossy().into_owned(),
            generation: "one".into(),
            trust_revision: 1,
            trusted: true,
        };
        let proof = PreparedSource {
            preparation_id: "native-issued".into(),
            repo_path: context.repo_path.clone(),
            files: vec![PreparedFile {
                relative_path: "main.py".into(),
                sha256: format!("{:x}", Sha256::digest(b"print(1)\n")),
            }],
        };
        verify_source(&context, &proof).unwrap();
        std::fs::write(root.join("new.py"), b"changed").unwrap();
        assert!(verify_source(&context, &proof).is_err());
        std::fs::remove_file(root.join("new.py")).unwrap();
        std::fs::write(root.join("main.py"), b"print(2)\n").unwrap();
        assert!(verify_source(&context, &proof).is_err());
        std::fs::write(root.join("main.py"), b"print(1)\n").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.join("main.py"), root.join("alias.py")).unwrap();
            assert!(verify_source(&context, &proof).is_err());
        }
        std::fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    fn fixture_work() -> crate::maintenance::Work {
        crate::maintenance::Gate::default().work().unwrap()
    }
    #[cfg(unix)]
    #[test]
    fn maintenance_counts_all_slots_until_cleanup_without_requiring_new_work() {
        let gate = crate::maintenance::Gate::default();
        let supervisor = ExecutionSupervisor::default();
        let context = fixture_context();
        for kind in ["run", "terminal", "probe"] {
            let mut spec = fixture_spec("sleep 60");
            if kind == "terminal" {
                spec.args.clear();
            }
            supervisor
                .start("main", &context, spec, kind, 24, 80, gate.work().unwrap())
                .unwrap();
            assert!(gate.install().is_err());
            assert!(supervisor.assert_idle().is_err());
        }
        supervisor.cancel_run_owned("main", &context).unwrap();
        assert!(gate.install().is_err()); // independent terminal is still owned
        supervisor.shutdown_all().unwrap(); // no fresh Work needed for cleanup
        supervisor.assert_idle().unwrap();
        let installation = gate.install().unwrap();
        assert!(gate.work().is_err());
        supervisor.shutdown_all().unwrap(); // also usable during installation
        drop(installation);
    }
    #[cfg(unix)]
    #[test]
    fn failed_natural_exit_releases_lease_while_history_remains() {
        let gate = crate::maintenance::Gate::default();
        let supervisor = ExecutionSupervisor::default();
        let context = fixture_context();
        let started = supervisor
            .start(
                "main",
                &context,
                fixture_spec("exit 23"),
                "run",
                24,
                80,
                gate.work().unwrap(),
            )
            .unwrap();
        let session = supervisor.session("main", &context, &started.id).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let snapshot = session.snapshot(0).unwrap();
            if snapshot.cleanup_confirmed {
                assert_eq!(snapshot.state, ExecutionState::Failed);
                assert_eq!(snapshot.exit_code, Some(23));
                break;
            }
            assert!(Instant::now() < deadline, "{snapshot:?}");
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(gate.install().is_ok());
        assert!(supervisor.session("main", &context, &started.id).is_ok());
        supervisor.assert_idle().unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn startup_handoff_failure_cleans_durable_owner_and_releases_admission() {
        let gate = crate::maintenance::Gate::default();
        let supervisor = ExecutionSupervisor::default();
        supervisor.fail_next_handoff.store(true, Ordering::SeqCst);
        assert!(supervisor
            .start(
                "main",
                &fixture_context(),
                fixture_spec("sleep 60"),
                "run",
                24,
                80,
                gate.work().unwrap()
            )
            .is_err());
        supervisor.assert_idle().unwrap();
        assert!(gate.install().is_ok());
    }
    #[cfg(unix)]
    #[test]
    fn worker_panic_retains_exact_owner_until_explicit_retry() {
        let gate = crate::maintenance::Gate::default();
        let supervisor = ExecutionSupervisor::default();
        supervisor.panic_next_worker.store(true, Ordering::SeqCst);
        let context = fixture_context();
        let started = supervisor
            .start(
                "main",
                &context,
                fixture_spec("sleep 60"),
                "run",
                24,
                80,
                gate.work().unwrap(),
            )
            .unwrap();
        let session = supervisor.session("main", &context, &started.id).unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while session.snapshot(0).unwrap().state != ExecutionState::CleanupUnknown {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(gate.install().is_err());
        assert!(supervisor.assert_idle().is_err());
        let stopped = supervisor
            .stop_owned("main", &context, &started.id)
            .unwrap();
        assert!(stopped.cleanup_confirmed);
        assert_eq!(stopped.owned_pid, started.owned_pid);
        assert!(gate.install().is_ok());
    }
    #[cfg(unix)]
    #[test]
    fn revoked_cleanup_unknown_keeps_consent_closed_until_owned_retry() {
        let gate = crate::maintenance::Gate::default();
        let supervisor = ExecutionSupervisor::default();
        let policy = ExecutionPolicy::default();
        let context = policy
            .transition_bind(
                "main",
                std::env::temp_dir().canonicalize().unwrap(),
                "revocation-unknown".into(),
                || Ok(()),
            )
            .unwrap();
        let context = policy.set_trust("main", &context, true).unwrap();
        supervisor.panic_next_worker.store(true, Ordering::SeqCst);
        let started = policy
            .with_admission("main", &context, || {
                supervisor.start(
                    "main",
                    &context,
                    fixture_spec("sleep 30"),
                    "run",
                    24,
                    80,
                    gate.work()?,
                )
            })
            .unwrap();
        let session = supervisor.session("main", &context, &started.id).unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while session.snapshot(0).unwrap().state != ExecutionState::CleanupUnknown {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        session
            .retained_process
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_mut()
            .unwrap()
            .fail_next_cleanup();
        let revoked = policy.set_trust("main", &context, false).unwrap();
        assert!(supervisor.shutdown_all().is_err());
        assert!(!revoked.trusted);
        assert!(gate.install().is_err());
        // Same native admission gate used by input, resize and launch. Neither
        // stale nor current revoked receipts can reach those actions.
        for receipt in [&context, &revoked] {
            let mut entered = false;
            assert!(policy
                .with_admission("main", receipt, || {
                    entered = true;
                    Ok(())
                })
                .is_err());
            assert!(!entered);
        }
        let recovered = supervisor
            .stop_owned("main", &context, &started.id)
            .unwrap();
        assert!(recovered.cleanup_confirmed);
        assert_eq!(recovered.owned_pid, started.owned_pid);
        supervisor.assert_idle().unwrap();
        assert!(gate.install().is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn clean_spawn_error_releases_admission_and_install_winner_prevents_start() {
        let gate = crate::maintenance::Gate::default();
        let supervisor = ExecutionSupervisor::default();
        let mut spec = fixture_spec("");
        spec.executable = "/nonexistent/helm-maintenance-fixture".into();
        assert!(supervisor
            .start(
                "main",
                &fixture_context(),
                spec,
                "run",
                24,
                80,
                gate.work().unwrap()
            )
            .is_err());
        supervisor.assert_idle().unwrap();
        let installation = gate.install().unwrap();
        assert!(gate.work().is_err());
        assert!(supervisor.sessions.lock().unwrap().is_empty());
        drop(installation);
    }
    #[cfg(unix)]
    pub(super) fn fixture_spec(script: &str) -> LaunchSpec {
        LaunchSpec {
            executable: "/bin/sh".into(),
            args: vec!["-c".into(), script.into()],
            cwd: std::env::temp_dir(),
            env: [("PATH".into(), "/usr/bin:/bin".into())].into(),
            tool: crate::run_config::ToolInfo {
                path: "/bin/sh".into(),
                provenance: "fixture".into(),
                architecture: "native".into(),
                version: None,
                search_path_source: "fixture".into(),
            },
        }
    }
    #[cfg(unix)]
    fn fixture_context() -> ExecutionContext {
        ExecutionContext {
            context_id: "native-test".into(),
            repo_path: std::env::temp_dir().to_string_lossy().into_owned(),
            generation: "one".into(),
            trust_revision: 1,
            trusted: true,
        }
    }
    #[cfg(unix)]
    #[test]
    fn real_run_cleans_resistant_child_when_leader_exits() {
        let supervisor = ExecutionSupervisor::default();
        let context = fixture_context();
        let result = supervisor
            .start(
                "main",
                &context,
                fixture_spec(
                    "(trap '' TERM; while :; do sleep 1; done) & echo child:$!; sleep 0.1; exit 7",
                ),
                "run",
                24,
                80,
                fixture_work(),
            )
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let result = supervisor
                .session("main", &context, &result.id)
                .unwrap()
                .snapshot(0)
                .unwrap();
            if result.cleanup_confirmed {
                assert_eq!(result.exit_code, Some(7));
                assert_eq!(result.state, ExecutionState::Failed);
                assert_eq!(result.completion_reason, Some("failed"));
                assert!(!result.stop_requested);
                assert_eq!(result.exit_signal, None);
                let late_stop = supervisor.stop_owned("main", &context, &result.id).unwrap();
                assert_eq!(late_stop.state, ExecutionState::Failed);
                assert_eq!(late_stop.completion_reason, Some("failed"));
                assert_eq!(late_stop.exit_code, Some(7));
                assert!(!late_stop.stop_requested);
                break;
            }
            assert!(Instant::now() < deadline, "{result:?}");
            std::thread::sleep(Duration::from_millis(30));
        }
    }
    #[cfg(unix)]
    #[test]
    fn real_stop_releases_owned_port_and_preserves_unrelated_listener() {
        use std::net::TcpListener;
        let unrelated = TcpListener::bind("127.0.0.1:0").unwrap();
        let unrelated_port = unrelated.local_addr().unwrap().port();
        let reserved = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = reserved.local_addr().unwrap().port();
        drop(reserved);
        let script = format!("exec /usr/bin/python3 -c 'import socket,time,signal; s=socket.socket(); s.bind((\"127.0.0.1\",{port})); s.listen(); signal.signal(signal.SIGTERM,signal.SIG_IGN); print(\"READY\",flush=True); time.sleep(60)'");
        let supervisor = ExecutionSupervisor::default();
        let context = fixture_context();
        let started = supervisor
            .start(
                "main",
                &context,
                fixture_spec(&script),
                "run",
                24,
                80,
                fixture_work(),
            )
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(4);
        loop {
            let snapshot = supervisor
                .session("main", &context, &started.id)
                .unwrap()
                .snapshot(0)
                .unwrap();
            if snapshot
                .chunks
                .iter()
                .any(|c| c.data.windows(5).any(|v| v == b"READY"))
            {
                break;
            }
            assert!(Instant::now() < deadline, "{snapshot:?}");
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(supervisor
            .start(
                "main",
                &context,
                fixture_spec("exit 0"),
                "run",
                24,
                80,
                fixture_work()
            )
            .is_err());
        let stopped = supervisor
            .stop_owned("main", &context, &started.id)
            .unwrap();
        assert!(stopped.cleanup_confirmed, "{stopped:?}");
        assert_eq!(stopped.state, ExecutionState::Exited);
        assert_eq!(stopped.completion_reason, Some("stopped"));
        assert!(stopped.stop_requested);
        assert_eq!(stopped.exit_code, Some(1));
        assert_eq!(stopped.exit_signal, Some(libc::SIGKILL));
        let rebound = TcpListener::bind(("127.0.0.1", port)).unwrap();
        assert_eq!(rebound.local_addr().unwrap().port(), port);
        assert!(TcpListener::bind(("127.0.0.1", unrelated_port)).is_err());
        let newer = supervisor
            .start(
                "main",
                &context,
                fixture_spec("echo newer"),
                "run",
                24,
                80,
                fixture_work(),
            )
            .unwrap();
        assert_ne!(newer.id, started.id);
        assert!(supervisor.session("other", &context, &newer.id).is_err());
        supervisor.shutdown_all().unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn repeated_stop_retries_exact_retained_native_process() {
        use std::net::TcpListener;
        let reserved = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = reserved.local_addr().unwrap().port();
        drop(reserved);
        let script=format!("exec /usr/bin/python3 -c 'import socket,time,signal; s=socket.socket(); s.bind((\"127.0.0.1\",{port})); s.listen(); signal.signal(signal.SIGTERM,signal.SIG_IGN); print(\"READY\",flush=True); time.sleep(60)'");
        let gate = crate::maintenance::Gate::default();
        let lease = ExecutionWork::new(gate.work().unwrap());
        let spawned =
            platform::spawn(&fixture_spec(&script), false, 24, 80, lease.clone()).unwrap();
        let pid = spawned.process.owned_pid();
        let context = fixture_context();
        let session = Arc::new(Session {
            id: format!("retry-fixture-{pid}"),
            kind: "run".into(),
            context: context.clone(),
            window: "main".into(),
            state: Mutex::new((ExecutionState::Running, None, false)),
            termination_requested: AtomicBool::new(false),
            exit_signal: Mutex::new(None),
            owned_pid: pid,
            cleanup_error: Mutex::new(None),
            output: Mutex::new(Output {
                chunks: VecDeque::new(),
                bytes: 0,
                sequence: 0,
            }),
            stop: AtomicBool::new(false),
            io: Mutex::new(spawned.io),
            readers: AtomicUsize::new(0),
            retained_process: Mutex::new(None),
            lease,
            #[cfg(test)]
            handoff_failure: AtomicBool::new(false),
            #[cfg(test)]
            worker_panic: AtomicBool::new(false),
        });
        for (stream, reader) in spawned.readers {
            read_output(session.clone(), stream, reader).unwrap();
        }
        let mut process = spawned.process;
        let deadline = Instant::now() + Duration::from_secs(4);
        loop {
            let snapshot = session.snapshot(0).unwrap();
            if snapshot
                .chunks
                .iter()
                .any(|chunk| chunk.data.windows(5).any(|bytes| bytes == b"READY"))
            {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "Real fixture failed to start: {snapshot:?}"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        process.fail_next_cleanup();
        let first = process.finish(true);
        assert!(first.is_err());
        *session.retained_process.lock().unwrap() = Some(process);
        complete_cleanup_attempt(&session, first, true);
        let failed = session.snapshot(0).unwrap();
        assert!(gate.install().is_err());
        assert_eq!(failed.state, ExecutionState::CleanupUnknown);
        assert_eq!(failed.completion_reason, Some("cleanup-unknown"));
        assert!(failed.stop_requested);
        assert!(!failed.cleanup_confirmed);
        assert_eq!(failed.owned_pid, pid);
        assert!(failed
            .cleanup_error
            .as_deref()
            .unwrap()
            .contains("Injected native cleanup failure"));
        assert!(failed
            .cleanup_recovery
            .as_deref()
            .unwrap()
            .contains("Retry cleanup"));
        assert!(TcpListener::bind(("127.0.0.1", port)).is_err());
        let supervisor = ExecutionSupervisor::default();
        supervisor
            .sessions
            .lock()
            .unwrap()
            .insert(session.id.clone(), session.clone());
        assert!(supervisor
            .start(
                "main",
                &context,
                fixture_spec("exit 0"),
                "run",
                24,
                80,
                fixture_work()
            )
            .is_err());
        session.handoff_failure.store(true, Ordering::SeqCst);
        assert!(supervisor
            .stop_owned("main", &context, &session.id)
            .is_err());
        assert!(gate.install().is_err());
        assert_eq!(
            session
                .retained_process
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .owned_pid(),
            pid
        );
        let retried = supervisor
            .stop_owned("main", &context, &session.id)
            .unwrap();
        assert_eq!(retried.owned_pid, pid);
        assert!(retried.cleanup_confirmed, "{retried:?}");
        assert_eq!(retried.state, ExecutionState::Exited);
        assert_eq!(retried.completion_reason, Some("stopped"));
        assert!(retried.stop_requested);
        assert_eq!(retried.exit_signal, Some(libc::SIGKILL));
        assert!(retried.cleanup_error.is_none());
        assert!(retried.cleanup_recovery.is_none());
        assert!(session.retained_process.lock().unwrap().is_none());
        assert!(gate.install().is_ok());
        let rebound = TcpListener::bind(("127.0.0.1", port)).unwrap();
        assert_eq!(rebound.local_addr().unwrap().port(), port);
        supervisor.shutdown_all().unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn cleanup_retry_preserves_original_natural_failure() {
        let gate = crate::maintenance::Gate::default();
        let lease = ExecutionWork::new(gate.work().unwrap());
        let spawned =
            platform::spawn(&fixture_spec("exit 23"), false, 24, 80, lease.clone()).unwrap();
        let context = fixture_context();
        let session = Arc::new(Session {
            id: "natural-failure-retry".into(),
            kind: "run".into(),
            context: context.clone(),
            window: "main".into(),
            state: Mutex::new((ExecutionState::Running, None, false)),
            termination_requested: AtomicBool::new(false),
            exit_signal: Mutex::new(None),
            owned_pid: spawned.process.owned_pid(),
            cleanup_error: Mutex::new(None),
            output: Mutex::new(Output {
                chunks: VecDeque::new(),
                bytes: 0,
                sequence: 0,
            }),
            stop: AtomicBool::new(false),
            io: Mutex::new(spawned.io),
            readers: AtomicUsize::new(0),
            retained_process: Mutex::new(None),
            lease,
            #[cfg(test)]
            handoff_failure: AtomicBool::new(false),
            #[cfg(test)]
            worker_panic: AtomicBool::new(false),
        });
        for (stream, reader) in spawned.readers {
            read_output(session.clone(), stream, reader).unwrap();
        }
        let mut process = spawned.process;
        let deadline = Instant::now() + Duration::from_secs(3);
        while !process.exited().unwrap() {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        process.fail_next_cleanup();
        let failed = process.finish(false);
        *session.retained_process.lock().unwrap() = Some(process);
        complete_cleanup_attempt(&session, failed, false);
        let unknown = session.snapshot(0).unwrap();
        assert_eq!(unknown.state, ExecutionState::CleanupUnknown);
        assert_eq!(unknown.completion_reason, Some("cleanup-unknown"));
        assert!(!unknown.stop_requested);
        assert!(!unknown.cleanup_confirmed);
        assert!(gate.install().is_err());
        let supervisor = ExecutionSupervisor::default();
        supervisor
            .sessions
            .lock()
            .unwrap()
            .insert(session.id.clone(), session.clone());
        let retried = supervisor
            .stop_owned("main", &context, &session.id)
            .unwrap();
        assert_eq!(retried.state, ExecutionState::Failed);
        assert_eq!(retried.completion_reason, Some("failed"));
        assert_eq!(retried.exit_code, Some(23));
        assert_eq!(retried.exit_signal, None);
        assert!(!retried.stop_requested);
        assert!(retried.cleanup_confirmed);
        assert!(gate.install().is_ok());
        supervisor.shutdown_all().unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn real_cancel_run_preserves_terminal_and_its_input() {
        use std::net::TcpListener;
        let reserved = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = reserved.local_addr().unwrap().port();
        drop(reserved);
        let policy = ExecutionPolicy::default();
        let context = policy
            .transition_bind(
                "main",
                std::env::temp_dir().canonicalize().unwrap(),
                "domain-isolation".into(),
                || Ok(()),
            )
            .unwrap();
        let context = policy.set_trust("main", &context, true).unwrap();
        let supervisor = ExecutionSupervisor::default();
        let mut shell = fixture_spec("");
        shell.args.clear();
        let terminal = supervisor
            .start("main", &context, shell, "terminal", 24, 80, fixture_work())
            .unwrap();
        let script=format!("exec /usr/bin/python3 -c 'import socket,time,signal; s=socket.socket(); s.bind((\"127.0.0.1\",{port})); s.listen(); signal.signal(signal.SIGTERM,signal.SIG_IGN); print(\"READY\",flush=True); time.sleep(60)'");
        let run = supervisor
            .start(
                "main",
                &context,
                fixture_spec(&script),
                "run",
                24,
                80,
                fixture_work(),
            )
            .unwrap();
        let probe = supervisor
            .start(
                "main",
                &context,
                fixture_spec("sleep 60"),
                "probe",
                24,
                80,
                fixture_work(),
            )
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(4);
        loop {
            let snapshot = supervisor
                .session("main", &context, &run.id)
                .unwrap()
                .snapshot(0)
                .unwrap();
            if snapshot
                .chunks
                .iter()
                .any(|chunk| chunk.data.windows(5).any(|bytes| bytes == b"READY"))
            {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "Run fixture did not become ready: {snapshot:?}"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        let updated = policy.invalidate_pending("main", &context).unwrap();
        supervisor.cancel_run_owned("main", &updated).unwrap();
        assert!(updated.trusted);
        assert!(policy.with_admission("main", &context, || Ok(())).is_err());
        assert!(
            supervisor
                .session("main", &updated, &run.id)
                .unwrap()
                .snapshot(0)
                .unwrap()
                .cleanup_confirmed
        );
        assert!(
            supervisor
                .session("main", &updated, &probe.id)
                .unwrap()
                .snapshot(0)
                .unwrap()
                .cleanup_confirmed
        );
        let rebound = TcpListener::bind(("127.0.0.1", port)).unwrap();
        let terminal = supervisor.session("main", &updated, &terminal.id).unwrap();
        assert!(!terminal.stop.load(Ordering::SeqCst));
        assert!(!terminal.snapshot(0).unwrap().cleanup_confirmed);
        policy
            .with_admission("main", &updated, || {
                let mut io = terminal.io.lock().unwrap();
                io.write(b"printf '\\141\\154\\151\\166\\145-after-run-cancel\\n'\r")
            })
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut after = 0;
        let mut output = Vec::new();
        loop {
            let snapshot = terminal.snapshot(after).unwrap();
            after = snapshot.sequence;
            for chunk in snapshot.chunks {
                output.extend(chunk.data);
            }
            if output
                .windows(b"alive-after-run-cancel".len())
                .any(|bytes| bytes == b"alive-after-run-cancel")
            {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "Preserved terminal did not execute input: {}",
                String::from_utf8_lossy(&output)
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(rebound.local_addr().unwrap().port(), port);
        supervisor.shutdown_all().unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn real_pty_echo_unicode_resize_and_stop() {
        let supervisor = ExecutionSupervisor::default();
        let context = fixture_context();
        let mut spec = fixture_spec("");
        spec.args = vec![];
        let started = supervisor
            .start("main", &context, spec, "terminal", 24, 80, fixture_work())
            .unwrap();
        let session = supervisor.session("main", &context, &started.id).unwrap();
        session.io.lock().unwrap().resize(40, 100).unwrap();
        session
            .io
            .lock()
            .unwrap()
            .write("printf '\\316\\251-ready\\n'\r".as_bytes())
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut observed = Vec::new();
        let mut after = 0;
        loop {
            let snapshot = session.snapshot(after).unwrap();
            after = snapshot.sequence;
            for chunk in snapshot.chunks {
                observed.extend(chunk.data);
            }
            if observed
                .windows("Ω-ready".len())
                .any(|c| c == "Ω-ready".as_bytes())
            {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "PTY output: {}",
                String::from_utf8_lossy(&observed)
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        let stopped = supervisor
            .stop_owned("main", &context, &started.id)
            .unwrap();
        assert!(stopped.cleanup_confirmed);
        assert_eq!(stopped.completion_reason, Some("stopped"));
        assert_eq!(stopped.state, ExecutionState::Exited);
        assert!(stopped.stop_requested);
    }
}
