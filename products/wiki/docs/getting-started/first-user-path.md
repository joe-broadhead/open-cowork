# First User Path

The shortest useful OpenWiki journey is a private local wiki, a proposal-mode
agent, and an optional read-only static export.

## 1. Install The CLI Tarball

Follow [Installation](installation.md), then verify:

```sh
openwiki --version
openwiki self-check
```

Source-checkout contributors can use the `pnpm --dir products/wiki openwiki`
form instead.

## 2. Create A Personal Wiki

```sh
openwiki setup personal ~/openwiki-personal \
  --agent opencode \
  --tools proposal
openwiki --root ~/openwiki-personal doctor --profile personal
```

The setup command creates the Git-backed workspace, indexes initial pages, and
generates local MCP configuration. Proposal mode lets the agent suggest edits
without applying them silently.

## 3. Open The Local UI

```sh
openwiki --root ~/openwiki-personal serve --host 127.0.0.1 --port 3030
```

Search, open a page, ask a cited question, then review one agent proposal. Keep
the write-capable server on loopback.

## 4. Back Up And Rehearse Restore

```sh
openwiki --root ~/openwiki-personal backup configure local \
  --id local-backups \
  --path ~/openwiki-backups
openwiki --root ~/openwiki-personal backup create \
  --destination local-backups \
  --verify
openwiki --root ~/openwiki-personal backup rehearse \
  --destination local-backups \
  --target-root /tmp/openwiki-restore
```

## 5. Publish Read-Only Knowledge

```sh
openwiki --root ~/openwiki-personal export static \
  --out-dir public \
  --base-url https://example.com
```

Review the static export report before publishing. Private content is excluded
by the export policy; the source Git workspace remains canonical.

## Source-Operated Hosted Evaluation

OpenWiki includes an authenticated HTTP/MCP runtime, but this repository does
not ship a qualified hosting package. An operator evaluating it from source
must provide an authenticated ingress boundary, HTTPS public origin, persistent
Git workspace, scoped service-account tokens, backups, and shared Postgres
state before multiple writers or replicas.

```sh
openwiki --root /srv/openwiki doctor --profile hosted --json
```

Read [Hosted Humans And Agents](../deployment/hosted-human-agent.md) and
[Authentication Boundaries](../deployment/auth-boundaries.md) before exposing a
network service.
