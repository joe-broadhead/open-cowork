# Personal Automation

OpenWiki can run personal sync and backup jobs without requiring users to write
cron, launchd, or systemd files by hand. Use foreground watchers while testing,
then install user-level services once the commands behave the way you expect.

## Foreground Watchers

Use watchers when you want an inspectable process in the current terminal:

```sh
openwiki --root ~/openwiki-personal sync watch --every 15m
openwiki --root ~/openwiki-personal backup watch --every 24h --destination gdrive
```

Both watchers use the same write coordinator as proposal apply, source fetch,
restore, backup creation, and Git sync. If another writer owns the workspace
lease, the watcher records `skipped_busy` under `.openwiki/sync/automation/` and
tries again later instead of racing the active write.

Watchers also record:

- last run
- last success
- last failure
- consecutive failure count
- next run after repeated-failure backoff

For a one-shot smoke test:

```sh
openwiki --root ~/openwiki-personal sync watch --every 15m --once --json
openwiki --root ~/openwiki-personal backup watch --every 24h --destination gdrive --once --json
```

## Scheduled Services

Install a user-level service for the current platform:

```sh
openwiki --root ~/openwiki-personal service install sync --every 15m
openwiki --root ~/openwiki-personal service install backup --every 24h --destination gdrive
openwiki --root ~/openwiki-personal service status
```

On macOS, OpenWiki writes a LaunchAgent under:

```text
~/Library/LaunchAgents/dev.openwiki.<workspace>.<sync|backup>.plist
```

On Linux, OpenWiki writes a systemd user service and timer under:

```text
~/.config/systemd/user/openwiki-<workspace>-<sync|backup>.service
~/.config/systemd/user/openwiki-<workspace>-<sync|backup>.timer
```

Generated services run the one-shot watcher form with
`OPENWIKI_AUTOMATION_SERVICE=1`, so each scheduled execution records state,
uses write coordination, applies jitter, and exits cleanly.

If the platform service manager cannot be activated from the current shell,
OpenWiki still writes the service files and prints the exact `launchctl` or
`systemctl --user` commands to run manually.

## Logs And Status

Service logs are written under:

```text
~/.openwiki/logs/
```

Use:

```sh
openwiki --root ~/openwiki-personal service status --json
openwiki --root ~/openwiki-personal doctor
```

`doctor` reports whether sync and backup automation are installed and includes
the last automation state in JSON output.

## Safe Sync Defaults

`sync watch` never silently commits a dirty workspace. If Git reports
uncommitted changes, the run fails with recovery instructions. To make a manual
sync commit explicit:

```sh
openwiki --root ~/openwiki-personal sync now --message "Sync local wiki edits"
```

Scheduled sync pulls by default. It only pushes when you pass `--push` to the
service install command or configure sync with `--push-after-commit`:

```sh
openwiki --root ~/openwiki-personal sync enable --every 15m --push-after-commit
openwiki --root ~/openwiki-personal service install sync --every 15m
```

## Backup Destinations

If exactly one backup destination is configured, `backup watch` uses it by
default. If multiple destinations are configured, pass `--destination` so the
schedule is explicit:

```sh
openwiki --root ~/openwiki-personal backup watch --every 24h --destination gdrive
openwiki --root ~/openwiki-personal service install backup --every 24h --destination gdrive
```

## Uninstall

Remove user-level service files with:

```sh
openwiki --root ~/openwiki-personal service uninstall sync
openwiki --root ~/openwiki-personal service uninstall backup
```

The commands remove the generated LaunchAgent or systemd unit files. Backup
artifacts, Git remotes, and workspace data are not deleted.

## Unsupported Platforms

On platforms without launchd or systemd user services, `service install` prints
manual cron examples using the same one-shot watcher command. Keep the live
workspace on a normal local filesystem and put only backup artifacts inside
consumer sync folders such as Google Drive, iCloud Drive, Dropbox, or NAS sync
clients.
