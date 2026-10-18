//! Bounded project IPC. Branch operations share the serial Python mutation worker.
use crate::bridge::BackendService;
use crate::repo_boundary::ActiveRepoBoundary;
use crate::watcher::ActiveRepoWatcher;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, State, Wry};

pub(crate) static CONTEXT_EPOCH: AtomicU64 = AtomicU64::new(0);
#[derive(Default)]
pub(crate) struct CloneJobs {
    active: Mutex<HashMap<String, Arc<AtomicBool>>>,
    cancelled: Mutex<HashSet<String>>,
}

#[tauri::command]
pub(crate) fn inspect_project(
    service: State<'_, BackendService>,
    repo_path: String,
) -> Result<Value, String> {
    service.request("inspect-project", json!({"repo": repo_path}))
}

#[tauri::command]
pub(crate) fn switch_project_branch(
    app: AppHandle<Wry>,
    service: State<'_, BackendService>,
    watcher: State<'_, ActiveRepoWatcher>,
    boundary: State<'_, ActiveRepoBoundary>,
    repo_path: String,
    branch: String,
    fingerprint: String,
) -> Result<Value, String> {
    let repo_path = boundary.command_repo_path(&repo_path)?;
    watcher.stop()?;
    let epoch = CONTEXT_EPOCH.fetch_add(1, Ordering::SeqCst) + 1;
    let result = service.request(
        "switch-project-branch",
        json!({"repo": repo_path, "branch": branch, "fingerprint": fingerprint}),
    );
    match result {
        Ok(mut result) => {
            result["contextEpoch"] = json!(epoch);
            Ok(result)
        }
        Err(error) => {
            let _ = watcher.watch_repo(&app, service.inner().clone(), &repo_path);
            let actual = service
                .request("inspect-project", json!({"repo": repo_path}))
                .ok();
            Ok(
                json!({"outcome":"refused", "actual": actual, "contextEpoch":epoch, "message":error}),
            )
        }
    }
}

fn valid_repository(repository: &str) -> bool {
    let fields: Vec<_> = repository.split('/').collect();
    fields.len() == 2
        && fields
            .iter()
            .all(|field| !field.is_empty() && *field != "." && *field != "..")
        && fields[0]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
        && fields[1]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
}

#[cfg(unix)]
fn unix_group_signal(child: &Child, signal: std::ffi::c_int) -> std::io::Result<()> {
    unsafe extern "C" {
        fn kill(pid: std::ffi::c_int, sig: std::ffi::c_int) -> std::ffi::c_int;
    }
    let group_id = i32::try_from(child.id())
        .ok()
        .filter(|pid| *pid > 1)
        .ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidInput, "Invalid owned group")
        })?;
    // Nonzero signals are used only while our fresh session leader is unreaped.
    // Signal zero below is a read-only existence probe after reaping, never a signal.
    if unsafe { kill(-group_id, signal) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(unix)]
fn signal_owned_group(child: &Child, signal: std::ffi::c_int) -> bool {
    match unix_group_signal(child, signal) {
        Ok(()) => true,
        Err(error) => error.raw_os_error() == Some(3),
    } // ESRCH on macOS/Linux.
}

fn terminate(child: &mut Child) -> bool {
    #[cfg(unix)]
    let tree_stopped = {
        // Keep the leader unreaped until after group KILL, reserving its PID/group
        // identity even if TERM makes Git exit before a resistant helper does.
        signal_owned_group(child, 15); // SIGTERM
        std::thread::sleep(Duration::from_millis(200));
        signal_owned_group(child, 9) // SIGKILL includes TERM-resistant helpers.
    };
    #[cfg(windows)]
    let tree_stopped = Command::new("taskkill")
        .args(["/F", "/T", "/PID", &child.id().to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success());
    #[cfg(not(any(unix, windows)))]
    let tree_stopped = false;
    let _ = child.kill();
    let reaped = child.wait().is_ok();
    // macOS can report EPERM for a group containing only the dead leader. After
    // reaping, an ESRCH from a read-only probe confirms that no helper survived.
    // Never send another signal after the leader PID could have been reused.
    #[cfg(unix)]
    let tree_stopped = tree_stopped
        || (reaped
            && unix_group_signal(child, 0).is_err_and(|error| error.raw_os_error() == Some(3)));
    tree_stopped && reaped
}

fn clone_owned(
    source: &str,
    destination: &str,
    cancel: &AtomicBool,
    timeout: Duration,
) -> Result<Value, String> {
    let destination = PathBuf::from(destination);
    if !destination.is_absolute() || destination.file_name().is_none() {
        return Err("Choose an absolute, new clone destination.".into());
    }
    let parent = destination
        .parent()
        .ok_or("Clone destination needs a parent directory.")?
        .canonicalize()
        .map_err(|_| "Clone parent directory does not exist or is inaccessible.")?;
    let destination = parent.join(destination.file_name().unwrap());
    if cancel.load(Ordering::SeqCst) {
        return Ok(json!({"outcome":"cancelled", "path":null}));
    }
    // Exclusive creation refuses every pre-existing path, including empty directories/symlinks.
    std::fs::create_dir(&destination).map_err(|_| {
        "Clone destination already exists or cannot be created. Select a new directory."
    })?;
    if cancel.load(Ordering::SeqCst) {
        let _ = std::fs::remove_dir(&destination); // removes only our still-empty directory
        return Ok(
            json!({"outcome":"cancelled", "path":destination, "message":"Inspect the destination if residue remains."}),
        );
    }
    let mut command = Command::new("git");
    command
        .args(["clone", "--", source])
        .arg(&destination)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .env("GCM_INTERACTIVE", "Never")
        .env("SSH_ASKPASS_REQUIRE", "never")
        .env("SSH_ASKPASS", "")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_COMMON_DIR")
        .env(
            "GIT_SSH_COMMAND",
            "ssh -o BatchMode=yes -o StrictHostKeyChecking=yes",
        );
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => {
            return Ok(
                json!({"outcome":"failed", "path":destination, "message":"Git could not start. The newly created destination was retained; inspect it before retrying."}),
            )
        }
    };
    let started = Instant::now();
    let outcome = loop {
        match child.try_wait() {
            Ok(Some(status)) => break if status.success() { "cloned" } else { "failed" },
            Ok(None) => {}
            Err(_) => {
                terminate(&mut child);
                break "unknown";
            }
        }
        if cancel.load(Ordering::SeqCst) || started.elapsed() > timeout {
            break if terminate(&mut child) {
                "cancelled"
            } else {
                "unknown"
            };
        }
        std::thread::sleep(Duration::from_millis(40));
    };
    // Never recursively clean output: a user/other process may have added files.
    Ok(
        json!({"outcome":outcome, "path":destination, "message": if outcome == "cloned" { "Clone complete. Verify the remote, then explicitly open this copy." } else if outcome == "unknown" { "Clone process cleanup could not be confirmed. Do not activate this destination until its owned Git/helper processes have been inspected." } else { "Clone did not complete. Any attempt-owned output remains at this destination; inspect it before retrying. Existing Git/SSH access is separate from issue-token access." }}),
    )
}

#[tauri::command]
pub(crate) async fn clone_project(
    jobs: State<'_, CloneJobs>,
    attempt_id: String,
    repository: String,
    destination: String,
    transport: String,
) -> Result<Value, String> {
    if !valid_repository(&repository) {
        return Err("Enter a valid github.com owner/repository.".into());
    }
    let source = match transport.as_str() {
        "https" => format!("https://github.com/{}.git", repository),
        "ssh" => format!("git@github.com:{}.git", repository),
        _ => {
            return Err(
                "Choose existing HTTPS Git credentials or existing SSH authentication.".into(),
            )
        }
    };
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut active = jobs.active.lock().map_err(|_| "Clone state unavailable.")?;
        let mut cancelled = jobs
            .cancelled
            .lock()
            .map_err(|_| "Clone state unavailable.")?;
        if cancelled.remove(&attempt_id) {
            return Ok(json!({"outcome":"cancelled", "path":null}));
        }
        if !active.is_empty() {
            return Err("Another clone is active. Wait or cancel it first.".into());
        }
        active.insert(attempt_id.clone(), cancel.clone());
    }
    let result = tauri::async_runtime::spawn_blocking(move || {
        clone_owned(&source, &destination, &cancel, Duration::from_secs(600))
    })
    .await;
    jobs.active
        .lock()
        .map_err(|_| "Clone state unavailable.")?
        .remove(&attempt_id);
    result.map_err(|_| {
        "Clone task interrupted; inspect the destination before retrying.".to_string()
    })?
}

#[tauri::command]
pub(crate) fn cancel_project_clone(
    jobs: State<'_, CloneJobs>,
    attempt_id: String,
) -> Result<(), String> {
    let active = jobs.active.lock().map_err(|_| "Clone state unavailable.")?;
    if let Some(cancel) = active.get(&attempt_id) {
        cancel.store(true, Ordering::SeqCst);
    } else {
        let mut cancelled = jobs
            .cancelled
            .lock()
            .map_err(|_| "Clone state unavailable.")?;
        if cancelled.len() > 100 {
            cancelled.clear();
        }
        cancelled.insert(attempt_id);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "helm-project-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::SeqCst)
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn git(root: &std::path::Path, args: &[&str]) {
        assert!(Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success());
    }
    #[test]
    fn repository_names_never_accept_credentials_or_arguments() {
        for repo in ["owner/H.E.L.M.", "synthetic/repo"] {
            assert!(valid_repository(repo));
        }
        for repo in [
            "https://secret@github.com/owner/repo",
            "owner/repo?token=secret",
            "owner/..",
            "-c injected",
            "owner/repo/extra",
        ] {
            assert!(!valid_repository(repo));
        }
    }
    #[test]
    fn local_fixture_clone_never_overwrites_and_requires_separate_activation() {
        let fixture = Fixture::new();
        let source = fixture.0.join("source ü");
        let target = fixture.0.join("explicit clone ü");
        std::fs::create_dir(&source).unwrap();
        git(&source, &["init"]);
        git(&source, &["config", "user.name", "Synthetic"]);
        git(
            &source,
            &["config", "user.email", "synthetic@example.invalid"],
        );
        std::fs::write(source.join("sample.py"), "def fixture(): pass\n").unwrap();
        git(&source, &["add", "."]);
        git(&source, &["commit", "-m", "fixture"]);
        let cancel = AtomicBool::new(false);
        let result = clone_owned(
            source.to_str().unwrap(),
            target.to_str().unwrap(),
            &cancel,
            Duration::from_secs(10),
        )
        .unwrap();
        assert_eq!(result["outcome"], "cloned");
        assert_eq!(
            std::fs::read(target.join("sample.py")).unwrap(),
            std::fs::read(source.join("sample.py")).unwrap()
        );
        std::fs::write(target.join("preserve.txt"), "user work").unwrap();
        assert!(clone_owned(
            source.to_str().unwrap(),
            target.to_str().unwrap(),
            &cancel,
            Duration::from_secs(10)
        )
        .is_err());
        assert_eq!(
            std::fs::read_to_string(target.join("preserve.txt")).unwrap(),
            "user work"
        );
    }
    #[test]
    fn cancel_before_start_creates_nothing_and_failed_clone_retains_owned_residue() {
        let fixture = Fixture::new();
        let target = fixture.0.join("target");
        let cancelled = AtomicBool::new(true);
        assert_eq!(
            clone_owned(
                "missing",
                target.to_str().unwrap(),
                &cancelled,
                Duration::from_secs(10)
            )
            .unwrap()["outcome"],
            "cancelled"
        );
        assert!(!target.exists());
        let result = clone_owned(
            fixture.0.join("missing").to_str().unwrap(),
            target.to_str().unwrap(),
            &AtomicBool::new(false),
            Duration::from_secs(10),
        )
        .unwrap();
        assert_eq!(result["outcome"], "failed");
        assert!(target.is_dir());
    }
    #[test]
    fn timeout_reaps_the_owned_clone_process_and_reports_residue() {
        let fixture = Fixture::new();
        let target = fixture.0.join("target");
        let result = clone_owned(
            fixture.0.join("missing").to_str().unwrap(),
            target.to_str().unwrap(),
            &AtomicBool::new(false),
            Duration::ZERO,
        )
        .unwrap();
        assert!(["cancelled", "failed"].contains(&result["outcome"].as_str().unwrap()));
        assert!(target.is_dir());
    }
    #[cfg(unix)]
    #[test]
    fn cancel_stops_term_resistant_helpers_without_signalling_an_unrelated_group() {
        use std::os::unix::process::CommandExt;
        let fixture = Fixture::new();
        let ticks = fixture.0.join("owned-helper-ticks");
        let mut owned = Command::new("sh");
        owned.args(["-c", "trap '' TERM; (trap '' TERM; while :; do printf x >> \"$1\"; sleep 0.02; done) & wait", "owned-fixture"]).arg(&ticks)
            .process_group(0).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        let mut owned = owned.spawn().unwrap();
        let mut unrelated = Command::new("sleep")
            .arg("5")
            .process_group(0)
            .spawn()
            .unwrap();
        let started = Instant::now();
        while std::fs::metadata(&ticks).map(|m| m.len()).unwrap_or(0) < 3
            && started.elapsed() < Duration::from_secs(2)
        {
            std::thread::sleep(Duration::from_millis(10));
        }
        let ready = std::fs::metadata(&ticks).map(|m| m.len()).unwrap_or(0) >= 3;
        let cleaned = terminate(&mut owned);
        let size_at_return = std::fs::metadata(&ticks).map(|m| m.len()).unwrap_or(0);
        std::thread::sleep(Duration::from_millis(160));
        let stopped = std::fs::metadata(&ticks).map(|m| m.len()).unwrap_or(0) == size_at_return;
        let unrelated_alive = unrelated.try_wait().unwrap().is_none();
        // Clean a failed fixture before asserting; its live helper still owns this group.
        if !stopped {
            let _ = Command::new("/bin/kill")
                .args(["-KILL", "--", &format!("-{}", owned.id())])
                .status();
        }
        let _ = unrelated.kill();
        let _ = unrelated.wait();
        assert!(ready, "resistant helper never started");
        assert!(cleaned, "owned process-group cleanup was not confirmed");
        assert!(
            stopped,
            "owned helper kept writing after cancellation returned"
        );
        assert!(unrelated_alive, "another process group was signalled");
    }
}
