import { markdownToHtml } from "../markdown-cache.ts";
import { numberQuery, optionalSearchParam } from "../request.ts";
import type { HttpPolicyOptions, HttpRouteResult } from "../types.ts";
import { type ClaimRecord, type GraphNeighborhoodResponse, humanLabel, idToUri, type PageRecord, type SourceRecord } from "@openwiki/core";
import { diffVersions, getHistory, getHistoryForPath, InvalidGitRevisionError, listRecentChanges } from "@openwiki/git";
import { graphCurrentIndexStoreNeighbors, graphCurrentIndexStoreRelated, listCurrentIndexStoreProposals, listCurrentIndexStoreRecords, readCurrentIndexStoreGraph, readCurrentIndexStoreRecord, readCurrentIndexStoreWorkspaceIndex } from "@openwiki/index-store";
import { assertPathAuthorized, canReadClaimRecord, canReadDecisionRecord, canReadProposalRecord, canReadRecordId, canReadSourceRecord, visibleRepositoryView } from "@openwiki/policy";
import { graphCurrentPostgresNeighbors, graphCurrentPostgresRelated, listCurrentPostgresProposals, listCurrentPostgresRecords, readCurrentPostgresGraph, readCurrentPostgresRecordEntry, readCurrentPostgresRecordsByIds } from "@openwiki/postgres-runtime";
import { graphBacklinks, graphRelated, listGraphEdges, listOpenQuestions, listTopics, loadRepository, readPage, readProposalDetail } from "@openwiki/repo";
import { searchWiki } from "@openwiki/search";
import { escapeHtml, renderArticleMeta, renderBreadcrumb, renderDiff, renderGraphMount, renderPanel, renderRecordActions } from "@openwiki/web";
import { badRequest, canSeeAdminSurface, httpCanReadPostgresRecordEntry, httpCanSeeUnfilteredIndex, httpPolicyContext, optionalQueryString } from "../auth.ts";
import { filterGraphIndexByPolicy, filterGraphNeighborhoodByPolicy, filterOpenQuestionsByPolicy, filterRecentChangesByPolicy, filterSearchResponseByPolicy, filterTopicsByPolicy, listVisibleProposals, type HttpRecordListItem } from "../data-access.ts";
import { graphSummary, pagePublicRoute, renderGraphPanel, renderGraphSummaryList, renderGraphVisibleNodeList, renderGraphVisualization } from "./graph.ts";
import { dashboardPaletteSuggestions, htmlLayout, metricCard, renderClaimList, renderCommitList, renderDashboardRecentChanges, renderDecisionList, renderOpenQuestions, renderPageList, renderPageQuestions, renderProposalList, renderSearchResults, renderServerPageNavigation, renderSourceList, type ServerActive } from "./layout.ts";
import { isObject } from "../route-utils.ts";

export async function renderDashboardPage(root: string, url: URL, policy: HttpPolicyOptions): Promise<string> {
  const repo = await loadRepository(root);
  const visible = visibleRepositoryView(repo, httpPolicyContext(policy));
  const query = (url.searchParams.get("q") ?? "").trim();
  const proposals = await listVisibleProposals(root, policy, { statuses: ["open"], limit: 8 });
  const recentChanges = await filterRecentChangesByPolicy(root, policy, await listRecentChanges(root, 6));
  const questions = await filterOpenQuestionsByPolicy(root, policy, await listOpenQuestions(root));
  const topics = await filterTopicsByPolicy(root, policy, await listTopics(root));
  const paletteSuggestions = dashboardPaletteSuggestions(visible.pages, topics.topics);
  const adminAction = canSeeAdminSurface(policy) ? `<a class="button secondary" href="/admin">Admin</a>` : "";
  const search =
    query.length === 0
      ? undefined
      : await filterSearchResponseByPolicy(
          root,
          policy,
          await searchWiki(
            root,
            {
              query,
              limit: 8,
              mode: "hybrid",
              fuzzy: true,
            },
            { policyContext: httpPolicyContext(policy) },
          ),
        );

  return htmlLayout(
    repo.config.title,
    "home",
    `
    <section class="ow-hero ow-hero--search">
      <p class="ow-eyebrow">${escapeHtml(repo.config.workspace_id)}</p>
      <h1>${escapeHtml(repo.config.title)}</h1>
      <p>Search, read, follow links, and propose edits to the team's versioned knowledge base. Agents use the same permissioned workflow through scoped tools.</p>
      <form class="ow-home-search-form" method="get" action="/" data-openwiki-palette-form>
        <input name="q" value="${escapeHtml(query)}" placeholder="Search pages and proposals" aria-label="Search">
        <button type="submit">Search</button>
      </form>
      <p class="ow-home-stats">${visible.pages.length} pages · ${visible.sources.length} sources · ${visible.claims.length} claims · ${proposals.total} open proposals</p>
      <div class="ow-hero__actions">
        <a class="button secondary" href="/#pages">Browse pages</a>
        <a class="button secondary" href="/proposals">Review proposals</a>
        ${adminAction}
      </div>
    </section>
    <section class="ow-metrics" aria-label="Workspace counts">
      ${metricCard("Pages", visible.pages.length)}
      ${metricCard("Sources", visible.sources.length)}
      ${metricCard("Claims", visible.claims.length)}
      ${metricCard("Open Proposals", proposals.total)}
    </section>
    ${
      search === undefined
        ? ""
        : `<section class="ow-panel">
      <div class="ow-panel__head"><h2>Search Results</h2><a href="/api/v1/search?q=${encodeURIComponent(query)}&fuzzy=true&mode=hybrid">JSON</a></div>
      ${search.results.length === 0 ? `<p class="ow-muted">No results for ${escapeHtml(query)}.</p>` : renderSearchResults(search.results)}
    </section>`
    }
    <section class="ow-grid">
      <div class="ow-panel">
        <div class="ow-panel__head"><h2>Pages</h2><a href="/api/v1/search?q=&types=page">JSON</a></div>
        ${renderPageList(visible.pages)}
      </div>
      <div class="ow-panel">
        <div class="ow-panel__head"><h2>Proposal Queue</h2><a href="/proposals">View all</a></div>
        ${renderProposalList(proposals.proposals)}
      </div>
    </section>
    <section class="ow-grid">
      <div class="ow-panel">
        <div class="ow-panel__head"><h2>Recent Changes</h2><a href="/api/v1/recent-changes">JSON</a></div>
        ${renderDashboardRecentChanges(recentChanges)}
      </div>
      <div class="ow-panel">
        <div class="ow-panel__head"><h2>Open Questions</h2><a href="/api/v1/open-questions">JSON</a></div>
        ${renderOpenQuestions(questions.open_questions)}
      </div>
    </section>
  `,
    { paletteSuggestions, policy },
  );
}

export async function renderWorkspaceGraphPage(root: string, url: URL, policy: HttpPolicyOptions): Promise<string> {
  const repo = await loadRepository(root);
  const focus = optionalQueryString(url, "focus", "id");
  const graph = await filterGraphIndexByPolicy(
    root,
    policy,
    (await readCurrentPostgresGraph(root)) ?? (await readCurrentIndexStoreGraph(root)) ?? (await listGraphEdges(root)),
  );
  const visual = renderGraphVisualization(graph, {
    ...(focus === undefined ? {} : { focusId: focus }),
    width: 980,
    height: 560,
    maxNodes: numberQuery(url, "limit") ?? 72,
  });
  const summary = graphSummary(graph);
  const graphLimit = Math.min(Math.max(numberQuery(url, "limit") ?? 1500, 1), 5000);
  const graphSrc =
    focus === undefined
      ? `/api/v1/graph?seed=top&limit=${graphLimit}`
      : `/api/v1/graph/${encodeURIComponent(focus)}/neighbors?limit=${graphLimit}`;

  return htmlLayout(
    "Workspace Graph",
    "graph",
    `
    <section class="ow-toolbar">
      <form class="ow-inline-search" method="get" action="/graph">
        <input name="focus" value="${escapeHtml(focus ?? "")}" placeholder="Focus a page, source, claim, topic, or section ID" aria-label="Focus node">
        <button type="submit">Focus</button>
      </form>
      <a class="button secondary" href="/api/v1/graph">Graph JSON</a>
      <a class="button secondary" href="/api/v1/graph?seed=top&amp;limit=${graphLimit}">Seed JSON</a>
      <a class="button secondary" href="/api/v1/graph/orphans">Orphans JSON</a>
      <a class="button secondary" href="/api/v1/graph/stale">Stale JSON</a>
    </section>
    <section class="ow-panel">
      <div class="ow-panel__head">
        <div>
          <p class="ow-eyebrow">${escapeHtml(repo.config.workspace_id)}</p>
          <h1>Workspace Graph</h1>
        </div>
        <a href="/graph">Reset</a>
      </div>
      <div class="ow-graph-layout">
        <div>
          ${renderGraphMount({
            src: graphSrc,
            mode: "global",
            ...(focus === undefined ? {} : { focusId: focus }),
            height: "620px",
            title: "Workspace Graph",
            neighborSrcTemplate: "/api/v1/graph/{id}/neighbors?limit=" + graphLimit,
            fallback: visual.svg,
          })}
          <p class="ow-muted">${visual.renderedNodes} visible nodes and ${visual.renderedEdges} visible edges drawn from ${graph.nodes.length} nodes and ${graph.edges.length} edges.</p>
        </div>
        <aside class="ow-graph-sidebar">
          <h2>Node Types</h2>
          ${renderGraphSummaryList(summary.nodeTypes)}
          <h2>Edge Types</h2>
          ${renderGraphSummaryList(summary.edgeTypes)}
          <h2>Visible Nodes</h2>
          ${renderGraphVisibleNodeList(visual.nodes.slice(0, 24))}
        </aside>
      </div>
    </section>
  `,
    { policy },
  );
}

export async function renderPageView(root: string, id: string, policy: HttpPolicyOptions): Promise<string> {
  const postgres = await renderPostgresPageView(root, id, policy);
  if (postgres !== undefined) {
    return postgres;
  }
  const indexed = await renderIndexedPageView(root, id, policy);
  if (indexed !== undefined) {
    return indexed;
  }
  const repo = await loadRepository(root);
  const page = await readPage(root, id);
  const sourceIds = new Set(page.source_ids);
  const claimIds = new Set(page.claim_ids);
  const context = httpPolicyContext(policy);
  const sources = repo.sources.filter((source) => sourceIds.has(source.id) && canReadSourceRecord(repo, context, source));
  const claims = repo.claims.filter((claim) => claimIds.has(claim.id) && canReadClaimRecord(repo, context, claim));
  const proposals = repo.proposals
    .filter((proposal) => proposal.target_ids.includes(page.id) && canReadProposalRecord(repo, context, proposal))
    .sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id));
  const proposalIds = new Set(proposals.map((proposal) => proposal.id));
  const decisions = repo.decisions
    .filter((decision) => proposalIds.has(decision.proposal_id) && canReadDecisionRecord(repo, context, decision))
    .sort((left, right) => right.decided_at.localeCompare(left.decided_at) || right.id.localeCompare(left.id));
  const visibleSiblingPages = repo.pages.filter((candidate) => candidate.page_type === page.page_type && canReadRecordId(repo, context, candidate.id));
  const history = await getHistory(root, page.id, 5);
  const backlinks = await filterGraphNeighborhoodByPolicy(root, policy, (await graphCurrentPostgresNeighbors(root, page.id, { direction: "in", depth: 1, limit: 12 })) ?? (await graphCurrentIndexStoreNeighbors(root, page.id, { direction: "in", depth: 1, limit: 12 })) ?? (await graphBacklinks(root, page.id, { limit: 12 })));
  const relatedGraph = await filterGraphNeighborhoodByPolicy(root, policy, (await graphCurrentPostgresRelated(root, page.id, { limit: 16 })) ?? (await graphCurrentIndexStoreRelated(root, page.id, { limit: 16 })) ?? (await graphRelated(root, page.id, { limit: 16 })));
  const questions = (await filterOpenQuestionsByPolicy(root, policy, await listOpenQuestions(root))).open_questions.filter((question) => question.page_id === page.id);
  const canSuggestEdit = canUsePathOperation(repo, policy, "wiki.propose_edit", page.path);
  const suggestEditLink = canSuggestEdit ? `<a class="button secondary" href="/pages/${encodeURIComponent(page.id)}/edit">Suggest Edit</a>` : "";

  return htmlLayout(
    page.title,
    "pages",
    `
    <section class="ow-toolbar">
      <a class="button secondary" href="/">Back</a>
      ${suggestEditLink}
      <a class="button secondary" href="/pages/${encodeURIComponent(page.id)}/diff">Diff</a>
      <a class="button secondary" href="/api/v1/pages/${encodeURIComponent(page.id)}">Page JSON</a>
      <a class="button secondary" href="${pagePublicRoute(page)}.md">Markdown</a>
      <a class="button secondary" href="/api/v1/pages/${encodeURIComponent(page.id)}/history">History JSON</a>
    </section>
    <section class="ow-record-layout">
      <article class="ow-reading-article">
        <header class="ow-article-header">
          ${renderBreadcrumb([
            { label: "Home", href: "/" },
            { label: "Pages", href: "/#pages" },
            { label: humanLabel(page.page_type) },
            { label: page.title },
          ])}
          <p class="ow-eyebrow">${escapeHtml(page.page_type)} / ${escapeHtml(page.status)}</p>
          <h1>${escapeHtml(page.title)}</h1>
          ${page.summary ? `<p class="ow-article-lede">${escapeHtml(page.summary)}</p>` : ""}
          ${renderArticleMeta([
            { label: "Status", value: page.status, kind: "badge", variant: page.status },
            { label: "Type", value: humanLabel(page.page_type) },
            { label: "Updated", value: page.updated_at },
            { label: "Created", value: page.created_at },
            ...(history.commits[0]
              ? [{ label: "Actor", value: history.commits[0].author_name || history.commits[0].author_email || history.commits[0].short_sha }]
              : []),
            { label: "Source", value: "Markdown", href: pagePublicRoute(page) + ".md", kind: "link" },
            { label: "Data", value: "JSON", href: pagePublicRoute(page) + ".json", kind: "link" },
          ])}
          ${renderRecordActions([
            { label: "Cite", cite: `${page.title} — ${page.uri}` },
            { label: "History", href: `/api/v1/pages/${encodeURIComponent(page.id)}/history` },
            { label: "Raw .md", href: pagePublicRoute(page) + ".md" },
            { label: "JSON", href: pagePublicRoute(page) + ".json" },
            { label: "Open in graph", href: `/graph?focus=${encodeURIComponent(page.id)}` },
            ...(canSuggestEdit ? [{ label: "Suggest edit", href: `/pages/${encodeURIComponent(page.id)}/edit`, primary: true }] : []),
          ])}
        </header>
        ${markdownToHtml(page.body)}
        ${renderPanel("References", renderPageReferences(sources, claims))}
        ${renderServerPageNavigation(page, visibleSiblingPages)}
      </article>
      <aside class="ow-panel ow-record-side">
        <h2>Sources</h2>
        ${sources.length === 0 ? `<p class="ow-muted">No sources linked.</p>` : renderSourceList(sources)}
        <h2>Claims</h2>
        ${claims.length === 0 ? `<p class="ow-muted">No claims linked.</p>` : renderClaimList(claims)}
        <h2>Governance</h2>
        ${proposals.length === 0 ? `<p class="ow-muted">No proposals target this page.</p>` : renderProposalList(proposals)}
        ${decisions.length === 0 ? "" : `<h2>Decisions</h2>${renderDecisionList(decisions)}`}
        <h2>History</h2>
        ${renderCommitList(history.commits, history.is_git_repo)}
        <h2>Graph</h2>
        ${renderGraphPanel(page.id, backlinks, relatedGraph)}
        <h2>Open Questions</h2>
        ${renderPageQuestions(questions)}
        <h2>Machine Readable</h2>
        <ul class="ow-link-list">
          <li><a href="/api/v1/pages/${encodeURIComponent(page.id)}">Page JSON</a></li>
          <li><a href="${pagePublicRoute(page)}.json">Adjacent JSON</a></li>
          <li><a href="${pagePublicRoute(page)}.md">Adjacent Markdown</a></li>
          <li><a href="/api/v1/pages/${encodeURIComponent(page.id)}/history">History JSON</a></li>
          <li><a href="/pages/${encodeURIComponent(page.id)}/diff">Human Diff</a></li>
          <li><a href="/api/v1/pages/${encodeURIComponent(page.id)}/diff">Diff JSON</a></li>
        </ul>
      </aside>
    </section>
  `,
    { policy },
  );
}

async function renderPostgresPageView(root: string, id: string, policy: HttpPolicyOptions): Promise<string | undefined> {
  const pageRead = await readCurrentPostgresRecordEntry<PageRecord>(root, id, "page");
  if (pageRead === undefined || !httpCanReadPostgresRecordEntry(policy, pageRead)) {
    return undefined;
  }
  const page = pageRead.record;
  const repo = await loadRepository(root);
  const admin = canSeeAdminSurface(policy);
  const [history, sourceReads, claimReads, proposalList, siblingList, backlinks, relatedGraph] = await Promise.all([
    getHistoryForPath(root, page.id, page.path, 5),
    readCurrentPostgresRecordsByIds<SourceRecord>(root, page.source_ids, "source"),
    readCurrentPostgresRecordsByIds<ClaimRecord>(root, page.claim_ids, "claim"),
    admin ? listCurrentPostgresProposals(root, { targetId: page.id, limit: 8 }) : Promise.resolve(undefined),
    admin ? listCurrentPostgresRecords<PageRecord>(root, { type: "page", group: page.page_type, limit: 200 }) : Promise.resolve(undefined),
    admin ? graphCurrentPostgresNeighbors(root, page.id, { direction: "in", depth: 1, limit: 12 }) : Promise.resolve(undefined),
    admin ? graphCurrentPostgresRelated(root, page.id, { limit: 16 }) : Promise.resolve(undefined),
  ]);
  const sources = (sourceReads?.records ?? [])
    .filter((entry) => httpCanReadPostgresRecordEntry(policy, entry))
    .map((entry) => entry.record);
  const claims = (claimReads?.records ?? [])
    .filter((entry) => httpCanReadPostgresRecordEntry(policy, entry))
    .map((entry) => entry.record);
  const proposals = (proposalList?.proposals ?? []).sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id));
  const visibleSiblingPages = admin ? siblingList?.records ?? [page] : [page];
  const canSuggestEdit = canUsePathOperation(repo, policy, "wiki.propose_edit", page.path);
  const suggestEditLink = canSuggestEdit ? `<a class="button secondary" href="/pages/${encodeURIComponent(page.id)}/edit">Suggest Edit</a>` : "";

  return htmlLayout(
    page.title,
    "pages",
    `
    <section class="ow-toolbar">
      <a class="button secondary" href="/">Back</a>
      ${suggestEditLink}
      <a class="button secondary" href="/pages/${encodeURIComponent(page.id)}/diff">Diff</a>
      <a class="button secondary" href="/api/v1/pages/${encodeURIComponent(page.id)}">Page JSON</a>
      <a class="button secondary" href="${pagePublicRoute(page)}.md">Markdown</a>
      <a class="button secondary" href="/api/v1/pages/${encodeURIComponent(page.id)}/history">History JSON</a>
    </section>
    <section class="ow-record-layout">
      <article class="ow-reading-article">
        <header class="ow-article-header">
          ${renderBreadcrumb([
            { label: "Home", href: "/" },
            { label: "Pages", href: "/#pages" },
            { label: humanLabel(page.page_type) },
            { label: page.title },
          ])}
          <p class="ow-eyebrow">${escapeHtml(page.page_type)} / ${escapeHtml(page.status)} / postgres-runtime</p>
          <h1>${escapeHtml(page.title)}</h1>
          ${page.summary ? `<p class="ow-article-lede">${escapeHtml(page.summary)}</p>` : ""}
          ${renderArticleMeta([
            { label: "Status", value: page.status, kind: "badge", variant: page.status },
            { label: "Type", value: humanLabel(page.page_type) },
            { label: "Updated", value: page.updated_at },
            { label: "Created", value: page.created_at },
            ...(history.commits[0]
              ? [{ label: "Actor", value: history.commits[0].author_name || history.commits[0].author_email || history.commits[0].short_sha }]
              : []),
            { label: "Source", value: "Markdown", href: pagePublicRoute(page) + ".md", kind: "link" },
            { label: "Data", value: "JSON", href: pagePublicRoute(page) + ".json", kind: "link" },
          ])}
          ${renderRecordActions([
            { label: "Cite", cite: `${page.title} — ${page.uri}` },
            { label: "History", href: `/api/v1/pages/${encodeURIComponent(page.id)}/history` },
            { label: "Raw .md", href: pagePublicRoute(page) + ".md" },
            { label: "JSON", href: pagePublicRoute(page) + ".json" },
            { label: "Open in graph", href: `/graph?focus=${encodeURIComponent(page.id)}` },
            ...(canSuggestEdit ? [{ label: "Suggest edit", href: `/pages/${encodeURIComponent(page.id)}/edit`, primary: true }] : []),
          ])}
        </header>
        ${markdownToHtml(page.body)}
        ${renderPanel("References", renderPageReferences(sources, claims))}
        ${renderServerPageNavigation(page, visibleSiblingPages)}
      </article>
      <aside class="ow-panel ow-record-side">
        <h2>Sources</h2>
        ${sources.length === 0 ? `<p class="ow-muted">No sources linked.</p>` : renderSourceList(sources)}
        <h2>Claims</h2>
        ${claims.length === 0 ? `<p class="ow-muted">No claims linked.</p>` : renderClaimList(claims)}
        <h2>Governance</h2>
        ${proposals.length === 0 ? `<p class="ow-muted">No proposals target this page.</p>` : renderProposalList(proposals)}
        <h2>History</h2>
        ${renderCommitList(history.commits, history.is_git_repo)}
        <h2>Graph</h2>
        ${renderGraphPanel(page.id, backlinks ?? emptyGraphNeighborhood(page.id), relatedGraph ?? emptyGraphNeighborhood(page.id))}
        <h2>Open Questions</h2>
        <p class="ow-muted">Open questions are available from the governance detector and API.</p>
        <h2>Machine Readable</h2>
        <ul class="ow-link-list">
          <li><a href="/api/v1/pages/${encodeURIComponent(page.id)}">Page JSON</a></li>
          <li><a href="${pagePublicRoute(page)}.json">Adjacent JSON</a></li>
          <li><a href="${pagePublicRoute(page)}.md">Adjacent Markdown</a></li>
          <li><a href="/api/v1/pages/${encodeURIComponent(page.id)}/history">History JSON</a></li>
          <li><a href="/pages/${encodeURIComponent(page.id)}/diff">Human Diff</a></li>
          <li><a href="/api/v1/pages/${encodeURIComponent(page.id)}/diff">Diff JSON</a></li>
        </ul>
      </aside>
    </section>
  `,
    { policy },
  );
}

function canUsePathOperation(
  repo: Awaited<ReturnType<typeof loadRepository>>,
  policy: HttpPolicyOptions,
  operation: Parameters<typeof assertPathAuthorized>[0],
  repoPath: string,
): boolean {
  try {
    assertPathAuthorized(operation, httpPolicyContext(policy), repo.policy, repoPath);
    return true;
  } catch {
    return false;
  }
}

async function renderIndexedPageView(root: string, id: string, policy: HttpPolicyOptions): Promise<string | undefined> {
  if (!httpCanSeeUnfilteredIndex(policy)) {
    return undefined;
  }
  const pageRead = await readCurrentIndexStoreRecord(root, id, { visibility: "all" });
  const page = recordJsonOfType<PageRecord>(pageRead?.record.json, "page");
  if (!page || pageRead?.record.record_type !== "page") {
    return undefined;
  }
  const [workspace, history, sourceReads, claimReads, proposalList, siblingList, backlinks, relatedGraph] = await Promise.all([
    readCurrentIndexStoreWorkspaceIndex(root),
    getHistoryForPath(root, page.id, page.path, 5),
    Promise.all(page.source_ids.map((sourceId) => readCurrentIndexStoreRecord(root, sourceId, { visibility: "all" }))),
    Promise.all(page.claim_ids.map((claimId) => readCurrentIndexStoreRecord(root, claimId, { visibility: "all" }))),
    listCurrentIndexStoreProposals(root, { targetId: page.id, limit: 8 }),
    listCurrentIndexStoreRecords(root, { type: "page", group: page.page_type, limit: 200, visibility: "all" }),
    graphCurrentIndexStoreNeighbors(root, page.id, { direction: "in", depth: 1, limit: 12 }),
    graphCurrentIndexStoreRelated(root, page.id, { limit: 16 }),
  ]);
  const sources = sourceReads
    .map((record) => recordJsonOfType<SourceRecord>(record?.record.json, "source"))
    .filter((source): source is SourceRecord => source !== undefined);
  const claims = claimReads
    .map((record) => recordJsonOfType<ClaimRecord>(record?.record.json, "claim"))
    .filter((claim): claim is ClaimRecord => claim !== undefined);
  const proposals = (proposalList?.proposals ?? []).sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id));
  const visibleSiblingPages = (siblingList?.records ?? []).map((record) => pageRecordStubFromListItem(record, page)).filter((record): record is PageRecord => record !== undefined);
  const workspaceId = typeof workspace?.workspace.workspace_id === "string" ? workspace.workspace.workspace_id : "workspace:index-store";

  return htmlLayout(
    page.title,
    "pages",
    `
    <section class="ow-toolbar">
      <a class="button secondary" href="/">Back</a>
      <a class="button secondary" href="/pages/${encodeURIComponent(page.id)}/edit">Suggest Edit</a>
      <a class="button secondary" href="/pages/${encodeURIComponent(page.id)}/diff">Diff</a>
      <a class="button secondary" href="/api/v1/pages/${encodeURIComponent(page.id)}">Page JSON</a>
      <a class="button secondary" href="${pagePublicRoute(page)}.md">Markdown</a>
      <a class="button secondary" href="/api/v1/pages/${encodeURIComponent(page.id)}/history">History JSON</a>
    </section>
    <section class="ow-record-layout">
      <article class="ow-reading-article">
        <header class="ow-article-header">
          ${renderBreadcrumb([
            { label: "Home", href: "/" },
            { label: "Pages", href: "/#pages" },
            { label: humanLabel(page.page_type) },
            { label: page.title },
          ])}
          <p class="ow-eyebrow">${escapeHtml(page.page_type)} / ${escapeHtml(page.status)} / ${escapeHtml(workspaceId)}</p>
          <h1>${escapeHtml(page.title)}</h1>
          ${page.summary ? `<p class="ow-article-lede">${escapeHtml(page.summary)}</p>` : ""}
          ${renderArticleMeta([
            { label: "Status", value: page.status, kind: "badge", variant: page.status },
            { label: "Type", value: humanLabel(page.page_type) },
            { label: "Updated", value: page.updated_at },
            { label: "Created", value: page.created_at },
            ...(history.commits[0]
              ? [{ label: "Actor", value: history.commits[0].author_name || history.commits[0].author_email || history.commits[0].short_sha }]
              : []),
            { label: "Source", value: "Markdown", href: pagePublicRoute(page) + ".md", kind: "link" },
            { label: "Data", value: "JSON", href: pagePublicRoute(page) + ".json", kind: "link" },
          ])}
          ${renderRecordActions([
            { label: "Cite", cite: `${page.title} — ${page.uri}` },
            { label: "History", href: `/api/v1/pages/${encodeURIComponent(page.id)}/history` },
            { label: "Raw .md", href: pagePublicRoute(page) + ".md" },
            { label: "JSON", href: pagePublicRoute(page) + ".json" },
            { label: "Open in graph", href: `/graph?focus=${encodeURIComponent(page.id)}` },
            { label: "Suggest edit", href: `/pages/${encodeURIComponent(page.id)}/edit`, primary: true },
          ])}
        </header>
        ${markdownToHtml(page.body)}
        ${renderPanel("References", renderPageReferences(sources, claims))}
        ${renderServerPageNavigation(page, visibleSiblingPages)}
      </article>
      <aside class="ow-panel ow-record-side">
        <h2>Sources</h2>
        ${sources.length === 0 ? `<p class="ow-muted">No sources linked.</p>` : renderSourceList(sources)}
        <h2>Claims</h2>
        ${claims.length === 0 ? `<p class="ow-muted">No claims linked.</p>` : renderClaimList(claims)}
        <h2>Governance</h2>
        ${proposals.length === 0 ? `<p class="ow-muted">No proposals target this page.</p>` : renderProposalList(proposals)}
        <h2>History</h2>
        ${renderCommitList(history.commits, history.is_git_repo)}
        <h2>Graph</h2>
        ${renderGraphPanel(page.id, backlinks ?? emptyGraphNeighborhood(page.id), relatedGraph ?? emptyGraphNeighborhood(page.id))}
        <h2>Open Questions</h2>
        <p class="ow-muted">Open questions are available from the governance detector and API.</p>
        <h2>Machine Readable</h2>
        <ul class="ow-link-list">
          <li><a href="/api/v1/pages/${encodeURIComponent(page.id)}">Page JSON</a></li>
          <li><a href="${pagePublicRoute(page)}.json">Adjacent JSON</a></li>
          <li><a href="${pagePublicRoute(page)}.md">Adjacent Markdown</a></li>
          <li><a href="/api/v1/pages/${encodeURIComponent(page.id)}/history">History JSON</a></li>
          <li><a href="/pages/${encodeURIComponent(page.id)}/diff">Human Diff</a></li>
          <li><a href="/api/v1/pages/${encodeURIComponent(page.id)}/diff">Diff JSON</a></li>
        </ul>
      </aside>
    </section>
  `,
    { policy },
  );
}

function recordJsonOfType<T extends { type: string }>(value: unknown, type: T["type"]): T | undefined {
  if (!isObject(value) || value.type !== type) {
    return undefined;
  }
  return value as unknown as T;
}

function pageRecordStubFromListItem(record: HttpRecordListItem, current: PageRecord): PageRecord | undefined {
  if (record.type !== "page") {
    return undefined;
  }
  return {
    id: record.id,
    uri: idToUri(record.id),
    type: "page",
    page_type: record.group || current.page_type,
    title: record.title,
    summary: record.summary ?? "",
    body_format: "markdown",
    body: "",
    path: record.path ?? "",
    source_ids: [],
    claim_ids: [],
    status: record.status ?? "draft",
    topics: [],
    created_at: record.updated_at ?? current.created_at,
    updated_at: record.updated_at ?? current.updated_at,
  };
}

function emptyGraphNeighborhood(id: string): GraphNeighborhoodResponse {
  return { root_id: id, depth: 1, direction: "both", nodes: [], edges: [] };
}

function renderPageReferences(sources: SourceRecord[], claims: ClaimRecord[]): string {
  const sourceHtml = sources.length === 0 ? "" : `<h3>Sources</h3>${renderSourceList(sources)}`;
  const claimHtml = claims.length === 0 ? "" : `<h3>Claims</h3>${renderClaimList(claims)}`;
  return sourceHtml || claimHtml ? `${sourceHtml}${claimHtml}` : `<p class="ow-muted">No linked sources or claims.</p>`;
}

async function renderRecordDiffPage(root: string, id: string, backHref: string, url: URL, policy: HttpPolicyOptions): Promise<string> {
  const repo = await loadRepository(root);
  const diff = await diffVersions({
    root,
    id,
    ...optionalSearchParam(url, "from", "from"),
    ...optionalSearchParam(url, "to", "to"),
  });
  const title = recordTitleForDiff(repo, id);
  const apiHref = apiDiffHrefForRecord(id, url.search);
  return htmlLayout(
    `Diff: ${title}`,
    recordActiveNav(id),
    `
    <section class="ow-toolbar">
      <a class="button secondary" href="${escapeHtml(backHref)}">Back</a>
      <a class="button secondary" href="${escapeHtml(apiHref)}">Diff JSON</a>
    </section>
    <article class="ow-panel">
      <header class="ow-article-header">
        ${renderBreadcrumb([
          { label: "Home", href: "/" },
          { label: "Diff" },
          { label: title },
        ])}
        <p class="ow-eyebrow">${escapeHtml(id)}</p>
        <h1>${escapeHtml(title)}</h1>
        ${renderArticleMeta([
          { label: "Git", value: diff.is_git_repo ? "available" : "not initialized" },
          { label: "Path", value: diff.path },
          { label: "From", value: diff.from ?? "working tree" },
          { label: "To", value: diff.to ?? "index/worktree" },
          { label: "Data", value: "JSON", href: apiHref, kind: "link" },
        ])}
      </header>
      ${renderDiff(diff.diff)}
    </article>
  `,
    { policy },
  );
}

export async function renderRecordDiffRouteResult(root: string, id: string, backHref: string, url: URL, policy: HttpPolicyOptions): Promise<HttpRouteResult> {
  try {
    return {
      status: 200,
      body: await renderRecordDiffPage(root, id, backHref, url, policy),
      contentType: "text/html; charset=utf-8",
    };
  } catch (error) {
    if (error instanceof InvalidGitRevisionError) {
      return badRequest(error.message);
    }
    throw error;
  }
}

export async function renderProposalDiffPage(root: string, id: string, policy: HttpPolicyOptions): Promise<string> {
  const detail = await readProposalDetail(root, id);
  const proposal = detail.proposal;
  return htmlLayout(
    `Diff: ${proposal.title}`,
    "proposals",
    `
    <section class="ow-toolbar">
      <a class="button secondary" href="/proposals/${encodeURIComponent(proposal.id)}">Back</a>
      <a class="button secondary" href="/api/v1/proposals/${encodeURIComponent(proposal.id)}/diff">Diff JSON</a>
    </section>
    <article class="ow-panel">
      <header class="ow-article-header">
        ${renderBreadcrumb([
          { label: "Proposals", href: "/proposals" },
          { label: proposal.title, href: `/proposals/${encodeURIComponent(proposal.id)}` },
          { label: "Diff" },
        ])}
        <p class="ow-eyebrow">${escapeHtml(proposal.id)}</p>
        <h1>${escapeHtml(proposal.title)}</h1>
        ${renderArticleMeta([
          { label: "Status", value: proposal.status, kind: "badge", variant: proposal.status },
          { label: "Target", value: proposal.target_path ?? proposal.target_ids.join(", ") },
          { label: "Data", value: "JSON", href: `/api/v1/proposals/${encodeURIComponent(proposal.id)}/diff`, kind: "link" },
        ])}
      </header>
      ${renderDiff(detail.diff?.body ?? "")}
    </article>
  `,
    { policy },
  );
}

function recordTitleForDiff(repo: Awaited<ReturnType<typeof loadRepository>>, id: string): string {
  const page = repo.pages.find((record) => record.id === id);
  if (page) return page.title;
  const source = repo.sources.find((record) => record.id === id);
  if (source) return source.title;
  const claim = repo.claims.find((record) => record.id === id);
  if (claim) return claim.text;
  const decision = repo.decisions.find((record) => record.id === id);
  if (decision) return decision.decision;
  return id;
}

function recordActiveNav(id: string): ServerActive {
  return id.startsWith("decision:") ? "proposals" : "pages";
}

function apiDiffHrefForRecord(id: string, search: string): string {
  const suffix = search || "";
  if (id.startsWith("page:")) return `/api/v1/pages/${encodeURIComponent(id)}/diff${suffix}`;
  if (id.startsWith("source:")) return `/api/v1/sources/${encodeURIComponent(id)}/diff${suffix}`;
  if (id.startsWith("claim:")) return `/api/v1/claims/${encodeURIComponent(id)}/diff${suffix}`;
  if (id.startsWith("decision:")) return `/api/v1/decisions/${encodeURIComponent(id)}/diff${suffix}`;
  return `/api/v1/search?q=${encodeURIComponent(id)}`;
}

export { renderClaimView, renderDecisionView, renderPageEditForm, renderSourceView } from "./record-views.ts";
