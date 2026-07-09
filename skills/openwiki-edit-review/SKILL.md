---
name: openwiki-edit-review
description: Draft scoped, cited OpenWiki edit proposals and review them without ever publishing directly.
---

# OpenWiki Edit Review

Use OpenWiki proposal tools for any change to canonical wiki content. Agents
propose; humans (or explicitly trusted maintainer loadouts) decide.

## Workflow

1. Read the target page and its supporting claims first
   (`mcp__openwiki__wiki.read_page`, `mcp__openwiki__wiki.trace_claim`).
2. Search for conflicting or stale records before drafting
   (`mcp__openwiki__wiki.search`, `mcp__openwiki__wiki.graph_stale`,
   `mcp__openwiki__wiki.list_facts`, `mcp__openwiki__wiki.list_takes`,
   `mcp__openwiki__wiki.detect_governance`).
3. Draft the full replacement page body — scoped to the change, keeping
   existing citations intact.
4. Call `mcp__openwiki__wiki.propose_edit` with a concise rationale for the
   change. This requires user approval by design.
5. Use fact/take proposal tools (`mcp__openwiki__wiki.propose_fact`,
   `mcp__openwiki__wiki.propose_take`, `mcp__openwiki__wiki.resolve_take`,
   `mcp__openwiki__wiki.forget_fact`) only when the requested change is
   better represented as governed memory. These require approval.
6. Use `mcp__openwiki__wiki.comment_on_proposal` for non-decision review notes
   or missing-evidence requests.
7. Never apply, publish, or commit proposals yourself. Those write-tier tools
   are reserved for explicitly trusted maintainer loadouts and are not exposed
   in this deployment's proposal tier.

## Review checklist

When reviewing someone else's proposal, check that the diff is scoped, cited,
and consistent with existing source and claim records before recommending a
decision.
