# H.E.L.M.

[![CI](https://github.com/Snowiehawk/H.E.L.M./actions/workflows/ci.yml/badge.svg)](https://github.com/Snowiehawk/H.E.L.M./actions/workflows/ci.yml)

H.E.L.M. is a bidirectional repo-to-graph structural editor for source code. This repository currently implements the MVP backbone for Python repositories:

- walk a repo and discover Python modules
- parse Python files with `ast`
- extract symbols, imports, call sites, spans, and diagnostics
- build a domain-owned structural graph
- print a CLI summary or export JSON

## Current Workflow

The first working slice is CLI-first and read-only:

```bash
PYTHONPATH=src python3 -m helm.cli scan path/to/repo
PYTHONPATH=src python3 -m helm.cli scan path/to/repo --json-out out/graph.json
```

If you install the project locally, the same workflow is available as `helm scan ...`.

## Desktop UI

A desktop shell now lives under `apps/desktop/`.

- Use the repo-local HELM wrapper as the normal entrypoint:
  - macOS/Linux: `./helm.sh ui`, `./helm.sh desktop`, `./helm.sh scan path/to/repo`
  - Windows: `.\helm.cmd ui`, `.\helm.cmd desktop`, `.\helm.cmd scan .`
- On first run, the wrapper detects the current OS, installs missing system prerequisites when it knows how to do so, creates or reuses `.venv-helm-dev`, installs the Python project deps, installs the desktop npm deps, and fetches the Tauri/Rust crates used by the desktop shell. Later runs skip completed repo-local steps unless you pass `--install` or `--force`.
- Windows PowerShell users should prefer `.\helm.cmd ...`, because local `.ps1` execution can be blocked by the machine's execution policy before HELM gets a chance to run.
- `./start_here.sh` and `.\start_here.cmd` remain available as one-shot bootstrap aliases if you want setup without launching a command.
- If you only need the scanner or browser-only UI, `./helm.sh bootstrap --python-only` and `./helm.sh bootstrap --ui-only` are available as lighter variants. The same pattern works as `.\helm.cmd bootstrap ...` on Windows.
- `inv ui` starts the browser-only UI with mock data.
- `inv desktop` starts the desktop app and exercises the real Python backbone from the UI.
- `python -m invoke <task>` works too if you prefer not to add the `inv` shell shim to your PATH.

The desktop flow is now the preferred way to validate the frontend/backend integration without running manual scan commands in the terminal.

On supported systems, HELM can now auto-install missing machine-level prerequisites:

- Windows uses `winget`, the official Python install manager, Rustup, and Visual Studio Build Tools when needed.
- On Windows, the first machine-level install may trigger a one-time UAC prompt so HELM can add the required desktop toolchain.
- macOS uses Homebrew plus `rustup`, and will request Xcode Command Line Tools for desktop work if they are missing.
- Linux uses supported package managers (`apt-get`, `dnf`, `pacman`, `zypper`, `apk`) and the Tauri desktop package lists from the official prerequisites guide.

The graph starts coarse and structural:

- repo
- module/file
- class/function/method

## Design Principles

- Python-only in v0
- preserve source spans now so edit-time fidelity is possible later
- keep the graph model independent from visualization libraries
- resolve cross-file relationships conservatively
- defer graph-to-source mutation until the read path is trustworthy

## Development

The package is laid out under `src/helm/`:

- `parser`: repo traversal and AST parsing into normalized IR
- `graph`: domain graph types and graph construction
- `ui`: summary/export adapters
- `cli`: end-to-end orchestration
- `editor`: intentionally deferred mutation interfaces

Tests are written to run under `unittest` in this environment and remain compatible with `pytest` later.

For desktop work, the root `invoke` tasks automatically run inside `apps/desktop/` and default `HELM_WORKSPACE_ROOT` plus `HELM_PYTHON_BIN` to the repo-local venv when it exists. You can still override either environment variable manually if needed.

The bootstrap script prints fully qualified follow-up commands that use the repo-local venv directly, so you do not have to activate the venv just to use HELM.

If you use zsh, keep the extras spec quoted as `'.[dev]'` so the shell does not treat `[]` as a glob. This non-editable install is intentional for compatibility with the older `pip` that ships with macOS Command Line Tools Python.

## CI / Quality Gates

GitHub Actions runs the current required gates on Ubuntu for pull requests, pushes to `main`, pushes to `dev`, and manual dispatches. HELM is still intended to support macOS and Windows local development; Ubuntu CI is the first automated baseline, not the whole platform matrix.

After installing development dependencies, run the CI-equivalent local checks with:

```bash
python -m invoke ci
```

Use `npm ci` in `apps/desktop/` when you want the same dependency install behavior as CI. The HELM bootstrap commands use `npm install` for local convenience and first-run setup. See `docs/ci.md` for the exact commands, audit allowlist rules, and platform notes.

HELM repo mutations are journaled under `.helm/recovery/` so interrupted edits can be rolled back on the next open or before the next mutation. See `docs/recovery.md` for the lifecycle, ignore rules, and platform durability notes.
