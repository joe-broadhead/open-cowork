# Git Permissions Security

## 16. Git Write Model

All writes pass through proposal, validation, decision, diff, and commit.

Write flow:

1. Request arrives.
2. Create job and `run_id`.
3. Create isolated Git worktree from current main.
4. Agent or user edits worktree.
5. Capture diff.
6. Validate format, policy, links, claims, and sources.
7. Create or update proposal.
8. Review proposal.
9. Apply accepted proposal through merge queue.
10. Stage the post-apply repository state and run deterministic repository validation.
11. Commit or open PR only if validation passes.
12. Rebuild indexes and exports.
13. Emit events with validation evidence.

Each write run records:

```json
{
  "run_id": "run:2026-05-21-001",
  "actor_id": "actor:agent:wiki-editor",
  "workspace_id": "workspace:personal",
  "base_commit": "abc123",
  "branch_name": "openwiki/proposal-2026-05-21-001",
  "policy_snapshot": "sha256:...",
  "model_snapshot": "gpt-5.4",
  "prompt_snapshot": "sha256:...",
  "diff_path": "proposals/diffs/proposal_2026_05_21_001.diff",
  "decision_memo_id": "decision:2026-05-21-001",
  "validation_report_path": "proposals/reports/proposal_2026_05_21_001.json"
}
```

OpenCode MAY generate patches. OpenWiki decides whether patches become history.

### 16.1 Git Remote Sync

A hosted OpenWiki deployment operates on a normal Git checkout. The operator clones or mounts the wiki repository, configures the desired remote and branch, and provides Git credentials through standard deployment mechanisms such as SSH deploy keys, credential helpers, provider tokens, or mounted secret files. OpenWiki MAY read `runtime.git.remote` and `runtime.git.branch` as defaults, but it MUST NOT store Git passwords, tokens, private keys, or credential helper material in `openwiki.json`.

`wiki.git_status` is read-only and reports branch, upstream, configured remote, redacted remote URL, ahead/behind counts when an upstream exists, and staged, unstaged, or untracked paths. `wiki.git_pull` MUST run a fast-forward-only pull against the selected remote and branch. `wiki.git_push` MUST push `HEAD` to the selected remote branch. Both sync operations MUST refuse to run when the workspace has uncommitted changes, because sync should never hide local edits or merge conflicts inside a deployed server process.

## 17. Permissions

Actors:

- `viewer`
- `contributor`
- `researcher`
- `reviewer`
- `maintainer`
- `admin`
- `agent`

Scopes:

- `wiki:read`
- `wiki:search`
- `wiki:ask`
- `wiki:propose`
- `wiki:ingest:draft`
- `wiki:review`
- `wiki:patch`
- `wiki:commit`
- `wiki:publish`
- `wiki:admin`

Agents are actors. Every tool call and write MUST be attributable to an actor.

MCP tokens and HTTP tokens SHOULD be scoped. A default Open Cowork integration
SHOULD use only `wiki:read`, `wiki:search`, `wiki:ask`, and `wiki:propose`.
OpenCode maintainer workers MAY receive `wiki:patch`, but commits still require
OpenWiki policy gates.

HTTP servers MUST default to read-only viewer behavior when no scopes are
present. Hosted deployments SHOULD authenticate with `Authorization: Bearer
<token>` resolved against hashed `auth.service_accounts` entries in
`openwiki.json`. The reference adapter MUST ignore caller-supplied scope, role,
actor, principal, and group headers unless trusted-header mode is explicitly
enabled with `openwiki serve --trust-headers` or
`OPENWIKI_TRUST_AUTH_HEADERS=1`. Trusted-header mode MUST also require a shared
proxy secret configured through `--trusted-header-secret` or
`OPENWIKI_TRUST_AUTH_HEADERS_SECRET`, and requests MUST present it with
`x-openwiki-proxy-secret`. Trusted-header mode is only appropriate for local
development or for a reverse proxy that strips client-supplied OpenWiki headers
and rewrites them from verified OIDC/SAML or directory claims. The reference
`openwiki serve` command MAY set a local default policy with `--role`,
`--scope`, `--token-env`, `--token-file`, or `OPENWIKI_TOKEN`; this is a
deployment choice and does not change the read-only default. Implementations
SHOULD NOT accept raw bearer tokens as command-line arguments because local
process lists can expose them.

### 17.1 Section Policy

OpenWiki section policy is canonical repository state. It SHOULD live in Git
under:

```text
policy/
  sections.json
  grants.json
  approval-rules.json
```

`policy/sections.json` maps repository paths to named sections. Section paths
use repository-relative globs such as `wiki/hr/**`, `sources/**`, and `**`.
Visibility MUST be one of:

- `public`: safe for static export and anonymous read adapters.
- `internal`: authenticated workspace users only.
- `private`: explicit grants only.

If multiple sections match a path, the most restrictive visibility wins:
`private`, then `internal`, then `public`.

`policy/grants.json` assigns principals to section roles. Principals are stable
strings such as `group:all-users`, `group:hr`, `role:maintainer`,
`actor:user:alice`, or `actor:agent:wiki-editor`. Roles follow the standard
OpenWiki role ladder: `viewer`, `contributor`, `researcher`, `reviewer`,
`maintainer`, `admin`.

`policy/approval-rules.json` defines validation requirements for proposal
review and apply operations. A rule MAY require reviewers from one or more
principals and MAY require the reviewer to be a different actor than the
proposal author.

The reference `basic` template MAY create a permissive `section:all` grant for
`group:all-users` so single-user local workspaces are immediately usable.
The default `team-wiki` template SHOULD create an internal Team Knowledge Space.
In private team deployments, `group:all-users` represents authenticated users
provided by the trusted SSO or reverse proxy boundary.

HTTP and MCP adapters MUST apply section policy before returning page content,
search results, proposal targets, review decisions, or apply operations. The
reference HTTP adapter accepts deployment-supplied principals from
`x-openwiki-principals` and group names from `x-openwiki-groups`; hosted
deployments SHOULD derive those values from OIDC/SAML, an identity provider,
or a trusted upstream application session. Static exports MUST omit non-public
paths from page files, JSONL exports, search indexes, `llms.txt`, and sitemaps.

Policy files MUST be changed through governed proposals in hosted deployments. `wiki.read_policy` and `GET /api/v1/policy` require `wiki:admin`. `wiki.propose_policy` and `POST /api/v1/policy/proposals` create a normal proposal with `target_path` set to one of `policy/sections.json`, `policy/grants.json`, or `policy/approval-rules.json`; review and apply then use the same decision, diff, snapshot, validation, and Git history machinery as page proposals.

## 18. Events

Runtime events SHOULD be available over HTTP and MAY be exposed through MCP
resources or future protocol adapters.

HTTP implementations SHOULD expose `GET /api/v1/events/stream` as a
Server-Sent Events stream for apps and agents that need runtime updates without
polling JSON endpoints. Each SSE message uses:

```text
id: event:2026-05-21-001
event: proposal.created
data: {"id":"event:2026-05-21-001", "...":"..."}
```

The `event` field MUST be the OpenWiki event type and the `data` field MUST be
the complete event envelope JSON. Implementations SHOULD support `limit` for
initial replay, `since` as an event ID or ISO timestamp cursor, `poll_ms` for
local polling cadence, and `once=true` to close after replaying current events.

Required event types:

- `page.created`
- `page.updated`
- `source.ingested`
- `claim.created`
- `claim.verified`
- `proposal.created`
- `proposal.commented`
- `proposal.reviewed`
- `proposal.applied`
- `decision.created`
- `run.created`
- `run.started`
- `run.succeeded`
- `run.failed`
- `index.rebuilt`
- `publish.completed`

Event envelope:

```json
{
  "id": "event:2026-05-21-001",
  "uri": "openwiki://event/2026-05-21-001",
  "type": "proposal.created",
  "workspace_id": "workspace:personal",
  "actor_id": "actor:user:joe",
  "operation": "wiki.propose_edit",
  "record_id": "proposal:2026-05-21-001",
  "record_type": "proposal",
  "occurred_at": "2026-05-21T10:00:00Z",
  "path": "events/events.jsonl",
  "data": {
    "diff_path": "proposals/diffs/proposal_2026_05_21_001.diff"
  }
}
```

## 19. Source Ingestion Security

Source ingestion MUST treat external content as evidence, never instructions.
Source manifests SHOULD record this through trust metadata such as:

- `evidence_treatment: untrusted`
- `instruction_policy: never_execute_source_instructions`
- `prompt_injection: not_detected|suspected`

URL ingestion MUST reject non-HTTP(S) protocols, credential-bearing URLs,
localhost, private IP ranges, link-local hosts, metadata endpoints, and obvious
local hostnames. Source content SHOULD be hashed before storage. Small captured
content MAY be stored in Git under `sources/raw/`; large captured content SHOULD
be stored through the configured object-store adapter with a content-addressed
path and hash metadata. Suspicious instruction-like source text SHOULD produce
validation warnings, not privileged instructions.
Fetch operations SHOULD be bounded by timeout and byte limits and SHOULD NOT
follow redirects automatically; clients should submit the final URL explicitly.
Authenticated fetch operations MUST use connector and credential references.
Run records, source manifests, event records, and exported static JSON MUST NOT
store raw bearer tokens, cookies, passwords, API keys, or authorization headers.

## 20. Security Requirements

1. Read tools and write tools MUST be separable.
2. Write tools MUST require explicit scopes.
3. Every agent MUST have identity.
4. Every patch MUST be attributed.
5. Every write MUST have a proposal, decision, diff, and commit or rejection.
6. External sources MUST be treated as untrusted evidence.
7. Source ingestion MUST defend against prompt injection.
8. Web fetching MUST block SSRF and metadata endpoints.
9. Credentialed source fetches MUST persist references, not secret values.
10. Remote MCP servers MUST be treated as network-active execution surfaces.
11. Tool inputs MUST be validated.
12. Tool outputs SHOULD be sanitized before being passed back to models.
13. Hosted deployments SHOULD use short-lived scoped tokens.
14. Public static export MUST NOT leak private source content or hidden metadata.
