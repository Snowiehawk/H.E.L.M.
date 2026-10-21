"""#93 source-level no-autoexec sentinels on real analysis/session entry points.

There is no Python ``restore`` command. The desktop's explicit saved-workspace
restore uses the normal open/index path. A cold manager and fresh real stdio
workers below reopen that saved path; these are not native/UI restore evidence.
"""

from __future__ import annotations

import io
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from helm.ui import desktop_bridge
from helm.ui import project_git
from helm.ui.workspace_session import WorkspaceSessionManager


DOTENV_NAME = "HELM_PASSIVE_DOTENV_SENTINEL_93"
DOTENV_PARENT_VALUE = "parent-value-remains"
SOURCE_ROOT = Path(__file__).resolve().parents[1] / "src"


class PassiveCheckout:
    """All executable controls and effects belong only to this disposable root."""

    def __init__(self, directory: Path):
        self.root = directory / "untrusted checkout café"
        self.effects = directory / "effects"
        self.tools = directory / "tool shims"
        self.root.mkdir()
        self.effects.mkdir()
        self.tools.mkdir()
        self.write("execution_tripwire_93.py", self.python_marker("project-import"))
        self.write(
            "app.py",
            "import execution_tripwire_93\n\ndef run():\n    return 93\n",
        )
        for name in ("sitecustomize.py", "usercustomize.py", "conftest.py", "setup.py"):
            self.write(name, self.python_marker(name))
        shell = self.shell_marker("project-shell-startup")
        for name in (".profile", ".bashrc", ".bash_profile", ".zshrc", ".zshenv", ".envrc"):
            self.write(name, shell)
        self.write("install-project.sh", self.shell_marker("installer"), executable=True)
        self.write(
            ".git/hooks/post-checkout", self.shell_marker("git-post-checkout"), executable=True
        )
        self.write(".git/hooks/post-merge", self.shell_marker("git-post-merge"), executable=True)
        self.write(
            ".env",
            f"{DOTENV_NAME}=dotenv-must-not-replace-parent\n"
            f"HELM_PASSIVE_COMMAND_93=$(printf ran > {shlex.quote(str(self.effects / 'dotenv-command.ran'))})\n",
        )
        self.write(".python-version", "execution-tripwire-version-93\n")
        self.write(".tool-versions", "python execution-tripwire-version-93\n")
        self.write(
            "pyproject.toml",
            '[build-system]\nrequires = []\nbuild-backend = "execution_tripwire_93"\n'
            '[project]\nname = "passive-sentinel-93"\nversion = "0.0.0"\n',
        )
        self.write(
            "package.json",
            json.dumps(
                {
                    "name": "passive-sentinel-93",
                    "scripts": {
                        name: "sh install-project.sh"
                        for name in ("preinstall", "postinstall", "prepare", "start", "test")
                    },
                }
            ),
        )
        self.write("Makefile", "all:\n\tsh install-project.sh\n")
        self.write("tox.ini", "[testenv]\ncommands = sh install-project.sh\n")
        self.write("requirements.txt", ".\n")
        for name in (
            "python",
            "python3",
            "pip",
            "pip3",
            "uv",
            "poetry",
            "pdm",
            "conda",
            "pyenv",
            "asdf",
            "mise",
            "node",
            "npm",
            "npx",
            "pnpm",
            "yarn",
            "bash",
            "zsh",
            "sh",
        ):
            path = self.tools / name
            path.write_text(self.shell_marker(f"tool-{name}") + "exit 93\n", encoding="utf-8")
            path.chmod(0o755)
            # Windows PATH discovery uses PATHEXT. These are controls only, not
            # a claim that the native Windows shell/PTY was exercised.
            (self.tools / f"{name}.cmd").write_text(
                f'@echo ran>"{self.effects / f"tool-{name}.ran"}"\r\n@exit /b 93\r\n',
                encoding="utf-8",
            )
        self.original_files = {
            path.relative_to(self.root): path.read_bytes()
            for path in self.root.rglob("*")
            if path.is_file()
        }

    def write(self, name: str, content: str, *, executable: bool = False) -> Path:
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        if executable:
            path.chmod(0o755)
        return path

    def python_marker(self, name: str) -> str:
        return (
            "from pathlib import Path\n"
            f"Path({str(self.effects / f'{name}.ran')!r}).write_text('ran', encoding='utf-8')\n"
        )

    def shell_marker(self, name: str) -> str:
        return f"#!/bin/sh\nprintf ran > {shlex.quote(str(self.effects / f'{name}.ran'))}\n"

    def environment(self) -> dict[str, str]:
        return {
            **os.environ,
            "PATH": str(self.tools) + os.pathsep + os.environ.get("PATH", ""),
            "HOME": str(self.root),
            "ZDOTDIR": str(self.root),
            "BASH_ENV": str(self.root / ".bashrc"),
            "ENV": str(self.root / ".profile"),
            "PYTHONSTARTUP": str(self.root / "sitecustomize.py"),
            DOTENV_NAME: DOTENV_PARENT_VALUE,
        }


class PassiveProjectOpenTests(unittest.TestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.checkout = PassiveCheckout(Path(directory.name))

    def assert_passive(self) -> None:
        self.assertEqual(list(self.checkout.effects.iterdir()), [], "A project sentinel executed")
        for relative, original in self.checkout.original_files.items():
            with self.subTest(unchanged=str(relative)):
                self.assertEqual((self.checkout.root / relative).read_bytes(), original)

    def test_real_session_open_reuse_reindex_and_cold_saved_path_reopen_are_passive(self) -> None:
        manager = WorkspaceSessionManager()
        saved_path = str(self.checkout.root)
        with mock.patch.dict(os.environ, self.checkout.environment()):
            opened = manager.ensure_session(saved_path)
            self.assertIs(manager.ensure_session(saved_path), opened)
            self.assertGreater(opened.build_payload()["summary"]["module_count"], 0)
            self.assert_passive()
            manager.full_resync(saved_path)
            self.assert_passive()
            manager.invalidate(saved_path)
            self.assertIsNot(manager.ensure_session(saved_path), opened)
            self.assert_passive()
            cold = WorkspaceSessionManager().ensure_session(saved_path)
            self.assertEqual(cold.root_path, self.checkout.root.resolve())
            self.assert_passive()
            self.assertEqual(os.environ[DOTENV_NAME], DOTENV_PARENT_VALUE)
        self.assertNotIn("execution_tripwire_93", sys.modules)

    def test_fresh_real_stdio_workers_reopen_saved_path_without_startup_or_tools(self) -> None:
        # Same isolated-module bootstrap as Rust's packaged backend. The final
        # assertion only observes environment after the real worker shuts down.
        bootstrap = (
            "import os, runpy, sys\n"
            "sys.path.insert(0, sys.argv.pop(1))\n"
            "try:\n"
            "    runpy.run_module('helm.ui.desktop_bridge', run_name='__main__')\n"
            "except SystemExit as finished:\n"
            "    if finished.code not in (None, 0):\n"
            "        raise\n"
            f"assert os.environ[{DOTENV_NAME!r}] == {DOTENV_PARENT_VALUE!r}\n"
        )
        requests = [
            {"id": 1, "command": "scan", "params": {"repo": str(self.checkout.root)}},
            {"id": 2, "command": "full-resync", "params": {"repo": str(self.checkout.root)}},
            {"id": 3, "command": "shutdown", "params": {}},
        ]
        for cold_start in range(2):
            with self.subTest(cold_start=cold_start):
                result = subprocess.run(
                    [sys.executable, "-I", "-B", "-c", bootstrap, str(SOURCE_ROOT), "serve"],
                    input="".join(json.dumps(request) + "\n" for request in requests),
                    capture_output=True,
                    text=True,
                    timeout=20,
                    cwd=self.checkout.root,
                    env=self.checkout.environment(),
                    check=False,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                replies = [json.loads(line) for line in result.stdout.splitlines()]
                self.assertEqual([reply["id"] for reply in replies], [1, 2, 3])
                self.assertTrue(all(reply["ok"] for reply in replies), replies)
                self.assertGreater(replies[0]["result"]["summary"]["module_count"], 0)
                self.assert_passive()

    def test_project_import_and_shell_sentinels_have_real_positive_controls(self) -> None:
        imported = subprocess.run(
            [
                sys.executable,
                "-I",
                "-B",
                "-c",
                "import sys;sys.path.insert(0,sys.argv[1]);import app",
                str(self.checkout.root),
            ],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        self.assertEqual(imported.returncode, 0, imported.stderr)
        self.assertTrue((self.checkout.effects / "project-import.ran").exists())
        if os.name == "posix":
            subprocess.run(["/bin/sh", str(self.checkout.root / ".profile")], timeout=5, check=True)
            self.assertTrue((self.checkout.effects / "project-shell-startup.ran").exists())
            tool = subprocess.run([str(self.checkout.tools / "npm")], timeout=5, check=False)
            self.assertEqual(tool.returncode, 93)
            self.assertTrue((self.checkout.effects / "tool-npm.ran").exists())

    def test_automatic_project_inspection_cannot_execute_repository_fsmonitor_hook(self) -> None:
        git = shutil.which("git")
        if git is None:
            self.skipTest("Git is unavailable; real repository-hook coverage requires Git")
        # Setup must not inherit machine hooks/filters, and only fixture-local
        # config is changed. No network, credential, or machine policy is changed.
        environment = {
            key: value for key, value in os.environ.items() if not key.startswith("GIT_")
        }
        environment.update({"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull})

        def fixture_git(*args: str) -> None:
            result = subprocess.run(
                [
                    git,
                    "-c",
                    "core.fsmonitor=false",
                    "-c",
                    "core.hooksPath=",
                    "-C",
                    str(self.checkout.root),
                    *args,
                ],
                env=environment,
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)

        fixture_git("init", "--quiet")
        fixture_git("add", "--", "app.py")
        hook = self.checkout.write(
            ".git/hooks/query-fsmonitor",
            self.checkout.shell_marker("git-fsmonitor") + "printf '%s\\0' sentinel-token /\n",
            executable=True,
        )
        # Git treats the hook value as a shell command. A relative path keeps
        # this control executable when the checkout's absolute path has spaces.
        fixture_git("config", "core.fsmonitor", hook.relative_to(self.checkout.root).as_posix())
        # Verify this Git/platform actually supports the executable hook control.
        # Absence on an unsupported host is an explicit skip, never a false pass.
        control = subprocess.run(
            [git, "-C", str(self.checkout.root), "status", "--porcelain=v1"],
            env=environment,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        self.assertEqual(control.returncode, 0, control.stderr)
        marker = self.checkout.effects / "git-fsmonitor.ran"
        if not marker.exists():
            self.skipTest(
                "This Git/platform did not execute the fsmonitor positive control; "
                f"Git stderr: {control.stderr.strip()!r}"
            )
        marker.unlink()
        incoming = io.StringIO(
            json.dumps(
                {
                    "id": 1,
                    "command": "inspect-project",
                    "params": {"repo": str(self.checkout.root)},
                }
            )
            + "\n"
        )
        outgoing = io.StringIO()
        # This is the real command automatically used by project-context
        # inspection on open, not a simulated manifest parser or a fake restore.
        with mock.patch.dict(os.environ, environment, clear=True):
            self.assertEqual(desktop_bridge.run_worker(incoming, outgoing), 0)
        reply = json.loads(outgoing.getvalue())
        self.assertTrue(reply["ok"], reply)
        self.assertFalse(marker.exists(), "Passive inspect-project executed core.fsmonitor")

    def test_automatic_project_inspection_cannot_execute_configured_clean_filter(self) -> None:
        git = shutil.which("git")
        if git is None:
            self.skipTest("Git is unavailable; real repository-filter coverage requires Git")
        environment = {
            key: value for key, value in os.environ.items() if not key.startswith("GIT_")
        }
        environment.update({"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull})

        def fixture_git(*args: str) -> None:
            result = subprocess.run(
                [
                    git,
                    "-c",
                    "core.fsmonitor=false",
                    "-c",
                    "core.hooksPath=",
                    "-C",
                    str(self.checkout.root),
                    *args,
                ],
                env=environment,
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)

        fixture_git("init", "--quiet")
        fixture_git("add", "--", "app.py")
        self.checkout.write(".gitattributes", "app.py filter=passive-sentinel\n")
        self.checkout.write(
            ".git/hooks/clean-filter-93",
            self.checkout.shell_marker("git-clean-filter") + "cat\n",
            executable=True,
        )
        fixture_git("config", "filter.passive-sentinel.clean", "sh .git/hooks/clean-filter-93")
        fixture_git("config", "filter.passive-sentinel.required", "true")
        # A changed length lets Git declare the file dirty from stat alone,
        # bypassing normalization. Keep the indexed length and change mtime so
        # status must hash changed content and exercise the configured filter.
        app = self.checkout.root / "app.py"
        indexed_stat = app.stat()
        app.write_text(
            app.read_text(encoding="utf-8").replace("return 93", "return 94"), encoding="utf-8"
        )
        os.utime(app, ns=(indexed_stat.st_atime_ns, indexed_stat.st_mtime_ns + 2_000_000_000))
        control = subprocess.run(
            [git, "-C", str(self.checkout.root), "status", "--porcelain=v1"],
            env=environment,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        self.assertEqual(control.returncode, 0, control.stderr)
        marker = self.checkout.effects / "git-clean-filter.ran"
        self.assertTrue(marker.exists(), "The real Git clean-filter control did not execute")
        marker.unlink()
        before_app = app.read_bytes()
        before_config = (self.checkout.root / ".git/config").read_bytes()
        incoming = io.StringIO(
            json.dumps(
                {
                    "id": 1,
                    "command": "inspect-project",
                    "params": {"repo": str(self.checkout.root)},
                }
            )
            + "\n"
        )
        outgoing = io.StringIO()
        with mock.patch.dict(os.environ, environment, clear=True):
            self.assertEqual(desktop_bridge.run_worker(incoming, outgoing), 0)
        reply = json.loads(outgoing.getvalue())
        self.assertFalse(reply["ok"], reply)
        self.assertIn("tracked paths with clean/process filters", reply["error"])
        self.assertFalse(
            marker.exists(), "Passive inspect-project executed a configured clean filter"
        )
        self.assertEqual(app.read_bytes(), before_app)
        self.assertEqual((self.checkout.root / ".git/config").read_bytes(), before_config)

    def test_automatic_project_inspection_refuses_configured_process_filter(self) -> None:
        git = shutil.which("git")
        if git is None:
            self.skipTest("Git is unavailable; real process-filter coverage requires Git")
        environment = {
            key: value for key, value in os.environ.items() if not key.startswith("GIT_")
        }
        environment.update({"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull})

        def fixture_git(*args: str) -> None:
            result = subprocess.run(
                [
                    git,
                    "-c",
                    "core.fsmonitor=false",
                    "-c",
                    "core.hooksPath=",
                    "-C",
                    str(self.checkout.root),
                    *args,
                ],
                env=environment,
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)

        fixture_git("init", "--quiet")
        fixture_git("add", "--", "app.py")
        self.checkout.write(".gitattributes", "app.py filter=passive-sentinel\n")
        marker = self.checkout.effects / "git-process-filter.ran"
        process_filter = self.checkout.write(
            ".git/hooks/process-filter-93.py",
            "import sys\nfrom pathlib import Path\n"
            f"Path({str(marker)!r}).write_text('ran', encoding='utf-8')\n"
            "source = sys.stdin.buffer\nsink = sys.stdout.buffer\n"
            "def read_group():\n"
            "    packets = []\n"
            "    while True:\n"
            "        header = source.read(4)\n"
            "        if not header:\n"
            "            return None\n"
            "        length = int(header, 16)\n"
            "        if length == 0:\n"
            "            return packets\n"
            "        packets.append(source.read(length - 4))\n"
            "def write_group(packets):\n"
            "    for packet in packets:\n"
            "        sink.write(('%04x' % (len(packet) + 4)).encode() + packet)\n"
            "    sink.write(b'0000')\n    sink.flush()\n"
            "assert read_group() == [b'git-filter-client\\n', b'version=2\\n']\n"
            "write_group([b'git-filter-server\\n', b'version=2\\n'])\n"
            "assert b'capability=clean\\n' in read_group()\n"
            "write_group([b'capability=clean\\n'])\n"
            "while True:\n"
            "    headers = read_group()\n"
            "    if headers is None:\n"
            "        break\n"
            "    assert b'command=clean\\n' in headers\n"
            "    content = read_group()\n"
            "    write_group([b'status=success\\n'])\n"
            "    write_group(content)\n"
            "    write_group([])\n",
        )
        command = f"{shlex.quote(sys.executable)} -I -B {shlex.quote(str(process_filter))}"
        fixture_git("config", "filter.passive-sentinel.process", command)
        fixture_git("config", "filter.passive-sentinel.required", "true")
        app = self.checkout.root / "app.py"
        indexed_stat = app.stat()
        app.write_text(
            app.read_text(encoding="utf-8").replace("return 93", "return 94"), encoding="utf-8"
        )
        os.utime(app, ns=(indexed_stat.st_atime_ns, indexed_stat.st_mtime_ns + 2_000_000_000))
        control = subprocess.run(
            [git, "-C", str(self.checkout.root), "status", "--porcelain=v1"],
            env=environment,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        self.assertEqual(control.returncode, 0, control.stderr)
        self.assertTrue(marker.exists(), "The real Git process-filter control did not execute")
        marker.unlink()
        before_app = app.read_bytes()
        before_config = (self.checkout.root / ".git/config").read_bytes()
        incoming = io.StringIO(
            json.dumps(
                {
                    "id": 1,
                    "command": "inspect-project",
                    "params": {"repo": str(self.checkout.root)},
                }
            )
            + "\n"
        )
        outgoing = io.StringIO()
        with mock.patch.dict(os.environ, environment, clear=True):
            self.assertEqual(desktop_bridge.run_worker(incoming, outgoing), 0)
        reply = json.loads(outgoing.getvalue())
        self.assertFalse(reply["ok"], reply)
        self.assertIn("tracked paths with clean/process filters", reply["error"])
        self.assertFalse(
            marker.exists(), "Passive inspect-project executed a configured process filter"
        )
        self.assertEqual(app.read_bytes(), before_app)
        self.assertEqual((self.checkout.root / ".git/config").read_bytes(), before_config)

    def test_passive_root_status_does_not_recurse_into_populated_submodule_filters(self) -> None:
        git = shutil.which("git")
        if git is None:
            self.skipTest("Git is unavailable; populated-submodule coverage requires Git")
        environment = {
            key: value for key, value in os.environ.items() if not key.startswith("GIT_")
        }
        environment.update({"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull})

        def fixture_git(root: Path, *args: str) -> None:
            result = subprocess.run(
                [
                    git,
                    "-c",
                    "core.fsmonitor=false",
                    "-c",
                    "core.hooksPath=",
                    "-C",
                    str(root),
                    *args,
                ],
                env=environment,
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)

        root = self.checkout.root
        child = root / "child"
        child.mkdir()
        fixture_git(root, "init", "--quiet")
        fixture_git(child, "init", "--quiet")
        app = child / "child.py"
        app.write_text("VALUE = 93\n", encoding="utf-8")
        (child / ".gitattributes").write_text(
            "child.py filter=passive-sentinel\n", encoding="utf-8"
        )
        fixture_git(child, "add", "--", "child.py", ".gitattributes")
        fixture_git(
            child,
            "-c",
            "user.name=Synthetic Test",
            "-c",
            "user.email=synthetic@example.invalid",
            "commit",
            "--quiet",
            "-m",
            "child fixture",
        )
        self.checkout.write(".gitmodules", '[submodule "child"]\n\tpath = child\n\turl = ./child\n')
        fixture_git(root, "config", "submodule.child.active", "true")
        fixture_git(root, "add", "--", "app.py", "child", ".gitmodules")
        fixture_git(
            root,
            "-c",
            "user.name=Synthetic Test",
            "-c",
            "user.email=synthetic@example.invalid",
            "commit",
            "--quiet",
            "-m",
            "parent fixture",
        )
        hook = child / ".git/hooks/clean-filter-93"
        hook.write_text(
            self.checkout.shell_marker("submodule-clean-filter") + "cat\n", encoding="utf-8"
        )
        hook.chmod(0o755)
        fixture_git(
            child, "config", "filter.passive-sentinel.clean", "sh .git/hooks/clean-filter-93"
        )
        fixture_git(child, "config", "filter.passive-sentinel.required", "true")
        indexed_stat = app.stat()
        app.write_text("VALUE = 94\n", encoding="utf-8")
        os.utime(app, ns=(indexed_stat.st_atime_ns, indexed_stat.st_mtime_ns + 2_000_000_000))
        # This positive control must execute via the actual parent status, not
        # merely a separate child command, to prove recursive helper eligibility.
        control = subprocess.run(
            [git, "-C", str(root), "status", "--porcelain=v1"],
            env=environment,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        self.assertEqual(control.returncode, 0, control.stderr)
        marker = self.checkout.effects / "submodule-clean-filter.ran"
        self.assertTrue(
            marker.exists(), "Parent Git status did not execute the populated-child control"
        )
        marker.unlink()
        before_app = app.read_bytes()
        before_config = (child / ".git/config").read_bytes()
        incoming = io.StringIO(
            json.dumps(
                {
                    "id": 1,
                    "command": "inspect-project",
                    "params": {"repo": str(root)},
                }
            )
            + "\n"
        )
        outgoing = io.StringIO()
        with mock.patch.dict(os.environ, environment, clear=True):
            self.assertEqual(desktop_bridge.run_worker(incoming, outgoing), 0)
        reply = json.loads(outgoing.getvalue())
        self.assertTrue(reply["ok"], reply)
        self.assertTrue(any("submodules" in reason for reason in reply["result"]["blocked"]))
        self.assertFalse(marker.exists(), "Passive parent inspection executed a submodule filter")
        self.assertEqual(app.read_bytes(), before_app)
        self.assertEqual((child / ".git/config").read_bytes(), before_config)

    def test_filter_config_lookup_distinguishes_no_match_from_error_before_status(self) -> None:
        for exit_code in (1, 2, 128):
            with self.subTest(exit_code=exit_code):
                process = mock.Mock(returncode=exit_code)
                process.communicate.return_value = (b"", None)
                with mock.patch.object(
                    project_git.subprocess, "Popen", return_value=process
                ) as launch:
                    if exit_code == 1:
                        self.assertEqual(project_git._filter_keys(self.checkout.root), b"")
                    else:
                        with self.assertRaises(project_git.GitExecutionError):
                            project_git._passive_status(self.checkout.root)
                    self.assertEqual(launch.call_count, 1)
                    self.assertNotIn("status", launch.call_args.args[0])

    def test_observed_filter_config_drift_refuses_cleanliness_admission(self) -> None:
        with mock.patch.object(
            project_git,
            "_git",
            side_effect=[
                b"",
                b"app.py\0",
                b"app.py\0filter\0unspecified\0",
                b"",
                b"filter.new-driver.process\0",
            ],
        ) as git:
            with self.assertRaisesRegex(
                project_git.GitExecutionError, "configuration or attributes changed"
            ):
                project_git._passive_status(self.checkout.root)
        self.assertIn("--ignore-submodules=all", git.call_args_list[3].args)

    def test_unused_global_filter_definition_allows_passive_inspection(self) -> None:
        git = shutil.which("git")
        if git is None:
            self.skipTest("Git is unavailable; unused-global-filter coverage requires Git")
        environment = {
            key: value for key, value in os.environ.items() if not key.startswith("GIT_")
        }
        environment.update({"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull})
        special = self.checkout.write("--option-like\nü.py", "VALUE = 93\n")
        for args in (("init", "--quiet"), ("add", "--", "app.py", special.name)):
            result = subprocess.run(
                [
                    git,
                    "-c",
                    "core.fsmonitor=false",
                    "-c",
                    "core.hooksPath=",
                    "-C",
                    str(self.checkout.root),
                    *args,
                ],
                env=environment,
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
        self.checkout.write(
            ".git/hooks/unused-global-filter-93",
            self.checkout.shell_marker("unused-global-filter") + "cat\n",
            executable=True,
        )
        global_config = self.checkout.effects.parent / "synthetic-global-gitconfig"
        global_config.write_text(
            '[filter "unused-sentinel"]\n'
            "\tclean = sh .git/hooks/unused-global-filter-93\n"
            "\tprocess = sh .git/hooks/unused-global-filter-93\n"
            "\trequired = true\n",
            encoding="utf-8",
        )
        environment["GIT_CONFIG_GLOBAL"] = str(global_config)
        before_config = global_config.read_bytes()
        incoming = io.StringIO(
            json.dumps(
                {
                    "id": 1,
                    "command": "inspect-project",
                    "params": {"repo": str(self.checkout.root)},
                }
            )
            + "\n"
        )
        outgoing = io.StringIO()
        with mock.patch.dict(os.environ, environment, clear=True):
            self.assertEqual(desktop_bridge.run_worker(incoming, outgoing), 0)
        reply = json.loads(outgoing.getvalue())
        self.assertTrue(reply["ok"], reply)
        self.assertFalse((self.checkout.effects / "unused-global-filter.ran").exists())
        self.assertEqual(global_config.read_bytes(), before_config)
        self.assertEqual(special.read_text(encoding="utf-8"), "VALUE = 93\n")

    def test_attribute_input_bounds_and_malformed_responses_refuse_before_status(self) -> None:
        for paths in (b"missing-terminator", b"a\0" * 4):
            with (
                self.subTest(paths=paths),
                mock.patch.object(project_git, "GIT_ATTRIBUTE_PATH_LIMIT", 3),
                mock.patch.object(project_git, "_git", return_value=paths) as git,
            ):
                with self.assertRaises(project_git.GitExecutionError):
                    project_git._filter_attributes(self.checkout.root)
                self.assertEqual(git.call_count, 1)
        for attributes in (b"a\0filter\0unspecified", b"a\0other\0unspecified\0", b""):
            with (
                self.subTest(attributes=attributes),
                mock.patch.object(project_git, "_git", side_effect=[b"a\0", attributes]),
            ):
                with self.assertRaises(project_git.GitExecutionError):
                    project_git._filter_attributes(self.checkout.root)
        with (
            mock.patch.object(project_git, "GIT_ATTRIBUTE_INPUT_LIMIT", 2),
            mock.patch.object(project_git.subprocess, "Popen") as launch,
        ):
            with self.assertRaises(project_git.GitExecutionError):
                project_git._git(self.checkout.root, "check-attr", input_bytes=b"abc")
            launch.assert_not_called()


if __name__ == "__main__":
    unittest.main()
