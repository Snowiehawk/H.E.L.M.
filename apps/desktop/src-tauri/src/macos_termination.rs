//! AppKit Dock/logout termination admission. Tao's applicationWillTerminate:
//! notification is too late to stop an exit or await owned-process cleanup.
//! Keep its delegate and lifecycle intact, adding only the optional admission
//! method. Never signal guessed PIDs or treat an Exit notification as cleanup.
use crate::execution_policy::ExecutionPolicy;
use crate::execution_supervisor::ExecutionSupervisor;
use dispatch2::DispatchQueue;
use objc2::runtime::{AnyObject, Bool, ClassBuilder, Sel};
use objc2::{class, msg_send, sel, MainThreadMarker};
use std::cell::RefCell;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};

// NSApplicationTerminateReply (NSUInteger), not BOOL.
const CANCEL: usize = 0;
const NOW: usize = 1;
const LATER: usize = 2;

#[derive(Debug, PartialEq)]
enum Admission {
    Cancel,
    Now,
    Pending,
    Start(u64),
}

#[derive(Default)]
struct Gate {
    next: u64,
    pending: Option<u64>,
    invalidated: bool,
}

impl Gate {
    fn request(&mut self, sealed: bool) -> Admission {
        if self.invalidated {
            return Admission::Cancel;
        }
        if self.pending.is_some() {
            return Admission::Pending;
        }
        if sealed {
            return Admission::Now;
        }
        let Some(ticket) = self.next.checked_add(1) else {
            return Admission::Cancel;
        };
        self.next = ticket;
        self.pending = Some(ticket);
        Admission::Start(ticket)
    }

    // Returns at most one reply per admitted request. A successful worker alone
    // is insufficient: execution admission must also have been sealed.
    fn complete(&mut self, ticket: u64, cleaned: bool, sealed: bool) -> Option<bool> {
        if self.invalidated || self.pending != Some(ticket) {
            return None;
        }
        self.pending = None;
        Some(cleaned && sealed)
    }

    fn invalidate(&mut self) {
        self.invalidated = true;
        self.pending = None;
    }
}

struct Registration {
    app: AppHandle,
    application: usize,
    delegate: usize,
    gate: Arc<Mutex<Gate>>,
}

thread_local! {
    // Main thread only. Cleared on RunEvent::Exit so a static AppHandle cannot
    // retain the application's managed backend state after termination.
    static REGISTRATION: RefCell<Option<Registration>> = const { RefCell::new(None) };
}

pub(crate) fn install(app: &AppHandle) -> Result<(), std::io::Error> {
    let error = |message| std::io::Error::other(message);
    let _main = MainThreadMarker::new()
        .ok_or_else(|| error("Termination hook requires the main thread."))?;
    if REGISTRATION.with(|slot| slot.borrow().is_some()) {
        return Err(error("Termination hook is already installed."));
    }
    // SAFETY: Called during main-thread setup. NSApplication's shared instance
    // and its currently retained Tao delegate are live for this event loop.
    let application: *mut AnyObject =
        unsafe { msg_send![class!(NSApplication), sharedApplication] };
    let delegate: *mut AnyObject = unsafe { msg_send![application, delegate] };
    let delegate_object = unsafe { delegate.as_ref() }.ok_or_else(|| {
        error("Application delegate is unavailable; termination hook was not installed.")
    })?;
    let superclass = delegate_object.class();
    if superclass.name() != c"TaoAppDelegateParent"
        || superclass
            .instance_method(sel!(applicationShouldTerminate:))
            .is_some()
    {
        return Err(error(
            "Application delegate changed; review the termination hook before running this build.",
        ));
    }
    let mut builder = ClassBuilder::new(c"HELMTerminationDelegate", superclass)
        .ok_or_else(|| error("Termination delegate class is already registered."))?;
    // SAFETY: AppKit declares this optional method as an NSUInteger return with
    // one NSApplication* parameter. No ivars or existing methods are changed.
    unsafe {
        builder.add_method(
            sel!(applicationShouldTerminate:),
            should_terminate as extern "C" fn(_, _, _) -> _,
        );
    }
    let subclass = builder.register();
    if subclass.instance_size() != superclass.instance_size() {
        return Err(error(
            "Termination delegate layout changed; refusing to install.",
        ));
    }
    // SAFETY: This is a subclass of the exact owned delegate, with identical
    // instance size and no overridden methods/ivars. Tao retains and deallocates
    // the original object normally; no other thread mutates its class.
    let previous = unsafe { AnyObject::set_class(delegate_object, subclass) };
    assert_eq!(
        previous, superclass,
        "Application delegate changed during setup"
    );
    REGISTRATION.with(|slot| {
        *slot.borrow_mut() = Some(Registration {
            app: app.clone(),
            application: application as usize,
            delegate: delegate as usize,
            gate: Arc::new(Mutex::new(Gate::default())),
        });
    });
    Ok(())
}

pub(crate) fn clear() {
    REGISTRATION.with(|slot| {
        let registration = slot.borrow_mut().take();
        if let Some(registration) = registration {
            if let Ok(mut gate) = registration.gate.lock() {
                gate.invalidate();
            }
        }
    });
}

extern "C" fn should_terminate(receiver: &AnyObject, _: Sel, sender: *mut AnyObject) -> usize {
    // Neither an AppKit callback nor a GCD callback may unwind through C.
    catch_unwind(AssertUnwindSafe(|| request(receiver, sender))).unwrap_or(CANCEL)
}

fn request(receiver: &AnyObject, sender: *mut AnyObject) -> usize {
    if MainThreadMarker::new().is_none() {
        return CANCEL;
    }
    let registration = REGISTRATION.with(|slot| {
        let slot = slot.borrow();
        let registration = slot.as_ref()?;
        if registration.application != sender as usize
            || registration.delegate != receiver as *const AnyObject as usize
        {
            return None;
        }
        Some((registration.app.clone(), registration.gate.clone()))
    });
    let Some((app, gate)) = registration else {
        return CANCEL;
    };
    let admission = match gate.lock() {
        Ok(mut gate) => gate.request(app.state::<ExecutionPolicy>().is_closing()),
        Err(_) => return CANCEL,
    };
    let ticket = match admission {
        Admission::Cancel => return CANCEL,
        Admission::Now => return NOW,
        Admission::Pending => return LATER,
        Admission::Start(ticket) => ticket,
    };
    let worker_app = app.clone();
    let worker_gate = gate.clone();
    let spawn = std::thread::Builder::new()
        .name("helm-termination".into())
        .spawn(move || {
            let cleanup = catch_unwind(AssertUnwindSafe(|| checked_cleanup(&worker_app)))
                .unwrap_or_else(|_| {
                    Err("Application cleanup panicked; termination was refused.".into())
                });
            if let Err(message) = &cleanup {
                let _ = worker_app.emit("helm://execution-cleanup-error", message);
            }
            let cleaned = cleanup.is_ok();
            // Do not use Tauri run_on_main_thread here. Its callback runs while Tao
            // borrows its handler; Cocoa's YES reply can synchronously reenter Exit.
            // GCD runs after the current AppKit/Tao callback has unwound.
            let queued = catch_unwind(AssertUnwindSafe(|| {
                DispatchQueue::main().exec_async(move || {
                    let result =
                        catch_unwind(AssertUnwindSafe(|| reply(&worker_gate, ticket, cleaned)));
                    if result.is_err() {
                        report_delivery_failure();
                    }
                });
            }));
            if queued.is_err() {
                let _ = worker_app.emit(
                    "helm://execution-cleanup-error",
                    "Termination reply could not be queued; exit remains pending.",
                );
            }
        });
    if spawn.is_err() {
        // Cocoa has not received LATER yet. Cancel synchronously, without a
        // replyToApplicationShouldTerminate call for a nonexistent worker.
        if let Ok(mut gate) = gate.lock() {
            gate.complete(ticket, false, false);
        }
        let _ = app.emit(
            "helm://execution-cleanup-error",
            "Cleanup worker could not start; termination was refused.",
        );
        return CANCEL;
    }
    LATER
}

fn checked_cleanup(app: &AppHandle) -> Result<(), String> {
    let policy = app.state::<ExecutionPolicy>();
    cleanup_then_seal(&policy, || {
        app.state::<ExecutionSupervisor>().shutdown_all()
    })
}

fn cleanup_then_seal(
    policy: &ExecutionPolicy,
    shutdown: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let transition = policy.begin_transition()?;
    shutdown()?;
    transition.seal();
    Ok(())
}

fn reply(gate: &Arc<Mutex<Gate>>, ticket: u64, cleaned: bool) {
    let reply = REGISTRATION.with(|slot| {
        let slot = slot.borrow();
        let registration = slot.as_ref()?;
        if !Arc::ptr_eq(&registration.gate, gate) {
            return None;
        }
        // SAFETY: The registered NSApplication is the singleton. Query its live
        // delegate before comparing addresses; never dereference a saved delegate.
        let application = registration.application as *mut AnyObject;
        let current: *mut AnyObject = unsafe { msg_send![application, delegate] };
        if current as usize != registration.delegate {
            return None;
        }
        let allow = gate.lock().ok()?.complete(
            ticket,
            cleaned,
            registration.app.state::<ExecutionPolicy>().is_closing(),
        )?;
        Some((application, allow))
    });
    if let Some((application, allow)) = reply {
        // No RefCell borrow or mutex guard may span this call: YES can invoke
        // applicationWillTerminate synchronously and clear our registration.
        // SAFETY: Live owned singleton, main GCD queue, BOOL matches AppKit.
        unsafe {
            let _: () = msg_send![application, replyToApplicationShouldTerminate: Bool::new(allow)];
        }
    }
}

fn report_delivery_failure() {
    // Avoid unwinding even if a reporter fails. Never substitute an unchecked
    // app.exit or Cocoa YES for a failed delivery.
    let _ = catch_unwind(AssertUnwindSafe(|| {
        REGISTRATION.with(|slot| {
            if let Some(registration) = slot.borrow().as_ref() {
                let _ = registration.app.emit(
                    "helm://execution-cleanup-error",
                    "Termination reply failed; exit remains pending.",
                );
            }
        })
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn start(gate: &mut Gate) -> u64 {
        match gate.request(false) {
            Admission::Start(ticket) => ticket,
            other => panic!("expected a cleanup worker, got {other:?}"),
        }
    }

    #[test]
    fn termination_is_deferred_and_repeated_requests_coalesce() {
        let mut gate = Gate::default();
        let ticket = start(&mut gate);
        assert_eq!(gate.request(false), Admission::Pending);
        assert_eq!(gate.request(true), Admission::Pending);
        assert_eq!(gate.complete(ticket, true, true), Some(true));
        assert_eq!(gate.complete(ticket, true, true), None);
        assert_eq!(gate.request(true), Admission::Now);
    }

    #[test]
    fn cleanup_error_refuses_exit_and_allows_a_fresh_retry() {
        let mut gate = Gate::default();
        let old = start(&mut gate);
        assert_eq!(gate.complete(old, false, false), Some(false));
        let new = start(&mut gate);
        assert_ne!(old, new);
        assert_eq!(gate.complete(old, true, true), None);
        assert_eq!(gate.complete(new, true, true), Some(true));
    }

    #[test]
    fn neither_success_without_sealing_nor_sealing_without_cleanup_allows_exit() {
        for (cleaned, sealed) in [(true, false), (false, true), (false, false)] {
            let mut gate = Gate::default();
            let ticket = start(&mut gate);
            assert_eq!(gate.complete(ticket, cleaned, sealed), Some(false));
        }
    }

    #[test]
    fn failed_worker_start_cancels_ticket_without_authorizing_exit() {
        let mut gate = Gate::default();
        let ticket = start(&mut gate);
        assert_eq!(gate.complete(ticket, false, false), Some(false));
        assert!(matches!(gate.request(false), Admission::Start(_)));
        assert_eq!(gate.complete(ticket, true, true), None);
    }

    #[test]
    fn undelivered_reply_stays_pending_and_never_authorizes_exit() {
        let mut gate = Gate::default();
        start(&mut gate);
        assert_eq!(gate.request(true), Admission::Pending);
        assert!(gate.pending.is_some());
    }

    #[test]
    fn exit_invalidates_registration_and_late_worker_completion() {
        let mut gate = Gate::default();
        let ticket = start(&mut gate);
        gate.invalidate();
        assert_eq!(gate.complete(ticket, true, true), None);
        assert_eq!(gate.request(true), Admission::Cancel);
        assert_eq!(gate.request(false), Admission::Cancel);
    }

    #[test]
    fn successful_cleanup_closes_admission_before_native_reply() {
        let policy = ExecutionPolicy::default();
        cleanup_then_seal(&policy, || {
            assert!(!policy.is_closing());
            assert!(policy.begin_transition().is_err());
            Ok(())
        })
        .unwrap();
        assert!(policy.is_closing());
        assert!(policy.begin_transition().is_err());
    }

    #[test]
    fn unconfirmed_cleanup_cannot_seal_and_a_retry_can_reacquire_admission() {
        let policy = ExecutionPolicy::default();
        assert_eq!(
            cleanup_then_seal(&policy, || Err("owned cleanup unconfirmed".into())),
            Err("owned cleanup unconfirmed".into())
        );
        assert!(!policy.is_closing());
        assert!(policy.begin_transition().is_ok());
    }

    #[test]
    fn cleanup_panic_releases_unsealed_transition() {
        let policy = ExecutionPolicy::default();
        assert!(
            catch_unwind(AssertUnwindSafe(|| cleanup_then_seal(&policy, || panic!(
                "injected cleanup failure"
            ))))
            .is_err()
        );
        assert!(!policy.is_closing());
        assert!(policy.begin_transition().is_ok());
    }

    #[test]
    fn existing_transition_refuses_termination_without_starting_duplicate_cleanup() {
        let policy = ExecutionPolicy::default();
        let _transition = policy.begin_transition().unwrap();
        assert!(cleanup_then_seal(&policy, || panic!("duplicate shutdown must not run")).is_err());
        assert!(!policy.is_closing());
    }
}
