# H.E.L.M. Desktop

Desktop shell for exploring and editing local Python repositories.

## Stack

- Tauri 2
- React 18
- TypeScript
- Vite
- TanStack Query
- Zustand
- React Flow

## Current scope

- Local repository onboarding and scanning
- UI-driven reindexing against the Python backbone
- Three-pane workspace
- File, symbol, and graph views
- Source/structural editing with Save, Undo, Redo and recovery journaling
- Separate read-only GitHub issues tab with memory-only credentials and layout
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

## Development prerequisites

- Node.js 20+ (required by the locked test runner and router)
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

1. Choose `Open Repo` in an existing workspace or the local-repository control on the welcome screen.
2. Choose the repo you want to scan.
3. Let the indexing screen finish.
4. Choose `Reindex` in the workspace explorer to scan the repository again.

No CLI scan command is required for that workflow.

## Notes

- The frontend intentionally talks only to the adapter layer in `src/lib/adapter`.
- The Tauri bridge invokes `python -m helm.ui.desktop_bridge` under the hood to fetch the real graph payload.

## Packaged applications

Windows x64 installers include a pinned Python runtime and backend dependencies.
Mac arm64 candidate bundles include a pinned interpreter and runtime dependencies.
Intel Mac bundles retain a compatible external Python contract. These
contracts differ from the source-development prerequisites above. See
[desktop packaging](../../docs/desktop-packaging.md) and the
[native acceptance matrix](../../docs/native-acceptance-20261017.md).
