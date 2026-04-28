from __future__ import annotations

from pathlib import Path
from typing import Any

from scripts import audit


def test_python_audit_uses_project_path(monkeypatch) -> None:
    commands: list[tuple[list[str], Path]] = []

    def fake_resolve_command(name: str) -> str:
        assert name == "pip-audit"
        return "pip-audit"

    def fake_run_json_command(command: list[str], *, cwd: Path) -> tuple[int, Any, str]:
        commands.append((command, cwd))
        return 0, {"dependencies": []}, ""

    monkeypatch.setattr(audit, "resolve_command", fake_resolve_command)
    monkeypatch.setattr(audit, "run_json_command", fake_run_json_command)

    assert audit.python_findings() == []
    assert commands == [
        (
            [
                "pip-audit",
                str(audit.REPO_ROOT),
                "--format",
                "json",
                "--progress-spinner",
                "off",
            ],
            audit.REPO_ROOT,
        )
    ]
