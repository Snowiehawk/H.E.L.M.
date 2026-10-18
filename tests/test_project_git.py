"""Disposable real-Git fixtures for the shared-project mutation boundary."""

import subprocess
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
            "helm.ui.project_git.subprocess.run", side_effect=OSError("secret internal diagnostic")
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
