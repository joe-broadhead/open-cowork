# ADR 0001: Language and Runtime Strategy

Status: Accepted

Date: 2026-05-21

## Context

OpenWiki needs to ship one protocol across several surfaces: repository format,
CLI, MCP, HTTP API, worker jobs, web UI, static export, OpenCode maintenance,
Open Cowork packs, Docker Compose, Umbrel, GitHub Pages, and later enterprise
deployments.

The project also needs a search path that can start local and explainable, then
grow toward dbt-nova-style fusion search with optional dense, sparse, and
reranker components.

## Decision

OpenWiki v0.1 is TypeScript-first.

- TypeScript is the primary product language for core packages, repository
  parsing, schemas, CLI, MCP, HTTP API, workflows, workers, integrations, and
  the server-rendered web UI.
- Node.js 24 is the primary CI and container runtime target. Package
  compatibility remains `>=22.22.3`, the tested Node 22 release where
  `node:sqlite` and SQLite FTS5 both work for the full local search/indexing
  path; SQLite remains marked experimental by Node and may emit runtime
  warnings.
- SQL is the persistence language for derived runtime state. Local mode uses
  SQLite; hosted mode targets Postgres.
- Markdown with YAML frontmatter is the page authoring format for v0.1.
- YAML is allowed for human-authored manifests. JSON, JSONL, JSON Schema, and
  OpenAPI are the protocol and interchange formats.
- Shell is allowed for packaging and deployment wrappers only.
- Python is allowed for development scripts and evals, but not as a v0.1
  product runtime dependency.
- Rust is reserved for optional high-performance search, indexing, or native
  adapters after the protocol, TypeScript search adapter, and search evals are
  stable.

## Rationale

TypeScript gives the shortest path to a coherent product:

- MCP, HTTP, CLI, web UI, and OpenCode/Open Cowork integrations can share the
  same package graph and protocol types.
- JSON Schema and OpenAPI contracts map naturally to TypeScript types.
- The first local deployment can be one Node process plus SQLite.
- The static export and integration packs can reuse the same repository parser
  and renderer.

Rust is attractive for search-heavy work, and dbt-nova proves that a Rust
search core can be valuable. OpenWiki should not start there as the main
runtime because the immediate risk is protocol churn, not raw search speed.
Rust should enter only when benchmarks show a real bottleneck and when the
TypeScript package boundary is stable enough to keep it optional.

Go is not selected for v0.1. It is operationally simple, but it does not improve
the immediate integration path enough to justify a second primary runtime.

Python is not selected for product runtime code because OpenWiki needs long-run
servers, packaged CLIs, and deployment artifacts that should remain small and
predictable. Python remains useful for offline evaluation and one-off
development tooling.

## Future Rust Criteria

Introduce Rust only if one or more of these are true:

- Local search/index rebuilds exceed the latency budget on representative wiki
  corpora.
- Dense, sparse, or reranker integrations need native performance or model
  runtime support.
- Static export or hosted indexing needs parallel parsing beyond what Node can
  handle comfortably.
- A Rust sidecar can preserve the OpenWiki Protocol without becoming required
  for local mode.

The Rust package, if introduced, must be optional and must not own canonical
repo semantics. Git records, schemas, protocol IDs, and API contracts remain
language-neutral.

## Consequences

- New v0.1 implementation packages should be TypeScript packages under
  `packages/`.
- Cross-surface behavior should live in shared packages before adapters call it.
- Performance-sensitive code should first expose diagnostics and benchmarks,
  then graduate to a native sidecar only with evidence.
- The protocol must stay runtime-neutral even though the first implementation is
  TypeScript.
