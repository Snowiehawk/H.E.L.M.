# CI and Quality Gates

HELM currently runs GitHub Actions on Ubuntu for pull requests, pushes to `main`, pushes to `dev`, and manual `workflow_dispatch` runs. This is the first automated baseline only. The project is still built with macOS and Windows local development in mind, so the local `invoke` tasks avoid shell-only assumptions and resolve Windows `.cmd` tools where needed.

## CI-equivalent local checks

Install Python dev dependencies from the repo root:

```bash
python -m pip install '.[dev]'
```

Install desktop dependencies with CI behavior:

```bash
cd apps/desktop
npm ci
cd ../..
```

Then run the same local quality gate aggregate that CI mirrors:

```bash
python -m invoke ci
```

For smaller runs:

```bash
python -m invoke check-python
python -m invoke check-desktop
python -m invoke check-tauri
python -m invoke audit-python
python -m invoke audit-desktop
python -m invoke audit-tauri
```

The bootstrap wrappers remain convenience entrypoints for local setup and app launching:

```bash
./helm.sh bootstrap
.\helm.cmd bootstrap
```

Those bootstrap commands may use `npm install` so first-run local setup is forgiving. They are not the CI-equivalent dependency install. Use `npm ci` when validating lockfile-accurate CI behavior.

## Gates

Python gates:

```bash
ruff check src tests scripts tasks.py
ruff format --check src tests scripts tasks.py
python -m pytest
python scripts/audit.py python
```

Desktop gates:

```bash
cd apps/desktop
npm run lint
npm run format:check
npm test
npm run build
cd ../..
python scripts/audit.py npm
```

Tauri/Rust gates:

```bash
cd apps/desktop
npm run build
cd src-tauri
cargo fmt -- --check
cargo clippy --locked -- -D warnings
cargo check --locked
cd ../../..
python scripts/audit.py cargo
```

CI explicitly installs or verifies Rust `rustfmt` and `clippy` before running the Rust gates. Tauri validation is intentionally limited to frontend build plus `cargo fmt`, `cargo clippy`, and `cargo check` for this issue. A full packaged app build is deferred until it is proven stable and quiet on Ubuntu.

## Security audit allowlist

Audits are blocking. Temporary exceptions must be recorded in `security/audit-allowlist.json`. Every ignore entry must include:

```json
{
  "ecosystem": "npm",
  "advisory": "GHSA-example",
  "package": "example-package",
  "reason": "Why HELM cannot remove this immediately.",
  "removal_condition": "The version or upstream condition that lets us remove this."
}
```

Allowed ecosystems are `python`, `npm`, and `cargo`. Bare advisory IDs are not valid. Each entry must identify the advisory ID, package, reason, and removal condition so the exception can be reviewed and removed later.

If an audit tool cannot filter by severity, any unallowlisted vulnerability fails the audit.

## Formatting

`python -m invoke format` applies Ruff, ESLint fixes, Prettier, and Rust formatting. If Ruff or Prettier creates a broad mechanical cleanup, keep that formatting separate from functional edits in the implementation summary or commit history.

Generated, vendored, dependency, and build output directories are excluded from format and lint gates.
