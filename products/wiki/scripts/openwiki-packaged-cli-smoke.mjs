#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const tarball = process.argv[2] ?? process.env.OPENWIKI_CLI_PACKAGE_TARBALL;

if (!tarball?.trim()) {
  console.error("Usage: node scripts/openwiki-packaged-cli-smoke.mjs <openwiki-cli.tgz>");
  process.exit(1);
}

const temp = await mkdtemp(path.join(os.tmpdir(), "openwiki-packaged-cli-smoke-"));

try {
  const project = path.join(temp, "consumer");
  const wikiRoot = path.join(temp, "packaged-wiki");
  const backupsDir = path.join(temp, "backups");
  const restoreRoot = path.join(temp, "restore-check");
  const integrationDir = path.join(temp, "integration");
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, "package.json"), `${JSON.stringify({ name: "openwiki-package-smoke", version: "0.0.0", private: true }, null, 2)}\n`);
  await execFileAsync("npm", ["install", "--prefix", project, path.resolve(tarball)], { maxBuffer: 1024 * 1024 * 16 });
  const bin = path.join(project, "node_modules", ".bin", "openwiki");

  await run(bin, ["--version"], project);
  const selfCheck = json(await run(bin, ["self-check", "--json"], project));
  assertEqual(selfCheck.status, "pass", "self-check status");
  assertEqual(selfCheck.distribution_mode, "package", "distribution mode");
  for (const check of ["binary", "version", "build-metadata", "license", "web-assets", "integrations", "schemas", "templates", "reference-docs"]) {
    assert(selfCheck.checks?.some((entry) => entry.name === check && entry.status === "pass"), `missing passing self-check ${check}`);
  }

  const setup = json(await run(bin, ["setup", "personal", wikiRoot, "--agent", "none", "--json"], project));
  assertEqual(setup.root, wikiRoot, "setup root");
  assert(Number(setup.search_index?.recordCount ?? 0) > 0, "setup should build a non-empty index");

  await run(bin, ["--root", wikiRoot, "validate"], project);
  await run(bin, ["--root", wikiRoot, "index"], project);
  await run(bin, ["--root", wikiRoot, "db", "rebuild"], project);

  const search = json(await run(bin, ["search", wikiRoot, "personal knowledge", "--json"], project));
  assert(search.results?.some((result) => result.id === "page:concept:personal-knowledge-base"), "search should find personal knowledge base page");

  const mcpInstall = json(await run(bin, ["--root", wikiRoot, "mcp", "install", "generic", "--mode", "proposal", "--output", path.join(temp, "openwiki.mcp.json"), "--json"], project));
  assert(String(mcpInstall.config_path ?? "").endsWith("openwiki.mcp.json"), "mcp install should report the generated config path");

  const staticExport = json(await run(bin, ["--root", wikiRoot, "export", "static", "--out-dir", "public", "--json"], project));
  assert(staticExport.files?.includes("index.html"), "static export should include index.html");
  assert(staticExport.files?.includes("assets/assets-manifest.json"), "static export should include the asset manifest");
  assert(staticExport.files?.some((file) => /^assets\/openwiki\.[a-f0-9]+\.css$/.test(file)), "static export should include hashed CSS");

  const backup = json(await run(bin, ["--root", wikiRoot, "backup", "create", "--out-dir", backupsDir, "--verify", "--json"], project));
  assert(/^openwiki-backup-/.test(String(backup.backup_id ?? "")), "backup id should use openwiki-backup prefix");
  await run(bin, ["--root", wikiRoot, "backup", "restore", "latest", "--out-dir", backupsDir, "--target-root", restoreRoot, "--force"], project);
  await run(bin, ["--root", restoreRoot, "validate"], project);

  const integration = json(await run(bin, ["integrate", "opencode", "--out-dir", integrationDir, "--json"], project));
  for (const expected of [
    ".opencode/agents/openwiki-inbox.md",
    ".opencode/agents/openwiki-meeting-curator.md",
    ".opencode/skills/openwiki-inbox",
    ".opencode/skills/openwiki-transcript-inbox",
    ".opencode/examples/opencode.hosted-http-proposal.json",
    "AGENTS.md",
  ]) {
    assert(integration.files?.includes(expected), `integration should include ${expected}`);
  }

  const tools = await requestMcpTools(bin, wikiRoot);
  assert(tools.some((tool) => tool.name === "wiki.search"), "MCP read mode should expose wiki.search");

  const port = await freePort();
  const server = spawn(bin, ["serve", wikiRoot, "--host", "127.0.0.1", "--port", String(port)], { cwd: project, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await waitForHttpOk(`http://127.0.0.1:${port}/livez`);
    await waitForHttpOk(`http://127.0.0.1:${port}/mcp-manifest.json`);
  } finally {
    server.kill("SIGTERM");
    await waitForProcessExit(server);
  }

  console.log(`Packaged CLI smoke passed for ${path.resolve(tarball)}`);
} finally {
  await rm(temp, { recursive: true, force: true });
}

async function run(bin, args, cwd) {
  const { stdout } = await execFileAsync(bin, args, { cwd, maxBuffer: 1024 * 1024 * 16 });
  return stdout;
}

function json(text) {
  return JSON.parse(text);
}

function assert(value, message) {
  if (!value) {
    throw new Error(message);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

async function requestMcpTools(bin, root) {
  const child = spawn(bin, ["--root", root, "mcp", "--stdio", "--tools", "read"], { stdio: ["pipe", "pipe", "pipe"] });
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
    const line = await readFirstJsonLine(child.stdout);
    return json(line).result?.tools ?? [];
  } finally {
    child.kill("SIGTERM");
    await waitForProcessExit(child);
  }
}

async function readFirstJsonLine(stream) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for MCP response")), 5000);
    stream.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        clearTimeout(timeout);
        resolve(buffer.slice(0, newline));
      }
    });
    stream.on("error", reject);
  });
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  if (address === null || typeof address === "string") {
    throw new Error("Could not allocate a local port");
  }
  return address.port;
}

async function waitForHttpOk(url) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Server is not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function waitForProcessExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Timed out waiting for child process to exit"));
    }, 5000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}
