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
| 1. Project linking | Selector, link toggle, project identity and persistence | Both linked directions offer the correct repository; unlinking permits different targets; restart restores references safely; graphs and credentials stay isolated. |
| 2. Local copies and clone | Verified matching, ambiguity choices, explicit clone destination/authentication | One/many/no matches and forks behave explicitly; no duplicate or overwrite; rejected authentication and cancellation preserve existing work. |
| 3. Branch switching | Actual Git switch and coherent IDE refresh | Actual branch, files and code graph agree after success; missing/remote-only/detached/conflict cases are explicit; failed/canceled switches preserve the prior coherent state; Issues remain repository-wide. |
| Cross-cutting safety | Protect unfinished work before stage 3 can apply | Unsaved drafts and staged/unstaged/untracked changes are distinguished; safe choices/rechecks prevent silent loss; recovery and failure behavior have focused coverage. |

Use credential-free temporary repositories and synthetic issue data for normal
tests. Cover multiple remotes/forks/local copies, removed paths, permission or
authentication failures, stale asynchronous results and restart. Native acceptance
must identify the exact implementation/build and supported desktop targets;
passing earlier candidate tests does not complete these new issues.

## Decisions still open

- Default link-toggle value, first-use choice and migration of existing projects.
- Credential prompts, cancellation/redaction and how issue/Git authentication
  choices are explained without conflating their permissions.
- Checkout discovery bounds and matching rules for remote aliases, renamed or
  transferred repositories, and Git worktrees.
- Whether and how explicit stash/reapply, tracking-branch creation, submodules
  and detached HEAD are supported in the first branch-switching slice.
- How persisted link context behaves when a tab/session is closed or disconnected;
  credentials must still clear and no canceled request may revive a session.

Resolve these in the relevant child before implementation; the agreed safety
and graph-isolation boundaries above apply regardless of the chosen UX.

## Related existing work

[Workspace sessions/sync #5](https://github.com/Snowiehawk/H.E.L.M./issues/5) and
[invalidation #18](https://github.com/Snowiehawk/H.E.L.M./issues/18) provide related
refresh work. [Undo #3](https://github.com/Snowiehawk/H.E.L.M./issues/3),
[atomic recovery #36](https://github.com/Snowiehawk/H.E.L.M./issues/36) and
[recursive safety #41](https://github.com/Snowiehawk/H.E.L.M./issues/41) are related
guardrails, not a Git stash/switch implementation.
[Docs umbrella #11](https://github.com/Snowiehawk/H.E.L.M./issues/11) remains
separate. This plan does not close or replace any audited issue.
