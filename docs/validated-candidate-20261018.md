# Validated desktop candidate and publication

This integration preserves the tested desktop fixes and the approved full-handles
logo as a reviewable working branch based on `dev`. It is not a merge to `dev`,
a promotion to `main`, or a signed public release. The independent shared-repository
design PR is outside this change.

## Source provenance

The eight existing issue-viewer commits after `dev` are preserved, ending at
`2b9eb5d1bb108d560f59a8751c475df2cd2bfe82`. The later, previously uncommitted
security/packaging/native fixes and branding are recorded in integration commit
`280492f`. Its complete 392-file tree matches the isolated approved logo source
commit `b3f545d6e102b7b842e06f818257f3b340f60079` byte for byte. That logo source
already includes the validated dirty fixes; checking out the old base alone would
omit them. Subsequent publication changes add workflow/evidence documentation and two
CI-pinned Ruff formatting corrections (one wrapped condition and one trailing
blank line). Their parsed Python syntax trees are unchanged; application behavior,
assets and lockfiles remain the validated snapshot.

Retained source archives, identified by SHA-256:

| Snapshot                                            | SHA-256                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| Functional follow-up, before the layout-only repair | `0bb634fe63547add1e15fda5f2111032068b4ac2a4ab2a59dde540766952988c` |
| Layout-repaired native candidate                    | `b73335b05883142f88cad5609753d37ac2913e5675cbbc5091b63e79c027c06b` |
| Full-handles source delivery                        | `f237e2af56b64c6f732cf5bcf1be0cea1c1e3b6c5a24608c9a94423bb05e8973` |

The original workspaces, histories, installers and candidates were preserved.
Generated build directories, private QA configurations, dependency caches and raw
native screenshots are not part of this integration.

## Resulting behavior

- The inspector keeps its editor identity during background fetches and keeps
  Save/Cancel reachable after an error, including with revealed source open.
- Save/Undo retains CRLF bytes. Repository switches invalidate late scan/cache
  updates. Pin state round-trips through native persistence, including legacy reads.
- A valid backend rejection retains the healthy worker. A broken transport may
  restart for known reads; mutations are never replayed automatically.
- Packaged Windows x64 and Mac arm64 apps use verified bundled Python/backend
  resources after installation and relocation, including paths with spaces/Unicode.
- The maintained SVG supplies complete, equally padded long handles for desktop
  icons. NSIS installer and uninstaller artwork references are explicit.
- Locked frontend dependencies include the reviewed security updates and scoped
  DOMPurify override. No security exception or Python baseline was widened.

## Verification of the publication checkout

The isolated checkout matched all 392 approved snapshot files before adding these
workflow documents. `npm ci` audited 318 packages with zero findings. Icon checks
passed all 21 desktop frames; TypeScript and the production Vite build passed.

The focused frontend run covered 198 tests: 194 passed initially, while four
workspace tests hit timing/lookup limits during a concurrent production build.
Those same four passed together in a subsequent isolated run (4 passed, 70 skipped).
Both raw runs are retained; this is not labeled a single all-green suite run.

Python 3.9 passed 47 selected tests and 25 subtests covering newline preservation,
bridge, packaging, tasks, audit parsing and desktop assets. Mac backend staging
verified 1,564 resources. Rust formatting and all 29 Rust tests passed.
Changed JavaScript/TypeScript/script ESLint checks passed. Strict Clippy with `-D warnings` also passed.

Earlier full suites and focused repairs retain their original revision/counts in
the historical records; they were not relabeled as reruns of this publication.

## Native evidence and its limits

Mac, the physical Windows laptop and disposable VM118 passed native checks of
the functional follow-up: installed/relocated bundled startup, scan, typing,
exact CRLF Save/Undo/Redo/restoration, repository separation, pin persistence,
worker failure with explicit retry, separate IDE/issues tabs and session clearing.
The layout-only repair received targeted native normal/revealed-source error-row
checks on all three. Mac also passed a valid Save and exact native Undo restoration.

Separate synthetic issue builds rendered 235 nodes and 1,130 links on all three
targets. Selection, Center/Fit, injected 503 retention, explicit refresh recovery
and Disconnect/Close clearing passed. No real GitHub credential/API acceptance is
claimed. The harness blocked non-GraphQL fetches; its two blocked bootstrap attempts
remained unchanged. Credential log/write/storage monitors stayed at zero.

The later full-handles build passed native Mac startup/Finder and Windows laptop
startup/Start/titlebar/taskbar checks, 404 Windows runtime hashes and 18 exact
Windows icon-resource comparisons. Its direct Mac Dock capture remains unverified;
the revised desktop shortcut target was verified but its shell rendering was not
separately viewed. The revised full-handles candidate was not rerun on VM118; earlier
shorter-handle VM results are not carried forward. Installer/uninstaller branding
was checked through native icon rendering, not an interactive uninstall. Mac
signing is ad hoc and candidate identities are private QA identities.

Retained owner-workspace receipts: `HELM-native-QA-complete-20261018.json` under
the native QA task's `followup-audit-20261017/native-resume`, and
`evidence/full-handles/publication-handoff.json` under the isolated logo task.
They index exact binary hashes, inputs, native observations and integrity records.

## Remaining independent gates

Python development/CI remains on 3.9; a 3.12 migration needs its separate owner
decision. The saved audit retains four Cargo informational warnings and 15 Python
development advisory records. The later npm audit is zero; an earlier two-low
snapshot is historical. No whole-interpreter/OS security certification is implied
by the runtime package audit. The previously incomplete Windows dependency
feature-tree inspection is not represented as completed by native GUI checks.

The normal GitHub CI/audit results must be read separately from these focused
checks. Publishing this branch does not clear a known dependency gate or grant
merge/release approval. Installed QA applications remain separate from a laptop
Git checkout; fetching or switching branches does not rebuild or replace them.

## CI formatting follow-up

The first GitHub Python job stopped at Ruff formatting in `graph_projection.py`
and `python_adapter.py`. Running the committed Ruff 0.15.12 wrapped one condition
and removed one trailing blank line. Python 3.9 parsed syntax trees before and
after are identical. Full Ruff lint and formatting now pass (67 files). No
dependency lock, Python baseline, audit exception or application behavior changed.
