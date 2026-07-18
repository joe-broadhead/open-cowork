import { execFile } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspace, readPage } from "@openwiki/repo";
import { searchWiki } from "@openwiki/search";
import {
  configureCloudBackupDestination,
  configureLocalBackupDestination,
  createWorkspaceBackup,
  listWorkspaceBackups,
  localBackupDestinationWarnings,
  pruneWorkspaceBackups,
  restoreWorkspaceBackup,
  resolveLocalBackupDestinationPath,
  verifyWorkspaceBackup,
} from "@openwiki/workflows";

const execFileAsync = promisify(execFile);

test("cloud backup destinations create, list, verify, restore, and prune MinIO-compatible artifacts", async () => {
  const server = await startBackupObjectServer();
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-cloud-backup-"));
  const restored = await mkdtemp(path.join(os.tmpdir(), "openwiki-cloud-restored-"));
  const env = snapshotEnv(["OPENWIKI_TEST_MINIO_ACCESS_KEY", "OPENWIKI_TEST_MINIO_SECRET_KEY"]);
  try {
    process.env.OPENWIKI_TEST_MINIO_ACCESS_KEY = "minio-access";
    process.env.OPENWIKI_TEST_MINIO_SECRET_KEY = "minio-secret";
    await rm(restored, { recursive: true, force: true });
    await createWorkspace(root, "Cloud Backup Wiki");
    await assert.rejects(
      configureCloudBackupDestination({
        root,
        id: "bad-env",
        kind: "minio",
        endpointUrl: server.url,
        bucket: "openwiki-backups",
        accessKeyIdEnv: "raw/key",
        secretAccessKeyEnv: "OPENWIKI_TEST_MINIO_SECRET_KEY",
      }),
      /--access-key-env must be an environment variable name/,
    );

    const { stdout: configureStdout } = await execFileAsync(
      process.execPath,
      [
        "--no-warnings",
        "--import",
        "tsx",
        path.join(process.cwd(), "packages", "cli", "src", "main.ts"),
        "--root",
        root,
        "backup",
        "configure",
        "minio",
        "--id",
        "minio-test",
        "--endpoint-url",
        server.url,
        "--bucket",
        "openwiki-backups",
        "--prefix",
        "test-prefix",
        "--access-key-env",
        "OPENWIKI_TEST_MINIO_ACCESS_KEY",
        "--secret-key-env",
        "OPENWIKI_TEST_MINIO_SECRET_KEY",
        "--keep-last",
        "1",
        "--keep-days",
        "1",
        "--json",
      ],
      { cwd: process.cwd() },
    );
    const configured = JSON.parse(configureStdout) as { destination: { kind: string; uri?: string; prefix?: string } };
    assert.equal(configured.destination.kind, "minio");
    assert.match(configured.destination.uri ?? "", /^s3:\/\/openwiki-backups\/test-prefix\/workspace-cloud-backup-wiki/);

    await createWorkspaceBackup({
      root,
      destinationId: "minio-test",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const newest = await createWorkspaceBackup({
      root,
      destinationId: "minio-test",
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    assert.match(newest.backup_dir, /^s3:\/\/openwiki-backups\/test-prefix\/workspace-cloud-backup-wiki\/openwiki-backup-/);
    assert.ok(server.requests.some((request) => request.method === "PUT" && request.authorization.includes("AWS4-HMAC-SHA256")));

    const listed = await listWorkspaceBackups({ root, destinationId: "minio-test" });
    assert.equal(listed.destination.kind, "minio");
    assert.equal(listed.backups.length, 2);
    assert.equal(listed.backups[0]?.backup_id, newest.backup_id);

    const verified = await verifyWorkspaceBackup({
      root,
      destinationId: "minio-test",
      backupDir: newest.backup_dir,
    });
    assert.equal(verified.backup_id, newest.backup_id);
    assert.ok(verified.files_checked > 0);
    assert.equal(verified.event?.type, "backup.verified");

    const restoredResult = await restoreWorkspaceBackup({
      root,
      destinationId: "minio-test",
      backupDir: newest.backup_dir,
      targetRoot: restored,
    });
    assert.equal(restoredResult.backup_dir, newest.backup_dir);
    assert.equal((await readPage(restored, "page:concept:agent-memory")).title, "Agent Memory");

    const dryRun = await pruneWorkspaceBackups({
      root,
      destinationId: "minio-test",
      keepLast: 1,
      keepDays: 1,
      dryRun: true,
      now: "2026-01-10T12:00:00.000Z",
    });
    assert.equal(dryRun.deleted.length, 1);
    assert.equal(server.deleted.length, 0);

    const pruned = await pruneWorkspaceBackups({
      root,
      destinationId: "minio-test",
      keepLast: 1,
      keepDays: 1,
      now: "2026-01-10T12:00:00.000Z",
    });
    assert.equal(pruned.deleted.length, 1);
    assert.ok(server.deleted.length > 0);
    const afterPrune = await listWorkspaceBackups({ root, destinationId: "minio-test" });
    assert.deepEqual(afterPrune.backups.map((backup) => backup.backup_id), [newest.backup_id]);
  } finally {
    restoreEnv(env);
    await server.close();
    await rm(root, { recursive: true, force: true });
    await rm(restored, { recursive: true, force: true });
  }
});

test(
  "GCS backup destination smoke creates and verifies artifacts when credentials are present",
  { skip: !process.env.OPENWIKI_TEST_GCS_BUCKET || !process.env.GOOGLE_APPLICATION_CREDENTIALS },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-gcs-backup-"));
    try {
      await createWorkspace(root, "GCS Backup Wiki");
      await configureCloudSmokeDestination(root, "gcs-smoke", {
        kind: "gcs",
        bucket: process.env.OPENWIKI_TEST_GCS_BUCKET,
        prefix: `ci-smoke/${Date.now()}`,
        credentialsEnv: "GOOGLE_APPLICATION_CREDENTIALS",
      });
      const backup = await createWorkspaceBackup({ root, destinationId: "gcs-smoke" });
      assert.match(backup.backup_dir, /^gs:\/\//);
      const verified = await verifyWorkspaceBackup({ root, destinationId: "gcs-smoke", backupDir: backup.backup_dir });
      assert.equal(verified.backup_id, backup.backup_id);
      await pruneWorkspaceBackups({ root, destinationId: "gcs-smoke", keepLast: 1, dryRun: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("local backup destination configuration normalizes paths, warns on sync folders, and rejects unsafe layouts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-backup-config-"));
  const linkParent = await mkdtemp(path.join(os.tmpdir(), "openwiki-backup-config-links-"));
  try {
    await createWorkspace(root, "Backup Config Wiki");

    assert.equal(
      resolveLocalBackupDestinationPath(root, "~/Google Drive/OpenWiki Backups"),
      path.resolve(os.homedir(), "Google Drive", "OpenWiki Backups"),
    );
    assert.equal(resolveLocalBackupDestinationPath(root, "relative-backups"), path.resolve(root, "relative-backups"));
    assert.throws(() => resolveLocalBackupDestinationPath(root, "\0bad"), /NUL/);

    assert.ok(
      localBackupDestinationWarnings(root, path.join(os.homedir(), "Google Drive", "OpenWiki Backups")).some((warning) =>
        warning.includes("Google Drive") && warning.includes("upload completion"),
      ),
    );
    assert.ok(
      localBackupDestinationWarnings(
        path.join(os.homedir(), "Library", "Mobile Documents", "com~apple~CloudDocs", "OpenWiki"),
        path.join(os.tmpdir(), "openwiki-backups"),
      ).some((warning) => warning.includes("iCloud Drive") && warning.includes("live workspace")),
    );

    await assert.rejects(
      configureLocalBackupDestination({ root, id: "same", path: root }),
      /live workspace root/,
    );
    await assert.rejects(
      configureLocalBackupDestination({ root, id: "inside", path: path.join(root, "backups") }),
      /inside the live workspace/,
    );
    await assert.rejects(
      configureLocalBackupDestination({ root, id: "parent", path: path.dirname(root) }),
      /contains the live workspace/,
    );
    const symlinkDestination = path.join(linkParent, "workspace-link");
    await symlink(root, symlinkDestination, "dir");
    await assert.rejects(
      configureLocalBackupDestination({ root, id: "link", path: symlinkDestination }),
      /live workspace root/,
    );
    await assert.rejects(
      configureLocalBackupDestination({ root, id: "bad/id", path: path.join(os.tmpdir(), "openwiki-config-safe-backups") }),
      /Backup destination id/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(linkParent, { recursive: true, force: true });
  }
});

test("creates, verifies, restores, and prunes workspace backups through workflows and the CLI", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-backup-"));
  const restored = await mkdtemp(path.join(os.tmpdir(), "openwiki-restored-"));
  const cliRestored = await mkdtemp(path.join(os.tmpdir(), "openwiki-cli-restored-"));
  const configuredRestored = await mkdtemp(path.join(os.tmpdir(), "openwiki-configured-restored-"));
  const unsafeTarget = await mkdtemp(path.join(os.tmpdir(), "openwiki-unsafe-restore-"));
  const replaceTarget = await mkdtemp(path.join(os.tmpdir(), "openwiki-replace-restore-"));
  const corruptTarget = await mkdtemp(path.join(os.tmpdir(), "openwiki-corrupt-restore-"));
  const configuredDestination = await mkdtemp(path.join(os.tmpdir(), "openwiki-configured-backups-"));
  const retentionDir = path.join(root, "retention-backups");
  try {
    await createWorkspace(root, "Backup Wiki");
    await mkdir(path.join(root, ".opencode", "node_modules", ".bin"), { recursive: true });
    await symlink(os.tmpdir(), path.join(root, ".opencode", "node_modules", "outside-cache"), "dir");
    await writeFile(path.join(root, ".opencode", "package.json"), "{}\n", "utf8");
    await writeFile(path.join(root, ".opencode", "package-lock.json"), "{}\n", "utf8");
    await rm(restored, { recursive: true, force: true });
    await rm(cliRestored, { recursive: true, force: true });
    await rm(configuredRestored, { recursive: true, force: true });

    const backup = await createWorkspaceBackup({
      root,
      outDir: path.join(root, "backups"),
    });
    assert.equal(backup.manifest.schema_version, "openwiki.backup.v1");
    assert.equal(backup.manifest.workspace_id, "workspace:backup-wiki");
    assert.equal(backup.manifest.openwiki_version, "0.0.0");
    assert.equal(backup.manifest.created_by_actor, "actor:user:local");
    assert.equal(backup.manifest.checksum_file, "checksums.sha256");
    assert.ok(backup.manifest.included_paths.includes("openwiki.json"));
    assert.ok(backup.manifest.included_paths.includes("wiki"));
    assert.doesNotMatch(backup.manifest.included_paths.join("\n"), /\.opencode\/node_modules/);
    assert.ok(backup.manifest.warnings.some((warning) => warning.includes(".opencode/node_modules")));
    assert.ok(backup.manifest.file_count > 0);
    assert.ok(backup.manifest.byte_count > 0);
    assert.ok(backup.manifest.checksum_file_hash.length === 64);
    assert.equal(backup.event?.type, "backup.created");
    assert.match(await readFile(backup.checksums_path, "utf8"), /repo\/openwiki\.json/);
    assert.match(await readFile(backup.restore_readme_path, "utf8"), /Verify this artifact before restore/);

    const listed = await listWorkspaceBackups({ root, outDir: path.join(root, "backups") });
    assert.equal(listed.backups[0]?.backup_id, backup.backup_id);
    const verification = await verifyWorkspaceBackup({ root, backupDir: backup.backup_dir });
    assert.equal(verification.backup_id, backup.backup_id);
    assert.equal(verification.files_checked, backup.manifest.file_count);
    assert.equal(verification.checksum_file_hash, backup.manifest.checksum_file_hash);
    assert.equal(verification.event?.type, "backup.verified");

    const restoredResult = await restoreWorkspaceBackup({
      backupDir: backup.backup_dir,
      targetRoot: restored,
    });
    assert.equal(restoredResult.manifest.workspace_id, "workspace:backup-wiki");
    assert.equal(restoredResult.event?.type, "backup.restored");
    assert.ok(restoredResult.search_index.recordCount >= 3);
    assert.equal((await readPage(restored, "page:concept:agent-memory")).title, "Agent Memory");
    const restoredSearch = await searchWiki(restored, { query: "agent memory", limit: 1 });
    assert.equal(restoredSearch.results[0]?.id, "page:concept:agent-memory");

    await writeFile(path.join(unsafeTarget, "important.txt"), "do not delete\n", "utf8");
    await assert.rejects(
      restoreWorkspaceBackup({
        backupDir: backup.backup_dir,
        targetRoot: unsafeTarget,
        force: true,
      }),
      /Refusing to force restore into non-OpenWiki directory/,
    );
    assert.equal(await readFile(path.join(unsafeTarget, "important.txt"), "utf8"), "do not delete\n");

    const corruptBackup = path.join(root, "corrupt-backup");
    await cp(backup.backup_dir, corruptBackup, { recursive: true });
    await writeFile(path.join(corruptBackup, "repo", "wiki", "concepts", "agent-memory.md"), "tampered\n", "utf8");
    await createWorkspace(corruptTarget, "Backup Wiki");
    await writeFile(path.join(corruptTarget, "stale.txt"), "must survive corrupt restore\n", "utf8");
    await assert.rejects(verifyWorkspaceBackup({ backupDir: corruptBackup }), /checksum mismatch/);
    await assert.rejects(
      restoreWorkspaceBackup({
        backupDir: corruptBackup,
        targetRoot: corruptTarget,
        force: true,
      }),
      /checksum mismatch/,
    );
    assert.equal(await readFile(path.join(corruptTarget, "stale.txt"), "utf8"), "must survive corrupt restore\n");

    const corruptListedBackup = path.join(root, "backups", "openwiki-backup-corrupt-list");
    await cp(backup.backup_dir, corruptListedBackup, { recursive: true });
    await writeFile(path.join(corruptListedBackup, "checksums.sha256"), "tampered checksum file\n", "utf8");
    const listedWithCorrupt = await listWorkspaceBackups({ root, outDir: path.join(root, "backups") });
    const corruptListed = listedWithCorrupt.backups.find((candidate) => candidate.backup_id === "openwiki-backup-corrupt-list");
    assert.equal(corruptListed?.status, "invalid");
    assert.match(corruptListed?.error ?? "", /checksum file hash does not match/);

    await createWorkspace(replaceTarget, "Backup Wiki");
    await writeFile(path.join(replaceTarget, "stale.txt"), "old workspace data\n", "utf8");
    const replacedResult = await restoreWorkspaceBackup({
      backupDir: backup.backup_dir,
      targetRoot: replaceTarget,
      force: true,
    });
    assert.equal(replacedResult.manifest.workspace_id, "workspace:backup-wiki");
    await assert.rejects(readFile(path.join(replaceTarget, "stale.txt"), "utf8"), /ENOENT/);
    assert.equal((await readPage(replaceTarget, "page:concept:agent-memory")).title, "Agent Memory");

    const { stdout: backupStdout } = await execFileAsync(
      process.execPath,
      [
        "--no-warnings",
        "--import",
        "tsx",
        path.join(process.cwd(), "packages", "cli", "src", "main.ts"),
        "--root",
        root,
        "backup",
        "create",
        "--out-dir",
        path.join(root, "cli-backups"),
        "--json",
      ],
      { cwd: process.cwd() },
    );
    const cliBackup = JSON.parse(backupStdout) as { backup_dir: string; manifest: { workspace_id: string } };
    assert.equal(cliBackup.manifest.workspace_id, "workspace:backup-wiki");

    const { stdout: listStdout } = await execFileAsync(
      process.execPath,
      [
        "--no-warnings",
        "--import",
        "tsx",
        path.join(process.cwd(), "packages", "cli", "src", "main.ts"),
        "--root",
        root,
        "backup",
        "list",
        "--out-dir",
        path.join(root, "cli-backups"),
        "--json",
      ],
      { cwd: process.cwd() },
    );
    const cliList = JSON.parse(listStdout) as { backups: Array<{ backup_id: string; status: string }> };
    assert.equal(cliList.backups[0]?.status, "ok");

    const { stdout: verifyStdout } = await execFileAsync(
      process.execPath,
      [
        "--no-warnings",
        "--import",
        "tsx",
        path.join(process.cwd(), "packages", "cli", "src", "main.ts"),
        "--root",
        root,
        "backup",
        "verify",
        "latest",
        "--out-dir",
        path.join(root, "cli-backups"),
        "--json",
      ],
      { cwd: process.cwd() },
    );
    const cliVerify = JSON.parse(verifyStdout) as { backup_id: string; files_checked: number };
    assert.equal(cliVerify.backup_id, cliList.backups[0]?.backup_id);
    assert.ok(cliVerify.files_checked > 0);

    const { stdout: configureStdout } = await execFileAsync(
      process.execPath,
      [
        "--no-warnings",
        "--import",
        "tsx",
        path.join(process.cwd(), "packages", "cli", "src", "main.ts"),
        "--root",
        root,
        "backup",
        "configure",
        "local",
        "--id",
        "local-test",
        "--path",
        configuredDestination,
        "--keep-last",
        "2",
        "--keep-days",
        "30",
        "--json",
      ],
      { cwd: process.cwd() },
    );
    const configured = JSON.parse(configureStdout) as {
      destination: { id?: string; path: string };
      retention?: { keep_last?: number; keep_days?: number };
      event?: { type: string };
    };
    assert.equal(configured.destination.id, "local-test");
    assert.equal(configured.destination.path, configuredDestination);
    assert.deepEqual(configured.retention, { keep_last: 2, keep_days: 30 });
    assert.equal(configured.event?.type, "backup.destination.configured");

    const { stdout: destinationCreateStdout } = await execFileAsync(
      process.execPath,
      [
        "--no-warnings",
        "--import",
        "tsx",
        path.join(process.cwd(), "packages", "cli", "src", "main.ts"),
        "--root",
        root,
        "backup",
        "create",
        "--destination",
        "local-test",
        "--json",
      ],
      { cwd: process.cwd() },
    );
    const destinationBackup = JSON.parse(destinationCreateStdout) as { backup_dir: string };
    assert.equal(path.dirname(destinationBackup.backup_dir), configuredDestination);

    const { stdout: watchStdout } = await execFileAsync(
      process.execPath,
      [
        "--no-warnings",
        "--import",
        "tsx",
        path.join(process.cwd(), "packages", "cli", "src", "main.ts"),
        "--root",
        root,
        "backup",
        "watch",
        "--every",
        "1h",
        "--destination",
        "local-test",
        "--once",
        "--json",
      ],
      { cwd: process.cwd() },
    );
    const watch = JSON.parse(watchStdout) as { kind: string; runs: Array<{ status: string; message: string }>; state: { last_success?: { status?: string } } };
    assert.equal(watch.kind, "backup");
    assert.equal(watch.runs[0]?.status, "success");
    assert.match(watch.runs[0]?.message ?? "", /created backup/);
    assert.equal(watch.state.last_success?.status, "success");

    const { stdout: destinationListStdout } = await execFileAsync(
      process.execPath,
      [
        "--no-warnings",
        "--import",
        "tsx",
        path.join(process.cwd(), "packages", "cli", "src", "main.ts"),
        "--root",
        root,
        "backup",
        "list",
        "--destination",
        "local-test",
        "--json",
      ],
      { cwd: process.cwd() },
    );
    const destinationList = JSON.parse(destinationListStdout) as { backups: Array<{ backup_id: string; status: string }> };
    assert.equal(destinationList.backups[0]?.status, "ok");

    const { stdout: destinationVerifyStdout } = await execFileAsync(
      process.execPath,
      [
        "--no-warnings",
        "--import",
        "tsx",
        path.join(process.cwd(), "packages", "cli", "src", "main.ts"),
        "--root",
        root,
        "backup",
        "verify",
        "latest",
        "--destination",
        "local-test",
        "--json",
      ],
      { cwd: process.cwd() },
    );
    const destinationVerify = JSON.parse(destinationVerifyStdout) as { backup_id: string; files_checked: number };
    assert.equal(destinationVerify.backup_id, destinationList.backups[0]?.backup_id);
    assert.ok(destinationVerify.files_checked > 0);

    const { stdout: destinationRestoreStdout } = await execFileAsync(
      process.execPath,
      [
        "--no-warnings",
        "--import",
        "tsx",
        path.join(process.cwd(), "packages", "cli", "src", "main.ts"),
        "--root",
        root,
        "backup",
        "restore",
        "latest",
        "--destination",
        "local-test",
        "--target-root",
        configuredRestored,
        "--json",
      ],
      { cwd: process.cwd() },
    );
    const destinationRestore = JSON.parse(destinationRestoreStdout) as { target_root: string; search_index: { recordCount: number } };
    assert.equal(destinationRestore.target_root, configuredRestored);
    assert.ok(destinationRestore.search_index.recordCount >= 3);
    assert.equal((await readPage(configuredRestored, "page:concept:agent-memory")).title, "Agent Memory");

    const { stdout: restoreStdout } = await execFileAsync(
      process.execPath,
      [
        "--no-warnings",
        "--import",
        "tsx",
        path.join(process.cwd(), "packages", "cli", "src", "main.ts"),
        "backup",
        "restore",
        cliBackup.backup_dir,
        "--target-root",
        cliRestored,
        "--json",
      ],
      { cwd: process.cwd() },
    );
    const cliRestore = JSON.parse(restoreStdout) as { target_root: string; search_index: { recordCount: number } };
    assert.equal(cliRestore.target_root, cliRestored);
    assert.ok(cliRestore.search_index.recordCount >= 3);
    assert.equal((await readPage(cliRestored, "page:concept:agent-memory")).title, "Agent Memory");

    const oldBackup = await createWorkspaceBackup({
      root,
      outDir: retentionDir,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const newerBackup = await createWorkspaceBackup({
      root,
      outDir: retentionDir,
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    const latestBackup = await createWorkspaceBackup({
      root,
      outDir: retentionDir,
      createdAt: "2026-01-09T00:00:00.000Z",
    });
    const dryRun = await pruneWorkspaceBackups({
      root,
      outDir: retentionDir,
      keepLast: 1,
      keepDays: 1,
      dryRun: true,
      now: "2026-01-10T12:00:00.000Z",
    });
    assert.equal(dryRun.deleted.length, 2);
    assert.equal(dryRun.event?.type, "backup.prune_planned");
    assert.equal(await pathExists(oldBackup.backup_dir), true);
    const pruned = await pruneWorkspaceBackups({
      root,
      outDir: retentionDir,
      keepLast: 1,
      keepDays: 1,
      now: "2026-01-10T12:00:00.000Z",
    });
    assert.equal(pruned.event?.type, "backup.pruned");
    assert.deepEqual(pruned.deleted.map((entry) => entry.backup_id).sort(), [newerBackup.backup_id, oldBackup.backup_id].sort());
    assert.equal(await pathExists(oldBackup.backup_dir), false);
    assert.equal(await pathExists(newerBackup.backup_dir), false);
    assert.equal(await pathExists(latestBackup.backup_dir), true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(restored, { recursive: true, force: true });
    await rm(cliRestored, { recursive: true, force: true });
    await rm(configuredRestored, { recursive: true, force: true });
    await rm(unsafeTarget, { recursive: true, force: true });
    await rm(replaceTarget, { recursive: true, force: true });
    await rm(corruptTarget, { recursive: true, force: true });
    await rm(configuredDestination, { recursive: true, force: true });
  }
});

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function configureCloudSmokeDestination(
  root: string,
  id: string,
  input: { kind: "gcs"; bucket: string | undefined; prefix: string; credentialsEnv: string },
): Promise<void> {
  if (input.bucket === undefined) {
    throw new Error("OPENWIKI_TEST_GCS_BUCKET is required for the GCS smoke test.");
  }
  await configureCloudBackupDestination({
    root,
    id,
    kind: input.kind,
    bucket: input.bucket,
    prefix: input.prefix,
    credentialsEnv: input.credentialsEnv,
    keepLast: 1,
  });
}

interface BackupObjectServer {
  url: string;
  requests: Array<{ method: string; key: string; authorization: string }>;
  deleted: string[];
  close(): Promise<void>;
}

async function startBackupObjectServer(): Promise<BackupObjectServer> {
  const objects = new Map<string, Buffer>();
  const requests: BackupObjectServer["requests"] = [];
  const deleted: string[] = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const key = keyFromPathStyleUrl(url);
    requests.push({
      method: request.method ?? "GET",
      key,
      authorization: request.headers.authorization ?? "",
    });
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
    if (request.method === "DELETE") {
      objects.delete(key);
      deleted.push(key);
      response.writeHead(204);
      response.end();
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
    deleted,
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
