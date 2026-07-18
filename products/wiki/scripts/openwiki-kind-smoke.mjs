#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const artifactsDir = path.join(root, "artifacts");
const clusterName = process.env.OPENWIKI_KIND_CLUSTER || "openwiki-smoke";
const namespace = process.env.OPENWIKI_KIND_NAMESPACE || "openwiki";
const enabled = process.env.OPENWIKI_KIND_SMOKE === "1";

async function run(command, args, options = {}) {
  const { stdout, stderr } = await execFile(command, args, {
    cwd: root,
    timeout: options.timeoutMs ?? 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return `${stdout}${stderr}`.trim();
}

async function hasCommand(command) {
  try {
    await run(command, command === "kubectl" ? ["version", "--client"] : ["--version"], { timeoutMs: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function writeArtifact(payload) {
  await fs.mkdir(artifactsDir, { recursive: true });
  const outPath = path.join(artifactsDir, "openwiki-kind-smoke.json");
  await fs.writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`);
  return outPath;
}

const kindAvailable = await hasCommand("kind");
const kubectlAvailable = await hasCommand("kubectl");
const basePath = "deploy/kubernetes/base";
const plan = {
  schema_version: "openwiki-kind-smoke-v1",
  generated_at: new Date().toISOString(),
  enabled,
  cluster: clusterName,
  namespace,
  manifest_path: basePath,
  required_binaries: {
    kind: kindAvailable,
    kubectl: kubectlAvailable,
  },
  commands: [
    `kind create cluster --name ${clusterName}`,
    `kubectl apply -k ${basePath}`,
    `kubectl -n ${namespace} rollout status deployment/openwiki --timeout=180s`,
    `kubectl -n ${namespace} get pods,svc,pdb,networkpolicy`,
  ],
};

if (!enabled) {
  const outPath = await writeArtifact({ ...plan, status: "planned" });
  console.log(`Planned kind smoke; set OPENWIKI_KIND_SMOKE=1 to apply it. Wrote ${path.relative(root, outPath)}`);
  process.exit(0);
}

if (!kindAvailable || !kubectlAvailable) {
  const outPath = await writeArtifact({ ...plan, status: "missing-tools" });
  console.error(`kind smoke needs kind and kubectl. Wrote ${path.relative(root, outPath)}`);
  process.exit(1);
}

const clusters = await run("kind", ["get", "clusters"]);
if (!clusters.split(/\r?\n/u).includes(clusterName)) {
  await run("kind", ["create", "cluster", "--name", clusterName], { timeoutMs: 300_000 });
}

await run("kubectl", ["apply", "-k", basePath], { timeoutMs: 180_000 });
await run("kubectl", ["-n", namespace, "rollout", "status", "deployment/openwiki", "--timeout=180s"], { timeoutMs: 210_000 });
const resources = await run("kubectl", ["-n", namespace, "get", "pods,svc,pdb,networkpolicy", "-o", "wide"]);
const outPath = await writeArtifact({ ...plan, status: "passed", resources });
console.log(`kind smoke passed. Wrote ${path.relative(root, outPath)}`);
