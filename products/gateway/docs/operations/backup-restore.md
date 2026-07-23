# Backup And Restore

Gateway stores durable work in `gateway.db` and small operational sidecars in the Gateway state directory. Backups are local filesystem snapshots intended for personal production recovery, audits, and machine transfer.

The current supported backend is `local_sqlite`; backup and restore commands do not imply self-hosted, hosted, or multi-tenant durability. Deployment, SLO, and disaster-recovery claim boundaries are enforced by the claim registry (`opencode-gateway release claims`); the milestone-era backend strategy documents that first defined them live in Git history (see the [Decision Log](../history/decision-log.md)).

## What A Backup Includes

Each backup is a timestamped directory under `~/.config/opencode-gateway/backups/` unless `OPENCODE_GATEWAY_STATE_DIR` points elsewhere.

Included files:

- `gateway.db`
- `channel-sync.json` when present
- `channel-sync.json.sqlite` when present, containing durable channel delivery receipts and leases without message plaintext
- `operational-sidecar.sqlite` when present (operational events, worker sessions, channel poll cursors)
- `events.json` / `sessions.json` when present (legacy JSON; still backed up for older states)

Metadata in `metadata.json` includes:

- Backup format version.
- Package version.
- Current SQLite schema version.
- Config file SHA-256 hash.
- Roadmap, supervisor, project binding, completion proposal, task, run, channel binding, and recent event counts.
- Per-file size and SHA-256 checksums.
- Manifest checksum.

Gateway stores only a config hash in backup metadata. It does not copy `config.json` into backups, because config may contain channel secrets.

## Frequency

Recommended baseline:

- Before upgrades or major config changes: create a backup manually.
- During active Gateway use: create at least one backup daily.
- Before restore, Gateway automatically creates a pre-restore safety backup unless `--skip-safety-backup` is passed.

Keep at least 20 local backups, but do not count them as disaster recovery: by default they share the same state directory, disk, host, and credentials as the live database. Maintain a separately retained encrypted copy off-host.

## Off-Host Encrypted Copy

Gateway verifies the plaintext backup before export; encryption and off-host retention are operator-owned. Keep the destination and encryption identity outside `~/.config/opencode-gateway` and outside the Docker named volume. One concrete flow using an `age` recipient is:

```bash
BACKUP="$HOME/.config/opencode-gateway/backups/gateway-backup-YYYYMMDDTHHMMSSZ"
DEST="/Volumes/encrypted-offsite/opencode-gateway"
AGE_RECIPIENT="age1replace-with-your-off-host-recovery-recipient"

opencode-gateway backup verify "$BACKUP"
install -d -m 700 "$DEST"
tar -C "$(dirname "$BACKUP")" -czf - "$(basename "$BACKUP")" \
  | age -r "$AGE_RECIPIENT" -o "$DEST/$(basename "$BACKUP").tar.gz.age"
shasum -a 256 "$DEST/$(basename "$BACKUP").tar.gz.age" \
  > "$DEST/$(basename "$BACKUP").tar.gz.age.sha256"
```

Sync the encrypted file and its checksum to storage in a different failure domain, with independent credentials and retention/versioning. Do not mount off-host storage credentials into the Gateway service. Test decryption and Gateway verification periodically in an isolated directory:

```bash
mkdir -m 700 /tmp/gateway-offhost-restore
age --decrypt -i /secure/offline/age-identity.txt \
  "$DEST/gateway-backup-YYYYMMDDTHHMMSSZ.tar.gz.age" \
  | tar -xzf - -C /tmp/gateway-offhost-restore
opencode-gateway backup verify /tmp/gateway-offhost-restore/gateway-backup-YYYYMMDDTHHMMSSZ
```

For Compose, first verify inside the running service, then copy the backup out of the named volume and apply the same encryption/off-host flow on the host:

```bash
docker compose -f docker/docker-compose.yml exec gateway \
  /nodejs/bin/node dist/cli.js backup verify \
  /home/nonroot/.config/opencode-gateway/backups/gateway-backup-YYYYMMDDTHHMMSSZ
docker compose -f docker/docker-compose.yml cp \
  gateway:/home/nonroot/.config/opencode-gateway/backups/gateway-backup-YYYYMMDDTHHMMSSZ \
  ./backup-export/gateway-backup-YYYYMMDDTHHMMSSZ
```

`config.json` and service/channel credentials are intentionally absent from Gateway backups. Maintain a separate encrypted recovery record for required non-secret configuration and rotate/re-provision credentials after machine loss rather than copying live secrets into the backup archive.

## CLI Commands

```bash
opencode-gateway backup create --label before-upgrade
opencode-gateway backup list
opencode-gateway backup verify ~/.config/opencode-gateway/backups/gateway-backup-YYYYMMDDTHHMMSSZ
opencode-gateway backup doctor --backup ~/.config/opencode-gateway/backups/gateway-backup-YYYYMMDDTHHMMSSZ
opencode-gateway backup export gateway-state-export.json
opencode-gateway backup drill --from ~/.config/opencode-gateway/backups/gateway-backup-YYYYMMDDTHHMMSSZ
```

Backup creation refuses to snapshot while Gateway has active running work by default, including runs already executing and scheduler dispatches that have reserved pre-run ownership but have not created a run yet. Let running work finish, pause/stop dispatch, or pass the explicit active-run override only when the operator accepts that the backup is an in-flight operational snapshot rather than a quiesced recovery point.

Restore is guarded. Stop the daemon first, or acknowledge maintenance mode explicitly:

```bash
opencode-gateway stop
opencode-gateway restore --from ~/.config/opencode-gateway/backups/gateway-backup-YYYYMMDDTHHMMSSZ
```

If you are invoking restore through the active daemon API, pass `maintenanceMode=true`. Prefer CLI restore with the daemon stopped.

## Verification

Backup verification checks:

- `metadata.json` is present and parseable.
- Backup format is supported.
- Required manifest fields are present, including `version`, `schema.current`, `files`, and `checksum`.
- Metadata references only known Gateway backup basenames: `gateway.db`, `channel-sync.json`, `channel-sync.json.sqlite`, `operational-sidecar.sqlite`, `events.json`, and `sessions.json`.
- Every recorded file exists.
- File sizes match metadata.
- SHA-256 checksums match metadata.
- `gateway.db` passes SQLite `PRAGMA integrity_check`.

The storage doctor is the higher-level consistency scanner:

```bash
opencode-gateway backup doctor
opencode-gateway backup doctor --json
opencode-gateway backup doctor --backup ~/.config/opencode-gateway/backups/gateway-backup-YYYYMMDDTHHMMSSZ
```

It reports a redacted source-of-truth inventory for the state directory, then flags missing or corrupt JSON artifacts, channel checkpoint/outbox mismatches, and backups that do not include expected state such as the channel-sync checkpoint. `info` findings document absent optional caches; `warning` and `critical` findings make service health degraded or down.

## Disaster Recovery Drill

Use the built-in drill after storage, scheduler, channel, or service-lifecycle changes:

```bash
opencode-gateway backup drill --label before-upgrade-drill
opencode-gateway backup drill --from ~/.config/opencode-gateway/backups/gateway-backup-YYYYMMDDTHHMMSSZ
```

The command verifies the backup, restores it into an isolated state directory under `~/.config/opencode-gateway/recovery-drills/<drill-id>/restored-state/`, and then simulates restart interruption recovery. It proves:

- Storage restore can load the backup and match manifest counts before drill mutations.
- The restored state passes the storage doctor after restore.
- Expired scheduler leases recover to retryable work.
- Missing OpenCode sessions recover as orphaned runs.
- Channel bindings stay attached to recovered task state.
- The backup includes only durable Gateway files and allowed sidecars.

Evidence is written predictably:

- `~/.config/opencode-gateway/recovery-drills/<drill-id>/evidence.json`
- `~/.config/opencode-gateway/recovery-drills/<drill-id>/report.md`

Failed drills still write evidence before refusing to proceed. Keep these artifacts with incident notes, upgrade records, or operator acceptance evidence.

For manual recovery practice, run the same flow in a temporary config directory:

```bash
export OPENCODE_GATEWAY_CONFIG_DIR=/tmp/opencode-gateway-drill
export OPENCODE_GATEWAY_STATE_DIR=/tmp/opencode-gateway-drill
opencode-gateway task add "DR drill task"
opencode-gateway backup create --label drill
opencode-gateway backup verify /tmp/opencode-gateway-drill/backups/gateway-backup-*
rm /tmp/opencode-gateway-drill/gateway.db
opencode-gateway restore --from /tmp/opencode-gateway-drill/backups/gateway-backup-* --maintenance
opencode-gateway task list
```

Expected result: the restored task list contains `DR drill task`, backup verification passes, and no channel secrets appear in backup metadata. Prefer `opencode-gateway backup drill` for release evidence because it records machine-readable results.

## Schema Changes

Gateway is a fresh, single-operator, local-first tool. There is no cross-version schema migration path: when a code change alters the `gateway.db` schema, recreate the local database rather than migrating an old one. Keep a fresh backup for state you care about, then let Gateway initialize the current schema on next start. Backups are restore points within the same schema version, not upgrade or downgrade tooling.

## Backend Consistency And Rollback Proofs

The `backend` command group provides value-free consistency and rollback evidence for the local SQLite backend without implying a supported backend switch:

```bash
opencode-gateway backend status --json
opencode-gateway backend doctor --json
opencode-gateway backend consistency-proof --json
opencode-gateway backend durable-state-proof --json
opencode-gateway backend rollback-dry-run --from ~/.config/opencode-gateway/backups/gateway-backup-YYYYMMDDTHHMMSSZ --label before-restore --json
```

| Command | Purpose |
| --- | --- |
| `backend status` | Backend activation mode, runtime persistence, cutover/rollback readiness, and blockers. |
| `backend doctor` / `backend consistency-scan` | Backend consistency scan through storage doctor with activation status and issues. |
| `backend consistency-proof` | Value-free proof of runtime posture, scan, backup freshness, and rollback status. |
| `backend durable-state-proof` | Durable-state ownership, scanner posture, and backup/restore lifecycle across sources. |
| `backend durable-state-integrity` | Source inventory, consistency scan, unsafe-restore refusal, and repair boundaries. |
| `backend durable-state-adapter` | Local durable-state adapter contract, inspect posture, backup status, and repair capabilities. |
| `backend durable-state-repair` | Explicit, idempotent repair (record blocker, create verified backup, or restore verified backup) with a durable receipt. |
| `backend durable-state-round-trip` | Backup round-trip and recovery drill into isolated state with redacted evidence. |
| `backend observability-plane` | Local observability/support evidence plane, trace coverage, and SLO status. |
| `backend rollback-dry-run` | Restore an isolated backup and prove rollback/recovery without touching live state. |

Evidence may include schema versions, counts, checksums, backup IDs, configured/not-configured booleans, and blocker codes. Evidence must not include connection strings, database hosts, raw channel targets, provider payloads, private transcript text, or secrets. Passing these proofs does not by itself establish hosted, multi-tenant, managed-backup, or production Postgres readiness.

## Crash Recovery

On daemon startup, Gateway:

- Recovers expired scheduler leases according to retry policy.
- Lists OpenCode sessions and recovers running Gateway runs whose sessions are missing.
- Leaves recoverable work pending at the same stage.
- Blocks work only when retry policy is exceeded.

The scheduler also checks expired leases at the start of each cycle, so a restarted daemon and a long-running daemon use the same deterministic recovery path.
