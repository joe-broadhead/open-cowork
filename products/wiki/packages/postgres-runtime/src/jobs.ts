import { runtimeRecordFromJson } from "./records.ts";
import { assertOpenWikiId, assertOpenWikiRunType, boundedOpenWikiListLimit, type EventRecord, isoNow, OPENWIKI_SYSTEM_ACTOR_ID, type OpenWikiSectionVisibility, redactOpenWikiRunRecord, type RunRecord, type RunStatus } from "@openwiki/core";
import { appendEvent, appendRun, loadRepository, updateRunIfStatus } from "@openwiki/repo";
import postgres from "postgres";
import { openPostgresSql } from "./connection.ts";
import { postgresRuntimeConfigured, resolvePostgresDatabaseUrl } from "./config.ts";
import { migratePostgresRuntime } from "./migrations.ts";
import { jobStatusCount, runStatusCount } from "./queries.ts";
import { dateStringField, jsonb, optionalSanitizedRunInput, runFromRow, stringField } from "./rows.ts";
import { DEFAULT_STALE_RUN_MAX_RUNTIME_MS, RUNTIME_SOURCE_COMMIT, type CountRow, type JobAttemptRow, type PostgresQuery, type PostgresRunCancellationOptions, type PostgresRunCancellationResult, type PostgresRunJobInput, type PostgresRunQueueAdapter, type PostgresRunReaperOptions, type PostgresRunReaperResult, type PostgresRuntimeOptions, type PostgresRuntimeQueueHealth, type PostgresSql, type RunRow } from "./types.ts";

export async function createPostgresRunQueue(root: string, options: PostgresRuntimeOptions = {}): Promise<PostgresRunQueueAdapter> {
  const databaseUrl = resolvePostgresDatabaseUrl(options);
  if (process.env.OPENWIKI_POSTGRES_MIGRATE !== "0") {
    await migratePostgresRuntime({ databaseUrl });
  }
  return new PostgresRunQueue(root, databaseUrl);
}

export async function readPostgresRuntimeQueueHealth(root: string, options: PostgresRuntimeOptions = {}): Promise<PostgresRuntimeQueueHealth | undefined> {
  if (!postgresRuntimeConfigured(options.databaseUrlEnv ?? process.env) && options.databaseUrl === undefined) {
    return undefined;
  }
  const repo = await loadRepository(root);
  return readPostgresRuntimeQueueHealthForWorkspace(repo.config.workspace_id, options);
}

export async function readPostgresRuntimeQueueHealthForWorkspace(
  workspaceId: string,
  options: PostgresRuntimeOptions = {},
): Promise<PostgresRuntimeQueueHealth | undefined> {
  if (!postgresRuntimeConfigured(options.databaseUrlEnv ?? process.env) && options.databaseUrl === undefined) {
    return undefined;
  }
  const openedSql = openPostgresSql(options);
  const { sql } = openedSql;
  try {
    const staleRunningAfterMs = boundedStaleRunMaxRuntimeMs(undefined);
    const staleBefore = new Date(Date.now() - staleRunningAfterMs).toISOString();
    const [
      queued,
      running,
      succeeded,
      failed,
      jobQueued,
      jobRunning,
      jobSucceeded,
      jobFailed,
      nextQueuedRows,
      oldestRunningRows,
      staleRunningRows,
      latestFailedRows,
    ] = await Promise.all([
      runStatusCount(sql, workspaceId, "queued"),
      runStatusCount(sql, workspaceId, "running"),
      runStatusCount(sql, workspaceId, "succeeded"),
      runStatusCount(sql, workspaceId, "failed"),
      jobStatusCount(sql, workspaceId, "queued"),
      jobStatusCount(sql, workspaceId, "running"),
      jobStatusCount(sql, workspaceId, "succeeded"),
      jobStatusCount(sql, workspaceId, "failed"),
      sql<Array<Record<string, unknown>>>`
        SELECT run_id, created_at
        FROM runs
        WHERE workspace_id = ${workspaceId} AND status = 'queued'
        ORDER BY created_at ASC, run_id ASC
        LIMIT 1
      `,
      sql<Array<Record<string, unknown>>>`
        SELECT run_id, claimed_at, created_at
        FROM jobs
        WHERE workspace_id = ${workspaceId} AND status = 'running'
        ORDER BY claimed_at ASC NULLS FIRST, created_at ASC, run_id ASC
        LIMIT 1
      `,
      sql<CountRow[]>`
        SELECT COUNT(*) AS count
        FROM jobs
        WHERE workspace_id = ${workspaceId}
          AND status = 'running'
          AND COALESCE(claimed_at, created_at) < ${staleBefore}
      `,
      sql<Array<Record<string, unknown>>>`
        SELECT run_id, completed_at
        FROM runs
        WHERE workspace_id = ${workspaceId} AND status = 'failed'
        ORDER BY completed_at DESC NULLS LAST, created_at DESC, run_id DESC
        LIMIT 1
      `,
    ]);
    const nextQueued = nextQueuedRows[0];
    const oldestRunning = oldestRunningRows[0];
    const latestFailed = latestFailedRows[0];
    const nextQueuedRunId = stringField(nextQueued ?? {}, "run_id");
    const oldestQueuedAt = dateStringField(nextQueued ?? {}, "created_at");
    const oldestRunningRunId = stringField(oldestRunning ?? {}, "run_id");
    const oldestRunningAt = dateStringField(oldestRunning ?? {}, "claimed_at") ?? dateStringField(oldestRunning ?? {}, "created_at");
    const latestFailedRunId = stringField(latestFailed ?? {}, "run_id");
    const latestFailedAt = dateStringField(latestFailed ?? {}, "completed_at");
    return {
      source: "postgres-runtime",
      backend: "postgres",
      enabled: true,
      runs: { queued, running, succeeded, failed },
      jobs: { queued: jobQueued, running: jobRunning, succeeded: jobSucceeded, failed: jobFailed },
      ...(nextQueuedRunId === undefined ? {} : { next_queued_run_id: nextQueuedRunId }),
      ...(oldestQueuedAt === undefined ? {} : { oldest_queued_at: oldestQueuedAt }),
      ...(oldestRunningRunId === undefined ? {} : { oldest_running_run_id: oldestRunningRunId }),
      ...(oldestRunningAt === undefined ? {} : { oldest_running_at: oldestRunningAt }),
      stale_running_jobs: Number(staleRunningRows[0]?.count ?? 0),
      stale_running_after_ms: staleRunningAfterMs,
      ...(latestFailedRunId === undefined ? {} : { latest_failed_run_id: latestFailedRunId }),
      ...(latestFailedAt === undefined ? {} : { latest_failed_at: latestFailedAt }),
    };
  } finally {
    await openedSql.close();
  }
}

export async function reapStalePostgresRunJobs(root: string, options: PostgresRunReaperOptions = {}): Promise<PostgresRunReaperResult> {
  const databaseUrl = resolvePostgresDatabaseUrl(options);
  const repo = await loadRepository(root);
  const workspaceId = repo.config.workspace_id;
  const maxRuntimeMs = boundedStaleRunMaxRuntimeMs(options.maxRuntimeMs);
  const staleBefore = new Date(Date.now() - maxRuntimeMs).toISOString();
  const limit = boundedOpenWikiListLimit(options.limit, 100, 1000);
  if (options.workerId !== undefined) {
    assertOpenWikiId(options.workerId, "actor");
  }
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const readCandidates = async (query: PostgresQuery): Promise<Array<{ run: RunRecord; attempts: number; maxAttempts: number }>> => {
      const rows = await query<Array<Record<string, unknown>>>`
        SELECT runs.json AS run_json, jobs.attempts, jobs.max_attempts
        FROM jobs
        JOIN runs ON runs.workspace_id = jobs.workspace_id AND runs.run_id = jobs.run_id
        WHERE jobs.workspace_id = ${workspaceId}
          AND jobs.status = 'running'
          AND runs.status = 'running'
          AND COALESCE(jobs.claimed_at, jobs.created_at) < ${staleBefore}
        ORDER BY jobs.claimed_at ASC NULLS FIRST, jobs.created_at ASC, jobs.run_id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      `;
      return rows.map((row) => ({
        run: runtimeRecordFromJson<RunRecord>(row.run_json, "run"),
        attempts: Math.max(Number(row.attempts ?? 1), 1),
        maxAttempts: Math.max(Number(row.max_attempts ?? 1), 1),
      }));
    };
    const candidates = options.dryRun ? await readCandidates(sql) : undefined;
    if (options.dryRun) {
      return {
        source: "postgres-runtime",
        workspace_id: workspaceId,
        max_runtime_ms: maxRuntimeMs,
        dry_run: true,
        scanned: candidates?.length ?? 0,
        retried: (candidates ?? []).filter((candidate) => candidate.attempts < candidate.maxAttempts).map((candidate) => candidate.run.id),
        failed: (candidates ?? []).filter((candidate) => candidate.attempts >= candidate.maxAttempts).map((candidate) => candidate.run.id),
      };
    }
    const decision = await sql.begin(async (tx) => {
      const query = transactionQuery(tx);
      const lockedCandidates = await readCandidates(query);
      const retried: string[] = [];
      const failed: string[] = [];
      const events: EventRecord[] = [];
      for (const candidate of lockedCandidates) {
        const message = `Postgres queue reaper recovered stale running job after ${maxRuntimeMs} ms`;
        const nextStatus: RunStatus = candidate.attempts < candidate.maxAttempts ? "queued" : "failed";
        let recovered: RunRecord;
        try {
          recovered = await updateRunIfStatus(root, {
            ...candidate.run,
            status: nextStatus,
            error: message,
            ...(nextStatus === "failed" ? { completed_at: isoNow() } : {}),
          }, "running");
        } catch (error) {
          if (error instanceof Error && /expected running/.test(error.message)) {
            continue;
          }
          throw error;
        }
        await upsertRun(query, recovered);
        await upsertJobAttempt(query, recovered, candidate.attempts, "failed", options.workerId, {
          error: message,
          retry: nextStatus === "queued",
          recovered_by: "postgres_queue_reaper",
        });
        const event = await appendEvent(root, {
          type: nextStatus === "queued" ? "run.retry_scheduled" : "run.failed",
          actor_id: recovered.actor_id,
          operation: "wiki.run_reaper",
          record_id: recovered.id,
          record_type: "run",
          data: {
            run_type: recovered.run_type,
            queue_backend: "postgres",
            stale_after_ms: maxRuntimeMs,
            attempts: candidate.attempts,
            max_attempts: candidate.maxAttempts,
            ...(options.workerId === undefined ? {} : { worker_id: options.workerId }),
          },
        });
        events.push(event);
        if (nextStatus === "queued") {
          retried.push(recovered.id);
        } else {
          failed.push(recovered.id);
        }
      }
      return { scanned: lockedCandidates.length, retried, failed, events };
    });
    for (const event of decision.events) {
      await upsertEvent(sql, event, RUNTIME_SOURCE_COMMIT);
    }
    return {
      source: "postgres-runtime",
      workspace_id: workspaceId,
      max_runtime_ms: maxRuntimeMs,
      dry_run: false,
      scanned: decision.scanned,
      retried: decision.retried,
      failed: decision.failed,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function cancelPostgresRun(
  root: string,
  runId: string,
  options: PostgresRunCancellationOptions = {},
): Promise<PostgresRunCancellationResult> {
  const databaseUrl = resolvePostgresDatabaseUrl(options);
  const repo = await loadRepository(root);
  const workspaceId = repo.config.workspace_id;
  const actorId = options.actorId ?? OPENWIKI_SYSTEM_ACTOR_ID;
  assertOpenWikiId(actorId, "actor");
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const reason = options.reason?.trim() || "Cancelled by operator";
    const decision = await sql.begin(async (tx) => {
      const query = transactionQuery(tx);
      const rows = await query<RunRow[]>`
        SELECT run_id, status, json
        FROM runs
        WHERE workspace_id = ${workspaceId} AND run_id = ${runId}
        FOR UPDATE
        LIMIT 1
      `;
      const row = rows[0];
      if (row === undefined) {
        throw new Error(`Run not found: ${runId}`);
      }
      const run = runFromRow(row);
      if (run.status !== "queued" && run.status !== "running") {
        throw new Error(`Run ${run.id} is ${run.status}; only queued or running Postgres jobs can be cancelled`);
      }
      const cancelled = await updateRunIfStatus(root, {
        ...run,
        status: "failed",
        completed_at: isoNow(),
        error: reason,
      }, run.status);
      const job = await upsertRun(query, cancelled);
      await upsertJobAttempt(query, cancelled, Math.max(job.attempts, 1), "failed", actorId, { error: reason, cancelled: true });
      return { cancelled, previousStatus: run.status };
    });
    const event = await appendEvent(root, {
      type: "run.cancelled",
      actor_id: actorId,
      operation: "wiki.run_cancel",
      record_id: decision.cancelled.id,
      record_type: "run",
      data: {
        run_type: decision.cancelled.run_type,
        queue_backend: "postgres",
        previous_status: decision.previousStatus,
        reason,
      },
    });
    await upsertEvent(sql, event, RUNTIME_SOURCE_COMMIT);
    return {
      source: "postgres-runtime",
      workspace_id: workspaceId,
      run: decision.cancelled,
      previous_status: decision.previousStatus,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

class PostgresRunQueue implements PostgresRunQueueAdapter {
  readonly backend = "postgres" as const;

  constructor(
    private readonly root: string,
    private readonly databaseUrl: string,
  ) {}

  async enqueue(input: PostgresRunJobInput): Promise<RunRecord> {
    assertOpenWikiRunType(input.runType);
    const actorId = input.actorId ?? OPENWIKI_SYSTEM_ACTOR_ID;
    assertOpenWikiId(actorId, "actor");
    const run = await appendRun(this.root, {
      run_type: input.runType,
      actor_id: actorId,
      ...optionalSanitizedRunInput(input.runType, input.input),
      ...(input.subjectIds === undefined ? {} : { subject_ids: input.subjectIds }),
      ...optionalRunSubjectPaths(input.runType, input.subjectPaths),
      ...optionalRunSensitivity(input.runType),
    });
    await this.withSql((sql) => upsertRun(sql, run));
    const event = await appendEvent(this.root, {
      type: "run.created",
      actor_id: actorId,
      operation: "wiki.run_job",
      record_id: run.id,
      record_type: "run",
      data: {
        run_type: input.runType,
        queue_backend: this.backend,
      },
      ...(input.subjectIds === undefined ? {} : { subject_ids: input.subjectIds }),
      ...optionalEventSubjectPaths(input.runType, input.subjectPaths),
      ...optionalEventSensitivity(input.runType),
    });
    await this.withSql((sql) => upsertEvent(sql, event, RUNTIME_SOURCE_COMMIT));
    return run;
  }

  async get(runId: string): Promise<RunRecord | undefined> {
    const workspaceId = await this.workspaceId();
    return this.withSql(async (sql) => {
      const rows = await sql<RunRow[]>`
        SELECT run_id, status, json
        FROM runs
        WHERE workspace_id = ${workspaceId} AND run_id = ${runId}
        LIMIT 1
      `;
      return rows[0] === undefined ? undefined : runFromRow(rows[0]);
    });
  }

  async claim(runId: string, workerId?: string): Promise<RunRecord> {
    if (workerId !== undefined) {
      assertOpenWikiId(workerId, "actor");
    }
    const workspaceId = await this.workspaceId();
    const claimed = await this.withSql((sql) =>
      sql.begin(async (tx) => {
        const rows = await tx<RunRow[]>`
          SELECT run_id, status, json
          FROM runs
          WHERE workspace_id = ${workspaceId} AND run_id = ${runId}
          FOR UPDATE SKIP LOCKED
        `;
        const row = rows[0];
        if (!row) {
          throw new Error(`Run not found or already claimed: ${runId}`);
        }
        const claimed = await claimRunRow(transactionQuery(tx), row, workerId);
        await mirrorPostgresRunTransition(this.root, claimed, "queued");
        return claimed;
      }),
    );
    await this.recordStartedEvent(claimed, workerId);
    return claimed;
  }

  async claimNext(workerId?: string): Promise<RunRecord | undefined> {
    if (workerId !== undefined) {
      assertOpenWikiId(workerId, "actor");
    }
    const workspaceId = await this.workspaceId();
    const claimed = await this.withSql((sql) =>
      sql.begin(async (tx) => {
        const rows = await tx<RunRow[]>`
          SELECT run_id, status, json
          FROM runs
          WHERE workspace_id = ${workspaceId} AND status = 'queued'
          ORDER BY created_at ASC, run_id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        `;
        const row = rows[0];
        if (row === undefined) {
          return undefined;
        }
        const claimed = await claimRunRow(transactionQuery(tx), row, workerId);
        await mirrorPostgresRunTransition(this.root, claimed, "queued");
        return claimed;
      }),
    );
    if (claimed !== undefined) {
      await this.recordStartedEvent(claimed, workerId);
    }
    return claimed;
  }

  async heartbeat(run: RunRecord, workerId?: string): Promise<void> {
    if (workerId !== undefined) {
      assertOpenWikiId(workerId, "actor");
    }
    if (run.status !== "running") {
      return;
    }
    const workspaceId = await this.workspaceId();
    const heartbeatAt = isoNow();
    await this.withSql(async (sql) => {
      const jobWorkerPredicate = workerId === undefined ? sql`claimed_by IS NULL` : sql`claimed_by = ${workerId}`;
      const runWorkerPredicate = workerId === undefined ? sql`claimed_by IS NULL` : sql`claimed_by = ${workerId}`;
      await sql`
        UPDATE jobs
        SET claimed_at = ${heartbeatAt}
        WHERE workspace_id = ${workspaceId}
          AND run_id = ${run.id}
          AND status = 'running'
          AND ${jobWorkerPredicate}
      `;
      await sql`
        UPDATE runs
        SET claimed_at = ${heartbeatAt}
        WHERE workspace_id = ${workspaceId}
          AND run_id = ${run.id}
          AND status = 'running'
          AND ${runWorkerPredicate}
      `;
    });
  }

  async complete(run: RunRecord, output: Record<string, unknown>, workerId?: string): Promise<RunRecord> {
    if (run.status !== "running") {
      throw new Error(`Run ${run.id} is ${run.status}, expected running`);
    }
    const workspaceId = await this.workspaceId();
    const completed = await this.withSql((sql) =>
      sql.begin(async (tx) => {
        const query = transactionQuery(tx);
        const claim = await assertRunningPostgresClaim(query, workspaceId, run, workerId);
        const next = {
          ...run,
          status: "succeeded",
          completed_at: isoNow(),
          output,
        } satisfies RunRecord;
        await upsertRun(query, next, workerId);
        await upsertJobAttempt(query, next, claim.attempts, "succeeded", workerId, { output });
        await mirrorPostgresRunTransition(this.root, next, "running");
        return next;
      }),
    );
    const event = await appendEvent(this.root, {
      type: "run.succeeded",
      actor_id: completed.actor_id,
      operation: "wiki.run_job",
      record_id: completed.id,
      record_type: "run",
      data: {
        run_type: completed.run_type,
        queue_backend: this.backend,
        output: redactOpenWikiRunRecord(completed).output ?? output,
        ...(workerId === undefined ? {} : { worker_id: workerId }),
      },
    });
    await this.withSql((sql) => upsertEvent(sql, event, RUNTIME_SOURCE_COMMIT));
    return completed;
  }

  async fail(run: RunRecord, message: string, workerId?: string): Promise<RunRecord> {
    if (run.status !== "running") {
      throw new Error(`Run ${run.id} is ${run.status}, expected running`);
    }
    const workspaceId = await this.workspaceId();
    const decision = await this.withSql((sql) =>
      sql.begin(async (tx) => {
        const query = transactionQuery(tx);
        const attempts = await assertRunningPostgresClaim(query, workspaceId, run, workerId);
        if (attempts.attempts < attempts.maxAttempts) {
          const retry = {
            ...run,
            status: "queued",
            error: message,
          } satisfies RunRecord;
          await upsertRun(query, retry);
          await upsertJobAttempt(query, retry, attempts.attempts, "failed", workerId, { error: message, retry: true });
          await mirrorPostgresRunTransition(this.root, retry, "running");
          return { run: retry, retry: true, attempts };
        }
        const failed = {
          ...run,
          status: "failed",
          completed_at: isoNow(),
          error: message,
        } satisfies RunRecord;
        await upsertRun(query, failed);
        await upsertJobAttempt(query, failed, attempts.attempts, "failed", workerId, { error: message, retry: false });
        await mirrorPostgresRunTransition(this.root, failed, "running");
        return { run: failed, retry: false, attempts };
      }),
    );
    const event = await appendEvent(this.root, {
      type: decision.retry ? "run.retry_scheduled" : "run.failed",
      actor_id: decision.run.actor_id,
      operation: "wiki.run_job",
      record_id: decision.run.id,
      record_type: "run",
      data: {
        run_type: decision.run.run_type,
        queue_backend: this.backend,
        error: message,
        attempts: decision.attempts.attempts,
        max_attempts: decision.attempts.maxAttempts,
        ...(workerId === undefined ? {} : { worker_id: workerId }),
      },
    });
    await this.withSql((sql) => upsertEvent(sql, event, RUNTIME_SOURCE_COMMIT));
    return decision.run;
  }

  private async workspaceId(): Promise<string> {
    return (await loadRepository(this.root)).config.workspace_id;
  }

  private async withSql<T>(callback: (sql: PostgresSql) => Promise<T>): Promise<T> {
    const sql = postgres(this.databaseUrl, { max: 1 });
    try {
      return await callback(sql);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }

  private async recordStartedEvent(claimed: RunRecord, workerId: string | undefined): Promise<void> {
    const event = await appendEvent(this.root, {
      type: "run.started",
      actor_id: claimed.actor_id,
      operation: "wiki.run_job",
      record_id: claimed.id,
      record_type: "run",
      data: {
        run_type: claimed.run_type,
        queue_backend: "postgres",
        ...(workerId === undefined ? {} : { worker_id: workerId }),
      },
    });
    await this.withSql((sql) => upsertEvent(sql, event, RUNTIME_SOURCE_COMMIT));
  }
}

function optionalRunSubjectPaths(runType: string, explicitPaths: string[] | undefined): { subject_paths: string[] } | {} {
  const subjectPaths = runSubjectPaths(runType, explicitPaths);
  return subjectPaths === undefined ? {} : { subject_paths: subjectPaths };
}

function optionalEventSubjectPaths(runType: string, explicitPaths: string[] | undefined): { subject_paths: string[] } | {} {
  const subjectPaths = runSubjectPaths(runType, explicitPaths);
  return subjectPaths === undefined ? {} : { subject_paths: subjectPaths };
}

function optionalRunSensitivity(runType: string): { sensitivity: OpenWikiSectionVisibility } | {} {
  const sensitivity = runSensitivity(runType);
  return sensitivity === undefined ? {} : { sensitivity };
}

function optionalEventSensitivity(runType: string): { sensitivity: OpenWikiSectionVisibility } | {} {
  const sensitivity = runSensitivity(runType);
  return sensitivity === undefined ? {} : { sensitivity };
}

function runSubjectPaths(runType: string, explicitPaths: string[] | undefined): string[] | undefined {
  const paths = [...(explicitPaths ?? []), ...(runType === "source.fetch" ? ["sources/manifests", "sources/raw"] : [])]
    .map((entry) => entry.trim())
    .filter((entry, index, values) => entry.length > 0 && values.indexOf(entry) === index);
  return paths.length === 0 ? undefined : paths;
}

function runSensitivity(runType: string): OpenWikiSectionVisibility | undefined {
  return runType === "source.fetch" ? "internal" : undefined;
}

// postgres.js types the in-transaction handle (passed to `sql.begin`) as a distinct generic
// instantiation that does not structurally unify with PostgresSql, even though both accept the
// same tagged-template queries. Narrow it once, here, instead of at every transaction call site.
function transactionQuery(tx: unknown): PostgresQuery {
  return tx as PostgresQuery;
}

interface RunningClaimRow {
  status: string;
  claimed_by: string | null;
  attempts: number | bigint | string;
  max_attempts: number | bigint | string;
}

async function assertRunningPostgresClaim(
  sql: PostgresQuery,
  workspaceId: string,
  run: RunRecord,
  workerId: string | undefined,
): Promise<{ attempts: number; maxAttempts: number }> {
  const runRows = await sql<Array<{ status: string; claimed_by: string | null }>>`
    SELECT status, claimed_by
    FROM runs
    WHERE workspace_id = ${workspaceId} AND run_id = ${run.id}
    FOR UPDATE
  `;
  const jobRows = await sql<RunningClaimRow[]>`
    SELECT status, claimed_by, attempts, max_attempts
    FROM jobs
    WHERE workspace_id = ${workspaceId} AND run_id = ${run.id}
    FOR UPDATE
  `;
  const runRow = runRows[0];
  const jobRow = jobRows[0];
  if (runRow === undefined || jobRow === undefined) {
    // A full derived-store rebuild can briefly remove queue rows while the Git
    // ledger still has a running claim. Recover from the canonical CAS below.
    if (run.status === "running") {
      return { attempts: 1, maxAttempts: maxAttemptsForRun(run) };
    }
    throw new Error(`Run not found or not claimable: ${run.id}`);
  }
  if (runRow.status !== "running" || jobRow.status !== "running") {
    throw new Error(`Run ${run.id} is no longer running`);
  }
  const claimedBy = jobRow.claimed_by ?? runRow.claimed_by ?? null;
  if (workerId === undefined ? claimedBy !== null : claimedBy !== workerId) {
    throw new Error(`Run ${run.id} is claimed by another worker`);
  }
  return {
    attempts: Math.max(Number(jobRow.attempts), 1),
    maxAttempts: Math.max(Number(jobRow.max_attempts), 1),
  };
}

async function claimRunRow(sql: PostgresQuery, row: RunRow, workerId: string | undefined): Promise<RunRecord> {
  const run = runFromRow(row);
  if (run.status !== "queued") {
    throw new Error(`Run ${run.id} is ${run.status}, expected queued`);
  }
  const claimed = {
    ...run,
    status: "running",
    started_at: isoNow(),
  } satisfies RunRecord;
  const job = await upsertRun(sql, claimed, workerId);
  await upsertJobAttempt(sql, claimed, job.attempts, "running", workerId);
  return claimed;
}

async function mirrorPostgresRunTransition(root: string, run: RunRecord, expectedStatus: RunRecord["status"]): Promise<void> {
  await updateRunIfStatus(root, run, expectedStatus);
}

async function upsertRun(sql: PostgresQuery, run: RunRecord, workerId?: string): Promise<{ attempts: number; maxAttempts: number }> {
  await sql`
    INSERT INTO runs (
      workspace_id, run_id, run_type, status, actor_id, created_at, started_at,
      completed_at, claimed_by, claimed_at, source_commit, json
    ) VALUES (
      ${run.workspace_id}, ${run.id}, ${run.run_type}, ${run.status}, ${run.actor_id},
      ${run.created_at}, ${run.started_at ?? null}, ${run.completed_at ?? null},
      ${workerId ?? null}, ${workerId === undefined ? null : isoNow()}, ${RUNTIME_SOURCE_COMMIT},
      ${JSON.stringify(run)}::jsonb
    )
    ON CONFLICT (workspace_id, run_id) DO UPDATE SET
      run_type = EXCLUDED.run_type,
      status = EXCLUDED.status,
      actor_id = EXCLUDED.actor_id,
      started_at = EXCLUDED.started_at,
      completed_at = EXCLUDED.completed_at,
      claimed_by = CASE WHEN EXCLUDED.status = 'queued' THEN NULL ELSE COALESCE(EXCLUDED.claimed_by, runs.claimed_by) END,
      claimed_at = CASE WHEN EXCLUDED.status = 'queued' THEN NULL ELSE COALESCE(EXCLUDED.claimed_at, runs.claimed_at) END,
      source_commit = EXCLUDED.source_commit,
      json = EXCLUDED.json
  `;
  return upsertJobForRun(sql, run, workerId);
}

export async function upsertJobForRun(sql: PostgresQuery, run: RunRecord, workerId?: string): Promise<{ attempts: number; maxAttempts: number }> {
  const claimedAt = workerId === undefined ? null : isoNow();
  const completedAt = run.status === "succeeded" || run.status === "failed" ? run.completed_at ?? isoNow() : null;
  const insertAttempts = run.status === "running" ? 1 : 0;
  const maxAttempts = maxAttemptsForRun(run);
  const rows = await sql<JobAttemptRow[]>`
    INSERT INTO jobs (
      workspace_id, job_id, run_id, job_type, status, actor_id, attempts,
      max_attempts, created_at, claimed_by, claimed_at, completed_at, source_commit, json
    ) VALUES (
      ${run.workspace_id}, ${run.id}, ${run.id}, ${run.run_type}, ${run.status}, ${run.actor_id},
      ${insertAttempts}, ${maxAttempts}, ${run.created_at}, ${workerId ?? null}, ${claimedAt},
      ${completedAt}, ${RUNTIME_SOURCE_COMMIT}, ${JSON.stringify(run)}::jsonb
    )
    ON CONFLICT (workspace_id, job_id) DO UPDATE SET
      run_id = EXCLUDED.run_id,
      job_type = EXCLUDED.job_type,
      status = EXCLUDED.status,
      actor_id = EXCLUDED.actor_id,
      attempts = CASE WHEN EXCLUDED.status = 'running' THEN jobs.attempts + 1 ELSE jobs.attempts END,
      max_attempts = GREATEST(jobs.max_attempts, EXCLUDED.max_attempts),
      claimed_by = CASE WHEN EXCLUDED.status = 'queued' THEN NULL ELSE COALESCE(EXCLUDED.claimed_by, jobs.claimed_by) END,
      claimed_at = CASE WHEN EXCLUDED.status = 'queued' THEN NULL ELSE COALESCE(EXCLUDED.claimed_at, jobs.claimed_at) END,
      completed_at = CASE WHEN EXCLUDED.status = 'queued' THEN NULL ELSE COALESCE(EXCLUDED.completed_at, jobs.completed_at) END,
      source_commit = EXCLUDED.source_commit,
      json = EXCLUDED.json
    RETURNING attempts, max_attempts
  `;
  const row = rows[0];
  return {
    attempts: Math.max(Number(row?.attempts ?? insertAttempts), 0),
    maxAttempts: Math.max(Number(row?.max_attempts ?? maxAttempts), 1),
  };
}

export async function upsertJobAttempt(
  sql: PostgresQuery,
  run: RunRecord,
  attempt: number,
  status: "running" | "succeeded" | "failed",
  workerId?: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const startedAt = run.started_at ?? isoNow();
  const completedAt = status === "running" ? null : run.completed_at ?? isoNow();
  const error = typeof metadata.error === "string" ? metadata.error : run.error ?? null;
  const payload = {
    run_id: run.id,
    run_type: run.run_type,
    status,
    attempt,
    ...(workerId === undefined ? {} : { worker_id: workerId }),
    ...metadata,
  };
  await sql`
    INSERT INTO job_attempts (
      workspace_id, job_id, run_id, attempt, job_type, status, actor_id,
      worker_id, started_at, completed_at, error, source_commit, json
    ) VALUES (
      ${run.workspace_id}, ${run.id}, ${run.id}, ${attempt}, ${run.run_type}, ${status}, ${run.actor_id},
      ${workerId ?? null}, ${startedAt}, ${completedAt}, ${error}, ${RUNTIME_SOURCE_COMMIT}, ${JSON.stringify(payload)}::jsonb
    )
    ON CONFLICT (workspace_id, job_id, attempt) DO UPDATE SET
      status = EXCLUDED.status,
      actor_id = EXCLUDED.actor_id,
      worker_id = COALESCE(EXCLUDED.worker_id, job_attempts.worker_id),
      started_at = LEAST(job_attempts.started_at, EXCLUDED.started_at),
      completed_at = COALESCE(EXCLUDED.completed_at, job_attempts.completed_at),
      error = COALESCE(EXCLUDED.error, job_attempts.error),
      source_commit = EXCLUDED.source_commit,
      json = EXCLUDED.json
  `;
}

async function upsertEvent(sql: PostgresQuery, event: EventRecord, sourceCommit: string): Promise<void> {
  await sql`
    INSERT INTO events (workspace_id, event_id, event_type, actor_id, operation, record_id, occurred_at, sensitivity, source_commit, json)
    VALUES (${event.workspace_id}, ${event.id}, ${event.type}, ${event.actor_id ?? null}, ${event.operation ?? null}, ${event.record_id ?? null}, ${event.occurred_at}, ${event.sensitivity ?? null}, ${sourceCommit}, ${jsonb(event)}::jsonb)
    ON CONFLICT (workspace_id, event_id) DO UPDATE SET
      event_type = EXCLUDED.event_type,
      actor_id = EXCLUDED.actor_id,
      operation = EXCLUDED.operation,
      record_id = EXCLUDED.record_id,
      occurred_at = EXCLUDED.occurred_at,
      sensitivity = EXCLUDED.sensitivity,
      source_commit = EXCLUDED.source_commit,
      json = EXCLUDED.json
  `;
}

function maxAttemptsForRun(run: RunRecord): number {
  const input = run.input ?? {};
  const configured = numericInput(input.max_attempts) ?? numericInput(input.retry_max_attempts);
  const envConfigured = numericInput(process.env.OPENWIKI_RUN_MAX_ATTEMPTS);
  return Math.min(Math.max(configured ?? envConfigured ?? 1, 1), 10);
}

function numericInput(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? Math.floor(number) : undefined;
}

function boundedStaleRunMaxRuntimeMs(value: number | undefined): number {
  const configured = value ?? numericInput(process.env.OPENWIKI_RUN_STALE_AFTER_MS) ?? DEFAULT_STALE_RUN_MAX_RUNTIME_MS;
  if (!Number.isFinite(configured) || configured < 1000 || configured > 24 * 60 * 60 * 1000) {
    throw new Error("Postgres stale run max runtime must be between 1000 and 86400000 milliseconds");
  }
  return Math.trunc(configured);
}
