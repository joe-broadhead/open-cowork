#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const artifactsDir = path.join(root, "artifacts");
const CLOUD_EVIDENCE_PROVIDERS = ["aws", "gcp"];

async function command(name, args) {
  try {
    const { stdout } = await execFile(name, args, { cwd: root, timeout: 15_000 });
    return stdout.trim();
  } catch (error) {
    return error instanceof Error ? `unavailable: ${error.message}` : "unavailable";
  }
}

async function readJson(relativePath) {
  try {
    return JSON.parse(await fs.readFile(path.join(root, relativePath), "utf8"));
  } catch {
    return undefined;
  }
}

async function listJsonArtifacts() {
  try {
    const names = await fs.readdir(artifactsDir);
    return names.filter((name) => name.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

async function listNpmTarballs() {
  try {
    const names = await fs.readdir(path.join(artifactsDir, "npm"));
    return names.filter((name) => name.endsWith(".tgz")).sort();
  } catch {
    return [];
  }
}

async function commandAvailable(name, args = ["--version"]) {
  try {
    await execFile(name, args, { cwd: root, timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function deploymentEvidence() {
  const outDir = path.join(artifactsDir, "deployment");
  await fs.mkdir(outDir, { recursive: true });
  const entries = [];
  entries.push(await optionalDeploymentCommand({
    profile: "docker-private",
    tool: "docker",
    availableArgs: ["--version"],
    command: ["docker", "compose", "-f", "deploy/compose/docker-compose.yml", "config"],
    artifact: path.join(outDir, "compose-config.txt"),
    inputs: ["deploy/compose/docker-compose.yml"],
    env: {
      POSTGRES_PASSWORD: "openwiki-release-evidence",
      OPENWIKI_MINIO_ACCESS_KEY: "openwiki-release-evidence",
      OPENWIKI_MINIO_SECRET_KEY: "openwiki-release-evidence-secret",
    },
  }));
  entries.push(await optionalDeploymentCommand({
    profile: "kubernetes-enterprise",
    tool: "helm",
    availableArgs: ["version", "--short"],
    command: [
      "helm",
      "template",
      "openwiki",
      "deploy/helm/openwiki",
      "--namespace",
      "openwiki",
      "--values",
      "deploy/helm/openwiki/examples/enterprise-values.yaml",
    ],
    artifact: path.join(outDir, "helm-template.txt"),
    inputs: [
      "deploy/helm/openwiki/Chart.yaml",
      "deploy/helm/openwiki/values.yaml",
      "deploy/helm/openwiki/examples/enterprise-values.yaml",
      "deploy/helm/openwiki/templates",
    ],
  }));
  entries.push(await kustomizeEvidence(outDir));
  for (const provider of CLOUD_EVIDENCE_PROVIDERS) {
    try {
      entries.push(await optionalDeploymentCommand({
        profile: cloudProfile(provider),
        tool: "terraform",
        availableArgs: ["version"],
        command: ["terraform", `-chdir=deploy/terraform/${provider}`, "fmt", "-check", "-recursive"],
        artifact: path.join(outDir, `terraform-${provider}-fmt.txt`),
        inputs: terraformInputs(provider),
      }));
      entries.push(await optionalDeploymentCommand({
        profile: cloudProfile(provider),
        tool: "terraform",
        availableArgs: ["version"],
        command: ["terraform", `-chdir=deploy/terraform/${provider}`, "init", "-backend=false"],
        artifact: path.join(outDir, `terraform-${provider}-init.txt`),
        inputs: terraformInputs(provider),
      }));
      entries.push(await optionalDeploymentCommand({
        profile: cloudProfile(provider),
        tool: "terraform",
        availableArgs: ["version"],
        command: ["terraform", `-chdir=deploy/terraform/${provider}`, "validate"],
        artifact: path.join(outDir, `terraform-${provider}-validate.txt`),
        inputs: terraformInputs(provider),
      }));
    } finally {
      await fs.rm(path.join(root, "deploy", "terraform", provider, ".terraform"), { recursive: true, force: true });
    }
  }
  const bundle = {
    schema_version: "openwiki-deployment-evidence-v1",
    generated_at: new Date().toISOString(),
    entries,
  };
  const bundlePath = path.join(outDir, "openwiki-deployment-evidence.json");
  await fs.writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
  return {
    artifact: path.relative(root, bundlePath),
    entries: entries.map((entry) => ({
      profile: entry.profile,
      status: entry.status,
      command: entry.command,
      artifact: entry.artifact,
      inputs: entry.inputs,
    })),
  };
}

function cloudProfile(provider) {
  return provider === "aws" ? "aws-ecs-efs" : "cloud-run-readmostly";
}

function terraformInputs(provider) {
  return [
    `deploy/terraform/${provider}/main.tf`,
    `deploy/terraform/${provider}/variables.tf`,
    `deploy/terraform/${provider}/outputs.tf`,
    `deploy/terraform/${provider}/backend.tf.example`,
  ];
}

async function kustomizeEvidence(outDir) {
  if (await commandAvailable("kubectl", ["version", "--client"])) {
    return optionalDeploymentCommand({
      profile: "kubernetes-enterprise",
      tool: "kubectl",
      availableArgs: ["version", "--client"],
      command: ["kubectl", "kustomize", "deploy/kubernetes/base"],
      artifact: path.join(outDir, "kubernetes-kustomize.txt"),
      inputs: ["deploy/kubernetes/base/kustomization.yaml", "deploy/kubernetes/base"],
    });
  }
  return optionalDeploymentCommand({
    profile: "kubernetes-enterprise",
    tool: "kustomize",
    availableArgs: ["version"],
    command: ["kustomize", "build", "deploy/kubernetes/base"],
    artifact: path.join(outDir, "kubernetes-kustomize.txt"),
    inputs: ["deploy/kubernetes/base/kustomization.yaml", "deploy/kubernetes/base"],
  });
}

async function optionalDeploymentCommand({ profile, tool, availableArgs, command: argv, artifact, inputs, env }) {
  const commandText = argv.join(" ");
  if (!await commandAvailable(tool, availableArgs)) {
    const payload = `status=tool_unavailable\nprofile=${profile}\ncommand=${commandText}\n`;
    await fs.writeFile(artifact, payload);
    if (releaseEvidenceStrict()) {
      throw new Error(`Required deployment evidence tool is unavailable for ${profile}: ${tool}`);
    }
    return {
      profile,
      status: "tool_unavailable",
      command: commandText,
      artifact: path.relative(root, artifact),
      inputs,
    };
  }
  try {
    const [name, ...args] = argv;
    const { stdout, stderr } = await execFile(name, args, {
      cwd: root,
      env: env === undefined ? process.env : { ...process.env, ...env },
      timeout: 60_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    const output = `${stdout}${stderr}`;
    await fs.writeFile(artifact, output.length === 0 ? "status=passed\n" : output);
    return {
      profile,
      status: "passed",
      command: commandText,
      artifact: path.relative(root, artifact),
      inputs,
      bytes: Buffer.byteLength(output),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await fs.writeFile(artifact, `status=failed\nprofile=${profile}\ncommand=${commandText}\nerror=${message}\n`);
    if (releaseEvidenceStrict()) {
      throw new Error(`Required deployment evidence failed for ${profile}: ${message}`);
    }
    return {
      profile,
      status: "failed",
      command: commandText,
      artifact: path.relative(root, artifact),
      inputs,
      error: message,
    };
  }
}

function releaseEvidenceStrict() {
  return process.env.OPENWIKI_RELEASE_EVIDENCE_STRICT === "1";
}

function summarizeArtifact(name, json) {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return { name, readable: false };
  }
  const record = json;
  if (name.startsWith("openwiki-scale-perf")) {
    return {
      name,
      readable: true,
      stage: stringField(record, "stage"),
      mode: stringField(record, "mode"),
      records: numberField(record, "records"),
      enforced: booleanField(record, "enforced"),
      checks: record.checks,
    };
  }
  if (name === "openwiki-postgres-scale-evidence.json") {
    return {
      name,
      readable: true,
      status: stringField(record, "status"),
      stage: stringField(record, "stage"),
      records: numberField(record, "records"),
      database_url_env: stringField(record, "database_url_env"),
      provider: stringField(record, "provider"),
      git: record.git,
      checks: record.checks,
    };
  }
  if (/^openwiki-cloud-apply-evidence-(aws|gcp)\.json$/.test(name)) {
    return {
      name,
      readable: true,
      status: stringField(record, "status"),
      provider: stringField(record, "provider"),
      profile: stringField(record, "profile"),
      issue: stringField(record, "issue"),
      apply_requested: booleanField(record, "apply_requested"),
      destroy_requested: booleanField(record, "destroy_requested"),
      backend_mode: stringField(record, "backend_mode"),
      token_env_present: booleanField(record, "token_env_present"),
      git: record.git,
      checks: record.checks,
    };
  }
  if (name === "openwiki-public-release-check.json") {
    return {
      name,
      readable: true,
      dry_run: booleanField(record, "dry_run"),
      repo_url: stringField(record, "repo_url"),
      docs_url: stringField(record, "docs_url"),
      ref: stringField(record, "ref"),
      tag: stringField(record, "tag"),
      total: numberField(record, "total"),
      passed: numberField(record, "passed"),
      failed: numberField(record, "failed"),
    };
  }
  if (name === "openwiki-ui-quality.json") {
    return {
      name,
      readable: true,
      screenshots: Array.isArray(record.screenshots) ? record.screenshots.length : undefined,
      violations: Array.isArray(record.violations) ? record.violations.length : undefined,
    };
  }
  return { name, readable: true };
}

function stringField(record, key) {
  return typeof record[key] === "string" ? record[key] : undefined;
}

function numberField(record, key) {
  return typeof record[key] === "number" ? record[key] : undefined;
}

function booleanField(record, key) {
  return typeof record[key] === "boolean" ? record[key] : undefined;
}

async function workflowNames() {
  try {
    return (await fs.readdir(path.join(root, ".github", "workflows"))).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml")).sort();
  } catch {
    return [];
  }
}

const packageJson = await readJson("package.json");
const artifactNames = await listJsonArtifacts();
const npmTarballs = await listNpmTarballs();
const deployment = await deploymentEvidence();
const artifacts = [];
for (const name of artifactNames) {
  artifacts.push(summarizeArtifact(name, await readJson(path.join("artifacts", name))));
}
const releaseWorkflowExecuted =
  process.env.GITHUB_ACTIONS === "true" && process.env.GITHUB_WORKFLOW === "OpenWiki Release Validation";
const releaseTag = process.env.GITHUB_REF?.startsWith("refs/tags/") === true ? process.env.GITHUB_REF_NAME : undefined;

const evidence = {
  schema_version: "openwiki-release-evidence-v1",
  generated_at: new Date().toISOString(),
  release_workflow_executed: releaseWorkflowExecuted,
  tag_created: releaseTag !== undefined,
  release_tag: releaseTag,
  github_actions: process.env.GITHUB_ACTIONS === "true"
    ? {
        workflow: process.env.GITHUB_WORKFLOW,
        run_id: process.env.GITHUB_RUN_ID,
        run_attempt: process.env.GITHUB_RUN_ATTEMPT,
        ref: process.env.GITHUB_REF,
        ref_name: process.env.GITHUB_REF_NAME,
        sha: process.env.GITHUB_SHA,
      }
    : undefined,
  package: {
    name: typeof packageJson?.name === "string" ? packageJson.name : "openwiki",
    version: typeof packageJson?.version === "string" ? packageJson.version : "unknown",
    node_engine: typeof packageJson?.engines?.node === "string" ? packageJson.engines.node : undefined,
    package_manager: typeof packageJson?.packageManager === "string" ? packageJson.packageManager : undefined,
  },
  runtime: {
    node: process.version,
    pnpm: await command("pnpm", ["--version"]),
  },
  git: {
    branch: await command("git", ["branch", "--show-current"]),
    commit: await command("git", ["rev-parse", "HEAD"]),
    dirty_files: (await command("git", ["status", "--short"])).split("\n").filter(Boolean),
  },
  required_local_gates: [
    "pnpm install --frozen-lockfile",
    "pnpm validate",
    "pnpm lint",
    "pnpm coverage",
    "pnpm audit --audit-level high",
    "pnpm check:bundle",
    "pnpm test:ui",
    "pnpm test:ui-quality",
    "pnpm perf:check",
    "python3 -m mkdocs build --strict",
  ],
  excluded_release_steps: ["Create the release tag", "Run the release workflow", "Publish the GitHub release"],
  distribution_commands: {
    dry_run_tarball: "pnpm pack:cli",
    local_install_from_tarball: "npm install -g ./artifacts/npm/openwiki-cli-0.0.0.tgz",
    published_install: "npm install -g @openwiki/cli@0.0.0",
  },
  distribution_artifacts: {
    npm_tarballs: npmTarballs,
  },
  deployment_evidence: deployment,
  ci_workflows: await workflowNames(),
  artifacts,
  recommended_artifacts: [
    "openwiki-scale-perf-smoke-1k.json",
    "openwiki-scale-perf-benchmark-10k.json",
    "openwiki-postgres-scale-evidence.json",
    "openwiki-cloud-apply-evidence-aws.json",
    "openwiki-cloud-apply-evidence-gcp.json",
    "openwiki-public-release-check.json",
    "openwiki-ui-quality.json",
  ],
};

await fs.mkdir(artifactsDir, { recursive: true });
const outPath = path.join(artifactsDir, "openwiki-release-evidence.json");
await fs.writeFile(outPath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`Wrote ${path.relative(root, outPath)}`);
