# local-personal

Use this for a personal wiki on one machine with local LLMs and agents.

## Quickstart

```sh
pnpm pack:cli
npm install -g ./artifacts/npm/openwiki-cli-0.0.0.tgz
openwiki setup personal ~/openwiki-personal --agent opencode --tools proposal
openwiki --root ~/openwiki-personal doctor --profile personal
```

Run the web UI only on loopback:

```sh
openwiki serve ~/openwiki-personal --host 127.0.0.1 --port 3030
```

## Preflight

```sh
openwiki --root ~/openwiki-personal deploy preflight --deploy-profile local-personal
```

## Security Notes

- Keep the HTTP server on `127.0.0.1`; do not bind a write-capable personal wiki
  to `0.0.0.0`.
- Prefer stdio MCP for local agents.
- Use proposal-mode tools before granting write tools.
- Use [Local Transcript Inbox Dogfood](../../guides/local-transcript-inbox-dogfood.md)
  for the first transcript inbox workflow, and keep watched inbox folders
  outside the live Git workspace.

## Readiness Checks

```sh
openwiki --root ~/openwiki-personal run lint --json
curl --fail http://127.0.0.1:3030/livez
curl --fail http://127.0.0.1:3030/readyz
```

## Backup And Restore

Sync the live wiki to a private Git repository when you want versioned off-box
storage:

```sh
openwiki --root ~/openwiki-personal sync connect git \
  --remote-url git@github.com:you/private-openwiki.git \
  --branch main
openwiki --root ~/openwiki-personal sync now --push --message "Initial private wiki sync"
```

For a portable point-in-time backup:

```sh
openwiki --root ~/openwiki-personal backup configure local \
  --id local-backups \
  --path ~/openwiki-backups \
  --keep-last 10 \
  --keep-days 30
openwiki --root ~/openwiki-personal backup create --destination local-backups --verify --json
openwiki --root ~/openwiki-personal backup rehearse \
  --destination local-backups \
  --target-root /tmp/openwiki-personal-restore \
  --json
```

The destination can be a local Google Drive, iCloud Drive, Dropbox, Synology
Drive, or mounted NAS folder. Keep the live workspace outside those folders and
store only backup artifacts there.

## Rollback

Stop local agents and the loopback server, restore from the latest workspace
backup or reset to a known-good Git commit, then rebuild derived stores:

```sh
openwiki --root ~/openwiki-personal backup restore latest \
  --destination local-backups \
  --target-root /tmp/openwiki-personal-restore \
  --dry-run \
  --json
openwiki --root ~/openwiki-personal backup rehearse \
  --destination local-backups \
  --target-root /tmp/openwiki-personal-restore \
  --json
openwiki --root /tmp/openwiki-personal-restore run lint --json
openwiki --root /tmp/openwiki-personal-restore index --json
```

## MCP

Generate MCP client config for OpenCode:

```sh
openwiki --root ~/openwiki-personal mcp install opencode --mode proposal
```

Generate a generic MCP config file:

```sh
openwiki --root ~/openwiki-personal mcp install generic \
  --mode proposal \
  --output ~/.config/openwiki/mcp.json
```

The generated config uses the packaged `openwiki` binary:

```json
{
  "mcp": {
    "openwiki-personal": {
      "type": "local",
      "enabled": true,
      "command": [
        "openwiki",
        "--root",
        "/absolute/path/to/openwiki-personal",
        "mcp",
        "--stdio",
        "--tools",
        "proposal"
      ]
    }
  }
}
```
