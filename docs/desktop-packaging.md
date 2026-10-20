# Desktop backend resources

Windows x64 installers include HELM's backend, official embedded CPython 3.13.16,
LibCST 1.8.6, and PyYAML 6.0.3. The build hook verifies pinned SHA-256 hashes before
extracting inputs from python.org and PyPI. Downloads happen at build time only.
The installed app does not install packages, download a runtime, change PATH, or
modify a system Python installation. Python library support remains >=3.9; this
shipping-runtime choice does not change the development/CI lock baseline.

`npm run prepare:backend` stages generated resources before a direct Cargo test or
build. Tauri's build and development hooks run it automatically. Set
`HELM_BUILD_PYTHON` to a build-machine Python if `python` (Windows) or `python3`
(other hosts) is unavailable. `HELM_RUNTIME_INPUTS_DIR` can point to an offline
directory containing the exact pinned archives (wheels may be in `wheels/`).
Corrupt inputs fail the build instead of falling back to unverified packages.

Only `src/helm/*.py` recursively, project metadata, applicable project licenses,
and verified runtime distributions are staged. Generated resources and download
caches are ignored by Git. The bundled `runtime-manifest.json` inventories input
hashes and every staged file. CPython's complete license file and the wheels'
license/metadata directories remain in the distribution, including LibCST's
MIT/PSF notices and PyYAML's MIT notice.

The app resolves `helm-runtime/backend` using Tauri's `resource_dir`, and Windows
uses `helm-runtime/python/python.exe`. Explicit `HELM_WORKSPACE_ROOT` and
`HELM_PYTHON_BIN` overrides remain available for development and diagnostics.
The checkout fallback is limited to an unbundled debug executable beside Cargo's
`.cargo-lock`; an installed app cannot use the original checkout as its default.
Health checks perform a persistent stdio handshake and verify the loaded backend
module path, rather than accepting `python --version` alone. The bridge forces
Python UTF-8 mode for its pipes so raw Unicode JSON and non-ASCII repository
paths work on Windows independently of the system code page.

Mac arm64 builds now also stage a pinned CPython 3.13.16 interpreter from the
20261013 Python Build Standalone release, with official PyPI LibCST 1.8.6 and
PyYAML 6.0.3 arm64 wheels. These inputs and the matching full upstream notice
archive are checked against committed SHA-256 hashes. The installed interpreter
is `helm-runtime/python/bin/python3`; it is launched in isolated Python mode.
Builds flatten only validated internal file links, preserve executable modes,
reject path traversal and special archive entries, and retain upstream component
license texts and runtime build metadata. The full upstream archive references
a missing zlib-ng notice; `third_party/python-runtime` supplies that notice from
the exact pinned zlib-ng 2.2.4 source archive, with recorded provenance and a
separate content hash check. Bundled pip/build-tool packages and
entry points are removed from generated runtime resources before adding HELM's
pinned runtime wheels. The build does not modify the host interpreter.

Intel Mac builds retain the external-interpreter contract until an independently
pinned and tested x86_64 runtime is added. Cross-building an Intel target from an
arm64 host fails explicitly. A declared bundled runtime that is damaged fails at
its installed path instead of silently choosing a system Python. A missing or malformed runtime manifest also fails closed. Older Mac
bundles whose manifest explicitly declares external Python retain their existing
contract. The owner-approved development/CI baseline is Python 3.12. That migration
does not change the pinned shipping interpreter, wheel inputs or installed candidates.

The arm64 runtime is an isolated candidate pending native acceptance. Prior
accepted Mac hashes in the dated native acceptance record used external Python.
Public signing/notarization and Intel/universal distribution are outside this
private QA candidate; no publication has occurred.

Clean-install acceptance must launch a relocated install with no `HELM_*` path
overrides or supplemental runtime. Verify the backend process and module both
come from installed resources, then scan, edit, Save, Undo, and Redo a disposable
CRLF fixture. A QA environment supplied with checkout/runtime overrides is a
separate scenario and cannot establish a clean-install pass.
