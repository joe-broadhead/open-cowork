import { OPENWIKI_PROTOCOL_VERSION, OPENWIKI_REPO_FORMAT } from "./protocol.ts";

export interface OpenWikiConfig {
  protocol_version: typeof OPENWIKI_PROTOCOL_VERSION;
  workspace_id: string;
  title: string;
  default_language?: string;
  repo_format: typeof OPENWIKI_REPO_FORMAT;
  runtime?: OpenWikiRuntimeConfig;
  auth?: OpenWikiAuthConfig;
  search?: OpenWikiSearchConfig;
  created_at: string;
}

export interface OpenWikiWorkspaceSummary {
  workspace_id: string;
  title: string;
  protocol_version: typeof OPENWIKI_PROTOCOL_VERSION;
  repo_format: typeof OPENWIKI_REPO_FORMAT;
  created_at: string;
  default_language?: string;
}

export function openWikiWorkspaceSummary(config: OpenWikiConfig): OpenWikiWorkspaceSummary {
  return {
    workspace_id: config.workspace_id,
    title: config.title,
    protocol_version: config.protocol_version,
    repo_format: config.repo_format,
    created_at: config.created_at,
    ...(config.default_language === undefined ? {} : { default_language: config.default_language }),
  };
}

export interface OpenWikiOrganizationRecord {
  id: string;
  uri: string;
  type: "organization";
  title: string;
  created_at: string;
}

export interface OpenWikiTenantRecord {
  id: string;
  uri: string;
  type: "tenant";
  organization_id: string;
  title: string;
  created_at: string;
}

export interface OpenWikiWorkspaceRecord {
  id: string;
  uri: string;
  type: "workspace";
  tenant_id: string;
  title: string;
  repo_format: typeof OPENWIKI_REPO_FORMAT;
  protocol_version: typeof OPENWIKI_PROTOCOL_VERSION;
  created_at: string;
  source_commit?: string;
  config: OpenWikiConfig;
}

export interface OpenWikiWorkspaceRepoRecord {
  id: string;
  uri: string;
  type: "workspace_repo";
  workspace_id: string;
  repo_id: string;
  root_path: string;
  remote?: string;
  branch?: string;
  remote_url?: string;
  credential_ref?: string;
  source_commit?: string;
}

export interface OpenWikiWorkspaceRegistry {
  source: "git" | "index-store" | "postgres-runtime";
  organizations: OpenWikiOrganizationRecord[];
  tenants: OpenWikiTenantRecord[];
  workspaces: OpenWikiWorkspaceRecord[];
  repos: OpenWikiWorkspaceRepoRecord[];
}

export interface OpenWikiRuntimeConfig {
  profile?: OpenWikiRuntimeProfile;
  sync?: OpenWikiSyncConfig;
  backups?: OpenWikiBackupConfig;
  queue?: OpenWikiQueueConfig;
  storage?: OpenWikiStorageConfig;
  connectors?: OpenWikiConnectorConfig;
  secrets?: OpenWikiSecretConfig;
  git?: OpenWikiGitConfig;
  controls?: OpenWikiControlsConfig;
  schema_pack?: OpenWikiSchemaPackConfig;
}

export type OpenWikiRuntimeProfile = "local" | "team" | "hosted" | "static" | "compose" | "umbrel" | "cloud" | "enterprise";
export type OpenWikiRuntimeMode = "local" | "team" | "hosted" | "enterprise";

export function openWikiRuntimeModeFromProfile(profile: string | undefined): OpenWikiRuntimeMode {
  if (profile === undefined || profile === "local" || profile === "static") {
    return "local";
  }
  if (profile === "enterprise") {
    return "enterprise";
  }
  if (profile === "hosted" || profile === "cloud") {
    return "hosted";
  }
  if (profile === "team" || profile === "compose" || profile === "umbrel") {
    return "team";
  }
  throw new Error(`Invalid OpenWiki runtime profile '${profile}'`);
}

export function openWikiRuntimeModeFromEnvOrProfile(
  env: Record<string, string | undefined>,
  profile: string | undefined,
): OpenWikiRuntimeMode {
  const value = env.OPENWIKI_RUNTIME_MODE?.trim().toLowerCase();
  if (value === "local" || value === "team" || value === "hosted" || value === "enterprise") {
    return value;
  }
  if (value !== undefined && value.length > 0) {
    throw new Error("OPENWIKI_RUNTIME_MODE must be local, team, hosted, or enterprise");
  }
  return openWikiRuntimeModeFromProfile(profile);
}

export function openWikiRuntimeModeRequiresHostedStores(mode: OpenWikiRuntimeMode): boolean {
  return mode === "hosted" || mode === "enterprise";
}

export type OpenWikiSyncMode = "manual" | "auto";
export type OpenWikiSyncConflictPolicy = "stop";
export type OpenWikiAutomationEvent = "proposal.applied" | "source.ingested" | "inbox.proposed" | "inbox.processed";

export interface OpenWikiSyncConfig {
  remote?: string;
  branch?: string;
  mode?: OpenWikiSyncMode;
  pull_on_start?: boolean;
  push_after_commit?: boolean;
  sync_after_events?: OpenWikiAutomationEvent[];
  debounce_seconds?: number;
  max_attempts?: number;
  backoff_seconds?: number;
  interval_seconds?: number;
  conflict_policy?: OpenWikiSyncConflictPolicy;
}

export type OpenWikiBackupSchedule = "manual" | "hourly" | "daily" | "weekly";
export type OpenWikiBackupDestinationKind =
  | "local"
  | "s3"
  | "minio"
  | "gcs"
  | "google-drive"
  | "webdav"
  | "rclone";

export interface OpenWikiBackupRetentionConfig {
  keep_last?: number;
  keep_days?: number;
}

export interface OpenWikiBackupConfig {
  enabled?: boolean;
  schedule?: OpenWikiBackupSchedule;
  backup_after_events?: OpenWikiAutomationEvent[];
  event_threshold?: number;
  min_interval_seconds?: number;
  retention?: OpenWikiBackupRetentionConfig;
  destinations?: OpenWikiBackupDestinationConfig[];
  default_destination_id?: string;
}

export interface OpenWikiBackupDestinationConfig {
  id: string;
  kind: OpenWikiBackupDestinationKind;
  path?: string;
  bucket?: string;
  prefix?: string;
  endpoint_url?: string;
  region?: string;
  remote?: string;
  credential_ref?: string;
  credentials_env?: string;
  access_key_id_env?: string;
  secret_access_key_env?: string;
  session_token_env?: string;
  server_side_encryption?: string;
  kms_key_id?: string;
  kms_key_name?: string;
  force_path_style?: boolean;
  allow_insecure_http?: boolean;
  allow_workspace_relative?: boolean;
}

export interface OpenWikiGitConfig {
  remote?: string;
  branch?: string;
  remote_url?: string;
  credential_ref?: string;
}

export interface OpenWikiSchemaPackConfig {
  path?: string;
  name?: string;
}

export interface OpenWikiControlsConfig {
  rate_limits?: OpenWikiRateLimitConfig;
  source_fetch?: OpenWikiSourceFetchBudgetConfig;
  operational_state?: OpenWikiOperationalStateConfig;
}

export type OpenWikiOperationalStateBackend = "memory" | "postgres";

export interface OpenWikiOperationalStateConfig {
  backend?: OpenWikiOperationalStateBackend;
}

export interface OpenWikiRateLimitConfig {
  enabled?: boolean;
  window_ms?: number;
  default_limit?: number;
  mcp_limit?: number;
  search_limit?: number;
  ask_limit?: number;
  source_limit?: number;
  proposal_limit?: number;
  policy_limit?: number;
  inbox_limit?: number;
  job_limit?: number;
  auth_limit?: number;
}

export interface OpenWikiSourceFetchBudgetConfig {
  default_max_bytes?: number;
  max_bytes?: number;
  default_timeout_ms?: number;
  max_timeout_ms?: number;
}

export type OpenWikiQueueBackend = "local" | "postgres";

export interface OpenWikiQueueConfig {
  backend?: OpenWikiQueueBackend;
  poll_ms?: number;
  max_jobs_per_worker?: number;
}

export type OpenWikiStorageBackend = "local" | "s3" | "minio";

export interface OpenWikiStorageConfig {
  backend?: OpenWikiStorageBackend;
  local_path?: string;
  inline_max_bytes?: number;
  endpoint_url?: string;
  bucket?: string;
  region?: string;
  prefix?: string;
  force_path_style?: boolean;
  access_key_id_env?: string;
  secret_access_key_env?: string;
  session_token_env?: string;
}

export interface OpenWikiConnectorConfig {
  http?: OpenWikiHttpConnectorConfig[];
  github?: OpenWikiGitHubConnectorConfig[];
  gitlab?: OpenWikiGitLabConnectorConfig[];
}

export interface OpenWikiHttpConnectorConfig {
  id: string;
  label?: string;
  allowed_hosts: string[];
  credential_refs?: string[];
  default_headers?: Record<string, string>;
}

export interface OpenWikiGitHubConnectorConfig {
  id: string;
  label?: string;
  web_base_url?: string;
  api_base_url?: string;
  allowed_repositories: string[];
  credential_refs?: string[];
}

export interface OpenWikiGitLabConnectorConfig {
  id: string;
  label?: string;
  web_base_url?: string;
  api_base_url?: string;
  allowed_repositories: string[];
  credential_refs?: string[];
}

export type OpenWikiSecretBackend = "none" | "env";

export interface OpenWikiSecretConfig {
  backend?: OpenWikiSecretBackend;
  env_prefix?: string;
}

export type OpenWikiScope =
  | "wiki:read"
  | "wiki:search"
  | "wiki:ask"
  | "wiki:inbox:read"
  | "wiki:inbox:submit"
  | "wiki:inbox:process"
  | "wiki:inbox:admin"
  | "wiki:propose"
  | "wiki:ingest:draft"
  | "wiki:review"
  | "wiki:patch"
  | "wiki:commit"
  | "wiki:publish"
  | "wiki:admin";

export type OpenWikiRole =
  | "viewer"
  | "contributor"
  | "researcher"
  | "reviewer"
  | "maintainer"
  | "admin"
  | "agent";

export type SearchPersona = "default" | "researcher" | "editor" | "reviewer" | "governance";
const OPENWIKI_SCOPE_VALUES: readonly OpenWikiScope[] = [
  "wiki:read",
  "wiki:search",
  "wiki:ask",
  "wiki:inbox:read",
  "wiki:inbox:submit",
  "wiki:inbox:process",
  "wiki:inbox:admin",
  "wiki:propose",
  "wiki:ingest:draft",
  "wiki:review",
  "wiki:patch",
  "wiki:commit",
  "wiki:publish",
  "wiki:admin",
];

const OPENWIKI_ROLE_VALUES: readonly OpenWikiRole[] = [
  "viewer",
  "contributor",
  "researcher",
  "reviewer",
  "maintainer",
  "admin",
  "agent",
];

export function isOpenWikiScope(value: unknown): value is OpenWikiScope {
  return typeof value === "string" && (OPENWIKI_SCOPE_VALUES as readonly string[]).includes(value);
}

export function isOpenWikiRole(value: unknown): value is OpenWikiRole {
  return typeof value === "string" && (OPENWIKI_ROLE_VALUES as readonly string[]).includes(value);
}

export type OpenWikiSectionVisibility = "public" | "internal" | "private";

export interface OpenWikiSectionRecord {
  id: string;
  title: string;
  paths: string[];
  visibility?: OpenWikiSectionVisibility;
  owner_principal?: string;
  default_reviewers?: string[];
  description?: string;
}

export interface OpenWikiGrantRecord {
  principal: string;
  section: string;
  role: OpenWikiRole;
}

export interface OpenWikiApprovalRequirement {
  principal?: string;
  role?: OpenWikiRole;
}

export interface OpenWikiApprovalRuleRecord {
  id: string;
  paths: string[];
  required_reviewers?: OpenWikiApprovalRequirement[];
  require_separate_actor?: boolean;
}

export interface OpenWikiPolicyBundle {
  sections: OpenWikiSectionRecord[];
  grants: OpenWikiGrantRecord[];
  approval_rules: OpenWikiApprovalRuleRecord[];
}

export interface OpenWikiAuthConfig {
  service_accounts?: OpenWikiAuthServiceAccount[];
  oauth?: OpenWikiAuthOAuthConfig;
}

export interface OpenWikiAuthServiceAccount {
  id: string;
  actor_id: string;
  description?: string;
  role?: OpenWikiRole;
  scopes?: OpenWikiScope[];
  principals?: string[];
  tokens?: OpenWikiAuthServiceAccountToken[];
  token_hashes?: string[];
  bounds?: OpenWikiAuthBoundsConfig;
  created_at?: string;
  updated_at?: string;
  expires_at?: string;
}

export interface OpenWikiAuthServiceAccountToken {
  id: string;
  token_hash: string;
  description?: string;
  bounds?: OpenWikiAuthBoundsConfig;
  created_at: string;
  expires_at?: string;
  revoked_at?: string;
}

export interface OpenWikiAuthOAuthConfig {
  enabled?: boolean;
  issuer?: string;
  dynamic_client_registration?: OpenWikiOAuthDynamicClientRegistrationConfig;
  clients?: OpenWikiOAuthClientConfig[];
}

export interface OpenWikiOAuthDynamicClientRegistrationConfig {
  enabled?: boolean;
  default_role?: OpenWikiRole;
  default_scopes?: OpenWikiScope[];
  default_bounds?: OpenWikiAuthBoundsConfig;
  access_token_ttl_seconds?: number;
  refresh_token_ttl_seconds?: number;
}

export interface OpenWikiOAuthClientConfig {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  public?: boolean;
  client_secret_hashes?: string[];
  actor_id: string;
  role?: OpenWikiRole;
  scopes?: OpenWikiScope[];
  principals?: string[];
  grant_types?: Array<"authorization_code" | "client_credentials" | "refresh_token">;
  bounds?: OpenWikiAuthBoundsConfig;
  access_token_ttl_seconds?: number;
  refresh_token_ttl_seconds?: number;
  created_at?: string;
  updated_at?: string;
  expires_at?: string;
}

export interface OpenWikiAuthBoundsConfig {
  operations?: string[];
  tool_modes?: Array<"read" | "proposal" | "write">;
  path_prefixes?: string[];
  section_ids?: string[];
  source_ids?: string[];
  inbox_providers?: string[];
  daily_budget?: number;
  max_concurrent_requests?: number;
  expires_at?: string;
}

export type OpenWikiPrincipalType = "actor" | "group" | "role" | "service_account" | "user" | "principal" | "unknown";

export interface OpenWikiRuntimePrincipalRecord {
  id: string;
  type: OpenWikiPrincipalType;
  title: string;
  created_at?: string;
  updated_at?: string;
}

export interface OpenWikiRuntimeGroupRecord {
  id: string;
  title: string;
  description?: string;
  created_at?: string;
  updated_at?: string;
}

export interface OpenWikiRuntimePrincipalGroupRecord {
  principal_id: string;
  group_id: string;
  source?: "runtime" | "idp" | "git";
  created_at?: string;
}

export interface OpenWikiRuntimeServiceAccountRecord {
  id: string;
  actor_id: string;
  description?: string;
  role?: OpenWikiRole;
  scopes: OpenWikiScope[];
  principals: string[];
  token_hash_count: number;
  active_token_count?: number;
  revoked_token_count?: number;
  expired_token_count?: number;
  tokens?: OpenWikiRuntimeServiceAccountTokenRecord[];
  created_at?: string;
  updated_at?: string;
  expires_at?: string;
}

export interface OpenWikiRuntimeServiceAccountTokenRecord {
  id: string;
  description?: string;
  created_at?: string;
  expires_at?: string;
  revoked_at?: string;
  status: "active" | "expired" | "revoked";
}

export interface OpenWikiRuntimeSessionRecord {
  id: string;
  actor_id: string;
  principal_id?: string;
  created_at: string;
  expires_at?: string;
  revoked_at?: string;
}

export interface OpenWikiRuntimeApiTokenRecord {
  id: string;
  actor_id: string;
  principal_id?: string;
  scopes: OpenWikiScope[];
  token_hash?: string;
  created_at: string;
  expires_at?: string;
  revoked_at?: string;
}

export interface OpenWikiRuntimeIdpMappingRecord {
  id: string;
  provider: string;
  claim: string;
  value: string;
  principal_id: string;
  created_at?: string;
  updated_at?: string;
}

export type SearchRetriever = "exact" | "bm25" | "ngram" | "fuzzy" | "graph" | "vector";
export type OpenWikiEmbeddingProvider = "local";
export type OpenWikiEmbeddingRebuildPolicy = "manual" | "index";

export interface OpenWikiSearchEmbeddingConfig {
  enabled?: boolean;
  provider?: OpenWikiEmbeddingProvider;
  model?: string;
  dimensions?: number;
  max_chunk_characters?: number;
  chunk_overlap_characters?: number;
  batch_size?: number;
  rebuild?: OpenWikiEmbeddingRebuildPolicy;
}

export interface OpenWikiSearchConfig {
  default_persona?: SearchPersona;
  default_limit?: number;
  max_limit?: number;
  max_query_length?: number;
  overfetch?: number;
  rrf_k?: number;
  ngram_min?: number;
  fuzzy_min_length?: number;
  fuzzy_mid_length?: number;
  fuzzy_max_distance?: number;
  embedding?: OpenWikiSearchEmbeddingConfig;
  enabled_retrievers?: Partial<Record<SearchRetriever, boolean>>;
  persona_weights?: Partial<Record<SearchPersona, Partial<Record<SearchRetriever, number>>>>;
}

export const DEFAULT_OPENWIKI_SEARCH_CONFIG = {
  default_persona: "default",
  default_limit: 20,
  max_limit: 200,
  max_query_length: 2000,
  overfetch: 3,
  rrf_k: 60,
  ngram_min: 3,
  fuzzy_min_length: 4,
  fuzzy_mid_length: 7,
  fuzzy_max_distance: 2,
  enabled_retrievers: {
    exact: true,
    bm25: true,
    ngram: true,
    fuzzy: true,
    graph: true,
    vector: false,
  },
  embedding: {
    enabled: false,
    provider: "local",
    model: "openwiki-local-sparse-v1",
    dimensions: 256,
    max_chunk_characters: 1200,
    chunk_overlap_characters: 120,
    batch_size: 64,
    rebuild: "index",
  },
  persona_weights: {
    default: { exact: 2.0, bm25: 1.0, ngram: 0.8, fuzzy: 0.6, graph: 1.0, vector: 0.9 },
    researcher: { exact: 1.8, bm25: 1.0, ngram: 0.9, fuzzy: 0.7, graph: 1.2, vector: 1.2 },
    editor: { exact: 2.4, bm25: 1.3, ngram: 1.0, fuzzy: 0.8, graph: 0.9, vector: 0.8 },
    reviewer: { exact: 1.8, bm25: 1.0, ngram: 0.8, fuzzy: 0.6, graph: 1.2, vector: 1.0 },
    governance: { exact: 1.8, bm25: 1.1, ngram: 0.8, fuzzy: 0.6, graph: 1.3, vector: 0.9 },
  },
} as const;
