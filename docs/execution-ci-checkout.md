# Windows native CI checkout

The first native Windows job for PR #135 failed in checkout before any source tests. Its generated workspace includes the repository's trailing period. Windows does not support trailing periods in ordinary directory names, and the pinned checkout action verifies that workspace exists before resolving its `path` input. Changing only `path:` cannot repair that ordering. The initial failed run remains evidence, not a native application test failure.

The native workflow uses a Windows-only bootstrap from `runner.temp` into a fresh `helm-native-<run>-<attempt>` directory. It fetches the current repository's exact `GITHUB_SHA`, verifies the fetched commit before checkout, detaches at that commit and rechecks HEAD before exposing a source-root output. Pull requests retain GitHub's synthetic merge commit; no moving branch or PR-head substitution is used. Existing paths and symlinks are refused rather than removed.

The existing read-only job token is supplied only to that bootstrap step. The raw token is removed from the child environment before Git starts; a command-scoped authentication header exists only for fetch, with credential helpers disabled for that command. It is not written to Git configuration, files, output or later step environments. Authentication is cleared before checkout or repository code. No reserved `GITHUB_*` variable, global Git setting, runner security setting or repository permission is changed. Non-Windows checkout keeps `persist-credentials: false`.

Every subsequent command, source-root binding and evidence upload follows the checked-out directory. Windows automatic setup-python/setup-node caches are disabled because their dependency hashing assumes `GITHUB_WORKSPACE`; Mac cache behavior is retained. This trades cache speed for a valid source path without changing build inputs or the installed application.

The next actual Windows run passed checkout and tool setup, then `pip check` exposed conflicts between the hosted image's preinstalled `pipx` and HELM's unchanged pinned `packaging`/`platformdirs`. Windows checks now use a fresh virtual environment beside the temporary source directory. Its Scripts directory is added only to the job PATH, and the install step verifies that Python is isolated before installing the existing lock. `pip check` stays enabled. No pin is upgraded and no preinstalled host tool is uninstalled to hide the conflict. Runner evidence records the actual Python executable and prefix.

The portable regression suite executes the actual workflow Bash with real local Git and a synthetic transport. It tests exact detached source and credential lifetime, fetch failure, wrong fetched commit before checkout, malformed repository/revision/run identity, existing directory and dangling-link preservation, plus workflow routing. Initial draft failures exposed reliance on legacy Bash's `errexit` handling for `[[...]]`; validation now exits explicitly. Those failed experiments are retained. Local fixtures do not emulate Windows filesystem behavior: the new hosted Windows run must prove actual checkout and subsequent source checks. Installed/WebView/ConPTY acceptance remains a separate gate.

Primary references:

- [Pinned checkout workspace validation](https://github.com/actions/checkout/blob/11d5960a326750d5838078e36cf38b85af677262/src/input-helper.ts).
- [Microsoft Windows filename rules](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file).
- [GitHub reserved variables and runner temporary directories](https://docs.github.com/en/actions/reference/workflows-and-actions/variables).
- [Git command-scoped environment configuration](https://git-scm.com/docs/git/2.53.0#Documentation/git.txt---config-envltnamegtltenvvargt).
