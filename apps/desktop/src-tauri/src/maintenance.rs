//! Shared admission contract for update installation and owned work (#85/#130).
//! New process/mutation owners must hold a Work guard for their entire lifetime.
use std::sync::{Arc, Mutex, OnceLock};

#[derive(Default)]
struct State {
    active: usize,
    installing: bool,
}
#[derive(Clone, Default)]
pub(crate) struct Gate(Arc<Mutex<State>>);
pub(crate) struct Work(Gate);
#[cfg(test)]
pub(crate) struct Installation(Gate);
static GATE: OnceLock<Gate> = OnceLock::new();
pub(crate) fn work() -> Result<Work, String> {
    GATE.get_or_init(Gate::default).work()
}
impl Gate {
    pub(crate) fn work(&self) -> Result<Work, String> {
        let mut state = self.0.lock().map_err(|_| "Work admission unavailable.")?;
        if state.installing {
            return Err("HELM is preparing an update. Defer it before starting work.".into());
        }
        state.active += 1;
        Ok(Work(self.clone()))
    }
    #[cfg(test)]
    pub(crate) fn install(&self) -> Result<Installation, String> {
        let mut state = self.0.lock().map_err(|_| "Work admission unavailable.")?;
        if state.installing || state.active != 0 {
            return Err(
                "An owned operation is active. Wait for it to finish, then retry the update."
                    .into(),
            );
        }
        state.installing = true;
        Ok(Installation(self.clone()))
    }
}
impl Drop for Work {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0 .0.lock() {
            state.active -= 1;
        }
    }
}
#[cfg(test)]
impl Drop for Installation {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0 .0.lock() {
            state.installing = false;
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn excludes_active_and_new_work_and_reopens_after_failure() {
        let gate = Gate::default();
        let work = gate.work().unwrap();
        assert!(gate.install().is_err());
        drop(work);
        let install = gate.install().unwrap();
        assert!(gate.work().is_err());
        assert!(gate.install().is_err());
        drop(install);
        assert!(gate.work().is_ok());
    }
}
