import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { runLocalJob } from "@openwiki/jobs";
import { createWorkspace, loadRepository, readPage } from "@openwiki/repo";
import {
  applyProposal,
  OpenWikiWriteInProgressError,
  proposeEdit,
  resolveWriteCoordinatorBackend,
  reviewProposal,
  withWriteCoordination,
} from "@openwiki/workflows";

test("local write coordinator reports the active writer and safely releases its lock", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-write-lock-"));
  try {
    await createWorkspace(root, "Write Lock Wiki");
    let release!: () => void;
    let ready!: () => void;
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const readyPromise = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const holder = withWriteCoordination(
      {
        root,
        operation: "test.hold_write_lock",
        actorId: "actor:user:first",
        metadata: { request_id: "first" },
        waitMs: 0,
      },
      async () => {
        ready();
        await releasePromise;
      },
    );
    await readyPromise;

    await assert.rejects(
      withWriteCoordination(
        {
          root,
          operation: "test.second_write",
          actorId: "actor:user:second",
          waitMs: 0,
        },
        async () => "unexpected",
      ),
      (error: unknown) => {
        assert.ok(error instanceof OpenWikiWriteInProgressError);
        assert.equal(error.active.operation, "test.hold_write_lock");
        assert.equal(error.active.actor_id, "actor:user:first");
        return true;
      },
    );

    release();
    await holder;

    const reacquired = await withWriteCoordination(
      {
        root,
        operation: "test.after_release",
        actorId: "actor:user:third",
        waitMs: 0,
      },
      async () => "ok",
    );
    assert.equal(reacquired, "ok");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local write coordinator recovers an expired diagnostic lock", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-stale-write-lock-"));
  try {
    await createWorkspace(root, "Stale Lock Wiki");
    const lockDir = path.join(root, ".openwiki", "locks");
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      path.join(lockDir, "write-coordinator.lock"),
      `${JSON.stringify(
        {
          backend: "local",
          lock_name: "git-writes",
          actor_id: "actor:user:stale",
          operation: "test.stale",
          started_at: "2026-05-28T00:00:00.000Z",
          heartbeat_at: "2026-05-28T00:00:00.000Z",
          expires_at: "2026-05-28T00:00:01.000Z",
          metadata: { note: "stale" },
          token: "stale-token",
        },
        null,
        2,
      )}\n`,
    );

    const result = await withWriteCoordination(
      {
        root,
        operation: "test.recover_stale",
        actorId: "actor:user:maintainer",
        waitMs: 0,
      },
      async () => "recovered",
    );

    assert.equal(result, "recovered");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local write coordinator aborts callback signal after heartbeat loses ownership", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-lost-write-lock-"));
  try {
    await createWorkspace(root, "Lost Write Lock Wiki");
    let ready!: () => void;
    const readyPromise = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const aborted = withWriteCoordination(
      {
        root,
        operation: "test.abort_lost_lock",
        actorId: "actor:user:writer",
        heartbeatMs: 100,
        leaseMs: 1000,
        waitMs: 0,
      },
      async ({ signal }) => {
        ready();
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("Timed out waiting for lost lease abort")), 1000);
          signal.addEventListener("abort", () => {
            clearTimeout(timeout);
            resolve();
          }, { once: true });
        });
        throw signal.reason instanceof Error ? signal.reason : new Error("Expected lost lease abort reason");
      },
    );
    await readyPromise;
    await writeFile(
      path.join(root, ".openwiki", "locks", "write-coordinator.lock"),
      `${JSON.stringify(
        {
          backend: "local",
          lock_name: "git-writes",
          actor_id: "actor:user:other",
          operation: "test.other_writer",
          started_at: "2026-05-28T00:00:00.000Z",
          heartbeat_at: "2026-05-28T00:00:00.000Z",
          expires_at: "2099-05-28T00:00:01.000Z",
          metadata: {},
          token: "other-token",
        },
        null,
        2,
      )}\n`,
    );

    await assert.rejects(aborted, /OpenWiki local write lease heartbeat lost ownership/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent proposal applies cannot both mutate canonical content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-concurrent-apply-"));
  try {
    await createWorkspace(root, "Concurrent Apply Wiki");
    const repo = await loadRepository(root);
    const page = repo.pages[0];
    assert.ok(page);

    const proposed = await proposeEdit({
      root,
      pageId: page.id,
      body: "# Coordinated Page\n\nOnly one apply should win.\n",
      actorId: "actor:user:editor",
    });
    await reviewProposal({
      root,
      proposalId: proposed.proposal.id,
      decision: "accepted",
      actorId: "actor:user:reviewer",
      rationale: "Accepted for concurrent apply test.",
    });

    const results = await Promise.allSettled([
      applyProposal({ root, proposalId: proposed.proposal.id, actorId: "actor:user:maintainer-a" }),
      applyProposal({ root, proposalId: proposed.proposal.id, actorId: "actor:user:maintainer-b" }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);

    const appliedPage = await readPage(root, page.id);
    assert.match(appliedPage.body, /Only one apply should win/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("web-held write lease blocks write-mode worker jobs on the same workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-web-worker-lock-"));
  try {
    await createWorkspace(root, "Web Worker Lock Wiki");
    let release!: () => void;
    let ready!: () => void;
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const readyPromise = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const holder = withWriteCoordination(
      {
        root,
        operation: "wiki.apply_proposal",
        actorId: "actor:user:web-maintainer",
        waitMs: 0,
      },
      async () => {
        ready();
        await releasePromise;
      },
    );
    await readyPromise;

    const run = await runLocalJob({
      root,
      runType: "static.export",
      actorId: "actor:user:publisher",
      input: { out_dir: "public" },
    });
    assert.equal(run.run.status, "failed");
    assert.match(run.run.error ?? "", /OpenWiki write in progress: wiki\.apply_proposal/);

    release();
    await holder;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("web-held write lease blocks backup worker jobs on the same workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-web-backup-worker-lock-"));
  try {
    await createWorkspace(root, "Web Backup Worker Lock Wiki");
    let release!: () => void;
    let ready!: () => void;
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const readyPromise = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const holder = withWriteCoordination(
      {
        root,
        operation: "wiki.apply_proposal",
        actorId: "actor:user:web-maintainer",
        waitMs: 0,
      },
      async () => {
        ready();
        await releasePromise;
      },
    );
    await readyPromise;

    const run = await runLocalJob({
      root,
      runType: "backup.create",
      actorId: "actor:user:backup-runner",
      input: { out_dir: "backups" },
    });
    assert.equal(run.run.status, "failed");
    assert.match(run.run.error ?? "", /OpenWiki write in progress: wiki\.apply_proposal/);

    release();
    await holder;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("write coordinator infers Postgres from configured queue backend", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-write-config-backend-"));
  const previousCoordinator = process.env.OPENWIKI_WRITE_COORDINATOR_BACKEND;
  const previousQueue = process.env.OPENWIKI_QUEUE_BACKEND;
  const previousRuntime = process.env.OPENWIKI_RUNTIME_BACKEND;
  try {
    const config = await createWorkspace(root, "Configured Queue Backend Wiki");
    config.runtime = {
      ...config.runtime,
      queue: {
        ...config.runtime?.queue,
        backend: "postgres",
      },
    };
    await writeFile(path.join(root, "openwiki.json"), `${JSON.stringify(config, null, 2)}\n`);
    delete process.env.OPENWIKI_WRITE_COORDINATOR_BACKEND;
    delete process.env.OPENWIKI_QUEUE_BACKEND;
    delete process.env.OPENWIKI_RUNTIME_BACKEND;

    assert.equal(await resolveWriteCoordinatorBackend(root), "postgres");
  } finally {
    restoreEnv("OPENWIKI_WRITE_COORDINATOR_BACKEND", previousCoordinator);
    restoreEnv("OPENWIKI_QUEUE_BACKEND", previousQueue);
    restoreEnv("OPENWIKI_RUNTIME_BACKEND", previousRuntime);
    await rm(root, { recursive: true, force: true });
  }
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
