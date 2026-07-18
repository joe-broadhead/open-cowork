# MCP

## 12. MCP Adapter

MCP is the primary agent interface.

The MCP server MUST expose tools with JSON Schema input schemas and SHOULD
provide structured output schemas. Tool outputs SHOULD include
`structuredContent` when the client supports it and SHOULD also include a
compact text representation for compatibility.

### 12.1 Permission Tiers

Tier 1: read-only

- `wiki.search`
- `wiki.ask`
- `wiki.think`
- `wiki.read_page`
- `wiki.read_source`
- `wiki.read_claim`
- `wiki.trace_claim`
- `wiki.get_history`
- `wiki.diff_versions`
- `wiki.list_recent_changes`
- `wiki.git_status`
- `wiki.list_events`
- `wiki.list_runs`
- `wiki.list_topics`
- `wiki.list_open_questions`
- `wiki.detect_governance`
- `wiki.graph_neighbors`
- `wiki.graph_backlinks`
- `wiki.graph_related`
- `wiki.graph_path`
- `wiki.graph_orphans`
- `wiki.graph_stale`
- `wiki.graph_report`

`wiki.graph_path` treats graph edges as traversable in either direction and
returns a structured response with `found: false`, `nodes: []`, and `edges: []`
when no visible path exists. It does not return `null`. `wiki.graph_related`
returns a bounded neighborhood around shared topics, sources, and claims; related
nodes should still be checked with `wiki.graph_path` when an explicit connecting
path is required.

Tier 2: proposal-only

- `wiki.propose_edit`
- `wiki.propose_source`
- `wiki.propose_synthesis`
- `wiki.comment_on_proposal`

Tier 3: write/workflow

- `wiki.ingest_source`
- `wiki.fetch_source`
- `wiki.review_proposal`
- `wiki.apply_proposal`
- `wiki.create_synthesis`
- `wiki.run_lint`
- `wiki.run_job`
- `wiki.commit_changes`
- `wiki.git_pull`
- `wiki.git_push`
- `wiki.sync_now`
- `wiki.publish`

Default MCP startup mode MUST be read-only unless the operator explicitly enables
proposal or write tools.
Implementations SHOULD expose MCP through local stdio and MAY expose the same
MCP JSON-RPC methods over the MCP Streamable HTTP transport at `/mcp`. Remote
HTTP MCP endpoints MUST default to viewer scopes unless scopes, role, token, or
server policy grant additional permission. Tool tier selection SHOULD use
`tools=read`, `tools=proposal`, or `tools=write`; enabling a tier only exposes
tools, while operation authorization still depends on scoped policy.
`wiki.run_job` SHOULD enqueue by default. Local implementations MAY accept
`wait=true` for synchronous execution when the client and operator explicitly
want inline work.
Agents SHOULD prefer `wiki.sync_now` for Git synchronization. It runs through
OpenWiki write coordination, refuses dirty workspaces, and does not expose raw
Git command construction to the client.

Tool outputs MUST be bounded for hosted MCP. The reference implementation uses a
256 KiB default final output ceiling, configurable with
`OPENWIKI_MCP_TOOL_OUTPUT_MAX_BYTES`. When a result exceeds the ceiling, the
tool call remains successful and returns a truncation envelope with
`structuredContent.truncated: true`, `_meta.openwiki.truncated: true`, a compact
JSON preview, byte counts, and guidance to use narrower limits, pagination, or
specific record IDs.

### 12.2 Queue Adapter Contract

The runtime MUST treat run queueing as an adapter boundary. The reference local
adapter stores queued, running, succeeded, and failed runs in `runs/runs.jsonl`.
Hosted queue adapters SHOULD provide the same operations as the local adapter;
v0.1 implements Postgres and reserves Redis or managed queues for later
compatibility milestones:

- enqueue run
- read run
- claim run by ID
- claim next queued run
- mark succeeded
- mark failed

Queue claiming SHOULD be atomic in hosted adapters. The local JSONL adapter is
intended for single-process or low-concurrency local workflows.

### 12.3 MCP Resources

Required resource URI patterns:

```text
openwiki://page/{page_id}
openwiki://source/{source_id}
openwiki://claim/{claim_id}
openwiki://proposal/{proposal_id}
openwiki://comment/{comment_id}
openwiki://decision/{decision_id}
openwiki://commit/{sha}
openwiki://index
openwiki://recent-changes
openwiki://events
openwiki://runs
```

### 12.4 MCP Prompts

Recommended prompts:

- `answer_with_citations`
- `research_topic`
- `review_edit`
- `ingest_source`
- `create_synthesis_page`
- `compare_sources`
- `find_contradictions`
- `prepare_briefing`
