import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { type PageRecord, type ProposalRecord, assertOpenWikiId, isoNow, openWikiGitArgs, openWikiGitEnv, uniqueStrings } from "@openwiki/core";
import { loadRepository, readPage } from "@openwiki/repo";
import { proposeEdit } from "@openwiki/workflows";

const execFileAsync = promisify(execFile);
const DEFAULT_AGENT_COMMAND_ALLOWLIST = ["opencode", "codex"];
const DEFAULT_AGENT_ENV_ALLOWLIST = ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "USER", "LOGNAME", "SHELL"];
const MAX_AGENT_OUTPUT_BYTES = 1024 * 1024;

interface AgentCommand {
  command: string;
  args?: string[];
  timeoutMs?: number;
  allowedCommands?: string[];
  envAllowlist?: string[];
}

interface MaintainerJobInput {
  root: string;
  task: string;
  targetPageId: string;
  actorId?: string;
  model?: string;
  policy?: Record<string, unknown>;
  agentCommand?: AgentCommand;
}

interface OpenWikiTaskPacket {
  run_id: string;
  actor_id: string;
  workspace_id: string;
  base_commit?: string;
  branch_name: string;
  worktree_path: string;
  task: string;
  target_ids: string[];
  policy_snapshot: string;
  model_snapshot?: string;
  prompt_snapshot: string;
  workspace_mode: "git_worktree" | "copy";
  created_at: string;
}

interface CommandRunResult {
  command: string;
  args: string[];
  exit_code: number | null;
  timed_out: boolean;
  stdout: string;
  stderr: string;
  duration_ms: number;
}

interface MaintainerJobResult {
  run_id: string;
  run_dir: string;
  worktree_path: string;
  task_packet_path: string;
  command?: CommandRunResult;
  changed: boolean;
  proposal?: ProposalRecord;
  result_path: string;
}

export async function createMaintainerJob(input: MaintainerJobInput): Promise<MaintainerJobResult> {
  const repo = await loadRepository(input.root);
  const page = await readPage(repo.root, input.targetPageId);
  const now = isoNow();
  const allocation = await allocateRun(repo.root, now);
  const { runId, runDir, worktreePath, branchName } = allocation;
  const actorId = input.actorId ?? "actor:agent:opencode";
  assertOpenWikiId(actorId, "actor");

  const workspaceMode = await prepareIsolatedWorkspace(repo.root, worktreePath, branchName);

  const taskPacket: OpenWikiTaskPacket = {
    run_id: runId,
    actor_id: actorId,
    workspace_id: repo.config.workspace_id,
    branch_name: branchName,
    worktree_path: worktreePath,
    task: input.task,
    target_ids: [page.id],
    policy_snapshot: sha256(JSON.stringify(input.policy ?? defaultPolicy(), null, 2)),
    prompt_snapshot: sha256(input.task),
    workspace_mode: workspaceMode,
    created_at: now,
  };
  const baseCommit = await currentGitCommit(repo.root);
  if (baseCommit) {
    taskPacket.base_commit = baseCommit;
  }
  if (input.model) {
    taskPacket.model_snapshot = input.model;
  }

  const taskPacketPath = path.join(runDir, "task.json");
  await writeJson(taskPacketPath, taskPacket);
  await fs.mkdir(path.join(worktreePath, ".openwiki"), { recursive: true });
  await writeJson(path.join(worktreePath, ".openwiki", "task.json"), taskPacket);

  const result: MaintainerJobResult = {
    run_id: runId,
    run_dir: runDir,
    worktree_path: worktreePath,
    task_packet_path: taskPacketPath,
    changed: false,
    result_path: path.join(runDir, "result.json"),
  };
  await writeJson(result.result_path, result);
  return result;
}

export async function runMaintainerJob(input: MaintainerJobInput): Promise<MaintainerJobResult> {
  const job = await createMaintainerJob(input);
  let commandResult: CommandRunResult | undefined;
  if (input.agentCommand) {
    commandResult = await runAgentCommand(job.worktree_path, job.task_packet_path, input.agentCommand);
  }

  const original = await readPage(input.root, input.targetPageId);
  const modified = await readPage(job.worktree_path, input.targetPageId);
  const changed = pageChanged(original, modified);
  const result: MaintainerJobResult = {
    ...job,
    ...(commandResult === undefined ? {} : { command: commandResult }),
    changed,
  };

  if (changed) {
    const proposalResult = await proposeEdit({
      root: input.root,
      pageId: input.targetPageId,
      body: modified.body,
      title: modified.title,
      actorId: input.actorId ?? "actor:agent:opencode",
      rationale: `Maintainer job ${job.run_id}: ${input.task}`,
      ...(modified.summary === undefined ? {} : { summary: modified.summary }),
    });
    result.proposal = proposalResult.proposal;
  }

  await writeJson(result.result_path, result);
  return result;
}

async function runAgentCommand(
  cwd: string,
  taskPacketPath: string,
  command: AgentCommand,
): Promise<CommandRunResult> {
  const started = Date.now();
  const timeoutMs = command.timeoutMs ?? 120000;
  validateAgentCommand(command);
  const args = command.args ?? [];
  return new Promise((resolve, reject) => {
    const child = spawn(command.command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: agentCommandEnvironment(cwd, taskPacketPath, command),
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = appendBoundedOutput(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendBoundedOutput(stderr, chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        command: command.command,
        args,
        exit_code: code,
        timed_out: timedOut,
        stdout,
        stderr,
        duration_ms: Date.now() - started,
      });
    });
  });
}

function validateAgentCommand(command: AgentCommand): void {
  const executable = command.command.trim();
  if (!executable) {
    throw new Error("Agent command cannot be empty");
  }
  if (executable.includes("\0")) {
    throw new Error("Agent command contains an unsupported character");
  }
  for (const arg of command.args ?? []) {
    if (arg.includes("\0")) {
      throw new Error("Agent command argument contains an unsupported character");
    }
  }
  if (!agentCommandAllowed(executable, allowedAgentCommands(command))) {
    throw new Error(`Agent command '${path.basename(executable)}' is not allowlisted`);
  }
}

function allowedAgentCommands(command: AgentCommand): string[] {
  const configured = command.allowedCommands ?? commaSeparatedEnv("OPENWIKI_AGENT_COMMAND_ALLOWLIST");
  return configured.length > 0 ? configured : DEFAULT_AGENT_COMMAND_ALLOWLIST;
}

function agentCommandAllowed(executable: string, allowedCommands: string[]): boolean {
  const executableHasPath = executable.includes("/") || executable.includes("\\");
  return allowedCommands.some((allowed) => {
    const normalized = allowed.trim();
    if (!normalized) {
      return false;
    }
    const allowedHasPath = normalized.includes("/") || normalized.includes("\\");
    if (executableHasPath || allowedHasPath) {
      return path.resolve(executable) === path.resolve(normalized);
    }
    return executable === normalized;
  });
}

function agentCommandEnvironment(cwd: string, taskPacketPath: string, command: AgentCommand): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of allowedAgentEnvNames(command)) {
    const value = process.env[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  env.OPENWIKI_TASK_PACKET = taskPacketPath;
  env.OPENWIKI_WORKTREE = cwd;
  return env;
}

function allowedAgentEnvNames(command: AgentCommand): string[] {
  const configured = command.envAllowlist ?? commaSeparatedEnv("OPENWIKI_AGENT_ENV_ALLOWLIST");
  return configured.length > 0 ? uniqueStrings([...DEFAULT_AGENT_ENV_ALLOWLIST, ...configured]) : DEFAULT_AGENT_ENV_ALLOWLIST;
}

function commaSeparatedEnv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function appendBoundedOutput(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  if (Buffer.byteLength(next, "utf8") <= MAX_AGENT_OUTPUT_BYTES) {
    return next;
  }
  return next.slice(0, MAX_AGENT_OUTPUT_BYTES) + "\n[output truncated]\n";
}

async function prepareIsolatedWorkspace(root: string, destination: string, branchName: string): Promise<OpenWikiTaskPacket["workspace_mode"]> {
  await fs.rm(destination, { recursive: true, force: true });
  if (await isGitRepo(root)) {
    try {
      await execFileAsync("git", gitArgs(root, ["worktree", "prune"]), { env: openWikiGitEnv() });
      await execFileAsync("git", gitArgs(root, ["worktree", "add", "-B", branchName, destination, "HEAD"]), { env: openWikiGitEnv() });
      return "git_worktree";
    } catch {
      await fs.rm(destination, { recursive: true, force: true });
    }
  }
  await copyWorkspace(root, destination);
  return "copy";
}

async function copyWorkspace(root: string, destination: string): Promise<void> {
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.mkdir(destination, { recursive: true });
  const ignored = new Set([".git", ".openwiki", "node_modules", "dist", "coverage", "public"]);
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (ignored.has(entry.name)) {
      continue;
    }
    await copyWorkspaceEntry(path.join(root, entry.name), path.join(destination, entry.name), ignored);
  }
}

async function copyWorkspaceEntry(source: string, destination: string, ignored: Set<string>): Promise<void> {
  const stats = await fs.lstat(source);
  if (stats.isSymbolicLink()) {
    throw new Error(`Maintainer workspace copy refuses symlink: ${source}`);
  }
  if (stats.isDirectory()) {
    await fs.mkdir(destination, { recursive: true });
    const entries = await fs.readdir(source, { withFileTypes: true });
    for (const entry of entries) {
      if (ignored.has(entry.name)) {
        continue;
      }
      await copyWorkspaceEntry(path.join(source, entry.name), path.join(destination, entry.name), ignored);
    }
    return;
  }
  if (stats.isFile()) {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
  }
}

async function allocateRun(root: string, iso: string): Promise<{
  runId: string;
  runDir: string;
  worktreePath: string;
  branchName: string;
}> {
  const runsRoot = path.join(root, ".openwiki", "runs");
  await fs.mkdir(runsRoot, { recursive: true });
  for (let sequence = 1; sequence <= 999999; sequence += 1) {
    const runId = `run:${iso.slice(0, 10)}-${String(sequence).padStart(3, "0")}`;
    const runStem = idStem(runId);
    const runDir = path.join(runsRoot, runStem);
    try {
      await fs.mkdir(runDir);
      return {
        runId,
        runDir,
        worktreePath: path.join(root, ".openwiki", "worktrees", runStem),
        branchName: `openwiki/${runStem}`,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        continue;
      }
      throw error;
    }
  }
  throw new Error(`Unable to allocate OpenWiki maintainer run for ${iso.slice(0, 10)}`);
}

function pageChanged(left: PageRecord, right: PageRecord): boolean {
  return (
    left.title !== right.title ||
    (left.summary ?? "") !== (right.summary ?? "") ||
    left.body !== right.body ||
    left.status !== right.status ||
    left.topics.join("\n") !== right.topics.join("\n") ||
    left.source_ids.join("\n") !== right.source_ids.join("\n") ||
    left.claim_ids.join("\n") !== right.claim_ids.join("\n")
  );
}

async function isGitRepo(root: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", gitArgs(root, ["rev-parse", "--is-inside-work-tree"]), { env: openWikiGitEnv() });
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

async function currentGitCommit(root: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", gitArgs(root, ["rev-parse", "--short", "HEAD"]), { env: openWikiGitEnv() });
    const commit = stdout.trim();
    return commit || undefined;
  } catch {
    return undefined;
  }
}

function gitArgs(root: string, args: string[]): string[] {
  return openWikiGitArgs(root, args);
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function idStem(id: string): string {
  return id.replace(/:/g, "_").replace(/-/g, "_");
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function defaultPolicy(): Record<string, unknown> {
  return {
    mode: "proposal_only",
    allowed_paths: ["wiki/**", "sources/**", "claims/**"],
    denied_paths: [".git/**", ".openwiki/**", "node_modules/**"],
    writes_require_review: true,
  };
}
