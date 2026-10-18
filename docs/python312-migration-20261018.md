# Python 3.12 development and CI migration

The owner approved this development/CI migration after reviewing the ten Python
3.9 dependency blockers in PR #75. It changes the three CI interpreter selections,
lock-generation baseline, development dependency floors and bootstrap minimum.
It does not authorize a merge or change the installed application.

## Environment boundaries

- CI and reproducible lock generation use exactly Python 3.12.
- Development bootstrap accepts Python 3.12+ and validates an existing venv before
  reusing it. An older venv is preserved with an actionable error; there is no
  automatic deletion or replacement. Existing interpreter overrides still work.
- The package's runtime `requires-python >=3.9` declaration remains. Source users
  on 3.9 install the package with dependency resolution, not the 3.12 dev lock.
  The runtime lock now targets 3.12 validation; the inactive <3.10 typing-extensions
  marker remains in its input, while 3.9 source installs resolve LibCST's dependency.
- Official bundled CPython 3.13.16, LibCST 1.8.6, PyYAML 6.0.3, packaging hashes
  and all installed QA candidates remain unchanged. No native app behavior changes
  in this development-only migration.

Patched minimums are filelock 3.20.3, msgpack 1.2.1, pytest 9.0.3, requests 2.33.0,
urllib3 2.8.0, pip 26.2 and setuptools 83.0.0. Pip-tools moves to 7.6.2 for the
current pip API. Unaffected existing pins are retained where resolution permits;
the Ruff 0.15.12 pin remains to avoid unrelated formatting churn. See the
[prior advisory analysis](python-audit-decision-20261018.md) for upstream links.

## Verification

Local CPython 3.12.15 validation passes lock reproducibility, Ruff lint/format,
178 tests (5 Windows-only skips), pip check, and both committed-lock audits. No
findings were allowlisted; the four obsolete Python exceptions were removed
after the fixed lock passed. A symlinked-interpreter regression test verifies
that task tools come from the invoking venv rather than its resolved base Python.
A separate system-3.9 venv with only unchanged runtime dependencies passes source
compilation and 107 core runtime unittest cases. It is a compatibility probe, not
a Python 3.9 development-tool audit. GitHub CI verification is pending publication.

The isolated validation interpreter lives under the task workspace, not system
Python. No native regression is claimed for this tooling-only change; source
runtime code, frontend code, native shell and bundled runtime inputs are unchanged.
