import { OPENWIKI_SYSTEM_ACTOR_ID, assertOpenWikiId, assertOpenWikiRunType, isoNow, openWikiRuntimeModeFromEnvOrProfile, openWikiRuntimeModeRequiresHostedStores, redactOpenWikiRunRecord, type OpenWikiQueueBackend, type OpenWikiSectionVisibility, type RunRecord } from "@openwiki/core";
import { appendEvent, appendRun, claimQueuedRun, loadRepository, updateRun } from "@openwiki/repo";
import { createPostgresRunQueue } from "@openwiki/postgres-runtime";
import { assertSourceFetchBudgetForRoot } from "@openwiki/workflows";
import { runJobSensitivity, runJobSubjectPaths, sanitizeRunInput } from "./inputs.ts";
import type { RunJobInput, RunQueueAdapter } from "./types.ts";

export async function createRunQueue(root: string): Promise<RunQueueAdapter> {
  const repo = await loadRepository(root);
  const backend = queueBackendOverride() ?? repo.config.runtime?.queue?.backend ?? "local";
  const runtimeMode = openWikiRuntimeModeFromEnvOrProfile(process.env, repo.config.runtime?.profile);
  if (backend === "local") {
    if (openWikiRuntimeModeRequiresHostedStores(runtimeMode)) {
      throw new Error(`OpenWiki ${runtimeMode} runtime mode requires OPENWIKI_QUEUE_BACKEND=postgres or runtime.queue.backend=postgres`);
    }
    return new BudgetedRunQueueAdapter(root, new LocalRunQueueAdapter(root));
  }
  if (backend === "postgres") {
    return new BudgetedRunQueueAdapter(root, await createPostgresRunQueue(root));
  }
  throw new Error(`OpenWiki queue backend '${backend}' is configured but not implemented in this runtime`);
}

function queueBackendOverride(): OpenWikiQueueBackend | undefined {
  const value = process.env.OPENWIKI_QUEUE_BACKEND?.trim();
  if (!value) {
    return undefined;
  }
  if (value === "local" || value === "postgres") {
    return value;
  }
  throw new Error(`Invalid OPENWIKI_QUEUE_BACKEND '${value}'. Supported v0.1 backends are local and postgres.`);
}

class LocalRunQueueAdapter implements RunQueueAdapter {
  readonly backend = "local" as const;

  constructor(private readonly root: string) {}

  async enqueue(input: RunJobInput): Promise<RunRecord> {
    assertOpenWikiRunType(input.runType);
    const actorId = input.actorId ?? OPENWIKI_SYSTEM_ACTOR_ID;
    assertOpenWikiId(actorId, "actor");
    const runInput = sanitizeRunInput(input.runType, input.input);
    const run = await appendRun(this.root, {
      run_type: input.runType,
      actor_id: actorId,
      ...(runInput === undefined ? {} : { input: runInput }),
      ...(input.subjectIds === undefined ? {} : { subject_ids: input.subjectIds }),
      ...optionalRunSubjectPaths(input.runType, input.subjectPaths),
      ...optionalRunSensitivity(input.runType),
    });
    await appendEvent(this.root, {
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
    return run;
  }

  async get(runId: string): Promise<RunRecord | undefined> {
    const repo = await loadRepository(this.root);
    return repo.runs.find((run) => run.id === runId || run.uri === runId);
  }

  async claim(runId: string, workerId?: string): Promise<RunRecord> {
    if (workerId !== undefined) {
      assertOpenWikiId(workerId, "actor");
    }
    const run = await this.get(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }
    if (run.status !== "queued") {
      throw new Error(`Run ${run.id} is ${run.status}, expected queued`);
    }
    const claimed = await claimQueuedRun(this.root, run.id, isoNow());
    await appendEvent(this.root, {
      type: "run.started",
      actor_id: claimed.actor_id,
      operation: "wiki.run_job",
      record_id: claimed.id,
      record_type: "run",
      data: {
        run_type: claimed.run_type,
        queue_backend: this.backend,
        ...(workerId === undefined ? {} : { worker_id: workerId }),
      },
    });
    return claimed;
  }

  async claimNext(workerId?: string): Promise<RunRecord | undefined> {
    const repo = await loadRepository(this.root);
    const queued = repo.runs
      .filter((run) => run.status === "queued")
      .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id));
    for (const run of queued) {
      try {
        return await this.claim(run.id, workerId);
      } catch (error) {
        if (!isQueuedClaimRace(error)) {
          throw error;
        }
      }
    }
    return undefined;
  }

  async complete(run: RunRecord, output: Record<string, unknown>, workerId?: string): Promise<RunRecord> {
    if (run.status !== "running") {
      throw new Error(`Run ${run.id} is ${run.status}, expected running`);
    }
    const completed = await updateRun(this.root, {
      ...run,
      status: "succeeded",
      completed_at: isoNow(),
      output,
    });
    const eventOutput = redactOpenWikiRunRecord(completed).output ?? output;
    await appendEvent(this.root, {
      type: "run.succeeded",
      actor_id: completed.actor_id,
      operation: "wiki.run_job",
      record_id: completed.id,
      record_type: "run",
      data: {
        run_type: completed.run_type,
        queue_backend: this.backend,
        output: eventOutput,
        ...(workerId === undefined ? {} : { worker_id: workerId }),
      },
    });
    return completed;
  }

  async fail(run: RunRecord, message: string, workerId?: string): Promise<RunRecord> {
    if (run.status !== "running") {
      throw new Error(`Run ${run.id} is ${run.status}, expected running`);
    }
    const failed = await updateRun(this.root, {
      ...run,
      status: "failed",
      completed_at: isoNow(),
      error: message,
    });
    await appendEvent(this.root, {
      type: "run.failed",
      actor_id: failed.actor_id,
      operation: "wiki.run_job",
      record_id: failed.id,
      record_type: "run",
      data: {
        run_type: failed.run_type,
        queue_backend: this.backend,
        error: message,
        ...(workerId === undefined ? {} : { worker_id: workerId }),
      },
    });
    return failed;
  }
}

function optionalRunSubjectPaths(runType: string, explicitPaths: string[] | undefined): { subject_paths: string[] } | {} {
  const subjectPaths = runJobSubjectPaths(runType, explicitPaths);
  return subjectPaths === undefined ? {} : { subject_paths: subjectPaths };
}

function optionalEventSubjectPaths(runType: string, explicitPaths: string[] | undefined): { subject_paths: string[] } | {} {
  const subjectPaths = runJobSubjectPaths(runType, explicitPaths);
  return subjectPaths === undefined ? {} : { subject_paths: subjectPaths };
}

function optionalRunSensitivity(runType: string): { sensitivity: OpenWikiSectionVisibility } | {} {
  const sensitivity = runJobSensitivity(runType);
  return sensitivity === undefined ? {} : { sensitivity };
}

function optionalEventSensitivity(runType: string): { sensitivity: OpenWikiSectionVisibility } | {} {
  const sensitivity = runJobSensitivity(runType);
  return sensitivity === undefined ? {} : { sensitivity };
}

class BudgetedRunQueueAdapter implements RunQueueAdapter {
  readonly backend: OpenWikiQueueBackend;
  readonly heartbeat?: (run: RunRecord, workerId?: string) => Promise<void>;

  constructor(private readonly root: string, private readonly inner: RunQueueAdapter) {
    this.backend = inner.backend;
    if (inner.heartbeat !== undefined) {
      this.heartbeat = inner.heartbeat.bind(inner);
    }
  }

  async enqueue(input: RunJobInput): Promise<RunRecord> {
    assertOpenWikiRunType(input.runType);
    const runInput = sanitizeRunInput(input.runType, input.input);
    if (input.runType === "source.fetch") {
      await assertSourceFetchBudgetForRoot(this.root, sourceFetchBudgetRequest(runInput));
    }
    return this.inner.enqueue(input);
  }

  get(runId: string): Promise<RunRecord | undefined> {
    return this.inner.get(runId);
  }

  claim(runId: string, workerId?: string): Promise<RunRecord> {
    return this.inner.claim(runId, workerId);
  }

  claimNext(workerId?: string): Promise<RunRecord | undefined> {
    return this.inner.claimNext(workerId);
  }

  complete(run: RunRecord, output: Record<string, unknown>, workerId?: string): Promise<RunRecord> {
    return this.inner.complete(run, output, workerId);
  }

  fail(run: RunRecord, message: string, workerId?: string): Promise<RunRecord> {
    return this.inner.fail(run, message, workerId);
  }
}

function sourceFetchBudgetRequest(input: Record<string, unknown> | undefined): { maxBytes?: number; timeoutMs?: number } {
  return {
    ...(typeof input?.max_bytes === "number" ? { maxBytes: input.max_bytes } : {}),
    ...(typeof input?.timeout_ms === "number" ? { timeoutMs: input.timeout_ms } : {}),
  };
}

function isQueuedClaimRace(error: unknown): boolean {
  return error instanceof Error && / is .*, expected queued$/.test(error.message);
}
