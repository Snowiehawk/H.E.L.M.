from __future__ import annotations

import os
import sys
from pathlib import Path

from invoke import Exit, task

REPO_ROOT = Path(__file__).resolve().parent
DESKTOP_DIR = REPO_ROOT / "apps" / "desktop"
BOOTSTRAP_SCRIPT = REPO_ROOT / "scripts" / "bootstrap.py"


def _pty_supported() -> bool:
    return os.name != "nt"


def _venv_python() -> Path:
    scripts_dir = "Scripts" if os.name == "nt" else "bin"
    python_name = "python.exe" if os.name == "nt" else "python"
    return REPO_ROOT / ".venv-helm-dev" / scripts_dir / python_name


def _preferred_python_bin() -> str:
    repo_python = _venv_python()
    if repo_python.exists():
        return str(repo_python)
    return sys.executable


def _run_bootstrap(ctx, *, force: bool = False, ui_only: bool = False) -> None:
    if not BOOTSTRAP_SCRIPT.exists():
        raise Exit(f"Bootstrap script not found at {BOOTSTRAP_SCRIPT}.")

    command = f'"{sys.executable}" "{BOOTSTRAP_SCRIPT}"'
    if force:
        command += " --force"
    if ui_only:
        command += " --ui-only"
    ctx.run(command, pty=_pty_supported())


def _desktop_env() -> dict[str, str]:
    env = os.environ.copy()
    env.setdefault("HELM_WORKSPACE_ROOT", str(REPO_ROOT))
    env.setdefault("HELM_PYTHON_BIN", _preferred_python_bin())
    return env


def _ensure_desktop_app() -> None:
    if not DESKTOP_DIR.exists():
        raise Exit(f"Desktop app not found at {DESKTOP_DIR}.")
    if not (DESKTOP_DIR / "package.json").exists():
        raise Exit(f"Missing package.json in {DESKTOP_DIR}.")


def _install_desktop_dependencies(ctx) -> None:
    _ensure_desktop_app()
    with ctx.cd(str(DESKTOP_DIR)):
        ctx.run("npm install", pty=_pty_supported())


def _ensure_desktop_dependencies(ctx) -> None:
    if (DESKTOP_DIR / "node_modules").exists():
        return
    print("Desktop dependencies are missing; running `npm install` first.")
    _install_desktop_dependencies(ctx)


def _run_desktop_command(ctx, command: str, *, install: bool) -> None:
    if command == "npm run dev":
        _run_bootstrap(ctx, force=install, ui_only=True)
    else:
        _run_bootstrap(ctx, force=install)

    with ctx.cd(str(DESKTOP_DIR)):
        ctx.run(command, env=_desktop_env(), pty=_pty_supported())


@task(
    aliases=["setup"],
    help={
        "force": "Reinstall repo dependencies even when bootstrap stamps are current.",
        "ui_only": "Install Python and npm dependencies, but skip Rust/Tauri fetches.",
    },
)
def bootstrap(ctx, force: bool = False, ui_only: bool = False) -> None:
    """Bootstrap the repo-local dev environment for this clone."""
    _run_bootstrap(ctx, force=force, ui_only=ui_only)


@task(aliases=["install"])
def install_desktop(ctx) -> None:
    """Install desktop npm dependencies."""
    _install_desktop_dependencies(ctx)


@task(
    aliases=["browser"],
    help={"install": "Run `npm install` before starting, even if node_modules exists."},
)
def ui(ctx, install: bool = False) -> None:
    """Run the browser-only UI with mock data."""
    _run_desktop_command(ctx, "npm run dev", install=install)


@task(
    aliases=["app", "dev"],
    help={"install": "Run `npm install` before starting, even if node_modules exists."},
)
def desktop(ctx, install: bool = False) -> None:
    """Run the Tauri desktop app from the repo root."""
    _run_desktop_command(ctx, "npm run tauri dev", install=install)
