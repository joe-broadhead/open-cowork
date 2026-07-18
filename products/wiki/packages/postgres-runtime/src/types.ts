import { type EventRecord, type OpenQuestionRecord, type OpenWikiRuntimeApiTokenRecord, OpenWikiRuntimeBusyError, type OpenWikiRuntimeGroupRecord, type OpenWikiRuntimeIdpMappingRecord, type OpenWikiRuntimePrincipalGroupRecord, type OpenWikiRuntimePrincipalRecord, type OpenWikiRuntimeServiceAccountRecord, type OpenWikiRuntimeSessionRecord, type ProposalRecord, type ProposalStatus, type RunRecord, type RunStatus, type RunType, type SourceRecord, type TopicSummary } from "@openwiki/core";
import type { Sql } from "postgres";

export interface PostgresMigrationResult {
  database_url_env: string;
  applied: string[];
  skipped: string[];
}

export interface PostgresRuntimeOptions {
  databaseUrl?: string;
  databaseUrlEnv?: NodeJS.ProcessEnv;
  pooled?: boolean;
}

export interface PostgresWriteLeaseDiagnostic {
  workspace_id: string;
  lock_name: string;
  actor_id: string;
  operation: string;
  started_at: string;
  heartbeat_at: string;
  expires_at: string;
  metadata: Record<string, unknown>;
}

export interface PostgresWriteLeaseInput extends PostgresRuntimeOptions {
  root: string;
  lockName?: string;
  actorId: string;
  operation: string;
  metadata?: Record<string, unknown>;
  leaseMs?: number;
  heartbeatMs?: number;
}

export type PostgresOperationalMcpToolMode = "read" | "proposal" | "write";

export interface PostgresOperationalMcpSession {
  id: string;
  root: string;
  toolMode: PostgresOperationalMcpToolMode;
  protocolVersion: string;
  createdAt: number;
  updatedAt: number;
}

export interface UpsertPostgresMcpHttpSessionInput extends PostgresRuntimeOptions {
  root: string;
  session: PostgresOperationalMcpSession;
  ttlMs: number;
}

export interface TouchPostgresMcpHttpSessionInput extends PostgresRuntimeOptions {
  root: string;
  sessionId: string;
  updatedAt: number;
  ttlMs: number;
}

export interface ReadPostgresMcpHttpSessionInput extends PostgresRuntimeOptions {
  root: string;
  sessionId: string;
}

export interface DeletePostgresMcpHttpSessionInput extends PostgresRuntimeOptions {
  root: string;
  sessionId: string;
}

export interface ExpirePostgresMcpHttpSessionsInput extends PostgresRuntimeOptions {
  root: string;
  now?: number;
}

export interface IncrementPostgresRateLimitWindowInput extends PostgresRuntimeOptions {
  root: string;
  key: string;
  now: number;
  windowMs: number;
  maxKeys: number;
}

export interface PostgresRateLimitWindow {
  startedAt: number;
  count: number;
}

export class PostgresWriteLeaseBusyError extends OpenWikiRuntimeBusyError {
  readonly active: PostgresWriteLeaseDiagnostic;

  constructor(active: PostgresWriteLeaseDiagnostic) {
    super(`OpenWiki write in progress: ${active.operation} by ${active.actor_id} since ${active.started_at}; lease expires at ${active.expires_at}`);
    this.name = "PostgresWriteLeaseBusyError";
    this.active = active;
  }
}

export interface PostgresRunJobInput {
  root: string;
  runType: RunType | string;
  actorId?: string;
  input?: Record<string, unknown>;
  subjectIds?: string[];
  subjectPaths?: string[];
}

export interface PostgresRunQueueAdapter {
  backend: "postgres";
  enqueue(input: PostgresRunJobInput): Promise<RunRecord>;
  get(runId: string): Promise<RunRecord | undefined>;
  claim(runId: string, workerId?: string): Promise<RunRecord>;
  claimNext(workerId?: string): Promise<RunRecord | undefined>;
  heartbeat(run: RunRecord, workerId?: string): Promise<void>;
  complete(run: RunRecord, output: Record<string, unknown>, workerId?: string): Promise<RunRecord>;
  fail(run: RunRecord, message: string, workerId?: string): Promise<RunRecord>;
}

export interface PostgresRuntimeRebuildResult {
  source: "postgres-runtime";
  root: string;
  workspace_id: string;
  source_commit: string;
  record_count: number;
  edge_count: number;
  search_document_count: number;
  effective_permission_count: number;
}

export interface PostgresRuntimeSyncResult extends PostgresRuntimeRebuildResult {
  mode: "rebuild" | "incremental" | "current";
  previous_source_commit?: string;
  changed_paths: string[];
  upserted_record_count: number;
}

export interface PostgresRuntimeSummary {
  source: "postgres-runtime";
  root: string;
  workspace_id?: string;
  schema_version?: string;
  source_commit?: string;
  content_hash?: string;
  generated_at?: string;
  record_count: number;
  edge_count: number;
  search_document_count: number;
  effective_permission_count: number;
}

export interface PostgresRuntimeRecordEntry<T> {
  source: "postgres-runtime";
  record: T;
  path: string;
  status: string;
  sensitivity?: string;
}

export interface PostgresRuntimeIntegrityResult extends PostgresRuntimeSummary {
  ok: boolean;
  current_commit: string;
  current_content_hash?: string;
  enabled: boolean;
  issues: string[];
  migrations: PostgresMigrationDiagnostics;
}

export interface PostgresMigrationDiagnostics {
  expected: string[];
  applied: string[];
  missing: string[];
  extra: string[];
}

export interface PostgresRuntimeWorkspaceIndex {
  source: "postgres-runtime";
  workspace: Record<string, unknown>;
  counts: {
    pages: number;
    sources: number;
    claims: number;
    facts: number;
    takes: number;
    proposals: number;
    comments: number;
    decisions: number;
    events: number;
    runs: number;
  };
}

export interface PostgresRuntimeProposalListOptions {
  statuses?: ProposalStatus[];
  actorId?: string;
  targetId?: string;
  targetPath?: string;
  sectionId?: string;
  updatedAfter?: string;
  updatedBefore?: string;
  limit?: number;
  offset?: number;
}

export interface PostgresRuntimeProposalList {
  source: "postgres-runtime";
  proposals: ProposalRecord[];
  total: number;
}

export interface PostgresRuntimeEventList {
  source: "postgres-runtime";
  events: EventRecord[];
}

export interface PostgresRuntimeEventListOptions {
  actorId?: string;
  eventType?: string;
  operation?: string;
  recordId?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

export interface PostgresRuntimeRunList {
  source: "postgres-runtime";
  runs: RunRecord[];
}

export interface PostgresRuntimeRunListOptions {
  statuses?: RunStatus[];
  actorId?: string;
  recordId?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

export interface PostgresRuntimeJobDetail {
  source: "postgres-runtime";
  backend: "postgres";
  workspace_id: string;
  job_id: string;
  run_id: string;
  job_type: string;
  status: string;
  actor_id: string;
  attempts: number;
  max_attempts: number;
  created_at: string;
  claimed_by?: string;
  claimed_at?: string;
  completed_at?: string;
  source_commit: string;
  json: Record<string, unknown>;
}

export interface PostgresRuntimeJobAttempt {
  source: "postgres-runtime";
  workspace_id: string;
  job_id: string;
  run_id: string;
  attempt: number;
  job_type: string;
  status: string;
  actor_id: string;
  worker_id?: string;
  started_at: string;
  completed_at?: string;
  error?: string;
  source_commit: string;
  json: Record<string, unknown>;
}

export interface PostgresRuntimeRunDetail {
  source: "postgres-runtime";
  run: RunRecord;
  job?: PostgresRuntimeJobDetail;
  attempts: PostgresRuntimeJobAttempt[];
}

export interface PostgresRuntimeTopicList {
  source: "postgres-runtime";
  topics: TopicSummary[];
}

export interface PostgresRuntimeOpenQuestionList {
  source: "postgres-runtime";
  open_questions: OpenQuestionRecord[];
}

export interface PostgresRuntimeSourceList {
  source: "postgres-runtime";
  sources: SourceRecord[];
  total: number;
}

export interface PostgresRuntimeIdentityList {
  source: "postgres-runtime";
  workspace_id: string;
  principals: OpenWikiRuntimePrincipalRecord[];
  groups: OpenWikiRuntimeGroupRecord[];
  principal_groups: OpenWikiRuntimePrincipalGroupRecord[];
  service_accounts: OpenWikiRuntimeServiceAccountRecord[];
  sessions: OpenWikiRuntimeSessionRecord[];
  api_tokens: Array<Omit<OpenWikiRuntimeApiTokenRecord, "token_hash"> & { token_hash_present: boolean }>;
  idp_mappings: OpenWikiRuntimeIdpMappingRecord[];
}

export interface PostgresRuntimeQueueHealth {
  source: "postgres-runtime";
  backend: "postgres";
  enabled: boolean;
  runs: Record<"queued" | "running" | "succeeded" | "failed", number>;
  jobs: Record<"queued" | "running" | "succeeded" | "failed", number>;
  next_queued_run_id?: string;
  oldest_queued_at?: string;
  oldest_running_run_id?: string;
  oldest_running_at?: string;
  stale_running_jobs: number;
  stale_running_after_ms: number;
  latest_failed_run_id?: string;
  latest_failed_at?: string;
}

export interface PostgresRunReaperOptions extends PostgresRuntimeOptions {
  maxRuntimeMs?: number;
  workerId?: string;
  dryRun?: boolean;
  limit?: number;
}

export interface PostgresRunReaperResult {
  source: "postgres-runtime";
  workspace_id: string;
  max_runtime_ms: number;
  dry_run: boolean;
  scanned: number;
  retried: string[];
  failed: string[];
}

export interface PostgresRunCancellationOptions extends PostgresRuntimeOptions {
  actorId?: string;
  reason?: string;
}

export interface PostgresRunCancellationResult {
  source: "postgres-runtime";
  workspace_id: string;
  run: RunRecord;
  previous_status: RunStatus;
}

export interface PostgresWriteLeaseRecoveryOptions extends PostgresRuntimeOptions {
  lockName?: string;
}

export interface PostgresWriteLeaseRecoveryResult {
  source: "postgres-runtime";
  workspace_id: string;
  lock_name: string;
  recovered: boolean;
  active?: PostgresWriteLeaseDiagnostic;
}

// Canonical record/search-document shapes are defined once in @openwiki/repo so the SQLite and
// Postgres store engines cannot drift apart. Re-exported here for existing local importers.
export type { DerivedRecord, SearchDocument } from "@openwiki/repo";

export interface RuntimeRow {
  json: unknown;
}

export interface CountRow {
  count: number | bigint | string;
}

export interface SourceCommitRow {
  source_commit: string;
}

export interface MetadataRow {
  key: string;
  value: string;
}

export type PostgresSql = Sql<Record<string, unknown>>;

export type PostgresQuery = PostgresSql;

export type PostgresJsonValue = Parameters<PostgresQuery["json"]>[0];

export interface RunRow {
  run_id: string;
  status: string;
  json: RunRecord | string;
}

export interface JobAttemptRow {
  attempts: number | bigint | string;
  max_attempts: number | bigint | string;
}

export const RUNTIME_SOURCE_COMMIT = "runtime";

export const POSTGRES_IMPORT_BATCH_SIZE = 500;

export const DEFAULT_STALE_RUN_MAX_RUNTIME_MS = 30 * 60 * 1000;

export type PostgresRuntimeCountTable =
  | "records"
  | "edges"
  | "search_documents"
  | "effective_permissions"
  | "source_objects";

export interface AcquirePostgresWriteLeaseInput {
  workspaceId: string;
  lockName: string;
  token: string;
  actorId: string;
  operation: string;
  leaseMs: number;
  metadata: Record<string, unknown>;
}
