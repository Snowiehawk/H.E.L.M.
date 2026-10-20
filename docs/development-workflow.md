# Development workflow

HELM follows the same branch roles as C.L.E.A.N.: shared development in `dev`,
focused working branches, and deliberate stable promotions into `main`.

| Branch           | Role                                                                   |
| ---------------- | ---------------------------------------------------------------------- |
| `dev`            | GitHub default, shared integration line, and normal pull-request base  |
| `main`           | Stable line; receives separately reviewed promotions from `dev`        |
| `noah/<purpose>` | Focused task or a coherent, explicitly scoped group of related changes |

## Normal work

1. Read the current README, relevant issues and documentation. Inspect local
   changes before choosing a checkout; preserve work belonging to other tasks.
2. Fetch the latest remote state and create a working branch from `origin/dev`.
3. Make the scoped change. Run relevant checks and record the exact source,
   environment, results and verification limits. Keep generated builds, caches,
   credentials and raw test media outside Git.
4. Commit and push useful checkpoints to the working branch. Open a pull request
   into `dev`, keeping it draft while implementation or required review is incomplete.
5. Merge only after explicit human review and authorization. A successful push,
   passing check or merged document does not by itself complete an issue or release.

For example:

```sh
git fetch origin
git switch -c noah/editor-fix origin/dev
# make and verify the change
git push -u origin noah/editor-fix
gh pr create --base dev --draft
```

Related fixes may share one coherent branch; unrelated features and design work
belong in separate pull requests. Do not use `Closes` language unless every part
of the issue's acceptance contract has been verified.

## Stable promotion and shared history

Stabilize reviewed work on `dev`, then open a separate `dev` to `main` promotion
pull request with the intended readiness/release scope and evidence. Do not
auto-merge, push directly to `main` or an existing `dev`, force-push shared history,
or delete branches without authorization. Initial repository setup must never
overwrite an existing branch.

These review rules apply even without server-enforced branch protection. The
owner-requested setup changed HELM's default from `main` to its existing `dev`;
neither branch history nor any protection/access rule was changed. C.L.E.A.N.'s
live branch API reported both branches unprotected, while its protection/ruleset
detail endpoints returned a plan-related 403. That response does not prove an
absence of every policy. HELM's live ruleset listing was empty and both branch
API records reported unprotected; no settings were weakened to match C.L.E.A.N.

## Source checkout versus installed application

A Windows clone in `D:\Projects\HELM` is development source. `git status` describes
that checkout, not a separately installed application. Updating the checkout does
not rebuild an installer or change a running app. Existing private QA applications
under `%LOCALAPPDATA%` and tiny fixture repositories remain separate.

New clones normally check out remote-default `dev`. If reviewing a published
candidate before its PR is merged, explicitly check out its working branch with
upstream tracking and state that it is unmerged. Do not silently substitute a
ZIP snapshot for a Git clone or describe candidate builds as releases.

See [CI](ci.md), [packaging](desktop-packaging.md), and
[the validated candidate record](validated-candidate-20261018.md) for checks and
the retained platform-specific evidence limits. The owner approved Python 3.12 for development/CI after the dependency review.
See [the migration record](python312-migration-20261018.md); this does not change
the installed application's bundled Python or authorize a merge.
