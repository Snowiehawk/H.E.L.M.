# Shared repository across IDE and Issues

Status: proposed behavior and acceptance plan; this document does not implement or
claim shipment of the feature. Implementation is tracked by
[#56](https://github.com/Snowiehawk/H.E.L.M./issues/56), whose checklist links the delivery slices.

## Project context and boundaries

Add an application-level project selector and a **Link repositories across tabs**
toggle. A project can associate a GitHub repository, a selected local checkout
and its chosen remote. Show repository identity, local path and current local
branch (or detached HEAD) clearly; a branch label must reflect Git's actual state.

When linked, both tabs refer to the chosen repository. When unlinked, the IDE
and Issues tabs can target different repositories independently. Linking shares
repository context only: code and issue graphs, selections, layouts, edit/undo
state and request lifecycles remain separate. Issues are repository-wide and
must not be filtered by the IDE's branch.

Persist project associations, the selected checkout and link preference across
restart. Revalidate paths/remotes and read the actual branch on restore; surface
missing or changed associations rather than silently choosing another copy.
Persistence must not include PATs, issue payloads or credentials.

## Linking and locating a checkout

- Opening a local repo inspects its GitHub remotes and offers issue loading for
  the selected repository. No GitHub remote is a valid local-only state.
- Selecting an issue repository looks for a matching known local checkout.
  Verify the remote association; a folder name alone is not a match.
- Multiple remotes, forks and multiple local copies require an explicit choice.
  A fork and its upstream stay distinct identities. Do not assume `origin`
  identifies the intended issue repository or switch local copies silently.
- If no suitable checkout exists, offer cloning to an explicit destination.
  Show the repository and destination before starting; never create a silent
  duplicate clone, overwrite an existing checkout or repurpose an unrelated
  directory. Failure/cancel must preserve existing files and associations.
- Issue access and Git authentication are separate. A PAT that reads issues may
  lack private-code clone rights. Use existing Git/SSH authentication where
  appropriate; expose an actionable access failure without requesting excess
  scope or assuming the issue PAT is a clone credential.
- Never embed tokens in clone URLs, persistent project state, logs, errors,
  documents, fixtures or screenshots. Keep issue credentials scoped to their
  issue session and retain its disconnect/close clearing behavior.

## Switching branches and protecting work

The branch selector switches the actual selected local checkout. On success,
read Git's resulting state and refresh the file tree and code graph, invalidating
stale work from the previous checkout/branch. Keep the issue repository and its
repository-wide scope unchanged.

Before switching a branch or replacing the IDE's project/checkout, inspect
unsaved editor/flow drafts separately from staged, unstaged and untracked Git
changes. Offer explicit non-destructive choices, including cancel/stay and
saving drafts before retrying. If work cannot be carried safely, block the switch
and explain the next step. Recheck state at apply time; a failed/canceled switch
must not discard files or drafts, publish a false branch label or leave mixed
old/new graph state.

Do not auto-discard, hard reset, clean, force checkout, auto-commit or silently
stash work. Whether to offer explicit stash/reapply is an open design decision;
the initial stage can block unsafe switches. Do not present local editor Undo as
a guarantee that a Git operation can be undone.

Fetch, pull and push are distinct operations. Selecting a remote-only branch
must make any required fetch/local tracking-branch creation explicit. Branch
switching grants no implied pull, push or write-back; remote publication and
cross-file refactoring are outside this plan.

## Delivery order and acceptance checklist

| Stage | Scope | Acceptance before completion |
| --- | --- | --- |
| 1. Project linking | Selector, link toggle, project identity and persistence | Metadata-only linking may precede the guard; IDE replacement uses #66. Both directions offer the correct repo; unlinking permits different targets; safe restore preserves graph/credential isolation. |
| 2. Local copies and clone | Verified matching, ambiguity choices, explicit clone destination/authentication | One/many/no matches and forks behave explicitly; no duplicate or overwrite; rejected authentication and cancellation preserve existing work. |
| 3. Branch switching | Actual Git switch and coherent IDE refresh | Actual branch, files and code graph agree after success; missing/remote-only/detached/conflict cases are explicit; failed/canceled switches preserve the prior coherent state; Issues remain repository-wide. |
| Cross-cutting safety | Protect unfinished work before IDE project/checkout replacement or branch apply | Unsaved drafts and staged/unstaged/untracked changes are distinguished; safe choices/rechecks prevent silent loss; recovery and failure behavior have focused coverage. |

Use credential-free temporary repositories and synthetic issue data for normal
tests. Cover multiple remotes/forks/local copies, removed paths, permission or
authentication failures, stale asynchronous results and restart. Native acceptance
must identify the exact implementation/build and supported desktop targets;
passing earlier candidate tests does not complete these new issues.

## Bounded native issue breakdown

The four feature groups remain #58 (linking), #59 (matching/cloning), #60
(unfinished-work safety) and #61 (branches), natively nested under #56.
The combined acceptance/evidence leaf #73 is also directly under #56.
Each row below is natively nested under its listed parent. Native blocked-by
edges use the exact input leaves shown; containment alone is not a dependency.

| Leaf | Native parent | Bounded output | Blocked by |
| --- | --- | --- | --- |
| [#62](https://github.com/Snowiehawk/H.E.L.M./issues/62) | #58 | Define repository identity and project-state contract | None |
| [#63](https://github.com/Snowiehawk/H.E.L.M./issues/63) | #59 | Normalize remotes and define the known-checkout registry | #62 |
| [#64](https://github.com/Snowiehawk/H.E.L.M./issues/64) | #58 | Persist, migrate and safely restore project associations | #62, #63 |
| [#65](https://github.com/Snowiehawk/H.E.L.M./issues/65) | #60 | Inspect unsaved drafts and actual Git working state | #62 |
| [#66](https://github.com/Snowiehawk/H.E.L.M./issues/66) | #60 | Guard project replacement and branch apply with save/cancel revalidation | #62, #65 |
| [#67](https://github.com/Snowiehawk/H.E.L.M./issues/67) | #58 | Add the selector and linking coordinator behind the transition guard | #62, #63, #66 |
| [#68](https://github.com/Snowiehawk/H.E.L.M./issues/68) | #59 | Let users choose among remotes, forks and local copies | #63, #67 |
| [#69](https://github.com/Snowiehawk/H.E.L.M./issues/69) | #59 | Implement explicit destination, Git authentication and safe cancellation | #63, #68, #66 |
| [#70](https://github.com/Snowiehawk/H.E.L.M./issues/70) | #61 | Define supported Git states and read branch inventory | #62, #63 |
| [#71](https://github.com/Snowiehawk/H.E.L.M./issues/71) | #61 | Execute one admitted local switch and reconcile its result | #70, #66 |
| [#72](https://github.com/Snowiehawk/H.E.L.M./issues/72) | #61 | Refresh files and code graph without stale cross-branch results | #71, #67 |
| [#73](https://github.com/Snowiehawk/H.E.L.M./issues/73) | #56 | Assemble combined acceptance and regression evidence | #64, #68, #69, #72 |

**Ordering correction:** #66 gates #67's IDE project/checkout replacement as well
as #71's branch execution. #69 also delegates activation to the guarded
coordinator. Link metadata and independent contract/decision work can precede
that gate; no replacement control may bypass it. Do not block all of #58 on
whole-group #60 closure. Existing-checkout branch work does not need to wait for
every clone scenario; exact leaf inputs determine the order.

Every leaf specifies success, failure/refusal and cancel/supersession cases,
platform expectations, exclusions and retrievable proof. Before implementation,
choose the reviewed integration revision: current main, remote dev and private
candidate work are not interchangeable. Existing session-generation fences,
draft/Undo owners and active-repository command boundaries are reuse candidates,
not evidence that linking or Git switching is implemented.

## Completion and review contract

- Bind every claim to exact source/dirty delta, build where applicable, Git and
  platform versions, independently expected/observed outcomes and retrievable
  secret-free evidence. Mock/unit, real Git and native desktop evidence are
  separate. Missing, failed, canceled and unsupported outcomes remain explicit.
- Contract/discovery leaves produce reviewed interfaces and decision records;
  they do not earn native implementation credit. Reuse adequate existing code
  when verified; do not invent a rewrite to satisfy an issue.
- A reviewer other than the implementer checks each promised output. #73 assembles
  the requirement-to-case index and combined Mac/Windows result; it does not
  implement or repair missing capability to manufacture a pass.
- #56 requires the leaf outputs and combined review. Earlier security, packaging,
  caret or logo QA does not complete these new requirements. Publishing planning
  issues, native relationships or this document grants no implementation/merge.

## Decisions still open

Recommendations below are proposals for Noah to review, not approved defaults.

| Decision owner | Required decision record | Initial recommendation / limit |
| --- | --- | --- |
| #62 | Toggle default, first-use/migration and close/disconnect semantics | Explicit first-use choice; conservative unlinked fallback. Preserve independent session ownership and credential clearing. |
| #63 | Discovery bounds, aliases/transfers, path/identity normalization and worktree registry semantics | Registered/recent or explicitly added roots; no unrestricted disk crawl. Ambiguous or unknown identity stays explicit. |
| #69 | Credential prompts, Git/SSH handoff, cancellation and redaction | Reuse existing Git authentication where appropriate, independently of issue PAT permissions; no custom vault or token-bearing URL. |
| #66 | Safe dirty-state carry and whether to support stash/reapply | First slice may block unsafe transitions; no silent stash/discard. Any explicit stash/reapply needs separately accepted restore/conflict semantics. |
| #70 | Local/remote-only branch policy, tracking creation, detached HEAD, worktrees and submodules | Start with existing local branches and explicit refusals outside the accepted matrix; fetch/tracking creation remain explicit operations. |
| #64 | Persistence version and repair/migration behavior using #62/#63 decisions | Preserve prior usable records on failure; restored metadata never bypasses guarded IDE activation. |

A decision task can record an unresolved choice and recommendation without
pretending approval. Escalate the affected implementation choice before enabling
it; independent contract, fixture and planning work can continue. Native blocker
closure must be backed by the named input's actual validity, not only issue state.

## Related existing work

[Workspace sessions/sync #5](https://github.com/Snowiehawk/H.E.L.M./issues/5) and
[invalidation #18](https://github.com/Snowiehawk/H.E.L.M./issues/18) provide related
refresh work. [Undo #3](https://github.com/Snowiehawk/H.E.L.M./issues/3),
[atomic recovery #36](https://github.com/Snowiehawk/H.E.L.M./issues/36) and
[recursive safety #41](https://github.com/Snowiehawk/H.E.L.M./issues/41) are related
guardrails, not a Git stash/switch implementation.
[Docs umbrella #11](https://github.com/Snowiehawk/H.E.L.M./issues/11) remains
separate. This plan does not close or replace any audited issue.
