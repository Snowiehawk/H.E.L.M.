from __future__ import annotations

from pathlib import Path
from typing import Any

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
