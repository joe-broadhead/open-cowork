#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { routeHttpRequest, startHttpApi } from "@openwiki/http-api";
import { handleMcpRequest } from "@openwiki/mcp-server";
import { scopesForRole } from "@openwiki/policy";
import { loadRepository } from "@openwiki/repo";
import { restoreWorkspaceBackup, runGovernanceDetectors } from "@openwiki/workflows";
import { ENTERPRISE_DEMO_SENTINELS, generateEnterpriseDemoWiki } from "./openwiki-enterprise-demo.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESULT_DIR = path.join(REPO_ROOT, "evals", "enterprise-demo");
const RESULT_PATH = path.join(RESULT_DIR, "latest.json");

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openwiki-enterprise-demo-eval-"));
  const root = path.resolve(options.root ?? path.join(tempRoot, "wiki"));
  const checks = [];
  let server;
  try {
    const generated = await generateEnterpriseDemoWiki({
      root,
      force: true,
      withDerived: true,
      withStatic: true,
      withBackup: true,
      baseUrl: "https://example.com/openwiki-enterprise-demo",
    });

    await assertCorpusShape(root, generated);
    checks.push("corpus shape");

    await assertGovernanceFixtures(root);
    checks.push("governance fixtures");

    await assertPermissions(root);
    checks.push("search and read permission filtering");

    await assertMcpAgentModes(root, generated);
    checks.push("MCP read and proposal agent workflows");

    server = await startHttpApi({ root, port: 0, defaultPolicy: { role: "admin" } });
    await assertUiSmoke(server.url);
    checks.push("server UI smoke");

    await assertStaticExportFiltering(generated);
    checks.push("static export private filtering");

    await assertBackupRestore(tempRoot, generated);
    checks.push("backup and restore smoke");

    const report = {
      eval: "openwiki-enterprise-demo",
      status: "pass",
      generated_at: new Date().toISOString(),
      root,
      checks,
      generated,
    };
    await mkdir(RESULT_DIR, { recursive: true });
    await writeFile(RESULT_PATH, JSON.stringify(report, null, 2) + "\n");
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`OpenWiki enterprise demo eval passed (${checks.length} checks).`);
      console.log(`Wrote ${path.relative(REPO_ROOT, RESULT_PATH)}`);
    }
  } catch (error) {
    const report = {
      eval: "openwiki-enterprise-demo",
      status: "fail",
      generated_at: new Date().toISOString(),
      root,
      checks,
      error: error instanceof Error ? error.message : String(error),
    };
    await mkdir(RESULT_DIR, { recursive: true });
    await writeFile(RESULT_PATH, JSON.stringify(report, null, 2) + "\n");
    throw error;
  } finally {
    if (server !== undefined) {
      await new Promise((resolve, reject) => server.server.close((error) => (error ? reject(error) : resolve())));
    }
    if (!options.keep) {
      await rm(tempRoot, { recursive: true, force: true });
    } else {
      console.error(`Kept enterprise demo eval workspace: ${tempRoot}`);
    }
  }
}

async function assertCorpusShape(root, generated) {
  const repo = await loadRepository(root);
  assert.equal(repo.pages.length >= 9, true, "enterprise corpus should contain multiple team pages");
  assert.equal(repo.sources.length >= 9, true, "enterprise corpus should contain source manifests");
  assert.equal(repo.claims.length >= 9, true, "enterprise corpus should contain claim records");
  assert.equal(repo.proposals.length >= 3, true, "enterprise corpus should seed proposals");
  assert.equal(repo.decisions.length >= 1, true, "enterprise corpus should seed decisions");
  assert.equal(repo.events.length >= 1, true, "enterprise corpus should seed events");
  assert.equal(repo.runs.length >= 1, true, "enterprise corpus should seed runs");
  assert.deepEqual(new Set(generated.page_ids).size, generated.page_ids.length);
}

async function assertGovernanceFixtures(root) {
  const report = await runGovernanceDetectors({
    root,
    detectors: ["stale_claim", "missing_source", "broken_link", "orphan_page"],
    staleAfterDays: 30,
  });
  assert.equal(report.status, "attention");
  for (const detector of ["stale_claim", "missing_source", "broken_link", "orphan_page"]) {
    assert.ok(report.findings.some((finding) => finding.detector === detector), `missing governance detector fixture ${detector}`);
  }
}

async function assertPermissions(root) {
  const publicPolicy = {
    actorId: "actor:agent:public-demo-reader",
    role: "viewer",
    scopes: scopesForRole("viewer"),
    principals: ["group:all-users"],
  };
  const financePolicy = {
    actorId: "actor:user:finance-demo",
    role: "maintainer",
    scopes: scopesForRole("maintainer"),
    principals: ["group:finance"],
  };

  const publicSearch = await routeHttpRequest(
    root,
    "GET",
    `/api/v1/search?q=${encodeURIComponent(ENTERPRISE_DEMO_SENTINELS.public)}&type=page&limit=10`,
    undefined,
    publicPolicy,
  );
  assert.equal(publicSearch.status, 200);
  assert.ok(JSON.stringify(publicSearch.body).includes("page:public:company-handbook"));

  const hiddenFinanceSearch = await routeHttpRequest(
    root,
    "GET",
    `/api/v1/search?q=${encodeURIComponent(ENTERPRISE_DEMO_SENTINELS.finance)}&type=page&limit=10`,
    undefined,
    publicPolicy,
  );
  assert.equal(hiddenFinanceSearch.status, 200);
  assert.doesNotMatch(JSON.stringify(hiddenFinanceSearch.body), /page:finance:forecast|enterprise-demo-finance-private-bravo/);

  const financeSearch = await routeHttpRequest(
    root,
    "GET",
    `/api/v1/search?q=${encodeURIComponent(ENTERPRISE_DEMO_SENTINELS.finance)}&type=page&limit=10`,
    undefined,
    financePolicy,
  );
  assert.equal(financeSearch.status, 200);
  assert.ok(JSON.stringify(financeSearch.body).includes("page:finance:forecast"));

  const hiddenSource = await routeHttpRequest(
    root,
    "GET",
    "/api/v1/sources/" + encodeURIComponent("source:finance:forecast"),
    undefined,
    publicPolicy,
  );
  assert.equal(hiddenSource.status, 403);
}

async function assertMcpAgentModes(root, generated) {
  const readTools = await handleMcpRequest(root, { jsonrpc: "2.0", id: "read-tools", method: "tools/list" }, { toolMode: "read" });
  const readNames = new Set(readTools.tools.map((tool) => tool.name));
  assert.ok(readNames.has("wiki.search"));
  assert.equal(readNames.has("wiki.propose_edit"), false);
  assert.equal(readNames.has("wiki.apply_proposal"), false);

  const search = await handleMcpRequest(
    root,
    {
      jsonrpc: "2.0",
      id: "read-search",
      method: "tools/call",
      params: {
        name: "wiki.search",
        arguments: { query: ENTERPRISE_DEMO_SENTINELS.public, types: ["page"], limit: 5, include_explain: true },
      },
    },
    { toolMode: "read", actorId: "actor:agent:demo-reader" },
  );
  assert.equal(search.structuredContent.results[0]?.id, "page:public:company-handbook");

  const answer = await handleMcpRequest(
    root,
    {
      jsonrpc: "2.0",
      id: "read-cite",
      method: "tools/call",
      params: {
        name: "wiki.ask",
        arguments: { question: ENTERPRISE_DEMO_SENTINELS.public, limit: 3 },
      },
    },
    { toolMode: "read", actorId: "actor:agent:demo-reader" },
  );
  assert.ok(answer.structuredContent.citations.length >= 1, "read-mode MCP ask should return citations");

  await assert.rejects(
    () =>
      handleMcpRequest(
        root,
        {
          jsonrpc: "2.0",
          id: "read-denial",
          method: "tools/call",
          params: { name: "wiki.read_page", arguments: { id: "page:finance:forecast" } },
        },
        { toolMode: "read", actorId: "actor:agent:demo-reader" },
      ),
    /requires .* access|not authorized|denied|requires scope/i,
  );

  const proposalTools = await handleMcpRequest(
    root,
    { jsonrpc: "2.0", id: "proposal-tools", method: "tools/list" },
    { toolMode: "proposal" },
  );
  const proposalNames = new Set(proposalTools.tools.map((tool) => tool.name));
  assert.ok(proposalNames.has("wiki.propose_edit"));
  assert.equal(proposalNames.has("wiki.apply_proposal"), false);

  const detail = await handleMcpRequest(
    root,
    {
      jsonrpc: "2.0",
      id: "proposal-detail",
      method: "tools/call",
      params: { name: "wiki.read_proposal_detail", arguments: { id: generated.open_proposal_ids[0] } },
    },
    { toolMode: "proposal", actorId: "actor:agent:demo-proposer", role: "contributor", principals: ["group:demo-contributors"] },
  );
  assert.equal(detail.structuredContent.proposal.id, generated.open_proposal_ids[0]);

  const proposed = await handleMcpRequest(
    root,
    {
      jsonrpc: "2.0",
      id: "proposal-edit",
      method: "tools/call",
      params: {
        name: "wiki.propose_edit",
        arguments: {
          page_id: "page:public:company-handbook",
          actor_id: "actor:agent:demo-proposer",
          rationale: "Deterministic enterprise demo MCP proposal eval.",
          body: "# Company Handbook\n\nMCP proposal-mode agent eval update for the public demo page.\n",
        },
      },
    },
    { toolMode: "proposal", actorId: "actor:agent:demo-proposer", role: "contributor", principals: ["group:demo-contributors"] },
  );
  assert.match(proposed.structuredContent.proposal.id, /^proposal:/);
}

async function assertUiSmoke(baseUrl) {
  for (const route of ["/", "/pages/" + encodeURIComponent("page:public:company-handbook"), "/spaces", "/proposals", "/admin"]) {
    const response = await fetch(baseUrl + route);
    assert.equal(response.status, 200, `${route} should render`);
    const body = await response.text();
    assert.match(body, /OpenWiki|Company Handbook|Spaces|Proposals|Admin/);
  }
}

async function assertStaticExportFiltering(generated) {
  const outDir = generated.artifacts.static_out_dir;
  assert.equal(typeof outDir, "string", "enterprise demo static export artifact missing");
  const searchIndex = await readFile(path.join(outDir, "search-index.json"), "utf8");
  const pages = await readFile(path.join(outDir, "pages.jsonl"), "utf8");
  assert.match(searchIndex, /enterprise-demo-public-knowledge-alpha/);
  for (const privateSentinel of [ENTERPRISE_DEMO_SENTINELS.finance, ENTERPRISE_DEMO_SENTINELS.hr, ENTERPRISE_DEMO_SENTINELS.executive]) {
    assert.doesNotMatch(searchIndex, new RegExp(escapeRegExp(privateSentinel)));
    assert.doesNotMatch(pages, new RegExp(escapeRegExp(privateSentinel)));
  }
}

async function assertBackupRestore(tempRoot, generated) {
  const backupDir = generated.artifacts.backup_dir;
  assert.equal(typeof backupDir, "string", "enterprise demo backup artifact missing");
  const targetRoot = path.join(tempRoot, "restored-wiki");
  await restoreWorkspaceBackup({
    backupDir,
    targetRoot,
    force: true,
    actorId: "actor:user:demo-owner",
  });
  const restored = await loadRepository(targetRoot);
  assert.ok(restored.pages.some((page) => page.id === "page:public:company-handbook"));
  assert.ok(restored.pages.some((page) => page.id === "page:finance:forecast"));
}

function parseArgs(argv) {
  const options = { keep: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--") {
      continue;
    }
    if (value === "--root") {
      options.root = requireValue(argv, index, "--root");
      index += 1;
      continue;
    }
    if (value === "--keep") {
      options.keep = true;
      continue;
    }
    if (value === "--json") {
      options.json = true;
      continue;
    }
    if (value === "--help" || value === "-h") {
      console.log("Usage: pnpm eval:enterprise-demo [--root path] [--keep] [--json]");
      process.exit(0);
    }
    throw new Error(`Unknown option '${value}'`);
  }
  return options;
}

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value) {
    throw new Error(`Expected value after ${flag}`);
  }
  return value;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
