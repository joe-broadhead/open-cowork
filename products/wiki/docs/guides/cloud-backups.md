# Cloud Backups

Cloud backup destinations store immutable OpenWiki backup artifacts in object
storage. They do not store the live Git workspace and should not be mounted as
the live workspace filesystem.

Every configured cloud destination stores only credential references in
`openwiki.json`. Put credentials in environment variables, platform secrets, or
workload identity files, then point OpenWiki at the environment variable name.

Backup object keys are isolated under:

```text
<prefix>/<workspace-id>/openwiki-backup-<workspace>-<timestamp>/
```

If `--prefix` is omitted, OpenWiki uses `openwiki-backups/<workspace-id>/...`.

## S3

```sh
openwiki --root /data/wiki backup configure s3 \
  --id aws \
  --bucket my-openwiki-backups \
  --prefix openwiki/personal \
  --region us-east-1 \
  --access-key-env AWS_ACCESS_KEY_ID \
  --secret-key-env AWS_SECRET_ACCESS_KEY \
  --server-side-encryption AES256
```

For KMS-backed encryption:

```sh
openwiki --root /data/wiki backup configure s3 \
  --id aws-kms \
  --bucket my-openwiki-backups \
  --prefix openwiki/personal \
  --region us-east-1 \
  --access-key-env AWS_ACCESS_KEY_ID \
  --secret-key-env AWS_SECRET_ACCESS_KEY \
  --server-side-encryption aws:kms \
  --kms-key-id arn:aws:kms:us-east-1:111122223333:key/...
```

## MinIO Or S3-Compatible Storage

```sh
openwiki --root /data/wiki backup configure minio \
  --id umbrel-minio \
  --endpoint-url http://minio:9000 \
  --bucket openwiki \
  --prefix backups \
  --access-key-env MINIO_ACCESS_KEY \
  --secret-key-env MINIO_SECRET_KEY \
  --force-path-style
```

Use HTTPS for hosted MinIO. Plain HTTP is intended for trusted local Docker or
Umbrel networks.

## GCS

Set `GOOGLE_APPLICATION_CREDENTIALS` to a service-account JSON file with
read/write access to the backup bucket:

```sh
openwiki --root /data/wiki backup configure gcs \
  --id gcs \
  --bucket my-openwiki-backups \
  --prefix openwiki/personal \
  --credentials-env GOOGLE_APPLICATION_CREDENTIALS
```

For CMEK:

```sh
openwiki --root /data/wiki backup configure gcs \
  --id gcs-cmek \
  --bucket my-openwiki-backups \
  --prefix openwiki/personal \
  --credentials-env GOOGLE_APPLICATION_CREDENTIALS \
  --kms-key-name projects/my-project/locations/global/keyRings/wiki/cryptoKeys/backups
```

## rclone Bridge

Use rclone when you want backups in a consumer provider such as Google Drive,
Dropbox, OneDrive, SFTP, WebDAV, or a NAS destination that rclone already
supports. This is an advanced bridge: configure and authenticate the rclone
remote outside OpenWiki, then give OpenWiki only the remote name/path.

```sh
rclone config
rclone lsd "gdrive:OpenWiki Backups"
openwiki --root /data/wiki backup configure rclone \
  --id gdrive \
  --rclone-remote "gdrive:OpenWiki Backups" \
  --prefix personal
```

OpenWiki invokes the allowlisted `rclone` executable name directly, never through
a shell. It does not pass provider secrets on the command line and does not store
OAuth refresh tokens, app passwords, or provider keys in `openwiki.json`.

Check readiness before trusting the destination:

```sh
openwiki --root /data/wiki backup status --destination gdrive --json
openwiki --root /data/wiki backup credentials explain gdrive --json
openwiki --root /data/wiki backup create --destination gdrive --json
openwiki --root /data/wiki backup verify latest --destination gdrive --json
```

If `backup status` reports a missing binary, missing remote, auth failure, quota
failure, or rate limit, fix the rclone configuration with rclone first and rerun
status. Use `rclone config reconnect <remote>:` or the provider-specific rclone
revocation flow when rotating credentials.

Direct Google Drive and WebDAV adapters are intentionally deferred. Google Drive
needs a first-class OAuth device flow plus secure refresh-token storage. WebDAV
needs a capability matrix for HTTPS, app passwords, ETag behavior, quota errors,
and server-specific retry semantics. See
[ADR 0007](../adr/0007-consumer-backup-adapters.md).

## Credential Lifecycle

`openwiki backup status --json` includes provider-neutral credential evidence:

- `credential_state`: whether credentials are not required, present through
  environment variables, externally managed by rclone, missing, or unsupported
- `provider_state`: normalized status for operator workflows: `configured`,
  `missing`, `expired`, `denied`, `quota_exceeded`, `rate_limited`, `unknown`,
  or `unsupported`
- `credential_requirements`: required environment variables or external
  credential systems and whether they are present
- `credential_lifecycle`: rotation, revoke, and verification steps for the
  destination family

Explain one destination before rotating secrets:

```sh
openwiki --root /data/wiki backup credentials explain aws --json
```

Print provider-specific manual rotation guidance:

```sh
openwiki --root /data/wiki backup rotate aws
```

OpenWiki does not rotate cloud credentials itself. Rotate in the provider or
secret manager, update the environment variable or mounted secret referenced by
`openwiki.json`, restart or reload the process, then prove the new credential:

```sh
openwiki --root /data/wiki backup status --destination aws --json
openwiki --root /data/wiki backup verify latest --destination aws --json
```

After verification passes, revoke the old provider credential and check
provider audit logs for stale credential use. Backup artifacts, events,
manifests, Git config, static exports, and docs must contain only destination
metadata, environment variable names, or redacted diagnostics.

`openwiki doctor --profile personal|hosted|kubernetes` and
`openwiki deploy preflight --deploy-profile <profile>` include the same
provider readiness state for each configured backup destination. Use those
checks before enabling scheduled backup workers in Docker, Kubernetes, Umbrel,
or cloud profiles.

## Deployment Secrets

Do not put raw provider keys in `openwiki.json`, Helm values, Compose files, Git
remotes, backup manifests, or static exports.

- Docker and Compose: pass credential environment variables from a local
  `.env`, shell environment, or Docker secret. The example Compose file uses
  placeholders; production operators should populate them from an external
  secret store.
- Kubernetes and Helm: mount provider credentials through Kubernetes Secrets,
  `workspaceBackup.existingSecret`, `workspaceBackup.envFrom`, CSI secret
  drivers, IRSA/workload identity, or the cloud provider's managed identity.
- AWS and GCP: prefer bucket-scoped IAM or workload identity
  over long-lived access keys where the platform supports it. If you must use
  static keys, rotate them in the provider and then update the deployment
  secret referenced by the destination's `*_env` field.
- Umbrel and local personal installs: keep credentials in user-managed Docker
  environment secrets, rclone config, OS keychain-backed Git helpers, or a
  local secret manager. Back up those credentials separately from OpenWiki
  backup artifacts.

## Operate

The same backup commands work for local and cloud destinations:

```sh
openwiki --root /data/wiki backup create --destination aws --json
openwiki --root /data/wiki backup list --destination aws --json
openwiki --root /data/wiki backup status --destination aws --json
openwiki --root /data/wiki backup verify latest --destination aws --json
openwiki --root /data/wiki backup restore latest \
  --destination aws \
  --target-root /tmp/openwiki-restore \
  --json
openwiki --root /data/wiki backup prune --destination aws --dry-run --json
```

Verification re-reads provider objects, materializes the artifact locally, and
checks `checksums.sha256` before restore. Prune only deletes objects under a
valid OpenWiki backup artifact prefix for the selected destination.
`backup status --json` follows the shared
[backup adapter contract](../reference/backup-adapter-contract.md): it reports
readiness, credential state, configured prefix, provider capabilities, redacted
diagnostics, backup count, latest backup id, and last verification evidence.

Use provider-native versioning, lifecycle policies, replication, and audit logs
for durability and retention beyond the OpenWiki artifact policy.

For local personal machines, pair the destination with a user-level schedule:

```sh
openwiki --root /data/wiki backup watch --every 24h --destination aws --once --json
openwiki --root /data/wiki service install backup --every 24h --destination aws
```

See [Personal Automation](personal-automation.md) for scheduler behavior,
write-coordination safety, service logs, and status checks.
