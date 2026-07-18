import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { EventRecord, OpenWikiBackupSchedule, OpenWikiConfig, OpenWikiStorageConfig, ValidationIssue } from "@openwiki/core";
import { backupDestinationCredentialState } from "@openwiki/workflows";
import { gitRemoteStatus, readGitSyncState } from "@openwiki/git";
import { checkIndexStoreIntegrity } from "@openwiki/index-store";
import { listEvents, loadRepository } from "@openwiki/repo";
import { validateOpenWikiConfig } from "@openwiki/validation";
import { backupProviderReadinessChecks } from "../backup-credentials.ts";
import { backupRehearsalDiagnostic } from "../backup-rehearsal-diagnostics.ts";
import type { CliOptions } from "../args.ts";
import { doctorProfileFor, doctorProfileRequirements, type DoctorProfile } from "../doctor-profiles.ts";
import type { DeploymentProfileDefinition, DeploymentProfileName, DeploymentProfileRequirement } from "../deployment-profiles.ts";
import { printJson } from "../output.ts";
import { checkPostgresRuntimeIntegrity, postgresRuntimeConfigured } from "@openwiki/postgres-runtime";
import { MIN_NODE_VERSION, execFileAsync, exists, resolveRoot } from "../utils.ts";
import { automationServiceDiagnostics } from "./service.ts";

type DiagnosticStatus = "pass" | "warn" | "fail" | "skip";

export interface DiagnosticCheck {
  name: string;
  status: DiagnosticStatus;
  message: string;
  details?: Record<string, unknown>;
}

interface DiagnosticReport {
  command: "doctor" | "deploy-preflight";
  status: "pass" | "warn" | "fail";
  profile?: DoctorProfile;
  deployment_profile?: {
    name: DeploymentProfileName;
    status: string;
    trust_boundary: string;
    persistence_model: string;
    backup_model: string;
    scaling_path: string;
  };
  checks: DiagnosticCheck[];
}

export async function doctorCommand(options: CliOptions): Promise<void> {
  const profile = doctorProfileFor(options.profile);
  const requirements = doctorProfileRequirements(profile);
  const checks: DiagnosticCheck[] = [];
  checks.push(nodeVersionDiagnostic());
  checks.push(await executableDiagnostic("git", ["--version"], "Git is required because the repository is the canonical store."));
  checks.push(await executableDiagnostic("pnpm", ["--version"], "pnpm is required for source checkout development.", "warn"));
  checks.push(await executableDiagnostic("corepack", ["--version"], "Corepack keeps pnpm version resolution reproducible.", "warn"));
  checks.push(await nodeSqliteDiagnostic());
  checks.push(await executableDiagnostic("docker", ["--version"], "Docker is optional, but needed for local compose and image smoke tests.", "warn"));
  if (profile === "hosted" || profile === "kubernetes") {
    checks.push(publicOriginDiagnostic(options.publicOrigin ?? process.env.OPENWIKI_PUBLIC_ORIGIN, requirements.publicOrigin));
    checks.push(trustedHeaderDiagnostic(options));
    checks.push(rateLimitDiagnostic(requirements.rateLimits));
    checks.push(imageDigestDiagnostic(options.image ?? process.env.OPENWIKI_IMAGE, requirements.imageDigest));
    checks.push(writeCoordinatorDiagnostic(requirements.writeCoordinator));
  }

  const root = await resolveRootOptional(options);
  if (root === undefined) {
    checks.push({ name: "workspace", status: "warn", message: "No OpenWiki workspace was found from this directory. Use --root inside a wiki." });
  } else {
    checks.push({ name: "workspace", status: "pass", message: `Workspace resolved at ${root}`, details: { root } });
    checks.push(await writableWorkspaceDiagnostic(root));
    checks.push(...await workspaceRuntimeConfigDiagnostics(root));
    checks.push(await sqliteReadinessDiagnostic(root));
    checks.push(await postgresDiagnostic(root, requirements.postgres));
    checks.push(postgresBackupDiagnostic(requirements.postgres));
    if (profile !== undefined) {
      checks.push(await gitRemoteDiagnostic(root, requirements.gitRemote));
    }
    if (profile === "personal") {
      checks.push(await agentMcpConfigDiagnostic(root));
    }
  }

  printDiagnosticReport({
    command: "doctor",
    status: summarizeDiagnosticStatus(checks),
    ...(profile === undefined ? {} : { profile }),
    checks,
  }, options);
}

function nodeVersionDiagnostic(): DiagnosticCheck {
  const version = process.versions.node;
  if (compareSemver(version, MIN_NODE_VERSION) < 0) {
    return {
      name: "node",
      status: "fail",
      message: `Node ${version} is below the supported minimum ${MIN_NODE_VERSION}.`,
      details: { version, minimum: MIN_NODE_VERSION },
    };
  }
  return {
    name: "node",
    status: "pass",
    message: `Node ${version} satisfies >=${MIN_NODE_VERSION}.`,
    details: { version, minimum: MIN_NODE_VERSION },
  };
}

async function executableDiagnostic(command: string, args: string[], missingMessage: string, missingStatus: DiagnosticStatus = "fail"): Promise<DiagnosticCheck> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { timeout: 5000, maxBuffer: 1024 * 1024 });
    const output = `${stdout}`.trim() || `${stderr}`.trim();
    return {
      name: command,
      status: "pass",
      message: output.length === 0 ? `${command} is available.` : output.split(/\r?\n/)[0] ?? `${command} is available.`,
    };
  } catch (error: unknown) {
    return {
      name: command,
      status: missingStatus,
      message: missingMessage,
      details: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

async function nodeSqliteDiagnostic(): Promise<DiagnosticCheck> {
  try {
    await import("node:sqlite");
    return { name: "node:sqlite", status: "pass", message: "node:sqlite can be imported by the current Node runtime." };
  } catch (error: unknown) {
    return {
      name: "node:sqlite",
      status: "fail",
      message: "node:sqlite is unavailable; search and derived SQLite stores cannot run.",
      details: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

export async function writableWorkspaceDiagnostic(root: string): Promise<DiagnosticCheck> {
  const marker = path.join(root, ".openwiki", `doctor-${process.pid}-${Date.now()}.tmp`);
  try {
    await mkdir(path.dirname(marker), { recursive: true });
    await writeFile(marker, "ok\n");
    await rm(marker, { force: true });
    return { name: "workspace-writable", status: "pass", message: ".openwiki is writable." };
  } catch (error: unknown) {
    return {
      name: "workspace-writable",
      status: "fail",
      message: "OpenWiki cannot write derived state under .openwiki.",
      details: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

export async function sqliteReadinessDiagnostic(root: string): Promise<DiagnosticCheck> {
  try {
    const indexStore = await checkIndexStoreIntegrity(root);
    const searchDbPath = path.join(root, ".openwiki", "index", "openwiki.sqlite");
    const searchDb = await exists(searchDbPath);
    if (indexStore.ok && searchDb) {
      return { name: "readyz-prerequisites", status: "pass", message: "Search and index-store SQLite files are present and current." };
    }
    const issues = [...indexStore.issues, ...(searchDb ? [] : ["search index is missing"])];
    return {
      name: "readyz-prerequisites",
      status: "warn",
      message: `Derived readiness stores need rebuild: ${issues.join("; ")}`,
      details: { issues },
    };
  } catch (error: unknown) {
    return {
      name: "readyz-prerequisites",
      status: "fail",
      message: "Derived readiness store check failed.",
      details: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

export async function postgresDiagnostic(root: string, required: DeploymentProfileRequirement | boolean = false): Promise<DiagnosticCheck> {
  const requirement = requirementFrom(required);
  if (!postgresRuntimeConfigured()) {
    return {
      name: "postgres",
      status: requirementStatus(requirement),
      message:
        requirement === "required"
          ? "This deployment profile requires OPENWIKI_DATABASE_URL or DATABASE_URL."
          : requirement === "warn"
            ? "Postgres is recommended for this deployment profile before scaling writes, workers, or search."
            : "Postgres is not configured; skipping.",
    };
  }
  try {
    const integrity = await checkPostgresRuntimeIntegrity(root);
    if (integrity.ok) {
      return { name: "postgres", status: "pass", message: `Postgres runtime is current with ${integrity.record_count} records.` };
    }
    return {
      name: "postgres",
      status: "warn",
      message: `Postgres runtime is reachable but stale: ${integrity.issues.join("; ")}`,
      details: { issues: integrity.issues },
    };
  } catch (error: unknown) {
    return {
      name: "postgres",
      status: "fail",
      message: "Postgres runtime check failed.",
      details: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

export async function workspaceRuntimeConfigDiagnostics(root: string): Promise<DiagnosticCheck[]> {
  try {
    const repo = await loadRepository(root);
    const configIssues = validateOpenWikiConfig(repo.config, { root });
    return [
      configValidationDiagnostic(configIssues),
      syncConfigDiagnostic(repo.config),
      await syncStateDiagnostic(root),
      backupConfigDiagnostic(repo.config),
      ...backupProviderReadinessChecks(repo.config),
      await backupStateDiagnostic(root, repo.config),
      backupRehearsalDiagnostic(repo.config, repo.events),
      objectStorageBackupDiagnostic(repo.config.runtime?.storage),
      ...await automationServiceDiagnostics(root),
    ];
  } catch (error: unknown) {
    return [
      {
        name: "workspace-config",
        status: "fail",
        message: "OpenWiki workspace config could not be loaded.",
        details: { error: error instanceof Error ? error.message : String(error) },
      },
    ];
  }
}

async function syncStateDiagnostic(root: string): Promise<DiagnosticCheck> {
  const state = await readGitSyncState(root);
  if (state.conflict?.has_conflicts === true) {
    return {
      name: "sync-state",
      status: "fail",
      message: `Git sync has unresolved conflicts in ${state.conflict.paths.length} path${state.conflict.paths.length === 1 ? "" : "s"}.`,
      details: { state },
    };
  }
  if (state.last_failure !== undefined && state.last_success === undefined) {
    return {
      name: "sync-state",
      status: "warn",
      message: `Last sync failed at ${state.last_failure.occurred_at}.`,
      details: { state },
    };
  }
  if (state.last_success === undefined) {
    return {
      name: "sync-state",
      status: "skip",
      message: "No successful sync has been recorded yet.",
      details: { state },
    };
  }
  return {
    name: "sync-state",
    status: "pass",
    message: `Last successful sync was ${state.last_success.status} at ${state.last_success.occurred_at}.`,
    details: { state },
  };
}

function configValidationDiagnostic(issues: ValidationIssue[]): DiagnosticCheck {
  if (issues.length === 0) {
    return { name: "workspace-config", status: "pass", message: "openwiki.json backup and sync config is valid." };
  }
  const errors = issues.filter((issue) => issue.severity === "error");
  const status: DiagnosticStatus = errors.length > 0 ? "fail" : "warn";
  return {
    name: "workspace-config",
    status,
    message: `${issues.length} openwiki.json backup/sync issue${issues.length === 1 ? "" : "s"} found.`,
    details: { issues },
  };
}

function syncConfigDiagnostic(config: OpenWikiConfig): DiagnosticCheck {
  const sync = config.runtime?.sync;
  if (sync === undefined) {
    return {
      name: "sync-config",
      status: "skip",
      message: "No runtime.sync config is set; use Git commands manually or configure sync before automation.",
    };
  }
  return {
    name: "sync-config",
    status: "pass",
    message: `Sync is ${sync.mode ?? "manual"} for ${sync.remote ?? config.runtime?.git?.remote ?? "origin"}/${sync.branch ?? config.runtime?.git?.branch ?? "main"}.`,
    details: {
      mode: sync.mode ?? "manual",
      remote: sync.remote ?? config.runtime?.git?.remote ?? "origin",
      branch: sync.branch ?? config.runtime?.git?.branch ?? "main",
      pull_on_start: sync.pull_on_start ?? false,
      push_after_commit: sync.push_after_commit ?? false,
      interval_seconds: sync.interval_seconds,
      conflict_policy: sync.conflict_policy ?? "stop",
    },
  };
}

function backupConfigDiagnostic(config: OpenWikiConfig): DiagnosticCheck {
  const backups = config.runtime?.backups;
  if (backups === undefined) {
    return {
      name: "backup-config",
      status: "skip",
      message: "No runtime.backups config is set; configure a backup destination before relying on this workspace.",
    };
  }
  const destinations = backups.destinations ?? [];
  if (backups.enabled === false) {
    return {
      name: "backup-config",
      status: "warn",
      message: "Backups are explicitly disabled.",
      details: { enabled: false, destination_count: destinations.length },
    };
  }
  if (destinations.length === 0) {
    return {
      name: "backup-config",
      status: "warn",
      message: "runtime.backups is present but no destinations are configured.",
      details: { enabled: backups.enabled ?? true, destination_count: 0 },
    };
  }
  return {
    name: "backup-config",
    status: "pass",
    message: `Backups are configured for ${destinations.length} destination${destinations.length === 1 ? "" : "s"}.`,
    details: {
      enabled: backups.enabled ?? true,
      schedule: backups.schedule ?? "manual",
      destinations: destinations.map((destination) => ({
        id: destination.id,
        kind: destination.kind,
        credential_state: backupDestinationCredentialState(destination),
      })),
      retention: backups.retention,
    },
  };
}

async function backupStateDiagnostic(root: string, config: OpenWikiConfig): Promise<DiagnosticCheck> {
  const backups = config.runtime?.backups;
  if (backups === undefined || backups.enabled === false || (backups.destinations ?? []).length === 0) {
    return {
      name: "backup-state",
      status: "skip",
      message: "No enabled backup destination is configured, so last backup and verification state cannot be evaluated.",
    };
  }
  const events = (await listEvents(root, 1000)).events;
  const latestCreated = events.find((event) => event.type === "backup.created");
  if (latestCreated === undefined) {
    return {
      name: "backup-state",
      status: "warn",
      message: "No workspace backup has been recorded yet. Run openwiki backup create and openwiki backup verify latest.",
    };
  }
  const backupId = backupIdFromEvent(latestCreated);
  const createdAt = Date.parse(latestCreated.occurred_at);
  const now = Date.now();
  const ageSeconds = Number.isFinite(createdAt) ? Math.max(0, Math.floor((now - createdAt) / 1000)) : undefined;
  const latestVerified = events.find(
    (event) =>
      event.type === "backup.verified" &&
      backupIdFromEvent(event) === backupId &&
      event.occurred_at >= latestCreated.occurred_at,
  );
  const maxAgeSeconds = backupStalenessThresholdSeconds(backups.schedule);
  const stale = ageSeconds !== undefined && maxAgeSeconds !== undefined && ageSeconds > maxAgeSeconds;
  const details = {
    backup_id: backupId,
    last_backup_at: latestCreated.occurred_at,
    ...(ageSeconds === undefined ? {} : { age_seconds: ageSeconds }),
    ...(latestVerified === undefined ? {} : { last_verified_at: latestVerified.occurred_at }),
    schedule: backups.schedule ?? "manual",
    ...(maxAgeSeconds === undefined ? {} : { max_age_seconds: maxAgeSeconds }),
  };
  if (latestVerified === undefined) {
    return {
      name: "backup-state",
      status: "warn",
      message: `Latest backup ${backupId ?? latestCreated.id} has not been verified. Run openwiki backup verify latest.`,
      details,
    };
  }
  if (stale) {
    return {
      name: "backup-state",
      status: "warn",
      message: `Latest verified backup is older than the ${backups.schedule ?? "manual"} schedule expects.`,
      details,
    };
  }
  return {
    name: "backup-state",
    status: "pass",
    message: `Latest backup ${backupId ?? latestCreated.id} was verified at ${latestVerified.occurred_at}.`,
    details,
  };
}

export async function agentMcpConfigDiagnostic(root: string): Promise<DiagnosticCheck> {
  const metadataPath = path.join(root, ".openwiki", "agents", "setup.json");
  try {
    const parsed = JSON.parse(await readFile(metadataPath, "utf8")) as {
      client?: unknown;
      transport?: unknown;
      tool_mode?: unknown;
      config_path?: unknown;
    };
    if (
      (parsed.client === "opencode" || parsed.client === "generic") &&
      (parsed.transport === "stdio" || parsed.transport === "http") &&
      (parsed.tool_mode === "read" || parsed.tool_mode === "proposal" || parsed.tool_mode === "write")
    ) {
      return {
        name: "agent-mcp-config",
        status: "pass",
        message: `${parsed.client} MCP is configured in ${parsed.tool_mode} mode.`,
        details: {
          client: parsed.client,
          transport: parsed.transport,
          tool_mode: parsed.tool_mode,
          ...(typeof parsed.config_path === "string" ? { config_path: parsed.config_path } : {}),
        },
      };
    }
    return { name: "agent-mcp-config", status: "warn", message: "Agent MCP metadata exists but is incomplete.", details: { path: metadataPath } };
  } catch (error) {
    return {
      name: "agent-mcp-config",
      status: "warn",
      message: "No generated agent MCP config metadata found. Run openwiki mcp install opencode --mode proposal.",
      details: { path: metadataPath, error: error instanceof Error ? error.message : String(error) },
    };
  }
}

export function postgresBackupDiagnostic(
  required: DeploymentProfileRequirement | boolean = false,
  env: NodeJS.ProcessEnv = process.env,
): DiagnosticCheck {
  const requirement = requirementFrom(required);
  const postgresConfigured = env === process.env
    ? postgresRuntimeConfigured()
    : Boolean(env.OPENWIKI_DATABASE_URL?.trim() || env.DATABASE_URL?.trim());
  if (!postgresConfigured) {
    return {
      name: "postgres-backup",
      status: "skip",
      message: "Postgres is not configured, so database-native backup evidence is not required.",
    };
  }
  const configured =
    env.OPENWIKI_POSTGRES_BACKUP_CONFIGURED === "1" ||
    env.OPENWIKI_POSTGRES_BACKUP_CRONJOB === "1" ||
    Boolean(env.OPENWIKI_POSTGRES_BACKUP_PATH?.trim());
  if (configured) {
    return {
      name: "postgres-backup",
      status: "pass",
      message: "Postgres backup evidence is configured.",
      details: {
        configured: true,
        has_backup_path: Boolean(env.OPENWIKI_POSTGRES_BACKUP_PATH?.trim()),
      },
    };
  }
  return {
    name: "postgres-backup",
    status: requirementStatus(requirement === "skip" ? "warn" : requirement),
    message: "Postgres is configured but no database-native backup evidence was found. Set OPENWIKI_POSTGRES_BACKUP_CONFIGURED=1 after enabling pg_dump, PITR, or a provider backup.",
  };
}

export function objectStorageBackupDiagnostic(
  storage: OpenWikiStorageConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
  required: DeploymentProfileRequirement | boolean = "warn",
): DiagnosticCheck {
  const requirement = requirementFrom(required);
  const backend = storage?.backend ?? "local";
  if (backend === "local") {
    const hostedStorageMessage = requirement === "required"
      ? "This deployment profile requires external object storage with provider-native backup evidence."
      : "External object storage is recommended before this deployment stores hosted captures, attachments, or backups outside the workspace.";
    if (requirement !== "skip") {
      return { name: "object-storage-backup", status: requirementStatus(requirement), message: hostedStorageMessage };
    }
    return { name: "object-storage-backup", status: "skip", message: "External object storage is not configured; workspace backups include local object captures." };
  }
  const configured =
    env.OPENWIKI_OBJECT_STORAGE_BACKUP_CONFIGURED === "1" ||
    Boolean(env.OPENWIKI_OBJECT_STORAGE_BACKUP_POLICY?.trim());
  if (configured) {
    return {
      name: "object-storage-backup",
      status: "pass",
      message: `External object storage backup evidence is configured for ${backend}.`,
      details: {
        backend,
        configured: true,
      },
    };
  }
  return {
    name: "object-storage-backup",
    status: requirementStatus(requirement === "skip" ? "warn" : requirement),
    message: `runtime.storage.backend=${backend} uses external object storage; configure provider-native versioning, replication, or backup and set OPENWIKI_OBJECT_STORAGE_BACKUP_CONFIGURED=1.`,
    details: {
      backend,
      bucket: storage?.bucket,
      prefix: storage?.prefix,
    },
  };
}

export async function gitRemoteDiagnostic(root: string, required: DeploymentProfileRequirement | boolean): Promise<DiagnosticCheck> {
  const requirement = requirementFrom(required);
  try {
    const status = await gitRemoteStatus(root);
    if (!status.is_git_repo) {
      return { name: "git-remote", status: requirementStatus(requirement), message: "Workspace is not a Git repository." };
    }
    if (status.remote_url === undefined) {
      return { name: "git-remote", status: requirementStatus(requirement), message: "No Git remote URL is configured for backup/sync." };
    }
    return { name: "git-remote", status: "pass", message: `Git remote ${status.remote ?? "origin"} is configured.`, details: { branch: status.branch, upstream: status.upstream } };
  } catch (error: unknown) {
    return {
      name: "git-remote",
      status: requirementStatus(requirement),
      message: "Git remote check failed.",
      details: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

function backupIdFromEvent(event: EventRecord): string | undefined {
  if (typeof event.record_id === "string" && event.record_id.trim().length > 0) {
    return event.record_id;
  }
  const backupId = event.data?.backup_id;
  return typeof backupId === "string" && backupId.trim().length > 0 ? backupId : undefined;
}

function backupStalenessThresholdSeconds(schedule: OpenWikiBackupSchedule | undefined): number | undefined {
  if (schedule === "hourly") {
    return 2 * 60 * 60;
  }
  if (schedule === "daily") {
    return 36 * 60 * 60;
  }
  if (schedule === "weekly") {
    return 8 * 24 * 60 * 60;
  }
  return undefined;
}

export function publicOriginDiagnostic(origin: string | undefined, required: DeploymentProfileRequirement | boolean): DiagnosticCheck {
  const requirement = requirementFrom(required);
  if (origin === undefined || origin.trim() === "") {
    return {
      name: "public-origin",
      status: requirementStatus(requirement),
      message:
        requirement === "required"
          ? "This deployment profile requires OPENWIKI_PUBLIC_ORIGIN or --public-origin."
          : requirement === "warn"
            ? "Configure OPENWIKI_PUBLIC_ORIGIN before exposing this deployment through a browser hostname."
            : "No public origin configured for this local profile.",
    };
  }
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "https:" && requirement !== "skip") {
      return { name: "public-origin", status: requirementStatus(requirement), message: "Hosted public origins must use HTTPS.", details: { origin } };
    }
    return { name: "public-origin", status: "pass", message: `Public origin is ${parsed.origin}.`, details: { origin: parsed.origin } };
  } catch {
    return { name: "public-origin", status: "fail", message: `Invalid public origin: ${origin}` };
  }
}

export function trustedHeaderDiagnostic(options: CliOptions): DiagnosticCheck {
  const enabled = options.trustHeaders || process.env.OPENWIKI_TRUST_AUTH_HEADERS === "1";
  const proxyOriginEnabled = process.env.OPENWIKI_TRUST_PROXY_ORIGIN === "1";
  const proxyOriginSecret = (process.env.OPENWIKI_TRUST_PROXY_ORIGIN_SECRET ?? process.env.OPENWIKI_TRUST_AUTH_HEADERS_SECRET ?? options.trustedHeaderSecret ?? "").trim();
  if (proxyOriginEnabled && proxyOriginSecret.length === 0) {
    return {
      name: "trusted-headers",
      status: "fail",
      message: "Trusted proxy origin requires OPENWIKI_TRUST_PROXY_ORIGIN_SECRET or OPENWIKI_TRUST_AUTH_HEADERS_SECRET.",
    };
  }
  if (proxyOriginEnabled && proxyOriginSecret.length < 16) {
    return { name: "trusted-headers", status: "fail", message: "Trusted proxy origin secret must be at least 16 characters." };
  }
  if (!enabled) {
    return proxyOriginEnabled
      ? { name: "trusted-headers", status: "pass", message: "Trusted proxy origin has a shared proxy secret configured." }
      : { name: "trusted-headers", status: "skip", message: "Trusted SSO headers are not enabled." };
  }
  const secret = options.trustedHeaderSecret ?? process.env.OPENWIKI_TRUST_AUTH_HEADERS_SECRET;
  if (secret === undefined || secret.trim() === "") {
    return { name: "trusted-headers", status: "fail", message: "Trusted auth headers require OPENWIKI_TRUST_AUTH_HEADERS_SECRET or --trusted-header-secret." };
  }
  if (secret.trim().length < 16) {
    return { name: "trusted-headers", status: "fail", message: "Trusted auth header secret must be at least 16 characters." };
  }
  return { name: "trusted-headers", status: "pass", message: "Trusted auth headers have a shared proxy secret configured." };
}

export function rateLimitDiagnostic(required: DeploymentProfileRequirement | boolean): DiagnosticCheck {
  const requirement = requirementFrom(required);
  const configured = process.env.OPENWIKI_RATE_LIMIT_ENABLED?.trim();
  if (configured === "0" && requirement !== "skip") {
    return { name: "rate-limits", status: requirementStatus(requirement), message: "Hosted profiles should not disable rate limits." };
  }
  if (configured === "1") {
    return { name: "rate-limits", status: "pass", message: "HTTP/MCP rate limits are explicitly enabled." };
  }
  if (requirement === "required") {
    return { name: "rate-limits", status: "pass", message: "Hosted defaults enable rate limits when runtime profile or public origin is configured." };
  }
  if (requirement === "warn") {
    return { name: "rate-limits", status: "warn", message: "Enable HTTP/MCP rate limits before exposing this private deployment to untrusted networks." };
  }
  return { name: "rate-limits", status: "skip", message: "Rate limits are optional for local personal profiles." };
}

export function imageDigestDiagnostic(image: string | undefined, required: DeploymentProfileRequirement | boolean): DiagnosticCheck {
  const requirement = requirementFrom(required);
  if (image === undefined || image.trim() === "") {
    return {
      name: "image-digest",
      status: requirementStatus(requirement),
      message:
        requirement === "required"
          ? "This deployment profile should pin an immutable image digest."
          : requirement === "warn"
            ? "Pin an immutable image digest before treating this deployment as production."
            : "No image configured for this local profile.",
    };
  }
  if (!image.includes("@sha256:")) {
    return { name: "image-digest", status: requirementStatus(requirement === "skip" ? "warn" : requirement), message: `Image is not digest-pinned: ${image}` };
  }
  return { name: "image-digest", status: "pass", message: "Container image is pinned by digest." };
}

export function writeCoordinatorDiagnostic(required: DeploymentProfileRequirement | boolean): DiagnosticCheck {
  const requirement = requirementFrom(required);
  const coordinator = process.env.OPENWIKI_WRITE_COORDINATOR_BACKEND?.trim();
  const queue = process.env.OPENWIKI_QUEUE_BACKEND?.trim();
  const runtime = process.env.OPENWIKI_RUNTIME_BACKEND?.trim();
  if (coordinator === "postgres") {
    return { name: "write-coordinator", status: "pass", message: "Postgres write coordinator is configured." };
  }
  if (queue === "postgres" || runtime === "postgres") {
    return { name: "write-coordinator", status: "pass", message: "Postgres write coordinator is auto-selected by queue/runtime backend." };
  }
  if (requirement === "required") {
    return { name: "write-coordinator", status: "fail", message: "This deployment profile requires OPENWIKI_WRITE_COORDINATOR_BACKEND=postgres or a Postgres queue/runtime backend." };
  }
  if (requirement === "warn") {
    return { name: "write-coordinator", status: "warn", message: "Use the Postgres write coordinator before running multiple web or worker writers." };
  }
  return { name: "write-coordinator", status: "skip", message: "Local file lock coordinator is acceptable for a single local process." };
}

export async function staticExportArtifactsDiagnostic(root: string, outDir: string | undefined): Promise<DiagnosticCheck> {
  if (outDir !== undefined && path.isAbsolute(outDir)) {
    return {
      name: "static-artifacts",
      status: "fail",
      message: "Static export out-dir must be relative to the OpenWiki workspace.",
      details: { out_dir: outDir },
    };
  }
  const target = path.resolve(root, outDir ?? "public");
  const requiredFiles = ["index.html", "search-index.json", "graph.json", "graph-report.json", "agents/index.md", "static-export-report.json"];
  const missing: string[] = [];
  for (const file of requiredFiles) {
    if (!(await exists(path.join(target, file)))) {
      missing.push(file);
    }
  }
  if (missing.length > 0) {
    return {
      name: "static-artifacts",
      status: "fail",
      message: `Static export artifacts are missing in ${target}: ${missing.join(", ")}`,
      details: { out_dir: target, missing },
    };
  }
  return { name: "static-artifacts", status: "pass", message: `Static export artifacts are present in ${target}.`, details: { out_dir: target } };
}

export function deploymentProfileDiagnostic(profile: DeploymentProfileDefinition): DiagnosticCheck {
  return {
    name: "deployment-profile",
    status: "pass",
    message: `${profile.name} is ${profile.status}; trust boundary: ${profile.trustBoundary}.`,
    details: {
      profile: profile.name,
      status: profile.status,
      trust_boundary: profile.trustBoundary,
      persistence_model: profile.persistenceModel,
      backup_model: profile.backupModel,
      scaling_path: profile.scalingPath,
    },
  };
}

export function requirementFrom(value: DeploymentProfileRequirement | boolean): DeploymentProfileRequirement {
  if (value === true) {
    return "required";
  }
  if (value === false) {
    return "skip";
  }
  return value;
}

export function requirementStatus(requirement: DeploymentProfileRequirement): DiagnosticStatus {
  if (requirement === "required") {
    return "fail";
  }
  if (requirement === "warn") {
    return "warn";
  }
  return "skip";
}

export function summarizeDiagnosticStatus(checks: DiagnosticCheck[]): "pass" | "warn" | "fail" {
  if (checks.some((check) => check.status === "fail")) {
    return "fail";
  }
  if (checks.some((check) => check.status === "warn")) {
    return "warn";
  }
  return "pass";
}

export function printDiagnosticReport(report: DiagnosticReport, options: CliOptions): void {
  if (options.json) {
    printJson(report);
  } else {
    console.log(`OpenWiki ${report.command}: ${report.status}`);
    for (const check of report.checks) {
      console.log(`${check.status.toUpperCase().padEnd(4)} ${check.name} - ${check.message}`);
    }
  }
  if (report.status === "fail") {
    process.exitCode = 1;
  }
}

export async function resolveRootOptional(options: CliOptions): Promise<string | undefined> {
  try {
    return await resolveRoot(options);
  } catch {
    return undefined;
  }
}

export function compareSemver(actual: string, minimum: string): number {
  const actualParts = actual.split(".").map((part) => Number(part));
  const minimumParts = minimum.split(".").map((part) => Number(part));
  for (let index = 0; index < 3; index += 1) {
    const diff = (actualParts[index] ?? 0) - (minimumParts[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}
