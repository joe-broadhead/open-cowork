import type { HttpPolicyOptions } from "../types.ts";
import { getHistory } from "@openwiki/git";
import { canReadClaimRecord, canReadRecordId } from "@openwiki/policy";
import { loadRepository, readDecision, readPage, readSource, readSourceContent, traceClaim } from "@openwiki/repo";
import { escapeHtml, renderArticleMeta, renderBreadcrumb, renderFormActions, renderRecordActions, renderTextarea, renderTextInput, renderMarkdown as renderWebMarkdown } from "@openwiki/web";
import { httpPolicyContext } from "../auth.ts";
import { filterClaimTraceByPolicy } from "../data-access.ts";
import { renderExternalLink, renderJsonPanel, renderSourceContentPanel } from "./graph.ts";
import { htmlLayout, renderClaimList, renderCommitList, renderDecisionList, renderLocalGraphPanel, renderPageList, renderProposalList, renderSourceList } from "./layout.ts";

export async function renderSourceView(root: string, id: string, policy: HttpPolicyOptions): Promise<string> {
  const repo = await loadRepository(root);
  const source = await readSource(root, id);
  const sourceContent = await readSourceContent(root, id, { maxBytes: 32 * 1024 });
  const context = httpPolicyContext(policy);
  const pages = repo.pages.filter((page) => page.source_ids.includes(source.id) && canReadRecordId(repo, context, page.id));
  const claims = repo.claims.filter((claim) => claim.source_ids.includes(source.id) && canReadClaimRecord(repo, context, claim));
  const history = await getHistory(root, source.id, 5);
  const graphPanel = await renderLocalGraphPanel(root, policy, source.id);

  return htmlLayout(
    source.title,
    "pages",
    `
    <section class="ow-toolbar">
      <a class="button secondary" href="/">Back</a>
      <a class="button secondary" href="/api/v1/sources/${encodeURIComponent(source.id)}">Source JSON</a>
      <a class="button secondary" href="/api/v1/sources/${encodeURIComponent(source.id)}/content">Content JSON</a>
      <a class="button secondary" href="/api/v1/sources/${encodeURIComponent(source.id)}/history">History JSON</a>
      <a class="button secondary" href="/sources/${encodeURIComponent(source.id)}/diff">Diff</a>
    </section>
    <section class="ow-record-layout">
      <article class="ow-panel ow-record-main">
        <header class="ow-article-header">
          ${renderBreadcrumb([
            { label: "Home", href: "/" },
            { label: "Sources" },
            { label: source.title },
          ])}
          <p class="ow-eyebrow">${escapeHtml(source.source_type)} / ${escapeHtml(source.id)}</p>
          <h1>${escapeHtml(source.title)}</h1>
          ${renderArticleMeta([
            { label: "Type", value: source.source_type, kind: "badge", variant: "source" },
            { label: "Retrieved", value: source.retrieved_at },
            { label: "Hash", value: source.content_hash ?? "" },
            { label: "Data", value: "JSON", href: `/sources/${encodeURIComponent(source.id)}.json`, kind: "link" },
            { label: "Content", value: "JSON", href: `/api/v1/sources/${encodeURIComponent(source.id)}/content`, kind: "link" },
          ])}
          ${renderRecordActions([
            { label: "Cite", cite: `${source.title} — ${source.uri}` },
            { label: "History", href: `/api/v1/sources/${encodeURIComponent(source.id)}/history` },
            { label: "JSON", href: `/sources/${encodeURIComponent(source.id)}.json` },
            { label: "Content", href: `/api/v1/sources/${encodeURIComponent(source.id)}/content` },
            { label: "Open in graph", href: `/graph?focus=${encodeURIComponent(source.id)}` },
          ])}
        </header>
        <dl class="ow-meta-list">
          <dt>URI</dt><dd>${escapeHtml(source.uri)}</dd>
          <dt>Retrieved</dt><dd>${escapeHtml(source.retrieved_at)}</dd>
          <dt>Path</dt><dd>${escapeHtml(source.path)}</dd>
          ${source.content_hash ? `<dt>Hash</dt><dd>${escapeHtml(source.content_hash)}</dd>` : ""}
          ${source.url ? `<dt>URL</dt><dd>${renderExternalLink(source.url)}</dd>` : ""}
        </dl>
      </article>
      <aside class="ow-panel ow-record-side">
        <h2>Pages</h2>
        ${pages.length === 0 ? `<p class="ow-muted">No pages cite this source.</p>` : renderPageList(pages)}
        <h2>Claims</h2>
        ${claims.length === 0 ? `<p class="ow-muted">No claims cite this source.</p>` : renderClaimList(claims)}
        <h2>History</h2>
        ${renderCommitList(history.commits, history.is_git_repo)}
        <h2>Graph</h2>
        ${graphPanel}
      </aside>
    </section>
    ${renderSourceContentPanel(sourceContent)}
    ${renderJsonPanel("Trust", source.trust)}
    ${renderJsonPanel("Storage", source.storage)}
  `,
    { policy },
  );
}

export async function renderClaimView(root: string, id: string, policy: HttpPolicyOptions): Promise<string> {
  const trace = await filterClaimTraceByPolicy(root, policy, await traceClaim(root, id));
  const claim = trace.claim;
  const page = trace.page;
  const sources = trace.sources;
  const history = await getHistory(root, claim.id, 5);
  const graphPanel = await renderLocalGraphPanel(root, policy, claim.id);

  return htmlLayout(
    claim.text,
    "pages",
    `
    <section class="ow-toolbar">
      <a class="button secondary" href="/">Back</a>
      <a class="button secondary" href="/api/v1/claims/${encodeURIComponent(claim.id)}">Claim JSON</a>
      <a class="button secondary" href="/api/v1/claims/${encodeURIComponent(claim.id)}/trace">Trace JSON</a>
      <a class="button secondary" href="/api/v1/claims/${encodeURIComponent(claim.id)}/history">History JSON</a>
      <a class="button secondary" href="/claims/${encodeURIComponent(claim.id)}/diff">Diff</a>
    </section>
    <section class="ow-record-layout">
      <article class="ow-panel ow-record-main">
        <header class="ow-article-header">
          ${renderBreadcrumb([
            { label: "Home", href: "/" },
            { label: "Claims" },
            { label: "Claim" },
          ])}
          <p class="ow-eyebrow">${escapeHtml(claim.status)} / ${escapeHtml(claim.id)}</p>
          <h1>${escapeHtml(claim.text)}</h1>
          ${renderArticleMeta([
            { label: "Status", value: claim.status, kind: "badge", variant: "claim" },
            { label: "Confidence", value: claim.confidence },
            { label: "Risk", value: claim.risk },
            { label: "Verified", value: claim.last_verified_at ?? "" },
            { label: "Data", value: "JSON", href: `/claims/${encodeURIComponent(claim.id)}.json`, kind: "link" },
            { label: "Trace", value: "JSON", href: `/api/v1/claims/${encodeURIComponent(claim.id)}/trace`, kind: "link" },
          ])}
          ${renderRecordActions([
            { label: "Cite", cite: `${claim.text} — ${claim.uri}` },
            { label: "Trace", href: `/api/v1/claims/${encodeURIComponent(claim.id)}/trace` },
            { label: "History", href: `/api/v1/claims/${encodeURIComponent(claim.id)}/history` },
            { label: "JSON", href: `/claims/${encodeURIComponent(claim.id)}.json` },
            { label: "Open in graph", href: `/graph?focus=${encodeURIComponent(claim.id)}` },
          ])}
        </header>
        <dl class="ow-meta-list">
          <dt>Page</dt><dd>${page ? `<a href="/pages/${encodeURIComponent(page.id)}">${escapeHtml(page.title)}</a>` : escapeHtml(claim.page_id)}</dd>
          <dt>Confidence</dt><dd>${escapeHtml(claim.confidence)}</dd>
          <dt>Risk</dt><dd>${escapeHtml(claim.risk)}</dd>
          ${claim.last_verified_at ? `<dt>Verified</dt><dd>${escapeHtml(claim.last_verified_at)}</dd>` : ""}
          <dt>Evidence</dt><dd>${trace.evidence_summary.source_count} sources / ${trace.evidence_summary.accepted_decision_count} accepted decisions</dd>
        </dl>
      </article>
      <aside class="ow-panel ow-record-side">
        <h2>Sources</h2>
        ${sources.length === 0 ? `<p class="ow-muted">No linked sources.</p>` : renderSourceList(sources)}
        <h2>Proposals</h2>
        ${trace.proposals.length === 0 ? `<p class="ow-muted">No linked proposals.</p>` : renderProposalList(trace.proposals)}
        <h2>Decisions</h2>
        ${trace.decisions.length === 0 ? `<p class="ow-muted">No linked decisions.</p>` : renderDecisionList(trace.decisions)}
        <h2>History</h2>
        ${renderCommitList(history.commits, history.is_git_repo)}
        <h2>Graph</h2>
        ${graphPanel}
      </aside>
    </section>
  `,
    { policy },
  );
}

export async function renderDecisionView(root: string, id: string, policy: HttpPolicyOptions): Promise<string> {
  const repo = await loadRepository(root);
  const decision = await readDecision(root, id);
  const proposal = repo.proposals.find((candidate) => candidate.id === decision.proposal_id);
  const history = await getHistory(root, decision.id, 5);
  const graphPanel = await renderLocalGraphPanel(root, policy, decision.id);

  return htmlLayout(
    `${decision.decision}: ${decision.proposal_id}`,
    "proposals",
    `
    <section class="ow-toolbar">
      <a class="button secondary" href="/proposals">Queue</a>
      <a class="button secondary" href="/api/v1/decisions/${encodeURIComponent(decision.id)}">Decision JSON</a>
      <a class="button secondary" href="/api/v1/decisions/${encodeURIComponent(decision.id)}/history">History JSON</a>
      <a class="button secondary" href="/decisions/${encodeURIComponent(decision.id)}/diff">Diff</a>
    </section>
    <section class="ow-record-layout">
      <article class="ow-panel ow-record-main">
        <header class="ow-article-header">
          ${renderBreadcrumb([
            { label: "Proposals", href: "/proposals" },
            ...(proposal === undefined ? [] : [{ label: proposal.title, href: `/proposals/${encodeURIComponent(proposal.id)}` }]),
            { label: decision.decision },
          ])}
          <p class="ow-eyebrow">${escapeHtml(decision.id)}</p>
          <h1>${escapeHtml(decision.decision)}</h1>
          ${renderArticleMeta([
            { label: "Decision", value: decision.decision, kind: "badge", variant: "decision" },
            { label: "Actor", value: decision.actor_id },
            { label: "Decided", value: decision.decided_at },
            { label: "Commit", value: decision.commit ?? "" },
            { label: "Data", value: "JSON", href: `/decisions/${encodeURIComponent(decision.id)}.json`, kind: "link" },
          ])}
          ${renderRecordActions([
            { label: "Cite", cite: `${decision.decision} — ${decision.uri}` },
            { label: "History", href: `/api/v1/decisions/${encodeURIComponent(decision.id)}/history` },
            { label: "JSON", href: `/decisions/${encodeURIComponent(decision.id)}.json` },
            { label: "Open in graph", href: `/graph?focus=${encodeURIComponent(decision.id)}` },
          ])}
        </header>
        <dl class="ow-meta-list">
          <dt>Proposal</dt><dd>${proposal ? `<a href="/proposals/${encodeURIComponent(proposal.id)}">${escapeHtml(proposal.title)}</a>` : escapeHtml(decision.proposal_id)}</dd>
          <dt>Actor</dt><dd>${escapeHtml(decision.actor_id)}</dd>
          <dt>Decided</dt><dd>${escapeHtml(decision.decided_at)}</dd>
          <dt>Path</dt><dd>${escapeHtml(decision.path)}</dd>
          ${decision.commit ? `<dt>Commit</dt><dd>${escapeHtml(decision.commit)}</dd>` : ""}
        </dl>
        <h2>Rationale</h2>
        <p>${escapeHtml(decision.rationale)}</p>
      </article>
      <aside class="ow-panel ow-record-side">
        <h2>History</h2>
        ${renderCommitList(history.commits, history.is_git_repo)}
        <h2>Graph</h2>
        ${graphPanel}
      </aside>
    </section>
  `,
    { policy },
  );
}

export async function renderPageEditForm(root: string, id: string, policy: HttpPolicyOptions): Promise<string> {
  const page = await readPage(root, id);
  return htmlLayout(
    `Suggest Edit: ${page.title}`,
    "pages",
    `
    <section class="ow-toolbar">
      <a class="button secondary" href="/pages/${encodeURIComponent(page.id)}">Back</a>
      <a class="button secondary" href="/api/v1/pages/${encodeURIComponent(page.id)}">Page JSON</a>
    </section>
    <section class="ow-grid">
      <article class="ow-panel">
        <h1>Suggest Edit</h1>
        <form class="ow-stacked-form" method="post" action="/pages/${encodeURIComponent(page.id)}/propose">
          ${renderTextInput("actor_id", "Actor ID", "actor:user:web")}
          ${renderTextInput("title", "Title", page.title)}
          ${renderTextInput("summary", "Summary", page.summary ?? "")}
          ${renderTextarea("body", "Body", page.body, { required: true, controlClassName: "markdown-editor", hint: "Markdown is rendered safely with links, tables, task lists, and wikilinks." })}
          ${renderTextarea("rationale", "Rationale", "", { required: true })}
          ${renderFormActions("Create Proposal")}
        </form>
      </article>
      <aside class="ow-panel ow-record-side ow-markdown-preview-panel">
        <h2>Preview</h2>
        <div class="ow-prose ow-markdown-live-preview" data-openwiki-markdown-preview>${renderWebMarkdown(page.body).html}</div>
      </aside>
    </section>
  `,
    { policy },
  );
}
