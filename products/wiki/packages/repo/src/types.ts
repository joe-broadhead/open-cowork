import type {
  ClaimRecord,
  DecisionRecord,
  EventRecord,
  FactRecord,
  InboxItemRecord,
  InboxItemStatus,
  OpenWikiConfig,
  OpenWikiPolicyBundle,
  OpenWikiSectionVisibility,
  PageRecord,
  ProposalCommentRecord,
  ProposalRecord,
  ProposalStatus,
  RunRecord,
  SourceRecord,
  TakeRecord,
  ValidationReport,
} from "@openwiki/core";

export interface LoadedOpenWikiRepo {
  root: string;
  config: OpenWikiConfig;
  pages: PageRecord[];
  sources: SourceRecord[];
  claims: ClaimRecord[];
  facts: FactRecord[];
  takes: TakeRecord[];
  inbox: InboxItemRecord[];
  proposals: ProposalRecord[];
  comments: ProposalCommentRecord[];
  decisions: DecisionRecord[];
  events: EventRecord[];
  runs: RunRecord[];
  policy: OpenWikiPolicyBundle;
}

export interface ListInboxItemsOptions {
  statuses?: InboxItemStatus[];
  ownerActorId?: string;
  provider?: string;
  inboxKind?: string;
  targetSpaceId?: string;
  updatedAfter?: string;
  updatedBefore?: string;
  limit?: number;
}

export interface InboxPayloadRead {
  item: InboxItemRecord;
  content: {
    path: string;
    kind: "git" | "object";
    media_type?: string;
    content_hash?: string;
    bytes: number;
    body: string;
    truncated: boolean;
    hash_verified?: boolean;
  } | null;
  unavailable_reason?: "not_captured" | "missing" | "unsupported_storage" | "invalid_storage" | "hash_mismatch";
}

export interface ArtifactReadOptions {
  maxBytes?: number;
  authorizePath?: (repoPath: string) => Promise<void> | void;
}

export interface AppendEventInput {
  type: string;
  actor_id?: string;
  operation?: string;
  record_id?: string;
  record_type?: string;
  occurred_at?: string;
  data?: Record<string, unknown>;
  subject_ids?: string[];
  subject_paths?: string[];
  sensitivity?: OpenWikiSectionVisibility;
}

export interface AppendRunInput {
  run_type: string;
  actor_id?: string;
  status?: RunRecord["status"];
  created_at?: string;
  started_at?: string;
  completed_at?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  subject_ids?: string[];
  subject_paths?: string[];
  sensitivity?: OpenWikiSectionVisibility;
}

export interface AppendProposalCommentInput {
  proposal_id: string;
  actor_id?: string;
  body: string;
  created_at?: string;
}

export interface ListProposalsOptions {
  statuses?: ProposalStatus[];
  actorId?: string;
  targetId?: string;
  targetPath?: string;
  sectionId?: string;
  updatedAfter?: string;
  updatedBefore?: string;
  limit?: number;
}


export interface ProposalTextArtifact {
  path: string;
  body: string;
}

export interface ProposalDetail {
  proposal: ProposalRecord;
  comments: ProposalCommentRecord[];
  diff?: ProposalTextArtifact;
  snapshot?: ProposalTextArtifact;
  snapshots?: Record<string, ProposalTextArtifact>;
  validation_report?: ValidationReport;
  snapshot_status?: {
    status: "current" | "stale" | "missing";
    target_paths: string[];
    stale_paths: string[];
  };
}

export interface ClaimTrace {
  claim: ClaimRecord;
  page: PageRecord | null;
  sources: SourceRecord[];
  missing_source_ids: string[];
  proposals: ProposalRecord[];
  decisions: DecisionRecord[];
  evidence_summary: {
    source_count: number;
    missing_source_count: number;
    proposal_count: number;
    decision_count: number;
    accepted_decision_count: number;
    confidence: ClaimRecord["confidence"];
    risk: ClaimRecord["risk"];
    status: ClaimRecord["status"];
    last_verified_at?: string;
  };
}

export interface SourceContentRead {
  source: SourceRecord;
  content: {
    path: string;
    kind?: string;
    backend?: string;
    media_type?: string;
    content_hash?: string;
    bytes: number;
    body: string;
    truncated: boolean;
    hash_verified?: boolean;
  } | null;
  unavailable_reason?: "not_captured" | "missing" | "unsupported_storage" | "invalid_storage" | "hash_mismatch";
}
