import type {
  FactRecord,
  FactStatus,
  ProposalRecord,
  SearchResponse,
  TakeRecord,
  TakeResolution,
  TakeStatus,
  ValidationReport,
} from "@openwiki/core";
import type { PolicyContext } from "@openwiki/policy";

export interface RecallWikiInput {
  root: string;
  query: string;
  limit?: number;
  includeExplain?: boolean;
  includeHighlights?: boolean;
  types?: string[];
  policyContext?: PolicyContext;
}

export interface RecallWikiResult {
  query: string;
  response: SearchResponse;
  hot_memory: Array<{
    id: string;
    type: "fact" | "take";
    title: string;
    summary?: string;
    updated_at: string;
  }>;
}

export interface ListFactsInput {
  root: string;
  statuses?: FactStatus[];
  kinds?: string[];
  subjectIds?: string[];
  pageIds?: string[];
  sourceIds?: string[];
  claimIds?: string[];
  limit?: number;
  policyContext?: PolicyContext;
}

export interface ListFactsResult {
  facts: FactRecord[];
  total: number;
}

export interface ReadFactInput {
  root: string;
  id: string;
  policyContext?: PolicyContext;
}

export interface ReadFactResult {
  fact: FactRecord;
}

export interface ListTakesInput {
  root: string;
  statuses?: TakeStatus[];
  pageIds?: string[];
  sourceIds?: string[];
  claimIds?: string[];
  limit?: number;
  policyContext?: PolicyContext;
}

export interface ListTakesResult {
  takes: TakeRecord[];
  total: number;
}

export interface ReadTakeInput {
  root: string;
  id: string;
  policyContext?: PolicyContext;
}

export interface ReadTakeResult {
  take: TakeRecord;
}

export interface TakesScorecardInput {
  root: string;
  policyContext?: PolicyContext;
}

export interface TakesScorecardResult {
  total: number;
  scored: number;
  open: number;
  resolved: number;
  archived: number;
  unresolvable: number;
  brier_score?: number;
  by_confidence: Array<{
    confidence: TakeRecord["confidence"];
    scored: number;
    brier_score?: number;
  }>;
}

export interface FindTrajectoryInput {
  root: string;
  id?: string;
  query?: string;
  limit?: number;
  order?: "asc" | "desc";
  policyContext?: PolicyContext;
}

export interface TrajectoryItem {
  id: string;
  type: string;
  title: string;
  summary?: string;
  path?: string;
  at: string;
  relation: string;
}

export interface FindTrajectoryResult {
  input: {
    id?: string;
    query?: string;
  };
  matched_record_ids: string[];
  items: TrajectoryItem[];
  total: number;
}

export interface ProposeFactInput {
  root: string;
  id?: string;
  kind?: string;
  text: string;
  subjectIds?: string[];
  pageIds?: string[];
  sourceIds?: string[];
  claimIds?: string[];
  confidence?: FactRecord["confidence"];
  sensitivity?: FactRecord["sensitivity"];
  status?: FactStatus;
  validFrom?: string;
  validTo?: string;
  actorId?: string;
  rationale?: string;
  policyContext?: PolicyContext;
}

export interface ProposeFactResult {
  proposal: ProposalRecord;
  fact: FactRecord;
  validation: ValidationReport;
  diff: string;
}

export interface ProposeTakeInput {
  root: string;
  id?: string;
  statement: string;
  rationale?: string;
  probability?: number;
  confidence?: TakeRecord["confidence"];
  status?: TakeStatus;
  dueAt?: string;
  pageIds?: string[];
  sourceIds?: string[];
  claimIds?: string[];
  actorId?: string;
  proposalRationale?: string;
  policyContext?: PolicyContext;
}

export interface ProposeTakeResult {
  proposal: ProposalRecord;
  take: TakeRecord;
  validation: ValidationReport;
  diff: string;
}

export interface ResolveTakeInput {
  root: string;
  id: string;
  resolution: TakeResolution;
  resolvedAt?: string;
  actorId?: string;
  rationale?: string;
  policyContext?: PolicyContext;
}

export interface ResolveTakeResult {
  proposal: ProposalRecord;
  take: TakeRecord;
  validation: ValidationReport;
  diff: string;
}

export interface ForgetFactInput {
  root: string;
  id: string;
  validTo?: string;
  actorId?: string;
  rationale?: string;
  policyContext?: PolicyContext;
}

export interface ForgetFactResult {
  proposal: ProposalRecord;
  fact: FactRecord;
  validation: ValidationReport;
  diff: string;
}
