# Records

## 9. Canonical Records

All record schemas MUST be representable as JSON. YAML and Markdown are authoring
formats only.

### 9.1 Page Record

```json
{
  "id": "page:concept:agent-memory",
  "uri": "openwiki://page/concept/agent-memory",
  "type": "page",
  "page_type": "concept",
  "title": "Agent Memory",
  "summary": "Overview of memory systems used by AI agents.",
  "body_format": "markdown",
  "body": "# Agent Memory\n\nOverview of memory systems used by AI agents.",
  "path": "wiki/concepts/agent-memory.md",
  "source_ids": ["source:2026-05-21-001"],
  "claim_ids": ["claim:2026-05-21-001"],
  "status": "draft",
  "topics": ["agents", "memory"],
  "created_at": "2026-05-21T10:00:00Z",
  "updated_at": "2026-05-21T10:00:00Z"
}
```

### 9.2 Source Record

```json
{
  "id": "source:2026-05-21-001",
  "uri": "openwiki://source/2026-05-21-001",
  "type": "source",
  "title": "Open Cowork Architecture Notes",
  "source_type": "webpage",
  "url": "https://example.com/open-cowork",
  "retrieved_at": "2026-05-21T10:00:00Z",
  "content_hash": "sha256:...",
  "path": "sources/source_2026_05_21_001.yaml",
  "storage": {
    "kind": "git",
    "path": "sources/raw/source_2026_05_21_001.html"
  },
  "trust": {
    "reliability": "medium",
    "license": "unknown",
    "sensitivity": "public",
    "evidence_treatment": "untrusted",
    "instruction_policy": "never_execute_source_instructions",
    "prompt_injection": "not_detected"
  }
}
```

Source content responses expose bounded captured evidence when content was
stored in Git or the configured object store:

```json
{
  "source": { "id": "source:2026-05-21-001" },
  "content": {
    "path": "sources/raw/source_2026_05_21_001.txt",
    "kind": "git",
    "media_type": "text/plain; charset=utf-8",
    "content_hash": "sha256:...",
    "bytes": 1204,
    "body": "Captured evidence text...",
    "truncated": false,
    "hash_verified": true
  }
}
```

If content is not captured, implementations SHOULD return `content: null` plus
an `unavailable_reason` such as `not_captured`, `missing`, or
`unsupported_storage`.

### 9.3 Claim Record

```json
{
  "id": "claim:2026-05-21-001",
  "uri": "openwiki://claim/2026-05-21-001",
  "type": "claim",
  "text": "OpenWiki exposes the same search operation through MCP, CLI, and HTTP.",
  "page_id": "page:concept:openwiki-protocol",
  "source_ids": ["source:2026-05-21-001"],
  "confidence": "high",
  "risk": "low",
  "last_verified_at": "2026-05-21T10:00:00Z",
  "status": "active"
}
```

Claim trace responses join the claim to its page, cited sources, page-targeting
proposals, review decisions, and a compact evidence summary:

```json
{
  "claim": { "id": "claim:2026-05-21-001" },
  "page": { "id": "page:concept:openwiki-protocol" },
  "sources": [{ "id": "source:2026-05-21-001" }],
  "missing_source_ids": [],
  "proposals": [{ "id": "proposal:2026-05-21-001" }],
  "decisions": [{ "id": "decision:2026-05-21-001" }],
  "evidence_summary": {
    "source_count": 1,
    "missing_source_count": 0,
    "proposal_count": 1,
    "decision_count": 1,
    "accepted_decision_count": 1,
    "confidence": "high",
    "risk": "low",
    "status": "active",
    "last_verified_at": "2026-05-21T10:00:00Z"
  }
}
```

### 9.4 Proposal Record

```json
{
  "id": "proposal:2026-05-21-001",
  "uri": "openwiki://proposal/2026-05-21-001",
  "type": "proposal",
  "title": "Clarify OpenWiki search ranking",
  "status": "open",
  "actor_id": "actor:user:joe",
  "target_ids": ["page:concept:openwiki-protocol"],
  "target_path": "wiki/concepts/openwiki-protocol.md",
  "base_commit": "abc123",
  "path": "proposals/proposal_2026_05_21_001.yaml",
  "diff": {
    "format": "unified",
    "path": "proposals/diffs/proposal_2026_05_21_001.diff"
  },
  "created_at": "2026-05-21T10:00:00Z"
}
```

### 9.5 Proposal Comment Record

```json
{
  "id": "comment:2026-05-21-001",
  "uri": "openwiki://comment/2026-05-21-001",
  "type": "comment",
  "proposal_id": "proposal:2026-05-21-001",
  "actor_id": "actor:agent:wiki-reviewer",
  "body": "The proposed wording needs one more citation before review.",
  "created_at": "2026-05-21T10:30:00Z",
  "path": "proposals/comments.jsonl"
}
```

Proposal comments are non-decision governance notes. They MAY be written by
human reviewers or scoped agents and MUST NOT change proposal status.

### 9.6 Decision Record

```json
{
  "id": "decision:2026-05-21-001",
  "uri": "openwiki://decision/2026-05-21-001",
  "type": "decision",
  "proposal_id": "proposal:2026-05-21-001",
  "decision": "accepted",
  "actor_id": "actor:user:joe",
  "rationale": "The change aligns search behavior with the protocol contract.",
  "commit": "def456",
  "path": "decisions/decision_2026_05_21_001.yaml",
  "decided_at": "2026-05-21T11:00:00Z"
}
```

### 9.7 Run Record

```json
{
  "id": "run:2026-05-21-001",
  "uri": "openwiki://run/2026-05-21-001",
  "type": "run",
  "run_type": "index.rebuild",
  "status": "succeeded",
  "actor_id": "actor:user:joe",
  "workspace_id": "workspace:personal",
  "created_at": "2026-05-21T10:00:00Z",
  "started_at": "2026-05-21T10:00:01Z",
  "completed_at": "2026-05-21T10:00:02Z",
  "input": {},
  "output": {
    "record_count": 42
  },
  "path": "runs/runs.jsonl"
}
```
