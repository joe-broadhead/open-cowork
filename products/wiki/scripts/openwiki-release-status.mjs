#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const artifactsDir = path.join(root, "artifacts");
const options = parseArgs(process.argv.slice(2));
const packageJson = await readJson("package.json");
const packageVersion = typeof packageJson?.version === "string" ? packageJson.version : "0.0.0";
const expectedTag = `v${packageVersion}`;
const git = await gitState();
const releaseTag = await tagEvidence(expectedTag);
const npmTarballs = await npmTarballEvidence();
const releaseEvidence = await artifactEvidence("openwiki-release-evidence.json");
const publicCheck = await publicReachabilityEvidence();
const releaseScope = await readJson("config/openwiki-release-scope.json");
const cloudEvidence = {
  aws: await cloudProviderEvidence("aws"),
  gcp: await cloudProviderEvidence("gcp"),
};
const postgresEvidence = await artifactEvidence("openwiki-postgres-scale-evidence.json");
const scaleBenchmark = await artifactEvidence("openwiki-scale-perf-benchmark-10k.json");
const checks = [
  checkCleanGit(git),
  checkTag(expectedTag, releaseTag, git.commit),
  checkReleaseEvidence(releaseEvidence, git.commit),
  checkNpmTarball(npmTarballs),
  checkPublicReachability(publicCheck),
  checkCloudEvidence("aws", cloudEvidence.aws, git.commit, cloudProviderScope(releaseScope, "aws")),
  checkCloudEvidence("gcp", cloudEvidence.gcp, git.commit, cloudProviderScope(releaseScope, "gcp")),
  checkHostedPostgres(postgresEvidence, git.commit),
  checkScaleBenchmark(scaleBenchmark),
];
const blockers = checks.filter((check) => check.status === "blocked" || check.status === "missing");
const warnings = checks.filter((check) => check.status === "warning");
const deferred = checks.filter((check) => check.status === "deferred");
const status = blockers.length === 0 ? "ready" : blockers.some((check) => check.category === "external") ? "blocked_external" : "blocked";
const report = {
  schema_version: "openwiki-release-status-v1",
  generated_at: new Date().toISOString(),
  status,
  package: {
    name: "@openwiki/cli",
    version: packageVersion,
    expected_tag: expectedTag,
  },
  git,
  summary: {
    checks: checks.length,
    passed: checks.filter((check) => check.status === "passed").length,
    warnings: warnings.length,
    blockers: blockers.length,
    deferred: deferred.length,
  },
  checks,
  next_actions: nextActions(checks),
};

await fs.mkdir(artifactsDir, { recursive: true });
const outPath = path.resolve(options.out ?? path.join(artifactsDir, "openwiki-release-status.json"));
await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
printSummary(report, outPath);
if (options.enforce && blockers.length > 0) {
  process.exitCode = 1;
}

async function gitState() {
  return {
    branch: await command("git", ["branch", "--show-current"]),
    commit: await command("git", ["rev-parse", "HEAD"]),
    dirty_files: (await command("git", ["status", "--short"])).split("\n").filter(Boolean),
  };
}

async function tagEvidence(tag) {
  const commit = await command("git", ["rev-parse", "--verify", `refs/tags/${tag}^{}`]);
  return {
    tag,
    exists: commit.length > 0,
    commit: commit.length > 0 ? commit : undefined,
  };
}

async function command(name, args) {
  try {
    const { stdout } = await execFile(name, args, { cwd: root, timeout: 15_000 });
    return stdout.trim();
  } catch {
    return "";
  }
}

async function readJson(relativePath) {
  try {
    return JSON.parse(await fs.readFile(path.join(root, relativePath), "utf8"));
  } catch {
    return undefined;
  }
}

async function readJsonAt(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

async function artifactEvidence(name) {
  const artifactPath = path.join(artifactsDir, name);
  const json = await readJsonAt(artifactPath);
  return {
    name,
    path: path.relative(root, artifactPath),
    exists: json !== undefined,
    json,
  };
}

async function publicReachabilityEvidence() {
  for (const name of [
    "openwiki-public-release-check.json",
    "openwiki-public-release-check-private-probe-current.json",
  ]) {
    const evidence = await artifactEvidence(name);
    if (evidence.exists) {
      return evidence;
    }
  }
  return artifactEvidence("openwiki-public-release-check.json");
}

async function cloudProviderEvidence(provider) {
  const primary = await artifactEvidence(`openwiki-cloud-apply-evidence-${provider}.json`);
  const plan = await artifactEvidence(`openwiki-cloud-apply-evidence-${provider}-plan-current.json`);
  return {
    provider,
    primary,
    plan: plan.exists ? plan : undefined,
  };
}

function cloudProviderScope(scope, provider) {
  const providerScope = scope?.cloud_providers?.[provider];
  if (providerScope?.status === "deferred" || providerScope?.status === "required") {
    return {
      status: providerScope.status,
      issue: typeof providerScope.issue === "string" ? providerScope.issue : undefined,
      rationale: typeof providerScope.rationale === "string" ? providerScope.rationale : undefined,
    };
  }
  return {
    status: "required",
  };
}

async function npmTarballEvidence() {
  const dir = path.join(artifactsDir, "npm");
  try {
    const names = (await fs.readdir(dir)).filter((name) => name.endsWith(".tgz")).sort();
    const files = [];
    for (const name of names) {
      const filePath = path.join(dir, name);
      const bytes = await fs.readFile(filePath);
      files.push({
        name,
        path: path.relative(root, filePath),
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    return files;
  } catch {
    return [];
  }
}

function checkCleanGit(currentGit) {
  const dirty = currentGit.dirty_files;
  return {
    name: "clean_git",
    category: "local",
    status: dirty.length === 0 ? "passed" : "warning",
    detail: dirty.length === 0 ? "Working tree is clean." : `Working tree has ${dirty.length} changed file(s).`,
    evidence: {
      branch: currentGit.branch,
      commit: currentGit.commit,
      dirty_files: dirty,
    },
  };
}

function checkTag(tag, tagState, commit) {
  if (tagState.exists && tagState.commit === commit) {
    return {
      name: "release_tag",
      category: "release_day",
      status: "passed",
      detail: `${tag} exists and points at the current commit.`,
      evidence: tagState,
    };
  }
  return {
    name: "release_tag",
    category: "release_day",
    status: "blocked",
    detail: tagState.exists
      ? `${tag} exists but does not point at the current commit.`
      : `Create final tag ${tag} only after release-day approval.`,
    evidence: { ...tagState, current_commit: commit },
  };
}

function checkReleaseEvidence(evidence, commit) {
  const json = evidence.json;
  if (!evidence.exists) {
    return missing("release_evidence", "local", `${evidence.path} is missing. Run pnpm release:evidence.`);
  }
  const artifactCommit = typeof json?.git?.commit === "string" ? json.git.commit : undefined;
  const artifactDirty = Array.isArray(json?.git?.dirty_files) ? json.git.dirty_files : undefined;
  const passed = artifactCommit === commit && artifactDirty?.length === 0;
  return {
    name: "release_evidence",
    category: "local",
    status: passed ? "passed" : "warning",
    detail: passed ? "Release evidence matches the current clean commit." : "Release evidence does not prove the current clean commit.",
    evidence: {
      path: evidence.path,
      commit: artifactCommit,
      current_commit: commit,
      dirty_files: artifactDirty,
    },
  };
}

function checkNpmTarball(tarballs) {
  const hasVersionedTarball = tarballs.some((file) => file.name === `openwiki-cli-${packageVersion}.tgz`);
  if (!hasVersionedTarball) {
    return missing("npm_tarball", "local", `artifacts/npm/openwiki-cli-${packageVersion}.tgz is missing. Run pnpm pack:cli.`);
  }
  return {
    name: "npm_tarball",
    category: "local",
    status: "passed",
    detail: "Generated CLI tarball is present.",
    evidence: { tarballs },
  };
}

function checkPublicReachability(evidence) {
  const json = evidence.json;
  if (!evidence.exists) {
    return missing("public_reachability", "release_day", `${evidence.path} is missing. Run pnpm release:public-check after the repo/tag are public.`);
  }
  const failed = typeof json?.failed === "number" ? json.failed : undefined;
  const passed = failed === 0;
  return {
    name: "public_reachability",
    category: "release_day",
    status: passed ? "passed" : "blocked",
    detail: passed ? "Public release URLs are reachable." : "Public release URLs are not fully reachable until repo/tag/package visibility is final.",
    evidence: {
      path: evidence.path,
      total: json?.total,
      passed: json?.passed,
      failed,
      tag: json?.tag,
    },
  };
}

function checkCloudEvidence(provider, evidence, commit, scope) {
  const primary = evidence.primary;
  const plan = evidence.plan;
  const primaryCommit = typeof primary.json?.git?.commit === "string" ? primary.json.git.commit : undefined;
  const planCommit = typeof plan?.json?.git?.commit === "string" ? plan.json.git.commit : undefined;
  const hasCurrentDryRun = primary.exists && primaryCommit === commit;
  const hasCurrentPlan = plan !== undefined && planCommit === commit;
  const hasLiveApply = primary.json?.apply_requested === true && primary.json?.status === "passed";
  if (hasLiveApply && primaryCommit === commit) {
    return {
      name: `cloud_${provider}`,
      category: "external",
      status: "passed",
      detail: `${provider.toUpperCase()} live apply evidence exists for the current commit.`,
      evidence: cloudEvidencePayload(primary, plan, scope),
    };
  }
  if (scope.status === "deferred") {
    return {
      name: `cloud_${provider}`,
      category: "external",
      status: "deferred",
      detail: `${provider.toUpperCase()} live apply/auth-boundary proof is explicitly deferred for this release claim.`,
      evidence: cloudEvidencePayload(primary, plan, scope),
    };
  }
  if (hasCurrentDryRun || hasCurrentPlan) {
    return {
      name: `cloud_${provider}`,
      category: "external",
      status: "blocked",
      detail: `${provider.toUpperCase()} has current non-live evidence, but live apply/auth-boundary proof is still pending.`,
      evidence: cloudEvidencePayload(primary, plan, scope),
    };
  }
  return missing(`cloud_${provider}`, "external", `${provider.toUpperCase()} cloud evidence is missing or stale.`);
}

function checkHostedPostgres(evidence, commit) {
  const json = evidence.json;
  if (!evidence.exists) {
    return missing("hosted_postgres_scale", "external", `${evidence.path} is missing. Run pnpm perf:postgres:hosted.`);
  }
  const artifactCommit = typeof json?.git?.commit === "string" ? json.git.commit : undefined;
  const liveStatus = json?.status === "passed" || json?.status === "completed";
  if (artifactCommit === commit && liveStatus) {
    return {
      name: "hosted_postgres_scale",
      category: "external",
      status: "passed",
      detail: "Hosted Postgres scale evidence exists for the current commit.",
      evidence: hostedPostgresPayload(evidence),
    };
  }
  if (artifactCommit === commit) {
    return {
      name: "hosted_postgres_scale",
      category: "external",
      status: "blocked",
      detail: "Hosted Postgres runner evidence is current, but live database benchmark proof is still pending.",
      evidence: hostedPostgresPayload(evidence),
    };
  }
  return {
    name: "hosted_postgres_scale",
    category: "external",
    status: "warning",
    detail: "Hosted Postgres evidence exists but is stale for the current commit.",
    evidence: hostedPostgresPayload(evidence),
  };
}

function checkScaleBenchmark(evidence) {
  const json = evidence.json;
  if (!evidence.exists) {
    return {
      name: "scale_10k_benchmark",
      category: "local",
      status: "warning",
      detail: "10k benchmark artifact is not present locally; link the latest passing OpenWiki Scale Performance run in release notes.",
      evidence: { path: evidence.path },
    };
  }
  const checks = Array.isArray(json?.checks) ? json.checks : [];
  const passed = checks.every((check) => check.pass === true);
  return {
    name: "scale_10k_benchmark",
    category: "local",
    status: passed ? "passed" : "warning",
    detail: passed ? "10k benchmark artifact passed its budgets." : "10k benchmark artifact has failing or unreadable checks.",
    evidence: {
      path: evidence.path,
      records: json?.records,
      iterations: json?.iterations,
      checks,
    },
  };
}

function cloudEvidencePayload(primary, plan, scope) {
  return {
    scope,
    primary: artifactPayload(primary),
    plan: plan === undefined ? undefined : artifactPayload(plan),
  };
}

function hostedPostgresPayload(evidence) {
  return artifactPayload(evidence);
}

function artifactPayload(evidence) {
  return {
    path: evidence.path,
    exists: evidence.exists,
    status: evidence.json?.status,
    provider: evidence.json?.provider,
    apply_requested: evidence.json?.apply_requested,
    backend_mode: evidence.json?.backend_mode,
    commit: evidence.json?.git?.commit,
    dirty_files: evidence.json?.git?.dirty_files,
  };
}

function missing(name, category, detail) {
  return {
    name,
    category,
    status: "missing",
    detail,
    evidence: {},
  };
}

function nextActions(currentChecks) {
  return currentChecks
    .filter((check) => check.status === "blocked" || check.status === "missing" || check.status === "warning")
    .map((check) => ({ check: check.name, action: check.detail }));
}

function printSummary(currentReport, outPath) {
  console.log(`Wrote ${path.relative(root, outPath)}`);
  console.log(`status=${currentReport.status}`);
  console.log(
    `passed=${currentReport.summary.passed} warnings=${currentReport.summary.warnings} blockers=${currentReport.summary.blockers} deferred=${currentReport.summary.deferred}`,
  );
  for (const action of currentReport.next_actions) {
    console.log(`- ${action.check}: ${action.action}`);
  }
}

function parseArgs(args) {
  const parsed = {
    enforce: false,
    out: undefined,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    } else if (arg === "--enforce") {
      parsed.enforce = true;
    } else if (arg === "--out") {
      parsed.out = requiredValue(args, index, arg);
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      printHelpAndExit();
    } else {
      throw new Error(`Unknown option ${arg}`);
    }
  }
  return parsed;
}

function requiredValue(args, index, option) {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function printHelpAndExit() {
  console.log(`Usage: pnpm release:status [options]

Writes artifacts/openwiki-release-status.json with a local, release-day, and
external-provider go/no-go summary.

Options:
  --out PATH   Artifact output path. Defaults to artifacts/openwiki-release-status.json.
  --enforce    Exit non-zero when any blocker or missing evidence remains.
  --help       Show this help.
`);
  process.exit(0);
}
