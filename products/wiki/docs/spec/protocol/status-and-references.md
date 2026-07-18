# Status And References

## 21. v0.1 Reference Implementation Status

The v0.1 reference implementation includes the original MVP plus the first
protocol adapters and deployment packs:

- protocol spec, language ADR, and JSON Schemas for core records and search responses
- TypeScript pnpm workspace with core, repo, search, policy, validation, workflows, jobs, storage, connectors, MCP, HTTP, CLI, static export, Git, and OpenCode harness packages
- `openwiki init`, starter templates, page/source/claim parsing, local SQLite derived indexing, fusion search, highlighted results, offsets, and explain output
- CLI, HTTP, MCP stdio, MCP HTTP bridge, static export, and adjacent JSON/Markdown page routes for the required v0.1 operations
- proposal, comment, decision, apply, source ingest/propose/fetch, synthesis, publish, commit, Git remote sync, event, run, lint, history, and diff workflows
- durable local run queue and event ledger, plus Server-Sent Events for live updates
- scoped role/token authorization, Git-backed section policy, and governed policy-change proposals for HTTP/MCP/CLI adapters and static export filtering
- source ingestion hardening, bounded fetches, connector/credential references, and local object storage for large captures
- server-rendered human views for dashboard, records, governance artifacts, proposals, and source content
- Open Cowork and OpenCode integration packs
- Docker, Docker Compose, Umbrel, Kubernetes, Helm, Terraform, and GitHub Pages workflow packaging

Remaining v0.x follow-up areas are semantic embeddings, optional cross-encoder
reranking, Redis or managed queue adapters, hosted object-store adapters, and
deeper enterprise RBAC/OIDC/SAML policy packs.

## 22. Open Questions

1. Should source manifests remain YAML long-term, or should JSON become the
   only canonical manifest format after v0.1?
2. Which semantic retrieval adapter should be first: pgvector, Qdrant,
   OpenSearch vector fields, or a local embedding cache?
3. Which hosted queue adapter should follow Postgres: Redis, a managed queue, or
   both in the same compatibility milestone?
4. Which enterprise policy pack should be first: OIDC/SAML auth, row-level
   workspace permissions, audit export, or signed commit enforcement?
5. Should Rust search be introduced before semantic embeddings as a lexical
   performance package, or after embeddings as a larger retrieval sidecar?

## 23. References

- MCP specification 2025-11-25: https://modelcontextprotocol.io/specification/2025-11-25/basic
- MCP tools: https://modelcontextprotocol.io/specification/2025-11-25/server/tools
- MCP resources: https://modelcontextprotocol.io/specification/2025-11-25/server/resources
- MCP authorization: https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- OpenAPI Specification: https://spec.openapis.org/oas/
- SQLite FTS5: https://www.sqlite.org/fts5.html
- Reciprocal Rank Fusion paper: https://doi.org/10.1145/1571941.1572114
- Node.js release schedule: https://github.com/nodejs/Release
