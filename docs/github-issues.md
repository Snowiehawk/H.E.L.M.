# GitHub issue viewer: scope and implementation plan

The GitHub issue/dependency viewer will be a **separate tab and piece of
functionality inside the H.E.L.M. desktop app**. It will have its own issue graph,
state and layout namespace. Issues and dependencies must never be overlaid on,
inserted into, or combined with the existing IDE/code graph.

The current local implementation is only an Atlas-derived read-only importer and
a temporary welcome-screen panel showing counts. The separate viewer tab and its
graph presentation have **not started**. This document is the design reference
for that next phase; documenting it does not authorize starting that phase.

Each desktop instance will accept a repository URL and personal access token,
then fetch directly from GitHub on Load or Refresh. These are snapshots, not a
live subscription. There is no hosted backend, shared token, GitHub write operation,
or automatic multi-computer synchronization.

## Current implementation and evidence

These commits exist only on the local `codex/atlas-issue-loader` branch based on
`49b8e51`; they have not been pushed or merged:

| Local commit | Implemented behavior |
| --- | --- |
| `730b510` | Atlas-derived loader, schemas, trailing-dot parser fix, in-memory issue adapter, synthetic tests, MIT notices, and a welcome-screen import/count panel. |
| `e7ffbca` | The explicitly approved GraphQL path added to production/development CSP connection lists, security regression test, and documentation update. |

The panel currently accepts `github.com` repository URLs or `owner/name`, loads
native blockers, and shows issue/link counts, timestamps, progress and incomplete
data warnings. It does not render issue nodes, connect issues to the code graph,
create a viewer tab, or persist issue layouts. Opening a local code workspace
unmounts this temporary panel and clears its issue session.

Implementation references:

- [GitHub client](../apps/desktop/src/issues/github/client.ts) and
  [response schemas](../apps/desktop/src/issues/github/schemas.ts).
- [Issue domain types](../apps/desktop/src/issues/types.ts),
  [blocker normalization](../apps/desktop/src/issues/dependencies.ts), and
  [IssueRepositoryAdapter](../apps/desktop/src/issues/IssueRepositoryAdapter.ts).
- [Temporary import panel](../apps/desktop/src/issues/IssueImportPanel.tsx) and
  [desktop CSP](../apps/desktop/src-tauri/tauri.conf.json).

## Separate viewer architecture

The boundary applies to the presentation, domain and state, not just the name of
a tab. A future issue renderer must consume issue-specific nodes and blocker edges
through its own projection. It must not map them to code `symbol`, `calls` or
`defines` semantics, widen the code graph to mix both sources, or inherit code
editing actions such as source mutation and flow authoring.

| Concern | Existing IDE/code functionality | Planned GitHub issues functionality |
| --- | --- | --- |
| Source | Local repository, Tauri/Python indexing and source operations. | Direct read-only GitHub GraphQL queries. |
| Domain | Code modules, symbols, imports, calls and flow. | GitHub issues and native blocker relationships. |
| State | Existing code workspace/session, selection, filters and undo. | Separate issue session, selection, filters and request lifecycle. |
| Canvas | Existing code graph and its editing behavior. | Its own issue graph; no shared nodes or cross-domain edges. |
| Layout | Existing code view keys and repository layout file. | Separate `github-issues` namespace; initially memory only. |

Shared styling, buttons, loading/error surfaces and genuinely domain-neutral
React Flow primitives may be reused. Reuse must not share mutable graph state,
selection, undo history, code ports/actions, persistence keys or credentials.
The existing `DesktopAdapter` mock/live switch remains for local code work; the
issue adapter must not silently become a mock merely because that switch exists.
Browser rendering can support development tests, but web hosting is not a product
target for this feature.

Use GitHub's native repository and issue node IDs as future canvas/layout
identities. Those IDs are already included in the imported snapshot and dependency
references. Current normalized `owner/name#number` keys and edge IDs are useful
for display and adjacency; they are not the future persisted-layout identity.
The next projection should derive blocker edge identities from relation kind and
native endpoint IDs, independently of any local checkout's absolute path.

## User flow and session lifecycle

The intended separate-tab flow is:

1. Open the GitHub issues viewer inside H.E.L.M. The code workspace, if any,
   remains independent. Issue loading does not require indexing a local checkout.
2. Enter a repository URL or `owner/name` and a PAT with Issues read access for
   that repository. Each desktop authenticates independently.
3. Choose Load. Fetch accessible issue pages, validate responses, and show progress.
   Replace the displayed snapshot after the request finishes, with visible limits
   if its counts or dependency connections are incomplete.
4. Inspect the separate issue graph once that presentation phase is implemented.
   Show the repository and last successful load time so stale snapshots are clear.
5. Choose Refresh to fetch again. Repository or issue edits elsewhere do not
   appear until a successful refresh. A failed refresh retains the preceding
   snapshot and reports that it is still being shown.
6. Cancel stops an in-flight request; it does not imply disconnecting an existing
   successful session. Disconnect clears the issue session and PAT. Changing
   repositories clears the preceding repository's issue data.

The next tab implementation must make session lifetime explicit. The proposed
behavior is to retain the in-memory issue session while its viewer tab remains
open, including when another tab is selected, and clear it on Disconnect or when
the issue tab/window closes. This is a planned lifecycle change from the current
welcome panel's clear-on-unmount behavior; it is not implemented yet. Switching
tabs must never transfer issue state into the IDE/code session.

## Data and privacy boundary

`apps/desktop/src/issues/IssueRepositoryAdapter.ts` owns an in-memory snapshot,
load progress, cancellation, and a private token reference. It is separate from
the Tauri/Python local-code workspace adapter. It publishes a replacement snapshot
only after all repository issue pages finish. A failed refresh keeps the previous
successful snapshot and reports the error. A repository switch clears the prior
repository's data. Cancelled or superseded responses cannot replace current data.

Tokens are cleared from the input on submit and from the adapter on disconnect or
when leaving the welcome screen. No token or imported issue data is written to
local storage, query caches, URLs, logs, exports, `.helm`, or Git. No issue body is
requested, and avatar/Markdown assets are not rendered. JavaScript memory is not
a secure-erasure mechanism; this is ephemeral session state, not a secret store.

This is a public H.E.L.M. source repository. Credentials and private issue content
must never enter its commits, test fixtures, screenshots, build artifacts or CI
logs. Tests use synthetic identities and content. Real private-repository checks,
if later authorized, must keep their data outside this repository and CI artifacts.
No issue snapshot is carried through ordinary Git operations in this implementation.

## Explicit limits

- All top-level issue pages are followed. Duplicate issues are deduplicated; cursor
  cycles are rejected. Mismatched or changing totals mark the result partial.
- Up to 100 `blockedBy` and 100 `blocking` references are fetched **per issue**.
  Their `totalCount` values detect truncation. Nested pagination is not implemented.
- Native references normalize to blocker -> blocked edges and are deduplicated
  when reported from both ends. Body text is never parsed into relationships.
- `blockedBy` means the referenced issue is the source/blocker and the current
  issue is its target. `blocking` means the current issue is the source/blocker.
  A dependency arrow does not assert parenthood or hierarchy.
- Parent/sub-issue hierarchy is **not loaded**, rather than inferred from blockers.
- External-repository references are boundary references, not recursively fetched
  repositories. Completeness only describes data returned to this token.
- Atlas metadata limits remain: up to 20 assignees and 50 labels per issue.
- Rate-limit metadata is retained, but retries/backoff are not automatic. Errors
  never echo GitHub response bodies, authorization values or arbitrary transport
  exception messages. The endpoint is fixed, cookies omitted and redirects rejected.
- GitHub pagination is not a transaction: a repository may change during loading.

The future viewer must preserve these warnings next to its graph and counts. A
complete top-level issue list does not prove complete blocker reachability. Do not
present paths, readiness or totals as authoritative when relevant data is partial.
Do not silently infer missing native hierarchy from issue titles, labels, body
references or blocker direction. Nested dependency pagination and native hierarchy
would each require an explicit later scope change and their own tests.

## Desktop network boundary

At baseline `49b8e51`, both production `csp.connect-src` and development
`devCsp.connect-src` exclude GitHub, so the loader's direct fetch requires a narrow
network allowance. Following explicit approval, both lists now include only the
additional `https://api.github.com/graphql` source. Every other configuration value
and all Tauri capabilities are unchanged.

This permits HTTPS connections to the fixed GraphQL path, without wildcard domains,
new Tauri HTTP plugins, Rust commands, shell permissions or relaxation of other
CSP directives. A configuration regression test locks this boundary. Live fetching
in the desktop WebView remains **unverified**: tests use synthetic responses, and
no real PAT or private repository data has been used. No browser-hosting work or
proxy is included.

## Repository-local layouts: existing behavior and future direction

The current code graph already reads/writes
`<opened-target-repo>/.helm/graph-layouts.v1.json`. Its JSON has a `views` map;
view data contains node-ID-to-`{x,y}` positions, reroutes, pins and groups. Dragging
and layout actions save through Tauri with atomic file replacement. View keys
combine level and target identity; repository roots normalize to `repo-root`.
Code IDs are based on module/qualified names, so renames can change their identity.
See [layout storage](../apps/desktop/src-tauri/src/graph_layout_storage.rs) and
[frontend persistence](../apps/desktop/src/components/graph/graphLayoutPersistence.ts).

That file is tracked in H.E.L.M.'s own repository. Writing it into another opened
repository does **not** automatically add, commit or push it. The current ignore
rules and new-project scaffold ignore `.helm/recovery/` but leave layouts eligible
for tracking; a target repository's own ignore rules can differ.

The implemented limits are material to any future reuse:

- The workspace watcher can report external file changes, but production code
  does not invalidate the frontend layout snapshot cache. A pull does not reliably
  reload an already-open layout; restarting the app provides a fresh disk read.
- Writes are atomic, but there is no layout-aware Git merge, concurrent-edit
  conflict resolution, or protection against overwriting newer external positions.
  Invalid/conflicted JSON currently normalizes to an empty layout. Frontend write
  failures are swallowed to keep dragging interactive.
- Rust currently serializes `pinned_node_ids`, while frontend normalization expects
  `pinnedNodeIds`. This existing mismatch must be checked before reusing pin
  persistence; it is not repaired by the importer work.

No issue layout is persisted now. The future direction is to let users explicitly
associate the issue viewer with a local target repository and version positions
through ordinary commit/push/pull. The proposed issue namespace is
`github-issues|<native-repository-id>|<view-id>`, with positions keyed by native issue
IDs. Use a separate versioned issue-layout file or isolated schema section; do not
reuse or overwrite code view keys. The exact storage schema/path remains a later
design decision, not an implemented file.

Any future tracked issue layout should contain only the explicitly approved
layout metadata, never PATs, private bodies or full issue snapshots. IDs and
relationships can themselves reveal private structure, so the target repository's
visibility matters; private target metadata must never be copied into public
H.E.L.M. as a fixture. Saving layout metadata must not imply saving credentials.

Push alone updates neither another computer's local checkout nor its open view.
Another computer needs its ordinary pull and a reliable future layout reload, and
still independently loads/refreshes issues from GitHub. Background Git, live
multi-system synchronization and automatic conflict resolution are out of scope.

## Upstream attribution and adaptations

The GitHub client, schemas, parser, issue types, edge normalization and parser test
cases are adapted from [Issue Atlas](https://github.com/ccheney/github-issue-dag-viewer),
upstream commit `b356d07` (MIT, copyright (c) 2026 Chris Cheney). The inspected local
Atlas copy also contains a trailing-dot repository-name parser fix and tests not
in that commit; those changes are retained here using synthetic repository names.
The complete notice is in `third_party/issue-atlas.LICENSE`. Zod is the only imported
runtime package. Copies of Atlas's and Zod's MIT notices are also in
`apps/desktop/public/licenses/`, so Vite includes them in packaged frontend assets.

H.E.L.M. adaptations add fetch injection, canonical native IDs, bounded network
errors, redirect/cookie restrictions, all-seen cursor detection, issue deduplication,
explicit completeness, and an atomic in-memory load/refresh adapter. Atlas's UI,
Cytoscape, Primer, React version and build tooling were not copied. Atlas remains
intact until any replacement is verified.

## Next implementation plan: not started

Work stops at this documented plan until it aligns with the requested separate-tab
design. No presentation phase is implied by the completed importer commits.

1. **Separate tab and issue projection.** Introduce an issue-viewer tab/entry point
   in the desktop shell, independent of the local code `RepoSession`. Move or reuse
   the existing import controls there, with an issue-scoped session owner and
   explicit close/disconnect lifecycle. Project snapshots into issue-specific
   React Flow nodes and native blocker edges. Render a basic issue graph plus its
   counts, last refresh and completeness warnings. Keep initial positions in memory.
   Preserve external boundary nodes; do not recursively load other repositories.
2. **Focused inspection, as its own bounded follow-up.** Add issue search, selected
   issue details, Center selected versus Fit visible, upstream/downstream/both,
   hop depth and hide-unrelated controls. Traverse blockers cycle-safely. Preserve
   the selected issue and viewport deliberately during refresh, rather than
   borrowing the code graph's selection or navigation state.
3. **Optional later scope.** Address nested pagination, native parent/sub-issue
   hierarchy, and repository-local issue layout persistence separately. Each needs
   its own schema, interaction, completeness/privacy and migration decisions. A
   hierarchy relation must remain distinct from blockers if it is later introduced.

The first item is the next actual graph-wiring boundary. It does not include code
overlays, source editing, GitHub mutations, hierarchy, persisted issue layouts,
hosting, OAuth/shared sessions or automatic synchronization. Keep Atlas available
until any replacement has been checked against its intended use.

## Verification record and acceptance criteria

Historical local verification of `730b510` passed 329 frontend tests across 40
files (including 50 new importer tests), lint, formatting, and the production build.
After `e7ffbca`, all 50 importer tests and both desktop asset/security tests passed;
a JSON comparison confirmed that only the approved connection source changed.
No native desktop network smoke test or real private-data validation occurred.
Ruff was unavailable for the Python test change. The dependency audit reported
blocking advisories in 11 pre-existing packages with unchanged locked versions;
the added Zod dependency was not reported. These results do not establish a fully
working issue viewer or a clean overall security audit.

Existing synthetic importer tests cover trailing-dot repository names, pagination,
dependency direction/deduplication, caps and partial counts, bounded errors,
cancellation, stale responses, memory-only lifecycle, and temporary panel controls.
See `apps/desktop/src/issues/*.test.*` and `tests/test_desktop_assets.py`.

Before accepting the separate viewer/tab phase, verify:

- Issue loading works without a local code workspace. Selecting the issue tab
  shows its own canvas; switching to IDE preserves the code graph, filters,
  selection, layout and editing behavior without adding issue nodes or edges.
- Issue selection, filters, viewport and layout keys are isolated from their code
  equivalents. Two checkouts of the same GitHub repository derive the same native
  issue identities; their absolute local paths do not become issue layout keys.
- Load/Refresh/Cancel/Disconnect and tab-close behavior match the documented
  lifecycle. Superseded requests cannot replace newer data. Failed refresh keeps
  the previous snapshot with an error and its previous successful timestamp.
- Duplicate relationships normalize once in blocker-to-blocked direction. External
  references, cycles, an empty repository, more-than-100 nested relationships and
  changing top-level totals are tested without private content.
- Caps, partial results and hierarchy-not-loaded remain visible in the viewer.
  Full top-level pagination never silently becomes a claim of complete reachability.
- Credentials and issue data stay out of persistent stores, URLs, logs, Git and
  build/test artifacts. Disconnect and closing the issue session clear them. The
  exact approved CSP endpoint is retained without broadening other permissions.
- Shared visual changes do not regress existing IDE/code tests. Any later search
  and focus phase tests centering an off-screen result, direction/depth boundaries,
  cycle termination and hiding unrelated nodes on synthetic graphs.

Use synthetic fixtures in normal CI. Live desktop verification, if later
authorized, must use an explicitly supplied test credential and keep its value and
private results out of this public repository, logs and recorded screenshots.
Never retrieve an existing PAT implicitly to satisfy a test.
