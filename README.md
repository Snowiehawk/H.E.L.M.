# H.E.L.M.

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

- `python3 -m venv .venv-helm-dev && source .venv-helm-dev/bin/activate` creates the recommended local dev environment.
- `python -m pip install '.[dev]'` installs the root dev helpers, including `invoke`.
- `inv install-desktop` installs the desktop app's npm dependencies from the repo root.
- `inv ui` starts the browser-only UI with mock data.
- `inv desktop` starts the desktop app and exercises the real Python backbone from the UI.
- `python -m invoke <task>` works too if you prefer not to add the `inv` shell shim to your PATH.

The desktop flow is now the preferred way to validate the frontend/backend integration without running manual scan commands in the terminal.

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

For desktop work, the root `invoke` tasks automatically run inside `apps/desktop/` and default `HELM_WORKSPACE_ROOT` plus `HELM_PYTHON_BIN` to the current repo and Python interpreter. You can still override either environment variable manually if needed.

If you use zsh, keep the extras spec quoted as `'.[dev]'` so the shell does not treat `[]` as a glob. This non-editable install is intentional for compatibility with the older `pip` that ships with macOS Command Line Tools Python.
