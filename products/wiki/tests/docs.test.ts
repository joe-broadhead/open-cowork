import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

const WIKI_ROOT = process.cwd();

test("the root toolchain is the single contributor authority", async () => {
  const packageJson = JSON.parse(await readFile(path.join(WIKI_ROOT, "package.json"), "utf8")) as {
    packageManager?: string;
    engines?: { node?: string };
  };
  const rootNvmrc = (await readFile(path.join(WIKI_ROOT, "..", "..", ".nvmrc"), "utf8")).trim();
  const contributorDocs = [
    await readFile(path.join(WIKI_ROOT, "README.md"), "utf8"),
    await readFile(path.join(WIKI_ROOT, "CONTRIBUTING.md"), "utf8"),
    await readFile(path.join(WIKI_ROOT, "docs", "getting-started", "installation.md"), "utf8"),
  ].join("\n");

  assert.equal(packageJson.packageManager, "pnpm@10.32.1");
  assert.equal(packageJson.engines?.node, ">=22.22.3");
  assert.match(rootNvmrc, /^\d+\.\d+\.\d+$/);
  await assert.rejects(access(path.join(WIKI_ROOT, ".nvmrc")));
  assert.doesNotMatch(contributorDocs, /pnpm(?:@|\s+`)11\./);
  assert.match(contributorDocs, /root `.nvmrc`/);
});

test("README references existing protocol documents", async () => {
  const readme = await readFile(path.join(WIKI_ROOT, "README.md"), "utf8");
  const referencedSpecs = [...readme.matchAll(/`(docs\/spec\/[^`]+)`/g)]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined);
  assert.ok(referencedSpecs.includes("docs/spec/openwiki-protocol-v0.1.md"));
  for (const specPath of referencedSpecs) {
    await access(path.join(WIKI_ROOT, specPath));
  }
});

test("MkDocs navigation resolves and excludes removed platform guides", async () => {
  const mkdocs = await readFile(path.join(WIKI_ROOT, "mkdocs.yml"), "utf8");
  assert.match(mkdocs, /strict: true/);
  assert.match(mkdocs, /theme:\n  name: material/);
  assert.match(mkdocs, /deployment\/overview\.md/);
  assert.match(mkdocs, /deployment\/profiles\/local-personal\.md/);
  assert.match(mkdocs, /deployment\/profiles\/local-team\.md/);
  assert.match(mkdocs, /deployment\/profiles\/public-static\.md/);

  const navPages = [...mkdocs.matchAll(/: ([A-Za-z0-9_\-/.]+\.md)$/gm)]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined);
  for (const page of navPages) {
    await access(path.join(WIKI_ROOT, "docs", page));
  }

  for (const removed of [
    "deployment/docker.md",
    "deployment/compose.md",
    "deployment/helm.md",
    "deployment/kubernetes.md",
    "deployment/terraform.md",
    "deployment/github-pages.md",
    "deployment/profiles/docker-compose.md",
    "deployment/profiles/kubernetes-helm.md",
    "deployment/profiles/aws.md",
    "deployment/profiles/gcp.md",
    "deployment/profiles/cloud-run.md",
    "deployment/profiles/umbrel.md",
  ]) {
    assert.ok(!navPages.includes(removed));
    await assert.rejects(access(path.join(WIKI_ROOT, "docs", removed)));
  }
});

test("public docs contain no retired command or registry claim", async () => {
  const files = [
    path.join(WIKI_ROOT, "README.md"),
    path.join(WIKI_ROOT, "CONTRIBUTING.md"),
    ...await listMarkdownFiles(path.join(WIKI_ROOT, "docs")),
  ];
  const banned = [
    /\bopenwiki upgrade\b/,
    /\bopenwiki version --check\b/,
    /\bopenwiki[^\n]*deploy preflight\b/,
    /--deploy-profile\b/,
    /npm view @openwiki\/cli/,
    /npm install -g @openwiki\/cli@/,
    /\bnpm publish\b/,
    /ghcr\.io\/joe-broadhead\/open-wiki/,
    /pnpm (?:release:evidence|release:status|release:smoke|deploy:cloud:evidence|smoke:kubernetes|evidence:hosted-readiness|perf:postgres:hosted|backup:postgres:restore-drill)/,
  ];
  const offenders: string[] = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    for (const pattern of banned) {
      if (pattern.test(content)) {
        offenders.push(`${path.relative(WIKI_ROOT, file)}: ${pattern.source}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test("user paths describe only source, tarball, static, and source-hosted runtime", async () => {
  const installation = await readFile(path.join(WIKI_ROOT, "docs", "getting-started", "installation.md"), "utf8");
  const firstUser = await readFile(path.join(WIKI_ROOT, "docs", "getting-started", "first-user-path.md"), "utf8");
  const distribution = await readFile(path.join(WIKI_ROOT, "docs", "reference", "distribution.md"), "utf8");
  const inventory = await readFile(path.join(WIKI_ROOT, "docs", "reference", "command-inventory.md"), "utf8");

  assert.match(installation, /Source Checkout/);
  assert.match(installation, /Generated CLI Tarball/);
  assert.match(installation, /Static Export/);
  assert.match(firstUser, /proposal-mode\s+agent/);
  assert.match(firstUser, /Source-Operated Hosted Evaluation/);
  assert.match(distribution, /Generated CLI tarball \| Release-candidate artifact/);
  assert.match(distribution, /Static export \| Supported output/);
  assert.match(inventory, /Source-operated runtime/);
  assert.match(inventory, /no registry self-update command/);
});

test("runtime and security docs retain active safety contracts", async () => {
  const hosted = await readFile(path.join(WIKI_ROOT, "docs", "deployment", "hosted-human-agent.md"), "utf8");
  const operations = await readFile(path.join(WIKI_ROOT, "docs", "deployment", "operations.md"), "utf8");
  const backup = await readFile(path.join(WIKI_ROOT, "docs", "deployment", "operations", "backup-restore.md"), "utf8");
  const threatModel = await readFile(path.join(WIKI_ROOT, "docs", "security", "threat-model.md"), "utf8");

  for (const required of [
    /OPENWIKI_TRUST_AUTH_HEADERS_SECRET/,
    /OPENWIKI_PUBLIC_ORIGIN/,
    /OPENWIKI_OPERATIONAL_STATE_BACKEND/,
    /service-account\s+bearer tokens/,
    /doctor --profile hosted/,
  ]) {
    assert.match(hosted, required);
  }
  assert.match(operations, /Git is canonical/);
  assert.match(operations, /Before adding\s+writers or replicas, use Postgres/);
  assert.match(backup, /Restore Rehearsal/);
  assert.match(backup, /Never point a rehearsal at the production database/);
  for (const category of [
    "Path traversal",
    "Git option injection",
    "SSRF and DNS rebinding",
    "Trusted-header spoofing",
    "CSRF and origin checks",
    "Token leakage",
  ]) {
    assert.match(threatModel, new RegExp(category));
  }
});

test("active documentation remains reviewable", async () => {
  const markdownFiles = await listMarkdownFiles(path.join(WIKI_ROOT, "docs"));
  const oversized: string[] = [];
  for (const file of markdownFiles) {
    const lineCount = (await readFile(file, "utf8")).split("\n").length;
    if (lineCount > 800) {
      oversized.push(`${path.relative(WIKI_ROOT, file)}: ${lineCount}`);
    }
  }
  assert.deepEqual(oversized, []);
});

test("module-size exceptions remain documented", async () => {
  const script = await readFile(path.join(WIKI_ROOT, "scripts", "openwiki-module-size-report.mjs"), "utf8");
  const moduleSizeDocs = await readFile(path.join(WIKI_ROOT, "docs", "development", "module-size.md"), "utf8");
  const documentedExceptions = [...script.matchAll(/\["([^"]+)",\s*"[^"]+"\]/g)]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined);
  assert.ok(documentedExceptions.length > 0);
  for (const relativePath of documentedExceptions) {
    assert.match(moduleSizeDocs, new RegExp(escapeRegExp(`\`${relativePath}\``)));
  }
});

test("user-facing docs use the packaged binary", async () => {
  const files = [
    path.join(WIKI_ROOT, "README.md"),
    ...await listMarkdownFiles(path.join(WIKI_ROOT, "docs", "getting-started")),
    ...await listMarkdownFiles(path.join(WIKI_ROOT, "docs", "guides")),
    ...await listMarkdownFiles(path.join(WIKI_ROOT, "docs", "deployment")),
    ...await listMarkdownFiles(path.join(WIKI_ROOT, "docs", "reference")),
  ];
  const offenders: string[] = [];
  for (const file of files) {
    if (/pnpm openwiki/.test(await readFile(file, "utf8"))) {
      offenders.push(path.relative(WIKI_ROOT, file));
    }
  }
  assert.deepEqual(offenders, []);
  assert.match(await readFile(path.join(WIKI_ROOT, "CONTRIBUTING.md"), "utf8"), /pnpm openwiki -- \.\.\./);
});

async function listMarkdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listMarkdownFiles(absolute));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(absolute);
    }
  }
  return files.sort();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
