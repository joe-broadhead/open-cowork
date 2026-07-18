# Configuration

Workspace configuration lives in `openwiki.json`.

Important areas:

- workspace identity and title
- runtime profile
- search defaults
- queue and read backend selection
- storage backend references
- hosted controls such as rate limits
- service accounts, token metadata, and token hashes
- OAuth clients, redirect URIs, grants, and policy bounds for hosted remote MCP
- Git remote metadata
- Git sync defaults under `runtime.sync`
- snapshot backup policy under `runtime.backups`

Secrets should be referenced through environment variables or platform secret
stores. Do not write raw credentials into `openwiki.json` or Git config.
Use `openwiki auth token create|rotate|revoke|list|inspect` to manage
service-account tokens; the config stores token hashes and redacted metadata,
never raw token values.

Hosted deployments also depend on process environment:

- `OPENWIKI_ROOT` for the mounted workspace
- `OPENWIKI_RUNTIME_MODE=local|team|hosted|enterprise` to select the runtime
  safety posture independently of the workspace template/profile
- `OPENWIKI_PUBLIC_ORIGIN` for browser write protection
- `OPENWIKI_DATABASE_URL` or `DATABASE_URL` for Postgres
- `OPENWIKI_READ_BACKEND`, `OPENWIKI_SEARCH_BACKEND`, and
  `OPENWIKI_QUEUE_BACKEND` for derived backend selection
- `OPENWIKI_WRITE_COORDINATOR_BACKEND` for local or Postgres Git write
  coordination across web and worker processes
- `OPENWIKI_RATE_LIMIT_*` and `OPENWIKI_REQUEST_LOGS` for hosted HTTP/MCP
  abuse controls and structured request logs
- `OPENWIKI_OPERATIONAL_STATE_BACKEND=postgres` when Streamable HTTP MCP
  sessions and rate-limit windows must be shared across web replicas
- `OPENWIKI_OAUTH_ENABLED=1` to enable hosted OAuth when `auth.oauth.enabled`
  is not set in config
- `OPENWIKI_OAUTH_ISSUER` or `OPENWIKI_PUBLIC_ORIGIN` as the external OAuth
  issuer for hosted MCP/API clients
- `OPENWIKI_OAUTH_STATE_BACKEND=postgres` when hosted OAuth clients, codes,
  tokens, and revocations must be shared across replicas; this is implied by
  `OPENWIKI_OPERATIONAL_STATE_BACKEND=postgres`
- `OPENWIKI_PUBLIC_METRICS=1` only when an internal scrape path already
  protects `/metrics`; by default metrics require admin access
- `OPENWIKI_MCP_TOOL_OUTPUT_MAX_BYTES` for the final MCP tool-output ceiling
  before truncation metadata is returned
- `OPENWIKI_SOURCE_FETCH_*` for source-fetch response-size and timeout budgets
  across HTTP, MCP, and queued jobs
- `OPENWIKI_WEBHOOK_GITHUB_SECRET` and `OPENWIKI_WEBHOOK_GITLAB_SECRET` to
  require provider authenticity checks before webhook jobs are queued
- `OPENWIKI_SECRET_*` for credential refs

## Runtime Modes

`runtime.profile` describes how a workspace was initialized or packaged:
`local`, `team`, `hosted`, `static`, `compose`, `umbrel`, `cloud`, or
`enterprise`. `OPENWIKI_RUNTIME_MODE` is the deploy-time override and accepts
`local`, `team`, `hosted`, or `enterprise`.

OpenWiki maps profiles to runtime modes before applying safety defaults:

- `local` and `static` use `local` mode.
- `team`, `compose`, and `umbrel` use `team` mode.
- `hosted` and `cloud` use `hosted` mode.
- `enterprise` uses `enterprise` mode.

`local` and `team` modes keep the personal/team ergonomics: SQLite indexes may
be built on demand, local queues are allowed, and in-process fallbacks remain
available for diagnostics. `hosted` and `enterprise` modes fail closed on
request-path full-repo fallbacks. They require Postgres read/search/queue
serving layers and shared operational state so horizontally scaled web and
worker processes do not silently drift.

For hosted or enterprise deployments, readiness requires:

```sh
OPENWIKI_RUNTIME_MODE=hosted
OPENWIKI_DATABASE_URL=postgres://...
OPENWIKI_READ_BACKEND=postgres
OPENWIKI_SEARCH_BACKEND=postgres
OPENWIKI_QUEUE_BACKEND=postgres
OPENWIKI_OPERATIONAL_STATE_BACKEND=postgres
```

Use `enterprise` instead of `hosted` when the same deployment is covered by
formal production controls, SSO, backups, monitoring, and change-management
processes. The runtime requirements are intentionally the same.

## Sync Vs Backup

`runtime.sync` describes Git synchronization for the live workspace. It selects
the default remote, branch, mode, interval, and conflict policy that future
`openwiki sync` commands and automation use. Git sync is versioned and
conflict-aware; it is the right way to mirror a live wiki to a private Git
repository.

Event-aware sync is opt-in. Set `runtime.sync.sync_after_events` to any of
`proposal.applied`, `source.ingested`, `inbox.proposed`, or `inbox.processed`
when a trusted server or local automation should sync after that workflow.
`push_after_commit` also triggers a safe sync after OpenWiki applies a proposal
with a managed Git commit. `debounce_seconds`, `max_attempts`, and
`backoff_seconds` bound retry storms; conflicts always stop for operator review.

`runtime.backups` describes snapshot backup artifacts. A backup destination is
where OpenWiki writes restorable copies of the workspace, not where the live
Git working tree should run. The safe personal pattern is:

- keep the live wiki in a normal local directory
- sync the live wiki through a private Git remote
- write backup artifacts to a separate backup destination

Backup automation is also opt-in. Set `runtime.backups.backup_after_events` to
the same event names, then tune `event_threshold` and `min_interval_seconds` so
busy inbox processors do not create a backup for every single item.
When more than one backup destination is configured, event-triggered backups
must set `runtime.backups.default_destination_id`; otherwise OpenWiki cannot
choose a destination safely. If exactly one destination exists, automation uses
that destination automatically.

Local backup destinations may point at folders that are synced by Google Drive,
iCloud, Dropbox, a NAS client, or another consumer backup tool. Do not place the
live workspace itself inside those folders unless that provider's filesystem
semantics have been explicitly tested for Git writes.

Configure local destinations through the CLI instead of hand-editing paths:

```sh
openwiki --root ~/openwiki-personal backup configure local \
  --id gdrive \
  --path "~/Google Drive/OpenWiki Backups" \
  --keep-last 10 \
  --keep-days 30
```

The command expands `~`, normalizes the destination for the current platform,
creates the folder, warns when common consumer sync paths are detected, and
refuses to place backup artifacts inside the live workspace or around it.

`runtime.backups.destinations[]` stores destination ids, kinds, paths, bucket
names, prefixes, and environment-variable names. It must not store raw access
keys, bearer tokens, connection strings, private keys, passwords, or Git
credentials. Use `*_env` fields, `credential_ref`, platform secrets, or provider
secret stores for credential material.

For consumer providers beyond a local synced folder, use the rclone bridge:

```sh
openwiki --root ~/openwiki-personal backup configure rclone \
  --id gdrive \
  --rclone-remote "gdrive:OpenWiki Backups" \
  --prefix personal
```

`runtime.backups.destinations[]` stores only `kind: "rclone"`, the destination
id, prefix, and rclone remote name/path. Provider tokens remain in rclone's own
configuration, not in OpenWiki config or backup manifests.

All destination kinds share the same status and artifact contract. See the
[backup adapter contract](backup-adapter-contract.md) for the stable
`openwiki backup status --json` fields and the requirements every provider must
meet before it is advertised as supported.

Existing workspaces do not need a migration when `runtime.sync` or
`runtime.backups` is absent. OpenWiki treats missing config as manual sync and
unconfigured backups; `openwiki doctor` reports that state so operators can
decide when to configure it.

See the [incident runbooks](../deployment/runbooks.md) for the full operator
checklist.

## Auth And OAuth

`auth.service_accounts[]` stores local service-account identities, token hashes,
token metadata, and optional bounds. Token hashes are created by
`openwiki auth token create|rotate`; raw bearer values must not be committed to
the workspace.

`auth.oauth` enables hosted OAuth 2.1 for remote MCP/API clients:

```json
{
  "auth": {
    "oauth": {
      "enabled": true,
      "issuer": "https://wiki.example.com",
      "dynamic_client_registration": {
        "enabled": false
      },
      "clients": [
        {
          "client_id": "trusted-ci",
          "client_name": "Trusted CI",
          "public": false,
          "redirect_uris": ["https://ci.example.com/openwiki/callback"],
          "client_secret_hashes": ["sha256:<hex>"],
          "actor_id": "actor:agent:trusted-ci",
          "role": "viewer",
          "scopes": ["wiki:read", "wiki:search"],
          "grant_types": ["client_credentials"],
          "bounds": {
            "operations": ["wiki.search", "wiki.read_page"],
            "path_prefixes": ["wiki/"],
            "source_ids": ["source:docs"]
          },
          "access_token_ttl_seconds": 3600,
          "refresh_token_ttl_seconds": 2592000
        }
      ]
    }
  }
}
```

`issuer` must match the external HTTPS origin. Loopback HTTP is accepted for
local desktop OAuth clients. If OAuth is enabled without an issuer, OpenWiki
returns an OAuth server error instead of issuing tokens.

Hosted HTTPS OAuth requires shared Postgres OAuth state. File-backed OAuth state
is reserved for local loopback clients because it cannot coordinate clients,
authorization codes, refresh tokens, or revocations across replicas.

`dynamic_client_registration.enabled` defaults to false. Keep it disabled unless
an admin-gated registration service fronts `/oauth/register`. Dynamically
registered clients start pending and cannot use `/oauth/authorize` until an
unbounded administrator approves them with
`POST /oauth/clients/{client_id}/approve`.

Policy bounds narrow the identity after scopes and roles are resolved. When both
`operations` and `tool_modes` are present, OpenWiki uses their intersection.
`source_ids`, `path_prefixes`, `section_ids`, and `inbox_providers` are enforced
by central policy visibility filters so search facets, graph results, topic
counts, inbox items, proposal subjects, and MCP reads do not reveal out-of-scope
records.
