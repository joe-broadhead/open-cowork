import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspace, readPage } from "@openwiki/repo";
import { createCloudBackupDestination } from "@openwiki/storage";
import {
  configureCloudBackupDestination,
  createWorkspaceBackup,
  listWorkspaceBackups,
} from "@openwiki/workflows";

const execFileAsync = promisify(execFile);

test("rclone backup adapter rejects out-of-prefix listings before delete", async () => {
  const fakeRcloneRoot = await mkdtemp(path.join(os.tmpdir(), "openwiki-fake-rclone-prefix-"));
  const fakeBin = await mkdtemp(path.join(os.tmpdir(), "openwiki-fake-rclone-prefix-bin-"));
  const env = snapshotEnv(["PATH", "OPENWIKI_FAKE_RCLONE_ROOT", "OPENWIKI_FAKE_RCLONE_BAD_LIST"]);
  try {
    await installFakeRclone(fakeBin);
    process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
    process.env.OPENWIKI_FAKE_RCLONE_ROOT = fakeRcloneRoot;
    process.env.OPENWIKI_FAKE_RCLONE_BAD_LIST = "1";
    const adapter = createCloudBackupDestination({ id: "rclone-prefix", kind: "rclone", remote: "gdrive:OpenWiki Backups" });
    const objectPath = path.join(fakeRcloneRoot, "gdrive", "OpenWiki Backups", "contract", "workspace", "manifest.json");
    await mkdir(path.dirname(objectPath), { recursive: true });
    await writeFile(objectPath, "{}");

    await assert.rejects(
      adapter.deletePrefix("contract/workspace/"),
      /Invalid backup object prefix: \.\.\/other\/manifest\.json/,
    );
    assert.equal(await readFile(objectPath, "utf8"), "{}");
  } finally {
    restoreEnv(env);
    await rm(fakeRcloneRoot, { recursive: true, force: true });
    await rm(fakeBin, { recursive: true, force: true });
  }
});

test("rclone backup bridge creates, lists, verifies, restores, prunes, and reports status without storing provider secrets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-rclone-backup-"));
  const restored = await mkdtemp(path.join(os.tmpdir(), "openwiki-rclone-restored-"));
  const fakeRcloneRoot = await mkdtemp(path.join(os.tmpdir(), "openwiki-fake-rclone-"));
  const fakeBin = await mkdtemp(path.join(os.tmpdir(), "openwiki-fake-rclone-bin-"));
  const env = snapshotEnv(["PATH", "OPENWIKI_FAKE_RCLONE_ROOT"]);
  try {
    await rm(restored, { recursive: true, force: true });
    await installFakeRclone(fakeBin);
    process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;
    process.env.OPENWIKI_FAKE_RCLONE_ROOT = fakeRcloneRoot;
    await createWorkspace(root, "Rclone Backup Wiki");

    await assert.rejects(
      configureCloudBackupDestination({
        root,
        id: "bad-rclone",
        kind: "rclone",
        remote: "https://user:secret@example.test/backups",
      }),
      /configured rclone remote/,
    );

    const configured = await runCliJson<{ destination: { kind: string; uri?: string; remote?: string }; warnings: string[] }>([
      "--root",
      root,
      "backup",
      "configure",
      "rclone",
      "--id",
      "rclone-test",
      "--rclone-remote",
      "gdrive:OpenWiki Backups",
      "--prefix",
      "consumer",
      "--keep-last",
      "1",
      "--json",
    ]);
    assert.equal(configured.destination.kind, "rclone");
    assert.equal(configured.destination.remote, "gdrive:OpenWiki Backups");
    assert.match(configured.destination.uri ?? "", /^rclone:\/\/gdrive%3AOpenWiki%20Backups\/consumer\/workspace-rclone-backup-wiki/);
    assert.ok(configured.warnings.some((warning) => warning.includes("stores only the remote name/path")));
    assert.doesNotMatch(await readFile(path.join(root, "openwiki.json"), "utf8"), /client_secret|refresh_token|ya29\.|provider-secret/u);

    const doctor = await runCliJson<{ checks: Array<{ name: string; details?: { destinations?: Array<{ id: string; credential_state?: string }> } }> }>([
      "--root",
      root,
      "doctor",
      "--json",
    ]);
    const backupConfig = doctor.checks.find((check) => check.name === "backup-config");
    assert.equal(backupConfig?.details?.destinations?.[0]?.id, "rclone-test");
    assert.equal(backupConfig?.details?.destinations?.[0]?.credential_state, "external");

    const emptyStatus = await runCliJson<{
      destinations: Array<{
        status: string;
        readiness: string;
        credential_state: string;
        configured_prefix: string | null;
        capabilities: { put: boolean; get: boolean; list: boolean; delete_prefix: boolean; durable_readback: boolean };
        diagnostics: unknown[];
        backup_count?: number;
        last_verification: unknown;
      }>;
    }>([
      "--root",
      root,
      "backup",
      "status",
      "--destination",
      "rclone-test",
      "--json",
    ]);
    assert.equal(emptyStatus.destinations[0]?.status, "ok");
    assert.equal(emptyStatus.destinations[0]?.readiness, "ok");
    assert.equal(emptyStatus.destinations[0]?.credential_state, "external");
    assert.equal(emptyStatus.destinations[0]?.configured_prefix, "consumer");
    assert.equal(emptyStatus.destinations[0]?.capabilities.put, true);
    assert.equal(emptyStatus.destinations[0]?.capabilities.get, true);
    assert.equal(emptyStatus.destinations[0]?.capabilities.list, true);
    assert.equal(emptyStatus.destinations[0]?.capabilities.delete_prefix, true);
    assert.equal(emptyStatus.destinations[0]?.capabilities.durable_readback, true);
    assert.deepEqual(emptyStatus.destinations[0]?.diagnostics, []);
    assert.equal(emptyStatus.destinations[0]?.backup_count, 0);
    assert.equal(emptyStatus.destinations[0]?.last_verification, null);

    await createWorkspaceBackup({
      root,
      destinationId: "rclone-test",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const newest = await createWorkspaceBackup({
      root,
      destinationId: "rclone-test",
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    assert.match(newest.backup_dir, /^rclone:\/\/gdrive%3AOpenWiki%20Backups\/consumer\/workspace-rclone-backup-wiki\/openwiki-backup-/);

    const listed = await runCliJson<{ backups: Array<{ backup_id: string; status: string }> }>([
      "--root",
      root,
      "backup",
      "list",
      "--destination",
      "rclone-test",
      "--json",
    ]);
    assert.equal(listed.backups.length, 2);
    assert.equal(listed.backups[0]?.backup_id, newest.backup_id);
    assert.equal(listed.backups[0]?.status, "ok");

    const verified = await runCliJson<{ backup_id: string; files_checked: number }>([
      "--root",
      root,
      "backup",
      "verify",
      "latest",
      "--destination",
      "rclone-test",
      "--json",
    ]);
    assert.equal(verified.backup_id, newest.backup_id);
    assert.ok(verified.files_checked > 0);

    const verifiedStatus = await runCliJson<{
      destinations: Array<{ last_verification: { backup_id: string; verified_at: string } | null }>;
    }>([
      "--root",
      root,
      "backup",
      "status",
      "--destination",
      "rclone-test",
      "--json",
    ]);
    assert.equal(verifiedStatus.destinations[0]?.last_verification?.backup_id, newest.backup_id);
    assert.match(verifiedStatus.destinations[0]?.last_verification?.verified_at ?? "", /^20/);

    const restoredResult = await runCliJson<{ target_root: string; search_index: { recordCount: number } }>([
      "--root",
      root,
      "backup",
      "restore",
      "latest",
      "--destination",
      "rclone-test",
      "--target-root",
      restored,
      "--json",
    ]);
    assert.equal(restoredResult.target_root, restored);
    assert.ok(restoredResult.search_index.recordCount >= 3);
    assert.equal((await readPage(restored, "page:concept:agent-memory")).title, "Agent Memory");

    const pruned = await runCliJson<{ deleted: Array<{ backup_id: string }> }>([
      "--root",
      root,
      "backup",
      "prune",
      "--destination",
      "rclone-test",
      "--keep-last",
      "1",
      "--json",
    ]);
    assert.equal(pruned.deleted.length, 1);
    const afterPrune = await listWorkspaceBackups({ root, destinationId: "rclone-test" });
    assert.deepEqual(afterPrune.backups.map((backup) => backup.backup_id), [newest.backup_id]);

    await configureCloudBackupDestination({
      root,
      id: "missing-rclone",
      kind: "rclone",
      remote: "missing:OpenWiki",
      prefix: "consumer",
    });
    const missingStatus = await runCliJson<{ destinations: Array<{ status: string; message: string }> }>([
      "--root",
      root,
      "backup",
      "status",
      "--destination",
      "missing-rclone",
      "--json",
    ]);
    assert.equal(missingStatus.destinations[0]?.status, "degraded");
    assert.match(missingStatus.destinations[0]?.message ?? "", /rclone remote is missing or not configured/);
  } finally {
    restoreEnv(env);
    await rm(root, { recursive: true, force: true });
    await rm(restored, { recursive: true, force: true });
    await rm(fakeRcloneRoot, { recursive: true, force: true });
    await rm(fakeBin, { recursive: true, force: true });
  }
});

async function runCliJson<T>(args: string[]): Promise<T> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "--no-warnings",
      "--import",
      "tsx",
      path.join(process.cwd(), "packages", "cli", "src", "main.ts"),
      ...args,
    ],
    { cwd: process.cwd() },
  );
  return JSON.parse(stdout) as T;
}

async function installFakeRclone(binDir: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("fs/promises");
const path = require("path");

const [command, ...args] = process.argv.slice(2);
const root = process.env.OPENWIKI_FAKE_RCLONE_ROOT;
if (!root) {
  console.error("OPENWIKI_FAKE_RCLONE_ROOT is required");
  process.exit(1);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function remotePath(value) {
  if (value.startsWith("missing:")) {
    fail("didn't find section in config file");
  }
  const index = value.indexOf(":");
  if (index < 1) {
    fail("invalid remote");
  }
  const remote = value.slice(0, index);
  const relative = value.slice(index + 1).replace(/^\\/+/, "");
  return path.join(root, remote, relative);
}

async function listFiles(directory, prefix = "") {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    const relative = prefix ? path.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      return listFiles(absolute, relative);
    }
    if (!entry.isFile()) {
      return [];
    }
    const stat = await fs.stat(absolute);
    return [{ Path: relative.split(path.sep).join("/"), Size: stat.size, ModTime: stat.mtime.toISOString(), IsDir: false }];
  }));
  return nested.flat();
}

(async () => {
  if (command === "copyto") {
    const [source, target] = args;
    if (!source || !target) {
      fail("copyto expects source and target");
    }
    const targetPath = remotePath(target);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(source, targetPath);
    return;
  }
  if (command === "cat") {
    const [target] = args;
    if (!target) {
      fail("cat expects target");
    }
    try {
      const data = await fs.readFile(remotePath(target));
      process.stdout.write(data);
    } catch {
      fail("file not found");
    }
    return;
  }
  if (command === "lsjson") {
    const [target] = args;
    if (!target) {
      fail("lsjson expects target");
    }
    if (process.env.OPENWIKI_FAKE_RCLONE_BAD_LIST === "1") {
      process.stdout.write(JSON.stringify([{ Path: "../other/manifest.json", Size: 2, ModTime: "2026-01-01T00:00:00.000Z", IsDir: false }]));
      return;
    }
    const targetPath = remotePath(target);
    try {
      const stat = await fs.stat(targetPath);
      if (stat.isFile()) {
        process.stdout.write(JSON.stringify([{ Path: path.basename(targetPath), Size: stat.size, ModTime: stat.mtime.toISOString(), IsDir: false }]));
        return;
      }
      if (stat.isDirectory()) {
        process.stdout.write(JSON.stringify(await listFiles(targetPath)));
        return;
      }
    } catch {
      fail("directory not found");
    }
    process.stdout.write("[]");
    return;
  }
  if (command === "deletefile") {
    const [target] = args;
    if (!target) {
      fail("deletefile expects target");
    }
    try {
      await fs.rm(remotePath(target), { force: false });
    } catch {
      fail("file not found");
    }
    return;
  }
  fail("unsupported command");
})().catch((error) => {
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
});
`;
  const target = path.join(binDir, "rclone");
  await writeFile(target, script, "utf8");
  await chmod(target, 0o755);
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
