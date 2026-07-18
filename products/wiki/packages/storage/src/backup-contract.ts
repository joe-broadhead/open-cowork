import type { OpenWikiBackupDestinationConfig } from "@openwiki/core";

export type BackupDestinationReadiness = "ok" | "degraded" | "unsupported";

export type BackupCredentialState =
  | "not_required"
  | "env_configured"
  | "env_missing"
  | "external"
  | "unsupported";

export type BackupDiagnosticSeverity = "info" | "warning" | "error";

export interface BackupDestinationDiagnostic {
  code: string;
  severity: BackupDiagnosticSeverity;
  message: string;
}

export interface BackupDestinationCapabilities {
  put: true;
  get: true;
  list: true;
  delete: true;
  delete_prefix: true;
  status: true;
  durable_readback: boolean;
  manifest_final_publish: true;
  prefix_scoped_delete: true;
}

export interface BackupDestinationStatus {
  readiness: BackupDestinationReadiness;
  credential_state: BackupCredentialState;
  capabilities: BackupDestinationCapabilities;
  diagnostics: BackupDestinationDiagnostic[];
  provider_identity?: string;
  configured_prefix?: string;
}

export interface BackupDestinationStatusInput {
  providerIdentity?: string;
  configuredPrefix?: string;
  diagnostics?: BackupDestinationDiagnostic[];
}

export interface BackupLifecycleObject {
  key: string;
}

export function defaultBackupDestinationCapabilities(): BackupDestinationCapabilities {
  return {
    put: true,
    get: true,
    list: true,
    delete: true,
    delete_prefix: true,
    status: true,
    durable_readback: true,
    manifest_final_publish: true,
    prefix_scoped_delete: true,
  };
}

export function backupDestinationCredentialState(destination: {
  kind: string;
  access_key_id_env?: string;
  secret_access_key_env?: string;
  session_token_env?: string;
  credentials_env?: string;
}): BackupCredentialState {
  if (destination.kind === "local") {
    return "not_required";
  }
  if (destination.kind === "rclone") {
    return "external";
  }
  if (destination.kind === "google-drive" || destination.kind === "webdav") {
    return "unsupported";
  }
  const envNames = [
    destination.access_key_id_env,
    destination.secret_access_key_env,
    destination.session_token_env,
    destination.credentials_env,
  ].filter((value): value is string => value !== undefined);
  if (envNames.length === 0) {
    return "env_missing";
  }
  return envNames.every((name) => (process.env[name]?.trim() ?? "") !== "") ? "env_configured" : "env_missing";
}

export function backupDestinationStatusFromConfig(
  destination: OpenWikiBackupDestinationConfig,
  input: BackupDestinationStatusInput = {},
): BackupDestinationStatus {
  const credentialState = backupDestinationCredentialState(destination);
  const diagnostics = [
    ...credentialDiagnostics(destination, credentialState),
    ...(input.diagnostics ?? []),
  ];
  return {
    readiness: diagnostics.some((diagnostic) => diagnostic.severity === "error") ? "degraded" : "ok",
    credential_state: credentialState,
    capabilities: defaultBackupDestinationCapabilities(),
    diagnostics,
    ...(input.providerIdentity === undefined ? {} : { provider_identity: redactBackupDiagnosticText(input.providerIdentity) }),
    ...(input.configuredPrefix === undefined ? {} : { configured_prefix: normalizeBackupObjectPrefix(input.configuredPrefix) }),
  };
}

export function normalizeBackupObjectKey(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  assertSafeBackupObjectPath(normalized, "key", value);
  return normalized;
}

export function normalizeBackupObjectPrefix(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  assertSafeBackupObjectPath(normalized, "prefix", value);
  return normalized;
}

export function redactBackupDiagnosticText(value: string): string {
  return value
    .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/@\s]+)@/gu, "$1<redacted>@")
    .replace(/(authorization:\s*bearer\s+)([^\s]+)/giu, "$1<redacted>")
    .replace(/(token|secret|password|authorization|access[_-]?key|signature)=([^&\s]+)/giu, "$1=<redacted>");
}

export function listedBackupObjectKeyValidForPrefix(value: string, normalizedPrefix: string): boolean {
  try {
    const normalizedKey = normalizeBackupObjectKey(value);
    if (value !== normalizedKey) {
      return false;
    }
    return normalizedKey === normalizedPrefix || normalizedKey.startsWith(`${normalizedPrefix}/`);
  } catch {
    return false;
  }
}

export function assertBackupObjectListConfinedToPrefix(objects: BackupLifecycleObject[], prefix: string): string {
  const normalizedPrefix = normalizeBackupObjectPrefix(prefix);
  const invalidKeys = objects
    .map((object) => object.key)
    .filter((key) => !listedBackupObjectKeyValidForPrefix(key, normalizedPrefix));
  if (invalidKeys.length > 0) {
    throw new Error(`Backup provider listed invalid object keys under prefix: ${invalidKeys.slice(0, 5).map(redactBackupDiagnosticText).join(", ")}`);
  }
  return normalizedPrefix;
}

export async function deleteBackupObjectPrefix(input: {
  prefix: string;
  listObjects(prefix: string): Promise<BackupLifecycleObject[]>;
  deleteObject(key: string): Promise<void>;
}): Promise<void> {
  const objects = await input.listObjects(input.prefix);
  assertBackupObjectListConfinedToPrefix(objects, input.prefix);
  for (const object of objects) {
    await input.deleteObject(object.key);
  }
}

function credentialDiagnostics(
  destination: OpenWikiBackupDestinationConfig,
  credentialState: BackupCredentialState,
): BackupDestinationDiagnostic[] {
  if (credentialState !== "env_missing") {
    return [];
  }
  return [{
    code: "credentials.env_missing",
    severity: "error",
    message: `Backup destination '${destination.id}' is missing required credential environment variables.`,
  }];
}

function assertSafeBackupObjectPath(normalized: string, kind: "key" | "prefix", original: string): void {
  if (
    !normalized ||
    /[\0-\x1f\x7f]/u.test(normalized) ||
    normalized.split("/").some((part) => part === "." || part === ".." || part === "" || part.startsWith("-"))
  ) {
    throw new Error(`Invalid backup object ${kind}: ${original}`);
  }
}
