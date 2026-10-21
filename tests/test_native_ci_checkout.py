"""Exercise the actual Windows bootstrap shell with a local Git transport.

These portable fixtures test exact revision, credential lifetime and refusal.
They do not emulate Windows paths; the hosted Windows job validates those.
"""

import base64
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

import yaml


WORKFLOW = Path(__file__).resolve().parents[1] / ".github/workflows/execution-native.yml"


@unittest.skipIf(os.name == "nt", "POSIX transport fixture; Windows runs the actual bootstrap")
@unittest.skipUnless(shutil.which("git") and shutil.which("bash"), "Git and Bash required")
class NativeCheckoutTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.runner = self.root / "runner space – café"
        self.runner.mkdir()
        self.target = self.runner / "helm-native-123-1"
        self.output = self.root / "output"
        self.log = self.root / "git-calls.jsonl"
        self.real_git = shutil.which("git")
        self.fixture = self.root / "fixture"
        self.fixture.mkdir()
        self.git("init", "-b", "main", cwd=self.fixture)
        self.git("config", "user.name", "Synthetic CI fixture", cwd=self.fixture)
        self.git("config", "user.email", "ci-fixture@example.invalid", cwd=self.fixture)
        (self.fixture / "value.txt").write_text("first café\n", encoding="utf-8")
        self.git("add", "value.txt", cwd=self.fixture)
        self.git("commit", "-m", "first", cwd=self.fixture)
        self.expected = self.git("rev-parse", "HEAD", cwd=self.fixture).stdout.strip()
        (self.fixture / "value.txt").write_text("second\n", encoding="utf-8")
        self.git("commit", "-am", "second", cwd=self.fixture)
        self.other = self.git("rev-parse", "HEAD", cwd=self.fixture).stdout.strip()
        self.remote = self.root / "remote.git"
        self.git("clone", "--bare", str(self.fixture), str(self.remote), cwd=self.root)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.wrapper(
            "cygpath",
            "import sys; print(sys.argv[-1])\n",
        )
        self.wrapper(
            "git",
            """import json, os, subprocess, sys
args = sys.argv[1:]
kind = next((k for k in ('fetch', 'checkout', 'init', 'remote', 'rev-parse') if k in args), 'other')
header = os.environ.get('HELM_CI_AUTH_HEADER')
record = {'kind':kind, 'hasToken':'HELM_CI_CHECKOUT_TOKEN' in os.environ, 'hasHeader':header is not None, 'hasTrace':any(k in os.environ for k in ('GIT_TRACE','GIT_TRACE_PACKET','GIT_TRACE_CURL','GIT_CURL_VERBOSE'))}
with open(os.environ['FIXTURE_LOG'], 'a') as log:
    log.write(json.dumps(record)+'\\n')
if kind == 'fetch':
    assert header == os.environ['FIXTURE_AUTH']
    assert 'credential.helper=' in args
    assert '--config-env=http.https://github.com/.extraheader=HELM_CI_AUTH_HEADER' in args
    assert '--no-tags' in args and '--depth=1' in args
    if os.environ.get('FIXTURE_MODE') == 'fetch-failure':
        sys.exit(17)
    args[args.index('origin')] = os.environ['FIXTURE_REMOTE']
    if os.environ.get('FIXTURE_MODE') == 'wrong-sha':
        args[-1] = os.environ['FIXTURE_OTHER_SHA']
sys.exit(subprocess.run([os.environ['FIXTURE_GIT'], *args]).returncode)
""",
        )
        steps = yaml.safe_load(WORKFLOW.read_text())["jobs"]["execution"]["steps"]
        self.steps = steps
        self.bootstrap = next(s for s in steps if s.get("id") == "windows_source")
        self.script = self.root / "bootstrap.sh"
        self.script.write_text(self.bootstrap["run"])

    def wrapper(self, name, body):
        path = self.bin / name
        path.write_text(f"#!{sys.executable}\n" + body)
        path.chmod(0o700)

    def git(self, *args, cwd, check=True):
        return subprocess.run(
            [self.real_git, *args], cwd=cwd, text=True, capture_output=True, check=check
        )

    def run_bootstrap(self, **overrides):
        token = "SYNTHETIC_CHECKOUT_TOKEN_ONLY"
        env = dict(os.environ)
        env.update(
            PATH=str(self.bin) + os.pathsep + os.environ["PATH"],
            GITHUB_SERVER_URL="https://github.com",
            GITHUB_REPOSITORY="Snowiehawk/H.E.L.M.",
            GITHUB_SHA=self.expected,
            GITHUB_RUN_ID="123",
            GITHUB_RUN_ATTEMPT="1",
            GITHUB_OUTPUT=str(self.output),
            RUNNER_TEMP=str(self.runner),
            HELM_CI_CHECKOUT_TOKEN=token,
            GIT_TRACE="1",
            GIT_TRACE_PACKET="1",
            GIT_TRACE_CURL="1",
            GIT_CURL_VERBOSE="1",
            GIT_CONFIG_COUNT="1",
            GIT_CONFIG_KEY_0="core.autocrlf",
            GIT_CONFIG_VALUE_0="true",
            FIXTURE_GIT=self.real_git,
            FIXTURE_REMOTE=str(self.remote),
            FIXTURE_OTHER_SHA=self.other,
            FIXTURE_LOG=str(self.log),
            FIXTURE_AUTH="AUTHORIZATION: basic "
            + base64.b64encode(f"x-access-token:{token}".encode()).decode(),
        )
        env.update(overrides)
        result = subprocess.run(
            [shutil.which("bash"), str(self.script)],
            cwd=self.runner,
            env=env,
            text=True,
            capture_output=True,
            timeout=30,
        )
        self.assertNotIn(token, result.stdout + result.stderr)
        self.assertNotIn(env["FIXTURE_AUTH"], result.stdout + result.stderr)
        return result

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def test_exact_detached_revision_and_no_persisted_credentials(self):
        result = self.run_bootstrap()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            self.git("rev-parse", "HEAD", cwd=self.target).stdout.strip(), self.expected
        )
        self.assertNotEqual(self.expected, self.other)
        self.assertEqual(
            self.git("symbolic-ref", "-q", "HEAD", cwd=self.target, check=False).returncode, 1
        )
        self.assertEqual((self.target / "value.txt").read_bytes(), "first café\n".encode())
        self.assertEqual(self.output.read_text(), f"root={self.target}\n")
        self.assertEqual(
            self.git("remote", "get-url", "origin", cwd=self.target).stdout.strip(),
            "https://github.com/Snowiehawk/H.E.L.M..git",
        )
        config = (self.target / ".git/config").read_text()
        for forbidden in ("extraheader", "credential", "SYNTHETIC_CHECKOUT_TOKEN_ONLY"):
            self.assertNotIn(forbidden, config)
        calls = self.calls()
        self.assertFalse(any(c["hasToken"] for c in calls))
        self.assertFalse(any(c["hasTrace"] for c in calls))
        self.assertEqual([c["kind"] for c in calls if c["hasHeader"]], ["fetch"])
        self.assertTrue(any(c["kind"] == "checkout" for c in calls))

    def test_fetch_failure_never_checks_out_or_admits_source(self):
        result = self.run_bootstrap(FIXTURE_MODE="fetch-failure")
        self.assertEqual(result.returncode, 17)
        self.assertFalse(self.output.exists())
        self.assertFalse(any(c["kind"] == "checkout" for c in self.calls()))

    def test_different_fetched_commit_is_not_admitted(self):
        result = self.run_bootstrap(FIXTURE_MODE="wrong-sha")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.output.exists())
        self.assertNotEqual(
            self.git("rev-parse", "HEAD", cwd=self.target, check=False).returncode, 0
        )
        self.assertFalse(any(c["kind"] == "checkout" for c in self.calls()))

    def test_invalid_repository_sha_or_run_identity_refuses_before_git(self):
        for override in (
            {"GITHUB_SERVER_URL": "https://example.invalid"},
            {"GITHUB_REPOSITORY": "other/repo"},
            {"GITHUB_SHA": "refs/heads/main"},
            {"GITHUB_RUN_ID": "../other"},
            {"GITHUB_RUN_ATTEMPT": ""},
        ):
            with self.subTest(override=override):
                self.assertNotEqual(self.run_bootstrap(**override).returncode, 0)
                self.assertFalse(self.target.exists())
                self.assertFalse(self.log.exists())
                self.assertFalse(self.output.exists())

    def test_existing_directory_is_preserved(self):
        self.target.mkdir()
        sentinel = self.target / "keep.txt"
        sentinel.write_text("preserve")
        self.assertNotEqual(self.run_bootstrap().returncode, 0)
        self.assertEqual(sentinel.read_text(), "preserve")
        self.assertFalse(self.log.exists())

    def test_dangling_link_is_preserved(self):
        self.target.symlink_to(self.root / "absent", target_is_directory=True)
        self.assertNotEqual(self.run_bootstrap().returncode, 0)
        self.assertTrue(self.target.is_symlink())
        self.assertFalse(self.log.exists())

    def test_workflow_uses_safe_root_without_overriding_reserved_workspace(self):
        data = yaml.safe_load(WORKFLOW.read_text())["jobs"]["execution"]
        self.assertEqual(data["env"]["CARGO_BUILD_JOBS"], "1")
        self.assertEqual(yaml.safe_load(WORKFLOW.read_text())["permissions"], {"contents": "read"})
        self.assertEqual(self.bootstrap["working-directory"], "${{ runner.temp }}")
        self.assertEqual(self.bootstrap["if"], "runner.os == 'Windows'")
        for step in self.steps:
            if "run" in step and step is not self.bootstrap:
                self.assertIn("steps.windows_source.outputs.root", step["working-directory"])
            self.assertNotIn("GITHUB_WORKSPACE", step.get("env", {}))
            self.assertNotIn(
                "HELM_CI_CHECKOUT_TOKEN", step.get("env", {}) if step is not self.bootstrap else {}
            )
        caches = [s["with"]["cache"] for s in self.steps if "cache" in s.get("with", {})]
        self.assertEqual(len(caches), 2)
        self.assertTrue(all("runner.os != 'Windows'" in c for c in caches))


if __name__ == "__main__":
    unittest.main()
