# Read-only GitHub issue import

This local slice adds a GitHub import panel to the desktop welcome screen. Enter a
`github.com` repository URL (or `owner/name`) and a personal access token with
Issues read access. Load and Refresh issue GitHub GraphQL queries, never mutations.
Each desktop instance authenticates independently. Refresh is manual; there is no
polling, webhook, Git operation, shared backend, or cross-device session.

## Data boundary

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

The panel shows issue/blocker counts, timestamps, and completeness. Imported issue
nodes are **not yet rendered on the code graph**. Graph presentation would need a
separate issue-domain adapter and is outside this slice. The existing code graph,
parser, layout persistence and editing behavior are unchanged.

## Explicit limits

- All top-level issue pages are followed. Duplicate issues are deduplicated; cursor
  cycles are rejected. Mismatched or changing totals mark the result partial.
- Up to 100 `blockedBy` and 100 `blocking` references are fetched **per issue**.
  Their `totalCount` values detect truncation. Nested pagination is not implemented.
- Native references normalize to blocker -> blocked edges and are deduplicated
  when reported from both ends. Body text is never parsed into relationships.
- Parent/sub-issue hierarchy is **not loaded**, rather than inferred from blockers.
- External-repository references are boundary references, not recursively fetched
  repositories. Completeness only describes data returned to this token.
- Atlas metadata limits remain: up to 20 assignees and 50 labels per issue.
- Rate-limit metadata is retained, but retries/backoff are not automatic. Errors
  never echo GitHub response bodies, authorization values or arbitrary transport
  exception messages. The endpoint is fixed, cookies omitted and redirects rejected.
- GitHub pagination is not a transaction: a repository may change during loading.

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

## Future repository-local layouts

The issue snapshot includes GitHub's native repository and issue node IDs,
including IDs of dependency references. Future layout keys should use those IDs;
the normalized `owner/name#number` key remains useful for display and adjacency.
No issue layout is persisted now. A future feature may explicitly store positions
in the opened target repository and let ordinary user-controlled commit/push/pull
carry them between computers. Tokens and private bodies must never enter tracked
layout data, and private issue metadata must not enter public H.E.L.M.

Existing code layouts already use `<target>/.helm/graph-layouts.v1.json`, but Git
tracking is user-controlled. An existing in-memory layout cache means external
pulls do not reliably reload an open layout. Push alone updates neither another
local checkout nor its open view. Automatic synchronization and conflict handling
are future work; this slice does not alter the existing mechanism.

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

## Verification

Synthetic tests live under `apps/desktop/src/issues/`. They cover pagination,
trailing-dot names, blocker direction/deduplication, nested caps, partial data,
errors, cancellation, stale responses, memory-only lifecycle, and panel controls.
No real PAT or private CLEAN snapshot is used. Any future live private-repository
verification must keep its data outside this public repository and CI artifacts.
