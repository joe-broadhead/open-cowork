import { numberQuery, proposalStatusesQuery } from "../request.ts";
import type { HttpPolicyOptions } from "../types.ts";
import type { InboxItemStatus, ProposalRecord } from "@openwiki/core";
import { loadRepository, readProposalDetail } from "@openwiki/repo";
import { readInboxWorkflow } from "@openwiki/workflows";
import { escapeHtml, renderArticleMeta, renderBreadcrumb, renderDiff, renderFormActions, renderPanel, renderRecordActions, renderSelect, renderTextarea, renderTextInput } from "@openwiki/web";
import { authorizeHttpInboxAction, listVisibleInboxItems, listVisibleProposals, runDetail, runMonitor } from "../data-access.ts";
import { authorizeHttp, authorizeHttpPath, authorizeHttpReview } from "../auth.ts";
import { renderJsonPanel, statusBadge } from "./graph.ts";
import { htmlLayout, metricCard, renderDecisionList, renderEventList, renderInboxItemList, renderLocalGraphPanel, renderProposalComments, renderProposalList, renderQueueHealth, renderRunAttempts, renderRunJob, renderRunList } from "./layout.ts";

export async function renderInboxPage(root: string, url: URL, policy: HttpPolicyOptions): Promise<string> {
  const status = inboxStatusFromUrl(url);
  const response = await listVisibleInboxItems(root, policy, {
    ...(status === undefined ? {} : { statuses: [status] }),
    limit: numberQuery(url, "limit") ?? 50,
  });
  const activeStatus = status ?? "all";
  return htmlLayout(
    "Inbox",
    "inbox",
    `
    <section class="ow-toolbar">
      <h1>Inbox</h1>
      <a class="button secondary" href="/api/v1/inbox/items${url.search}">Inbox JSON</a>
    </section>
    <nav class="ow-tabs" aria-label="Inbox status filters">
      ${["all", "received", "proposed", "ignored", "failed"]
        .map((entry) => {
          const href = entry === "all" ? "/inbox" : `/inbox?status=${entry}`;
          return `<a class="${activeStatus === entry ? "active" : ""}" href="${href}">${escapeHtml(entry)}</a>`;
        })
        .join("")}
    </nav>
    <section class="ow-panel">
      <div class="ow-panel__head"><h2>Incoming Knowledge</h2><span>${response.total} items</span></div>
      ${renderInboxItemList(response.items)}
    </section>
  `,
    { policy },
  );
}

export async function renderInboxView(root: string, id: string, policy: HttpPolicyOptions): Promise<string> {
  const detail = await readInboxWorkflow({ root, id, includeContent: true, maxBytes: 128 * 1024 });
  const item = detail.item;
  const actions = await renderInboxActionForms(root, item.id, item.status, policy);
  return htmlLayout(
    item.title,
    "inbox",
    `
    <section class="ow-toolbar">
      <a class="button secondary" href="/inbox">Inbox</a>
      <a class="button secondary" href="/api/v1/inbox/items/${encodeURIComponent(item.id)}?include_content=true">Item JSON</a>
    </section>
    <section class="ow-record-layout">
      <article class="ow-panel ow-record-main">
        <header class="ow-article-header">
          ${renderBreadcrumb([
            { label: "Inbox", href: "/inbox" },
            { label: item.title },
          ])}
          <p class="ow-eyebrow">${escapeHtml(item.id)}</p>
          <h1>${escapeHtml(item.title)}</h1>
          ${renderArticleMeta([
            { label: "Status", value: item.status, kind: "badge", variant: item.status },
            { label: "Provider", value: item.provider },
            { label: "Kind", value: item.inbox_kind },
            { label: "Owner", value: item.owner_actor_id ?? "" },
            { label: "Received", value: item.received_at },
          ])}
          ${renderRecordActions([
            { label: "JSON", href: `/api/v1/inbox/items/${encodeURIComponent(item.id)}?include_content=true` },
          ])}
        </header>
        ${detail.content === undefined ? `<p class="ow-muted">No readable payload is attached.</p>` : renderPanel("Payload", `<pre><code>${escapeHtml(detail.content.body)}</code></pre>`)}
      </article>
      <aside class="ow-panel ow-record-side">
        ${actions}
        <h2>Links</h2>
        <dl class="ow-meta-list">
          <dt>Sources</dt><dd>${escapeHtml((item.source_ids ?? []).join(", ") || "none")}</dd>
          <dt>Proposals</dt><dd>${escapeHtml((item.proposal_ids ?? []).join(", ") || "none")}</dd>
          <dt>Payload</dt><dd>${escapeHtml(item.payload?.path ?? "none")}</dd>
        </dl>
      </aside>
    </section>
  `,
    { policy },
  );
}

async function renderInboxActionForms(root: string, id: string, status: InboxItemStatus, policy: HttpPolicyOptions): Promise<string> {
  const forms: string[] = [];
  if (status === "received" && (await authorizeHttpInboxAction(root, "wiki.inbox_process", policy, id)) === undefined) {
    forms.push(`
      <form method="post" action="/inbox/${encodeURIComponent(id)}/process">
        <button type="submit">Process</button>
      </form>
    `);
  }
  if ((status === "received" || status === "failed") && (await authorizeHttpInboxAction(root, "wiki.inbox_ignore", policy, id)) === undefined) {
    forms.push(`
      <form method="post" action="/inbox/${encodeURIComponent(id)}/ignore">
        <label>Reason <input name="reason" value=""></label>
        <button type="submit">Ignore</button>
      </form>
    `);
  }
  if (status === "failed" && (await authorizeHttpInboxAction(root, "wiki.inbox_retry", policy, id)) === undefined) {
    forms.push(`
      <form method="post" action="/inbox/${encodeURIComponent(id)}/retry">
        <button type="submit">Retry</button>
      </form>
    `);
  }
  return forms.length === 0 ? "" : `<h2>Actions</h2>${forms.join("")}`;
}

export async function renderProposalQueuePage(root: string, url: URL, policy: HttpPolicyOptions): Promise<string> {
  const repo = await loadRepository(root);
  const statuses = proposalStatusesQuery(url);
  const limit = numberQuery(url, "limit") ?? 50;
  const actorId = url.searchParams.get("actor_id") ?? undefined;
  const targetId = url.searchParams.get("target_id") ?? undefined;
  const targetPath = url.searchParams.get("target_path") ?? undefined;
  const sectionId = url.searchParams.get("section_id") ?? undefined;
  const updatedAfter = url.searchParams.get("updated_after") ?? undefined;
  const proposals = await listVisibleProposals(root, policy, {
    ...(statuses === undefined ? {} : { statuses }),
    ...(actorId === undefined ? {} : { actorId }),
    ...(targetId === undefined ? {} : { targetId }),
    ...(targetPath === undefined ? {} : { targetPath }),
    ...(sectionId === undefined ? {} : { sectionId }),
    ...(updatedAfter === undefined ? {} : { updatedAfter }),
    limit,
  });
  const activeStatus = statuses?.[0] ?? "all";

  return htmlLayout(
    "Proposal Queue",
    "proposals",
    `
    <section class="ow-toolbar">
      <h1>Proposal Queue</h1>
      <a class="button secondary" href="/api/v1/proposals${activeStatus === "all" ? "" : `?status=${encodeURIComponent(activeStatus)}`}">Queue JSON</a>
    </section>
    <nav class="ow-tabs" aria-label="Proposal status filters">
      ${["all", "open", "accepted", "rejected", "applied", "closed"]
        .map((status) => {
          const href = status === "all" ? "/proposals" : `/proposals?status=${status}`;
          return `<a class="${activeStatus === status ? "active" : ""}" href="${href}">${escapeHtml(status)}</a>`;
        })
        .join("")}
    </nav>
    <section class="ow-panel">
      <div class="ow-panel__head"><h2>${escapeHtml(repo.config.title)}</h2><span>${proposals.total} proposals</span></div>
      ${renderProposalList(proposals.proposals)}
    </section>
  `,
    { policy },
  );
}

function inboxStatusFromUrl(url: URL): InboxItemStatus | undefined {
  const value = url.searchParams.get("status") ?? undefined;
  if (value === undefined || value === "all") {
    return undefined;
  }
  if (
    value === "received" ||
    value === "queued" ||
    value === "processing" ||
    value === "proposed" ||
    value === "applied" ||
    value === "ignored" ||
    value === "failed" ||
    value === "superseded"
  ) {
    return value;
  }
  throw new Error(`Invalid inbox status '${value}'`);
}

export async function renderRunsPage(root: string, url: URL, policy: HttpPolicyOptions): Promise<string> {
  const monitor = await runMonitor(root, url, policy);
  const activeStatuses = monitor.filters.statuses.length === 0 ? ["all"] : monitor.filters.statuses;
  const activeStatus = activeStatuses[0] ?? "all";

  return htmlLayout(
    "Run Monitor",
    "runs",
    `
    <section class="ow-toolbar">
      <h1>Run Monitor</h1>
      <a class="button secondary" href="/api/v1/runs/monitor${url.search}">Monitor JSON</a>
    </section>
    <section class="ow-metrics" aria-label="Run counts">
      ${metricCard("Total Runs", monitor.counts.total)}
      ${metricCard("Queued", monitor.counts.queued)}
      ${metricCard("Running", monitor.counts.running)}
      ${metricCard("Failed", monitor.counts.failed)}
    </section>
    <nav class="ow-tabs" aria-label="Run status filters">
      ${["all", "queued", "running", "succeeded", "failed"]
        .map((status) => {
          const href = status === "all" ? "/runs" : `/runs?status=${status}`;
          return `<a class="${activeStatus === status ? "active" : ""}" href="${href}">${escapeHtml(status)}</a>`;
        })
        .join("")}
    </nav>
    <section class="ow-grid">
      <div class="ow-panel">
        <div class="ow-panel__head"><h2>Recent Runs</h2><a href="/api/v1/runs${url.search}">JSON</a></div>
        ${renderRunList(monitor.recent)}
      </div>
      <aside class="ow-panel ow-record-side">
        <h2>Serving Layer</h2>
        <dl class="ow-meta-list">
          <dt>Source</dt><dd>${escapeHtml(monitor.source)}</dd>
          <dt>Workspace</dt><dd>${escapeHtml(monitor.workspace_id)}</dd>
          <dt>Generated</dt><dd>${escapeHtml(monitor.generated_at)}</dd>
        </dl>
        ${monitor.queue === undefined ? "" : `<h2>Postgres Queue</h2>${renderQueueHealth(monitor.queue)}`}
      </aside>
    </section>
  `,
    { policy },
  );
}

export async function renderRunView(root: string, id: string, policy: HttpPolicyOptions): Promise<string> {
  const detail = await runDetail(root, id, policy);
  if (detail === undefined) {
    return htmlLayout(
      "Run Not Found",
      "runs",
      `
      <section class="ow-toolbar">
        <a class="button secondary" href="/runs">Runs</a>
      </section>
      <section class="ow-panel"><h1>Run Not Found</h1><p class="ow-muted">${escapeHtml(id)}</p></section>
    `,
      { policy },
    );
  }
  const run = detail.run;
  return htmlLayout(
    `${run.run_type}: ${run.id}`,
    "runs",
    `
    <section class="ow-toolbar">
      <a class="button secondary" href="/runs">Run Monitor</a>
      <a class="button secondary" href="/api/v1/runs/${encodeURIComponent(run.id)}">Run JSON</a>
      <a class="button secondary" href="/api/v1/events?record_id=${encodeURIComponent(run.id)}">Events JSON</a>
    </section>
    <section class="ow-record-layout">
      <article class="ow-panel ow-record-main">
        <header class="ow-article-header">
          ${renderBreadcrumb([
            { label: "Runs", href: "/runs" },
            { label: run.run_type },
          ])}
          <p class="ow-eyebrow">${escapeHtml(run.id)}</p>
          <h1>${escapeHtml(run.run_type)}</h1>
          ${renderArticleMeta([
            { label: "Status", value: run.status, kind: "badge", variant: run.status },
            { label: "Actor", value: run.actor_id },
            { label: "Created", value: run.created_at },
            { label: "Started", value: run.started_at ?? "" },
            { label: "Completed", value: run.completed_at ?? "" },
            { label: "Source", value: detail.source },
          ])}
          ${renderRecordActions([
            { label: "JSON", href: `/api/v1/runs/${encodeURIComponent(run.id)}` },
            { label: "Events", href: `/api/v1/events?record_id=${encodeURIComponent(run.id)}` },
          ])}
        </header>
        ${run.error ? renderPanel("Error", `<p>${escapeHtml(run.error)}</p>`) : ""}
      </article>
      <aside class="ow-panel ow-record-side">
        <h2>Events</h2>
        ${renderEventList(detail.events)}
        ${detail.job === undefined ? "" : `<h2>Job</h2>${renderRunJob(detail.job)}`}
        <h2>Attempts</h2>
        ${renderRunAttempts(detail.attempts)}
      </aside>
    </section>
    ${renderJsonPanel("Input", run.input)}
    ${renderJsonPanel("Output", run.output)}
  `,
    { policy },
  );
}

export async function renderProposalView(root: string, id: string, policy: HttpPolicyOptions): Promise<string> {
  const repo = await loadRepository(root);
  const detail = await readProposalDetail(root, id);
  const proposal = detail.proposal;
  const decisions = repo.decisions
    .filter((decision) => decision.proposal_id === proposal.id)
    .sort((left, right) => right.decided_at.localeCompare(left.decided_at) || right.id.localeCompare(left.id));
  const graphPanel = await renderLocalGraphPanel(root, policy, proposal.id);
  const actionPanel = await renderProposalActionPanel(root, proposal, policy);
  const commentPanel = await renderProposalCommentPanel(root, proposal, policy);
  return htmlLayout(
    proposal.title,
    "proposals",
    `
    <section class="ow-toolbar">
      <a class="button secondary" href="/proposals">Queue</a>
      <a class="button secondary" href="/proposals/${encodeURIComponent(proposal.id)}/diff">Diff</a>
      <a class="button secondary" href="/api/v1/proposals/${encodeURIComponent(proposal.id)}/detail">Detail JSON</a>
      <a class="button secondary" href="/api/v1/proposals/${encodeURIComponent(proposal.id)}/diff">Diff JSON</a>
    </section>
    <section class="ow-record-layout">
      <div class="ow-panel">
        <header class="ow-article-header">
          ${renderBreadcrumb([
            { label: "Proposals", href: "/proposals" },
            { label: proposal.title },
          ])}
          <p class="ow-eyebrow">${escapeHtml(proposal.id)}</p>
          <h1>${escapeHtml(proposal.title)}</h1>
          ${renderArticleMeta([
            { label: "Status", value: proposal.status, kind: "badge", variant: proposal.status },
            { label: "Actor", value: proposal.actor_id },
            { label: "Created", value: proposal.created_at },
            { label: "Target", value: proposal.target_path ?? proposal.target_ids.join(", ") },
            { label: "Data", value: "JSON", href: `/proposals/${encodeURIComponent(proposal.id)}.json`, kind: "link" },
            { label: "Diff", value: "JSON", href: `/api/v1/proposals/${encodeURIComponent(proposal.id)}/diff`, kind: "link" },
          ])}
          ${renderRecordActions([
            { label: "Cite", cite: `${proposal.title} — ${proposal.uri}` },
            { label: "Diff", href: `/proposals/${encodeURIComponent(proposal.id)}/diff` },
            { label: "JSON", href: `/proposals/${encodeURIComponent(proposal.id)}.json` },
            { label: "Open in graph", href: `/graph?focus=${encodeURIComponent(proposal.id)}` },
          ])}
        </header>
        <dl class="ow-meta-list">
          <dt>Status</dt><dd>${statusBadge(proposal.status)}</dd>
          <dt>Actor</dt><dd>${escapeHtml(proposal.actor_id)}</dd>
          <dt>Created</dt><dd>${escapeHtml(proposal.created_at)}</dd>
          ${proposal.closed_at ? `<dt>Closed</dt><dd>${escapeHtml(proposal.closed_at)}</dd>` : ""}
          ${proposal.close_resolution ? `<dt>Resolution</dt><dd>${escapeHtml(proposal.close_resolution)}</dd>` : ""}
          ${proposal.superseded_by ? `<dt>Superseded By</dt><dd><a href="/proposals/${encodeURIComponent(proposal.superseded_by)}">${escapeHtml(proposal.superseded_by)}</a></dd>` : ""}
          <dt>Target</dt><dd>${escapeHtml(proposal.target_path ?? proposal.target_ids.join(", "))}</dd>
        </dl>
        ${proposal.rationale ? `<h2>Rationale</h2><p>${escapeHtml(proposal.rationale)}</p>` : ""}
        ${proposal.close_rationale ? `<h2>Close Rationale</h2><p>${escapeHtml(proposal.close_rationale)}</p>` : ""}
        ${renderPolicyProposalImpact(proposal)}
        ${decisions.length === 0 ? "" : `<h2>Decisions</h2>${renderDecisionList(decisions)}`}
        <div class="ow-panel__head"><h2>Comments</h2><a href="/api/v1/proposals/${encodeURIComponent(proposal.id)}/comments">JSON</a></div>
        ${renderProposalComments(detail.comments)}
        <div class="ow-panel__head ow-section-head"><h2>Diff</h2><a href="/api/v1/proposals/${encodeURIComponent(proposal.id)}/diff">JSON</a></div>
        ${renderDiff(detail.diff?.body ?? "Diff artifact not found.")}
        <div class="ow-panel__head ow-section-head"><h2>Snapshot</h2><a href="/api/v1/proposals/${encodeURIComponent(proposal.id)}/snapshot">JSON</a></div>
        <pre>${escapeHtml(renderProposalSnapshots(detail))}</pre>
      </div>
      <div>
        ${actionPanel}
        ${commentPanel}
        <div class="ow-panel">
          <div class="ow-panel__head"><h2>Validation</h2><a href="/api/v1/proposals/${encodeURIComponent(proposal.id)}/validation">JSON</a></div>
          <pre>${escapeHtml(JSON.stringify(detail.validation_report ?? null, null, 2))}</pre>
        </div>
        <div class="ow-panel">
          <h2>Graph</h2>
          ${graphPanel}
        </div>
      </div>
    </section>
  `,
    { policy },
  );
}

function renderProposalSnapshots(detail: Awaited<ReturnType<typeof readProposalDetail>>): string {
  if (detail.snapshots !== undefined) {
    return Object.entries(detail.snapshots)
      .map(([key, artifact]) => `# ${key}: ${artifact.path}\n${artifact.body}`)
      .join("\n");
  }
  return detail.snapshot?.body ?? "Snapshot artifact not found.";
}

function renderPolicyProposalImpact(proposal: ProposalRecord): string {
  const targetsPolicy = (proposal.target_path ?? "").startsWith("policy") || proposal.target_ids.some((id) => id.startsWith("policy:"));
  if (!targetsPolicy) {
    return "";
  }
  const targets = proposal.target_ids.length > 0 ? proposal.target_ids : [proposal.target_path ?? "policy"];
  return `
    <section class="ow-callout">
      <h2>Policy Scope And Blast Radius</h2>
      <p class="ow-muted">This proposal changes permission policy. Review affected sections, grants, and approval rules before applying.</p>
      <dl class="ow-meta-list">
        <dt>Path</dt><dd>${escapeHtml(proposal.target_path ?? "policy")}</dd>
        <dt>Targets</dt><dd>${targets.map((target) => `<code>${escapeHtml(target)}</code>`).join(", ")}</dd>
        <dt>Apply Gate</dt><dd>Validation reruns before Git history is updated.</dd>
      </dl>
    </section>
  `;
}

async function renderProposalActionPanel(root: string, proposal: ProposalRecord, policy: HttpPolicyOptions): Promise<string> {
  if (proposal.status === "open") {
    const canReview = (await authorizeHttpReview(root, policy, proposal)) === undefined;
    if (!canReview) {
      return "";
    }
    return `
      <div class="ow-panel ow-action-panel">
        <p class="ow-eyebrow">Step 1</p>
        <h2>Review Decision</h2>
        <p class="ow-muted">Accepting makes this proposal eligible to apply. Rejecting or requesting changes keeps Git history unchanged.</p>
        <form class="ow-stacked-form" method="post" action="/proposals/${encodeURIComponent(proposal.id)}/review">
          ${renderSelect("decision", "Decision", [
            { value: "accepted", label: "Accept" },
            { value: "rejected", label: "Reject" },
            { value: "needs_changes", label: "Needs Changes" },
          ])}
          ${renderTextInput("actor_id", "Actor ID", "actor:user:web-reviewer")}
          ${renderTextarea("rationale", "Rationale", "", { required: true })}
          ${renderFormActions("Record Decision")}
        </form>
      </div>
      ${renderProposalClosePanel(proposal)}
    `;
  }
  if (proposal.status === "accepted") {
    const canApply = (await authorizeHttpPath(root, "wiki.apply_proposal", policy, proposal.target_path ?? proposal.path)) === undefined;
    const canClose = (await authorizeHttpReview(root, policy, proposal)) === undefined;
    return `
      ${canApply ? `<div class="ow-panel ow-action-panel">
        <p class="ow-eyebrow">Step 2</p>
        <h2>Apply To Git</h2>
        <p class="ow-muted">Applying reruns validation, writes the accepted artifacts, and records the resulting commit when Git is initialized.</p>
        <form class="ow-stacked-form" method="post" action="/proposals/${encodeURIComponent(proposal.id)}/apply">
          ${renderTextInput("actor_id", "Actor ID", "actor:user:web-maintainer")}
          ${renderFormActions("Apply Proposal")}
        </form>
      </div>` : ""}
      ${canClose ? renderProposalClosePanel(proposal) : ""}
    `;
  }
  if (proposal.status === "rejected") {
    return (await authorizeHttpReview(root, policy, proposal)) === undefined ? renderProposalClosePanel(proposal) : "";
  }
  return "";
}

async function renderProposalCommentPanel(root: string, proposal: ProposalRecord, policy: HttpPolicyOptions): Promise<string> {
  if (authorizeHttp("wiki.comment_on_proposal", policy) !== undefined) {
    return "";
  }
  if ((await authorizeHttpPath(root, "wiki.comment_on_proposal", policy, proposal.target_path ?? proposal.path)) !== undefined) {
    return "";
  }
  return `
    <div class="ow-panel">
      <h2>Comment</h2>
      <form class="ow-stacked-form" method="post" action="/proposals/${encodeURIComponent(proposal.id)}/comment">
        ${renderTextInput("actor_id", "Actor", "actor:user:web")}
        ${renderTextarea("body", "Comment", "", { rows: 5, required: true })}
        ${renderFormActions("Add Comment")}
      </form>
    </div>
  `;
}

function renderProposalClosePanel(proposal: ProposalRecord): string {
  if (proposal.status === "applied" || proposal.status === "closed") {
    return "";
  }
  return `
    <div class="ow-panel ow-action-panel">
      <p class="ow-eyebrow">Alternative</p>
      <h2>Close Without Applying</h2>
      ${proposal.status === "accepted" ? `<p class="ow-muted">Use this when an accepted proposal is superseded or should not be merged after review.</p>` : `<p class="ow-muted">Use this for duplicates, superseded proposals, or stale work that should remain auditable.</p>`}
      <form class="ow-stacked-form" method="post" action="/proposals/${encodeURIComponent(proposal.id)}/close">
        ${renderTextInput("actor_id", "Actor ID", "actor:user:web-reviewer")}
        ${renderTextInput("superseded_by", "Superseded By", "", { placeholder: "proposal:2026-05-25-003" })}
        ${renderTextarea("rationale", "Rationale", "", { required: true })}
        ${renderFormActions("Close Proposal")}
      </form>
    </div>
  `;
}
