import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openWikiGitArgs, openWikiGitEnv } from "@openwiki/core";
import { printJson } from "../output.ts";
import { execFileAsync, MIN_NODE_VERSION, OPENWIKI_VERSION } from "../utils.ts";

interface CliBuildMetadata {
  package: string;
  version: string;
  built_at: string;
  node_target: string;
  source: "generated-cli";
  git_commit?: string;
}

interface VersionReport {
  version: string;
  package: "@openwiki/cli";
  node: {
    version: string;
    minimum: string;
    supported: boolean;
  };
  git: {
    available: boolean;
    version?: string;
    error?: string;
  };
  build?: CliBuildMetadata;
  compatibility: {
    warnings: string[];
  };
  latest_command?: string;
  upgrade_command?: string;
}

export async function versionCommand(args: string[], options: { json: boolean }): Promise<void> {
  const short = args.includes("--short");
  const check = args.includes("--check") || args.includes("check");
  const report = await cliVersionReport(check);
  if (short && !options.json) {
    console.log(report.version);
    return;
  }
  if (options.json) {
    printJson(short ? { version: report.version, package: report.package } : report);
    return;
  }
  console.log(`OpenWiki ${report.version}`);
  console.log(`Node ${report.node.version} (minimum ${report.node.minimum})`);
  console.log(report.git.available ? `Git ${report.git.version ?? "available"}` : `Git unavailable: ${report.git.error ?? "unknown error"}`);
  if (report.build !== undefined) {
    console.log(`Build ${report.build.version} (${report.build.git_commit ?? "unknown commit"}, ${report.build.built_at})`);
  }
  for (const warning of report.compatibility.warnings) {
    console.log(`Warning: ${warning}`);
  }
  if (check) {
    console.log(`Check latest: ${report.latest_command}`);
    console.log(`Upgrade: ${report.upgrade_command}`);
  }
}

export async function cliVersionReport(includeUpgradeCommands = false): Promise<VersionReport> {
  const version = await readOpenWikiVersion();
  const nodeSupported = compareSemver(process.versions.node, MIN_NODE_VERSION) >= 0;
  const git = await gitVersionReport();
  const build = await readCliBuildMetadata();
  const warnings = [
    ...(nodeSupported ? [] : [`Node ${process.versions.node} is below the supported minimum ${MIN_NODE_VERSION}.`]),
    ...(git.available ? [] : ["Git was not found on PATH; OpenWiki repositories require Git for canonical storage and sync."]),
  ];
  return {
    version,
    package: "@openwiki/cli",
    node: {
      version: process.versions.node,
      minimum: MIN_NODE_VERSION,
      supported: nodeSupported,
    },
    git,
    ...(build === undefined ? {} : { build }),
    compatibility: { warnings },
    ...(includeUpgradeCommands
      ? {
          latest_command: "npm view @openwiki/cli version",
          upgrade_command: "npm install -g @openwiki/cli@latest",
        }
      : {}),
  };
}

async function readOpenWikiVersion(): Promise<string> {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(moduleDir, "package.json"),
    path.resolve(moduleDir, "../../../package.json"),
    path.resolve(moduleDir, "../../../../package.json"),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(await readFile(candidate, "utf8")) as { version?: unknown };
      if (typeof parsed.version === "string" && parsed.version.trim().length > 0) {
        return parsed.version;
      }
    } catch {
      // Try the next candidate; the bundled package and source checkout differ.
    }
  }
  return OPENWIKI_VERSION;
}

export async function readCliBuildMetadata(): Promise<CliBuildMetadata | undefined> {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  try {
    const parsed = JSON.parse(await readFile(path.join(moduleDir, "build-metadata.json"), "utf8")) as Partial<CliBuildMetadata>;
    if (
      parsed.package === "@openwiki/cli" &&
      typeof parsed.version === "string" &&
      typeof parsed.built_at === "string" &&
      typeof parsed.node_target === "string" &&
      parsed.source === "generated-cli"
    ) {
      return {
        package: parsed.package,
        version: parsed.version,
        built_at: parsed.built_at,
        node_target: parsed.node_target,
        source: parsed.source,
        ...(typeof parsed.git_commit === "string" ? { git_commit: parsed.git_commit } : {}),
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function gitVersionReport(): Promise<VersionReport["git"]> {
  try {
    const { stdout } = await execFileAsync("git", openWikiGitArgs(undefined, ["--version"]), { timeout: 5000, maxBuffer: 1024 * 1024, env: openWikiGitEnv() });
    return { available: true, version: stdout.trim() };
  } catch (error: unknown) {
    return { available: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function compareSemver(actual: string, minimum: string): number {
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
