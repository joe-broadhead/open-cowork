#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COVERAGE_ROOT = path.join(REPO_ROOT, "artifacts", "coverage");
const V8_COVERAGE_DIR = path.join(COVERAGE_ROOT, "v8");
const COVERAGE_LOG = path.join(COVERAGE_ROOT, "openwiki-coverage.txt");
const THRESHOLDS = {
  lines: 80,
  functions: 75,
  branches: 65,
};
const DEFAULT_PACKAGE_LINE_FLOOR = 60;

// Per-package line-coverage floors, enforced in addition to the authoritative global thresholds
// above. The global aggregate is weighted by total lines, so a large well-tested package (e.g.
// http-api) can mask a small under-tested one. These floors stop any single package's coverage
// from silently collapsing under that aggregate. Values are the unweighted mean of each package's
// per-file line %, set conservatively below current levels; raise them as coverage improves.
// `postgres-runtime` and `cli` carry lower floors: postgres-runtime's concurrency paths are only
// exercised when DATABASE_URL is set (see the Postgres coverage CI job), and the CLI is a thin
// composition layer over already-covered packages.
const PER_PACKAGE_LINE_FLOORS = {
  core: 90,
  policy: 90,
  validation: 85,
  git: 85,
  repo: 85,
  search: 90,
  "index-store": 90,
  "static-export": 90,
  "http-api": 88,
  workflows: 88,
  web: 90,
  connectors: 85,
  storage: 85,
  "mcp-server": 78,
  jobs: 78,
  "harness-opencode": 85,
  cli: 65,
  "postgres-runtime": 50,
};

await rm(COVERAGE_ROOT, { recursive: true, force: true });
await mkdir(V8_COVERAGE_DIR, { recursive: true });

const tests = [
  ...(await filesMatching(path.join(REPO_ROOT, "tests"), (name) => name.endsWith(".test.ts"))),
  ...(await packageTestFiles()),
].map((file) => path.relative(REPO_ROOT, file));

const args = [
  "--no-warnings",
  "--import",
  "tsx",
  "--test",
  "--experimental-test-coverage",
  "--test-coverage-include=packages/**/*.ts",
  "--test-coverage-exclude=packages/*/dist/**",
  "--test-coverage-exclude=packages/web/assets/**",
  `--test-coverage-lines=${THRESHOLDS.lines}`,
  `--test-coverage-functions=${THRESHOLDS.functions}`,
  `--test-coverage-branches=${THRESHOLDS.branches}`,
  ...tests,
];

const child = spawn(process.execPath, args, {
  cwd: REPO_ROOT,
  env: { ...process.env, NODE_V8_COVERAGE: V8_COVERAGE_DIR },
  stdio: ["ignore", "pipe", "pipe"],
});

const output = createWriteStream(COVERAGE_LOG, { encoding: "utf8" });
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.stdout.pipe(output, { end: false });
child.stderr.pipe(output, { end: false });

const exitCode = await new Promise((resolve) => {
  child.on("close", resolve);
});
await new Promise((resolve) => output.end(resolve));

if (exitCode !== 0) {
  process.exitCode = typeof exitCode === "number" ? exitCode : 1;
} else {
  const floorFailures = await enforcePerPackageFloors(COVERAGE_LOG);
  if (floorFailures.length > 0) {
    console.error("Per-package coverage floors not met:");
    for (const failure of floorFailures) {
      console.error(`  - ${failure}`);
    }
    process.exitCode = 1;
  } else {
    console.log(`OpenWiki coverage report written to ${path.relative(REPO_ROOT, COVERAGE_LOG)}`);
    console.log(`V8 coverage JSON written to ${path.relative(REPO_ROOT, V8_COVERAGE_DIR)}`);
  }
}

// Parse the node --test coverage report (a hierarchical tree where only leaf files carry
// percentages) and return one message per package whose mean per-file line coverage is below its
// configured floor. Packages without a configured floor are reported only if they fall under a
// conservative default, so a newly added package can't slip in entirely untested.
async function enforcePerPackageFloors(logPath) {
  let log;
  try {
    log = await readFile(logPath, "utf8");
  } catch {
    return ["coverage report log was not produced; cannot enforce per-package floors"];
  }
  const perPackage = parsePerPackageLineCoverage(log);
  if (perPackage.size === 0) {
    return ["no per-package coverage rows were parsed from the report"];
  }
  const failures = [];
  for (const [pkg, stats] of [...perPackage.entries()].sort()) {
    const floor = PER_PACKAGE_LINE_FLOORS[pkg] ?? DEFAULT_PACKAGE_LINE_FLOOR;
    const mean = stats.sum / stats.count;
    if (mean + 1e-9 < floor) {
      failures.push(`@openwiki/${pkg} mean line coverage ${mean.toFixed(1)}% is below floor ${floor}% (${stats.count} files)`);
    }
  }
  return failures;
}

function parsePerPackageLineCoverage(log) {
  const perPackage = new Map();
  let inReport = false;
  let currentPackage;
  for (const raw of log.split(/\r?\n/)) {
    if (raw.includes("start of coverage report")) {
      inReport = true;
      continue;
    }
    if (raw.includes("end of coverage report")) {
      break;
    }
    if (!inReport) {
      continue;
    }
    const line = raw.replace(/^ℹ /, "");
    if (!line.includes("|")) {
      continue;
    }
    const depth = line.length - line.trimStart().length;
    const columns = line.split("|");
    const name = columns[0].trim();
    const linePct = columns[1].trim();
    // A package directory row sits one level under `packages` and has no percentage value.
    if (depth === 1 && linePct === "") {
      currentPackage = name;
      continue;
    }
    if (currentPackage !== undefined && /^[0-9]/.test(linePct)) {
      const value = Number.parseFloat(linePct);
      if (!Number.isNaN(value)) {
        const stats = perPackage.get(currentPackage) ?? { sum: 0, count: 0 };
        stats.sum += value;
        stats.count += 1;
        perPackage.set(currentPackage, stats);
      }
    }
  }
  return perPackage;
}

async function packageTestFiles() {
  const packagesDir = path.join(REPO_ROOT, "packages");
  const packages = await safeReaddir(packagesDir);
  const files = [];
  for (const entry of packages) {
    if (!entry.isDirectory()) {
      continue;
    }
    files.push(...await filesMatching(path.join(packagesDir, entry.name, "test"), (name) => name.endsWith(".test.ts")));
  }
  return files;
}

async function filesMatching(dir, predicate) {
  const entries = await safeReaddir(dir);
  return entries
    .filter((entry) => entry.isFile() && predicate(entry.name))
    .map((entry) => path.join(dir, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

async function safeReaddir(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
