# H.E.L.M. Desktop

Premium minimal desktop shell for exploring local repositories before editing them.

## Stack

- Tauri 2
- React 18
- TypeScript
- Vite
- TanStack Query
- Zustand
- React Flow

## Current scope

- Read-only repo onboarding
- UI-driven reindexing against the Python backbone
- Three-pane workspace
- File, symbol, and graph views
- Browser-only mock mode plus live desktop transport

## How to run the UI

From the repo root, use the repo-local HELM wrapper as the normal entrypoint:

```bash
./helm.sh ui
```

On Windows, use:

```powershell
.\helm.cmd ui
```

For the full desktop shell instead of the browser-only UI:

```bash
./helm.sh desktop
```

The wrapper bootstraps itself on first run: it detects the current OS, installs missing system prerequisites when HELM knows how to do so, creates or reuses `.venv-helm-dev`, installs the root Python dependencies, installs the desktop npm dependencies, and fetches the Rust crates used by the Tauri shell. Later runs skip completed steps unless you pass `--install`.

On Windows, the first machine-level install may show a one-time UAC prompt so HELM can add the native desktop toolchain.

If you want setup without launching a command, `./start_here.sh` and `.\start_here.cmd` remain available as bootstrap-only aliases.

If you only need the scanner or mock browser UI, you can trim the bootstrap scope:

```bash
./helm.sh bootstrap --python-only
./helm.sh bootstrap --ui-only
```

Windows PowerShell users should prefer the `.cmd` wrappers, because a local `.ps1` can be blocked before HELM gets to handle bootstrap.

For UI-only styling work with mock data from the repo root:

```bash
inv ui
```

For the real desktop app with the live Python backend wired in:

```bash
inv desktop
```

If you prefer the module form, `python -m invoke ui` and `python -m invoke desktop` do the same thing.

## Prerequisites

- Node.js 18+
- npm 9+
- Rust / Cargo
- Python 3.9+

The desktop shell uses the repo-local `.venv-helm-dev` interpreter by default once bootstrap has run. If your Python binary or workspace path is different, set:

```bash
export HELM_PYTHON_BIN=/path/to/python3
export HELM_WORKSPACE_ROOT=/absolute/path/to/H.E.L.M.
```

before `inv desktop`.

If you use zsh, keep `'.[dev]'` quoted so the shell does not expand the brackets. This uses a non-editable install on purpose so it works with the older `pip` bundled on many macOS systems.

## Testing from the UI

Once the Tauri app is running:

1. Click `Open Local Repo`.
2. Choose the repo you want to scan.
3. Let the indexing screen finish.
4. Use `Reindex Repo` in the window header or `Reindex From UI` on the overview card to validate the live bridge again.

No CLI scan command is required for that workflow.

## Notes

- The frontend intentionally talks only to the adapter layer in `src/lib/adapter`.
- The Tauri bridge invokes `python -m helm.ui.desktop_bridge` under the hood to fetch the real graph payload.
