from __future__ import annotations

import hashlib
import json
import socket
from pathlib import Path
import tempfile
import unittest

from scripts.verify_execution_package import (
    REQUIRED_CASES,
    package_identity,
    probe_port,
    validate_receipt,
    verify_runtime,
)


class ExecutionPackageVerifierTests(unittest.TestCase):
    def receipt(self, package: Path) -> dict:
        return {
            "schemaVersion": 1,
            "scope": "private-installed-execution-acceptance",
            "source": {
                "sourceSHA": "1" * 40,
                "sourceDirty": False,
                "dirtyDeltaSHA256": hashlib.sha256(b"").hexdigest(),
            },
            "package": package_identity(package),
            "cases": [{"id": name, "status": "pending"} for name in REQUIRED_CASES],
            "evidence": [],
        }

    def test_pending_receipt_never_passes_installed_acceptance(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            package = Path(temporary) / "private-qa.exe"
            package.write_bytes(b"fixture bytes, not a real executable")
            receipt = self.receipt(package)
            self.assertEqual(len(validate_receipt(receipt)), len(REQUIRED_CASES))
            with self.assertRaisesRegex(ValueError, "acceptance is incomplete"):
                validate_receipt(receipt, require_pass=True)

    def test_changed_package_and_missing_evidence_refuse_recorded_pass(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            package = Path(temporary) / "private-qa.exe"
            package.write_bytes(b"first source-bound artifact")
            receipt = self.receipt(package)
            receipt["cases"][0].update(
                {
                    "status": "pass",
                    "expected": "sentinel untouched",
                    "observed": "untouched",
                    "evidence": ["missing"],
                }
            )
            with self.assertRaisesRegex(ValueError, "artifact evidence"):
                validate_receipt(receipt)
            package.write_bytes(b"different artifact")
            with self.assertRaisesRegex(ValueError, "Package changed"):
                validate_receipt(receipt)

    def test_runtime_inventory_checks_exact_bytes_and_rejects_escape(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            file = root / "backend.py"
            file.write_bytes("print('Ω')\r\n".encode())
            manifest = root / "runtime-manifest.json"
            payload = {
                "schema": 1,
                "target": "fixture",
                "files": {"backend.py": hashlib.sha256(file.read_bytes()).hexdigest()},
            }
            manifest.write_text(json.dumps(payload), encoding="utf-8")
            self.assertEqual(verify_runtime(root)["filesVerified"], 1)
            file.write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "hash mismatch"):
                verify_runtime(root)
            payload["files"] = {"../outside.py": "0" * 64}
            manifest.write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "Invalid runtime"):
                verify_runtime(root)

    def test_port_probe_preserves_occupied_listener_and_proves_rebind_after_close(self) -> None:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as unrelated:
            unrelated.bind(("127.0.0.1", 0))
            unrelated.listen()
            port = unrelated.getsockname()[1]
            self.assertEqual(probe_port(port)["observed"], "occupied")
            self.assertEqual(unrelated.getsockname()[1], port)
        self.assertEqual(probe_port(port)["observed"], "available")
        with self.assertRaises(ValueError):
            probe_port(port, "0.0.0.0")

    def test_directory_identity_changes_with_contents_and_rejects_external_link(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "HELM Ω with spaces.app"
            root.mkdir()
            executable = root / "owned"
            executable.write_bytes(b"a")
            first = package_identity(root)["sha256"]
            executable.write_bytes(b"b")
            self.assertNotEqual(first, package_identity(root)["sha256"])
            outside = Path(temporary) / "outside"
            outside.write_bytes(b"not a packaged resource")
            try:
                (root / "external").symlink_to(outside)
            except (OSError, NotImplementedError):
                self.skipTest("symlink creation is unavailable on this test host")
            with self.assertRaisesRegex(ValueError, "escapes"):
                package_identity(root)


if __name__ == "__main__":
    unittest.main()
