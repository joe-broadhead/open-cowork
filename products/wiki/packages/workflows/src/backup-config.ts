import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWriteFile, type OpenWikiBackupConfig, type OpenWikiBackupDestinationConfig, type OpenWikiConfig } from "@openwiki/core";
import { cloudBackupObjectUri } from "@openwiki/storage";
import { appendEvent, loadRepository } from "@openwiki/repo";
import { rebuildDerivedIndexes } from "./derived-indexes.ts";
import { withWriteCoordination } from "./write-coordinator.ts";
import type {
  ConfigureCloudBackupDestinationInput,
  ConfigureCloudBackupDestinationResult,
  ConfigureLocalBackupDestinationInput,
  ConfigureLocalBackupDestinationResult,
  WorkspaceBackupDestinationSummary,
} from "./types.ts";

const BACKUP_DESTINATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export async function configureLocalBackupDestination(
  input: ConfigureLocalBackupDestinationInput,
): Promise<ConfigureLocalBackupDestinationResult> {
  return withWriteCoordination(
    {
      root: input.root,
      operation: "wiki.admin",
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
      metadata: {
        backup_destination_id: input.id,
        backup_destination_kind: "local",
      },
    },
    () => configureLocalBackupDestinationUnlocked(input),
  );
}

export async function configureCloudBackupDestination(
  input: ConfigureCloudBackupDestinationInput,
): Promise<ConfigureCloudBackupDestinationResult> {
  return withWriteCoordination(
    {
      root: input.root,
      operation: "wiki.admin",
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
      metadata: {
        backup_destination_id: input.id,
        backup_destination_kind: input.kind,
      },
    },
    () => configureCloudBackupDestinationUnlocked(input),
  );
}

export function resolveLocalBackupDestinationPath(root: string, value: string): string {
  if (value.includes("\0")) {
    throw new Error("Backup destination path must not contain NUL bytes.");
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Backup destination path cannot be empty.");
  }
  if (trimmed === "~") {
    return os.homedir();
  }
  if (trimmed.startsWith("~/")) {
    return path.resolve(os.homedir(), trimmed.slice(2));
  }
  return path.resolve(root, trimmed);
}

export function localBackupDestinationWarnings(root: string, destinationPath: string): string[] {
  const warnings: string[] = [];
  const workspaceProvider = consumerSyncProviderForPath(root);
  if (workspaceProvider !== undefined) {
    warnings.push(
      `The live workspace appears to be inside ${workspaceProvider}; keep Git workspaces outside consumer sync folders and put only backup artifacts there.`,
    );
  }
  const destinationProvider = consumerSyncProviderForPath(destinationPath);
  if (destinationProvider !== undefined) {
    warnings.push(
      `Destination appears to be inside ${destinationProvider}; verification proves local artifact integrity but not provider upload completion.`,
    );
  }
  return warnings;
}

async function configureLocalBackupDestinationUnlocked(
  input: ConfigureLocalBackupDestinationInput,
): Promise<ConfigureLocalBackupDestinationResult> {
  const repo = await loadRepository(input.root);
  if (!BACKUP_DESTINATION_ID_PATTERN.test(input.id)) {
    throw new Error("Backup destination id must start with an alphanumeric character and contain only letters, numbers, dot, underscore, or dash.");
  }
  const destinationPath = resolveLocalBackupDestinationPath(repo.root, input.path);
  assertSafeLocalBackupDestinationPath(repo.root, destinationPath);
  await fs.mkdir(destinationPath, { recursive: true });
  assertSafeLocalBackupDestinationPath(await fs.realpath(repo.root), await fs.realpath(destinationPath));

  const nextRetention = backupRetention(repo.config.runtime?.backups, input);
  const destination: OpenWikiBackupDestinationConfig = {
    id: input.id,
    kind: "local",
    path: destinationPath,
  };
  const nextConfig = upsertBackupDestination(repo.config, destination, nextRetention);
  const configPath = path.join(repo.root, "openwiki.json");
  await atomicWriteFile(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`);
  const warnings = localBackupDestinationWarnings(repo.root, destinationPath);
  const event = await appendEvent(repo.root, {
    type: "backup.destination.configured",
    actor_id: input.actorId ?? "actor:user:local",
    operation: "wiki.admin",
    record_id: input.id,
    record_type: "backup_destination",
    data: {
      destination,
      ...(nextRetention === undefined ? {} : { retention: nextRetention }),
      warnings,
    },
  });
  await rebuildDerivedIndexes(repo.root);
  return {
    root: repo.root,
    config_path: configPath,
    destination: { id: destination.id, kind: "local", path: destination.path ?? destinationPath },
    warnings,
    ...(nextRetention === undefined ? {} : { retention: nextRetention }),
    event,
  };
}

async function configureCloudBackupDestinationUnlocked(
  input: ConfigureCloudBackupDestinationInput,
): Promise<ConfigureCloudBackupDestinationResult> {
  const repo = await loadRepository(input.root);
  if (!BACKUP_DESTINATION_ID_PATTERN.test(input.id)) {
    throw new Error("Backup destination id must start with an alphanumeric character and contain only letters, numbers, dot, underscore, or dash.");
  }
  const destination = cloudDestinationFromInput(input);
  const nextRetention = backupRetention(repo.config.runtime?.backups, input);
  const nextConfig = upsertBackupDestination(repo.config, destination, nextRetention);
  const configPath = path.join(repo.root, "openwiki.json");
  await atomicWriteFile(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`);
  const warnings = [
    `Cloud backup objects are isolated under prefix ${(destination.prefix ?? "openwiki-backups").replace(/\/+$/g, "")}/${safePathSegment(repo.config.workspace_id)}.`,
    "Verification proves uploaded artifact integrity by re-reading provider objects; use provider-native lifecycle/versioning for offsite durability.",
    ...(destination.kind === "rclone"
      ? ["The rclone bridge uses an existing rclone remote; OpenWiki stores only the remote name/path and never provider credentials."]
      : []),
  ];
  const event = await appendEvent(repo.root, {
    type: "backup.destination.configured",
    actor_id: input.actorId ?? "actor:user:local",
    operation: "wiki.admin",
    record_id: input.id,
    record_type: "backup_destination",
    data: {
      destination,
      ...(nextRetention === undefined ? {} : { retention: nextRetention }),
      warnings,
    },
  });
  await rebuildDerivedIndexes(repo.root);
  return {
    root: repo.root,
    config_path: configPath,
    destination: cloudDestinationSummary(destination, repo.config.workspace_id),
    warnings,
    ...(nextRetention === undefined ? {} : { retention: nextRetention }),
    event,
  };
}

function backupRetention(
  current: OpenWikiBackupConfig | undefined,
  input: ConfigureLocalBackupDestinationInput | ConfigureCloudBackupDestinationInput,
): ConfigureLocalBackupDestinationResult["retention"] {
  const keepLast = input.keepLast ?? current?.retention?.keep_last;
  const keepDays = input.keepDays ?? current?.retention?.keep_days;
  if (keepLast === undefined && keepDays === undefined) {
    return undefined;
  }
  return {
    ...(keepLast === undefined ? {} : { keep_last: keepLast }),
    ...(keepDays === undefined ? {} : { keep_days: keepDays }),
  };
}

function cloudDestinationFromInput(input: ConfigureCloudBackupDestinationInput): OpenWikiBackupDestinationConfig {
  if (input.kind === "s3" || input.kind === "minio") {
    requireInput(input.bucket, `${input.kind} backup destinations require --bucket.`);
    requireEnvInput(input.accessKeyIdEnv, `${input.kind} backup destinations require --access-key-env.`, "--access-key-env");
    requireEnvInput(input.secretAccessKeyEnv, `${input.kind} backup destinations require --secret-key-env.`, "--secret-key-env");
    validateOptionalEnvInput(input.sessionTokenEnv, "--session-token-env");
    if (input.kind === "minio") {
      requireInput(input.endpointUrl, "minio backup destinations require --endpoint-url.");
    }
  } else if (input.kind === "gcs") {
    requireInput(input.bucket, "gcs backup destinations require --bucket.");
    requireEnvInput(input.credentialsEnv, "gcs backup destinations require --credentials-env.", "--credentials-env");
  } else if (input.kind === "rclone") {
    requireInput(input.remote, "rclone backup destinations require --rclone-remote.");
    validateRcloneRemoteInput(input.remote);
  }
  const destination: OpenWikiBackupDestinationConfig = {
    id: input.id,
    kind: input.kind,
    ...(input.bucket === undefined ? {} : { bucket: input.bucket }),
    ...(input.remote === undefined ? {} : { remote: input.remote }),
    ...(input.prefix === undefined ? {} : { prefix: safePrefix(input.prefix) }),
    ...(input.endpointUrl === undefined ? {} : { endpoint_url: input.endpointUrl }),
    ...(input.region === undefined ? {} : { region: input.region }),
    ...(input.accessKeyIdEnv === undefined ? {} : { access_key_id_env: input.accessKeyIdEnv }),
    ...(input.secretAccessKeyEnv === undefined ? {} : { secret_access_key_env: input.secretAccessKeyEnv }),
    ...(input.sessionTokenEnv === undefined ? {} : { session_token_env: input.sessionTokenEnv }),
    ...(input.credentialsEnv === undefined ? {} : { credentials_env: input.credentialsEnv }),
    ...(input.serverSideEncryption === undefined ? {} : { server_side_encryption: input.serverSideEncryption }),
    ...(input.kmsKeyId === undefined ? {} : { kms_key_id: input.kmsKeyId }),
    ...(input.kmsKeyName === undefined ? {} : { kms_key_name: input.kmsKeyName }),
    ...(input.forcePathStyle === undefined ? {} : { force_path_style: input.forcePathStyle }),
    ...(input.allowInsecureHttp === undefined ? {} : { allow_insecure_http: input.allowInsecureHttp }),
  };
  return destination;
}

function cloudDestinationSummary(
  destination: OpenWikiBackupDestinationConfig,
  workspaceId: string,
): WorkspaceBackupDestinationSummary {
  const prefix = `${safePrefix(destination.prefix ?? "openwiki-backups")}/${safePathSegment(workspaceId)}`;
  return {
    id: destination.id,
    kind: destination.kind as WorkspaceBackupDestinationSummary["kind"],
    uri: cloudBackupObjectUri(destination, prefix),
    ...(destination.bucket === undefined ? {} : { bucket: destination.bucket }),
    ...(destination.remote === undefined ? {} : { remote: destination.remote }),
    prefix,
    ...(destination.endpoint_url === undefined ? {} : { endpoint_url: destination.endpoint_url }),
    ...(destination.region === undefined ? {} : { region: destination.region }),
  };
}

function validateRcloneRemoteInput(value: string | undefined): void {
  const remote = value?.trim();
  if (
    remote === undefined ||
    remote.includes("\0") ||
    /[\r\n]/u.test(remote) ||
    remote.startsWith("-") ||
    remote.includes("://") ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}:/.test(remote)
  ) {
    throw new Error("rclone backup destinations require --rclone-remote to name a configured rclone remote such as drive:OpenWikiBackups.");
  }
}

function requireInput(value: string | undefined, message: string): void {
  if (value === undefined || value.trim() === "") {
    throw new Error(message);
  }
}

function requireEnvInput(value: string | undefined, message: string, label: string): void {
  requireInput(value, message);
  validateOptionalEnvInput(value, label);
}

function validateOptionalEnvInput(value: string | undefined, label: string): void {
  if (value !== undefined && !ENV_NAME_PATTERN.test(value)) {
    throw new Error(`${label} must be an environment variable name.`);
  }
}

function safePrefix(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.split("/").some((part) => part === "." || part === ".." || part === "")) {
    throw new Error(`Invalid backup destination prefix: ${value}`);
  }
  return normalized.split("/").map(safePathSegment).join("/");
}

function safePathSegment(value: string): string {
  const cleaned = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!cleaned) {
    throw new Error(`Invalid backup path segment: ${value}`);
  }
  return cleaned;
}

function upsertBackupDestination(
  config: OpenWikiConfig,
  destination: OpenWikiBackupDestinationConfig,
  retention: ConfigureLocalBackupDestinationResult["retention"],
): OpenWikiConfig {
  const currentRuntime = config.runtime ?? {};
  const currentBackups = currentRuntime.backups ?? {};
  const destinations = currentBackups.destinations ?? [];
  const nextDestinations = destinations.some((candidate) => candidate.id === destination.id)
    ? destinations.map((candidate) => (candidate.id === destination.id ? destination : candidate))
    : [...destinations, destination];
  return {
    ...config,
    runtime: {
      ...currentRuntime,
      backups: {
        ...currentBackups,
        enabled: currentBackups.enabled ?? true,
        schedule: currentBackups.schedule ?? "manual",
        ...(retention === undefined ? {} : { retention }),
        destinations: nextDestinations,
      },
    },
  };
}

function assertSafeLocalBackupDestinationPath(root: string, destinationPath: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedDestination = path.resolve(destinationPath);
  if (resolvedDestination === path.parse(resolvedDestination).root) {
    throw new Error("Refusing to configure filesystem root as a backup destination.");
  }
  if (samePath(resolvedDestination, resolvedRoot)) {
    throw new Error("Refusing to configure the live workspace root as a backup destination.");
  }
  if (isPathWithin(resolvedRoot, resolvedDestination)) {
    throw new Error("Refusing to configure a backup destination that contains the live workspace.");
  }
  if (isPathWithin(resolvedDestination, resolvedRoot)) {
    throw new Error("Refusing to configure a backup destination inside the live workspace.");
  }
}

export function consumerSyncProviderForPath(value: string): string | undefined {
  const normalized = value.replace(/\\/g, "/").toLowerCase();
  if (normalized.includes("/google drive/") || normalized.includes("/my drive/") || normalized.includes("/drivefs/")) {
    return "Google Drive";
  }
  if (normalized.includes("/dropbox/")) {
    return "Dropbox";
  }
  if (normalized.includes("/onedrive") || normalized.includes("/one drive")) {
    return "OneDrive";
  }
  if (normalized.includes("/synology drive/") || normalized.includes("/synologydrive/")) {
    return "Synology Drive";
  }
  if (normalized.includes("mobile documents/com~apple~clouddocs") || normalized.includes("/icloud drive/")) {
    return "iCloud Drive";
  }
  return undefined;
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

function isPathWithin(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
