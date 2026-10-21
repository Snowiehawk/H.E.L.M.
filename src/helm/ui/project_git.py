"""Bounded, credential-free project identity and clean local branch transitions.

Called on the serial desktop worker, alongside source mutations. No network or stash.
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
import re
import subprocess
import signal
import time
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


GIT_TIMEOUT_SECONDS = 20
GIT_TERMINATION_GRACE_SECONDS = 0.2
GIT_ATTRIBUTE_INPUT_LIMIT = 4 * 1024 * 1024
GIT_ATTRIBUTE_PATH_LIMIT = 100_000


class GitExecutionError(ValueError):
    def __init__(self, message: str, *, timed_out: bool = False, cleanup_confirmed: bool = True):
        super().__init__(message)
        self.timed_out = timed_out
        self.cleanup_confirmed = cleanup_confirmed


def _terminate_owned_git(process: subprocess.Popen) -> bool:
    """The unreaped session leader reserves its PID until the whole group is killed."""
    confirmed = True
    if os.name == "posix":
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        except OSError:
            confirmed = False
        # Do not poll/wait (and reap/reuse the leader PID) before the group KILL.
        time.sleep(GIT_TERMINATION_GRACE_SECONDS)
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        except OSError:
            confirmed = False
    elif os.name == "nt":
        try:
            stopped = subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(process.pid)],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=5,
                check=False,
            )
            confirmed = stopped.returncode == 0
        except (OSError, subprocess.TimeoutExpired):
            confirmed = False
    else:
        confirmed = False
    try:
        process.kill()
        process.communicate(timeout=2)
    except (OSError, subprocess.TimeoutExpired):
        confirmed = False
    return confirmed


def _git(
    root: Path,
    *args: str,
    optional: bool = False,
    allow_no_match: bool = False,
    input_bytes: bytes | None = None,
) -> bytes:
    if input_bytes is not None and len(input_bytes) > GIT_ATTRIBUTE_INPUT_LIMIT:
        raise GitExecutionError(
            "Git attribute inspection exceeded its bounded path input. Inspect outside HELM."
        )
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
        process = subprocess.Popen(
            ["git", "--no-optional-locks", "-c", "core.fsmonitor=false", "-C", str(root), *args],
            stdin=subprocess.PIPE if input_bytes is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=environment,
            start_new_session=os.name == "posix",
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
        )
    except OSError as error:
        raise GitExecutionError("Git is unavailable; the project state is unknown.") from error
    try:
        if input_bytes is None:
            output, _ = process.communicate(timeout=GIT_TIMEOUT_SECONDS)
        else:
            output, _ = process.communicate(input=input_bytes, timeout=GIT_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired as error:
        cleaned = _terminate_owned_git(process)
        raise GitExecutionError(
            "Git timed out. Its owned processes were stopped; inspect the actual checkout before retrying."
            if cleaned
            else "Git timed out and process cleanup could not be confirmed. Do not edit this checkout until its Git processes have been inspected.",
            timed_out=True,
            cleanup_confirmed=cleaned,
        ) from error
    if process.returncode and not optional and not (allow_no_match and process.returncode == 1):
        raise GitExecutionError(
            "Git inspection or execution failed. Check the selected checkout and Git permissions."
        )
    return output if process.returncode == 0 else b""


def _filter_keys(root: Path) -> bytes:
    # Exit 1 means no matching configuration. Other errors must not authorize
    # status: an unreadable or malformed config is not proof of absent helpers.
    return _git(
        root,
        "config",
        "--null",
        "--name-only",
        "--get-regexp",
        r"^filter\..*\.(clean|process|required)$",
        allow_no_match=True,
    )


def _filter_attributes(root: Path) -> bytes:
    paths = _git(root, "ls-files", "--cached", "-z")
    count = paths.count(b"\0")
    if (
        len(paths) > GIT_ATTRIBUTE_INPUT_LIMIT
        or count > GIT_ATTRIBUTE_PATH_LIMIT
        or (paths and not paths.endswith(b"\0"))
    ):
        raise GitExecutionError(
            "Git attribute inspection exceeded its bounded path input. Inspect outside HELM."
        )
    # Default check-attr semantics match worktree conversion: read worktree
    # attributes with index fallback when an attributes file is missing.
    attributes = _git(root, "check-attr", "-z", "--stdin", "filter", input_bytes=paths)
    fields = attributes.split(b"\0")
    if (
        fields[-1] != b""
        or len(fields) != count * 3 + 1
        or any(fields[index] != b"filter" for index in range(1, len(fields) - 1, 3))
    ):
        raise GitExecutionError(
            "Git attributes could not be inspected safely. Inspect outside HELM."
        )
    return attributes


def _passive_status(root: Path) -> bytes:
    # Status can run configured clean/process filters while hashing a changed
    # tracked file. Disabling normalization could produce either a false-clean
    # or false-dirty result, so this slice refuses filter-dependent inspection.
    # Unused global drivers are harmless; inspect tracked-path attributes without
    # invoking a driver. NUL input handles option-like names/newlines, with a
    # bounded stdin payload instead of a platform-dependent argv length limit.
    # Read config names only; never return helper commands or change settings.
    before = _filter_keys(root)
    attributes = _filter_attributes(root)
    fields = attributes.split(b"\0")
    if any(
        fields[index] not in (b"unspecified", b"unset") for index in range(2, len(fields) - 1, 3)
    ):
        raise GitExecutionError(
            "Passive Git inspection does not support tracked paths with clean/process filters. "
            "Local code remains available; inspect this checkout and switch branches "
            "explicitly outside HELM. No filter was run or configuration changed."
        )
    status = _git(
        root, "status", "--ignore-submodules=all", "--porcelain=v1", "-z", "--untracked-files=all"
    )
    # The serial worker prevents HELM operations interleaving these commands.
    # Refuse a transition if external configuration drift is observed as well.
    # This is not an OS sandbox or protection from a concurrent malicious writer
    # adding a helper between the precheck and Git's own config read.
    if _filter_keys(root) != before or _filter_attributes(root) != attributes:
        raise GitExecutionError(
            "Git filter configuration or attributes changed during inspection. Review and retry."
        )
    return status


def inspect_project(repo: str) -> dict:
    root = Path(repo).resolve(strict=True)
    actual = Path(os.fsdecode(_git(root, "rev-parse", "--show-toplevel")).strip()).resolve()
    if actual != root:
        raise ValueError("Select the repository root, not a folder inside another checkout.")
    head = _git(root, "rev-parse", "--verify", "HEAD", optional=True).decode().strip()
    branch = (
        _git(root, "symbolic-ref", "--quiet", "--short", "HEAD", optional=True).decode().strip()
    )
    status = _passive_status(root)
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
    # -z preserves raw paths; count record prefixes rather than text inside paths.
    worktrees = sum(
        record.startswith(b"worktree ")
        for record in _git(root, "worktree", "list", "--porcelain", "-z").split(b"\0")
    )
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
    execution_error = None
    outcome = "unchanged"
    try:
        # Git otherwise overwrites ignored, untracked paths by default. Let Git
        # detect collisions at apply time, including paths absent from status.
        _git(Path(before["path"]), "switch", "--no-guess", "--no-overwrite-ignore", branch)
        outcome = "switched"
    except GitExecutionError as error:
        execution_error = error
        outcome = "timed-out" if error.timed_out else "failed"
        if not error.cleanup_confirmed:
            return {"outcome": "unknown", "actual": None, "message": str(error)}
    # Reconcile actual Git state after any execution result. Never promise rollback.
    try:
        actual = inspect_project(repo)
    except (OSError, ValueError):
        return {
            "outcome": "unknown",
            "actual": None,
            "message": "Git state could not be reconciled. Inspect this checkout before retrying.",
        }
    if execution_error is None and actual["branch"] != branch:
        outcome = "failed"
    return {
        "outcome": outcome,
        "actual": actual,
        "executionFailed": execution_error is not None,
        "contextChanged": actual["head"] != before["head"] or actual["branch"] != before["branch"],
        "message": str(execution_error)
        if execution_error
        else (
            None
            if outcome == "switched"
            else "Git refused the branch switch. Review the actual Git state before retrying."
        ),
    }
