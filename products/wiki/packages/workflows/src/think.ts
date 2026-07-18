import type { ThinkGap } from "@openwiki/core";
import { askWithCitations } from "./ask.ts";
import type { ThinkWithCitationsInput, ThinkWithCitationsResult } from "./types.ts";

const DETERMINISTIC_THINK_MODEL = "openwiki-cited-think-v1";

export async function thinkWithCitations(input: ThinkWithCitationsInput): Promise<ThinkWithCitationsResult> {
  const answer = await askWithCitations({
    ...input,
    includeExplain: input.includeExplain ?? true,
  });
  const retrieversUsed = answer.search.explain?.retrievers_used ?? [];
  return {
    ...answer,
    gaps: gapsForAnswer(answer.evidence.length, answer.citations.length),
    diagnostics: {
      synthesis: {
        provider: "deterministic",
        model: DETERMINISTIC_THINK_MODEL,
        available: true,
        fallback: true,
      },
      retrieval: {
        mode: answer.search.explain?.mode ?? "hybrid",
        retrievers_used: retrieversUsed,
        citations_required: true,
      },
    },
  };
}

export function redactThinkSearchExplainForPolicy(response: ThinkWithCitationsResult): ThinkWithCitationsResult {
  if (response.search.explain === undefined) {
    return response;
  }
  const search = { ...response.search };
  delete search.explain;
  return { ...response, search };
}

function gapsForAnswer(evidenceCount: number, citationCount: number): ThinkGap[] {
  const gaps: ThinkGap[] = [];
  if (evidenceCount === 0) {
    gaps.push({ reason: "No visible OpenWiki records matched the question." });
  }
  if (citationCount === 0) {
    gaps.push({ reason: "No citations were available for the retrieved evidence." });
  }
  return gaps;
}
