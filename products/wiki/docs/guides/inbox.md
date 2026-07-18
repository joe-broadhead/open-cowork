# Inbox Automation

OpenWiki inboxes collect incoming knowledge before an agent or maintainer turns
it into wiki pages, sources, proposals, and reviewable history. They are meant
for local automations such as watched transcript folders and for hosted teams
where each authenticated user can submit private or Space-scoped items.

For remote team agents and Streamable HTTP MCP deployment guidance, see
[Hosted Inbox Agents](hosted-inbox-agents.md).

## Storage Model

Inbox items are canonical Git records in `inbox/items.jsonl`. Payloads submitted
by the CLI and watcher are stored under `inbox/payloads/` and referenced by the
item record. Each item has an idempotency key, provider, adapter, optional
external id, owner actor, optional target Space, payload hash, lifecycle status,
and links to any sources, proposals, pages, runs, events, or commits that were
created while processing it.

Statuses are:

- `received`
- `queued`
- `processing`
- `proposed`
- `applied`
- `ignored`
- `failed`
- `superseded`

Inbox content is private by default. Static export does not publish
`inbox/items.jsonl` or `inbox/payloads/`.

## Permissions

Inbox access uses explicit operations:

- `wiki.inbox_list` and `wiki.inbox_read` require `wiki:inbox:read`.
- `wiki.inbox_submit` requires `wiki:inbox:submit`.
- `wiki.inbox_process`, `wiki.inbox_ignore`, and `wiki.inbox_retry` require
  `wiki:inbox:process`.

Personal items are visible to the owning actor. Shared items can target a Space
with `target_space_id`; actors with viewer access to that Space can read the
item metadata and payload. Admin contexts can audit all inbox records without
changing the Git record layout.

Submitting to someone else's `owner_actor_id` requires `wiki:inbox:admin`.
Submitting a shared item with `target_space_id` or `target_path` requires
contributor access to that Space or path. This keeps hosted deployments safe for
many user inboxes while still allowing shared team queues.

## Local Folder Watcher

Use the watcher to ingest local files into the inbox without mutating wiki pages:

```sh
openwiki --root ~/Wiki inbox watch \
  --dir ~/OpenWiki/"Transcript Inbox" \
  --adapter file \
  --provider transcript_file \
  --source-type meeting_transcript \
  --actor actor:user:local \
  --every 30s \
  --once
```

Install a recurring local service:

```sh
openwiki --root ~/Wiki service install inbox \
  --dir ~/OpenWiki/"Transcript Inbox" \
  --adapter file \
  --provider transcript_file \
  --source-type meeting_transcript \
  --every 5m
```

The watcher rejects symlinks, skips unstable files, enforces `--max-bytes`, and
deduplicates by content hash. Optional `--archive-dir` and `--quarantine-dir`
move successfully submitted or failed files out of the inbox folder.
Use `--provider source-name` to tag every file from a watcher, or include
`provider` / `source_provider` in a `.json` sidecar next to a file when an
upstream importer needs per-file labels.

## Agent Flow

Local agents can use stdio MCP with proposal or write mode. Hosted agents should
use streamable HTTP MCP with a service-account token that carries only the inbox
and proposal scopes required for the workflow.

Typical flow:

1. A transcript lands in a watched folder or is submitted over HTTP/MCP.
2. OpenWiki creates a private `inbox:*` record and payload reference.
3. An agent lists/reads inbox items through MCP.
4. The agent processes the item into source material.
5. The agent proposes wiki pages or edits for human review.

Processing an inbox item creates a source record and links it back to the inbox
item. Meeting-specific page organization is handled by agent skills so local
personal wikis and hosted team wikis can use the same canonical inbox records
with different orchestration policies.

The OpenCode integration pack includes `openwiki-inbox`,
`openwiki-inbox-operator`, `openwiki-meeting-curator`,
`openwiki-transcript-inbox`, and `openwiki-meeting-curation` for this flow:

```sh
openwiki integrate opencode --out-dir ~/Wiki --wiki-root ~/Wiki
opencode run --agent openwiki-inbox \
  "Use openwiki-personal MCP. Triage received transcript inbox items and propose wiki updates."

opencode run --agent openwiki-meeting-curator \
  "Use openwiki-personal MCP. Process meeting transcripts, search existing people and project pages first, and propose linked meeting updates."
```

The meeting curator treats transcript content as untrusted evidence, preserves
uncertainty, reads or proposes transcript sources before citing them, and
reports inbox IDs, source IDs, proposal IDs, validation status, and unresolved
ambiguities.

For a personal wiki, pair that agent with local stdio MCP. For a hosted wiki,
configure OpenCode against `/mcp?tools=proposal` or `/mcp?tools=write` with a
scoped service-account bearer token rather than exposing a broad maintainer
token.

## Hosted Inbox Cookbook

Create a per-user inbox submitter token for a user's remote OpenCode agent or a
webhook bridge:

```sh
openwiki --root /data/wiki auth token create \
  --profile inbox-submitter \
  --id service:user-inbox-submitter \
  --actor actor:agent:user-inbox \
  --expires-in-days 30
```

Configure that agent with Streamable HTTP MCP proposal tools:

```sh
openwiki --root /data/wiki agent configure \
  --client opencode \
  --transport http \
  --server-url https://wiki.example.com \
  --tools proposal \
  --token-env OPENWIKI_INBOX_TOKEN \
  --config-out ./opencode.remote-inbox.json
```

The agent can call `wiki.inbox_submit` and `wiki.inbox_read` for its own inbox.
It cannot process items, apply proposals, or submit to another user's inbox.

For a shared Space inbox, grant the agent or SSO group contributor access to the
target Space and submit with `target_space_id`:

```json
{
  "title": "Platform weekly transcript",
  "content": "...",
  "kind": "meeting_transcript",
  "provider": "transcript_file",
  "target_space_id": "section:team-knowledge"
}
```

Run processing with a separate curator identity:

```sh
openwiki --root /data/wiki auth token create \
  --profile inbox-curator \
  --id service:team-inbox-curator \
  --actor actor:agent:team-inbox-curator \
  --expires-in-days 14
```

Curator tokens should be stored in a platform secret manager, used only by the
worker or trusted agent that processes inbox items, and rotated independently
from user submitter tokens.
