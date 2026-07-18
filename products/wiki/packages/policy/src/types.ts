import type {
  ClaimRecord,
  DecisionRecord,
  EventRecord,
  FactRecord,
  InboxItemRecord,
  OpenWikiPolicyBundle,
  OpenWikiRole,
  OpenWikiRuntimeGroupRecord,
  OpenWikiRuntimePrincipalGroupRecord,
  OpenWikiRuntimePrincipalRecord,
  OpenWikiRuntimeServiceAccountRecord,
  OpenWikiScope,
  PageRecord,
  ProposalCommentRecord,
  ProposalRecord,
  RunRecord,
  SourceRecord,
  TakeRecord,
} from "@openwiki/core";

export type { OpenWikiRole, OpenWikiScope } from "@openwiki/core";
export type OpenWikiOperation =
  | "wiki.search"
  | "wiki.recall"
  | "wiki.ask"
  | "wiki.think"
  | "wiki.read_page"
  | "wiki.read_source"
  | "wiki.read_claim"
  | "wiki.list_facts"
  | "wiki.read_fact"
  | "wiki.list_takes"
  | "wiki.read_take"
  | "wiki.takes_scorecard"
  | "wiki.find_trajectory"
  | "wiki.list_proposals"
  | "wiki.read_proposal"
  | "wiki.read_proposal_detail"
  | "wiki.read_decision"
  | "wiki.trace_claim"
  | "wiki.get_history"
  | "wiki.diff_versions"
  | "wiki.list_recent_changes"
  | "wiki.git_status"
  | "wiki.git_pull"
  | "wiki.git_push"
  | "wiki.sync_now"
  | "wiki.list_events"
  | "wiki.list_runs"
  | "wiki.dream_status"
  | "wiki.dream_run"
  | "wiki.list_topics"
  | "wiki.list_open_questions"
  | "wiki.inbox_list"
  | "wiki.inbox_read"
  | "wiki.inbox_submit"
  | "wiki.inbox_process"
  | "wiki.inbox_ignore"
  | "wiki.inbox_retry"
  | "wiki.detect_governance"
  | "wiki.graph_neighbors"
  | "wiki.graph_backlinks"
  | "wiki.graph_related"
  | "wiki.graph_path"
  | "wiki.graph_orphans"
  | "wiki.graph_stale"
  | "wiki.graph_report"
  | "wiki.read_policy"
  | "wiki.preview_permissions"
  | "wiki.list_workspaces"
  | "wiki.connect_workspace"
  | "wiki.propose_policy"
  | "wiki.propose_section_policy"
  | "wiki.propose_edit"
  | "wiki.propose_source"
  | "wiki.propose_synthesis"
  | "wiki.propose_fact"
  | "wiki.propose_take"
  | "wiki.resolve_take"
  | "wiki.forget_fact"
  | "wiki.comment_on_proposal"
  | "wiki.ingest_source"
  | "wiki.fetch_source"
  | "wiki.review_proposal"
  | "wiki.close_proposal"
  | "wiki.apply_proposal"
  | "wiki.create_synthesis"
  | "wiki.run_lint"
  | "wiki.run_job"
  | "wiki.commit_changes"
  | "wiki.publish"
  | "wiki.admin";

export type OpenWikiMcpToolMode = "read" | "proposal" | "write";

/** Optional hard bounds attached to a token, client, or service account. */
export interface PolicyBounds {
  operations?: OpenWikiOperation[];
  toolModes?: OpenWikiMcpToolMode[];
  pathPrefixes?: string[];
  sectionIds?: string[];
  sourceIds?: string[];
  inboxProviders?: string[];
  dailyBudget?: number;
  maxConcurrentRequests?: number;
  expiresAt?: string;
}

/** Identity, role, principal, and scope facts used for one authorization decision. */
export interface PolicyContext {
  actorId?: string;
  scopes: OpenWikiScope[];
  role?: OpenWikiRole;
  principals?: string[];
  bounds?: PolicyBounds;
}

/** Repository snapshot shape used when filtering records by policy visibility. */
export interface PolicyVisibilityRepository {
  policy: OpenWikiPolicyBundle;
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
}

/** Repository snapshot after records outside the caller's visible policy envelope are removed. */
export interface VisiblePolicyRepository {
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
}

/** Minimal record reference used by policy filters when the full record shape is not needed. */
export interface PolicyReadableRecordReference {
  id: string;
  type?: string;
  path?: string;
  source_ids?: string[];
}

/** Service-account token resolution result promoted into a normal policy context. */
export interface ResolvedServiceAccount extends PolicyContext {
  serviceAccountId: string;
  actorId: string;
}

/** Structured result for one operation-level authorization check. */
export interface AuthorizationResult {
  allowed: boolean;
  operation: OpenWikiOperation;
  required_scopes: OpenWikiScope[];
  granted_scopes: OpenWikiScope[];
  missing_scopes: OpenWikiScope[];
  denied_by_bounds?: boolean;
  denied_reason?: string;
  actor_id?: string;
}

export interface PermissionAccessMatrix {
  read: boolean;
  propose: boolean;
  review: boolean;
  maintain: boolean;
  admin: boolean;
}

export interface PermissionGrantPreview {
  principal: string;
  section: string;
  role: OpenWikiRole;
}

export interface PermissionSectionPreview {
  id: string;
  title: string;
  paths: string[];
  visibility: "public" | "internal" | "private";
  matching_grants: PermissionGrantPreview[];
  access: PermissionAccessMatrix;
  role?: OpenWikiRole;
  scopes?: OpenWikiScope[];
  description?: string;
}

export interface PermissionPathPreview {
  path: string;
  visibility: "public" | "internal" | "private";
  matching_sections: Array<{
    id: string;
    title: string;
    visibility: "public" | "internal" | "private";
    paths: string[];
  }>;
  access: PermissionAccessMatrix;
  allowed_operations: OpenWikiOperation[];
  role?: OpenWikiRole;
}

export interface PermissionRecordPreview {
  id: string;
  visible: boolean;
  type?: string;
  path?: string;
  visibility?: "public" | "internal" | "private";
  matching_sections?: Array<{
    id: string;
    title: string;
    visibility: "public" | "internal" | "private";
    paths: string[];
  }>;
  required_role?: OpenWikiRole;
  role?: OpenWikiRole;
  reason: string;
}

export interface PermissionOperationPreview extends Omit<AuthorizationResult, "allowed"> {
  allowed: boolean;
  scope_allowed: boolean;
  required_section_role?: OpenWikiRole;
  path?: string;
  path_allowed?: boolean;
  path_role?: OpenWikiRole;
}

export interface PermissionPreviewOptions {
  repo?: PolicyVisibilityRepository;
  paths?: string[];
  recordIds?: string[];
  operations?: OpenWikiOperation[];
}

export interface PermissionPreview {
  actor_id?: string;
  role?: OpenWikiRole;
  principals: string[];
  scopes: OpenWikiScope[];
  sections: PermissionSectionPreview[];
  paths: PermissionPathPreview[];
  records: PermissionRecordPreview[];
  operations: PermissionOperationPreview[];
}

export interface PolicyIdentitySummary {
  source: "git-policy";
  principals: OpenWikiRuntimePrincipalRecord[];
  groups: OpenWikiRuntimeGroupRecord[];
  principal_groups: OpenWikiRuntimePrincipalGroupRecord[];
  service_accounts: OpenWikiRuntimeServiceAccountRecord[];
}

export interface EffectivePermissionRecord {
  principal: string;
  section: string;
  role: OpenWikiRole;
  scopes: OpenWikiScope[];
}
