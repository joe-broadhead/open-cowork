# Backup And Restore

Protect every enabled state layer:

- canonical Git workspace and remote;
- verified OpenWiki workspace snapshots;
- Postgres operational state;
- external object storage;
- operator-managed secrets.

## Workspace Snapshot

Configure a destination outside the live workspace:

```sh
openwiki --root /data/wiki backup configure local \
  --id local-backups \
  --path /data/openwiki-backups \
  --keep-last 14 \
  --keep-days 30 \
  --json
openwiki --root /data/wiki backup create \
  --destination local-backups \
  --verify \
  --json
```

Each artifact contains a manifest, repository snapshot, checksums, and restore
instructions. Derived indexes, local caches, environment files, credentials,
and secret-looking material are excluded.

The destination may be a local folder, S3/MinIO, GCS, or an rclone remote.
`openwiki.json` stores only destination metadata and environment-variable names;
raw provider credentials remain outside Git.

## Restore Rehearsal

List and verify before restoring:

```sh
openwiki --root /data/wiki backup list --destination local-backups --json
openwiki --root /data/wiki backup verify latest --destination local-backups --json
openwiki --root /data/wiki backup restore latest \
  --destination local-backups \
  --target-root /data/wiki-restore \
  --dry-run \
  --json
openwiki --root /data/wiki backup rehearse \
  --destination local-backups \
  --target-root /data/wiki-restore \
  --json
```

Rehearsal restores into an isolated target, rebuilds derived stores, validates
the repository, and records `backup.rehearsed` evidence. It refuses the live
workspace, filesystem roots, incompatible workspaces, and non-empty targets
unless `--force` is explicit.

Keep the live Git workspace out of consumer-sync folders. Storing immutable
backup artifacts in a synced destination is acceptable.

## Postgres

Use database-native backups for Postgres. Prefer provider PITR or WAL archiving
and retain a rehearsed logical dump for portability:

```sh
pg_dump "$OPENWIKI_DATABASE_URL" > openwiki.sql
createdb openwiki_restore_drill
export OPENWIKI_RESTORE_DATABASE_URL=postgres://openwiki:openwiki@127.0.0.1:5432/openwiki_restore_drill
psql "$OPENWIKI_RESTORE_DATABASE_URL" < openwiki.sql
OPENWIKI_DATABASE_URL="$OPENWIKI_RESTORE_DATABASE_URL" openwiki --root /data/wiki-restore db migrate
OPENWIKI_DATABASE_URL="$OPENWIKI_RESTORE_DATABASE_URL" openwiki --root /data/wiki-restore db sync-postgres --full
OPENWIKI_DATABASE_URL="$OPENWIKI_RESTORE_DATABASE_URL" openwiki --root /data/wiki-restore db check --json
```

Never point a rehearsal at the production database. Git can rebuild derived
read/search tables, but queued work, shared sessions, rate-limit state, and
other operational records may require the database backup.

## Object Storage And Secrets

Git manifests reference external captures, so Git restore is incomplete when
object storage is enabled. Use provider versioning, replication, lifecycle
policies, and audit logs, then verify OpenWiki backup objects by reading them
back.

Store service tokens, proxy secrets, private keys, database URLs, and provider
credentials in the operator secret system. Restore and rotate them separately;
they must not appear in workspace snapshots or static exports.

## Source-Hosted Recovery Drill

1. Freeze browser, agent, and worker writes.
2. Restore Git or the latest verified workspace snapshot into a clean path.
3. Restore object storage and Postgres where enabled.
4. Restore operator-managed secrets.
5. Rebuild and verify derived stores.
6. Run runtime and authenticated interface smoke checks.

```sh
openwiki --root /data/wiki-restore db migrate
openwiki --root /data/wiki-restore index --json
openwiki --root /data/wiki-restore db rebuild --json
openwiki --root /data/wiki-restore db sync-postgres --full --json
openwiki --root /data/wiki-restore db check --json
openwiki --root /data/wiki-restore run lint --json
openwiki --root /data/wiki-restore doctor --profile hosted --json
curl --fail http://127.0.0.1:3030/readyz
```

Rehearse after changes to Git, storage, Postgres, auth, or secret management and
on an operator-owned schedule that matches the recovery objective.

## Retention

Preview deletions before pruning:

```sh
openwiki --root /data/wiki backup prune --destination local-backups --dry-run --json
openwiki --root /data/wiki backup prune --destination local-backups --json
```

Prune only considers valid OpenWiki artifacts beneath the resolved destination
and honors `keep_last` and `keep_days`.
