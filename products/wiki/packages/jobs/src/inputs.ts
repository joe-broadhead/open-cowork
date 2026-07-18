import {
  SOURCE_FETCH_NUMBER_INPUT_KEYS,
  SOURCE_FETCH_RUN_INPUT_KEYS,
  SOURCE_FETCH_STRING_INPUT_KEYS,
  isSensitiveSourceFetchInputKey,
  type InboxProcessingFailureCategory,
  type OpenWikiSectionVisibility,
} from "@openwiki/core";
import { SOURCE_FETCH_CONNECTOR_KIND_LABEL, isSourceFetchConnectorKind, type SourceFetchConnectorKind } from "@openwiki/connectors";
import { dreamRunInputFromRecord, type SyncWorkspaceNowResult } from "@openwiki/workflows";

export function sanitizeRunInput(runType: string, input: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (runType === "git.sync") {
    return sanitizedRunInput(input, {
      strings: ["remote", "branch", "trigger_event", "trigger_record_id"],
      booleans: ["pull", "push"],
    });
  }
  if (runType === "backup.create") {
    return sanitizedRunInput(input, {
      strings: ["out_dir", "destination_id"],
      booleans: ["include_git"],
    });
  }
  if (runType === "dream.run") {
    const dreamInput = dreamRunInputFromRecord(input);
    return Object.keys(dreamInput).length === 0 ? undefined : {
      ...(dreamInput.phases === undefined ? {} : { phases: dreamInput.phases }),
      ...(dreamInput.limit === undefined ? {} : { limit: dreamInput.limit }),
      ...(dreamInput.maxRecords === undefined ? {} : { max_records: dreamInput.maxRecords }),
      ...(dreamInput.timeoutMs === undefined ? {} : { timeout_ms: dreamInput.timeoutMs }),
      ...(dreamInput.dryRun === undefined ? {} : { dry_run: dreamInput.dryRun }),
      ...(dreamInput.createProposals === undefined ? {} : { create_proposals: dreamInput.createProposals }),
      ...(dreamInput.provider === undefined ? {} : { provider: dreamInput.provider }),
      ...(dreamInput.schemaPack === undefined ? {} : { schema_pack: dreamInput.schemaPack }),
    };
  }
  if (runType !== "source.fetch") {
    return input;
  }

  assertNoSensitiveSourceFetchInput(input);

  const sanitized: Record<string, unknown> = {};
  for (const key of SOURCE_FETCH_STRING_INPUT_KEYS) {
    const value = input[key];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== "string") {
      throw new Error(`Expected string source.fetch run input field '${key}'`);
    }
    if (key === "connector_kind" && !isSourceFetchConnectorKind(value)) {
      throw new Error(`Expected source.fetch connector_kind to be ${SOURCE_FETCH_CONNECTOR_KIND_LABEL}`);
    }
    sanitized[key] = value;
  }
  for (const key of SOURCE_FETCH_NUMBER_INPUT_KEYS) {
    const value = input[key];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`Expected numeric source.fetch run input field '${key}'`);
    }
    sanitized[key] = value;
  }
  return Object.fromEntries(SOURCE_FETCH_RUN_INPUT_KEYS.flatMap((key) => (key in sanitized ? [[key, sanitized[key]]] : [])));
}

export function runJobSubjectPaths(runType: string, explicitPaths: string[] | undefined): string[] | undefined {
  const paths = [...(explicitPaths ?? []), ...(runType === "source.fetch" ? ["sources/manifests", "sources/raw"] : [])]
    .map((entry) => entry.trim())
    .filter((entry, index, values) => entry.length > 0 && values.indexOf(entry) === index);
  return paths.length === 0 ? undefined : paths;
}

export function runJobSensitivity(runType: string): OpenWikiSectionVisibility | undefined {
  return runType === "source.fetch" ? "internal" : undefined;
}

export function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Expected string job input field '${key}'`);
  }
  return value;
}

export function requiredString(input: Record<string, unknown>, key: string): string {
  const value = optionalString(input, key);
  if (value === undefined || !value.trim()) {
    throw new Error(`Expected string job input field '${key}'`);
  }
  return value;
}

export function optionalStringProperty<Key extends string>(
  input: Record<string, unknown>,
  inputKey: string,
  outputKey: Key,
): Partial<Record<Key, string>> {
  const value = optionalString(input, inputKey);
  return value === undefined ? {} : ({ [outputKey]: value } as Partial<Record<Key, string>>);
}

export function optionalNumberProperty<Key extends string>(
  input: Record<string, unknown>,
  inputKey: string,
  outputKey: Key,
): Partial<Record<Key, number>> {
  const value = input[inputKey];
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Expected numeric job input field '${inputKey}'`);
  }
  return { [outputKey]: value } as Partial<Record<Key, number>>;
}

export function optionalBoolean(input: Record<string, unknown>, key: string): boolean | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`Expected boolean job input field '${key}'`);
  }
  return value;
}

export function optionalBooleanProperty<Key extends string>(
  input: Record<string, unknown>,
  inputKey: string,
  outputKey: Key,
): Partial<Record<Key, boolean>> {
  const value = optionalBoolean(input, inputKey);
  return value === undefined ? {} : ({ [outputKey]: value } as Partial<Record<Key, boolean>>);
}

export function optionalConnectorKindProperty<Key extends string>(
  input: Record<string, unknown>,
  inputKey: string,
  outputKey: Key,
): Partial<Record<Key, SourceFetchConnectorKind>> {
  const value = optionalString(input, inputKey);
  if (value === undefined) {
    return {};
  }
  if (!isSourceFetchConnectorKind(value)) {
    throw new Error(`Expected source.fetch connector_kind to be ${SOURCE_FETCH_CONNECTOR_KIND_LABEL}`);
  }
  return { [outputKey]: value } as Partial<Record<Key, SourceFetchConnectorKind>>;
}

export function optionalInboxWatchAdapterProperty<Key extends string>(
  input: Record<string, unknown>,
  inputKey: string,
  outputKey: Key,
): Partial<Record<Key, "file">> {
  const value = optionalString(input, inputKey);
  if (value === undefined) {
    return {};
  }
  if (value !== "file") {
    throw new Error(`Expected inbox.watch adapter to be file`);
  }
  return { [outputKey]: value } as Partial<Record<Key, "file">>;
}

export function optionalInboxFailureProperty<Key extends string>(
  input: Record<string, unknown>,
  inputKey: string,
  outputKey: Key,
): Partial<Record<Key, InboxProcessingFailureCategory>> {
  const value = optionalString(input, inputKey);
  if (value === undefined) {
    return {};
  }
  if (isInboxFailureCategory(value)) {
    return { [outputKey]: value } as Partial<Record<Key, InboxProcessingFailureCategory>>;
  }
  throw new Error(`Expected inbox failure category for job input field '${inputKey}'`);
}

export function inboxStatusesInput(
  value: unknown,
): Array<"received" | "queued" | "processing" | "proposed" | "applied" | "ignored" | "failed" | "superseded"> | undefined {
  if (value === undefined) {
    return undefined;
  }
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,\s]+/) : [];
  if (values.length === 0) {
    return undefined;
  }
  return values.map((entry) => {
    if (
      entry === "received" ||
      entry === "queued" ||
      entry === "processing" ||
      entry === "proposed" ||
      entry === "applied" ||
      entry === "ignored" ||
      entry === "failed" ||
      entry === "superseded"
    ) {
      return entry;
    }
    throw new Error(`Invalid inbox status '${String(entry)}'`);
  });
}

export function syncRunOutput(result: SyncWorkspaceNowResult): Record<string, unknown> {
  return {
    root: result.root,
    status: result.status,
    operations: result.operations,
    before: gitStatusOutput(result.before),
    ...(result.after === undefined ? {} : { after: gitStatusOutput(result.after) }),
    state: result.state,
    ...(result.conflict === undefined ? {} : { conflict: result.conflict }),
    ...(result.error === undefined ? {} : { error: result.error }),
    ...(result.recovery === undefined ? {} : { recovery: result.recovery }),
    ...(result.trigger_event === undefined ? {} : { trigger_event: result.trigger_event }),
  };
}

function sanitizedRunInput(
  input: Record<string, unknown>,
  allowed: { strings?: string[]; booleans?: string[] },
): Record<string, unknown> | undefined {
  const sanitized: Record<string, unknown> = {};
  for (const key of allowed.strings ?? []) {
    const value = input[key];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== "string") {
      throw new Error(`Expected string run input field '${key}'`);
    }
    sanitized[key] = value;
  }
  for (const key of allowed.booleans ?? []) {
    const value = input[key];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== "boolean") {
      throw new Error(`Expected boolean run input field '${key}'`);
    }
    sanitized[key] = value;
  }
  return Object.keys(sanitized).length === 0 ? undefined : sanitized;
}

function assertNoSensitiveSourceFetchInput(value: unknown, path: string[] = []): void {
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSensitiveSourceFetchInput(entry, [...path, String(index)]));
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (isSensitiveSourceFetchInputKey(key)) {
      const fieldPath = [...path, key].join(".");
      throw new Error(`Sensitive source.fetch run input field '${fieldPath}' is not allowed; use connector_id and credential_ref`);
    }
    assertNoSensitiveSourceFetchInput(entry, [...path, key]);
  }
}

function isInboxFailureCategory(value: string): value is InboxProcessingFailureCategory {
  return (
    value === "duplicate" ||
    value === "validation_failed" ||
    value === "payload_unavailable" ||
    value === "permission_denied" ||
    value === "provider_unavailable" ||
    value === "provider_timeout" ||
    value === "proposal_validation_failed" ||
    value === "sync_failed" ||
    value === "unknown_internal_error"
  );
}

function gitStatusOutput(status: SyncWorkspaceNowResult["before"]): Record<string, unknown> {
  return {
    is_git_repo: status.is_git_repo,
    ...(status.branch === undefined ? {} : { branch: status.branch }),
    ...(status.upstream === undefined ? {} : { upstream: status.upstream }),
    ...(status.remote === undefined ? {} : { remote: status.remote }),
    ...(status.remote_url === undefined ? {} : { remote_url: status.remote_url }),
    ahead: status.ahead,
    behind: status.behind,
    clean: status.clean,
    conflict_state: status.conflict_state,
    conflict_paths: status.conflict_paths,
  };
}
