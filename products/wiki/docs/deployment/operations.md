# Operations

This runbook covers hosted OpenWiki deployments. Static export is simpler:
generate artifacts from a trusted checkout and deploy the output to a static
host.

## Production Boundary

OpenWiki treats Git as the canonical store. Everything else is derived:

- the local SQLite index store
- Postgres read/search/queue tables
- object storage captures
- static export artifacts
- rendered HTML and API responses

Operate the Git workspace as the source of truth. Rebuild derived stores after
restore, migration, or suspected drift.

Write-capable hosted deployments must sit behind an authentication boundary.
Set `OPENWIKI_PUBLIC_ORIGIN` to the external origin and enable trusted auth
headers only when a proxy strips untrusted inbound headers and supplies
`OPENWIKI_TRUST_AUTH_HEADERS_SECRET`.
See the SSO and reverse proxy auth guide for reference oauth2-proxy, Envoy,
Cloudflare Access, Google IAP, AWS ALB OIDC, and generic OIDC profiles.

## Preflight Checklist

Before serving a deployment publicly:

- pin the container image by digest
- mount persistent storage at `OPENWIKI_ROOT`
- configure Git remote URL, branch, and credentials outside `openwiki.json`
- configure `OPENWIKI_PUBLIC_ORIGIN`
- choose `OPENWIKI_RUNTIME_MODE=local|team|hosted|enterprise`; public
  multi-user servers should use `hosted` or `enterprise`
- configure SSO/reverse-proxy trusted headers or choose service-account-only API access
- decide whether Postgres serves reads, search, queue, or all three
- configure object storage only through env-backed credential refs
- configure hosted rate limits and request logs before exposing HTTP MCP or write APIs
- run `pnpm validate` or the container lint job against the workspace
- rebuild derived stores with `openwiki index` and `openwiki db rebuild`
- for multi-replica or split web/worker containers, run `openwiki db migrate`,
  `openwiki index`, `openwiki db rebuild`, and `openwiki db sync-postgres`
  once from a deployment job, then set `OPENWIKI_BOOTSTRAP_MODE=skip` on the
  serving containers
- run `openwiki deploy preflight --root <wiki> --deploy-profile <profile> --public-origin <https-origin> --image <image@sha256:...>`
- confirm `/livez`, `/readyz`, and `/metrics`
- perform a backup and restore drill

## Runtime Topology

The smallest hosted topology is one web container with a persistent wiki volume.
For team deployments, run:

| Component | Responsibility | State |
| --- | --- | --- |
| Web | HTTP UI, API, MCP HTTP, health, metrics | Git workspace, optional SQLite |
| Worker | Queued local jobs such as index, lint, static export, source fetch | Git workspace, queue backend |
| Postgres | Derived read/search tables and optional durable queue | Rebuildable from Git except queue state |
| Object storage | Large source captures referenced by manifests | Must be backed up with Git |
| Git remote | Canonical collaboration and disaster recovery ledger | Source of truth |

For one-container deployments, keep writes local and run jobs inline. For
multi-container deployments, use Postgres for the queue and ensure only one
writer applies Git mutations at a time.

## Environment Variables

| Variable | Purpose |
| --- | --- |
| `OPENWIKI_ROOT` | Persistent workspace path, usually `/data/wiki`. |
| `OPENWIKI_RUNTIME_MODE` | Runtime safety posture: `local`, `team`, `hosted`, or `enterprise`. Hosted and enterprise modes require Postgres read/search/queue stores and shared operational state before `/readyz` passes. |
| `OPENWIKI_GIT_REMOTE_URL` | Remote repository URL cloned or configured on boot. Use HTTPS or SSH for hosted deployments. |
| `OPENWIKI_ALLOW_LOCAL_GIT_REMOTE` | Set to `1` only for local development, home-lab, NAS, or air-gapped workflows that intentionally use filesystem or loopback HTTP Git remotes. Do not enable it for hosted deployments. |
| `OPENWIKI_GIT_BRANCH` | Branch used for clone, pull, push, and checkout. |
| `OPENWIKI_GIT_PULL_ON_BOOT` | Set to `1` to fast-forward on container boot. |
| `OPENWIKI_DATABASE_URL` or `DATABASE_URL` | Postgres connection string. |
| `OPENWIKI_READ_BACKEND` | Set to `postgres` for derived Postgres reads. |
| `OPENWIKI_SEARCH_BACKEND` | Set to `postgres` for derived Postgres search. |
| `OPENWIKI_QUEUE_BACKEND` | Set to `postgres` for durable worker queue claims. |
| `OPENWIKI_WRITE_COORDINATOR_BACKEND` | Set to `postgres` for multi-container Git write leases. Defaults to `local`, and auto-selects Postgres when the runtime or queue backend is Postgres. |
| `OPENWIKI_WRITE_WAIT_MS` | Optional local wait budget before returning write-in-progress errors. Defaults to fail-fast. |
| `OPENWIKI_WRITE_LEASE_MS` | Write lease expiration window. Defaults to 30000. |
| `OPENWIKI_WRITE_HEARTBEAT_MS` | Write lease heartbeat interval. Defaults to 5000. |
| `OPENWIKI_RATE_LIMIT_ENABLED` | Enables HTTP abuse controls. Defaults to enabled for hosted profiles or when `OPENWIKI_PUBLIC_ORIGIN` is set, and disabled for plain local workspaces. |
| `OPENWIKI_RATE_LIMIT_WINDOW_MS` | Rolling fixed-window size for request limits. Defaults to 60000. |
| `OPENWIKI_RATE_LIMIT_REQUESTS` | Fallback requests per window for limited routes. Defaults to 600. |
| `OPENWIKI_RATE_LIMIT_MCP` | HTTP MCP requests per window. Defaults to 120. |
| `OPENWIKI_RATE_LIMIT_SEARCH` | Search requests per window. Defaults to 120. |
| `OPENWIKI_RATE_LIMIT_ASK` | Ask requests per window. Defaults to 60. |
| `OPENWIKI_RATE_LIMIT_SOURCE` | Source fetch, ingest, and proposal requests per window. Defaults to 30. |
| `OPENWIKI_RATE_LIMIT_PROPOSAL` | Proposal creation, comments, reviews, and applies per window. Defaults to 60. |
| `OPENWIKI_RATE_LIMIT_POLICY` | Spaces and policy browser/API requests per window. Defaults to 60. |
| `OPENWIKI_RATE_LIMIT_INBOX` | Inbox submission, listing, processing, ignore, and retry requests per window. Defaults to 60. |
| `OPENWIKI_RATE_LIMIT_JOB` | Runs, Git sync, commit, and publish requests per window. Defaults to 30. |
| `OPENWIKI_RATE_LIMIT_AUTH` | Auth and token-management requests per window. Defaults to 20. |
| `OPENWIKI_RATE_LIMIT_MAX_KEYS` | Maximum rate-limit keys retained by one process or Postgres workspace. Defaults to 10000. |
| `OPENWIKI_OPERATIONAL_STATE_BACKEND` | Selects the HTTP operational-state backend: `memory` for local/single-node or `postgres` for shared MCP session and rate-limit state across replicas. Defaults to `memory`. |
| `OPENWIKI_OPERATIONAL_METRIC_MAX_SERIES` | Maximum in-memory series retained for process-local counters and histograms. Defaults to 10000. Prometheus should aggregate metrics across replicas. |
| `OPENWIKI_PUBLIC_METRICS` | Set to `1` only when `/metrics` is protected by an internal scrape path. Defaults to admin-scoped metrics. |
| `OPENWIKI_SOURCE_FETCH_DEFAULT_MAX_BYTES` | Default source-fetch response body budget when callers omit `max_bytes`. Defaults to 1048576. |
| `OPENWIKI_SOURCE_FETCH_MAX_BYTES` | Maximum source-fetch response body budget callers may request. Defaults to 5242880. |
| `OPENWIKI_SOURCE_FETCH_DEFAULT_TIMEOUT_MS` | Default source-fetch timeout when callers omit `timeout_ms`. Defaults to 10000. |
| `OPENWIKI_SOURCE_FETCH_MAX_TIMEOUT_MS` | Maximum source-fetch timeout callers may request. Defaults to 30000. |
| `OPENWIKI_MCP_TOOL_OUTPUT_MAX_BYTES` | Final MCP tool-output ceiling before truncation metadata is returned. Defaults to 262144. |
| `OPENWIKI_SHUTDOWN_TIMEOUT_MS` | Graceful shutdown drain timeout used by `openwiki serve` after SIGTERM or SIGINT. Defaults to 10000. |
| `OPENWIKI_REQUEST_LOGS` | Set to `1` to emit structured JSON request logs to the process log stream. |
| `OPENWIKI_STRUCTURED_LOGS` | Set to `1` to emit structured JSON logs for MCP tool calls, jobs, source fetches, Git sync, and proposal applies. |
| `OPENWIKI_PUBLIC_ORIGIN` | External browser origin allowed for write requests. |
| `OPENWIKI_TRUST_AUTH_HEADERS` | Enables trusted identity headers. Requires the shared secret. |
| `OPENWIKI_TRUST_AUTH_HEADERS_SECRET` | Shared proxy-to-app secret for trusted headers. |
| `OPENWIKI_TRUST_PROXY_ORIGIN` | Allows forwarded origin and client-IP evaluation from a trusted proxy. Requires `x-openwiki-proxy-secret`. |
| `OPENWIKI_TRUST_PROXY_ORIGIN_SECRET` | Optional separate shared secret for forwarded origin/IP trust. Defaults to `OPENWIKI_TRUST_AUTH_HEADERS_SECRET` when unset. |
| `OPENWIKI_TOKEN` | Local-only service-account token source for `openwiki serve` and `openwiki mcp --stdio`; prefer this, `--token-env`, or `--token-file` over command-line token literals. |
| `OPENWIKI_SECRET_*` | Runtime secret values referenced by credential refs. |

Never store raw tokens, private keys, storage access keys, or Git passwords in
`openwiki.json`.

When HTTP rate limiting is enabled, OpenWiki applies the default bucket to every
non-public route that does not have a tighter route-specific bucket. Health and
readiness endpoints remain unbucketed so orchestrators can probe instances
during incidents. Metrics are also unbucketed, but they require admin access by
default unless `OPENWIKI_PUBLIC_METRICS=1` is set behind an internal scrape
path.

## Focused Runbooks

| Runbook | Use It For |
| --- | --- |
| [Operations Matrix](operations/matrix.md) | Profile-by-profile support status, backup/sync model, token rotation, health checks, observability, and recovery path. |
| [Monitoring And Abuse Controls](operations/monitoring.md) | Rate limits, request logs, health probes, and Prometheus metrics. |
| [Write Coordination](operations/write-coordination.md) | Durable write leases, shutdown, draining, and stuck-writer recovery. |
| [Backup And Restore](operations/backup-restore.md) | Git, Postgres, object storage, secrets, restore drills, and verification. |
| [Postgres And Workers](operations/postgres-and-workers.md) | Rebuilds, migrations, queues, workers, stale runs, and cancellation. |
| [Upgrades](operations/upgrades.md) | Image digest changes, schema migrations, rollback, and post-upgrade checks. |
| [Incident Response](operations/incidents.md) | Unauthorized writes, Git divergence, queue backlog, read/search drift, and missing object captures. |

The commands above are the copy-paste safe preflight path. The focused runbooks
list additional prerequisites before each destructive or externally visible
operation.

## Abuse Controls

See [Monitoring And Abuse Controls](operations/monitoring.md#abuse-controls).

## Operations Matrix

See [Operations Matrix](operations/matrix.md).

## Request Logs

See [Monitoring And Abuse Controls](operations/monitoring.md#request-logs).

## Health And Metrics

See [Monitoring And Abuse Controls](operations/monitoring.md#health-and-metrics).

## Write Coordination

See [Write Coordination](operations/write-coordination.md).

## Backup And Restore

See [Backup And Restore](operations/backup-restore.md).

## Rebuilds And Migrations

See [Postgres And Workers](operations/postgres-and-workers.md#rebuilds-and-migrations).

## Workers And Queues

See [Postgres And Workers](operations/postgres-and-workers.md#workers-and-queues).

## Upgrades And Rollback

See [Upgrades](operations/upgrades.md).

## Incident Playbooks

See [Incident Response](operations/incidents.md).
