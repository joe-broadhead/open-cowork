import { execFile } from "node:child_process";
import { access, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { OPENWIKI_PROTOCOL_VERSION, OPENWIKI_REPO_FORMAT, type EventRecord, type OpenWikiConfig } from "@openwiki/core";
import { createWorkspace, readPage } from "@openwiki/repo";
import {
  configureCloudBackupDestination,
  configureLocalBackupDestination,
  createWorkspaceBackup,
} from "@openwiki/workflows";
import { backupRehearsalDiagnostic } from "../packages/cli/src/backup-rehearsal-diagnostics.ts";

const execFileAsync = promisify(execFile);
const cliEntry = path.join(process.cwd(), "packages", "cli", "src", "main.ts");

test("backup rehearse restores a local destination and records doctor evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-rehearsal-"));
  const backups = await mkdtemp(path.join(os.tmpdir(), "openwiki-rehearsal-backups-"));
  const target = path.join(os.tmpdir(), `openwiki-rehearsed-${Date.now()}`);
  const dryRunTarget = path.join(os.tmpdir(), `openwiki-dry-run-${Date.now()}`);
  try {
    await createWorkspace(root, "Rehearsal Wiki");
    await configureLocalBackupDestination({ root, id: "local-test", path: backups, keepLast: 3 });
    const backup = await createWorkspaceBackup({ root, destinationId: "local-test" });

    const missing = await runCliJson<{ checks: Array<{ name: string; status: string }> }>([
      "--root",
      root,
      "doctor",
      "--json",
    ]);
    assert.equal(missing.checks.find((candidate) => candidate.name === "restore-rehearsal")?.status, "warn");

    const dryRun = await runCliJson<{
      dry_run: true;
      verification: { backup_id: string };
      target: { status: string };
    }>([
      "--root",
      root,
      "backup",
      "restore",
      "latest",
      "--destination",
      "local-test",
      "--target-root",
      dryRunTarget,
      "--dry-run",
      "--json",
    ]);
    assert.equal(dryRun.dry_run, true);
    assert.equal(dryRun.verification.backup_id, backup.backup_id);
    assert.equal(dryRun.target.status, "missing");
    assert.equal(await pathExists(dryRunTarget), false);

    const rehearsal = await runCliJson<{
      status: string;
      backup_id: string;
      target_root: string;
      stages: Array<{ name: string; status: string }>;
      validation: { status: string; issue_count: number };
    }>([
      "--root",
      root,
      "backup",
      "rehearse",
      "--backup-id",
      "latest",
      "--destination",
      "local-test",
      "--target-root",
      target,
      "--json",
    ]);
    assert.equal(rehearsal.status, "pass");
    assert.equal(rehearsal.backup_id, backup.backup_id);
    assert.equal(rehearsal.target_root, path.resolve(target));
    assert.deepEqual(rehearsal.stages.map((stage) => [stage.name, stage.status]), [
      ["resolve_backup", "pass"],
      ["verify_backup", "pass"],
      ["restore_workspace", "pass"],
      ["validate_repository", "pass"],
      ["record_evidence", "pass"],
    ]);
    assert.equal(rehearsal.validation.status, "passed");
    assert.equal((await readPage(target, "page:concept:agent-memory")).title, "Agent Memory");

    const doctor = await runCliJson<{ checks: Array<{ name: string; status: string; details?: Record<string, unknown> }> }>([
      "--root",
      root,
      "doctor",
      "--json",
    ]);
    const check = doctor.checks.find((candidate) => candidate.name === "restore-rehearsal");
    assert.equal(check?.status, "pass");
    assert.equal(check?.details?.backup_id, backup.backup_id);

    const preflight = await runCliJson<{ checks: Array<{ name: string; status: string }> }>([
      "--root",
      root,
      "deploy",
      "preflight",
      "--deploy-profile",
      "local-personal",
      "--json",
    ]);
    assert.equal(preflight.checks.find((candidate) => candidate.name === "restore-rehearsal")?.status, "pass");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(backups, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
    await rm(dryRunTarget, { recursive: true, force: true });
  }
});

test("restore rehearsal diagnostic warns when evidence is stale", () => {
  const config: OpenWikiConfig = {
    protocol_version: OPENWIKI_PROTOCOL_VERSION,
    repo_format: OPENWIKI_REPO_FORMAT,
    workspace_id: "workspace:rehearsal-diagnostic",
    title: "Rehearsal Diagnostic",
    created_at: "2026-01-01T00:00:00.000Z",
    runtime: {
      backups: {
        schedule: "daily",
        destinations: [{ id: "local-test", kind: "local", path: "/tmp/openwiki-backups" }],
      },
    },
  };
  const staleEvent: EventRecord = {
    id: "event:2026-01-01-001",
    uri: "openwiki://event/event%3A2026-01-01-001",
    type: "backup.rehearsed",
    workspace_id: config.workspace_id,
    occurred_at: "2026-01-01T00:00:00.000Z",
    record_id: "openwiki-backup-old",
    record_type: "backup",
    path: ".openwiki/events/events.jsonl",
    data: { target_root: "/tmp/openwiki-restore", validation_status: "passed" },
  };
  const check = backupRehearsalDiagnostic(config, [staleEvent], Date.parse("2026-03-01T00:00:00.000Z"));
  assert.equal(check.status, "warn");
  assert.equal(check.details?.backup_id, "openwiki-backup-old");
});

test("backup rehearse reports safe failures for live, non-empty, and corrupt targets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-rehearsal-safety-"));
  const backups = await mkdtemp(path.join(os.tmpdir(), "openwiki-rehearsal-safety-backups-"));
  const nonEmptyTarget = await mkdtemp(path.join(os.tmpdir(), "openwiki-rehearsal-non-empty-"));
  const corruptTarget = path.join(os.tmpdir(), `openwiki-rehearsal-corrupt-${Date.now()}`);
  const corruptBackup = path.join(os.tmpdir(), `openwiki-rehearsal-corrupt-backup-${Date.now()}`);
  try {
    await createWorkspace(root, "Rehearsal Safety Wiki");
    await configureLocalBackupDestination({ root, id: "local-test", path: backups });
    const backup = await createWorkspaceBackup({ root, destinationId: "local-test" });
    await writeFile(path.join(nonEmptyTarget, "important.txt"), "keep me\n", "utf8");

    await assert.rejects(
      runCli([
        "--root",
        root,
        "backup",
        "rehearse",
        "latest",
        "--destination",
        "local-test",
        "--target-root",
        root,
        "--json",
      ]),
      /Restore rehearsal target must be outside the live workspace/,
    );
    await assert.rejects(
      runCli([
        "--root",
        root,
        "backup",
        "rehearse",
        "latest",
        "--destination",
        "local-test",
        "--target-root",
        nonEmptyTarget,
        "--json",
      ]),
      /restore_workspace.*Restore target is not empty/s,
    );
    assert.equal(await readFile(path.join(nonEmptyTarget, "important.txt"), "utf8"), "keep me\n");

    await cp(backup.backup_dir, corruptBackup, { recursive: true });
    await writeFile(path.join(corruptBackup, "repo", "wiki", "concepts", "agent-memory.md"), "tampered\n", "utf8");
    await assert.rejects(
      runCli([
        "--root",
        root,
        "backup",
        "rehearse",
        corruptBackup,
        "--target-root",
        corruptTarget,
        "--json",
      ]),
      /verify_backup.*checksum mismatch/s,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(backups, { recursive: true, force: true });
    await rm(nonEmptyTarget, { recursive: true, force: true });
    await rm(corruptBackup, { recursive: true, force: true });
    await rm(corruptTarget, { recursive: true, force: true });
  }
});

test("backup rehearse restores a provider-backed MinIO-compatible artifact", async () => {
  const server = await startBackupObjectServer();
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-rehearsal-minio-"));
  const target = path.join(os.tmpdir(), `openwiki-rehearsal-minio-target-${Date.now()}`);
  const env = snapshotEnv(["OPENWIKI_TEST_MINIO_ACCESS_KEY", "OPENWIKI_TEST_MINIO_SECRET_KEY"]);
  try {
    process.env.OPENWIKI_TEST_MINIO_ACCESS_KEY = "minio-access";
    process.env.OPENWIKI_TEST_MINIO_SECRET_KEY = "minio-secret";
    await createWorkspace(root, "Rehearsal Cloud Wiki");
    await configureCloudBackupDestination({
      root,
      id: "minio-test",
      kind: "minio",
      endpointUrl: server.url,
      bucket: "openwiki-backups",
      prefix: "rehearsal",
      accessKeyIdEnv: "OPENWIKI_TEST_MINIO_ACCESS_KEY",
      secretAccessKeyEnv: "OPENWIKI_TEST_MINIO_SECRET_KEY",
      keepLast: 2,
    });
    const backup = await createWorkspaceBackup({ root, destinationId: "minio-test" });
    const rehearsal = await runCliJson<{ status: string; backup_id: string; target_root: string }>([
      "--root",
      root,
      "backup",
      "rehearse",
      "--destination",
      "minio-test",
      "--target-root",
      target,
      "--json",
    ]);
    assert.equal(rehearsal.status, "pass");
    assert.equal(rehearsal.backup_id, backup.backup_id);
    assert.equal(rehearsal.target_root, path.resolve(target));
    assert.equal((await readPage(target, "page:concept:agent-memory")).title, "Agent Memory");
    assert.ok(server.requests.some((request) => request.method === "GET" && request.authorization.includes("AWS4-HMAC-SHA256")));
  } finally {
    restoreEnv(env);
    await server.close();
    await rm(root, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

async function runCliJson<T>(args: string[]): Promise<T> {
  const { stdout } = await runCli(args);
  return JSON.parse(stdout) as T;
}

function runCli(args: string[]) {
  return execFileAsync(process.execPath, ["--no-warnings", "--import", "tsx", cliEntry, ...args], {
    cwd: process.cwd(),
  });
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

interface BackupObjectServer {
  url: string;
  requests: Array<{ method: string; key: string; authorization: string }>;
  close(): Promise<void>;
}

async function startBackupObjectServer(): Promise<BackupObjectServer> {
  const objects = new Map<string, Buffer>();
  const requests: BackupObjectServer["requests"] = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const key = keyFromPathStyleUrl(url);
    requests.push({ method: request.method ?? "GET", key, authorization: request.headers.authorization ?? "" });
    if (request.method === "PUT") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        objects.set(key, Buffer.concat(chunks));
        response.writeHead(200);
        response.end();
      });
      return;
    }
    if (request.method === "GET" && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const contents = [...objects.entries()]
        .filter(([objectKey]) => objectKey.startsWith(prefix))
        .map(([objectKey, object]) =>
          `<Contents><Key>${xmlEscape(objectKey)}</Key><LastModified>2026-01-02T00:00:00.000Z</LastModified><Size>${object.byteLength}</Size></Contents>`,
        )
        .join("");
      response.writeHead(200, { "content-type": "application/xml" });
      response.end(`<ListBucketResult>${contents}</ListBucketResult>`);
      return;
    }
    if (request.method === "GET") {
      const object = objects.get(key);
      if (object === undefined) {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, { "content-length": String(object.byteLength) });
      response.end(object);
      return;
    }
    response.writeHead(405);
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("Expected backup object test server to listen on a TCP port");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function keyFromPathStyleUrl(url: URL): string {
  const [, , ...keyParts] = url.pathname.split("/");
  return keyParts.map(decodeURIComponent).join("/");
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
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
