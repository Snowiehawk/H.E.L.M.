# Architecture

## MVP Pipeline

H.E.L.M. v0 is a read-only ingestion pipeline:

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

## Editing Boundary

Graph-backed source editing is intentionally deferred. The main forward-compatibility choice in v0 is preserving precise source spans on parsed entities so later edit logic can target concrete source ranges.

## Deferred Work

Not part of the MVP backbone:

- non-Python languages
- incremental indexing
- persistent graph storage
- semantic type inference
- formatting-preserving rewrites
- interactive UI
