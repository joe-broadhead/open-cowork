import type { IndexRecord } from "./records.ts";
import { tokenizeOpenWikiText } from "@openwiki/core";
import type { ResolvedSearchConfig } from "./types.ts";

export function chunkText(value: string, maxChars: number): string[] {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }
  const paragraphs = normalized.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    const next = current ? `${current}\n\n${paragraph}` : paragraph;
    if (next.length <= maxChars) {
      current = next;
      continue;
    }
    if (current) {
      chunks.push(current);
      current = "";
    }
    if (paragraph.length <= maxChars) {
      current = paragraph;
      continue;
    }
    for (let index = 0; index < paragraph.length; index += maxChars) {
      chunks.push(paragraph.slice(index, index + maxChars));
    }
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

export function summaryFromText(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= 180) {
    return compact;
  }
  return `${compact.slice(0, 177)}...`;
}

export function ftsQueryFromText(query: string): string {
  return tokenizeOpenWikiText(query)
    .map((token) => `${token}*`)
    .join(" ");
}

export function tokenOverlap(tokens: string[], value: string): number {
  const haystack = value.toLowerCase();
  return tokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}

export function weightedFieldScore(record: IndexRecord, scoreField: (value: string) => number): number {
  const fields: Array<[string, number]> = [
    [record.title, 4.0],
    [record.summary, 2.0],
    [record.topics.join(" "), 2.0],
    [record.path, 1.5],
    [record.body, 1.0],
  ];
  return fields.reduce((score, [value, weight]) => score + scoreField(value) * weight, 0);
}

export function ngramsForText(value: string, ngramMin: number): Set<string> {
  const grams = new Set<string>();
  for (const token of tokenizeOpenWikiText(value)) {
    if (token.length < ngramMin) {
      continue;
    }
    for (let index = 0; index <= token.length - ngramMin; index += 1) {
      grams.add(token.slice(index, index + ngramMin));
    }
  }
  return grams;
}

export function ngramSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const gram of left) {
    if (right.has(gram)) {
      overlap += 1;
    }
  }
  return (2 * overlap) / (left.size + right.size);
}

export function fuzzyTokenScore(
  queryTokens: string[],
  candidateTokens: string[],
  searchConfig: ResolvedSearchConfig,
): number {
  const candidates = [...new Set(candidateTokens)]
    .filter((token) => token.length >= searchConfig.fuzzy_min_length)
    .slice(0, 500);
  if (candidates.length === 0) {
    return 0;
  }
  let score = 0;
  for (const queryToken of queryTokens) {
    const maxDistance = fuzzyDistance(queryToken, searchConfig);
    let best = 0;
    for (const candidate of candidates) {
      if (Math.abs(candidate.length - queryToken.length) > maxDistance) {
        continue;
      }
      const distance = levenshteinDistance(queryToken, candidate, maxDistance);
      if (distance <= maxDistance) {
        best = Math.max(best, 1 - distance / (maxDistance + 1));
      }
      if (best === 1) {
        break;
      }
    }
    score += best;
  }
  return score / queryTokens.length;
}

function fuzzyDistance(token: string, searchConfig: ResolvedSearchConfig): number {
  if (token.length <= searchConfig.fuzzy_mid_length) {
    return 1;
  }
  return searchConfig.fuzzy_max_distance;
}

function levenshteinDistance(left: string, right: string, maxDistance: number): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    let rowMinimum = current[0] ?? leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      const value = Math.min(
        (previous[rightIndex] ?? 0) + 1,
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + cost,
      );
      current[rightIndex] = value;
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > maxDistance) {
      return maxDistance + 1;
    }
    previous = current;
  }
  return previous[right.length] ?? maxDistance + 1;
}

export function matchedFields(record: IndexRecord, query: string): string[] {
  const tokens = tokenizeOpenWikiText(query);
  const fields: Array<[string, string]> = [
    ["title", record.title],
    ["summary", record.summary],
    ["body", record.body],
    ["path", record.path],
  ];
  return fields
    .filter(([, value]) => tokens.some((token) => value.toLowerCase().includes(token)))
    .map(([field]) => field);
}

export function highlightsForRecord(record: IndexRecord, query: string): Record<string, string[]> {
  const tokens = tokenizeOpenWikiText(query);
  if (tokens.length === 0) {
    return {};
  }
  const fields: Array<[string, string]> = [
    ["title", record.title],
    ["summary", record.summary],
    ["body", record.body],
    ["path", record.path],
  ];
  const highlights: Record<string, string[]> = {};
  for (const [field, value] of fields) {
    const snippets = snippetsForValue(value, tokens);
    if (snippets.length > 0) {
      highlights[field] = snippets;
    }
  }
  return highlights;
}

function snippetsForValue(value: string, tokens: string[]): string[] {
  const compact = value.replace(/\s+/g, " ").trim();
  const lower = compact.toLowerCase();
  const snippets: string[] = [];
  for (const token of tokens) {
    const index = lower.indexOf(token);
    if (index === -1) {
      continue;
    }
    const start = Math.max(0, index - 48);
    const end = Math.min(compact.length, index + token.length + 96);
    const prefix = start === 0 ? "" : "...";
    const suffix = end === compact.length ? "" : "...";
    const snippet = prefix + compact.slice(start, end) + suffix;
    if (!snippets.includes(snippet)) {
      snippets.push(snippet);
    }
    if (snippets.length >= 3) {
      break;
    }
  }
  return snippets;
}

export function appendMapValue(map: Map<string, string[]>, key: string, value: string): void {
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
}

export function roundScore(value: number): number {
  return Number(value.toFixed(6));
}

export function isRecoverableIndexError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("no such table") ||
    message.includes("stale search index") ||
    message.includes("database disk image is malformed") ||
    message.includes("unable to open database file")
  );
}
