"""Bounded, credential-free project identity and clean local branch transitions.

Called on the serial desktop worker, alongside source mutations. No network or stash.
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
import re
import subprocess
from urllib.parse import urlsplit


def github_identity(remote: str) -> str | None:
    """Accept only credential-free github.com HTTPS/SSH forms; preserve trailing dots."""
    if remote.lower().startswith("git@github.com:"):
        path = remote[len("git@github.com:") :]
    else:
        try:
            parsed = urlsplit(remote)
            port = parsed.port
        except ValueError:
            return None
        if parsed.hostname != "github.com" or parsed.query or parsed.fragment or port:
            return None
        if parsed.scheme == "https" and not parsed.username and not parsed.password:
            path = parsed.path.removeprefix("/")
        elif parsed.scheme == "ssh" and parsed.username == "git" and not parsed.password:
            path = parsed.path.removeprefix("/")
        else:
            return None
    if path.endswith(".git"):
        path = path[:-4]
    if not re.fullmatch(r"[A-Za-z0-9-]+/[A-Za-z0-9_.-]+", path):
        return None
    owner, name = path.split("/")
    if name in {".", ".."}:
        return None
    return f"{owner}/{name}".lower()


def _git(root: Path, *args: str, optional: bool = False) -> bytes:
    environment = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
    for key in (
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_COMMON_DIR",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    ):
        environment.pop(key, None)
    try:
        result = subprocess.run(
            ["git", "--no-optional-locks", "-C", str(root), *args],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=20,
            check=False,
            env=environment,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ValueError(
            "Git is unavailable or timed out; the project state is unknown."
        ) from error
    if result.returncode and not optional:
        raise ValueError("Git inspection failed. Check the selected checkout and Git permissions.")
    return result.stdout if result.returncode == 0 else b""


def inspect_project(repo: str) -> dict:
    root = Path(repo).resolve(strict=True)
    actual = Path(os.fsdecode(_git(root, "rev-parse", "--show-toplevel")).strip()).resolve()
    if actual != root:
        raise ValueError("Select the repository root, not a folder inside another checkout.")
    head = _git(root, "rev-parse", "--verify", "HEAD", optional=True).decode().strip()
    branch = (
        _git(root, "symbolic-ref", "--quiet", "--short", "HEAD", optional=True).decode().strip()
    )
    status = _git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all")
    fields = status.split(b"\0")
    staged = unstaged = untracked = conflicts = 0
    index = 0
    while index < len(fields) and fields[index]:
        field = fields[index]
        if len(field) < 4 or field[2:3] != b" ":
            raise ValueError("Git status could not be parsed safely.")
        code = field[:2].decode("ascii")
        if code == "??":
            untracked += 1
        else:
            staged += code[0] != " "
            unstaged += code[1] != " "
            conflicts += "U" in code or code in {"AA", "DD"}
            if "R" in code or "C" in code:
                index += 1  # porcelain -z has an extra original path, including spaces/newlines
        index += 1
    operations = []
    for marker in (
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "rebase-merge",
        "rebase-apply",
        "BISECT_LOG",
        "index.lock",
    ):
        marker_path = Path(os.fsdecode(_git(root, "rev-parse", "--git-path", marker)).strip())
        if not marker_path.is_absolute():
            marker_path = root / marker_path
        if marker_path.exists():
            operations.append(marker)
    refs = (
        _git(
            root, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/remotes"
        )
        .decode()
        .splitlines()
    )
    branches = [line.split(" ", 1)[0][11:] for line in refs if line.startswith("refs/heads/")]
    remote_branches = [
        line.split(" ", 1)[0][13:] for line in refs if line.startswith("refs/remotes/")
    ]
    remotes = []
    config = _git(
        root, "config", "--null", "--get-regexp", r"^remote\..*\.(url|pushurl)$", optional=True
    )
    for record in config.split(b"\0"):
        if not record:
            continue
        key, raw = record.split(b"\n", 1)
        name = key.decode().removeprefix("remote.").rsplit(".", 1)[0]
        identity = github_identity(os.fsdecode(raw))
        # Never return raw remotes: even unsupported URLs may contain credentials.
        remotes.append(
            {
                "name": name,
                "repository": identity,
                "kind": "push" if key.endswith(b".pushurl") else "fetch",
            }
        )
    worktrees = _git(root, "worktree", "list", "--porcelain").count(b"worktree ")
    git_dir = Path(os.fsdecode(_git(root, "rev-parse", "--absolute-git-dir")).strip()).resolve()
    linked_worktree = git_dir != (root / ".git").resolve()
    submodule = (
        bool(_git(root, "rev-parse", "--show-superproject-working-tree").strip())
        or (root / ".gitmodules").exists()
    )
    blocked = []
    if not head:
        blocked.append("Create an initial commit before switching branches.")
    if not branch:
        blocked.append("Detached HEAD: select a supported normal checkout first.")
    if operations:
        blocked.append("Finish the Git operation or resolve its lock before switching.")
    if worktrees > 1 or linked_worktree:
        blocked.append(
            "Branch switching in linked worktree setups is not supported in this first slice."
        )
    if submodule:
        blocked.append("Branch switching with submodules is not supported in this first slice.")
    fingerprint = hashlib.sha256(
        str(root).encode()
        + head.encode()
        + branch.encode()
        + status
        + config
        + repr(refs).encode()
        + repr(operations).encode()
    ).hexdigest()
    return {
        "path": root.as_posix(),
        "head": head,
        "branch": branch or None,
        "branches": branches,
        "remoteBranches": remote_branches,
        "remotes": remotes,
        "staged": staged,
        "unstaged": unstaged,
        "untracked": untracked,
        "conflicts": conflicts,
        "operations": operations,
        "blocked": blocked,
        "fingerprint": fingerprint,
    }


def require_clean(snapshot: dict) -> None:
    if snapshot["blocked"] or any(
        snapshot[k] for k in ("staged", "unstaged", "untracked", "conflicts")
    ):
        raise ValueError(
            "Transition blocked. Preserve staged, unstaged and untracked work in Git, finish any Git operation, then retry. Nothing was stashed or discarded."
        )


def switch_branch(repo: str, branch: str, fingerprint: str) -> dict:
    before = inspect_project(repo)
    if before["fingerprint"] != fingerprint:
        raise ValueError("Checkout state changed since inspection. Review and retry.")
    require_clean(before)
    if branch not in before["branches"] or branch.startswith("-"):
        raise ValueError(
            "Choose an existing local branch. Fetch/tracking creation must be done explicitly outside this selector."
        )
    outcome = "unchanged"
    try:
        _git(Path(before["path"]), "switch", "--no-guess", branch)
        outcome = "switched"
    except ValueError:
        outcome = "failed"
    # Reconcile actual Git state after any execution result. Never promise rollback.
    try:
        actual = inspect_project(repo)
    except (OSError, ValueError):
        return {
            "outcome": "unknown",
            "actual": None,
            "message": "Git state could not be reconciled. Inspect this checkout before retrying.",
        }
    if actual["branch"] == branch:
        outcome = "switched"
    return {
        "outcome": outcome,
        "actual": actual,
        "message": None
        if outcome == "switched"
        else "Git refused the branch switch. Existing files were preserved; review Git state and retry.",
    }
