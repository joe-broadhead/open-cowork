# Monitoring

## Abuse Controls

Hosted OpenWiki applies route-specific rate limits when explicitly enabled,
when the workspace runtime profile is `compose`, `umbrel`, `cloud`, or
`enterprise`, or when `OPENWIKI_PUBLIC_ORIGIN` is set. Local workspaces stay
permissive by default so a developer can run evals, imports, and MCP smoke tests
without tripping production controls.

Limits are evaluated across the dimensions OpenWiki can see for the request:
remote IP, authenticated actor, and bearer token hash. A request is rejected when
any visible dimension exceeds the route bucket. Tokens and IPs are hashed before
they appear in logs or metric labels.

By default, MCP HTTP sessions, rate-limit windows, and Prometheus counters live
inside one web process. This is correct for local and single-node deployments
and remains bounded by `OPENWIKI_RATE_LIMIT_MAX_KEYS` and
`OPENWIKI_OPERATIONAL_METRIC_MAX_SERIES`.

Set `OPENWIKI_OPERATIONAL_STATE_BACKEND=postgres` for horizontally scaled HTTP
deployments. The Postgres backend stores Streamable HTTP MCP sessions and
rate-limit windows by workspace so a session created by one replica can be used
by another, and excessive requests are rejected consistently across replicas.
Prometheus metrics stay process-local by design; scrape every replica and let
Prometheus aggregate bounded labels.

Recommended starting points:

| Deployment | Setting |
| --- | --- |
| Local personal wiki | Leave rate limits disabled, or set `OPENWIKI_RATE_LIMIT_ENABLED=0`. |
| Private team behind SSO, one web process | Enable limits with the defaults and keep `OPENWIKI_OPERATIONAL_STATE_BACKEND=memory`. |
| Enterprise/shared HTTP MCP, multiple web replicas | Set `OPENWIKI_OPERATIONAL_STATE_BACKEND=postgres`, enable limits, keep source/auth buckets low, and allocate service-account tokens per integration so token-level isolation is useful. |

The same values can be stored in `openwiki.json` under
`runtime.controls.rate_limits`; environment variables override config values for
operational changes during an incident.

```json
{
  "runtime": {
    "profile": "cloud",
    "controls": {
      "rate_limits": {
        "enabled": true,
        "window_ms": 60000,
        "mcp_limit": 120,
        "search_limit": 120,
        "ask_limit": 60,
        "source_limit": 30,
        "proposal_limit": 60,
        "policy_limit": 60,
        "inbox_limit": 60,
        "job_limit": 30,
        "auth_limit": 20
      },
      "source_fetch": {
        "default_max_bytes": 1048576,
        "max_bytes": 5242880,
        "default_timeout_ms": 10000,
        "max_timeout_ms": 30000
      },
      "operational_state": {
        "backend": "postgres"
      }
    }
  }
}
```

## Request Logs

Set `OPENWIKI_REQUEST_LOGS=1` to emit one JSON log line per routed HTTP request.
Set `OPENWIKI_STRUCTURED_LOGS=1` to emit non-request JSON logs for MCP tools,
jobs, source fetches, Git pull/push, and proposal applies:

```json
{
  "timestamp": "2026-05-28T12:00:00.000Z",
  "service": "openwiki",
  "event": "http_request",
  "request_id": "8f0c...",
  "method": "POST",
  "route": "/mcp",
  "operation": "wiki.search",
  "actor_id": "actor:user:ada",
  "status": 200,
  "duration_ms": 18,
  "rate_limited": false,
  "metadata": {
    "rate_limit_bucket": "mcp",
    "token_hash": "4f2a...",
    "mcp_tool": "wiki.search"
  }
}
```

OpenWiki does not log raw bearer tokens, source credentials, connector headers,
or request payload bodies. Ship process logs to your platform log pipeline and index
`request_id`, `actor_id`, `route`, `operation`, `status`, and `rate_limited`.
HTTP responses include `x-openwiki-request-id` and `x-request-id`; use either
header to join proxy logs to OpenWiki logs.

## Health And Metrics

Use `/livez` for process liveness and `/readyz` for dependency readiness.
Scrape `/metrics` for Prometheus-compatible counters and gauges. Metrics are
admin-scoped by default; set `OPENWIKI_PUBLIC_METRICS=1` only when an internal
network policy, service mesh, or scrape proxy already protects the endpoint.

```sh
curl --fail http://127.0.0.1:3030/livez
curl --fail http://127.0.0.1:3030/readyz
curl --fail -H "Authorization: Bearer $OPENWIKI_ADMIN_TOKEN" http://127.0.0.1:3030/metrics
```

Readiness failures should block traffic. Liveness failures should restart the
container. Metrics should be protected by network policy or an internal scrape
path.
`openwiki serve` handles SIGTERM and SIGINT by closing the listener, rejecting
new requests, draining existing connections, and force-closing remaining
connections after `OPENWIKI_SHUTDOWN_TIMEOUT_MS`.

Prometheus scrape example:

```yaml
scrape_configs:
  - job_name: openwiki
    metrics_path: /metrics
    static_configs:
      - targets: ["openwiki.default.svc.cluster.local:3030"]
```

Key operational metrics:

| Metric | Use |
| --- | --- |
| `openwiki_http_requests_total` | Request volume by route, operation, and status. |
| `openwiki_http_request_duration_seconds` | Request latency histogram by route, operation, and status. |
| `openwiki_mcp_tool_calls_total` | HTTP MCP tool calls by tool, mode, and result. |
| `openwiki_mcp_tool_duration_seconds` | MCP tool latency histogram by tool, mode, and result. |
| `openwiki_rate_limit_rejections_total` | Abuse-control rejections by route and dimension. |
| `openwiki_proposal_lifecycle_events_total` | Proposal creation, comments, decisions, applies, and closes. |
| `openwiki_write_lock_acquisitions_total` | Write coordinator acquisitions, busy responses, and errors. |
| `openwiki_write_lock_wait_seconds_total` | Total wait time before write lock acquisition or rejection. |
| `openwiki_write_lock_hold_seconds_total` | Total time spent holding write locks. |
| `openwiki_queue_runs` and `openwiki_queue_jobs` | Queue depth by status. |
| `openwiki_job_duration_seconds_total` and `openwiki_job_duration_seconds_count` | Completed job duration by run type and status. |
| `openwiki_search_duration_seconds` | Search latency histogram by backend, mode, and status. |
| `openwiki_source_fetch_attempts_total` | Source fetch successes, failures, and timeouts by connector kind. |
| `openwiki_source_fetch_duration_seconds_total` and `openwiki_source_fetch_duration_seconds_count` | Source fetch duration by connector kind and status. |

Sample Prometheus alerts and a Grafana dashboard live in
`deploy/observability/`. See the Observability guide for import and scrape
details.
