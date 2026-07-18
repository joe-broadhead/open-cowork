import {
  assertOpenWikiId,
  pageId,
  slugify,
  synthesisTargetPath,
  uniqueStrings,
  isoNow,
  type ValidationIssue,
  type ValidationReport,
} from "@openwiki/core";
import {
  pageLink,
  renderActionPageBody,
  renderDecisionPageBody,
  renderEntityPageBody,
  renderMeetingPageBody,
} from "./meeting-plan-rendering.ts";

export const MEETING_KNOWLEDGE_PAGE_TYPES = ["meeting", "person", "organization", "project", "topic", "decision", "action"] as const;

export type MeetingKnowledgePageType = (typeof MEETING_KNOWLEDGE_PAGE_TYPES)[number];

export interface MeetingExistingPageRef {
  id: string;
  page_type: string;
  title: string;
  path?: string;
  aliases?: string[];
}

export interface MeetingEntityDraft {
  page_type: Exclude<MeetingKnowledgePageType, "meeting" | "decision" | "action">;
  title: string;
  summary?: string;
  evidence?: string;
  role?: string;
  organization?: string;
  links?: string[];
}

export interface MeetingDecisionDraft {
  title: string;
  summary: string;
  rationale?: string;
  owner?: string;
}

export interface MeetingActionDraft {
  title: string;
  owner?: string;
  due_date?: string;
  status?: string;
}

export interface BuildMeetingCurationPlanInput {
  inboxItemId: string;
  sourceId: string;
  title: string;
  date?: string;
  summary?: string;
  transcriptFacts: string[];
  agentInterpretation?: string[];
  entities?: MeetingEntityDraft[];
  decisions?: MeetingDecisionDraft[];
  actions?: MeetingActionDraft[];
  ambiguities?: string[];
  existingPages?: MeetingExistingPageRef[];
}

export interface MeetingPlanEntityCandidate {
  page_type: MeetingKnowledgePageType;
  title: string;
  slug: string;
  normalized_key: string;
  existing_page_id?: string;
  merge_candidate_ids: string[];
}

export interface MeetingPlanPageCreation {
  page_type: MeetingKnowledgePageType;
  title: string;
  slug: string;
  target_id: string;
  target_path: string;
  summary: string;
  source_ids: string[];
  body: string;
  links: string[];
  confidence: "low" | "medium" | "high";
  uncertainty_notes: string[];
}

export interface MeetingPlanPageUpdate {
  page_type: MeetingKnowledgePageType;
  title: string;
  target_id: string;
  target_path?: string;
  summary: string;
  source_ids: string[];
  proposed_sections: Array<{ heading: string; body: string }>;
  confidence: "low" | "medium" | "high";
  uncertainty_notes: string[];
}

export interface MeetingPlanMergeCandidate {
  page_type: MeetingKnowledgePageType;
  title: string;
  existing_page_id: string;
  reason: string;
}

export interface MeetingCurationPlan {
  schema_version: "openwiki.meeting_curation_plan.v1";
  inbox_item_id: string;
  source_id: string;
  generated_at: string;
  page_creations: MeetingPlanPageCreation[];
  page_updates: MeetingPlanPageUpdate[];
  entity_candidates: MeetingPlanEntityCandidate[];
  merge_candidates: MeetingPlanMergeCandidate[];
  unresolved_ambiguities: string[];
  validation_warnings: string[];
}

export function buildMeetingCurationPlan(input: BuildMeetingCurationPlanInput): MeetingCurationPlan {
  const sourceIds = uniqueStrings([input.sourceId], { trim: true, omitEmpty: true });
  const ambiguities = uniqueStrings(input.ambiguities ?? [], { trim: true, omitEmpty: true });
  const existingPages = input.existingPages ?? [];
  const entities = dedupeEntities(input.entities ?? []);
  const entityCandidates = entities.map((entity) => entityCandidate(entity.page_type, entity.title, existingPages));
  const mergeCandidates = entityCandidates
    .filter((candidate): candidate is MeetingPlanEntityCandidate & { existing_page_id: string } => candidate.existing_page_id !== undefined)
    .map((candidate) => ({
      page_type: candidate.page_type,
      title: candidate.title,
      existing_page_id: candidate.existing_page_id,
      reason: "Existing page with the same type and normalized title should be updated instead of duplicated.",
    }));

  const pageCreations: MeetingPlanPageCreation[] = [];
  const pageUpdates: MeetingPlanPageUpdate[] = [];
  const meetingCandidate = entityCandidate("meeting", input.title, existingPages);
  const meetingBody = renderMeetingPageBody(input, entityCandidates, sourceIds, ambiguities);
  if (meetingCandidate.existing_page_id) {
    const targetPath = existingPages.find((page) => page.id === meetingCandidate.existing_page_id)?.path;
    pageUpdates.push({
      page_type: "meeting",
      title: input.title.trim(),
      target_id: meetingCandidate.existing_page_id,
      summary: input.summary ?? `Meeting notes for ${input.title.trim()}.`,
      source_ids: sourceIds,
      proposed_sections: [{ heading: "Transcript-Derived Update", body: meetingBody }],
      confidence: "medium",
      uncertainty_notes: ambiguities,
      ...(targetPath === undefined ? {} : { target_path: targetPath }),
    });
  } else {
    pageCreations.push(pageCreation("meeting", input.title, input.summary ?? `Meeting notes for ${input.title.trim()}.`, sourceIds, meetingBody, entityCandidates.map((candidate) => pageLink(candidate.title)), ambiguities));
  }

  for (const entity of entities) {
    const candidate = entityCandidate(entity.page_type, entity.title, existingPages);
    if (candidate.existing_page_id) {
      pageUpdates.push(entityUpdate(entity, candidate.existing_page_id, existingPages, sourceIds, ambiguities));
    } else {
      pageCreations.push(entityCreation(entity, sourceIds, ambiguities));
    }
  }

  for (const decision of input.decisions ?? []) {
    pageCreations.push(pageCreation("decision", decision.title, decision.summary, sourceIds, renderDecisionPageBody(decision, sourceIds, ambiguities), [pageLink(input.title), ...(decision.owner ? [pageLink(decision.owner)] : [])], ambiguities));
  }

  for (const action of input.actions ?? []) {
    pageCreations.push(pageCreation("action", action.title, action.title, sourceIds, renderActionPageBody(action, sourceIds, ambiguities), [pageLink(input.title), ...(action.owner ? [pageLink(action.owner)] : [])], ambiguities));
  }

  const plan: MeetingCurationPlan = {
    schema_version: "openwiki.meeting_curation_plan.v1",
    inbox_item_id: input.inboxItemId,
    source_id: input.sourceId,
    generated_at: isoNow(),
    page_creations: dedupePageCreations(pageCreations),
    page_updates: dedupePageUpdates(pageUpdates),
    entity_candidates: entityCandidates,
    merge_candidates: mergeCandidates,
    unresolved_ambiguities: ambiguities,
    validation_warnings: [],
  };
  const validation = validateMeetingCurationPlan(plan);
  plan.validation_warnings = validation.issues.filter((issue) => issue.severity !== "error").map((issue) => issue.message);
  return plan;
}

export function validateMeetingCurationPlan(plan: MeetingCurationPlan): ValidationReport {
  const issues: ValidationIssue[] = [];
  pushIdIssue(issues, plan.inbox_item_id, "inbox", "inbox_item_id");
  pushIdIssue(issues, plan.source_id, "source", "source_id");
  const targetPaths = new Set<string>();
  for (const creation of plan.page_creations) {
    validatePlanPage(issues, creation.page_type, creation.title, creation.source_ids, creation.target_path);
    if (targetPaths.has(creation.target_path)) {
      issues.push({
        severity: "error",
        code: "meeting_plan.target_path.duplicate",
        message: `Meeting curation plan creates duplicate target path ${creation.target_path}.`,
        path: creation.target_path,
      });
    }
    targetPaths.add(creation.target_path);
    if (!creation.body.includes("## Transcript Facts")) {
      issues.push({
        severity: "warning",
        code: "meeting_plan.transcript_facts.missing",
        message: `Page creation ${creation.title} should separate transcript facts from interpretation.`,
        path: creation.target_path,
      });
    }
  }
  for (const update of plan.page_updates) {
    validatePlanPage(issues, update.page_type, update.title, update.source_ids, update.target_path);
    if (update.proposed_sections.length === 0) {
      issues.push({
        severity: "error",
        code: "meeting_plan.update.empty",
        message: `Page update ${update.title} must include at least one proposed section.`,
        ...(update.target_path === undefined ? {} : { path: update.target_path }),
      });
    }
    if (!update.proposed_sections.some((section) => section.body.includes("## Transcript Facts"))) {
      issues.push({
        severity: "warning",
        code: "meeting_plan.transcript_facts.missing",
        message: `Page update ${update.title} should separate transcript facts from interpretation.`,
        ...(update.target_path === undefined ? {} : { path: update.target_path }),
      });
    }
  }
  for (const sourceIds of [...plan.page_creations.map((page) => page.source_ids), ...plan.page_updates.map((page) => page.source_ids)]) {
    if (!sourceIds.includes(plan.source_id)) {
      issues.push({
        severity: "error",
        code: "meeting_plan.source_id.unlinked",
        message: `Every transcript-derived proposal target must include source id ${plan.source_id}.`,
      });
    }
  }
  return {
    id: `validation:meeting-plan:${slugify(plan.inbox_item_id)}`,
    proposal_id: "proposal:meeting-plan",
    status: issues.some((issue) => issue.severity === "error") ? "failed" : "passed",
    checked_at: isoNow(),
    issues,
  };
}

export function isMeetingKnowledgePageType(value: string): value is MeetingKnowledgePageType {
  return MEETING_KNOWLEDGE_PAGE_TYPES.includes(value as MeetingKnowledgePageType);
}

function pageCreation(
  pageType: MeetingKnowledgePageType,
  title: string,
  summary: string,
  sourceIds: string[],
  body: string,
  links: string[],
  uncertaintyNotes: string[],
): MeetingPlanPageCreation {
  const slug = slugify(title);
  return {
    page_type: pageType,
    title: title.trim(),
    slug,
    target_id: pageId(pageType, slug),
    target_path: synthesisTargetPath(title, pageType),
    summary,
    source_ids: sourceIds,
    body,
    links: uniqueStrings(links, { trim: true, omitEmpty: true }),
    confidence: "medium",
    uncertainty_notes: uncertaintyNotes,
  };
}

function entityCreation(entity: MeetingEntityDraft, sourceIds: string[], ambiguity: string[]): MeetingPlanPageCreation {
  return pageCreation(
    entity.page_type,
    entity.title,
    entity.summary ?? `${entity.title.trim()} mentioned in meeting transcript evidence.`,
    sourceIds,
    renderEntityPageBody(entity, sourceIds, ambiguity),
    entity.links ?? [],
    ambiguity,
  );
}

function entityUpdate(entity: MeetingEntityDraft, existingPageId: string, existingPages: MeetingExistingPageRef[], sourceIds: string[], ambiguity: string[]): MeetingPlanPageUpdate {
  const targetPath = existingPages.find((page) => page.id === existingPageId)?.path;
  return {
    page_type: entity.page_type,
    title: entity.title.trim(),
    target_id: existingPageId,
    summary: entity.summary ?? `${entity.title.trim()} has new meeting transcript evidence.`,
    source_ids: sourceIds,
    proposed_sections: [
      {
        heading: "Transcript-Derived Update",
        body: [
          "## Transcript Facts",
          "",
          `- ${entity.evidence ?? `${entity.title.trim()} was mentioned in the transcript.`}`,
          ...(entity.role ? [`- Role: ${entity.role}.`] : []),
          ...(entity.organization ? [`- Organization: ${pageLink(entity.organization)}.`] : []),
          "",
          "## Agent Interpretation",
          "",
          "- No interpretation beyond transcript facts.",
          "",
          "## Open Questions",
          "",
          ...(ambiguity.length > 0 ? ambiguity.map((item) => `- ${item}`) : ["- None recorded"]),
          "",
          "## Sources",
          "",
          ...sourceIds.map((sourceId) => `- ${sourceId}`),
          "",
        ].join("\n"),
      },
    ],
    confidence: "medium",
    uncertainty_notes: ambiguity,
    ...(targetPath === undefined ? {} : { target_path: targetPath }),
  };
}

function dedupeEntities(entities: MeetingEntityDraft[]): MeetingEntityDraft[] {
  const seen = new Set<string>();
  const result: MeetingEntityDraft[] = [];
  for (const entity of entities) {
    const key = `${entity.page_type}:${slugify(entity.title)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push({ ...entity, title: entity.title.trim() });
  }
  return result;
}

function entityCandidate(pageType: MeetingKnowledgePageType, title: string, existingPages: MeetingExistingPageRef[]): MeetingPlanEntityCandidate {
  const normalizedKey = `${pageType}:${slugify(title)}`;
  const matches = existingPages.filter((page) => page.page_type === pageType && [page.title, ...(page.aliases ?? [])].some((value) => slugify(value) === slugify(title)));
  return {
    page_type: pageType,
    title: title.trim(),
    slug: slugify(title),
    normalized_key: normalizedKey,
    ...(matches[0] === undefined ? {} : { existing_page_id: matches[0].id }),
    merge_candidate_ids: matches.slice(1).map((page) => page.id),
  };
}

function dedupePageCreations(pages: MeetingPlanPageCreation[]): MeetingPlanPageCreation[] {
  const seen = new Set<string>();
  return pages.filter((page) => {
    const key = `${page.page_type}:${page.slug}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function dedupePageUpdates(pages: MeetingPlanPageUpdate[]): MeetingPlanPageUpdate[] {
  const seen = new Set<string>();
  return pages.filter((page) => {
    if (seen.has(page.target_id)) {
      return false;
    }
    seen.add(page.target_id);
    return true;
  });
}

function validatePlanPage(issues: ValidationIssue[], pageType: string, title: string, sourceIds: string[], path: string | undefined): void {
  if (!isMeetingKnowledgePageType(pageType)) {
    issues.push({
      severity: "error",
      code: "meeting_plan.page_type.unsupported",
      message: `Unsupported meeting knowledge page type '${pageType}'.`,
      ...(path === undefined ? {} : { path }),
    });
  }
  if (!title.trim()) {
    issues.push({
      severity: "error",
      code: "meeting_plan.title.empty",
      message: "Meeting curation targets must have a title.",
      ...(path === undefined ? {} : { path }),
    });
  }
  if (sourceIds.length === 0) {
    issues.push({
      severity: "error",
      code: "meeting_plan.source_ids.empty",
      message: "Transcript-derived targets must include at least one source ID.",
      ...(path === undefined ? {} : { path }),
    });
  }
}

function pushIdIssue(issues: ValidationIssue[], id: string, kind: "inbox" | "source", field: string): void {
  try {
    assertOpenWikiId(id, kind);
  } catch (error) {
    issues.push({
      severity: "error",
      code: `meeting_plan.${field}.invalid`,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
