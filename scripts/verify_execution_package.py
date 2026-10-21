"""Bind private execution acceptance receipts to source, package and local evidence.

This script does not launch HELM, install a package, execute a project, change a
network adapter or promote pending acceptance. Run it on an approved QA machine.
Raw source deltas, environment values and terminal transcripts are never recorded.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path, PurePosixPath
import platform
import re
import errno
import socket
import subprocess
import sys

REQUIRED_CASES = (
    "trust-no-autoexecute",
    "trusted-run-environment-isolation",
    "private-values",
    "runtime-discovery-and-missing-tools",
    "named-configs-default-and-wrappers",
    "save-current-source-hash",
    "invalid-flow-and-preparation-refusal",
    "terminal-shell-repl-tui",
    "terminal-resize-unicode-copy-paste",
    "sidebar-focus-accessibility-hide-show",
    "bounded-output-flood-and-stop",
    "owned-child-grandchild-cleanup",
    "stop-during-startup-and-repeat",
    "port-rebind-and-unrelated-survival",
    "restart-reprepares-current-source",
    "project-and-branch-replacement",
    "window-close-and-quit",
    "diagnostic-file-line-navigation",
    "graph-mapping-stale-and-ambiguous",
    "loopback-osc8-policy-and-browser",
    "relocated-clean-install",
    "bundled-backend-independent-of-project-python",
    "missing-helper-and-architecture",
)
HEX = re.compile(r"^[0-9a-f]{64}$")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def contained(root: Path, path: Path) -> Path:
    resolved = path.resolve(strict=True)
    if not resolved.is_relative_to(root):
        raise ValueError("Package/evidence entry escapes its declared root")
    return resolved


def package_identity(package: Path) -> dict:
    package = package.resolve(strict=True)
    if package.is_file():
        return {
            "kind": "file",
            "path": str(package),
            "sha256": sha256_file(package),
            "bytes": package.stat().st_size,
        }
    if not package.is_dir():
        raise ValueError("Package must be an installer file or application directory")
    entries = []
    total = 0
    for path in sorted(package.rglob("*")):
        relative = path.relative_to(package).as_posix()
        target = contained(package, path)
        if path.is_symlink():
            entries.append([relative, "symlink", path.readlink().as_posix()])
        elif target.is_file():
            entries.append([relative, "file", sha256_file(target)])
            total += target.stat().st_size
        elif not target.is_dir():
            raise ValueError("Unsupported special entry in package")
    encoded = json.dumps(entries, ensure_ascii=False, separators=(",", ":")).encode()
    return {
        "kind": "directory",
        "path": str(package),
        "sha256": hashlib.sha256(encoded).hexdigest(),
        "files": len(entries),
        "bytes": total,
        "hashAlgorithm": "sha256-of-sorted-relative-path-type-content-hash-or-link-json-v1",
    }


def git(repo: Path, *arguments: str) -> bytes:
    return subprocess.check_output(["git", "-C", str(repo), *arguments], stderr=subprocess.PIPE)


def source_identity(repo: Path) -> dict:
    repo = repo.resolve(strict=True)
    sha = git(repo, "rev-parse", "HEAD").decode().strip()
    delta = hashlib.sha256(git(repo, "diff", "--binary", "HEAD", "--"))
    untracked = sorted(
        filter(None, git(repo, "ls-files", "--others", "--exclude-standard", "-z").split(b"\0"))
    )
    for name in untracked:
        path = repo / name.decode("utf-8")
        target = contained(repo, path)
        if not target.is_file():
            raise ValueError("Untracked source entry is not a regular file")
        delta.update(name + b"\0" + sha256_file(target).encode() + b"\0")
    dirty = bool(git(repo, "status", "--porcelain", "--untracked-files=normal"))
    return {
        "sourceSHA": sha,
        "sourceDirty": dirty,
        "dirtyDeltaSHA256": delta.hexdigest(),
        "untrackedFiles": len(untracked),
        "repository": str(repo),
    }


def verify_runtime(root: Path) -> dict:
    root = root.resolve(strict=True)
    manifest_path = contained(root, root / "runtime-manifest.json")
    if manifest_path.stat().st_size > 8 * 1024 * 1024:
        raise ValueError("Runtime manifest exceeds 8 MiB")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    files = manifest.get("files")
    if (
        manifest.get("schema") != 1
        or not isinstance(files, dict)
        or not files
        or len(files) > 100000
    ):
        raise ValueError("Unsupported or empty runtime manifest")
    for relative, expected in files.items():
        path = PurePosixPath(relative)
        if (
            not isinstance(relative, str)
            or path.is_absolute()
            or not path.parts
            or any(part in (".", "..") for part in path.parts)
            or "\\" in relative
            or ":" in relative
            or not isinstance(expected, str)
            or not HEX.fullmatch(expected)
        ):
            raise ValueError("Invalid runtime manifest entry")
        target = contained(root, root.joinpath(*path.parts))
        if not target.is_file() or sha256_file(target) != expected:
            raise ValueError("Runtime inventory hash mismatch: " + relative)
    return {
        "status": "pass",
        "root": str(root),
        "manifestSHA256": sha256_file(manifest_path),
        "target": manifest.get("target"),
        "filesVerified": len(files),
        "scope": "file-inventory-only; installed startup and project execution remain pending",
    }


def probe_port(port: int, address: str = "127.0.0.1") -> dict:
    """Independently test exact loopback rebind; never infer or kill its owner."""
    if address not in {"127.0.0.1", "::1"} or not 1 <= port <= 65535:
        raise ValueError("Choose an explicit loopback fixture address and port 1-65535")
    family = socket.AF_INET6 if address == "::1" else socket.AF_INET
    with socket.socket(family, socket.SOCK_STREAM) as listener:
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        try:
            listener.bind((address, port))
        except OSError as error:
            if error.errno != errno.EADDRINUSE and getattr(error, "winerror", None) != 10048:
                raise
            available = False
        else:
            available = True
    return {
        "observedAtUTC": datetime.now(timezone.utc).isoformat(),
        "address": address,
        "port": port,
        "observed": "available" if available else "occupied",
        "ownership": "not inferred; compare recorded fixture identities",
        "action": "bind probe only; no process was signalled",
    }


def create_receipt(repo: Path, package: Path, runtime: Path | None) -> dict:
    return {
        "schemaVersion": 1,
        "createdAtUTC": datetime.now(timezone.utc).isoformat(),
        "scope": "private-installed-execution-acceptance",
        "source": source_identity(repo),
        "package": package_identity(package),
        "machine": {
            "os": platform.system(),
            "osVersion": platform.version(),
            "architecture": platform.machine(),
            "webViewVersion": None,
            "buildPythonVersion": platform.python_version(),
        },
        "runtimeInventory": verify_runtime(runtime) if runtime else {"status": "pending"},
        "launch": {
            "installedPath": None,
            "relocatedSpacesUnicode": None,
            "developmentCheckoutUnavailable": None,
            "helmOverridesAbsent": None,
            "guiSearchPathReduced": None,
            "backendProcessPath": None,
            "backendModulePath": None,
        },
        "toolVersions": {
            "shell": None,
            "projectPython": None,
            "node": None,
            "packageManager": None,
        },
        "cases": [
            {
                "id": name,
                "status": "pending",
                "expected": "",
                "observed": "",
                "evidence": [],
                "durationMs": None,
            }
            for name in REQUIRED_CASES
        ],
        "evidence": [],
        "review": {"reviewer": None, "status": "pending", "observedResidueAfterExit": None},
        "ownerDogfooding": {
            "status": "pending",
            "attribution": "Owner-led acceptance is coordinated separately; this receipt cannot mark it complete.",
        },
        "result": "pending",
    }


def validate_receipt(receipt: dict, require_pass: bool = False) -> list[str]:
    if (
        receipt.get("schemaVersion") != 1
        or receipt.get("scope") != "private-installed-execution-acceptance"
    ):
        raise ValueError("Unsupported acceptance receipt")
    source = receipt.get("source", {})
    if (
        not re.fullmatch(r"[0-9a-f]{40}", source.get("sourceSHA", ""))
        or not HEX.fullmatch(source.get("dirtyDeltaSHA256", ""))
        or not isinstance(source.get("sourceDirty"), bool)
    ):
        raise ValueError("Missing exact source identity")
    package = receipt.get("package", {})
    if not HEX.fullmatch(package.get("sha256", "")):
        raise ValueError("Missing exact package identity")
    actual = package_identity(Path(package["path"]))
    if actual["sha256"] != package["sha256"]:
        raise ValueError("Package changed after receipt creation")
    evidence_ids = set()
    for entry in receipt.get("evidence", []):
        if not isinstance(entry.get("id"), str) or entry["id"] in evidence_ids:
            raise ValueError("Duplicate or missing evidence ID")
        path = Path(entry["path"]).resolve(strict=True)
        if not path.is_file() or sha256_file(path) != entry.get("sha256"):
            raise ValueError("Evidence artifact hash mismatch")
        evidence_ids.add(entry["id"])
    cases = receipt.get("cases", [])
    if {case.get("id") for case in cases} != set(REQUIRED_CASES) or len(cases) != len(
        REQUIRED_CASES
    ):
        raise ValueError("Acceptance case set is incomplete or duplicated")
    pending = []
    for case in cases:
        if case.get("status") not in {"pass", "fail", "pending", "blocked"}:
            raise ValueError("Invalid acceptance status")
        if case["status"] == "pass":
            if (
                not case.get("expected")
                or not case.get("observed")
                or not case.get("evidence")
                or not set(case["evidence"]).issubset(evidence_ids)
            ):
                raise ValueError("Passing case lacks expected/observed artifact evidence")
        else:
            pending.append(case["id"] + ":" + case["status"])
    if require_pass:
        required_launch = (
            "installedPath",
            "relocatedSpacesUnicode",
            "developmentCheckoutUnavailable",
            "helmOverridesAbsent",
            "guiSearchPathReduced",
            "backendProcessPath",
            "backendModulePath",
        )
        if (
            pending
            or not all(receipt.get("launch", {}).get(key) for key in required_launch)
            or not receipt.get("machine", {}).get("webViewVersion")
            or receipt.get("review", {}).get("status") != "pass"
            or not receipt.get("review", {}).get("reviewer")
            or receipt.get("review", {}).get("observedResidueAfterExit") != "none"
        ):
            raise ValueError(
                "Installed native acceptance is incomplete; pending/failed/blocked criteria cannot pass"
            )
        if not all(
            isinstance(receipt.get("toolVersions", {}).get(tool), str)
            and receipt["toolVersions"][tool].strip()
            for tool in ("shell", "projectPython", "node", "packageManager")
        ):
            raise ValueError(
                "Record selected tool versions or explicit absence for each supported runtime"
            )
        inventory = receipt.get("runtimeInventory", {})
        if inventory.get("status") != "pass" or verify_runtime(Path(inventory["root"]))[
            "manifestSHA256"
        ] != inventory.get("manifestSHA256"):
            raise ValueError("Installed runtime inventory is unverified")
    return pending


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest="action", required=True)
    create = actions.add_parser(
        "create", help="Write a receipt with every native/owner case pending"
    )
    create.add_argument("--repo", type=Path, required=True)
    create.add_argument("--package", type=Path, required=True)
    create.add_argument("--runtime-root", type=Path)
    create.add_argument("--out", type=Path, required=True)
    validate = actions.add_parser(
        "validate", help="Verify package/artifact hashes and receipt structure"
    )
    validate.add_argument("receipt", type=Path)
    validate.add_argument("--require-pass", action="store_true")
    runtime = actions.add_parser(
        "runtime", help="Verify existing staged/installed backend manifest without launching it"
    )
    runtime.add_argument("root", type=Path)
    port = actions.add_parser(
        "port", help="Independently probe a recorded fixture port without killing its occupant"
    )
    port.add_argument("port", type=int)
    port.add_argument("--address", choices=["127.0.0.1", "::1"], default="127.0.0.1")
    port.add_argument("--expect", choices=["available", "occupied"], required=True)
    arguments = parser.parse_args()
    try:
        if arguments.action == "create":
            receipt = create_receipt(arguments.repo, arguments.package, arguments.runtime_root)
            # Exclusive creation preserves earlier evidence rather than overwriting it.
            with arguments.out.open("x", encoding="utf-8") as stream:
                json.dump(receipt, stream, ensure_ascii=False, indent=2)
                stream.write("\n")
            print(
                json.dumps(
                    {
                        "receipt": str(arguments.out),
                        "result": "pending",
                        "casesPending": len(REQUIRED_CASES),
                    }
                )
            )
        elif arguments.action == "runtime":
            print(json.dumps(verify_runtime(arguments.root), indent=2))
        elif arguments.action == "port":
            result = probe_port(arguments.port, arguments.address)
            result["expected"] = arguments.expect
            result["result"] = "pass" if result["observed"] == arguments.expect else "fail"
            print(json.dumps(result, indent=2))
            return 0 if result["result"] == "pass" else 1
        else:
            pending = validate_receipt(
                json.loads(arguments.receipt.read_text(encoding="utf-8")), arguments.require_pass
            )
            print(
                json.dumps(
                    {
                        "receiptStructureAndHashes": "pass",
                        "nativeAcceptance": "pending" if pending else "evidence-recorded",
                        "remaining": pending,
                    },
                    indent=2,
                )
            )
        return 0
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print("Verification refused: " + str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
