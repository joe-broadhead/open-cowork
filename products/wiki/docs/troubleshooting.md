# Troubleshooting

Use this page with the [installation guide](getting-started/installation.md),
[deployment profiles](deployment/profiles.md), and
[operations runbook](deployment/operations.md). For agent-specific issues, see
[MCP And Agents](guides/mcp-and-agents.md).

## Server Does Not Start

Check the configured root and health endpoints:

```sh
curl http://127.0.0.1:3030/livez
curl http://127.0.0.1:3030/readyz
```

## Search Looks Empty

Rebuild derived indexes:

```sh
openwiki --root ./wiki index
openwiki --root ./wiki db rebuild
```

## Personal Setup Refuses A Sync Folder

`openwiki setup personal` refuses to create the live Git workspace inside
Google Drive, iCloud Drive, Dropbox, OneDrive, Synology Drive, and similar
consumer sync folders. Those clients can rewrite, lock, or partially sync files
while OpenWiki is writing Git records.

Keep the live workspace in a normal local folder and point backups at the synced
folder:

```sh
openwiki setup personal ~/openwiki-personal \
  --backup-path "~/Google Drive/OpenWiki Backups"
```

Only use `--allow-sync-folder-workspace` for a disposable test workspace where
you accept the risk.

## Git Sync Fails

Check that the remote is private, reachable, and has a working SSH or HTTPS
credential outside OpenWiki:

```sh
git ls-remote git@github.com:you/private-openwiki.git
openwiki --root ~/openwiki-personal sync status --json
```

If setup failed during Git sync, rerun it after fixing credentials. The setup
command is idempotent and will reuse the existing wiki:

```sh
openwiki setup personal ~/openwiki-personal \
  --git-remote git@github.com:you/private-openwiki.git
```

## Backup Verify Fails

Create and verify a fresh backup in one command:

```sh
openwiki --root ~/openwiki-personal backup create --destination local-backups --verify --json
```

If the destination is a synced folder, wait for the sync client to finish before
copying or restoring backup artifacts. A failed checksum means the backup should
not be used for restore.

## MCP Client Does Not Launch

Regenerate client config with the packaged CLI and then run the personal doctor
profile:

```sh
openwiki --root ~/openwiki-personal mcp install opencode --mode proposal
openwiki --root ~/openwiki-personal doctor --profile personal --json
```

Generated configs should invoke `openwiki`, not `pnpm` or a source checkout
path. If the client cannot find `openwiki`, install the packaged CLI or adjust
the client's PATH to include the install location.

## Readiness Reports Not Ready

`/readyz` requires the Git workspace, local search index, and local index-store
to be current. Rebuild both derived stores after initializing a source checkout,
restoring a backup, or editing canonical records outside OpenWiki:

```sh
openwiki --root ./wiki index
openwiki --root ./wiki db rebuild
```

## Browser Writes Return 403

For hosted deployments, set `OPENWIKI_PUBLIC_ORIGIN` to the external origin and
ensure browser POSTs include a matching `Origin` header. For local development,
use the same host and port in the browser that the server is listening on.

## Docker Cannot Write

The image supports read-only root filesystems, but `/tmp` and `/data/wiki` must
be writable volumes or tmpfs mounts.

See the [Docker private profile](deployment/profiles/docker-compose.md) and the
[release validation notes](development/release.md#release-validation-matrix) for
the exact probes used in CI.
