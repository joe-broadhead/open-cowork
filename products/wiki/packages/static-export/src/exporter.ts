import { promises as fs } from "node:fs";
import { analyzeGraph, assertOpenWikiId } from "@openwiki/core";
import { listRecentChanges } from "@openwiki/git";
import { publicPathAllowed } from "@openwiki/policy";
import {
  appendEvent,
  listGraphEdges,
  listOpenQuestions,
  listTopics,
  loadRepository,
  renderPageMarkdown,
} from "@openwiki/repo";
import { buildSearchIndex, exportSearchCorpus } from "@openwiki/search";
import { copyWebAssets, pageRoute, recordRoute } from "@openwiki/web";

import {
  DEFAULT_LLMS_FULL_MAX_BYTES,
  DEFAULT_SITEMAP_SHARD_SIZE,
  DEFAULT_STATIC_HTML_PAGE_CEILING,
  type PublishStaticSiteOptions,
  type PublishStaticSiteResult,
  type StaticExportOptions,
  type StaticExportResult,
} from "./types.ts";
import { resolveStaticExportOutDir } from "./paths.ts";
import { writeFile, writeJsonl } from "./writers.ts";
import {
  renderIndexHtml,
  renderPageHtml,
  renderSourceHtml,
  renderClaimHtml,
  renderFactHtml,
  renderTakeHtml,
  renderProposalHtml,
  renderDecisionHtml,
  renderStaticGraphHtml,
  renderStaticGraphReportHtml,
  renderTopicsHtml,
  renderChangesHtml,
  renderMachineOnlyIndexHtml,
  renderAgentsIndexMarkdown,
} from "./render-pages.ts";
import {
  renderLlmsTxt,
  renderBoundedLlmsFullTxt,
  htmlRoutesForSitemap,
  writeSitemapFiles,
  numberFromEnv,
  boundedPositiveInteger,
} from "./llms-sitemap.ts";
import { openApiDocument } from "./openapi.ts";
import { mcpManifest } from "./mcp-manifest.ts";
import { replaceStaticExportDirectory, runStaticPublishTransaction, temporaryStaticExportDir } from "./publish-transaction.ts";
import {
  claimPublicAllowed,
  factPublicAllowed,
  proposalPublicAllowed,
  publicDecisionAllowed,
  eventPublicAllowed,
  runPublicAllowed,
  publicTopicSummaries,
  publicOpenQuestionRecords,
  publicGraphIndex,
  publicRecentChangesResponse,
  sourcePublicAllowed,
  takePublicAllowed,
} from "./public-filter.ts";

export async function publishStaticSite(options: PublishStaticSiteOptions): Promise<PublishStaticSiteResult> {
  const actorId = options.actorId ?? "actor:user:local";
  assertOpenWikiId(actorId, "actor");
  return runStaticPublishTransaction({ ...options, actorId }, {
    exportStaticSite,
    loadRepository,
    appendEvent,
  });
}

export async function exportStaticSite(options: StaticExportOptions): Promise<StaticExportResult> {
  const repo = await loadRepository(options.root);
  const outDir = await resolveStaticExportOutDir(repo.root, options.outDir);
  await buildSearchIndex(repo.root);
  const exportDir = temporaryStaticExportDir(outDir);
  await fs.rm(exportDir, { recursive: true, force: true });
  await fs.mkdir(exportDir, { recursive: true });
  try {
    const result = await renderStaticSite(repo, exportDir, outDir, options);
    await replaceStaticExportDirectory(exportDir, outDir);
    return result;
  } catch (error) {
    await fs.rm(exportDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function renderStaticSite(
  repo: Awaited<ReturnType<typeof loadRepository>>,
  outDir: string,
  finalOutDir: string,
  options: StaticExportOptions,
): Promise<StaticExportResult> {
  const baseUrl = (options.baseUrl ?? "").replace(/\/+$/, "");
  const files: string[] = [];
  const publicPages = repo.pages.filter((page) => publicPathAllowed(repo.policy, page.path));
  const publicSources = repo.sources.filter((source) => sourcePublicAllowed(source) && publicPathAllowed(repo.policy, source.path));
  const publicClaims = repo.claims.filter((claim) => claimPublicAllowed(repo, claim, publicSources));
  const publicFacts = repo.facts.filter((fact) => factPublicAllowed(repo, fact, publicSources, publicClaims));
  const publicTakes = repo.takes.filter((take) => takePublicAllowed(repo, take, publicSources, publicClaims));
  const publicProposals = repo.proposals.filter((proposal) => proposalPublicAllowed(repo, proposal, publicSources));
  const publicProposalIds = new Set(publicProposals.map((proposal) => proposal.id));
  const publicComments = repo.comments.filter((comment) => publicProposalIds.has(comment.proposal_id));
  const publicDecisions = repo.decisions.filter((decision) => publicDecisionAllowed(repo, decision, publicProposalIds));
  const publicEvents = repo.events.filter((event) => eventPublicAllowed(repo, event, publicProposalIds, publicSources));
  const publicRuns = repo.runs.filter((run) => runPublicAllowed(repo, run));
  const publicTopics = publicTopicSummaries(await listTopics(repo.root), publicPages, publicSources, publicClaims);
  const publicOpenQuestions = publicOpenQuestionRecords(await listOpenQuestions(repo.root), publicPages);
  const publicRecentChanges = publicRecentChangesResponse(repo, await listRecentChanges(repo.root, 50));
  const publicGraph = publicGraphIndex(repo, await listGraphEdges(repo.root), publicProposalIds, publicSources, new Set(publicClaims.map((claim) => claim.id)), new Set(publicTakes.map((take) => take.id)));
  const publicGraphReport = analyzeGraph(publicGraph, { limit: 12 });
  const searchCorpus = await exportSearchCorpus(repo.root, { visibility: "public" });
  const webAssets = await copyWebAssets(outDir, files);
  const htmlPageCeiling = boundedPositiveInteger(options.htmlPageCeiling ?? numberFromEnv("OPENWIKI_STATIC_HTML_PAGE_CEILING") ?? DEFAULT_STATIC_HTML_PAGE_CEILING, "htmlPageCeiling");
  const sitemapShardSize = boundedPositiveInteger(options.sitemapShardSize ?? numberFromEnv("OPENWIKI_STATIC_SITEMAP_SHARD_SIZE") ?? DEFAULT_SITEMAP_SHARD_SIZE, "sitemapShardSize");
  const llmsFullMaxBytes = boundedPositiveInteger(options.llmsFullMaxBytes ?? numberFromEnv("OPENWIKI_LLMS_FULL_MAX_BYTES") ?? DEFAULT_LLMS_FULL_MAX_BYTES, "llmsFullMaxBytes");
  const htmlPageCount = 5 + publicPages.length + publicSources.length + publicClaims.length + publicFacts.length + publicTakes.length + publicProposals.length + publicDecisions.length;
  const htmlMode = htmlPageCount <= htmlPageCeiling ? "full" : "machine-only";
  const warnings: string[] = [];
  if (htmlMode === "machine-only") {
    warnings.push(`Static HTML export skipped ${htmlPageCount} human pages because it exceeds the configured ceiling of ${htmlPageCeiling}. Machine-readable exports are complete.`);
  }

  if (htmlMode === "full") {
    await writeFile(outDir, files, "index.html", renderIndexHtml(repo.config.title, publicPages, publicSources, publicClaims, publicFacts, publicTakes, publicTopics.topics, publicRecentChanges, publicGraph, webAssets));
    await writeFile(outDir, files, "graph.html", renderStaticGraphHtml(repo.config.title, publicGraph, webAssets));
    await writeFile(outDir, files, "graph-report.html", renderStaticGraphReportHtml(repo.config.title, publicGraphReport, webAssets));
    await writeFile(outDir, files, "topics.html", renderTopicsHtml(repo.config.title, publicTopics.topics, publicPages, webAssets));
    await writeFile(outDir, files, "changes.html", renderChangesHtml(repo.config.title, publicRecentChanges, webAssets));
  } else {
    await writeFile(outDir, files, "index.html", renderMachineOnlyIndexHtml(repo.config.title, htmlPageCount, htmlPageCeiling, webAssets));
  }
  await writeFile(outDir, files, "search-index.json", searchCorpus);
  await writeJsonl(outDir, files, "search-records.jsonl", searchCorpus.records);
  await writeJsonl(outDir, files, "pages.jsonl", publicPages);
  await writeJsonl(outDir, files, "sources.jsonl", publicSources);
  await writeJsonl(outDir, files, "claims.jsonl", publicClaims);
  await writeJsonl(outDir, files, "facts.jsonl", publicFacts);
  await writeJsonl(outDir, files, "takes.jsonl", publicTakes);
  await writeJsonl(outDir, files, "proposals.jsonl", publicProposals);
  await writeJsonl(outDir, files, "proposal-comments.jsonl", publicComments);
  await writeJsonl(outDir, files, "decisions.jsonl", publicDecisions);
  await writeJsonl(outDir, files, "events.jsonl", publicEvents);
  await writeJsonl(outDir, files, "runs.jsonl", publicRuns);
  await writeFile(outDir, files, "topics.json", publicTopics);
  await writeFile(outDir, files, "open-questions.json", publicOpenQuestions);
  await writeFile(outDir, files, "graph.json", publicGraph);
  await writeFile(outDir, files, "graph-report.json", publicGraphReport);
  await writeFile(outDir, files, "agents/index.md", renderAgentsIndexMarkdown(repo.config.title, publicGraphReport, publicGraph));
  await writeFile(outDir, files, "recent-changes.json", publicRecentChanges);
  await writeFile(outDir, files, "proposals.json", { proposals: publicProposals });
  await writeFile(outDir, files, "decisions.json", { decisions: publicDecisions });
  await writeFile(outDir, files, "events.json", { events: publicEvents.slice(0, 50) });
  await writeFile(outDir, files, "runs.json", { runs: publicRuns.slice(0, 50) });
  await writeFile(outDir, files, "llms.txt", renderLlmsTxt(repo.config.title, publicPages, baseUrl, false));
  const llmsFull = renderBoundedLlmsFullTxt(repo.config.title, publicPages, baseUrl, llmsFullMaxBytes);
  if (llmsFull.truncated) {
    warnings.push(`llms-full.txt was reduced because the full body export exceeded ${llmsFullMaxBytes} bytes. Use pages.jsonl and adjacent Markdown files for complete content.`);
  }
  await writeFile(outDir, files, "llms-full.txt", llmsFull.body);
  await writeFile(outDir, files, "openapi.json", openApiDocument());
  await writeFile(outDir, files, "mcp-manifest.json", mcpManifest());

  for (const page of publicPages) {
    const route = pageRoute(page.id);
    if (htmlMode === "full") {
      await writeFile(outDir, files, `${route}.html`, renderPageHtml(repo.config.title, page, publicPages, publicSources, publicClaims, publicGraph, webAssets));
    }
    await writeFile(outDir, files, `${route}.md`, renderPageMarkdown(page));
    await writeFile(outDir, files, `${route}.json`, page);
  }
  for (const source of publicSources) {
    if (htmlMode === "full") {
      await writeFile(outDir, files, `${recordRoute(source.id)}.html`, renderSourceHtml(repo.config.title, source, publicPages, publicClaims, publicGraph, webAssets));
    }
    await writeFile(outDir, files, `${recordRoute(source.id)}.json`, source);
  }
  for (const claim of publicClaims) {
    if (htmlMode === "full") {
      await writeFile(outDir, files, `${recordRoute(claim.id)}.html`, renderClaimHtml(repo.config.title, claim, publicPages, publicSources, publicGraph, webAssets));
    }
    await writeFile(outDir, files, `${recordRoute(claim.id)}.json`, claim);
  }
  for (const fact of publicFacts) {
    if (htmlMode === "full") {
      await writeFile(outDir, files, `${recordRoute(fact.id)}.html`, renderFactHtml(repo.config.title, fact, publicPages, publicSources, publicClaims, publicGraph, webAssets));
    }
    await writeFile(outDir, files, `${recordRoute(fact.id)}.json`, fact);
  }
  for (const take of publicTakes) {
    if (htmlMode === "full") {
      await writeFile(outDir, files, `${recordRoute(take.id)}.html`, renderTakeHtml(repo.config.title, take, publicPages, publicSources, publicClaims, publicGraph, webAssets));
    }
    await writeFile(outDir, files, `${recordRoute(take.id)}.json`, take);
  }
  for (const proposal of publicProposals) {
    if (htmlMode === "full") {
      await writeFile(outDir, files, `${recordRoute(proposal.id)}.html`, renderProposalHtml(repo.config.title, proposal, publicPages, publicComments, publicDecisions, publicGraph, webAssets));
    }
    await writeFile(outDir, files, `${recordRoute(proposal.id)}.json`, proposal);
  }
  for (const decision of publicDecisions) {
    if (htmlMode === "full") {
      await writeFile(outDir, files, `${recordRoute(decision.id)}.html`, renderDecisionHtml(repo.config.title, decision, publicProposals, publicPages, publicGraph, webAssets));
    }
    await writeFile(outDir, files, `${recordRoute(decision.id)}.json`, decision);
  }

  const sitemapUrls = htmlMode === "full" ? htmlRoutesForSitemap(publicPages, publicSources, publicClaims, publicFacts, publicTakes, publicProposals, publicDecisions) : ["index.html"];
  const sitemapFiles = await writeSitemapFiles(outDir, files, sitemapUrls, baseUrl, sitemapShardSize);
  await writeFile(outDir, files, "static-export-report.json", {
    html_mode: htmlMode,
    html_page_count: htmlPageCount,
    html_page_ceiling: htmlPageCeiling,
    sitemap_files: sitemapFiles,
    llms_full_max_bytes: llmsFullMaxBytes,
    llms_full_truncated: llmsFull.truncated,
    warnings,
  });
  files.sort();
  return { root: repo.root, outDir: finalOutDir, files, html_mode: htmlMode, html_page_count: htmlPageCount, html_page_ceiling: htmlPageCeiling, sitemap_files: sitemapFiles, warnings };
}
