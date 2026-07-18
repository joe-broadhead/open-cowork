#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { routeHttpRequest, startHttpApi } from "@openwiki/http-api";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = [process.execPath, ["--no-warnings", "--import", "tsx", path.join(REPO_ROOT, "packages", "cli", "src", "main.ts")]];

const [mode = "all"] = process.argv.slice(2).filter((arg) => arg !== "--");

try {
  if (mode === "all") {
    await smokeLocalPersonal();
    await smokeStaticExport();
    await smokeSecurityBasics();
  } else if (mode === "local-personal") {
    await smokeLocalPersonal();
  } else if (mode === "local-personal-missing-readiness") {
    await smokeLocalPersonalMissingReadiness();
  } else if (mode === "static-export") {
    await smokeStaticExport();
  } else if (mode === "security-basics") {
    await smokeSecurityBasics();
  } else {
    throw new Error(`Unknown release smoke mode '${mode}'`);
  }
  console.log(`OpenWiki release smoke '${mode}' passed`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}

async function smokeLocalPersonal() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openwiki-release-local-"));
  const root = path.join(tempRoot, "personal-wiki");
  try {
    await runCli(["init", root, "--template", "personal-wiki", "--title", "Release Personal Wiki", "--json"]);
    await runCli(["--root", root, "index", "--json"]);
    await runCli(["--root", root, "db", "rebuild", "--json"]);
    await runCli(["--root", root, "deploy", "preflight", "--deploy-profile", "local-personal", "--json"]);
    await assertReady(root);
    await assertMcpStdio(root);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function smokeLocalPersonalMissingReadiness() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openwiki-release-missing-readiness-"));
  const root = path.join(tempRoot, "personal-wiki");
  try {
    await runCli(["init", root, "--template", "personal-wiki", "--title", "Missing Readiness Stores", "--json"]);
    const readiness = await routeHttpRequest(root, "GET", "/readyz");
    if (readiness.body?.status !== "ready") {
      throw new Error("Readiness stores missing: run openwiki index and openwiki db rebuild before release validation");
    }
    throw new Error("Expected missing readiness stores to make /readyz fail");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function smokeStaticExport() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openwiki-release-static-"));
  const root = path.join(tempRoot, "static-wiki");
  try {
    await runCli(["init", root, "--template", "basic", "--title", "Release Static Wiki", "--json"]);
    await installPrivateStaticFixture(root);
    await runCli(["--root", root, "index", "--json"]);
    await runCli(["--root", root, "db", "rebuild", "--json"]);
    const exportResult = JSON.parse(await runCli(["--root", root, "export", "static", "--out-dir", "public", "--base-url", "https://wiki.example.com", "--json"]));
    await runCli([
      "--root",
      root,
      "deploy",
      "preflight",
      "--deploy-profile",
      "public-static",
      "--public-origin",
      "https://wiki.example.com",
      "--out-dir",
      "public",
      "--json",
    ]);
    for (const artifact of ["index.html", "search-index.json", "search-records.jsonl", "pages.jsonl", "graph-report.json", "agents/index.md", "openapi.json", "mcp-manifest.json", "llms.txt", "static-export-report.json"]) {
      assert.ok(exportResult.files.includes(artifact), `missing static artifact ${artifact}`);
    }
    const html = await readFile(path.join(exportResult.outDir, "index.html"), "utf8");
    assert.match(html, /Release Static Wiki|Agent Memory/);
    const searchIndex = await readFile(path.join(exportResult.outDir, "search-index.json"), "utf8");
    const pages = await readFile(path.join(exportResult.outDir, "pages.jsonl"), "utf8");
    assert.doesNotMatch(searchIndex, /Private Release Secret|page:private:release-secret/);
    assert.doesNotMatch(pages, /Private Release Secret|page:private:release-secret/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function smokeSecurityBasics() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openwiki-release-security-"));
  const root = path.join(tempRoot, "security-wiki");
  const previousCors = process.env.OPENWIKI_CORS_ORIGIN;
  const previousTrustedSecret = process.env.OPENWIKI_TRUST_AUTH_HEADERS_SECRET;
  try {
    delete process.env.OPENWIKI_CORS_ORIGIN;
    delete process.env.OPENWIKI_TRUST_AUTH_HEADERS_SECRET;
    await runCli(["init", root, "--template", "personal-wiki", "--title", "Release Security Wiki", "--json"]);
    await runCli(["--root", root, "index", "--json"]);
    await runCli(["--root", root, "db", "rebuild", "--json"]);

    const server = await startHttpApi({ root, port: 0 });
    try {
      const response = await fetch(`${server.url}/api/v1/capabilities`);
      assert.notEqual(response.headers.get("access-control-allow-origin"), "*");
    } finally {
      await closeServer(server.server);
    }

    await assertCliFails(["--root", root, "serve", "--port", "0", "--trust-headers"], /Trusted auth headers require/);

    const created = JSON.parse(await runCli(["--root", root, "auth", "token", "create", "service:release-smoke", "--profile", "hosted-readonly-agent", "--json"]));
    const tokenValue = created.token?.value;
    assert.equal(typeof tokenValue, "string");
    const config = await readFile(path.join(root, "openwiki.json"), "utf8");
    assert.doesNotMatch(config, new RegExp(escapeRegExp(tokenValue)));
    assert.match(config, /token_hash/);
    const listed = await runCli(["--root", root, "auth", "token", "list", "service:release-smoke", "--json"]);
    assert.doesNotMatch(listed, new RegExp(escapeRegExp(tokenValue)));
  } finally {
    restoreEnv("OPENWIKI_CORS_ORIGIN", previousCors);
    restoreEnv("OPENWIKI_TRUST_AUTH_HEADERS_SECRET", previousTrustedSecret);
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function installPrivateStaticFixture(root) {
  await mkdir(path.join(root, "wiki", "private"), { recursive: true });
  await writeFile(
    path.join(root, "wiki", "private", "release-secret.md"),
    [
      "---",
      "id: page:private:release-secret",
      "title: Private Release Secret",
      "page_type: concept",
      "summary: Private release validation content.",
      "sensitivity: private",
      "topics:",
      "  - release",
      "source_ids: []",
      "claim_ids: []",
      "---",
      "",
      "# Private Release Secret",
      "",
      "This non-public content must not appear in static export artifacts.",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(root, "policy", "sections.json"),
    JSON.stringify(
      [
        {
          id: "section:public-release",
          title: "Public Release Content",
          paths: ["wiki/concepts/**", "sources/**", "claims/**"],
          visibility: "public",
        },
        {
          id: "section:private-release",
          title: "Private Release Content",
          paths: ["wiki/private/**"],
          visibility: "private",
        },
      ],
      null,
      2,
    ) + "\n",
    "utf8",
  );
  await writeFile(
    path.join(root, "policy", "grants.json"),
    JSON.stringify(
      [
        {
          principal: "group:all-users",
          section: "section:public-release",
          role: "viewer",
        },
      ],
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

async function assertReady(root) {
  const readiness = await routeHttpRequest(root, "GET", "/readyz");
  assert.equal(readiness.status, 200);
  assert.equal(readiness.body?.status, "ready");
}

async function assertMcpStdio(root) {
  const child = spawn(CLI[0], [...CLI[1], "--root", root, "mcp", "--stdio", "--tools", "read"], {
    cwd: REPO_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  try {
    const responses = readJsonLines(child.stdout);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: "tools", method: "tools/list" })}\n`);
    const response = await waitForJsonRpcResponse(responses, "tools", 5000);
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    const tools = response.result?.tools;
    assert.ok(Array.isArray(tools), "MCP tools/list did not return tools");
    assert.ok(tools.some((tool) => tool.name === "wiki.search"), "MCP stdio did not expose wiki.search");
  } finally {
    child.stdin.end();
    child.kill("SIGTERM");
    await waitForExit(child).catch(() => undefined);
  }
  assert.equal(stderr.join("").trim(), "");
}

async function runCli(args) {
  const result = await runProcess(CLI[0], [...CLI[1], ...args]);
  return result.stdout;
}

async function assertCliFails(args, pattern) {
  try {
    await runCli(args);
  } catch (error) {
    const output = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
    assert.match(output, pattern);
    return;
  }
  throw new Error(`Expected CLI command to fail: ${args.join(" ")}`);
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { code, stdout: stdout.join(""), stderr: stderr.join("") };
      if (code === 0) {
        resolve(result);
      } else {
        reject(Object.assign(new Error(`Command failed: ${command} ${args.join(" ")}`), result));
      }
    });
  });
}

async function* readJsonLines(stream) {
  stream.setEncoding("utf8");
  let buffer = "";
  for await (const chunk of stream) {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        yield JSON.parse(line);
      }
    }
  }
}

async function waitForJsonRpcResponse(responses, id, timeoutMs) {
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Timed out waiting for MCP response '${id}'`)), timeoutMs);
  });
  const nextResponse = (async () => {
    for await (const response of responses) {
      if (response.id === id) {
        return response;
      }
    }
    throw new Error(`MCP server exited before response '${id}'`);
  })();
  return Promise.race([nextResponse, timeout]);
}

function waitForExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("close", () => resolve());
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
