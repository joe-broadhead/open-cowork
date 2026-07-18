# OpenWiki Protocol v0.1

Status: Accepted for OpenWiki v0.0.0
Date: 2026-05-21
Audience: implementers of OpenWiki servers, CLIs, MCP servers, static exports, and agent integrations

## 1. Purpose

OpenWiki is a Git-backed, protocol-first knowledge substrate for humans,
agents, scripts, and hosted applications.

The protocol defines the durable contract that all OpenWiki surfaces use:

- Repository format: the canonical Git-native knowledge format.
- Runtime operations: search, read, trace, propose, review, ingest, and publish.
- Adapter contracts: MCP, CLI, HTTP, static export, and future agent protocols.
- Governance model: proposals, decisions, diffs, validation reports, and commits.
- Search model: fusion search across lexical, graph, semantic, and governance signals.

OpenWiki must not depend on one agent runtime. OpenCode is a first-class
maintainer harness. Open Cowork is a first-class client. MCP is the first-class
agent interface. CLI and HTTP are required universal interfaces.

## 2. Design Commitments

1. Git is the canonical ledger, not the hot serving layer.
2. Runtime indexes are derived state and can be rebuilt from the repository.
3. Operations are defined once and exposed through MCP, CLI, HTTP, and static exports.
4. Reads are broadly available; writes are scoped, auditable, and policy-gated.
5. External sources are untrusted evidence, never trusted instructions.
6. Search is explainable and deterministic.
7. Static hosting remains machine-readable.
8. Local mode must work with Git, SQLite, and a single OpenWiki process.
9. Hosted mode must scale to Postgres, object storage, queues, workers, and separate search backends.
10. The protocol must outlive any one implementation language or agent harness.

The terms MUST, SHOULD, MAY, REQUIRED, and OPTIONAL are used in the RFC 2119
sense when capitalized.

## 3. Implementation Language Decisions

OpenWiki v0.1 is TypeScript-first.

### 3.1 Product Languages

- TypeScript is the primary implementation language for the core packages,
  repo parser, schemas, CLI, MCP server, HTTP API, workflows, and web app.
- SQL is the persistence language for derived runtime state. Local mode uses
  SQLite. Hosted mode uses Postgres.
- Markdown is the page authoring format. Pages use Markdown with YAML
  frontmatter, not MDX, for v0.1.
- YAML is allowed for human-authored manifests. JSON and JSONL are the protocol
  and export formats.
- Shell is allowed only for packaging and deployment wrappers.
- Python is allowed for development scripts and evals, but not as a product
  runtime dependency in v0.1.
- Rust is not part of the v0.1 critical path. Rust MAY be introduced later as
  an optional high-performance search/indexing sidecar or native package, after
  the protocol and TypeScript search adapter are stable.

### 3.2 Runtime and Toolchain

- Node.js 24 is the primary CI and container runtime target for apps, servers,
  and workers.
- Packages SHOULD preserve `>=22.22.3` compatibility. OpenWiki uses
  `node:sqlite` with SQLite FTS5; Node 22.13.0 loads `node:sqlite` but its
  hosted Linux build lacks FTS5, so 22.22.3 is the tested minimum Node 22
  release for the full local search/indexing path. Node still reports SQLite as
  experimental and may emit runtime warnings.
- The monorepo SHOULD use `pnpm` workspaces.
- JSON Schema 2020-12 is the normative schema language.
- TypeScript types SHOULD be generated from JSON Schemas or kept in lockstep
  with schema tests.
- Runtime validation SHOULD use a JSON Schema validator.
- HTTP contracts SHOULD be published as OpenAPI 3.1.

Rationale: TypeScript is the shortest path to first-class MCP, HTTP, CLI, web,
Open Cowork, and OpenCode integration. Rust remains attractive for search-heavy
work, as dbt-nova demonstrates, but OpenWiki should first stabilize its protocol
and data model.

The durable decision record is `docs/adr/0001-language-and-runtime-strategy.md`.

## 4. Layers

OpenWiki has three product layers:

1. OpenWiki Repository Format
   - Git-native pages, source manifests, claims, proposals, decisions, and config.
2. OpenWiki Runtime
   - Search, indexing, graph extraction, MCP, CLI, HTTP API, auth, jobs, and Git workflows.
3. OpenWiki Surfaces
   - Human website, Open Cowork pack, OpenCode pack, static export, cloud app,
     Umbrel package, and enterprise deployment.

Only the repository format is canonical. Runtime state and surfaces are derived.

## Normative Detail Pages

The v0.1 protocol is split into focused normative pages so implementation
changes stay reviewable while this overview URL remains stable.

| Area | Detail Page |
| --- | --- |
| Identifiers, URIs, repository layout, and page format | [Repository Format](protocol/repository-format.md) |
| Page, source, claim, proposal, comment, decision, and run records | [Canonical Records](protocol/records.md) |
| Cross-surface operation contract | [Operation Contract](protocol/operation-contract.md) |
| Fusion search, indexing, and deployment search profiles | [Search](protocol/search.md) |
| MCP tool tiers, resources, prompts, and queue contract | [MCP Adapter](protocol/mcp.md) |
| HTTP API, browser write protection, webhooks, and OpenAPI | [HTTP Adapter](protocol/http.md) |
| CLI and static export surfaces | [CLI And Static Export](protocol/cli-static-export.md) |
| Git writes, permissions, events, source ingestion, and security requirements | [Git, Permissions, And Security](protocol/git-permissions-security.md) |
| Reference implementation status, open questions, and references | [Status And References](protocol/status-and-references.md) |

## 5. Canonical Identifiers

See [Repository Format](protocol/repository-format.md#5-canonical-identifiers).

## 6. Canonical URIs

See [Repository Format](protocol/repository-format.md#6-canonical-uris).

## 7. Repository Format

See [Repository Format](protocol/repository-format.md#7-repository-format).

## 8. Page Format

See [Repository Format](protocol/repository-format.md#8-page-format).

## 9. Canonical Records

See [Canonical Records](protocol/records.md#9-canonical-records).

## 10. Operation Contract

See [Operation Contract](protocol/operation-contract.md).

## 11. Search Protocol

See [Search](protocol/search.md#11-search-protocol).

## 12. MCP Adapter

See [MCP Adapter](protocol/mcp.md#12-mcp-adapter).

## 13. HTTP Adapter

See [HTTP Adapter](protocol/http.md#13-http-adapter).

## 14. CLI Adapter

See [CLI And Static Export](protocol/cli-static-export.md#14-cli-adapter).

## 15. Static Export

See [CLI And Static Export](protocol/cli-static-export.md#15-static-export).

## 16. Git Write Model

See [Git, Permissions, And Security](protocol/git-permissions-security.md#16-git-write-model).

## 17. Permissions

See [Git, Permissions, And Security](protocol/git-permissions-security.md#17-permissions).

## 18. Events

See [Git, Permissions, And Security](protocol/git-permissions-security.md#18-events).

## 19. Source Ingestion Security

See [Git, Permissions, And Security](protocol/git-permissions-security.md#19-source-ingestion-security).

## 20. Security Requirements

See [Git, Permissions, And Security](protocol/git-permissions-security.md#20-security-requirements).

## 21. v0.1 Reference Implementation Status

See [Status And References](protocol/status-and-references.md#21-v01-reference-implementation-status).

## 22. Open Questions

See [Status And References](protocol/status-and-references.md#22-open-questions).

## 23. References

See [Status And References](protocol/status-and-references.md#23-references).
