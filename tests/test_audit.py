from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from scripts import audit


def test_python_audit_uses_committed_lockfiles(monkeypatch) -> None:
    commands: list[tuple[list[str], Path]] = []

    def fake_run_json_command(command: list[str], *, cwd: Path) -> tuple[int, Any, str]:
        commands.append((command, cwd))
        return 0, {"dependencies": []}, ""

    monkeypatch.setattr(audit, "run_json_command", fake_run_json_command)

    assert audit.python_findings() == []
    assert commands == [
        (
            [
                audit.sys.executable,
                "-m",
                "pip_audit",
                "-r",
                str(audit.REPO_ROOT / "requirements" / "python-runtime.txt"),
                "--format",
                "json",
                "--progress-spinner",
                "off",
            ],
            audit.REPO_ROOT,
        ),
        (
            [
                audit.sys.executable,
                "-m",
                "pip_audit",
                "-r",
                str(audit.REPO_ROOT / "requirements" / "python-dev.txt"),
                "--format",
                "json",
                "--progress-spinner",
                "off",
            ],
            audit.REPO_ROOT,
        ),
    ]


@pytest.mark.parametrize(
    ("returncode", "payload"),
    [
        (0, None),
        (1, None),
        (1, {"error": {"code": "ENETUNREACH"}}),
        (0, {"error": {"code": "EUNKNOWN"}, "vulnerabilities": {}}),
        (1, []),
        (0, {}),
        (0, {"vulnerabilities": []}),
        (2, {"vulnerabilities": {}}),
        (1, {"vulnerabilities": {}}),
    ],
)
def test_npm_audit_rejects_missing_or_failed_reports(monkeypatch, returncode, payload) -> None:
    monkeypatch.setattr(audit, "resolve_command", lambda name: name)
    monkeypatch.setattr(
        audit, "run_json_command", lambda *args, **kwargs: (returncode, payload, "")
    )

    with pytest.raises(SystemExit):
        audit.npm_findings()


def test_npm_audit_accepts_clean_report(monkeypatch) -> None:
    monkeypatch.setattr(audit, "resolve_command", lambda name: name)
    monkeypatch.setattr(
        audit, "run_json_command", lambda *args, **kwargs: (0, {"vulnerabilities": {}}, "")
    )

    assert audit.npm_findings() == []


def test_npm_audit_preserves_blocking_findings(monkeypatch) -> None:
    payload = {
        "vulnerabilities": {
            "example": {
                "severity": "high",
                "via": [
                    {"name": "example", "source": 123, "url": "https://example.test/GHSA-test"}
                ],
            },
            "low-only": {"severity": "low", "via": []},
        }
    }
    monkeypatch.setattr(audit, "resolve_command", lambda name: name)
    monkeypatch.setattr(audit, "run_json_command", lambda *args, **kwargs: (1, payload, ""))

    assert audit.npm_findings() == [
        audit.Finding("npm", "123", "example", "high"),
        audit.Finding("npm", "GHSA-test", "example", "high"),
    ]
