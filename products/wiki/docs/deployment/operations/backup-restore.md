# Backup Restore

## Backup And Restore

Back up four things when they are enabled:

- Git remote and local workspace
- Postgres
- object storage bucket
- deployment secrets

Configure a named local destination, then create a verifiable workspace backup
from a trusted checkout:

```sh
openwiki --root /data/wiki backup configure local \
  --id local-backups \
  --path /data/openwiki-backups \
  --keep-last 14 \
  --keep-days 30 \
  --json
openwiki --root /data/wiki backup create --destination local-backups --json
```

The artifact layout is intentionally portable:

```text
openwiki-backup-<workspace>-<timestamp>/
  manifest.json
  repo/
  checksums.sha256
  restore-readme.txt
```

`manifest.json` records the OpenWiki version, protocol version, workspace
identity, source Git commit, dirty-state marker, included paths, excluded
derived stores, object-storage completeness, Postgres completeness, creator,
host, checksum-file hash, and restore compatibility constraints.
`checksums.sha256` covers every backed-up payload file under `repo/` plus the
restore readme. Restore verifies those checksums before replacing anything in
the target path.

`runtime.backups` in `openwiki.json` is the product-level backup policy. It may
declare local or cloud destinations, schedule intent, and retention rules.
Local destinations can point at a folder that is synced by Google Drive, iCloud,
Dropbox, a NAS client, or a provider backup agent. Configure them with
`backup configure local` so OpenWiki expands `~`, normalizes the path, writes an
absolute destination, and refuses unsafe layouts where the destination is the
workspace, contains the workspace, or sits inside the live workspace.

Cloud destinations can point at S3/MinIO, GCS, or rclone remotes. Configure them
with `backup configure s3|minio|gcs|rclone`. OpenWiki stores only bucket,
remote, prefix, and environment-variable names in `openwiki.json`; raw access
keys, bearer tokens, connection strings, SSH private keys, and passwords must
stay in the environment or provider secret store. Backup creation excludes local
env files, secret-looking key material, and Git credential config from the
artifact.

Keep Git sync and backup snapshots separate:

- use a private Git remote for live workspace sync
- prefer `openwiki sync connect git` and `openwiki sync now` over raw Git commands
  so the write coordinator protects concurrent web, agent, and worker writes
- use backup artifacts for point-in-time restore
- do not run the live Git workspace directly inside Google Drive, iCloud,
  Dropbox, or other consumer sync folders
- writing backup artifacts to a synced folder is acceptable because the
  artifacts are immutable snapshots

List and verify artifacts before restore:

```sh
openwiki --root /data/wiki backup list --destination local-backups --json
openwiki --root /data/wiki backup verify latest --destination local-backups --json
```

Run a dry run before restoring into any important path. The dry run verifies
the backup artifact and reports whether the target is missing, empty, blocked,
or would be replaced with `--force`; it does not create, replace, or append
restore files:

```sh
openwiki --root /data/wiki backup restore latest \
  --destination local-backups \
  --target-root /data/wiki-restore \
  --dry-run \
  --json
```

For cloud destinations, the same commands re-read provider objects and
materialize the artifact locally before checksum verification:

```sh
openwiki --root /data/wiki backup configure s3 \
  --id aws \
  --bucket my-openwiki-backups \
  --prefix openwiki/prod \
  --region us-east-1 \
  --access-key-env AWS_ACCESS_KEY_ID \
  --secret-key-env AWS_SECRET_ACCESS_KEY
openwiki --root /data/wiki backup create --destination aws --json
openwiki --root /data/wiki backup verify latest --destination aws --json
```

Restore into a new path first, validate it, then promote:

```sh
openwiki --root /data/wiki backup rehearse \
  --destination local-backups \
  --target-root /data/wiki-restore \
  --json
openwiki --root /data/wiki doctor --profile hosted --json
```

Restore rehearsal verifies manifests and checksums, restores into the isolated
target, rebuilds derived stores, validates the restored repository, and records
`backup.rehearsed` evidence in the live workspace event log. Rehearsal refuses
the live workspace root and refuses existing non-empty targets unless `--force`
is provided. Restore refuses filesystem roots, non-empty non-OpenWiki
directories, and incompatible existing OpenWiki workspaces. Use `--force` only
after verifying that the target is the intended compatible restore workspace.

Apply retention with a dry run first:

```sh
openwiki --root /data/wiki backup prune --destination local-backups --dry-run --json
openwiki --root /data/wiki backup prune --destination local-backups --json
```

The prune command only deletes directories under the resolved backup
destination, only considers `openwiki-backup-*` artifacts with valid manifests,
and honors `runtime.backups.retention.keep_last` plus `keep_days`. Operators can
override policy for one run with `--keep-last N` and `--keep-days N`.

For Postgres, use database-native backups. The Kubernetes base includes a
suspended `CronJob/openwiki-postgres-backup`; enable it only after wiring the
`openwiki-postgres` secret and durable backup storage for your cluster. The Helm
chart exposes the same pattern with `postgresBackup.enabled=true`,
`postgresBackup.existingSecret`, and `postgresBackup.persistence.*`.

For managed databases, use provider-native PITR/WAL archiving where available
and keep at least one rehearsed logical `pg_dump` path for portability. The
commands below require local PostgreSQL client tools; if they are not installed,
run the same commands from a trusted `postgres:17-alpine` container or an
operator workstation that has `pg_dump` and `psql`. After restore, run
migrations and rebuild derived tables from Git if any drift is suspected:

```sh
pg_dump "$OPENWIKI_DATABASE_URL" > openwiki.sql
createdb openwiki_restore_drill
OPENWIKI_RESTORE_DATABASE_URL=postgres://openwiki:openwiki@127.0.0.1:5432/openwiki_restore_drill
psql "$OPENWIKI_RESTORE_DATABASE_URL" < openwiki.sql
OPENWIKI_DATABASE_URL="$OPENWIKI_RESTORE_DATABASE_URL" openwiki --root /data/wiki db migrate
OPENWIKI_DATABASE_URL="$OPENWIKI_RESTORE_DATABASE_URL" openwiki --root /data/wiki index
OPENWIKI_DATABASE_URL="$OPENWIKI_RESTORE_DATABASE_URL" openwiki --root /data/wiki db rebuild
OPENWIKI_DATABASE_URL="$OPENWIKI_RESTORE_DATABASE_URL" openwiki --root /data/wiki db sync-postgres --full
OPENWIKI_DATABASE_URL="$OPENWIKI_RESTORE_DATABASE_URL" openwiki --root /data/wiki db check --json
```

Do not pipe a restore drill back into the production `OPENWIKI_DATABASE_URL`.
Use a disposable restore database or a staging cluster, then promote only after
the restored workspace and derived tables pass validation.

For object storage, back up the bucket with provider-native versioning or a
bucket replication job. Object manifests in Git reference external captures, so
Git restore alone is incomplete when object storage is enabled. The workspace
backup manifest makes this explicit with `object_storage.restore_complete_from_git`.

For consumer-provider snapshots, use either a local synced-folder backup
destination or the rclone bridge. rclone is appropriate when a personal user or
home-lab operator already manages a remote such as Google Drive, WebDAV, SFTP,
or a NAS target with rclone. OpenWiki stores only the rclone remote name/path and
verifies provider objects by reading them back before reporting success.

## Recovery Objectives

Set realistic RPO and RTO by state layer:

- Git remote: RPO is the last successful `openwiki sync now` or scheduled sync;
  RTO is reclone time plus validation and index rebuild time.
- Workspace backup artifact: RPO is the latest verified backup; RTO is artifact
  materialization, checksum verification, restore, and derived-store rebuild.
- Object storage: RPO depends on bucket versioning, replication, or provider
  backups; Git restore is incomplete when external objects are enabled.
- Postgres runtime: RPO depends on PITR/WAL, provider snapshots, or the latest
  `pg_dump`; derived rows can be rebuilt from Git, but queues, rate/session
  state, identity runtime state, and audit-adjacent runtime tables may require a
  database restore.
- Secrets: RPO/RTO are owned by the operator secret store. Backup artifacts must
  not contain raw service-account tokens, proxy secrets, private keys, or cloud
  credentials.

For personal wikis, a daily verified backup plus private Git sync is a practical
baseline. For hosted/team deployments, rehearse the full restore path at least
monthly and after changing Git, object storage, Postgres, auth proxy, or secret
management.

## Personal Restore Drill

For a local personal wiki:

```sh
openwiki --root ~/openwiki-personal backup configure local \
  --id local-backups \
  --path ~/openwiki-backups \
  --keep-last 10 \
  --keep-days 30 \
  --json
openwiki --root ~/openwiki-personal backup create --destination local-backups --json
openwiki --root ~/openwiki-personal backup verify latest --destination local-backups --json
openwiki --root ~/openwiki-personal backup rehearse \
  --destination local-backups \
  --target-root /tmp/openwiki-personal-restore \
  --json
openwiki --root ~/openwiki-personal doctor --profile personal --json
openwiki --root /tmp/openwiki-personal-restore serve --host 127.0.0.1 --port 3031
```

After the drill, remove the temporary restore path. Keep the live workspace out
of consumer sync folders; point the backup destination at the synced folder
instead.

## Hosted Restore Drill

For Docker, Kubernetes, ECS, Cloud Run plus durable state, or another hosted
profile:

1. Freeze writes by scaling web and worker processes down or putting the ingress
   behind maintenance controls.
2. Recover the Git workspace or restore the latest verified workspace snapshot
   into a clean workspace path.
3. Recover object storage artifacts from bucket versioning, replication,
   provider backup, or the relevant S3/GCS/rclone/Umbrel mechanism when
   `runtime.storage.backend` is not local.
4. Recover Postgres from provider-native PITR, scheduled backup, or logical
   `pg_dump` when the deployment uses Postgres for queues, identity, sessions,
   rate limits, search, or runtime data.
5. Rebuild derived indexes, search, static artifacts, and Postgres derived rows
   from the canonical workspace where appropriate.
6. Restore service secrets, trusted proxy secrets, service-account token
   material, and Git/cloud credential references from the deployment secret
   store.
7. Run validation, doctor, HTTP readiness, MCP smoke, and backup verification:

```sh
openwiki --root /data/wiki-restore db migrate
openwiki --root /data/wiki-restore index --json
openwiki --root /data/wiki-restore db rebuild --json
openwiki --root /data/wiki-restore db sync-postgres --full --json
openwiki --root /data/wiki-restore db check --json
openwiki --root /data/wiki-restore run lint --json
openwiki --root /data/wiki-restore validate --json
openwiki --root /data/wiki-restore doctor --profile hosted --json
curl --fail http://127.0.0.1:3030/readyz
curl http://127.0.0.1:3030/mcp?tools=read \
  -H 'authorization: Bearer <smoke-test-token>' \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":"tools","method":"tools/list"}'
openwiki --root /data/wiki-restore backup verify latest --destination local-backups --json
```

Run a restore drill before the first public release, after changing storage,
database, or Git remote configuration, and on a regular schedule that matches
your recovery objective.

For Compose and other hosted deployments with Postgres, keep a dry-run plan in
the deployment ticket before executing a database restore. The helper below
redacts credentials, refuses to restore into the source database, and records
the exact `pg_dump`, `pg_restore`, migration, full sync, and health-check
commands that an operator will run:

```sh
pnpm backup:postgres:restore-drill -- \
  --database-url "$OPENWIKI_DATABASE_URL" \
  --restore-database-url "$OPENWIKI_RESTORE_DATABASE_URL" \
  --workspace-root /data/wiki \
  --dry-run \
  --json
```

After reviewing the plan and pointing `OPENWIKI_RESTORE_DATABASE_URL` at an
isolated restore database, rerun with `--execute`. Do not execute this against
the production database URL. The script writes
`artifacts/openwiki-postgres-restore-drill.json` for audit evidence.
