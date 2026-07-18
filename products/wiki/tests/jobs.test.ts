import { execFile } from "node:child_process";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { createRun, createRunQueue, executeClaimedRun, executeRun, runLocalJob, runNextQueuedJob, runWorker, type RunQueueAdapter } from "@openwiki/jobs";
import {
  inboxStatusesInput,
  optionalBoolean,
  optionalBooleanProperty,
  optionalConnectorKindProperty,
  optionalInboxFailureProperty,
  optionalInboxWatchAdapterProperty,
  optionalNumberProperty,
  optionalString,
  optionalStringProperty,
  requiredString,
  sanitizeRunInput,
  syncRunOutput,
} from "../packages/jobs/src/inputs.ts";
import { createWorkspace, listEvents, listRuns, loadRepository } from "@openwiki/repo";
import { syncWorkspaceNow } from "@openwiki/workflows";
import type { RunRecord } from "@openwiki/core";

const execFileAsync = promisify(execFile);

test("local jobs create durable run records and audit events", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-jobs-"));
  try {
    await createWorkspace(root, "Jobs Wiki");

    const indexRun = await runLocalJob({
      root,
      runType: "index.rebuild",
      actorId: "actor:user:indexer",
    });
    assert.equal(indexRun.run.status, "succeeded");
    assert.equal(indexRun.run.run_type, "index.rebuild");
    assert.ok(((indexRun.run.output as { record_count: number } | undefined)?.record_count ?? 0) >= 3);
    const indexOutput = indexRun.run.output as { index_store_record_count?: number; index_store_edge_count?: number } | undefined;
    assert.ok((indexOutput?.index_store_record_count ?? 0) >= 3);
    assert.ok((indexOutput?.index_store_edge_count ?? 0) > 0);

    const lintRun = await runLocalJob({
      root,
      runType: "lint",
      actorId: "actor:user:reviewer",
    });
    assert.equal(lintRun.run.status, "succeeded");
    assert.equal((lintRun.run.output as { status: string } | undefined)?.status, "passed");

    const runs = await listRuns(root, 10);
    assert.equal(runs.runs.length, 2);
    assert.equal(runs.runs[0]?.status, "succeeded");
    assert.ok(runs.runs.some((run) => run.id === indexRun.run.id));

    const events = await listEvents(root, 20);
    assert.ok(events.events.some((event) => event.type === "run.created" && event.record_id === indexRun.run.id));
    assert.ok(events.events.some((event) => event.type === "run.started" && event.record_id === indexRun.run.id));
    assert.ok(events.events.some((event) => event.type === "run.succeeded" && event.record_id === indexRun.run.id));
    assert.equal(events.events.filter((event) => event.type === "run.succeeded" && event.record_id === indexRun.run.id).length, 1);

    const eventPage = await execFileAsync(
      process.execPath,
      [
        "--no-warnings",
        "--import",
        "tsx",
        path.join(process.cwd(), "packages", "cli", "src", "main.ts"),
        "--root",
        root,
        "events",
        "--actor",
        "actor:user:indexer",
        "--event-type",
        "run.created",
        "--limit",
        "1",
        "--json",
      ],
      { cwd: process.cwd() },
    );
    const eventPageBody = JSON.parse(eventPage.stdout) as {
      events: Array<{ type: string; actor_id: string; record_id?: string }>;
    };
    assert.equal(eventPageBody.events.length, 1);
    assert.equal(eventPageBody.events[0]?.type, "run.created");
    assert.equal(eventPageBody.events[0]?.actor_id, "actor:user:indexer");
    assert.equal(eventPageBody.events[0]?.record_id, indexRun.run.id);

    const auditPage = await execFileAsync(
      process.execPath,
      [
        "--no-warnings",
        "--import",
        "tsx",
        path.join(process.cwd(), "packages", "cli", "src", "main.ts"),
        "--root",
        root,
        "audit",
        "export",
        "--actor",
        "actor:user:indexer",
        "--event-type",
        "run.created",
        "--limit",
        "1",
        "--json",
      ],
      { cwd: process.cwd() },
    );
    const auditPageBody = JSON.parse(auditPage.stdout) as {
      counts: { events: number; timeline: number };
      events: Array<{ type: string; actor_id: string; record_id?: string }>;
      timeline: Array<{ kind: string; id: string }>;
    };
    assert.equal(auditPageBody.counts.events, 1);
    assert.equal(auditPageBody.counts.timeline, 1);
    assert.equal(auditPageBody.events[0]?.type, "run.created");
    assert.equal(auditPageBody.events[0]?.actor_id, "actor:user:indexer");
    assert.equal(auditPageBody.events[0]?.record_id, indexRun.run.id);
    assert.equal(auditPageBody.timeline[0]?.kind, "event");

    const unsafeExportRun = await runLocalJob({
      root,
      runType: "static.export",
      actorId: "actor:user:publisher",
      input: { out_dir: ".." },
    });
    assert.equal(unsafeExportRun.run.status, "failed");
    assert.match(unsafeExportRun.run.error ?? "", /Static export outDir/);

    const repo = await loadRepository(root);
    assert.equal(repo.runs.length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local job execution fails only pre-completion execution errors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-job-failure-"));
  try {
    await createWorkspace(root, "Job Failure Wiki");
    await assert.rejects(
      createRun({
        root,
        runType: "unsupported.job",
        actorId: "actor:user:runner",
      }),
      /Unsupported OpenWiki run type/,
    );

    const queued = await createRun({
      root,
      runType: "static.export",
      actorId: "actor:user:runner",
      input: { out_dir: ".." },
    });
    const result = await executeRun({ root, runId: queued.id, workerId: "actor:agent:worker" });
    assert.equal(result.run.status, "failed");
    assert.match(result.run.error ?? "", /Static export outDir/);

    const events = await listEvents(root, 20);
    assert.equal(events.events.filter((event) => event.type === "run.failed" && event.record_id === queued.id).length, 1);
    assert.equal(events.events.some((event) => event.type === "run.succeeded" && event.record_id === queued.id), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("claimed run execution handles queue completion failures", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-job-completion-failure-"));
  try {
    await createWorkspace(root, "Job Completion Failure Wiki");
    const queue = await createRunQueue(root);
    const queued = await queue.enqueue({
      root,
      runType: "lint",
      actorId: "actor:user:runner",
    });
    const running = await queue.claim(queued.id, "actor:agent:worker");
    let failedMessage = "";
    const failingCompleteQueue: RunQueueAdapter = {
      ...queue,
      async complete() {
        throw new Error("completion write failed");
      },
      async get() {
        return running;
      },
      async fail(run, message) {
        failedMessage = message;
        return {
          ...run,
          status: "failed",
          completed_at: new Date().toISOString(),
          error: message,
        };
      },
    };

    const failed = await executeClaimedRun(root, failingCompleteQueue, running, "actor:agent:worker");
    assert.equal(failed.run.status, "failed");
    assert.match(failedMessage, /completion write failed/);

    const succeededRun: RunRecord = {
      ...running,
      status: "succeeded",
      completed_at: new Date().toISOString(),
      output: { status: "passed" },
    };
    let failCalled = false;
    const alreadyCompletedQueue: RunQueueAdapter = {
      ...queue,
      async complete() {
        throw new Error("event append failed after success");
      },
      async get() {
        return succeededRun;
      },
      async fail() {
        failCalled = true;
        throw new Error("should not fail an already completed run");
      },
    };

    const recovered = await executeClaimedRun(root, alreadyCompletedQueue, running, "actor:agent:worker");
    assert.equal(recovered.run.status, "succeeded");
    assert.equal(failCalled, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hosted runtime mode refuses the local run queue backend", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-hosted-local-queue-"));
  const oldRuntimeMode = process.env.OPENWIKI_RUNTIME_MODE;
  const oldQueueBackend = process.env.OPENWIKI_QUEUE_BACKEND;
  const oldRuntimeBackend = process.env.OPENWIKI_RUNTIME_BACKEND;
  const oldDatabase = process.env.DATABASE_URL;
  const oldOpenWikiDatabase = process.env.OPENWIKI_DATABASE_URL;
  try {
    await createWorkspace(root, "Hosted Queue Guard Wiki");
    process.env.OPENWIKI_RUNTIME_MODE = "hosted";
    delete process.env.OPENWIKI_QUEUE_BACKEND;
    delete process.env.OPENWIKI_RUNTIME_BACKEND;
    delete process.env.DATABASE_URL;
    delete process.env.OPENWIKI_DATABASE_URL;

    await assert.rejects(
      createRunQueue(root),
      /hosted runtime mode requires OPENWIKI_QUEUE_BACKEND=postgres/,
    );
  } finally {
    restoreEnv("OPENWIKI_RUNTIME_MODE", oldRuntimeMode);
    restoreEnv("OPENWIKI_QUEUE_BACKEND", oldQueueBackend);
    restoreEnv("OPENWIKI_RUNTIME_BACKEND", oldRuntimeBackend);
    restoreEnv("DATABASE_URL", oldDatabase);
    restoreEnv("OPENWIKI_DATABASE_URL", oldOpenWikiDatabase);
    await rm(root, { recursive: true, force: true });
  }
});

test("local worker drains queued runs oldest first", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-worker-"));
  try {
    await createWorkspace(root, "Worker Wiki");

    const queuedLint = await createRun({
      root,
      runType: "lint",
      actorId: "actor:user:reviewer",
    });
    const queuedIndex = await createRun({
      root,
      runType: "index.rebuild",
      actorId: "actor:user:indexer",
    });
    assert.equal(queuedLint.status, "queued");
    assert.equal(queuedIndex.status, "queued");

    const next = await runNextQueuedJob({ root, workerId: "actor:agent:worker" });
    assert.equal(next.run?.id, queuedLint.id);
    assert.equal(next.run?.status, "succeeded");

    const remaining = await listRuns(root, 10);
    assert.equal(remaining.runs.find((run) => run.id === queuedIndex.id)?.status, "queued");

    const worker = await runWorker({
      root,
      workerId: "actor:agent:worker",
      once: true,
    });
    assert.equal(worker.processed.length, 1);
    assert.equal(worker.processed[0]?.id, queuedIndex.id);
    assert.equal(worker.processed[0]?.status, "succeeded");

    await assert.rejects(
      executeRun({ root, runId: queuedIndex.id, workerId: "actor:agent:worker" }),
      /expected queued/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runWorker exits when its abort signal is cancelled", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-worker-abort-"));
  try {
    await createWorkspace(root, "Worker Abort Wiki");
    const controller = new AbortController();
    controller.abort();
    const worker = await runWorker({
      root,
      pollMs: 60_000,
      signal: controller.signal,
    });
    assert.deepEqual(worker.processed, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run and event ledgers serialize concurrent append writes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-ledger-locks-"));
  try {
    await createWorkspace(root, "Ledger Lock Wiki");

    const runs = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        createRun({
          root,
          runType: "lint",
          actorId: `actor:user:runner-${index}`,
        }),
      ),
    );

    assert.equal(new Set(runs.map((run) => run.id)).size, runs.length);
    const storedRuns = await listRuns(root, 20);
    assert.equal(storedRuns.runs.length, runs.length);
    assert.equal(new Set(storedRuns.runs.map((run) => run.id)).size, runs.length);

    const events = await listEvents(root, 20);
    const createdEvents = events.events.filter((event) => event.type === "run.created");
    assert.equal(createdEvents.length, runs.length);
    assert.equal(new Set(createdEvents.map((event) => event.id)).size, runs.length);

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--no-warnings",
        "--import",
        "tsx",
        path.join(process.cwd(), "packages", "cli", "src", "main.ts"),
        "--root",
        root,
        "runs",
        "monitor",
        "--status",
        "queued",
        "--json",
      ],
      { cwd: process.cwd() },
    );
    const monitor = JSON.parse(stdout) as { counts: { total: number; queued: number }; recent: Array<{ status: string }> };
    assert.equal(monitor.counts.total, runs.length);
    assert.equal(monitor.counts.queued, runs.length);
    assert.equal(monitor.recent.every((run) => run.status === "queued"), true);

    const audit = await execFileAsync(
      process.execPath,
      [
        "--no-warnings",
        "--import",
        "tsx",
        path.join(process.cwd(), "packages", "cli", "src", "main.ts"),
        "--root",
        root,
        "audit",
        "export",
        "--actor",
        "actor:user:runner-0",
        "--event-type",
        "run.created",
        "--json",
      ],
      { cwd: process.cwd() },
    );
    const auditExport = JSON.parse(audit.stdout) as {
      counts: { events: number; runs: number; timeline: number };
      filters: { actorId: string; eventType: string };
      timeline: Array<{ kind: string }>;
    };
    assert.deepEqual(auditExport.filters, { actorId: "actor:user:runner-0", eventType: "run.created" });
    assert.equal(auditExport.counts.events, 1);
    assert.equal(auditExport.counts.runs, 0);
    assert.equal(auditExport.counts.timeline, 1);
    assert.deepEqual(auditExport.timeline.map((entry) => entry.kind), ["event"]);

    const detail = await execFileAsync(
      process.execPath,
      [
        "--no-warnings",
        "--import",
        "tsx",
        path.join(process.cwd(), "packages", "cli", "src", "main.ts"),
        "--root",
        root,
        "runs",
        "detail",
        runs[0]?.id ?? "",
        "--json",
      ],
      { cwd: process.cwd() },
    );
    const runDetail = JSON.parse(detail.stdout) as { run: { id: string; status: string }; events: Array<{ type: string }> };
    assert.equal(runDetail.run.id, runs[0]?.id);
    assert.equal(runDetail.run.status, "queued");
    assert.ok(runDetail.events.some((event) => event.type === "run.created"));

    const firstEventsPage = await execFileAsync(
      process.execPath,
      [
        "--no-warnings",
        "--import",
        "tsx",
        path.join(process.cwd(), "packages", "cli", "src", "main.ts"),
        "--root",
        root,
        "events",
        "--limit",
        "1",
        "--json",
      ],
      { cwd: process.cwd() },
    );
    const firstEvents = JSON.parse(firstEventsPage.stdout) as { events: Array<{ id: string }>; next_cursor?: string };
    assert.equal(firstEvents.events.length, 1);
    assert.ok(firstEvents.next_cursor);
    const secondEventsPage = await execFileAsync(
      process.execPath,
      [
        "--no-warnings",
        "--import",
        "tsx",
        path.join(process.cwd(), "packages", "cli", "src", "main.ts"),
        "--root",
        root,
        "events",
        "--limit",
        "1",
        "--cursor",
        firstEvents.next_cursor ?? "",
        "--json",
      ],
      { cwd: process.cwd() },
    );
    const secondEvents = JSON.parse(secondEventsPage.stdout) as { events: Array<{ id: string }> };
    assert.equal(secondEvents.events.length, 1);
    assert.notEqual(secondEvents.events[0]?.id, firstEvents.events[0]?.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("syncWorkspaceNow pushes clean workspaces and fails dirty workspaces without auto-committing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-git-sync-job-"));
  const remote = path.join(os.tmpdir(), "openwiki-git-sync-job-" + Date.now() + ".git");
  const restoreLocalGitRemotes = allowLocalGitRemotesForTest();
  try {
    await execFileAsync("git", ["init", "--bare", remote]);
    await createWorkspace(root, "Git Sync Job Wiki");
    await git(root, ["init", "--initial-branch", "main"]);
    await git(root, ["config", "user.name", "OpenWiki Test"]);
    await git(root, ["config", "user.email", "openwiki@example.com"]);
    await git(root, ["remote", "add", "origin", remote]);
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "Initial wiki"]);

    const synced = await syncWorkspaceNow({
      root,
      actorId: "actor:user:syncer",
      pull: false,
      push: true,
    });
    assert.equal(synced.status, "synced");
    assert.deepEqual(synced.operations, ["push"]);
    const localHead = await git(root, ["rev-parse", "HEAD"]);
    const remoteHead = (await execFileAsync("git", ["--git-dir", remote, "rev-parse", "refs/heads/main"])).stdout.trim();
    assert.equal(remoteHead, localHead);

    await appendFile(path.join(root, "wiki", "concepts", "agent-memory.md"), "\nDirty job sync attempts must not auto-commit.\n");
    const dirty = await syncWorkspaceNow({
      root,
      actorId: "actor:user:syncer",
      pull: false,
      push: true,
    });
    assert.equal(dirty.status, "failed");
    assert.match(dirty.error ?? "", /uncommitted changes|auto-commit/);
    assert.notEqual(await git(root, ["status", "--short"]), "");
  } finally {
    restoreLocalGitRemotes();
    await rm(root, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
  }
});

test("job input helpers sanitize persisted payloads and validate typed fields", () => {
  assert.equal(sanitizeRunInput("lint", undefined), undefined);
  const passthrough = { arbitrary: { value: true } };
  assert.equal(sanitizeRunInput("lint", passthrough), passthrough);
  assert.deepEqual(
    sanitizeRunInput("git.sync", {
      remote: "origin",
      branch: "main",
      trigger_event: "inbox.processed",
      trigger_record_id: "inbox:2026-05-31:001",
      pull: true,
      push: false,
      token: "must-not-persist",
    }),
    {
      remote: "origin",
      branch: "main",
      trigger_event: "inbox.processed",
      trigger_record_id: "inbox:2026-05-31:001",
      pull: true,
      push: false,
    },
  );
  assert.deepEqual(
    sanitizeRunInput("backup.create", {
      out_dir: "backups",
      destination_id: "local",
      include_git: true,
      ignored: "value",
    }),
    {
      out_dir: "backups",
      destination_id: "local",
      include_git: true,
    },
  );
  assert.deepEqual(
    sanitizeRunInput("source.fetch", {
      title: "Evidence",
      url: "https://example.com/evidence.txt",
      connector_kind: "github",
      timeout_ms: 1000,
      max_bytes: 2048,
      ignored: "value",
    }),
    {
      title: "Evidence",
      url: "https://example.com/evidence.txt",
      connector_kind: "github",
      timeout_ms: 1000,
      max_bytes: 2048,
    },
  );
  assert.throws(() => sanitizeRunInput("git.sync", { pull: "yes" }), /Expected boolean run input field 'pull'/);
  assert.throws(() => sanitizeRunInput("source.fetch", { title: "Evidence", headers: { authorization: "secret" } }), /Sensitive source\.fetch run input field 'headers'/);
  assert.throws(() => sanitizeRunInput("source.fetch", { connector_kind: "ftp" }), /connector_kind/);
  assert.throws(() => sanitizeRunInput("source.fetch", { timeout_ms: Number.POSITIVE_INFINITY }), /Expected numeric source\.fetch/);

  const input = {
    title: "Inbox item",
    retries: 2,
    dry_run: false,
    connector_kind: "gitlab",
    adapter: "file",
    failure: "sync_failed",
  };
  assert.equal(optionalString(input, "title"), "Inbox item");
  assert.equal(optionalString(input, "missing"), undefined);
  assert.equal(requiredString(input, "title"), "Inbox item");
  assert.deepEqual(optionalStringProperty(input, "title", "outputTitle"), { outputTitle: "Inbox item" });
  assert.deepEqual(optionalNumberProperty(input, "retries", "maxRetries"), { maxRetries: 2 });
  assert.equal(optionalBoolean(input, "dry_run"), false);
  assert.deepEqual(optionalBooleanProperty(input, "dry_run", "dryRun"), { dryRun: false });
  assert.deepEqual(optionalConnectorKindProperty(input, "connector_kind", "connectorKind"), { connectorKind: "gitlab" });
  assert.deepEqual(optionalInboxWatchAdapterProperty(input, "adapter", "adapter"), { adapter: "file" });
  assert.deepEqual(optionalInboxFailureProperty(input, "failure", "failure"), { failure: "sync_failed" });
  assert.throws(() => requiredString({ title: " " }, "title"), /Expected string job input field 'title'/);
  assert.throws(() => optionalString({ title: 42 }, "title"), /Expected string job input field 'title'/);
  assert.throws(() => optionalNumberProperty({ retries: Number.NaN }, "retries", "maxRetries"), /Expected numeric job input field 'retries'/);
  assert.throws(() => optionalConnectorKindProperty({ connector_kind: "ftp" }, "connector_kind", "connectorKind"), /Expected source\.fetch connector_kind/);
  assert.throws(() => optionalInboxWatchAdapterProperty({ adapter: "email" }, "adapter", "adapter"), /Expected inbox\.watch adapter/);
  assert.throws(() => optionalInboxFailureProperty({ failure: "surprise" }, "failure", "failure"), /Expected inbox failure category/);

  assert.deepEqual(inboxStatusesInput("received failed"), ["received", "failed"]);
  assert.deepEqual(inboxStatusesInput(["queued", "proposed"]), ["queued", "proposed"]);
  assert.equal(inboxStatusesInput(undefined), undefined);
  assert.throws(() => inboxStatusesInput(["invalid"]), /Invalid inbox status 'invalid'/);

  assert.deepEqual(
    syncRunOutput({
      root: "/tmp/wiki",
      status: "failed",
      operations: ["pull", "push"],
      before: {
        root: "/tmp/wiki",
        is_git_repo: true,
        branch: "main",
        upstream: "origin/main",
        remote: "origin",
        remote_url: "https://github.com/example/wiki.git",
        ahead: 1,
        behind: 0,
        clean: false,
        conflict_state: "none",
        conflict_paths: [],
        staged_paths: [],
        unstaged_paths: ["wiki/page.md"],
        untracked_paths: [],
        changes: [],
      },
      state: {
        schema_version: "openwiki.git_sync_state.v0",
        updated_at: "2026-05-31T00:00:00.000Z",
      },
      error: "dirty",
      recovery: ["commit first"],
      trigger_event: "inbox.processed",
    }),
    {
      root: "/tmp/wiki",
      status: "failed",
      operations: ["pull", "push"],
      before: {
        is_git_repo: true,
        branch: "main",
        upstream: "origin/main",
        remote: "origin",
        remote_url: "https://github.com/example/wiki.git",
        ahead: 1,
        behind: 0,
        clean: false,
        conflict_state: "none",
        conflict_paths: [],
      },
      state: {
        schema_version: "openwiki.git_sync_state.v0",
        updated_at: "2026-05-31T00:00:00.000Z",
      },
      error: "dirty",
      recovery: ["commit first"],
      trigger_event: "inbox.processed",
    },
  );
});

test("local queue adapter exposes enqueue, claim, complete, and fail primitives", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-queue-"));
  try {
    await createWorkspace(root, "Queue Wiki");
    const queue = await createRunQueue(root);
    assert.equal(queue.backend, "local");

    const queued = await queue.enqueue({
      root,
      runType: "lint",
      actorId: "actor:user:reviewer",
    });
    assert.equal(queued.status, "queued");

    const claimed = await queue.claimNext("actor:agent:queue-worker");
    assert.equal(claimed?.id, queued.id);
    assert.equal(claimed?.status, "running");

    assert.ok(claimed);
    const completed = await queue.complete(claimed, { status: "passed" }, "actor:agent:queue-worker");
    assert.equal(completed.status, "succeeded");
    assert.deepEqual(completed.output, { status: "passed" });

    const failing = await queue.enqueue({
      root,
      runType: "lint",
      actorId: "actor:user:reviewer",
    });
    const claimedFailing = await queue.claim(failing.id, "actor:agent:queue-worker");
    const failed = await queue.fail(claimedFailing, "Unsupported test job", "actor:agent:queue-worker");
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "Unsupported test job");

    const events = await listEvents(root, 20);
    assert.ok(events.events.some((event) => event.type === "run.started" && event.data?.queue_backend === "local"));
    assert.ok(events.events.some((event) => event.type === "run.failed" && event.record_id === failing.id));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", root, ...args]);
  return stdout.trim();
}

function allowLocalGitRemotesForTest(): () => void {
  const previous = process.env.OPENWIKI_ALLOW_LOCAL_GIT_REMOTE;
  process.env.OPENWIKI_ALLOW_LOCAL_GIT_REMOTE = "1";
  return () => {
    if (previous === undefined) {
      delete process.env.OPENWIKI_ALLOW_LOCAL_GIT_REMOTE;
      return;
    }
    process.env.OPENWIKI_ALLOW_LOCAL_GIT_REMOTE = previous;
  };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

test("local queue adapter claims queued runs once under concurrency", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-queue-concurrent-"));
  try {
    await createWorkspace(root, "Queue Concurrency Wiki");
    const queue = await createRunQueue(root);
    const queued = await Promise.all(
      [0, 1, 2].map((index) =>
        queue.enqueue({
          root,
          runType: "lint",
          actorId: `actor:user:queue-${index}`,
        }),
      ),
    );

    const claims = await Promise.all([
      queue.claimNext("actor:agent:queue-a"),
      queue.claimNext("actor:agent:queue-b"),
      queue.claimNext("actor:agent:queue-c"),
    ]);
    const claimedIds = claims.map((run) => run?.id).filter((id): id is string => typeof id === "string");
    assert.deepEqual(new Set(claimedIds), new Set(queued.map((run) => run.id)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worker execution supports optional queue heartbeats", async () => {
  const types = await readFile("packages/jobs/src/types.ts", "utf8");
  const worker = await readFile("packages/jobs/src/worker.ts", "utf8");
  assert.match(types, /heartbeat\?\(run: RunRecord, workerId\?: string\): Promise<void>/);
  assert.match(worker, /startRunHeartbeat\(queue, run, workerId\)/);
  assert.match(worker, /OPENWIKI_RUN_HEARTBEAT_MS/);
});
