# Shared repository candidate — #56 and #58–73

This is an unmerged implementation candidate, based on PR #75 at
`5faed57a5a73147cb6861b3d1a1772a6d0197deb` (fetched dev `49b8e51` plus the
verified committed prerequisite). PR #57's design at `bda3ddd` and all native
parent/child issue contracts were read before implementation. The design PR,
navigation PR, colors branch, integration checkout and its pending UI permission
are unchanged. There was no merge, stable promotion, installation or screen control.

## Contract and selected first-slice policy

Noah authorized implementation and dirty-work safeguards overnight. These
conservative implementation choices remain subject to review and native acceptance:

| Decision | Candidate policy |
| --- | --- |
| Link default / first use | Unlinked; user explicitly checks Link repositories across tabs |
| Shared identity | Case-insensitive github.com owner/repository; trailing dots retained; forks remain distinct |
| Discovery | Registered paths and explicitly browsed/entered roots only; no disk crawl |
| Remote choice | Explicit fetch-remote selection, even with one candidate; Local only is supported |
| Copies | Every registered candidate revalidated by Git/remotes; explicit copy selection |
| Restore | Version-1 metadata only; no automatic checkout activation, clone, issue load or credential revival |
| Dirty transitions | Refuse unsaved declaration/file/flow/composer drafts, pending mutations, staged/unstaged/untracked/conflicted work and active Git operations |
| Save/cancel | Explicit Save drafts then retry, or Cancel transition before apply; failed/stale saves cannot admit a switch |
| Stash/safe carry | No stash/reapply, discard, reset, clean, force switch or automatic commit |
| Branch support | Existing local branches in a normal committed checkout; remote-only fetch/tracking creation remains separate |
| Detached/worktrees/submodules | Inspection supported; branch execution refused with a specific reason |
| Clone auth | Existing HTTPS Git helper or existing SSH agent/known host; no issue-PAT reuse or new permission scope |
| Clone destination | Exclusively create a new directory; refuse every existing path, including an empty one |
| Clone cancellation | Exact attempt ID, owned process/tree termination and reconciliation; retain partial output for inspection |
| Close/disconnect | Issue viewer retains its existing memory-only clearing lifecycle; non-secret project association metadata stays |

GitHub HTTPS, SCP-style SSH and `ssh://git@github.com/...` remotes normalize to
the same identity. Credential-bearing/unsupported remotes return no identity;
raw URLs and Git stderr never enter renderer state, persistence or diagnostics.
Push URLs are inspected separately and never silently selected as fetch identity.
Repository aliases/transfers/enterprise hosts are unsupported rather than guessed.
Canonical paths come from the filesystem and Git, including symlinks and Unicode;
case-insensitive string comparison is not used to prove filesystem identity.

## User journey

The application-level Project context panel shows the actual active IDE path and
Git branch/detached state, the Issues target and link toggle. Inspect a local root,
choose its fetch remote (or Local only), register the association, then explicitly
Open selected copy. In linked mode a mismatching local repository is refused.
Choosing the active checkout's remote offers **Use linked repository** in the
issue import panel; applying that offer clears old credentials/snapshot, and Load
remains manual. Selecting an issue repository records its target and offers Find
matching known copies or an explicit clone. It never automatically replaces IDE
work. Unlinking permits different targets. Branch selection never filters Issues.

Stored associations and selected copy are restored as metadata. Open, match and
registration inspect actual roots/remotes again. Missing/changed roots produce a
repair/refusal message. Existing recent-repo UI stays intact; its paths are not
silently imported as verified associations. Corrupt/unknown-version records are
retained and cannot be overwritten until explicit Clear saved associations.
Storage write failure preserves the previous record and leaves the session usable.
Only whitelisted identity/path/remote/link fields are serialized; no branch label,
PAT, issue payload, graph, draft or Undo state is persisted here.

## Admission, Git execution and refresh

The workspace registers a live snapshot of declaration, workspace-file and flow/
composer drafts, plus busy state. Missing providers block transitions while the
IDE is loading. The live adapter tracks in-flight source/workspace/Undo mutations.
Admission serializes shared transitions, checks drafts, inspects the old and target
checkouts, and rechecks Git identity/status immediately before apply. Fingerprints
bind canonical path, HEAD, branch refs, porcelain status, remote config and Git
operation markers. The UI is inert during admission/apply; explicit cancellation
is offered until apply begins. Existing workspace/launcher replacement paths route
through the coordinator when the provider is active.

Python uses argument-vector subprocess calls on the same serial worker as source
mutations. It uses porcelain `-z` parsing (including rename records), refuses dirty,
unsupported or changed admission, and runs one `git switch --no-guess` on an
inventory-verified local branch. No shell interpolation or implicit network action
is used. Repository-location Git environment overrides are removed. External Git
processes are not controlled by HELM; Git's own collision/locking checks still
apply after the final probe. There is no promise of an atomic lock against editors
or Git processes outside HELM.

The native watcher is stopped/joined before branch execution. Its replacement uses
a new context epoch; the adapter rejects queued prior-epoch events even for the
same path. The backend invalidates the prior Python workspace session. Every Git
execution exit is reconciled against actual HEAD/ref: switched, refused/failed,
or unknown. After Git starts the UI does not claim cancellation or rollback.
The frontend invalidates prior adapter work, cancels/removes code queries, resets
Undo/drafts/selection through a fresh session ID, and starts indexing the actual
checkout. Indexing failure leaves an explicit error/unready context on the real
branch; no previous graph is relabeled current. Issue import state is untouched.

## Clone lifecycle

The exact repository, new destination and HTTPS/SSH route are shown before the
Clone action. Known matches are revalidated again; this first slice refuses a
second clone when a verified registered copy exists. Destination creation is
exclusive. Git stdin/output are not exposed, interactive credential prompts are
disabled, and SSH uses existing host trust with BatchMode/StrictHostKeyChecking.
The issue PAT is never passed to Git. A ten-minute bound or explicit Cancel stops
the owned process tree and reaps Git. Cancellation before preflight/worker start
is remembered; it cannot turn into a later clone after a delayed lookup.

Successful cloning re-inspects the actual remote identity before registration.
Activation remains a separate guarded action. A cancellation racing with completion
is reconciled by the clone outcome; it cannot silently activate the result. Failed
or canceled output remains at the exact new destination for inspection. Cleanup
never recursively removes a directory that another process/user might have changed;
only a newly created still-empty directory may be removed before Git starts.
No pre-existing user directory is cleaned, repurposed or overwritten.

## Requirement/evidence index and remaining acceptance

| Leaves | Implementation / evidence seam | Remaining acceptance |
| --- | --- | --- |
| #62 / #63 | ProjectRecord, remote normalizer, canonical Git inspection, verifiedMatches | Independent contract/platform review |
| #64 | Whitelist/versioned storage, explicit restore/repair, persistence refusal tests | Native restart/permissions/Unicode on Mac and Windows |
| #65 / #66 | Workspace draft provider, adapter mutation tracking, live Git fingerprint, save/cancel/recheck | Native draft-provider and external-process race checks |
| #67 / #68 | App Project context, link offer, explicit remote/copy selection, stale lookup fences | Native complete linked/unlinked journeys |
| #69 | Owned async clone/cancel, auth separation, identity verification | Native Mac/Windows process-tree cancellation and private-auth failures |
| #70 / #71 | Branch inventory/support refusal, serial worker switch, actual-state reconciliation | Native platform Git lock/conflict/cancel cases |
| #72 | Watcher epochs, Python invalidation, fresh UI session/query/Undo lifecycle | Native file/symbol/branch coherence and delayed-event review |
| #73 | This index, focused/full automated results and preserved failures | Separate combined reviewer verdict; no issue closure |

Normal tests use only synthetic identities and disposable local Git repositories.
TypeScript/component tests distinguish metadata from activation, check dirty and
unknown draft providers, changed Git state, cancel-before-apply, save failure,
corrupt restore, copy/fork selection, duplicate clone refusal, failed clone output,
exact cancellation IDs, branch refresh and prior-epoch event refusal. Real-Git
Python tests check actual HEAD/file changes, every dirty category, renames, remote
redaction/change, locks, missing/nested roots, and detached/worktree/submodule
refusals. Rust clone tests use local fixtures and check no overwrite, pre-start
cancel, failed output and timeout cleanup ownership.

All native macOS/Windows combined journeys and a reviewer other than the
implementer remain pending. No private authentication was tested. No earlier
native/caret/colors evidence is reused to accept this feature. Keep #56 and its
children open. The exact automated counts and source commit are recorded in the
draft PR after final checks; logs remain in the task evidence directory.

Final source review also bound native camelCase watcher/progress events to the
adapter's normalized internal wire types (legacy snake_case fixture input remains
supported), and includes pending graph-layout writes in transition admission.
These prevent treating a delayed native event or queued layout write as clean
cross-branch state. An initial concurrent frontend run hit existing five-second
interaction timeouts; its log is retained. Final verification is rerun with bounded
workers after source changes, without increasing any test timeout.
