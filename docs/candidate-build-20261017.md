# Audited candidate checkpoint, 2026-10-17

This record identifies the preserved original candidate. Later asynchronous
session, worker-rejection and clean-build source repairs are recorded separately
in [the follow-up audit](followup-audit-20261017.md); original candidate binaries
do not gain those changes through a documentation update.

This isolated private QA candidate includes the native graph pin persistence and
mutation replay repairs, the scoped DOMPurify 3.4.16 patch, and standalone Mac
arm64 runtime packaging. It has not been merged or published.

The prior accepted Windows installer SHA-256 remains
`cbb130030a2651ae577fd7bb595115180452784ff245b18a1be442d305e8ac5e`.
Its successful native acceptance on Mac, the physical laptop, and offline VM118
is preserved separately in [the native acceptance record](native-acceptance-20261017.md).
Those earlier native passes do not certify this later candidate.

## Verified candidate checks

- 118 selected editor/workspace and graph tests pass in a serial run.
- Both saved DOMPurify exploit fixtures reproduce on 3.4.15 and pass on 3.4.16;
  the candidate npm lockfile audit reports zero findings.
- 27 Rust tests cover the existing pin/uncertain-mutation repairs plus installed
  Mac interpreter relocation, explicit legacy external-runtime compatibility,
  and fail-closed selection when the interpreter or manifest is missing/damaged.
  Strict Clippy and changed-file formatting checks pass.
- 11 Python 3.9 packaging tests cover verified inputs, archive traversal/link
  guards, target exclusivity, HTTPS redirect hosts, complete notice discovery,
  and corrupt vendored notice rejection. The development/CI baseline is unchanged.
- The pinned Mac CPython 3.13.16 runtime, LibCST and PyYAML load from relocated
  app resources with no external Python or development backend. Health, scan,
  exact CRLF Save/Undo/Redo and fixture restoration pass through the packaged
  backend protocol. All 1,564 resource hashes and 20 component notices verify.
- Private Mac app packaging seals its resources with an ad-hoc signature and
  requires `codesign --verify --deep --strict` to pass. This is not public
  signing/notarization or native application acceptance.
- The new isolated-Python `-I` flag also passes health/shutdown against VM118's
  existing accepted embedded interpreter. This is a launch-flag compatibility
  check, not a fresh Windows candidate installer result.

## Exact remaining work

The Mac is locked and the native control reports that manual unlock is needed.
Chrome extension inventory works, but DOM and screenshot reads on the existing
CRD tab report `Debugger unattached`. No security settings or browser settings
were changed. The earlier laptop source upload has an uncertain outcome; no
fresh Windows candidate build was launched by this task. Before another build,
inspect the dedicated laptop build process/output and uploaded file hashes.

Once normal controls are available, build the new source archive using the
included Windows script and isolated application identifier. Install into a
new QA directory on the laptop and VM118, preserving accepted artifacts. Verify
native startup uses only installed resources, then inspect a flow, pin a node
through its context menu, reload/restart, and verify the pin persists in
`.helm/graph-layouts.v1.json` as `pinnedNodeIds`. Exercise Save after a verified
candidate backend interruption, inspect retained draft/error behavior, and
verify the next explicit Save produces one edit, with exact Undo/Redo bytes.
The Rust fault test separately covers a mutation committed before a lost reply;
no native reproduction of that exact timing is claimed yet.

Mac native checks must bind the exact new candidate app path because multiple
private bundles share a product name. Inspect the native backend health/origin,
then perform the same pin persistence and mutation recovery checks. Keep the
four laptop displays and user apps/tabs intact. Do not access deleted VM116 or
modify protected VM110/117/118/408 infrastructure.

[Dependency disposition](candidate-dependency-disposition-20261017.md) records
the remaining four Cargo warnings and 15 Python development advisory records.
No warnings were suppressed and no Python baseline migration was applied.
