# Native acceptance, 2026-10-17

This record supersedes older verification gaps and dependency counts in the
chronological issue-viewer notes. It describes private local QA, not a release,
merge, or publication approval. No real credential or private issue payload is
included here.

## Verified builds

- Final packaging source archive SHA-256:
  `9604db44071211d43b48cae07d67282cddce2ae0836fac58c5c78ba397cdc696`.
- Repaired Windows installer SHA-256:
  `cbb130030a2651ae577fd7bb595115180452784ff245b18a1be442d305e8ac5e`.
- Installed Windows executable SHA-256:
  `ff6e1ef7983132f01f28aac5e52079200e97e14f5b1f7e912387fb1c56347126`.
- Mac production-entry QA executable SHA-256:
  `a80dbba8581ba07eb1999003bfa33464ea041e9c5f77e25b24fcdbb96a0d347b`.

## Native coverage

| Check                                                  | Mac production-entry bundle               | Fresh offline Windows VM                             | Physical Windows laptop                                        |
| ------------------------------------------------------ | ----------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------- |
| Native installed application startup and backend ready | Passed with the external Python contract  | Passed, relocated path containing Unicode and spaces | Passed, repaired installer exit 0 and executable hash verified |
| Native folder selection and scan                       | Passed                                    | Passed                                               | Passed                                                         |
| Source typing and Save                                 | Passed                                    | Passed, 19 uninterrupted characters                  | Passed                                                         |
| Save, Undo, Redo preserve exact CRLF bytes             | Passed                                    | Passed                                               | Passed                                                         |
| Disposable source restored exactly                     | Passed                                    | Passed                                               | Passed                                                         |
| Separate IDE/issue tabs preserve workspace             | Passed                                    | Passed                                               | Passed                                                         |
| Synthetic token input cleared on Close/reopen          | Passed                                    | Passed                                               | Passed                                                         |
| Synthetic token input cleared on Disconnect            | Passed in synthetic native graph build    | Passed in synthetic native graph build               | Passed                                                         |
| Dense graph and failed-refresh recovery                | Passed in separate native synthetic build | Passed in separate native synthetic build            | Passed in separate native synthetic build                      |

The Windows VM launched the relocated app without a development checkout, global
Python, network, or runtime overrides. Its earlier installed-resource acceptance
verified 404 resources, module origin, health, scan and CRLF mutation round-trips.
The physical laptop launched the repaired install from its own install directory
with Python/workspace overrides cleared and the process PATH limited to Windows.
No supplemental runtime was supplied to this run. Earlier Windows GUI results
that used a supplemental runtime remain a separate scenario.

A disposable fixture first placed on the VM's Public Desktop inherited read and
delete access without write access for the QA user. Native Save correctly failed
with a sanitized error. Copying the fixture into that user's existing Documents
folder resolved the fixture problem without ACL changes. Save/Undo/Redo then
passed with exact-byte checks.

Remote keyboard modifier transport was unreliable. Explicit remote modifier keys
and the Windows on-screen keyboard produced the intended shortcuts. Ctrl+Shift+Z
is the current app-wide Redo shortcut; Ctrl+Y was not treated as a supported
shortcut in this acceptance run.

## Synthetic native graph acceptance

Separate QA apps built from the same final source used a synthetic-only fetch
fixture. These graph apps are distinct from the production-entry builds above. The Mac executable SHA-256 was
`86a02ddc8982d3f590fdcd93a1e3890896171f3e8f437cad56e0212500e29411`.
Native canvases on Mac, the physical Windows laptop, and offline VM118 each
rendered 235 issues and 1,130 blocker links. Fit contained all
nodes; zoom, selection/details and Center selected worked. A synthetic HTTP 503
refresh retained the previous graph; the next refresh recovered. IDE round-trips
preserved the issue graph. Disconnect and Close/reopen cleared active graph state,
cleared the submitted synthetic field, and disabled Refresh.

One observed request-to-render interval was 1,766 ms with artificial fixture
latency. It is not a controlled performance benchmark. This synthetic test does
not establish real-dataset readability or live authenticated GitHub acceptance.
Two non-GraphQL fetch attempts were intercepted and rejected; no claim of zero
unexpected attempts is made. The fixture's secret counters watched its predefined
sentinel, while the UI clearing check submitted a different synthetic string, so
those counters alone do not prove that the submitted string was never stored.

The Windows synthetic executable SHA-256 was
`dfa65cef9d1e22d3c364447db31362c4c68c761e2094b52a393205cf2e97fe39`.
The transfer archive SHA-256 was
`a2713adca157c5c4e65389b08827dbb96ae922b2f626fd2bb451e04200d5537f`.
All 404 runtime resource hashes matched its manifest. The same Windows build ran
on the physical laptop and offline VM118. Both passed Fit, Center selected,
neighbor navigation, HTTP 503 snapshot/selection retention, successful retry,
IDE/issue tab round-trips, Close/reopen and Disconnect. After each clearing action,
the graph showed zero nodes and edges, the synthetic input was empty, and Refresh
was disabled. The submitted Windows sentinel matched the fixture counters: zero
log matches, zero storage writes, and no stored sentinel. Two non-GraphQL attempts
were blocked. Observed request-to-render intervals were 561 ms on the laptop and
747 ms on VM118, with the same artificial-latency and benchmark limitations.

## Remaining gates and limits

The preserved non-UI suite passed 342 frontend tests, 163 Python tests (including
the Python 3.9 compatibility run), and 18 Rust tests before the later isolated pin
persistence and bridge retry repairs. They were not repeated merely for native acceptance. The isolated repairs now pass 22 Rust tests, including native pin serialization,
legacy reads, disk round-trips, a write followed by a lost response, and recovery
of a read request. Three pin regression assertions and the duplicate-mutation
fault test failed before the fixes. These later source repairs are not included
in the Windows installer hashes listed above.

The prior saved dependency audit reported two low npm affected-package entries,
four Cargo informational warnings (including two unsoundness warnings), and 15
Python development advisory records across seven packages. The bundled LibCST
and PyYAML audit reported zero findings for those packages; this does not certify
the whole interpreter or operating system. Python development/CI remains on 3.9;
a proposed 3.12 migration requires a separate owner decision. The approved bundled
Windows interpreter is 3.13.16.

The accepted Mac build above retains an external Python dependency; it is not a
standalone-runtime claim. A later isolated candidate includes the pin/retry
repairs and a scoped DOMPurify 3.4.16 security patch; its npm audit has zero
findings. Mac arm64 standalone packaging, resource hashes, strict ad-hoc signature
verification and relocated backend checks now pass in the distinct candidate;
its native GUI acceptance remains pending. Candidate native results and hashes
must be recorded separately before promoting it over these accepted hashes.
No security settings, permissions, audit exceptions, baseline migration, merge,
or publication were changed by this acceptance work.
