---
name: openwiki-research
description: Use when answering questions from OpenWiki records with configured OpenWiki MCP search, reads, claims, source tracing, and cited IDs.
version: 1.0.0
applies_to: [opencode, openclaw, mcp]
required_tools: [wiki.search, wiki.ask, wiki.think, wiki.read_page, wiki.read_source, wiki.trace_claim]
allowed_operations: [wiki.search, wiki.ask, wiki.think, wiki.read_page, wiki.read_source, wiki.read_claim, wiki.trace_claim, wiki.graph_neighbors, wiki.graph_backlinks, wiki.graph_related, wiki.graph_path]
risk_level: low
---

# OpenWiki Research

Use OpenWiki as the source of truth for workspace knowledge.

Required behavior:

- Start with `wiki.search`, `wiki.ask`, or `wiki.think`.
- Read relevant pages, sources, and claims before answering.
- Use `wiki.trace_claim` when a factual assertion needs provenance.
- Include page IDs, claim IDs, source IDs, and proposal IDs so humans and agents can inspect records.
- State missing evidence instead of filling gaps from memory.
- Do not browse outside OpenWiki unless the user asks for new research.
