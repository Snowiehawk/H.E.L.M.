# Agent instructions

Read the README, [development workflow](docs/development-workflow.md), relevant
issues and affected component documentation before changing this repository.

- Base focused `noah/<purpose>` working branches on the latest `origin/dev`.
- Normal pull requests target `dev`; stable promotion from `dev` to `main` is a
  separate human-reviewed pull request.
- Do not push directly to shared `main` or existing `dev`, auto-merge, force-push,
  or delete branches without explicit authorization. Preserve existing local work.
- Follow the owner's scope. Inspection, implementation, publication and release
  are distinct actions; documentation or a passing test does not authorize the next one.
- Review the full diff, run relevant checks, and state evidence limits. Keep
  credentials, generated builds/caches and raw test media out of Git.
- Preserve the distinction between a source checkout, a private QA candidate and
  a release. Do not claim prior tests were rerun on a later revision.
- Do not migrate the Python development/CI baseline or change security exceptions
  merely to make checks pass; report the finding and its actual scope.
