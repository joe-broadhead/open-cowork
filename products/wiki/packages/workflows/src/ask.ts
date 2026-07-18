import {
  type AnswerCitation,
  type AnswerEvidence,
  type AnswerResponse,
  type ClaimRecord,
  type OpenWikiPolicyBundle,
  type PageRecord,
  type SearchResult,
  type SourceRecord,
  tokenizeOpenWikiText,
} from "@openwiki/core";
import { loadRepository } from "@openwiki/repo";
import { canReadSourceRecord, filterSearchResponseByVisibility, type PolicyContext } from "@openwiki/policy";
import { searchWiki } from "@openwiki/search";
import type { AskWithCitationsInput } from "./types.ts";

export async function askWithCitations(input: AskWithCitationsInput): Promise<AnswerResponse> {
  const question = input.question.trim();
  if (!question) {
    throw new Error("Question cannot be empty");
  }

  const repo = await loadRepository(input.root);
  const rawSearch = await searchWiki(
    repo.root,
    {
      query: question,
      limit: input.limit ?? 5,
      types: ["page", "source", "claim"],
      include_explain: input.includeExplain ?? false,
      ...(input.persona === undefined ? {} : { persona: input.persona }),
    },
    input.policyContext === undefined ? {} : { policyContext: input.policyContext },
  );
  const search = input.policyContext === undefined ? rawSearch : filterSearchResponseByVisibility(repo, input.policyContext, rawSearch);

  const citationsById = new Map<string, AnswerCitation>();
  const evidence = search.results.map((result) => {
    const recordCitations = citationsForSearchResult(result, repo.policy, repo.pages, repo.sources, repo.claims, input.policyContext);
    for (const citation of recordCitations) {
      citationsById.set(citation.id, citation);
    }
    return evidenceForSearchResult(result, repo.pages, repo.sources, repo.claims, recordCitations, question);
  });

  const citations = [...citationsById.values()];
  return {
    question,
    answer: renderDeterministicAnswer(evidence, citations, question),
    citations,
    evidence,
    search,
  };
}

function evidenceForSearchResult(
  result: SearchResult,
  pages: PageRecord[],
  sources: SourceRecord[],
  claims: ClaimRecord[],
  citations: AnswerCitation[],
  question: string,
): AnswerEvidence {
  const text = evidenceText(result, pages, sources, claims);
  const page = result.type === "page" ? pages.find((candidate) => candidate.id === result.id) : undefined;
  const snippet = page === undefined ? extractSnippet(text, question) : extractPageSnippet(page.body, question) ?? extractSnippet(text, question);
  return {
    id: result.id,
    type: result.type,
    title: result.title,
    uri: result.uri,
    score: result.score,
    ...(result.summary === undefined ? {} : { summary: result.summary }),
    ...(snippet === undefined ? {} : { snippet }),
    citations,
  };
}

function citationsForSearchResult(
  result: SearchResult,
  policy: OpenWikiPolicyBundle,
  pages: PageRecord[],
  sources: SourceRecord[],
  claims: ClaimRecord[],
  policyContext: PolicyContext | undefined,
): AnswerCitation[] {
  if (result.type === "source") {
    const source = sources.find((candidate) => candidate.id === result.id);
    return source && sourceVisibleForCitation(source, policy, pages, sources, claims, policyContext) ? [citationFromSource(source)] : [citationFromResult(result)];
  }

  const sourceIds = new Set<string>();
  if (result.type === "page") {
    const page = pages.find((candidate) => candidate.id === result.id);
    for (const sourceId of page?.source_ids ?? []) {
      sourceIds.add(sourceId);
    }
  }
  if (result.type === "claim") {
    const claim = claims.find((candidate) => candidate.id === result.id);
    for (const sourceId of claim?.source_ids ?? []) {
      sourceIds.add(sourceId);
    }
  }
  for (const citation of result.citations) {
    if (typeof citation.source_id === "string") {
      sourceIds.add(citation.source_id);
    }
  }

  const sourceCitations = [...sourceIds]
    .map((sourceId) => sources.find((source) => source.id === sourceId))
    .filter((source): source is SourceRecord => Boolean(source))
    .filter((source) => sourceVisibleForCitation(source, policy, pages, sources, claims, policyContext))
    .map(citationFromSource);
  return sourceCitations.length > 0 ? sourceCitations : [citationFromResult(result)];
}

function sourceVisibleForCitation(
  source: SourceRecord,
  policy: OpenWikiPolicyBundle,
  pages: PageRecord[],
  sources: SourceRecord[],
  claims: ClaimRecord[],
  policyContext: PolicyContext | undefined,
): boolean {
  return policyContext === undefined ||
    canReadSourceRecord({ policy, pages, sources, claims, facts: [], takes: [], inbox: [], proposals: [], comments: [], decisions: [], events: [], runs: [] }, policyContext, source);
}

function citationFromSource(source: SourceRecord): AnswerCitation {
  return {
    id: source.id,
    type: source.type,
    title: source.title,
    uri: source.uri,
    ...(source.url === undefined ? {} : { url: source.url }),
  };
}

function citationFromResult(result: SearchResult): AnswerCitation {
  return {
    id: result.id,
    type: result.type,
    title: result.title,
    uri: result.uri,
    ...(result.url === undefined ? {} : { url: result.url }),
  };
}

function evidenceText(
  result: SearchResult,
  pages: PageRecord[],
  sources: SourceRecord[],
  claims: ClaimRecord[],
): string {
  if (result.type === "page") {
    const page = pages.find((candidate) => candidate.id === result.id);
    return [page?.body ? stripMarkdownHeadings(page.body) : undefined, page?.summary, page?.title]
      .filter(Boolean)
      .join("\n");
  }
  if (result.type === "claim") {
    const claim = claims.find((candidate) => candidate.id === result.id);
    return claim?.text ?? result.title;
  }
  if (result.type === "source") {
    const source = sources.find((candidate) => candidate.id === result.id);
    return [source?.title, source?.source_type, source?.url].filter(Boolean).join("\n");
  }
  return [result.title, result.summary].filter(Boolean).join("\n");
}

function renderDeterministicAnswer(evidence: AnswerEvidence[], citations: AnswerCitation[], question: string): string {
  if (evidence.length === 0) {
    return "OpenWiki did not find cited records that answer this question.";
  }

  const citationNumbers = new Map(citations.map((citation, index) => [citation.id, index + 1]));
  const broadIntent = operationalQuestionIntent(question);
  if (broadIntent !== undefined && evidence.every((item) => item.snippet === undefined)) {
    const labels = {
      missing: "missing context",
      changed: "recent changes",
      next: "next actions",
    } as const;
    const cited = evidence.slice(0, 3).map((item) => {
      const firstCitation = item.citations[0];
      const citationNumber = firstCitation ? citationNumbers.get(firstCitation.id) : undefined;
      return citationNumber === undefined ? item.title : `${item.title} [${citationNumber}]`;
    });
    return `OpenWiki found ${evidence.length} relevant record${evidence.length === 1 ? "" : "s"}, but they did not contain specific ${labels[broadIntent]} evidence. Add a ${labels[broadIntent]} section or supporting page. Retrieved: ${cited.join("; ")}.`;
  }
  const statements = evidence.slice(0, 3).map((item) => {
    const firstCitation = item.citations[0];
    const citationNumber = firstCitation ? citationNumbers.get(firstCitation.id) : undefined;
    const marker = citationNumber === undefined ? "" : ` [${citationNumber}]`;
    const text = item.snippet ?? item.summary ?? item.title;
    const statement =
      normalizeForComparison(text) === normalizeForComparison(item.title) ? text : `${item.title}: ${text}`;
    return `${statement}${marker}`;
  });
  return `OpenWiki found ${evidence.length} relevant record${evidence.length === 1 ? "" : "s"}. ${statements.join(" ")}`;
}

function normalizeForComparison(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function extractSnippet(text: string, query: string): string | undefined {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return undefined;
  }
  const tokens = tokenize(query).filter((token) => token.length > 2);
  const candidates = cleaned
    .split(/(?<=[.!?])\s+|#+\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const selected =
    candidates.find((sentence) => tokens.some((token) => sentence.toLowerCase().includes(token))) ?? candidates[0];
  if (!selected) {
    return undefined;
  }
  return selected.length <= 240 ? selected : `${selected.slice(0, 237).trimEnd()}...`;
}

function extractPageSnippet(markdown: string, query: string): string | undefined {
  const intent = operationalQuestionIntent(query);
  if (intent === undefined) {
    return undefined;
  }
  const sections = markdownSections(markdown);
  const matchingSections = sections.filter((section) => sectionMatchesIntent(section.heading, intent) || section.lines.some((line) => sectionMatchesIntent(line, intent)));
  const extracted = matchingSections.flatMap((section) => importantSectionLines(section.lines, intent));
  if (extracted.length === 0) {
    return undefined;
  }
  const snippet = extracted.slice(0, 4).join("; ");
  return snippet.length <= 420 ? snippet : `${snippet.slice(0, 417).trimEnd()}...`;
}

type OperationalQuestionIntent = "missing" | "changed" | "next";

function operationalQuestionIntent(question: string): OperationalQuestionIntent | undefined {
  const normalized = normalizeForComparison(question);
  if (/\b(missing|gap|gaps|lack|lacks|needed|needs|before useful|open questions?)\b/u.test(normalized)) {
    return "missing";
  }
  if (/\b(changed|change|changes|recent|since|last run|new|updated)\b/u.test(normalized)) {
    return "changed";
  }
  if (/\b(next|first|should|todo|to do|action|actions|follow up|follow-up)\b/u.test(normalized)) {
    return "next";
  }
  return undefined;
}

function markdownSections(markdown: string): Array<{ heading: string; lines: string[] }> {
  const sections: Array<{ heading: string; lines: string[] }> = [{ heading: "", lines: [] }];
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line.trim());
    if (heading) {
      sections.push({ heading: heading[2] ?? "", lines: [] });
      continue;
    }
    sections[sections.length - 1]?.lines.push(line);
  }
  return sections;
}

function sectionMatchesIntent(text: string, intent: OperationalQuestionIntent): boolean {
  const normalized = normalizeForComparison(text);
  if (intent === "missing") {
    return /\b(missing|gap|gaps|needed|needs|open question|open questions|not yet|before useful)\b/u.test(normalized);
  }
  if (intent === "changed") {
    return /\b(changed|changes|recent|since|last run|new|updated|run log|latest)\b/u.test(normalized);
  }
  return /\b(next|first|todo|to do|action|actions|follow up|follow-up|should)\b/u.test(normalized);
}

function importantSectionLines(lines: string[], intent: OperationalQuestionIntent): string[] {
  const candidates = lines
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("```"))
    .map((line) => line.replace(/^[-*+]\s+|^\d+\.\s+/u, "").trim())
    .filter(Boolean);
  const matching = candidates.filter((line) => sectionMatchesIntent(line, intent));
  return (matching.length > 0 ? matching : candidates).slice(0, 6);
}

function stripMarkdownHeadings(value: string): string {
  return value
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
}

function tokenize(value: string): string[] {
  return tokenizeOpenWikiText(value);
}
