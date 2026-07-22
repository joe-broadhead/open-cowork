# Module Guide

OpenWiki keeps the public product contracts in CLI, HTTP, MCP, schemas, Git
records, and static artifacts. Workspace packages are internal implementation
modules, but contributors should still be able to find behavior by concern.

## Large Package Seams

The largest packages intentionally keep `src/index.ts` as the package barrel and
main orchestration surface. Concern-specific code should move into adjacent
internal modules when it can be tested and reviewed independently.

| Package | Concern | Module |
| --- | --- | --- |
| `@openwiki/cli` | Flag parsing and typed option normalization | `packages/cli/src/args.ts` |
| `@openwiki/cli` | Deployment profile definitions and alias resolution | `packages/cli/src/deployment-profiles.ts` |
| `@openwiki/cli` | Human/JSON output helpers and live help text | `packages/cli/src/output.ts` |
| `@openwiki/cli` | Process signal handling and server shutdown registration | `packages/cli/src/process-lifecycle.ts` |
| `@openwiki/cli` | Git sync command contracts and human output | `packages/cli/src/commands/sync-types.ts`, `packages/cli/src/commands/sync-output.ts` |
| `@openwiki/index-store` | SQLite derived-row JSON parsing and validation | `packages/index-store/src/records.ts` |
| `@openwiki/repo` | Markdown frontmatter and the repository YAML subset | `packages/repo/src/frontmatter.ts` |
| `@openwiki/repo` | Workspace config JSON parsing and protocol validation | `openWikiWorkspaceConfigFromUnknown` from `@openwiki/core` |
| `@openwiki/repo` | Workspace templates and default seed policy | `packages/repo/src/templates.ts` |
| `@openwiki/jobs` | Queue adapters and backend selection | `packages/jobs/src/queue.ts` |
| `@openwiki/jobs` | Run dispatch by `run_type` | `packages/jobs/src/dispatcher.ts` |
| `@openwiki/jobs` | Worker loop, claiming, heartbeat, and execution lifecycle | `packages/jobs/src/worker.ts` |
| `@openwiki/mcp-server` | Read/proposal/write tool definition groups | `packages/mcp-server/src/tool-definitions-read.ts`, `packages/mcp-server/src/tool-definitions-proposal.ts`, `packages/mcp-server/src/tool-definitions-write.ts` |
| `@openwiki/postgres-runtime` | Schema SQL and migration inventory | `packages/postgres-runtime/src/schema.ts` |
| `@openwiki/postgres-runtime` | Runtime JSON parsing and protocol-row validation | `packages/postgres-runtime/src/records.ts` |
| `@openwiki/postgres-runtime` | Read queries (summary/records/events/runs) | `packages/postgres-runtime/src/queries.ts` |
| `@openwiki/postgres-runtime` | Catalog reads (topics/sources/identities) | `packages/postgres-runtime/src/queries-catalog.ts` |
| `@openwiki/postgres-runtime` | Table/status count helpers | `packages/postgres-runtime/src/queries-counts.ts` |
| `@openwiki/search` | Search index JSON row validation | `packages/search/src/records.ts` |
| `@openwiki/workflows` | Governance detector workflow and visibility filtering | `packages/workflows/src/governance.ts` |
| `@openwiki/workflows` | Inbox submit/status, processing, and watch orchestration | `packages/workflows/src/inbox-submit.ts`, `packages/workflows/src/inbox-process.ts`, `packages/workflows/src/inbox-watch.ts` |
| `@openwiki/workflows` | Source fetch validation, DNS pinning, and fetch metrics | `packages/workflows/src/source-fetch.ts` |
| `@openwiki/workflows` | Local/Postgres write coordination and lock metrics | `packages/workflows/src/write-coordinator.ts` |
| `@openwiki/http-api` | HTTP option/result types | `packages/http-api/src/types.ts` |
| `@openwiki/http-api` | Request body parsing, query helpers, redirects, CORS, and response writing | `packages/http-api/src/request.ts` |
| `@openwiki/http-api` | OAuth route façade, token grants, pure helpers | `packages/http-api/src/oauth.ts`, `oauth-token-routes.ts`, `oauth-helpers.ts` |
| `@openwiki/http-api` | Bounded markdown render cache for server HTML | `packages/http-api/src/markdown-cache.ts` |
| `@openwiki/http-api` | System routes such as liveness probes | `packages/http-api/src/routes/system.ts` |
| `@openwiki/web` | Graph legend/search/URL controls (CSP-safe styling) | `packages/web/src/client/graph/controls.js` |
| `@openwiki/core` | Derived-store runtime record validation | `openWikiDerivedRecordFromUnknown`, `openWikiIndexedRecordJsonFromUnknown` |
| `@openwiki/core` | Proposal path and section filtering shared by Git, SQLite, and Postgres readers | `openWikiProposalTargetPaths`, `openWikiProposalSectionIds` |
| `@openwiki/core` | Validation report artifact parsing | `validationReportFromUnknown` |

## Package Boundary Rules

- Keep `src/index.ts` as the public package barrel. Put new implementation code
  in concern-specific internal modules and re-export only the package contract.
- Put canonical types, protocol validators, path matching, pagination cursors,
  and adapter-shared filtering helpers in `@openwiki/core`.
- Put Git-backed file layout, frontmatter/YAML parsing, and repository loaders in
  `@openwiki/repo`. Adapter packages should not reimplement canonical path
  derivation when a repo/core helper exists.
- Put business workflows in `@openwiki/workflows`; CLI, HTTP, and MCP adapters
  should call workflow functions rather than duplicating mutation behavior.
- Put queue claiming, backend adapters, and run execution in `@openwiki/jobs`.
  New `run_type` dispatch should go in `packages/jobs/src/dispatcher.ts`, not in
  the queue adapter.
- Put MCP tool schemas in the read/proposal/write definition modules and keep
  handlers in `tool-handlers.ts`.
- Parse JSON as `unknown`, then pass it through a core/repo/adapter validator
  before treating it as an OpenWiki protocol type.

## Error Mapping

Shared OpenWiki errors live in `@openwiki/core`. Adapter layers should map errors
through the core helpers instead of inventing per-interface status logic:

- HTTP: `openWikiHttpStatusForError`.
- CLI: `openWikiCliExitCodeForError`.
- MCP: `openWikiMcpJsonRpcCodeForError`.

When adding a new error category, update `OPENWIKI_ERROR_MODEL`, the generated
error reference docs, and `tests/error-model.test.ts`.

## Split Criteria

Prefer extracting code when all of these are true:

- The concern has a stable name a contributor would search for.
- The code has a narrow import surface.
- The package barrel can keep the same public exports.
- Focused tests can prove the behavior stayed the same.

Avoid moving code only to reduce line count if the extraction creates circular
dependencies or makes a route/workflow harder to follow.
