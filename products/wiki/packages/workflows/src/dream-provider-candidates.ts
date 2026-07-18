import { createHash } from "node:crypto";
import {
  type FactRecord,
  type PageRecord,
  type ProposalRecord,
  type TakeRecord,
} from "@openwiki/core";
import { canSeeRecord, visiblePages } from "./dream-cycle-visibility.ts";
import { proposeFact, proposeTake } from "./memory.ts";
import { loadRepository, type LoadedOpenWikiRepo } from "@openwiki/repo";
import type { PolicyContext } from "@openwiki/policy";
import type { DreamPhaseItem, DreamPhaseName } from "./dream-cycle-contract.ts";

const PROVIDER_PHASE_SKIP_REASON = "provider not configured; phase requires an explicit provider";
const MAX_PROVIDER_CONTEXT_CHARS = 12_000;
const MAX_PROVIDER_RESPONSE_CHARS = 24_000;
const MAX_PROVIDER_CANDIDATES = 5;

export interface DreamCandidatePhaseContext {
  root: string;
  workspaceId: string;
  runId?: string;
  actorId: string;
  generatedAt: string;
  limit: number;
  timeoutMs: number;
  createProposals: boolean;
  providerEnabled: boolean;
  provider?: string;
  policyContext?: PolicyContext;
  phaseDeadlineMs?: number;
  phaseAbortSignal?: AbortSignal;
}

export async function factCandidatesPhase(context: DreamCandidatePhaseContext) {
  const provider = dreamProviderForContext(context);
  if (provider === undefined) {
    return skippedProviderPhase(phaseSkipReason(context), "fact_candidates");
  }
  const repo = await loadRepository(context.root);
  const pages = visiblePages(context, repo)
    .filter((page) => page.body.trim().length > 0)
    .sort((left, right) => left.path.localeCompare(right.path) || left.id.localeCompare(right.id))
    .slice(0, context.limit);
  const candidates = await provider.extractFactCandidates(context, repo, pages);
  const bounded = uniqueFactCandidates(candidates)
    .filter((candidate) => candidate.text.length > 0)
    .filter((candidate) => !repo.facts.some((fact) => normalizedText(fact.text) === normalizedText(candidate.text)))
    .slice(0, Math.min(MAX_PROVIDER_CANDIDATES, context.limit));
  const items: DreamPhaseItem[] = [];
  const proposalIds: string[] = [];
  for (const candidate of bounded) {
    assertDreamPhaseWithinDeadline(context, "fact_candidates");
    const pageIds = candidate.page_ids.filter((pageId) => canSeeRecord(context, repo, pageId));
    const sourceIds = candidate.source_ids.filter((sourceId) => canSeeRecord(context, repo, sourceId));
    const claimIds = candidate.claim_ids.filter((claimId) => canSeeRecord(context, repo, claimId));
    const candidateId = candidate.fact_id ?? candidateIdFor("fact", candidate.text);
    const item: DreamPhaseItem = {
      id: candidateId,
      record_type: "fact_candidate",
      title: candidate.text,
      reason_codes: ["provider_candidate"],
      candidate_ids: uniqueStrings([...pageIds, ...sourceIds, ...claimIds]).slice(0, 10),
      ...(candidate.score === undefined ? {} : { score: candidate.score }),
      counts: {
        page_count: pageIds.length,
        source_count: sourceIds.length,
        claim_count: claimIds.length,
      },
    };
    if (context.createProposals) {
      const idempotencyKey = targetIdempotencyKey("fact_candidates", candidateId, [candidate.text]);
      const existing = await findExistingDreamProposal(context.root, candidateId, idempotencyKey);
      const proposal = existing ?? (await proposeFact({
        root: context.root,
        id: candidateId,
        kind: candidate.kind ?? "dream",
        text: candidate.text,
        subjectIds: uniqueStrings(candidate.subject_ids.length > 0 ? candidate.subject_ids : pageIds),
        pageIds,
        sourceIds,
        claimIds,
        confidence: candidate.confidence ?? "medium",
        sensitivity: candidate.sensitivity ?? "internal",
        actorId: context.actorId,
        rationale: dreamProposalRationale(context, "fact_candidates", candidateId, idempotencyKey),
        ...(context.policyContext === undefined ? {} : { policyContext: context.policyContext }),
      })).proposal;
      proposalIds.push(proposal.id);
      item.proposal_id = proposal.id;
      item.proposal_status = proposal.status;
    }
    items.push(item);
  }
  return {
    status: "succeeded" as const,
    summary: `Found ${items.length} provider-backed fact candidate(s).`,
    counts: {
      pages_scanned: pages.length,
      candidate_count: items.length,
      proposal_count: proposalIds.length,
    },
    items,
    proposal_ids: uniqueStrings(proposalIds),
    subject_ids: uniqueStrings([...items.map((item) => item.id), ...items.flatMap((item) => item.candidate_ids ?? []), ...proposalIds]),
    subject_paths: uniqueStrings(pages.map((page) => page.path)),
  };
}

export async function takeScoreCandidatesPhase(context: DreamCandidatePhaseContext) {
  const provider = dreamProviderForContext(context);
  if (provider === undefined) {
    return skippedProviderPhase(phaseSkipReason(context), "take_score_candidates");
  }
  const repo = await loadRepository(context.root);
  const pages = visiblePages(context, repo)
    .filter((page) => page.body.trim().length > 0)
    .sort((left, right) => left.path.localeCompare(right.path) || left.id.localeCompare(right.id))
    .slice(0, context.limit);
  const candidates = await provider.extractTakeCandidates(context, repo, pages);
  const bounded = uniqueTakeCandidates(candidates)
    .filter((candidate) => candidate.statement.length > 0)
    .filter((candidate) => !repo.takes.some((take) => normalizedText(take.statement) === normalizedText(candidate.statement)))
    .slice(0, Math.min(MAX_PROVIDER_CANDIDATES, context.limit));
  const items: DreamPhaseItem[] = [];
  const proposalIds: string[] = [];
  for (const candidate of bounded) {
    assertDreamPhaseWithinDeadline(context, "take_score_candidates");
    const pageIds = candidate.page_ids.filter((pageId) => canSeeRecord(context, repo, pageId));
    const sourceIds = candidate.source_ids.filter((sourceId) => canSeeRecord(context, repo, sourceId));
    const claimIds = candidate.claim_ids.filter((claimId) => canSeeRecord(context, repo, claimId));
    const candidateId = candidate.take_id ?? candidateIdFor("take", candidate.statement);
    const item: DreamPhaseItem = {
      id: candidateId,
      record_type: "take_candidate",
      title: candidate.statement,
      reason_codes: ["provider_candidate"],
      candidate_ids: uniqueStrings([...pageIds, ...sourceIds, ...claimIds]).slice(0, 10),
      score: candidate.probability,
      counts: {
        page_count: pageIds.length,
        source_count: sourceIds.length,
        claim_count: claimIds.length,
      },
    };
    if (context.createProposals) {
      const idempotencyKey = targetIdempotencyKey("take_score_candidates", candidateId, [candidate.statement]);
      const existing = await findExistingDreamProposal(context.root, candidateId, idempotencyKey);
      const proposal = existing ?? (await proposeTake({
        root: context.root,
        id: candidateId,
        statement: candidate.statement,
        rationale: candidate.rationale,
        probability: candidate.probability,
        confidence: candidate.confidence ?? "medium",
        status: "open",
        pageIds,
        sourceIds,
        claimIds,
        actorId: context.actorId,
        proposalRationale: dreamProposalRationale(context, "take_score_candidates", candidateId, idempotencyKey),
        ...(context.policyContext === undefined ? {} : { policyContext: context.policyContext }),
      })).proposal;
      proposalIds.push(proposal.id);
      item.proposal_id = proposal.id;
      item.proposal_status = proposal.status;
    }
    items.push(item);
  }
  return {
    status: "succeeded" as const,
    summary: `Found ${items.length} provider-backed take candidate(s).`,
    counts: {
      pages_scanned: pages.length,
      candidate_count: items.length,
      proposal_count: proposalIds.length,
    },
    items,
    proposal_ids: uniqueStrings(proposalIds),
    subject_ids: uniqueStrings([...items.map((item) => item.id), ...items.flatMap((item) => item.candidate_ids ?? []), ...proposalIds]),
    subject_paths: uniqueStrings(pages.map((page) => page.path)),
  };
}

function skippedProviderPhase(reason: string, phase: DreamPhaseName) {
  return {
    status: "skipped" as const,
    summary: `${phase} skipped: ${reason}.`,
    counts: {},
    items: [],
    proposal_ids: [],
    subject_ids: [],
    subject_paths: [],
    skipped_reason: reason,
  };
}

function phaseSkipReason(context: DreamCandidatePhaseContext): string {
  if (!context.providerEnabled) {
    return PROVIDER_PHASE_SKIP_REASON;
  }
  const provider = context.provider?.toLowerCase();
  if (provider === "openrouter" && openWikiEnv("OPENROUTER_API_KEY") === undefined && openWikiEnv("OPENWIKI_DREAM_API_KEY") === undefined) {
    return "OpenRouter credential not configured; set OPENROUTER_API_KEY or OPENWIKI_DREAM_API_KEY";
  }
  if (provider === "openai" && openWikiEnv("OPENAI_API_KEY") === undefined && openWikiEnv("OPENWIKI_DREAM_API_KEY") === undefined) {
    return "OpenAI-compatible credential not configured; set OPENAI_API_KEY or OPENWIKI_DREAM_API_KEY";
  }
  return `unsupported dream provider '${context.provider}'`;
}

interface DreamFactCandidate {
  fact_id?: string;
  text: string;
  kind?: string;
  subject_ids: string[];
  page_ids: string[];
  source_ids: string[];
  claim_ids: string[];
  confidence?: FactRecord["confidence"];
  sensitivity?: FactRecord["sensitivity"];
  score?: number;
}

interface DreamTakeCandidate {
  take_id?: string;
  statement: string;
  rationale: string;
  probability: number;
  page_ids: string[];
  source_ids: string[];
  claim_ids: string[];
  confidence?: TakeRecord["confidence"];
}

interface DreamProvider {
  extractFactCandidates(context: DreamCandidatePhaseContext, repo: LoadedOpenWikiRepo, pages: PageRecord[]): Promise<DreamFactCandidate[]>;
  extractTakeCandidates(context: DreamCandidatePhaseContext, repo: LoadedOpenWikiRepo, pages: PageRecord[]): Promise<DreamTakeCandidate[]>;
}

function dreamProviderForContext(context: DreamCandidatePhaseContext): DreamProvider | undefined {
  if (!context.providerEnabled || context.provider === undefined) {
    return undefined;
  }
  const provider = context.provider.toLowerCase();
  if (provider === "fixture") {
    return fixtureDreamProvider();
  }
  const baseUrl = openAiCompatibleBaseUrl(context.provider);
  const apiKey = openAiCompatibleApiKey(provider);
  if (baseUrl === undefined || apiKey === undefined) {
    return undefined;
  }
  return openAiCompatibleDreamProvider({
    provider,
    baseUrl,
    apiKey,
    model: openWikiEnv("OPENWIKI_DREAM_MODEL") ?? (provider === "openrouter" ? "deepseek/deepseek-v4-pro" : "gpt-4.1-mini"),
  });
}

function fixtureDreamProvider(): DreamProvider {
  return {
    async extractFactCandidates(_context, _repo, pages) {
      const page = pages[0];
      if (page === undefined) {
        return [];
      }
      return [{
        text: `${page.title}: ${firstSentence(page.body)}`,
        kind: "dream",
        subject_ids: [page.id],
        page_ids: [page.id],
        source_ids: page.source_ids,
        claim_ids: page.claim_ids,
        confidence: "medium",
        sensitivity: "internal",
        score: 0.8,
      }];
    },
    async extractTakeCandidates(_context, _repo, pages) {
      const page = pages[0];
      if (page === undefined) {
        return [];
      }
      return [{
        statement: `Reviewing ${page.title} will improve OpenWiki recall quality.`,
        rationale: "Fixture provider generated a deterministic reviewable take from the visible dream page context.",
        probability: 0.7,
        page_ids: [page.id],
        source_ids: page.source_ids,
        claim_ids: page.claim_ids,
        confidence: "medium",
      }];
    },
  };
}

function openAiCompatibleDreamProvider(config: { provider: string; baseUrl: string; apiKey: string; model: string }): DreamProvider {
  return {
    async extractFactCandidates(context, repo, pages) {
      const payload = await requestProviderJson(config, context, {
        task: "fact_candidates",
        instruction: "Return JSON with a facts array. Each fact must be atomic, durable, directly supported by the supplied records, and useful as personal wiki memory.",
        schema: {
          facts: [{
            text: "string",
            kind: "string optional",
            subject_ids: ["record id"],
            page_ids: ["page id"],
            source_ids: ["source id"],
            claim_ids: ["claim id"],
            confidence: "low|medium|high",
            sensitivity: "public|internal|private",
            score: "0..1 optional",
          }],
        },
        records: providerRecords(repo, pages),
      });
      return parseProviderFactCandidates(payload);
    },
    async extractTakeCandidates(context, repo, pages) {
      const payload = await requestProviderJson(config, context, {
        task: "take_score_candidates",
        instruction: "Return JSON with a takes array. Each take must be a falsifiable probabilistic statement useful for future review.",
        schema: {
          takes: [{
            statement: "string",
            rationale: "string",
            probability: "0..1",
            page_ids: ["page id"],
            source_ids: ["source id"],
            claim_ids: ["claim id"],
            confidence: "low|medium|high",
          }],
        },
        records: providerRecords(repo, pages),
      });
      return parseProviderTakeCandidates(payload);
    },
  };
}

async function requestProviderJson(
  config: { provider: string; baseUrl: string; apiKey: string; model: string },
  context: DreamCandidatePhaseContext,
  input: Record<string, unknown>,
): Promise<unknown> {
  assertDreamPhaseWithinDeadline(context, input["task"] === "take_score_candidates" ? "take_score_candidates" : "fact_candidates");
  const body = JSON.stringify({
    model: config.model,
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "You extract OpenWiki dream candidates.",
          "Return only valid JSON matching the requested shape.",
          "Do not invent record IDs; use only IDs present in the supplied records.",
          "Do not include source text excerpts beyond the candidate itself.",
        ].join(" "),
      },
      {
        role: "user",
        content: boundedJsonString(input, MAX_PROVIDER_CONTEXT_CHARS),
      },
    ],
  });
  const response = await fetch(`${config.baseUrl.replace(/\/+$/u, "")}/chat/completions`, {
    method: "POST",
    ...(context.phaseAbortSignal === undefined ? {} : { signal: context.phaseAbortSignal }),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
      ...(config.provider === "openrouter" ? { "http-referer": "https://github.com/joe-broadhead/open-cowork", "x-title": "Open Cowork Wiki Dream" } : {}),
    },
    body,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Dream provider ${config.provider} failed with HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  const json = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error(`Dream provider ${config.provider} returned no JSON content`);
  }
  return parseProviderJsonContent(content);
}

function providerRecords(repo: LoadedOpenWikiRepo, pages: PageRecord[]): Array<Record<string, unknown>> {
  const visibleSourceById = new Map(repo.sources.map((source) => [source.id, source]));
  const visibleClaimById = new Map(repo.claims.map((claim) => [claim.id, claim]));
  return pages.map((page) => ({
    id: page.id,
    title: page.title,
    summary: page.summary ?? "",
    path: page.path,
    topics: page.topics,
    source_ids: page.source_ids.filter((sourceId) => visibleSourceById.has(sourceId)),
    claim_ids: page.claim_ids.filter((claimId) => visibleClaimById.has(claimId)),
    body: page.body.slice(0, 1_200),
  }));
}

function parseProviderFactCandidates(payload: unknown): DreamFactCandidate[] {
  const facts = objectArrayProperty(payload, "facts");
  return facts.map((fact) => ({
    ...optionalStringRecordProperty(fact, "fact_id"),
    text: stringRecordProperty(fact, "text").slice(0, 500),
    ...optionalStringRecordProperty(fact, "kind"),
    subject_ids: stringArrayRecordProperty(fact, "subject_ids"),
    page_ids: stringArrayRecordProperty(fact, "page_ids"),
    source_ids: stringArrayRecordProperty(fact, "source_ids"),
    claim_ids: stringArrayRecordProperty(fact, "claim_ids"),
    ...confidenceRecordProperty(fact),
    ...sensitivityRecordProperty(fact),
    ...scoreRecordProperty(fact, "score"),
  }));
}

function parseProviderTakeCandidates(payload: unknown): DreamTakeCandidate[] {
  const takes = objectArrayProperty(payload, "takes");
  return takes.map((take) => ({
    ...optionalStringRecordProperty(take, "take_id"),
    statement: stringRecordProperty(take, "statement").slice(0, 500),
    rationale: stringRecordProperty(take, "rationale").slice(0, 700),
    probability: boundedProbability(numberRecordProperty(take, "probability")),
    page_ids: stringArrayRecordProperty(take, "page_ids"),
    source_ids: stringArrayRecordProperty(take, "source_ids"),
    claim_ids: stringArrayRecordProperty(take, "claim_ids"),
    ...confidenceRecordProperty(take),
  }));
}

async function findExistingDreamProposal(root: string, targetId: string, idempotencyKey: string): Promise<ProposalRecord | undefined> {
  const repo = await loadRepository(root);
  return repo.proposals.find(
    (proposal) =>
      proposal.status === "open" &&
      proposal.target_ids.includes(targetId) &&
      proposal.rationale !== undefined &&
      proposal.rationale.includes(idempotencyKey),
  );
}

function dreamProposalRationale(
  context: DreamCandidatePhaseContext,
  phase: DreamPhaseName,
  targetId: string,
  idempotencyKey: string,
): string {
  return [
    `OpenWiki dream cycle phase ${phase} produced provider-backed memory candidates for review.`,
    `Source run: ${context.runId ?? "direct"}.`,
    `Target: ${targetId}.`,
    `Idempotency key: ${idempotencyKey}.`,
    "This proposal does not directly mutate canonical content; review and apply it through the normal proposal flow.",
  ].join(" ");
}

function targetIdempotencyKey(phase: DreamPhaseName, targetId: string, candidateIds: string[]): string {
  return stableKey(["openwiki:dream:v1", phase, targetId, ...candidateIds.sort()]);
}

function stableKey(parts: string[]): string {
  const hash = createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);
  return `${parts[0]}:${hash}`;
}

function openAiCompatibleBaseUrl(provider: string): string | undefined {
  const configured = openWikiEnv("OPENWIKI_DREAM_PROVIDER_BASE_URL");
  if (configured !== undefined) {
    return configured;
  }
  if (/^https?:\/\//u.test(provider)) {
    return provider;
  }
  if (provider.toLowerCase() === "openrouter") {
    return "https://openrouter.ai/api/v1";
  }
  if (provider.toLowerCase() === "openai") {
    return "https://api.openai.com/v1";
  }
  return undefined;
}

function openAiCompatibleApiKey(provider: string): string | undefined {
  return openWikiEnv("OPENWIKI_DREAM_API_KEY") ??
    (provider === "openrouter" ? openWikiEnv("OPENROUTER_API_KEY") : undefined) ??
    (provider === "openai" ? openWikiEnv("OPENAI_API_KEY") : undefined);
}

function openWikiEnv(name: string): string | undefined {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseProviderJsonContent(content: string): unknown {
  const trimmed = content.trim().slice(0, MAX_PROVIDER_RESPONSE_CHARS);
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/u);
    if (match === null) {
      throw new Error("Dream provider returned content that was not JSON");
    }
    return JSON.parse(match[0]);
  }
}

function boundedJsonString(value: unknown, maxChars: number): string {
  const text = JSON.stringify(value);
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

function uniqueFactCandidates(candidates: DreamFactCandidate[]): DreamFactCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = normalizedText(candidate.text);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function uniqueTakeCandidates(candidates: DreamTakeCandidate[]): DreamTakeCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = normalizedText(candidate.statement);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function candidateIdFor(kind: "fact" | "take", text: string): string {
  return `${kind}:dream:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
}

function normalizedText(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}

function firstSentence(value: string): string {
  const text = value.trim().replace(/\s+/gu, " ");
  const match = text.match(/^(.{1,220}?[.!?])(?:\s|$)/u);
  return (match?.[1] ?? text.slice(0, 220)).trim();
}

function objectArrayProperty(value: unknown, key: string): Record<string, unknown>[] {
  if (typeof value !== "object" || value === null || !(key in value)) {
    return [];
  }
  const candidate = (value as Record<string, unknown>)[key];
  return Array.isArray(candidate) ? candidate.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null) : [];
}

function stringRecordProperty(value: Record<string, unknown>, key: string): string {
  const candidate = value[key];
  return typeof candidate === "string" ? candidate.trim() : "";
}

function optionalStringRecordProperty(value: Record<string, unknown>, key: string): Record<string, string> {
  const candidate = stringRecordProperty(value, key);
  return candidate.length === 0 ? {} : { [key]: candidate };
}

function stringArrayRecordProperty(value: Record<string, unknown>, key: string): string[] {
  const candidate = value[key];
  if (!Array.isArray(candidate)) {
    return [];
  }
  return candidate.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean);
}

function confidenceRecordProperty(value: Record<string, unknown>): { confidence?: FactRecord["confidence"] } {
  const confidence = stringRecordProperty(value, "confidence");
  return confidence === "low" || confidence === "medium" || confidence === "high" ? { confidence } : {};
}

function sensitivityRecordProperty(value: Record<string, unknown>): { sensitivity?: FactRecord["sensitivity"] } {
  const sensitivity = stringRecordProperty(value, "sensitivity");
  return sensitivity === "public" || sensitivity === "internal" || sensitivity === "private" ? { sensitivity } : {};
}

function scoreRecordProperty(value: Record<string, unknown>, key: string): { score?: number } {
  const candidate = value[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? { score: boundedProbability(candidate) } : {};
}

function numberRecordProperty(value: Record<string, unknown>, key: string): number {
  const candidate = value[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : 0.5;
}

function boundedProbability(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

function assertDreamPhaseWithinDeadline(context: DreamCandidatePhaseContext, phase: DreamPhaseName): void {
  if (context.phaseAbortSignal?.aborted === true || (context.phaseDeadlineMs !== undefined && Date.now() > context.phaseDeadlineMs)) {
    throw new Error(`Dream phase ${phase} timed out after ${context.timeoutMs}ms`);
  }
}

function uniqueStrings(values: readonly string[]): string[] {
  return values.filter((value, index, array) => value.trim().length > 0 && array.indexOf(value) === index);
}
