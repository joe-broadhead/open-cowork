
import {
  humanLabel,
  type GraphAnalysisResponse,
  type ClaimRecord,
  type DecisionRecord,
  type FactRecord,
  type GraphIndexResponse,
  type GraphNodeRecord,
  type PageRecord,
  type ProposalCommentRecord,
  type ProposalRecord,
  type SourceRecord,
  type TakeRecord,
  type TopicSummary,
} from "@openwiki/core";
import type { RecentChangesResponse } from "@openwiki/git";
import {
  escapeHtml,
  graphTextFallback,
  pageRoute,
  recordRoute,
  relativeHref,
  renderArticleMeta,
  renderBadge,
  renderGraphMount,
  renderMarkdown,
  renderPanel,
  renderRecordList,
  renderShell,
  renderToc,
  safeExternalHref,
  type ShellNavItem,
  type WebAssetManifest,
} from "@openwiki/web";

import {
  graphTextFallbackForStatic,
  localGraphForRecord,
  renderDefinitionList,
  renderRecentChangeList,
  renderStaticBreadcrumb,
  renderStaticPageNavigation,
  renderStaticShell,
  renderTopicList,
  renderTopicSections,
  resolveMarkdownHref,
  staticBacklinkRecords,
  staticRelatedRecords,
  wikiResolver,
} from "./render-shell.ts";

export function renderIndexHtml(
  title: string,
  pages: PageRecord[],
  sources: SourceRecord[],
  claims: ClaimRecord[],
  facts: FactRecord[],
  takes: TakeRecord[],
  topics: TopicSummary[],
  recentChanges: RecentChangesResponse,
  graph: GraphIndexResponse,
  assets: WebAssetManifest,
): string {
  const main = `
    <section class="ow-hero ow-hero--search">
      <p class="ow-eyebrow">OpenWiki</p>
      <h1>${escapeHtml(title)}</h1>
      <p>Search and read the Git-backed knowledge base. Machine-readable exports remain available for agents and scripts.</p>
      <form class="ow-home-search-form" method="get" action="index.html" data-openwiki-palette-form>
        <input name="q" placeholder="Search pages, sources, claims, facts, takes, and topics" aria-label="Search">
        <button type="submit">Search</button>
      </form>
      <p class="ow-home-stats">${pages.length} pages · ${sources.length} sources · ${claims.length} claims · ${facts.length} facts · ${takes.length} takes · ${topics.length} topics</p>
    </section>
    <section class="ow-grid" id="pages">
      ${renderPanel("Pages", renderRecordList(pages.map((page) => ({
        title: page.title,
        href: `${pageRoute(page.id)}.html`,
        summary: page.summary ?? page.id,
        type: page.page_type,
        status: page.status,
      }))))}
      ${renderPanel("Most Connected", graphTextFallback(graph, 10))}
    </section>
    <section class="ow-grid">
      ${renderPanel("Topics", renderTopicList(topics, "index.html"))}
      ${renderPanel("Recent Changes", renderRecentChangeList(recentChanges, "index.html"))}
    </section>
    <section class="ow-panel ow-panel--graph-preview">
      <div class="ow-panel__head">
        <div><p class="ow-eyebrow">Graph</p><h2>Knowledge Map</h2></div>
        <div class="ow-actions"><a class="button secondary" href="graph.html">Open graph</a><a class="button secondary" href="graph-report.html">Graph report</a></div>
      </div>
      ${renderGraphMount({
        src: "graph.json",
        mode: "preview",
        maxNodes: 180,
        height: "320px",
        title: "Knowledge Map",
        fallback: graphTextFallback(graph, 12),
      })}
    </section>
  `;
  return renderStaticShell({ title, workspaceTitle: title, active: "home", file: "index.html", assets, pages, main });
}

export function renderPageHtml(
  workspaceTitle: string,
  page: PageRecord,
  pages: PageRecord[],
  sources: SourceRecord[],
  claims: ClaimRecord[],
  graph: GraphIndexResponse,
  assets: WebAssetManifest,
): string {
  const file = `${pageRoute(page.id)}.html`;
  const linkedSources = sources.filter((source) => page.source_ids.includes(source.id));
  const linkedClaims = claims.filter((claim) => page.claim_ids.includes(claim.id));
  const markdown = renderMarkdown(page.body, {
    resolveWikiLink: wikiResolver(pages, file),
    resolveLink: (href) => resolveMarkdownHref(href, file, pages),
  });
  const backlinks = staticBacklinkRecords(graph, page.id, file);
  const related = staticRelatedRecords(graph, page.id, file);
  const rightRail = [
    renderPanel("Outline", renderToc(markdown.toc)),
    renderPanel("Backlinks", renderRecordList(backlinks, "No backlinks yet.")),
    renderPanel("Related", renderRecordList(related, "No related graph nodes.")),
    renderPanel("Sources", renderRecordList(linkedSources.map((source) => ({
      title: source.title,
      href: relativeHref(file, `${recordRoute(source.id)}.html`),
      type: "source",
      summary: source.source_type,
    })), "No linked sources.")),
    renderPanel("Claims", renderRecordList(linkedClaims.map((claim) => ({
      title: claim.text,
      href: relativeHref(file, `${recordRoute(claim.id)}.html`),
      type: "claim",
      summary: `${claim.confidence} confidence / ${claim.risk} risk`,
    })), "No linked claims.")),
    renderPanel("Machine Readable", `<div class="ow-chip-list">
      <a class="ow-chip" href="${relativeHref(file, `${pageRoute(page.id)}.md`)}">Markdown</a>
      <a class="ow-chip" href="${relativeHref(file, `${pageRoute(page.id)}.json`)}">JSON</a>
      <a class="ow-chip" href="${relativeHref(file, "llms.txt")}">llms.txt</a>
    </div>`),
  ].join("");
  const localGraph = localGraphForRecord(graph, page.id);
  const main = `
    <article>
      <header class="ow-article-header">
        ${renderStaticBreadcrumb(file, [
          { label: "Home", href: "index.html" },
          { label: humanLabel(page.page_type), href: "index.html#pages" },
          { label: page.title },
        ])}
        <p class="ow-eyebrow">${escapeHtml(page.page_type)} ${renderBadge(page.status, page.status)}</p>
        <h1>${escapeHtml(page.title)}</h1>
        ${page.summary ? `<p class="ow-article-lede">${escapeHtml(page.summary)}</p>` : ""}
        ${renderArticleMeta([
          { label: "Status", value: page.status, kind: "badge", variant: page.status },
          { label: "Type", value: humanLabel(page.page_type) },
          { label: "Updated", value: page.updated_at },
          { label: "Created", value: page.created_at },
          { label: "Source", value: "Markdown", href: relativeHref(file, `${pageRoute(page.id)}.md`), kind: "link" },
          { label: "Data", value: "JSON", href: relativeHref(file, `${pageRoute(page.id)}.json`), kind: "link" },
        ])}
      </header>
      ${markdown.html}
      ${renderStaticReferences(file, linkedSources, linkedClaims)}
      ${renderPanel("Local Graph", renderGraphMount({
        src: relativeHref(file, "graph.json"),
        mode: "local",
        focusId: page.id,
        height: "280px",
        fallback: graphTextFallbackForStatic(localGraph, file, 8),
      }))}
      ${renderStaticPageNavigation(page, pages, file)}
    </article>
  `;
  return renderStaticShell({ title: page.title, workspaceTitle, active: "pages", file, assets, pages, main, rightRail });
}

function renderStaticReferences(fromFile: string, sources: SourceRecord[], claims: ClaimRecord[]): string {
  const records = [
    ...sources.map((source) => ({
      title: source.title,
      href: relativeHref(fromFile, `${recordRoute(source.id)}.html`),
      type: "source",
      summary: source.source_type,
    })),
    ...claims.map((claim) => ({
      title: claim.text,
      href: relativeHref(fromFile, `${recordRoute(claim.id)}.html`),
      type: "claim",
      summary: `${claim.confidence} confidence / ${claim.risk} risk`,
    })),
  ];
  return renderPanel("References", renderRecordList(records, "No linked sources or claims."));
}

export function renderSourceHtml(
  workspaceTitle: string,
  source: SourceRecord,
  pages: PageRecord[],
  claims: ClaimRecord[],
  graph: GraphIndexResponse,
  assets: WebAssetManifest,
): string {
  const file = `${recordRoute(source.id)}.html`;
  const citingPages = pages.filter((page) => page.source_ids.includes(source.id));
  const citingClaims = claims.filter((claim) => claim.source_ids.includes(source.id));
  const sourceHref = safeExternalHref(source.url);
  const main = `
    <header class="ow-article-header">
      ${renderStaticBreadcrumb(file, [
        { label: "Home", href: "index.html" },
        { label: "Sources" },
        { label: source.title },
      ])}
      <p class="ow-eyebrow">Source ${renderBadge(source.source_type, "source")}</p>
      <h1>${escapeHtml(source.title)}</h1>
      ${renderArticleMeta([
        { label: "Type", value: source.source_type, kind: "badge", variant: "source" },
        { label: "Retrieved", value: source.retrieved_at },
        { label: "Hash", value: source.content_hash ?? "" },
        { label: "Original", value: source.url === undefined ? "" : sourceHref === undefined ? source.url : "URL", href: sourceHref, kind: "link" },
        { label: "Data", value: "JSON", href: relativeHref(file, `${recordRoute(source.id)}.json`), kind: "link" },
      ])}
    </header>
    ${renderPanel("Metadata", renderDefinitionList([
      ["ID", source.id],
      ["URI", source.uri],
      ["Retrieved", source.retrieved_at],
      ["Path", source.path],
      ["Hash", source.content_hash ?? ""],
      ["URL", source.url ?? ""],
    ]))}
    <section class="ow-grid">
      ${renderPanel("Cited By Pages", renderRecordList(citingPages.map((page) => ({
        title: page.title,
        href: relativeHref(file, `${pageRoute(page.id)}.html`),
        type: "page",
        summary: page.summary ?? page.id,
      })), "No public pages cite this source."))}
      ${renderPanel("Cited By Claims", renderRecordList(citingClaims.map((claim) => ({
        title: claim.text,
        href: relativeHref(file, `${recordRoute(claim.id)}.html`),
        type: "claim",
        summary: claim.confidence,
      })), "No public claims cite this source."))}
    </section>
    ${renderPanel("Local Graph", renderGraphMount({ src: relativeHref(file, "graph.json"), mode: "local", focusId: source.id, height: "280px", fallback: graphTextFallbackForStatic(localGraphForRecord(graph, source.id), file, 8) }))}
  `;
  return renderStaticShell({ title: source.title, workspaceTitle, active: "pages", file, assets, pages, main });
}

export function renderClaimHtml(
  workspaceTitle: string,
  claim: ClaimRecord,
  pages: PageRecord[],
  sources: SourceRecord[],
  graph: GraphIndexResponse,
  assets: WebAssetManifest,
): string {
  const file = `${recordRoute(claim.id)}.html`;
  const page = pages.find((candidate) => candidate.id === claim.page_id);
  const linkedSources = sources.filter((source) => claim.source_ids.includes(source.id));
  const main = `
    <header class="ow-article-header">
      ${renderStaticBreadcrumb(file, [
        { label: "Home", href: "index.html" },
        { label: "Claims" },
        { label: "Claim" },
      ])}
      <p class="ow-eyebrow">Claim ${renderBadge(claim.status, "claim")}</p>
      <h1>${escapeHtml(claim.text)}</h1>
      ${renderArticleMeta([
        { label: "Status", value: claim.status, kind: "badge", variant: "claim" },
        { label: "Confidence", value: claim.confidence },
        { label: "Risk", value: claim.risk },
        { label: "Verified", value: claim.last_verified_at ?? "" },
        { label: "Data", value: "JSON", href: relativeHref(file, `${recordRoute(claim.id)}.json`), kind: "link" },
      ])}
    </header>
    ${renderPanel("Trace", renderDefinitionList([
      ["Page", page ? `<a href="${relativeHref(file, `${pageRoute(page.id)}.html`)}">${escapeHtml(page.title)}</a>` : claim.page_id],
      ["Confidence", claim.confidence],
      ["Risk", claim.risk],
      ["Verified", claim.last_verified_at ?? ""],
    ], true))}
    ${renderPanel("Sources", renderRecordList(linkedSources.map((source) => ({
      title: source.title,
      href: relativeHref(file, `${recordRoute(source.id)}.html`),
      type: "source",
      summary: source.source_type,
    })), "No public sources linked."))}
    ${renderPanel("Local Graph", renderGraphMount({ src: relativeHref(file, "graph.json"), mode: "local", focusId: claim.id, height: "280px", fallback: graphTextFallbackForStatic(localGraphForRecord(graph, claim.id), file, 8) }))}
  `;
  return renderStaticShell({ title: "Claim", workspaceTitle, active: "pages", file, assets, pages, main });
}

export function renderFactHtml(
  workspaceTitle: string,
  fact: FactRecord,
  pages: PageRecord[],
  sources: SourceRecord[],
  claims: ClaimRecord[],
  graph: GraphIndexResponse,
  assets: WebAssetManifest,
): string {
  const file = `${recordRoute(fact.id)}.html`;
  const linkedPages = pages.filter((page) => fact.page_ids.includes(page.id));
  const linkedSources = sources.filter((source) => fact.source_ids.includes(source.id));
  const linkedClaims = claims.filter((claim) => fact.claim_ids.includes(claim.id));
  const main = `
    <header class="ow-article-header">
      ${renderStaticBreadcrumb(file, [
        { label: "Home", href: "index.html" },
        { label: "Facts" },
        { label: fact.kind },
      ])}
      <p class="ow-eyebrow">Fact ${renderBadge(fact.status, "claim")}</p>
      <h1>${escapeHtml(fact.text)}</h1>
      ${renderArticleMeta([
        { label: "Kind", value: fact.kind },
        { label: "Status", value: fact.status, kind: "badge", variant: "claim" },
        { label: "Confidence", value: fact.confidence },
        { label: "Sensitivity", value: fact.sensitivity },
        { label: "Updated", value: fact.updated_at },
        { label: "Data", value: "JSON", href: relativeHref(file, `${recordRoute(fact.id)}.json`), kind: "link" },
      ])}
    </header>
    ${renderPanel("Scope", renderDefinitionList([
      ["Subjects", fact.subject_ids.join(", ")],
      ["Valid From", fact.valid_from ?? ""],
      ["Valid To", fact.valid_to ?? ""],
      ["Path", fact.path],
    ]))}
    <section class="ow-grid">
      ${renderPanel("Pages", renderRecordList(linkedPages.map((page) => ({
        title: page.title,
        href: relativeHref(file, `${pageRoute(page.id)}.html`),
        type: "page",
        summary: page.summary ?? page.id,
      })), "No public linked pages."))}
      ${renderPanel("Sources", renderRecordList(linkedSources.map((source) => ({
        title: source.title,
        href: relativeHref(file, `${recordRoute(source.id)}.html`),
        type: "source",
        summary: source.source_type,
      })), "No public linked sources."))}
      ${renderPanel("Claims", renderRecordList(linkedClaims.map((claim) => ({
        title: claim.text,
        href: relativeHref(file, `${recordRoute(claim.id)}.html`),
        type: "claim",
        summary: `${claim.confidence} confidence`,
      })), "No public linked claims."))}
    </section>
    ${renderPanel("Local Graph", renderGraphMount({ src: relativeHref(file, "graph.json"), mode: "local", focusId: fact.id, height: "280px", fallback: graphTextFallbackForStatic(localGraphForRecord(graph, fact.id), file, 8) }))}
  `;
  return renderStaticShell({ title: "Fact", workspaceTitle, active: "pages", file, assets, pages, main });
}

export function renderTakeHtml(
  workspaceTitle: string,
  take: TakeRecord,
  pages: PageRecord[],
  sources: SourceRecord[],
  claims: ClaimRecord[],
  graph: GraphIndexResponse,
  assets: WebAssetManifest,
): string {
  const file = `${recordRoute(take.id)}.html`;
  const linkedPages = pages.filter((page) => take.page_ids.includes(page.id));
  const linkedSources = sources.filter((source) => take.source_ids.includes(source.id));
  const linkedClaims = claims.filter((claim) => take.claim_ids.includes(claim.id));
  const main = `
    <header class="ow-article-header">
      ${renderStaticBreadcrumb(file, [
        { label: "Home", href: "index.html" },
        { label: "Takes" },
        { label: take.status },
      ])}
      <p class="ow-eyebrow">Take ${renderBadge(take.status, "claim")}</p>
      <h1>${escapeHtml(take.statement)}</h1>
      ${take.rationale ? `<p class="ow-article-lede">${escapeHtml(take.rationale)}</p>` : ""}
      ${renderArticleMeta([
        { label: "Probability", value: `${Math.round(take.probability * 100)}%` },
        { label: "Status", value: take.status, kind: "badge", variant: "claim" },
        { label: "Confidence", value: take.confidence },
        { label: "Resolution", value: take.resolution ?? "" },
        { label: "Score", value: take.score === undefined ? "" : String(take.score) },
        { label: "Data", value: "JSON", href: relativeHref(file, `${recordRoute(take.id)}.json`), kind: "link" },
      ])}
    </header>
    ${renderPanel("Schedule", renderDefinitionList([
      ["Due", take.due_at ?? ""],
      ["Resolved", take.resolved_at ?? ""],
      ["Path", take.path],
    ]))}
    <section class="ow-grid">
      ${renderPanel("Pages", renderRecordList(linkedPages.map((page) => ({
        title: page.title,
        href: relativeHref(file, `${pageRoute(page.id)}.html`),
        type: "page",
        summary: page.summary ?? page.id,
      })), "No public linked pages."))}
      ${renderPanel("Sources", renderRecordList(linkedSources.map((source) => ({
        title: source.title,
        href: relativeHref(file, `${recordRoute(source.id)}.html`),
        type: "source",
        summary: source.source_type,
      })), "No public linked sources."))}
      ${renderPanel("Claims", renderRecordList(linkedClaims.map((claim) => ({
        title: claim.text,
        href: relativeHref(file, `${recordRoute(claim.id)}.html`),
        type: "claim",
        summary: `${claim.confidence} confidence`,
      })), "No public linked claims."))}
    </section>
    ${renderPanel("Local Graph", renderGraphMount({ src: relativeHref(file, "graph.json"), mode: "local", focusId: take.id, height: "280px", fallback: graphTextFallbackForStatic(localGraphForRecord(graph, take.id), file, 8) }))}
  `;
  return renderStaticShell({ title: "Take", workspaceTitle, active: "pages", file, assets, pages, main });
}

export function renderProposalHtml(
  workspaceTitle: string,
  proposal: ProposalRecord,
  pages: PageRecord[],
  comments: ProposalCommentRecord[],
  decisions: DecisionRecord[],
  graph: GraphIndexResponse,
  assets: WebAssetManifest,
): string {
  const file = `${recordRoute(proposal.id)}.html`;
  const proposalComments = comments.filter((comment) => comment.proposal_id === proposal.id);
  const proposalDecisions = decisions.filter((decision) => decision.proposal_id === proposal.id);
  const targetPage = pages.find((page) => proposal.target_ids.includes(page.id));
  const main = `
    <header class="ow-article-header">
      ${renderStaticBreadcrumb(file, [
        { label: "Home", href: "index.html" },
        { label: "Proposals" },
        { label: proposal.title },
      ])}
      <p class="ow-eyebrow">Proposal ${renderBadge(proposal.status, proposal.status)}</p>
      <h1>${escapeHtml(proposal.title)}</h1>
      ${proposal.rationale ? `<p class="ow-article-lede">${escapeHtml(proposal.rationale)}</p>` : ""}
      ${renderArticleMeta([
        { label: "Status", value: proposal.status, kind: "badge", variant: proposal.status },
        { label: "Actor", value: proposal.actor_id },
        { label: "Created", value: proposal.created_at },
        { label: "Target", value: proposal.target_path ?? proposal.target_ids.join(", ") },
        { label: "Data", value: "JSON", href: relativeHref(file, `${recordRoute(proposal.id)}.json`), kind: "link" },
      ])}
    </header>
    ${renderPanel("Metadata", renderDefinitionList([
      ["ID", proposal.id],
      ["Actor", proposal.actor_id],
      ["Created", proposal.created_at],
      ["Target", targetPage ? `<a href="${relativeHref(file, `${pageRoute(targetPage.id)}.html`)}">${escapeHtml(targetPage.title)}</a>` : proposal.target_ids.join(", ")],
      ["Path", proposal.path],
    ], true))}
    ${renderPanel("Comments", renderRecordList(proposalComments.map((comment) => ({
      title: comment.body,
      type: "comment",
      summary: `${comment.actor_id} / ${comment.created_at}`,
    })), "No public comments."))}
    ${renderPanel("Decisions", renderRecordList(proposalDecisions.map((decision) => ({
      title: decision.decision,
      href: relativeHref(file, `${recordRoute(decision.id)}.html`),
      type: "decision",
      summary: decision.rationale,
    })), "No public decisions."))}
    ${renderPanel("Local Graph", renderGraphMount({
      src: relativeHref(file, "graph.json"),
      mode: "local",
      focusId: proposal.id,
      height: "280px",
      fallback: graphTextFallbackForStatic(localGraphForRecord(graph, proposal.id), file, 8),
    }))}
  `;
  return renderStaticShell({ title: proposal.title, workspaceTitle, active: "pages", file, assets, pages, main });
}

export function renderDecisionHtml(
  workspaceTitle: string,
  decision: DecisionRecord,
  proposals: ProposalRecord[],
  pages: PageRecord[],
  graph: GraphIndexResponse,
  assets: WebAssetManifest,
): string {
  const file = `${recordRoute(decision.id)}.html`;
  const proposal = proposals.find((candidate) => candidate.id === decision.proposal_id);
  const main = `
    <header class="ow-article-header">
      ${renderStaticBreadcrumb(file, [
        { label: "Home", href: "index.html" },
        { label: "Decisions" },
        { label: decision.decision },
      ])}
      <p class="ow-eyebrow">Decision ${renderBadge(decision.decision, "decision")}</p>
      <h1>${escapeHtml(decision.decision)}</h1>
      <p class="ow-article-lede">${escapeHtml(decision.rationale)}</p>
      ${renderArticleMeta([
        { label: "Decision", value: decision.decision, kind: "badge", variant: "decision" },
        { label: "Actor", value: decision.actor_id },
        { label: "Decided", value: decision.decided_at },
        { label: "Commit", value: decision.commit ?? "" },
        { label: "Data", value: "JSON", href: relativeHref(file, `${recordRoute(decision.id)}.json`), kind: "link" },
      ])}
    </header>
    ${renderPanel("Metadata", renderDefinitionList([
      ["ID", decision.id],
      ["Proposal", proposal ? `<a href="${relativeHref(file, `${recordRoute(proposal.id)}.html`)}">${escapeHtml(proposal.title)}</a>` : decision.proposal_id],
      ["Actor", decision.actor_id],
      ["Decided", decision.decided_at],
      ["Commit", decision.commit ?? ""],
    ], true))}
    ${renderPanel("Local Graph", renderGraphMount({
      src: relativeHref(file, "graph.json"),
      mode: "local",
      focusId: decision.id,
      height: "280px",
      fallback: graphTextFallbackForStatic(localGraphForRecord(graph, decision.id), file, 8),
    }))}
  `;
  return renderStaticShell({ title: `Decision: ${decision.decision}`, workspaceTitle, active: "pages", file, assets, pages, main });
}

export function renderStaticGraphHtml(title: string, graph: GraphIndexResponse, assets: WebAssetManifest): string {
  const main = `
    <section class="ow-hero">
      <p class="ow-eyebrow">Knowledge graph</p>
      <h1>Workspace Graph</h1>
      <p>Explore pages, sources, claims, topics, proposals, and decisions from the public OpenWiki graph export.</p>
      <p><a class="button secondary" href="graph-report.html">Open graph report</a></p>
    </section>
    ${renderGraphMount({ src: "graph.json", mode: "global", height: "620px", title: "Public Graph", fallback: graphTextFallback(graph, 24) })}
  `;
  return renderStaticShell({ title: "Workspace Graph", workspaceTitle: title, active: "graph", file: "graph.html", assets, pages: [], main });
}

export function renderStaticGraphReportHtml(title: string, report: GraphAnalysisResponse, assets: WebAssetManifest): string {
  const main = `
    <section class="ow-hero">
      <p class="ow-eyebrow">Graph intelligence</p>
      <h1>Graph Report</h1>
      <p>Deterministic public graph analysis for humans and agents: hubs, components, gaps, stale hubs, and suggested traversal questions.</p>
      <p class="ow-home-stats">${report.node_count} nodes · ${report.edge_count} edges · ${report.components.length} components</p>
    </section>
    <section class="ow-grid">
      ${renderPanel("Hub Nodes", renderRecordList(report.hub_nodes.map((hub) => ({
        title: hub.title,
        href: graphReportNodeHref(hub.id, "graph-report.html"),
        type: hub.record_type,
        summary: `degree ${hub.degree} / ${hub.reason_codes.join(", ")}`,
      })), "No hub nodes found."))}
      ${renderPanel("Orphan Page Clusters", graphReportOrphanComponents(report))}
    </section>
    <section class="ow-grid">
      ${renderPanel("Missing Link Candidates", graphReportMissingLinks(report))}
      ${renderPanel("Stale Hubs", renderRecordList(report.stale_hubs.map((hub) => ({
        title: hub.title,
        href: graphReportNodeHref(hub.id, "graph-report.html"),
        type: "page",
        summary: `${hub.reason_codes.join(", ")} / ${[...hub.stale_claim_ids, ...hub.disputed_claim_ids].length} claims`,
      })), "No stale hubs found."))}
    </section>
    <section class="ow-grid">
      ${renderPanel("Source Coverage Gaps", renderRecordList(report.source_coverage_gaps.map((gap) => ({
        title: gap.topic,
        href: `graph.html?focus=${encodeURIComponent(gap.topic_id)}&types=${encodeURIComponent("page,topic,source")}`,
        type: "topic",
        summary: `${gap.page_count} pages / ${gap.source_count} sources / score ${gap.score}`,
      })), "No source coverage gaps found."))}
      ${renderPanel("Suggested Questions", graphReportQuestions(report))}
    </section>
    ${renderPanel("Machine Files", `<div class="ow-chip-list"><a class="ow-chip" href="graph-report.json">graph-report.json</a><a class="ow-chip" href="agents/index.md">agents/index.md</a><a class="ow-chip" href="graph.json">graph.json</a></div>`)}
  `;
  return renderStaticShell({ title: "Graph Report", workspaceTitle: title, active: "graph", file: "graph-report.html", assets, pages: [], main });
}

export function renderTopicsHtml(title: string, topics: TopicSummary[], pages: PageRecord[], assets: WebAssetManifest): string {
  const main = `
    <section class="ow-hero"><p class="ow-eyebrow">Topics</p><h1>Topic Index</h1><p>Browse public pages grouped by their declared OpenWiki topics.</p></section>
    ${renderPanel("Topics", renderTopicList(topics, "topics.html"))}
    ${renderTopicSections(topics, pages, "topics.html")}
  `;
  return renderStaticShell({ title: "Topics", workspaceTitle: title, active: "topics", file: "topics.html", assets, pages, main });
}

export function renderChangesHtml(title: string, recentChanges: RecentChangesResponse, assets: WebAssetManifest): string {
  const main = `
    <section class="ow-hero"><p class="ow-eyebrow">Git history</p><h1>Recent Changes</h1><p>Follow the public Git-backed change stream for this OpenWiki export.</p></section>
    ${renderPanel("Timeline", renderRecentChangeList(recentChanges, "changes.html"))}
  `;
  return renderStaticShell({ title: "Recent Changes", workspaceTitle: title, active: "changes", file: "changes.html", assets, pages: [], main });
}

export function renderMachineOnlyIndexHtml(title: string, htmlPageCount: number, htmlPageCeiling: number, assets: WebAssetManifest): string {
  const machineOnlyNav: ShellNavItem[] = [
    { label: "Home", href: "index.html", active: true },
    { label: "Search Index", href: "search-index.json" },
    { label: "Graph", href: "graph.json" },
    { label: "Graph Report", href: "graph-report.json" },
    { label: "API", href: "openapi.json" },
  ];
  const main = `
    <section class="ow-hero ow-hero--search">
      <p class="ow-eyebrow">Machine-readable export</p>
      <h1>${escapeHtml(title)}</h1>
      <p>This static export contains the complete agent-readable substrate. Human HTML pages were not generated because ${htmlPageCount} pages exceeded the configured ceiling of ${htmlPageCeiling}.</p>
      <p class="ow-home-stats">Use the JSONL, adjacent Markdown, OpenAPI, MCP manifest, and search corpus files as the complete source for agents and scripts.</p>
    </section>
    <section class="ow-grid">
      ${renderPanel("Machine Files", `<div class="ow-chip-list">
        <a class="ow-chip" href="pages.jsonl">Pages JSONL</a>
        <a class="ow-chip" href="sources.jsonl">Sources JSONL</a>
        <a class="ow-chip" href="claims.jsonl">Claims JSONL</a>
        <a class="ow-chip" href="search-index.json">Search Index</a>
        <a class="ow-chip" href="graph.json">Graph JSON</a>
        <a class="ow-chip" href="graph-report.json">Graph Report</a>
        <a class="ow-chip" href="agents/index.md">Agent Graph Guide</a>
        <a class="ow-chip" href="llms.txt">llms.txt</a>
        <a class="ow-chip" href="openapi.json">OpenAPI</a>
        <a class="ow-chip" href="mcp-manifest.json">MCP Manifest</a>
      </div>`)}
      ${renderPanel("Export Report", `<p class="ow-muted">The export report records why the HTML site was skipped and which sitemap artifacts were emitted.</p><p><a href="static-export-report.json">Open report JSON</a></p>`)}
    </section>
  `;
  return renderShell({
    title,
    workspaceTitle: title,
    active: "home",
    assetBase: "assets/",
    assetManifest: assets,
    navItems: machineOnlyNav,
    main,
    searchIndexHref: "search-index.json",
    graphHref: "graph.json",
    footer: `<a href="llms.txt">llms.txt</a><a href="pages.jsonl">Pages</a><a href="graph-report.json">Graph Report</a><a href="agents/index.md">Agent Guide</a><a href="openapi.json">OpenAPI</a><a href="mcp-manifest.json">MCP</a><a href="static-export-report.json">Report</a>`,
  });
}

export function renderAgentsIndexMarkdown(title: string, report: GraphAnalysisResponse, graph: GraphIndexResponse): string {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  return [
    `# ${markdownText(title)} Agent Graph Guide`,
    "",
    "This public guide is generated from the permission-filtered OpenWiki graph. Use it as an agent entry point before traversing page Markdown, `graph.json`, or `graph-report.json`.",
    "",
    `- Nodes: ${report.node_count}`,
    `- Edges: ${report.edge_count}`,
    `- Components: ${report.components.length}`,
    "",
    "## Hub Nodes",
    "",
    ...markdownList(report.hub_nodes, (hub) => `${markdownNodeLink(hub.id, hub.title, nodesById)} - degree ${hub.degree}; ${hub.reason_codes.join(", ")}`),
    "",
    "## Components",
    "",
    ...markdownList(report.components, (component) => `${component.id} - ${component.node_count} nodes, ${component.edge_count} edges; top nodes ${component.top_node_ids.map((id) => markdownNodeLabel(id, nodesById)).join(", ")}`),
    "",
    "## Missing Link Candidates",
    "",
    ...markdownList(report.candidate_missing_links, (candidate) => `${markdownNodeLink(candidate.from_id, markdownNodeLabel(candidate.from_id, nodesById), nodesById)} -> ${markdownNodeLink(candidate.to_id, markdownNodeLabel(candidate.to_id, nodesById), nodesById)} - score ${candidate.score}; ${candidate.reason_codes.join(", ")}`),
    "",
    "## Suggested Questions",
    "",
    ...markdownList(report.suggested_questions, (question) => `${markdownText(question.question)} Seeds: ${question.seed_node_ids.map((id) => markdownNodeLabel(id, nodesById)).join(", ")}`),
    "",
    "## Machine Artifacts",
    "",
    "- [graph-report.json](../graph-report.json)",
    "- [graph.json](../graph.json)",
    "- [pages.jsonl](../pages.jsonl)",
    "- [search-records.jsonl](../search-records.jsonl)",
    "",
  ].join("\n");
}

function graphReportOrphanComponents(report: GraphAnalysisResponse): string {
  if (report.orphan_components.length === 0) {
    return `<p class="ow-muted">No orphan page clusters found.</p>`;
  }
  return `<ul class="ow-record-list">${report.orphan_components
    .map((component) => `<li><div class="ow-record-list__title">${escapeHtml(component.id)}</div><p>${component.page_ids.map((id) => graphReportNodeLink(id, "graph-report.html")).join(" · ")}</p><small>${escapeHtml(component.reason_codes.join(", "))}</small></li>`)
    .join("")}</ul>`;
}

function graphReportMissingLinks(report: GraphAnalysisResponse): string {
  if (report.candidate_missing_links.length === 0) {
    return `<p class="ow-muted">No missing-link candidates found.</p>`;
  }
  return `<ul class="ow-record-list">${report.candidate_missing_links
    .map((candidate) => `<li><div class="ow-record-list__title">${graphReportNodeLink(candidate.from_id, "graph-report.html")} -> ${graphReportNodeLink(candidate.to_id, "graph-report.html")}</div><p>score ${candidate.score} · ${escapeHtml(candidate.reason_codes.join(", "))}</p><small>${escapeHtml(candidate.shared_node_ids.join(", "))}</small></li>`)
    .join("")}</ul>`;
}

function graphReportQuestions(report: GraphAnalysisResponse): string {
  if (report.suggested_questions.length === 0) {
    return `<p class="ow-muted">No suggested graph questions found.</p>`;
  }
  return `<ul class="ow-record-list">${report.suggested_questions
    .map((question) => `<li><div class="ow-record-list__title">${escapeHtml(question.question)}</div><p>${question.seed_node_ids.map((id) => graphReportNodeLink(id, "graph-report.html")).join(" · ")}</p><small>${escapeHtml(question.reason_codes.join(", "))}</small></li>`)
    .join("")}</ul>`;
}

function graphReportNodeLink(id: string, fromFile: string): string {
  const href = graphReportNodeHref(id, fromFile);
  return href === undefined ? `<code>${escapeHtml(id)}</code>` : `<a href="${escapeHtml(href)}">${escapeHtml(id)}</a>`;
}

function graphReportNodeHref(id: string, fromFile: string): string | undefined {
  if (id.startsWith("page:")) {
    return relativeHref(fromFile, `${pageRoute(id)}.html`);
  }
  if (id.startsWith("source:") || id.startsWith("claim:") || id.startsWith("proposal:") || id.startsWith("decision:")) {
    return relativeHref(fromFile, `${recordRoute(id)}.html`);
  }
  if (id.startsWith("topic:")) {
    return relativeHref(fromFile, `graph.html?focus=${encodeURIComponent(id)}&types=${encodeURIComponent("page,topic")}`);
  }
  return undefined;
}

function markdownList<T>(items: T[], line: (item: T) => string): string[] {
  return items.length === 0 ? ["- None"] : items.map((item) => `- ${line(item)}`);
}

function markdownNodeLabel(id: string, nodesById: Map<string, GraphNodeRecord>): string {
  return markdownText(nodesById.get(id)?.title ?? id);
}

function markdownNodeLink(id: string, label: string, nodesById: Map<string, GraphNodeRecord>): string {
  const node = nodesById.get(id);
  if (node?.record_type === "page") {
    return `[${markdownText(label)}](../${pageRoute(id)}.md)`;
  }
  return markdownText(label);
}

function markdownText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]").replace(/\n/g, " ");
}
