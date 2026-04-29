# Dependency Policy

HELM has three dependency ecosystems: Python, the desktop frontend npm app, and
the Tauri/Rust shell. Package manifests keep normal version ranges for humans and
packaging metadata, while committed lockfiles are the authority for CI and release
validation.

## Python

Python lockfiles are generated with the CI baseline interpreter, currently
Python 3.9. Do not regenerate them with a newer local interpreter.

Inputs:

```bash
requirements/python-runtime.in
requirements/python-dev.in
```

Generated lockfiles:

```bash
requirements/python-runtime.txt
requirements/python-dev.txt
```

Regenerate both lockfiles from a Python 3.9 environment:

```bash
python -m invoke lock-python
```

Check that committed locks are fresh:

```bash
python -m invoke check-python-locks
```

CI installs the dev lock, installs HELM without resolving dependencies again,
and then verifies the environment:

```bash
python -m pip install -r requirements/python-dev.txt
python -m pip install --no-deps -e .
python -m pip check
```

Runtime/release dependency review starts from `requirements/python-runtime.txt`.
Development and CI tooling review starts from `requirements/python-dev.txt`.

## npm

The desktop app lives in `apps/desktop`. `package.json` keeps semver ranges and
`package-lock.json` is the authoritative install record. CI and CI-equivalent
local validation use:

```bash
cd apps/desktop
npm ci
```

Use `npm install` only for local bootstrap convenience or intentional dependency
updates, then review and commit the resulting lockfile change.

## Rust/Tauri

The Tauri shell lives in `apps/desktop/src-tauri`. `Cargo.toml` keeps normal
dependency requirements and `Cargo.lock` is authoritative for CI. Rust gates use
locked commands:

```bash
cargo clippy --locked -- -D warnings
cargo check --locked
```

Use `cargo update` only for intentional dependency upgrades, then review and
commit the lockfile change.

## Audits

Security audits are blocking. Python audits run against both committed Python
lockfiles:

```bash
python scripts/audit.py python
```

npm and Cargo audits run against their lockfiles through the same wrapper:

```bash
python scripts/audit.py npm
python scripts/audit.py cargo
```

Temporary vulnerability exceptions must be narrow entries in
`security/audit-allowlist.json` with ecosystem, advisory, package, reason, and
removal condition. Prefer dependency upgrades over allowlist entries.

## Vendoring

HELM currently has no vendored runtime dependencies. LibCST is supplied only by
the declared Python dependency and the committed Python lockfiles.

Future vendoring requires a documented owner, upstream source and version,
reproducible update command, audit process, and removal/review condition before
any vendored tree is committed.
