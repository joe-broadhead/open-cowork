
import type { ClaimRecord, DecisionRecord, FactRecord, PageRecord, ProposalRecord, SourceRecord, TakeRecord } from "@openwiki/core";
import { escapeHtml, pageRoute, recordRoute } from "@openwiki/web";

import { writeFile } from "./writers.ts";

export function renderLlmsTxt(
  title: string,
  pages: Array<{ id: string; title: string; summary?: string; body: string }>,
  baseUrl: string,
  includeBody: boolean,
): string {
  const lines = [`# ${title}`, "", "## Pages", ""];
  for (const page of pages) {
    const route = `${baseUrl}/${pageRoute(page.id)}.md`.replace(/^\/+/, "");
    lines.push(`- ${page.title}: ${route}`);
    if (page.summary) {
      lines.push(`  ${page.summary}`);
    }
    if (includeBody) {
      lines.push("", page.body, "");
    }
  }
  return `${lines.join("\n")}\n`;
}

export function renderBoundedLlmsFullTxt(
  title: string,
  pages: Array<{ id: string; title: string; summary?: string; body: string }>,
  baseUrl: string,
  maxBytes: number,
): { body: string; truncated: boolean } {
  const full = renderLlmsTxt(title, pages, baseUrl, true);
  if (Buffer.byteLength(full, "utf8") <= maxBytes) {
    return { body: full, truncated: false };
  }
  const compact = renderLlmsTxt(title, pages, baseUrl, false);
  const body = [
    `# ${title}`,
    "",
    "> llms-full.txt was reduced because the complete body export exceeded the configured byte limit.",
    "> Use pages.jsonl and adjacent .md files for complete page content.",
    "",
    compact.replace(/^# .+?\n\n/s, ""),
  ].join("\n");
  return { body: `${body.trimEnd()}\n`, truncated: true };
}

export function htmlRoutesForSitemap(
  pages: PageRecord[],
  sources: SourceRecord[],
  claims: ClaimRecord[],
  facts: FactRecord[],
  takes: TakeRecord[],
  proposals: ProposalRecord[],
  decisions: DecisionRecord[],
): string[] {
  return [
    "index.html",
    "graph.html",
    "topics.html",
    "changes.html",
    ...pages.map((page) => `${pageRoute(page.id)}.html`),
    ...sources.map((source) => `${recordRoute(source.id)}.html`),
    ...claims.map((claim) => `${recordRoute(claim.id)}.html`),
    ...facts.map((fact) => `${recordRoute(fact.id)}.html`),
    ...takes.map((take) => `${recordRoute(take.id)}.html`),
    ...proposals.map((proposal) => `${recordRoute(proposal.id)}.html`),
    ...decisions.map((decision) => `${recordRoute(decision.id)}.html`),
  ];
}

export async function writeSitemapFiles(outDir: string, files: string[], routes: string[], baseUrl: string, shardSize: number): Promise<string[]> {
  const uniqueRoutes = [...new Set(routes)].sort();
  const shardFiles: string[] = [];
  for (let index = 0; index < uniqueRoutes.length; index += shardSize) {
    const shardNumber = shardFiles.length + 1;
    const shardPath = `sitemaps/sitemap-${shardNumber}.xml`;
    const shardRoutes = uniqueRoutes.slice(index, index + shardSize);
    await writeFile(outDir, files, shardPath, renderSitemapUrlSet(shardRoutes, baseUrl));
    shardFiles.push(shardPath);
  }
  await writeFile(outDir, files, "sitemap.xml", renderSitemapIndex(shardFiles, baseUrl));
  return ["sitemap.xml", ...shardFiles];
}

function renderSitemapIndex(shardFiles: string[], baseUrl: string): string {
  const entries = shardFiles
    .map((file) => `  <sitemap><loc>${escapeXml(siteUrl(baseUrl, file))}</loc></sitemap>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</sitemapindex>
`;
}

function renderSitemapUrlSet(routes: string[], baseUrl: string): string {
  const urls = routes
    .map((route) => `  <url><loc>${escapeXml(siteUrl(baseUrl, route))}</loc></url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}

function siteUrl(baseUrl: string, route: string): string {
  return baseUrl ? `${baseUrl}/${route}` : route;
}

export function numberFromEnv(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  return Number(value);
}

export function boundedPositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

export function escapeXml(value: string): string {
  return escapeHtml(value).replace(/'/g, "&apos;");
}
