---
name: openwiki-proposal-drafting
description: Use when drafting reviewable OpenWiki proposals from retrieved evidence, link suggestions, schema-pack requirements, or inbox-derived material.
version: 1.0.0
applies_to: [opencode, openclaw, mcp]
required_tools: [wiki.search, wiki.read_page, wiki.read_source, wiki.propose_edit, wiki.propose_synthesis, wiki.read_proposal_detail]
allowed_operations: [wiki.search, wiki.ask, wiki.think, wiki.read_page, wiki.read_source, wiki.read_claim, wiki.trace_claim, wiki.graph_neighbors, wiki.graph_related, wiki.propose_edit, wiki.propose_synthesis, wiki.propose_source, wiki.read_proposal_detail, wiki.comment_on_proposal]
risk_level: medium
---

# OpenWiki Proposal Drafting

Use this skill when a change should be staged for human review.

Required behavior:

- Search and read existing records before drafting.
- Preserve page IDs, source IDs, claim IDs, proposal IDs, and inbox IDs in rationale text when they justify the change.
- Draft focused proposals. Prefer one proposal per page-sized change.
- Keep canonical page bodies in Markdown and let OpenWiki render frontmatter.
- Use schema-pack guidance as constraints, not as permission to bypass repository validation.
- After every proposal, read the proposal detail and report validation status, target path, and any warnings.
- Do not apply proposals unless the user explicitly authorizes trusted write mode.

When link extraction suggests an edge, include the extraction rule and confidence in the rationale or a suggested-links section so reviewers can distinguish explicit links from derived ones.
