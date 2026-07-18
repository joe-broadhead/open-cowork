# Write Coordination

## Write Coordination

OpenWiki serializes hosted Git workspace mutations through one write
coordinator. The coordinator covers proposal apply, proposal/review/comment
writes, source ingest, service-account token writes, manual commits, Git
pull/push, publish, and write-mode worker jobs such as static export.

Use the local coordinator for one process or one container with a normal
workspace filesystem:

```sh
OPENWIKI_WRITE_COORDINATOR_BACKEND=local
```

Use the Postgres coordinator when web and worker run as separate containers:

```sh
OPENWIKI_DATABASE_URL=postgres://...
OPENWIKI_QUEUE_BACKEND=postgres
OPENWIKI_WRITE_COORDINATOR_BACKEND=postgres
```

The Postgres backend stores a lease in `write_leases` with actor, operation,
started time, heartbeat, expiry, and diagnostic metadata. Acquisition is atomic:
an active lease returns a 423 write-in-progress error instead of allowing two
Git mutations to proceed.

To diagnose a stuck hosted write:

```sh
openwiki --root /data/wiki db write-lease --json
```

If `expires_at` is in the past, recover it through the CLI so only expired
leases are removed:

```sh
openwiki --root /data/wiki db recover-write-lease --json
```

The command does not remove non-expired leases. If a non-expired lease appears
stuck, confirm the owning pod/process is dead and inspect Git status before
changing the lease duration or restarting writers.
