# Meeting Knowledge

Meeting curation turns transcript evidence into reviewable wiki proposals. The
defaults below are conventions, not a mandatory ontology. Personal wikis and
organizations can rename page families or add local sections as long as agents
search first, cite sources, preserve uncertainty, and keep changes governed.

## Page Families

OpenWiki uses these defaults for transcript-derived knowledge:

| Type | Path Family | Use |
| --- | --- | --- |
| `meeting` | `wiki/meetings/<slug>.md` | One page per durable meeting or transcript. |
| `person` | `wiki/people/<slug>.md` | People mentioned, attending, owning work, or making decisions. |
| `organization` | `wiki/organizations/<slug>.md` | Companies, teams, vendors, customers, and groups. |
| `project` | `wiki/projects/<slug>.md` | Recurring initiatives, workstreams, or products. |
| `topic` | `wiki/topics/<slug>.md` | Durable subject areas and open-question indexes. |
| `decision` | `wiki/decisions/<slug>.md` | Durable decisions made or referenced. |
| `action` | `wiki/actions/<slug>.md` | Follow-ups with owner and due date when stated. |

The `personal-wiki` template includes starter pages for meetings, people,
organizations, projects, and open questions so agents have obvious places to
link and update.

## Proposal Plan

Before creating proposals, agents should draft a `MeetingCurationPlan`:

```json
{
  "schema_version": "openwiki.meeting_curation_plan.v1",
  "inbox_item_id": "inbox:2026-05-31-001",
  "source_id": "source:2026-05-31-001",
  "page_creations": [],
  "page_updates": [],
  "entity_candidates": [],
  "merge_candidates": [],
  "unresolved_ambiguities": [],
  "validation_warnings": []
}
```

The plan should include proposed page creations, proposed updates to existing
people, organizations, projects, topics, decisions, or actions, merge candidates
when an entity already exists, unresolved ambiguities, and validation warnings.
OpenWiki validates that transcript-derived targets use supported page types and
carry the transcript source ID before proposals are created.

## Page Content

Every transcript-derived proposal should include:

- a stable title and slug convention;
- a concise summary;
- source IDs;
- confidence or uncertainty notes;
- wiki links to related people, organizations, projects, topics, decisions, and
  action items;
- open questions when information is missing;
- explicit separation between transcript facts and agent interpretation.

For meeting pages, use this shape:

```markdown
# Meeting Title

Date: YYYY-MM-DD or "Unknown"

## Summary

Evidence-backed summary in neutral language.

## Transcript Facts

- Fact stated by the transcript.

## Agent Interpretation

- Interpretation separated from transcript facts, or "No interpretation beyond
  transcript facts."

## Participants

- [[Person Name]] - role or organization when explicit

## Decisions

- Decision, rationale, and source ID.

## Action Items

- Owner, action, due date if explicit, and status if known.

## Open Questions

- Missing owner, date, attendee identity, or unsupported inference.

## Sources

- source:id
```

## Multi-Page Review

The current governed flow creates one proposal per page creation or update.
That is sufficient for the first implementation because proposal detail shows
the diff, snapshot, validation report, target path, source IDs, and rationale
for each affected page. Agents should group related proposal IDs in their final
report and include the same inbox item ID and source ID across the set.

Future multi-target proposal bundles can build on the same plan shape when a
team wants one review decision to cover a meeting page plus its related person,
organization, project, decision, and action updates.
