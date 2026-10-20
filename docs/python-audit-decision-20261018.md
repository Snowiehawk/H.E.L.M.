> Historical investigation at `846e237`: the owner subsequently approved the
> Python 3.12 development/CI migration. See the [migration record](python312-migration-20261018.md)
> for implementation and current validation; the observations below describe the
> pre-migration lock and are retained as evidence.

# Python development audit: baseline decision required

PR #75's Python job completed lint/format and 171 tests (5 skipped), then failed
the unchanged audit gate on 10 unallowlisted records across five development
packages. The published source is `b421897840bf5c7c71c355913abe033d9a35a882` before
this documentation-only follow-up. This record is analysis, not a baseline change
or permission to merge.

## Official compatible fixes

OSV advisory ranges and the official PyPI release metadata were read on
2026-10-18 UTC. The current lock already selects the newest non-yanked stable
release compatible with Python 3.9 for each of the five packages. Every required
fixed release declares Python >=3.10; no compatible official 3.9 update was found.

| Package  | Locked / newest Python 3.9 release | Minimum fixed release covering its blockers | Official release metadata                                           |
| -------- | ---------------------------------- | ------------------------------------------- | ------------------------------------------------------------------- |
| filelock | 3.19.1                             | 3.20.3 (includes 3.20.1 fix)                | [3.20.3, Python >=3.10](https://pypi.org/pypi/filelock/3.20.3/json) |
| msgpack  | 1.1.2                              | 1.2.1                                       | [1.2.1, Python >=3.10](https://pypi.org/pypi/msgpack/1.2.1/json)    |
| pytest   | 8.4.2                              | 9.0.3                                       | [9.0.3, Python >=3.10](https://pypi.org/pypi/pytest/9.0.3/json)     |
| requests | 2.32.5                             | 2.33.0                                      | [2.33.0, Python >=3.10](https://pypi.org/pypi/requests/2.33.0/json) |
| urllib3  | 2.6.3                              | 2.8.0 (2.7.0 fixes only two of five)        | [2.8.0, Python >=3.10](https://pypi.org/pypi/urllib3/2.8.0/json)    |

The ten records and their upstream fixes are:

- `PYSEC-2026-1375`, alias `GHSA-w853-jp5j-5j7f`: filelock native-lock symlink race; fixed 3.20.1. [Upstream advisory](https://github.com/tox-dev/filelock/security/advisories/GHSA-w853-jp5j-5j7f).
- `PYSEC-2026-1374`, alias `GHSA-qmgc-5h2g-mvrw`: filelock soft-lock symlink race; fixed 3.20.3. [Upstream advisory](https://github.com/tox-dev/filelock/security/advisories/GHSA-qmgc-5h2g-mvrw).
- `PYSEC-2026-3625`, alias `GHSA-6v7p-g79w-8964`: msgpack Unpacker reuse after a caught error can crash; fixed 1.2.1. [Upstream advisory](https://github.com/msgpack/msgpack-python/security/advisories/GHSA-6v7p-g79w-8964).
- `PYSEC-2026-1845`, alias `GHSA-6w46-j5rx-g56g`: pytest predictable UNIX temporary-directory handling; fixed 9.0.3. [Upstream fix](https://github.com/pytest-dev/pytest/pull/14343).
- `PYSEC-2026-2275`, alias `GHSA-gc5v-m9x4-r6x2`: requests `extract_zipped_paths` predictable temporary extraction; fixed 2.33.0. [Upstream advisory](https://github.com/psf/requests/security/advisories/GHSA-gc5v-m9x4-r6x2).
- `PYSEC-2026-142`, alias `GHSA-mf9v-mfxr-j63j`: urllib3 decompression resource exhaustion; fixed 2.7.0. [Upstream advisory](https://github.com/urllib3/urllib3/security/advisories/GHSA-mf9v-mfxr-j63j).
- `PYSEC-2026-141`, alias `GHSA-qccp-gfcp-xxvc`: urllib3 low-level proxy redirects forward sensitive headers across origins; fixed 2.7.0. [Upstream advisory](https://github.com/urllib3/urllib3/security/advisories/GHSA-qccp-gfcp-xxvc).
- `PYSEC-2026-4177`, alias `GHSA-vxq7-64xx-v4gw`: urllib3 streaming chunk-size buffering can exhaust memory; fixed 2.8.0. [Upstream advisory](https://github.com/urllib3/urllib3/security/advisories/GHSA-vxq7-64xx-v4gw).
- `PYSEC-2026-4176`, alias `GHSA-gh4c-6fx4-qh6g`: urllib3 chunked Deflate streaming can loop without network timeout interruption; fixed 2.8.0. [Upstream advisory](https://github.com/urllib3/urllib3/security/advisories/GHSA-gh4c-6fx4-qh6g).
- `PYSEC-2026-4175`, alias `GHSA-8988-9cw3-xx77`: urllib3 proxy and target TLS settings can be mixed; fixed 2.8.0. [Upstream advisory](https://github.com/urllib3/urllib3/security/advisories/GHSA-8988-9cw3-xx77).

## Dependency paths and bounded reachability

`pip-audit` requires `CacheControl[filecache]` and `requests`. Locked CacheControl
0.14.3 requires msgpack and, through its `filecache` extra, filelock. Requests
requires urllib3. Pytest is direct test tooling. HELM's own Python source has no
direct imports of those four transitive packages; two test files import pytest.

The verified official CacheControl 0.14.3 wheel uses `msgpack.dumps/loads`, rather
than explicitly reusing an Unpacker after errors, and uses `FileLock` around cache
writes. Pip-audit's database services make HTTP requests through Requests. HELM's
own source does not call `extract_zipped_paths`, low-level proxy APIs, or urllib3
streaming APIs. These are bounded static observations, not proof of non-reachability
through every transitive path or permission/proxy configuration. No advisory was
hidden or reclassified based on this inspection.

The five packages are absent from the accepted Windows 404-file and staged Mac
1,564-file runtime manifests. The installed apps' pinned Python 3.13.16 and
LibCST/PyYAML runtime are a separate dependency scope. This does not certify the
whole interpreter, native libraries or operating system.

A fresh local requirements audit returned 15 records across seven packages,
including four pip records and one setuptools record. The actual GitHub Python
job printed 10 blocking records across the five packages above; those observations
are kept distinct. The additional complete fixes, pip 26.2 and setuptools 83.0.0,
also require Python >=3.10 according to official release metadata. Existing exact-ID
exception behavior was not broadened to absorb PYSEC/GHSA aliases.

## Exact owner decision and consequences

The mathematical minimum interpreter for these upstream fixes is **Python 3.10**.
It is already end-of-life; Python's official status table lists 3.10 EOL on
2026-10-01 and 3.9 EOL on 2025-10-31. **3.11 is the oldest still-supported line**;
the previously proposed **3.12 development/CI baseline** has security support
through October 2028. [Python version status](https://devguide.python.org/versions/).

Choose a supported development/CI baseline (the existing proposal is 3.12), then:

1. Change all three CI interpreter selections and `tasks.py`'s lock-generation
   baseline to that version; update setup documentation and baseline assertions.
2. Regenerate the committed locks with that interpreter and explicit fixed floors
   for the affected development/tooling dependencies. Re-run full lint/tests,
   lock reproducibility and audits; do not assume this metadata check proves a
   green migrated CI run.
3. Make the bootstrap consequence explicit: it currently accepts Python 3.9 but
   installs the development lock even for normal wrapper use. Either require the
   new interpreter for that developer/bootstrap workflow or deliberately split
   runtime-only and development setup. A newer dev lock cannot be installed on 3.9.
4. Decide separately whether runtime/source-install compatibility still promises
   Python >=3.9. Keeping that promise needs appropriate runtime compatibility
   checks; moving dev/CI alone need not change `project.requires-python` or the
   installed app's bundled 3.13.16 interpreter.
5. Remove existing exceptions only after their affected packages actually become
   fixed. Do not add aliases, suppress findings, force-install unsupported wheels
   or introduce an unreviewed backport/fork to make the audit pass.

No code, lock, interpreter baseline, exception, protection or installed candidate
was changed by this investigation. PR #75 remains unmerged and its audit remains
blocking. The laptop clone was last verified clean at the published candidate;
documentation-only follow-up updates do not rebuild its installed applications.
