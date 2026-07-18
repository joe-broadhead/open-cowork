---
name: openwiki-edit
description: Use when proposing OpenWiki page edits, source additions, or synthesis pages through proposal-safe configured OpenWiki MCP tools.
version: 1.0.0
applies_to: [opencode, openclaw, mcp]
required_tools: [wiki.search, wiki.read_page, wiki.propose_edit, wiki.propose_synthesis, wiki.propose_source, wiki.read_proposal_detail]
allowed_operations: [wiki.search, wiki.read_page, wiki.read_source, wiki.trace_claim, wiki.propose_edit, wiki.propose_synthesis, wiki.propose_source, wiki.read_proposal_detail]
risk_level: medium
---

# OpenWiki Edit

Use proposals for wiki content changes.

Required behavior:

- Read/search before drafting an edit.
- Keep page bodies in Markdown.
- For `wiki.propose_edit`, send body Markdown only; do not include YAML frontmatter.
- For `wiki.propose_synthesis`, send body Markdown only; OpenWiki generates frontmatter.
- For sources, use valid `source_type` values only: `webpage`, `pdf`, `document`, `transcript`, `image`, `dataset`, `manual`.
- Preserve existing source and claim IDs unless the source or claim change is part of the task.
- Use `wiki.propose_edit`, `wiki.propose_synthesis`, or `wiki.propose_source`.
- Immediately inspect proposals with `wiki.read_proposal_detail` and report validation status.
- Do not directly edit canonical pages during normal client mode.
