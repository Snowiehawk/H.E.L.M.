//! Exercise the exact private cores used by the Run and Terminal IPC handlers.
use super::*;

struct Fixture {
    root: PathBuf,
    active_repo: ActiveRepoBoundary,
    policy: ExecutionPolicy,
    supervisor: ExecutionSupervisor,
    receipts: PreparationReceipts,
    gate: crate::maintenance::Gate,
    context: ExecutionContext,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "helm-command-admission-{}-{}",
            std::process::id(),
            NEXT_ID.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let active_repo = ActiveRepoBoundary::default();
        active_repo.set_active_repo(root.clone()).unwrap();
        let policy = ExecutionPolicy::default();
        let context = policy
            .transition_bind("main", root.clone(), "command-generation".into(), || Ok(()))
            .unwrap();
        Self {
            root,
            active_repo,
            policy,
            supervisor: ExecutionSupervisor::default(),
            receipts: PreparationReceipts::default(),
            gate: crate::maintenance::Gate::default(),
            context,
        }
    }
    fn owner<'a>(&'a self, window: &'a str) -> ExecutionCommandOwner<'a> {
        // The production handler supplies the native window label. Tests vary
        // this private argument to exercise refusal of a different native owner.
        ExecutionCommandOwner {
            window,
            policy: &self.policy,
            supervisor: &self.supervisor,
            active_repo: &self.active_repo,
        }
    }
    fn missing_tool(&self) -> String {
        self.root
            .join("deliberately-missing-executable")
            .to_string_lossy()
            .into_owned()
    }
    fn config(&self, executable: String) -> RunConfig {
        RunConfig {
            id: "command-admission".into(),
            name: "Command admission fixture".into(),
            kind: "app".into(),
            mode: "executable".into(),
            executable,
            args: vec![],
            command: String::new(),
            cwd: ".".into(),
            env: Default::default(),
            secret_names: vec![],
        }
    }
    fn unavailable_source(&self) -> PreparedSource {
        PreparedSource {
            preparation_id: "not-native-issued".into(),
            repo_path: self.context.repo_path.clone(),
            files: vec![],
        }
    }
    fn attempt_missing_tool(
        &self,
        terminal: bool,
        window: &str,
        context: &ExecutionContext,
    ) -> Result<ExecutionSnapshot, String> {
        let owner = self.owner(window);
        let work = self.gate.work()?;
        if terminal {
            owner.start_terminal_owned(context, Some(self.missing_tool()), (24, 80), work)
        } else {
            owner.start_run_owned(
                context,
                &self.config(self.missing_tool()),
                &self.unavailable_source(),
                &self.receipts,
                work,
            )
        }
    }
    fn assert_refused_without_ownership(
        &self,
        result: Result<ExecutionSnapshot, String>,
        expected: &str,
    ) {
        // Clean exact owned handles first even if a regression accidentally
        // launches. Never leave a child behind on a failed assertion.
        let cleanup = self.supervisor.shutdown_all();
        assert!(cleanup.is_ok(), "fixture cleanup failed: {cleanup:?}");
        assert!(
            self.supervisor.sessions.lock().unwrap().is_empty(),
            "a refused entry path created an execution session"
        );
        self.supervisor.assert_idle().unwrap();
        let installation = self.gate.install().expect("refused launch retained Work");
        let error = match result {
            Err(error) => error,
            Ok(snapshot) => panic!("launch unexpectedly admitted: {}", snapshot.id),
        };
        assert!(
            error.contains(expected),
            "expected admission error {expected:?}, received {error:?}"
        );
        drop(installation);
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        // Retain diagnostic files if exact native cleanup cannot be proven.
        if self.supervisor.shutdown_all().is_ok() {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
}

#[test]
fn run_entry_core_refuses_native_untrusted_forged_stale_and_wrong_owner_before_fallback() {
    check_denied_entry_paths(false);
}

#[test]
fn terminal_entry_core_refuses_native_untrusted_forged_stale_and_wrong_owner_before_fallback() {
    check_denied_entry_paths(true);
}

fn check_denied_entry_paths(terminal: bool) {
    let fixture = Fixture::new();
    let mut forged = fixture.context.clone();
    forged.trusted = true;
    // Both contexts refer to the real active repository and a valid cwd. The
    // nonexistent tool and absent receipt must not mask consent/owner refusal.
    for context in [&fixture.context, &forged] {
        fixture.assert_refused_without_ownership(
            fixture.attempt_missing_tool(terminal, "main", context),
            "consent is missing or stale",
        );
    }
    let trusted = fixture
        .policy
        .set_trust("main", &fixture.context, true)
        .unwrap();
    let mut stale_revision = trusted.clone();
    stale_revision.trust_revision -= 1;
    fixture.assert_refused_without_ownership(
        fixture.attempt_missing_tool(terminal, "main", &stale_revision),
        "consent is missing or stale",
    );
    let mut wrong_generation = trusted.clone();
    wrong_generation.generation = "renderer-replaced-generation".into();
    let mut wrong_identity = trusted.clone();
    wrong_identity.context_id = "renderer-forged-context".into();
    // Revocation is native state; setting a renderer boolean cannot regrant it.
    let revoked = fixture.policy.set_trust("main", &trusted, false).unwrap();
    forged.trust_revision = revoked.trust_revision;
    let mut current_untrusted = revoked.clone();
    current_untrusted.trusted = false;
    let cases = [
        ("main", current_untrusted, "consent is missing or stale"),
        ("main", forged, "consent is missing or stale"),
        ("main", trusted, "consent is missing or stale"),
        ("main", wrong_generation, "different window or workspace"),
        ("main", wrong_identity, "different window or workspace"),
        ("other-native-window", revoked, "Open the active workspace"),
    ];
    for (window, context, expected) in cases {
        let result = fixture.attempt_missing_tool(terminal, window, &context);
        fixture.assert_refused_without_ownership(result, expected);
    }
}

#[cfg(unix)]
#[test]
fn trusted_terminal_entry_core_starts_once_and_keeps_work_until_owned_cleanup() {
    let fixture = Fixture::new();
    let trusted = fixture
        .policy
        .set_trust("main", &fixture.context, true)
        .unwrap();
    let started = fixture.owner("main").start_terminal_owned(
        &trusted,
        Some("/bin/sh".into()),
        (24, 80),
        fixture.gate.work().unwrap(),
    );
    let held_work = fixture.gate.install().is_err();
    // Stop before checking the result so even an assertion failure cannot leave
    // this known, startup-script-free fixture shell alive.
    let cleanup = fixture.supervisor.shutdown_all();
    assert!(cleanup.is_ok(), "fixture cleanup failed: {cleanup:?}");
    let started = started.expect("trusted Terminal core should launch");
    assert!(held_work, "live Terminal must retain the original Work");
    assert_eq!(fixture.supervisor.sessions.lock().unwrap().len(), 1);
    let stopped = fixture
        .supervisor
        .session("main", &trusted, &started.id)
        .unwrap()
        .snapshot(0)
        .unwrap();
    assert!(stopped.cleanup_confirmed);
    fixture.supervisor.assert_idle().unwrap();
    assert!(fixture.gate.install().is_ok());
}

#[cfg(unix)]
#[test]
fn trusted_run_entry_core_consumes_real_receipt_starts_once_and_cleans_owned_child() {
    let fixture = Fixture::new();
    let trusted = fixture
        .policy
        .set_trust("main", &fixture.context, true)
        .unwrap();
    let source = b"exit 23\n";
    std::fs::write(fixture.root.join("fixture.sh"), source).unwrap();
    let issued = fixture
        .receipts
        .issue_fixture(
            "main",
            &trusted,
            serde_json::json!({
                "repoPath": trusted.repo_path,
                "files": [{
                    "relativePath": "fixture.sh",
                    "sha256": format!("{:x}", Sha256::digest(source)),
                }],
            }),
        )
        .unwrap();
    let prepared: PreparedSource = serde_json::from_value(issued).unwrap();
    let mut config = fixture.config("/bin/sh".into());
    config.args = vec!["fixture.sh".into()];
    let started = fixture.owner("main").start_run_owned(
        &trusted,
        &config,
        &prepared,
        &fixture.receipts,
        fixture.gate.work().unwrap(),
    );
    let cleanup = fixture.supervisor.shutdown_all();
    assert!(cleanup.is_ok(), "fixture cleanup failed: {cleanup:?}");
    let started = started.expect("trusted Run core should launch verified fixture");
    assert_eq!(fixture.supervisor.sessions.lock().unwrap().len(), 1);
    assert!(
        fixture
            .supervisor
            .session("main", &trusted, &started.id)
            .unwrap()
            .snapshot(0)
            .unwrap()
            .cleanup_confirmed
    );
    fixture.supervisor.assert_idle().unwrap();
    assert!(fixture.gate.install().is_ok());

    // Reusing the same genuine receipt must fail without creating a second
    // session, even though native trust still admits the configured tool.
    let replay = fixture.owner("main").start_run_owned(
        &trusted,
        &config,
        &prepared,
        &fixture.receipts,
        fixture.gate.work().unwrap(),
    );
    let cleanup = fixture.supervisor.shutdown_all();
    assert!(cleanup.is_ok(), "fixture cleanup failed: {cleanup:?}");
    assert!(
        matches!(replay, Err(error) if error.contains("receipt is unavailable or already used"))
    );
    assert_eq!(fixture.supervisor.sessions.lock().unwrap().len(), 1);
    fixture.supervisor.assert_idle().unwrap();
    assert!(fixture.gate.install().is_ok());
}
