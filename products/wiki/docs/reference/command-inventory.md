# Command Inventory

This inventory maps the packaged `openwiki` CLI to the HTTP API, MCP tools, and
web UI. The CLI should be the normal automation surface for local users and
operators; MCP should be the normal agent surface; HTTP and the web UI should
serve hosted deployments.

## Coverage Matrix

| Product Area | CLI | HTTP API | MCP | Web UI | Notes |
| --- | --- | --- | --- | --- | --- |
| Install, version, and upgrade guidance | `openwiki version --check`, `openwiki upgrade`, `openwiki self-check` | n/a | n/a | n/a | Reports the installed package version, npm update command, and installed package asset readiness. |
| Workspace lifecycle | `init`, `setup personal`, `setup team`, `doctor` | `/readyz`, `/livez`, `/api/v1/workspaces` | `wiki.list_workspaces` in write mode | Admin health and readiness links | Setup commands compose templates, indexing, backup, sync, and MCP config instead of exposing repository internals. |
| Pages | `pages list`, `pages read`, `pages search`, `pages history`, `pages diff`, `pages propose`; legacy `page read` | `/api/v1/pages/{id}`, `/api/v1/search`, page history and diff routes | `wiki.read_page`, `wiki.search`, `wiki.get_history`, `wiki.diff_versions`, `wiki.propose_edit` | Home, Pages, page detail, history, proposal form | `pages` is the human-facing command group; `page` remains as a compatibility alias for direct reads. |
| Proposals | `proposal list/read/detail/diff/snapshot/validation/comment/review/close/apply`, `propose-edit`, `synthesize` | `/api/v1/proposals*`, `/api/v1/synthesis*` | Proposal mode can create and comment; write mode can review, close, and apply | Proposals list, detail, review, and apply screens | Applying proposals is a write operation and uses write coordination. |
| Spaces and permissions | `spaces list/read/preview/create/edit-advanced`; legacy `policy read/preview/propose/propose-section` | `/api/v1/policy*` | Write mode exposes policy read/propose tools | Spaces & Permissions page | `spaces` renders policy sections as product-facing Spaces; raw policy files remain under advanced commands. |
| Search and ask | `search`, `ask`, `pages search` | `/api/v1/search`, `/api/v1/ask` | Read mode search and ask tools | Search box and result pages | `pages search` narrows results to page records for user-facing wiki workflows. |
| Sources, claims, and decisions | `source list/read/content/ingest/propose/fetch`, `claim read/trace`, `decision read` | `/api/v1/sources*`, `/api/v1/claims*`, `/api/v1/decisions*` | Read and write source/evidence tools by mode | Advanced record and source views | Source fetch uses connector and SSRF controls; credentials stay referenced, not persisted as secret values. |
| Graph and governance | `graph`, `topics`, `questions`, `governance detectors` | `/api/v1/graph*`, `/api/v1/topics`, `/api/v1/open-questions` | Read-mode graph and governance tools | Graph from Admin and page context | Graph stays available but secondary to search/read/propose. |
| Git sync | `sync connect/status/check-remote/explain-conflict/now/watch/enable/disable/repair`, `git status/pull/push` | `/api/v1/git*`, `/api/v1/sync/now` | `wiki.sync_now` plus write mode Git tools | Admin operations links | Sync is conflict-aware, validates remote reachability, and refuses unsafe overwrite paths. |
| Backups | `backup configure/status/credentials/rotate/create/list/verify/rehearse/restore/prune/watch`, `service install backup` | Operational API and run records where hosted | Write mode job and run tools | Admin operation links | Backups are snapshot artifacts with manifests and checksums; provider credential lifecycle is inspectable without storing secrets. |
| Deployment | `deploy profile list`, `deploy preflight`, `serve`, `worker`, `run`, `service` | Health, metrics, MCP, API routes | HTTP MCP for hosted agents | Server-rendered wiki UI | Hosted deployments require an auth boundary before browser writes or HTTP MCP. |
| Agents and MCP | `mcp --stdio`, `mcp install`, `agent providers list`, `agent install`, `agent configure`, `integrate opencode` | `/mcp`, `/mcp-manifest.json` | n/a | Admin MCP links | Local agents start with stdio proposal mode; hosted agents use scoped bearer tokens or trusted proxy identity. Provider-specific files are generated through the agent provider registry. |
| Service accounts and tokens | `auth token create/list/inspect/rotate/revoke` | Authenticated API requests use bearer tokens | Hosted MCP uses bearer tokens | Admin token workflows are intentionally CLI-first in v0.1 | Raw token values are printed only on create/rotate and are not persisted in repo config. |
| Audit and runs | `events`, `audit export`, `runs`, `worker` | `/api/v1/events`, `/api/v1/runs`, metrics | Read/write run tools by mode | Admin runs and metrics | JSON output is stable for scripts and incident workflows. |
| Static export and publish | `export static`, `publish static` | `/api/v1/publish` | Write mode publish tools | Admin publish action | Static export emits human HTML plus JSON, JSONL, Markdown, OpenAPI, and MCP manifest artifacts. |

## Intentional Gaps

- Native username/password login and first-party OIDC are not CLI commands.
  Humans authenticate through a reverse proxy or platform SSO boundary.
- Direct consumer-provider OAuth flows, such as Google Drive device auth, are
  deferred until OpenWiki has a secure local credential storage story. Use
  local-folder or rclone-backed backups instead.
- The CLI does not replace MCP for agent runtime integration. It installs and
  validates MCP config, while agents should use MCP tools for knowledge work.
- The CLI does not bypass policy. Mutation commands use the shared workflows and
  write coordination used by HTTP and MCP adapters.

## JSON Stability

Every command listed above should keep concise human output and `--json` output
that is usable by scripts. For compatibility, scripts should:

- branch on top-level status fields and OpenWiki error codes before matching
  human messages
- treat additive fields as non-breaking
- avoid storing raw token output outside a secret manager or local token file
- prefer `openwiki doctor`, `openwiki deploy preflight`, `openwiki backup
  status`, and `openwiki sync status` for machine checks
