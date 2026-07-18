# Observability

OpenWiki exposes three production diagnostic surfaces:

- structured JSON logs for requests, MCP tools, jobs, Git sync, source fetch,
  and proposal apply operations
- Prometheus metrics at `/metrics`
- readiness component details at `/readyz`

Enable structured logs in hosted deployments:

```sh
OPENWIKI_STRUCTURED_LOGS=1
OPENWIKI_REQUEST_LOGS=1
```

`OPENWIKI_REQUEST_LOGS=1` keeps request logging explicit. `OPENWIKI_STRUCTURED_LOGS=1`
also enables non-request logs from workers, MCP stdio servers, source fetches,
Git sync, and proposal applies. Logs are JSON lines and include stable fields
such as `event`, `level`, `actor_id`, `correlation_id`, `duration_ms`,
`metadata`, and `error`.

OpenWiki redacts raw tokens, authorization headers, cookies, connector headers,
request bodies, private keys, passwords, and secret values before writing a log
entry. Operators should index `request_id`, `correlation_id`, `actor_id`,
`event`, `route`, `operation`, `status`, and `metadata.run_id`.

## Request IDs

HTTP responses include both `x-openwiki-request-id` and `x-request-id`.
Incoming `x-request-id` or `x-correlation-id` is preserved when supplied by a
trusted proxy or load balancer.

Use the request ID to join:

- reverse-proxy logs
- OpenWiki request logs
- MCP HTTP logs
- application errors

Job execution uses the run id as `correlation_id`, so worker logs can be joined
to `openwiki runs detail <run-id> --json` and proposal/source/job events.

## Prometheus Metrics

Scrape `/metrics` with an admin-scoped service token, or set
`OPENWIKI_PUBLIC_METRICS=1` only when an internal network path, service mesh, or
scrape proxy already protects the endpoint.

Metrics are intentionally process-local and bounded. In multi-replica
deployments, scrape each replica and aggregate in Prometheus; do not expect one
OpenWiki process to report another process's counters. The series cap is
controlled by `OPENWIKI_OPERATIONAL_METRIC_MAX_SERIES`, and labels are limited
to workspace, normalized route, operation, status, MCP tool, MCP mode, search
backend/mode, connector kind, write-lock backend/operation, and job/proposal
status fields.

Core series:

| Metric | Purpose |
| --- | --- |
| `openwiki_ready` | Overall readiness. |
| `openwiki_component_ok` | Per-component health for Git, SQLite, Postgres, queue, object storage, search, and config safety. |
| `openwiki_http_requests_total` | HTTP request volume by route, operation, and status. |
| `openwiki_http_request_duration_seconds` | HTTP latency histogram by route, operation, and status. |
| `openwiki_mcp_tool_calls_total` | MCP tool calls by tool, mode, and status. |
| `openwiki_mcp_tool_duration_seconds` | MCP tool latency histogram by tool, mode, and status. |
| `openwiki_search_duration_seconds` | Search latency histogram by backend, mode, and status. |
| `openwiki_source_fetch_attempts_total` | Source fetch successes, failures, and timeouts by connector kind. |
| `openwiki_source_fetch_duration_seconds_total` | Source fetch duration counter by connector kind and status. |
| `openwiki_queue_jobs` | Queue depth by job status. |
| `openwiki_queue_stale_running_jobs` | Postgres jobs running beyond the stale threshold. |
| `openwiki_job_duration_seconds_total` | Completed job duration by run type and status. |
| `openwiki_write_lock_acquisitions_total` | Write lock acquisitions, busy responses, and errors. |
| `openwiki_proposal_lifecycle_events_total` | Proposal lifecycle event counts from the canonical event log. |

Sample artifacts:

- Prometheus alerts: `deploy/observability/prometheus-rules.yaml`
- Grafana dashboard: `deploy/observability/grafana-dashboard.json`

Validate the dashboard JSON before importing:

```sh
python3 -m json.tool deploy/observability/grafana-dashboard.json >/dev/null
```

## Readiness Details

`/readyz` embeds `/healthz` component details:

- `git`: repository presence, dirty state, branch, upstream, ahead/behind
- `index_store`: SQLite freshness and drift checks
- `postgres_runtime`: schema, migration, commit, and content-hash checks
- `queue`: local or Postgres queue depth, oldest queued/running, stale jobs
- `write_lease`: active Postgres write lease diagnostics
- `object_storage`: local or S3-style object backend health
- `search_index`: local SQLite search index presence
- `config_safety`: public origin, trusted headers/proxy, and rate-limit posture

Traffic should only be sent to pods whose `/readyz` returns `ready`.
