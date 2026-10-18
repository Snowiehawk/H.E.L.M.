# Candidate dependency disposition, 2026-10-17

This record describes the isolated audited candidate. It does not replace the
hashes or native results for the earlier accepted installer.

## npm repair

Monaco 0.57.0 pins DOMPurify 3.4.15. A scoped npm override selects DOMPurify
3.4.16 for that dependency; the lockfile changes only its resolved package.
The new npm audit reports zero findings. Two concrete sanitizer regressions
reproduced the old rawtext-root and detached-hook handler hazards on 3.4.15 and
passed on 3.4.16. The 118 selected workspace and graph tests pass when run
serially. Two editor lookups timed out during the earlier concurrent build and
passed both individually and in the serial run; their failed run is preserved.

Upstream patched-version records:
[rawtext root advisory](https://github.com/cure53/DOMPurify/security/advisories/GHSA-6688-9rhm-gjv2)
and [detached-hook advisory](https://github.com/cure53/DOMPurify/security/advisories/GHSA-p98j-92pf-mc4p).

## Rust warnings retained

No warning was suppressed or allowlisted. The saved Cargo audit has no blocking
vulnerability records and four informational warnings. That distinction does not
make the unsoundness warnings harmless.

| Package          | Locked version | Dependency path and disposition                                                                                                                                                                                                                                     |
| ---------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| glib             | 0.18.5         | Tauri's GTK 0.18 chain on Linux/BSD. The fixed 0.20 API is outside GTK's 0.18 requirement; replacing it directly is not a compatible lockfile update. It is excluded from the Mac native target tree.                                                               |
| proc-macro-error | 1.0.4          | GTK3 macro build dependency. Unmaintained, without an upstream patched release in the saved advisory. Track the framework's GTK migration.                                                                                                                          |
| fxhash           | 0.2.1          | selectors → kuchikiki → tauri-utils. Unmaintained; replacing the crate requires upstream parser/framework changes or a maintained reviewed fork. No fork was silently introduced.                                                                                   |
| rand             | 0.7.3          | phf_generator 0.8 uses seeded SmallRng for generated tables. The saved Mac feature tree does not enable rand's optional log feature, which the advisory requires. The warning remains open; the available fixed versions are outside the consumer's 0.7 constraint. |

Sources: [glib unsoundness](https://rustsec.org/advisories/RUSTSEC-2024-0429.html),
[rand reentrant logger unsoundness](https://rustsec.org/advisories/RUSTSEC-2026-0097.html),
[fxhash maintenance](https://rustsec.org/advisories/RUSTSEC-2025-0057.html), and
[proc-macro-error maintenance](https://rustsec.org/advisories/RUSTSEC-2024-0370.html).
These are bounded dependency-path observations, not a whole-codebase security
certification. Recheck the Windows feature graph with the fresh native build.

## Python development findings and shipping runtime

The preserved development lock audit has 15 advisory records across filelock,
msgpack, pytest, requests, urllib3, pip, and setuptools. Their saved minimum fixed
versions require Python >=3.10. Python development/CI stays on 3.9; the proposed
3.12 baseline remains an owner decision. Existing alias exceptions were not
expanded and the exact-ID parser was not weakened to hide these records.

Those seven development packages are absent from the Windows runtime manifest.
The Mac arm64 candidate likewise stages only the interpreter/stdlib and pinned
LibCST/PyYAML runtime wheels, removing bundled pip before staging dependencies.
The saved runtime audit reported no findings for LibCST/PyYAML; it does not cover
the entire interpreter, its native libraries, or the operating system.

Mac candidate inputs come from the pinned
[Python Build Standalone 20261013 release](https://github.com/astral-sh/python-build-standalone/releases/tag/20261013)
and official PyPI wheels. Its build keeps the matching full-archive component
notices; the [upstream archive documentation](https://gregoryszorc.com/docs/python-build-standalone/main/distributions.html)
describes the install-only and full distributions. Native acceptance remains a
separate gate from successful packaging and relocated backend protocol checks.

## Follow-up target exposure review

A locked Mac arm64 normal-edge tree has no rand 0.7.3 consumer. fxhash reaches
HELM through `tauri-macros`/`tauri-codegen`, a host procedural-macro path, rather
than a directly used HELM runtime API. Both entries remain in the lockfile audit.
The saved feature graph still has no optional rand logging feature. These
observations narrow this target’s exposure; they do not remove the warnings or
establish Windows/Linux equivalence. No dependency fork, exception or Python
baseline change was made.

The independent Windows tree attempt could not complete offline because the
local Cargo cache lacks `objc2-quartz-core 0.3.2`. Its failed receipt is retained;
no Windows target equivalence is claimed from the Mac results. Resolve and save
that target tree during the fresh Windows candidate build.
