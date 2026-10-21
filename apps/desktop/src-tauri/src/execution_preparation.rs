//! Read-only source verification around the existing analysis worker.
use crate::bridge::BackendService;
use crate::execution_policy::{ExecutionContext, ExecutionPolicy};
use crate::repo_boundary::{normalize_path, ActiveRepoBoundary};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use tauri::{Manager, WebviewWindow};

static NEXT_PREPARATION: AtomicU64 = AtomicU64::new(1);

struct IssuedPreparation {
    window: String,
    context_id: String,
    repo_path: String,
    generation: String,
    trust_revision: u64,
    manifest: Value,
}

/// Keep one native-issued, single-use preparation per owning window. Renderer
/// supplied hashes alone cannot bypass persisted graph/source validation.
#[derive(Default)]
pub(crate) struct PreparationReceipts {
    receipts: Mutex<BTreeMap<String, IssuedPreparation>>,
}
impl PreparationReceipts {
    #[cfg(test)]
    pub(crate) fn issue_fixture(
        &self,
        window: &str,
        context: &ExecutionContext,
        manifest: Value,
    ) -> Result<Value, String> {
        self.issue(window, context, manifest)
    }

    fn issue(
        &self,
        window: &str,
        context: &ExecutionContext,
        mut manifest: Value,
    ) -> Result<Value, String> {
        let id = format!(
            "preparation-{}-{}",
            std::process::id(),
            NEXT_PREPARATION.fetch_add(1, Ordering::Relaxed)
        );
        manifest
            .as_object_mut()
            .ok_or("Invalid source preparation response.")?
            .insert("preparationId".into(), Value::String(id.clone()));
        let mut receipts = self
            .receipts
            .lock()
            .map_err(|_| "Source preparation unavailable.")?;
        receipts.retain(|_, receipt| receipt.window != window);
        receipts.insert(
            id,
            IssuedPreparation {
                window: window.into(),
                context_id: context.context_id.clone(),
                repo_path: context.repo_path.clone(),
                generation: context.generation.clone(),
                trust_revision: context.trust_revision,
                manifest: manifest.clone(),
            },
        );
        Ok(manifest)
    }
    pub(crate) fn consume(
        &self,
        window: &str,
        context: &ExecutionContext,
        id: &str,
    ) -> Result<Value, String> {
        let mut receipts = self
            .receipts
            .lock()
            .map_err(|_| "Source preparation unavailable.")?;
        let receipt = receipts.get(id).ok_or(
            "Prepare source again before Run. Its receipt is unavailable or already used.",
        )?;
        if receipt.window != window
            || receipt.context_id != context.context_id
            || receipt.repo_path != context.repo_path
            || receipt.generation != context.generation
            || receipt.trust_revision != context.trust_revision
        {
            return Err(
                "Source preparation belongs to a different workspace or consent revision.".into(),
            );
        }
        Ok(receipts
            .remove(id)
            .ok_or("Source preparation unavailable.")?
            .manifest)
    }
}

#[tauri::command]
pub(crate) async fn prepare_run_source(
    window: WebviewWindow,
    context: ExecutionContext,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _work = crate::maintenance::work()?;
        let app = window.app_handle();
        let policy = app.state::<ExecutionPolicy>();
        let active_repo = app.state::<ActiveRepoBoundary>();
        let service = app.state::<BackendService>();
        let receipts = app.state::<PreparationReceipts>();
        let root = active_repo.command_repo_root(&context.repo_path)?;
        policy.with_admission(window.label(), &context, || Ok(()))?;
        // Preparation is passive. Do not hold admission while reading files: a Stop
        // or consent revocation must remain available during a slow worker response.
        let manifest = service.request(
            "prepare-run-source",
            json!({ "repo": normalize_path(&root) }),
        )?;
        active_repo.command_repo_root(&context.repo_path)?;
        policy.with_admission(window.label(), &context, || {
            receipts.issue(window.label(), &context, manifest)
        })
    })
    .await
    .map_err(|_| "Source preparation worker failed. No project was launched.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context() -> ExecutionContext {
        ExecutionContext {
            context_id: "ctx".into(),
            repo_path: "/repo".into(),
            generation: "generation".into(),
            trust_revision: 2,
            trusted: true,
        }
    }
    #[test]
    fn receipts_are_owned_single_use_and_replaced_by_new_preparation() {
        let receipts = PreparationReceipts::default();
        let context = context();
        let first = receipts
            .issue("main", &context, json!({"files": []}))
            .unwrap();
        let first_id = first["preparationId"].as_str().unwrap();
        assert!(receipts.consume("other", &context, first_id).is_err());
        let mut revoked = context.clone();
        revoked.trust_revision += 1;
        assert!(receipts.consume("main", &revoked, first_id).is_err());
        let second = receipts
            .issue(
                "main",
                &context,
                json!({"files": [{"relativePath":"actual.py"}]}),
            )
            .unwrap();
        assert!(receipts.consume("main", &context, first_id).is_err());
        let second_id = second["preparationId"].as_str().unwrap();
        assert_eq!(
            receipts.consume("main", &context, second_id).unwrap(),
            second
        );
        assert!(receipts.consume("main", &context, second_id).is_err());
    }
}
