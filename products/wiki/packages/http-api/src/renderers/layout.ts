import type { HttpPolicyOptions } from "../types.ts";
import { type ClaimRecord, type DecisionRecord, type EventRecord, type InboxItemRecord, type PageRecord, type ProposalCommentRecord, type ProposalRecord, type RunRecord, slugify, type SourceRecord, type TopicSummary } from "@openwiki/core";
import type { GitCommitEntry, RecentChangesResponse } from "@openwiki/git";
import { graphCurrentIndexStoreNeighbors, graphCurrentIndexStoreRelated } from "@openwiki/index-store";
import { graphCurrentPostgresNeighbors, graphCurrentPostgresRelated } from "@openwiki/postgres-runtime";
import { graphNeighbors, graphRelated } from "@openwiki/repo";
import { escapeHtml, type PaletteSuggestion, renderPanel, renderShell, type ShellNavItem } from "@openwiki/web";
import { canSeeAdminSurface, httpPolicyContext, identityLabelForPolicy, identityTitleForPolicy } from "../auth.ts";
import { filterGraphNeighborhoodByPolicy } from "../data-access.ts";
import type { RunDetailResponse, RunMonitorResponse } from "../misc.ts";
import { renderExternalLink, renderGraphPanel, statusBadge, webHrefForRecord } from "./graph.ts";

export type ServerActive = "home" | "pages" | "inbox" | "proposals" | "spaces" | "admin" | "runs" | "graph";

export function htmlLayout(
  title: string,
  active: ServerActive,
  body: string,
  options: { paletteSuggestions?: PaletteSuggestion[]; policy?: HttpPolicyOptions } = {},
): string {
  const shellPolicy = options.policy ?? {};
  const footer = canSeeAdminSurface(shellPolicy)
    ? `<a href="/admin">Admin</a><a href="/openapi.json">OpenAPI</a><a href="/mcp-manifest.json">MCP manifest</a>`
    : `<span>OpenWiki</span>`;
  return renderShell({
    title,
    workspaceTitle: "Workspace",
    active,
    assetBase: "/_assets/",
    identityLabel: identityLabelForPolicy(shellPolicy),
    identityTitle: identityTitleForPolicy(shellPolicy),
    navItems: serverNavItems(active, shellPolicy),
    sidebar: renderServerLazySidebar(active, shellPolicy),
    searchIndexHref: "",
    searchApiHref: "/api/v1/search",
    graphHref: "/graph",
    main: body,
    footer,
    ...(options.paletteSuggestions === undefined ? {} : { paletteSuggestions: options.paletteSuggestions }),
  });
}

function renderServerLazySidebar(active: ServerActive, policy: HttpPolicyOptions): string {
  const graphLink = canSeeGraphSurface(policy) ? `<a${active === "graph" ? ` aria-current="page"` : ""} href="/graph">Graph</a>` : "";
  const adminLink = canSeeAdminSurface(policy) ? `<a${active === "admin" || active === "spaces" || active === "runs" ? ` aria-current="page"` : ""} href="/admin">Admin</a>` : "";
  return `<div class="ow-sidebar-tools">
    <label class="ow-sr-only" for="openwiki-sidebar-filter">Filter pages</label>
    <input id="openwiki-sidebar-filter" type="search" placeholder="Filter pages" data-openwiki-sidebar-filter autocomplete="off">
  </div>
  <div data-openwiki-lazy-sidebar data-openwiki-sidebar-groups-src="/api/v1/records?type=page&amp;group_by=page_type&amp;limit=1" data-openwiki-sidebar-records-src="/api/v1/records?type=page&amp;limit=40">
    <p class="ow-muted">Loading page sections...</p>
    <noscript><p class="ow-muted">Enable JavaScript to load the paged server navigation. Search remains available above.</p></noscript>
  </div>
  <div class="ow-sidebar-links">
    <a${active === "home" ? ` aria-current="page"` : ""} href="/">Home</a>
    <a${active === "pages" ? ` aria-current="page"` : ""} href="/#pages">Pages</a>
    <a${active === "inbox" ? ` aria-current="page"` : ""} href="/inbox">Inbox</a>
    <a${active === "proposals" ? ` aria-current="page"` : ""} href="/proposals">Proposals</a>
    ${graphLink}
    ${adminLink}
  </div>`;
}

function serverNavItems(active: ServerActive, policy: HttpPolicyOptions): ShellNavItem[] {
  return [
    { label: "Home", href: "/", active: active === "home" },
    { label: "Pages", href: "/#pages", active: active === "pages" },
    { label: "Inbox", href: "/inbox", active: active === "inbox" },
    { label: "Proposals", href: "/proposals", active: active === "proposals" },
    ...(canSeeGraphSurface(policy) ? [{ label: "Graph", href: "/graph", active: active === "graph" }] : []),
    ...(canSeeAdminSurface(policy) ? [{ label: "Admin", href: "/admin", active: active === "admin" || active === "spaces" || active === "runs" }] : []),
  ];
}

function canSeeGraphSurface(policy: HttpPolicyOptions): boolean {
  const context = httpPolicyContext(policy);
  return context.scopes.includes("wiki:read") || context.scopes.includes("wiki:admin");
}

export function dashboardPaletteSuggestions(pages: PageRecord[], topics: TopicSummary[]): PaletteSuggestion[] {
  const pageSuggestions = pages
    .slice()
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at) || left.title.localeCompare(right.title))
    .slice(0, 6)
    .map((page) => ({
      title: page.title,
      href: `/pages/${encodeURIComponent(page.id)}`,
      type: "recent page",
      summary: page.summary ?? page.id,
    }));
  const topicSuggestions = topics.slice(0, 6).map((topic) => ({
    title: topic.topic,
    href: `/graph?focus=${encodeURIComponent(`topic:${slugify(topic.topic)}`)}&types=${encodeURIComponent("page,topic")}`,
    type: "top topic",
    summary: `${topic.page_count} ${topic.page_count === 1 ? "page" : "pages"}`,
  }));
  return [...pageSuggestions, ...topicSuggestions];
}

export function metricCard(label: string, value: number): string {
  return `<div class="ow-metric"><strong>${value}</strong><span>${escapeHtml(label)}</span></div>`;
}

export function renderPageList(pages: PageRecord[]): string {
  if (pages.length === 0) {
    return `<p class="ow-muted">No pages yet.</p>`;
  }
  return `<ul class="ow-record-list">${pages
    .map(
      (page) =>
        `<li><div class="ow-record-list__title">${statusBadge(page.status)} <a href="/pages/${encodeURIComponent(page.id)}">${escapeHtml(page.title)}</a></div><p>${escapeHtml(page.summary ?? page.id)}</p></li>`,
    )
    .join("")}</ul>`;
}

export function renderProposalList(proposals: ProposalRecord[]): string {
  if (proposals.length === 0) {
    return `<p class="ow-muted">No proposals match this view.</p>`;
  }
  return `<ul class="ow-record-list">${proposals
    .map(
      (proposal) =>
        `<li>
          <div class="ow-record-list__title">${statusBadge(proposal.status)} <a href="/proposals/${encodeURIComponent(proposal.id)}">${escapeHtml(
          proposal.title,
        )}</a></div>
          <p>${escapeHtml(proposal.rationale ?? proposal.id)}</p>
          <small>${escapeHtml(proposal.target_path ?? proposal.target_ids.join(", "))} / ${escapeHtml(proposal.actor_id)} / validation ${proposal.validation_report_path ? "captured" : "not captured"} / ${escapeHtml(proposalNextStep(proposal))}</small>
        </li>`,
    )
    .join("")}</ul>`;
}

export function renderInboxItemList(items: InboxItemRecord[]): string {
  if (items.length === 0) {
    return `<p class="ow-muted">No inbox items match this view.</p>`;
  }
  return `<ul class="ow-record-list">${items
    .map(
      (item) =>
        `<li>
          <div class="ow-record-list__title">${statusBadge(item.status)} <a href="/inbox/${encodeURIComponent(item.id)}">${escapeHtml(item.title)}</a></div>
          <p>${escapeHtml(item.provider)} / ${escapeHtml(item.inbox_kind)} / ${escapeHtml(item.owner_actor_id ?? "shared")}</p>
          <small>${escapeHtml(item.updated_at)}${item.payload?.path === undefined ? "" : ` / ${escapeHtml(item.payload.path)}`}</small>
        </li>`,
    )
    .join("")}</ul>`;
}

function proposalNextStep(proposal: ProposalRecord): string {
  if (proposal.status === "open") return "needs review";
  if (proposal.status === "accepted") return "ready to apply or close";
  if (proposal.status === "rejected") return "can be closed";
  if (proposal.status === "applied") return proposal.applied_commit ? `applied at ${proposal.applied_commit}` : "applied";
  if (proposal.status === "closed") return proposal.close_resolution ? `closed: ${proposal.close_resolution}` : "closed";
  return proposal.status;
}

export function renderRunList(runs: RunRecord[]): string {
  if (runs.length === 0) {
    return `<p class="ow-muted">No runs match this view.</p>`;
  }
  return `<ul class="ow-record-list">${runs
    .map(
      (run) =>
        `<li><div class="ow-record-list__title">${statusBadge(run.status)} <a href="/runs/${encodeURIComponent(run.id)}"><code>${escapeHtml(run.id)}</code></a></div><p>${escapeHtml(
          run.run_type,
        )} / ${escapeHtml(run.actor_id)} / ${escapeHtml(run.created_at)}${run.error ? ` / ${escapeHtml(run.error)}` : ""}</p></li>`,
    )
    .join("")}</ul>`;
}

export function renderDashboardRecentChanges(changes: RecentChangesResponse): string {
  if (!changes.is_git_repo) {
    return `<p class="ow-muted">This workspace is not backed by a Git repository yet.</p>`;
  }
  if (changes.changes.length === 0) {
    return `<p class="ow-muted">No recent Git changes found.</p>`;
  }
  return `<ul class="ow-record-list">${changes.changes.slice(0, 6)
    .map(
      (change) =>
        `<li><div class="ow-record-list__title"><code>${escapeHtml(change.short_sha)}</code> ${escapeHtml(change.subject)}</div><p>${escapeHtml(
          change.author_name,
        )} / ${escapeHtml(change.date)}</p><small>${renderDashboardRecentChangeFiles(change.files)}</small></li>`,
    )
    .join("")}</ul>`;
}

function renderDashboardRecentChangeFiles(files: Array<{ status: string; path: string }>): string {
  const visible = files.slice(0, 4).map((file) => {
    const label = `${file.status} ${file.path}`;
    const href = serverHrefForRecentChangePath(file.path);
    return href === undefined ? escapeHtml(label) : `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
  });
  const remaining = files.length - visible.length;
  if (remaining > 0) {
    visible.push(`${remaining} more ${remaining === 1 ? "file" : "files"}`);
  }
  return visible.join(" · ");
}

function serverHrefForRecentChangePath(filePath: string): string | undefined {
  if (!filePath.startsWith("wiki/") || !filePath.endsWith(".md")) {
    return undefined;
  }
  return `/${filePath.slice("wiki/".length, filePath.length - ".md".length)}`;
}

export function renderEventList(events: EventRecord[]): string {
  if (events.length === 0) {
    return `<p class="ow-muted">No events found for this run.</p>`;
  }
  return `<ul class="ow-record-list">${events
    .map(
      (event) =>
        `<li><div class="ow-record-list__title">${escapeHtml(event.type)}</div><p>${escapeHtml(event.actor_id ?? "unknown")} / ${escapeHtml(
          event.occurred_at,
        )} / ${escapeHtml(event.operation ?? "no operation")}</p></li>`,
    )
    .join("")}</ul>`;
}

export function renderRunJob(job: NonNullable<RunDetailResponse["job"]>): string {
  return `
    <dl class="ow-meta-list">
      <dt>Status</dt><dd>${statusBadge(job.status)}</dd>
      <dt>Attempts</dt><dd>${job.attempts} / ${job.max_attempts}</dd>
      <dt>Claimed By</dt><dd>${escapeHtml(job.claimed_by ?? "unclaimed")}</dd>
      <dt>Created</dt><dd>${escapeHtml(job.created_at)}</dd>
      ${job.claimed_at ? `<dt>Claimed</dt><dd>${escapeHtml(job.claimed_at)}</dd>` : ""}
      ${job.completed_at ? `<dt>Completed</dt><dd>${escapeHtml(job.completed_at)}</dd>` : ""}
    </dl>
  `;
}

export function renderRunAttempts(attempts: RunDetailResponse["attempts"]): string {
  if (attempts.length === 0) {
    return `<p class="ow-muted">No Postgres attempt history found.</p>`;
  }
  return `<ul class="ow-record-list">${attempts
    .map(
      (attempt) =>
        `<li><div class="ow-record-list__title">${statusBadge(attempt.status)} attempt ${attempt.attempt}</div><p>${escapeHtml(
          attempt.worker_id ?? "unclaimed",
        )} / ${escapeHtml(attempt.started_at)}${attempt.completed_at ? ` / ${escapeHtml(attempt.completed_at)}` : ""}${
          attempt.error ? ` / ${escapeHtml(attempt.error)}` : ""
        }</p></li>`,
    )
    .join("")}</ul>`;
}

export function renderQueueHealth(queue: NonNullable<RunMonitorResponse["queue"]>): string {
  return `
    <dl class="ow-meta-list">
      <dt>Backend</dt><dd>${escapeHtml(queue.backend)}</dd>
      <dt>Queued</dt><dd>${queue.runs.queued} runs / ${queue.jobs.queued} jobs</dd>
      <dt>Running</dt><dd>${queue.runs.running} runs / ${queue.jobs.running} jobs</dd>
      <dt>Succeeded</dt><dd>${queue.runs.succeeded} runs / ${queue.jobs.succeeded} jobs</dd>
      <dt>Failed</dt><dd>${queue.runs.failed} runs / ${queue.jobs.failed} jobs</dd>
      ${queue.next_queued_run_id ? `<dt>Next</dt><dd>${escapeHtml(queue.next_queued_run_id)}</dd>` : ""}
      ${queue.oldest_running_run_id ? `<dt>Oldest Running</dt><dd>${escapeHtml(queue.oldest_running_run_id)}${queue.oldest_running_at ? ` since ${escapeHtml(queue.oldest_running_at)}` : ""}</dd>` : ""}
      <dt>Stale Running</dt><dd>${queue.stale_running_jobs} jobs after ${queue.stale_running_after_ms} ms</dd>
      ${queue.latest_failed_run_id ? `<dt>Latest Failed</dt><dd>${escapeHtml(queue.latest_failed_run_id)}</dd>` : ""}
    </dl>
  `;
}

export function renderProposalComments(comments: ProposalCommentRecord[]): string {
  if (comments.length === 0) {
    return `<p class="ow-muted">No comments yet.</p>`;
  }
  return `<ul class="ow-record-list">${comments
    .map(
      (comment) =>
        `<li><div class="ow-record-list__title">${escapeHtml(comment.body)}</div><p>${escapeHtml(comment.actor_id)} / ${escapeHtml(
          comment.created_at,
        )}</p></li>`,
    )
    .join("")}</ul>`;
}

export function renderSearchResults(results: Array<{ id: string; type: string; title: string; summary?: string }>): string {
  return `<ul class="ow-record-list">${results
    .map((result) => {
      const href = webHrefForRecord(result.type, result.id) ?? `/api/v1/search?q=${encodeURIComponent(result.id)}`;
      return `<li><div class="ow-record-list__title">${statusBadge(result.type)} <a href="${href}">${escapeHtml(result.title)}</a></div><p>${escapeHtml(result.type)} / ${escapeHtml(
        result.summary ?? result.id,
      )}</p></li>`;
    })
    .join("")}</ul>`;
}

export function renderOpenQuestions(questions: Array<{ question: string; page_id: string; page_title: string }>): string {
  if (questions.length === 0) {
    return `<p class="ow-muted">No open questions found.</p>`;
  }
  return `<ul class="ow-record-list">${questions
    .map(
      (question) =>
        `<li><div class="ow-record-list__title"><a href="/pages/${encodeURIComponent(question.page_id)}">${escapeHtml(question.question)}</a></div><p>${escapeHtml(
          question.page_title,
        )}</p></li>`,
    )
    .join("")}</ul>`;
}

export function renderPageQuestions(questions: Array<{ question: string }>): string {
  if (questions.length === 0) {
    return `<p class="ow-muted">No open questions found.</p>`;
  }
  return `<ul class="ow-record-list">${questions.map((question) => `<li>${escapeHtml(question.question)}</li>`).join("")}</ul>`;
}

export function renderSourceList(sources: SourceRecord[]): string {
  return `<ul class="ow-record-list">${sources
    .map((source) => `<li>
      <div class="ow-record-list__title">${statusBadge("source")} <a href="/sources/${encodeURIComponent(source.id)}">${escapeHtml(source.title)}</a></div>
      <p>${escapeHtml(source.source_type)}${source.retrieved_at ? ` / ${escapeHtml(source.retrieved_at)}` : ""}</p>
      <details class="ow-preview-details">
        <summary>Preview source</summary>
        <dl class="ow-meta-list">
          <dt>ID</dt><dd><code>${escapeHtml(source.id)}</code></dd>
          ${source.url ? `<dt>URL</dt><dd>${renderExternalLink(source.url)}</dd>` : ""}
          ${source.content_hash ? `<dt>Hash</dt><dd><code>${escapeHtml(source.content_hash)}</code></dd>` : ""}
        </dl>
      </details>
    </li>`)
    .join("")}</ul>`;
}

export function renderClaimList(claims: ClaimRecord[]): string {
  return `<ul class="ow-record-list">${claims
    .map(
      (claim) =>
        `<li>
          <div class="ow-record-list__title">${statusBadge("claim")} <a href="/claims/${encodeURIComponent(claim.id)}">${escapeHtml(claim.text)}</a></div>
          <p>${escapeHtml(claim.confidence)} confidence / ${escapeHtml(claim.risk)} risk</p>
          <details class="ow-preview-details">
            <summary>Trace claim</summary>
            <dl class="ow-meta-list">
              <dt>Page</dt><dd><code>${escapeHtml(claim.page_id)}</code></dd>
              <dt>Sources</dt><dd>${claim.source_ids.map((sourceId) => `<a href="/sources/${encodeURIComponent(sourceId)}">${escapeHtml(sourceId)}</a>`).join(", ") || "None"}</dd>
              ${claim.last_verified_at ? `<dt>Verified</dt><dd>${escapeHtml(claim.last_verified_at)}</dd>` : ""}
            </dl>
          </details>
        </li>`,
    )
    .join("")}</ul>`;
}

export function renderDecisionList(decisions: DecisionRecord[]): string {
  return `<ul class="ow-record-list">${decisions
    .map(
      (decision) =>
        `<li><div class="ow-record-list__title">${statusBadge("decision")} <a href="/decisions/${encodeURIComponent(decision.id)}">${escapeHtml(decision.decision)}</a></div><p>${escapeHtml(
          decision.rationale,
        )} / ${escapeHtml(decision.actor_id)} / ${escapeHtml(decision.decided_at)}</p></li>`,
    )
    .join("")}</ul>`;
}

export function renderCommitList(commits: GitCommitEntry[], isGitRepo: boolean): string {
  if (!isGitRepo) {
    return `<p class="ow-muted">No Git repository found.</p>`;
  }
  if (commits.length === 0) {
    return `<p class="ow-muted">No commits found.</p>`;
  }
  return `<ul class="ow-record-list">${commits
    .map(
      (commit) =>
        `<li><div class="ow-record-list__title"><code>${escapeHtml(commit.short_sha)}</code></div><p>${escapeHtml(commit.subject)} / ${escapeHtml(commit.date)}</p></li>`,
    )
    .join("")}</ul>`;
}

export function renderServerPageNavigation(page: PageRecord, pages: PageRecord[]): string {
  const adjacent = adjacentServerPages(page, pages);
  return renderPanel("Continue Reading", `<nav class="ow-page-nav" aria-label="Page navigation">
      ${adjacent.previous ? pageNavigationLink("Previous", adjacent.previous.title, `/pages/${encodeURIComponent(adjacent.previous.id)}`) : pageNavigationPlaceholder("Previous")}
      ${pageNavigationLink("Open In Graph", "Focus this page", `/graph?focus=${encodeURIComponent(page.id)}`)}
      ${adjacent.next ? pageNavigationLink("Next", adjacent.next.title, `/pages/${encodeURIComponent(adjacent.next.id)}`) : pageNavigationPlaceholder("Next")}
    </nav>`);
}

function adjacentServerPages(page: PageRecord, pages: PageRecord[]): { previous?: PageRecord; next?: PageRecord } {
  const siblings = pages
    .slice()
    .sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
  const index = siblings.findIndex((candidate) => candidate.id === page.id);
  return {
    ...(index > 0 && siblings[index - 1] ? { previous: siblings[index - 1] } : {}),
    ...(index >= 0 && siblings[index + 1] ? { next: siblings[index + 1] } : {}),
  };
}

export function pageNavigationLink(label: string, title: string, href: string): string {
  return `<a class="ow-page-nav__item" href="${escapeHtml(href)}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(title)}</strong></a>`;
}

export function pageNavigationPlaceholder(label: string): string {
  return `<span class="ow-page-nav__item is-disabled"><span>${escapeHtml(label)}</span><strong>None</strong></span>`;
}

export async function renderLocalGraphPanel(root: string, policy: HttpPolicyOptions, recordId: string): Promise<string> {
  const neighbors = await filterGraphNeighborhoodByPolicy(
    root,
    policy,
    (await graphCurrentPostgresNeighbors(root, recordId, { direction: "both", depth: 1, limit: 16 })) ??
      (await graphCurrentIndexStoreNeighbors(root, recordId, { direction: "both", depth: 1, limit: 16 })) ??
      (await graphNeighbors(root, recordId, { direction: "both", depth: 1, limit: 16 })),
  );
  const related = await filterGraphNeighborhoodByPolicy(
    root,
    policy,
    (await graphCurrentPostgresRelated(root, recordId, { limit: 16 })) ??
      (await graphCurrentIndexStoreRelated(root, recordId, { limit: 16 })) ??
      (await graphRelated(root, recordId, { limit: 16 })),
  );
  return renderGraphPanel(recordId, neighbors, related);
}
