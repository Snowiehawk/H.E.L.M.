//! Headless policy/supervisor integration; these do not invoke Webview IPC.
use super::*;
use std::sync::atomic::AtomicUsize;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let root = std::env::temp_dir().join(format!(
            "helm-admission-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&root).unwrap();
        Self(root.canonicalize().unwrap())
    }
    fn trusted(&self) -> (ExecutionPolicy, ExecutionContext) {
        let policy = ExecutionPolicy::default();
        let context = policy
            .bind("main", self.0.clone(), "generation-one".into())
            .unwrap();
        let context = policy.set_trust("main", &context, true).unwrap();
        (policy, context)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(unix)]
#[test]
fn admission_rejects_root_replaced_by_symlink_after_prior_owner_validation() {
    let fixture = Fixture::new();
    let outside = Fixture::new();
    let (policy, context) = fixture.trusted();
    policy.validate_owner("main", &context).unwrap();
    let moved = fixture.0.with_extension("original");
    std::fs::rename(&fixture.0, &moved).unwrap();
    std::os::unix::fs::symlink(&outside.0, &fixture.0).unwrap();
    let calls = AtomicUsize::new(0);
    let result = policy.with_admission("main", &context, || {
        calls.fetch_add(1, Ordering::SeqCst);
        Ok(())
    });
    std::fs::remove_file(&fixture.0).unwrap();
    std::fs::rename(moved, &fixture.0).unwrap();
    assert!(
        result.is_err(),
        "Final admission followed a changed root identity"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn forged_window_session_generation_path_and_revision_cannot_enter_spawn() {
    let fixture = Fixture::new();
    let (policy, context) = fixture.trusted();
    let mut variants = Vec::new();
    let mut forged = context.clone();
    forged.context_id.push_str("-forged");
    variants.push(("main", forged));
    let mut forged = context.clone();
    forged.generation.push_str("-forged");
    variants.push(("main", forged));
    let mut forged = context.clone();
    forged.repo_path.push_str("/..");
    variants.push(("main", forged));
    let mut forged = context.clone();
    forged.trust_revision += 1;
    variants.push(("main", forged));
    variants.push(("other-window", context));
    let calls = AtomicUsize::new(0);
    for (window, forged) in variants {
        assert!(policy
            .with_admission(window, &forged, || {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
            .is_err());
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn revocation_during_delayed_preparation_rejects_the_late_receipt() {
    let fixture = Fixture::new();
    let (policy, context) = fixture.trusted();
    let policy = std::sync::Arc::new(policy);
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    let (resume_tx, resume_rx) = std::sync::mpsc::channel();
    let worker_policy = policy.clone();
    let pending_context = context.clone();
    let worker = std::thread::spawn(move || {
        ready_tx.send(()).unwrap();
        resume_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        let called = AtomicBool::new(false);
        let result = worker_policy.with_admission("main", &pending_context, || {
            called.store(true, Ordering::SeqCst);
            Ok(())
        });
        (result, called.load(Ordering::SeqCst))
    });
    ready_rx
        .recv_timeout(std::time::Duration::from_secs(2))
        .unwrap();
    let revoked = policy.set_trust("main", &context, false).unwrap();
    resume_tx.send(()).unwrap();
    let (result, called) = worker.join().unwrap();
    assert!(result.is_err());
    assert!(!called);
    assert!(!revoked.trusted);
    assert!(policy.validate_owner("main", &context).is_ok());
}

#[cfg(unix)]
#[test]
fn trusted_explicit_start_once_then_revocation_cleans_actual_owned_child() {
    let fixture = Fixture::new();
    let policy = ExecutionPolicy::default();
    let context = policy
        .bind("main", fixture.0.clone(), "run-terminal-probe".into())
        .unwrap();
    let supervisor = ExecutionSupervisor::default();
    let gate = crate::maintenance::Gate::default();
    for kind in ["run", "terminal", "probe"] {
        let calls = AtomicUsize::new(0);
        assert!(policy
            .with_admission("main", &context, || {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
            .is_err());
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "Untrusted {kind} entered spawn"
        );
    }
    let trusted = policy.set_trust("main", &context, true).unwrap();
    let calls = AtomicUsize::new(0);
    let spec = LaunchSpec {
        executable: "/bin/sh".into(),
        args: vec!["-c".into(), "printf 'explicit-start\n'; sleep 30".into()],
        cwd: fixture.0.clone(),
        env: [("PATH".into(), "/usr/bin:/bin".into())].into(),
        tool: crate::run_config::ToolInfo {
            path: "/bin/sh".into(),
            provenance: "fixture".into(),
            architecture: "native".into(),
            version: None,
            search_path_source: "fixture".into(),
        },
    };
    let started = policy
        .with_admission("main", &trusted, || {
            calls.fetch_add(1, Ordering::SeqCst);
            supervisor.start("main", &trusted, spec, "run", 24, 80, gate.work()?)
        })
        .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(!started.id.is_empty());
    let revoked = policy.set_trust("main", &trusted, false).unwrap();
    supervisor.shutdown_all().unwrap();
    assert!(policy.with_admission("main", &trusted, || Ok(())).is_err());
    assert!(policy.with_admission("main", &revoked, || Ok(())).is_err());
    supervisor.assert_idle().unwrap();
}

#[cfg(unix)]
#[test]
fn canonical_alias_binding_does_not_authorize_a_forged_alias_receipt() {
    let target = Fixture::new();
    let links = Fixture::new();
    let alias = links.0.join("alias – café");
    std::os::unix::fs::symlink(&target.0, &alias).unwrap();
    let policy = ExecutionPolicy::default();
    let mut context = policy
        .bind("main", alias.clone(), "alias-owner".into())
        .unwrap();
    assert_eq!(context.repo_path, normalize_path(&target.0));
    context.trusted = true; // renderer assertion cannot grant native consent
    assert!(policy.with_admission("main", &context, || Ok(())).is_err());
    let trusted = policy.set_trust("main", &context, true).unwrap();
    let mut forged = trusted.clone();
    forged.repo_path = normalize_path(&alias);
    let mut entered = false;
    assert!(policy
        .with_admission("main", &forged, || {
            entered = true;
            Ok(())
        })
        .is_err());
    assert!(!entered);
    let mut accepted = 0;
    policy
        .with_admission("main", &trusted, || {
            accepted += 1;
            Ok(())
        })
        .unwrap();
    assert_eq!(accepted, 1);
}

#[cfg(unix)]
fn admission_fixture_spec(root: &std::path::Path) -> LaunchSpec {
    LaunchSpec {
        executable: "/bin/sh".into(),
        args: vec![
            "-c".into(),
            "printf 'HELM_SYNTHETIC_VERSION\\n'; sleep 30".into(),
        ],
        cwd: root.to_owned(),
        env: [("PATH".into(), "/usr/bin:/bin".into())].into(),
        tool: crate::run_config::ToolInfo {
            path: "/bin/sh".into(),
            provenance: "synthetic admission fixture".into(),
            architecture: "native".into(),
            version: None,
            search_path_source: "fixture".into(),
        },
    }
}

#[cfg(unix)]
#[test]
fn revocation_during_an_actual_owned_probe_rejects_its_late_version_admission() {
    let fixture = Fixture::new();
    let (policy, context) = fixture.trusted();
    let supervisor = ExecutionSupervisor::default();
    let gate = crate::maintenance::Gate::default();
    let started = policy
        .with_admission("main", &context, || {
            supervisor.start(
                "main",
                &context,
                admission_fixture_spec(&fixture.0),
                "probe",
                24,
                80,
                gate.work()?,
            )
        })
        .unwrap();
    assert!(serde_json::to_value(&started).unwrap()["ownedPid"].is_number());
    policy.set_trust("main", &context, false).unwrap();
    supervisor.shutdown_all().unwrap();
    let mut accepted_version = false;
    assert!(policy
        .with_admission("main", &context, || {
            accepted_version = true;
            Ok(())
        })
        .is_err());
    assert!(!accepted_version);
    let stopped = supervisor
        .stop_owned("main", &context, &started.id)
        .unwrap();
    assert!(stopped.cleanup_confirmed);
    assert_eq!(
        serde_json::to_value(&stopped).unwrap()["ownedPid"],
        serde_json::to_value(&started).unwrap()["ownedPid"]
    );
    supervisor.assert_idle().unwrap();
    assert!(gate.install().is_ok());
}

#[cfg(unix)]
#[test]
fn revocation_racing_an_admitted_spawn_cleans_the_created_child_before_returning() {
    let fixture = Fixture::new();
    let (policy, context) = fixture.trusted();
    let policy = std::sync::Arc::new(policy);
    let supervisor = std::sync::Arc::new(ExecutionSupervisor::default());
    let gate = std::sync::Arc::new(crate::maintenance::Gate::default());
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let (revoke_tx, revoke_rx) = std::sync::mpsc::channel();
    let worker_policy = policy.clone();
    let worker_owner = supervisor.clone();
    let worker_gate = gate.clone();
    let worker_context = context.clone();
    let spec = admission_fixture_spec(&fixture.0);
    let start = std::thread::spawn(move || {
        worker_policy.with_admission("main", &worker_context, || {
            entered_tx.send(()).unwrap();
            release_rx
                .recv_timeout(std::time::Duration::from_secs(3))
                .unwrap();
            worker_owner.start(
                "main",
                &worker_context,
                spec,
                "run",
                24,
                80,
                worker_gate.work()?,
            )
        })
    });
    entered_rx
        .recv_timeout(std::time::Duration::from_secs(3))
        .unwrap();
    assert!(policy.bindings.try_lock().is_err()); // actual admission mutex held across spawn
    let revoke_policy = policy.clone();
    let revoke_owner = supervisor.clone();
    let revoke_context = context.clone();
    let revoke = std::thread::spawn(move || {
        revoke_tx.send(()).unwrap();
        let revoked = revoke_policy.set_trust("main", &revoke_context, false)?;
        revoke_owner.shutdown_all()?;
        Ok::<_, String>(revoked)
    });
    revoke_rx
        .recv_timeout(std::time::Duration::from_secs(3))
        .unwrap();
    release_tx.send(()).unwrap();
    let started = start.join().unwrap().unwrap();
    let revoked = revoke.join().unwrap().unwrap();
    assert!(!revoked.trusted);
    let stopped = supervisor
        .stop_owned("main", &context, &started.id)
        .unwrap();
    assert!(stopped.cleanup_confirmed);
    assert_eq!(
        serde_json::to_value(&stopped).unwrap()["ownedPid"],
        serde_json::to_value(&started).unwrap()["ownedPid"]
    );
    assert!(policy.with_admission("main", &context, || Ok(())).is_err());
    supervisor.assert_idle().unwrap();
    assert!(gate.install().is_ok());
}
