from __future__ import annotations

import argparse
import os
import platform
import shlex
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
VENV_DIR = REPO_ROOT / ".venv-helm-dev"
DESKTOP_DIR = REPO_ROOT / "apps" / "desktop"
TAURI_DIR = DESKTOP_DIR / "src-tauri"


class BootstrapError(RuntimeError):
    """Raised when the repo bootstrap cannot complete."""


@dataclass(frozen=True)
class PlatformProfile:
    name: str
    python_subpath: tuple[str, ...]
    activation_hint: str
    tool_hints: dict[str, str]


PLATFORM_PROFILES: dict[str, PlatformProfile] = {
    "windows": PlatformProfile(
        name="windows",
        python_subpath=("Scripts", "python.exe"),
        activation_hint=r".\.venv-helm-dev\Scripts\Activate.ps1",
        tool_hints={
            "npm": (
                "Install Node.js LTS so `npm` is available on PATH. "
                "On Windows, `winget install OpenJS.NodeJS.LTS` is the quickest path."
            ),
            "cargo": (
                "Install Rust with rustup so `cargo` is available on PATH. "
                "On Windows, `winget install Rustlang.Rustup` is the quickest path."
            ),
        },
    ),
    "macos": PlatformProfile(
        name="macos",
        python_subpath=("bin", "python"),
        activation_hint="source .venv-helm-dev/bin/activate",
        tool_hints={
            "npm": (
                "Install Node.js so `npm` is available on PATH. "
                "Homebrew users can run `brew install node`."
            ),
            "cargo": (
                "Install Xcode Command Line Tools and Rust so `cargo` is available on PATH. "
                "A common path is `xcode-select --install` followed by rustup."
            ),
        },
    ),
    "linux": PlatformProfile(
        name="linux",
        python_subpath=("bin", "python"),
        activation_hint="source .venv-helm-dev/bin/activate",
        tool_hints={
            "npm": (
                "Install Node.js and npm with your distro package manager or nvm "
                "so `npm` is available on PATH."
            ),
            "cargo": (
                "Install Rust with rustup so `cargo` is available on PATH. "
                "Linux desktop builds also need the Tauri system libraries for your distro."
            ),
        },
    ),
}


def get_platform_profile(system_name: str | None = None) -> PlatformProfile:
    normalized = (system_name or platform.system()).strip().lower()
    if normalized.startswith("win"):
        return PLATFORM_PROFILES["windows"]
    if normalized == "darwin":
        return PLATFORM_PROFILES["macos"]
    if normalized == "linux":
        return PLATFORM_PROFILES["linux"]
    raise BootstrapError(f"Unsupported operating system: {system_name or platform.system()}")


def venv_python_path(profile: PlatformProfile, root: Path = REPO_ROOT) -> Path:
    return root.joinpath(".venv-helm-dev", *profile.python_subpath)


def bootstrap_cache_dir(profile: PlatformProfile, root: Path = REPO_ROOT) -> Path:
    return venv_python_path(profile, root).parent.parent / ".helm-bootstrap"


def selected_phases(*, python_only: bool = False, ui_only: bool = False) -> tuple[str, ...]:
    phases = ["python"]
    if not python_only:
        phases.append("npm")
    if not python_only and not ui_only:
        phases.append("cargo")
    return tuple(phases)


def format_command(command: list[str]) -> str:
    parts = [str(part) for part in command]
    if os.name == "nt":
        return subprocess.list2cmdline(parts)
    return shlex.join(parts)


def print_step(message: str) -> None:
    print(f"[helm bootstrap] {message}")


def run_command(command: list[str], *, cwd: Path | None = None, description: str) -> None:
    print_step(f"{description}: {format_command(command)}")
    completed = subprocess.run(command, cwd=cwd, check=False)
    if completed.returncode != 0:
        raise BootstrapError(f"{description} failed with exit code {completed.returncode}.")


def touch(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("ok\n", encoding="utf-8")


def needs_refresh(stamp_path: Path, inputs: list[Path]) -> bool:
    if not stamp_path.exists():
        return True

    stamp_mtime = stamp_path.stat().st_mtime
    for input_path in inputs:
        if input_path.exists() and input_path.stat().st_mtime > stamp_mtime:
            return True
    return False


def resolve_command(command_name: str, profile: PlatformProfile) -> str:
    resolved = shutil.which(command_name)
    if resolved is not None:
        return resolved
    hint = profile.tool_hints.get(command_name, "")
    detail = f" {hint}" if hint else ""
    raise BootstrapError(f"Missing required tool `{command_name}`.{detail}")


def ensure_supported_python() -> None:
    if sys.version_info < (3, 9):
        version = ".".join(str(part) for part in sys.version_info[:3])
        raise BootstrapError(
            f"HELM requires Python 3.9+ for bootstrap, but the current interpreter is {version}."
        )


def ensure_desktop_layout() -> None:
    if not DESKTOP_DIR.exists():
        raise BootstrapError(f"Desktop app not found at {DESKTOP_DIR}.")
    if not (DESKTOP_DIR / "package.json").exists():
        raise BootstrapError(f"Missing package.json in {DESKTOP_DIR}.")
    if not (TAURI_DIR / "Cargo.toml").exists():
        raise BootstrapError(f"Missing Cargo.toml in {TAURI_DIR}.")


def ensure_venv(profile: PlatformProfile) -> Path:
    venv_python = venv_python_path(profile)
    if venv_python.exists():
        print_step(f"Using existing virtual environment at {VENV_DIR}.")
        return venv_python

    print_step(f"Creating virtual environment at {VENV_DIR}.")
    run_command(
        [sys.executable, "-m", "venv", str(VENV_DIR)],
        cwd=REPO_ROOT,
        description="Create Python virtual environment",
    )
    if not venv_python.exists():
        raise BootstrapError(f"Virtual environment was created, but {venv_python} is missing.")
    return venv_python


def ensure_python_dependencies(profile: PlatformProfile, *, force: bool) -> Path:
    venv_python = ensure_venv(profile)
    stamp_path = bootstrap_cache_dir(profile) / "python.stamp"
    inputs = [REPO_ROOT / "pyproject.toml"]

    if not force and not needs_refresh(stamp_path, inputs):
        print_step("Python dependencies are already up to date.")
        return venv_python

    run_command(
        [str(venv_python), "-m", "pip", "install", "--upgrade", "pip"],
        cwd=REPO_ROOT,
        description="Upgrade pip in the repo virtual environment",
    )
    run_command(
        [str(venv_python), "-m", "pip", "install", ".[dev]"],
        cwd=REPO_ROOT,
        description="Install Python project dependencies",
    )
    touch(stamp_path)
    return venv_python


def ensure_npm_dependencies(profile: PlatformProfile, *, force: bool) -> None:
    ensure_desktop_layout()
    npm_path = resolve_command("npm", profile)
    stamp_path = bootstrap_cache_dir(profile) / "desktop-npm.stamp"
    inputs = [DESKTOP_DIR / "package.json", DESKTOP_DIR / "package-lock.json"]
    node_modules_dir = DESKTOP_DIR / "node_modules"

    if not force and node_modules_dir.exists() and not needs_refresh(stamp_path, inputs):
        print_step("Desktop npm dependencies are already up to date.")
        return

    run_command(
        [npm_path, "install"],
        cwd=DESKTOP_DIR,
        description="Install desktop npm dependencies",
    )
    touch(stamp_path)


def ensure_cargo_dependencies(profile: PlatformProfile, *, force: bool) -> None:
    ensure_desktop_layout()
    cargo_path = resolve_command("cargo", profile)
    stamp_path = bootstrap_cache_dir(profile) / "desktop-cargo.stamp"
    inputs = [TAURI_DIR / "Cargo.toml", TAURI_DIR / "Cargo.lock"]

    if not force and not needs_refresh(stamp_path, inputs):
        print_step("Desktop Rust dependencies are already up to date.")
        return

    run_command(
        [cargo_path, "fetch", "--locked"],
        cwd=TAURI_DIR,
        description="Fetch desktop Rust dependencies",
    )
    touch(stamp_path)


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Bootstrap the HELM development environment for this clone."
    )
    mode_group = parser.add_mutually_exclusive_group()
    mode_group.add_argument(
        "--python-only",
        action="store_true",
        help="Install only the Python environment and Python dependencies.",
    )
    mode_group.add_argument(
        "--ui-only",
        action="store_true",
        help="Install Python and desktop npm dependencies, but skip Rust/Tauri fetches.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Re-run install steps even when HELM's bootstrap stamps are current.",
    )
    return parser


def print_next_steps(profile: PlatformProfile, venv_python: Path) -> None:
    print_step("Bootstrap complete.")
    print_step(f"Activate later if you want shell-local shortcuts: {profile.activation_hint}")
    print_step(f"Scan a repo: {format_command([str(venv_python), '-m', 'helm.cli', 'scan', '.'])}")
    print_step(f"Run the browser UI: {format_command([str(venv_python), '-m', 'invoke', 'ui'])}")
    print_step(
        f"Run the desktop app: {format_command([str(venv_python), '-m', 'invoke', 'desktop'])}"
    )


def main(argv: list[str] | None = None) -> int:
    ensure_supported_python()
    parser = build_argument_parser()
    args = parser.parse_args(argv)
    profile = get_platform_profile()
    phases = selected_phases(python_only=args.python_only, ui_only=args.ui_only)

    try:
        print_step(f"Detected OS: {profile.name}.")
        venv_python = ensure_python_dependencies(profile, force=args.force)
        if "npm" in phases:
            ensure_npm_dependencies(profile, force=args.force)
        if "cargo" in phases:
            ensure_cargo_dependencies(profile, force=args.force)
    except BootstrapError as exc:
        print(f"[helm bootstrap] {exc}", file=sys.stderr)
        return 1

    print_next_steps(profile, venv_python)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
