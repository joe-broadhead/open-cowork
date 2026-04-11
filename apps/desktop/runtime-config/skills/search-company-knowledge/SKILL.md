---
name: search-company-knowledge
description: "Search across Jira, Confluence, and Compass to answer internal company questions with citations. Use when the user asks how an internal system works, wants internal documentation, needs Jira/Confluence context, or asks for company-specific terminology, process, architecture, or operational knowledge."
allowed-tools: "mcp__atlassian-rovo-mcp__*"
metadata:
  owner: "cowork"
  persona: "knowledge"
  provider: "atlassian"
  version: "1.0.0"
---

# Search Company Knowledge

## Mission

Find the best available answer in Atlassian knowledge sources, then return a concise synthesis with direct source links.

## Use This Skill When

- The user asks how an internal system, process, or team workflow works.
- The answer is likely documented in Confluence, Jira, or Compass.
- You need company-specific context rather than generic internet knowledge.

## Workflow

1. Identify the core topic.
- Reduce the user request to a few search terms.
- Prefer product names, system names, team names, project keys, or exact terminology over long natural-language queries.

2. Search broadly first.
- Start with the Atlassian cross-product search tool if available.
- If the result set is noisy, narrow with Jira-specific or Confluence-specific search tools.
- Prefer recent and canonical documentation pages over scattered ticket chatter.

3. Fetch the best sources.
- Open the most relevant Confluence pages or Jira issues instead of relying on snippets alone.
- If multiple sources disagree, collect both and make the disagreement explicit.

4. Synthesize the answer.
- Lead with the direct answer.
- Follow with a short explanation organized by topic, not by source order.
- Call out gaps, ambiguity, or stale documentation if you see it.

5. Cite the sources.
- Always include direct links to the Confluence pages, Jira issues, or Compass entries you used.

## Guardrails

- Do not invent internal facts when the search results are weak.
- If no strong source exists, say that clearly and offer the closest related documentation you found.
- Prefer read/search/fetch operations. Do not modify Jira or Confluence while using this skill.

## Output Pattern

Use this structure when it fits:

```md
## Answer
[Direct answer]

## Details
- [Key point]
- [Key point]

## Sources
- [Source title](url)
- [Source title](url)
```
