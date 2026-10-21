# Project execution implementation

> Historical implementation record for the original combined candidate. For the
> current extraction onto published dev, its narrower scope, exact-target checks
> and publication/native gates, use [the foundation review](execution-foundation-review.md).
> References below to shared-project and installation consumers do not imply
> those feature integrations are included in this extracted branch.

## Base and scope

Issue #85 implementation branch `noah/issue-85-terminal-run` starts from the
explicit unpublished prerequisite candidate `02caee52515d0510133a03fba6ae035cedf41777`.
A fresh remote fetch on 2026-10-20 verifies published `dev` remains
`49b8e5121da19e26dc72fd664b0c1f8e568a7101`, an ancestor. The prerequisite delta
includes packaging, recovery, project context and graph fixes. It is retained
without modifying the clean QA checkout, user installations or physical laptop.
Review the terminal/run delta against `02caee5`; integration into dev also needs
review of its explicitly inherited prerequisite changes. No push, merge or release
is implied by this branch.

## Architecture and defaults

Native execution is separate from the persistent Python analysis bridge. Every
execution context is bound to a native window, canonical workspace, renderer
generation and trust revision. Opening/restoring/indexing/manifest suggestions
remain passive. Trust and private environment values last for the session; trust
allows arbitrary user-level project code and is not sandboxing. Nonsecret named
configuration documents live in application data keyed by verified local checkout.

One interactive terminal and one configured run may be owned per workspace.
Direct executable/argv and explicit shell mode remain distinct. The environment
is constructed from an OS allowlist, then selected nonsecret and private overrides;
HELM backend controls and provider/IPC credentials are excluded. The bundled
analysis Python never becomes a project-runtime fallback.

Preparation saves supported editor drafts, refuses unresolved composer/flow or
mutations, validates persisted graph-source state, and freezes source hashes.
The native spawn boundary rechecks identity, trust and file hashes. Stop during
preparation invalidates its completion. Restart waits for confirmed prior cleanup
and prepares current source/configuration again.

A verified declaration save may return the backend's canonical outer whitespace
and LF text. Preparation accepts only the save's certified predecessor/successor
revision: the captured tuple changes that declaration's text alone, using the
authoritative refreshed target and source. It never adopts an arbitrary current
revision or normalizes every draft comparison. Concurrent edits, including a new
final newline, other drafts, cancellation and changed workspace ownership still
refuse Run. The resulting receipt remains exact through source capture and launch.
The shared explicit installation-save consumer uses the same revision proof and
retains its separate freeze/admission checks.

PTY bytes use a terminal renderer; configured-run logs have their own bounded
stream and diagnostic parser. Native polling bounds queued data and records
truncation; renderer writes complete before requesting more terminal data. Hiding
or changing tabs preserves sessions. Explicit close/revocation, project/branch
replacement and app exit clean owned work. Closing the main window exits the app
on every supported platform after owned cleanup, with the same policy as Quit;
no detached or headless session is retained. Unknown cleanup blocks replacement
or restart. Unix groups do not sandbox deliberate daemon escape; Windows
processes require Job ownership before resume, including ConPTY.

Navigation validates canonical workspace containment and current source hashes.
Exact graph selection requires matching source evidence; ambiguous/stale mappings
fall back visibly to a validated file. Browser activation is explicit and restricted
to http/https loopback; actual OSC8 destinations are checked. No embedded preview.

## Delivery order and evidence

1. #93/#94/#96 trust, configuration and private values.
2. #95 runtime resolution, then #98 process ownership and #99 PTY.
3. #101/#102 preparation and #97 configuration editor.
4. #100 sidebar, #103 controls and lifecycle integration.
5. #105/#106/#107 validated diagnostics, mapping and links.
6. #104 process fixtures, independent review, #108 packaged platform matrix.

Implementation, automated checks, native packaging and owner acceptance are
separate statuses. Windows laptop acceptance is coordinated with the parent later.
No calculator fixture substitutes for the owner's first-use journey. Theme #109,
Light #114, onboarding #86, updater and local-worker work remain separate. Terminal
styles consume semantic terminal tokens supplied by the theme task, with existing
surface/text tokens as fallback. No global theme machinery is changed here.

## Verification limits and process policy

Source admission verifies the current bounded file inventory and bytes immediately
before spawn; it does not freeze a live external filesystem after launch. Project
code and external editors can subsequently change files. Diagnostic navigation
rechecks source and refuses stale exact selection. Read/source admission bounds
are 5,000 regular files, 64 MiB total and 8 MiB per file, with a bounded directory
walk; dependency/build trees are excluded. Pending recovery or unsupported graph
state refuses launch without replaying edits.

Unix executions own a fresh session. Normal child/grandchild and shell foreground
job groups are cleaned with finite escalation and reaping. Deliberate `setsid`
daemon escape, external services and abrupt host termination/SIGKILL of HELM are
outside that guarantee. Secondary group ownership is revalidated immediately
before signals; POSIX lacks an atomic conditional session-wide kill primitive,
so hostile concurrent PID/group churn is not claimed as sandbox containment.
Windows uses suspended assignment to a kill-on-close Job, disallows ordinary
breakaway, and retains uncertain partial-spawn handles; external service/WMI
launches outside that Job are not an ownership guarantee. Native platform
acceptance must demonstrate ordinary tree/port cleanup and unrelated survival.

Direct native executable arguments use platform argv encoding. Windows batch
wrappers support literal spaces/Unicode but refuse arguments whose expansion or
forwarding cannot be represented safely (metacharacters, embedded quotes and
trailing-backslash wrapper arguments). Select the underlying native executable or
an explicitly reviewed system-shell command for those cases; settings remain
editable and are never executed on restore. A missing project runtime never
falls back to bundled HELM Python. Version probes are explicit trusted actions,
owned independently, timed out and excluded from project/private environment.

Private values exist only in native session memory. Explicit `.env` import reads
literal KEY=value data, never sources a shell or expands variables. Imported names
are returned for configuration; values are not returned or persisted. Arbitrary
project output can echo values the project receives; retained output stays in
bounded session memory with no input/transcript persistence by this feature.

## Run settings and private-value decisions

The v1 document contains `schemaVersion: 1`, a compare-and-save `revision`, an
explicit nullable `defaultId`, and configurations with stable IDs. Names may
repeat; IDs must be unique. There is no implicit default. Deleting the default
in the editor selects No default; native validation refuses a dangling default.
The three kinds (App, Tests, Build) share the same executable/argv or explicit
shell contract. Stored argv strings, including Windows paths/quotes/backslashes,
remain literal data; Windows wrapper execution has the separate restrictions
above. Native preparation owns a new argv/environment snapshot. Editing saved
settings cannot change an active process; Restart confirms cleanup and prepares
the newly saved configuration again.

Nonsecret settings use application data under `run-configs`, keyed by the
canonical local checkout path. The stored full path is checked even if filename
hashes collide. Two local copies therefore have separate records. Moving a
checkout does not automatically transfer its settings; reconfigure the new
verified path. This local storage choice provides no share/export or automatic
repo-file import. Documents are bounded to 64 configurations/256 KiB. Unknown
schema versions have no automatic migration: decoding, schema, stale-revision,
size and write failures preserve the original record for repair. Atomic replacement
is used only after validation. Missing/moved/outside cwd refuses launch with an
editable error; relative cwd is resolved against the current canonical checkout.
Cancel leaves the saved document unchanged.

Private values are keyed by native context and stable configuration ID, never by
GitHub identity. The base child environment uses the explicit OS allowlist in
`run_config.rs`; nonsecret overrides replace allowlisted keys and null removes a
key. Only selected private names are then added. Public/private names cannot
collide, including letter case. Missing required private values refuse launch;
there is no empty-credential fallback. Private updates merge named keys atomically,
replace previous case variants, distinguish empty strings from missing values,
and use null to remove a key. Clear sends null for the saved configuration's
private names. Other configurations and local copies do not receive those values.

Apply, Clear and Import are explicit immediate session actions. Cancel discards
unsubmitted configuration, private-input and import-path drafts; it does not undo
an already completed explicit session action. `.env` import merges keys only
after a complete valid parse and a fresh native consent check. Its bounded literal
dialect supports blank/comment lines and KEY=value with optional matching outer
quotes. It does not expand variables, execute substitutions, source files, accept
`export`, or accept duplicate case variants. Import errors contain line numbers
and generic reasons, never the values. Trust revocation clears buffered/session
values and invalidates late imports. During close/replacement, consent is revoked
and values cleared; a replacement context is published only after owned cleanup.
Unconfirmed cleanup retains the revoked old cleanup identity. No secret credential
backend is used, so locked/unavailable persistent secret storage is inapplicable;
there is no plaintext fallback. Settings/maintenance metadata and command previews
contain no private values. Project output can deliberately echo values it receives,
as described above; that is not a secret-redaction guarantee.

## Diagnostic matching decisions

The built-in v1 grammar recognizes Python `File "path", line N` traceback records
and common `path:line[:column]` records. Multiline tracebacks yield their individual
file records; identical records within the same stream are counted together.
Unsupported/malformed compiler output remains ordinary readable Run Output.
There is no custom matcher configuration in v1. Per-run diagnostic retention is
256 records by default, capped at 1,024; matching lines are bounded to 16,384
JavaScript code units. Oversized records are discarded whole, and truncation is
visible. Stdout/stderr have independent partial-line, ANSI and UTF-8 decoder state.
ANSI/OSC metadata is stripped only for matching; it does not become a command.
Final partial lines are processed when output completes, and final errors/exit
status remain available under the run's bounded output retention.

Coordinates are one-based Monaco UTF-16 positions, clamped against current UTF-8
file contents; Python parser byte spans are converted separately for graph mapping.
Navigation uses the captured run cwd/context and revalidates containment, ownership,
file hashes and current draft state. Current UTF-8 files are bounded to 8 MiB;
missing, binary, oversized, traversal, external and symlink-escape targets refuse
navigation visibly. Windows drive/UNC syntax can be matched as data everywhere,
but a foreign-platform path is not opened as a Unix relative filename. Actual
Windows normalization/runtime claims require Windows evidence. Stale run source
opens only the current validated file without an old-line highlight or graph
selection. Replaced/unmounted/canceled navigation cannot mutate the new workspace.

`execution-native.yml` adds Windows/macOS source-native checks without release
publication. The separate acceptance checklist and package verifier preserve
pending/failed cells; neither source tests nor a created receipt constitute an
installed GUI or owner-led dogfooding pass. Additional dependency license notices
are recorded in `third_party/execution/inventory.json` and frontend public notices.
