# Execution foundation publication review

This is a review-only extraction from local accepted source `678d1d3c50b56e2d0c09ae057915a0ab62f63812` onto published `dev` `20636025441473601de73514548f98137f6119ee`. It is not a release or an instruction to replace an installed application. The frozen d1/678 source and QA artifacts remain unchanged. Required native acceptance is incomplete; do not merge the runtime foundation while that gate remains pending or failing.

## Inherited scope and dependencies

The complete inherited candidate differs from dev in 294 files and includes multiple separately owned features. This branch extracts execution and its source/ownership dependencies, instead of merging that tree wholesale.

| Layer                   | Included                                                                                                                                                         | Provenance / reason                                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Source ownership        | Declaration preimage/CAS through renderer, native glue and Python session; file-save lifecycle fences; authoritative reload and inspector preimages              | Accepted #101 / d1 preservation / c9aec52; required to save current source safely                                                     |
| Analysis preparation    | Frozen bounded Python inventory/parser, Unicode AST offsets, recovery preimage identity and clean-flow receipts                                                  | e4db239 and earlier accepted parser/recovery corrections; required #102 output                                                        |
| Passive Git helper      | Python project inspection/branch helper, worker dispatch and ownership-uncertain tagging with accepted passive fsmonitor/filter safeguards                       | Explicit inherited backend dependency from PR #84 / #66 and aa7fbb6; no native Git/clone handlers or shared-project UI are added here |
| Runtime execution       | Native trust/config/private values, tool resolution, Run/PTY supervision, source-proof admission, diagnostics/loopback navigation, output and command-core tests | #85 implementation and bounded follow-ups through 678                                                                                 |
| Lifecycle               | Generic mutation/Work ownership, durable backend ownership/quarantine, authoritative repository replacement and guarded Close/Quit                               | Required execution safety kernel; no updater installation or download consumer                                                        |
| Application integration | Sidebar, actions, preparation provider, editor/navigation and responsive layout                                                                                  | Execution-only integration into the published shell and existing graph/UI                                                             |
| Dependencies            | Required PTY/platform/runtime parsing/hash dependencies, xterm packages and test-only Node declarations/licenses                                                 | Added/pruned against the actual dev manifests; no wholesale accepted-candidate lock transplant                                        |

The existing shared-project PR #84 remains independent. Linking, copy selection, clone, branch UI and shared ProjectContext are not required just to mount the execution controller. Its later integration must connect the same neutral native repository epoch and native execution transition cleanup before exposing its handlers/UI. The Python helper is retained with all passive safeguards rather than restoring its earlier filter-running implementation.

## Deliberately separate feature work

This branch retains published dev behavior for themes/preferences/initialization, New Project/scaffold APIs, GraphCanvas/Issues interaction and application identity. It does not include:

- HELM/Light palette/default/persistence changes or theme fixtures;
- onboarding templates, preview/guidance/provenance expansion;
- Issues parity or shared graph interaction refactoring;
- updater state/UI/storage, HTTP/TLS/download/install/recovery/release/feed tools or signing configuration;
- updater-only package identity/build.rs/Tauri configuration, single-instance policy or startup update-health acknowledgment.

Generic mutation/freeze and Work accounting remain where actual execution/editor consumers use them. Their tests do not enable an updater. The existing production build identity/resources/capabilities are preserved; this review does not approve running a development bundle over the daily application. No new permissions, credentials or trust/network settings are introduced.

## Validation and review gates

The 741/154 source checks belong to 678, not automatically to this extracted target. Exact-target source tests, type/lint/format checks, dependency consistency and distinct native/frontend review must pass before a review PR is published. The extraction has changed integration surfaces and therefore needs new evidence. No source check can complete missing installed/WebView/Windows or owner acceptance.

The source contract remains session-scoped trust for arbitrary user-level code, not an OS sandbox. Owned cleanup must fail closed on uncertainty. No publication may claim native branches/projects or updater behavior that was left out of this target.

## Exact extracted-target evidence

The tests below ran on the extracted working-tree bytes above dev `2063602`, not on the full inherited 678 tree. The publication handoff binds those bytes to the subsequent commits; committing does not imply a new test execution.

| Check                                  | Actual result                                                        | Limits                                                                                                                     |
| -------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Complete frontend suite                | 568 tests / 68 files pass, all five opt-in real Python joins enabled | jsdom and subprocess source contracts, not native GUI                                                                      |
| Complete Python suite                  | 242 tests pass, 5 platform skips, 195 subtests                       | development Python 3.12; skipped platform cases remain unproved                                                            |
| Complete native suite                  | 124 tests pass, including four same-path scan replacement cases      | local macOS source tests; callbacks/state fixtures are not an installed IPC campaign                                       |
| Native strict Clippy                   | offline, locked, all targets, warnings denied: pass                  | local platform                                                                                                             |
| Frontend TypeScript / ESLint           | pass                                                                 | source checks                                                                                                              |
| Production web build                   | pass with Node 2 GiB heap; 42.648 s, minimum free memory 28%         | generated web assets only; no new Tauri application/package                                                                |
| Formatting, Ruff and dependency audit  | pass; no existing lock version/checksum changes                      | source consistency, not an additional online advisory scan                                                                 |
| Rendered wrapper allocation regression | before 46 failures; after 36 matrix cases + 10 live transitions pass | actual provider/shell/sidebar/window wrappers and CSS, synthetic analysis canvas; scale simulated by CSS viewport division |

The rendered regression caught an extraction-specific allocation failure: moving the execution wrapper outside the old flex shell left it without a definite height. Adding `height: 100%` gives it the actual scaled root height. The paired generated fixtures have identical JavaScript and differ only by that CSS declaration. A separate actual-shell test verifies that opening/hiding the sidebar retains the same child and unsaved draft. Neither result certifies full editor/inspector geometry, native zoom, PTY rendering or installed platform acceptance.

Same-checkout reindex is an ownership transition too. The native scan entry now invalidates execution consent/proofs and cleans owned work before replacement, while the renderer suspends watcher admission and adopts only the current successful scan epoch. These paths are covered on this extracted target. The published bridge's existing `HELM_PYTHON_BIN` and `HELM_WORKSPACE_ROOT` behavior is retained; release-specific override restrictions from the inherited updater stack were deliberately excluded.

The native compile tests used an inventoried pre-existing backend resource tree and frontend assets solely as compiler inputs. They did not produce a new source-matched QA application. Production web-build results, static checks, dependency inventories and distinct source-review bindings are recorded in the publication handoff. Existing npm lock entries and all baseline Cargo versions/checksums remain unchanged; additions are limited to execution dependencies.

## Later package handoff

A later package must name this exact reviewed source commit and dependency/runtime inputs. Its native replay should cover passive open, trusted Run/Terminal, private isolation, source-save/reload/Undo, invalid/recovered graph preparation, cancellation/replacement/revocation, responsive sidebar/inspector controls, diagnostics/loopback and exact owned-tree/PTY cleanup with unrelated-process survival. Shared-project branch cases require the separately reviewed #84 integration. Existing d1 and 678 receipts remain historical evidence and cannot be copied as passes for that new package.

Do not build another GUI artifact merely to publish this source review. Mac/Windows package updates and source-matched native acceptance are separately coordinated; no merge of the full runtime foundation occurs before required native gates pass.
