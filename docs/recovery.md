# Atomic Edits and Recovery

HELM wraps repo mutations in a small repo-local recovery journal so interrupted writes can be rolled back instead of leaving source files half-edited.

## What is protected

Journaled mutations include workspace save, create, move, and delete operations, structural editor changes, visual flow metadata writes, and backend undo restores. Read-only scans, file reads, reveal/open commands, and graph inspection stay lock-free.

Graph layout persistence in the Tauri shell uses an atomic write helper. New project creation is intentionally separate from the repo journal because the project is not an opened repo yet; HELM scaffolds into a temporary sibling folder, final-renames it into place, and cleans up only the temporary folder it created if scaffolding fails.

## Journal lifecycle

Each journaled mutation follows this lifecycle:

1. `prepare`: create `.helm/recovery/`, write the journal record, and stage all required preimages before touching user files.
2. `apply`: run the filesystem or source edit.
3. `commit`: mark the journal committed and remove the journal plus staging files.
4. `rollback`: restore staged preimages if apply fails or an interrupted journal is found.
5. `recover`: on repo open or before the next mutation, treat any non-committed journal as interrupted and roll it back.

If journal setup or staging fails, HELM aborts before mutating the repo.

## Staged preimages

HELM stages operation-specific data:

- save: old file content plus the version that was checked before saving
- create: the created path, so rollback can remove it
- move: source and destination entries, so rollback can restore the source and remove the new destination
- delete: a full file or directory tree preimage
- structural edit: every touched source file and HELM flow metadata file
- undo: current files before restoring the undo snapshot

Directory preimages include a recursive manifest. Destructive operations on symlinked directories are rejected until HELM has explicit cross-platform preservation semantics for them. Symlinked files are staged as links where the platform supports them.

## Recovery behavior

Recovery is idempotent. If rollback is interrupted, the next recovery pass continues from the same staged preimages. If HELM cannot complete recovery, it reports a narrow recovery error naming the journal path instead of silently continuing.

Backend responses may include `recovery_events`. The desktop UI surfaces those events as concise activity warnings so the user knows HELM rolled back an interrupted mutation. There is no recovery dashboard in this issue.

## Storage and ignore rules

Transient records live under:

```text
.helm/recovery/
```

HELM writes a `.gitignore` inside that folder to keep journal and staging files ignored. For Git repos, HELM also adds `/.helm/recovery/` to the local `.git/info/exclude` file so recovery scratch does not appear in status without editing tracked project ignore rules. HELM-created project templates include `.helm/recovery/` in their root `.gitignore`; existing projects may add the same root ignore entry if they track other `.helm` metadata.

Normal HELM metadata, such as graph layouts and flow models, is not hidden by this recovery ignore rule.

## Durability notes

Python atomic writes use same-directory temporary files, flush and fsync the temp file, then `os.replace`. On Unix, HELM also fsyncs the parent directory where practical.

Rust/Tauri atomic writes use same-directory temporary files and a platform replace operation. Windows uses the native replace-existing move with write-through; directory fsync remains best-effort because Rust does not expose a portable Windows directory fsync API.
