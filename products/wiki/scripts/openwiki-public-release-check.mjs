#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const artifactsDir = path.join(root, "artifacts");

const options = parseArgs(process.argv.slice(2));
const packageJson = await readJson("package.json");
const mkdocs = await fs.readFile(path.join(root, "mkdocs.yml"), "utf8").catch(() => "");
const packageVersion = stringField(packageJson, "version") ?? "0.0.0";
const repoUrl = options.repoUrl ?? stringField(packageJson, "homepage")?.replace(/#.*$/, "") ?? "https://github.com/joe-broadhead/open-wiki";
const docsUrl = options.docsUrl ?? yamlScalar(mkdocs, "site_url") ?? "https://joe-broadhead.github.io/open-wiki/";
const ref = options.ref ?? "master";
const tag = options.tag ?? `v${packageVersion}`;
const outPath = path.resolve(options.out ?? path.join(artifactsDir, "openwiki-public-release-check.json"));
const startedAt = new Date().toISOString();
const targets = await buildTargets({ repoUrl, docsUrl, ref, tag });
const checks = options.allowUnpublished
  ? targets.map((target) => ({ ...target, status: "deferred_unpublished", ok: true }))
  : options.dryRun
  ? targets.map((target) => ({ ...target, status: "not_checked", ok: true }))
  : await checkTargets(targets, options.timeoutMs);
const failed = checks.filter((check) => check.ok !== true);
const report = {
  schema_version: "openwiki-public-release-check-v1",
  generated_at: new Date().toISOString(),
  started_at: startedAt,
  dry_run: options.dryRun,
  allow_unpublished: options.allowUnpublished,
  repo_url: repoUrl,
  docs_url: docsUrl,
  ref,
  tag,
  total: checks.length,
  passed: checks.length - failed.length,
  failed: failed.length,
  checks,
};

await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);

if (options.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Wrote ${path.relative(root, outPath)}`);
  for (const check of checks) {
    const marker = check.ok === true ? "PASS" : "FAIL";
    const status = check.http_status === undefined ? check.status : `HTTP ${check.http_status}`;
    console.log(`${marker} ${check.name} ${status} ${check.url}`);
  }
}

if (failed.length > 0) {
  process.exitCode = 1;
}

async function readJson(relativePath) {
  return JSON.parse(await fs.readFile(path.join(root, relativePath), "utf8"));
}

async function buildTargets(input) {
  const ownerRepo = ownerRepoFromGitHubUrl(input.repoUrl);
  const rawBase = ownerRepo === undefined
    ? undefined
    : `https://raw.githubusercontent.com/${ownerRepo}/${input.ref.replace(/^\/+|\/+$/g, "")}/`;
  const schemaRawBase = ownerRepo === undefined
    ? undefined
    : `https://raw.githubusercontent.com/${ownerRepo}/${input.tag.replace(/^\/+|\/+$/g, "")}/`;
  const targets = [
    target("repo-home", "github", input.repoUrl),
    target("repo-issues", "github", joinUrl(input.repoUrl, "issues")),
    target("repo-security-policy", "github", joinUrl(input.repoUrl, "security/policy")),
    target("repo-releases", "github", joinUrl(input.repoUrl, "releases")),
    target("repo-release-tag", "github", joinUrl(input.repoUrl, `releases/tag/${input.tag}`)),
    target("release-source-tarball", "github", joinUrl(input.repoUrl, `archive/refs/tags/${input.tag}.tar.gz`)),
    target("release-source-zip", "github", joinUrl(input.repoUrl, `archive/refs/tags/${input.tag}.zip`)),
    target("docs-site", "docs", input.docsUrl),
    target("docs-distribution", "docs", joinUrl(input.docsUrl, "reference/distribution/")),
    target("docs-mcp-agents", "docs", joinUrl(input.docsUrl, "guides/mcp-and-agents/")),
    target("docs-security", "docs", joinUrl(input.docsUrl, "security/")),
  ];

  if (rawBase !== undefined) {
    for (const file of ["README.md", "CHANGELOG.md", "CONTRIBUTING.md", "SECURITY.md", "SUPPORT.md"]) {
      targets.push(target(`raw-${file.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-$/, "")}`, "raw-doc", new URL(file, rawBase).toString()));
    }
  }

  for (const schema of await schemaTargets()) {
    targets.push(target(`schema-id-${schema.name}`, "schema-id", schema.id));
    if (schemaRawBase !== undefined) {
      targets.push(target(`schema-ref-${schema.name}`, "schema-ref", new URL(`schemas/openwiki/v0/${schema.file}`, schemaRawBase).toString()));
    }
  }
  return targets;
}

async function schemaTargets() {
  const dir = path.join(root, "schemas", "openwiki", "v0");
  const files = (await fs.readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  const schemas = [];
  for (const file of files) {
    const json = JSON.parse(await fs.readFile(path.join(dir, file), "utf8"));
    const id = typeof json.$id === "string" ? json.$id : undefined;
    if (id === undefined) {
      throw new Error(`Missing $id in schemas/openwiki/v0/${file}`);
    }
    schemas.push({ file, id, name: file.replace(/\.schema\.json$/, "") });
  }
  return schemas;
}

function target(name, category, url) {
  return { name, category, url };
}

async function checkTargets(targets, timeoutMs) {
  const checks = [];
  for (const item of targets) {
    checks.push(await checkTarget(item, timeoutMs));
  }
  return checks;
}

async function checkTarget(item, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(item.url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "openwiki-public-release-check",
      },
    });
    return {
      ...item,
      ok: response.status >= 200 && response.status < 400,
      status: response.status >= 200 && response.status < 400 ? "passed" : "failed",
      http_status: response.status,
      content_type: response.headers.get("content-type") ?? undefined,
      final_url: response.url,
    };
  } catch (error) {
    return {
      ...item,
      ok: false,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

function parseArgs(args) {
  const parsed = {
    dryRun: false,
    allowUnpublished: false,
    json: false,
    timeoutMs: 10_000,
    out: undefined,
    repoUrl: undefined,
    docsUrl: undefined,
    ref: undefined,
    tag: undefined,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }
    if (arg === "--allow-unpublished") {
      parsed.allowUnpublished = true;
      continue;
    }
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--out") {
      parsed.out = requiredValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--repo-url") {
      parsed.repoUrl = requiredValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--docs-url") {
      parsed.docsUrl = requiredValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--ref") {
      parsed.ref = requiredValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--tag") {
      parsed.tag = requiredValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--timeout-ms") {
      const value = Number(requiredValue(args, index, arg));
      if (!Number.isSafeInteger(value) || value < 1000 || value > 120_000) {
        throw new Error("--timeout-ms must be an integer between 1000 and 120000");
      }
      parsed.timeoutMs = value;
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return parsed;
}

function requiredValue(args, index, name) {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function printHelp() {
  console.log(`Usage: pnpm release:public-check [options]

Checks public release URLs and writes artifacts/openwiki-public-release-check.json.

Options:
  --repo-url URL       GitHub repository URL. Defaults to package.json homepage.
  --docs-url URL       MkDocs site URL. Defaults to mkdocs.yml site_url.
  --ref REF            Raw GitHub content ref to verify. Defaults to master.
  --tag TAG            GitHub release tag to verify. Defaults to v<package version>.
  --out PATH           JSON report path.
  --timeout-ms N       Per-target request timeout, 1000-120000. Defaults to 10000.
  --dry-run            Generate target inventory without network requests.
  --allow-unpublished  Defer network reachability when repo/tag/docs are not public yet.
  --json               Print the JSON report.
`);
}

function joinUrl(base, suffix) {
  const trimmed = base.endsWith("/") ? base : `${base}/`;
  return new URL(suffix, trimmed).toString();
}

function ownerRepoFromGitHubUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "github.com") {
      return undefined;
    }
    const [owner, repo] = parsed.pathname.split("/").filter(Boolean);
    if (owner === undefined || repo === undefined) {
      return undefined;
    }
    return `${owner}/${repo.replace(/\.git$/, "")}`;
  } catch {
    return undefined;
  }
}

function yamlScalar(text, key) {
  const pattern = new RegExp(`^${escapeRegExp(key)}:\\s*([^\\n#]+)`, "m");
  const match = pattern.exec(text);
  return match?.[1]?.trim().replace(/^['"]|['"]$/g, "");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stringField(record, key) {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    return undefined;
  }
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}
