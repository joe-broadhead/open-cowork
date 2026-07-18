import type { CliOptions } from "../args.ts";
import { printJson } from "../output.ts";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { EventRecord, OpenWikiBackupDestinationConfig } from "@openwiki/core";
import { exportStaticSite, publishStaticSite } from "@openwiki/static-export";
import { loadRepository } from "@openwiki/repo";
import {
  backupDestinationStatusFromConfig,
  configureCloudBackupDestination,
  configureLocalBackupDestination,
  createWorkspaceBackup,
  listWorkspaceBackups,
  pruneWorkspaceBackups,
  rehearseWorkspaceBackup,
  restoreWorkspaceBackup,
  verifyWorkspaceBackup,
  withWriteCoordination,
  type BackupCredentialState,
  type BackupDestinationCapabilities,
  type BackupDestinationDiagnostic,
  type BackupDestinationReadiness,
} from "@openwiki/workflows";
import type { WorkspaceBackupDestinationSummary } from "@openwiki/workflows";
import {
  backupCredentialExplanation,
  backupCredentialLifecycle,
  backupCredentialRequirements,
  backupProviderState,
  sanitizeBackupDiagnostics,
  sanitizeBackupError,
  type BackupCredentialExplanation,
  type BackupCredentialLifecycle,
  type BackupCredentialRequirement,
  type BackupProviderState,
} from "../backup-credentials.ts";
import { backupRestoreDryRun } from "../backup-restore-dry-run.ts";
import { resolveRoot } from "../utils.ts";
import { parseAutomationIntervalSeconds, runForegroundWatcher } from "./watch.ts";

export async function exportCommand(args: string[], options: CliOptions): Promise<void> {
  const [target] = args;
  if (target !== "static") {
    throw new Error("Usage: openwiki [--root <path>] export static [--out-dir public] [--base-url URL] [--html-page-ceiling N] [--json]");
  }
  const result = await exportStaticSite({
    root: await resolveRoot(options),
    ...(options.outDir === undefined ? {} : { outDir: options.outDir }),
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.htmlPageCeiling === undefined ? {} : { htmlPageCeiling: options.htmlPageCeiling }),
    ...(options.sitemapShardSize === undefined ? {} : { sitemapShardSize: options.sitemapShardSize }),
    ...(options.llmsFullMaxBytes === undefined ? {} : { llmsFullMaxBytes: options.llmsFullMaxBytes }),
  });
  if (options.json) {
    printJson(result);
    return;
  }
  console.log(`Exported ${result.files.length} files to ${result.outDir}`);
  if (result.warnings.length > 0) {
    console.warn(result.warnings.join("\n"));
  }
}

export async function publishCommand(args: string[], options: CliOptions): Promise<void> {
  const [target] = args;
  if (target !== "static") {
    throw new Error("Usage: openwiki [--root <path>] publish static [--out-dir public] [--base-url URL] [--actor actor:user:local] [--html-page-ceiling N] [--json]");
  }
  const root = await resolveRoot(options);
  const result = await withWriteCoordination(
    {
      root,
      operation: "wiki.publish",
      ...(options.actor === undefined ? {} : { actorId: options.actor }),
      metadata: {
        ...(options.outDir === undefined ? {} : { out_dir: options.outDir }),
        ...(options.baseUrl === undefined ? {} : { base_url: options.baseUrl }),
      },
    },
    () =>
      publishStaticSite({
        root,
        ...(options.outDir === undefined ? {} : { outDir: options.outDir }),
        ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
        ...(options.actor === undefined ? {} : { actorId: options.actor }),
        ...(options.htmlPageCeiling === undefined ? {} : { htmlPageCeiling: options.htmlPageCeiling }),
        ...(options.sitemapShardSize === undefined ? {} : { sitemapShardSize: options.sitemapShardSize }),
        ...(options.llmsFullMaxBytes === undefined ? {} : { llmsFullMaxBytes: options.llmsFullMaxBytes }),
      }),
  );
  if (options.json) {
    printJson(result);
    return;
  }
  console.log(`Published ${result.files.length} files to ${result.outDir}`);
  console.log(result.event.id);
  if (result.warnings.length > 0) {
    console.warn(result.warnings.join("\n"));
  }
}

export async function backupCommand(args: string[], options: CliOptions): Promise<void> {
  const [subcommand, backupRef, ...rest] = args;
  if (subcommand === "credentials") {
    await backupCredentialsCommand(backupRef, rest, options);
    return;
  }
  if (subcommand === "rotate") {
    if (backupRef === undefined || rest.length > 0) {
      throw new Error("Usage: openwiki [--root <path>] backup rotate <destination-id> [--json]");
    }
    const result = await backupCredentialLifecycleCommand(backupRef, options);
    if (options.json) {
      printJson(result);
      return;
    }
    printBackupCredentialLifecycle(result);
    return;
  }
  if (subcommand === "configure") {
    if (rest.length > 0 || !options.targetId) {
      throw new Error(backupConfigureUsage());
    }
    if (backupRef === "local") {
      if (!options.backupPath) {
        throw new Error(backupConfigureUsage());
      }
      const result = await configureLocalBackupDestination({
        root: await resolveRoot(options),
        id: options.targetId,
        path: options.backupPath,
        ...(options.keepLast === undefined ? {} : { keepLast: options.keepLast }),
        ...(options.keepDays === undefined ? {} : { keepDays: options.keepDays }),
        ...(options.actor === undefined ? {} : { actorId: options.actor }),
      });
      if (options.json) {
        printJson(result);
        return;
      }
      console.log(`Configured local backup destination ${result.destination.id ?? options.targetId}`);
      console.log(result.destination.path);
      if (result.warnings.length > 0) {
        console.warn(result.warnings.join("\n"));
      }
      return;
    }
    const kind = parseCloudBackupKind(backupRef);
    const result = await configureCloudBackupDestination({
      root: await resolveRoot(options),
      id: options.targetId,
      kind,
      ...(options.backupBucket === undefined ? {} : { bucket: options.backupBucket }),
      ...(options.rcloneRemote === undefined ? {} : { remote: options.rcloneRemote }),
      ...(options.backupPrefix === undefined ? {} : { prefix: options.backupPrefix }),
      ...(options.endpointUrl === undefined ? {} : { endpointUrl: options.endpointUrl }),
      ...(options.backupRegion === undefined ? {} : { region: options.backupRegion }),
      ...(options.accessKeyEnv === undefined ? {} : { accessKeyIdEnv: options.accessKeyEnv }),
      ...(options.secretKeyEnv === undefined ? {} : { secretAccessKeyEnv: options.secretKeyEnv }),
      ...(options.sessionTokenEnv === undefined ? {} : { sessionTokenEnv: options.sessionTokenEnv }),
      ...(options.credentialsEnv === undefined ? {} : { credentialsEnv: options.credentialsEnv }),
      ...(options.serverSideEncryption === undefined ? {} : { serverSideEncryption: options.serverSideEncryption }),
      ...(options.kmsKeyId === undefined ? {} : { kmsKeyId: options.kmsKeyId }),
      ...(options.kmsKeyName === undefined ? {} : { kmsKeyName: options.kmsKeyName }),
      ...(options.forcePathStyle ? { forcePathStyle: true } : {}),
      ...(options.allowInsecureHttp ? { allowInsecureHttp: true } : {}),
      ...(options.keepLast === undefined ? {} : { keepLast: options.keepLast }),
      ...(options.keepDays === undefined ? {} : { keepDays: options.keepDays }),
      ...(options.actor === undefined ? {} : { actorId: options.actor }),
    });
    if (options.json) {
      printJson(result);
      return;
    }
    console.log(`Configured ${kind} backup destination ${result.destination.id ?? options.targetId}`);
    console.log(result.destination.uri ?? result.destination.id ?? kind);
    if (result.warnings.length > 0) {
      console.warn(result.warnings.join("\n"));
    }
    return;
  }
  if (subcommand === "create") {
    const root = await resolveRoot(options);
    const result = await createBackupWithCoordination(root, options, "wiki.backup_create");
    const verification = options.verifyBackup
      ? await verifyWorkspaceBackup({
          root,
          backupDir: result.backup_dir,
          ...(options.backupDestination === undefined ? {} : { destinationId: options.backupDestination }),
          ...(options.actor === undefined ? {} : { actorId: options.actor }),
        })
      : undefined;
    const output = verification === undefined ? result : { ...result, verification };
    if (options.json) {
      printJson(output);
      return;
    }
    console.log(`Created backup ${result.backup_dir}`);
    console.log(result.manifest_path);
    if (verification !== undefined) {
      console.log(`Verified backup ${verification.backup_id}`);
    }
    return;
  }
  if (subcommand === "watch") {
    await backupWatchCommand(options);
    return;
  }
  if (subcommand === "list") {
    const root = await resolveRoot(options);
    const result = await listWorkspaceBackups({
      root,
      ...(options.outDir === undefined ? {} : { outDir: options.outDir }),
      ...(options.backupDestination === undefined ? {} : { destinationId: options.backupDestination }),
    });
    if (options.json) {
      printJson(result);
      return;
    }
    if (result.backups.length === 0) {
      console.log(`No backups found in ${formatBackupDestination(result.destination)}`);
      return;
    }
    for (const backup of result.backups) {
      console.log(`${backup.backup_id}\t${backup.status}\t${backup.created_at ?? "unknown"}\t${backup.backup_dir}`);
    }
    return;
  }
  if (subcommand === "status") {
    const result = await backupStatusCommand(options);
    if (options.json) {
      printJson(result);
      return;
    }
    for (const destination of result.destinations) {
      console.log(`${destination.id}\t${destination.kind}\t${destination.status}\t${destination.message}`);
    }
    return;
  }
  if (subcommand === "verify") {
    if (!backupRef) {
      throw new Error("Usage: openwiki [--root <path>] backup verify <backup-id|latest|path> [--destination id] [--json]");
    }
    const root = await resolveRoot(options).catch(() => undefined);
    if (root === undefined && !isBackupPathReference(backupRef)) {
      throw new Error("backup verify latest or a backup id requires --root so the backup destination can be resolved.");
    }
    const backupDir = root === undefined ? backupRef : await resolveBackupReference(root, backupRef, options);
    const result = await verifyWorkspaceBackup({
      backupDir,
      ...(root === undefined ? {} : { root }),
      ...(options.backupDestination === undefined ? {} : { destinationId: options.backupDestination }),
      ...(options.actor === undefined ? {} : { actorId: options.actor }),
    });
    if (options.json) {
      printJson(result);
      return;
    }
    console.log(`Verified backup ${result.backup_id}`);
    console.log(`Files checked: ${result.files_checked}`);
    return;
  }
  if (subcommand === "rehearse") {
    if (rest.length > 0 || options.targetRoot === undefined) {
      throw new Error("Usage: openwiki [--root <path>] backup rehearse [<backup-id|latest|path>] [--backup-id latest] --target-root <path> [--destination id] [--force] [--json]");
    }
    const root = await resolveRoot(options);
    const rehearsalRef = backupRef ?? options.backupId ?? "latest";
    const backupDir = await resolveBackupReference(root, rehearsalRef, options);
    const result = await rehearseWorkspaceBackup({
      root,
      backupDir,
      targetRoot: options.targetRoot,
      ...(options.backupDestination === undefined ? {} : { destinationId: options.backupDestination }),
      ...(options.force ? { force: true } : {}),
      ...(options.actor === undefined ? {} : { actorId: options.actor }),
    });
    if (options.json) {
      printJson(result);
      return;
    }
    console.log(`Rehearsed restore ${result.backup_id} into ${result.target_root}`);
    console.log(`Validation: ${result.validation.status} (${result.validation.issue_count} issue${result.validation.issue_count === 1 ? "" : "s"})`);
    for (const stage of result.stages) {
      console.log(`${stage.status}\t${stage.name}\t${stage.message}`);
    }
    return;
  }
  if (subcommand === "restore") {
    if (!backupRef || !options.targetRoot) {
      throw new Error("Usage: openwiki [--root <path>] backup restore <backup-id|latest|path> --target-root <path> [--destination id] [--force] [--dry-run] [--json]");
    }
    const backupDir = await resolveBackupReferenceIfPossible(backupRef, options);
    const root = await resolveRoot(options).catch(() => undefined);
    if (options.dryRun === true) {
      const result = await backupRestoreDryRun({ backupDir, targetRoot: options.targetRoot, root, options });
      if (options.json) {
        printJson(result);
        return;
      }
      console.log(`Dry run verified backup ${result.verification.backup_id}`);
      console.log(`${result.target.status}: ${result.target.message}`);
      return;
    }
    const result = await restoreWorkspaceBackup({
      backupDir,
      targetRoot: options.targetRoot,
      ...(root === undefined ? {} : { root }),
      ...(options.backupDestination === undefined ? {} : { destinationId: options.backupDestination }),
      ...(options.force ? { force: true } : {}),
      ...(options.actor === undefined ? {} : { actorId: options.actor }),
    });
    if (options.json) {
      printJson(result);
      return;
    }
    console.log(`Restored backup to ${result.target_root}`);
    console.log(`Restored paths: ${result.restored_paths.length}`);
    console.log(`Indexed records: ${result.search_index.recordCount}`);
    return;
  }
  if (subcommand === "prune") {
    const root = await resolveRoot(options);
    const result = await pruneWorkspaceBackups({
      root,
      ...(options.outDir === undefined ? {} : { outDir: options.outDir }),
      ...(options.backupDestination === undefined ? {} : { destinationId: options.backupDestination }),
      ...(options.keepLast === undefined ? {} : { keepLast: options.keepLast }),
      ...(options.keepDays === undefined ? {} : { keepDays: options.keepDays }),
      ...(options.dryRun === true ? { dryRun: true } : {}),
      ...(options.actor === undefined ? {} : { actorId: options.actor }),
    });
    if (options.json) {
      printJson(result);
      return;
    }
    console.log(`${result.dry_run ? "Would delete" : "Deleted"} ${result.deleted.length} backup${result.deleted.length === 1 ? "" : "s"}`);
    return;
  }
  throw new Error(
    [
      "Usage:",
      "  openwiki [--root <path>] backup configure local --id destination-id --path <folder> [--keep-last N] [--keep-days N] [--actor actor:user:local] [--json]",
      "  openwiki [--root <path>] backup configure s3 --id destination-id --bucket bucket --prefix prefix --region region --access-key-env ENV --secret-key-env ENV [--session-token-env ENV] [--server-side-encryption AES256|aws:kms] [--kms-key-id key] [--json]",
      "  openwiki [--root <path>] backup configure minio --id destination-id --endpoint-url URL --bucket bucket --prefix prefix --access-key-env ENV --secret-key-env ENV [--force-path-style] [--allow-insecure-http] [--json]",
      "  openwiki [--root <path>] backup configure gcs --id destination-id --bucket bucket --prefix prefix --credentials-env ENV [--kms-key-name name] [--json]",
      "  openwiki [--root <path>] backup configure rclone --id destination-id --rclone-remote remote:path [--prefix prefix] [--json]",
      "  openwiki [--root <path>] backup credentials explain <destination-id> [--json]",
      "  openwiki [--root <path>] backup rotate <destination-id> [--json]",
      "  openwiki [--root <path>] backup create [--destination id|--out-dir backups] [--verify] [--actor actor:user:local] [--json]",
      "  openwiki [--root <path>] backup watch --every 24h [--destination id|--out-dir backups] [--once] [--json]",
      "  openwiki [--root <path>] backup list [--destination id|--out-dir backups] [--json]",
      "  openwiki [--root <path>] backup status [--destination id] [--json]",
      "  openwiki [--root <path>] backup verify <backup-id|latest|path> [--destination id|--out-dir backups] [--actor actor:user:local] [--json]",
      "  openwiki [--root <path>] backup rehearse [<backup-id|latest|path>] [--backup-id latest] --target-root <path> [--destination id|--out-dir backups] [--force] [--actor actor:user:local] [--json]",
      "  openwiki [--root <path>] backup restore <backup-id|latest|path> --target-root <path> [--destination id|--out-dir backups] [--force] [--dry-run] [--actor actor:user:local] [--json]",
      "  openwiki [--root <path>] backup prune [--destination id|--out-dir backups] [--keep-last N] [--keep-days N] [--dry-run] [--actor actor:user:local] [--json]",
    ].join("\n"),
  );
}

async function backupWatchCommand(options: CliOptions): Promise<void> {
  if (options.every === undefined) {
    throw new Error("Usage: openwiki [--root <path>] backup watch --every 24h [--destination id|--out-dir backups] [--once] [--json]");
  }
  const root = await resolveRoot(options);
  const everySeconds = parseAutomationIntervalSeconds(options.every);
  const watchOptions = await backupWatchOptions(root, options);
  const result = await runForegroundWatcher({
    root,
    kind: "backup",
    everySeconds,
    once: options.once,
    initialJitterSeconds: serviceInitialJitterSeconds(everySeconds),
    ...(options.json ? {} : { log: (message: string) => console.log(message) }),
    async runOnce() {
      const backup = await createBackupWithCoordination(root, watchOptions, "wiki.backup_watch");
      return {
        status: "success",
        message: `created backup ${backup.backup_id}`,
        details: { backup_id: backup.backup_id, backup_dir: backup.backup_dir },
      };
    },
  });
  if (options.json) {
    printJson(result);
  }
  if (options.once && result.runs.some((run) => run.status === "failed")) {
    process.exitCode = 1;
  }
}

async function backupWatchOptions(root: string, options: CliOptions): Promise<CliOptions> {
  if (options.backupDestination !== undefined || options.outDir !== undefined) {
    return options;
  }
  const repo = await loadRepository(root);
  const backups = repo.config.runtime?.backups;
  if (backups?.enabled === false) {
    throw new Error("Backups are disabled in runtime.backups.");
  }
  const destinations = backups?.destinations ?? [];
  if (destinations.length === 1) {
    const destinationId = destinations[0]?.id;
    return destinationId === undefined ? options : { ...options, backupDestination: destinationId };
  }
  if (destinations.length > 1) {
    throw new Error("Multiple backup destinations are configured; pass --destination <id> for scheduled backups.");
  }
  return options;
}

async function createBackupWithCoordination(
  root: string,
  options: CliOptions,
  operation: string,
): ReturnType<typeof createWorkspaceBackup> {
  return withWriteCoordination(
    {
      root,
      operation,
      ...(options.actor === undefined ? {} : { actorId: options.actor }),
      metadata: {
        ...(options.outDir === undefined ? {} : { out_dir: options.outDir }),
        ...(options.backupDestination === undefined ? {} : { destination_id: options.backupDestination }),
      },
    },
    () =>
      createWorkspaceBackup({
        root,
        ...(options.outDir === undefined ? {} : { outDir: options.outDir }),
        ...(options.backupDestination === undefined ? {} : { destinationId: options.backupDestination }),
        ...(options.actor === undefined ? {} : { actorId: options.actor }),
      }),
  );
}

function serviceInitialJitterSeconds(everySeconds: number): number {
  return process.env.OPENWIKI_AUTOMATION_SERVICE === "1" ? Math.max(1, Math.min(300, Math.floor(everySeconds * 0.1))) : 0;
}

interface BackupStatusResult {
  root: string;
  destinations: BackupDestinationStatus[];
  warnings: string[];
}

interface BackupDestinationStatus {
  id: string;
  kind: string;
  status: BackupDestinationReadiness;
  readiness: BackupDestinationReadiness;
  provider_state: BackupProviderState;
  credential_state: BackupCredentialState;
  credential_requirements: BackupCredentialRequirement[];
  credential_lifecycle: BackupCredentialLifecycle;
  configured_prefix: string | null;
  capabilities: BackupDestinationCapabilities;
  diagnostics: BackupDestinationDiagnostic[];
  last_verification: BackupLastVerification | null;
  message: string;
  backup_count: number;
  latest_backup_id?: string;
  path?: string;
  uri?: string;
  prefix?: string;
}

interface BackupLastVerification {
  backup_id: string;
  verified_at: string;
  backup_dir?: string;
}

async function backupStatusCommand(options: CliOptions): Promise<BackupStatusResult> {
  const root = await resolveRoot(options);
  const repo = await loadRepository(root);
  const configured = repo.config.runtime?.backups?.destinations ?? [];
  const destinations = options.backupDestination === undefined
    ? configured
    : configured.filter((destination) => destination.id === options.backupDestination);
  if (options.backupDestination !== undefined && destinations.length === 0) {
    throw new Error(`Backup destination '${options.backupDestination}' is not configured.`);
  }
  if (destinations.length === 0) {
    return {
      root,
      destinations: [],
      warnings: ["No backup destinations are configured."],
    };
  }
  return {
    root,
    destinations: await Promise.all(destinations.map((destination) => backupDestinationStatus(root, destination, repo.events))),
    warnings: [],
  };
}

async function backupCredentialsCommand(backupRef: string | undefined, rest: string[], options: CliOptions): Promise<void> {
  if (backupRef !== "explain" || rest.length !== 1 || rest[0] === undefined) {
    throw new Error("Usage: openwiki [--root <path>] backup credentials explain <destination-id> [--json]");
  }
  const result = await backupCredentialLifecycleCommand(rest[0], options);
  if (options.json) {
    printJson(result);
    return;
  }
  printBackupCredentialExplanation(result);
}

async function backupCredentialLifecycleCommand(destinationId: string, options: CliOptions): Promise<BackupCredentialExplanation> {
  const root = await resolveRoot(options);
  const repo = await loadRepository(root);
  const destination = (repo.config.runtime?.backups?.destinations ?? []).find((candidate) => candidate.id === destinationId);
  if (destination === undefined) {
    throw new Error(`Backup destination '${destinationId}' is not configured.`);
  }
  const status = await backupDestinationStatus(root, destination, repo.events);
  return backupCredentialExplanation(destination, {
    readiness: status.readiness,
    diagnostics: status.diagnostics,
  });
}

async function backupDestinationStatus(
  root: string,
  destination: OpenWikiBackupDestinationConfig,
  events: EventRecord[],
): Promise<BackupDestinationStatus> {
  const baseDiagnostics = backupDestinationStatusFromConfig(destination, {
    ...(destination.prefix === undefined ? {} : { configuredPrefix: destination.prefix }),
  });
  const base = {
    id: destination.id,
    kind: destination.kind,
    credential_state: baseDiagnostics.credential_state,
    credential_requirements: backupCredentialRequirements(destination),
    credential_lifecycle: backupCredentialLifecycle(destination),
    configured_prefix: destination.prefix ?? null,
    capabilities: baseDiagnostics.capabilities,
    diagnostics: sanitizeBackupDiagnostics(baseDiagnostics.diagnostics),
    last_verification: null,
    backup_count: 0,
    ...(destination.path === undefined ? {} : { path: destination.path }),
    ...(destination.prefix === undefined ? {} : { prefix: destination.prefix }),
  };
  if (destination.kind === "google-drive" || destination.kind === "webdav") {
    return {
      ...base,
      status: "unsupported",
      readiness: "unsupported",
      provider_state: "unsupported" as const,
      credential_state: "unsupported",
      diagnostics: sanitizeBackupDiagnostics([{
        code: "provider.unsupported",
        severity: "warning",
        message: `${destination.kind} direct backups are reserved but not implemented; use local synced-folder backups or rclone for this release.`,
      }]),
      message: `${destination.kind} direct backups are reserved but not implemented; use local synced-folder backups or rclone for this release.`,
    };
  }
  try {
    if (destination.kind === "local" && destination.path !== undefined) {
      await fs.access(path.resolve(root, destination.path));
    }
    const listed = await listWorkspaceBackups({ root, destinationId: destination.id });
    const valid = listed.backups.filter((backup) => backup.status === "ok");
    const latest = valid[0];
    const readiness: BackupDestinationReadiness = baseDiagnostics.readiness === "degraded" ? "degraded" : "ok";
    const diagnostics = sanitizeBackupDiagnostics(baseDiagnostics.diagnostics);
    return {
      ...base,
      status: readiness,
      readiness,
      provider_state: backupProviderState({
        credentialState: baseDiagnostics.credential_state,
        readiness,
        diagnostics,
      }),
      diagnostics,
      message: `${valid.length} valid backup${valid.length === 1 ? "" : "s"} available.`,
      backup_count: valid.length,
      last_verification: latestBackupVerification(events, listed.destination),
      ...(latest === undefined ? {} : { latest_backup_id: latest.backup_id }),
      ...(listed.destination.uri === undefined ? {} : { uri: listed.destination.uri }),
      ...(listed.destination.prefix === undefined ? {} : { prefix: listed.destination.prefix }),
    };
  } catch (error) {
    const message = sanitizeBackupError(error);
    const diagnostics = sanitizeBackupDiagnostics([
      ...baseDiagnostics.diagnostics,
      {
        code: providerDiagnosticCode(error),
        severity: "error",
        message,
      },
    ]);
    return {
      ...base,
      status: "degraded",
      readiness: "degraded",
      provider_state: backupProviderState({
        credentialState: baseDiagnostics.credential_state,
        readiness: "degraded",
        diagnostics,
        error,
      }),
      diagnostics,
      message,
    };
  }
}

function printBackupCredentialExplanation(result: BackupCredentialExplanation): void {
  console.log(`${result.id}\t${result.kind}\t${result.credential_state}\t${result.provider_state}`);
  for (const requirement of result.requirements) {
    const name = requirement.name === undefined ? "-" : requirement.name;
    console.log(`requirement ${requirement.source} ${name} required=${requirement.required} present=${requirement.present}`);
  }
  printBackupCredentialLifecycle(result);
}

function printBackupCredentialLifecycle(result: BackupCredentialExplanation): void {
  console.log(`rotation ${result.lifecycle.rotation_mode}`);
  for (const step of result.lifecycle.rotate_steps) {
    console.log(`rotate ${step}`);
  }
  for (const step of result.lifecycle.revoke_steps) {
    console.log(`revoke ${step}`);
  }
  for (const step of result.lifecycle.verify_steps) {
    console.log(`verify ${step}`);
  }
}

function providerDiagnosticCode(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/expired|invalid grant|token has expired|credential.*expired/iu.test(text)) {
    return "provider.expired";
  }
  if (/denied|unauthorized|forbidden|auth|permission|invalid access key|signaturedoesnotmatch|authenticationfailed/iu.test(text)) {
    return "provider.denied";
  }
  if (/quota|insufficient storage|storage limit|not enough space/iu.test(text)) {
    return "provider.quota_exceeded";
  }
  if (/rate[_ -]?limit|too many requests|throttle|429/iu.test(text)) {
    return "provider.rate_limited";
  }
  return "provider.status_failed";
}

function latestBackupVerification(
  events: EventRecord[],
  destination: WorkspaceBackupDestinationSummary,
): BackupLastVerification | null {
  const prefix = destination.uri ?? destination.path;
  const candidates = events
    .filter((event) => event.type === "backup.verified")
    .filter((event) => {
      const backupDir = event.data?.backup_dir;
      return typeof backupDir !== "string" || prefix === undefined || backupDir.startsWith(prefix);
    })
    .sort((left, right) => right.occurred_at.localeCompare(left.occurred_at));
  const event = candidates[0];
  const backupId = event === undefined ? undefined : backupIdFromVerificationEvent(event);
  if (event === undefined || backupId === undefined) {
    return null;
  }
  const backupDir = event.data?.backup_dir;
  return {
    backup_id: backupId,
    verified_at: event.occurred_at,
    ...(typeof backupDir === "string" ? { backup_dir: backupDir } : {}),
  };
}

function backupIdFromVerificationEvent(event: EventRecord): string | undefined {
  if (typeof event.record_id === "string" && event.record_id.trim().length > 0) {
    return event.record_id;
  }
  const backupId = event.data?.backup_id;
  return typeof backupId === "string" && backupId.trim().length > 0 ? backupId : undefined;
}

async function resolveBackupReferenceIfPossible(backupRef: string, options: CliOptions): Promise<string> {
  if (isBackupPathReference(backupRef)) {
    return backupRef;
  }
  const root = await resolveRoot(options).catch(() => undefined);
  if (root === undefined) {
    return backupRef;
  }
  return resolveBackupReference(root, backupRef, options);
}

async function resolveBackupReference(root: string, backupRef: string, options: CliOptions): Promise<string> {
  if (isBackupPathReference(backupRef)) {
    return backupRef;
  }
  const result = await listWorkspaceBackups({
    root,
    ...(options.outDir === undefined ? {} : { outDir: options.outDir }),
    ...(options.backupDestination === undefined ? {} : { destinationId: options.backupDestination }),
  });
  const valid = result.backups.filter((backup) => backup.status === "ok");
  if (backupRef === "latest") {
    const latest = valid[0];
    if (latest === undefined) {
      throw new Error(`No valid backups found in ${formatBackupDestination(result.destination)}`);
    }
    return latest.backup_dir;
  }
  const match = valid.find((backup) => backup.backup_id === backupRef || backup.backup_dir.endsWith(`/${backupRef}`));
  if (match === undefined) {
    throw new Error(`Backup '${backupRef}' was not found in ${formatBackupDestination(result.destination)}`);
  }
  return match.backup_dir;
}

function isBackupPathReference(value: string): boolean {
  return value !== "latest" && (value.includes("/") || value.includes("\\") || value.startsWith("."));
}

function parseCloudBackupKind(value: string | undefined): "s3" | "minio" | "gcs" | "rclone" {
  if (value === "s3" || value === "minio" || value === "gcs" || value === "rclone") {
    return value;
  }
  throw new Error(backupConfigureUsage());
}

function formatBackupDestination(destination: WorkspaceBackupDestinationSummary): string {
  return destination.path ?? destination.uri ?? destination.id ?? destination.kind;
}

function backupConfigureUsage(): string {
  return [
    "Usage:",
    "  openwiki [--root <path>] backup configure local --id destination-id --path <folder> [--keep-last N] [--keep-days N] [--actor actor:user:local] [--json]",
    "  openwiki [--root <path>] backup configure s3 --id destination-id --bucket bucket --prefix prefix --region region --access-key-env ENV --secret-key-env ENV [--session-token-env ENV] [--server-side-encryption AES256|aws:kms] [--kms-key-id key] [--json]",
    "  openwiki [--root <path>] backup configure minio --id destination-id --endpoint-url URL --bucket bucket --prefix prefix --access-key-env ENV --secret-key-env ENV [--force-path-style] [--allow-insecure-http] [--json]",
    "  openwiki [--root <path>] backup configure gcs --id destination-id --bucket bucket --prefix prefix --credentials-env ENV [--kms-key-name name] [--json]",
    "  openwiki [--root <path>] backup configure rclone --id destination-id --rclone-remote remote:path [--prefix prefix] [--json]",
    "  openwiki [--root <path>] backup credentials explain <destination-id> [--json]",
    "  openwiki [--root <path>] backup rotate <destination-id> [--json]",
  ].join("\n");
}
