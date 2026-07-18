---
name: openwiki-dream-review
description: Use when running a periodic OpenWiki review cycle that looks for stale knowledge, missing links, unresolved proposals, inbox backlog, and schema-pack drift.
version: 1.0.0
applies_to: [opencode, openclaw, mcp]
required_tools: [wiki.graph_report, wiki.graph_orphans, wiki.graph_stale, wiki.list_proposals, wiki.list_runs, wiki.list_open_questions]
allowed_operations: [wiki.search, wiki.think, wiki.graph_report, wiki.graph_orphans, wiki.graph_stale, wiki.graph_neighbors, wiki.graph_related, wiki.list_proposals, wiki.read_proposal_detail, wiki.list_runs, wiki.list_events, wiki.list_open_questions, wiki.propose_edit, wiki.comment_on_proposal]
risk_level: medium
---

# OpenWiki Dream Review

Use this skill for a bounded maintenance review of the wiki.

Review sequence:

1. Read graph report, orphan pages, stale graph nodes, open questions, runs, and open proposals.
2. Group findings into link hygiene, source coverage, stale claims, proposal backlog, inbox follow-up, and schema-pack drift.
3. Search and read the affected records before drafting any proposal.
4. Propose small, reviewable fixes only when evidence is sufficient.
5. Comment on existing proposals when they already cover the issue.
6. Report what was changed, what still needs human judgment, and what should be deferred.

Do not create broad rewrites or direct canonical edits during a review cycle. Keep suggested fixes traceable to graph output, proposal records, runs, or source-backed pages.
