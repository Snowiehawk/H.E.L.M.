# Follow-up source audit, 2026-10-17

Historical revision record. The later [validated candidate record](validated-candidate-20261018.md)
supersedes the pending native gates below; earlier artifact hashes and test runs
keep their original scope.

This private source revision follows the preserved standalone candidate. The Mac
app archive with SHA-256 `91545a625490d27b3a6c7cb6be0e836cfb9668ccc63502011d2c58cfef45b094`
is preserved unchanged and does **not** include these later source repairs.
Earlier native passes remain tied to [their accepted builds](native-acceptance-20261017.md).
No merge, publication, security exception or Python baseline migration was made.

## Repairs

- A selected repository now owns its asynchronous scan and cache updates. Late
  scans, progress, watcher events and mutation results from the previous session
  cannot replace the new workspace. Opening a repository clears the old cache;
  job IDs remain distinct within the same millisecond. Completion publishes only
  after the scan cache is ready. Eight focused regressions failed before repair.
- A valid worker rejection (for example, an invalid draft expression) returns an
  error while retaining the healthy process and its workspace/Undo session.
  Transport/protocol failures still invalidate the process. The existing rule
  against automatic mutation replay remains intact. A two-request process fixture
  verifies the same worker survives the rejection.
- The clean Rust quality task stages backend resources before compiling. A clean
  copy previously failed because `packaged-backend` did not exist. Running the
  real staging hook followed by locked Cargo checks now passes.

## Verification

The focused revision passes 196 frontend tests (adapter, editor/workspace, graph,
and all issue-viewer tests), 29 Rust tests, strict Clippy, locked Cargo check,
TypeScript, the production frontend build, changed-file ESLint and Rust formatting. Python 3.9 passes 13 existing
packaging/task tests. These focused checks supplement the preserved earlier full
suite; the earlier suite was not relabeled as a run of this revision.

Issue-session inspection and the existing tests cover invalidating late imports,
abort on clear/unmount, clearing in-memory credentials, disabling refresh after
Disconnect, and preserving the previous snapshot on refresh failure. No real
credential was used or captured. No additional issue-session code change was
justified by that review.

Setup/build docs now state Node 20+, resource staging before Rust compilation,
the actual editing/recovery boundaries, and the distinction between historical
native acceptance and newer standalone packaging. See the
[dependency disposition](candidate-dependency-disposition-20261017.md) for the
remaining four Rust warnings and 15 Python development advisory records.

## Follow-up Mac artifact

A separate Mac arm64 app now includes these source repairs. Its executable SHA-256
is `b67bc955467fda39d63658d90b352774fd44e6228145a70a1980db20c5f2fd37`.
Strict ad-hoc signature verification passes. All 1,564 runtime resources and 20
component notices verify after relocation to a path containing Unicode and spaces.
Bundled Python 3.13.16, LibCST and PyYAML load inside the app; health, scan and
byte-exact CRLF Save/Undo/Redo pass, and the fixture is restored. These are packaged
backend protocol checks, separate from native GUI acceptance.

## Remaining native gate

The Mac requires manual unlock. The first-party native inventory reports that
automatic unlock could not unlock it. Chrome extension inventory works, while
reads of the existing CRD tab report `Debugger unattached`. No disabled control
settings were changed or bypassed, and no browser/native restart was attempted.
The earlier Windows source upload is uncertain; inspect the laptop upload hash,
build process and outputs before starting another build.

The follow-up Mac app and preserved earlier standalone Mac app are separate
artifacts. A fresh Windows build from the new frozen source is still required.
Once controls work, verify the exact app identity, then finish native pin
persistence, invalid-draft/worker continuity,
repository switch, Save/Undo/Redo and session-clearing checks on Mac, the laptop
and VM118. Preserve all user files/apps/tabs and all protected VMs.
