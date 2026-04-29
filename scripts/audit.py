from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
ALLOWLIST_PATH = REPO_ROOT / "security" / "audit-allowlist.json"
PYTHON_AUDIT_REQUIREMENTS = (
    REPO_ROOT / "requirements" / "python-runtime.txt",
    REPO_ROOT / "requirements" / "python-dev.txt",
)
ECOSYSTEMS = {"python", "npm", "cargo"}
BLOCKING_NPM_SEVERITIES = {"high", "critical"}


@dataclass(frozen=True)
class Finding:
    ecosystem: str
    advisory: str
    package: str
    severity: str = "unknown"


@dataclass(frozen=True)
class AllowlistEntry:
    ecosystem: str
    advisory: str
    package: str
    reason: str
    removal_condition: str


def load_allowlist() -> list[AllowlistEntry]:
    try:
        payload = json.loads(ALLOWLIST_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise SystemExit(f"Missing audit allowlist at {ALLOWLIST_PATH}.")
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Invalid JSON in {ALLOWLIST_PATH}: {exc}")

    entries = payload.get("ignored")
    if not isinstance(entries, list):
        raise SystemExit("Audit allowlist must contain an `ignored` list.")

    allowlist: list[AllowlistEntry] = []
    required_fields = {"ecosystem", "advisory", "package", "reason", "removal_condition"}

    for index, entry in enumerate(entries, start=1):
        if not isinstance(entry, dict):
            raise SystemExit(f"Allowlist entry {index} must be an object.")

        missing = sorted(required_fields - entry.keys())
        if missing:
            raise SystemExit(
                f"Allowlist entry {index} is missing required field(s): {', '.join(missing)}."
            )

        normalized = {
            key: str(entry[key]).strip() for key in required_fields if entry.get(key) is not None
        }
        empty = sorted(key for key in required_fields if not normalized.get(key))
        if empty:
            raise SystemExit(
                f"Allowlist entry {index} has empty required field(s): {', '.join(empty)}."
            )

        ecosystem = normalized["ecosystem"]
        if ecosystem not in ECOSYSTEMS:
            raise SystemExit(f"Allowlist entry {index} has unsupported ecosystem `{ecosystem}`.")

        allowlist.append(
            AllowlistEntry(
                ecosystem=ecosystem,
                advisory=normalized["advisory"],
                package=normalized["package"],
                reason=normalized["reason"],
                removal_condition=normalized["removal_condition"],
            )
        )

    return allowlist


def is_allowed(finding: Finding, allowlist: list[AllowlistEntry]) -> bool:
    return any(
        entry.ecosystem == finding.ecosystem
        and entry.package.lower() == finding.package.lower()
        and entry.advisory.lower() == finding.advisory.lower()
        for entry in allowlist
    )


def run_json_command(command: list[str], *, cwd: Path) -> tuple[int, Any, str]:
    completed = subprocess.run(
        command,
        cwd=cwd,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    output = completed.stdout.strip()
    if not output:
        return completed.returncode, None, completed.stderr.strip()

    try:
        return completed.returncode, json.loads(output), completed.stderr.strip()
    except json.JSONDecodeError:
        details = completed.stderr.strip() or output
        raise SystemExit(f"Audit command did not produce JSON: {' '.join(command)}\n{details}")


def resolve_command(name: str) -> str:
    if os.name == "nt":
        candidates = [f"{name}.cmd", f"{name}.exe", name]
    else:
        candidates = [name]

    for candidate in candidates:
        resolved = shutil.which(candidate)
        if resolved:
            return resolved

    scripts_dir = Path(sys.executable).resolve().parent
    for candidate in candidates:
        local = scripts_dir / candidate
        if local.exists():
            return str(local)

    raise SystemExit(f"Required audit command `{name}` was not found on PATH.")


def npm_advisory_ids(item: dict[str, Any]) -> list[str]:
    ids: list[str] = []
    for key in ("source", "id"):
        if item.get(key):
            ids.append(str(item[key]))

    url = str(item.get("url", ""))
    for part in reversed(url.rstrip("/").split("/")):
        if part:
            ids.append(part)
            break

    return ids or ["unknown"]


def npm_findings() -> list[Finding]:
    npm = resolve_command("npm")
    command = [npm, "audit", "--json"]
    returncode, payload, stderr = run_json_command(command, cwd=REPO_ROOT / "apps" / "desktop")

    if payload is None:
        if returncode == 0:
            return []
        raise SystemExit(stderr or "npm audit failed without JSON output.")

    findings: list[Finding] = []
    vulnerabilities = payload.get("vulnerabilities", {})
    if not isinstance(vulnerabilities, dict):
        raise SystemExit("Unexpected npm audit JSON: missing vulnerabilities object.")

    for package, vulnerability in vulnerabilities.items():
        if not isinstance(vulnerability, dict):
            continue

        severity = str(vulnerability.get("severity", "unknown")).lower()
        if severity not in BLOCKING_NPM_SEVERITIES:
            continue

        via_items = vulnerability.get("via", [])
        advisory_items = [item for item in via_items if isinstance(item, dict)]

        if not advisory_items:
            findings.append(Finding("npm", str(package), str(package), severity))
            continue

        for item in advisory_items:
            item_package = str(item.get("name") or package)
            for advisory in npm_advisory_ids(item):
                findings.append(Finding("npm", advisory, item_package, severity))

    return findings


def python_findings_from_payload(payload: Any) -> list[Finding]:
    dependencies = payload.get("dependencies", [])
    if not isinstance(dependencies, list):
        raise SystemExit("Unexpected pip-audit JSON: missing dependencies list.")

    findings: list[Finding] = []
    for dependency in dependencies:
        if not isinstance(dependency, dict):
            continue

        package = str(dependency.get("name", "unknown"))
        for vuln in dependency.get("vulns", []):
            if not isinstance(vuln, dict):
                continue

            advisory = str(vuln.get("id") or "unknown")
            findings.append(Finding("python", advisory, package))

    return findings


def python_findings() -> list[Finding]:
    pip_audit = resolve_command("pip-audit")
    findings: list[Finding] = []

    for requirements_path in PYTHON_AUDIT_REQUIREMENTS:
        command = [
            pip_audit,
            "-r",
            str(requirements_path),
            "--format",
            "json",
            "--progress-spinner",
            "off",
        ]
        returncode, payload, stderr = run_json_command(command, cwd=REPO_ROOT)

        if payload is None:
            if returncode == 0:
                continue
            raise SystemExit(stderr or "pip-audit failed without JSON output.")

        findings.extend(python_findings_from_payload(payload))

    return findings


def cargo_findings() -> list[Finding]:
    cargo = resolve_command("cargo")
    command = [cargo, "audit", "--json"]
    returncode, payload, stderr = run_json_command(
        command,
        cwd=REPO_ROOT / "apps" / "desktop" / "src-tauri",
    )

    if payload is None:
        if returncode == 0:
            return []
        raise SystemExit(stderr or "cargo audit failed without JSON output.")

    vulnerabilities = payload.get("vulnerabilities", {})
    if not isinstance(vulnerabilities, dict):
        raise SystemExit("Unexpected cargo audit JSON: missing vulnerabilities object.")

    findings: list[Finding] = []
    for item in vulnerabilities.get("list", []):
        if not isinstance(item, dict):
            continue

        advisory = item.get("advisory", {})
        package = item.get("package", {})
        finding = Finding(
            ecosystem="cargo",
            advisory=str(advisory.get("id", "unknown")),
            package=str(package.get("name", "unknown")),
        )
        findings.append(finding)

    return findings


def collect_findings(ecosystem: str) -> list[Finding]:
    if ecosystem == "python":
        return python_findings()
    if ecosystem == "npm":
        return npm_findings()
    if ecosystem == "cargo":
        return cargo_findings()
    raise SystemExit(f"Unsupported audit ecosystem `{ecosystem}`.")


def run_audit(ecosystems: list[str]) -> int:
    allowlist = load_allowlist()
    failed = False

    for ecosystem in ecosystems:
        findings = collect_findings(ecosystem)
        unallowed = [finding for finding in findings if not is_allowed(finding, allowlist)]
        allowed = [finding for finding in findings if is_allowed(finding, allowlist)]

        if allowed:
            print(f"{ecosystem}: {len(allowed)} finding(s) allowed by {ALLOWLIST_PATH}.")

        if not unallowed:
            print(f"{ecosystem}: no unallowlisted blocking vulnerabilities found.")
            continue

        failed = True
        print(f"{ecosystem}: unallowlisted blocking vulnerabilities found:", file=sys.stderr)
        for finding in unallowed:
            print(
                f"  - {finding.package}: {finding.advisory} ({finding.severity})",
                file=sys.stderr,
            )

    return 1 if failed else 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run HELM dependency security audits.")
    parser.add_argument(
        "ecosystem",
        choices=sorted([*ECOSYSTEMS, "all"]),
        help="Audit ecosystem to run.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    ecosystems = sorted(ECOSYSTEMS) if args.ecosystem == "all" else [args.ecosystem]
    return run_audit(ecosystems)


if __name__ == "__main__":
    raise SystemExit(main())
