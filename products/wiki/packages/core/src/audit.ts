import type { DecisionRecord, EventRecord, ProposalRecord, RunRecord } from "./records.ts";

export interface AuditFilters {
  actorId?: string | undefined;
  eventType?: string | undefined;
  operation?: string | undefined;
  recordId?: string | undefined;
  since?: string | undefined;
  until?: string | undefined;
}

export interface AuditTimelineEntry {
  kind: "event" | "run" | "proposal" | "decision";
  id: string;
  actor_id?: string;
  record_id?: string;
  operation?: string;
  status?: string;
  occurred_at: string;
  title: string;
  record: EventRecord | RunRecord | ProposalRecord | DecisionRecord;
}

export function compactAuditFilters(filters: AuditFilters): AuditFilters {
  return {
    ...(filters.actorId?.trim() ? { actorId: filters.actorId.trim() } : {}),
    ...(filters.eventType?.trim() ? { eventType: filters.eventType.trim() } : {}),
    ...(filters.operation?.trim() ? { operation: filters.operation.trim() } : {}),
    ...(filters.recordId?.trim() ? { recordId: filters.recordId.trim() } : {}),
    ...(filters.since?.trim() ? { since: filters.since.trim() } : {}),
    ...(filters.until?.trim() ? { until: filters.until.trim() } : {}),
  };
}

export function filterEventRecords(events: EventRecord[], filters: AuditFilters): EventRecord[] {
  return events.filter((event) =>
    auditMatchesActor(event.actor_id, filters) &&
    auditMatchesString(event.type, filters.eventType) &&
    auditMatchesString(event.operation, filters.operation) &&
    auditMatchesRecord(event.record_id, event.subject_ids, filters) &&
    auditMatchesTime(event.occurred_at, filters)
  );
}

export function paginateEventRecords(events: EventRecord[], limit: number, cursor: string | undefined): { events: EventRecord[]; next_cursor?: string } {
  const parsed = parseAuditCursor(cursor);
  const sortedEvents = [...events].sort((left, right) => right.occurred_at.localeCompare(left.occurred_at) || right.id.localeCompare(left.id));
  const afterCursor = parsed === undefined
    ? sortedEvents
    : sortedEvents.filter((event) => event.occurred_at < parsed.occurredAt || (event.occurred_at === parsed.occurredAt && event.id < parsed.eventId));
  const boundedLimit = Math.max(limit, 0);
  const page = afterCursor.slice(0, boundedLimit);
  const last = page.at(-1);
  return {
    events: page,
    ...(afterCursor.length > boundedLimit && last !== undefined ? { next_cursor: auditCursor(last) } : {}),
  };
}

function auditCursor(event: EventRecord): string {
  return `${event.occurred_at}|${event.id}`;
}

function parseAuditCursor(value: string | undefined): { occurredAt: string; eventId: string } | undefined {
  if (value === undefined || !value.trim()) {
    return undefined;
  }
  const [occurredAt, eventId] = value.split("|");
  if (!occurredAt?.trim() || !eventId?.trim()) {
    return undefined;
  }
  return { occurredAt, eventId };
}

export function buildAuditTimeline(
  events: EventRecord[],
  runs: RunRecord[],
  proposals: ProposalRecord[],
  decisions: DecisionRecord[],
): AuditTimelineEntry[] {
  return [
    ...events.map((event): AuditTimelineEntry => ({
      kind: "event",
      id: event.id,
      ...(event.actor_id === undefined ? {} : { actor_id: event.actor_id }),
      ...(event.record_id === undefined ? {} : { record_id: event.record_id }),
      ...(event.operation === undefined ? {} : { operation: event.operation }),
      occurred_at: event.occurred_at,
      title: event.type,
      record: event,
    })),
    ...runs.map((run): AuditTimelineEntry => ({
      kind: "run",
      id: run.id,
      actor_id: run.actor_id,
      status: run.status,
      occurred_at: run.completed_at ?? run.started_at ?? run.created_at,
      title: run.run_type,
      record: run,
    })),
    ...proposals.map((proposal): AuditTimelineEntry => ({
      kind: "proposal",
      id: proposal.id,
      actor_id: proposal.actor_id,
      status: proposal.status,
      ...(proposal.target_ids[0] === undefined ? {} : { record_id: proposal.target_ids[0] }),
      occurred_at: proposal.closed_at ?? proposal.created_at,
      title: proposal.title,
      record: proposal,
    })),
    ...decisions.map((decision): AuditTimelineEntry => ({
      kind: "decision",
      id: decision.id,
      actor_id: decision.actor_id,
      status: decision.decision,
      record_id: decision.proposal_id,
      occurred_at: decision.decided_at,
      title: decision.decision,
      record: decision,
    })),
  ].sort(compareAuditTimelineEntries);
}

export function paginateAuditTimeline(
  entries: AuditTimelineEntry[],
  limit: number,
  cursor: string | undefined,
): { entries: AuditTimelineEntry[]; next_cursor?: string } {
  const parsed = parseAuditCursor(cursor);
  const afterCursor = parsed === undefined
    ? entries
    : entries.filter((entry) => entry.occurred_at < parsed.occurredAt || (entry.occurred_at === parsed.occurredAt && auditTimelineCursorId(entry) < parsed.eventId));
  const boundedLimit = Math.max(limit, 0);
  const page = afterCursor.slice(0, boundedLimit);
  const last = page.at(-1);
  return {
    entries: page,
    ...(afterCursor.length > boundedLimit && last !== undefined ? { next_cursor: `${last.occurred_at}|${auditTimelineCursorId(last)}` } : {}),
  };
}

export function filterAuditRuns(runs: RunRecord[], filters: AuditFilters): RunRecord[] {
  if (filters.eventType !== undefined || filters.operation !== undefined) {
    return [];
  }
  return runs.filter((run) =>
    auditMatchesActor(run.actor_id, filters) &&
    auditMatchesRecord(run.id, run.subject_ids, filters) &&
    auditMatchesTime(run.created_at, filters)
  );
}

export function filterAuditProposals(proposals: ProposalRecord[], filters: AuditFilters): ProposalRecord[] {
  if (filters.eventType !== undefined || filters.operation !== undefined) {
    return [];
  }
  return proposals.filter((proposal) =>
    auditMatchesActor(proposal.actor_id, filters) &&
    auditMatchesRecord(proposal.id, proposal.target_ids, filters, proposal.target_path) &&
    auditMatchesTime(proposal.created_at, filters)
  );
}

export function filterAuditDecisions(decisions: DecisionRecord[], filters: AuditFilters): DecisionRecord[] {
  if (filters.eventType !== undefined || filters.operation !== undefined) {
    return [];
  }
  return decisions.filter((decision) =>
    auditMatchesActor(decision.actor_id, filters) &&
    auditMatchesRecord(decision.id, [decision.proposal_id], filters) &&
    auditMatchesTime(decision.decided_at, filters)
  );
}

function compareAuditTimelineEntries(left: AuditTimelineEntry, right: AuditTimelineEntry): number {
  return right.occurred_at.localeCompare(left.occurred_at) || auditTimelineCursorId(right).localeCompare(auditTimelineCursorId(left));
}

function auditTimelineCursorId(entry: AuditTimelineEntry): string {
  return `${entry.kind}:${entry.id}`;
}

function auditMatchesActor(actorId: string | undefined, filters: AuditFilters): boolean {
  return filters.actorId === undefined || actorId === filters.actorId;
}

function auditMatchesString(value: string | undefined, expected: string | undefined): boolean {
  return expected === undefined || value === expected;
}

function auditMatchesRecord(recordId: string | undefined, subjectIds: string[] | undefined, filters: AuditFilters, path?: string): boolean {
  return (
    filters.recordId === undefined ||
    recordId === filters.recordId ||
    path === filters.recordId ||
    (subjectIds ?? []).includes(filters.recordId)
  );
}

function auditMatchesTime(value: string, filters: AuditFilters): boolean {
  return (filters.since === undefined || value >= filters.since) && (filters.until === undefined || value <= filters.until);
}
