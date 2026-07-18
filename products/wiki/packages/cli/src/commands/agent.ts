import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { rebuildIndexStore } from "@openwiki/index-store";
import type { McpToolMode } from "@openwiki/mcp-server";
import type { AgentClient, AgentTransport, CliOptions } from "../args.ts";
import {
  agentProviderForClient,
  generateAgentProviderConfig,
  listAgentProviderSummaries,
  mcpHttpUrl as providerMcpHttpUrl,
  resolveAgentProvider,
  type AgentProviderConfigInput as AgentClientConfigInput,
} from "../agent-providers.ts";
import { DEPLOYMENT_PROFILE_NAMES, deploymentProfileFor } from "../deployment-profiles.ts";
import { hostedHumanAgentDiagnostics } from "../hosted-auth-diagnostics.ts";
import { printJson } from "../output.ts";
import { createWorkspace, loadRepository } from "@openwiki/repo";
import { buildSearchIndex } from "@openwiki/search";
import {
  configureLocalBackupDestination,
  consumerSyncProviderForPath,
  createServiceAccountToken,
} from "@openwiki/workflows";
import type { ServiceAccountTokenProfile } from "@openwiki/workflows";
import { resolveRoot } from "../utils.ts";
import { connectGitSync } from "./sync.ts";
import {
  deploymentProfileDiagnostic,
  gitRemoteDiagnostic,
  imageDigestDiagnostic,
  objectStorageBackupDiagnostic,
  postgresDiagnostic,
  postgresBackupDiagnostic,
  printDiagnosticReport,
  publicOriginDiagnostic,
  rateLimitDiagnostic,
  resolveRootOptional,
  sqliteReadinessDiagnostic,
  staticExportArtifactsDiagnostic,
  summarizeDiagnosticStatus,
  trustedHeaderDiagnostic,
  writableWorkspaceDiagnostic,
  workspaceRuntimeConfigDiagnostics,
  writeCoordinatorDiagnostic,
  agentMcpConfigDiagnostic,
  type DiagnosticCheck,
} from "./doctor.ts";
import { integrateOpenCode } from "./integrations.ts";

interface AgentConfigureResult {
  client: Exclude<AgentClient, "none">;
  root: string;
  tool_mode: McpToolMode;
  transport: AgentTransport;
  server_name: string;
  server_url?: string;
  config: unknown;
  config_path?: string;
  token_file?: string;
  token_id?: string;
  notes: string[];
}

interface SetupPersonalAction {
  kind: "workspace" | "git_sync" | "backup" | "agent" | "integration" | "doctor";
  status: "created" | "configured" | "existing" | "skipped" | "pass" | "warn" | "fail";
  message: string;
}

export async function setupCommand(args: string[], options: CliOptions): Promise<void> {
  const [kind, targetArg] = args;
  if (kind === "personal") {
    const target = path.resolve(targetArg ?? options.root ?? "openwiki-personal");
    assertSafePersonalWorkspacePath(target, options);
    const actions: SetupPersonalAction[] = [];
    const existing = await workspaceConfigExists(target);
    const config = existing
      ? (await loadRepository(target)).config
      : await createWorkspace(target, {
          title: options.title ?? "Personal Wiki",
          template: "personal-wiki",
        });
    actions.push({
      kind: "workspace",
      status: existing ? "existing" : "created",
      message: existing ? `Using existing OpenWiki workspace at ${target}.` : `Created personal wiki at ${target}.`,
    });
    const [searchIndex, indexStore] = await Promise.all([buildSearchIndex(target), rebuildIndexStore(target)]);
    const gitSync = options.gitRemoteUrl === undefined
      ? undefined
      : await connectGitSync({
          root: target,
          remoteUrl: options.gitRemoteUrl,
          remote: options.gitRemote ?? "origin",
          branch: options.gitBranch ?? "main",
          ...(options.credentialRef === undefined ? {} : { credentialRef: options.credentialRef }),
          ...(options.actor === undefined ? {} : { actorId: options.actor }),
        });
    if (gitSync !== undefined) {
      actions.push({
        kind: "git_sync",
        status: "configured",
        message: `Configured Git sync for ${gitSync.remote}/${gitSync.branch}.`,
      });
    } else {
      actions.push({ kind: "git_sync", status: "skipped", message: "No Git remote requested; local-only wiki is configured." });
    }
    const backup = options.backupPath === undefined
      ? undefined
      : await configureLocalBackupDestination({
          root: target,
          id: options.backupDestination ?? "local-backups",
          path: options.backupPath,
          ...(options.keepLast === undefined ? {} : { keepLast: options.keepLast }),
          ...(options.keepDays === undefined ? {} : { keepDays: options.keepDays }),
          ...(options.actor === undefined ? {} : { actorId: options.actor }),
        });
    if (backup !== undefined) {
      actions.push({
        kind: "backup",
        status: "configured",
        message: `Configured local backup destination ${backup.destination.id ?? "local-backups"}.`,
      });
    } else {
      actions.push({ kind: "backup", status: "skipped", message: "No backup path requested; configure backups before relying on this wiki." });
    }
    const agent =
      options.skipAgent || options.agentClient === "none"
        ? undefined
        : await configureAgentForRoot(target, options.agentClient ?? "generic", {
            toolMode: options.mcpToolMode ?? "proposal",
            transport: options.agentTransport ?? "stdio",
            serverUrl: options.serverUrl,
            configOut: options.configOut,
            tokenEnv: options.tokenEnv,
            tokenFile: options.tokenFile,
            tokenOut: options.tokenOut,
            createToken: options.createToken || options.tokenOut !== undefined,
            confirmWriteTools: options.confirmWriteTools,
            profile: options.authTokenProfile,
          });
    if (agent !== undefined) {
      await writeAgentSetupMetadata(target, agent);
      actions.push({
        kind: "agent",
        status: "configured",
        message: `Configured ${agent.client} ${agent.transport} MCP in ${agent.tool_mode} mode.`,
      });
    } else {
      actions.push({ kind: "agent", status: "skipped", message: "Agent MCP config was skipped." });
    }
    const openCodeIntegration =
      agent?.client === "opencode"
        ? await integrateOpenCode(target, {
            profile: "personal-curator",
            installScope: "project",
            wikiRoot: target,
          })
        : undefined;
    if (openCodeIntegration !== undefined) {
      actions.push({
        kind: "integration",
        status: "configured",
        message: `Installed OpenCode ${openCodeIntegration.profile} pack into ${openCodeIntegration.target}.`,
      });
    } else {
      actions.push({ kind: "integration", status: "skipped", message: "Provider integration pack was skipped." });
    }
    const doctorChecks = await personalDoctorChecks(target);
    actions.push({
      kind: "doctor",
      status: summarizeDiagnosticStatus(doctorChecks),
      message: `Personal profile doctor completed with status ${summarizeDiagnosticStatus(doctorChecks)}.`,
    });
    const result = {
      profile: "personal" as const,
      root: target,
      template: "personal-wiki",
      config,
      search_index: searchIndex,
      index_store: indexStore,
      ...(gitSync === undefined ? {} : { git_sync: gitSync }),
      ...(backup === undefined ? {} : { backup }),
      ...(agent === undefined ? {} : { agent }),
      ...(openCodeIntegration === undefined ? {} : { opencode_integration: openCodeIntegration }),
      doctor: {
        status: summarizeDiagnosticStatus(doctorChecks),
        checks: doctorChecks,
      },
      actions,
      next_steps: [
        ...(backup === undefined ? [`Configure backups with: openwiki --root ${target} backup configure local --id local-backups --path <backup-folder>`] : []),
        ...(gitSync === undefined ? [`Connect private Git sync with: openwiki --root ${target} sync connect git --remote-url <private-git-url> --branch main`] : []),
        `Open ${target} in the web UI with: openwiki --root ${target} serve --host 127.0.0.1 --port 3030`,
        ...(openCodeIntegration === undefined ? [] : [`Run OpenCode from ${target} so it picks up the installed .opencode pack.`]),
        "Connect local agents through stdio MCP before exposing an HTTP server.",
      ],
    };
    if (options.json) {
      printJson(result);
      return;
    }
    console.log(`${existing ? "Prepared existing" : "Initialized"} personal wiki at ${target}`);
    console.log(`Indexed records=${searchIndex.recordCount}; index-store records=${indexStore.recordCount}`);
    for (const action of actions) {
      console.log(`${action.kind}: ${action.status} - ${action.message}`);
    }
    if (agent !== undefined) {
      printAgentSummary(agent);
    }
    console.log("Next:");
    for (const step of result.next_steps) {
      console.log("- " + step);
    }
    return;
  }

  if (kind === "team") {
    const target = path.resolve(targetArg ?? options.root ?? "openwiki-team");
    const config = await createWorkspace(target, {
      title: options.title ?? "Team Wiki",
      template: "team-wiki",
    });
    const [searchIndex, indexStore] = await Promise.all([buildSearchIndex(target), rebuildIndexStore(target)]);
    const spaceTitle = options.spaceTitle ?? "Team Knowledge";
    const nextSteps = [
      `Put OpenWiki behind SSO or an authenticating reverse proxy before accepting browser writes.`,
      `Set OPENWIKI_PUBLIC_ORIGIN to the browser-visible HTTPS origin.`,
      `Set OPENWIKI_TRUST_AUTH_HEADERS=1 and OPENWIKI_TRUST_AUTH_HEADERS_SECRET for trusted identity headers.`,
      `Create service-account tokens with openwiki --root ${target} auth token create --profile proposal-agent --token-description "Hosted proposal agent".`,
    ];
    if (options.adminPrincipal !== undefined || options.teamGroup !== undefined) {
      nextSteps.push(
        `Review initial access: admin=${options.adminPrincipal ?? "unset"} team_group=${options.teamGroup ?? "unset"} space="${spaceTitle}".`,
      );
      nextSteps.push(
        `Use openwiki --root ${target} policy propose-section --section section:team-knowledge --title "${spaceTitle}" --path wiki/team/** --reviewer ${
          options.teamGroup ?? "group:knowledge-reviewers"
        } --admin ${options.adminPrincipal ?? "group:knowledge-admins"} to adjust permissions through review.`,
      );
    }
    const result = {
      profile: "team" as const,
      root: target,
      template: "team-wiki",
      config,
      search_index: searchIndex,
      index_store: indexStore,
      space: {
        title: spaceTitle,
        admin_principal: options.adminPrincipal,
        team_group: options.teamGroup,
      },
      next_steps: nextSteps,
    };
    if (options.json) {
      printJson(result);
      return;
    }
    console.log(`Initialized team wiki at ${target}`);
    console.log(`Indexed records=${searchIndex.recordCount}; index-store records=${indexStore.recordCount}`);
    console.log("Next:");
    for (const step of nextSteps) {
      console.log("- " + step);
    }
    return;
  }

  throw new Error("Usage: openwiki setup personal|team [path] [--agent opencode|generic|none] [--tools read|proposal|write] [--git-remote URL] [--backup-path folder] [--config-out path] [--create-token --token-out path] [--confirm-write-tools] [--json]");
}

export async function agentCommand(args: string[], options: CliOptions): Promise<void> {
  const [subcommand, resource] = args;
  if ((subcommand === "providers" || subcommand === "provider") && (resource === undefined || resource === "list")) {
    const providers = listAgentProviderSummaries();
    if (options.json) {
      printJson({ providers });
      return;
    }
    for (const provider of providers) {
      const aliases = provider.aliases.length > 0 ? ` aliases=${provider.aliases.join(",")}` : "";
      const profiles = provider.install_profiles.length > 0 ? ` profiles=${provider.install_profiles.join(",")}` : "";
      console.log(`${provider.id}\t${provider.client}\t${provider.transports.join(",")}\t${provider.install_kind}${aliases}${profiles}`);
    }
    return;
  }

  if (subcommand === "install") {
    const provider = resolveAgentProvider(options.provider ?? "opencode");
    if (provider.install.kind !== "opencode-pack") {
      throw new Error(`Provider ${provider.id} does not install skills, agents, tools, or plugins; use agent configure instead.`);
    }
    const installScope = options.profile === "global" ? "global" : "project";
    const result = await integrateOpenCode(installScope === "global" ? options.outDir : options.outDir ?? options.root ?? ".", {
      profile: options.profile ?? "personal-curator",
      installScope,
      wikiRoot: options.wikiRoot ?? options.root,
    });
    if (options.json) {
      printJson({
        provider: provider.id,
        profile: result.profile,
        install_scope: result.install_scope,
        target: result.target,
        files: result.files,
        notes: result.notes,
      });
      return;
    }
    console.log(`Installed ${provider.displayName} integration profile ${result.profile} into ${result.target}`);
    for (const file of result.files) {
      console.log(file);
    }
    for (const note of result.notes) {
      console.log(`note: ${note}`);
    }
    return;
  }

  if (subcommand !== "configure") {
    throw new Error("Usage: openwiki agent providers list [--json]\n       openwiki agent install --provider opencode --profile personal-curator|researcher|reviewer|maintainer|wiki-curator|developer|global [--out-dir <path>] [--wiki-root <path>] [--json]\n       openwiki [--root <path>] agent configure --client opencode|generic [--transport stdio|http] [--server-url URL] [--tools read|proposal|write] [--token-env ENV|--token-file path|--create-token --token-out path] [--config-out path] [--json]");
  }
  const root = await resolveRoot(options);
  const client = options.agentClient ?? "generic";
  if (client === "none") {
    throw new Error("agent configure requires --client opencode or --client generic");
  }
  const result = await configureAgentForRoot(root, client, {
    toolMode: options.mcpToolMode ?? "proposal",
    transport: options.agentTransport ?? "stdio",
    serverUrl: options.serverUrl,
    configOut: options.configOut,
    tokenEnv: options.tokenEnv,
    tokenFile: options.tokenFile,
    tokenOut: options.tokenOut,
    createToken: options.createToken || options.tokenOut !== undefined,
    confirmWriteTools: options.confirmWriteTools,
    profile: options.authTokenProfile,
  });
  if (options.json) {
    printJson(result);
    return;
  }
  printAgentSummary(result);
}

export async function deployCommand(args: string[], options: CliOptions): Promise<void> {
  const [subcommand, resource] = args;
  if ((subcommand === "profile" || subcommand === "profiles") && (resource === undefined || resource === "list")) {
    const profiles = DEPLOYMENT_PROFILE_NAMES.map((name) => {
      const profile = deploymentProfileFor(name);
      return {
        name: profile.name,
        status: profile.status,
        trust_boundary: profile.trustBoundary,
        persistence_model: profile.persistenceModel,
        backup_model: profile.backupModel,
        scaling_path: profile.scalingPath,
      };
    });
    if (options.json) {
      printJson({ profiles });
      return;
    }
    for (const profile of profiles) {
      console.log(`${profile.name}\t${profile.status}\t${profile.trust_boundary}`);
    }
    return;
  }
  if (subcommand !== "preflight") {
    throw new Error(`Usage: openwiki deploy profile list [--json]\n       openwiki [--root <path>] deploy preflight [--deploy-profile ${DEPLOYMENT_PROFILE_NAMES.join("|")}] [--public-origin URL] [--image image@sha256:...] [--out-dir public] [--json]`);
  }
  const profile = deploymentProfileFor(options.deployProfile ?? "local-personal");
  const checks: DiagnosticCheck[] = [];
  checks.push(deploymentProfileDiagnostic(profile));
  if (profile.previewWarning !== undefined) {
    checks.push({ name: "profile-preview", status: "warn", message: profile.previewWarning });
  }
  checks.push(publicOriginDiagnostic(options.publicOrigin ?? process.env.OPENWIKI_PUBLIC_ORIGIN, profile.publicOrigin));
  checks.push(trustedHeaderDiagnostic(options));
  checks.push(rateLimitDiagnostic(profile.rateLimits));
  checks.push(imageDigestDiagnostic(options.image ?? process.env.OPENWIKI_IMAGE, profile.imageDigest));
  checks.push(writeCoordinatorDiagnostic(profile.writeCoordinator));

  const root = await resolveRootOptional(options);
  if (root === undefined) {
    checks.push({ name: "workspace", status: profile.name === "local-personal" ? "warn" : "fail", message: "No OpenWiki workspace was found. Pass --root for deployment checks that need repository state." });
  } else {
    checks.push({ name: "workspace", status: "pass", message: `Workspace resolved at ${root}`, details: { root } });
    const repo = await loadRepository(root);
    checks.push(await writableWorkspaceDiagnostic(root));
    checks.push(...await workspaceRuntimeConfigDiagnostics(root));
    checks.push(...await hostedHumanAgentDiagnostics(root, profile));
    checks.push(await sqliteReadinessDiagnostic(root));
    checks.push(await gitRemoteDiagnostic(root, profile.gitRemote));
    checks.push(await postgresDiagnostic(root, profile.postgres));
    checks.push(postgresBackupDiagnostic(profile.postgres));
    checks.push(objectStorageBackupDiagnostic(repo.config.runtime?.storage, process.env, profile.objectStorageBackup));
    if (profile.staticArtifacts) {
      checks.push(await staticExportArtifactsDiagnostic(root, options.outDir));
    }
  }

  printDiagnosticReport({
    command: "deploy-preflight",
    status: summarizeDiagnosticStatus(checks),
    deployment_profile: {
      name: profile.name,
      status: profile.status,
      trust_boundary: profile.trustBoundary,
      persistence_model: profile.persistenceModel,
      backup_model: profile.backupModel,
      scaling_path: profile.scalingPath,
    },
    checks,
  }, options);
}

export async function configureAgentForRoot(
  root: string,
  client: Exclude<AgentClient, "none">,
  input: {
    toolMode: McpToolMode;
    transport: AgentTransport;
    serverUrl?: string | undefined;
    configOut?: string | undefined;
    tokenEnv?: string | undefined;
    tokenFile?: string | undefined;
    tokenOut?: string | undefined;
    createToken: boolean;
    confirmWriteTools: boolean;
    profile?: ServiceAccountTokenProfile | undefined;
  },
): Promise<AgentConfigureResult> {
  if (input.toolMode === "write" && !input.confirmWriteTools) {
    throw new Error("--tools write can apply changes; pass --confirm-write-tools to generate a write-mode MCP config.");
  }
  const notes: string[] = [];
  let tokenFile = input.tokenFile === undefined ? undefined : path.resolve(input.tokenFile);
  let tokenId: string | undefined;
  const tokenEnv = input.tokenEnv ?? (input.transport === "http" ? "OPENWIKI_TOKEN" : undefined);
  if (input.createToken) {
    const tokenResult = await createServiceAccountToken({
      root,
      profile: input.profile ?? serviceAccountProfileForToolMode(input.toolMode, input.transport),
      expiresInDays: 90,
      description: `OpenWiki ${input.toolMode} MCP agent`,
      tokenDescription: `OpenWiki ${input.toolMode} MCP agent token`,
      auditActorId: "actor:cli:setup",
    });
    tokenId = tokenResult.token.id;
    tokenFile = path.resolve(input.tokenOut ?? input.tokenFile ?? defaultAgentTokenFile(root, input.toolMode));
    await writeSecretFile(tokenFile, tokenResult.token.value);
    notes.push(`Created service-account token ${tokenId} and wrote it to ${tokenFile}.`);
  } else if (input.tokenOut !== undefined) {
    throw new Error("--token-out requires --create-token");
  } else if (tokenFile !== undefined) {
    notes.push(`MCP config will read its bearer token from ${tokenFile}.`);
  }

  const serverName = "openwiki";
  let configInput: AgentClientConfigInput;
  let httpServerUrl: string | undefined;
  if (input.transport === "http") {
    httpServerUrl = mcpHttpUrl(input.serverUrl, input.toolMode);
    configInput = {
      transport: "http",
      url: httpServerUrl,
      ...(tokenEnv === undefined ? {} : { tokenEnv }),
    };
    notes.push(`HTTP MCP config points at ${httpServerUrl}.`);
    if (tokenEnv !== undefined) {
      notes.push(`HTTP MCP config reads its bearer token from the ${tokenEnv} environment secret.`);
    }
    if (tokenFile !== undefined) {
      notes.push(`Load the token file into ${tokenEnv ?? "OPENWIKI_TOKEN"} before starting the remote MCP client.`);
    }
  } else {
    configInput = {
      transport: "stdio",
      mcpArgs: [
        "--root",
        root,
        "mcp",
        "--stdio",
        "--tools",
        input.toolMode,
        ...(tokenFile === undefined ? [] : ["--token-file", tokenFile]),
        ...(tokenFile === undefined && tokenEnv !== undefined ? ["--token-env", tokenEnv] : []),
      ],
    };
  }
  const config = agentClientConfig(client, serverName, configInput);
  const configPath = input.configOut === undefined ? undefined : path.resolve(input.configOut);
  if (configPath !== undefined) {
    await writeJsonFile(configPath, config);
    notes.push(`Wrote ${client} MCP config to ${configPath}.`);
  }
  return {
    client,
    root,
    tool_mode: input.toolMode,
    transport: input.transport,
    server_name: serverName,
    ...(httpServerUrl === undefined ? {} : { server_url: httpServerUrl }),
    config,
    ...(configPath === undefined ? {} : { config_path: configPath }),
    ...(tokenFile === undefined ? {} : { token_file: tokenFile }),
    ...(tokenId === undefined ? {} : { token_id: tokenId }),
    notes,
  };
}

function agentClientConfig(client: Exclude<AgentClient, "none">, serverName: string, input: AgentClientConfigInput): unknown {
  return generateAgentProviderConfig(agentProviderForClient(client), serverName, input);
}

function mcpHttpUrl(serverUrl: string | undefined, toolMode: McpToolMode): string {
  return providerMcpHttpUrl(serverUrl, toolMode);
}

function serviceAccountProfileForToolMode(toolMode: McpToolMode, transport: AgentTransport = "stdio"): ServiceAccountTokenProfile {
  if (toolMode === "read") {
    return "hosted-readonly-agent";
  }
  if (toolMode === "write") {
    return "maintainer-automation";
  }
  return transport === "http" ? "proposal-agent" : "local-agent";
}

function defaultAgentTokenFile(root: string, toolMode: McpToolMode): string {
  return path.join(os.homedir(), ".config", "openwiki", "tokens", `${path.basename(root).replace(/[^A-Za-z0-9._-]/g, "-")}-${toolMode}.token`);
}

async function writeSecretFile(filePath: string, value: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, value.trim() + "\n", { mode: 0o600 });
  await chmod(filePath, 0o600);
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2) + "\n");
}

export async function writeAgentSetupMetadata(root: string, result: AgentConfigureResult): Promise<void> {
  await writeJsonFile(path.join(root, ".openwiki", "agents", "setup.json"), {
    schema_version: "openwiki.agent-setup.v1",
    client: result.client,
    transport: result.transport,
    tool_mode: result.tool_mode,
    server_name: result.server_name,
    ...(result.server_url === undefined ? {} : { server_url: result.server_url }),
    ...(result.config_path === undefined ? {} : { config_path: result.config_path }),
    ...(result.token_file === undefined ? {} : { token_file: result.token_file }),
    updated_at: new Date().toISOString(),
  });
}

async function workspaceConfigExists(root: string): Promise<boolean> {
  try {
    await access(path.join(root, "openwiki.json"));
    return true;
  } catch {
    return false;
  }
}

function assertSafePersonalWorkspacePath(root: string, options: CliOptions): void {
  const provider = consumerSyncProviderForPath(root);
  if (provider !== undefined && !options.allowSyncFolderWorkspace) {
    throw new Error(
      `Refusing to create a live OpenWiki workspace inside ${provider}. Keep the live Git workspace in a normal folder and use --backup-path for synced backup artifacts, or pass --allow-sync-folder-workspace if you accept the risk.`,
    );
  }
}

async function personalDoctorChecks(root: string): Promise<DiagnosticCheck[]> {
  const checks: DiagnosticCheck[] = [];
  checks.push(await writableWorkspaceDiagnostic(root));
  checks.push(...await workspaceRuntimeConfigDiagnostics(root));
  checks.push(await gitRemoteDiagnostic(root, "warn"));
  checks.push(await agentMcpConfigDiagnostic(root));
  return checks;
}

export function printAgentSummary(result: AgentConfigureResult): void {
  console.log(`Agent config: ${result.client} (${result.transport}, ${result.tool_mode} tools)`);
  if (result.server_url !== undefined) {
    console.log(`Server: ${result.server_url}`);
  }
  if (result.config_path !== undefined) {
    console.log(`Config: ${result.config_path}`);
  } else {
    console.log(JSON.stringify(result.config, null, 2));
  }
  if (result.token_file !== undefined) {
    console.log(`Token file: ${result.token_file}`);
  }
  for (const note of result.notes) {
    console.log(`note: ${note}`);
  }
}
