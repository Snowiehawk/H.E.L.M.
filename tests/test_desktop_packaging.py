from __future__ import annotations

import io
from pathlib import Path
import tempfile
import tarfile
import unittest
from unittest.mock import patch
import zipfile

from scripts.package_desktop_backend import (
    extract_verified_zip,
    fetch,
    extract_verified_tar,
    read_input,
    read_zlib_ng_notice,
    stage_backend,
    prepare,
    runtime_license_paths,
)


class DesktopPackagingTests(unittest.TestCase):
    def test_corrupt_cached_runtime_is_rejected_without_fetch_or_execution(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            cache = Path(temporary)
            (cache / "python.zip").write_bytes(b"corrupted input")
            item = {"filename": "python.zip", "sha256": "0" * 64}
            with patch("scripts.package_desktop_backend.fetch") as fetch:
                with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
                    read_input(item, cache, None)
                fetch.assert_not_called()

    def test_archive_cannot_escape_resource_directory(self) -> None:
        for name in ("../outside", "/absolute", "C:/outside", "..\\outside"):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                buffer = io.BytesIO()
                with zipfile.ZipFile(buffer, "w") as archive:
                    archive.writestr(name, "unexpected")
                with self.assertRaisesRegex(ValueError, "Unsafe path"):
                    extract_verified_zip(buffer.getvalue(), Path(temporary) / "resources")

    def test_only_backend_sources_and_project_metadata_are_staged(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "checkout"
            entry = root / "src/helm/ui/desktop_bridge.py"
            entry.parent.mkdir(parents=True)
            entry.write_text("# backend\n")
            (root / "pyproject.toml").write_text("[project]\nname='fixture'\n")
            (root / "private.env").write_text("do not bundle")
            (root / "src/helm/private.env").write_text("do not bundle")
            cache = root / "src/helm/__pycache__"
            cache.mkdir()
            (cache / "desktop_bridge.pyc").write_bytes(b"not source")
            destination = Path(temporary) / "packaged"
            stage_backend(root, destination)
            self.assertEqual(
                {
                    p.relative_to(destination).as_posix()
                    for p in destination.rglob("*")
                    if p.is_file()
                },
                {"src/helm/ui/desktop_bridge.py", "pyproject.toml"},
            )

    @staticmethod
    def tar_bytes(entries: list[tarfile.TarInfo]) -> bytes:
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode="w:gz") as archive:
            for entry in entries:
                payload = b"runtime" if entry.isfile() else None
                entry.size = len(payload) if payload else 0
                archive.addfile(entry, io.BytesIO(payload) if payload else None)
        return output.getvalue()

    def test_mac_runtime_internal_file_links_become_executable_regular_files(self) -> None:
        executable = tarfile.TarInfo("python/bin/python3.13")
        executable.mode = 0o755
        link = tarfile.TarInfo("python/bin/python3")
        link.type = tarfile.SYMTYPE
        link.linkname = "python3.13"
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            extract_verified_tar(self.tar_bytes([executable, link]), root)
            python = root / "python/bin/python3"
            self.assertFalse(python.is_symlink())
            self.assertEqual(python.read_bytes(), b"runtime")
            self.assertTrue(python.stat().st_mode & 0o111)

    def test_mac_runtime_archive_rejects_traversal_duplicates_and_special_files(self) -> None:
        for name in (
            "../outside",
            "/absolute",
            "C:/outside",
            "python/../outside",
            "..\\outside",
            "",
        ):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                with self.assertRaisesRegex(ValueError, "Unsafe"):
                    extract_verified_tar(self.tar_bytes([tarfile.TarInfo(name)]), Path(temporary))
        special = tarfile.TarInfo("python/device")
        special.type = tarfile.CHRTYPE
        for entries in (
            [special],
            [tarfile.TarInfo("python/same"), tarfile.TarInfo("python/same")],
        ):
            with self.subTest(entries=entries), tempfile.TemporaryDirectory() as temporary:
                with self.assertRaises(ValueError):
                    extract_verified_tar(self.tar_bytes(entries), Path(temporary))

    def test_mac_runtime_archive_rejects_escaping_missing_and_cyclic_links(self) -> None:
        for target in ("../../../outside", "/absolute", "missing", "python3"):
            link = tarfile.TarInfo("python/bin/python3")
            link.type = tarfile.SYMTYPE
            link.linkname = target
            with self.subTest(target=target), tempfile.TemporaryDirectory() as temporary:
                with self.assertRaisesRegex(ValueError, "link|cycle"):
                    extract_verified_tar(self.tar_bytes([link]), Path(temporary))

    def test_runtime_targets_cannot_be_combined(self) -> None:
        with self.assertRaisesRegex(ValueError, "exactly one"):
            prepare(True, True)

    def test_runtime_notices_include_nested_component_license_paths(self) -> None:
        self.assertEqual(
            runtime_license_paths(
                {
                    "license_path": "licenses/python.txt",
                    "extensions": [
                        {"license_paths": ["licenses/openssl.txt", "licenses/python.txt"]}
                    ],
                }
            ),
            ["licenses/openssl.txt", "licenses/python.txt"],
        )

    def test_runtime_notices_reject_escape_paths_and_missing_metadata(self) -> None:
        for metadata in (
            {},
            {"license_path": "/absolute"},
            {"license_paths": ["licenses/../../outside"]},
            {"license_paths": [None]},
        ):
            with self.subTest(metadata=metadata), self.assertRaises(ValueError):
                runtime_license_paths(metadata)

    def test_runtime_download_redirects_stay_https_on_expected_hosts(self) -> None:
        for url, allowed in (
            ("https://release-assets.githubusercontent.com/runtime", True),
            ("https://unexpected.example/runtime", False),
            ("http://github.com/runtime", False),
        ):
            response = io.BytesIO(b"runtime")
            response.url = url
            with (
                self.subTest(url=url),
                patch("scripts.package_desktop_backend.urlopen", return_value=response),
            ):
                if allowed:
                    self.assertEqual(fetch("https://github.com/runtime", "github.com"), b"runtime")
                else:
                    with self.assertRaisesRegex(ValueError, "redirected"):
                        fetch("https://github.com/runtime", "github.com")

    def test_corrupted_vendored_runtime_notice_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            notice = root / "third_party/python-runtime/LICENSE.zlib-ng.txt"
            notice.parent.mkdir(parents=True)
            notice.write_text("corrupt notice")
            with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
                read_zlib_ng_notice(root)
