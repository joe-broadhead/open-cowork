import { uniqueStrings } from "@openwiki/core";
import type {
  BuildMeetingCurationPlanInput,
  MeetingActionDraft,
  MeetingDecisionDraft,
  MeetingEntityDraft,
  MeetingPlanEntityCandidate,
} from "./meeting-plans.ts";

export function renderMeetingPageBody(input: BuildMeetingCurationPlanInput, candidates: MeetingPlanEntityCandidate[], sourceIds: string[], ambiguities: string[]): string {
  const people = candidates.filter((candidate) => candidate.page_type === "person").map((candidate) => `- ${pageLink(candidate.title)}`);
  const organizations = candidates.filter((candidate) => candidate.page_type === "organization").map((candidate) => `- ${pageLink(candidate.title)}`);
  const projects = candidates.filter((candidate) => candidate.page_type === "project").map((candidate) => `- ${pageLink(candidate.title)}`);
  const topics = candidates.filter((candidate) => candidate.page_type === "topic").map((candidate) => `- ${pageLink(candidate.title)}`);
  return [
    `# ${input.title.trim()}`,
    "",
    `Date: ${input.date ?? "Unknown"}`,
    "",
    "## Summary",
    "",
    input.summary ?? "Transcript-derived meeting summary pending human review.",
    "",
    "## Transcript Facts",
    "",
    ...bulletList(input.transcriptFacts),
    "",
    "## Agent Interpretation",
    "",
    ...bulletList(input.agentInterpretation ?? ["No interpretation beyond transcript facts."]),
    "",
    "## Participants",
    "",
    ...(people.length > 0 ? people : ["- Not stated"]),
    "",
    "## Organizations",
    "",
    ...(organizations.length > 0 ? organizations : ["- Not stated"]),
    "",
    "## Projects And Topics",
    "",
    ...(projects.length > 0 || topics.length > 0 ? [...projects, ...topics] : ["- Not stated"]),
    "",
    "## Decisions",
    "",
    ...bulletList((input.decisions ?? []).map((decision) => `${decision.title}: ${decision.summary}`), "- No decisions stated"),
    "",
    "## Action Items",
    "",
    ...bulletList((input.actions ?? []).map((action) => `${action.owner ? `${action.owner}: ` : ""}${action.title}${action.due_date ? ` (due ${action.due_date})` : ""}`), "- No action items stated"),
    "",
    "## Open Questions",
    "",
    ...bulletList(ambiguities, "- None recorded"),
    "",
    "## Sources",
    "",
    ...sourceIds.map((sourceId) => `- ${sourceId}`),
  ].join("\n");
}

export function renderEntityPageBody(entity: MeetingEntityDraft, sourceIds: string[], ambiguities: string[]): string {
  return titledEvidencePage(
    entity.title,
    entity.summary ?? `${entity.title.trim()} was identified from meeting transcript evidence.`,
    [entity.evidence ?? `${entity.title.trim()} was mentioned in the transcript.`],
    sourceIds,
    ambiguities,
  );
}

export function renderDecisionPageBody(decision: MeetingDecisionDraft, sourceIds: string[], ambiguities: string[]): string {
  return titledEvidencePage(decision.title, decision.summary, [decision.rationale ?? decision.summary], sourceIds, ambiguities);
}

export function renderActionPageBody(action: MeetingActionDraft, sourceIds: string[], ambiguities: string[]): string {
  return [
    `# ${action.title.trim()}`,
    "",
    "## Transcript Facts",
    "",
    ...bulletList([
      `Owner: ${action.owner ?? "not stated"}.`,
      `Due date: ${action.due_date ?? "not stated"}.`,
      `Status: ${action.status ?? "open"}.`,
    ]),
    "",
    ...sharedInterpretationSections(sourceIds, ambiguities),
  ].join("\n");
}

export function pageLink(title: string): string {
  return `[[${title.trim()}]]`;
}

function titledEvidencePage(title: string, summary: string, facts: string[], sourceIds: string[], ambiguities: string[]): string {
  return [
    `# ${title.trim()}`,
    "",
    "## Summary",
    "",
    summary,
    "",
    "## Transcript Facts",
    "",
    ...bulletList(facts),
    "",
    ...sharedInterpretationSections(sourceIds, ambiguities),
  ].join("\n");
}

function sharedInterpretationSections(sourceIds: string[], ambiguities: string[]): string[] {
  return [
    "## Agent Interpretation",
    "",
    "- No interpretation beyond transcript facts.",
    "",
    "## Open Questions",
    "",
    ...bulletList(ambiguities, "- None recorded"),
    "",
    "## Sources",
    "",
    ...sourceIds.map((sourceId) => `- ${sourceId}`),
  ];
}

function bulletList(values: string[], empty = "- Not stated"): string[] {
  const items = uniqueStrings(values, { trim: true, omitEmpty: true });
  return items.length === 0 ? [empty] : items.map((item) => `- ${item}`);
}
