# Runtime And Publishing Overview

OpenWiki has three executable product paths in this monorepo:

| Path | Best for | Evidence |
| --- | --- | --- |
| Local source or CLI tarball | One person with local agents | `openwiki doctor --profile personal` and the standalone CLI smoke |
| Source-operated team or hosted runtime | Authenticated humans and agents on operator-managed infrastructure | `openwiki doctor --profile hosted`, readiness probes, backups, and runtime tests |
| Static export | Public read-only knowledge | Static export tests and artifact checks |

Git remains canonical. SQLite, Postgres, search indexes, object storage, and
static output are derived layers.

The repository does not currently release an npm-registry package or container
image and does not qualify a hosted platform deployment. Operators evaluating
a source-hosted runtime own its process
supervision, network boundary, storage, and rollback.

Before exposing a source-hosted runtime, read the
[authentication boundary](auth-boundaries.md),
[hosted human and agent](hosted-human-agent.md),
[write coordination](operations/write-coordination.md), and
[backup and restore](operations/backup-restore.md) guidance. Run:

```sh
openwiki --root <wiki> doctor --profile hosted --json
```

Use the [smoke checklist](smoke.md) to verify source, tarball, and static paths.
