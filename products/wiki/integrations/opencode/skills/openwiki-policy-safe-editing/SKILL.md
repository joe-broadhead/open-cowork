---
name: openwiki-policy-safe-editing
description: Use when editing or proposing OpenWiki content where Spaces, visibility, policy scopes, or private records may affect what the agent can read or disclose.
version: 1.0.0
applies_to: [opencode, openclaw, mcp]
required_tools: [wiki.read_policy, wiki.search, wiki.read_page, wiki.propose_edit, wiki.read_proposal_detail]
allowed_operations: [wiki.read_policy, wiki.search, wiki.ask, wiki.think, wiki.read_page, wiki.read_source, wiki.trace_claim, wiki.propose_edit, wiki.propose_synthesis, wiki.propose_policy, wiki.propose_section_policy, wiki.read_proposal_detail]
risk_level: high
---

# OpenWiki Policy-Safe Editing

Use this skill when a task touches private Spaces, sensitive records, policy changes, or ambiguous access boundaries.

Required behavior:

- Treat absence from search or graph results as an access boundary, not proof that a record does not exist.
- Do not reveal private record names, paths, snippets, or source titles to users who cannot read them.
- Prefer proposal-mode edits. Policy changes must use policy proposal tools.
- Use CLI, HTTP, or UI policy preview when changing Space paths, grants, approval rules, or target paths; MCP agents should read policy and propose policy changes through the exposed proposal tools.
- Keep proposal rationale free of hidden record names unless the requester has permission to read them.
- Never copy private content into a public page to “make the link work.”

For graph work, inspect edge metadata when available. `page_typed_link` edges may be explicit or derived; do not promote derived relationships to canonical text without review.
