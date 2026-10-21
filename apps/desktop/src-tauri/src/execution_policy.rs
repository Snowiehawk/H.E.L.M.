//! Session-only execution consent. Project identity and trust are independent of Issues metadata.
use crate::execution_supervisor::ExecutionSupervisor;
use crate::repo_boundary::{canonicalize_repo_root, normalize_path, ActiveRepoBoundary};
use crate::run_config::{self, LaunchSpec, RunConfig};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Mutex,
};
use tauri::{Manager, State, WebviewWindow};

static NEXT_CONTEXT: AtomicU64 = AtomicU64::new(1);
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExecutionContext {
    pub(crate) context_id: String,
    pub(crate) repo_path: String,
    pub(crate) generation: String,
    pub(crate) trust_revision: u64,
    pub(crate) trusted: bool,
}
struct Binding {
    context: ExecutionContext,
    secrets: BTreeMap<String, BTreeMap<String, String>>,
}
#[derive(Default)]
pub(crate) struct ExecutionPolicy {
    bindings: Mutex<BTreeMap<String, Binding>>,
    transitioning: AtomicBool,
    closing: AtomicBool,
}
pub(crate) struct ExecutionTransition<'a> {
    policy: &'a ExecutionPolicy,
    sealed: bool,
}
impl ExecutionTransition<'_> {
    /// Runtime destroy/exit requests are queued. Keep admission closed after the
    /// worker returns, until the window/application has actually disappeared.
    pub(crate) fn seal(mut self) {
        self.policy.closing.store(true, Ordering::SeqCst);
        self.sealed = true;
    }
}
impl Drop for ExecutionTransition<'_> {
    fn drop(&mut self) {
        if self.sealed {
            return;
        }
        if let Ok(_bindings) = self.policy.bindings.lock() {
            self.policy.transitioning.store(false, Ordering::SeqCst);
        }
    }
}
impl ExecutionPolicy {
    /// A transition lease spans the entire native Git/open/exit operation, including
    /// slow worker I/O. Revocation alone cannot prevent a renderer regrant in that gap.
    pub(crate) fn begin_transition(&self) -> Result<ExecutionTransition<'_>, String> {
        let mut bindings = self
            .bindings
            .lock()
            .map_err(|_| "Execution state unavailable.")?;
        if self.transitioning.swap(true, Ordering::SeqCst) {
            return Err("A workspace or application transition is already in progress.".into());
        }
        for binding in bindings.values_mut() {
            binding.context.trust_revision += 1;
            binding.context.trusted = false;
            binding.secrets.clear();
        }
        Ok(ExecutionTransition {
            policy: self,
            sealed: false,
        })
    }
    pub(crate) fn is_closing(&self) -> bool {
        self.closing.load(Ordering::SeqCst)
    }
    fn check_transition(&self) -> Result<(), String> {
        if self.transitioning.load(Ordering::SeqCst) {
            return Err("Workspace or application transition in progress. Execution stays disabled until it finishes.".into());
        }
        Ok(())
    }
    /// Rebinding is passive but cannot forget owned work. Holding the same admission lock
    /// across cleanup prevents a start racing between revocation and replacement.
    pub(crate) fn transition_bind(
        &self,
        window: &str,
        root: PathBuf,
        generation: String,
        stop: impl FnOnce() -> Result<(), String>,
    ) -> Result<ExecutionContext, String> {
        if window != "main" || generation.is_empty() || generation.len() > 512 {
            return Err("Invalid execution window or workspace generation.".into());
        }
        let mut bindings = self
            .bindings
            .lock()
            .map_err(|_| "Execution state unavailable.")?;
        self.check_transition()?;
        let repo_path = normalize_path(&root);
        if let Some(binding) = bindings.get_mut(window) {
            if binding.context.repo_path == repo_path && binding.context.generation == generation {
                return Ok(binding.context.clone());
            }
            binding.context.trust_revision += 1;
            binding.context.trusted = false;
            binding.secrets.clear();
        }
        stop()?; // Failure retains the revoked old binding, preserving cleanup ownership.
        let context = ExecutionContext {
            context_id: format!("execution-{}", NEXT_CONTEXT.fetch_add(1, Ordering::Relaxed)),
            repo_path,
            generation,
            trust_revision: 0,
            trusted: false,
        };
        bindings.insert(
            window.into(),
            Binding {
                context: context.clone(),
                secrets: BTreeMap::new(),
            },
        );
        Ok(context)
    }
    #[cfg(test)]
    fn bind(
        &self,
        window: &str,
        root: PathBuf,
        generation: String,
    ) -> Result<ExecutionContext, String> {
        self.transition_bind(
            window,
            root.canonicalize().map_err(|_| "Test root unavailable.")?,
            generation,
            || Ok(()),
        )
    }
    fn check<'a>(
        bindings: &'a BTreeMap<String, Binding>,
        window: &str,
        context: &ExecutionContext,
    ) -> Result<&'a Binding, String> {
        let binding = bindings
            .get(window)
            .ok_or("Open the active workspace before executing.")?;
        let actual = &binding.context;
        if actual.context_id != context.context_id
            || actual.repo_path != context.repo_path
            || actual.generation != context.generation
        {
            return Err("Execution belongs to a different window or workspace. Retry in the current project.".into());
        }
        Ok(binding)
    }
    pub(crate) fn validate_owner(
        &self,
        window: &str,
        context: &ExecutionContext,
    ) -> Result<PathBuf, String> {
        let bindings = self
            .bindings
            .lock()
            .map_err(|_| "Execution state unavailable.")?;
        Self::check(&bindings, window, context)?;
        drop(bindings);
        let root = canonicalize_repo_root(&context.repo_path)?;
        if normalize_path(&root) != context.repo_path {
            return Err(
                "Workspace path identity changed. Reopen the project before executing.".into(),
            );
        }
        Ok(root)
    }
    /// Lock held through admission/spawn: revocation cannot overtake the final check.
    pub(crate) fn with_admission<T>(
        &self,
        window: &str,
        context: &ExecutionContext,
        action: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let bindings = self
            .bindings
            .lock()
            .map_err(|_| "Execution state unavailable.")?;
        self.check_transition()?;
        let binding = Self::check(&bindings, window, context)?;
        if !binding.context.trusted || binding.context.trust_revision != context.trust_revision {
            return Err("Trust this project for this session before running code. Trust allows user-level code; it is not a sandbox.".into());
        }
        // Reaffirm canonical identity at the final spawn/input boundary, after any
        // asynchronous preparation or runtime discovery. A bound pathname may have
        // been replaced by a symlink since ActiveRepoBoundary checked it.
        let root = canonicalize_repo_root(&binding.context.repo_path)?;
        if normalize_path(&root) != binding.context.repo_path {
            return Err(
                "Workspace path identity changed. Reopen the project before executing.".into(),
            );
        }
        action()
    }
    /// Invalidate pending launch snapshots without accepting a renderer trust boolean.
    pub(crate) fn invalidate_pending(
        &self,
        window: &str,
        context: &ExecutionContext,
    ) -> Result<ExecutionContext, String> {
        let mut bindings = self
            .bindings
            .lock()
            .map_err(|_| "Execution state unavailable.")?;
        Self::check(&bindings, window, context)?;
        let binding = bindings
            .get_mut(window)
            .ok_or("Execution state unavailable.")?;
        binding.context.trust_revision += 1;
        Ok(binding.context.clone())
    }
    pub(crate) fn set_trust(
        &self,
        window: &str,
        context: &ExecutionContext,
        trusted: bool,
    ) -> Result<ExecutionContext, String> {
        let mut bindings = self
            .bindings
            .lock()
            .map_err(|_| "Execution state unavailable.")?;
        if trusted {
            self.check_transition()?;
        }
        Self::check(&bindings, window, context)?;
        let binding = bindings
            .get_mut(window)
            .ok_or("Execution state unavailable.")?;
        if trusted && binding.context.trust_revision != context.trust_revision {
            return Err(
                "Execution consent changed. Refresh project execution state before retrying."
                    .into(),
            );
        }
        binding.context.trust_revision += 1;
        binding.context.trusted = trusted;
        if !trusted {
            binding.secrets.clear();
        }
        Ok(binding.context.clone())
    }
    pub(crate) fn set_secrets(
        &self,
        window: &str,
        context: &ExecutionContext,
        config_id: &str,
        values: BTreeMap<String, Option<String>>,
    ) -> Result<(), String> {
        if !run_config::valid_id(config_id) || values.len() > 128 {
            return Err("Invalid private environment input.".into());
        }
        let mut names = std::collections::BTreeSet::new();
        for (name, value) in &values {
            run_config::validate_env_name(name)?;
            if !names.insert(name.to_ascii_uppercase()) {
                return Err(
                    "Private environment keys must be unique, including letter case.".into(),
                );
            }
            if value
                .as_ref()
                .is_some_and(|v| v.len() > 32768 || v.contains('\0'))
            {
                return Err("Private environment value is invalid or too large.".into());
            }
        }
        let mut bindings = self
            .bindings
            .lock()
            .map_err(|_| "Execution state unavailable.")?;
        self.check_transition()?;
        let binding = Self::check(&bindings, window, context)?;
        if !binding.context.trusted || binding.context.trust_revision != context.trust_revision {
            return Err("Trust this project before setting private run values.".into());
        }
        let binding = bindings
            .get_mut(window)
            .ok_or("Execution state unavailable.")?;
        if !binding.secrets.contains_key(config_id) && binding.secrets.len() >= 64 {
            return Err("Private values are limited to 64 configurations per session. Close the project to clear unused session values.".into());
        }
        let mut next = binding.secrets.get(config_id).cloned().unwrap_or_default();
        for (name, value) in values {
            next.retain(|old, _| !old.eq_ignore_ascii_case(&name));
            if let Some(value) = value {
                next.insert(name, value);
            } else {
                next.remove(&name);
            }
        }
        if next.len() > 128 {
            return Err("Private values are limited to 128 variables per configuration. No values were changed.".into());
        }
        if next.is_empty() {
            binding.secrets.remove(config_id);
        } else {
            binding.secrets.insert(config_id.into(), next);
        }
        Ok(())
    }
    /// Build outside the consent lock so filesystem/tool inspection cannot block
    /// Stop. Every caller must recheck with_admission immediately around spawn/use.
    pub(crate) fn launch_spec(
        &self,
        window: &str,
        context: &ExecutionContext,
        config: &RunConfig,
    ) -> Result<LaunchSpec, String> {
        let secrets = {
            let bindings = self
                .bindings
                .lock()
                .map_err(|_| "Execution state unavailable.")?;
            self.check_transition()?;
            let binding = Self::check(&bindings, window, context)?;
            if !binding.context.trusted || binding.context.trust_revision != context.trust_revision
            {
                return Err("Project execution consent is missing or stale.".into());
            }
            binding.secrets.get(&config.id).cloned().unwrap_or_default()
        };
        let root = canonicalize_repo_root(&context.repo_path)?;
        let spec = run_config::prepare_launch(&root, config, &secrets)?;
        self.with_admission(window, context, || Ok(spec))
    }
}
#[tauri::command]
pub(crate) async fn execution_bind(
    window: WebviewWindow,
    repo_path: String,
    generation: String,
) -> Result<ExecutionContext, String> {
    let window_label = window.label().to_string();
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _work = crate::maintenance::work()?;
        let policy = app.state::<ExecutionPolicy>();
        let active_repo = app.state::<ActiveRepoBoundary>();
        let supervisor = app.state::<ExecutionSupervisor>();
        let root = active_repo.command_repo_root(&repo_path)?;
        policy.transition_bind(&window_label, root, generation, || {
            supervisor.shutdown_all()
        })
    })
    .await
    .map_err(|_| {
        "Execution binding was interrupted; check process status before retrying.".to_string()
    })?
}
// Revocation is orchestrated by execution_set_trust in the supervisor command layer:
// invalidate consent first, then stop all owned work and surface cleanup-unknown.
#[tauri::command]
pub(crate) fn execution_set_secrets(
    window: WebviewWindow,
    policy: State<'_, ExecutionPolicy>,
    context: ExecutionContext,
    config_id: String,
    values: BTreeMap<String, Option<String>>,
) -> Result<(), String> {
    let _work = crate::maintenance::work()?;
    policy.set_secrets(window.label(), &context, &config_id, values)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn consent_and_identity_are_native_and_revision_bound() {
        let p = ExecutionPolicy::default();
        let root = std::env::temp_dir().canonicalize().unwrap();
        let c = p.bind("main", root.clone(), "one".into()).unwrap();
        assert!(p.with_admission("main", &c, || Ok(())).is_err());
        let c = p.set_trust("main", &c, true).unwrap();
        assert!(p.with_admission("other", &c, || Ok(())).is_err());
        assert!(p.with_admission("main", &c, || Ok(())).is_ok());
        let revoked = p.set_trust("main", &c, false).unwrap();
        assert!(p.with_admission("main", &c, || Ok(())).is_err());
        assert!(p.validate_owner("main", &c).is_ok()); // cleanup stays available
        assert!(!revoked.trusted);
        p.bind("main", root, "two".into()).unwrap();
        assert!(p.validate_owner("main", &c).is_err());
    }
    #[test]
    fn failed_transition_revokes_but_preserves_old_cleanup_identity() {
        let p = ExecutionPolicy::default();
        let c = p.bind("main", std::env::temp_dir(), "one".into()).unwrap();
        let c = p.set_trust("main", &c, true).unwrap();
        assert!(p
            .transition_bind("main", std::env::temp_dir(), "two".into(), || Err(
                "cleanup unknown".into()
            ))
            .is_err());
        assert!(p.validate_owner("main", &c).is_ok());
        assert!(p.with_admission("main", &c, || Ok(())).is_err());
    }
    #[test]
    fn invalidating_pending_cannot_grant_renderer_claimed_trust() {
        let p = ExecutionPolicy::default();
        let mut c = p.bind("main", std::env::temp_dir(), "one".into()).unwrap();
        c.trusted = true;
        let c = p.invalidate_pending("main", &c).unwrap();
        assert!(!c.trusted);
        let c = p.set_trust("main", &c, true).unwrap();
        drop(p.begin_transition().unwrap());
        assert!(p.with_admission("main", &c, || Ok(())).is_err());
    }
    #[test]
    fn transition_lease_blocks_rebinding_regrant_and_delayed_admission() {
        let p = ExecutionPolicy::default();
        let root = std::env::temp_dir();
        let c = p.bind("main", root.clone(), "one".into()).unwrap();
        let c = p.set_trust("main", &c, true).unwrap();
        let lease = p.begin_transition().unwrap();
        assert!(p.bind("main", root.clone(), "one".into()).is_err());
        assert!(p.set_trust("main", &c, true).is_err());
        assert!(p.with_admission("main", &c, || Ok(())).is_err());
        assert!(p.begin_transition().is_err());
        assert!(p.validate_owner("main", &c).is_ok());
        drop(lease);
        let current = p.bind("main", root, "one".into()).unwrap();
        assert!(!current.trusted);
        assert!(p.with_admission("main", &current, || Ok(())).is_err());
        assert!(p.set_trust("main", &current, true).is_ok());
    }
    #[test]
    fn queued_close_seals_admission_but_failed_close_lease_restores_recovery() {
        let p = ExecutionPolicy::default();
        let root = std::env::temp_dir();
        p.bind("main", root.clone(), "one".into()).unwrap();
        // A failed destroy returns before sealing and drops its lease normally.
        {
            let _failed_destroy = p.begin_transition().unwrap();
        }
        assert!(!p.is_closing());
        let c = p.bind("main", root.clone(), "one".into()).unwrap();
        let c = p.set_trust("main", &c, true).unwrap();
        p.begin_transition().unwrap().seal();
        assert!(p.is_closing());
        assert!(p.bind("main", root, "one".into()).is_err());
        assert!(p.set_trust("main", &c, true).is_err());
        assert!(p.with_admission("main", &c, || Ok(())).is_err());
        assert!(p.validate_owner("main", &c).is_ok());
    }
    #[test]
    fn env_import_is_literal_atomic_and_never_sources_shell() {
        let parsed =
            parse_private_env("# comment\nTOKEN='synthetic'\nLITERAL=\"$(touch NEVER)\"\nEMPTY=\n")
                .unwrap();
        assert_eq!(parsed["TOKEN"].as_deref(), Some("synthetic"));
        assert_eq!(parsed["LITERAL"].as_deref(), Some("$(touch NEVER)"));
        assert_eq!(parsed["EMPTY"].as_deref(), Some(""));
        for malformed in [
            "export FOO=value",
            "source ./activate",
            "FOO='unmatched",
            "FOO=one\nfoo=two",
            "HELM_TOKEN=synthetic",
        ] {
            assert!(parse_private_env(malformed).is_err());
        }
    }
    #[test]
    fn arbitrary_renderer_trusted_boolean_cannot_grant_consent() {
        let p = ExecutionPolicy::default();
        let mut c = p.bind("main", std::env::temp_dir(), "one".into()).unwrap();
        c.trusted = true;
        assert!(p.with_admission("main", &c, || Ok(())).is_err());
        assert!(p.set_secrets("main", &c, "app", BTreeMap::new()).is_err());
    }
    fn private_fixture() -> (ExecutionPolicy, ExecutionContext, RunConfig) {
        let p = ExecutionPolicy::default();
        let c = p
            .bind("main", std::env::temp_dir(), "private-fixture".into())
            .unwrap();
        let c = p.set_trust("main", &c, true).unwrap();
        let config = RunConfig {
            id: "app".into(),
            name: "App".into(),
            kind: "app".into(),
            mode: "executable".into(),
            executable: if cfg!(windows) { "cmd.exe" } else { "/bin/sh" }.into(),
            args: vec![],
            command: String::new(),
            cwd: ".".into(),
            env: BTreeMap::new(),
            secret_names: vec!["FIXTURE_TOKEN".into()],
        };
        (p, c, config)
    }
    #[test]
    fn private_replace_unset_and_config_selection_have_atomic_session_precedence() {
        let (p, c, config) = private_fixture();
        p.set_secrets(
            "main",
            &c,
            "app",
            BTreeMap::from([("FIXTURE_TOKEN".into(), Some("synthetic-first".into()))]),
        )
        .unwrap();
        p.set_secrets(
            "main",
            &c,
            "other",
            BTreeMap::from([("FIXTURE_TOKEN".into(), Some("synthetic-other".into()))]),
        )
        .unwrap();
        assert_eq!(
            p.launch_spec("main", &c, &config).unwrap().env["FIXTURE_TOKEN"],
            "synthetic-first"
        );
        p.set_secrets(
            "main",
            &c,
            "app",
            BTreeMap::from([("fixture_token".into(), Some("synthetic-replaced".into()))]),
        )
        .unwrap();
        let replaced = p.launch_spec("main", &c, &config).unwrap();
        assert_eq!(replaced.env["FIXTURE_TOKEN"], "synthetic-replaced");
        assert!(!replaced.env.contains_key("fixture_token"));
        p.set_secrets(
            "main",
            &c,
            "app",
            BTreeMap::from([("FIXTURE_TOKEN".into(), None)]),
        )
        .unwrap();
        assert!(p.launch_spec("main", &c, &config).is_err());
        let mut other = config.clone();
        other.id = "other".into();
        assert_eq!(
            p.launch_spec("main", &c, &other).unwrap().env["FIXTURE_TOKEN"],
            "synthetic-other"
        );
        other.secret_names.clear();
        assert!(!p
            .launch_spec("main", &c, &other)
            .unwrap()
            .env
            .contains_key("FIXTURE_TOKEN"));
    }
    #[test]
    fn rejected_private_updates_preserve_previous_values_without_error_payload_leaks() {
        let (p, c, config) = private_fixture();
        p.set_secrets(
            "main",
            &c,
            "app",
            BTreeMap::from([("FIXTURE_TOKEN".into(), Some("synthetic-kept".into()))]),
        )
        .unwrap();
        for values in [
            BTreeMap::from([
                ("FIXTURE_TOKEN".into(), Some("synthetic-rejected".into())),
                ("fixture_token".into(), Some("synthetic-rejected".into())),
            ]),
            BTreeMap::from([("BAD-NAME".into(), Some("synthetic-rejected".into()))]),
            BTreeMap::from([("FIXTURE_TOKEN".into(), Some("synthetic-rejected\0".into()))]),
        ] {
            let error = p.set_secrets("main", &c, "app", values).unwrap_err();
            assert!(!serde_json::to_string(&error)
                .unwrap()
                .contains("synthetic-rejected"));
            assert_eq!(
                p.launch_spec("main", &c, &config).unwrap().env["FIXTURE_TOKEN"],
                "synthetic-kept"
            );
        }
        assert!(!serde_json::to_string(&c)
            .unwrap()
            .contains("synthetic-kept"));
        assert!(!serde_json::to_string(&config)
            .unwrap()
            .contains("synthetic-kept"));
        assert!(
            !serde_json::to_string(&p.launch_spec("main", &c, &config).unwrap().tool)
                .unwrap()
                .contains("synthetic-kept")
        );
    }
    #[test]
    fn revocation_during_import_blocks_late_commit_and_successful_replacement_has_no_secrets() {
        let (p, c, config) = private_fixture();
        let parsed = parse_private_env("FIXTURE_TOKEN=synthetic-late-import\n").unwrap();
        let revoked = p.set_trust("main", &c, false).unwrap();
        assert!(p.set_secrets("main", &c, "app", parsed).is_err());
        let trusted = p.set_trust("main", &revoked, true).unwrap();
        assert!(p.launch_spec("main", &trusted, &config).is_err());
        p.set_secrets(
            "main",
            &trusted,
            "app",
            BTreeMap::from([("FIXTURE_TOKEN".into(), Some("synthetic-close".into()))]),
        )
        .unwrap();
        let stopped = std::cell::Cell::new(false);
        let replacement = p
            .transition_bind(
                "main",
                std::env::temp_dir().canonicalize().unwrap(),
                "replacement".into(),
                || {
                    stopped.set(true);
                    Ok(())
                },
            )
            .unwrap();
        assert!(stopped.get());
        let replacement = p.set_trust("main", &replacement, true).unwrap();
        assert!(p.launch_spec("main", &replacement, &config).is_err());
    }
    #[test]
    fn malformed_import_errors_never_echo_values_or_partially_change_session() {
        let (p, c, config) = private_fixture();
        p.set_secrets(
            "main",
            &c,
            "app",
            BTreeMap::from([("FIXTURE_TOKEN".into(), Some("synthetic-existing".into()))]),
        )
        .unwrap();
        for raw in [
            "FIXTURE_TOKEN=synthetic-rejected\nBROKEN",
            "FIXTURE_TOKEN='synthetic-rejected",
            "FIXTURE_TOKEN=synthetic-rejected\nfixture_token=duplicate",
        ] {
            let error = parse_private_env(raw).unwrap_err();
            assert!(!serde_json::to_string(&error)
                .unwrap()
                .contains("synthetic-rejected"));
            assert_eq!(
                p.launch_spec("main", &c, &config).unwrap().env["FIXTURE_TOKEN"],
                "synthetic-existing"
            );
        }
    }
    #[cfg(unix)]
    #[test]
    fn intended_child_receives_only_selected_synthetic_private_values() {
        let (p, c, mut config) = private_fixture();
        p.set_secrets(
            "main",
            &c,
            "app",
            BTreeMap::from([("FIXTURE_TOKEN".into(), Some("synthetic-intended".into()))]),
        )
        .unwrap();
        p.set_secrets(
            "main",
            &c,
            "other",
            BTreeMap::from([(
                "FIXTURE_UNSELECTED".into(),
                Some("synthetic-other-config".into()),
            )]),
        )
        .unwrap();
        config.args = vec!["-c".into(), "test \"$FIXTURE_TOKEN\" = synthetic-intended && test -z \"${FIXTURE_UNSELECTED+x}\" && printf selected-only".into()];
        let spec = p.launch_spec("main", &c, &config).unwrap();
        let output = std::process::Command::new(spec.executable)
            .args(spec.args)
            .current_dir(spec.cwd)
            .env_clear()
            .envs(spec.env)
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, b"selected-only");
        assert!(output.stderr.is_empty());
        config.secret_names.clear();
        config.args = vec!["-c".into(), "test -z \"${FIXTURE_TOKEN+x}\" && test -z \"${FIXTURE_UNSELECTED+x}\" && printf unrelated-child".into()];
        let spec = p.launch_spec("main", &c, &config).unwrap();
        let output = std::process::Command::new(spec.executable)
            .args(spec.args)
            .current_dir(spec.cwd)
            .env_clear()
            .envs(spec.env)
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, b"unrelated-child");
        assert!(output.stderr.is_empty());
    }
    #[test]
    fn different_local_copies_with_same_config_id_cannot_reuse_private_values() {
        let (p, initial, config) = private_fixture();
        let directory = std::env::temp_dir().join(format!(
            "helm-private-checkouts-{}-{}",
            std::process::id(),
            initial.context_id
        ));
        std::fs::create_dir_all(directory.join("first Ω")).unwrap();
        std::fs::create_dir_all(directory.join("second Ω")).unwrap();
        let first = p
            .transition_bind(
                "main",
                directory.join("first Ω").canonicalize().unwrap(),
                "same-generation".into(),
                || Ok(()),
            )
            .unwrap();
        let first = p.set_trust("main", &first, true).unwrap();
        p.set_secrets(
            "main",
            &first,
            "app",
            BTreeMap::from([("FIXTURE_TOKEN".into(), Some("synthetic-first-copy".into()))]),
        )
        .unwrap();
        let second = p
            .transition_bind(
                "main",
                directory.join("second Ω").canonicalize().unwrap(),
                "same-generation".into(),
                || Ok(()),
            )
            .unwrap();
        assert_ne!(first.context_id, second.context_id);
        assert!(p.launch_spec("main", &first, &config).is_err());
        let second = p.set_trust("main", &second, true).unwrap();
        assert!(p.launch_spec("main", &second, &config).is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn private_import_file_failures_preserve_existing_values_and_never_source_contents() {
        let (p, c, config) = private_fixture();
        p.set_secrets(
            "main",
            &c,
            "app",
            BTreeMap::from([(
                "FIXTURE_TOKEN".into(),
                Some("synthetic-before-import".into()),
            )]),
        )
        .unwrap();
        let base = std::env::temp_dir().join(format!(
            "helm-private-import-{}-{}",
            std::process::id(),
            c.context_id
        ));
        std::fs::create_dir_all(base.join("checkout")).unwrap();
        let root = base.join("checkout").canonicalize().unwrap();
        std::fs::write(
            root.join("invalid.env"),
            "FIXTURE_TOKEN=synthetic-rejected-file\nBROKEN",
        )
        .unwrap();
        std::fs::write(root.join("binary.env"), [0xff]).unwrap();
        std::fs::File::create(root.join("large.env"))
            .unwrap()
            .set_len(128 * 1024 + 1)
            .unwrap();
        for path in [
            "missing.env",
            "invalid.env",
            "binary.env",
            "large.env",
            "../outside.env",
        ] {
            let error = read_private_env(&root, path).unwrap_err();
            assert!(!serde_json::to_string(&error)
                .unwrap()
                .contains("synthetic-rejected-file"));
            assert_eq!(
                p.launch_spec("main", &c, &config).unwrap().env["FIXTURE_TOKEN"],
                "synthetic-before-import"
            );
        }
        #[cfg(unix)]
        {
            std::fs::write(base.join("outside.env"), "FIXTURE_TOKEN=synthetic-outside").unwrap();
            std::os::unix::fs::symlink(base.join("outside.env"), root.join("escape.env")).unwrap();
            assert!(read_private_env(&root, "escape.env").is_err());
        }
        std::fs::write(
            root.join("literal.env"),
            "FIXTURE_TOKEN='synthetic-imported'\nLITERAL=$(touch MUST_NOT_EXIST)\n",
        )
        .unwrap();
        let values = read_private_env(&root, "literal.env").unwrap();
        assert_eq!(
            values["LITERAL"].as_deref(),
            Some("$(touch MUST_NOT_EXIST)")
        );
        p.set_secrets("main", &c, "app", values).unwrap();
        assert_eq!(
            p.launch_spec("main", &c, &config).unwrap().env["FIXTURE_TOKEN"],
            "synthetic-imported"
        );
        assert!(!root.join("MUST_NOT_EXIST").exists());
        std::fs::remove_dir_all(base).unwrap();
    }
}

/// Minimal literal .env dialect. This is data parsing, never shell evaluation.
fn parse_private_env(raw: &str) -> Result<BTreeMap<String, Option<String>>, String> {
    if raw.len() > 128 * 1024 || raw.contains('\0') {
        return Err("The environment file is invalid or exceeds 128 KiB.".into());
    }
    let mut result = BTreeMap::new();
    let mut names = std::collections::BTreeSet::new();
    for (index, line) in raw.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (name, value) = line.split_once('=').ok_or_else(|| {
            format!(
                "Environment line {} needs literal KEY=value syntax. No changes were imported.",
                index + 1
            )
        })?;
        let name = name.trim();
        run_config::validate_env_name(name)?;
        if !names.insert(name.to_ascii_uppercase()) {
            return Err(format!(
                "Environment line {} duplicates a variable. No changes were imported.",
                index + 1
            ));
        }
        let value = value.trim();
        let value = if value.starts_with('"') || value.starts_with('\'') {
            if value.len() < 2 || value.as_bytes().first() != value.as_bytes().last() {
                return Err(format!(
                    "Environment line {} has unmatched quotes. No changes were imported.",
                    index + 1
                ));
            }
            &value[1..value.len() - 1]
        } else {
            value
        };
        if value.len() > 32768 || result.len() >= 128 {
            return Err(
                "The environment file exceeds supported variable limits. No changes were imported."
                    .into(),
            );
        }
        result.insert(name.into(), Some(value.into()));
    }
    Ok(result)
}
#[tauri::command]
pub(crate) fn execution_import_env(
    window: WebviewWindow,
    policy: State<'_, ExecutionPolicy>,
    active_repo: State<'_, ActiveRepoBoundary>,
    context: ExecutionContext,
    config_id: String,
    relative_path: String,
) -> Result<Vec<String>, String> {
    let _work = crate::maintenance::work()?;
    let root = policy.validate_owner(window.label(), &context)?;
    active_repo.command_repo_root(&context.repo_path)?;
    policy.with_admission(window.label(), &context, || Ok(()))?;
    let values = read_private_env(&root, &relative_path)?;
    let names = values.keys().cloned().collect();
    // Trust/revision rechecked after I/O. Only this explicit import action replaces keys.
    active_repo.command_repo_root(&context.repo_path)?;
    policy.set_secrets(window.label(), &context, &config_id, values)?;
    Ok(names)
}

fn read_private_env(
    root: &std::path::Path,
    relative_path: &str,
) -> Result<BTreeMap<String, Option<String>>, String> {
    use crate::repo_boundary::ensure_canonical_path_inside_repo;
    use std::path::{Component, Path};
    let relative = Path::new(relative_path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("Select a repository-relative environment file inside this workspace.".into());
    }
    let path = root
        .join(relative)
        .canonicalize()
        .map_err(|_| "The selected environment file is unavailable.")?;
    ensure_canonical_path_inside_repo(&path, root, "Environment file")?;
    let metadata = std::fs::metadata(&path)
        .map_err(|_| "The selected environment file cannot be inspected.")?;
    if !metadata.is_file() || metadata.len() > 128 * 1024 {
        return Err("Select an environment text file no larger than 128 KiB.".into());
    }
    use std::io::Read;
    let mut raw = String::new();
    std::fs::File::open(path)
        .map_err(|_| "The selected environment file cannot be opened.")?
        .take(128 * 1024 + 1)
        .read_to_string(&mut raw)
        .map_err(|_| "The selected environment file is not readable UTF-8 text.")?;
    parse_private_env(&raw)
}

#[cfg(test)]
#[path = "execution_admission_tests.rs"]
mod admission_tests;
