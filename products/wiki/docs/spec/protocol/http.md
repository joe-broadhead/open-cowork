# Http

## 13. HTTP Adapter

HTTP is the universal application interface.

The HTTP API SHOULD be specified with OpenAPI 3.1 and JSON Schema 2020-12.
Published OpenAPI documents SHOULD include reusable component schemas for
capabilities, search responses, answer responses, repository validation reports,
validation issues, and standard error responses. Endpoint responses SHOULD
reference those components instead of documenting only free-form JSON.

Required endpoints:

```text
GET    /mcp
POST   /mcp
DELETE /mcp
GET    /api/v1/capabilities
GET    /api/v1/openapi.json
GET    /openapi.json
GET    /api/v1/mcp-manifest
GET    /mcp-manifest.json
GET    /api/v1/search
GET    /api/v1/topics
GET    /api/v1/open-questions
GET    /api/v1/graph/report
GET    /api/v1/pages/:id
GET    /api/v1/sources/:id
GET    /api/v1/sources/:id/content
GET    /api/v1/claims/:id
GET    /api/v1/claims/:id/trace
GET    /api/v1/decisions/:id
GET    /api/v1/recent-changes
GET    /api/v1/git/status
POST   /api/v1/git/pull
POST   /api/v1/git/push
GET    /api/v1/pages/:id/history
GET    /api/v1/pages/:id/diff
GET    /api/v1/sources/:id/history
GET    /api/v1/sources/:id/diff
GET    /api/v1/claims/:id/history
GET    /api/v1/claims/:id/diff
GET    /api/v1/decisions/:id/history
GET    /api/v1/decisions/:id/diff
POST   /api/v1/ask
GET    /api/v1/proposals
POST   /api/v1/proposals
GET    /api/v1/proposals/:id
GET    /api/v1/proposals/:id/detail
GET    /api/v1/proposals/:id/diff
GET    /api/v1/proposals/:id/snapshot
GET    /api/v1/proposals/:id/validation
GET    /api/v1/proposals/:id/comments
POST   /api/v1/proposals/:id/comments
POST   /api/v1/proposals/:id/review
POST   /api/v1/proposals/:id/apply
POST   /api/v1/sources/ingest
POST   /api/v1/sources/propose
POST   /api/v1/sources/fetch
POST   /api/v1/synthesis
POST   /api/v1/synthesis/create
POST   /api/v1/lint
POST   /api/v1/publish
POST   /api/v1/commit
GET    /api/v1/events
GET    /api/v1/events/stream
GET    /api/v1/runs
POST   /api/v1/runs
POST   /api/v1/webhooks/github
POST   /api/v1/webhooks/gitlab
```

Descriptor endpoints are read-only. `/api/v1/openapi.json` and `/openapi.json` SHOULD return the same OpenAPI document; `/api/v1/mcp-manifest` and `/mcp-manifest.json` SHOULD return the same MCP manifest that static export writes.

Endpoints MUST return JSON by default. Page endpoints MAY also return Markdown
when requested with content negotiation or adjacent `.md` routes.
`POST /api/v1/runs` SHOULD return `202 Accepted` with a queued run by default
and MAY return `201 Created` with a completed run when `wait=true` is supplied.
`POST /api/v1/sources/fetch` accepts `connector_kind`, `connector_id`, and
`credential_ref` for authenticated HTTP, GitHub, and GitLab connectors. It MUST
NOT accept raw tokens, cookies, or arbitrary authorization headers in persisted
run input.
`POST /api/v1/synthesis/create` is bound to `wiki.create_synthesis`. It SHOULD create a synthesis proposal, record an accepted decision, apply the proposal, and return the resulting page and governance records.
`POST /api/v1/publish` is bound to `wiki.publish`. It SHOULD write static
artifacts, append a `publish.completed` event, and ensure the generated event
exports and search corpus include that publish event before returning.
`POST /api/v1/commit` is bound to `wiki.commit_changes`. It SHOULD commit
staged changes by default, selected repository-relative `paths` when supplied,
or OpenWiki-managed paths when `all=true` is supplied. It MUST NOT stage
arbitrary paths outside the workspace root. It SHOULD append a `git.committed`
event after a commit is created.
`GET /api/v1/git/status` is bound to `wiki.git_status`. `POST /api/v1/git/pull` is bound to `wiki.git_pull`; it MUST use fast-forward-only pull semantics and refuse dirty workspaces. `POST /api/v1/git/push` is bound to `wiki.git_push`; it MUST refuse dirty workspaces. `POST /api/v1/sync/now` is bound to `wiki.sync_now`; it SHOULD run the safe product sync operation rather than exposing raw Git to agents. Git credentials MUST be provided by the deployment environment and MUST NOT be persisted in request bodies, repo config, events, runs, or static exports.
Webhook endpoints are bound to `wiki.run_job` policy and SHOULD append a durable
`webhook.github.received` or `webhook.gitlab.received` event before queueing any
follow-up work. They default to queueing `index.rebuild`; implementations MAY
accept `run_type` values of `index.rebuild`, `static.export`, or `lint`.
Supplying `enqueue=false` records the webhook event without creating a run.
Webhook events MUST persist only normalized metadata such as provider event name,
delivery ID, repository, ref, commit SHA, action, and sender. Raw provider
payloads, signatures, secrets, and authorization material MUST NOT be persisted
in event or run records.
`/mcp` is the remote MCP Streamable HTTP endpoint. `POST /mcp` accepts JSON-RPC
2.0 request objects for MCP methods such as `initialize`, `tools/list`,
`tools/call`, `resources/list`, `resources/read`, `prompts/list`, and
`prompts/get`. Valid request responses SHOULD use HTTP `200` with either
`application/json` JSON-RPC response objects or `text/event-stream` frames when
the client requests an SSE response. JSON-RPC errors SHOULD remain JSON-RPC
error payloads so MCP clients can handle them consistently. Invalid
non-JSON-RPC requests MAY return HTTP `400`.

Streamable HTTP clients SHOULD send `MCP-Protocol-Version: 2025-11-25`.
Servers SHOULD echo the negotiated version and MAY accept missing protocol
headers for one-shot compatibility. A successful `initialize` response MAY
return `MCP-Session-Id`; clients that receive it MUST include that header on
subsequent session-bound requests. `GET /mcp` opens a
`text/event-stream` server-to-client stream for a known session, and
`DELETE /mcp` terminates that session. HTTP MCP servers MUST validate browser
`Origin` headers and reject disallowed origins with HTTP `403` to reduce DNS
rebinding risk. Agent authentication MUST use explicit service-account bearer
tokens or trusted proxy identity headers rather than browser sessions.
Webhook receivers SHOULD set `OPENWIKI_WEBHOOK_GITHUB_SECRET` or
`OPENWIKI_WEBHOOK_GITLAB_SECRET`; when configured, GitHub requests MUST include
`X-Hub-Signature-256` and GitLab requests MUST include `X-Gitlab-Token`.

The reference HTTP server also exposes human web routes backed by the same
substrate:

```text
GET /
GET /pages/:id
GET /pages/:id.md
GET /pages/:id.json
GET /pages/:id/edit
POST /pages/:id/propose
GET /:page-type/:slug.md
GET /:page-type/:slug.json
GET /proposals
GET /proposals/:id
GET /proposals/:id.json
POST /proposals/:id/review
POST /proposals/:id/apply
GET /sources/:id
GET /sources/:id.json
GET /claims/:id
GET /claims/:id.json
GET /decisions/:id
GET /decisions/:id.json
```

Each human view SHOULD include adjacent machine-readable API links for the same
page, proposal, diff, snapshot, validation report, or queue. Web write routes
MUST use the same policy scopes as their JSON API equivalents.
