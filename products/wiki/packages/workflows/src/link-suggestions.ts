import type { PageRecord } from "@openwiki/core";
import { buildOpenWikiLinkGazetteer, extractOpenWikiTypedLinks, type OpenWikiLinkCollision, type OpenWikiTypedLinkCandidate } from "@openwiki/skills";
import { loadRepository, readPage } from "@openwiki/repo";
import { proposeEdit } from "./proposals.ts";
import type { ProposeEditResult } from "./types.ts";

const SUGGESTED_LINKS_HEADING = "## Suggested Links";

export interface SuggestPageTypedLinksInput {
  root: string;
  pageId: string;
}

export interface SuggestPageTypedLinksResult {
  page: PageRecord;
  candidates: OpenWikiTypedLinkCandidate[];
  collisions: OpenWikiLinkCollision[];
}

export interface ProposePageTypedLinksInput extends SuggestPageTypedLinksInput {
  actorId?: string;
  proposalTitle?: string;
  rationale?: string;
  abortSignal?: AbortSignal;
}

export interface ProposePageTypedLinksResult extends ProposeEditResult {
  suggestions: SuggestPageTypedLinksResult;
}

export async function suggestPageTypedLinks(input: SuggestPageTypedLinksInput): Promise<SuggestPageTypedLinksResult> {
  const repo = await loadRepository(input.root);
  const page = await readPage(repo.root, input.pageId);
  const gazetteer = buildOpenWikiLinkGazetteer({
    pages: repo.pages.map((candidate) => ({
      id: candidate.id,
      title: candidate.title,
      path: candidate.path,
      page_type: candidate.page_type,
      topics: candidate.topics,
    })),
    sources: repo.sources.map((source) => ({
      id: source.id,
      title: source.title,
      path: source.path,
      source_type: source.source_type,
    })),
    claims: repo.claims.map((claim) => ({
      id: claim.id,
      text: claim.text,
    })),
    topics: [...new Set(repo.pages.flatMap((candidate) => candidate.topics))].sort(),
  });
  const extracted = extractOpenWikiTypedLinks({
    from_id: page.id,
    path: page.path,
    body: page.body,
    gazetteer,
  });
  return {
    page,
    candidates: extracted.candidates.filter((candidate) => candidate.rule !== "wikilink" && candidate.rule !== "markdown_link"),
    collisions: extracted.collisions,
  };
}

export async function proposePageTypedLinks(input: ProposePageTypedLinksInput): Promise<ProposePageTypedLinksResult> {
  throwIfAborted(input.abortSignal);
  const suggestions = await suggestPageTypedLinks(input);
  throwIfAborted(input.abortSignal);
  if (suggestions.candidates.length === 0 && suggestions.collisions.length === 0) {
    throw new Error(`No typed link suggestions found for ${input.pageId}`);
  }
  const body = replaceSuggestedLinksSection(suggestions.page.body, renderSuggestedLinksSection(suggestions));
  const proposed = await proposeEdit({
    root: input.root,
    pageId: input.pageId,
    body,
    ...(input.proposalTitle === undefined ? {} : { proposalTitle: input.proposalTitle }),
    ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
    ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
    rationale: input.rationale ?? "OpenWiki deterministic link extraction suggested typed links for review.",
  });
  return { ...proposed, suggestions };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new Error("OpenWiki typed-link proposal creation aborted");
  }
}

function renderSuggestedLinksSection(suggestions: SuggestPageTypedLinksResult): string {
  const lines = [SUGGESTED_LINKS_HEADING, ""];
  if (suggestions.candidates.length > 0) {
    for (const candidate of suggestions.candidates) {
      lines.push(`- ${candidate.relation}: [[${candidate.to_id}]] (rule: ${candidate.rule}, confidence: ${candidate.confidence})`);
    }
  } else {
    lines.push("- No unambiguous link candidates.");
  }
  if (suggestions.collisions.length > 0) {
    lines.push("", "Ambiguous candidates:");
    for (const collision of suggestions.collisions) {
      lines.push(`- ${collision.text}: ${collision.candidate_ids.join(", ")}`);
    }
  }
  return lines.join("\n").trim();
}

function replaceSuggestedLinksSection(body: string, nextSection: string): string {
  const index = body.indexOf(SUGGESTED_LINKS_HEADING);
  if (index === -1) {
    return `${body.trimEnd()}\n\n${nextSection}\n`;
  }
  const nextHeading = body.slice(index + SUGGESTED_LINKS_HEADING.length).search(/\n##\s+/);
  if (nextHeading === -1) {
    return `${body.slice(0, index).trimEnd()}\n\n${nextSection}\n`;
  }
  const afterIndex = index + SUGGESTED_LINKS_HEADING.length + nextHeading;
  return `${body.slice(0, index).trimEnd()}\n\n${nextSection}\n\n${body.slice(afterIndex).trimStart()}`;
}
