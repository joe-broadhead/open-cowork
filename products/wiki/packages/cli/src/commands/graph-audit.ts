import { configureGitRemote, diffVersions, getHistory, gitPull, gitPush, gitRemoteStatus, listRecentChanges } from "@openwiki/git";
import { graphCurrentIndexStoreNeighbors, graphCurrentIndexStoreOrphans, graphCurrentIndexStorePath, graphCurrentIndexStoreRelated, graphCurrentIndexStoreStale, readCurrentIndexStoreGraph } from "@openwiki/index-store";
import type { CliOptions } from "../args.ts";
import { printJson } from "../output.ts";
import { graphCurrentPostgresNeighbors, graphCurrentPostgresOrphans, graphCurrentPostgresPath, graphCurrentPostgresRelated, graphCurrentPostgresStale, listCurrentPostgresEvents, listCurrentPostgresProposals, listCurrentPostgresRuns, readCurrentPostgresGraph } from "@openwiki/postgres-runtime";
import { graphBacklinks, graphNeighbors, graphOrphans, graphPath, graphRelated, graphStale, listEvents, listGraphEdges, listProposals, listRuns, loadRepository } from "@openwiki/repo";
import { commitChanges, withWriteCoordination } from "@openwiki/workflows";
import { analyzeGraph, buildAuditTimeline, compactAuditFilters, filterAuditDecisions, filterAuditProposals, filterAuditRuns, filterEventRecords, type GraphAnalysisResponse, type GraphIndexResponse, paginateAuditTimeline, paginateEventRecords } from "@openwiki/core";
import { AUDIT_SOURCE_LIMIT, resolveRoot } from "../utils.ts";

export async function graphCommand(args: string[], options: CliOptions): Promise<void> {
  const [subcommand, first, second] = args;
  const root = await resolveRoot(options);
  if (subcommand === "report") {
    const report = analyzeGraph(await readBestGraph(root), options.limit === undefined ? {} : { limit: options.limit });
    if (options.json) {
      printJson(report);
      return;
    }
    printGraphReport(report);
    return;
  }
  if (subcommand === "edges") {
    const result = await readBestGraph(root);
    if (options.json) {
      printJson(result);
      return;
    }
    for (const edge of result.edges) {
      console.log(formatGraphEdge(edge, options));
    }
    return;
  }
  if (subcommand === "neighbors" && first) {
    const result = (await graphCurrentPostgresNeighbors(root, first, options.limit === undefined ? {} : { limit: options.limit })) ?? (await graphCurrentIndexStoreNeighbors(root, first, options.limit === undefined ? {} : { limit: options.limit })) ?? (await graphNeighbors(root, first, options.limit === undefined ? {} : { limit: options.limit }));
    printGraphResult(result, options);
    return;
  }
  if (subcommand === "backlinks" && first) {
    const result = (await graphCurrentPostgresNeighbors(root, first, { direction: "in", depth: 1, ...(options.limit === undefined ? {} : { limit: options.limit }) })) ?? (await graphCurrentIndexStoreNeighbors(root, first, { direction: "in", depth: 1, ...(options.limit === undefined ? {} : { limit: options.limit }) })) ?? (await graphBacklinks(root, first, options.limit === undefined ? {} : { limit: options.limit }));
    printGraphResult(result, options);
    return;
  }
  if (subcommand === "related" && first) {
    const result = (await graphCurrentPostgresRelated(root, first, options.limit === undefined ? {} : { limit: options.limit })) ?? (await graphCurrentIndexStoreRelated(root, first, options.limit === undefined ? {} : { limit: options.limit })) ?? (await graphRelated(root, first, options.limit === undefined ? {} : { limit: options.limit }));
    printGraphResult(result, options);
    return;
  }
  if (subcommand === "path" && first && second) {
    const result = (await graphCurrentPostgresPath(root, first, second)) ?? (await graphCurrentIndexStorePath(root, first, second)) ?? (await graphPath(root, first, second));
    if (options.json) {
      printJson(result);
      return;
    }
    if (!result.found) {
      console.log("No graph path found");
      return;
    }
    console.log(result.nodes.map((node) => node.id).join(" -> "));
    return;
  }
  if (subcommand === "orphans") {
    const result = (await graphCurrentPostgresOrphans(root)) ?? (await graphCurrentIndexStoreOrphans(root)) ?? (await graphOrphans(root));
    if (options.json) {
      printJson(result);
      return;
    }
    for (const page of result.pages) {
      console.log(page.id + "  " + page.title);
    }
    return;
  }
  if (subcommand === "stale") {
    const result = (await graphCurrentPostgresStale(root)) ?? (await graphCurrentIndexStoreStale(root)) ?? (await graphStale(root));
    if (options.json) {
      printJson(result);
      return;
    }
    for (const page of result.pages) {
      console.log(page.id + "  " + page.reasons.join(","));
    }
    for (const claim of result.claims) {
      console.log(claim.id + "  " + claim.status + "  " + claim.text);
    }
    return;
  }
  throw new Error("Usage: openwiki [--root <path>] graph edges|neighbors <id>|backlinks <id>|related <id>|path <from> <to>|orphans|stale|report [--json] [--limit N]");
}

async function readBestGraph(root: string): Promise<GraphIndexResponse> {
  return (await readCurrentPostgresGraph(root)) ?? (await readCurrentIndexStoreGraph(root)) ?? (await listGraphEdges(root));
}

function printGraphResult(result: Awaited<ReturnType<typeof graphNeighbors>>, options: CliOptions): void {
  if (options.json) {
    printJson(result);
    return;
  }
  for (const edge of result.edges) {
    console.log(formatGraphEdge(edge, options));
  }
}

function formatGraphEdge(edge: GraphIndexResponse["edges"][number], options: CliOptions): string {
  const base = edge.edge_type + "  " + edge.from_id + " -> " + edge.to_id;
  if (!options.explain || edge.metadata === undefined) {
    return base;
  }
  const relation = stringMetadata(edge.metadata, "relation");
  const rule = stringMetadata(edge.metadata, "extraction_rule");
  const linkKind = stringMetadata(edge.metadata, "link_kind");
  const confidence = numberMetadata(edge.metadata, "confidence");
  const pieces = [
    relation === undefined ? undefined : `relation=${relation}`,
    rule === undefined ? undefined : `rule=${rule}`,
    linkKind === undefined ? undefined : `kind=${linkKind}`,
    confidence === undefined ? undefined : `confidence=${confidence}`,
  ].filter((piece): piece is string => piece !== undefined);
  return pieces.length === 0 ? base : `${base}  ${pieces.join(" ")}`;
}

function stringMetadata(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" ? value : undefined;
}

function numberMetadata(metadata: Record<string, unknown>, key: string): number | undefined {
  const value = metadata[key];
  return typeof value === "number" ? value : undefined;
}

function printGraphReport(report: GraphAnalysisResponse): void {
  console.log(`Graph report: ${report.node_count} nodes, ${report.edge_count} edges`);
  printReportSection("Hub nodes", report.hub_nodes, (hub) => `${hub.id}  degree=${hub.degree} weighted=${hub.weighted_degree}  ${hub.reason_codes.join(",")}`);
  printReportSection("Orphan page clusters", report.orphan_components, (component) => `${component.id}  pages=${component.page_ids.length}  ${component.page_ids.join(", ")}`);
  printReportSection("Missing-link candidates", report.candidate_missing_links, (candidate) => `${candidate.from_id} -> ${candidate.to_id}  score=${candidate.score}  ${candidate.reason_codes.join(",")}`);
  printReportSection("Stale hubs", report.stale_hubs, (hub) => `${hub.id}  degree=${hub.degree}  ${hub.reason_codes.join(",")}  claims=${[...hub.stale_claim_ids, ...hub.disputed_claim_ids].join(", ")}`);
  printReportSection("Source coverage gaps", report.source_coverage_gaps, (gap) => `${gap.topic_id}  pages=${gap.page_count} sources=${gap.source_count}  score=${gap.score}`);
  printReportSection("Suggested questions", report.suggested_questions, (question) => `${question.question}  seeds=${question.seed_node_ids.join(", ")}`);
}

function printReportSection<T>(title: string, items: T[], line: (item: T) => string): void {
  console.log("");
  console.log(title);
  if (items.length === 0) {
    console.log("  none");
    return;
  }
  for (const item of items) {
    console.log(`  ${line(item)}`);
  }
}

export async function historyCommand(args: string[], options: CliOptions): Promise<void> {
  const [id] = args;
  if (!id) {
    throw new Error("Usage: openwiki [--root <path>] history <id> [--limit N] [--json]");
  }
  const result = await getHistory(await resolveRoot(options), id, options.limit);
  if (options.json) {
    printJson(result);
    return;
  }
  for (const commit of result.commits) {
    console.log(`${commit.short_sha}  ${commit.date}  ${commit.subject}`);
  }
}

export async function diffCommand(args: string[], options: CliOptions): Promise<void> {
  const [id] = args;
  if (!id) {
    throw new Error("Usage: openwiki [--root <path>] diff <id> [--from <ref>] [--to <ref>] [--json]");
  }
  const result = await diffVersions({
    root: await resolveRoot(options),
    id,
    ...(options.fromRef === undefined ? {} : { from: options.fromRef }),
    ...(options.toRef === undefined ? {} : { to: options.toRef }),
  });
  if (options.json) {
    printJson(result);
    return;
  }
  console.log(result.diff);
}

export async function changesCommand(options: CliOptions): Promise<void> {
  const result = await listRecentChanges(await resolveRoot(options), options.limit);
  if (options.json) {
    printJson(result);
    return;
  }
  for (const change of result.changes) {
    console.log(`${change.short_sha}  ${change.date}  ${change.subject}`);
    for (const file of change.files) {
      console.log(`  ${file.status} ${file.path}`);
    }
  }
}

export async function gitCommand(args: string[], options: CliOptions): Promise<void> {
  const [subcommand] = args;
  const root = await resolveRoot(options);
  if (subcommand === "status") {
    const result = await gitRemoteStatus(root);
    if (options.json) {
      printJson(result);
      return;
    }
    if (!result.is_git_repo) {
      console.log("not_git_repo");
      return;
    }
    console.log((result.branch ?? "detached") + " " + (result.clean ? "clean" : "dirty") + " ahead=" + result.ahead + " behind=" + result.behind);
    if (result.remote) {
      console.log("remote " + result.remote + (result.remote_url ? " " + result.remote_url : ""));
    }
    for (const change of result.changes) {
      console.log(change.index + change.working_tree + " " + change.path);
    }
    return;
  }
  if (subcommand === "configure") {
    const result = await configureGitRemote(root, {
      ...(options.gitRemote === undefined ? {} : { remote: options.gitRemote }),
      ...(options.gitBranch === undefined ? {} : { branch: options.gitBranch }),
      ...(options.gitRemoteUrl === undefined ? {} : { remote_url: options.gitRemoteUrl }),
      ...(options.credentialRef === undefined ? {} : { credential_ref: options.credentialRef }),
    });
    if (options.json) {
      printJson(result);
      return;
    }
    console.log("configured " + result.remote + " " + result.branch + (result.remote_url ? " " + result.remote_url : ""));
    return;
  }
  if (subcommand === "pull") {
    const result = await withWriteCoordination(
      {
        root,
        operation: "wiki.git_pull",
        ...(options.actor === undefined ? {} : { actorId: options.actor }),
        metadata: {
          ...(options.gitRemote === undefined ? {} : { remote: options.gitRemote }),
          ...(options.gitBranch === undefined ? {} : { branch: options.gitBranch }),
        },
      },
      () =>
        gitPull(root, {
          ...(options.gitRemote === undefined ? {} : { remote: options.gitRemote }),
          ...(options.gitBranch === undefined ? {} : { branch: options.gitBranch }),
        }),
    );
    if (options.json) {
      printJson(result);
      return;
    }
    console.log((result.status + " " + (result.remote ?? "") + " " + (result.branch ?? "")).trim());
    if (result.stdout) {
      console.log(result.stdout);
    }
    return;
  }
  if (subcommand === "push") {
    const result = await withWriteCoordination(
      {
        root,
        operation: "wiki.git_push",
        ...(options.actor === undefined ? {} : { actorId: options.actor }),
        metadata: {
          ...(options.gitRemote === undefined ? {} : { remote: options.gitRemote }),
          ...(options.gitBranch === undefined ? {} : { branch: options.gitBranch }),
        },
      },
      () =>
        gitPush(root, {
          ...(options.gitRemote === undefined ? {} : { remote: options.gitRemote }),
          ...(options.gitBranch === undefined ? {} : { branch: options.gitBranch }),
        }),
    );
    if (options.json) {
      printJson(result);
      return;
    }
    console.log((result.status + " " + (result.remote ?? "") + " " + (result.branch ?? "")).trim());
    if (result.stdout) {
      console.log(result.stdout);
    }
    return;
  }
  throw new Error("Usage: openwiki [--root <path>] git status|configure|pull|push [--remote origin] [--branch main] [--remote-url url] [--credential-ref ref] [--json]");
}

export async function commitCommand(options: CliOptions): Promise<void> {
  if (!options.message) {
    throw new Error(
      "Usage: openwiki [--root <path>] commit --message text [--all|--path path] [--actor actor:user:local] [--json]",
    );
  }
  const result = await commitChanges({
    root: await resolveRoot(options),
    message: options.message,
    ...(options.actor === undefined ? {} : { actorId: options.actor }),
    ...(options.commitPaths.length === 0 ? {} : { paths: options.commitPaths }),
    ...(options.commitAll ? { all: true } : {}),
  });
  if (options.json) {
    printJson(result);
    return;
  }
  if (!result.committed) {
    console.log(result.status);
    return;
  }
  console.log(`Committed ${result.short_sha}`);
  for (const committedPath of result.staged_paths) {
    console.log(committedPath);
  }
}

export async function eventsCommand(options: CliOptions): Promise<void> {
  const root = await resolveRoot(options);
  const limit = options.limit ?? 50;
  const source = (await listCurrentPostgresEvents(root, AUDIT_SOURCE_LIMIT)) ?? {
    source: "parser" as const,
    events: (await listEvents(root, AUDIT_SOURCE_LIMIT)).events,
  };
  const filters = compactAuditFilters({
    actorId: options.actor,
    eventType: options.eventType,
    operation: options.operation,
    recordId: options.recordId,
    since: options.since,
    until: options.until,
  });
  const page = paginateEventRecords(filterEventRecords(source.events, filters), Math.max(limit, 0), options.cursor);
  if (options.json) {
    printJson({
      source: source.source,
      events: page.events,
      filters,
      ...(page.next_cursor === undefined ? {} : { next_cursor: page.next_cursor }),
    });
    return;
  }
  for (const event of page.events) {
    console.log(`${event.occurred_at}  ${event.type}  ${event.record_id ?? ""}`);
  }
  if (page.next_cursor) {
    console.log(`next_cursor=${page.next_cursor}`);
  }
}

export async function auditCommand(args: string[], options: CliOptions): Promise<void> {
  const [subcommand] = args;
  if (subcommand !== "export") {
    throw new Error("Usage: openwiki [--root <path>] audit export [--actor actor:user:id] [--event-type type] [--operation op] [--record id] [--since ISO] [--until ISO] [--limit N] [--json]");
  }
  const root = await resolveRoot(options);
  const limit = options.limit ?? 500;
  const pageLimit = Math.max(limit, 0);
  const repo = await loadRepository(root);
  const filters = compactAuditFilters({
    actorId: options.actor,
    eventType: options.eventType,
    operation: options.operation,
    recordId: options.recordId,
    since: options.since,
    until: options.until,
  });
  const [events, runs, proposals] = await Promise.all([
    (await listCurrentPostgresEvents(root, AUDIT_SOURCE_LIMIT)) ?? {
      source: "parser" as const,
      events: (await listEvents(root, AUDIT_SOURCE_LIMIT)).events,
    },
    (await listCurrentPostgresRuns(root, AUDIT_SOURCE_LIMIT)) ?? (await listRuns(root, AUDIT_SOURCE_LIMIT)),
    (await listCurrentPostgresProposals(root, { limit: AUDIT_SOURCE_LIMIT })) ?? (await listProposals(root, { limit: AUDIT_SOURCE_LIMIT })),
  ]);
  const filteredEvents = filterEventRecords(events.events, filters);
  const eventPage = paginateEventRecords(filteredEvents, pageLimit, options.cursor);
  const filteredRuns = filterAuditRuns(runs.runs, filters);
  const filteredProposals = filterAuditProposals(proposals.proposals, filters);
  const filteredDecisions = filterAuditDecisions(repo.decisions, filters);
  const returnedRuns = filteredRuns.slice(0, pageLimit);
  const returnedProposals = filteredProposals.slice(0, pageLimit);
  const returnedDecisions = filteredDecisions.slice(0, pageLimit);
  const timelinePage = paginateAuditTimeline(
    buildAuditTimeline(filteredEvents, filteredRuns, filteredProposals, filteredDecisions),
    pageLimit,
    options.timelineCursor,
  );
  const result = {
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
  if (options.json) {
    printJson(result);
    return;
  }
  console.log(`Audit export for ${result.workspace_id}`);
  console.log(`events=${result.counts.events} runs=${result.counts.runs} proposals=${result.counts.proposals} decisions=${result.counts.decisions}`);
  if (result.next_timeline_cursor) {
    console.log(`next_timeline_cursor=${result.next_timeline_cursor}`);
  }
}
