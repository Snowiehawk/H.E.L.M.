//! Untrusted output navigation. Neither a displayed filename nor a link is an
//! executable command, and no navigation invokes a project shell.
use crate::execution_policy::{ExecutionContext, ExecutionPolicy};
use crate::execution_work::ExecutionWork;
use crate::repo_boundary::{ensure_canonical_path_inside_repo, ActiveRepoBoundary};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Component, Path};
#[cfg(not(target_os = "windows"))]
use std::process::{Command, Stdio};
use std::sync::Arc;
use tauri::{Manager, State, WebviewWindow};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiagnosticLocation {
    relative_path: String,
    line: u32,
    column: u32,
    current_hash: String,
    source_matches: bool,
    /// Enables conversion between Monaco UTF-16 columns and Python UTF-8 spans.
    line_text: Option<String>,
}

fn resolve_location(
    root: &Path,
    cwd: &str,
    path: &str,
    line: u32,
    column: u32,
    expected_hash: Option<&str>,
) -> Result<DiagnosticLocation, String> {
    if path.is_empty() || path.len() > 4096 || path.chars().any(char::is_control) {
        return Err("The diagnostic filename is malformed or unavailable.".into());
    }
    if line == 0 || column == 0 {
        return Err("Diagnostic line and column must be one-based.".into());
    }
    if expected_hash
        .is_some_and(|hash| hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err("The run-source hash is malformed.".into());
    }
    let cwd = Path::new(cwd)
        .canonicalize()
        .map_err(|_| "The recorded run directory is unavailable.")?;
    ensure_canonical_path_inside_repo(&cwd, root, "Run directory")?;
    if !cwd.is_dir() {
        return Err("The recorded run directory is not a directory.".into());
    }
    #[cfg(target_os = "windows")]
    let normalized = path.replace('/', "\\");
    #[cfg(not(target_os = "windows"))]
    let normalized = path.to_string();
    let diagnostic_path = Path::new(&normalized);
    if diagnostic_path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("Diagnostic traversal paths cannot be opened.".into());
    }
    // Windows paths cannot accidentally become project-relative files on Unix.
    #[cfg(not(target_os = "windows"))]
    if path.starts_with("\\\\") || path.as_bytes().get(1) == Some(&b':') || path.contains('\\') {
        return Err(
            "This diagnostic uses a path for another platform; navigation is unavailable.".into(),
        );
    }
    let candidate = if diagnostic_path.is_absolute() {
        diagnostic_path.to_path_buf()
    } else {
        cwd.join(diagnostic_path)
    };
    let target = candidate
        .canonicalize()
        .map_err(|_| "The diagnostic file was deleted or is unavailable.")?;
    ensure_canonical_path_inside_repo(&target, root, "Diagnostic file")?;
    let metadata = fs::metadata(&target).map_err(|_| "The diagnostic file is unavailable.")?;
    if !metadata.is_file() || metadata.len() > 8 * 1024 * 1024 {
        return Err("The diagnostic target must be a text file no larger than 8 MiB.".into());
    }
    let bytes = fs::read(&target).map_err(|_| "The diagnostic file could not be read.")?;
    if bytes.len() > 8 * 1024 * 1024
        || candidate.canonicalize().ok().as_deref() != Some(target.as_path())
    {
        return Err("The diagnostic file changed while resolving it. Retry navigation.".into());
    }
    let text =
        std::str::from_utf8(&bytes).map_err(|_| "The diagnostic target is not UTF-8 text.")?;
    let selected_line = text
        .split('\n')
        .nth((line - 1) as usize)
        .ok_or("The diagnostic line is outside the current file; its source may have changed.")?;
    let line_width = selected_line.trim_end_matches('\r').encode_utf16().count() + 1;
    let current_hash = format!("{:x}", Sha256::digest(&bytes));
    Ok(DiagnosticLocation {
        relative_path: target
            .strip_prefix(root)
            .map_err(|_| "Diagnostic file is outside the workspace.")?
            .to_string_lossy()
            .replace('\\', "/"),
        line,
        column: column.min(u32::try_from(line_width).unwrap_or(u32::MAX)),
        source_matches: expected_hash
            .is_some_and(|expected| expected.eq_ignore_ascii_case(&current_hash)),
        current_hash,
        line_text: (selected_line.len() <= 16_384)
            .then(|| selected_line.trim_end_matches('\r').to_string()),
    })
}

// Tauri injects owner/state parameters; keep the explicit validated IPC wire fields.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub(crate) fn execution_resolve_diagnostic(
    window: tauri::Window,
    policy: State<'_, ExecutionPolicy>,
    active_repo: State<'_, ActiveRepoBoundary>,
    context: ExecutionContext,
    cwd: String,
    path: String,
    line: u32,
    column: u32,
    expected_hash: Option<String>,
) -> Result<DiagnosticLocation, String> {
    let _work = crate::maintenance::work()?;
    let root = policy.validate_owner(window.label(), &context)?;
    if active_repo.command_repo_root(&context.repo_path)? != root {
        return Err("Workspace changed before diagnostic navigation.".into());
    }
    let location = resolve_location(&root, &cwd, &path, line, column, expected_hash.as_deref())?;
    policy.validate_owner(window.label(), &context)?;
    active_repo.command_repo_root(&context.repo_path)?;
    Ok(location)
}

pub(crate) fn validate_loopback_url(target: &str) -> Result<String, String> {
    if target.is_empty()
        || target.len() > 4096
        || target
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || c == '\\')
    {
        return Err("The link contains unsupported whitespace or controls.".into());
    }
    let lowercase = target.to_ascii_lowercase();
    for code in 0..=31u8 {
        if lowercase.contains(&format!("%{code:02x}")) {
            return Err("Encoded URL controls are not allowed.".into());
        }
    }
    if lowercase.contains("%7f") {
        return Err("Encoded URL controls are not allowed.".into());
    }
    let remainder = lowercase
        .strip_prefix("http://")
        .or_else(|| lowercase.strip_prefix("https://"))
        .ok_or("Only http(s) local links can open.")?;
    let authority = remainder.split(['/', '?', '#']).next().unwrap_or("");
    let port = if let Some(suffix) = authority.strip_prefix("[::1]") {
        suffix
    } else if let Some(suffix) = authority.strip_prefix("localhost") {
        suffix
    } else if let Some(suffix) = authority.strip_prefix("127.0.0.1") {
        suffix
    } else {
        return Err("Only localhost, 127.0.0.1 and [::1] links can open.".into());
    };
    if !port.is_empty()
        && !port.strip_prefix(':').is_some_and(|digits| {
            !digits.is_empty()
                && digits.len() <= 5
                && digits.bytes().all(|b| b.is_ascii_digit())
                && digits.parse::<u16>().is_ok_and(|value| value > 0)
        })
    {
        return Err("The local host or port is invalid; credentials are not allowed.".into());
    }
    let parsed = tauri::Url::parse(target).map_err(|_| "The local link is malformed.")?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("URL credentials are not allowed.".into());
    }
    Ok(parsed.to_string())
}

enum BrowserRequest {
    #[cfg(target_os = "windows")]
    Submitted,
    #[cfg(not(target_os = "windows"))]
    Helper(BrowserHelper),
}

// This owns only the short-lived OS dispatch helper, never the user's browser.
#[cfg(not(target_os = "windows"))]
struct BrowserHelper {
    child: Option<std::process::Child>,
    work: Arc<ExecutionWork>,
}
#[cfg(not(target_os = "windows"))]
impl Drop for BrowserHelper {
    fn drop(&mut self) {
        if let Some(child) = self.child.take() {
            type Quarantine = Vec<(std::process::Child, Arc<ExecutionWork>)>;
            static RETAINED: std::sync::OnceLock<std::sync::Mutex<Quarantine>> =
                std::sync::OnceLock::new();
            let owner = (child, self.work.clone());
            match RETAINED.get_or_init(Default::default).lock() {
                Ok(mut retained) => retained.push(owner),
                Err(_) => std::mem::forget(owner),
            }
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn browser_command(target: &str, inherited: impl IntoIterator<Item = (String, String)>) -> Command {
    #[cfg(target_os = "macos")]
    let mut command = Command::new("/usr/bin/open");
    #[cfg(not(target_os = "macos"))]
    let mut command = Command::new("xdg-open");
    command
        .arg(target)
        .env_clear()
        .envs(crate::run_config::base_environment(inherited))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

fn begin_browser_request(target: &str, work: Arc<ExecutionWork>) -> Result<BrowserRequest, String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        let operation: Vec<u16> = std::ffi::OsStr::new("open")
            .encode_wide()
            .chain(Some(0))
            .collect();
        let url: Vec<u16> = std::ffi::OsStr::new(target)
            .encode_wide()
            .chain(Some(0))
            .collect();
        // ShellExecute dispatches the validated URL to the OS protocol handler;
        // it never interpolates project text into cmd.exe or PowerShell.
        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                operation.as_ptr(),
                url.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1,
            )
        };
        // Dispatch has returned; the external browser is deliberately user-owned.
        work.confirmed_cleanup();
        if result as isize <= 32 {
            return Err(
                "The system browser could not open this local link. Copy it or retry.".into(),
            );
        }
        Ok(BrowserRequest::Submitted)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let inherited = std::env::vars_os()
            .filter_map(|(key, value)| Some((key.into_string().ok()?, value.into_string().ok()?)));
        let child = match browser_command(target, inherited).spawn() {
            Ok(child) => child,
            Err(_) => {
                work.confirmed_cleanup(); // No helper was created.
                return Err(
                    "The system browser could not start. Copy this local link or retry.".into(),
                );
            }
        };
        Ok(BrowserRequest::Helper(BrowserHelper {
            child: Some(child),
            work,
        }))
    }
}

fn finish_browser_request(request: BrowserRequest) -> Result<(), String> {
    match request {
        #[cfg(target_os = "windows")]
        BrowserRequest::Submitted => Ok(()),
        #[cfg(not(target_os = "windows"))]
        BrowserRequest::Helper(mut helper) => {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
            loop {
                let child = helper
                    .child
                    .as_mut()
                    .ok_or("Browser helper ownership unavailable.")?;
                match child.try_wait() {
                    Ok(Some(status)) => {
                        helper.child.take(); // Reaped: there is no remaining helper owner.
                        helper.work.confirmed_cleanup();
                        return if status.success() {
                            Ok(())
                        } else {
                            Err(
                                "The system browser refused this local link. Copy it or retry."
                                    .into(),
                            )
                        };
                    }
                    Ok(None) if std::time::Instant::now() < deadline => {
                        std::thread::sleep(std::time::Duration::from_millis(10));
                    }
                    _ => {
                        let _ = child.kill();
                        let reap_deadline =
                            std::time::Instant::now() + std::time::Duration::from_millis(500);
                        loop {
                            if child.try_wait().is_ok_and(|status| status.is_some()) {
                                helper.child.take();
                                helper.work.confirmed_cleanup();
                                return Err("The browser request did not finish in time; it may have opened. Copy the URL if needed.".into());
                            }
                            if std::time::Instant::now() >= reap_deadline {
                                // Drop retains this exact child and lease, even during unwind.
                                return Err("Browser helper cleanup is unconfirmed. Update installation remains blocked; inspect the owned helper before restarting HELM.".into());
                            }
                            std::thread::sleep(std::time::Duration::from_millis(10));
                        }
                    }
                }
            }
        }
    }
}

#[tauri::command]
pub(crate) async fn execution_open_loopback(
    window: WebviewWindow,
    context: ExecutionContext,
    url: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let work = crate::maintenance::work()?;
        let app = window.app_handle();
        let policy = app.state::<ExecutionPolicy>();
        let active_repo = app.state::<ActiveRepoBoundary>();
        let root = policy.validate_owner(window.label(), &context)?;
        let request = policy.with_admission(window.label(), &context, || {
            if active_repo.command_repo_root(&context.repo_path)? != root {
                return Err("Workspace changed before opening the local link.".into());
            }
            begin_browser_request(&validate_loopback_url(&url)?, ExecutionWork::new(work))
        })?;
        // OS helper waiting owns no admission lock, so Stop/revocation stays responsive.
        finish_browser_request(request)
    })
    .await
    .map_err(|_| {
        "The browser request worker failed; it may have opened. Copy the URL if needed.".to_string()
    })?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[cfg(unix)]
    #[test]
    fn failed_browser_dispatch_releases_admission_only_after_reap() {
        let gate = crate::maintenance::Gate::default();
        let helper = BrowserHelper {
            child: Some(
                Command::new("/bin/sh")
                    .args(["-c", "exit 7"])
                    .spawn()
                    .unwrap(),
            ),
            work: ExecutionWork::new(gate.work().unwrap()),
        };
        assert!(gate.install().is_err());
        assert!(finish_browser_request(BrowserRequest::Helper(helper)).is_err());
        assert!(gate.install().is_ok()); // Failed dispatch is nevertheless proven reaped.
    }

    #[cfg(unix)]
    #[test]
    fn abandoned_helper_handle_never_silently_releases_its_lease() {
        let gate = crate::maintenance::Gate::default();
        let mut child = Command::new("/bin/sh")
            .args(["-c", "exit 0"])
            .spawn()
            .unwrap();
        child.wait().unwrap(); // No real test child survives this deliberate quarantine.
        drop(BrowserHelper {
            child: Some(child),
            work: ExecutionWork::new(gate.work().unwrap()),
        });
        assert!(gate.install().is_err()); // Ordinary Drop cannot assert a cleanup proof.
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn browser_helper_environment_excludes_helm_and_provider_secrets_without_launching() {
        let command = browser_command(
            "http://localhost:3000/",
            [
                ("PATH".into(), "/usr/bin:/bin".into()),
                ("HOME".into(), "/fixture-home".into()),
                (
                    "HELM_PROVIDER_TOKEN".into(),
                    "synthetic-private-token".into(),
                ),
                ("OPENAI_API_KEY".into(), "synthetic-api-key".into()),
                ("PYTHONPATH".into(), "/private/backend".into()),
            ],
        );
        let variables: std::collections::BTreeMap<_, _> = command.get_envs().collect();
        assert_eq!(variables.len(), 2);
        assert!(variables.contains_key(std::ffi::OsStr::new("PATH")));
        assert!(variables.contains_key(std::ffi::OsStr::new("HOME")));
        assert!(!variables.contains_key(std::ffi::OsStr::new("HELM_PROVIDER_TOKEN")));
        assert!(!variables.contains_key(std::ffi::OsStr::new("OPENAI_API_KEY")));
        assert!(!variables.contains_key(std::ffi::OsStr::new("PYTHONPATH")));
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            [std::ffi::OsStr::new("http://localhost:3000/")]
        );
    }

    #[test]
    fn local_url_policy_checks_original_authority_and_controls() {
        for target in [
            "http://localhost:3000/a?q=ok",
            "https://127.0.0.1:443/Ω",
            "http://[::1]:8080/",
            "HTTP://LOCALHOST/path",
        ] {
            assert!(validate_loopback_url(target).is_ok(), "{target}");
        }
        for target in [
            "file:///tmp/x",
            "javascript:alert(1)",
            "http://localhost.evil/",
            "http://localhost./",
            "http://localhost@evil/",
            "http://evil@localhost/",
            "http://127.1/",
            "http://2130706433/",
            "http://localhost:0/",
            "http://localhost:65536/",
            "http://localhost/%0d%0Aevil",
            "http://localhost\\@evil/",
            "http://[::1]suffix/",
        ] {
            assert!(validate_loopback_url(target).is_err(), "{target}");
        }
    }

    #[test]
    fn contained_diagnostic_has_raw_byte_hash_and_utf16_columns() {
        let root = std::env::temp_dir().join(format!(
            "helm-diagnostic-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(root.join("space Ω")).unwrap();
        fs::write(
            root.join("space Ω/main.py"),
            "print('😀')\r\nraise ValueError('x')\r\n",
        )
        .unwrap();
        let root = root.canonicalize().unwrap();
        let cwd = root.to_string_lossy();
        let found = resolve_location(&root, &cwd, "space Ω/main.py", 1, 99, None).unwrap();
        assert_eq!(found.relative_path, "space Ω/main.py");
        assert_eq!(found.column, 12);
        assert!(!found.source_matches);
        assert!(
            resolve_location(
                &root,
                &cwd,
                "space Ω/main.py",
                2,
                1,
                Some(&found.current_hash)
            )
            .unwrap()
            .source_matches
        );
        assert!(resolve_location(&root, &cwd, "../outside.py", 1, 1, None).is_err());
        assert!(resolve_location(&root, &cwd, "space Ω/main.py", 999, 1, None).is_err());
        assert!(resolve_location(&root, &cwd, "space Ω/main.py", 0, 1, None).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/etc/hosts", root.join("outside.py")).unwrap();
            assert!(resolve_location(&root, &cwd, "outside.py", 1, 1, None).is_err());
        }
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn diagnostic_missing_deleted_nontext_and_oversized_targets_fail_without_mutation() {
        let root = std::env::temp_dir().join(format!(
            "helm-diagnostic-refusal-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let cwd = root.to_string_lossy();
        assert!(resolve_location(&root, &cwd, "missing.py", 1, 1, None)
            .unwrap_err()
            .contains("deleted"));
        fs::write(root.join("deleted.py"), "pass\n").unwrap();
        fs::remove_file(root.join("deleted.py")).unwrap();
        assert!(resolve_location(&root, &cwd, "deleted.py", 1, 1, None).is_err());
        fs::write(root.join("binary.py"), [0xff, 0xfe]).unwrap();
        assert!(resolve_location(&root, &cwd, "binary.py", 1, 1, None)
            .unwrap_err()
            .contains("UTF-8"));
        assert!(resolve_location(&root, &cwd, ".", 1, 1, None).is_err());
        let large = root.join("large.py");
        fs::File::create(&large)
            .unwrap()
            .set_len(8 * 1024 * 1024 + 1)
            .unwrap();
        assert!(resolve_location(&root, &cwd, "large.py", 1, 1, None)
            .unwrap_err()
            .contains("8 MiB"));
        assert_eq!(fs::read(root.join("binary.py")).unwrap(), [0xff, 0xfe]);
        assert_eq!(fs::metadata(large).unwrap().len(), 8 * 1024 * 1024 + 1);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn recorded_cwd_and_stale_hash_bound_relative_absolute_and_large_line_navigation() {
        let root = std::env::temp_dir().join(format!(
            "helm-diagnostic-cwd-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(root.join("sub Ω")).unwrap();
        let root = root.canonicalize().unwrap();
        let file = root.join("sub Ω/main.py");
        fs::write(&file, "😀\r\n").unwrap();
        let cwd = root.join("sub Ω").to_string_lossy().into_owned();
        let first = resolve_location(&root, &cwd, "main.py", 1, u32::MAX, None).unwrap();
        assert_eq!(first.relative_path, "sub Ω/main.py");
        assert_eq!(first.column, 3); // One emoji is two Monaco UTF-16 units, plus end position.
        assert!(
            resolve_location(
                &root,
                &cwd,
                &file.to_string_lossy(),
                1,
                1,
                Some(&first.current_hash.to_uppercase())
            )
            .unwrap()
            .source_matches
        );
        fs::write(&file, format!("{}\r\n", "x".repeat(20_000))).unwrap();
        let changed =
            resolve_location(&root, &cwd, "main.py", 1, 2, Some(&first.current_hash)).unwrap();
        assert!(!changed.source_matches);
        assert!(changed.line_text.is_none());
        for path in ["../sub Ω/main.py", "./../main.py", "bad\0.py"] {
            assert!(resolve_location(&root, &cwd, path, 1, 1, None).is_err());
        }
        assert!(resolve_location(&root, &cwd, "main.py", 1, 1, Some("malformed")).is_err());
        #[cfg(not(windows))]
        for path in ["C:\\project\\main.py", "\\\\server\\share\\main.py"] {
            // Even a Unix file literally bearing a Windows name must not be opened.
            fs::write(root.join("sub Ω").join(path), "pass\n").unwrap();
            assert!(resolve_location(&root, &cwd, path, 1, 1, None)
                .unwrap_err()
                .contains("another platform"));
        }
        fs::remove_dir_all(root).unwrap();
    }
}
