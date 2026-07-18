import type { SecretResolver, SourceFetchConnectorKind } from "@openwiki/connectors";
import type {
  DecisionRecord,
  DecisionValue,
  EventRecord,
  InboxProcessingFailureCategory,
  InboxItemRecord,
  InboxItemStatus,
  OpenWikiRole,
  OpenWikiScope,
  OpenWikiSectionRecord,
  PageRecord,
  ProposalCloseResolution,
  ProposalCommentRecord,
  ProposalRecord,
  SearchPersona,
  ThinkResponse,
  SourceRecord,
  ValidationIssue,
  ValidationReport,
} from "@openwiki/core";
import type { rebuildIndexStore } from "@openwiki/index-store";
import type { PolicyContext } from "@openwiki/policy";
import type { buildSearchIndex } from "@openwiki/search";
import type { RepositoryValidationReport } from "@openwiki/validation";

export interface ProposeEditInput {
  root: string;
  pageId: string;
  body: string;
  title?: string;
  proposalTitle?: string;
  summary?: string;
  sourceIds?: string[];
  claimIds?: string[];
  actorId?: string;
  rationale?: string;
  abortSignal?: AbortSignal;
}

export interface ProposeEditResult {
  proposal: ProposalRecord;
  validation: ValidationReport;
  diff: string;
}

export interface ProposeSynthesisInput {
  root: string;
  title: string;
  body: string;
  pageType?: string;
  summary?: string;
  topics?: string[];
  sourceIds?: string[];
  actorId?: string;
  rationale?: string;
}

export interface ProposeSynthesisResult {
  proposal: ProposalRecord;
  page: PageRecord;
  validation: ValidationReport;
  diff: string;
}

export interface CreateSynthesisInput extends ProposeSynthesisInput {
  decisionRationale?: string;
  commit?: boolean;
  message?: string;
}

export interface CreateSynthesisResult {
  proposal: ProposalRecord;
  decision: DecisionRecord;
  page: PageRecord;
  applied_paths: string[];
  validation: ValidationReport;
  repository_validation: RepositoryValidationReport;
  commit?: string;
}

export type ServiceAccountTokenProfile =
  | "local-agent"
  | "ci-bot"
  | "hosted-readonly-agent"
  | "inbox-submitter"
  | "inbox-curator"
  | "proposal-agent"
  | "maintainer-automation";

export interface ServiceAccountTokenCreateInput {
  root: string;
  id?: string;
  profile?: ServiceAccountTokenProfile;
  actorId?: string;
  role?: OpenWikiRole;
  scopes?: OpenWikiScope[];
  principals?: string[];
  groups?: string[];
  expiresAt?: string;
  expiresInDays?: number;
  description?: string;
  tokenDescription?: string;
  auditActorId?: string;
}

export interface ServiceAccountTokenRotateInput extends Omit<ServiceAccountTokenCreateInput, "id"> {
  root: string;
  id: string;
  tokenId?: string;
}

export interface ServiceAccountTokenRevokeInput {
  root: string;
  id: string;
  tokenId?: string;
  auditActorId?: string;
  reason?: string;
}

export interface ServiceAccountTokenListInput {
  root: string;
  id?: string;
}

export interface ServiceAccountTokenResult {
  service_account: SanitizedServiceAccount;
  token: {
    id: string;
    value: string;
    created_at: string;
    expires_at?: string;
  };
  event: EventRecord;
}

export interface ServiceAccountTokenRevokeResult {
  service_account: SanitizedServiceAccount;
  revoked_token_ids: string[];
  event: EventRecord;
}

export interface ServiceAccountTokenListResult {
  service_accounts: SanitizedServiceAccount[];
}

export interface SanitizedServiceAccount {
  id: string;
  actor_id: string;
  description?: string;
  role?: OpenWikiRole;
  scopes: OpenWikiScope[];
  principals: string[];
  token_hash_count: number;
  active_token_count: number;
  revoked_token_count: number;
  expired_token_count: number;
  tokens: SanitizedServiceAccountToken[];
  created_at?: string;
  updated_at?: string;
  expires_at?: string;
}

export interface SanitizedServiceAccountToken {
  id: string;
  description?: string;
  created_at?: string;
  expires_at?: string;
  revoked_at?: string;
  status: "active" | "expired" | "revoked";
}

export interface ProposeSourceInput {
  root: string;
  title: string;
  sourceType?: string;
  url?: string;
  contentHash?: string;
  actorId?: string;
  rationale?: string;
  retrievedAt?: string;
  trust?: Record<string, unknown>;
  authorizePaths?: SourcePathAuthorizer;
}

export interface ProposeSourceResult {
  proposal: ProposalRecord;
  source: SourceRecord;
  validation: ValidationReport;
  diff: string;
}

export type PolicyFileName = "sections" | "grants" | "approval-rules" | "approval_rules";

export interface ProposePolicyChangeInput {
  root: string;
  policyFile: PolicyFileName;
  body: string;
  actorId?: string;
  rationale?: string;
}

export interface ProposePolicyChangeResult {
  proposal: ProposalRecord;
  policy_file: "sections" | "grants" | "approval-rules";
  target_path: string;
  validation: ValidationReport;
  diff: string;
}

export interface ProposeSectionPolicyInput {
  root: string;
  sectionId: string;
  title: string;
  paths: string[];
  visibility?: OpenWikiSectionRecord["visibility"];
  ownerPrincipal?: string;
  viewerPrincipals?: string[];
  contributorPrincipals?: string[];
  researcherPrincipals?: string[];
  reviewerPrincipals?: string[];
  maintainerPrincipals?: string[];
  adminPrincipals?: string[];
  requiredReviewerPrincipals?: string[];
  replaceGrants?: boolean;
  actorId?: string;
  rationale?: string;
}

export interface ProposeSectionPolicyResult {
  proposal: ProposalRecord;
  section: OpenWikiSectionRecord;
  policy_files: Array<"sections" | "grants" | "approval-rules">;
  target_path: string;
  validation: ValidationReport;
  diff: string;
}

export interface ReviewProposalInput {
  root: string;
  proposalId: string;
  decision: DecisionValue;
  actorId?: string;
  rationale: string;
  commit?: string;
}

export interface ReviewProposalResult {
  proposal: ProposalRecord;
  decision: DecisionRecord;
}

export interface CommentOnProposalInput {
  root: string;
  proposalId: string;
  body: string;
  actorId?: string;
}

export interface CommentOnProposalResult {
  proposal: ProposalRecord;
  comment: ProposalCommentRecord;
}

export interface CloseProposalInput {
  root: string;
  proposalId: string;
  actorId?: string;
  rationale: string;
  resolution?: ProposalCloseResolution;
  supersededBy?: string;
}

export interface CloseProposalResult {
  proposal: ProposalRecord;
  closed: boolean;
}

export interface CommitChangesInput {
  root: string;
  message: string;
  actorId?: string;
  paths?: string[];
  all?: boolean;
  authorizePaths?: CommitPathAuthorizer;
}

export interface CommitChangesResult {
  root: string;
  is_git_repo: boolean;
  committed: boolean;
  status: "committed" | "no_changes" | "not_git_repo";
  mode: "staged" | "paths" | "all";
  message: string;
  staged_paths: string[];
  sha?: string;
  short_sha?: string;
  event?: EventRecord;
}

export interface AskWithCitationsInput {
  root: string;
  question: string;
  limit?: number;
  persona?: SearchPersona;
  includeExplain?: boolean;
  policyContext?: PolicyContext;
}

export interface ThinkWithCitationsInput extends AskWithCitationsInput {}

export type ThinkWithCitationsResult = ThinkResponse;

export interface CreateWorkspaceBackupInput {
  root: string;
  outDir?: string;
  destinationId?: string;
  includeGit?: boolean;
  actorId?: string;
  createdAt?: string;
}

export interface WorkspaceBackupManifest {
  schema_version: "openwiki.backup.v1";
  backup_id: string;
  openwiki_version: string;
  workspace_id: string;
  workspace_title: string;
  protocol_version: string;
  repo_format: string;
  created_at: string;
  created_by_actor: string;
  created_on_host: string;
  source_commit?: string;
  source_dirty: boolean | null;
  included_paths: string[];
  derived_stores: {
    search_index: "included" | "excluded";
    sqlite_index: "included" | "excluded";
  };
  object_storage: {
    mode: string;
    external_objects_included: boolean;
    restore_complete_from_git: boolean;
    warning?: string;
  };
  postgres: {
    included: boolean;
    warning?: string;
  };
  checksum_file: "checksums.sha256";
  checksum_file_hash: string;
  file_count: number;
  byte_count: number;
  compatibility: {
    min_openwiki_version: string;
    protocol_version: string;
    repo_format: string;
    requires_checksum_verification: true;
  };
  warnings: string[];
  counts: {
    pages: number;
    sources: number;
    claims: number;
    proposals: number;
    decisions: number;
    events: number;
    runs: number;
  };
}

export interface CreateWorkspaceBackupResult {
  root: string;
  backup_id: string;
  backup_dir: string;
  manifest_path: string;
  checksums_path: string;
  restore_readme_path: string;
  manifest: WorkspaceBackupManifest;
  event?: EventRecord;
}

export interface WorkspaceBackupDestinationSummary {
  id?: string;
  kind: "local" | "s3" | "minio" | "gcs" | "rclone";
  path?: string;
  uri?: string;
  bucket?: string;
  remote?: string;
  prefix?: string;
  endpoint_url?: string;
  region?: string;
}

export interface WorkspaceBackupListInput {
  root: string;
  outDir?: string;
  destinationId?: string;
}

export interface WorkspaceBackupEntry {
  backup_id: string;
  backup_dir: string;
  manifest_path: string;
  created_at?: string;
  workspace_id?: string;
  workspace_title?: string;
  checksum_file_hash?: string;
  file_count?: number;
  byte_count?: number;
  status: "ok" | "invalid";
  error?: string;
}

export interface WorkspaceBackupListResult {
  root: string;
  destination: WorkspaceBackupDestinationSummary;
  backups: WorkspaceBackupEntry[];
}

export interface VerifyWorkspaceBackupInput {
  backupDir: string;
  root?: string;
  destinationId?: string;
  actorId?: string;
  recordEvent?: boolean;
}

export interface VerifyWorkspaceBackupResult {
  backup_id: string;
  backup_dir: string;
  manifest: WorkspaceBackupManifest;
  checksum_file_hash: string;
  files_checked: number;
  bytes_checked: number;
  warnings: string[];
  event?: EventRecord;
}

export interface RestoreWorkspaceBackupInput {
  root?: string;
  destinationId?: string;
  backupDir: string;
  targetRoot: string;
  force?: boolean;
  actorId?: string;
}

export interface RestoreWorkspaceBackupResult {
  backup_dir: string;
  target_root: string;
  manifest: WorkspaceBackupManifest;
  verification: VerifyWorkspaceBackupResult;
  restored_paths: string[];
  search_index: Awaited<ReturnType<typeof buildSearchIndex>>;
  index_store: Awaited<ReturnType<typeof rebuildIndexStore>>;
  event?: EventRecord;
}

export interface RehearseWorkspaceBackupInput {
  root: string;
  destinationId?: string;
  backupDir: string;
  targetRoot: string;
  force?: boolean;
  actorId?: string;
  rehearsedAt?: string;
}

export interface RestoreRehearsalStage {
  name: "resolve_backup" | "verify_backup" | "restore_workspace" | "validate_repository" | "record_evidence";
  status: "pass" | "fail";
  message: string;
  details?: Record<string, unknown>;
}

export interface RehearseWorkspaceBackupResult {
  root: string;
  backup_id: string;
  backup_dir: string;
  target_root: string;
  rehearsed_at: string;
  status: "pass";
  stages: RestoreRehearsalStage[];
  verification: VerifyWorkspaceBackupResult;
  restore: RestoreWorkspaceBackupResult;
  validation: RepositoryValidationReport;
  event?: EventRecord;
}

export interface PruneWorkspaceBackupsInput {
  root: string;
  outDir?: string;
  destinationId?: string;
  keepLast?: number;
  keepDays?: number;
  dryRun?: boolean;
  actorId?: string;
  now?: string;
}

export interface WorkspaceBackupPruneEntry {
  backup_id: string;
  backup_dir: string;
  created_at?: string;
  reason: string;
}

export interface PruneWorkspaceBackupsResult {
  root: string;
  destination: WorkspaceBackupDestinationSummary;
  dry_run: boolean;
  retention: {
    keep_last?: number;
    keep_days?: number;
  };
  backups_considered: number;
  kept: WorkspaceBackupPruneEntry[];
  deleted: WorkspaceBackupPruneEntry[];
  event?: EventRecord;
}

export interface ConfigureLocalBackupDestinationInput {
  root: string;
  id: string;
  path: string;
  keepLast?: number;
  keepDays?: number;
  actorId?: string;
}

export interface ConfigureLocalBackupDestinationResult {
  root: string;
  config_path: string;
  destination: WorkspaceBackupDestinationSummary;
  warnings: string[];
  retention?: {
    keep_last?: number;
    keep_days?: number;
  };
  event?: EventRecord;
}

export interface ConfigureCloudBackupDestinationInput {
  root: string;
  id: string;
  kind: "s3" | "minio" | "gcs" | "rclone";
  bucket?: string;
  remote?: string;
  prefix?: string;
  endpointUrl?: string;
  region?: string;
  accessKeyIdEnv?: string;
  secretAccessKeyEnv?: string;
  sessionTokenEnv?: string;
  credentialsEnv?: string;
  serverSideEncryption?: string;
  kmsKeyId?: string;
  kmsKeyName?: string;
  forcePathStyle?: boolean;
  allowInsecureHttp?: boolean;
  keepLast?: number;
  keepDays?: number;
  actorId?: string;
}

export interface ConfigureCloudBackupDestinationResult {
  root: string;
  config_path: string;
  destination: WorkspaceBackupDestinationSummary;
  warnings: string[];
  retention?: {
    keep_last?: number;
    keep_days?: number;
  };
  event?: EventRecord;
}

export interface SubmitInboxItemInput {
  root: string;
  title: string;
  content?: string;
  inboxKind?: string;
  provider?: string;
  adapter?: string;
  ownerActorId?: string;
  submittedBy?: string;
  targetSpaceId?: string;
  targetPath?: string;
  externalId?: string;
  origin?: string;
  sourceUrl?: string;
  idempotencyKey?: string;
  sensitivity?: "public" | "internal" | "private";
  metadata?: Record<string, unknown>;
  receivedAt?: string;
  mediaType?: string;
}

export interface SubmitInboxItemResult {
  item: InboxItemRecord;
  duplicate: boolean;
  existing_id?: string;
  payload_path?: string;
  event?: EventRecord;
}

export interface ListInboxWorkflowInput {
  root: string;
  statuses?: InboxItemStatus[];
  ownerActorId?: string;
  provider?: string;
  inboxKind?: string;
  targetSpaceId?: string;
  limit?: number;
}

export interface ListInboxWorkflowResult {
  items: InboxItemRecord[];
  total: number;
}

export interface ReadInboxWorkflowInput {
  root: string;
  id: string;
  includeContent?: boolean;
  maxBytes?: number;
}

export interface ReadInboxWorkflowResult {
  item: InboxItemRecord;
  content?: {
    path: string;
    media_type?: string;
    bytes: number;
    body: string;
    truncated: boolean;
  };
}

export interface UpdateInboxStatusInput {
  root: string;
  id: string;
  actorId?: string;
  reason?: string;
}

export interface UpdateInboxStatusResult {
  item: InboxItemRecord;
  event: EventRecord;
}

export interface ProcessInboxItemInput extends UpdateInboxStatusInput {
  dryRun?: boolean;
  force?: boolean;
  runId?: string;
  policyContext?: PolicyContext;
  processor?: "deterministic" | "fake";
  fakeProviderFailure?: InboxProcessingFailureCategory;
  providerTimeoutMs?: number;
  enqueueSyncAfterProcess?: boolean;
}

export interface ProcessInboxItemResult {
  item: InboxItemRecord;
  dry_run: boolean;
  plan: string[];
  idempotent?: boolean;
  source?: SourceRecord;
  event?: EventRecord;
  failure?: {
    category: InboxProcessingFailureCategory;
    message: string;
    retryable: boolean;
    next_action: string;
    next_retry_at?: string;
  };
}

export type InboxWatchAdapter = "file";

export interface WatchInboxOnceInput {
  root: string;
  dir: string;
  adapter?: InboxWatchAdapter;
  provider?: string;
  inboxKind?: string;
  ownerActorId?: string;
  targetSpaceId?: string;
  maxBytes?: number;
  archiveDir?: string;
  quarantineDir?: string;
}

export interface WatchInboxOnceResult {
  scanned: number;
  submitted: number;
  duplicates: number;
  skipped: number;
  failed: number;
  items: InboxItemRecord[];
  errors: Array<{ path: string; message: string }>;
}

export interface IngestSourceInput {
  root: string;
  title: string;
  sourceType?: string;
  url?: string;
  content?: string;
  actorId?: string;
  retrievedAt?: string;
  trust?: Record<string, unknown>;
  storage?: Record<string, unknown>;
  postEventAutomation?: boolean;
  authorizePaths?: SourcePathAuthorizer;
}

export interface FetchSourceInput {
  root: string;
  title: string;
  url?: string;
  sourceType?: string;
  actorId?: string;
  connectorKind?: SourceFetchConnectorKind;
  connectorId?: string;
  credentialRef?: string;
  githubOwner?: string;
  githubRepo?: string;
  gitlabProject?: string;
  sourcePath?: string;
  ref?: string;
  maxBytes?: number;
  timeoutMs?: number;
  fetcher?: SourceFetchFunction;
  secretResolver?: SecretResolver;
  authorizePaths?: SourcePathAuthorizer;
}

export interface SourcePathAuthorizationTarget {
  sourceId: string;
  manifestPath: string;
  rawPath?: string;
}

export type SourcePathAuthorizer = (target: SourcePathAuthorizationTarget) => void | Promise<void>;

export type CommitPathAuthorizer = (paths: string[]) => void | Promise<void>;

export interface FetchSourceResult extends IngestSourceResult {
  fetch: {
    url: string;
    request_url?: string;
    status: number;
    content_type?: string;
    bytes: number;
    connector_kind?: SourceFetchConnectorKind;
    connector_id?: string;
    credential_ref?: string;
    authenticated?: boolean;
    repository?: string;
    source_path?: string;
    ref?: string;
  };
}

export type SourceFetchFunction = (url: string, init: RequestInit) => Promise<Response>;

export interface SourceIngestReport {
  id: string;
  source_id: string;
  status: "passed" | "failed";
  checked_at: string;
  issues: ValidationIssue[];
}

export interface IngestSourceResult {
  source: SourceRecord;
  validation: SourceIngestReport;
  manifest_path: string;
  raw_path?: string;
  object_path?: string;
}
