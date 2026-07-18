import { boundedNumberQuery, corsHeaders, securityHeaders } from "./request.ts";
import type { HttpPolicyOptions } from "./types.ts";
import { type AuditFilters, buildAuditTimeline, compactAuditFilters, type EventRecord, filterAuditDecisions, filterAuditProposals, filterAuditRuns, filterEventRecords, paginateAuditTimeline, paginateEventRecords } from "@openwiki/core";
import { canReadDecisionRecord } from "@openwiki/policy";
import { listCurrentPostgresEvents, listCurrentPostgresRuns, type PostgresRuntimeEventListOptions, type PostgresRuntimeRunListOptions } from "@openwiki/postgres-runtime";
import { listEvents, listRuns, loadRepository } from "@openwiki/repo";
import type { IncomingMessage, ServerResponse } from "node:http";
import { httpPolicyContext } from "./auth.ts";
import { AUDIT_SOURCE_LIMIT, HTTP_EVENT_LIMIT_MAX } from "./constants.ts";
import { filterEventsByPolicy, filterRunsByPolicy, listVisibleProposals } from "./data-access.ts";

export function eventStreamUrl(rawUrl: string): URL | undefined {
  const url = new URL(rawUrl, "http://openwiki.local");
  return url.pathname === "/api/v1/events/stream" ? url : undefined;
}

export async function writeEventStream(
  root: string,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  policy: HttpPolicyOptions,
): Promise<void> {
  response.writeHead(200, {
    ...corsHeaders(),
    ...eventStreamHeaders(),
    ...securityHeaders("text/event-stream; charset=utf-8"),
    "content-type": "text/event-stream; charset=utf-8",
  });
  response.write(": openwiki event stream\n\n");

  const sent = new Set<string>();
  const sendPendingEvents = async (): Promise<void> => {
    for (const event of await eventStreamEvents(root, url, policy, sent)) {
      sent.add(event.id);
      response.write(renderSseEvent(event));
    }
  };

  await sendPendingEvents();
  if (url.searchParams.get("once") === "true") {
    response.end();
    return;
  }

  const pollMs = boundedNumberQuery(url, "poll_ms", 1000, 250, 30_000);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const close = (): void => {
    closed = true;
    if (timer) {
      clearTimeout(timer);
    }
  };
  request.on("close", close);

  const tick = async (): Promise<void> => {
    if (closed) {
      return;
    }
    try {
      await sendPendingEvents();
      response.write(`: heartbeat ${new Date().toISOString()}\n\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.write(`event: openwiki.error\ndata: ${JSON.stringify({ message })}\n\n`);
    }
    if (!closed) {
      timer = setTimeout(() => {
        tick().catch(() => undefined);
      }, pollMs);
    }
  };

  timer = setTimeout(() => {
    tick().catch(() => undefined);
  }, pollMs);
}

export async function eventStreamEvents(root: string, url: URL, policy: HttpPolicyOptions, alreadySent?: Set<string>): Promise<EventRecord[]> {
  const limit = boundedNumberQuery(url, "limit", 50, 1, HTTP_EVENT_LIMIT_MAX);
  const since = url.searchParams.get("since")?.trim();
  const result = await filterEventsByPolicy(root, policy, (await listCurrentPostgresEvents(root, {
    limit,
    ...(since && !since.startsWith("event:") ? { since } : {}),
  })) ?? (await listEvents(root, limit)));
  return result.events
    .filter((event) => !alreadySent?.has(event.id))
    .filter((event) => (since ? eventIsAfterCursor(event, since) : true))
    .reverse();
}

export async function eventPage(root: string, url: URL, policy: HttpPolicyOptions): Promise<unknown> {
  const limit = boundedNumberQuery(url, "limit", 50, 0, HTTP_EVENT_LIMIT_MAX);
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const filters = auditFiltersFromUrl(url);
  const source = (await listCurrentPostgresEvents(root, auditEventListOptions(filters, AUDIT_SOURCE_LIMIT))) ?? {
    source: "parser" as const,
    events: (await listEvents(root, AUDIT_SOURCE_LIMIT)).events,
  };
  const visible = await filterEventsByPolicy(root, policy, source);
  const page = paginateEventRecords(filterEventRecords(visible.events, filters), limit, cursor);
  return {
    source: source.source,
    filters,
    events: page.events,
    ...(page.next_cursor === undefined ? {} : { next_cursor: page.next_cursor }),
  };
}

export async function auditExport(root: string, url: URL, policy: HttpPolicyOptions): Promise<unknown> {
  const pageLimit = boundedNumberQuery(url, "limit", 500, 0, AUDIT_SOURCE_LIMIT);
  const filters = auditFiltersFromUrl(url);
  const repo = await loadRepository(root);
  const context = httpPolicyContext(policy);
  const [events, runs, proposals] = await Promise.all([
    filterEventsByPolicy(root, policy, (await listCurrentPostgresEvents(root, auditEventListOptions(filters, AUDIT_SOURCE_LIMIT))) ?? (await listEvents(root, AUDIT_SOURCE_LIMIT))),
    filterRunsByPolicy(root, policy, (await auditRunsFromPostgresOrGit(root, filters)) ?? (await listRuns(root, AUDIT_SOURCE_LIMIT))),
    listVisibleProposals(root, policy, { limit: AUDIT_SOURCE_LIMIT }),
  ]);
  const decisions = repo.decisions.filter((decision) => canReadDecisionRecord(repo, context, decision));
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const filteredEvents = filterEventRecords(events.events, filters);
  const eventPage = paginateEventRecords(filteredEvents, pageLimit, cursor);
  const filteredRuns = filterAuditRuns(runs.runs, filters);
  const filteredProposals = filterAuditProposals(proposals.proposals, filters);
  const filteredDecisions = filterAuditDecisions(decisions, filters);
  const returnedRuns = filteredRuns.slice(0, pageLimit);
  const returnedProposals = filteredProposals.slice(0, pageLimit);
  const returnedDecisions = filteredDecisions.slice(0, pageLimit);
  const timelinePage = paginateAuditTimeline(
    buildAuditTimeline(filteredEvents, filteredRuns, filteredProposals, filteredDecisions),
    pageLimit,
    url.searchParams.get("timeline_cursor") ?? undefined,
  );
  return {
    generated_at: new Date().toISOString(),
    workspace_id: repo.config.workspace_id,
    filters,
    events: eventPage.events,
    ...(eventPage.next_cursor === undefined ? {} : { next_cursor: eventPage.next_cursor }),
    runs: returnedRuns,
    proposals: returnedProposals,
    decisions: returnedDecisions,
    timeline: timelinePage.entries,
    ...(timelinePage.next_cursor === undefined ? {} : { next_timeline_cursor: timelinePage.next_cursor }),
    counts: {
      events: eventPage.events.length,
      runs: returnedRuns.length,
      proposals: returnedProposals.length,
      decisions: returnedDecisions.length,
      timeline: timelinePage.entries.length,
    },
  };
}

async function auditRunsFromPostgresOrGit(root: string, filters: AuditFilters): Promise<{ source: "postgres-runtime"; runs: [] } | Awaited<ReturnType<typeof listCurrentPostgresRuns>>> {
  if (filters.eventType !== undefined || filters.operation !== undefined) {
    return { source: "postgres-runtime", runs: [] };
  }
  return listCurrentPostgresRuns(root, auditRunListOptions(filters, AUDIT_SOURCE_LIMIT));
}

function auditEventListOptions(filters: AuditFilters, limit: number): PostgresRuntimeEventListOptions {
  return {
    limit,
    ...(filters.actorId === undefined ? {} : { actorId: filters.actorId }),
    ...(filters.eventType === undefined ? {} : { eventType: filters.eventType }),
    ...(filters.operation === undefined ? {} : { operation: filters.operation }),
    ...(filters.recordId === undefined ? {} : { recordId: filters.recordId }),
    ...(filters.since === undefined ? {} : { since: filters.since }),
    ...(filters.until === undefined ? {} : { until: filters.until }),
  };
}

function auditRunListOptions(filters: AuditFilters, limit: number): PostgresRuntimeRunListOptions {
  return {
    limit,
    ...(filters.actorId === undefined ? {} : { actorId: filters.actorId }),
    ...(filters.recordId === undefined ? {} : { recordId: filters.recordId }),
    ...(filters.since === undefined ? {} : { since: filters.since }),
    ...(filters.until === undefined ? {} : { until: filters.until }),
  };
}

function auditFiltersFromUrl(url: URL): AuditFilters {
  return compactAuditFilters({
    actorId: url.searchParams.get("actor_id") ?? url.searchParams.get("actor") ?? undefined,
    eventType: url.searchParams.get("event_type") ?? url.searchParams.get("type") ?? undefined,
    operation: url.searchParams.get("operation") ?? undefined,
    recordId: url.searchParams.get("record_id") ?? url.searchParams.get("record") ?? undefined,
    since: url.searchParams.get("since") ?? undefined,
    until: url.searchParams.get("until") ?? undefined,
  });
}

function eventIsAfterCursor(event: EventRecord, cursor: string): boolean {
  if (cursor.startsWith("event:")) {
    return event.id.localeCompare(cursor) > 0;
  }
  return event.occurred_at.localeCompare(cursor) > 0;
}

export function renderEventStream(events: EventRecord[]): string {
  return events.map((event) => renderSseEvent(event)).join("");
}

function renderSseEvent(event: EventRecord): string {
  return [`id: ${sseField(event.id)}`, `event: ${sseField(event.type)}`, `data: ${JSON.stringify(event)}`, "", ""].join(
    "\n",
  );
}

export function sseField(value: string): string {
  return value.replace(/[\r\n]/g, " ");
}

export function eventStreamHeaders(): Record<string, string> {
  return {
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  };
}
