import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspace } from "@openwiki/repo";
import {
  configureCloudBackupDestination,
  configureLocalBackupDestination,
} from "@openwiki/workflows";
import { backupProviderState } from "../packages/cli/src/backup-credentials.ts";

const execFileAsync = promisify(execFile);

test("backup provider state does not mark unclassified degraded checks as configured", () => {
  assert.equal(
    backupProviderState({
      credentialState: "env_configured",
      readiness: "degraded",
      diagnostics: [{ code: "provider.status_failed", severity: "error", message: "network unavailable" }],
    }),
    "unknown",
  );
  assert.equal(
    backupProviderState({
      credentialState: "not_required",
      readiness: "degraded",
      diagnostics: [{ code: "provider.status_failed", severity: "error", message: "local path unavailable" }],
    }),
    "unknown",
  );
});

test("backup credential commands expose local lifecycle and doctor provider readiness", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-backup-credentials-local-"));
  const backupDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-backup-credentials-destination-"));
  try {
    await createWorkspace(root, "Backup Credential Wiki");
    await configureLocalBackupDestination({ root, id: "local-safe", path: backupDir });

    const status = await runOpenWikiJson<BackupStatusJson>(root, ["backup", "status", "--destination", "local-safe", "--json"]);
    const destination = status.destinations[0];
    assert.equal(destination?.provider_state, "configured");
    assert.equal(destination?.credential_state, "not_required");
    assert.equal(destination?.credential_lifecycle.rotation_mode, "not_required");
    assert.deepEqual(destination?.credential_requirements.map((requirement) => requirement.source), ["none"]);

    const explanation = await runOpenWikiJson<BackupCredentialExplanationJson>(root, [
      "backup",
      "credentials",
      "explain",
      "local-safe",
      "--json",
    ]);
    assert.equal(explanation.provider_state, "configured");
    assert.equal(explanation.lifecycle.rotation_mode, "not_required");
    assert.match(explanation.lifecycle.verify_steps.join("\n"), /backup verify latest --destination local-safe/);

    const rotation = await runOpenWikiJson<BackupCredentialExplanationJson>(root, ["backup", "rotate", "local-safe", "--json"]);
    assert.equal(rotation.lifecycle.rotation_mode, "not_required");
    assert.match(rotation.lifecycle.revoke_steps.join("\n"), /No provider credential revoke step/);

    const doctor = await runOpenWikiJson<DoctorJson>(root, ["doctor", "--profile", "personal", "--json"]);
    const check = doctor.checks.find((candidate) => candidate.name === "backup-provider:local-safe");
    assert.equal(check?.status, "pass");
    assert.equal(check?.details?.provider_state, "configured");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(backupDir, { recursive: true, force: true });
  }
});

test("backup status classifies provider credential failures without leaking secrets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-backup-credentials-cloud-"));
  const server = await startDeniedObjectServer();
  const env = snapshotEnv([
    "OPENWIKI_TEST_BACKUP_ACCESS",
    "OPENWIKI_TEST_BACKUP_SECRET",
    "OPENWIKI_TEST_BACKUP_MISSING_ACCESS",
    "OPENWIKI_TEST_BACKUP_MISSING_SECRET",
  ]);
  try {
    delete process.env.OPENWIKI_TEST_BACKUP_MISSING_ACCESS;
    delete process.env.OPENWIKI_TEST_BACKUP_MISSING_SECRET;
    process.env.OPENWIKI_TEST_BACKUP_ACCESS = "openwiki-access-value";
    process.env.OPENWIKI_TEST_BACKUP_SECRET = "super-secret-token";
    await createWorkspace(root, "Backup Credential Cloud Wiki");
    await configureCloudBackupDestination({
      root,
      id: "minio-missing",
      kind: "minio",
      endpointUrl: server.url,
      bucket: "openwiki-backups",
      prefix: "missing",
      accessKeyIdEnv: "OPENWIKI_TEST_BACKUP_MISSING_ACCESS",
      secretAccessKeyEnv: "OPENWIKI_TEST_BACKUP_MISSING_SECRET",
      allowInsecureHttp: true,
      forcePathStyle: true,
    });
    await configureCloudBackupDestination({
      root,
      id: "minio-denied",
      kind: "minio",
      endpointUrl: server.url,
      bucket: "openwiki-backups",
      prefix: "denied",
      accessKeyIdEnv: "OPENWIKI_TEST_BACKUP_ACCESS",
      secretAccessKeyEnv: "OPENWIKI_TEST_BACKUP_SECRET",
      allowInsecureHttp: true,
      forcePathStyle: true,
    });

    const missing = await runOpenWikiRaw(root, ["backup", "status", "--destination", "minio-missing", "--json"]);
    assert.doesNotMatch(missing.stdout, /super-secret-token|openwiki-access-value/);
    const missingStatus = JSON.parse(missing.stdout) as BackupStatusJson;
    assert.equal(missingStatus.destinations[0]?.provider_state, "missing");
    assert.equal(missingStatus.destinations[0]?.credential_state, "env_missing");
    assert.equal(missingStatus.destinations[0]?.credential_requirements.every((requirement) => requirement.present === false), true);

    const denied = await runOpenWikiRaw(root, ["backup", "status", "--destination", "minio-denied", "--json"]);
    assert.doesNotMatch(denied.stdout, /super-secret-token|openwiki-access-value/);
    const deniedStatus = JSON.parse(denied.stdout) as BackupStatusJson;
    const deniedDestination = deniedStatus.destinations[0];
    assert.equal(deniedDestination?.provider_state, "denied");
    assert.equal(deniedDestination?.credential_state, "env_configured");
    assert.match(deniedDestination?.message ?? "", /token=<redacted>/);
    const requiredEnv = deniedDestination?.credential_requirements
      .filter((requirement) => requirement.source === "env")
      .slice(0, 2);
    assert.equal(requiredEnv?.every((requirement) => requirement.present === true), true);

    const explanation = await runOpenWikiRaw(root, ["backup", "credentials", "explain", "minio-denied", "--json"]);
    assert.doesNotMatch(explanation.stdout, /super-secret-token|openwiki-access-value/);
    const parsedExplanation = JSON.parse(explanation.stdout) as BackupCredentialExplanationJson;
    assert.equal(parsedExplanation.provider_state, "denied");
    assert.match(parsedExplanation.lifecycle.rotate_steps.join("\n"), /least-privilege access key/);
    assert.match(parsedExplanation.lifecycle.revoke_steps.join("\n"), /old object-store access key/);
  } finally {
    restoreEnv(env);
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function runOpenWikiJson<T>(root: string, args: string[]): Promise<T> {
  const { stdout } = await runOpenWikiRaw(root, args);
  return JSON.parse(stdout) as T;
}

async function runOpenWikiRaw(root: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(
    process.execPath,
    [
      "--no-warnings",
      "--import",
      "tsx",
      path.join(process.cwd(), "packages", "cli", "src", "main.ts"),
      "--root",
      root,
      ...args,
    ],
    { cwd: process.cwd() },
  );
}

interface BackupStatusJson {
  destinations: Array<{
    id: string;
    provider_state: string;
    credential_state: string;
    credential_requirements: Array<{ source: string; present: boolean }>;
    credential_lifecycle: { rotation_mode: string };
    message: string;
  }>;
}

interface BackupCredentialExplanationJson {
  provider_state: string;
  lifecycle: {
    rotation_mode: string;
    rotate_steps: string[];
    revoke_steps: string[];
    verify_steps: string[];
  };
}

interface DoctorJson {
  checks: Array<{
    name: string;
    status: string;
    details?: Record<string, unknown>;
  }>;
}

interface DeniedObjectServer {
  url: string;
  close(): Promise<void>;
}

async function startDeniedObjectServer(): Promise<DeniedObjectServer> {
  const server = http.createServer((_request, response) => {
    response.statusCode = 403;
    response.statusMessage = "Forbidden token=super-secret-token";
    response.end("denied\n");
  });
  await mkdir(path.join(os.tmpdir(), "openwiki-backup-denied-server"), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("Expected denied object test server to listen on a TCP port");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function snapshotEnv(keys: string[]): Map<string, string | undefined> {
  return new Map(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(values: Map<string, string | undefined>): void {
  for (const [key, value] of values) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
