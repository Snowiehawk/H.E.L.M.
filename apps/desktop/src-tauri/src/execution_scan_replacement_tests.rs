//! Headless lifecycle tests of the exact core called by native repository scan.
//! The worker/commit closure is a bounded fixture, not Python IPC or GUI proof.
use super::execute_scan_replacement;
use crate::execution_policy::{ExecutionContext, ExecutionPolicy};
use crate::execution_supervisor::ExecutionSupervisor;
use crate::repo_boundary::CONTEXT_EPOCH;
use crate::run_config::RunConfig;
use std::cell::Cell;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    mpsc, Arc, Mutex,
};
use std::time::Duration;

static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(1);
static EPOCH_TESTS: Mutex<()> = Mutex::new(());
struct Fixture {
    root: PathBuf,
    policy: Arc<ExecutionPolicy>,
    supervisor: Arc<ExecutionSupervisor>,
    gate: crate::maintenance::Gate,
    trusted: ExecutionContext,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "helm-scan-replacement-{}-{}",
            std::process::id(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let policy = Arc::new(ExecutionPolicy::default());
        let bound = policy
            .transition_bind("main", root.clone(), "same-path".into(), || Ok(()))
            .unwrap();
        let trusted = policy.set_trust("main", &bound, true).unwrap();
        Self {
            root,
            policy,
            supervisor: Arc::new(ExecutionSupervisor::default()),
            gate: crate::maintenance::Gate::default(),
            trusted,
        }
    }
    fn missing_tool(&self) -> RunConfig {
        RunConfig {
            id: "scan-replacement".into(),
            name: "Scan replacement fixture".into(),
            kind: "app".into(),
            mode: "executable".into(),
            executable: self
                .root
                .join("deliberately-missing-tool")
                .to_string_lossy()
                .into_owned(),
            args: vec![],
            command: String::new(),
            cwd: ".".into(),
            env: Default::default(),
            secret_names: vec![],
        }
    }
    fn assert_old_launch_refused(&self) {
        let result = self
            .policy
            .launch_spec("main", &self.trusted, &self.missing_tool());
        assert!(matches!(result, Err(message) if message.contains("consent is missing or stale")));
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        // These fixtures never spawn. Still perform exact owned cleanup before
        // discarding paths, so a future regression cannot hide native residue.
        let _ = self.supervisor.shutdown_all();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn same_path_scan_replacements_get_distinct_epochs_and_revoke_old_consent() {
    let _epoch_test = EPOCH_TESTS.lock().unwrap();
    let fixture = Fixture::new();
    let _work = fixture.gate.work().unwrap();
    let watch_stops = Cell::new(0);
    let replace = || {
        execute_scan_replacement(
            &fixture.policy,
            &fixture.supervisor,
            || {
                watch_stops.set(watch_stops.get() + 1);
                Ok(())
            },
            |epoch| Ok((fixture.root.clone(), epoch)),
        )
    };
    let (first_root, first_epoch) = replace().unwrap();
    fixture.assert_old_launch_refused();
    let (second_root, second_epoch) = replace().unwrap();
    assert_eq!(first_root, second_root);
    assert!(second_epoch > first_epoch);
    assert_eq!(watch_stops.get(), 2);
    fixture.supervisor.assert_idle().unwrap();
}

#[test]
fn failed_scan_keeps_advanced_epoch_and_cannot_restore_old_launch_consent() {
    let _epoch_test = EPOCH_TESTS.lock().unwrap();
    let fixture = Fixture::new();
    let _work = fixture.gate.work().unwrap();
    let entered_epoch = Cell::new(None);
    let before = CONTEXT_EPOCH.load(Ordering::SeqCst);
    let result: Result<(), String> = execute_scan_replacement(
        &fixture.policy,
        &fixture.supervisor,
        || Ok(()),
        |epoch| {
            entered_epoch.set(Some(epoch));
            Err("injected worker rejection".into())
        },
    );
    assert!(matches!(result, Err(message) if message == "injected worker rejection"));
    let advanced = entered_epoch
        .get()
        .expect("worker entered after epoch advance");
    assert!(advanced > before);
    assert!(CONTEXT_EPOCH.load(Ordering::SeqCst) >= advanced);
    fixture.assert_old_launch_refused();
    fixture.supervisor.assert_idle().unwrap();
}

#[test]
fn pending_scan_worker_blocks_old_context_launch_until_replacement_returns() {
    let _epoch_test = EPOCH_TESTS.lock().unwrap();
    let fixture = Fixture::new();
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let policy = fixture.policy.clone();
    let supervisor = fixture.supervisor.clone();
    let work = fixture.gate.work().unwrap();
    let worker = std::thread::spawn(move || {
        let _work = work;
        execute_scan_replacement(
            &policy,
            &supervisor,
            || Ok(()),
            |epoch| {
                entered_tx
                    .send(epoch)
                    .map_err(|_| "fixture receiver closed".to_string())?;
                release_rx
                    .recv_timeout(Duration::from_secs(5))
                    .map_err(|_| "fixture release timed out".to_string())?;
                Ok(epoch)
            },
        )
    });
    let entered = entered_rx.recv_timeout(Duration::from_secs(5));
    let launch = fixture
        .policy
        .launch_spec("main", &fixture.trusted, &fixture.missing_tool());
    let owned_action = Cell::new(false);
    let admission = fixture.policy.with_admission("main", &fixture.trusted, || {
        owned_action.set(true);
        Ok(())
    });
    let work_held = fixture.gate.install().is_err();
    // Release/join before assertions, including the unexpected-regression path.
    let _ = release_tx.send(());
    let finished = worker.join();
    let entered = entered.expect("fixture worker should enter bounded replacement");
    assert_eq!(finished.unwrap().unwrap(), entered);
    assert!(matches!(launch, Err(message) if message.contains("transition in progress")));
    assert!(matches!(admission, Err(message) if message.contains("transition in progress")));
    assert!(!owned_action.get());
    assert!(work_held);
    fixture.assert_old_launch_refused();
    fixture.supervisor.assert_idle().unwrap();
    assert!(fixture.gate.install().is_ok());
}

#[test]
fn recorded_partial_cleanup_unknown_refuses_scan_before_watcher_worker_and_epoch_effects() {
    let _epoch_test = EPOCH_TESTS.lock().unwrap();
    let fixture = Fixture::new();
    fixture.supervisor.mark_partial_cleanup_unknown_fixture();
    let _work = fixture.gate.work().unwrap();
    let before = CONTEXT_EPOCH.load(Ordering::SeqCst);
    let stopped_watcher = Cell::new(false);
    let entered_worker = Cell::new(false);
    let result = execute_scan_replacement(
        &fixture.policy,
        &fixture.supervisor,
        || {
            stopped_watcher.set(true);
            Ok(())
        },
        |_| {
            entered_worker.set(true);
            Ok(())
        },
    );
    assert!(
        matches!(result, Err(message) if message.contains("Partial process cleanup") && message.contains("unconfirmed"))
    );
    assert!(!stopped_watcher.get());
    assert!(!entered_worker.get());
    assert_eq!(CONTEXT_EPOCH.load(Ordering::SeqCst), before);
    fixture.assert_old_launch_refused();
    assert!(fixture.supervisor.assert_idle().is_err());
}
