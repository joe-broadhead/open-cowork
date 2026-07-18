# Postgres And Workers

## Rebuilds And Migrations

Use full rebuilds after restore, schema changes, or backend switches:

```sh
openwiki --root /data/wiki db migrate
openwiki --root /data/wiki index --json
openwiki --root /data/wiki db rebuild --json
openwiki --root /data/wiki db sync-postgres --full
openwiki --root /data/wiki run lint --json
```

`db check --json` reports both SQLite index-store freshness and Postgres runtime
metadata when Postgres is configured. Treat schema version, source commit,
content hash, or record-count drift as a signal to rerun `db sync-postgres
--full` before serving hosted reads.

Use incremental sync during normal operation. If the SQLite index store reports
an uncommitted workspace, commit or reset the workspace intentionally before
trusting derived index reads.

## Workers And Queues

Use `OPENWIKI_QUEUE_BACKEND=postgres` when web and worker run in separate
containers. Workers claim queued runs atomically through Postgres and refresh a
running-job heartbeat (`OPENWIKI_RUN_HEARTBEAT_MS`, default 10000 ms) while the
job executes.

```sh
openwiki --root /data/wiki worker --max-jobs 1 --poll-ms 2000
openwiki --root /data/wiki runs monitor --json
```

Keep worker concurrency conservative until Git mutation ownership is explicit.
`runs monitor` includes Postgres queue depth, failed job counts, and stale
running-job diagnostics. A stuck queued run should be investigated through the
run ledger and related audit events before retrying.

Recover running jobs whose worker disappeared:

```sh
openwiki --root /data/wiki runs reap-stale --max-runtime-ms 1800000 --dry-run --json
openwiki --root /data/wiki runs reap-stale --max-runtime-ms 1800000 --actor actor:agent:ops-reaper --json
```

The reaper returns stale jobs to `queued` while attempts remain and marks them
failed after their retry budget is exhausted. To stop a queued or running
Postgres-backed job without editing database rows:

```sh
openwiki --root /data/wiki runs cancel run:... --actor actor:user:admin --reason "Superseded by deploy rollback" --json
```
