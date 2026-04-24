from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from bootstrap import (
    BootstrapError,
    ensure_cargo_dependencies,
    ensure_npm_dependencies,
    ensure_python_dependencies,
    ensure_supported_python,
    format_command,
    get_platform_profile,
    print_next_steps,
    print_step,
)

REPO_ROOT = Path(__file__).resolve().parent.parent

USAGE = """Usage:
  helm bootstrap [--force] [--python-only | --ui-only]
  helm scan [repo] [--json-out PATH] [--top N] [--verbose]
  helm ui [--install]
  helm desktop [--install]

The wrapper bootstraps repo-local dependencies on first run and skips completed
steps later unless you pass --force or --install.
"""

BOOTSTRAP_USAGE = """Usage:
  helm bootstrap [--force] [--python-only | --ui-only]
"""


def extract_force_install_flag(args: list[str]) -> tuple[bool, list[str]]:
    remaining: list[str] = []
    force_bootstrap = False
    for arg in args:
        if arg == "--install":
            force_bootstrap = True
            continue
        remaining.append(arg)
    return force_bootstrap, remaining


def ensure_bootstrap(*, force: bool = False, python_only: bool = False, ui_only: bool = False) -> Path:
    ensure_supported_python()
    profile = get_platform_profile()
    print_step(f"Detected OS: {profile.name}.")
    venv_python = ensure_python_dependencies(profile, force=force)
    if not python_only:
        ensure_npm_dependencies(profile, force=force)
    if not python_only and not ui_only:
        ensure_cargo_dependencies(profile, force=force)
    return venv_python


def repo_env(venv_python: Path) -> dict[str, str]:
    env = os.environ.copy()
    env.setdefault("HELM_WORKSPACE_ROOT", str(REPO_ROOT))
    env.setdefault("HELM_PYTHON_BIN", str(venv_python))
    return env


def run_user_command(command: list[str], *, env: dict[str, str] | None = None) -> int:
    print_step(f"Running: {format_command(command)}")
    completed = subprocess.run(command, cwd=REPO_ROOT, env=env, check=False)
    return completed.returncode


def run_bootstrap_command(args: list[str]) -> int:
    if any(arg in {"-h", "--help", "help"} for arg in args):
        print(BOOTSTRAP_USAGE)
        return 0

    force = False
    python_only = False
    ui_only = False

    for arg in args:
        if arg == "--force":
            force = True
        elif arg == "--python-only":
            python_only = True
        elif arg == "--ui-only":
            ui_only = True
        else:
            raise BootstrapError(f"Unsupported bootstrap option: {arg}")

    if python_only and ui_only:
        raise BootstrapError("Use either --python-only or --ui-only, not both.")

    profile = get_platform_profile()
    venv_python = ensure_bootstrap(force=force, python_only=python_only, ui_only=ui_only)
    print_next_steps(profile, venv_python)
    return 0


def run_scan_command(args: list[str]) -> int:
    force_bootstrap, scan_args = extract_force_install_flag(args)
    venv_python = ensure_bootstrap(force=force_bootstrap, python_only=True)
    if not scan_args:
        scan_args = ["."]
    return run_user_command([str(venv_python), "-m", "helm.cli", "scan", *scan_args])


def run_ui_command(args: list[str]) -> int:
    force_bootstrap, invoke_args = extract_force_install_flag(args)
    venv_python = ensure_bootstrap(force=force_bootstrap, ui_only=True)
    return run_user_command(
        [str(venv_python), "-m", "invoke", "ui", *invoke_args],
        env=repo_env(venv_python),
    )


def run_desktop_command(args: list[str]) -> int:
    force_bootstrap, invoke_args = extract_force_install_flag(args)
    venv_python = ensure_bootstrap(force=force_bootstrap)
    return run_user_command(
        [str(venv_python), "-m", "invoke", "desktop", *invoke_args],
        env=repo_env(venv_python),
    )


def main(argv: list[str] | None = None) -> int:
    args = list(argv or sys.argv[1:])
    if not args or args[0] in {"-h", "--help", "help"}:
        print(USAGE)
        return 0

    command, command_args = args[0], args[1:]

    try:
        if command == "bootstrap":
            return run_bootstrap_command(command_args)
        if command == "scan":
            return run_scan_command(command_args)
        if command == "ui":
            return run_ui_command(command_args)
        if command == "desktop":
            return run_desktop_command(command_args)
        raise BootstrapError(f"Unknown HELM command: {command}")
    except BootstrapError as exc:
        print(f"[helm bootstrap] {exc}", file=sys.stderr)
        print(USAGE, file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
