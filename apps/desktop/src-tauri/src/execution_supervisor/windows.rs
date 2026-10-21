//! Windows ownership is established while the initial thread is suspended.
//! Pseudoconsole closure alone is never used as proof of descendant cleanup.
use super::*;
use crate::execution_work::{ExecutionWork, SpawnFailure};
use std::ffi::c_void;
use std::mem::{size_of, zeroed};
use std::ptr::{null, null_mut};
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::sync::OnceLock;
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, SetHandleInformation, ERROR_BROKEN_PIPE, ERROR_HANDLE_EOF, HANDLE,
    HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, ReadFile, WriteFile, FILE_GENERIC_READ, FILE_SHARE_READ, FILE_SHARE_WRITE,
    OPEN_EXISTING,
};
use windows_sys::Win32::System::Console::{
    ClosePseudoConsole, CreatePseudoConsole, ResizePseudoConsole, COORD, HPCON,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
    JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
    TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess, GetProcessId,
    InitializeProcThreadAttributeList, ResumeThread, TerminateProcess, UpdateProcThreadAttribute,
    WaitForSingleObject, CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT,
    EXTENDED_STARTUPINFO_PRESENT, LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION,
    PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, STARTF_USESTDHANDLES,
    STARTUPINFOEXW,
};

struct Handle(HANDLE);
// Each wrapper exclusively owns one kernel handle. Moving ownership across a
// worker boundary is supported by Win32; no caller shares mutable handle state.
unsafe impl Send for Handle {}
impl Handle {
    fn new(raw: HANDLE, message: &str) -> Result<Self, String> {
        if raw.is_null() || raw == INVALID_HANDLE_VALUE {
            Err(message.into())
        } else {
            Ok(Self(raw))
        }
    }
}
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
struct PipeReader(Handle);
impl Read for PipeReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        let mut count = 0;
        let result = unsafe {
            ReadFile(
                self.0 .0,
                buffer.as_mut_ptr(),
                buffer.len().min(u32::MAX as usize) as u32,
                &mut count,
                null_mut(),
            )
        };
        if result != 0 {
            return Ok(count as usize);
        }
        let error = unsafe { GetLastError() };
        if error == ERROR_BROKEN_PIPE || error == ERROR_HANDLE_EOF {
            Ok(0)
        } else {
            Err(std::io::Error::from_raw_os_error(error as i32))
        }
    }
}
fn write_pipe(handle: &Handle, mut bytes: &[u8]) -> Result<(), ()> {
    while !bytes.is_empty() {
        let mut count = 0;
        if unsafe {
            WriteFile(
                handle.0,
                bytes.as_ptr(),
                bytes.len().min(u32::MAX as usize) as u32,
                &mut count,
                null_mut(),
            )
        } == 0
            || count == 0
        {
            return Err(());
        }
        bytes = &bytes[count as usize..];
    }
    Ok(())
}
struct InputWorker {
    sender: Mutex<Option<SyncSender<Vec<u8>>>>,
    receiver: Mutex<Option<mpsc::Receiver<Vec<u8>>>>,
    pending_handle: Mutex<Option<Handle>>,
    started: AtomicBool,
    finished: AtomicBool,
    // An input writer is not a passive output reader. It retains the same lease
    // until its exact pipe is closed and the worker acknowledges completion.
    _lease: Arc<ExecutionWork>,
}
impl InputWorker {
    fn new(handle: Handle, lease: Arc<ExecutionWork>) -> Arc<Self> {
        let (sender, receiver) = mpsc::sync_channel(8);
        Arc::new(Self {
            sender: Mutex::new(Some(sender)),
            receiver: Mutex::new(Some(receiver)),
            pending_handle: Mutex::new(Some(handle)),
            started: AtomicBool::new(false),
            finished: AtomicBool::new(false),
            _lease: lease,
        })
    }
    fn start(self: &Arc<Self>) -> Result<(), String> {
        self.started.store(true, Ordering::Release);
        let worker = self.clone();
        // The handle and receiver remain in durable Arc storage until a running
        // thread takes them. A failed handoff cannot drop their only owner.
        if std::thread::Builder::new()
            .name("execution-input".into())
            .spawn(move || {
                let handle = match worker.pending_handle.lock() {
                    Ok(mut pending) => pending.take(),
                    Err(_) => return,
                };
                let receiver = match worker.receiver.lock() {
                    Ok(mut pending) => pending.take(),
                    Err(_) => return,
                };
                let (Some(handle), Some(receiver)) = (handle, receiver) else {
                    return;
                };
                while let Ok(data) = receiver.recv() {
                    if write_pipe(&handle, &data).is_err() {
                        break;
                    }
                }
                drop(handle);
                worker.finished.store(true, Ordering::Release);
            })
            .is_err()
        {
            self.started.store(false, Ordering::Release);
            return Err("Unable to start the terminal input worker.".into());
        }
        Ok(())
    }
    fn write(&self, data: &[u8]) -> Result<(), String> {
        let sender = self
            .sender
            .lock()
            .map_err(|_| "Terminal input state is unavailable.")?;
        let sender = sender.as_ref().ok_or("Terminal input is closed.")?;
        match sender.try_send(data.to_vec()) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => {
                Err("Terminal input is busy; wait before pasting more.".into())
            }
            Err(TrySendError::Disconnected(_)) => Err("Terminal input is closed.".into()),
        }
    }
    fn stop_sending(&self) -> Result<(), String> {
        self.sender
            .lock()
            .map_err(|_| "Terminal input teardown is unconfirmed.")?
            .take();
        Ok(())
    }
    fn close_bounded(&self) -> Result<(), String> {
        self.stop_sending()?;
        if !self.started.load(Ordering::Acquire) {
            // A failed Builder::spawn created no worker. Closing its still-owned
            // pipe and receiver is a checked no-thread cleanup path.
            self.pending_handle
                .lock()
                .map_err(|_| "Unstarted terminal input handle is unavailable.")?
                .take();
            self.receiver
                .lock()
                .map_err(|_| "Unstarted terminal input queue is unavailable.")?
                .take();
            self.finished.store(true, Ordering::Release);
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        while !self.finished.load(Ordering::Acquire) {
            if Instant::now() >= deadline {
                return Err("Terminal input worker cleanup is unconfirmed.".into());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        Ok(())
    }
}
fn pipe(inheritable: bool) -> Result<(Handle, Handle), String> {
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: null_mut(),
        bInheritHandle: i32::from(inheritable),
    };
    let mut read = null_mut();
    let mut write = null_mut();
    if unsafe { CreatePipe(&mut read, &mut write, &attributes, 0) } == 0 {
        return Err("Unable to allocate execution pipes.".into());
    }
    Ok((
        Handle::new(read, "Execution pipe unavailable.")?,
        Handle::new(write, "Execution pipe unavailable.")?,
    ))
}
fn private_handle(handle: &Handle) -> Result<(), String> {
    if unsafe { SetHandleInformation(handle.0, HANDLE_FLAG_INHERIT, 0) } == 0 {
        return Err("Unable to restrict execution handle inheritance.".into());
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum ConsoleState {
    Open(HPCON),
    Closing(HPCON),
    Closed,
}
struct PseudoConsole {
    state: Mutex<ConsoleState>,
    closed: AtomicBool,
    lease: Arc<ExecutionWork>,
}
impl PseudoConsole {
    fn raw(&self) -> Result<HPCON, String> {
        match *self
            .state
            .lock()
            .map_err(|_| "Terminal state unavailable.")?
        {
            ConsoleState::Open(handle) => Ok(handle),
            ConsoleState::Closing(_) | ConsoleState::Closed => {
                Err("Terminal is closing or closed.".into())
            }
        }
    }
    fn resize(&self, rows: u16, cols: u16) -> Result<(), String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "Terminal state unavailable.")?;
        let ConsoleState::Open(handle) = *state else {
            return Err("Terminal is closing or closed.".into());
        };
        if unsafe {
            ResizePseudoConsole(
                handle,
                COORD {
                    X: cols.clamp(1, 1000) as i16,
                    Y: rows.clamp(1, 500) as i16,
                },
            )
        } < 0
        {
            return Err("Unable to resize the Windows pseudoconsole.".into());
        }
        Ok(())
    }
    fn close_bounded(self: &Arc<Self>) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Terminal teardown state unavailable.")?;
        match *state {
            ConsoleState::Closed => return Ok(()),
            ConsoleState::Closing(_) => {}
            ConsoleState::Open(handle) => {
                *state = ConsoleState::Closing(handle);
                let worker = self.clone();
                // State retains the exact HPCON and shared lease across this
                // fallible handoff. The worker cannot pass the state lock before
                // handoff succeeds, so Err can safely restore the open state.
                if std::thread::Builder::new()
                    .name("execution-conpty-close".into())
                    .spawn(move || {
                        let handle = match worker.state.lock() {
                            Ok(state) => match *state {
                                ConsoleState::Closing(handle) => handle,
                                _ => return,
                            },
                            Err(_) => return,
                        };
                        unsafe {
                            ClosePseudoConsole(handle);
                        }
                        if let Ok(mut state) = worker.state.lock() {
                            *state = ConsoleState::Closed;
                            worker.closed.store(true, Ordering::Release);
                        }
                    })
                    .is_err()
                {
                    *state = ConsoleState::Open(handle);
                    return Err(
                        "Unable to start Windows terminal teardown; its helper remains owned."
                            .into(),
                    );
                }
            }
        }
        drop(state);
        let deadline = Instant::now() + Duration::from_secs(2);
        while !self.closed.load(Ordering::Acquire) {
            if Instant::now() >= deadline {
                return Err("Windows terminal teardown is unconfirmed. Restart and installation remain blocked.".into());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        match *self
            .state
            .lock()
            .map_err(|_| "Terminal teardown state is poisoned.")?
        {
            ConsoleState::Closed => Ok(()),
            _ => Err("Windows terminal helper cleanup is unconfirmed.".into()),
        }
    }
}
impl Drop for PseudoConsole {
    fn drop(&mut self) {
        // Unexpected last-owner Drop is not proof that ClosePseudoConsole ran.
        // Preserve a raw helper-only record and lease instead of discarding an
        // error from a best-effort destructor, even if its state was poisoned.
        let state = self
            .state
            .get_mut()
            .unwrap_or_else(|error| error.into_inner());
        match std::mem::replace(state, ConsoleState::Closed) {
            ConsoleState::Closed => {}
            ConsoleState::Open(handle) | ConsoleState::Closing(handle) => {
                retain_quarantine(QuarantinedOwner::RawConsole {
                    _handle: handle,
                    _lease: self.lease.clone(),
                });
            }
        }
    }
}

pub(super) struct SessionIo {
    console: Option<Arc<PseudoConsole>>,
    input: Option<Arc<InputWorker>>,
    _lease: Arc<ExecutionWork>,
}
impl SessionIo {
    pub(super) fn write(&mut self, data: &[u8]) -> Result<(), String> {
        self.input
            .as_ref()
            .ok_or("Terminal input is closed.")?
            .write(data)
    }
    pub(super) fn resize(&mut self, rows: u16, cols: u16) -> Result<(), String> {
        self.console
            .as_ref()
            .ok_or("This execution has no terminal.")?
            .resize(rows, cols)
    }
    pub(super) fn close(&mut self) -> Result<(), String> {
        if let Some(input) = &self.input {
            input.stop_sending()?;
        }
        if let Some(console) = &self.console {
            console.close_bounded()?;
        }
        if let Some(input) = &self.input {
            input.close_bounded()?;
        }
        self.input.take();
        self.console.take();
        Ok(())
    }
}
pub(super) struct Spawned {
    pub(super) process: OwnedProcess,
    pub(super) io: SessionIo,
    pub(super) readers: Vec<(String, Box<dyn Read + Send>)>,
}
struct NativeResources {
    process: Option<Handle>,
    thread: Option<Handle>,
    job: Option<Handle>,
    pid: Option<u32>,
    process_created: bool,
    helper_identity_unknown: bool,
    job_assigned: bool,
    resumed: bool,
    console: Option<Arc<PseudoConsole>>,
    input: Option<Arc<InputWorker>>,
    child_ends: Vec<Handle>,
    readers: Vec<(String, Box<dyn Read + Send>)>,
    lease: Arc<ExecutionWork>,
}
impl NativeResources {
    fn new(lease: Arc<ExecutionWork>) -> Self {
        Self {
            process: None,
            thread: None,
            job: None,
            pid: None,
            process_created: false,
            helper_identity_unknown: false,
            job_assigned: false,
            resumed: false,
            console: None,
            input: None,
            child_ends: Vec::new(),
            readers: Vec::new(),
            lease,
        }
    }
    fn process_handle(&self) -> Result<HANDLE, String> {
        self.process
            .as_ref()
            .map(|handle| handle.0)
            .filter(|handle| !handle.is_null() && *handle != INVALID_HANDLE_VALUE)
            .ok_or("Created Windows process has no usable ownership handle.".into())
    }
    fn exited(&self) -> Result<bool, String> {
        match unsafe { WaitForSingleObject(self.process_handle()?, 0) } {
            WAIT_OBJECT_0 => Ok(true),
            WAIT_TIMEOUT => Ok(false),
            _ => Err("Unable to inspect the owned Windows process.".into()),
        }
    }
    fn active_processes(&self) -> Result<u32, String> {
        let job = self
            .job
            .as_ref()
            .ok_or("Owned Windows job is unavailable.")?;
        let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { zeroed() };
        if unsafe {
            QueryInformationJobObject(
                job.0,
                JobObjectBasicAccountingInformation,
                (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                null_mut(),
            )
        } == 0
        {
            return Err("Owned Windows job cleanup could not be verified.".into());
        }
        Ok(info.ActiveProcesses)
    }
    fn cleanup(&mut self, requested_stop: bool) -> Result<u32, String> {
        if self.helper_identity_unknown {
            return Err("Windows reported a created native helper without a usable ownership handle; cleanup cannot be proven.".into());
        }
        let mut code = 0;
        if self.process_created {
            let process = self.process_handle()?;
            if requested_stop && self.resumed {
                if let Some(input) = &self.input {
                    let _ = input.write(&[3]);
                }
                let deadline = Instant::now() + Duration::from_millis(300);
                while self.job_assigned
                    && self.active_processes()? != 0
                    && Instant::now() < deadline
                {
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
            if self.job_assigned {
                let job = self
                    .job
                    .as_ref()
                    .ok_or("Owned Windows job is unavailable.")?;
                if self.active_processes()? != 0 && unsafe { TerminateJobObject(job.0, 1) } == 0 {
                    return Err(
                        "Unable to terminate the owned Windows job. Cleanup is unknown.".into(),
                    );
                }
                let deadline = Instant::now() + Duration::from_secs(2);
                while self.active_processes()? != 0 || !self.exited()? {
                    if Instant::now() >= deadline {
                        return Err("Owned Windows descendants remain; cleanup is unknown.".into());
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
            } else {
                // Assignment failed while the initial thread was suspended. It
                // has executed no project instruction and can have no project
                // descendants, but exact handle exit still must be observed.
                if self.resumed {
                    return Err("A resumed Windows process lacks confirmed job ownership.".into());
                }
                unsafe {
                    TerminateProcess(process, 1);
                }
                if unsafe { WaitForSingleObject(process, 2000) } != WAIT_OBJECT_0 {
                    return Err(
                        "The unresumed Windows process could not be confirmed terminated.".into(),
                    );
                }
            }
            if unsafe { GetExitCodeProcess(process, &mut code) } == 0 {
                return Err("Unable to read the owned Windows exit status.".into());
            }
        }
        // A failed spawn has no registered output readers. Closing those exact
        // read ends prevents final ConPTY output from depending on a nonexistent
        // reader thread. Bounded ClosePseudoConsole must still prove completion.
        self.child_ends.clear();
        self.readers.clear();
        if let Some(input) = &self.input {
            input.stop_sending()?;
        }
        if let Some(console) = &self.console {
            console.close_bounded()?;
        }
        if let Some(input) = &self.input {
            input.close_bounded()?;
        }
        Ok(code)
    }
}
pub(super) struct OwnedProcess {
    resources: Option<NativeResources>,
    exit_code: Option<u32>,
}
impl OwnedProcess {
    pub(super) fn exit_signal(&self) -> Option<i32> {
        None
    }
    pub(super) fn owned_pid(&self) -> u32 {
        self.resources
            .as_ref()
            .and_then(|owner| owner.process.as_ref())
            .map_or(0, |process| unsafe { GetProcessId(process.0) })
    }
    pub(super) fn exited(&mut self) -> Result<bool, String> {
        self.resources
            .as_ref()
            .ok_or("Windows process ownership is unavailable.")?
            .exited()
    }
    #[cfg(test)]
    fn active_processes(&self) -> Result<u32, String> {
        self.resources
            .as_ref()
            .ok_or("Windows process ownership is unavailable.")?
            .active_processes()
    }
    pub(super) fn finish(&mut self, requested_stop: bool) -> Result<u32, String> {
        if let Some(code) = self.exit_code {
            return Ok(code);
        }
        let code = self
            .resources
            .as_mut()
            .ok_or("Windows process ownership is unavailable.")?
            .cleanup(requested_stop)?;
        self.exit_code = Some(code);
        // The supervisor publishes confirmed lifecycle state, checks SessionIo,
        // then releases this same lease. A platform finish is not that release.
        Ok(code)
    }
}
impl Drop for OwnedProcess {
    fn drop(&mut self) {
        if let Some(mut resources) = self.resources.take() {
            if self.exit_code.is_none() && resources.cleanup(false).is_err() {
                retain_quarantine(QuarantinedOwner::Resources {
                    _resources: Box::new(resources),
                });
            }
            // No confirmation from Drop, including a successful best-effort
            // reap. Unexpected last-lease Drop must remain fail closed.
        }
    }
}

// Attribute-list storage needs native-pointer alignment; Vec<u8> does not
// promise that alignment. Keep this allocation stable through CreateProcessW.
struct Attributes {
    storage: Vec<usize>,
    initialized: bool,
}
impl Attributes {
    fn new(count: u32) -> Result<Self, String> {
        let mut bytes = 0;
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), count, 0, &mut bytes);
        }
        if bytes == 0 {
            return Err("Windows process attributes are unavailable.".into());
        }
        let mut result = Self {
            storage: vec![0; bytes.div_ceil(size_of::<usize>())],
            initialized: false,
        };
        if unsafe { InitializeProcThreadAttributeList(result.raw(), count, 0, &mut bytes) } == 0 {
            return Err("Unable to initialize Windows process attributes.".into());
        }
        result.initialized = true;
        Ok(result)
    }
    fn raw(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.storage.as_mut_ptr().cast()
    }
    fn set(&mut self, attribute: u32, value: *const c_void, size: usize) -> Result<(), String> {
        if unsafe {
            UpdateProcThreadAttribute(
                self.raw(),
                0,
                attribute as usize,
                value,
                size,
                null_mut(),
                null(),
            )
        } == 0
        {
            return Err("Unable to restrict Windows process startup attributes.".into());
        }
        Ok(())
    }
}
impl Drop for Attributes {
    fn drop(&mut self) {
        if self.initialized {
            unsafe {
                DeleteProcThreadAttributeList(self.raw());
            }
        }
    }
}

fn wide(value: &str) -> Result<Vec<u16>, String> {
    if value.contains('\0') {
        return Err("Execution text cannot contain null bytes.".into());
    }
    Ok(value.encode_utf16().chain(Some(0)).collect())
}
fn path_wide(value: &Path) -> Result<Vec<u16>, String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let mut encoded: Vec<_> = value.as_os_str().encode_wide().collect();
        if encoded.contains(&0) {
            return Err("Execution path cannot contain null bytes.".into());
        }
        encoded.push(0);
        Ok(encoded)
    }
    #[cfg(not(windows))]
    {
        wide(&value.to_string_lossy())
    }
}
// Microsoft C-runtime argv quoting. Shell command text is prepared explicitly by
// the run-config layer; direct arguments never become inferred shell syntax.
fn quote_arg(argument: &str) -> String {
    let mut result = String::from("\"");
    let mut slashes = 0;
    for ch in argument.chars() {
        if ch == '\\' {
            slashes += 1;
            continue;
        }
        if ch == '"' {
            result.push_str(&"\\".repeat(slashes * 2 + 1));
        } else {
            result.push_str(&"\\".repeat(slashes));
        }
        result.push(ch);
        slashes = 0;
    }
    result.push_str(&"\\".repeat(slashes * 2));
    result.push('"');
    result
}
fn command_line(executable: &str, args: &[String], shell_command: Option<&str>) -> String {
    // CreateProcess accepts slash separators, but cmd.exe also parses its own
    // argv0 and can mistake a path's /cmd.exe for the /C command switch.
    let executable = executable.replace('/', "\\");
    if let Some(raw) = shell_command {
        // cmd.exe uses its own /S /C grammar. C-runtime escaping here would
        // insert literal backslashes before quotes and alter the shell command.
        format!("{} /D /S /C \"{}\"", quote_arg(&executable), raw)
    } else {
        let mut command = vec![quote_arg(&executable)];
        command.extend(args.iter().map(|argument| quote_arg(argument)));
        command.join(" ")
    }
}
fn environment(spec: &LaunchSpec) -> Result<Vec<u16>, String> {
    let mut entries: Vec<_> = spec.env.iter().collect();
    entries.sort_by_key(|(name, _)| name.to_uppercase());
    let mut previous = None;
    let mut result = Vec::new();
    for (name, value) in entries {
        let normalized = name.to_uppercase();
        if previous.as_ref() == Some(&normalized) {
            return Err("Environment has conflicting Windows variable names.".into());
        }
        previous = Some(normalized);
        if name.contains('=') {
            return Err("Invalid Windows environment variable name.".into());
        }
        result.extend(wide(&format!("{name}={value}"))?);
    }
    // Empty environment still requires two NULs.
    if result.is_empty() {
        result.push(0);
    }
    result.push(0);
    if result.len() > 32767 {
        return Err("Selected Windows environment exceeds 32767 characters.".into());
    }
    Ok(result)
}

fn cmd_component_is_representable(name: &str) -> bool {
    if name.is_empty()
        || name.ends_with('.')
        || name.ends_with(' ')
        || name
            .chars()
            .any(|c| c <= '\u{1f}' || "<>:\"/\\|?*".contains(c))
    {
        return false;
    }
    let stem = name
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end_matches(' ')
        .to_uppercase();
    if matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) {
        return false;
    }
    let port = stem
        .strip_prefix("COM")
        .or_else(|| stem.strip_prefix("LPT"));
    !port.is_some_and(|suffix| {
        matches!(
            suffix,
            "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
        )
    })
}

fn cmd_directory_candidate(cwd: &Path) -> Result<PathBuf, String> {
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Component, Prefix};
    let unsupported = || {
        "System shell requires a representable absolute drive working directory. UNC, device and long paths cannot be used safely with cmd.exe; select a native executable instead. No fallback directory was chosen.".to_string()
    };
    let mut components = cwd.components();
    let drive = match components.next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::Disk(drive) | Prefix::VerbatimDisk(drive) => drive,
            _ => return Err(unsupported()),
        },
        _ => return Err(unsupported()),
    };
    if components.next() != Some(Component::RootDir) {
        return Err(unsupported());
    }
    let mut candidate = PathBuf::from(format!("{}:\\", char::from(drive)));
    for component in components {
        match component {
            Component::Normal(name) => {
                // std canonicalize can retain verbatim NTFS names. Admit DOS
                // names explicitly before using canonical identity as a check.
                if !name.to_str().is_some_and(cmd_component_is_representable) {
                    return Err(unsupported());
                }
                candidate.push(name);
            }
            _ => return Err(unsupported()),
        }
    }
    // cmd's non-verbatim DOS cwd must fit the legacy MAX_PATH boundary,
    // including its terminating NUL. Never rely on a host long-path setting.
    if candidate.as_os_str().encode_wide().count() >= 260 {
        return Err(unsupported());
    }
    Ok(candidate)
}

fn cmd_working_directory(cwd: &Path) -> Result<PathBuf, String> {
    let candidate = cmd_directory_candidate(cwd)?;
    let original = cwd
        .canonicalize()
        .map_err(|_| "System shell working directory is unavailable; no fallback was chosen.")?;
    let checked = candidate.canonicalize().map_err(|_| {
        "System shell working directory cannot be represented safely; no fallback was chosen."
    })?;
    if checked != original {
        return Err("System shell working-directory spelling resolves to a different folder; no fallback was chosen.".into());
    }
    Ok(candidate)
}

// Typed quarantine includes both real processes and helper-only startup work.
// Poisoning its storage never releases handles or the maintenance work lease.
enum QuarantinedOwner {
    Resources {
        _resources: Box<NativeResources>,
    },
    RawConsole {
        _handle: HPCON,
        _lease: Arc<ExecutionWork>,
    },
}
static QUARANTINED: OnceLock<Mutex<Vec<QuarantinedOwner>>> = OnceLock::new();
fn retain_quarantine_in(storage: &Mutex<Vec<QuarantinedOwner>>, owner: QuarantinedOwner) {
    match storage.lock() {
        Ok(mut entries) => entries.push(owner),
        Err(poisoned) => poisoned.into_inner().push(owner),
    }
}
fn retain_quarantine(owner: QuarantinedOwner) {
    retain_quarantine_in(QUARANTINED.get_or_init(|| Mutex::new(Vec::new())), owner);
}
fn assert_quarantine_empty(storage: &Mutex<Vec<QuarantinedOwner>>) -> Result<(), String> {
    let entries = storage
        .lock()
        .map_err(|_| "Windows execution quarantine is poisoned; installation remains blocked.")?;
    if entries.is_empty() {
        Ok(())
    } else {
        Err("Windows process or native helper cleanup remains quarantined; installation is blocked.".into())
    }
}
#[cfg(test)]
pub(super) fn assert_no_quarantine() -> Result<(), String> {
    QUARANTINED.get().map_or(Ok(()), assert_quarantine_empty)
}
fn classify_spawn_failure(
    resources: NativeResources,
    cause: String,
    cleanup: Result<u32, String>,
    storage: &Mutex<Vec<QuarantinedOwner>>,
) -> SpawnFailure {
    match cleanup {
        Ok(_) => {
            let lease = resources.lease.clone();
            drop(resources); // Close all verified-clean native handles before admission reopens.
            lease.confirmed_cleanup();
            SpawnFailure::clean(format!(
                "{cause} Any allocated native owner was confirmed cleaned."
            ))
        }
        Err(detail) => {
            let identity = resources.pid.map_or_else(
                || "helper-only startup without a project PID".into(),
                |pid| format!("owned Windows process {pid}"),
            );
            retain_quarantine_in(
                storage,
                QuarantinedOwner::Resources {
                    _resources: Box::new(resources),
                },
            );
            SpawnFailure::unknown(format!("{cause} Cleanup of {identity} is unconfirmed: {detail} Exact ownership and work admission were retained; restart, replacement and installation remain blocked."))
        }
    }
}
struct ProvisionalOwner {
    resources: Option<NativeResources>,
}
impl ProvisionalOwner {
    fn failure(mut self, cause: String) -> SpawnFailure {
        let Some(mut resources) = self.resources.take() else {
            return SpawnFailure::unknown(
                "Windows startup ownership was lost; installation remains blocked.",
            );
        };
        let result = resources.cleanup(false);
        classify_spawn_failure(
            resources,
            cause,
            result,
            QUARANTINED.get_or_init(|| Mutex::new(Vec::new())),
        )
    }
}
impl Drop for ProvisionalOwner {
    fn drop(&mut self) {
        if let Some(mut resources) = self.resources.take() {
            let result = resources.cleanup(false);
            let _ = classify_spawn_failure(
                resources,
                "Windows startup unwound before ownership transfer.".into(),
                result,
                QUARANTINED.get_or_init(|| Mutex::new(Vec::new())),
            );
        }
    }
}

pub(super) fn spawn(
    spec: &LaunchSpec,
    terminal: bool,
    rows: u16,
    cols: u16,
    lease: Arc<ExecutionWork>,
) -> Result<Spawned, SpawnFailure> {
    let mut provisional = ProvisionalOwner {
        resources: Some(NativeResources::new(lease)),
    };
    match spawn_owned(&mut provisional, spec, terminal, rows, cols) {
        Ok(spawned) => Ok(spawned),
        Err(cause) => Err(provisional.failure(cause)),
    }
}
fn spawn_owned(
    provisional: &mut ProvisionalOwner,
    spec: &LaunchSpec,
    terminal: bool,
    rows: u16,
    cols: u16,
) -> Result<Spawned, String> {
    // Rust canonicalization emits a verbatim path. cmd treats that as UNC and
    // silently switches cwd, so admit only a proven equivalent DOS spelling.
    let selected_cwd = if spec.windows_shell_command.is_some() {
        cmd_working_directory(&spec.cwd)?
    } else {
        spec.cwd.clone()
    };
    let cwd = path_wide(&selected_cwd)?;
    let owner = provisional
        .resources
        .as_mut()
        .ok_or("Windows startup ownership is unavailable.")?;
    owner.job = Some(Handle::new(
        unsafe { CreateJobObjectW(null(), null()) },
        "Unable to allocate a Windows execution job.",
    )?);
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if unsafe {
        SetInformationJobObject(
            owner
                .job
                .as_ref()
                .ok_or("Windows execution job is unavailable.")?
                .0,
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    } == 0
    {
        return Err("Unable to configure Windows process ownership.".into());
    }
    let mut attributes = Attributes::new(1)?;
    let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    let mut inherited = Vec::<HANDLE>::new();
    if terminal {
        let (input_read, input_write) = pipe(false)?;
        let (output_read, output_write) = pipe(false)?;
        let mut raw_console = 0;
        let result = unsafe {
            CreatePseudoConsole(
                COORD {
                    X: cols.clamp(1, 1000) as i16,
                    Y: rows.clamp(1, 500) as i16,
                },
                input_read.0,
                output_write.0,
                0,
                &mut raw_console,
            )
        };
        // Register an output handle immediately, including an unexpected handle
        // returned alongside a failure HRESULT. No later error may rely on Drop
        // as proof that a helper was cleaned, even when there is no project PID.
        if raw_console != 0 {
            owner.console = Some(Arc::new(PseudoConsole {
                state: Mutex::new(ConsoleState::Open(raw_console)),
                closed: AtomicBool::new(false),
                lease: owner.lease.clone(),
            }));
        }
        if result < 0 {
            return Err("Unable to create a Windows terminal. ConPTY requires Windows 10 version 1809 or newer.".into());
        }
        if raw_console == 0 {
            owner.helper_identity_unknown = true;
            return Err(
                "Windows reported terminal creation without a usable helper handle.".into(),
            );
        }
        owner.child_ends.extend([input_read, output_write]);
        owner
            .readers
            .push(("terminal".into(), Box::new(PipeReader(output_read))));
        let input = InputWorker::new(input_write, owner.lease.clone());
        owner.input = Some(input.clone());
        attributes.set(
            PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
            owner
                .console
                .as_ref()
                .ok_or("Windows terminal ownership is unavailable.")?
                .raw()? as *const c_void,
            size_of::<HPCON>(),
        )?;
        input.start()?;
    } else {
        let (stdout_read, stdout_write) = pipe(true)?;
        let (stderr_read, stderr_write) = pipe(true)?;
        private_handle(&stdout_read)?;
        private_handle(&stderr_read)?;
        let name = wide("NUL")?;
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: null_mut(),
            bInheritHandle: 1,
        };
        let stdin = Handle::new(
            unsafe {
                CreateFileW(
                    name.as_ptr(),
                    FILE_GENERIC_READ,
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                    &attributes,
                    OPEN_EXISTING,
                    0,
                    null_mut(),
                )
            },
            "Unable to allocate closed run input.",
        )?;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = stdin.0;
        startup.StartupInfo.hStdOutput = stdout_write.0;
        startup.StartupInfo.hStdError = stderr_write.0;
        inherited.extend([stdin.0, stdout_write.0, stderr_write.0]);
        owner.child_ends.extend([stdin, stdout_write, stderr_write]);
        owner
            .readers
            .push(("stdout".into(), Box::new(PipeReader(stdout_read))));
        owner
            .readers
            .push(("stderr".into(), Box::new(PipeReader(stderr_read))));
    }
    if !terminal {
        attributes.set(
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
            inherited.as_ptr().cast(),
            inherited.len() * size_of::<HANDLE>(),
        )?;
    }
    startup.lpAttributeList = attributes.raw();
    let executable = path_wide(&spec.executable)?;
    let executable_text = spec
        .executable
        .to_str()
        .ok_or("The selected executable path is not valid Unicode.")?;
    let mut command = wide(&command_line(
        executable_text,
        &spec.args,
        spec.windows_shell_command.as_deref(),
    ))?;
    if command.len() > 32767 {
        return Err("Windows command line exceeds 32767 characters.".into());
    }
    let environment = environment(spec)?;
    let mut information: PROCESS_INFORMATION = unsafe { zeroed() };
    let flags = CREATE_SUSPENDED
        | CREATE_UNICODE_ENVIRONMENT
        | EXTENDED_STARTUPINFO_PRESENT
        | if terminal { 0 } else { CREATE_NO_WINDOW };
    if unsafe {
        CreateProcessW(
            executable.as_ptr(),
            command.as_mut_ptr(),
            null(),
            null(),
            i32::from(!terminal),
            flags,
            environment.as_ptr().cast(),
            cwd.as_ptr(),
            &startup.StartupInfo,
            &mut information,
        )
    } == 0
    {
        return Err("Unable to start the selected executable. Check its architecture, path, permissions and working directory.".into());
    }
    // Store both returned handles before checking either one. Even a malformed
    // successful API result is an unproven created process, never a clean error.
    owner.process_created = true;
    owner.pid = Some(information.dwProcessId);
    owner.process = Some(Handle(information.hProcess));
    owner.thread = Some(Handle(information.hThread));
    let process = owner.process_handle()?;
    if information.hThread.is_null() || information.hThread == INVALID_HANDLE_VALUE {
        return Err("Created Windows thread has no usable ownership handle.".into());
    }
    if unsafe {
        AssignProcessToJobObject(
            owner
                .job
                .as_ref()
                .ok_or("Windows execution job is unavailable.")?
                .0,
            process,
        )
    } == 0
    {
        return Err(
            "Windows could not establish process-tree ownership; check host job restrictions."
                .into(),
        );
    }
    owner.job_assigned = true;
    if unsafe { ResumeThread(information.hThread) } == u32::MAX {
        return Err("Windows could not resume the owned executable.".into());
    }
    owner.resumed = true;
    owner.thread.take();
    owner.child_ends.clear();
    let mut resources = provisional
        .resources
        .take()
        .ok_or("Windows startup ownership was not retained.")?;
    let io = SessionIo {
        console: resources.console.clone(),
        input: resources.input.clone(),
        _lease: resources.lease.clone(),
    };
    let readers = std::mem::take(&mut resources.readers);
    Ok(Spawned {
        process: OwnedProcess {
            resources: Some(resources),
            exit_code: None,
        },
        io,
        readers,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    #[test]
    fn typed_clean_failure_ignores_message_markers_and_releases_once() {
        let gate = crate::maintenance::Gate::default();
        let lease = ExecutionWork::new(gate.work().unwrap());
        let storage = Mutex::new(Vec::new());
        let failure = classify_spawn_failure(
            NativeResources::new(lease.clone()),
            "Literal [cleanup-unknown] text is not an ownership outcome.".into(),
            Ok(0),
            &storage,
        );
        assert!(!failure.cleanup_unknown);
        assert!(assert_quarantine_empty(&storage).is_ok());
        assert!(gate.install().is_ok());
        lease.confirmed_cleanup(); // One shared token cannot be decremented twice.
        assert!(gate.install().is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn created_helper_with_missing_identity_cannot_become_clean_no_pid_error() {
        let gate = crate::maintenance::Gate::default();
        let lease = ExecutionWork::new(gate.work().unwrap());
        let storage = Mutex::new(Vec::new());
        let mut helper_only = NativeResources::new(lease.clone());
        helper_only.helper_identity_unknown = true;
        let cleanup = helper_only.cleanup(false);
        assert!(cleanup.is_err());
        let failure = classify_spawn_failure(
            helper_only,
            "Injected successful helper allocation with missing output handle.".into(),
            cleanup,
            &storage,
        );
        assert!(failure.cleanup_unknown);
        assert!(assert_quarantine_empty(&storage).is_err());
        assert!(gate.install().is_err());
    }

    #[cfg(windows)]
    #[test]
    fn helper_only_failed_teardown_retains_exact_owner_and_work_without_pid() {
        let gate = crate::maintenance::Gate::default();
        let lease = ExecutionWork::new(gate.work().unwrap());
        let weak = Arc::downgrade(&lease);
        let storage = Mutex::new(Vec::new());
        let helper_only = NativeResources::new(lease.clone());
        assert!(!helper_only.process_created);
        assert!(helper_only.pid.is_none());
        // Inject the checked close result, without allocating a real ConPTY or
        // poisoning the process-global Gate/quarantine used by other tests.
        let failure = classify_spawn_failure(
            helper_only,
            "Environment validation failed after native helper allocation.".into(),
            Err("Injected ConPTY close timeout before CreateProcessW.".into()),
            &storage,
        );
        drop(lease);
        assert!(failure.cleanup_unknown);
        assert!(failure.message.contains("helper-only"));
        assert!(weak.upgrade().is_some());
        assert!(assert_quarantine_empty(&storage).is_err());
        assert!(gate.install().is_err());
    }

    #[cfg(windows)]
    #[test]
    fn poisoned_quarantine_keeps_helper_lease_and_refuses_idle_assertion() {
        let gate = crate::maintenance::Gate::default();
        let lease = ExecutionWork::new(gate.work().unwrap());
        let storage = Mutex::new(Vec::new());
        let poisoned = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = storage.lock().unwrap();
            panic!("Injected local quarantine poison");
        }));
        assert!(poisoned.is_err());
        let failure = classify_spawn_failure(
            NativeResources::new(lease.clone()),
            "Partial native startup failed.".into(),
            Err("Injected helper-only teardown failure.".into()),
            &storage,
        );
        drop(lease);
        assert!(failure.cleanup_unknown);
        let retained = match storage.lock() {
            Ok(_) => panic!("quarantine unexpectedly lost its poisoned state"),
            Err(poisoned) => poisoned.into_inner(),
        };
        assert_eq!(retained.len(), 1);
        drop(retained);
        assert!(assert_quarantine_empty(&storage).is_err());
        assert!(gate.install().is_err());
        // Deliberately no global reset or synthetic release of unknown work.
    }

    #[test]
    fn explicit_shell_text_keeps_cmd_quotes_without_crt_backslashes() {
        assert_eq!(
            command_line(
                "C:\\Windows\\System32/cmd.exe",
                &[],
                Some("echo HELM-owned-run&exit /b 23")
            ),
            r#""C:\Windows\System32\cmd.exe" /D /S /C "echo HELM-owned-run&exit /b 23""#,
        );
        assert_eq!(
            command_line(
                "C:\\Windows\\System32\\cmd.exe",
                &[],
                Some(r#""C:\space Ω\tool.cmd" "two words""#)
            ),
            r#""C:\Windows\System32\cmd.exe" /D /S /C ""C:\space Ω\tool.cmd" "two words"""#,
        );
        assert_eq!(
            command_line("tool.exe", &["one two".into(), "&".into()], None),
            r#""tool.exe" "one two" "&""#,
        );
        assert_eq!(
            command_line("C:/space Ω/tool.exe", &["/literal/path".into()], None),
            r#""C:\space Ω\tool.exe" "/literal/path""#,
        );
    }
    #[test]
    fn cmd_components_refuse_dos_aliases_without_rewriting_names() {
        for name in [
            ".venv",
            "space café",
            "子🧭",
            "COM10",
            "LPT0",
            "normal .file",
        ] {
            assert!(cmd_component_is_representable(name), "{name}");
        }
        for name in [
            "",
            ".",
            "..",
            "shadow.",
            "shadow ",
            "nul",
            "CON.txt",
            "LPT1.log",
            "com¹",
            "LPT².txt",
            "con .txt",
            "CONOUT$",
            "a:b",
            "a?b",
            "a/b",
            "a\\b",
            "a\u{1f}b",
        ] {
            assert!(!cmd_component_is_representable(name), "{name}");
        }
    }
    #[cfg(windows)]
    #[test]
    fn cmd_directory_spelling_is_bounded_and_preserves_drive_components() {
        assert_eq!(
            cmd_directory_candidate(Path::new(r"\\?\C:\space café\子")).unwrap(),
            PathBuf::from(r"C:\space café\子")
        );
        assert_eq!(
            cmd_directory_candidate(Path::new(r"\\?\C:\")).unwrap(),
            PathBuf::from(r"C:\")
        );
        for path in [
            r"\\server\share\folder",
            r"\\?\UNC\server\share\folder",
            r"\\.\C:\folder",
            r"\\?\Volume{00000000-0000-0000-0000-000000000000}\folder",
            r"C:relative",
            r"relative",
            r"C:\folder\..\other",
        ] {
            assert!(cmd_directory_candidate(Path::new(path)).is_err(), "{path}");
        }
        // Include a surrogate pair so the boundary is UTF-16 units, not bytes
        // or Unicode scalar count: 3 + 254 + 2 = 259, plus NUL = MAX_PATH.
        let longest = format!("C:\\{}🧭", "x".repeat(254));
        assert!(cmd_directory_candidate(Path::new(&longest)).is_ok());
        assert!(cmd_directory_candidate(Path::new(&(longest + "x"))).is_err());
    }
    #[cfg(windows)]
    #[test]
    fn cmd_directory_round_trip_refuses_dos_alias_to_different_folder() {
        let root = std::env::temp_dir().join(format!(
            "helm-cmd-cwd café {}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        let canonical = root.canonicalize().unwrap();
        let candidate = cmd_working_directory(&canonical).unwrap();
        assert_eq!(candidate.canonicalize().unwrap(), canonical);
        assert!(candidate
            .to_string_lossy()
            .starts_with(|c: char| c.is_ascii_alphabetic()));
        // Verbatim NTFS names can differ from their DOS spelling. Removing a
        // prefix alone would launch in shadow instead of the selected shadow.
        let ordinary = canonical.join("shadow");
        let distinct = canonical.join("shadow.");
        std::fs::create_dir(&ordinary).unwrap();
        std::fs::create_dir(&distinct).unwrap();
        assert_ne!(
            ordinary.canonicalize().unwrap(),
            distinct.canonicalize().unwrap()
        );
        assert!(cmd_working_directory(&distinct).is_err());
        std::fs::remove_dir_all(&canonical).unwrap();
    }
    #[cfg(windows)]
    fn fixture_spec(command: &str) -> LaunchSpec {
        let config = crate::run_config::RunConfig {
            id: "windows-owner-fixture".into(),
            name: "Owned Windows fixture".into(),
            kind: "tests".into(),
            mode: "shell".into(),
            executable: String::new(),
            args: Vec::new(),
            command: command.into(),
            cwd: ".".into(),
            env: std::collections::BTreeMap::new(),
            secret_names: Vec::new(),
        };
        crate::run_config::prepare_launch(
            &std::env::temp_dir().canonicalize().unwrap(),
            &config,
            &std::collections::BTreeMap::new(),
        )
        .unwrap()
    }
    #[cfg(windows)]
    #[test]
    fn real_windows_job_observes_exit_and_piped_output() {
        let gate = crate::maintenance::Gate::default();
        let lease = ExecutionWork::new(gate.work().unwrap());
        let spawned = spawn(
            &fixture_spec("echo HELM-owned-run&cd&exit /b 23"),
            false,
            24,
            80,
            lease.clone(),
        )
        .unwrap();
        let Spawned {
            mut process,
            mut io,
            readers,
        } = spawned;
        let (tx, rx) = mpsc::channel();
        for (stream, mut reader) in readers {
            let tx = tx.clone();
            std::thread::spawn(move || {
                let mut bytes = Vec::new();
                let result = reader.read_to_end(&mut bytes);
                let _ = tx.send((stream, result, bytes));
            });
        }
        drop(tx);
        let deadline = Instant::now() + Duration::from_secs(3);
        while !process.exited().unwrap() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(process.exited().unwrap(), "fixture did not exit");
        assert_eq!(process.finish(false).unwrap(), 23);
        assert_eq!(process.finish(false).unwrap(), 23); // I/O-only retry is idempotent.
        assert_eq!(process.active_processes().unwrap(), 0);
        io.close().unwrap();
        assert!(gate.install().is_err()); // Publication/release belongs to the supervisor.
        lease.confirmed_cleanup();
        assert!(gate.install().is_ok());
        let output: Vec<_> = (0..2)
            .map(|_| rx.recv_timeout(Duration::from_secs(2)).unwrap())
            .collect();
        assert!(
            output.iter().all(|(_, result, _)| result.is_ok()),
            "Owned Run output read failed: {output:?}"
        );
        assert!(
            output.iter().any(|(stream, _, bytes)| stream == "stdout"
                && String::from_utf8_lossy(bytes).contains("HELM-owned-run")),
            "Owned Run output did not contain its marker: {output:?}"
        );
        let expected_cwd = cmd_working_directory(&std::env::temp_dir().canonicalize().unwrap())
            .unwrap()
            .to_string_lossy()
            .to_lowercase();
        assert!(
            output.iter().any(|(stream, _, bytes)| stream == "stdout"
                && String::from_utf8_lossy(bytes)
                    .lines()
                    .any(|line| line.to_lowercase() == expected_cwd)),
            "Owned Run did not retain the selected cwd: {output:?}"
        );
    }
    #[cfg(windows)]
    #[test]
    fn real_windows_conpty_resize_output_and_cleanup() {
        let gate = crate::maintenance::Gate::default();
        let lease = ExecutionWork::new(gate.work().unwrap());
        let Spawned {
            mut process,
            mut io,
            mut readers,
        } = spawn(
            &fixture_spec("echo HELM-owned-terminal&exit /b 0"),
            true,
            24,
            80,
            lease.clone(),
        )
        .unwrap();
        let (_, mut reader) = readers.pop().unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = reader.read_to_end(&mut bytes);
            let _ = tx.send((result, bytes));
        });
        io.resize(36, 110).unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while !process.exited().unwrap() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(process.exited().unwrap(), "terminal fixture did not exit");
        assert_eq!(process.finish(false).unwrap(), 0);
        io.close().unwrap();
        assert!(gate.install().is_err());
        lease.confirmed_cleanup();
        assert!(gate.install().is_ok());
        let (result, bytes) = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(
            result.is_ok(),
            "Owned terminal read failed: {result:?}; {bytes:?}"
        );
        assert!(
            String::from_utf8_lossy(&bytes).contains("HELM-owned-terminal"),
            "Owned terminal output did not contain its marker: {bytes:?}"
        );
    }
    #[test]
    fn argv_quoting_preserves_empty_quotes_and_trailing_slashes() {
        assert_eq!(quote_arg(""), "\"\"");
        assert_eq!(quote_arg("space Ω value"), "\"space Ω value\"");
        assert_eq!(quote_arg("a\"b"), "\"a\\\"b\"");
        assert_eq!(quote_arg("C:\\space dir\\"), "\"C:\\space dir\\\\\"");
        assert_eq!(quote_arg("a\\\"b"), "\"a\\\\\\\"b\"");
    }
}
