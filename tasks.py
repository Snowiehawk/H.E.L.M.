from __future__ import annotations

import os
import sys
from pathlib import Path

from invoke import Exit, task

REPO_ROOT = Path(__file__).resolve().parent
DESKTOP_DIR = REPO_ROOT / "apps" / "desktop"


def _desktop_env() -> dict[str, str]:
    env = os.environ.copy()
    env.setdefault("HELM_WORKSPACE_ROOT", str(REPO_ROOT))
    env.setdefault("HELM_PYTHON_BIN", sys.executable)
    return env


def _ensure_desktop_app() -> None:
    if not DESKTOP_DIR.exists():
        raise Exit(f"Desktop app not found at {DESKTOP_DIR}.")
    if not (DESKTOP_DIR / "package.json").exists():
        raise Exit(f"Missing package.json in {DESKTOP_DIR}.")


def _install_desktop_dependencies(ctx) -> None:
    _ensure_desktop_app()
    with ctx.cd(str(DESKTOP_DIR)):
        ctx.run("npm install", pty=True)


def _ensure_desktop_dependencies(ctx) -> None:
    if (DESKTOP_DIR / "node_modules").exists():
        return
    print("Desktop dependencies are missing; running `npm install` first.")
    _install_desktop_dependencies(ctx)


def _run_desktop_command(ctx, command: str, *, install: bool) -> None:
    if install:
        _install_desktop_dependencies(ctx)
    else:
        _ensure_desktop_dependencies(ctx)

    with ctx.cd(str(DESKTOP_DIR)):
        ctx.run(command, env=_desktop_env(), pty=True)


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
