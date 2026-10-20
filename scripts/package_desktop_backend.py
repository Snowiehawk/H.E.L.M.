"""Stage backend resources with pinned Windows x64 and Mac arm64 offline runtimes.

Downloads happen only on the build machine. HELM_RUNTIME_INPUTS_DIR can supply
verified inputs offline. Never stage a checkout, virtualenv, or user data.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import posixpath
import sys
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tempfile
import tarfile
from urllib.parse import urlparse
from urllib.request import urlopen
import zipfile

ROOT = Path(__file__).resolve().parents[1]
TAURI = ROOT / "apps" / "desktop" / "src-tauri"
INPUTS = [
    {
        "filename": "python-3.13.16-embed-amd64.zip",
        "sha256": "97dae5274cc54867065e8d5a3226e48c35017ed332a0fdb0e27d5b5821961297",
        "url": "https://www.python.org/ftp/python/3.13.16/python-3.13.16-embed-amd64.zip",
    },
    {
        "filename": "libcst-1.8.6-cp313-cp313-win_amd64.whl",
        "sha256": "8066f1b70f21a2961e96bedf48649f27dfd5ea68be5cd1bed3742b047f14acde",
        "package": "libcst",
        "version": "1.8.6",
    },
    {
        "filename": "pyyaml-6.0.3-cp313-cp313-win_amd64.whl",
        "sha256": "79005a0d97d5ddabfeeea4cf676af11e647e41d81c9a7722a193022accdb6b7c",
        "package": "pyyaml",
        "version": "6.0.3",
    },
]


MACOS_ARM64_INPUTS = [
    {
        "filename": "cpython-3.13.16+20261013-aarch64-apple-darwin-install_only_stripped.tar.gz",
        "sha256": "16a5332fb0dcb77f163fc8f8cbccd95be1644cc53e68e5d2a79f50afd6680a0e",
        "url": "https://github.com/astral-sh/python-build-standalone/releases/download/20261013/cpython-3.13.16%2B20261013-aarch64-apple-darwin-install_only_stripped.tar.gz",
        "host": "github.com",
    },
    {
        "filename": "libcst-1.8.6-cp313-cp313-macosx_11_0_arm64.whl",
        "sha256": "4fc3fef8a2c983e7abf5d633e1884c5dd6fa0dcb8f6e32035abd3d3803a3a196",
        "package": "libcst",
        "version": "1.8.6",
    },
    {
        "filename": "pyyaml-6.0.3-cp313-cp313-macosx_11_0_arm64.whl",
        "sha256": "2283a07e2c21a2aa78d9c4442724ec1eb15f5e42a723b99cb3d822d48f5f7ad1",
        "package": "pyyaml",
        "version": "6.0.3",
    },
    {
        "filename": "cpython-3.13.16+20261013-aarch64-apple-darwin-pgo+lto-full.tar.zst",
        "sha256": "3497822d8bf4884bc79258f62668f985654d03d40ec74da4ca9ae7a5667c4362",
        "url": "https://github.com/astral-sh/python-build-standalone/releases/download/20261013/cpython-3.13.16%2B20261013-aarch64-apple-darwin-pgo%2Blto-full.tar.zst",
        "host": "github.com",
        "runtime_notices": True,
    },
]


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def verify_input(data: bytes, item: dict) -> bytes:
    if sha256(data) != item["sha256"]:
        raise ValueError("Runtime input SHA-256 mismatch: " + item["filename"])
    return data


def fetch(url: str, host: str) -> bytes:
    if urlparse(url).scheme != "https" or urlparse(url).hostname != host:
        raise ValueError("Unexpected runtime input host")
    with urlopen(url, timeout=90) as response:
        allowed_hosts = {host}
        if host == "github.com":
            allowed_hosts.update(
                {"release-assets.githubusercontent.com", "objects.githubusercontent.com"}
            )
        if (
            urlparse(response.url).scheme != "https"
            or urlparse(response.url).hostname not in allowed_hosts
        ):
            raise ValueError("Runtime input redirected to an unexpected host")
        return response.read()


def read_input(item: dict, cache: Path, supplied: Path | None) -> bytes:
    candidates = [cache / item["filename"]]
    if supplied:
        candidates = [
            supplied / item["filename"],
            supplied / "wheels" / item["filename"],
        ] + candidates
    for candidate in candidates:
        if candidate.is_file():
            return verify_input(candidate.read_bytes(), item)
    if "url" in item:
        data = fetch(item["url"], item.get("host", "www.python.org"))
    else:
        metadata = json.loads(
            fetch(
                "https://pypi.org/pypi/" + item["package"] + "/" + item["version"] + "/json",
                "pypi.org",
            )
        )
        matches = [entry for entry in metadata["urls"] if entry["filename"] == item["filename"]]
        if len(matches) != 1 or matches[0]["digests"]["sha256"] != item["sha256"]:
            raise ValueError("Pinned runtime wheel does not match official metadata")
        data = fetch(matches[0]["url"], "files.pythonhosted.org")
    verify_input(data, item)
    cache.mkdir(parents=True, exist_ok=True)
    (cache / item["filename"]).write_bytes(data)
    return data


def extract_verified_zip(data: bytes, destination: Path) -> None:
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        for info in archive.infolist():
            path = PurePosixPath(info.filename)
            if (
                path.is_absolute()
                or ".." in path.parts
                or "\\" in info.filename
                or ":" in info.filename
            ):
                raise ValueError("Unsafe path in runtime archive")
            if (info.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError("Symlinks are not allowed in runtime archives")
        archive.extractall(destination)


def extract_verified_tar(data: bytes, destination: Path) -> None:
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        members = archive.getmembers()
        index = {}
        if len(members) > 20000:
            raise ValueError("Too many runtime archive members")
        for member in members:
            path = PurePosixPath(member.name)
            if (
                not path.parts
                or path.is_absolute()
                or ".." in path.parts
                or "\\" in member.name
                or ":" in member.name
                or path.parts[0] != "python"
                or path.as_posix() in index
            ):
                raise ValueError("Unsafe runtime archive path")
            if not (member.isdir() or member.isfile() or member.issym()):
                raise ValueError("Unsupported runtime archive member")
            index[path.as_posix()] = member
        for name, member in index.items():
            output = destination / name
            if member.isdir():
                output.mkdir(parents=True, exist_ok=True)
                continue
            target = member
            visited = set()
            while target.issym():
                if target.name in visited:
                    raise ValueError("Runtime archive symlink cycle")
                visited.add(target.name)
                link = PurePosixPath(target.linkname)
                if link.is_absolute() or "\\" in target.linkname or ":" in target.linkname:
                    raise ValueError("Unsafe runtime archive link")
                resolved = posixpath.normpath(
                    posixpath.join(posixpath.dirname(target.name), target.linkname)
                )
                if not resolved.startswith("python/") or resolved not in index:
                    raise ValueError("Escaping or missing runtime link")
                target = index[resolved]
            if not target.isfile() or target.size > 128 * 1024 * 1024:
                raise ValueError("Unsupported runtime link target")
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(archive.extractfile(target).read())
            output.chmod(0o755 if target.mode & 0o111 else 0o644)


def runtime_license_paths(metadata: dict) -> list[str]:
    paths: set[str] = set()

    def collect(value: object) -> None:
        if isinstance(value, dict):
            for key, item in value.items():
                if key in {"license_path", "license_paths"}:
                    for name in item if isinstance(item, list) else [item]:
                        if not isinstance(name, str):
                            raise ValueError("Invalid runtime license path")
                        path = PurePosixPath(name)
                        if (
                            path.is_absolute()
                            or ".." in path.parts
                            or "\\" in name
                            or ":" in name
                            or len(path.parts) < 2
                            or path.parts[0] != "licenses"
                        ):
                            raise ValueError("Unsafe runtime license path")
                        paths.add(path.as_posix())
                else:
                    collect(item)
        elif isinstance(value, list):
            for item in value:
                collect(item)

    collect(metadata)
    if not paths:
        raise ValueError("Runtime license metadata is missing")
    return sorted(paths)


def read_zlib_ng_notice(source_root: Path) -> bytes:
    return verify_input(
        (source_root / "third_party/python-runtime/LICENSE.zlib-ng.txt").read_bytes(),
        {
            "filename": "LICENSE.zlib-ng.txt",
            "sha256": "6c9f0d975b41afaa34d22f55bb8986ce69e5cb7ad327cb2b28820cd425edf5ee",
        },
    )


def stage_runtime_notices(data: bytes, destination: Path) -> None:
    # Read only exact validated members to stdout. Never extract archive paths to disk.
    with tempfile.NamedTemporaryFile(suffix=".tar.zst") as archive:
        archive.write(data)
        archive.flush()

        def read_member(name: str) -> bytes:
            result = subprocess.run(
                ["/usr/bin/tar", "-xOf", archive.name, "python/" + name],
                capture_output=True,
                check=True,
                timeout=45,
            )
            if len(result.stdout) > 2 * 1024 * 1024:
                raise ValueError("Runtime notice member is unexpectedly large")
            return result.stdout

        metadata = json.loads(read_member("PYTHON.json"))
        if (
            metadata.get("target_triple") != "aarch64-apple-darwin"
            or metadata.get("python_version") != "3.13.16"
        ):
            raise ValueError("Runtime notice metadata does not match pinned interpreter")
        listing = subprocess.run(
            ["/usr/bin/tar", "-tf", archive.name],
            capture_output=True,
            text=True,
            check=True,
            timeout=45,
        )
        archived = [
            name.removeprefix("python/")
            for name in listing.stdout.splitlines()
            if name.startswith("python/licenses/") and not name.endswith("/")
        ]
        paths = sorted(
            set(runtime_license_paths(metadata))
            | set(runtime_license_paths({"license_paths": archived}))
        )
        for name in paths:
            output = destination / name
            output.parent.mkdir(parents=True, exist_ok=True)
            if name == "licenses/LICENSE.zlib-ng.txt":
                # Upstream metadata references this file but the full archive omits it.
                # Recover the exact component notice with pinned source provenance.
                output.write_bytes(read_zlib_ng_notice(ROOT))
                shutil.copyfile(
                    ROOT / "third_party/python-runtime/zlib-ng-provenance.json",
                    destination / "licenses/zlib-ng-provenance.json",
                )
            else:
                output.write_bytes(read_member(name))
        (destination / "runtime-build-metadata.json").write_text(
            json.dumps(metadata, indent=2) + "\n", encoding="utf-8"
        )


def stage_backend(source_root: Path, destination: Path) -> None:
    source = source_root / "src" / "helm"
    if not (source / "ui" / "desktop_bridge.py").is_file():
        raise ValueError("HELM backend entry point is missing")
    for path in sorted(source.rglob("*.py")):
        if path.is_symlink() or "__pycache__" in path.parts:
            raise ValueError("Unexpected backend source path")
        output = destination / "src" / "helm" / path.relative_to(source)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(path.read_bytes())
    shutil.copyfile(source_root / "pyproject.toml", destination / "pyproject.toml")
    for name in ("LICENSE", "LICENSE.txt", "LICENSE.md"):
        if (source_root / name).is_file():
            shutil.copyfile(source_root / name, destination / name)


def validate_runtime(stage: Path, python_relative: str) -> None:
    python = stage / python_relative
    backend_src = stage / "backend" / "src"
    bootstrap = (
        "import runpy,sys;sys.path.insert(0,sys.argv.pop(1));"
        "runpy.run_module('helm.ui.desktop_bridge',run_name='__main__')"
    )
    frames = "".join(
        json.dumps(frame) + "\n"
        for frame in [
            {"id": 1, "command": "health", "params": {}},
            {"id": 2, "command": "shutdown", "params": {}},
        ]
    )
    result = subprocess.run(
        [str(python), "-I", "-B", "-X", "utf8", "-c", bootstrap, str(backend_src), "serve"],
        input=frames,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=45,
        cwd=stage,
    )
    replies = [json.loads(line) for line in result.stdout.splitlines()]
    if result.returncode or len(replies) != 2 or not all(reply.get("ok") for reply in replies):
        raise RuntimeError("Packaged Python bridge handshake failed: " + result.stderr[-1000:])
    module = Path(replies[0]["result"]["backend_module"]).resolve()
    if module != (backend_src / "helm" / "ui" / "desktop_bridge.py").resolve():
        raise RuntimeError("Runtime loaded a backend outside the packaged resources")


def prepare(windows_x64: bool, macos_arm64: bool = False) -> Path:
    if windows_x64 and macos_arm64:
        raise ValueError("Select exactly one bundled runtime target")
    inputs = MACOS_ARM64_INPUTS if macos_arm64 else INPUTS if windows_x64 else []
    output = TAURI / "packaged-backend"
    supplied = os.environ.get("HELM_RUNTIME_INPUTS_DIR")
    with tempfile.TemporaryDirectory(prefix=".backend-stage-", dir=TAURI) as temporary:
        stage = Path(temporary)
        stage_backend(ROOT, stage / "backend")
        if windows_x64 or macos_arm64:
            for item in inputs:
                data = read_input(
                    item, TAURI / ".runtime-cache", Path(supplied) if supplied else None
                )
                target = stage / "python"
                if "package" in item:
                    target = target / (
                        "lib/python3.13/site-packages" if macos_arm64 else "Lib/site-packages"
                    )
                if item["filename"].endswith(".tar.gz"):
                    extract_verified_tar(data, stage)
                    # Ship the interpreter and HELM runtime dependencies, not pip or build tools.
                    packages = stage / "python/lib/python3.13/site-packages"
                    if packages.exists():
                        shutil.rmtree(packages)
                    for script in (stage / "python/bin").glob("pip*"):
                        script.unlink()
                elif item.get("runtime_notices"):
                    stage_runtime_notices(data, target)
                else:
                    extract_verified_zip(data, target)
            # An isolated embedded interpreter imports only its standard library
            # and pinned wheels. Rust explicitly supplies the backend source path.
            if windows_x64:
                (stage / "python" / "python313._pth").write_text(
                    "python313.zip\n.\nLib/site-packages\nimport site\n", encoding="utf-8"
                )
                if os.name == "nt":
                    validate_runtime(stage, "python/python.exe")
            elif sys.platform == "darwin":
                validate_runtime(stage, "python/bin/python3")
        manifest = {
            "schema": 1,
            "target": "macos-aarch64"
            if macos_arm64
            else "windows-x86_64"
            if windows_x64
            else "external-python",
            "runtime_inputs": inputs,
            "files": {
                path.relative_to(stage).as_posix(): sha256(path.read_bytes())
                for path in sorted(stage.rglob("*"))
                if path.is_file()
            },
        }
        (stage / "runtime-manifest.json").write_text(
            json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
        )
        # Only this generated staging directory is replaced. Installed apps and
        # preserved acceptance artifacts are never touched by the build hook.
        if output.exists():
            shutil.rmtree(output)
        shutil.copytree(stage, output)
    print(
        "Staged "
        + manifest["target"]
        + " backend resources: "
        + str(len(manifest["files"]))
        + " files"
    )
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    targets = parser.add_mutually_exclusive_group()
    targets.add_argument("--windows-x64", action="store_true")
    targets.add_argument("--macos-arm64", action="store_true")
    args = parser.parse_args()
    prepare(args.windows_x64, args.macos_arm64)
