"""Disposable real-Git fixtures for the shared-project mutation boundary."""

import subprocess
import os
import shlex
import time
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch
from helm.ui.project_git import github_identity, inspect_project, switch_branch


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args], stderr=subprocess.DEVNULL)


class ProjectGitTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="helm project ü ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        git(self.root, "init", "-b", "dev")
        git(self.root, "config", "user.name", "Synthetic Test")
        git(self.root, "config", "user.email", "synthetic@example.invalid")
        (self.root / "sample.py").write_text("def original(): pass\n")
        git(self.root, "add", ".")
        git(self.root, "commit", "-m", "fixture")
        git(self.root, "branch", "other")

    def test_normalization_preserves_trailing_dot_and_fork_identity(self):
        for url in [
            "https://github.com/Owner/H.E.L.M..git",
            "git@github.com:Owner/H.E.L.M..git",
            "ssh://git@github.com/Owner/H.E.L.M..git",
        ]:
            self.assertEqual(github_identity(url), "owner/h.e.l.m.")
        self.assertNotEqual(
            github_identity("https://github.com/fork/repo"),
            github_identity("https://github.com/upstream/repo"),
        )
        for url in [
            "https://secret@github.com/owner/repo",
            "ssh://token@github.com/owner/repo",
            "https://other.invalid/owner/repo",
            "https://github.com/owner/repo?token=secret",
            "https://github.com/owner/..",
            "https://github.com/owner/repo/extra",
        ]:
            self.assertIsNone(github_identity(url))

    def test_inspects_distinct_staged_unstaged_untracked_and_redacts_remote(self):
        git(self.root, "remote", "add", "origin", "https://do-not-return@github.com/example/repo")
        git(self.root, "remote", "add", "upstream", "git@github.com:example/upstream.git")
        (self.root / "sample.py").write_text("staged\n")
        git(self.root, "add", "sample.py")
        (self.root / "sample.py").write_text("unstaged\n")
        (self.root / "new\nquoted ü.py").write_text("untracked\n")
        info = inspect_project(str(self.root))
        self.assertEqual((info["staged"], info["unstaged"], info["untracked"]), (1, 1, 1))
        self.assertNotIn("do-not-return", repr(info))
        self.assertIsNone(info["remotes"][0]["repository"])
        self.assertEqual(info["remotes"][1]["repository"], "example/upstream")

    def test_actual_clean_switch_reconciles_head_and_branch_specific_files(self):
        git(self.root, "switch", "other")
        (self.root / "other.py").write_text("def other_branch(): pass\n")
        git(self.root, "add", ".")
        git(self.root, "commit", "-m", "other")
        expected_head = git(self.root, "rev-parse", "HEAD").decode().strip()
        git(self.root, "switch", "dev")
        before = inspect_project(str(self.root))
        result = switch_branch(str(self.root), "other", before["fingerprint"])
        self.assertEqual(result["outcome"], "switched")
        self.assertEqual(result["actual"]["branch"], "other")
        self.assertEqual(result["actual"]["head"], expected_head)
        self.assertTrue((self.root / "other.py").exists())
        self.assertEqual(git(self.root, "status", "--porcelain"), b"")

    def test_each_dirty_state_and_stale_snapshot_refuses_without_loss(self):
        original = (self.root / "sample.py").read_bytes()
        before = inspect_project(str(self.root))
        (self.root / "sample.py").write_bytes(original + b"# unsaved git work\n")
        for staged in [False, True]:
            if staged:
                git(self.root, "add", ".")
            dirty = inspect_project(str(self.root))
            with self.assertRaises(ValueError):
                switch_branch(str(self.root), "other", dirty["fingerprint"])
            self.assertEqual(git(self.root, "branch", "--show-current").strip(), b"dev")
            self.assertTrue(
                (self.root / "sample.py").read_bytes().endswith(b"# unsaved git work\n")
            )
        with self.assertRaisesRegex(ValueError, "changed"):
            switch_branch(str(self.root), "other", before["fingerprint"])

    def test_untracked_and_missing_branch_refuse(self):
        info = inspect_project(str(self.root))
        with self.assertRaisesRegex(ValueError, "existing local branch"):
            switch_branch(str(self.root), "origin/remote-only", info["fingerprint"])
        (self.root / "untracked").write_text("preserve")
        info = inspect_project(str(self.root))
        with self.assertRaises(ValueError):
            switch_branch(str(self.root), "other", info["fingerprint"])
        self.assertEqual((self.root / "untracked").read_text(), "preserve")

    def test_rename_status_and_operation_lock_are_not_clean(self):
        git(self.root, "mv", "sample.py", "renamed ü.py")
        self.assertEqual(inspect_project(str(self.root))["staged"], 1)
        (self.root / ".git" / "MERGE_HEAD").write_text("not-a-real-merge")
        self.assertIn("MERGE_HEAD", inspect_project(str(self.root))["operations"])

    def test_detached_submodule_and_worktree_refusals(self):
        git(self.root, "switch", "--detach")
        self.assertTrue(
            any("Detached" in message for message in inspect_project(str(self.root))["blocked"])
        )
        git(self.root, "switch", "dev")
        (self.root / ".gitmodules").write_text("")
        self.assertTrue(
            any("submodules" in message for message in inspect_project(str(self.root))["blocked"])
        )
        (self.root / ".gitmodules").unlink()
        linked = self.root.parent / (self.root.name + "-worktree")
        self.addCleanup(lambda: git(self.root, "worktree", "remove", str(linked)))
        git(self.root, "worktree", "add", str(linked), "other")
        self.assertTrue(
            any("worktree" in message for message in inspect_project(str(self.root))["blocked"])
        )
        self.assertTrue(
            any("worktree" in message for message in inspect_project(str(linked))["blocked"])
        )

    def test_failed_git_probe_is_unknown_not_clean_and_hides_stderr(self):
        with patch(
            "helm.ui.project_git.subprocess.Popen",
            side_effect=OSError("secret internal diagnostic"),
        ):
            with self.assertRaisesRegex(ValueError, "unknown") as error:
                inspect_project(str(self.root))
            self.assertNotIn("secret", str(error.exception))

    def test_non_repo_nested_root_and_missing_paths_refuse(self):
        nested = self.root / "nested"
        nested.mkdir()
        with self.assertRaisesRegex(ValueError, "root"):
            inspect_project(str(nested))
        with self.assertRaises(OSError):
            inspect_project(str(nested / "missing"))

    def test_worker_dispatch_invalidates_previous_branch_session(self):
        from helm.ui.desktop_bridge import _handle_worker_command, _SESSION_MANAGER

        previous = _SESSION_MANAGER.ensure_session(str(self.root))
        info = _handle_worker_command("inspect-project", {"repo": str(self.root)})
        result = _handle_worker_command(
            "switch-project-branch",
            {"repo": str(self.root), "branch": "other", "fingerprint": info["fingerprint"]},
        )
        self.assertEqual(result["actual"]["branch"], "other")
        self.assertIsNot(_SESSION_MANAGER.ensure_session(str(self.root)), previous)
        _SESSION_MANAGER.invalidate(str(self.root))

    def test_changed_remote_invalidates_admission_and_malformed_ports_never_escape(self):
        info = inspect_project(str(self.root))
        git(self.root, "remote", "add", "origin", "https://github.com/example/repo")
        with self.assertRaisesRegex(ValueError, "changed"):
            switch_branch(str(self.root), "other", info["fingerprint"])
        self.assertIsNone(github_identity("https://github.com:private-token/example/repo"))

    def assert_ignored_path_collision_is_preserved(self, relative_path):
        ignored_path = self.root / relative_path
        ignore_rule = relative_path.split("/")[0]
        (self.root / ".gitignore").write_text(f"/{ignore_rule}\n")
        git(self.root, "add", ".gitignore")
        git(self.root, "commit", "-m", "ignore local-only fixture")
        git(self.root, "switch", "other")
        ignored_path.parent.mkdir(parents=True, exist_ok=True)
        ignored_path.write_bytes(b"target branch tracked bytes\n")
        git(self.root, "add", "--", relative_path)
        git(self.root, "commit", "-m", "track colliding fixture on target")
        git(self.root, "switch", "dev")
        ignored_path.parent.mkdir(parents=True, exist_ok=True)
        original = b"synthetic local-only bytes\r\n\x00preserve exactly\xff"
        ignored_path.write_bytes(original)
        before = inspect_project(str(self.root))
        self.assertEqual((before["staged"], before["unstaged"], before["untracked"]), (0, 0, 0))
        self.assertEqual(
            git(self.root, "check-ignore", "--", relative_path).strip(), relative_path.encode()
        )

        result = switch_branch(str(self.root), "other", before["fingerprint"])

        self.assertEqual(result["outcome"], "failed")
        self.assertEqual(result["actual"]["branch"], "dev")
        self.assertEqual(result["actual"]["head"], before["head"])
        self.assertEqual(result["actual"]["fingerprint"], before["fingerprint"])
        self.assertEqual(ignored_path.read_bytes(), original)
        self.assertEqual(git(self.root, "status", "--porcelain"), b"")
        self.assertNotIn("synthetic local-only bytes", repr(result))

    def test_switch_refuses_overwriting_an_ignored_env_file(self):
        self.assert_ignored_path_collision_is_preserved(".env")

    def test_switch_refuses_overwriting_an_ignored_python_config(self):
        self.assert_ignored_path_collision_is_preserved("config.py")

    def test_switch_refuses_overwriting_a_file_in_an_ignored_directory(self):
        self.assert_ignored_path_collision_is_preserved(".env/config.py")

    def test_switch_preserves_noncolliding_ignored_work(self):
        (self.root / ".gitignore").write_text("/.env\n")
        git(self.root, "add", ".gitignore")
        git(self.root, "commit", "-m", "ignore local fixture")
        original = b"synthetic local-only value\r\n"
        ignored = self.root / ".env"
        ignored.write_bytes(original)
        before = inspect_project(str(self.root))
        result = switch_branch(str(self.root), "other", before["fingerprint"])
        self.assertEqual(result["outcome"], "switched")
        self.assertEqual(result["actual"]["branch"], "other")
        self.assertEqual(ignored.read_bytes(), original)

    def test_single_worktree_path_text_is_not_counted_as_another_record(self):
        # Move the owned fixture as a whole; the new root includes the record prefix text.
        moved = self.root.parent / (self.root.name + " worktree demo ü")
        self.root.rename(moved)
        self.addCleanup(lambda: moved.rename(Path(self.temp.name)))
        self.root = moved
        info = inspect_project(str(self.root))
        self.assertEqual(info["blocked"], [])
        result = switch_branch(str(self.root), "other", info["fingerprint"])
        self.assertEqual(result["outcome"], "switched")

    @unittest.skipUnless(os.name == "posix", "POSIX owned-session hook fixture")
    def test_switch_timeout_stops_resistant_hook_and_does_not_infer_success_from_head(self):
        git(self.root, "switch", "other")
        target_bytes = b"def target_branch(): pass\n"
        (self.root / "sample.py").write_bytes(target_bytes)
        git(self.root, "add", "sample.py")
        git(self.root, "commit", "-m", "distinct target")
        target_head = git(self.root, "rev-parse", "HEAD").decode().strip()
        git(self.root, "switch", "dev")
        delayed_write = self.root / ".git" / "unexpected-late-write"
        started = self.root / ".git" / "hook-started"
        hook = self.root / ".git" / "hooks" / "post-checkout"
        hook.write_text(
            "#!/bin/sh\ntrap '' TERM\n"
            + f"printf started > {shlex.quote(str(started))}\n"
            + "sleep 3\n"
            + f"printf unsafe > {shlex.quote(str(delayed_write))}\n"
        )
        hook.chmod(0o755)
        git(self.root, "config", "core.hooksPath", str(hook.parent))
        before = inspect_project(str(self.root))
        with patch("helm.ui.project_git.GIT_TIMEOUT_SECONDS", 1):
            result = switch_branch(str(self.root), "other", before["fingerprint"])
        self.assertTrue(started.exists(), repr(result))
        self.assertEqual(result["outcome"], "timed-out")
        self.assertTrue(result["executionFailed"])
        self.assertTrue(result["contextChanged"])
        self.assertEqual(result["actual"]["head"], target_head)
        self.assertEqual(result["actual"]["branch"], "other")
        time.sleep(3.1)
        self.assertFalse(delayed_write.exists(), "a hook wrote after timeout was reported")
        self.assertEqual((self.root / "sample.py").read_bytes(), target_bytes)

    @unittest.skipUnless(os.name == "posix", "POSIX failing-hook fixture")
    def test_failed_hook_does_not_become_success_when_branch_changed(self):
        hook = self.root / ".git" / "hooks" / "post-checkout"
        hook.write_text("#!/bin/sh\nexit 23\n")
        hook.chmod(0o755)
        git(self.root, "config", "core.hooksPath", str(hook.parent))
        before = inspect_project(str(self.root))
        result = switch_branch(str(self.root), "other", before["fingerprint"])
        self.assertEqual(result["outcome"], "failed")
        self.assertTrue(result["executionFailed"])
        self.assertTrue(result["contextChanged"])
        self.assertEqual(result["actual"]["branch"], "other")

    def test_unconfirmed_timeout_cleanup_refuses_admission_without_an_actual_snapshot(self):
        from helm.ui.project_git import GitExecutionError, _git

        before = inspect_project(str(self.root))

        def failed_switch(root, *args, **kwargs):
            if args[0] == "switch":
                raise GitExecutionError(
                    "Git timed out and cleanup could not be confirmed.",
                    timed_out=True,
                    cleanup_confirmed=False,
                )
            return _git(root, *args, **kwargs)

        with patch("helm.ui.project_git._git", side_effect=failed_switch):
            result = switch_branch(str(self.root), "other", before["fingerprint"])
        self.assertEqual(result["outcome"], "unknown")
        self.assertIsNone(result["actual"])
        self.assertIn("cleanup could not be confirmed", result["message"])
