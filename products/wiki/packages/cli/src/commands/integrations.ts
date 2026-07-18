import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeAgentInstallProfile, resolveAgentProvider, type AgentProviderInstallProfile } from "../agent-providers.ts";
import { exists } from "../utils.ts";

type OpenCodeInstallScope = "project" | "global";

interface IntegrateOpenCodeOptions {
  profile?: string | undefined;
  installScope?: OpenCodeInstallScope | undefined;
  wikiRoot?: string | undefined;
}

interface IntegrateOpenCodeResult {
  provider: "opencode";
  target: string;
  profile: AgentProviderInstallProfile;
  install_scope: OpenCodeInstallScope;
  files: string[];
  notes: string[];
}

interface OpenCodePackConfig {
  $schema?: string;
  mcp?: unknown;
  skills?: {
    paths?: string[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

const OPENCODE_FULL_PROFILE_ENTRIES = [
  "agents/openwiki-editor.md",
  "agents/openwiki-inbox.md",
  "agents/openwiki-inbox-operator.md",
  "agents/openwiki-meeting-curator.md",
  "agents/openwiki-monitor.md",
  "agents/openwiki-researcher.md",
  "agents/openwiki-reviewer.md",
  "skills/openwiki-edit",
  "skills/openwiki-proposal-drafting",
  "skills/openwiki-policy-safe-editing",
  "skills/openwiki-dream-review",
  "skills/openwiki-inbox",
  "skills/openwiki-meeting-curation",
  "skills/openwiki-operator",
  "skills/openwiki-research",
  "skills/openwiki-transcript-inbox",
  "plugins/openwiki_guardrails.ts",
  "examples/opencode.gateway-dream.yaml",
  "examples/opencode.hosted-http-proposal.json",
  "examples/opencode.local-proposal.json",
] as const;

const OPENCODE_PROFILE_ENTRIES: Record<AgentProviderInstallProfile, readonly string[]> = {
  "personal-curator": OPENCODE_FULL_PROFILE_ENTRIES,
  researcher: [
    "agents/openwiki-monitor.md",
    "agents/openwiki-researcher.md",
    "skills/openwiki-operator",
    "skills/openwiki-research",
    "skills/openwiki-dream-review",
    "plugins/openwiki_guardrails.ts",
  ],
  reviewer: [
    "agents/openwiki-monitor.md",
    "agents/openwiki-reviewer.md",
    "skills/openwiki-edit",
    "skills/openwiki-policy-safe-editing",
    "skills/openwiki-dream-review",
    "skills/openwiki-operator",
    "plugins/openwiki_guardrails.ts",
  ],
  maintainer: OPENCODE_FULL_PROFILE_ENTRIES,
  "wiki-curator": OPENCODE_FULL_PROFILE_ENTRIES,
  developer: OPENCODE_FULL_PROFILE_ENTRIES,
  global: OPENCODE_FULL_PROFILE_ENTRIES,
};

export async function integrateOpenCode(targetRoot?: string, options: IntegrateOpenCodeOptions = {}): Promise<IntegrateOpenCodeResult> {
  const provider = resolveAgentProvider("opencode");
  const profile = normalizeAgentInstallProfile(provider, options.profile, "wiki-curator");
  const installScope = options.installScope ?? (profile === "global" ? "global" : "project");
  const target = path.resolve(installScope === "global" ? targetRoot ?? path.join(os.homedir(), ".config", "opencode") : targetRoot ?? ".");
  const source = await resolveOpenCodeIntegrationSource();
  await assertDirectory(source, "OpenCode integration pack");
  await mkdir(target, { recursive: true });

  const files: string[] = [];
  const notes: string[] = [];
  const opencodeRoot = installScope === "global" ? target : path.join(target, ".opencode");

  const entries = OPENCODE_PROFILE_ENTRIES[profile];
  for (const entry of entries) {
    await cp(path.join(source, entry), path.join(opencodeRoot, entry), {
      recursive: true,
      force: false,
      errorOnExist: false,
    });
    files.push(installScope === "global" ? entry : `.opencode/${entry}`);
  }

  const configPath = path.join(target, "opencode.json");
  const configExists = await exists(configPath);
  const configTarget = configExists ? path.join(target, "opencode.openwiki.json") : configPath;
  const config = await openCodeConfigForScope(path.join(source, "opencode.json"), installScope, options.wikiRoot);
  await writeFile(configTarget, JSON.stringify(config, null, 2) + "\n");
  files.push(relativeFileName(target, configTarget));
  if (configExists) {
    notes.push("Existing opencode.json was left untouched; OpenWiki config was written to opencode.openwiki.json.");
  }
  if (options.wikiRoot === undefined) {
    notes.push("No wiki root was bound into the generated MCP config; run openwiki --root <wiki> agent configure or reinstall with --wiki-root <wiki> before using OpenWiki MCP from another project.");
  }

  if (installScope === "project") {
    const sourceRules = await readFile(path.join(source, "AGENTS.md"), "utf8");
    const agentsPath = path.join(target, "AGENTS.md");
    const nextRules = await mergeMarkedSection(
      agentsPath,
      "OPENWIKI OPENCODE INTEGRATION",
      sourceRules.trim(),
    );
    await writeFile(agentsPath, nextRules);
    files.push("AGENTS.md");
  } else {
    notes.push("Global OpenCode install skipped project AGENTS.md rules; keep wiki-specific rules in each wiki repository.");
  }

  return { provider: "opencode", target, profile, install_scope: installScope, files, notes };
}

async function resolveOpenCodeIntegrationSource(): Promise<string> {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(moduleDir, "integrations", "opencode"),
    path.resolve(moduleDir, "../../../../integrations/opencode"),
    path.resolve(moduleDir, "../../../integrations/opencode"),
  ];
  for (const candidate of candidates) {
    const stats = await stat(candidate).catch(() => undefined);
    if (stats?.isDirectory()) {
      return candidate;
    }
  }
  return candidates[0] ?? path.resolve("integrations/opencode");
}

async function mergeMarkedSection(filePath: string, label: string, content: string): Promise<string> {
  const start = `<!-- BEGIN ${label} -->`;
  const end = `<!-- END ${label} -->`;
  const block = `${start}\n${content}\n${end}`;
  const current = (await exists(filePath)) ? await readFile(filePath, "utf8") : "";
  if (current.includes(start) && current.includes(end)) {
    const before = current.slice(0, current.indexOf(start)).trimEnd();
    const after = current.slice(current.indexOf(end) + end.length).trimStart();
    return [before, block, after].filter(Boolean).join("\n\n").concat("\n");
  }
  return [current.trimEnd(), block].filter(Boolean).join("\n\n").concat("\n");
}

async function assertDirectory(directory: string, label: string): Promise<void> {
  const stats = await stat(directory).catch(() => undefined);
  if (!stats?.isDirectory()) {
    throw new Error(`${label} not found at ${directory}`);
  }
}

function relativeFileName(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join("/");
}

async function openCodeConfigForScope(configPath: string, installScope: OpenCodeInstallScope, wikiRoot?: string): Promise<OpenCodePackConfig> {
  const config = JSON.parse(await readFile(configPath, "utf8")) as OpenCodePackConfig;
  const skills = config.skills ?? {};
  const mcp = wikiRoot === undefined ? undefined : bindOpenWikiMcpRoot(config.mcp, wikiRoot);
  return {
    ...config,
    ...(mcp === undefined ? { mcp: undefined } : { mcp }),
    skills: {
      ...skills,
      paths: [installScope === "global" ? "./skills" : ".opencode/skills"],
    },
  };
}

function bindOpenWikiMcpRoot(mcp: unknown, wikiRoot: string): unknown {
  if (!mcp || typeof mcp !== "object") {
    return mcp;
  }
  const next = structuredClone(mcp) as Record<string, unknown>;
  const openwiki = next.openwiki;
  if (!openwiki || typeof openwiki !== "object" || !Array.isArray((openwiki as { command?: unknown }).command)) {
    return next;
  }
  const command = (openwiki as { command: unknown[] }).command.map(String);
  const withoutRoot = command.filter((value, index) => value !== "--root" && command[index - 1] !== "--root");
  (openwiki as { command: string[] }).command = [withoutRoot[0] ?? "openwiki", "--root", path.resolve(wikiRoot), ...withoutRoot.slice(1)];
  return next;
}
