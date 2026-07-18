import type { OpenWikiScope, ProposalRecord } from "@openwiki/core";
import type { PolicyContext } from "@openwiki/policy";

export const DREAM_PHASE_NAMES = [
  "lint",
  "index_refresh",
  "stale_claims",
  "missing_backlinks",
  "thin_pages",
  "orphan_pages",
  "link_suggestions",
  "fact_candidates",
  "take_score_candidates",
  "report",
] as const;

export type DreamPhaseName = typeof DREAM_PHASE_NAMES[number];
export type DreamPhaseStatus = "succeeded" | "skipped" | "failed";

export interface DreamPhaseDefinition {
  name: DreamPhaseName;
  description: string;
  scopes: OpenWikiScope[];
  inputs: string[];
  outputs: string[];
  idempotency_key: string;
  timeout_ms: number;
  may_create_proposals: boolean;
  provider_required: boolean;
  resumable: boolean;
}

export interface DreamRunInput {
  root: string;
  runId?: string;
  actorId?: string;
  phases?: readonly string[];
  limit?: number;
  maxRecords?: number;
  timeoutMs?: number;
  dryRun?: boolean;
  createProposals?: boolean;
  provider?: string;
  schemaPack?: string;
  policyContext?: PolicyContext;
}

export interface DreamPhaseItem {
  id: string;
  record_type: string;
  path?: string;
  title?: string;
  reason_codes?: string[];
  score?: number;
  counts?: Record<string, number>;
  candidate_ids?: string[];
  proposal_id?: string;
  proposal_status?: ProposalRecord["status"];
}

export interface DreamPhaseResult {
  phase: DreamPhaseName;
  status: DreamPhaseStatus;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  idempotency_key: string;
  timeout_ms: number;
  scopes: OpenWikiScope[];
  may_create_proposals: boolean;
  dry_run: boolean;
  summary: string;
  counts: Record<string, number>;
  items: DreamPhaseItem[];
  proposal_ids: string[];
  subject_ids: string[];
  subject_paths: string[];
  skipped_reason?: string;
  error?: string;
}

export interface DreamRunReport {
  status: "passed" | "attention";
  generated_at: string;
  phase_count: number;
  failed_phase_count: number;
  skipped_phase_count: number;
  item_count: number;
  proposal_count: number;
  next_actions: string[];
}

export interface DreamRunOutput extends Record<string, unknown> {
  schema_version: "openwiki-dream-run-v1";
  run_id?: string;
  workspace_id: string;
  generated_at: string;
  dry_run: boolean;
  create_proposals: boolean;
  provider_enabled: boolean;
  provider?: string;
  schema_pack?: string;
  limit: number;
  phases: DreamPhaseResult[];
  proposal_ids: string[];
  subject_ids: string[];
  subject_paths: string[];
  report: DreamRunReport;
}

const DEFAULT_DREAM_LIMIT = 20;
const MAX_DREAM_LIMIT = 200;
const DEFAULT_DREAM_PHASE_TIMEOUT_MS = 30_000;

const DREAM_PHASE_DEFINITIONS: DreamPhaseDefinition[] = [
  phaseDefinition("lint", "Run repository validation and summarize non-content diagnostics.", ["wiki:read"], ["repository"], ["validation_summary"], false),
  phaseDefinition("index_refresh", "Refresh local derived search and graph indexes.", ["wiki:read"], ["repository"], ["index_counts"], false),
  phaseDefinition("stale_claims", "Report stale or disputed claim review targets.", ["wiki:read"], ["claims"], ["stale_claim_targets"], false),
  phaseDefinition("missing_backlinks", "Find pages with no canonical incoming page links.", ["wiki:read"], ["graph"], ["backlink_gaps"], false),
  phaseDefinition("thin_pages", "Find pages with little body, source, or claim context.", ["wiki:read"], ["pages"], ["thin_page_targets"], false),
  phaseDefinition("orphan_pages", "Find pages disconnected from canonical page-to-page links.", ["wiki:read"], ["graph"], ["orphan_page_targets"], false),
  phaseDefinition("link_suggestions", "Extract deterministic typed-link suggestions and optionally create review proposals.", ["wiki:read", "wiki:propose"], ["pages", "graph"], ["typed_link_candidates", "proposal_ids"], true),
  phaseDefinition("fact_candidates", "Extract provider-backed fact candidates and optionally create review proposals.", ["wiki:read", "wiki:propose"], ["pages", "sources"], ["fact_candidates", "proposal_ids"], true, true),
  phaseDefinition("take_score_candidates", "Extract provider-backed probabilistic take candidates and optionally create review proposals.", ["wiki:read", "wiki:propose"], ["pages"], ["take_candidates", "proposal_ids"], true, true),
  phaseDefinition("report", "Summarize the dream run and next actions.", ["wiki:read"], ["phase_results"], ["run_report"], false),
];

export const DREAM_PHASE_REGISTRY = Object.freeze(
  Object.fromEntries(DREAM_PHASE_DEFINITIONS.map((phase) => [phase.name, phase])),
) as Readonly<Record<DreamPhaseName, DreamPhaseDefinition>>;

export function isDreamPhaseName(value: string): value is DreamPhaseName {
  return (DREAM_PHASE_NAMES as readonly string[]).includes(value);
}

export function parseDreamPhaseNames(values: readonly string[] | undefined): DreamPhaseName[] {
  if (values === undefined || values.length === 0) {
    return [...DREAM_PHASE_NAMES];
  }
  const phases = values
    .flatMap((value) => value.split(/[\s,]+/g))
    .map((value) => value.trim())
    .filter(Boolean);
  if (phases.length === 0) {
    return [...DREAM_PHASE_NAMES];
  }
  return phases.map((phase) => {
    if (!isDreamPhaseName(phase)) {
      throw new Error(`Unknown OpenWiki dream phase '${phase}'. Expected one of: ${DREAM_PHASE_NAMES.join(", ")}`);
    }
    return phase;
  }).filter((phase, index, array) => array.indexOf(phase) === index);
}

export function dreamRunInputFromRecord(input: Record<string, unknown>): Omit<DreamRunInput, "root" | "actorId" | "runId" | "policyContext"> {
  return {
    ...dreamInputStringArray(input, "phases", "phases"),
    ...dreamInputNumber(input, "limit", "limit"),
    ...dreamInputNumber(input, "max_records", "maxRecords"),
    ...dreamInputNumber(input, "timeout_ms", "timeoutMs"),
    ...dreamInputBoolean(input, "dry_run", "dryRun"),
    ...dreamInputBoolean(input, "create_proposals", "createProposals"),
    ...dreamInputString(input, "provider", "provider"),
    ...dreamInputString(input, "schema_pack", "schemaPack"),
  };
}

export function boundedDreamLimit(value: number | undefined): number {
  if (value === undefined || Number.isNaN(value)) {
    return DEFAULT_DREAM_LIMIT;
  }
  return Math.min(Math.max(Math.floor(value), 1), MAX_DREAM_LIMIT);
}

export function boundedDreamTimeout(value: number | undefined): number {
  if (value === undefined || Number.isNaN(value)) {
    return DEFAULT_DREAM_PHASE_TIMEOUT_MS;
  }
  return Math.min(Math.max(Math.floor(value), 1_000), 5 * 60_000);
}

function phaseDefinition(
  name: DreamPhaseName,
  description: string,
  scopes: OpenWikiScope[],
  inputs: string[],
  outputs: string[],
  mayCreateProposals: boolean,
  providerRequired = false,
): DreamPhaseDefinition {
  return {
    name,
    description,
    scopes,
    inputs,
    outputs,
    idempotency_key: `openwiki:dream:v1:${name}`,
    timeout_ms: DEFAULT_DREAM_PHASE_TIMEOUT_MS,
    may_create_proposals: mayCreateProposals,
    provider_required: providerRequired,
    resumable: true,
  };
}

function dreamInputString<Key extends string>(
  input: Record<string, unknown>,
  inputKey: string,
  outputKey: Key,
): Partial<Record<Key, string>> {
  const value = input[inputKey];
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "string") {
    throw new Error(`Expected string dream.run input field '${inputKey}'`);
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? {} : ({ [outputKey]: trimmed } as Partial<Record<Key, string>>);
}

function dreamInputStringArray<Key extends string>(
  input: Record<string, unknown>,
  inputKey: string,
  outputKey: Key,
): Partial<Record<Key, string[]>> {
  const value = input[inputKey];
  if (value === undefined) {
    return {};
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return { [outputKey]: parseDreamPhaseNames(value) } as Partial<Record<Key, string[]>>;
  }
  if (typeof value === "string") {
    return { [outputKey]: parseDreamPhaseNames([value]) } as Partial<Record<Key, string[]>>;
  }
  throw new Error(`Expected string array dream.run input field '${inputKey}'`);
}

function dreamInputNumber<Key extends string>(
  input: Record<string, unknown>,
  inputKey: string,
  outputKey: Key,
): Partial<Record<Key, number>> {
  const value = input[inputKey];
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Expected numeric dream.run input field '${inputKey}'`);
  }
  return { [outputKey]: value } as Partial<Record<Key, number>>;
}

function dreamInputBoolean<Key extends string>(
  input: Record<string, unknown>,
  inputKey: string,
  outputKey: Key,
): Partial<Record<Key, boolean>> {
  const value = input[inputKey];
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "boolean") {
    throw new Error(`Expected boolean dream.run input field '${inputKey}'`);
  }
  return { [outputKey]: value } as Partial<Record<Key, boolean>>;
}
