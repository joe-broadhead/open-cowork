import { assertOpenWikiId, writeOpenWikiLog, type RunRecord } from "@openwiki/core";
import { createRunQueue } from "./queue.ts";
import { executeLocalRun } from "./dispatcher.ts";
import type { ExecuteRunInput, RunJobInput, RunJobResult, RunNextQueuedJobInput, RunNextQueuedJobResult, RunQueueAdapter, RunWorkerInput, RunWorkerResult } from "./types.ts";

export async function createRun(input: RunJobInput): Promise<RunRecord> {
  return (await createRunQueue(input.root)).enqueue(input);
}

export async function runLocalJob(input: RunJobInput): Promise<RunJobResult> {
  const run = await createRun(input);
  return executeRun({ root: input.root, runId: run.id, ...(input.policyContext === undefined ? {} : { policyContext: input.policyContext }) });
}

const RUN_ABORT_SETTLE_GRACE_MS = 1000;

export async function executeRun(input: ExecuteRunInput): Promise<RunJobResult> {
  if (input.workerId !== undefined) {
    assertOpenWikiId(input.workerId, "actor");
  }
  const queue = await createRunQueue(input.root);
  const run = await queue.claim(input.runId, input.workerId);
  return executeClaimedRun(input.root, queue, run, input.workerId, input.signal, input.policyContext);
}

export async function executeClaimedRun(
  root: string,
  queue: RunQueueAdapter,
  run: RunRecord,
  workerId?: string,
  signal?: AbortSignal,
  policyContext?: ExecuteRunInput["policyContext"],
): Promise<RunJobResult> {
  const heartbeat = startRunHeartbeat(queue, run, workerId);
  const startedAt = Date.now();
  writeOpenWikiLog({
    event: "job_started",
    actor_id: run.actor_id,
    correlation_id: run.id,
    metadata: {
      run_id: run.id,
      run_type: run.run_type,
      queue_backend: queue.backend,
      ...(workerId === undefined ? {} : { worker_id: workerId }),
    },
  });
  try {
    if (signal?.aborted) {
      throw new Error("Worker aborted");
    }
    const execution = executeLocalRun(root, run.run_type, run.input ?? {}, run.actor_id, run.id, policyContext);
    const output = await raceRunExecution(execution, signal, heartbeat.failure);
    const completed = await queue.complete(run, output, workerId);
    writeOpenWikiLog({
      event: "job_succeeded",
      actor_id: completed.actor_id,
      correlation_id: completed.id,
      duration_ms: Date.now() - startedAt,
      metadata: {
        run_id: completed.id,
        run_type: completed.run_type,
        queue_backend: queue.backend,
        ...(workerId === undefined ? {} : { worker_id: workerId }),
      },
    });
    return { run: completed };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const current = await queue.get(run.id);
    if (current !== undefined && current.status !== "running") {
      writeOpenWikiLog({
        event: "job_finished_elsewhere",
        actor_id: current.actor_id,
        correlation_id: current.id,
        duration_ms: Date.now() - startedAt,
        metadata: {
          run_id: current.id,
          run_type: current.run_type,
          status: current.status,
          queue_backend: queue.backend,
          ...(workerId === undefined ? {} : { worker_id: workerId }),
        },
      });
      return { run: current };
    }
    const failed = await queue.fail(current ?? run, message, workerId);
    writeOpenWikiLog({
      event: "job_failed",
      level: "error",
      actor_id: failed.actor_id,
      correlation_id: failed.id,
      duration_ms: Date.now() - startedAt,
      metadata: {
        run_id: failed.id,
        run_type: failed.run_type,
        queue_backend: queue.backend,
        ...(workerId === undefined ? {} : { worker_id: workerId }),
      },
      error: message,
    });
    return { run: failed };
  } finally {
    heartbeat.stop();
  }
}

export async function runNextQueuedJob(input: RunNextQueuedJobInput): Promise<RunNextQueuedJobResult> {
  const queue = await createRunQueue(input.root);
  const next = await queue.claimNext(input.workerId);
  if (!next) {
    return {};
  }
  return executeClaimedRun(input.root, queue, next, input.workerId, input.signal);
}

export async function runWorker(input: RunWorkerInput): Promise<RunWorkerResult> {
  const processed: RunRecord[] = [];
  const pollMs = Math.max(input.pollMs ?? 1000, 0);
  const maxJobs = input.maxJobs ?? (input.once ? 1 : Number.POSITIVE_INFINITY);

  while (!input.signal?.aborted && processed.length < maxJobs) {
    const result = await runNextQueuedJob({
      root: input.root,
      ...(input.workerId === undefined ? {} : { workerId: input.workerId }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (result.run) {
      processed.push(result.run);
      continue;
    }
    if (input.once || processed.length >= maxJobs) {
      break;
    }
    await sleep(pollMs, input.signal);
  }

  return { processed };
}

function startRunHeartbeat(queue: RunQueueAdapter, run: RunRecord, workerId: string | undefined): {
  failure: Promise<never>;
  stop(): void;
} {
  if (queue.heartbeat === undefined || run.status !== "running") {
    return {
      failure: new Promise<never>(() => undefined),
      stop() {
        return undefined;
      },
    };
  }
  const heartbeatMs = boundedRunHeartbeatMs();
  const heartbeat = queue.heartbeat.bind(queue);
  let stopped = false;
  let rejectFailure: (error: Error) => void = () => undefined;
  const failure = new Promise<never>((_, reject) => {
    rejectFailure = reject;
  });
  const timer = setInterval(() => {
    void heartbeat(run, workerId).catch((error) => {
      if (!stopped) {
        rejectFailure(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }, heartbeatMs);
  return {
    failure,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

async function raceRunExecution(
  execution: Promise<Record<string, unknown>>,
  signal: AbortSignal | undefined,
  heartbeatFailure: Promise<never>,
): Promise<Record<string, unknown>> {
  const contenders: Array<Promise<Record<string, unknown>>> = [execution, heartbeatFailure];
  let cleanupAbort = (): void => undefined;
  if (signal !== undefined) {
    const abort = abortFailure(signal);
    cleanupAbort = abort.cleanup;
    contenders.push(abort.promise);
  }
  try {
    return await Promise.race(contenders);
  } catch (error) {
    await waitForExecutionGrace(execution);
    throw error;
  } finally {
    cleanupAbort();
  }
}

async function waitForExecutionGrace(execution: Promise<Record<string, unknown>>): Promise<void> {
  execution.catch(() => undefined);
  await Promise.race([
    execution.then(() => undefined, () => undefined),
    sleep(RUN_ABORT_SETTLE_GRACE_MS),
  ]);
}

function abortFailure(signal: AbortSignal): { promise: Promise<never>; cleanup(): void } {
  if (signal.aborted) {
    return { promise: Promise.reject(new Error("Worker aborted")), cleanup: () => undefined };
  }
  let abort = (): void => undefined;
  const promise = new Promise<never>((_, reject) => {
    abort = (): void => reject(new Error("Worker aborted"));
    signal.addEventListener("abort", abort, { once: true });
  });
  return {
    promise,
    cleanup() {
      signal.removeEventListener("abort", abort);
    },
  };
}

function boundedRunHeartbeatMs(): number {
  const value = process.env.OPENWIKI_RUN_HEARTBEAT_MS;
  const parsed = value === undefined || value.trim() === "" ? 10000 : Number(value);
  if (!Number.isFinite(parsed) || parsed < 1000 || parsed > 5 * 60 * 1000) {
    throw new Error("OPENWIKI_RUN_HEARTBEAT_MS must be between 1000 and 300000 milliseconds");
  }
  return Math.trunc(parsed);
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    const abort = (): void => done();
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}
