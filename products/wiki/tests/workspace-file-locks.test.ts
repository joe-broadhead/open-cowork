import { createWorkspace } from "@openwiki/repo";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { withWorkspaceFileLock } from "../packages/repo/src/io.ts";

test("workspace file locks fail closed instead of deleting ambiguous stale-looking locks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-stale-lock-"));
  const originalNow = Date.now;
  try {
    await createWorkspace(root, "Stale Lock Wiki");
    const lockDir = path.join(root, ".openwiki", "locks");
    const lockPath = path.join(lockDir, "events.lock");
    await mkdir(lockDir, { recursive: true });
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, created_at: new Date(originalNow() - 60_000).toISOString() }));
    const startedAt = originalNow();
    await utimes(lockPath, new Date(startedAt - 60_000), new Date(startedAt - 60_000));
    let calls = 0;
    Date.now = () => startedAt + (calls++ === 0 ? 0 : 31_000);

    await assert.rejects(
      withWorkspaceFileLock(root, "events", async () => "unexpected"),
      /stale OpenWiki workspace file lock/,
    );
    assert.match(await readFile(lockPath, "utf8"), /created_at/);
  } finally {
    Date.now = originalNow;
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace file locks recover dead-owner stale locks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-recover-stale-lock-"));
  const originalNow = Date.now;
  try {
    await createWorkspace(root, "Recover Stale Lock Wiki");
    const lockDir = path.join(root, ".openwiki", "locks");
    const lockPath = path.join(lockDir, "events.lock");
    await mkdir(lockDir, { recursive: true });
    const startedAt = originalNow();
    await writeFile(
      lockPath,
      `${JSON.stringify({
        pid: 99999999,
        hostname: os.hostname(),
        token: "dead-owner-token",
        created_at: new Date(startedAt - 60_000).toISOString(),
        heartbeat_at: new Date(startedAt - 60_000).toISOString(),
      })}\n`,
      "utf8",
    );
    await utimes(lockPath, new Date(startedAt - 60_000), new Date(startedAt - 60_000));
    let calls = 0;
    Date.now = () => startedAt + (calls++ === 0 ? 0 : 31_000);

    const result = await withWorkspaceFileLock(root, "events", async () => "recovered");

    assert.equal(result, "recovered");
    await assert.rejects(readFile(lockPath, "utf8"), /ENOENT/);
  } finally {
    Date.now = originalNow;
    await rm(root, { recursive: true, force: true });
  }
});
