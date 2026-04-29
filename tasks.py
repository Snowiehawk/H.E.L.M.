from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from invoke import Exit, task

REPO_ROOT = Path(__file__).resolve().parent
DESKTOP_DIR = REPO_ROOT / "apps" / "desktop"
TAURI_DIR = DESKTOP_DIR / "src-tauri"
BOOTSTRAP_SCRIPT = REPO_ROOT / "scripts" / "bootstrap.py"
AUDIT_SCRIPT = REPO_ROOT / "scripts" / "audit.py"
PYTHON_CHECK_PATHS = ["src", "tests", "scripts", "tasks.py"]
REQUIREMENTS_DIR = REPO_ROOT / "requirements"
PYTHON_LOCK_VERSION = (3, 9)
PYTHON_LOCK_FILES = (
    (REQUIREMENTS_DIR / "python-runtime.in", REQUIREMENTS_DIR / "python-runtime.txt"),
    (REQUIREMENTS_DIR / "python-dev.in", REQUIREMENTS_DIR / "python-dev.txt"),
)


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


def _same_python_tool(name: str) -> str:
    candidates = [name]
    if os.name == "nt":
        candidates = [f"{name}.exe", f"{name}.cmd", name]

    python_dir = Path(sys.executable).resolve().parent
    scripts_dirs = [python_dir]
    if os.name == "nt":
        scripts_dirs.append(python_dir / "Scripts")
    for candidate in candidates:
        for scripts_dir in scripts_dirs:
            local = scripts_dir / candidate
            if local.exists():
                return str(local)

    for candidate in candidates:
        resolved = shutil.which(candidate)
        if resolved:
            return resolved

    raise Exit(
        f"Required Python tool `{name}` was not found. "
        "Run `python -m pip install -r requirements/python-dev.txt`."
    )


def _command(name: str) -> str:
    candidates = [name]
    if os.name == "nt":
        candidates = [f"{name}.cmd", f"{name}.exe", name]

    for candidate in candidates:
        resolved = shutil.which(candidate)
        if resolved:
            return resolved

    raise Exit(f"Required command `{name}` was not found on PATH.")


def _npm() -> str:
    return _command("npm")


def _cargo() -> str:
    return _command("cargo")


def _run(command: list[str], *, cwd: Path = REPO_ROOT, env: dict[str, str] | None = None) -> None:
    print(f"Running: {' '.join(command)}")
    completed = subprocess.run(command, cwd=str(cwd), env=env, check=False)
    if completed.returncode:
        raise Exit(code=completed.returncode)


def _repo_relative_posix(path: Path) -> str:
    return path.relative_to(REPO_ROOT).as_posix()


def _ensure_python_lock_version() -> None:
    current = sys.version_info[:2]
    if current != PYTHON_LOCK_VERSION:
        expected = ".".join(str(part) for part in PYTHON_LOCK_VERSION)
        actual = ".".join(str(part) for part in current)
        raise Exit(
            "Python lockfiles must be generated and checked with the CI baseline "
            f"Python {expected}; current interpreter is Python {actual}."
        )


def _pip_compile_command(
    input_path: Path, output_path: Path, *, upgrade: bool = False
) -> list[str]:
    command = [
        sys.executable,
        "-m",
        "piptools",
        "compile",
        "--resolver=backtracking",
        "--output-file",
        _repo_relative_posix(output_path),
        _repo_relative_posix(input_path),
        "--newline=lf",
        "--allow-unsafe",
        "--strip-extras",
        "--no-annotate",
        "--no-emit-index-url",
        "--no-emit-trusted-host",
        "--no-emit-options",
        "--no-config",
    ]
    if upgrade:
        command.append("--upgrade")
    return command


def _pip_tools_env(cache_root: Path) -> dict[str, str]:
    env = os.environ.copy()
    env["PIP_TOOLS_CACHE_DIR"] = str(cache_root / "pip-tools")
    env["XDG_CACHE_HOME"] = str(cache_root / "xdg")
    if os.name == "nt":
        env["LOCALAPPDATA"] = str(cache_root / "localappdata")
    return env


def _compile_python_lock(
    input_path: Path,
    output_path: Path,
    *,
    cwd: Path = REPO_ROOT,
    upgrade: bool = False,
) -> None:
    with tempfile.TemporaryDirectory(prefix="helm-pip-tools-cache-") as cache_dir:
        _run(
            _pip_compile_command(input_path, output_path, upgrade=upgrade),
            cwd=cwd,
            env=_pip_tools_env(Path(cache_dir)),
        )


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


def _run_desktop_command(ctx, command: str, *, install: bool) -> None:
    if command == "npm run dev":
        _run_bootstrap(ctx, force=install, ui_only=True)
    else:
        _run_bootstrap(ctx, force=install)

    with ctx.cd(str(DESKTOP_DIR)):
        if os.name == "nt":
            _run_windows_desktop_command(command)
        else:
            ctx.run(command, env=_desktop_env(), pty=_pty_supported())


def _run_windows_desktop_command(command: str) -> None:
    process = subprocess.Popen(
        command,
        cwd=str(DESKTOP_DIR),
        env=_desktop_env(),
        shell=True,
    )

    try:
        return_code = process.wait()
    except KeyboardInterrupt:
        print("\nStopping desktop dev processes...")
        subprocess.run(
            ["taskkill", "/pid", str(process.pid), "/t", "/f"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        process.wait()
        return

    if return_code:
        raise Exit(code=return_code)


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
    """Install desktop npm dependencies with bootstrap-friendly npm install."""
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


@task(name="format-python")
def format_python(ctx) -> None:
    """Apply Python Ruff lint fixes and formatting."""
    ruff = _same_python_tool("ruff")
    _run([ruff, "check", "--fix", *PYTHON_CHECK_PATHS])
    _run([ruff, "format", *PYTHON_CHECK_PATHS])


@task(name="lock-python", help={"upgrade": "Ask pip-compile to upgrade all resolved pins."})
def lock_python(ctx, upgrade: bool = False) -> None:
    """Regenerate Python dependency lockfiles with the CI Python baseline."""
    _ensure_python_lock_version()
    for input_path, output_path in PYTHON_LOCK_FILES:
        _compile_python_lock(input_path, output_path, upgrade=upgrade)


@task(name="check-python-locks")
def check_python_locks(ctx) -> None:
    """Fail when committed Python lockfiles are stale."""
    _ensure_python_lock_version()
    with tempfile.TemporaryDirectory(prefix="helm-python-locks-") as tmp_dir:
        temp_root = Path(tmp_dir)
        for input_path, output_path in PYTHON_LOCK_FILES:
            temp_input = temp_root / _repo_relative_posix(input_path)
            temp_output = temp_root / _repo_relative_posix(output_path)
            temp_input.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(input_path, temp_input)
            if output_path.exists():
                shutil.copy2(output_path, temp_output)
            _compile_python_lock(input_path, output_path, cwd=temp_root)

            expected = output_path.read_bytes()
            actual = temp_output.read_bytes()
            if actual != expected:
                raise Exit(
                    f"{_repo_relative_posix(output_path)} is stale. "
                    "Run `python -m invoke lock-python` with Python 3.9."
                )


@task(name="check-python")
def check_python(ctx) -> None:
    """Run Python lint, format, and test gates."""
    check_python_locks(ctx)
    ruff = _same_python_tool("ruff")
    _run([ruff, "check", *PYTHON_CHECK_PATHS])
    _run([ruff, "format", "--check", *PYTHON_CHECK_PATHS])
    _run([sys.executable, "-m", "pytest"])


@task(name="format-desktop")
def format_desktop(ctx) -> None:
    """Apply frontend ESLint fixes and Prettier formatting."""
    npm = _npm()
    _run([npm, "run", "lint:fix"], cwd=DESKTOP_DIR)
    _run([npm, "run", "format"], cwd=DESKTOP_DIR)


@task(name="check-desktop")
def check_desktop(ctx) -> None:
    """Run frontend lint, format, tests, and build gates."""
    npm = _npm()
    _run([npm, "run", "lint"], cwd=DESKTOP_DIR)
    _run([npm, "run", "format:check"], cwd=DESKTOP_DIR)
    _run([npm, "test"], cwd=DESKTOP_DIR)
    _run([npm, "run", "build"], cwd=DESKTOP_DIR)


@task(name="format-tauri")
def format_tauri(ctx) -> None:
    """Apply Rust formatting in the Tauri shell."""
    _run([_cargo(), "fmt"], cwd=TAURI_DIR)


@task(name="check-tauri")
def check_tauri(ctx) -> None:
    """Run frontend build plus Rust format, Clippy, and cargo check gates."""
    npm = _npm()
    cargo = _cargo()
    _run([npm, "run", "build"], cwd=DESKTOP_DIR)
    _run([cargo, "fmt", "--", "--check"], cwd=TAURI_DIR)
    _run([cargo, "clippy", "--locked", "--", "-D", "warnings"], cwd=TAURI_DIR)
    _run([cargo, "check", "--locked"], cwd=TAURI_DIR)


@task(name="audit-python")
def audit_python(ctx) -> None:
    """Run the Python dependency audit with the HELM allowlist."""
    _run([sys.executable, str(AUDIT_SCRIPT), "python"])


@task(name="audit-desktop")
def audit_desktop(ctx) -> None:
    """Run the desktop npm dependency audit with the HELM allowlist."""
    _run([sys.executable, str(AUDIT_SCRIPT), "npm"])


@task(name="audit-tauri")
def audit_tauri(ctx) -> None:
    """Run the Tauri Cargo dependency audit with the HELM allowlist."""
    _run([sys.executable, str(AUDIT_SCRIPT), "cargo"])


@task
def format(ctx) -> None:
    """Apply all project formatters."""
    format_python(ctx)
    format_desktop(ctx)
    format_tauri(ctx)


@task
def check(ctx) -> None:
    """Run all non-audit quality gates."""
    check_python(ctx)
    check_desktop(ctx)
    check_tauri(ctx)


@task
def ci(ctx) -> None:
    """Run the local CI-equivalent checks and blocking audits."""
    check(ctx)
    audit_python(ctx)
    audit_desktop(ctx)
    audit_tauri(ctx)
