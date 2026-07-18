---
name: openwiki-meeting-curation
description: Use when turning transcript evidence into OpenWiki meeting pages, entity updates, decisions, action items, and proposal-safe wiki changes.
version: 1.0.0
applies_to: [opencode, openclaw, mcp]
required_tools: [wiki.inbox_read, wiki.read_source, wiki.search, wiki.propose_edit, wiki.propose_synthesis, wiki.read_proposal_detail]
allowed_operations: [wiki.inbox_list, wiki.inbox_read, wiki.read_source, wiki.search, wiki.read_page, wiki.propose_edit, wiki.propose_synthesis, wiki.read_proposal_detail]
risk_level: medium
---

# OpenWiki Meeting Curation

Use this skill after transcript intake has identified a meeting or call that
should become durable wiki knowledge.

## Required Sequence

1. Read the inbox item and linked transcript source.
2. Search existing pages for people, organizations, projects, topics, meetings,
   and decisions before proposing new pages.
3. Draft a meeting curation plan before proposing changes. Include inbox item
   ID, source ID, page creations, page updates, entity candidates, merge
   candidates, unresolved ambiguities, and validation warnings.
4. Decide whether to update an existing page or propose a new synthesis page.
5. Use `wiki.propose_edit` for existing pages and `wiki.propose_synthesis` for
   new pages. Do not include YAML frontmatter in proposal bodies.
6. Include source IDs only when the transcript source is already canonical.
7. Call `wiki.read_proposal_detail` for every proposal.
8. Report proposal IDs, validation status, and unresolved ambiguity.

## Page Families

Use these practical defaults unless the wiki's local conventions say otherwise:

| Type | Path Family | Use |
| --- | --- | --- |
| `meeting` | `wiki/meetings/<slug>.md` | One page per durable meeting or transcript. |
| `person` | `wiki/people/<slug>.md` | People mentioned, attending, owning work, or making decisions. |
| `organization` | `wiki/organizations/<slug>.md` | Companies, teams, vendors, customers, and groups. |
| `project` | `wiki/projects/<slug>.md` | Recurring initiatives, workstreams, or products. |
| `topic` | `wiki/topics/<slug>.md` | Durable subject areas and open-question indexes. |
| `decision` | `wiki/decisions/<slug>.md` | Durable decisions made or referenced. |
| `action` | `wiki/actions/<slug>.md` | Follow-ups with owner and due date only when stated. |

Title and slug rules:

- Prefer stable human titles: `YYYY-MM-DD Topic Meeting` for dated meetings when
  the date is explicit, otherwise use the transcript title.
- Search by likely aliases before creating people, organization, and project
  pages. Update the existing page when a same-type page has the same normalized
  title or alias.
- Keep local ontology customizable. Do not force every organization to use all
  page families.

## Meeting Page Shape

Prefer this body structure for a new meeting page:

```markdown
# Meeting Title

Date: YYYY-MM-DD or "Unknown"

## Participants

- [[Person Name]] - role or organization when explicit

## Summary

Evidence-backed summary in neutral language.

## Decisions

- Decision, rationale, and source ID.

## Action Items

- Owner, action, due date if explicit, and status if known.

## Follow-Ups And Open Questions

- Unresolved point or ambiguity.

## Sources

- source:id
```

Every transcript-derived proposal body should include:

- a clear summary;
- source IDs;
- confidence or uncertainty notes;
- related wiki links;
- open questions when information is missing;
- explicit separation between transcript facts and agent interpretation.

## Entity Updates

- People pages should get evidence-backed relationship, role, and responsibility
  updates only when the transcript states them.
- Organization pages should get project, decision, or relationship updates only
  when explicit.
- Project pages should get decisions, milestones, risks, and action items tied
  to source IDs.
- Decision pages should state the decision, date, participants, alternatives,
  rationale, and follow-up owner when explicit.

## Guardrails

- Propose focused changes; avoid one giant transcript dump.
- Preserve uncertainty. Use "not stated" or open questions instead of guessing.
- Do not edit canonical files directly.
- Do not apply proposals unless the user explicitly asks for trusted write-mode
  maintainer work and the tools are available.
