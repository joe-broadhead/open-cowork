# Incident Runbooks

These runbooks assume a hosted deployment with access to logs, `/readyz`,
`/metrics`, the wiki root, and the OpenWiki CLI.

## Auth Exposure

Symptoms:

- unexpected proposal, source, Git, or token-management writes
- logs show unknown `actor_id` values or anonymous write attempts
- `openwiki_rate_limit_rejections_total` rises for auth or proposal routes

Actions:

1. Remove public traffic or restrict ingress to the trusted proxy.
2. Confirm `OPENWIKI_PUBLIC_ORIGIN` exactly matches the browser origin.
3. Confirm trusted headers are stripped from inbound client requests and added
   only by the proxy.
4. Rotate `OPENWIKI_TRUST_AUTH_HEADERS_SECRET` and
   `OPENWIKI_TRUST_PROXY_ORIGIN_SECRET`.
5. Rotate affected service-account tokens:

```sh
openwiki --root /data/wiki auth token revoke <service-account-id> --token-id <token-id> --reason "incident rotation" --json
openwiki --root /data/wiki auth token create <service-account-id> --profile proposal-agent --json
```

6. Review recent audit events:

```sh
openwiki --root /data/wiki audit export --since 2026-05-29T00:00:00.000Z --json
```

## Stuck Write Lock

Symptoms:

- HTTP 423 write-in-progress responses
- `openwiki_write_lock_acquisitions_total{status="busy"}` increases
- `/readyz` shows an active `write_lease`

Actions:

1. Inspect the lease:

```sh
openwiki --root /data/wiki db write-lease --json
```

2. If `expires_at` is in the past, recover it:

```sh
openwiki --root /data/wiki db recover-write-lease --json
```

3. If the lease is not expired, find the owning pod/process from `actor_id`,
   `operation`, and logs.
4. Stop the owner only after confirming it is deadlocked.
5. Inspect Git state before resuming writes:

```sh
openwiki --root /data/wiki git status --json
openwiki --root /data/wiki db check --json
```

## Stale Derived Store

Symptoms:

- `/readyz` returns `not_ready`
- `openwiki_component_ok{component="index_store"}` or
  `openwiki_component_ok{component="postgres_runtime"}` is `0`
- search/read results do not reflect Git

Actions:

1. Inspect drift:

```sh
openwiki --root /data/wiki db check --json
```

2. Rebuild local and Postgres derived stores:

```sh
openwiki --root /data/wiki db migrate
openwiki --root /data/wiki index --json
openwiki --root /data/wiki db rebuild --json
openwiki --root /data/wiki db sync-postgres --full --json
openwiki --root /data/wiki run lint --json
```

3. Confirm readiness:

```sh
curl --fail http://127.0.0.1:3030/readyz
```

## Failing Source Fetch

Symptoms:

- `openwiki_source_fetch_attempts_total{status="failure"}` or
  `status="timeout"` increases
- `source_fetch_failed` structured logs appear
- queued `source.fetch` runs fail

Actions:

1. Inspect the run:

```sh
openwiki --root /data/wiki runs monitor --status failed --json
openwiki --root /data/wiki runs detail run:... --json
```

2. Verify connector allowlists, credential refs, and env-backed secrets.
3. Confirm the target host is not blocked by SSRF controls and does not
   redirect to another URL.
4. Re-run with a bounded timeout and byte limit:

```sh
openwiki --root /data/wiki source fetch \
  --title "Retry" \
  --url https://example.com/source.md \
  --max-bytes 1048576 \
  --timeout-ms 10000 \
  --json
```

## Queue Backlog

Symptoms:

- `openwiki_queue_jobs{status="queued"}` grows
- `openwiki_queue_stale_running_jobs` is non-zero
- workers are not emitting `job_started` or `job_succeeded` logs

Actions:

1. Inspect queue state:

```sh
openwiki --root /data/wiki runs monitor --json
```

2. Confirm workers use the same `OPENWIKI_ROOT`, `OPENWIKI_DATABASE_URL`, and
   `OPENWIKI_QUEUE_BACKEND=postgres`.
3. Inspect stale jobs without changing state:

```sh
openwiki --root /data/wiki runs reap-stale --max-runtime-ms 1800000 --dry-run --json
```

4. Reap only after confirming the worker is gone:

```sh
openwiki --root /data/wiki runs reap-stale --max-runtime-ms 1800000 --actor actor:agent:ops-reaper --json
```

5. Scale workers conservatively after Git write ownership is understood.

## Restore Drill

Symptoms:

- disaster-recovery rehearsal
- failed deployment or data-plane corruption
- object storage or Postgres restore test

Actions:

1. Rehearse the latest backup into a new path:

```sh
openwiki --root /data/wiki backup verify latest --destination local-backups --json
openwiki --root /data/wiki backup rehearse \
  --destination local-backups \
  --target-root /data/wiki-restore \
  --json
```

2. Recover object storage from bucket versioning, replication, provider backup,
   or the cloud provider restore mechanism when external object storage is used.
3. Restore Postgres from the chosen backup mechanism, then migrate and rebuild:

```sh
openwiki --root /data/wiki-restore db migrate
openwiki --root /data/wiki-restore index --json
openwiki --root /data/wiki-restore db rebuild --json
openwiki --root /data/wiki-restore db sync-postgres --full --json
```

4. Restore trusted proxy secrets, MCP service-account token material, Git
   credentials, and cloud credentials from the operator secret store.
5. Validate:

```sh
openwiki --root /data/wiki-restore validate --json
openwiki --root /data/wiki-restore doctor --profile hosted --json
openwiki --root /data/wiki-restore db check --json
curl --fail http://127.0.0.1:3030/readyz
curl http://127.0.0.1:3030/mcp?tools=read \
  -H 'authorization: Bearer <smoke-test-token>' \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":"tools","method":"tools/list"}'
```

6. Promote only after Git, Postgres, object storage, and service secrets are
   all confirmed.
