use super::*;
use crate::execution_work::SpawnFailure;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::OnceLock;

pub(super) struct SessionIo {
    master: Option<Box<dyn MasterPty + Send>>,
    writer: Option<std::sync::mpsc::SyncSender<Vec<u8>>>,
    input_done: Option<std::sync::mpsc::Receiver<()>>,
}
impl SessionIo {
    pub(super) fn write(&mut self, data: &[u8]) -> Result<(), String> {
        self.writer
            .as_ref()
            .ok_or("Terminal input is closed.")?
            .try_send(data.to_vec())
            .map_err(|_| "Terminal input is busy or closed. Wait before retrying the paste.".into())
    }
    pub(super) fn resize(&mut self, rows: u16, cols: u16) -> Result<(), String> {
        self.master
            .as_ref()
            .ok_or("This execution has no terminal.")?
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|_| "Terminal resize failed.".into())
    }
    pub(super) fn close(&mut self) -> Result<(), String> {
        self.writer.take();
        self.master.take();
        if let Some(done) = self.input_done.as_ref() {
            done.recv_timeout(Duration::from_secs(2))
                .map_err(|_| "Terminal input teardown is unconfirmed.")?;
            self.input_done = None;
        }
        Ok(())
    }
}
type OutputReaders = Vec<(String, Box<dyn Read + Send>)>;
pub(super) struct Spawned {
    pub(super) process: OwnedProcess,
    pub(super) io: SessionIo,
    pub(super) readers: OutputReaders,
}
enum Child {
    Pipe(std::process::Child),
    Pty(Box<dyn portable_pty::Child + Send + Sync>),
}
pub(super) struct OwnedProcess {
    child: Option<Child>,
    pid: Option<i32>,
    lease: Arc<ExecutionWork>,
    completed_code: Option<u32>,
    finished: bool,
    exit_signal: Option<i32>,
    #[cfg(test)]
    fail_cleanup_once: bool,
}
impl OwnedProcess {
    pub(super) fn exit_signal(&self) -> Option<i32> {
        self.exit_signal
    }
    pub(super) fn owned_pid(&self) -> u32 {
        self.pid.unwrap_or(0) as u32
    }
    #[cfg(test)]
    pub(super) fn fail_next_cleanup(&mut self) {
        self.fail_cleanup_once = true;
    }
    // WNOWAIT deliberately leaves the leader unreaped. Its reserved PID prevents
    // accidentally signalling a recycled group/session after a fast leader exit.
    pub(super) fn exited(&mut self) -> Result<bool, String> {
        let pid = self
            .pid
            .ok_or("Owned process identity is unavailable; cleanup remains unconfirmed.")?;
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                pid as _,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if result != 0 {
            return Err("Unable to inspect the owned execution.".into());
        }
        let exited = unsafe { info.si_pid() } == pid;
        if exited && matches!(info.si_code, libc::CLD_KILLED | libc::CLD_DUMPED) {
            self.exit_signal = Some(unsafe { info.si_status() });
        }
        Ok(exited)
    }
    pub(super) fn finish(&mut self, requested_stop: bool) -> Result<u32, String> {
        #[cfg(test)]
        if std::mem::take(&mut self.fail_cleanup_once) {
            return Err("Injected native cleanup failure; owned process retained.".into());
        }
        if let Some(code) = self.completed_code {
            return Ok(code);
        }
        let pid = self
            .pid
            .ok_or("Owned process identity is unavailable; cleanup remains unconfirmed.")?;
        // Interactive shells create foreground job groups inside their session.
        // Signal all groups in our session, never a process name or listening port.
        if requested_stop {
            signal_session(pid, libc::SIGTERM)?;
            std::thread::sleep(Duration::from_millis(300));
        }
        signal_session(pid, libc::SIGKILL)?;
        let deadline = Instant::now() + Duration::from_secs(2);
        while session_members(pid)?.iter().any(|member| *member != pid) {
            if Instant::now() >= deadline {
                return Err("Owned descendants remain; cleanup is unknown.".into());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        // SIGKILL does not guarantee immediate reaping (for example a process
        // stuck in kernel I/O). Never let wait() turn Stop into an infinite wait.
        while !self.exited()? {
            if Instant::now() >= deadline {
                return Err("Owned leader did not exit before the cleanup deadline.".into());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let (code, signal) = match self
            .child
            .as_mut()
            .ok_or("Owned process handle unavailable.")?
        {
            Child::Pipe(child) => child.wait().map(|status| {
                use std::os::unix::process::ExitStatusExt;
                (status.code().unwrap_or(1) as u32, status.signal())
            }),
            Child::Pty(child) => child
                .wait()
                .map(|status| (status.exit_code(), self.exit_signal)),
        }
        .map_err(|_| "Unable to reap the owned execution.")?;
        self.exit_signal = signal;
        self.finished = true;
        self.completed_code = Some(code);
        Ok(code)
    }
}
struct QuarantinedUnix {
    _child: Option<Child>,
    _pid: Option<i32>,
    _io: Option<SessionIo>,
    _lease: Arc<ExecutionWork>,
}
static QUARANTINED: OnceLock<Mutex<Vec<QuarantinedUnix>>> = OnceLock::new();
#[cfg(test)]
pub(super) fn assert_no_quarantine() -> Result<(), String> {
    let entries = QUARANTINED
        .get_or_init(|| Mutex::new(Vec::new()))
        .lock()
        .map_err(|_| "Native execution quarantine is unavailable.")?;
    if entries.is_empty() {
        Ok(())
    } else {
        Err("Native execution cleanup remains quarantined; installation is blocked.".into())
    }
}
impl Drop for OwnedProcess {
    fn drop(&mut self) {
        if self.finished || self.finish(true).is_ok() {
            return;
        }
        let Some(child) = self.child.take() else {
            return;
        };
        let entry = QuarantinedUnix {
            _child: Some(child),
            _pid: self.pid,
            _io: None,
            _lease: self.lease.clone(),
        };
        QUARANTINED
            .get_or_init(|| Mutex::new(Vec::new()))
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push(entry);
    }
}
fn owner(child: Child, pid: Option<i32>, lease: Arc<ExecutionWork>) -> OwnedProcess {
    OwnedProcess {
        child: Some(child),
        pid,
        lease,
        completed_code: None,
        finished: false,
        exit_signal: None,
        #[cfg(test)]
        fail_cleanup_once: false,
    }
}
fn abort_spawn(mut process: OwnedProcess, mut io: SessionIo, message: &str) -> SpawnFailure {
    let clean = process.finish(true).is_ok() && io.close().is_ok();
    if clean {
        let lease = process.lease.clone();
        drop(process);
        drop(io);
        lease.confirmed_cleanup();
        SpawnFailure::clean(message)
    } else {
        let entry = QuarantinedUnix {
            _child: process.child.take(),
            _pid: process.pid,
            _io: Some(io),
            _lease: process.lease.clone(),
        };
        QUARANTINED
            .get_or_init(|| Mutex::new(Vec::new()))
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push(entry);
        process.finished = true; // ownership was transferred, not cleaned
        SpawnFailure::unknown(format!(
            "{message} Native partial-spawn cleanup is unconfirmed."
        ))
    }
}

pub(super) fn spawn(
    spec: &LaunchSpec,
    terminal: bool,
    rows: u16,
    cols: u16,
    lease: Arc<ExecutionWork>,
) -> Result<Spawned, SpawnFailure> {
    if terminal {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: rows.clamp(1, 500),
                cols: cols.clamp(1, 1000),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|_| "Unable to allocate a native terminal.")?;
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|_| "Unable to allocate terminal output.")?;
        let mut writer = pair
            .master
            .take_writer()
            .map_err(|_| "Unable to allocate terminal input.")?;
        let (send, receive) = std::sync::mpsc::sync_channel::<Vec<u8>>(8);
        let mut cmd = CommandBuilder::new(&spec.executable);
        cmd.args(&spec.args);
        cmd.cwd(&spec.cwd);
        cmd.env_clear();
        for (key, value) in &spec.env {
            cmd.env(key, value);
        }
        cmd.env("TERM", "xterm-256color");
        let child = pair.slave.spawn_command(cmd).map_err(|_| "Unable to start the selected shell. Check its executable, permissions and working directory.")?;
        // Establish native ownership before any post-spawn conversion/extraction.
        let pid = child.process_id().and_then(|pid| i32::try_from(pid).ok());
        let process = owner(Child::Pty(child), pid, lease);
        drop(pair.slave);
        let mut io = SessionIo {
            master: Some(pair.master),
            writer: Some(send),
            input_done: None,
        };
        if pid.is_none() {
            return Err(abort_spawn(
                process,
                io,
                "Terminal did not provide an owned process identity.",
            ));
        }
        let (done, completed) = std::sync::mpsc::channel();
        if std::thread::Builder::new()
            .name("helm-terminal-input".into())
            .spawn(move || {
                while let Ok(data) = receive.recv() {
                    if writer.write_all(&data).is_err() {
                        break;
                    }
                }
                drop(writer);
                let _ = done.send(());
            })
            .is_err()
        {
            return Err(abort_spawn(
                process,
                io,
                "Unable to start terminal input worker.",
            ));
        }
        io.input_done = Some(completed);
        Ok(Spawned {
            process,
            io,
            readers: vec![("terminal".into(), reader)],
        })
    } else {
        use std::os::unix::process::CommandExt;
        let mut cmd = Command::new(&spec.executable);
        cmd.args(&spec.args)
            .current_dir(&spec.cwd)
            .env_clear()
            .envs(&spec.env)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // setsid owns descendants across child process groups, including shells.
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() < 0 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
        let child = cmd.spawn().map_err(|_| "Unable to start the configured executable. Check its path, permissions and working directory.")?;
        let pid = i32::try_from(child.id()).ok();
        let mut process = owner(Child::Pipe(child), pid, lease);
        let io = SessionIo {
            master: None,
            writer: None,
            input_done: None,
        };
        if pid.is_none() {
            return Err(abort_spawn(process, io, "Invalid process identity."));
        }
        let readers = match extract_run_readers(&mut process) {
            Ok(readers) => readers,
            Err(message) => return Err(abort_spawn(process, io, message)),
        };
        Ok(Spawned {
            process,
            io,
            readers,
        })
    }
}

fn extract_run_readers(process: &mut OwnedProcess) -> Result<OutputReaders, &'static str> {
    let Some(Child::Pipe(child)) = process.child.as_mut() else {
        return Err("Run process handle unavailable.");
    };
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        return Err("Run output pipes unavailable.");
    };
    Ok(vec![
        ("stdout".into(), Box::new(stdout)),
        ("stderr".into(), Box::new(stderr)),
    ])
}

#[cfg(target_os = "macos")]
fn process_ids() -> Result<Vec<i32>, String> {
    #[link(name = "proc")]
    unsafe extern "C" {
        fn proc_listallpids(buffer: *mut std::ffi::c_void, buffersize: i32) -> i32;
    }
    let mut ids = vec![0i32; 65536];
    let count = unsafe { proc_listallpids(ids.as_mut_ptr().cast(), (ids.len() * 4) as i32) };
    if count <= 0 || count as usize >= ids.len() {
        return Err("Process enumeration failed; cleanup cannot be proven.".into());
    }
    ids.truncate(count as usize);
    Ok(ids)
}
#[cfg(not(target_os = "macos"))]
fn process_ids() -> Result<Vec<i32>, String> {
    std::fs::read_dir("/proc")
        .map_err(|_| "Process enumeration unavailable.".to_string())
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter_map(|e| e.file_name().to_str()?.parse().ok())
                .collect()
        })
}
#[cfg(target_os = "macos")]
fn zombie(pid: i32) -> bool {
    #[link(name = "proc")]
    unsafe extern "C" {
        fn proc_pidinfo(
            pid: i32,
            flavor: i32,
            arg: u64,
            buffer: *mut std::ffi::c_void,
            buffersize: i32,
        ) -> i32;
    }
    let mut info = [0u32; 64];
    let result = unsafe { proc_pidinfo(pid, 3, 0, info.as_mut_ptr().cast(), 256) };
    result > 8 && info[1] == 5 // PROC_PIDTBSDINFO, SZOMB
}
#[cfg(not(target_os = "macos"))]
fn zombie(pid: i32) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/stat"))
        .ok()
        .and_then(|s| {
            s.rsplit_once(')')
                .map(|(_, tail)| tail.trim_start().starts_with('Z'))
        })
        .unwrap_or(false)
}
fn session_members(sid: i32) -> Result<Vec<i32>, String> {
    Ok(process_ids()?
        .into_iter()
        .filter(|pid| *pid > 1 && unsafe { libc::getsid(*pid) } == sid && !zombie(*pid))
        .collect())
}
fn signal_session(sid: i32, signal: i32) -> Result<(), String> {
    let mut groups = std::collections::HashSet::new();
    for pid in session_members(sid)? {
        let group = unsafe { libc::getpgid(pid) };
        if group > 1 {
            groups.insert(group);
        }
    }
    // The leader remains unreaped until after all signals, reserving sid/pgid.
    for group in groups {
        // A foreground job group may disappear while the original session
        // leader is still unreaped. Re-enumerate immediately before signalling
        // so an already-recycled secondary PGID does not gain our authority.
        let live = session_members(sid)?;
        let owned_member = live
            .into_iter()
            .find(|pid| unsafe { libc::getpgid(*pid) } == group);
        let Some(member) = owned_member else {
            continue;
        };
        let leader_session = unsafe { libc::getsid(group) };
        if leader_session > 0 && leader_session != sid {
            return Err("Owned job-group identity changed; cleanup remains unconfirmed.".into());
        }
        let current_session = unsafe { libc::getsid(member) };
        if current_session < 0
            && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
        {
            continue;
        }
        let current_group = unsafe { libc::getpgid(member) };
        if current_group < 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
        {
            continue;
        }
        if current_session != sid || current_group != group {
            return Err("Owned job-group membership changed during cleanup. Retry cleanup.".into());
        }
        // POSIX has no atomic session-qualified kill operation. These checks
        // narrow the race but do not claim protection from adversarial PID churn.
        if unsafe { libc::kill(-group, signal) } != 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(
                    "Unable to signal the owned session; cleanup remains unconfirmed.".into(),
                );
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod maintenance_tests {
    use super::*;
    #[test]
    fn post_spawn_pipe_failure_uses_checked_abort_before_admission_release() {
        let gate = crate::maintenance::Gate::default();
        let lease = ExecutionWork::new(gate.work().unwrap());
        let spec = super::super::tests::fixture_spec("sleep 60");
        let spawned = spawn(&spec, false, 24, 80, lease.clone()).unwrap();
        let mut process = spawned.process;
        let pid = process.owned_pid();
        assert!(pid > 1);
        assert!(gate.install().is_err());
        // Successful extraction already took both pipes. The production
        // post-spawn extraction helper now follows its real missing-pipe branch.
        assert!(extract_run_readers(&mut process).is_err());
        let failure = abort_spawn(process, spawned.io, "Injected missing run pipes.");
        assert!(!failure.cleanup_unknown, "{}", failure.message);
        assert!(gate.install().is_ok());
        assert_eq!(
            unsafe { libc::waitpid(pid as i32, std::ptr::null_mut(), libc::WNOHANG) },
            -1
        );
    }
}
