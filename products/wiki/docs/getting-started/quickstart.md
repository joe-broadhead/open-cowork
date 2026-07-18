# Quick Start

Create and inspect a private personal wiki with local agent access:

```sh
# Install the release-candidate CLI from a source checkout first:
# pnpm pack:cli
# npm install -g ./artifacts/npm/openwiki-cli-0.0.0.tgz
openwiki setup personal ~/openwiki-personal --agent opencode --tools proposal
openwiki --root ~/openwiki-personal doctor --profile personal
openwiki --root ~/openwiki-personal backup create --verify
openwiki --root ~/openwiki-personal serve --host 127.0.0.1 --port 3030
```

Open `http://127.0.0.1:3030` to search, read pages, propose edits, and inspect
proposal history. The setup command creates a private personal wiki, rebuilds
derived stores, generates proposal-mode stdio MCP config for local agents, and
installs the project-local OpenCode personal-curator pack when `--agent
opencode` is selected. Keep personal write-capable servers on loopback.

To sync and back up off-machine, add a private Git remote and backup folder:

```sh
openwiki setup personal ~/openwiki-personal \
  --agent opencode \
  --tools proposal \
  --git-remote git@github.com:you/private-openwiki.git \
  --backup-path "~/Google Drive/OpenWiki Backups"
openwiki --root ~/openwiki-personal sync now --push
```

Keep the live workspace outside Google Drive, iCloud, Dropbox, OneDrive, and
similar sync folders. Use those folders for backup artifacts only.

For a private team wiki instead:

```sh
openwiki setup team local-wiki --title "Team Wiki"
openwiki search local-wiki "team knowledge" --json
openwiki serve local-wiki --host 127.0.0.1 --port 3030
```

The default `team-wiki` template creates an internal Team Knowledge Space for
authenticated deployments.

For the full first-user flow, including proposal-mode MCP, hosted private
deployment, SSO boundaries, rate limits, and the UI walkthrough, continue with
[First User Path](first-user-path.md).

Useful endpoints once the server is running:

```sh
curl http://127.0.0.1:3030/livez
curl http://127.0.0.1:3030/readyz
curl "http://127.0.0.1:3030/api/v1/search?q=team%20knowledge"
curl http://127.0.0.1:3030/mcp-manifest.json
```

If `/readyz` returns `not_ready`, rebuild the derived local stores and restart
the server:

```sh
openwiki --root local-wiki index
openwiki --root local-wiki db rebuild
```

Generate a public static export:

```sh
openwiki --root local-wiki export static --out-dir public
```

`--out-dir` is relative to the wiki workspace. The export writes human HTML plus
JSON, JSONL, Markdown, OpenAPI, and MCP manifest artifacts under that workspace
export directory.
