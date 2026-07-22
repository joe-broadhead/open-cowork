# Performance And Scale

OpenWiki has explicit scale profiles so local users, teams, and hosted
operators can tell whether a deployment is inside the supported envelope.

| Profile | Target | Gate | Budget |
| --- | --- | --- | --- |
| v0.1 local/team | 1k pages with SQLite search and derived graph indexes | `pnpm perf:check` | Blocking smoke gate; p95 records/graph under 250 ms, search under 750 ms, and page render under 400 ms on GitHub-hosted CI-class hardware. |
| v0.2 team/hosted | 10k pages or records | `pnpm perf:scale:10k` and the scheduled `OpenWiki Scale Performance` workflow | Non-blocking benchmark evidence; p50 and p95 are reported, with p95 budgets tracked in `artifacts/openwiki-scale-perf-benchmark-10k.json` (records 500 ms, search 1500 ms, page 2500 ms, graph 750 ms). |
| Enterprise | 100k+ records | `pnpm perf:scale:100k` plus deployment-specific Postgres measurements | Hosted deployments should use the Postgres read/search runtime, external object storage, and durable queue/write coordination; local 100k reports are manual evidence, not a default release blocker. |

`pnpm perf:check` is the release-readiness smoke profile. Pull requests that
touch packages, tests, lockfiles, or the scale script run the same 1k smoke
profile through the `OpenWiki Scale Performance` workflow, so perf budgets can
fail a PR before release validation. The profile creates a 1k synthetic wiki,
builds the SQLite search index and derived graph index, serves the full HTTP
app, measures records, search, page rendering, and graph neighbors, then writes
`artifacts/openwiki-scale-perf-smoke-1k.json` and the compatibility copy
`artifacts/openwiki-scale-perf.json`.

The larger profiles are benchmarks. They still produce pass/fail budget fields
in the report, but do not fail the command unless
`OPENWIKI_SCALE_ENFORCE=1` is set:

```sh
pnpm perf:scale:10k
pnpm perf:scale:100k
OPENWIKI_SCALE_ENFORCE=1 pnpm perf:scale:10k
```

The scheduled GitHub workflow runs the 10k benchmark weekly and uploads the
JSON report as `openwiki-scale-performance`. Run the workflow manually to
capture a 1k, 10k, or 100k report for release notes.

## Release 10k Evidence

The v0.1 release candidate must have 10k synthetic-wiki evidence for the local
SQLite/search/graph path. This is release evidence for the code path used by
local and single-node deployments; it is not a hosted Postgres capacity claim.

The exact release-candidate run URL and artifact must be linked from
[#64](https://github.com/joe-broadhead/open-wiki/issues/64) and from the GitHub
release notes. This page describes the required evidence shape so it does not
become stale when the candidate commit advances.

The 10k benchmark artifact is `openwiki-scale-performance` from the
`OpenWiki Scale Performance` workflow with `mode=benchmark` and `stage=10k`.
It must contain `openwiki-scale-perf-benchmark-10k.json` with:

- `records: 10000`
- `iterations: 20`
- `search_records`, `derived_records`, and `derived_edges`
- pass/fail checks for records, search, page render, and graph neighbors

For v0.1 release notes, cite the artifact's p50/p95 measurements in this shape:

| Endpoint | p50 | p95 | Advisory p95 budget |
| --- | ---: | ---: | ---: |
| Records API | `<p50>` | `<p95>` | 500 ms |
| Search API | `<p50>` | `<p95>` | 1500 ms |
| Page render | `<p50>` | `<p95>` | 2500 ms |
| Graph neighbors | `<p50>` | `<p95>` | 750 ms |

These numbers should be cited as 10k local/scheduled benchmark evidence only.
Hosted Postgres release claims still require a managed Postgres-backed run with
the runtime variables in the next section, plus CPU, memory, database class,
database size, image digest, and request-latency observations.

## Budget Gate Decision

For v0.1, only the 1k smoke profile is a blocking release gate. The 10k profile
is required release evidence but stays advisory because it depends on hosted
hardware shape, database class, and runner noise. Promote the 10k p95 budgets to
a blocking gate only after three consecutive scheduled main-branch benchmark
runs produce usable artifacts inside budget on the chosen release hardware. A
miss before that promotion opens a hardening issue with the artifact attached;
it does not block an otherwise healthy patch release.

Enterprise 100k and 1m reports remain manual capacity evidence. They should be
captured when changing the Postgres importer, search path, queue backend, or
write-coordination path, but they are not default CI gates for v0.1.

## Search Path

SQLite search uses the indexed lexical path for ordinary exact/BM25 queries:
filters are pushed into SQLite, candidate rows are permission-filtered before
fusion, and only returned candidate JSON is parsed. Fuzzy and graph/ngram-only
edge cases fall back to the full in-process retrievers so behavior is preserved.

When `include_explain=true`, search responses include diagnostic fields:

- `backend`: `sqlite` or `postgres`
- `capabilities`: supported retrievers, unsupported retrievers, fuzzy/ngram/graph
  support, permission-filter mode, and backend limit/offset ceilings
- `disabled_retrievers`: requested or configured retrievers that did not run for
  the selected backend, mode, or configuration
- `candidate_strategy`: indexed, fallback, or hosted runtime strategy
- `index_content_hash` and `index_record_count` for SQLite index metadata
- `candidate_ids`, `record_json_reads`, and `scanned_rows`
- `elapsed_ms` for SQLite query-side profiling

These diagnostics are intended for profiling slow searches without exposing
hidden records. Permission filtering remains part of the candidate path before
result fusion.

## Hosted Scale Path

Postgres is the hosted scale path. In hosted deployments set:

```sh
OPENWIKI_RUNTIME_MODE=hosted
OPENWIKI_DATABASE_URL=postgres://...
OPENWIKI_READ_BACKEND=postgres
OPENWIKI_SEARCH_BACKEND=postgres
OPENWIKI_QUEUE_BACKEND=postgres
OPENWIKI_WRITE_COORDINATOR_BACKEND=postgres
OPENWIKI_OPERATIONAL_STATE_BACKEND=postgres
```

Before collecting scale numbers, prove the hosted runtime contract:

```sh
pnpm evidence:hosted-readiness -- --dry-run

OPENWIKI_DATABASE_URL="postgres://..." \
pnpm evidence:hosted-readiness -- --enforce
```

The hosted readiness evidence runner is a functional gate, not a capacity
benchmark. It proves the boot sequence and multi-process contract: migrations,
full Postgres sync, two HTTP replicas, Postgres-backed reads/search, hosted MCP
session sharing, Postgres queue/worker execution, write-lock contention, and
shared rate-limit windows. Use the hosted Postgres scale runner below after
that contract passes.

**CI policy (JOE-975 / wiki audit P2-3):** monorepo PR `CI Wiki` runs the dry-run
contract unit test only (`tests/hosted-readiness-evidence.test.ts`) so PR cost
stays bounded. `Release Wiki` re-runs `pnpm evidence:hosted-readiness -- --dry-run`.
Live `--enforce` (dual HTTP replicas + Postgres) remains an operator/release
step when `OPENWIKI_DATABASE_URL` is available—not a required gate on every PR.

In `hosted` and `enterprise` runtime modes, OpenWiki disables request-path
SQLite index rebuilds and full-repo search fallbacks by default. That prevents
a missing or stale derived store from turning one user search into a full
workspace scan on every replica. Run the worker/index sync path before serving
traffic, or use the Postgres search runtime above. The low-level search API
still has explicit diagnostic overrides for local operator tooling, but hosted
HTTP/MCP requests should not rely on them.

The Postgres search runtime uses database-side exact and FTS/BM25-style lexical
retrieval with policy prefilter batches. It reports `fuzzy`, `ngram`, and
`graph` as unsupported retrievers in `capabilities`; when a caller asks for
`fuzzy=true`, the request is downgraded to lexical retrieval and
`disabled_retrievers` includes `fuzzy`. This keeps hosted search bounded and
deterministic while preserving the same response shape as local SQLite search.

For release validation, a 10k-record hosted workspace should complete a full
`db sync-postgres --full` within five minutes on a small managed Postgres
instance or faster local equivalent, and an incremental sync after a single page
edit should complete within ten seconds. Capture the record count, edge count,
search document count, elapsed time, database size class, and image digest in
release notes when changing the importer or schema.

The first hosted Postgres evidence run should record:

- cloud/provider, region, database class, storage size, and image digest
- exact runtime environment variables, with secrets redacted
- `db sync-postgres --full` elapsed time and imported record/search/edge counts
- incremental sync elapsed time after one committed page edit
- `/readyz`, search, page-render, graph-neighbors, and hosted MCP auth-token
  probe latencies
- CPU, memory, database CPU/IO, and connection-count observations during the run
- backup/restore drill evidence or a linked provider-native backup policy

## Current GCP Hosted Postgres Evidence

The current hosted Postgres release evidence is tracked in
[#198](https://github.com/joe-broadhead/open-wiki/issues/198), with the exact
commit, generated timestamp, p50/p95 measurements, and artifact summary posted
there. The measured environment is GCP Cloud SQL for PostgreSQL 16 in
`us-central1`, `db-custom-4-15360` Enterprise edition, 10 GB PD_SSD, public IP
restricted to the operator IP, with the runner executed from source rather than
a published image digest.

The hosted 10k evidence artifact must record `records: 10000`, `iterations: 8`,
`record_count: 10261`, `edge_count: 40006`, `search_document_count: 10261`, and
`dirty_files: []`. Every check must pass these budgets:

| Check | Budget |
| --- | ---: |
| Full Postgres sync | 300 s |
| Incremental Postgres sync | 10 s |
| `/readyz` p95 | 1000 ms |
| Search p95 | 1500 ms |
| Page render p95 | 2500 ms |
| Graph neighbors p95 | 750 ms |
| MCP read-token p95 | 2000 ms |

Passing 10k hosted Postgres evidence does not prove 100k+ or multi-replica
readiness; those remain enterprise roadmap targets until separate hosted
evidence is captured on appropriately sized infrastructure.

Use the hosted Postgres evidence runner to make that evidence repeatable:

```sh
pnpm perf:postgres:hosted -- --dry-run

OPENWIKI_DATABASE_URL="postgres://..." \
OPENWIKI_POSTGRES_SCALE_PROVIDER="aws|gcp|local|other" \
OPENWIKI_POSTGRES_SCALE_REGION="..." \
OPENWIKI_POSTGRES_SCALE_DATABASE_CLASS="..." \
OPENWIKI_POSTGRES_SCALE_DATABASE_STORAGE="..." \
OPENWIKI_IMAGE_DIGEST="ghcr.io/joe-broadhead/open-wiki@sha256:..." \
pnpm perf:postgres:hosted -- --stage 10k --iterations 8
```

The runner writes `artifacts/openwiki-postgres-scale-evidence.json`. It creates
a synthetic workspace, creates a temporary hosted read-only service-account
token, commits the fixture to Git, measures full Postgres sync, serves the HTTP
app with hosted Postgres read/search/queue/write-coordination/operational-state
environment variables, probes `/readyz`, search, page rendering, graph
neighbors, and Streamable HTTP MCP with the bearer token, commits one page edit,
and measures incremental Postgres sync. It records the database URL only by
environment-variable name; do not pass database URLs on the command line.
