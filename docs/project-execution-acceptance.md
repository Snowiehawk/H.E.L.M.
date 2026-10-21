# Native project execution acceptance

> This is the historical native procedure. The current extracted source target
> and its validation limits are recorded in [the foundation review](execution-foundation-review.md).
> Start a fresh source-bound receipt for that target; do not transfer combined-candidate passes.

This is the reproducible #104/#108 acceptance procedure for issue #85. It does
not authorize publication, installation over an existing app, access to the
owner's Windows laptop, or completion of owner-led dogfooding. Use a disposable
fixture project and a distinct private QA application. Coordinate exclusive Mac
foreground use with the parent before UI/browser work. Keep security/network
settings and credentials unchanged. The owner's calculator is excluded.

## Evidence levels and current status

| Evidence                                        | macOS                              | Windows                                                         |
| ----------------------------------------------- | ---------------------------------- | --------------------------------------------------------------- |
| Source tests in `execution-native.yml`          | Workflow prepared; run pending     | Workflow prepared; run pending                                  |
| Windows API host typecheck / argv tests         | Supporting host-only check         | Does not establish Windows compilation or runtime               |
| Exact package build and runtime inventory       | Pending on implementation revision | Pending on implementation revision                              |
| Relocated installed interactive journey         | Pending                            | Pending on approved isolated machine                            |
| Independent residue / port audit after app exit | Pending                            | Pending                                                         |
| Owner's hands-on acceptance                     | Coordinated separately             | Coordinated with parent later; no laptop access authorized here |

A CI source test is not an installed GUI pass. Prior candidate `02caee5` packaging
or editor acceptance cannot accept this later terminal/run implementation. Record
exact source, dirty delta and package hash for each actual run; preserve failures
and pending cells. The workflow records runner OS/architecture/tool versions and
runs the same native modules on Windows and macOS with bounded Cargo concurrency.
It reuses `prepare-backend.mjs` and the SHA-verified backend packaging script.
Workflow execution requires a later authorized code push/dispatch. There is no
release, signing, auto-merge or deployment step.

## Prepare a source-bound private candidate

1. Record `git rev-parse HEAD` and `git status --porcelain` before building. Preserve
   unrelated work. Use the task branch and its explicit prerequisite base recorded
   in [implementation architecture](project-execution.md).
2. Install locked development/test dependencies in this isolated checkout. Run
   the focused frontend execution tests, Python preparation tests and Rust
   execution modules. Read failures rather than altering security exceptions.
3. Run `npm run prepare:backend` from `apps/desktop`. This stages the existing
   pinned backend/runtime; it does not make that Python a project interpreter.
   If inputs are supplied offline, use `HELM_RUNTIME_INPUTS_DIR` only on the build
   machine. Missing/corrupt inputs fail closed.
4. Build with the existing Tauri packaging path. Keep build log, source identity,
   build command and the exact resulting package together. A `.app` or installer
   alone does not prove which source was compiled. Use a distinct QA title,
   identifier and installation destination, preserving user's installed apps.
5. Verify the generated runtime without starting project code:

   ```sh
   python scripts/verify_execution_package.py runtime \
     apps/desktop/src-tauri/packaged-backend
   ```

6. Create the evidence receipt with all interactive cases initially pending:

   ```sh
   python scripts/verify_execution_package.py create \
     --repo /absolute/path/to/isolated/checkout \
     --package '/absolute/path/to/private QA.app' \
     --runtime-root '/absolute/path/to/private QA.app/Contents/Resources/helm-runtime' \
     --out /absolute/path/to/new-acceptance-receipt.json
   ```

   On Windows pass the exact installer/portable executable as `--package` and the
   installed `helm-runtime` directory as `--runtime-root`. These are read-only
   verification operations. Receipt creation is exclusive and refuses overwrite.
   No application launch, installation, tool probe or acceptance is automatic.

The verifier records `sourceSHA`, `sourceDirty`, a SHA-256 of the binary tracked
source delta plus untracked filenames/content hashes, package SHA-256, machine
OS/version/architecture, and runtime inventory. It does not record raw diffs,
private environment values or terminal transcripts. Directory package hashing
uses sorted relative paths/types/content hashes/link targets; links outside the
package fail verification. A runtime inventory pass proves declared bytes only.

## Installed journey and required observations

Run from a relocated path containing spaces and Unicode, with the development
checkout unavailable to the installed app, no `HELM_*` overrides, and a reduced
GUI PATH. Do not change system PATH or move the active source checkout; use an
isolated test image or a separate build-input copy. Record OS/WebView, selected
shell/tool versions, absolute executable provenance, backend process/module paths,
package/source hashes, timing, and before/after owned process/listener evidence.
Use only synthetic secrets.

| Case                                  | Required expected/observed evidence                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trust / no automatic execution        | Opening, restoring, indexing, config/manifest preview leaves project startup, `.env`, install and probe sentinels untouched. No shell starts. Explicit trust plus action admits one launch. Revocation cancels pending preparation and cleans owned sessions. Forged/stale context calls refuse.                                                                |
| Configs / runtime / private values    | App, Tests and Build add/edit/duplicate/delete/default survive restore; two checkouts stay distinct. Suggestions remain passive/editable. Explicit executable, cwd, Unicode/space arguments and supported `.cmd` wrappers reach intended runtime. Selected private values reach only that child and stay absent from settings/previews/other children.          |
| Runtime failures                      | Missing Python/Node/package manager/shell, wrong architecture, bad cwd, missing packaged helper and probe timeout give actionable errors. HELM's bundled backend still works without a project Python; no implicit fallback/install occurs. Explicit selected path recovers dependent launch.                                                                   |
| Preparation                           | Source/declaration/file drafts save current CRLF/Unicode bytes and source hashes. Invalid persisted flow, unresolved composer/expression, disk changes, concurrent edits, lost reply and failed save/generation create zero children and preserve drafts/recovery/Undo. Stop during preparation cannot launch later.                                            |
| Interactive terminal                  | Actual shell prompt, input, REPL and a locally available TUI work. Resize narrow/hidden/restored views, copy/paste, split Unicode and Ctrl-C. Hide/show and IDE/Issues switching preserve the same process/session. Explicit terminal close cleans it.                                                                                                          |
| Bounded output / focus                | Flood stdout/stderr and PTY output while typing and stopping. Record bounds/truncation and control responsiveness. Sidebar pointer/keyboard resize and tabs preserve minimum workspace usability/focus; terminal shortcuts do not mutate graph state. Record terminal contrast/accessibility without claiming theme #109/#114 acceptance.                       |
| Processes / ports                     | Child and grandchild own ephemeral loopback ports. Include TERM-resistant helper, leader exiting before helper, startup delay, fast exit, spawn failure and repeated Stop. After cleanup, independently bind the exact owned port. A separate unrelated listener/process survives. Never kill by process name or free a port by killing its occupant.           |
| Restart / transitions / app lifecycle | Rapid restart waits for confirmed prior cleanup and prepares new source/config. Project/branch replacement and window close/macOS Quit stop all owned terminal/run/probe work. Canceled/failed cleanup stays visible and blocks replacement/restart; no silent detached server. Independent reviewer checks residue after app exit.                             |
| Diagnostics / graph                   | Python traceback and file:line/column open canonical contained file/range. Spaces, Windows drive/UNC, ANSI/chunk splits and hostile paths remain safe. Matching source proof selects the supported unambiguous graph symbol; stale/ambiguous/generated-unmapped results are labeled and never select a guessed node. IDE/Issues domains remain separate.        |
| URLs                                  | Deliberate click/keyboard action opens the actual validated `localhost`, `127.0.0.1` or `[::1]` http/https destination in the system browser. OSC8 deceptive labels reveal real destination. Credentials, controls, non-loopback lookalikes and other protocols refuse. Selection/copy never opens a URL. No embedded preview or bind-address/security changes. |

Record actual executable and process identities, not inferred success from a shell
exit code or the absence of a UI spinner. Unix sessions cannot sandbox deliberate
`setsid` daemon escape. Windows ownership uses a non-breakaway Job Object before
resume; ConPTY alone is not cleanup proof. Supported Windows minimum is Windows
10 1809 because native ConPTY APIs are imported. Terminal stop sends scoped Ctrl-C;
piped runs have no universal safely scoped graceful console signal, so a 300 ms
grace period precedes job termination. Record these limits when interpreting tests.
Unknown partial-spawn or ConPTY teardown retains ownership evidence and blocks
retry/close; it is a failure/pending result, never a pass.

For independent port evidence, use the exact ephemeral port recorded by the
owned disposable fixture before launch. This helper only attempts a temporary
loopback bind, then closes its own socket; it never kills the occupant or guesses
its identity:

```sh
python scripts/verify_execution_package.py port 49152 --expect occupied
# After HELM reports confirmed owned cleanup:
python scripts/verify_execution_package.py port 49152 --expect available
```

Use a recorded fixture port instead of blindly using the example number. Run a
separate `--expect occupied` probe for the recorded unrelated listener, and pair
it with its process/start identity or challenge-response evidence. An occupied
port alone does not prove that the original unrelated process survived. The
helper is not a localhost service and makes no bind-address/security changes.

## Receipt schema and validation

`schemaVersion: 1` uses these top-level fields:

- `source`: source SHA, dirty flag/delta hash and checkout identity.
- `package`: exact artifact path/hash, file size or deterministic directory hash.
- `machine`, `launch`, `toolVersions`: actual installed environment observations.
- `runtimeInventory`: verified file manifest, separate from startup acceptance.
- `cases`: all required case IDs with `pending`, `blocked`, `fail` or `pass`, exact
  `expected`/`observed`, duration and artifact evidence IDs.
- `evidence`: `{ "id": "owned-port-rebind", "path": "/absolute/private/artifact.json", "sha256": "..." }`.
- `review`: independent reviewer, status and observed owned residue after exit.
- `ownerDogfooding`: separate attribution, initially pending; never inferred from
  automated fixture work.

Attach hash-bound build/source logs and process/port receipts alongside redacted
native screenshots where useful. Preserve failure artifacts. Do not commit raw
screenshots, builds, secrets or transcripts. A case marked pass must contain
expected/observed text and references to existing hash-matching artifacts.

```sh
python scripts/verify_execution_package.py validate /path/to/receipt.json
python scripts/verify_execution_package.py validate /path/to/receipt.json --require-pass
```

The first command verifies structure/package/artifact hashes and prints remaining
statuses. `--require-pass` additionally refuses any pending/blocked/failed native
case, missing installed launch facts, missing WebView evidence, unverified runtime
inventory or independent residue review. Neither command changes a case or closes
a GitHub issue. Human review still assesses whether supplied artifacts establish
actual behavior; JSON statements are not independent proof. Owner acceptance and
publication remain distinct parent-coordinated decisions.
