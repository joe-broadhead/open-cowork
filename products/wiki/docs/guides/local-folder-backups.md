# Local Folder Backups

Use local folder backups when a personal wiki needs point-in-time snapshots in a
folder that another tool syncs or backs up. This is the right pattern for Google
Drive, iCloud Drive, Dropbox, Synology Drive, mounted NAS shares, and external
backup agents.

Keep the live workspace and backup destination separate:

- live workspace: normal local filesystem path, for example `~/openwiki-personal`
- Git sync: private Git remote for live version history
- backup destination: synced or mounted folder that receives immutable snapshot
  artifacts

Do not run the live Git workspace directly inside a consumer sync folder unless
that provider has been explicitly tested for Git lockfile and rename semantics.
Consumer sync clients are acceptable for backup artifacts because each artifact
is written as a complete directory snapshot and then verified locally.

If you prefer not to rely on a local synced folder, use the
[rclone bridge](cloud-backups.md#rclone-bridge). rclone lets advanced users
target Google Drive, WebDAV, SFTP, Dropbox, OneDrive, and NAS destinations while
keeping provider credentials outside OpenWiki.

## Configure

Create a named local destination once:

```sh
openwiki --root ~/openwiki-personal backup configure local \
  --id gdrive \
  --path "~/Google Drive/OpenWiki Backups" \
  --keep-last 10 \
  --keep-days 30
```

The command expands `~`, writes an absolute path into `openwiki.json`, creates
the destination directory, and records an audit event. It refuses unsafe layouts
where the destination is the workspace, contains the workspace, or sits inside
the live workspace.

## Google Drive

Choose the actual local Google Drive folder shown by Finder or your sync client:

```sh
openwiki --root ~/openwiki-personal backup configure local \
  --id gdrive \
  --path "~/Google Drive/OpenWiki Backups"
```

Some Google Drive installs use `~/Library/CloudStorage/GoogleDrive-*` or a
`drivefs` path instead. Use the local folder path where files appear on disk,
not a browser URL.

## iCloud Drive

On macOS, iCloud Drive usually appears under the CloudDocs path:

```sh
openwiki --root ~/openwiki-personal backup configure local \
  --id icloud \
  --path "~/Library/Mobile Documents/com~apple~CloudDocs/OpenWiki Backups"
```

The OpenWiki workspace should stay outside iCloud Drive. Put only the generated
backup artifact directories inside iCloud Drive.

## Dropbox

```sh
openwiki --root ~/openwiki-personal backup configure local \
  --id dropbox \
  --path "~/Dropbox/OpenWiki Backups"
```

Verification proves that the local artifact is intact. It does not prove that
Dropbox has finished uploading it.

## NAS Or Synology Drive

For a mounted NAS share on macOS:

```sh
openwiki --root ~/openwiki-personal backup configure local \
  --id nas \
  --path "/Volumes/Home/OpenWiki Backups"
```

For Linux:

```sh
openwiki --root ~/openwiki-personal backup configure local \
  --id nas \
  --path "/mnt/nas/openwiki-backups"
```

Prefer a mounted filesystem that supports atomic directory rename. If the mount
is unreliable, create backups on a local disk first and let the NAS client copy
completed artifacts.

## Create, Verify, Restore

```sh
openwiki --root ~/openwiki-personal backup create --destination gdrive --json
openwiki --root ~/openwiki-personal backup list --destination gdrive --json
openwiki --root ~/openwiki-personal backup verify latest --destination gdrive --json
```

For scheduled personal backups, first smoke-test a one-shot watcher:

```sh
openwiki --root ~/openwiki-personal backup watch --every 24h --destination gdrive --once --json
```

Then install a user-level schedule:

```sh
openwiki --root ~/openwiki-personal service install backup --every 24h --destination gdrive
openwiki --root ~/openwiki-personal service status
```

See [Personal Automation](personal-automation.md) for launchd, systemd, logs,
and repeated-failure backoff behavior.

Run restore drills into a temporary path:

```sh
openwiki --root ~/openwiki-personal backup restore latest \
  --destination gdrive \
  --target-root /tmp/openwiki-personal-restore \
  --json
openwiki --root /tmp/openwiki-personal-restore run lint --json
openwiki --root /tmp/openwiki-personal-restore index --json
```

After the drill, remove the temporary restore directory. Promote a restored
workspace only after validation passes.

## Retention

Destination retention can be configured with the destination:

```sh
openwiki --root ~/openwiki-personal backup configure local \
  --id gdrive \
  --path "~/Google Drive/OpenWiki Backups" \
  --keep-last 10 \
  --keep-days 30
```

Prune with a dry run first:

```sh
openwiki --root ~/openwiki-personal backup prune --destination gdrive --dry-run --json
openwiki --root ~/openwiki-personal backup prune --destination gdrive --json
```

Pruning only deletes valid `openwiki-backup-*` artifact directories under the
configured destination.
