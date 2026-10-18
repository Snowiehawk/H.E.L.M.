> Development/CI follow-up: the owner later approved Python 3.12 and patched
> development locks. See the [migration record](python312-migration-20261018.md).
> Historical tests, installed candidates and runtime findings below retain their
> original scope; they are not rerun claims for the migration.

# Desktop packaging acceptance — 2026-10-17

This is the historical installed-backend checkpoint. Its artifact hashes and
counts remain unchanged. Later native results supersede its pending GUI gates in
[native acceptance](native-acceptance-20261017.md); the distinct standalone Mac
candidate and patched npm dependency are recorded in
[candidate build](candidate-build-20261017.md) and
[dependency disposition](candidate-dependency-disposition-20261017.md).

The Windows x64 installer now carries the HELM backend, pinned official embedded
Python 3.13.16, runtime dependencies, licenses, and a file/hash manifest. The app
resolves installed Tauri resources, checks the loaded backend path through a health
handshake, and forces UTF-8 JSON pipes. Build-time downloads are hash verified;
installed backend startup does not use a development checkout or download Python.

## Verified

A fresh disposable clone of the golden Windows baseline had no Python command or
development checkout. With its network disconnected, the installer exited 0. The
installation was relocated to a path containing spaces and U+03A9. All 404 packaged
resource files matched the manifest. The installed interpreter loaded the installed
backend, scanned a disposable fixture, and passed byte-exact CRLF Save, Undo, and
Redo. The original fixture bytes were restored.

This establishes offline installation and backend acceptance. Native GUI acceptance
on that fresh Windows clone, Mac native regression, and repaired-installer testing
on the physical Windows laptop remain pending.

The final source passed 342 frontend, 163 Python, and 18 Rust tests; the Python 3.9
compatibility run passed 163 tests. The focused new-module typing regression passed on Mac and on the final Windows
source (one passed, 73 skipped).
Its cause was an inspector React key changing as the graph refreshed, which
remounted the editor during typing. The fix uses the stable source target and
retains existing source during background refresh.

The Mac bundle verified 39 backend resource files and passed the backend scan and
exact-CRLF edit roundtrip. It retains the existing external-Python contract.

## Artifact identity

- Source base: `2b9eb5d1bb108d560f59a8751c475df2cd2bfe82`; 378 source files verified.
- Installer: `HELM-standalone-Windows-x64-setup.exe`, 16,465,981 bytes.
- Installer SHA-256: `cbb130030a2651ae577fd7bb595115180452784ff245b18a1be442d305e8ac5e`.
- Installed executable SHA-256: `ff6e1ef7983132f01f28aac5e52079200e97e14f5b1f7e912387fb1c56347126`.
- Final source archive SHA-256: `9604db44071211d43b48cae07d67282cddce2ae0836fac58c5c78ba397cdc696`.

The installer, full logs, runtime/license manifests, historical evidence, and source
archives are preserved outside the disposable VM. Bulky binaries and raw machine
logs are excluded from this repository evidence summary.

## Remaining findings and gates

The saved npm audit reports two low findings involving DOMPurify and Monaco, with
no moderate, high, or critical findings. Cargo reports no entries in its
vulnerabilities category but retains four informational maintenance/unsoundness
warnings. Bundled LibCST and PyYAML have no findings in the saved runtime audit.
These results do not establish a completely clean security audit.

The saved development-lock audit covers 43 packages and reports 15 advisory records
across seven packages. All listed fixed releases require Python >=3.10, while the
current development/CI baseline remains 3.9. These development packages do not
appear in the shipped Windows runtime manifest. The existing allowlist has four
matching GHSA aliases, but the current audit parser compares only primary IDs;
all 15 saved PYSEC records remain unallowed under that parser. No allowlist was
expanded, and the development security gate is not claimed to pass.

| Development package | Locked | Fixed release floor | Official requirement                                         |
| ------------------- | ------ | ------------------- | ------------------------------------------------------------ |
| filelock            | 3.19.1 | 3.20.3              | [Python >=3.10](https://pypi.org/project/filelock/3.20.3/)   |
| msgpack             | 1.1.2  | 1.2.1               | [Python >=3.10](https://pypi.org/project/msgpack/1.2.1/)     |
| pytest              | 8.4.2  | 9.0.3               | [Python >=3.10](https://pypi.org/project/pytest/9.0.3/)      |
| requests            | 2.32.5 | 2.33.0              | [Python >=3.10](https://pypi.org/project/requests/2.33.0/)   |
| urllib3             | 2.6.3  | 2.8.0               | [Python >=3.10](https://pypi.org/project/urllib3/2.8.0/)     |
| pip                 | 26.0.1 | 26.2                | [Python >=3.10](https://pypi.org/project/pip/26.2/)          |
| setuptools          | 82.0.1 | 83.0.0              | [Python >=3.10](https://pypi.org/project/setuptools/83.0.0/) |

Python 3.9 remains the development/CI baseline; the proposed 3.12 migration requires
a separate owner decision. The bundled Windows runtime choice is independent.
No merge, publication, or VM deletion is authorized by these acceptance results.

See [sanitized receipts](evidence/packaging-acceptance-20261017.json) for counts,
byte-stage hashes, pending GUI gates, and remaining advisory IDs.
