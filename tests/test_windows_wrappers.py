from __future__ import annotations

import os
import subprocess
import sys
import unittest
from pathlib import Path


@unittest.skipUnless(os.name == "nt", "Windows wrapper tests require Windows.")
class WindowsWrapperTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.repo_root = Path(__file__).resolve().parents[1]
        cls.env = os.environ.copy()
        cls.env["HELM_BOOTSTRAP_PYTHON_BIN"] = sys.executable

    def test_cmd_wrapper_shows_usage_with_bootstrap_python_override(self) -> None:
        completed = subprocess.run(
            ["cmd.exe", "/c", "helm.cmd", "--help"],
            cwd=self.repo_root,
            env=self.env,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("helm bootstrap", completed.stdout)

    def test_start_here_cmd_routes_to_bootstrap_help(self) -> None:
        completed = subprocess.run(
            ["cmd.exe", "/c", "start_here.cmd", "--help"],
            cwd=self.repo_root,
            env=self.env,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("helm bootstrap", completed.stdout)

    def test_windows_launcher_uses_supported_vctools_workload_ids(self) -> None:
        launcher = (self.repo_root / "scripts" / "helm-launch.ps1").read_text(encoding="utf-8")

        self.assertIn("Microsoft.VisualStudio.Workload.VCTools", launcher)
        self.assertIn("Microsoft.VisualStudio.Component.VC.Tools.x86.x64", launcher)
        self.assertNotIn("Microsoft.VisualStudio.Workload.NativeDesktop", launcher)

    def test_windows_launcher_does_not_use_wait_with_setup_modify(self) -> None:
        launcher = (self.repo_root / "scripts" / "helm-launch.ps1").read_text(encoding="utf-8")
        modify_section = launcher.split(
            "function Ensure-WindowsDesktopWorkloadOnExistingBuildTools {", maxsplit=1
        )[1].split("function Ensure-WindowsDesktopBuildTools {", maxsplit=1)[0]

        self.assertNotIn("--wait", modify_section)

    def test_windows_launcher_can_request_elevation_for_visual_studio_changes(self) -> None:
        launcher = (self.repo_root / "scripts" / "helm-launch.ps1").read_text(encoding="utf-8")

        self.assertIn("RequireElevation", launcher)
        self.assertIn('Verb"] = "RunAs"', launcher)
