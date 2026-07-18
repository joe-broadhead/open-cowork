import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { createRun, createRunQueue, runNextQueuedJob } from "@openwiki/jobs";
import {
  POSTGRES_RUNTIME_MIGRATIONS,
  PostgresWriteLeaseBusyError,
  cancelPostgresRun,
  deletePostgresMcpHttpSession,
  expirePostgresMcpHttpSessions,
  graphCurrentPostgresNeighbors,
  incrementPostgresRateLimitWindow,
  listCurrentPostgresEvents,
  listCurrentPostgresIdentities,
  listCurrentPostgresOpenQuestions,
  listCurrentPostgresProposals,
  listCurrentPostgresRuns,
  listCurrentPostgresSources,
  listCurrentPostgresTopics,
  migratePostgresRuntime,
  checkPostgresRuntimeIntegrity,
  reapStalePostgresRunJobs,
  readPostgresMcpHttpSession,
  readPostgresWriteLease,
  readPostgresRuntimeQueueHealth,
  readCurrentPostgresRun,
  readCurrentPostgresSource,
  readCurrentPostgresGraph,
  readCurrentPostgresWorkspaceIndex,
  rebuildPostgresRuntimeIndex,
  searchCurrentPostgresRuntime,
  syncPostgresRuntimeIndex,
  touchPostgresMcpHttpSession,
  upsertPostgresMcpHttpSession,
  withPostgresWriteLease,
} from "@openwiki/postgres-runtime";
import { routeHttpRequest, startHttpApi } from "@openwiki/http-api";
import { MCP_PROTOCOL_VERSION } from "@openwiki/mcp-server";
import { createWorkspace, renderPageMarkdown } from "@openwiki/repo";
import { proposeEdit, submitInboxItem } from "@openwiki/workflows";

const execFileAsync = promisify(execFile);
const databaseUrl = process.env.OPENWIKI_POSTGRES_TEST_DATABASE_URL ?? process.env.OPENWIKI_DATABASE_URL ?? process.env.DATABASE_URL;

test("Postgres operational state persists MCP sessions and rate-limit windows", { skip: databaseUrl === undefined ? "DATABASE_URL is not configured" : false }, async () => {
  assert.ok(databaseUrl);
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-postgres-operational-"));
  const env = snapshotEnv(["OPENWIKI_DATABASE_URL", "DATABASE_URL"]);
  try {
    await createWorkspace(root, { title: `Postgres Operational ${Date.now()}` });
    process.env.OPENWIKI_DATABASE_URL = databaseUrl;
    process.env.DATABASE_URL = databaseUrl;
    await migratePostgresRuntime({ databaseUrl });

    const now = Date.now();
    const session = {
      id: `session-${now}`,
      root,
      toolMode: "read" as const,
      protocolVersion: MCP_PROTOCOL_VERSION,
      createdAt: now,
      updatedAt: now,
    };
    await upsertPostgresMcpHttpSession({ root, databaseUrl, session, ttlMs: 60_000 });
    const persisted = await readPostgresMcpHttpSession({ root, databaseUrl, sessionId: session.id });
    assert.equal(persisted?.id, session.id);
    assert.equal(persisted?.toolMode, "read");

    await touchPostgresMcpHttpSession({ root, databaseUrl, sessionId: session.id, updatedAt: now + 5000, ttlMs: 60_000 });
    const touched = await readPostgresMcpHttpSession({ root, databaseUrl, sessionId: session.id });
    assert.ok((touched?.updatedAt ?? 0) >= now + 5000);

    await expirePostgresMcpHttpSessions({ root, databaseUrl, now: now + 120_000 });
    assert.equal(await readPostgresMcpHttpSession({ root, databaseUrl, sessionId: session.id }), undefined);

    const first = await incrementPostgresRateLimitWindow({
      root,
      databaseUrl,
      key: `search|/api/v1/search|token|${now}`,
      now,
      windowMs: 60_000,
      maxKeys: 100,
    });
    const second = await incrementPostgresRateLimitWindow({
      root,
      databaseUrl,
      key: `search|/api/v1/search|token|${now}`,
      now: now + 10,
      windowMs: 60_000,
      maxKeys: 100,
    });
    assert.equal(first.count, 1);
    assert.equal(second.count, 2);

    await deletePostgresMcpHttpSession({ root, databaseUrl, sessionId: session.id });
    assert.equal(await readPostgresMcpHttpSession({ root, databaseUrl, sessionId: session.id }), undefined);
  } finally {
    restoreEnv(env);
    await rm(root, { recursive: true, force: true });
  }
});

test("served HTTP operational_state=postgres shares MCP sessions and rate limits across server instances", { skip: databaseUrl === undefined ? "DATABASE_URL is not configured" : false }, async () => {
  assert.ok(databaseUrl);
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-postgres-http-operational-"));
  const env = snapshotEnv([
    "OPENWIKI_DATABASE_URL",
    "DATABASE_URL",
    "OPENWIKI_OPERATIONAL_STATE_BACKEND",
    "OPENWIKI_RATE_LIMIT_ENABLED",
    "OPENWIKI_RATE_LIMIT_WINDOW_MS",
    "OPENWIKI_RATE_LIMIT_SEARCH",
    "OPENWIKI_RATE_LIMIT_MCP",
  ]);
  let serverA: Awaited<ReturnType<typeof startHttpApi>> | undefined;
  let serverB: Awaited<ReturnType<typeof startHttpApi>> | undefined;
  try {
    await createWorkspace(root, { title: `Postgres HTTP Operational ${Date.now()}` });
    process.env.OPENWIKI_DATABASE_URL = databaseUrl;
    process.env.DATABASE_URL = databaseUrl;
    process.env.OPENWIKI_OPERATIONAL_STATE_BACKEND = "postgres";
    process.env.OPENWIKI_RATE_LIMIT_ENABLED = "1";
    process.env.OPENWIKI_RATE_LIMIT_WINDOW_MS = "60000";
    process.env.OPENWIKI_RATE_LIMIT_SEARCH = "1";
    process.env.OPENWIKI_RATE_LIMIT_MCP = "100";

    const defaultPolicy = { actorId: "actor:user:postgres-ops", role: "admin" as const };
    serverA = await startHttpApi({ root, port: 0, defaultPolicy });
    serverB = await startHttpApi({ root, port: 0, defaultPolicy });

    const firstSearch = await fetch(`${serverA.url}/api/v1/search?q=agent&limit=1`);
    assert.equal(firstSearch.status, 200);
    const secondSearch = await fetch(`${serverB.url}/api/v1/search?q=agent&limit=1`);
    assert.equal(secondSearch.status, 429);

    const initialize = await fetch(`${serverA.url}/mcp?tools=read`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": MCP_PROTOCOL_VERSION,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "init",
        method: "initialize",
      }),
    });
    assert.equal(initialize.status, 200);
    const sessionId = initialize.headers.get("mcp-session-id");
    assert.ok(sessionId);

    await serverA.close({ timeoutMs: 1000 });
    serverA = undefined;

    const stream = await fetch(`${serverB.url}/mcp?once=true`, {
      headers: {
        accept: "text/event-stream",
        "mcp-protocol-version": MCP_PROTOCOL_VERSION,
        "mcp-session-id": sessionId,
      },
    });
    assert.equal(stream.status, 200);
    assert.equal(stream.headers.get("mcp-session-id"), sessionId);
    assert.match(await stream.text(), /openwiki mcp stream/);
  } finally {
    if (serverA !== undefined) {
      await serverA.close({ timeoutMs: 1000 });
    }
    if (serverB !== undefined) {
      await serverB.close({ timeoutMs: 1000 });
    }
    restoreEnv(env);
    await rm(root, { recursive: true, force: true });
  }
});

test("live Postgres runtime sync serves reads, search, graph, proposals, and queue claims", { skip: databaseUrl === undefined ? "DATABASE_URL is not configured" : false }, async () => {
  assert.ok(databaseUrl);
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-postgres-live-"));
  const env = snapshotEnv([
    "OPENWIKI_DATABASE_URL",
    "DATABASE_URL",
    "OPENWIKI_READ_BACKEND",
    "OPENWIKI_SEARCH_BACKEND",
    "OPENWIKI_QUEUE_BACKEND",
    "OPENWIKI_OPERATIONAL_STATE_BACKEND",
    "OPENWIKI_WRITE_COORDINATOR_BACKEND",
    "OPENWIKI_RUN_STALE_AFTER_MS",
  ]);
  try {
    await createWorkspace(root, { template: "personal-wiki", title: `Postgres Live ${Date.now()}` });
    await writeFilteredSearchFixturePages(root);
    await git(root, ["init"]);
    await git(root, ["config", "user.name", "OpenWiki Postgres Test"]);
    await git(root, ["config", "user.email", "openwiki-postgres@example.com"]);
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "Initial wiki"]);

    process.env.OPENWIKI_DATABASE_URL = databaseUrl;
    process.env.DATABASE_URL = databaseUrl;
    process.env.OPENWIKI_READ_BACKEND = "postgres";
    process.env.OPENWIKI_SEARCH_BACKEND = "postgres";
    process.env.OPENWIKI_QUEUE_BACKEND = "postgres";
    process.env.OPENWIKI_OPERATIONAL_STATE_BACKEND = "postgres";
    process.env.OPENWIKI_WRITE_COORDINATOR_BACKEND = "postgres";

    const migrated = await migratePostgresRuntime({ databaseUrl });
    assert.ok(migrated.applied.includes("0001_runtime_schema") || migrated.skipped.includes("0001_runtime_schema"));
    const remigrated = await migratePostgresRuntime({ databaseUrl });
    assert.deepEqual(remigrated.applied, []);
    assert.deepEqual(
      new Set(remigrated.skipped),
      new Set(POSTGRES_RUNTIME_MIGRATIONS.map((migration) => migration.id)),
    );

    let releaseWriteLease!: () => void;
    let writeLeaseReady!: () => void;
    const releaseWriteLeasePromise = new Promise<void>((resolve) => {
      releaseWriteLease = resolve;
    });
    const writeLeaseReadyPromise = new Promise<void>((resolve) => {
      writeLeaseReady = resolve;
    });
    const heldWriteLease = withPostgresWriteLease(
      {
        root,
        databaseUrl,
        actorId: "actor:user:postgres-writer-a",
        operation: "test.postgres_write_a",
        leaseMs: 5000,
        heartbeatMs: 500,
      },
      async () => {
        writeLeaseReady();
        await releaseWriteLeasePromise;
      },
    );
    await writeLeaseReadyPromise;
    const activeLease = await readPostgresWriteLease(root, { databaseUrl });
    assert.equal(activeLease?.operation, "test.postgres_write_a");
    assert.equal(activeLease?.actor_id, "actor:user:postgres-writer-a");
    await assert.rejects(
      withPostgresWriteLease(
        {
          root,
          databaseUrl,
          actorId: "actor:user:postgres-writer-b",
          operation: "test.postgres_write_b",
          leaseMs: 5000,
          heartbeatMs: 500,
        },
        async () => "unexpected",
      ),
      (error: unknown) => {
        assert.ok(error instanceof PostgresWriteLeaseBusyError);
        assert.equal(error.active.operation, "test.postgres_write_a");
        return true;
      },
    );
    releaseWriteLease();
    await heldWriteLease;
    await withPostgresWriteLease(
      {
        root,
        databaseUrl,
        actorId: "actor:user:postgres-writer-b",
        operation: "test.postgres_write_b",
        leaseMs: 5000,
        heartbeatMs: 500,
      },
      async () => "released",
    );

    const synced = await rebuildPostgresRuntimeIndex(root, { databaseUrl });
    assert.equal(synced.source, "postgres-runtime");
    assert.ok(synced.record_count >= 4);
    assert.ok(synced.edge_count > 0);

    const workspace = await readCurrentPostgresWorkspaceIndex(root);
    assert.equal(workspace?.source, "postgres-runtime");
    assert.ok((workspace?.counts.pages ?? 0) >= 113);
    assert.equal(workspace?.counts.sources, 1);
    const sources = await listCurrentPostgresSources(root);
    assert.equal(sources?.source, "postgres-runtime");
    assert.equal(sources?.sources[0]?.id, "source:2026-05-21-001");
    const source = await readCurrentPostgresSource(root, "source:2026-05-21-001");
    assert.equal(source?.title, "Personal OpenWiki Starter Notes");

    const graph = await readCurrentPostgresGraph(root);
    assert.ok(graph?.edges.some((edge) => edge.edge_type === "page_source"));
    const neighbors = await graphCurrentPostgresNeighbors(root, "page:concept:personal-knowledge-base", { depth: 2 });
    assert.ok(neighbors?.nodes.some((node) => node.id === "source:2026-05-21-001"));
    assert.equal(new Set((neighbors?.edges ?? []).map((edge) => edge.id)).size, neighbors?.edges.length ?? 0);
    const topics = await listCurrentPostgresTopics(root);
    assert.equal(topics?.source, "postgres-runtime");
    assert.ok((topics?.topics.length ?? 0) > 0);
    const openQuestions = await listCurrentPostgresOpenQuestions(root);
    assert.equal(openQuestions?.source, "postgres-runtime");
    assert.ok(Array.isArray(openQuestions?.open_questions));

    const search = await searchCurrentPostgresRuntime(root, { query: "personal knowledge", limit: 5, include_explain: true });
    assert.ok(search?.results.some((result) => result.id === "page:concept:personal-knowledge-base"));
    assert.equal(search?.explain?.ranking_signals.includes("postgres_runtime_search_documents"), true);
    assert.equal(search?.explain?.diagnostics?.backend, "postgres");
    assert.ok((search?.explain?.diagnostics?.scanned_rows ?? 0) > 0);

    const filteredSearch = await searchCurrentPostgresRuntime(root, {
      query: "postgres filtered parity marker",
      limit: 1,
      types: ["page"],
      filters: { status: ["draft"], topics: ["postgres-filtered-parity"] },
      include_explain: true,
    });
    assert.equal(filteredSearch?.results.length, 1);
    const filteredResult = filteredSearch?.results[0];
    assert.equal(filteredResult?.type, "page");
    assert.match(filteredResult?.id ?? "", /^page:postgres-filtered:match-/);
    assert.equal(filteredSearch?.total_relation, "capped");
    assert.equal(filteredSearch?.facets_relation, "capped");
    assert.ok(filteredSearch?.next_cursor);
    assert.equal(filteredSearch?.facets?.types.page, 100);
    assert.equal(filteredSearch?.facets?.status.draft, 100);
    assert.equal(filteredSearch?.facets?.topics["postgres-filtered-parity"], 100);
    assert.equal(filteredSearch?.explain?.diagnostics?.backend, "postgres");
    assert.ok((filteredSearch?.explain?.diagnostics?.scanned_rows ?? 0) >= 100);

    const filteredSecondPage = await searchCurrentPostgresRuntime(root, {
      query: "postgres filtered parity marker",
      limit: 1,
      offset: 1,
      types: ["page"],
      filters: { status: ["draft"], topics: ["postgres-filtered-parity"] },
    });
    assert.equal(filteredSecondPage?.results.length, 1);
    assert.notEqual(filteredSecondPage?.results[0]?.id, filteredSearch?.results[0]?.id);

    await appendFile(
      path.join(root, "wiki", "concepts", "personal-knowledge-base.md"),
      "\n\nDirty Postgres runtime fallback coverage.\n",
    );
    const dirtySearch = await searchCurrentPostgresRuntime(root, { query: "Dirty Postgres runtime fallback", limit: 5 });
    assert.equal(dirtySearch, undefined);
    const dirtyIntegrity = await checkPostgresRuntimeIntegrity(root, { databaseUrl });
    assert.equal(dirtyIntegrity.ok, false);
    assert.ok(dirtyIntegrity.issues.some((issue) => issue.includes("content hash mismatch")));
    const dirtySync = await syncPostgresRuntimeIndex(root, { databaseUrl });
    assert.equal(dirtySync.mode, "rebuild");
    const refreshedDirtySearch = await searchCurrentPostgresRuntime(root, { query: "Dirty Postgres runtime fallback", limit: 5 });
    assert.ok(refreshedDirtySearch?.results.some((result) => result.id === "page:concept:personal-knowledge-base"));

    const noGitRoot = await mkdtemp(path.join(os.tmpdir(), "openwiki-postgres-no-git-"));
    try {
      await createWorkspace(noGitRoot, { template: "personal-wiki", title: `Postgres No Git ${Date.now()}` });
      await rebuildPostgresRuntimeIndex(noGitRoot, { databaseUrl });
      const noGitSearch = await searchCurrentPostgresRuntime(noGitRoot, { query: "personal knowledge", limit: 5 });
      assert.ok(noGitSearch?.results.some((result) => result.id === "page:concept:personal-knowledge-base"));
      await appendFile(
        path.join(noGitRoot, "wiki", "concepts", "personal-knowledge-base.md"),
        "\n\nNon-git Postgres runtime freshness coverage.\n",
      );
      const staleNoGitSearch = await searchCurrentPostgresRuntime(noGitRoot, { query: "Non-git Postgres runtime freshness", limit: 5 });
      assert.equal(staleNoGitSearch, undefined);
      const noGitIntegrity = await checkPostgresRuntimeIntegrity(noGitRoot, { databaseUrl });
      assert.equal(noGitIntegrity.current_commit, "uncommitted");
      assert.equal(noGitIntegrity.ok, false);
      assert.ok(noGitIntegrity.issues.some((issue) => issue.includes("content hash mismatch")));
      await syncPostgresRuntimeIndex(noGitRoot, { databaseUrl });
      const refreshedNoGitSearch = await searchCurrentPostgresRuntime(noGitRoot, { query: "Non-git Postgres runtime freshness", limit: 5 });
      assert.ok(refreshedNoGitSearch?.results.some((result) => result.id === "page:concept:personal-knowledge-base"));
    } finally {
      await rm(noGitRoot, { recursive: true, force: true });
    }

    const otherRoot = await mkdtemp(path.join(os.tmpdir(), "openwiki-postgres-other-"));
    try {
      await createWorkspace(otherRoot, { title: `Postgres Other ${Date.now()}` });
      await addServiceAccount(otherRoot, {
        id: "tenant-b-reader",
        actor_id: "actor:agent:tenant-b-reader",
        role: "viewer",
        principals: ["group:tenant-b"],
        token_hashes: ["sha256:tenant-b-reader"],
      });
      await git(otherRoot, ["init"]);
      await git(otherRoot, ["config", "user.name", "OpenWiki Postgres Test"]);
      await git(otherRoot, ["config", "user.email", "openwiki-postgres@example.com"]);
      await git(otherRoot, ["add", "."]);
      await git(otherRoot, ["commit", "-m", "Initial other wiki"]);
      await rebuildPostgresRuntimeIndex(otherRoot, { databaseUrl });
      const rootIdentities = await listCurrentPostgresIdentities(root);
      const otherIdentities = await listCurrentPostgresIdentities(otherRoot);
      assert.equal(rootIdentities?.source, "postgres-runtime");
      assert.equal(otherIdentities?.source, "postgres-runtime");
      const rootConfig = await readJson<{ workspace_id: string }>(root, "openwiki.json");
      assert.equal(rootIdentities?.workspace_id, rootConfig.workspace_id);
      assert.ok(otherIdentities?.groups.some((group) => group.id === "group:tenant-b"));
      assert.equal(rootIdentities?.groups.some((group) => group.id === "group:tenant-b"), false);
      assert.equal(rootIdentities?.principals.some((principal) => principal.id === "actor:agent:tenant-b-reader"), false);
      assert.equal(
        rootIdentities?.principal_groups.some(
          (entry) => entry.principal_id === "actor:agent:tenant-b-reader" || entry.group_id === "group:tenant-b",
        ),
        false,
      );
    } finally {
      await rm(otherRoot, { recursive: true, force: true });
    }

    const initialIntegrity = await checkPostgresRuntimeIntegrity(root, { databaseUrl });
    assert.equal(initialIntegrity.ok, true);
    assert.equal(initialIntegrity.migrations.missing.length, 0);
    assert.deepEqual(new Set(initialIntegrity.migrations.expected), new Set(POSTGRES_RUNTIME_MIGRATIONS.map((migration) => migration.id)));

    const adminPolicy = { actorId: "actor:user:postgres-admin", role: "admin" as const };
    const httpIndex = await routeHttpRequest(root, "GET", "/api/v1/index", undefined, adminPolicy);
    assert.equal(httpIndex.status, 200);
    assert.equal((httpIndex.body as { serving_layer?: string }).serving_layer, "postgres-runtime");
    const runtime = (httpIndex.body as {
      runtime?: {
        postgres_configured?: boolean;
        read_backend?: string;
        search_backend?: string;
        queue_backend?: string;
        operational_state_backend?: string;
        write_coordinator_backend?: string;
      };
    }).runtime;
    assert.equal(runtime?.postgres_configured, true);
    assert.equal(runtime?.read_backend, "postgres");
    assert.equal(runtime?.search_backend, "postgres");
    assert.equal(runtime?.queue_backend, "postgres");
    assert.equal(runtime?.operational_state_backend, "postgres");
    assert.equal(runtime?.write_coordinator_backend, "postgres");

    const httpHealth = await routeHttpRequest(root, "GET", "/api/v1/health", undefined, adminPolicy);
    assert.equal(httpHealth.status, 200);
    assert.equal((httpHealth.body as { components?: { postgres_runtime?: { ok?: boolean } } }).components?.postgres_runtime?.ok, true);
    assert.equal((httpHealth.body as { components?: { queue?: { backend?: string } } }).components?.queue?.backend, "postgres");
    assert.equal(typeof (httpHealth.body as { components?: { queue?: { stale_running_jobs?: unknown } } }).components?.queue?.stale_running_jobs, "number");
    assert.equal((httpHealth.body as { components?: { write_lease?: { active?: boolean } } }).components?.write_lease?.active, false);
    assert.equal((httpHealth.body as { components?: { object_storage?: { backend?: string } } }).components?.object_storage?.backend, "local");

    await appendFile(path.join(root, "wiki", "concepts", "personal-knowledge-base.md"), "\n\nCommitted incremental Postgres sync coverage.\n");
    await git(root, ["add", "wiki/concepts/personal-knowledge-base.md"]);
    await git(root, ["commit", "-m", "Exercise incremental Postgres sync"]);
    const incremental = await syncPostgresRuntimeIndex(root, { databaseUrl });
    assert.equal(incremental.mode, "incremental");
    assert.ok(incremental.changed_paths.includes("wiki/concepts/personal-knowledge-base.md"));
    assert.ok(incremental.upserted_record_count > 0);
    const incrementalIntegrity = await checkPostgresRuntimeIntegrity(root, { databaseUrl });
    assert.equal(incrementalIntegrity.ok, true);

    await unlink(path.join(root, "wiki", "projects", "active-projects.md"));
    await git(root, ["add", "-A"]);
    await git(root, ["commit", "-m", "Exercise incremental Postgres deletion sync"]);
    const deletionSync = await syncPostgresRuntimeIndex(root, { databaseUrl });
    assert.equal(deletionSync.mode, "incremental");
    assert.ok(deletionSync.changed_paths.includes("wiki/projects/active-projects.md"));
    const afterDeleteWorkspace = await readCurrentPostgresWorkspaceIndex(root);
    assert.ok((afterDeleteWorkspace?.counts.pages ?? 0) >= 112);
    const deletedSearch = await searchCurrentPostgresRuntime(root, { query: "Active Projects", limit: 5, types: ["page"] });
    assert.equal(deletedSearch?.results.some((result) => result.id === "page:project:active-projects"), false);
    const deletionIntegrity = await checkPostgresRuntimeIntegrity(root, { databaseUrl });
    assert.equal(deletionIntegrity.ok, true);

    await mkdir(path.join(root, "wiki", "reference"), { recursive: true });
    await rename(
      path.join(root, "wiki", "concepts", "personal-knowledge-base.md"),
      path.join(root, "wiki", "reference", "personal-knowledge-base.md"),
    );
    await git(root, ["add", "-A"]);
    await git(root, ["commit", "-m", "Exercise incremental Postgres rename sync"]);
    const renameSync = await syncPostgresRuntimeIndex(root, { databaseUrl });
    assert.equal(renameSync.mode, "incremental");
    assert.ok(renameSync.changed_paths.includes("wiki/concepts/personal-knowledge-base.md"));
    assert.ok(renameSync.changed_paths.includes("wiki/reference/personal-knowledge-base.md"));
    const renamedSearch = await searchCurrentPostgresRuntime(root, { query: "Personal Knowledge Base", limit: 5, types: ["page"] });
    assert.ok(renamedSearch?.results.some((result) => result.id === "page:concept:personal-knowledge-base"));
    const renameIntegrity = await checkPostgresRuntimeIntegrity(root, { databaseUrl });
    assert.equal(renameIntegrity.ok, true);

    const proposal = await proposeEdit({
      root,
      pageId: "page:concept:personal-knowledge-base",
      actorId: "actor:user:postgres-live",
      rationale: "Exercise Postgres proposal reads.",
      body: "# Personal Knowledge Base\n\nPostgres runtime reads should include proposed edits after sync.",
    });
    await rebuildPostgresRuntimeIndex(root, { databaseUrl });
    const proposals = await listCurrentPostgresProposals(root, {
      statuses: ["open"],
      actorId: "actor:user:postgres-live",
      targetId: "page:concept:personal-knowledge-base",
    });
    assert.equal(proposals?.source, "postgres-runtime");
    assert.equal(proposals?.proposals[0]?.id, proposal.proposal.id);
    const events = await listCurrentPostgresEvents(root, 10);
    assert.equal(events?.source, "postgres-runtime");
    assert.ok(events?.events.some((event) => event.type === "proposal.created"));

    const queued = await createRun({ root, runType: "lint", actorId: "actor:user:postgres-runner" });
    assert.equal(queued.status, "queued");
    const queueBefore = await readPostgresRuntimeQueueHealth(root, { databaseUrl });
    assert.equal(queueBefore?.runs.queued, 1);
    assert.equal(queueBefore?.jobs.queued, 1);
    const run = await runNextQueuedJob({ root, workerId: "actor:agent:postgres-worker" });
    assert.equal(run.run?.id, queued.id);
    assert.equal(run.run?.status, "succeeded");
    const runDetail = await readCurrentPostgresRun(root, queued.id);
    assert.equal(runDetail?.job?.status, "succeeded");
    assert.equal(runDetail?.attempts.length, 1);
    assert.equal(runDetail?.attempts[0]?.status, "succeeded");
    assert.equal(runDetail?.attempts[0]?.worker_id, "actor:agent:postgres-worker");
    const queueAfter = await readPostgresRuntimeQueueHealth(root, { databaseUrl });
    assert.equal(queueAfter?.runs.succeeded, 1);
    assert.equal(queueAfter?.jobs.succeeded, 1);
    const runs = await listCurrentPostgresRuns(root, 10);
    assert.equal(runs?.source, "postgres-runtime");
    assert.ok(runs?.runs.some((candidate) => candidate.id === queued.id && candidate.status === "succeeded"));

    const inbox = await submitInboxItem({
      root,
      title: "Postgres inbox transcript",
      content: "Postgres queue should process this inbox item.",
      inboxKind: "meeting_transcript",
      provider: "transcript_file",
      ownerActorId: "actor:user:postgres-runner",
      submittedBy: "actor:user:postgres-runner",
    });
    await rebuildPostgresRuntimeIndex(root, { databaseUrl });
    const inboxRun = await createRun({
      root,
      runType: "inbox.process",
      actorId: "actor:user:postgres-runner",
      input: { id: inbox.item.id },
    });
    const inboxRunResult = await runNextQueuedJob({ root, workerId: "actor:agent:postgres-inbox-worker" });
    assert.equal(inboxRunResult.run?.id, inboxRun.id);
    assert.equal(inboxRunResult.run?.status, "succeeded");
    await git(root, ["add", "-A"]);
    await git(root, ["commit", "-m", "Process inbox item through Postgres queue"]);
    await rebuildPostgresRuntimeIndex(root, { databaseUrl });
    const inboxRunDetail = await readCurrentPostgresRun(root, inboxRun.id);
    assert.equal(inboxRunDetail?.run.run_type, "inbox.process");
    assert.equal(inboxRunDetail?.run.status, "succeeded");
    assert.equal(inboxRunDetail?.run.output?.inbox_item_id, inbox.item.id);

    const queue = await createRunQueue(root);
    const concurrentQueued = [];
    for (const index of [0, 1, 2]) {
      concurrentQueued.push(
        await queue.enqueue({
          root,
          runType: "lint",
          actorId: `actor:user:postgres-concurrent-${index}`,
        }),
      );
    }
    const concurrentWorkers = [
      "actor:agent:postgres-worker-a",
      "actor:agent:postgres-worker-b",
      "actor:agent:postgres-worker-c",
    ];
    const concurrentClaims = await Promise.all(concurrentWorkers.map((workerId) => queue.claimNext(workerId)));
    assert.equal(concurrentClaims.length, 3);
    assert.ok(concurrentClaims.every((run) => run?.status === "running"));
    const claimedIds = concurrentClaims.map((run) => run?.id).filter((id): id is string => typeof id === "string");
    assert.deepEqual(new Set(claimedIds), new Set(concurrentQueued.map((run) => run.id)));
    for (const [index, run] of concurrentClaims.entries()) {
      assert.ok(run);
      const workerId = concurrentWorkers[index];
      assert.ok(workerId);
      await queue.complete(run, { concurrent_claim: true, index }, workerId);
    }
    const concurrentQueue = await readPostgresRuntimeQueueHealth(root, { databaseUrl });
    assert.equal(concurrentQueue?.jobs.running, 0);

    const retrying = await createRun({
      root,
      runType: "static.export",
      actorId: "actor:user:postgres-runner",
      input: { out_dir: "../outside-workspace", max_attempts: 2 },
    });
    const firstAttempt = await runNextQueuedJob({ root, workerId: "actor:agent:postgres-worker" });
    assert.equal(firstAttempt.run?.id, retrying.id);
    assert.equal(firstAttempt.run?.status, "queued");
    const retryQueue = await readPostgresRuntimeQueueHealth(root, { databaseUrl });
    assert.equal(retryQueue?.runs.queued, 1);
    assert.equal(retryQueue?.jobs.queued, 1);
    const secondAttempt = await runNextQueuedJob({ root, workerId: "actor:agent:postgres-worker" });
    assert.equal(secondAttempt.run?.id, retrying.id);
    assert.equal(secondAttempt.run?.status, "failed");
    const retryDetail = await readCurrentPostgresRun(root, retrying.id);
    assert.equal(retryDetail?.attempts.length, 2);
    assert.deepEqual(retryDetail?.attempts.map((attempt) => attempt.status), ["failed", "failed"]);
    assert.equal(retryDetail?.attempts.every((attempt) => attempt.error !== undefined), true);
    const failedQueue = await readPostgresRuntimeQueueHealth(root, { databaseUrl });
    assert.equal(failedQueue?.runs.failed, 1);
    assert.equal(failedQueue?.jobs.failed, 1);
    const retryEvents = await listCurrentPostgresEvents(root, 20);
    assert.ok(retryEvents?.events.some((event) => event.type === "run.retry_scheduled" && event.record_id === retrying.id));

    const staleCandidate = await queue.enqueue({
      root,
      runType: "lint",
      actorId: "actor:user:postgres-stale",
      input: { max_attempts: 2 },
    });
    const staleRunning = await queue.claim(staleCandidate.id, "actor:agent:postgres-stale-worker");
    assert.equal(staleRunning.status, "running");
    await sleep(1100);
    process.env.OPENWIKI_RUN_STALE_AFTER_MS = "1000";
    const staleHealth = await readPostgresRuntimeQueueHealth(root, { databaseUrl });
    assert.ok((staleHealth?.stale_running_jobs ?? 0) >= 1);
    const dryReap = await reapStalePostgresRunJobs(root, { databaseUrl, maxRuntimeMs: 1000, dryRun: true });
    assert.ok(dryReap.retried.includes(staleCandidate.id));
    const reap = await reapStalePostgresRunJobs(root, { databaseUrl, maxRuntimeMs: 1000, workerId: "actor:agent:postgres-reaper" });
    assert.ok(reap.retried.includes(staleCandidate.id));
    const reapedDetail = await readCurrentPostgresRun(root, staleCandidate.id);
    assert.equal(reapedDetail?.run.status, "queued");
    assert.ok(reapedDetail?.attempts.some((attempt) => attempt.status === "failed" && attempt.worker_id === "actor:agent:postgres-reaper"));

    const cancellable = await queue.enqueue({
      root,
      runType: "lint",
      actorId: "actor:user:postgres-cancellable",
    });
    const cancelled = await cancelPostgresRun(root, cancellable.id, {
      databaseUrl,
      actorId: "actor:user:postgres-admin",
      reason: "integration test cancellation",
    });
    assert.equal(cancelled.previous_status, "queued");
    assert.equal(cancelled.run.status, "failed");
    assert.equal(cancelled.run.error, "integration test cancellation");

    const firstFilteredEventPage = await routeHttpRequest(
      root,
      "GET",
      "/api/v1/events?event_type=run.created&actor_id=actor:user:postgres-runner&limit=1",
      undefined,
      adminPolicy,
    );
    assert.equal(firstFilteredEventPage.status, 200);
    const firstFilteredEventPageBody = firstFilteredEventPage.body as {
      events: Array<{ id: string; type: string; actor_id: string }>;
      next_cursor?: string;
    };
    assert.equal(firstFilteredEventPageBody.events.length, 1);
    assert.ok(firstFilteredEventPageBody.next_cursor);
    assert.equal(firstFilteredEventPageBody.events[0]?.type, "run.created");
    assert.equal(firstFilteredEventPageBody.events[0]?.actor_id, "actor:user:postgres-runner");
    const secondFilteredEventPage = await routeHttpRequest(
      root,
      "GET",
      `/api/v1/events?event_type=run.created&actor_id=actor:user:postgres-runner&limit=1&cursor=${encodeURIComponent(firstFilteredEventPageBody.next_cursor ?? "")}`,
      undefined,
      adminPolicy,
    );
    assert.equal(secondFilteredEventPage.status, 200);
    const secondFilteredEventPageBody = secondFilteredEventPage.body as {
      events: Array<{ id: string; type: string; actor_id: string }>;
    };
    assert.equal(secondFilteredEventPageBody.events.length, 1);
    assert.notEqual(secondFilteredEventPageBody.events[0]?.id, firstFilteredEventPageBody.events[0]?.id);
    assert.equal(secondFilteredEventPageBody.events[0]?.type, "run.created");
    assert.equal(secondFilteredEventPageBody.events[0]?.actor_id, "actor:user:postgres-runner");

    const firstAuditPage = await routeHttpRequest(
      root,
      "GET",
      "/api/v1/audit/export?event_type=run.created&actor_id=actor:user:postgres-runner&limit=1",
      undefined,
      adminPolicy,
    );
    assert.equal(firstAuditPage.status, 200);
    const firstAuditPageBody = firstAuditPage.body as {
      counts: { events: number; timeline: number };
      events: Array<{ id: string }>;
      timeline: Array<{ kind: string; id: string }>;
      next_cursor?: string;
      next_timeline_cursor?: string;
    };
    assert.equal(firstAuditPageBody.counts.events, 1);
    assert.equal(firstAuditPageBody.counts.timeline, 1);
    assert.ok(firstAuditPageBody.next_cursor);
    assert.ok(firstAuditPageBody.next_timeline_cursor);
    assert.equal(firstAuditPageBody.timeline[0]?.kind, "event");
    const secondAuditPage = await routeHttpRequest(
      root,
      "GET",
      `/api/v1/audit/export?event_type=run.created&actor_id=actor:user:postgres-runner&limit=1&cursor=${encodeURIComponent(
        firstAuditPageBody.next_cursor ?? "",
      )}&timeline_cursor=${encodeURIComponent(firstAuditPageBody.next_timeline_cursor ?? "")}`,
      undefined,
      adminPolicy,
    );
    assert.equal(secondAuditPage.status, 200);
    const secondAuditPageBody = secondAuditPage.body as {
      counts: { events: number; timeline: number };
      events: Array<{ id: string }>;
      timeline: Array<{ kind: string; id: string }>;
    };
    assert.equal(secondAuditPageBody.counts.events, 1);
    assert.equal(secondAuditPageBody.counts.timeline, 1);
    assert.notEqual(secondAuditPageBody.events[0]?.id, firstAuditPageBody.events[0]?.id);
    assert.notEqual(secondAuditPageBody.timeline[0]?.id, firstAuditPageBody.timeline[0]?.id);
    assert.equal(secondAuditPageBody.timeline[0]?.kind, "event");

    const eventStream = await routeHttpRequest(root, "GET", "/api/v1/events/stream?once=true&limit=20", undefined, adminPolicy);
    assert.equal(eventStream.status, 200);
    assert.match(String(eventStream.body), /event: run\.retry_scheduled/);
    const audit = await routeHttpRequest(root, "GET", "/api/v1/audit/export?limit=20", undefined, adminPolicy);
    assert.equal(audit.status, 200);
    assert.ok((audit.body as { counts?: { events?: number; runs?: number } }).counts?.events);
    assert.ok((audit.body as { counts?: { events?: number; runs?: number } }).counts?.runs);
  } finally {
    restoreEnv(env);
    await rm(root, { recursive: true, force: true });
  }
});

async function git(root: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd: root });
  return result.stdout.trim();
}

async function readJson<T>(root: string, repoPath: string): Promise<T> {
  return JSON.parse(await readFile(path.join(root, repoPath), "utf8")) as T;
}

async function addServiceAccount(root: string, serviceAccount: Record<string, unknown>): Promise<void> {
  const config = await readJson<{ auth?: { service_accounts?: Array<Record<string, unknown>> } }>(root, "openwiki.json");
  config.auth = {
    service_accounts: [...(config.auth?.service_accounts ?? []), serviceAccount],
  };
  await writeFile(path.join(root, "openwiki.json"), `${JSON.stringify(config, null, 2)}\n`);
}

async function writeFilteredSearchFixturePages(root: string): Promise<void> {
  await mkdir(path.join(root, "wiki", "postgres-filtered"), { recursive: true });
  for (let index = 0; index < 105; index += 1) {
    const padded = String(index).padStart(3, "0");
    await writeFilteredSearchFixturePage(root, `match-${padded}`, `Postgres Filtered Match ${padded}`, "draft", ["postgres-filtered-parity"]);
  }
  await writeFilteredSearchFixturePage(root, "wrong-status", "Postgres Filtered Wrong Status", "published", ["postgres-filtered-parity"]);
  await writeFilteredSearchFixturePage(root, "wrong-topic", "Postgres Filtered Wrong Topic", "draft", ["postgres-filtered-other"]);
}

async function writeFilteredSearchFixturePage(root: string, slug: string, title: string, status: "draft" | "published", topics: string[]): Promise<void> {
  await writeFile(
    path.join(root, "wiki", "postgres-filtered", `${slug}.md`),
    renderPageMarkdown({
      id: `page:postgres-filtered:${slug}`,
      uri: `openwiki://page/postgres-filtered/${slug}`,
      type: "page",
      page_type: "note",
      title,
      summary: "postgres filtered parity marker page.",
      body_format: "markdown",
      body: `# ${title}\n\npostgres filtered parity marker page.`,
      path: `wiki/postgres-filtered/${slug}.md`,
      source_ids: [],
      claim_ids: [],
      status,
      topics,
      created_at: "2026-06-16T00:00:00.000Z",
      updated_at: "2026-06-16T00:00:00.000Z",
    }),
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
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
