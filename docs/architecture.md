# Architecture

## Analysis pipeline

The CLI analyzes Python repositories without editing their source:

1. discover Python files in a target repository
2. derive stable module identities from repo-relative paths
3. parse files into normalized IR
4. build a domain-owned graph from that IR
5. render a CLI summary and optional JSON export

## Parser Boundary

The parser owns syntax-level extraction only:

- `ModuleRef`
- `SymbolDef`
- `ImportRef`
- `CallSite`
- `ParseDiagnostic`
- `SourceSpan`

It does not own graph semantics or presentation.

## Graph Boundary

The graph layer owns:

- stable repo/module/symbol nodes
- contains/defines/imports/calls edges
- conservative call resolution
- unresolved call reporting

The graph model is custom and library-free so adapters like `networkx` can be added later without becoming the system of record.

The local desktop GitHub issue viewer is a separate tab, domain, state and graph;
its issues and dependencies must not overlay or mix with the IDE/code graph.
See [GitHub issue viewer: status and implementation plan](github-issues.md) for the
implemented importer/presentation boundaries and the remaining work.

## Editing Boundary

The desktop editor uses precise source spans and LibCST-backed structural edits.
Workspace saves, file operations, graph/flow edits and Undo run through the backend
recovery journal; see [atomic edits and recovery](recovery.md). Graph layout
metadata is stored separately in the repository with atomic writes. The CLI
analysis pipeline remains read-only.

The native watcher feeds workspace changes back into the active desktop session.
Watcher overflow requires an explicit reindex. Desktop scan and mutation callbacks
may update the cache only while their repository session is still active; a late
result from a previous session cannot replace the new workspace.

The GitHub viewer has its own in-memory import, request cancellation, selection
and layout lifecycle. Disconnect or closing the viewer aborts its request and
clears its credentials and graph state. Switching IDE/issue tabs preserves each
workspace until it is explicitly closed.

## Deferred Work

Remaining analysis extensions:

- non-Python languages
- semantic type inference
