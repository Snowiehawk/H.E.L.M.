//! A native owner's admission outlives its IPC future and every uncertain exit.
use crate::maintenance::Work;
use std::sync::{Arc, Mutex};

pub(crate) struct ExecutionWork {
    token: Mutex<Option<Work>>,
}
impl ExecutionWork {
    pub(crate) fn new(token: Work) -> Arc<Self> {
        Arc::new(Self {
            token: Mutex::new(Some(token)),
        })
    }
    /// Called only after native ownership is proven clean, never by ordinary Drop.
    pub(crate) fn confirmed_cleanup(&self) {
        let mut token = self.token.lock().unwrap_or_else(|error| error.into_inner());
        drop(token.take());
    }
}
impl Drop for ExecutionWork {
    fn drop(&mut self) {
        // Last-owner unwinding is not cleanup evidence. Deliberately retain the
        // counted guard until process exit, even if quarantine storage is poisoned
        // or unavailable. This does not retain project/environment data.
        let token = self
            .token
            .get_mut()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(token) = token.take() {
            std::mem::forget(token);
        }
    }
}

#[derive(Debug)]
pub(crate) struct SpawnFailure {
    pub(crate) message: String,
    pub(crate) cleanup_unknown: bool,
}
impl SpawnFailure {
    pub(crate) fn clean(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            cleanup_unknown: false,
        }
    }
    pub(crate) fn unknown(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            cleanup_unknown: true,
        }
    }
}
// Only use implicit conversion before side effects or after checked teardown.
impl From<String> for SpawnFailure {
    fn from(message: String) -> Self {
        Self::clean(message)
    }
}
impl From<&str> for SpawnFailure {
    fn from(message: &str) -> Self {
        Self::clean(message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::maintenance::Gate;
    #[test]
    fn one_lease_excludes_install_until_explicit_cleanup_even_with_clones() {
        let gate = Gate::default();
        let owner = ExecutionWork::new(gate.work().unwrap());
        let worker = owner.clone();
        drop(owner); // models a canceled IPC future
        assert!(gate.install().is_err());
        worker.confirmed_cleanup();
        worker.confirmed_cleanup(); // exactly-once release
        let installation = gate.install().unwrap();
        assert!(gate.work().is_err());
        drop(installation);
        drop(worker);
        assert!(gate.install().is_ok());
    }
    #[test]
    fn unexpected_last_drop_and_unwind_fail_closed_on_isolated_gates() {
        let gate = Gate::default();
        let lease = ExecutionWork::new(gate.work().unwrap());
        let result = std::panic::catch_unwind(|| {
            let _owned = lease;
            panic!("injected owner panic");
        });
        assert!(result.is_err());
        assert!(gate.install().is_err());
        // This is an isolated Gate: no real/global admission reset is performed.
        assert!(Gate::default().install().is_ok());
    }
    #[test]
    fn poisoned_token_storage_still_releases_only_after_cleanup_proof() {
        let gate = Gate::default();
        let lease = ExecutionWork::new(gate.work().unwrap());
        let owned = lease.clone();
        let _ = std::panic::catch_unwind(move || {
            let _lock = owned.token.lock().unwrap();
            panic!("injected poisoned lease lock");
        });
        assert!(gate.install().is_err());
        lease.confirmed_cleanup();
        assert!(gate.install().is_ok());
    }
}
