#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const options = parseArgs(process.argv.slice(2));
const json = options.json === true;
const execute = options.execute === true;
const dryRun = !execute;
const sourceDatabaseUrl = stringOption(options, "database-url") ?? process.env.OPENWIKI_DATABASE_URL ?? process.env.DATABASE_URL;
const restoreDatabaseUrl = stringOption(options, "restore-database-url") ?? process.env.OPENWIKI_RESTORE_DATABASE_URL;
const workspaceRoot = path.resolve(stringOption(options, "workspace-root") ?? process.env.OPENWIKI_ROOT ?? "/data/wiki");
const outDir = path.resolve(stringOption(options, "out-dir") ?? path.join(repoRoot, "artifacts"));
const backupFile = path.resolve(stringOption(options, "backup-file") ?? path.join(outDir, "openwiki-postgres-restore-drill.dump"));
const artifactPath = path.resolve(stringOption(options, "artifact") ?? path.join(outDir, "openwiki-postgres-restore-drill.json"));

try {
  const result = await buildAndMaybeRunPlan();
  await writeResult(result);
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Postgres restore drill ${result.status}. Wrote ${path.relative(repoRoot, artifactPath)}`);
  }
  process.exitCode = result.status === "failed" ? 1 : 0;
} catch (error) {
  const result = failureResult(error);
  await writeResult(result).catch(() => undefined);
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.error(result.error);
    console.error(`Wrote ${path.relative(repoRoot, artifactPath)}`);
  }
  process.exitCode = 1;
}

async function buildAndMaybeRunPlan() {
  if (sourceDatabaseUrl === undefined || sourceDatabaseUrl.trim() === "") {
    throw new Error("Postgres restore drill requires --database-url or OPENWIKI_DATABASE_URL");
  }
  if (!dryRun && (restoreDatabaseUrl === undefined || restoreDatabaseUrl.trim() === "")) {
    throw new Error("Executing a Postgres restore drill requires --restore-database-url or OPENWIKI_RESTORE_DATABASE_URL");
  }
  if (restoreDatabaseUrl !== undefined && sameDatabaseUrl(sourceDatabaseUrl, restoreDatabaseUrl)) {
    throw new Error("Refusing to use the same Postgres URL for source and restore target");
  }

  const sourceUrl = sourceDatabaseUrl;
  const targetUrl = restoreDatabaseUrl ?? "postgres://restore-target.example/openwiki_restore";
  const commands = [
    {
      name: "dump",
      argv: ["pg_dump", "--format=custom", "--file", backupFile, sourceUrl],
      redacted_argv: ["pg_dump", "--format=custom", "--file", backupFile, redactDatabaseUrl(sourceUrl)],
    },
    {
      name: "restore",
      argv: ["pg_restore", "--clean", "--if-exists", "--no-owner", "--dbname", targetUrl, backupFile],
      redacted_argv: ["pg_restore", "--clean", "--if-exists", "--no-owner", "--dbname", redactDatabaseUrl(targetUrl), backupFile],
    },
    {
      name: "migrate",
      argv: openwikiArgs(["--root", workspaceRoot, "db", "migrate"]),
      redacted_argv: openwikiArgs(["--root", workspaceRoot, "db", "migrate"]),
      env: { OPENWIKI_DATABASE_URL: redactDatabaseUrl(targetUrl), DATABASE_URL: redactDatabaseUrl(targetUrl) },
    },
    {
      name: "sync_postgres",
      argv: openwikiArgs(["--root", workspaceRoot, "db", "sync-postgres", "--full", "--json"]),
      redacted_argv: openwikiArgs(["--root", workspaceRoot, "db", "sync-postgres", "--full", "--json"]),
      env: { OPENWIKI_DATABASE_URL: redactDatabaseUrl(targetUrl), DATABASE_URL: redactDatabaseUrl(targetUrl) },
    },
    {
      name: "check",
      argv: openwikiArgs(["--root", workspaceRoot, "db", "check", "--json"]),
      redacted_argv: openwikiArgs(["--root", workspaceRoot, "db", "check", "--json"]),
      env: { OPENWIKI_DATABASE_URL: redactDatabaseUrl(targetUrl), DATABASE_URL: redactDatabaseUrl(targetUrl) },
    },
  ];

  const base = {
    schema_version: "openwiki-postgres-restore-drill-v1",
    generated_at: new Date().toISOString(),
    mode: dryRun ? "dry_run" : "execute",
    status: dryRun ? "planned" : "running",
    source_database_url: redactDatabaseUrl(sourceUrl),
    restore_database_url: redactDatabaseUrl(targetUrl),
    workspace_root: workspaceRoot,
    backup_file: backupFile,
    commands: commands.map(({ name, redacted_argv, env }) => ({
      name,
      command: redacted_argv.join(" "),
      ...(env === undefined ? {} : { env }),
    })),
    safety: {
      requires_distinct_source_and_restore_database: true,
      execute_requires_explicit_flag: true,
      raw_database_urls_redacted: true,
    },
  };

  if (dryRun) {
    return base;
  }

  await fs.mkdir(path.dirname(backupFile), { recursive: true });
  const executed = [];
  for (const command of commands) {
    const [name, ...args] = command.argv;
    if (name === undefined) {
      throw new Error(`Invalid command plan for ${command.name}`);
    }
    const env = command.env === undefined
      ? process.env
      : { ...process.env, OPENWIKI_DATABASE_URL: targetUrl, DATABASE_URL: targetUrl };
    const { stdout, stderr } = await execFile(name, args, {
      cwd: repoRoot,
      env,
      timeout: command.name === "dump" || command.name === "restore" ? 300_000 : 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    executed.push({
      name: command.name,
      stdout_tail: tail(stdout),
      stderr_tail: tail(stderr),
    });
  }

  return { ...base, status: "passed", executed };
}

function failureResult(error) {
  return {
    schema_version: "openwiki-postgres-restore-drill-v1",
    generated_at: new Date().toISOString(),
    mode: dryRun ? "dry_run" : "execute",
    status: "failed",
    source_database_url: sourceDatabaseUrl === undefined ? undefined : redactDatabaseUrl(sourceDatabaseUrl),
    restore_database_url: restoreDatabaseUrl === undefined ? undefined : redactDatabaseUrl(restoreDatabaseUrl),
    workspace_root: workspaceRoot,
    backup_file: backupFile,
    error: error instanceof Error ? error.message : String(error),
    safety: {
      requires_distinct_source_and_restore_database: true,
      execute_requires_explicit_flag: true,
      raw_database_urls_redacted: true,
    },
  };
}

async function writeResult(result) {
  await fs.mkdir(path.dirname(artifactPath), { recursive: true });
  await fs.writeFile(artifactPath, `${JSON.stringify(result, null, 2)}\n`);
}

function openwikiArgs(args) {
  return [process.execPath, "--no-warnings", "--import", "tsx", path.join(repoRoot, "packages", "cli", "src", "main.ts"), ...args];
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--") {
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected positional argument '${arg}'`);
    }
    const key = arg.slice(2);
    if (key === "json" || key === "dry-run" || key === "execute") {
      parsed[key] = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    parsed[key] = value;
    index += 1;
  }
  if (parsed["dry-run"] === true && parsed.execute === true) {
    throw new Error("Use either --dry-run or --execute, not both");
  }
  return parsed;
}

function stringOption(options, key) {
  const value = options[key];
  return typeof value === "string" ? value : undefined;
}

function sameDatabaseUrl(left, right) {
  return normalizeDatabaseUrl(left) === normalizeDatabaseUrl(right);
}

function normalizeDatabaseUrl(value) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return value;
  }
}

function redactDatabaseUrl(value) {
  try {
    const url = new URL(value);
    if (url.username !== "") {
      url.username = "redacted-user";
    }
    if (url.password !== "") {
      url.password = "redacted-password";
    }
    return url.toString();
  } catch {
    return "<redacted>";
  }
}

function tail(value) {
  const text = value.trim();
  return text.length <= 4000 ? text : text.slice(-4000);
}
