import os from "node:os";
import path from "node:path";
import { validateOpenWikiGitRemoteUrl, type OpenWikiBackupDestinationKind, type OpenWikiConfig, type ValidationIssue } from "@openwiki/core";
import { SOURCE_FETCH_CONNECTOR_KINDS } from "@openwiki/connectors";

export interface ValidateOpenWikiConfigOptions {
  root?: string;
  pathForIssues?: string;
  allowLocalGitRemote?: boolean;
}

const SYNC_MODES = new Set(["manual", "auto"]);
const SYNC_CONFLICT_POLICIES = new Set(["stop"]);
const SYNC_KEYS = new Set(["remote", "branch", "mode", "pull_on_start", "push_after_commit", "sync_after_events", "debounce_seconds", "max_attempts", "backoff_seconds", "interval_seconds", "conflict_policy"]);
const AUTOMATION_EVENTS = new Set(["proposal.applied", "source.ingested", "inbox.proposed", "inbox.processed"]);
const RUNTIME_PROFILES = new Set(["local", "team", "hosted", "static", "compose", "umbrel", "cloud", "enterprise"]);
const RUNTIME_KEYS = new Set(["profile", "sync", "backups", "queue", "storage", "connectors", "secrets", "git", "controls", "schema_pack"]);
const QUEUE_BACKENDS = new Set(["local", "postgres"]);
const QUEUE_KEYS = new Set(["backend", "poll_ms", "max_jobs_per_worker"]);
const STORAGE_BACKENDS = new Set(["local", "s3", "minio"]);
const STORAGE_KEYS = new Set(["backend", "local_path", "inline_max_bytes", "endpoint_url", "bucket", "region", "prefix", "force_path_style", "access_key_id_env", "secret_access_key_env", "session_token_env"]);
const CONNECTOR_KEYS = new Set(SOURCE_FETCH_CONNECTOR_KINDS);
const HTTP_CONNECTOR_KEYS = new Set(["id", "label", "allowed_hosts", "credential_refs", "default_headers"]);
const REPOSITORY_CONNECTOR_KEYS = new Set(["id", "label", "web_base_url", "api_base_url", "allowed_repositories", "credential_refs"]);
const SECRET_BACKENDS = new Set(["none", "env"]);
const SECRET_KEYS = new Set(["backend", "env_prefix"]);
const GIT_KEYS = new Set(["remote", "branch", "remote_url", "credential_ref"]);
const SCHEMA_PACK_KEYS = new Set(["path", "name"]);
const CONTROL_KEYS = new Set(["rate_limits", "source_fetch", "operational_state"]);
const RATE_LIMIT_KEYS = new Set(["enabled", "window_ms", "default_limit", "mcp_limit", "search_limit", "ask_limit", "source_limit", "proposal_limit", "policy_limit", "inbox_limit", "job_limit", "auth_limit"]);
const SOURCE_FETCH_CONTROL_KEYS = new Set(["default_max_bytes", "max_bytes", "default_timeout_ms", "max_timeout_ms"]);
const OPERATIONAL_STATE_BACKENDS = new Set(["memory", "postgres"]);
const OPERATIONAL_STATE_KEYS = new Set(["backend"]);
const BACKUP_SCHEDULES = new Set(["manual", "hourly", "daily", "weekly"]);
const BACKUP_KEYS = new Set(["enabled", "schedule", "backup_after_events", "event_threshold", "min_interval_seconds", "default_destination_id", "retention", "destinations"]);
const BACKUP_DESTINATION_KINDS = new Set<OpenWikiBackupDestinationKind>([
  "local",
  "s3",
  "minio",
  "gcs",
  "google-drive",
  "webdav",
  "rclone",
]);
const DERIVED_WORKSPACE_PATHS = [
  ".git",
  ".openwiki",
  ".openwiki/index",
  ".openwiki/index-store",
  ".openwiki/cache",
  ".openwiki/objects",
  ".openwiki/locks",
  ".openwiki/tmp",
  ".openwiki/worktrees",
];
const SECRET_FIELD_PATTERN = /(^|[_-])(authorization|body|cookie|credential|headers?|password|private[_-]?key|secret|token|access[_-]?key|connection[_-]?string)([_-]|$)/i;
const SAFE_SECRET_REFERENCE_FIELDS = new Set([
  "credential_ref",
  "credentials_env",
  "access_key_id_env",
  "secret_access_key_env",
  "session_token_env",
]);

export function validateOpenWikiConfig(config: OpenWikiConfig, options: ValidateOpenWikiConfigOptions = {}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const issuePath = options.pathForIssues ?? "openwiki.json";
  const configRecord = recordFromUnknown(config);
  const runtime = recordFromUnknown(configRecord?.runtime);
  if (runtime === undefined) {
    return issues;
  }

  validateKnownProperties(runtime, RUNTIME_KEYS, "runtime", issuePath, issues);
  if (runtime.profile !== undefined && (typeof runtime.profile !== "string" || !RUNTIME_PROFILES.has(runtime.profile))) {
    issues.push(validationIssue("error", "config.runtime.profile.invalid", "runtime.profile must be local, team, hosted, static, compose, umbrel, cloud, or enterprise.", issuePath));
  }

  const sync = runtime.sync;
  if (sync !== undefined) {
    validateSyncConfig(sync, issuePath, issues);
  }

  const backups = runtime.backups;
  if (backups !== undefined) {
    validateBackupConfig(backups, issuePath, issues, options.root);
  }

  if (runtime.queue !== undefined) {
    validateQueueConfig(runtime.queue, issuePath, issues);
  }
  if (runtime.storage !== undefined) {
    validateStorageConfig(runtime.storage, issuePath, issues);
  }
  if (runtime.connectors !== undefined) {
    validateConnectorConfig(runtime.connectors, issuePath, issues);
  }
  if (runtime.secrets !== undefined) {
    validateSecretsConfig(runtime.secrets, issuePath, issues);
  }
  if (runtime.git !== undefined) {
    validateGitConfig(runtime.git, issuePath, issues, options);
  }
  if (runtime.controls !== undefined) {
    validateControlsConfig(runtime.controls, issuePath, issues);
  }
  if (runtime.schema_pack !== undefined) {
    validateSchemaPackConfig(runtime.schema_pack, issuePath, issues);
  }

  return issues;
}

function validateSyncConfig(value: unknown, issuePath: string, issues: ValidationIssue[]): void {
  const sync = recordFromUnknown(value);
  if (sync === undefined) {
    issues.push(validationIssue("error", "config.sync.invalid", "runtime.sync must be an object.", issuePath));
    return;
  }
  validateKnownProperties(sync, SYNC_KEYS, "runtime.sync", issuePath, issues);

  if (sync.remote !== undefined) {
    validateGitRemoteName(sync.remote, "config.sync.remote.invalid", "runtime.sync.remote", issuePath, issues);
  }
  if (sync.branch !== undefined) {
    validateGitBranchName(sync.branch, "config.sync.branch.invalid", "runtime.sync.branch", issuePath, issues);
  }
  if (sync.mode !== undefined && (typeof sync.mode !== "string" || !SYNC_MODES.has(sync.mode))) {
    issues.push(validationIssue("error", "config.sync.mode.invalid", "runtime.sync.mode must be manual or auto.", issuePath));
  }
  if (sync.conflict_policy !== undefined && (typeof sync.conflict_policy !== "string" || !SYNC_CONFLICT_POLICIES.has(sync.conflict_policy))) {
    issues.push(validationIssue("error", "config.sync.conflict_policy.invalid", "runtime.sync.conflict_policy must be stop.", issuePath));
  }
  if (sync.interval_seconds !== undefined) {
    validateIntegerRange(sync.interval_seconds, 60, 7 * 24 * 60 * 60, "config.sync.interval.invalid", "runtime.sync.interval_seconds must be an integer from 60 to 604800 seconds.", issuePath, issues);
  }
  validateAutomationEvents(sync.sync_after_events, "config.sync.sync_after_events.invalid", "runtime.sync.sync_after_events", issuePath, issues);
  if (sync.debounce_seconds !== undefined) {
    validateIntegerRange(sync.debounce_seconds, 0, 24 * 60 * 60, "config.sync.debounce.invalid", "runtime.sync.debounce_seconds must be an integer from 0 to 86400 seconds.", issuePath, issues);
  }
  if (sync.max_attempts !== undefined) {
    validateIntegerRange(sync.max_attempts, 1, 20, "config.sync.max_attempts.invalid", "runtime.sync.max_attempts must be an integer from 1 to 20.", issuePath, issues);
  }
  if (sync.backoff_seconds !== undefined) {
    validateIntegerRange(sync.backoff_seconds, 0, 7 * 24 * 60 * 60, "config.sync.backoff.invalid", "runtime.sync.backoff_seconds must be an integer from 0 to 604800 seconds.", issuePath, issues);
  }
  if (sync.pull_on_start !== undefined && typeof sync.pull_on_start !== "boolean") {
    issues.push(validationIssue("error", "config.sync.pull_on_start.invalid", "runtime.sync.pull_on_start must be boolean.", issuePath));
  }
  if (sync.push_after_commit !== undefined && typeof sync.push_after_commit !== "boolean") {
    issues.push(validationIssue("error", "config.sync.push_after_commit.invalid", "runtime.sync.push_after_commit must be boolean.", issuePath));
  }
}

function validateQueueConfig(value: unknown, issuePath: string, issues: ValidationIssue[]): void {
  const queue = recordFromUnknown(value);
  if (queue === undefined) {
    issues.push(validationIssue("error", "config.queue.invalid", "runtime.queue must be an object.", issuePath));
    return;
  }
  validateKnownProperties(queue, QUEUE_KEYS, "runtime.queue", issuePath, issues);
  if (queue.backend !== undefined && (typeof queue.backend !== "string" || !QUEUE_BACKENDS.has(queue.backend))) {
    issues.push(validationIssue("error", "config.queue.backend.invalid", "runtime.queue.backend must be local or postgres in v0.1.", issuePath));
  }
  if (queue.poll_ms !== undefined) {
    validateIntegerRange(queue.poll_ms, 0, Number.MAX_SAFE_INTEGER, "config.queue.poll_ms.invalid", "runtime.queue.poll_ms must be a non-negative integer.", issuePath, issues);
  }
  if (queue.max_jobs_per_worker !== undefined) {
    validateIntegerRange(queue.max_jobs_per_worker, 1, Number.MAX_SAFE_INTEGER, "config.queue.max_jobs_per_worker.invalid", "runtime.queue.max_jobs_per_worker must be a positive integer.", issuePath, issues);
  }
}

function validateSchemaPackConfig(value: unknown, issuePath: string, issues: ValidationIssue[]): void {
  const schemaPack = recordFromUnknown(value);
  if (schemaPack === undefined) {
    issues.push(validationIssue("error", "config.schema_pack.invalid", "runtime.schema_pack must be an object.", issuePath));
    return;
  }
  validateKnownProperties(schemaPack, SCHEMA_PACK_KEYS, "runtime.schema_pack", issuePath, issues);
  validateOptionalString(schemaPack.path, "config.schema_pack.path.invalid", "runtime.schema_pack.path must be a string.", issuePath, issues);
  validateOptionalString(schemaPack.name, "config.schema_pack.name.invalid", "runtime.schema_pack.name must be a string.", issuePath, issues);
  if (schemaPack.path !== undefined && schemaPack.name !== undefined) {
    issues.push(validationIssue("error", "config.schema_pack.reference.ambiguous", "runtime.schema_pack must set path or name, not both.", issuePath));
  }
}

function validateStorageConfig(value: unknown, issuePath: string, issues: ValidationIssue[]): void {
  const storage = recordFromUnknown(value);
  if (storage === undefined) {
    issues.push(validationIssue("error", "config.storage.invalid", "runtime.storage must be an object.", issuePath));
    return;
  }
  validateKnownProperties(storage, STORAGE_KEYS, "runtime.storage", issuePath, issues);
  if (storage.backend !== undefined && (typeof storage.backend !== "string" || !STORAGE_BACKENDS.has(storage.backend))) {
    issues.push(validationIssue("error", "config.storage.backend.invalid", "runtime.storage.backend must be local, s3, or minio in v0.1. Use backup destinations for gcs.", issuePath));
  }
  for (const field of ["local_path", "endpoint_url", "bucket", "region", "prefix", "access_key_id_env", "secret_access_key_env", "session_token_env"]) {
    validateOptionalString(storage[field], `config.storage.${field}.invalid`, `runtime.storage.${field} must be a string.`, issuePath, issues);
  }
  if (storage.inline_max_bytes !== undefined) {
    validateIntegerRange(storage.inline_max_bytes, 0, Number.MAX_SAFE_INTEGER, "config.storage.inline_max_bytes.invalid", "runtime.storage.inline_max_bytes must be a non-negative integer.", issuePath, issues);
  }
  if (storage.force_path_style !== undefined && typeof storage.force_path_style !== "boolean") {
    issues.push(validationIssue("error", "config.storage.force_path_style.invalid", "runtime.storage.force_path_style must be boolean.", issuePath));
  }
}

function validateConnectorConfig(value: unknown, issuePath: string, issues: ValidationIssue[]): void {
  const connectors = recordFromUnknown(value);
  if (connectors === undefined) {
    issues.push(validationIssue("error", "config.connectors.invalid", "runtime.connectors must be an object.", issuePath));
    return;
  }
  validateKnownProperties(connectors, CONNECTOR_KEYS, "runtime.connectors", issuePath, issues);
  validateConnectorArray(connectors.http, "http", HTTP_CONNECTOR_KEYS, issuePath, issues);
  validateConnectorArray(connectors.github, "github", REPOSITORY_CONNECTOR_KEYS, issuePath, issues);
  validateConnectorArray(connectors.gitlab, "gitlab", REPOSITORY_CONNECTOR_KEYS, issuePath, issues);
}

function validateConnectorArray(
  value: unknown,
  kind: "http" | "github" | "gitlab",
  allowedKeys: Set<string>,
  issuePath: string,
  issues: ValidationIssue[],
): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    issues.push(validationIssue("error", `config.connectors.${kind}.invalid`, `runtime.connectors.${kind} must be an array.`, issuePath));
    return;
  }
  for (const [index, rawConnector] of value.entries()) {
    const connector = recordFromUnknown(rawConnector);
    const connectorPath = `${issuePath}:runtime.connectors.${kind}[${index}]`;
    if (connector === undefined) {
      issues.push(validationIssue("error", `config.connectors.${kind}.entry.invalid`, `${kind} connector must be an object.`, connectorPath));
      continue;
    }
    validateKnownProperties(connector, allowedKeys, `runtime.connectors.${kind}[${index}]`, connectorPath, issues);
    validateRequiredString(connector.id, `config.connectors.${kind}.id.missing`, `${kind} connector requires id.`, connectorPath, issues);
    if (kind === "http") {
      validateStringArray(connector.allowed_hosts, `config.connectors.${kind}.allowed_hosts.invalid`, `${kind} connector requires allowed_hosts with at least one host.`, connectorPath, issues, { minItems: 1 });
    } else {
      validateStringArray(connector.allowed_repositories, `config.connectors.${kind}.allowed_repositories.invalid`, `${kind} connector requires allowed_repositories with at least one repository.`, connectorPath, issues, { minItems: 1 });
      validateOptionalString(connector.web_base_url, `config.connectors.${kind}.web_base_url.invalid`, `${kind} connector web_base_url must be a string.`, connectorPath, issues);
      validateOptionalString(connector.api_base_url, `config.connectors.${kind}.api_base_url.invalid`, `${kind} connector api_base_url must be a string.`, connectorPath, issues);
    }
    validateOptionalString(connector.label, `config.connectors.${kind}.label.invalid`, `${kind} connector label must be a string.`, connectorPath, issues);
    validateStringArray(connector.credential_refs, `config.connectors.${kind}.credential_refs.invalid`, `${kind} connector credential_refs must be strings.`, connectorPath, issues);
    const headers = connector.default_headers;
    if (headers !== undefined && recordFromUnknown(headers) === undefined) {
      issues.push(validationIssue("error", `config.connectors.${kind}.default_headers.invalid`, `${kind} connector default_headers must be an object.`, connectorPath));
    }
  }
}

function validateSecretsConfig(value: unknown, issuePath: string, issues: ValidationIssue[]): void {
  const secrets = recordFromUnknown(value);
  if (secrets === undefined) {
    issues.push(validationIssue("error", "config.secrets.invalid", "runtime.secrets must be an object.", issuePath));
    return;
  }
  validateKnownProperties(secrets, SECRET_KEYS, "runtime.secrets", issuePath, issues);
  if (secrets.backend !== undefined && (typeof secrets.backend !== "string" || !SECRET_BACKENDS.has(secrets.backend))) {
    issues.push(validationIssue("error", "config.secrets.backend.invalid", "runtime.secrets.backend must be none or env.", issuePath));
  }
  validateOptionalString(secrets.env_prefix, "config.secrets.env_prefix.invalid", "runtime.secrets.env_prefix must be a string.", issuePath, issues);
}

function validateGitConfig(value: unknown, issuePath: string, issues: ValidationIssue[], options: ValidateOpenWikiConfigOptions): void {
  const git = recordFromUnknown(value);
  if (git === undefined) {
    issues.push(validationIssue("error", "config.git.invalid", "runtime.git must be an object.", issuePath));
    return;
  }
  validateKnownProperties(git, GIT_KEYS, "runtime.git", issuePath, issues);
  if (git.remote !== undefined) {
    validateGitRemoteName(git.remote, "config.git.remote.invalid", "runtime.git.remote", issuePath, issues);
  }
  if (git.branch !== undefined) {
    validateGitBranchName(git.branch, "config.git.branch.invalid", "runtime.git.branch", issuePath, issues);
  }
  validateOptionalGitRemoteUrl(git.remote_url, issuePath, issues, options);
  validateOptionalString(git.credential_ref, "config.git.credential_ref.invalid", "runtime.git.credential_ref must be a string.", issuePath, issues);
}

function validateControlsConfig(value: unknown, issuePath: string, issues: ValidationIssue[]): void {
  const controls = recordFromUnknown(value);
  if (controls === undefined) {
    issues.push(validationIssue("error", "config.controls.invalid", "runtime.controls must be an object.", issuePath));
    return;
  }
  validateKnownProperties(controls, CONTROL_KEYS, "runtime.controls", issuePath, issues);
  validateRateLimitsConfig(controls.rate_limits, issuePath, issues);
  validateSourceFetchControls(controls.source_fetch, issuePath, issues);
  validateOperationalStateControls(controls.operational_state, issuePath, issues);
}

function validateRateLimitsConfig(value: unknown, issuePath: string, issues: ValidationIssue[]): void {
  if (value === undefined) {
    return;
  }
  const rateLimits = recordFromUnknown(value);
  if (rateLimits === undefined) {
    issues.push(validationIssue("error", "config.controls.rate_limits.invalid", "runtime.controls.rate_limits must be an object.", issuePath));
    return;
  }
  validateKnownProperties(rateLimits, RATE_LIMIT_KEYS, "runtime.controls.rate_limits", issuePath, issues);
  if (rateLimits.enabled !== undefined && typeof rateLimits.enabled !== "boolean") {
    issues.push(validationIssue("error", "config.controls.rate_limits.enabled.invalid", "runtime.controls.rate_limits.enabled must be boolean.", issuePath));
  }
  if (rateLimits.window_ms !== undefined) {
    validateIntegerRange(rateLimits.window_ms, 1000, 3600000, "config.controls.rate_limits.window_ms.invalid", "runtime.controls.rate_limits.window_ms must be an integer from 1000 to 3600000.", issuePath, issues);
  }
  for (const field of ["default_limit", "mcp_limit", "search_limit", "ask_limit", "source_limit", "proposal_limit", "policy_limit", "inbox_limit", "job_limit", "auth_limit"]) {
    if (rateLimits[field] !== undefined) {
      validateIntegerRange(rateLimits[field], 0, Number.MAX_SAFE_INTEGER, `config.controls.rate_limits.${field}.invalid`, `runtime.controls.rate_limits.${field} must be a non-negative integer.`, issuePath, issues);
    }
  }
}

function validateSourceFetchControls(value: unknown, issuePath: string, issues: ValidationIssue[]): void {
  if (value === undefined) {
    return;
  }
  const sourceFetch = recordFromUnknown(value);
  if (sourceFetch === undefined) {
    issues.push(validationIssue("error", "config.controls.source_fetch.invalid", "runtime.controls.source_fetch must be an object.", issuePath));
    return;
  }
  validateKnownProperties(sourceFetch, SOURCE_FETCH_CONTROL_KEYS, "runtime.controls.source_fetch", issuePath, issues);
  for (const field of SOURCE_FETCH_CONTROL_KEYS) {
    if (sourceFetch[field] !== undefined) {
      validateIntegerRange(sourceFetch[field], 1, Number.MAX_SAFE_INTEGER, `config.controls.source_fetch.${field}.invalid`, `runtime.controls.source_fetch.${field} must be a positive integer.`, issuePath, issues);
    }
  }
}

function validateOperationalStateControls(value: unknown, issuePath: string, issues: ValidationIssue[]): void {
  if (value === undefined) {
    return;
  }
  const operationalState = recordFromUnknown(value);
  if (operationalState === undefined) {
    issues.push(validationIssue("error", "config.controls.operational_state.invalid", "runtime.controls.operational_state must be an object.", issuePath));
    return;
  }
  validateKnownProperties(operationalState, OPERATIONAL_STATE_KEYS, "runtime.controls.operational_state", issuePath, issues);
  if (operationalState.backend !== undefined && (typeof operationalState.backend !== "string" || !OPERATIONAL_STATE_BACKENDS.has(operationalState.backend))) {
    issues.push(validationIssue("error", "config.controls.operational_state.backend.invalid", "runtime.controls.operational_state.backend must be memory or postgres.", issuePath));
  }
}

function validateBackupConfig(value: unknown, issuePath: string, issues: ValidationIssue[], root: string | undefined): void {
  const backups = recordFromUnknown(value);
  if (backups === undefined) {
    issues.push(validationIssue("error", "config.backups.invalid", "runtime.backups must be an object.", issuePath));
    return;
  }
  validateKnownProperties(backups, BACKUP_KEYS, "runtime.backups", issuePath, issues);

  if (backups.enabled !== undefined && typeof backups.enabled !== "boolean") {
    issues.push(validationIssue("error", "config.backups.enabled.invalid", "runtime.backups.enabled must be boolean.", issuePath));
  }
  if (backups.schedule !== undefined && (typeof backups.schedule !== "string" || !BACKUP_SCHEDULES.has(backups.schedule))) {
    issues.push(validationIssue("error", "config.backups.schedule.invalid", "runtime.backups.schedule must be manual, hourly, daily, or weekly.", issuePath));
  }
  validateAutomationEvents(backups.backup_after_events, "config.backups.backup_after_events.invalid", "runtime.backups.backup_after_events", issuePath, issues);
  if (backups.event_threshold !== undefined) {
    validateIntegerRange(backups.event_threshold, 1, 10000, "config.backups.event_threshold.invalid", "runtime.backups.event_threshold must be an integer from 1 to 10000.", issuePath, issues);
  }
  if (backups.min_interval_seconds !== undefined) {
    validateIntegerRange(backups.min_interval_seconds, 0, 7 * 24 * 60 * 60, "config.backups.min_interval.invalid", "runtime.backups.min_interval_seconds must be an integer from 0 to 604800 seconds.", issuePath, issues);
  }
  if (backups.default_destination_id !== undefined && (typeof backups.default_destination_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(backups.default_destination_id))) {
    issues.push(validationIssue("error", "config.backups.default_destination_id.invalid", "runtime.backups.default_destination_id must name a configured backup destination.", issuePath));
  }

  const retention = backups.retention === undefined ? undefined : recordFromUnknown(backups.retention);
  if (backups.retention !== undefined && retention === undefined) {
    issues.push(validationIssue("error", "config.backups.retention.invalid", "runtime.backups.retention must be an object.", issuePath));
  }
  if (retention !== undefined) {
    if (retention.keep_last !== undefined) {
      validateIntegerRange(retention.keep_last, 1, 10000, "config.backups.retention.keep_last.invalid", "runtime.backups.retention.keep_last must be an integer from 1 to 10000.", issuePath, issues);
    }
    if (retention.keep_days !== undefined) {
      validateIntegerRange(retention.keep_days, 1, 3650, "config.backups.retention.keep_days.invalid", "runtime.backups.retention.keep_days must be an integer from 1 to 3650.", issuePath, issues);
    }
  }

  if (backups.destinations === undefined) {
    if (backups.default_destination_id !== undefined) {
      issues.push(validationIssue("error", "config.backups.default_destination_id.unknown", "runtime.backups.default_destination_id requires runtime.backups.destinations.", issuePath));
    }
    return;
  }
  if (!Array.isArray(backups.destinations)) {
    issues.push(validationIssue("error", "config.backups.destinations.invalid", "runtime.backups.destinations must be an array.", issuePath));
    return;
  }

  const destinationIds = new Set<string>();
  for (const [index, rawDestination] of backups.destinations.entries()) {
    const destination = recordFromUnknown(rawDestination);
    const destinationPath = `${issuePath}:runtime.backups.destinations[${index}]`;
    if (destination === undefined) {
      issues.push(validationIssue("error", "config.backups.destination.invalid", "Backup destination must be an object.", destinationPath));
      continue;
    }
    validateBackupDestination(destination, destinationPath, destinationIds, issues, root);
  }
  if (typeof backups.default_destination_id === "string" && !destinationIds.has(backups.default_destination_id)) {
    issues.push(validationIssue("error", "config.backups.default_destination_id.unknown", `runtime.backups.default_destination_id references unknown destination '${backups.default_destination_id}'.`, issuePath));
  }
  if (backups.enabled === true && Array.isArray(backups.backup_after_events) && backups.backup_after_events.length > 0 && backups.destinations.length > 1 && backups.default_destination_id === undefined) {
    issues.push(validationIssue("error", "config.backups.default_destination_id.required", "Event-triggered backups with multiple destinations must set runtime.backups.default_destination_id.", issuePath));
  }
}

function validateAutomationEvents(
  value: unknown,
  code: string,
  field: string,
  issuePath: string,
  issues: ValidationIssue[],
): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !AUTOMATION_EVENTS.has(entry))) {
    issues.push(validationIssue("error", code, `${field} must list proposal.applied, source.ingested, inbox.proposed, or inbox.processed.`, issuePath));
  }
}

function validateKnownProperties(
  record: Record<string, unknown>,
  allowed: Set<string>,
  label: string,
  issuePath: string,
  issues: ValidationIssue[],
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      issues.push(validationIssue("error", "config.property.unknown", `${label}.${key} is not a supported OpenWiki configuration field.`, issuePath));
    }
  }
}

function validateBackupDestination(
  destination: Record<string, unknown>,
  issuePath: string,
  destinationIds: Set<string>,
  issues: ValidationIssue[],
  root: string | undefined,
): void {
  const id = destination.id;
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) {
    issues.push(validationIssue("error", "config.backups.destination.id.invalid", "Backup destination id must start with an alphanumeric character and contain only letters, numbers, dot, underscore, or dash.", issuePath));
  } else if (destinationIds.has(id)) {
    issues.push(validationIssue("error", "config.backups.destination.id.duplicate", `Duplicate backup destination id '${id}'.`, issuePath));
  } else {
    destinationIds.add(id);
  }

  const kind = destination.kind;
  if (typeof kind !== "string" || !BACKUP_DESTINATION_KINDS.has(kind as OpenWikiBackupDestinationKind)) {
    issues.push(validationIssue("error", "config.backups.destination.kind.invalid", "Backup destination kind is not recognized.", issuePath));
  }

  validateNoRawBackupSecrets(destination, issuePath, issues);
  for (const field of ["credentials_env", "access_key_id_env", "secret_access_key_env", "session_token_env"]) {
    const value = destination[field];
    if (value !== undefined && (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))) {
      issues.push(validationIssue("error", "config.backups.destination.env.invalid", `${field} must name an environment variable.`, issuePath));
    }
  }
  if (destination.credential_ref !== undefined && (typeof destination.credential_ref !== "string" || !destination.credential_ref.startsWith("cred:"))) {
    issues.push(validationIssue("error", "config.backups.destination.credential_ref.invalid", "credential_ref must use a cred: reference, not a raw secret.", issuePath));
  }

  if (kind === "local") {
    validateLocalBackupDestinationPath(destination, issuePath, issues, root);
  } else if (kind === "s3" || kind === "minio") {
    validateRequiredString(destination.bucket, "config.backups.destination.bucket.missing", "S3 backup destinations require bucket.", issuePath, issues);
    if (kind === "minio") {
      validateRequiredString(destination.endpoint_url, "config.backups.destination.endpoint_url.missing", "MinIO backup destinations require endpoint_url.", issuePath, issues);
    }
    validateRequiredString(destination.access_key_id_env, "config.backups.destination.access_key_id_env.missing", "S3 backup destinations require access_key_id_env.", issuePath, issues);
    validateRequiredString(destination.secret_access_key_env, "config.backups.destination.secret_access_key_env.missing", "S3 backup destinations require secret_access_key_env.", issuePath, issues);
    validateBackupPrefix(destination.prefix, issuePath, issues);
  } else if (kind === "gcs") {
    validateRequiredString(destination.bucket, "config.backups.destination.bucket.missing", "GCS backup destinations require bucket.", issuePath, issues);
    validateRequiredString(destination.credentials_env, "config.backups.destination.credentials_env.missing", "GCS backup destinations require credentials_env.", issuePath, issues);
    validateBackupPrefix(destination.prefix, issuePath, issues);
  } else if (kind === "rclone") {
    validateRcloneRemote(destination.remote, issuePath, issues);
    validateBackupPrefix(destination.prefix, issuePath, issues);
  }
}

function validateRcloneRemote(value: unknown, issuePath: string, issues: ValidationIssue[]): void {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.includes("\0") ||
    /[\r\n]/u.test(value) ||
    value.startsWith("-") ||
    value.includes("://") ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}:/.test(value.trim())
  ) {
    issues.push(validationIssue("error", "config.backups.destination.remote.invalid", "Rclone backup destinations require remote to name a configured rclone remote such as drive:OpenWikiBackups.", issuePath));
  }
}

function validateRequiredString(
  value: unknown,
  code: string,
  message: string,
  issuePath: string,
  issues: ValidationIssue[],
): void {
  if (typeof value !== "string" || value.trim() === "") {
    issues.push(validationIssue("error", code, message, issuePath));
  }
}

function validateOptionalString(
  value: unknown,
  code: string,
  message: string,
  issuePath: string,
  issues: ValidationIssue[],
): void {
  if (value !== undefined && (typeof value !== "string" || value.trim() === "")) {
    issues.push(validationIssue("error", code, message, issuePath));
  }
}

function validateStringArray(
  value: unknown,
  code: string,
  message: string,
  issuePath: string,
  issues: ValidationIssue[],
  options: { minItems?: number } = {},
): void {
  if (value === undefined && options.minItems === undefined) {
    return;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "") || value.length < (options.minItems ?? 0)) {
    issues.push(validationIssue("error", code, message, issuePath));
  }
}

function validateBackupPrefix(value: unknown, issuePath: string, issues: ValidationIssue[]): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "string" || value.includes("\0") || value.replace(/\\/g, "/").split("/").some((part) => part === "..")) {
    issues.push(validationIssue("error", "config.backups.destination.prefix.invalid", "Backup destination prefix must be a safe object prefix.", issuePath));
  }
}

function validateNoRawBackupSecrets(destination: Record<string, unknown>, issuePath: string, issues: ValidationIssue[]): void {
  for (const [key, value] of Object.entries(destination)) {
    if (SAFE_SECRET_REFERENCE_FIELDS.has(key) || key.endsWith("_env")) {
      continue;
    }
    if (SECRET_FIELD_PATTERN.test(key) && value !== undefined) {
      issues.push(validationIssue("error", "config.backups.destination.secret.invalid", `${key} looks like a raw secret field; store only env var names or credential refs in openwiki.json.`, issuePath));
    }
  }
}

function validateLocalBackupDestinationPath(
  destination: Record<string, unknown>,
  issuePath: string,
  issues: ValidationIssue[],
  root: string | undefined,
): void {
  if (typeof destination.path !== "string" || destination.path.trim() === "") {
    issues.push(validationIssue("error", "config.backups.destination.path.missing", "Local backup destinations require a non-empty path.", issuePath));
    return;
  }
  if (destination.path.includes("\0")) {
    issues.push(validationIssue("error", "config.backups.destination.path.invalid", "Backup destination path must not contain NUL bytes.", issuePath));
    return;
  }
  if (root === undefined) {
    return;
  }

  const resolvedRoot = path.resolve(root);
  const resolvedDestination = resolveConfigPath(resolvedRoot, destination.path);
  const allowWorkspaceRelative = destination.allow_workspace_relative === true;
  if (resolvedDestination === path.parse(resolvedDestination).root) {
    issues.push(validationIssue("error", "config.backups.destination.path.filesystem_root", "Backup destination must not be the filesystem root.", issuePath));
  }
  if (samePath(resolvedDestination, resolvedRoot)) {
    issues.push(validationIssue("error", "config.backups.destination.path.workspace_root", "Backup destination must not be the live OpenWiki workspace root.", issuePath));
  }
  if (isPathWithin(resolvedRoot, resolvedDestination)) {
    issues.push(validationIssue("error", "config.backups.destination.path.contains_workspace", "Backup destination must not contain the live OpenWiki workspace.", issuePath));
  }
  const unsafeDerived = DERIVED_WORKSPACE_PATHS.find((relativePath) => {
    const unsafePath = path.resolve(resolvedRoot, relativePath);
    return samePath(resolvedDestination, unsafePath) || isPathWithin(resolvedDestination, unsafePath);
  });
  if (unsafeDerived !== undefined) {
    issues.push(validationIssue("error", "config.backups.destination.path.derived_state", `Backup destination must not be inside ${unsafeDerived}.`, issuePath));
  }
  if (isPathWithin(resolvedDestination, resolvedRoot) && !allowWorkspaceRelative) {
    issues.push(validationIssue("error", "config.backups.destination.path.inside_workspace", "Backup destination inside the workspace requires allow_workspace_relative=true and must avoid .git and .openwiki derived state.", issuePath));
  }
  if (destination.allow_workspace_relative !== undefined && typeof destination.allow_workspace_relative !== "boolean") {
    issues.push(validationIssue("error", "config.backups.destination.allow_workspace_relative.invalid", "allow_workspace_relative must be boolean.", issuePath));
  }
}

function validateGitRemoteName(value: unknown, code: string, label: string, issuePath: string, issues: ValidationIssue[]): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value.startsWith("-")) {
    issues.push(validationIssue("error", code, `${label} must be a safe Git remote name.`, issuePath));
  }
}

function validateGitBranchName(value: unknown, code: string, label: string, issuePath: string, issues: ValidationIssue[]): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 255 ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.endsWith(".lock") ||
    value.includes("..") ||
    value.includes("//") ||
    value.includes("@{") ||
    /[\s~^:?*[\\\x00-\x1F\x7F]/.test(value)
  ) {
    issues.push(validationIssue("error", code, `${label} must be a safe Git branch name.`, issuePath));
  }
}

function validateOptionalGitRemoteUrl(value: unknown, issuePath: string, issues: ValidationIssue[], options: ValidateOpenWikiConfigOptions): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "string") {
    issues.push(validationIssue("error", "config.git.remote_url.invalid", "runtime.git.remote_url must be a string.", issuePath));
    return;
  }
  try {
    validateOpenWikiGitRemoteUrl(value, { allowLocalRemotes: options.allowLocalGitRemote ?? (process.env.OPENWIKI_ALLOW_LOCAL_GIT_REMOTE === "1") });
  } catch (error) {
    issues.push(validationIssue("error", "config.git.remote_url.invalid", error instanceof Error ? error.message : "runtime.git.remote_url is not safe.", issuePath));
  }
}

function validateIntegerRange(
  value: unknown,
  min: number,
  max: number,
  code: string,
  message: string,
  issuePath: string,
  issues: ValidationIssue[],
): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    issues.push(validationIssue("error", code, message, issuePath));
  }
}

function recordFromUnknown(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function resolveConfigPath(root: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed === "~") {
    return os.homedir();
  }
  if (trimmed.startsWith("~/")) {
    return path.resolve(os.homedir(), trimmed.slice(2));
  }
  return path.resolve(root, trimmed);
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

function isPathWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function validationIssue(
  severity: ValidationIssue["severity"],
  code: string,
  message: string,
  pathValue: string,
): ValidationIssue {
  return { severity, code, message, path: pathValue };
}
