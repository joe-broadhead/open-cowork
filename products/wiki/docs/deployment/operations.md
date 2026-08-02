# Operations

This runbook covers a source-operated OpenWiki network runtime. Static export
is simpler: generate output from a trusted checkout and publish only the
generated directory.

## Canonical And Derived State

Git is canonical. SQLite indexes, Postgres read/search tables, queues, object
storage captures, static output, and rendered responses are derived or
operational state. Rebuild derived stores after restore, migration, or suspected
drift.

## Security Boundary

A write-capable network runtime must sit behind an authentication boundary.
Set `OPENWIKI_PUBLIC_ORIGIN` to the browser-visible HTTPS origin. Enable trusted
identity or forwarded-origin headers only when the proxy strips untrusted
headers and supplies the matching shared secret.

Remote MCP agents use scoped service-account bearer tokens. Keep personal
agents on stdio MCP where possible.

## Runtime Shape

| Component | Responsibility | State |
| --- | --- | --- |
| Web process | UI, HTTP API, MCP, health, metrics | Git workspace and derived read state |
| Worker process | Queued index, lint, export, and source jobs | Shared queue and Git workspace |
| Postgres | Optional shared reads, search, queue, write leases, sessions, and rate limits | Derived plus operational state |
| Object storage | Large captures referenced by manifests | Must be backed up with Git metadata |
| Git remote | Collaboration and disaster-recovery ledger | Canonical history |

Single-process local or team use can keep local queues and locks. Before adding
writers or replicas, use Postgres for queue, write coordination, read/search,
and operational state.

## Active Environment Controls

| Variable | Purpose |
| --- | --- |
| `OPENWIKI_RUNTIME_MODE` | `local`, `team`, `hosted`, or `enterprise` safety posture. |
| `OPENWIKI_DATABASE_URL` or `DATABASE_URL` | Postgres connection string. |
| `OPENWIKI_READ_BACKEND` | `postgres` for derived Postgres reads. |
| `OPENWIKI_SEARCH_BACKEND` | `postgres` for derived Postgres search. |
| `OPENWIKI_QUEUE_BACKEND` | `postgres` for durable worker claims. |
| `OPENWIKI_WRITE_COORDINATOR_BACKEND` | `postgres` for shared Git write leases. |
| `OPENWIKI_OPERATIONAL_STATE_BACKEND` | `postgres` for shared MCP sessions and rate-limit windows. |
| `OPENWIKI_PUBLIC_ORIGIN` | Browser-visible origin allowed for writes. |
| `OPENWIKI_TRUST_AUTH_HEADERS` | Enables trusted identity headers; requires a shared secret. |
| `OPENWIKI_TRUST_AUTH_HEADERS_SECRET` | Proxy-to-app identity-header secret. |
| `OPENWIKI_TRUST_PROXY_ORIGIN` | Enables trusted forwarded origin/IP handling. |
| `OPENWIKI_TRUST_PROXY_ORIGIN_SECRET` | Proxy-to-app forwarded-origin secret. |
| `OPENWIKI_RATE_LIMIT_ENABLED` | Enables HTTP and MCP abuse controls. |
| `OPENWIKI_RATE_LIMIT_POLICY` | Overrides the policy-route request limit. |
| `OPENWIKI_RATE_LIMIT_INBOX` | Overrides the inbox-route request limit. |
| `OPENWIKI_RATE_LIMIT_JOB` | Overrides the job-route request limit. |
| `OPENWIKI_RATE_LIMIT_MAX_KEYS` | Bounds in-process rate-limit key storage. |
| `OPENWIKI_SOURCE_FETCH_MAX_BYTES` | Caps operator-configurable source-fetch size. |
| `OPENWIKI_SOURCE_FETCH_MAX_TIMEOUT_MS` | Caps operator-configurable source-fetch timeout. |
| `OPENWIKI_OPERATIONAL_METRIC_MAX_SERIES` | Bounds process-local metric series. |
| `OPENWIKI_MCP_TOOL_OUTPUT_MAX_BYTES` | Bounds final MCP tool output. |
| `OPENWIKI_REQUEST_LOGS` | Enables structured request logs. |
| `OPENWIKI_STRUCTURED_LOGS` | Enables structured application logs. |
| `OPENWIKI_SHUTDOWN_TIMEOUT_MS` | Graceful process drain budget. |

Keep raw tokens, private keys, database URLs, storage keys, and Git credentials
out of `openwiki.json`, logs, static output, and Git history.

## Start And Verify

Run migrations and derived-store synchronization as an explicit operator step
before serving traffic:

```sh
openwiki --root <wiki> db migrate
openwiki --root <wiki> index --json
openwiki --root <wiki> db rebuild --json
openwiki --root <wiki> db sync-postgres --full --json
openwiki --root <wiki> doctor --profile hosted --json
```

Then verify `/livez`, `/readyz`, authenticated `/metrics`, browser identity,
HTTP MCP token rejection/acceptance, a proposal flow, a verified backup, and a
restore rehearsal.

## Focused Runbooks

- [Operations Matrix](operations/matrix.md)
- [Monitoring And Abuse Controls](operations/monitoring.md)
- [Write Coordination](operations/write-coordination.md)
- [Backup And Restore](operations/backup-restore.md)
- [Postgres And Workers](operations/postgres-and-workers.md)
- [Upgrades And Rollback](operations/upgrades.md)
- [Incident Response](operations/incidents.md)
- [Incident Runbooks](runbooks.md)
