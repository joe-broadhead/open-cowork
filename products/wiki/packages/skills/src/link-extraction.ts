import path from "node:path";

export type OpenWikiTypedLinkRelation =
  | "references"
  | "mentions"
  | "depends_on"
  | "blocks"
  | "blocked_by"
  | "supports"
  | "contradicts"
  | "supersedes"
  | "related_to";

export type OpenWikiTypedLinkRule =
  | "wikilink"
  | "markdown_link"
  | "frontmatter_relation"
  | "known_alias"
  | "bare_slug"
  | "regex_relation";

export interface OpenWikiLinkGazetteerEntry {
  id: string;
  record_type: string;
  title: string;
  path?: string;
  aliases?: string[];
}

export interface OpenWikiLinkGazetteer {
  entries: OpenWikiLinkGazetteerEntry[];
  aliases: Array<{ alias: string; normalized: string; entry_id: string }>;
}

export interface OpenWikiPreparedLinkGazetteer {
  gazetteer: OpenWikiLinkGazetteer;
  entriesById: ReadonlyMap<string, OpenWikiLinkGazetteerEntry>;
  entriesByPath: ReadonlyMap<string, readonly OpenWikiLinkGazetteerEntry[]>;
  entriesByPathSuffix: ReadonlyMap<string, readonly OpenWikiLinkGazetteerEntry[]>;
  aliasesByNormalized: ReadonlyMap<string, readonly OpenWikiLinkGazetteerEntry[]>;
  sortedAliases: readonly string[];
  candidateAliasSet: ReadonlySet<string>;
  maxAliasTokenCount: number;
}

export interface OpenWikiTypedLinkCandidate {
  from_id: string;
  to_id: string;
  relation: OpenWikiTypedLinkRelation;
  path: string;
  rule: OpenWikiTypedLinkRule;
  confidence: number;
  already_present: boolean;
  span: { start: number; end: number };
  anchor?: string;
  label?: string;
  context?: string;
}

export interface OpenWikiLinkCollision {
  text: string;
  path: string;
  candidate_ids: string[];
  span: { start: number; end: number };
  rule: OpenWikiTypedLinkRule;
}

export interface OpenWikiTypedLinkExtractionResult {
  candidates: OpenWikiTypedLinkCandidate[];
  collisions: OpenWikiLinkCollision[];
}

export interface OpenWikiTypedLinkExtractionInput {
  from_id: string;
  path: string;
  body: string;
  frontmatter?: Record<string, unknown>;
  gazetteer: OpenWikiLinkGazetteer;
  existing_edges?: Array<{ from_id: string; to_id: string }>;
}

interface SlugSearchIndex {
  text: string;
  spans: Array<{ start: number; end: number }>;
}

const RELATION_FIELDS: Record<string, OpenWikiTypedLinkRelation> = {
  related: "related_to",
  related_ids: "related_to",
  references: "references",
  reference_ids: "references",
  mentions: "mentions",
  mention_ids: "mentions",
  depends_on: "depends_on",
  depends_on_ids: "depends_on",
  blocks: "blocks",
  blocked_by: "blocked_by",
  supports: "supports",
  contradicts: "contradicts",
  supersedes: "supersedes",
  replaces: "supersedes",
};

const RELATION_LINE_PATTERNS: Array<{ relation: OpenWikiTypedLinkRelation; pattern: RegExp }> = [
  { relation: "depends_on", pattern: /\bdepends\s+on\b/i },
  { relation: "blocks", pattern: /\bblocks\b/i },
  { relation: "blocked_by", pattern: /\bblocked\s+by\b/i },
  { relation: "supports", pattern: /\bsupports\b/i },
  { relation: "contradicts", pattern: /\bcontradicts\b/i },
  { relation: "supersedes", pattern: /\bsupersedes|replaces\b/i },
];

export function buildOpenWikiLinkGazetteer(input: {
  pages?: Array<{ id: string; title: string; path?: string; page_type?: string; topics?: string[] }>;
  sources?: Array<{ id: string; title: string; path?: string; source_type?: string }>;
  claims?: Array<{ id: string; text: string }>;
  topics?: string[];
  entries?: OpenWikiLinkGazetteerEntry[];
}): OpenWikiLinkGazetteer {
  const entries: OpenWikiLinkGazetteerEntry[] = [
    ...(input.entries ?? []),
    ...(input.pages ?? []).map((page): OpenWikiLinkGazetteerEntry => ({
      id: page.id,
      record_type: "page",
      title: page.title,
      ...(page.path === undefined ? {} : { path: page.path }),
      aliases: uniqueStrings([
        page.title,
        idTail(page.id),
        page.path?.replace(/\.md$/u, ""),
        page.path?.split("/").at(-1)?.replace(/\.md$/u, ""),
        ...(page.topics ?? []),
      ]),
    })),
    ...(input.sources ?? []).map((source): OpenWikiLinkGazetteerEntry => ({
      id: source.id,
      record_type: "source",
      title: source.title,
      ...(source.path === undefined ? {} : { path: source.path }),
      aliases: uniqueStrings([source.title, idTail(source.id)]),
    })),
    ...(input.claims ?? []).map((claim): OpenWikiLinkGazetteerEntry => ({
      id: claim.id,
      record_type: "claim",
      title: claim.text,
      aliases: [claim.id],
    })),
    ...(input.topics ?? []).map((topic): OpenWikiLinkGazetteerEntry => ({
      id: "topic:" + slugText(topic),
      record_type: "topic",
      title: topic,
      aliases: [topic, slugText(topic)],
    })),
  ];
  const aliases = entries.flatMap((entry) => uniqueStrings([entry.id, entry.title, entry.path, ...(entry.aliases ?? [])])
    .filter((alias) => alias.trim().length > 1)
    .map((alias) => ({ alias, normalized: normalizeAlias(alias), entry_id: entry.id })));
  return { entries, aliases };
}

export function prepareOpenWikiLinkGazetteer(gazetteer: OpenWikiLinkGazetteer): OpenWikiPreparedLinkGazetteer {
  const entriesById = new Map(gazetteer.entries.map((entry) => [entry.id, entry]));
  const entriesByPath = new Map<string, OpenWikiLinkGazetteerEntry[]>();
  const entriesByPathSuffix = new Map<string, OpenWikiLinkGazetteerEntry[]>();
  for (const entry of gazetteer.entries) {
    if (entry.path === undefined) {
      continue;
    }
    const normalizedPath = path.posix.normalize(entry.path);
    entriesByPath.set(normalizedPath, uniqueEntries([...(entriesByPath.get(normalizedPath) ?? []), entry]));
    for (const suffix of pathSuffixes(normalizedPath)) {
      entriesByPathSuffix.set(suffix, uniqueEntries([...(entriesByPathSuffix.get(suffix) ?? []), entry]));
    }
  }
  const aliasesByNormalized = aliasMap(gazetteer, entriesById);
  const sortedAliases = [...aliasesByNormalized.keys()]
    .filter((alias) => alias.length >= 4)
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
  const candidateAliasSet = new Set(sortedAliases);
  return {
    gazetteer,
    entriesById,
    entriesByPath,
    entriesByPathSuffix,
    aliasesByNormalized,
    sortedAliases,
    candidateAliasSet,
    maxAliasTokenCount: sortedAliases.length === 0 ? 0 : Math.min(8, Math.max(...sortedAliases.map(aliasTokenCount))),
  };
}

export function extractOpenWikiTypedLinks(input: OpenWikiTypedLinkExtractionInput, preparedGazetteer = prepareOpenWikiLinkGazetteer(input.gazetteer)): OpenWikiTypedLinkExtractionResult {
  const maskedBody = maskMarkdownCode(input.body);
  const existing = new Set((input.existing_edges ?? []).map((edge) => edge.from_id + "\u0000" + edge.to_id));
  const candidates: OpenWikiTypedLinkCandidate[] = [];
  const collisions: OpenWikiLinkCollision[] = [];
  const occupied: Array<{ start: number; end: number }> = [];
  const pushCandidate = (candidate: Omit<OpenWikiTypedLinkCandidate, "already_present">): void => {
    if (candidate.to_id === input.from_id) {
      return;
    }
    candidates.push({
      ...candidate,
      already_present: existing.has(candidate.from_id + "\u0000" + candidate.to_id),
    });
    occupied.push(candidate.span);
  };
  const resolve = (text: string, span: { start: number; end: number }, rule: OpenWikiTypedLinkRule, fromPath?: string): OpenWikiLinkGazetteerEntry | undefined => {
    const matches = resolveGazetteerEntry(preparedGazetteer, text, fromPath);
    if (matches.length > 1) {
      collisions.push({ text, path: input.path, candidate_ids: matches.map((entry) => entry.id).sort(), span, rule });
      return undefined;
    }
    return matches[0];
  };

  for (const link of markdownLinks(maskedBody)) {
    const target = resolve(link.target, link.span, "markdown_link", input.path);
    if (target === undefined) {
      continue;
    }
    pushCandidate({ from_id: input.from_id, to_id: target.id, relation: "references", path: input.path, rule: "markdown_link", confidence: 0.98, span: link.span, anchor: link.target, label: link.label });
  }
  for (const link of wikiLinks(maskedBody)) {
    const target = resolve(link.target, link.span, "wikilink");
    if (target === undefined) {
      continue;
    }
    pushCandidate({ from_id: input.from_id, to_id: target.id, relation: "references", path: input.path, rule: "wikilink", confidence: 0.99, span: link.span, anchor: link.target, label: link.label });
  }
  for (const relation of frontmatterRelations(input.frontmatter ?? {})) {
    const target = resolve(relation.target, { start: 0, end: 0 }, "frontmatter_relation");
    if (target === undefined) {
      continue;
    }
    pushCandidate({ from_id: input.from_id, to_id: target.id, relation: relation.relation, path: input.path, rule: "frontmatter_relation", confidence: 1, span: { start: 0, end: 0 }, anchor: relation.field });
  }
  for (const regexCandidate of regexRelationCandidates(maskedBody, input, preparedGazetteer, occupied)) {
    const target = resolve(regexCandidate.text, regexCandidate.span, "regex_relation");
    if (target === undefined) {
      continue;
    }
    pushCandidate({ from_id: input.from_id, to_id: target.id, relation: regexCandidate.relation, path: input.path, rule: "regex_relation", confidence: 0.72, span: regexCandidate.span, context: regexCandidate.context });
  }
  for (const mention of bareAliasCandidates(maskedBody, input, preparedGazetteer, occupied)) {
    const target = resolve(mention.text, mention.span, mention.rule);
    if (target === undefined) {
      continue;
    }
    pushCandidate({ from_id: input.from_id, to_id: target.id, relation: "mentions", path: input.path, rule: mention.rule, confidence: mention.rule === "bare_slug" ? 0.42 : 0.5, span: mention.span, context: mention.context });
  }

  return {
    candidates: dedupeCandidates(candidates),
    collisions: dedupeCollisions(collisions),
  };
}

function markdownLinks(body: string): Array<{ label: string; target: string; span: { start: number; end: number } }> {
  const links: Array<{ label: string; target: string; span: { start: number; end: number } }> = [];
  const pattern = /\[([^\]]+)\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    const rawTarget = (match[2] ?? "").trim();
    if (isExternalLink(rawTarget)) {
      continue;
    }
    links.push({ label: (match[1] ?? "").trim(), target: stripLinkTarget(rawTarget), span: { start: match.index, end: pattern.lastIndex } });
  }
  return links;
}

function wikiLinks(body: string): Array<{ label: string; target: string; span: { start: number; end: number } }> {
  const links: Array<{ label: string; target: string; span: { start: number; end: number } }> = [];
  const pattern = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    const target = stripLinkTarget((match[1] ?? "").trim());
    if (target.length > 0) {
      links.push({ label: ((match[2] ?? match[1]) ?? "").trim(), target, span: { start: match.index, end: pattern.lastIndex } });
    }
  }
  return links;
}

function frontmatterRelations(frontmatter: Record<string, unknown>): Array<{ field: string; relation: OpenWikiTypedLinkRelation; target: string }> {
  const output: Array<{ field: string; relation: OpenWikiTypedLinkRelation; target: string }> = [];
  for (const [field, value] of Object.entries(frontmatter)) {
    const relation = RELATION_FIELDS[field];
    if (relation === undefined) {
      continue;
    }
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (typeof item === "string" && item.trim().length > 0) {
        output.push({ field, relation, target: item.trim() });
      }
    }
  }
  return output;
}

function regexRelationCandidates(
  body: string,
  input: OpenWikiTypedLinkExtractionInput,
  preparedGazetteer: OpenWikiPreparedLinkGazetteer,
  occupied: Array<{ start: number; end: number }>,
): Array<{ text: string; relation: OpenWikiTypedLinkRelation; span: { start: number; end: number }; context: string }> {
  const output: Array<{ text: string; relation: OpenWikiTypedLinkRelation; span: { start: number; end: number }; context: string }> = [];
  const lines = body.split("\n");
  let offset = 0;
  for (const line of lines) {
    for (const item of RELATION_LINE_PATTERNS) {
      const match = item.pattern.exec(line);
      if (match === null) {
        continue;
      }
      const tailStart = (match.index ?? 0) + match[0].length;
      const tail = line.slice(tailStart);
      const candidate = longestAliasInText(tail, preparedGazetteer, input.from_id);
      if (candidate === undefined) {
        continue;
      }
      const span = { start: offset + tailStart + candidate.start, end: offset + tailStart + candidate.end };
      if (!spansOverlap(span, occupied)) {
        output.push({ text: candidate.text, relation: item.relation, span, context: line.trim().slice(0, 180) });
      }
    }
    offset += line.length + 1;
  }
  return output;
}

function bareAliasCandidates(
  body: string,
  input: OpenWikiTypedLinkExtractionInput,
  preparedGazetteer: OpenWikiPreparedLinkGazetteer,
  occupied: Array<{ start: number; end: number }>,
): Array<{ text: string; rule: OpenWikiTypedLinkRule; span: { start: number; end: number }; context: string }> {
  const output: Array<{ text: string; rule: OpenWikiTypedLinkRule; span: { start: number; end: number }; context: string }> = [];
  const searchable = slugSearchIndex(body);
  if (preparedGazetteer.candidateAliasSet.size === 0 || preparedGazetteer.maxAliasTokenCount === 0) {
    return output;
  }
  const tokens = slugSearchTokens(searchable);
  for (let startIndex = 0; startIndex < tokens.length; startIndex += 1) {
    for (let width = Math.min(preparedGazetteer.maxAliasTokenCount, tokens.length - startIndex); width >= 1; width -= 1) {
      const selectedTokens = tokens.slice(startIndex, startIndex + width);
      const normalized = selectedTokens.map((token) => token.text).join("-");
      if (!preparedGazetteer.candidateAliasSet.has(normalized) || (preparedGazetteer.aliasesByNormalized.get(normalized) ?? []).every((entry) => entry.id === input.from_id)) {
        continue;
      }
      const span = searchIndexSpan(searchable, selectedTokens[0]?.start ?? 0, selectedTokens.at(-1)?.end ?? 0);
      if (span === undefined || spansOverlap(span, occupied) || output.some((item) => spansOverlap(item.span, [span]))) {
        continue;
      }
      output.push({ text: normalized, rule: normalized.includes("-") ? "bare_slug" : "known_alias", span, context: body.slice(Math.max(0, span.start - 60), Math.min(body.length, span.end + 60)).trim() });
      break;
    }
  }
  return output;
}

function resolveGazetteerEntry(preparedGazetteer: OpenWikiPreparedLinkGazetteer, raw: string, fromPath?: string): OpenWikiLinkGazetteerEntry[] {
  const target = stripLinkTarget(raw);
  const byId = preparedGazetteer.entriesById.get(target) ?? preparedGazetteer.entriesById.get(openWikiUriToId(target) ?? "");
  if (byId !== undefined) {
    return [byId];
  }
  const pathTargets = linkPathTargets(target, fromPath);
  const exactPathMatches = uniqueEntries(pathTargets.flatMap((candidate) => [...(preparedGazetteer.entriesByPath.get(candidate) ?? [])]));
  if (exactPathMatches.length > 0) {
    return exactPathMatches;
  }
  const suffixPathMatches = uniqueEntries(pathTargets.flatMap((candidate) => [...(preparedGazetteer.entriesByPathSuffix.get(candidate) ?? [])]));
  if (suffixPathMatches.length > 0) {
    return suffixPathMatches;
  }
  return uniqueEntries([...(preparedGazetteer.aliasesByNormalized.get(normalizeAlias(target)) ?? [])]);
}

function linkPathTargets(target: string, fromPath: string | undefined): string[] {
  const cleaned = target.startsWith("/") ? target.slice(1) : target;
  const candidates = [path.posix.normalize(cleaned)];
  if (fromPath !== undefined && !target.startsWith("/") && !/^[a-z][a-z0-9+.-]*:/iu.test(target)) {
    candidates.unshift(path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), target)));
  }
  return uniqueStrings(candidates.filter((candidate) => candidate.length > 0 && candidate !== "."));
}

function aliasMap(gazetteer: OpenWikiLinkGazetteer, entriesById: ReadonlyMap<string, OpenWikiLinkGazetteerEntry>): Map<string, OpenWikiLinkGazetteerEntry[]> {
  const output = new Map<string, OpenWikiLinkGazetteerEntry[]>();
  for (const alias of gazetteer.aliases) {
    const entry = entriesById.get(alias.entry_id);
    if (entry === undefined || alias.normalized.length === 0) {
      continue;
    }
    output.set(alias.normalized, uniqueEntries([...(output.get(alias.normalized) ?? []), entry]));
  }
  return output;
}

function longestAliasInText(text: string, preparedGazetteer: OpenWikiPreparedLinkGazetteer, fromId: string): { text: string; start: number; end: number } | undefined {
  const searchable = slugSearchIndex(text);
  for (const alias of preparedGazetteer.sortedAliases) {
    if ((preparedGazetteer.aliasesByNormalized.get(alias) ?? []).every((entry) => entry.id === fromId)) {
      continue;
    }
    const match = boundedAliasMatch(searchable.text, alias);
    if (match !== undefined) {
      const span = searchIndexSpan(searchable, match.start, match.end);
      if (span !== undefined) {
        return { text: alias, ...span };
      }
    }
  }
  return undefined;
}

function pathSuffixes(normalizedPath: string): string[] {
  const parts = normalizedPath.split("/").filter((part) => part.length > 0);
  const suffixes: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    suffixes.push(parts.slice(index).join("/"));
  }
  return suffixes;
}

function boundedAliasMatch(text: string, alias: string): { start: number; end: number } | undefined {
  const expression = new RegExp(`(^|-)(${escapeRegExp(alias)})(?=-|$)`, "i");
  const match = expression.exec(text);
  if (match === null) {
    return undefined;
  }
  const start = match.index + (match[1]?.length ?? 0);
  return { start, end: start + (match[2]?.length ?? 0) };
}

function maskMarkdownCode(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, (match) => " ".repeat(match.length))
    .replace(/`[^`\n]*`/g, (match) => " ".repeat(match.length));
}

function normalizeAlias(value: string): string {
  return slugText(stripLinkTarget(value));
}

function slugText(value: string): string {
  return value.toLowerCase().trim().replace(/\.md$/u, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function slugSearchIndex(value: string): SlugSearchIndex {
  const parts: string[] = [];
  const spans: Array<{ start: number; end: number }> = [];
  let inSeparator = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]?.toLowerCase() ?? "";
    if (/^[a-z0-9]$/.test(character)) {
      parts.push(character);
      spans.push({ start: index, end: index + 1 });
      inSeparator = false;
      continue;
    }
    if (inSeparator) {
      const last = spans.at(-1);
      if (last !== undefined) {
        last.end = index + 1;
      }
      continue;
    }
    parts.push("-");
    spans.push({ start: index, end: index + 1 });
    inSeparator = true;
  }
  return { text: parts.join(""), spans };
}

function slugSearchTokens(index: SlugSearchIndex): Array<{ text: string; start: number; end: number }> {
  const tokens: Array<{ text: string; start: number; end: number }> = [];
  const pattern = /[a-z0-9]+/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(index.text)) !== null) {
    tokens.push({ text: match[0], start: match.index, end: pattern.lastIndex });
  }
  return tokens;
}

function aliasTokenCount(alias: string): number {
  return alias.split("-").filter((part) => part.length > 0).length;
}

function searchIndexSpan(index: SlugSearchIndex, start: number, end: number): { start: number; end: number } | undefined {
  if (start < 0 || end <= start || end > index.spans.length) {
    return undefined;
  }
  const first = index.spans[start];
  const last = index.spans[end - 1];
  if (first === undefined || last === undefined) {
    return undefined;
  }
  return { start: first.start, end: last.end };
}

function stripLinkTarget(value: string): string {
  let target = value.split("#")[0]?.trim() ?? "";
  try {
    target = decodeURIComponent(target);
  } catch {
    // Use the raw target when decoding fails.
  }
  return target.replace(/^\.\//, "");
}

function isExternalLink(value: string): boolean {
  return /^(?:https?:|mailto:|tel:)/i.test(value);
}

function openWikiUriToId(value: string): string | undefined {
  const prefix = "openwiki://";
  if (!value.startsWith(prefix)) {
    return undefined;
  }
  return value.slice(prefix.length).replace(/\//g, ":");
}

function idTail(id: string): string {
  return id.split(":").at(-1) ?? id;
}

function spansOverlap(span: { start: number; end: number }, spans: Array<{ start: number; end: number }>): boolean {
  return spans.some((existing) => span.start < existing.end && span.end > existing.start);
}

function dedupeCandidates(candidates: OpenWikiTypedLinkCandidate[]): OpenWikiTypedLinkCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = [candidate.from_id, candidate.to_id, candidate.relation, candidate.rule, candidate.anchor ?? "", candidate.span.start, candidate.span.end].join("\u0000");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  }).sort((left, right) => left.path.localeCompare(right.path) || left.span.start - right.span.start || left.to_id.localeCompare(right.to_id) || left.relation.localeCompare(right.relation));
}

function dedupeCollisions(collisions: OpenWikiLinkCollision[]): OpenWikiLinkCollision[] {
  const seen = new Set<string>();
  return collisions.filter((collision) => {
    const key = [collision.text, collision.path, collision.rule, collision.span.start, collision.candidate_ids.join("|")].join("\u0000");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function uniqueEntries(entries: OpenWikiLinkGazetteerEntry[]): OpenWikiLinkGazetteerEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.id)) {
      return false;
    }
    seen.add(entry.id);
    return true;
  });
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  return values.filter((value): value is string => {
    const cleaned = value?.trim();
    if (cleaned === undefined || cleaned.length === 0 || seen.has(cleaned)) {
      return false;
    }
    seen.add(cleaned);
    return true;
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
