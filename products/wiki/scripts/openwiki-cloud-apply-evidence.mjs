#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MCP_PROTOCOL_VERSION } from "@openwiki/mcp-server";
import { createGcpEvidenceTools } from "./openwiki-cloud-gcp-evidence.mjs";

const execFile = promisify(execFileCallback);
const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const ARTIFACTS_DIR = path.join(REPO_ROOT, "artifacts", "deployment");
const TOKEN_ENV = "OPENWIKI_CLOUD_EVIDENCE_MCP_TOKEN";
const ORIGIN_ENV = "OPENWIKI_CLOUD_EVIDENCE_PUBLIC_ORIGIN";
const RAW_STDOUT = Symbol("rawStdout");
const runtimeRedactions = new Set();
const PROVIDERS = {
  aws: {
    issue: "#195",
    profile: "aws-ecs-efs",
    moduleDir: "deploy/terraform/aws",
    docs: "docs/deployment/profiles/aws.md",
    authCommand: ["aws", "sts", "get-caller-identity"],
    terraformOutputUrl: "url",
    expectedRuntimeEnv: {
      OPENWIKI_RUNTIME_MODE: "hosted",
      OPENWIKI_READ_BACKEND: "postgres",
      OPENWIKI_SEARCH_BACKEND: "postgres",
      OPENWIKI_QUEUE_BACKEND: "postgres",
      OPENWIKI_OPERATIONAL_STATE_BACKEND: "postgres",
      OPENWIKI_WRITE_COORDINATOR_BACKEND: "postgres",
      DATABASE_URL: "provider secret reference",
    },
    authBoundary: "ALB OIDC, Cloudflare Access, private network, or equivalent trusted proxy boundary",
  },
  gcp: {
    issue: "#196",
    profile: "cloud-run-readmostly",
    moduleDir: "deploy/terraform/gcp",
    docs: "docs/deployment/profiles/gcp.md",
    authCommand: ["gcloud", "auth", "list", "--filter=status:ACTIVE", "--format=value(account)"],
    terraformOutputUrl: "public_origin",
    expectedRuntimeEnv: {
      OPENWIKI_RUNTIME_MODE: "hosted",
      OPENWIKI_READ_BACKEND: "postgres",
      OPENWIKI_SEARCH_BACKEND: "postgres",
      OPENWIKI_QUEUE_BACKEND: "postgres",
      OPENWIKI_OPERATIONAL_STATE_BACKEND: "postgres",
      OPENWIKI_WRITE_COORDINATOR_BACKEND: "postgres",
      DATABASE_URL: "Secret Manager reference",
    },
    authBoundary: "Cloud Run IAM plus trusted proxy headers for disposable evidence; use IAP, private ingress, an authenticated gateway, or equivalent trusted proxy boundary for production browser writes",
  },
};

const options = parseArgs(process.argv.slice(2));
const provider = PROVIDERS[options.provider];
const outputPath = path.resolve(options.out ?? path.join(REPO_ROOT, "artifacts", `openwiki-cloud-apply-evidence-${options.provider}.json`));
const sourceGit = await gitMetadata();
const gcp = createGcpEvidenceTools({
  repoRoot: REPO_ROOT,
  execFile,
  sourceCommand,
  sourceGit,
  options,
  terraformVar,
  requiredTerraformVar,
  terraformOutputString,
  jsonHttpCheck,
  redact,
  round,
  addRuntimeRedaction: (value) => runtimeRedactions.add(value),
  setTerraformVar: (name, value) => {
    process.env[`TF_VAR_${name}`] = value;
  },
});

if (options.dryRun) {
  await writeReport(outputPath, baseReport("not_checked", {
    checks: dryRunChecks(provider),
  }), options.json);
  process.exit(0);
}

const checks = [];
let terraformOutput = {};
let publicOrigin = normalizedOrigin(options.publicOrigin ?? process.env[ORIGIN_ENV]);
let gcpContext;
try {
  if (options.provider === "gcp") {
    await gcp.prepareEnvironment();
  }
  checks.push(await runCheck("provider_auth", provider.authCommand, { cwd: REPO_ROOT }));
  checks.push(await runCheck("terraform_fmt", ["terraform", "-chdir=" + provider.moduleDir, "fmt", "-check", "-recursive"], { cwd: REPO_ROOT }));
  checks.push(await runCheck("terraform_init", terraformInitArgs(provider.moduleDir), { cwd: REPO_ROOT }));
  checks.push(await runCheck("terraform_validate", ["terraform", "-chdir=" + provider.moduleDir, "validate"], { cwd: REPO_ROOT }));
  if (gcp.shouldBuildImage()) {
    const setupCheck = await runCheck("gcp_artifact_registry_setup", gcp.artifactRegistrySetupArgs(provider.moduleDir), { cwd: REPO_ROOT, timeoutMs: 20 * 60 * 1000 });
    checks.push(setupCheck);
    const imageTag = requiredTerraformVar("image");
    const projectId = requiredTerraformVar("project_id");
    checks.push(await runCheck("gcp_cloud_build_image", ["gcloud", "builds", "submit", "--project", projectId, "--tag", imageTag, "--quiet"], { cwd: REPO_ROOT, timeoutMs: 60 * 60 * 1000 }));
    const digestCheck = await gcp.imageDigestCheck(imageTag, projectId);
    checks.push(digestCheck);
    if (digestCheck.pass && digestCheck.digest_ref) {
      process.env.TF_VAR_image = digestCheck.digest_ref;
    }
  }
  checks.push(await runCheck("terraform_plan", ["terraform", "-chdir=" + provider.moduleDir, "plan", "-input=false", "-no-color"], { cwd: REPO_ROOT }));
  if (options.apply) {
    const applyCheck = await runCheck("terraform_apply", ["terraform", "-chdir=" + provider.moduleDir, "apply", "-auto-approve", "-input=false", "-no-color"], { cwd: REPO_ROOT, timeoutMs: 60 * 60 * 1000 });
    checks.push(applyCheck);
    const outputCheck = await runCheck("terraform_output", ["terraform", "-chdir=" + provider.moduleDir, "output", "-json"], { cwd: REPO_ROOT });
    checks.push(outputCheck);
    terraformOutput = parseTerraformOutput(outputCheck[RAW_STDOUT]);
    publicOrigin = publicOrigin ?? normalizedOrigin(terraformOutputString(terraformOutput, provider.terraformOutputUrl));
    if (!applyCheck.pass) {
      checks.push({
        name: "live_probes",
        pass: false,
        status: "skipped",
        reason: "terraform_apply failed; skipped live HTTP and job probes.",
      });
    } else if (options.provider === "gcp") {
      gcpContext = await gcp.probeContext(terraformOutput, publicOrigin);
      checks.push(await httpCheck("gcp_unauth_livez_denied", publicOrigin, "/livez", { expectedStatuses: [401, 403] }));
      checks.push(await httpCheck("gcp_iam_without_trusted_headers_denied", publicOrigin, "/api/v1/index", {
        headers: gcp.iamHeaders(gcpContext),
        expectedStatuses: [401, 403],
      }));
      checks.push(await jsonHttpCheck("readyz", publicOrigin, "/readyz", {
        headers: gcp.trustedHeaders(gcpContext),
        validate: (json) => json?.status === "ready",
      }));
      checks.push(await jsonHttpCheck("index", publicOrigin, "/api/v1/index", {
        headers: gcp.trustedHeaders(gcpContext),
        validate: (json) => json?.serving_layer === "postgres-runtime" && Number(json?.counts?.pages ?? 0) > 0,
      }));
      checks.push(await jsonHttpCheck("search", publicOrigin, "/api/v1/search?q=proposing", {
        headers: gcp.trustedHeaders(gcpContext),
        validate: (json) => Array.isArray(json?.results) && json.results.some((item) => String(item?.matched_fields ?? "").includes("postgres.search_documents")),
      }));
      checks.push(await httpCheck("openapi", publicOrigin, "/openapi.json", { headers: gcp.trustedHeaders(gcpContext) }));
      const queuedRun = await gcp.queueLintRun(publicOrigin, gcpContext);
      checks.push(queuedRun.check);
      checks.push(await runCheck("gcp_worker_execute", [
        "gcloud", "run", "jobs", "execute", gcpContext.workerJobName,
        "--project", gcpContext.projectId,
        "--region", gcpContext.region,
        "--wait",
        "--quiet",
        "--format=json",
      ], { cwd: REPO_ROOT, timeoutMs: 20 * 60 * 1000 }));
      checks.push(await gcp.runDetailCheck(publicOrigin, gcpContext, queuedRun.runId));
      checks.push(await runCheck("gcp_rebuild_execute", [
        "gcloud", "run", "jobs", "execute", gcpContext.rebuildJobName,
        "--project", gcpContext.projectId,
        "--region", gcpContext.region,
        "--wait",
        "--quiet",
        "--format=json",
      ], { cwd: REPO_ROOT, timeoutMs: 20 * 60 * 1000 }));
      checks.push(await jsonHttpCheck("readyz_after_rebuild", publicOrigin, "/readyz", {
        headers: gcp.trustedHeaders(gcpContext),
        validate: (json) => json?.status === "ready",
      }));
      checks.push(await mcpCheck(publicOrigin));
    } else {
      checks.push(await httpCheck("livez", publicOrigin, "/livez"));
      checks.push(await httpCheck("readyz", publicOrigin, "/readyz"));
      checks.push(await httpCheck("openapi", publicOrigin, "/openapi.json"));
      checks.push(await mcpCheck(publicOrigin));
    }
    if (options.destroy) {
      checks.push(await runCheck("terraform_destroy", ["terraform", "-chdir=" + provider.moduleDir, "destroy", "-auto-approve", "-input=false", "-no-color"], { cwd: REPO_ROOT, timeoutMs: 60 * 60 * 1000 }));
      if (options.provider === "gcp") {
        checks.push(await gcp.postDestroyVerify(terraformOutput, gcpContext));
      }
    }
  }
  const checksPassed = checks.every((check) => check.pass || (check.name === "mcp-http-read-token" && check.status === "skipped"));
  const status = checksPassed ? options.apply ? "passed" : "planned" : "failed";
  await writeReport(outputPath, baseReport(status, {
    public_origin: publicOrigin,
    terraform_outputs: summarizeTerraformOutputs(terraformOutput),
    checks,
  }), options.json);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  await writeReport(outputPath, baseReport("failed", {
    public_origin: publicOrigin,
    checks: [...checks, { name: "runner_error", pass: false, status: "failed", error: redact(message) }],
  }), options.json);
  if (options.enforce) {
    process.exitCode = 1;
  }
}

function baseReport(status, extra) {
  return {
    schema_version: "openwiki-cloud-apply-evidence-v1",
    generated_at: new Date().toISOString(),
    status,
    dry_run: options.dryRun,
    provider: options.provider,
    profile: provider.profile,
    issue: provider.issue,
    module_dir: provider.moduleDir,
    docs: provider.docs,
    git: sourceGit,
    apply_requested: options.apply,
    destroy_requested: options.destroy,
    backend_mode: options.backendFalse ? "disabled" : backendMode(provider.moduleDir),
    terraform_vars: summarizeTerraformVars(),
    token_env: TOKEN_ENV,
    token_env_present: Boolean(process.env[TOKEN_ENV]?.trim()),
    public_origin_env: ORIGIN_ENV,
    expected_runtime_env: provider.expectedRuntimeEnv,
    auth_boundary_requirement: provider.authBoundary,
    ...extra,
  };
}

function summarizeTerraformVars() {
  return Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => key.startsWith("TF_VAR_"))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => {
      const sensitive = /secret|password|token|database_url|credential/i.test(key);
      return [key, {
        present: Boolean(value?.trim()),
        sensitive,
        value_sample: sensitive ? undefined : redact(String(value ?? "")).slice(0, 200),
      }];
    }));
}

async function gitMetadata() {
  return {
    branch: await sourceCommand("git", ["branch", "--show-current"]),
    commit: await sourceCommand("git", ["rev-parse", "HEAD"]),
    dirty_files: (await sourceCommand("git", ["status", "--short"])).split("\n").filter(Boolean),
  };
}

async function sourceCommand(command, args) {
  try {
    const { stdout } = await execFile(command, args, { cwd: REPO_ROOT, timeout: 15_000 });
    return stdout.trim();
  } catch (error) {
    return error instanceof Error ? `unavailable: ${redact(error.message)}` : "unavailable";
  }
}

function terraformVar(name, fallback) {
  const value = process.env[`TF_VAR_${name}`]?.trim();
  return value || fallback;
}

function requiredTerraformVar(name) {
  const value = terraformVar(name, "");
  if (!value) {
    throw new Error(`TF_VAR_${name} is required`);
  }
  return value;
}

function dryRunChecks(selected) {
  const checks = [
    ["provider_auth", selected.authCommand.join(" ")],
    ["terraform_fmt", `terraform -chdir=${selected.moduleDir} fmt -check -recursive`],
    ["terraform_init", terraformInitArgs(selected.moduleDir).join(" ")],
    ["terraform_validate", `terraform -chdir=${selected.moduleDir} validate`],
    ["terraform_plan", `terraform -chdir=${selected.moduleDir} plan -input=false -no-color`],
    ["terraform_apply", `terraform -chdir=${selected.moduleDir} apply -auto-approve -input=false -no-color`],
    ["livez", `${ORIGIN_ENV}/livez`],
    ["readyz", `${ORIGIN_ENV}/readyz`],
    ["openapi", `${ORIGIN_ENV}/openapi.json`],
    ["mcp-http-read-token", `${ORIGIN_ENV}/mcp?tools=read with ${TOKEN_ENV}`],
    ["terraform_destroy", `terraform -chdir=${selected.moduleDir} destroy -auto-approve -input=false -no-color`],
  ];
  if (options.provider === "gcp") {
    checks.splice(4, 0,
      ["gcp_artifact_registry_setup", "terraform apply -target=<artifact-registry-and-build-iam>"],
      ["gcp_cloud_build_image", "gcloud builds submit --tag <artifact-registry-image>"],
      ["gcp_image_digest", "gcloud artifacts docker images describe <tag>"],
    );
    checks.splice(-1, 0,
      ["gcp_unauth_livez_denied", "unauthenticated Cloud Run /livez must be denied"],
      ["gcp_iam_without_trusted_headers_denied", "Cloud Run IAM without OpenWiki trusted headers must be denied by the app"],
      ["index", `${ORIGIN_ENV}/api/v1/index with Cloud Run IAM and trusted headers`],
      ["search", `${ORIGIN_ENV}/api/v1/search?q=proposing with Cloud Run IAM and trusted headers`],
      ["gcp_queue_lint_run", "POST /api/v1/runs lint with trusted headers"],
      ["gcp_worker_execute", "gcloud run jobs execute <worker> --wait"],
      ["gcp_run_detail_post_worker", "GET queued run detail and verify postgres succeeded"],
      ["gcp_rebuild_execute", "gcloud run jobs execute <rebuild> --wait"],
      ["readyz_after_rebuild", `${ORIGIN_ENV}/readyz after rebuild job`],
      ["gcp_post_destroy_verify", "verify no prefixed GCP resources remain after terraform destroy"],
    );
  }
  return checks.map(([name, command]) => ({ name, command, pass: false, status: "not_checked" }));
}

async function runCheck(name, argv, input = {}) {
  const started = performance.now();
  const artifact = path.join(ARTIFACTS_DIR, `cloud-${options.provider}-${name}.txt`);
  await fs.mkdir(path.dirname(artifact), { recursive: true });
  try {
    const [command, ...args] = argv;
    const { stdout, stderr } = await execFile(command, args, {
      cwd: input.cwd ?? REPO_ROOT,
      env: process.env,
      timeout: input.timeoutMs ?? 120_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    const output = redact(`${stdout}${stderr}`);
    await fs.writeFile(artifact, output.length === 0 ? "status=passed\n" : output);
    return {
      name,
      pass: true,
      status: "passed",
      command: redact(argv.join(" ")),
      elapsed_ms: round(performance.now() - started),
      artifact: path.relative(REPO_ROOT, artifact),
      stdout_sample: redact(stdout.trim()).slice(0, 4000),
      [RAW_STDOUT]: stdout,
    };
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : String(error));
    await fs.writeFile(artifact, `status=failed\ncommand=${redact(argv.join(" "))}\nerror=${message}\n`);
    if (options.enforce) {
      throw new Error(`${name} failed: ${message}`);
    }
    return {
      name,
      pass: false,
      status: "failed",
      command: redact(argv.join(" ")),
      elapsed_ms: round(performance.now() - started),
      artifact: path.relative(REPO_ROOT, artifact),
      error: message,
    };
  }
}

async function httpCheck(name, origin, suffix, input = {}) {
  if (origin === undefined) {
    return { name, pass: false, status: "skipped", reason: `Set ${ORIGIN_ENV} or expose terraform output url` };
  }
  const expectedStatuses = input.expectedStatuses ?? undefined;
  const started = performance.now();
  try {
    const response = await fetch(`${origin}${suffix}`, { headers: input.headers ?? authHeaders(false) });
    const body = await response.text();
    const statusPassed = expectedStatuses === undefined
      ? response.status >= 200 && response.status < 300
      : expectedStatuses.includes(response.status);
    const pass = statusPassed && (expectedStatuses !== undefined || body.length > 0);
    return {
      name,
      pass,
      status: pass ? "passed" : "failed",
      status_code: response.status,
      elapsed_ms: round(performance.now() - started),
      body_sample: redact(body.slice(0, 500)),
    };
  } catch (error) {
    return { name, pass: false, status: "failed", elapsed_ms: round(performance.now() - started), error: redact(error instanceof Error ? error.message : String(error)) };
  }
}

async function jsonHttpCheck(name, origin, suffix, input = {}) {
  if (origin === undefined) {
    return { name, pass: false, status: "skipped", reason: `Set ${ORIGIN_ENV} or expose terraform output url` };
  }
  const started = performance.now();
  try {
    const response = await fetch(`${origin}${suffix}`, { headers: input.headers ?? authHeaders(false) });
    const body = await response.text();
    const json = parseJson(body);
    const pass = response.status >= 200 && response.status < 300 && json !== undefined && (input.validate === undefined || input.validate(json));
    return {
      name,
      pass,
      status: pass ? "passed" : "failed",
      status_code: response.status,
      elapsed_ms: round(performance.now() - started),
      body_sample: redact(body.slice(0, 1000)),
    };
  } catch (error) {
    return { name, pass: false, status: "failed", elapsed_ms: round(performance.now() - started), error: redact(error instanceof Error ? error.message : String(error)) };
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function mcpCheck(origin) {
  const name = "mcp-http-read-token";
  const token = process.env[TOKEN_ENV]?.trim();
  if (origin === undefined) {
    return { name, pass: false, status: "skipped", reason: `Set ${ORIGIN_ENV} or expose terraform output url` };
  }
  if (!token) {
    return { name, pass: false, status: "skipped", reason: `Set ${TOKEN_ENV}` };
  }
  const started = performance.now();
  try {
    const initialize = await fetch(`${origin}/mcp?tools=read`, {
      method: "POST",
      headers: {
        ...authHeaders(true),
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": MCP_PROTOCOL_VERSION,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: "cloud-evidence-init", method: "initialize" }),
    });
    const body = await initialize.text();
    const sessionId = initialize.headers.get("mcp-session-id");
    let streamStatus;
    let streamBody = "";
    if (initialize.status === 200 && sessionId) {
      const stream = await fetch(`${origin}/mcp?once=true`, {
        headers: {
          ...authHeaders(true),
          accept: "text/event-stream",
          "mcp-protocol-version": MCP_PROTOCOL_VERSION,
          "mcp-session-id": sessionId,
        },
      });
      streamStatus = stream.status;
      streamBody = await stream.text();
    }
    const streamPassed = streamStatus === 200 && streamBody.includes("openwiki mcp stream");
    return {
      name,
      pass: initialize.status === 200 && Boolean(sessionId) && streamPassed,
      status: initialize.status === 200 && Boolean(sessionId) && streamPassed ? "passed" : "failed",
      status_code: initialize.status,
      stream_status_code: streamStatus,
      elapsed_ms: round(performance.now() - started),
      body_sample: redact(`${body}\n${streamBody}`.slice(0, 500)),
      session_header_present: Boolean(sessionId),
    };
  } catch (error) {
    return { name, pass: false, status: "failed", elapsed_ms: round(performance.now() - started), error: redact(error instanceof Error ? error.message : String(error)) };
  }
}

function authHeaders(includeBearer) {
  const token = process.env[TOKEN_ENV]?.trim();
  return includeBearer && token ? { authorization: `Bearer ${token}` } : {};
}

function terraformInitArgs(moduleDir) {
  return options.backendFalse
    ? ["terraform", "-chdir=" + moduleDir, "init", "-backend=false", "-input=false"]
    : ["terraform", "-chdir=" + moduleDir, "init", "-input=false"];
}

function backendMode(moduleDir) {
  return process.env.OPENWIKI_CLOUD_EVIDENCE_BACKEND_MODE?.trim()
    || (existsSync(path.join(REPO_ROOT, moduleDir, "backend.tf")) ? "configured" : "local");
}

function parseTerraformOutput(text) {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function terraformOutputString(outputs, key) {
  const value = outputs[key]?.value;
  return typeof value === "string" ? value : undefined;
}

function summarizeTerraformOutputs(outputs) {
  return Object.fromEntries(Object.entries(outputs).map(([key, value]) => {
    const item = value && typeof value === "object" ? value : {};
    const raw = item.value;
    return [key, { sensitive: Boolean(item.sensitive), value_present: raw !== undefined, value_sample: typeof raw === "string" && !item.sensitive ? raw.slice(0, 200) : undefined }];
  }));
}

function parseArgs(args) {
  const parsed = {
    apply: false,
    backendFalse: false,
    destroy: false,
    dryRun: false,
    enforce: false,
    gcpBuildImage: false,
    json: false,
    out: undefined,
    provider: undefined,
    publicOrigin: undefined,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--apply") parsed.apply = true;
    else if (arg === "--backend=false") parsed.backendFalse = true;
    else if (arg === "--destroy") parsed.destroy = true;
    else if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--enforce") parsed.enforce = true;
    else if (arg === "--gcp-build-image") parsed.gcpBuildImage = true;
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--out") {
      parsed.out = requiredValue(args, index, arg);
      index += 1;
    } else if (arg === "--provider") {
      parsed.provider = providerValue(requiredValue(args, index, arg));
      index += 1;
    } else if (arg === "--public-origin") {
      parsed.publicOrigin = requiredValue(args, index, arg);
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (parsed.provider === undefined) {
    throw new Error("--provider is required: aws or gcp");
  }
  if (parsed.destroy && !parsed.apply) {
    throw new Error("--destroy requires --apply");
  }
  return parsed;
}

function providerValue(value) {
  if (value !== "aws" && value !== "gcp") {
    throw new Error("--provider must be aws or gcp");
  }
  return value;
}

function requiredValue(args, index, name) {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function normalizedOrigin(value) {
  if (!value?.trim()) return undefined;
  return value.trim().replace(/\/+$/, "");
}

async function writeReport(outPath, report, printJson) {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
  if (printJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Wrote ${path.relative(REPO_ROOT, outPath)}`);
  }
}

function redact(value) {
  const secrets = [process.env[TOKEN_ENV], process.env.OPENWIKI_DATABASE_URL, process.env.DATABASE_URL, ...runtimeRedactions]
    .filter((item) => typeof item === "string" && item.length > 0);
  let result = String(value);
  for (const secret of secrets) {
    result = result.split(secret).join("[REDACTED]");
  }
  return result
    .replace(/owk_[A-Za-z0-9_-]+/g, "owk_[REDACTED]")
    .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, "postgres://[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]");
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function printHelp() {
  console.log(`Usage: pnpm deploy:cloud:evidence -- --provider aws|gcp [options]

Generates cloud apply/auth-boundary evidence for the Terraform examples.
Do not pass secrets on the command line. Use provider auth, TF_VAR_* values,
${ORIGIN_ENV}, and ${TOKEN_ENV} through the environment.

Options:
  --provider NAME       Required: aws or gcp.
  --apply               Run terraform apply and live HTTP/MCP probes.
  --destroy             Run terraform destroy after probes; requires --apply.
  --backend=false       Initialize Terraform with -backend=false.
  --gcp-build-image     Build the current checkout into the managed GCP Artifact Registry repo before GCP apply. Automatically used for GCP apply when TF_VAR_image is unset.
  --public-origin URL   Override the Terraform output URL for health probes.
  --out PATH            JSON report path.
  --enforce             Throw on the first command failure.
  --dry-run             Write the evidence inventory without cloud access.
  --json                Print the JSON report.
`);
}
