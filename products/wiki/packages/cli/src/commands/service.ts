import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { atomicWriteFile } from "@openwiki/core";
import { loadRepository } from "@openwiki/repo";
import type { CliOptions } from "../args.ts";
import { printJson } from "../output.ts";
import { exists, resolveRoot } from "../utils.ts";
import { parseAutomationIntervalSeconds, readAutomationState, type AutomationKind, type AutomationState } from "./watch.ts";

const execFileAsync = promisify(execFile);

type ServicePlatform = "macos" | "linux" | "unsupported";
type ActivationStatus = "activated" | "manual" | "skipped" | "failed";

interface AutomationServiceLocations {
  platform: ServicePlatform;
  workspace_key: string;
  label: string;
  log_dir: string;
  stdout_log: string;
  stderr_log: string;
  plist_path?: string;
  systemd_service_path?: string;
  systemd_timer_path?: string;
}

interface AutomationServicePlan extends AutomationServiceLocations {
  root: string;
  kind: AutomationKind;
  every: string;
  every_seconds: number;
  command: string[];
  working_directory: string;
  activation_commands: string[];
  manual_cron_examples: string[];
}

interface ServiceStatusEntry extends AutomationServiceLocations {
  kind: AutomationKind;
  installed: boolean;
  state: AutomationState;
}

interface ServiceActivationResult {
  status: ActivationStatus;
  commands: string[];
  error?: string;
}

export async function serviceCommand(args: string[], options: CliOptions): Promise<void> {
  const [subcommand, kindRaw] = args;
  if (subcommand === "install") {
    const kind = parseAutomationKind(kindRaw);
    if (options.every === undefined) {
      throw new Error(serviceUsage());
    }
    const root = await resolveRoot(options);
    const plan = await createAutomationServicePlan({
      root,
      kind,
      every: options.every,
      options,
    });
    if (plan.platform === "unsupported") {
      const result = { root, kind, platform: plan.platform, installed: false, plan, activation: manualActivation(plan) };
      printServiceResult(result, options);
      return;
    }
    const installed = await installAutomationService(plan);
    const activation = await activateAutomationService(plan);
    printServiceResult({ root, kind, platform: plan.platform, installed, plan, activation }, options);
    return;
  }
  if (subcommand === "status") {
    const root = await resolveRoot(options);
    const result = await automationServiceStatus(root);
    if (options.json) {
      printJson(result);
      return;
    }
    console.log(`service platform ${result.platform}`);
    for (const entry of result.services) {
      console.log(`${entry.kind} ${entry.installed ? "installed" : "not_installed"} ${entry.label}`);
      const last = entry.state.last_run;
      if (last !== undefined) {
        console.log(`  last_run ${last.finished_at} ${last.status} ${last.message}`);
      }
      console.log(`  logs ${entry.stdout_log}`);
    }
    return;
  }
  if (subcommand === "uninstall") {
    const kind = parseAutomationKind(kindRaw);
    const root = await resolveRoot(options);
    const result = await uninstallAutomationService(root, kind);
    if (options.json) {
      printJson(result);
      return;
    }
    console.log(`uninstalled ${kind} service files: ${result.removed_paths.length}`);
    for (const command of result.activation.commands) {
      console.log(`run: ${command}`);
    }
    return;
  }
  throw new Error(serviceUsage());
}

export async function createAutomationServicePlan(input: {
  root: string;
  kind: AutomationKind;
  every: string;
  options?: CliOptions;
  platform?: ServicePlatform;
  commandPrefix?: string[];
  workingDirectory?: string;
}): Promise<AutomationServicePlan> {
  const root = path.resolve(input.root);
  const everySeconds = parseAutomationIntervalSeconds(input.every);
  if (input.kind === "inbox" && input.options?.inboxDir === undefined) {
    throw new Error("Inbox service install requires --dir <folder>.");
  }
  const locations = await automationServiceLocations(root, input.kind, input.platform ?? detectServicePlatform());
  const options = input.kind === "backup" ? await backupServiceOptions(root, input.options) : input.options;
  const command = [
    ...(input.commandPrefix ?? openWikiServiceCommandPrefix()),
    "--root",
    root,
    input.kind,
    "watch",
    "--every",
    input.every,
    "--once",
    "--json",
    ...watchCommandOptions(input.kind, options),
  ];
  const activationCommands = activationCommandsFor(locations);
  return {
    ...locations,
    root,
    kind: input.kind,
    every: input.every,
    every_seconds: everySeconds,
    command,
    working_directory: input.workingDirectory ?? process.cwd(),
    activation_commands: activationCommands,
    manual_cron_examples: manualCronExamples(input.kind, root, input.every, command, locations),
  };
}

async function backupServiceOptions(root: string, options: CliOptions | undefined): Promise<CliOptions | undefined> {
  if (options?.backupDestination !== undefined || options?.outDir !== undefined) {
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
    return destinationId === undefined || options === undefined ? options : { ...options, backupDestination: destinationId };
  }
  if (destinations.length > 1) {
    throw new Error("Multiple backup destinations are configured; pass --destination <id> for scheduled backups.");
  }
  return options;
}

export async function automationServiceStatus(root: string, platform = detectServicePlatform()): Promise<{ root: string; platform: ServicePlatform; services: ServiceStatusEntry[] }> {
  const resolvedRoot = path.resolve(root);
  const services: ServiceStatusEntry[] = [];
  for (const kind of ["sync", "backup", "inbox"] as const) {
    const locations = await automationServiceLocations(resolvedRoot, kind, platform);
    const installed = await serviceFilesInstalled(locations);
    services.push({
      ...locations,
      kind,
      installed,
      state: await readAutomationState(resolvedRoot, kind),
    });
  }
  return { root: resolvedRoot, platform, services };
}

export async function automationServiceDiagnostics(root: string): Promise<Array<{ name: string; status: "pass" | "warn" | "skip"; message: string; details?: Record<string, unknown> }>> {
  const status = await automationServiceStatus(root);
  return status.services.map((service) => {
    if (service.installed) {
      return {
        name: `${service.kind}-automation`,
        status: "pass" as const,
        message: `${service.kind} automation is installed for ${service.label}.`,
        details: { service },
      };
    }
    return {
      name: `${service.kind}-automation`,
      status: "skip" as const,
      message: `${service.kind} automation is not installed; use openwiki service install ${service.kind} --every ... to schedule it.`,
      details: { service },
    };
  });
}

export function renderLaunchdPlist(plan: AutomationServicePlan): string {
  if (plan.plist_path === undefined) {
    throw new Error("launchd plist rendering requires a macOS plan.");
  }
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${escapeXml(plan.label)}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    ...plan.command.map((argument) => `    <string>${escapeXml(argument)}</string>`),
    `  </array>`,
    `  <key>WorkingDirectory</key>`,
    `  <string>${escapeXml(plan.working_directory)}</string>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    `    <key>OPENWIKI_AUTOMATION_SERVICE</key>`,
    `    <string>1</string>`,
    `    <key>PATH</key>`,
    `    <string>${escapeXml(process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin")}</string>`,
    `  </dict>`,
    `  <key>StartInterval</key>`,
    `  <integer>${plan.every_seconds}</integer>`,
    `  <key>StandardOutPath</key>`,
    `  <string>${escapeXml(plan.stdout_log)}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${escapeXml(plan.stderr_log)}</string>`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}

export function renderSystemdService(plan: AutomationServicePlan): string {
  if (plan.systemd_service_path === undefined) {
    throw new Error("systemd service rendering requires a Linux plan.");
  }
  return [
    `[Unit]`,
    `Description=OpenWiki ${plan.kind} automation for ${plan.root}`,
    ``,
    `[Service]`,
    `Type=oneshot`,
    `WorkingDirectory=${systemdQuote(plan.working_directory)}`,
    `Environment=OPENWIKI_AUTOMATION_SERVICE=1`,
    `ExecStart=${plan.command.map(systemdQuote).join(" ")}`,
    `StandardOutput=append:${plan.stdout_log}`,
    `StandardError=append:${plan.stderr_log}`,
    ``,
  ].join("\n");
}

export function renderSystemdTimer(plan: AutomationServicePlan): string {
  if (plan.systemd_timer_path === undefined) {
    throw new Error("systemd timer rendering requires a Linux plan.");
  }
  return [
    `[Unit]`,
    `Description=Schedule OpenWiki ${plan.kind} automation for ${plan.root}`,
    ``,
    `[Timer]`,
    `OnBootSec=5min`,
    `OnUnitActiveSec=${plan.every_seconds}s`,
    `RandomizedDelaySec=${Math.max(1, Math.min(300, Math.floor(plan.every_seconds * 0.1)))}s`,
    `Persistent=true`,
    ``,
    `[Install]`,
    `WantedBy=timers.target`,
    ``,
  ].join("\n");
}

async function installAutomationService(plan: AutomationServicePlan): Promise<boolean> {
  await fs.mkdir(plan.log_dir, { recursive: true });
  if (plan.plist_path !== undefined) {
    await fs.mkdir(path.dirname(plan.plist_path), { recursive: true });
    await atomicWriteFile(plan.plist_path, renderLaunchdPlist(plan));
    return true;
  }
  if (plan.systemd_service_path !== undefined && plan.systemd_timer_path !== undefined) {
    await fs.mkdir(path.dirname(plan.systemd_service_path), { recursive: true });
    await atomicWriteFile(plan.systemd_service_path, renderSystemdService(plan));
    await atomicWriteFile(plan.systemd_timer_path, renderSystemdTimer(plan));
    return true;
  }
  return false;
}

async function uninstallAutomationService(root: string, kind: AutomationKind): Promise<{
  root: string;
  kind: AutomationKind;
  platform: ServicePlatform;
  removed_paths: string[];
  activation: ServiceActivationResult;
}> {
  const platform = detectServicePlatform();
  const locations = await automationServiceLocations(path.resolve(root), kind, platform);
  const activation = await deactivateAutomationService(locations);
  const candidates = [locations.plist_path, locations.systemd_service_path, locations.systemd_timer_path].filter((candidate): candidate is string => candidate !== undefined);
  const removedPaths: string[] = [];
  for (const candidate of candidates) {
    if (await exists(candidate)) {
      await fs.rm(candidate, { force: true });
      removedPaths.push(candidate);
    }
  }
  if (platform === "linux") {
    await execFileAsync("systemctl", ["--user", "daemon-reload"], { timeout: 10000 }).catch(() => undefined);
  }
  return { root: path.resolve(root), kind, platform, removed_paths: removedPaths, activation };
}

async function activateAutomationService(plan: AutomationServicePlan): Promise<ServiceActivationResult> {
  if (process.env.OPENWIKI_SERVICE_SKIP_ACTIVATE === "1") {
    return { status: "skipped", commands: plan.activation_commands };
  }
  if (plan.platform === "unsupported") {
    return manualActivation(plan);
  }
  try {
    if (plan.platform === "macos" && plan.plist_path !== undefined) {
      const domain = launchdDomain();
      await execFileAsync("launchctl", ["bootout", domain, plan.plist_path], { timeout: 10000 }).catch(() => undefined);
      await execFileAsync("launchctl", ["bootstrap", domain, plan.plist_path], { timeout: 10000 });
      await execFileAsync("launchctl", ["enable", `${domain}/${plan.label}`], { timeout: 10000 }).catch(() => undefined);
      return { status: "activated", commands: plan.activation_commands };
    }
    if (plan.platform === "linux" && plan.systemd_timer_path !== undefined) {
      await execFileAsync("systemctl", ["--user", "daemon-reload"], { timeout: 10000 });
      await execFileAsync("systemctl", ["--user", "enable", "--now", path.basename(plan.systemd_timer_path)], { timeout: 10000 });
      return { status: "activated", commands: plan.activation_commands };
    }
    return manualActivation(plan);
  } catch (error) {
    return {
      status: "failed",
      commands: plan.activation_commands,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function deactivateAutomationService(locations: AutomationServiceLocations): Promise<ServiceActivationResult> {
  const commands = deactivationCommandsFor(locations);
  if (process.env.OPENWIKI_SERVICE_SKIP_ACTIVATE === "1") {
    return { status: "skipped", commands };
  }
  try {
    if (locations.platform === "macos" && locations.plist_path !== undefined) {
      await execFileAsync("launchctl", ["bootout", launchdDomain(), locations.plist_path], { timeout: 10000 }).catch(() => undefined);
      return { status: "activated", commands };
    }
    if (locations.platform === "linux" && locations.systemd_timer_path !== undefined) {
      await execFileAsync("systemctl", ["--user", "disable", "--now", path.basename(locations.systemd_timer_path)], { timeout: 10000 }).catch(() => undefined);
      return { status: "activated", commands };
    }
    return { status: "manual", commands };
  } catch (error) {
    return { status: "failed", commands, error: error instanceof Error ? error.message : String(error) };
  }
}

async function automationServiceLocations(root: string, kind: AutomationKind, platform: ServicePlatform): Promise<AutomationServiceLocations> {
  const repo = await loadRepository(root);
  const workspaceKey = serviceWorkspaceKey(repo.config.workspace_id, root);
  const label = `dev.openwiki.${workspaceKey}.${kind}`;
  const home = serviceHomeDir();
  const logDir = path.join(home, ".openwiki", "logs");
  const base = `openwiki-${workspaceKey}-${kind}`;
  const locations: AutomationServiceLocations = {
    platform,
    workspace_key: workspaceKey,
    label,
    log_dir: logDir,
    stdout_log: path.join(logDir, `${base}.out.log`),
    stderr_log: path.join(logDir, `${base}.err.log`),
  };
  if (platform === "macos") {
    return { ...locations, plist_path: path.join(home, "Library", "LaunchAgents", `${label}.plist`) };
  }
  if (platform === "linux") {
    const unitDir = path.join(home, ".config", "systemd", "user");
    return {
      ...locations,
      systemd_service_path: path.join(unitDir, `${base}.service`),
      systemd_timer_path: path.join(unitDir, `${base}.timer`),
    };
  }
  return locations;
}

function serviceHomeDir(): string {
  return process.env.OPENWIKI_SERVICE_HOME?.trim() || os.homedir();
}

async function serviceFilesInstalled(locations: AutomationServiceLocations): Promise<boolean> {
  if (locations.plist_path !== undefined) {
    return exists(locations.plist_path);
  }
  if (locations.systemd_service_path !== undefined && locations.systemd_timer_path !== undefined) {
    return (await exists(locations.systemd_service_path)) && (await exists(locations.systemd_timer_path));
  }
  return false;
}

function watchCommandOptions(kind: AutomationKind, options: CliOptions | undefined): string[] {
  if (options === undefined) {
    return [];
  }
  const args: string[] = [];
  if (kind === "sync") {
    if (options.syncPull) {
      args.push("--pull");
    }
    if (options.syncPush) {
      args.push("--push");
    }
    if (options.gitRemote !== undefined) {
      args.push("--remote", options.gitRemote);
    }
    if (options.gitBranch !== undefined) {
      args.push("--branch", options.gitBranch);
    }
  }
  if (kind === "backup") {
    if (options.backupDestination !== undefined) {
      args.push("--destination", options.backupDestination);
    }
    if (options.outDir !== undefined) {
      args.push("--out-dir", options.outDir);
    }
  }
  if (kind === "inbox") {
    if (options.inboxDir !== undefined) {
      args.push("--dir", options.inboxDir);
    }
    if (options.inboxAdapter !== undefined) {
      args.push("--adapter", options.inboxAdapter);
    }
    if (options.provider !== undefined) {
      args.push("--provider", options.provider);
    }
    if (options.sourceType !== undefined) {
      args.push("--source-type", options.sourceType);
    }
    if (options.sectionId !== undefined) {
      args.push("--section", options.sectionId);
    }
    if (options.maxBytes !== undefined) {
      args.push("--max-bytes", String(options.maxBytes));
    }
    if (options.archiveDir !== undefined) {
      args.push("--archive-dir", options.archiveDir);
    }
    if (options.quarantineDir !== undefined) {
      args.push("--quarantine-dir", options.quarantineDir);
    }
  }
  if (options.actor !== undefined) {
    args.push("--actor", options.actor);
  }
  return args;
}

function activationCommandsFor(locations: AutomationServiceLocations): string[] {
  if (locations.platform === "macos" && locations.plist_path !== undefined) {
    const domain = launchdDomain();
    return [
      `launchctl bootstrap ${domain} ${shellQuote(locations.plist_path)}`,
      `launchctl enable ${domain}/${locations.label}`,
    ];
  }
  if (locations.platform === "linux" && locations.systemd_timer_path !== undefined) {
    return [
      `systemctl --user daemon-reload`,
      `systemctl --user enable --now ${shellQuote(path.basename(locations.systemd_timer_path))}`,
    ];
  }
  return [];
}

function deactivationCommandsFor(locations: AutomationServiceLocations): string[] {
  if (locations.platform === "macos" && locations.plist_path !== undefined) {
    return [`launchctl bootout ${launchdDomain()} ${shellQuote(locations.plist_path)}`];
  }
  if (locations.platform === "linux" && locations.systemd_timer_path !== undefined) {
    return [`systemctl --user disable --now ${shellQuote(path.basename(locations.systemd_timer_path))}`];
  }
  return [];
}

function manualActivation(plan: AutomationServicePlan): ServiceActivationResult {
  return {
    status: "manual",
    commands: plan.manual_cron_examples,
  };
}

function manualCronExamples(kind: AutomationKind, _root: string, every: string, command: string[], locations: AutomationServiceLocations): string[] {
  const joined = `${command.map(shellQuote).join(" ")} >> ${shellQuote(locations.stdout_log)} 2>> ${shellQuote(locations.stderr_log)}`;
  const seconds = parseAutomationIntervalSeconds(every);
  const minutes = Math.max(1, Math.floor(seconds / 60));
  if (kind === "backup" && seconds >= 86400) {
    return [`0 3 * * * OPENWIKI_AUTOMATION_SERVICE=1 ${joined}`];
  }
  if (seconds % 60 === 0 && minutes <= 59) {
    return [`*/${minutes} * * * * OPENWIKI_AUTOMATION_SERVICE=1 ${joined}`];
  }
  return [`# Run every ${every}: OPENWIKI_AUTOMATION_SERVICE=1 ${joined}`];
}

function openWikiServiceCommandPrefix(): string[] {
  const override = process.env.OPENWIKI_SERVICE_COMMAND?.trim();
  if (override !== undefined && override !== "") {
    return [override];
  }
  const entry = process.argv[1];
  if (entry !== undefined && entry.endsWith(".ts")) {
    return [process.execPath, "--no-warnings", "--import", "tsx", entry];
  }
  return entry === undefined ? ["openwiki"] : [entry];
}

function serviceWorkspaceKey(workspaceId: string, root: string): string {
  const slug = workspaceId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "workspace";
  const digest = createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 8);
  return `${slug}-${digest}`;
}

function parseAutomationKind(value: string | undefined): AutomationKind {
  if (value === "sync" || value === "backup" || value === "inbox") {
    return value;
  }
  throw new Error(serviceUsage());
}

function detectServicePlatform(): ServicePlatform {
  const override = process.env.OPENWIKI_SERVICE_PLATFORM?.trim();
  if (override === "macos" || override === "linux" || override === "unsupported") {
    return override;
  }
  if (process.platform === "darwin") {
    return "macos";
  }
  if (process.platform === "linux") {
    return "linux";
  }
  return "unsupported";
}

function launchdDomain(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  return uid === undefined ? "gui/$UID" : `gui/${uid}`;
}

function printServiceResult(value: {
  root: string;
  kind: AutomationKind;
  platform: ServicePlatform;
  installed: boolean;
  plan: AutomationServicePlan;
  activation: ServiceActivationResult;
}, options: CliOptions): void {
  if (options.json) {
    printJson(value);
    return;
  }
  console.log(`${value.kind} service ${value.installed ? "installed" : "manual"} (${value.platform})`);
  console.log(`logs ${value.plan.stdout_log}`);
  for (const command of value.activation.commands) {
    console.log(`run: ${command}`);
  }
  if (value.activation.error !== undefined) {
    console.log(`activation ${value.activation.status}: ${value.activation.error}`);
  } else {
    console.log(`activation ${value.activation.status}`);
  }
}

function serviceUsage(): string {
  return [
    "Usage:",
    "  openwiki [--root <path>] service install sync --every 15m [--pull] [--push] [--remote origin] [--branch main] [--json]",
    "  openwiki [--root <path>] service install backup --every 24h [--destination id|--out-dir backups] [--json]",
    "  openwiki [--root <path>] service install inbox --dir <folder> --adapter file [--provider source-name] [--source-type meeting_transcript] --every 5m [--json]",
    "  openwiki [--root <path>] service status [--json]",
    "  openwiki [--root <path>] service uninstall sync|backup|inbox [--json]",
  ].join("\n");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function systemdQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\$/g, "\\$")}"`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
