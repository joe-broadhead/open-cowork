import { createRun, runLocalJob, runWorker } from "@openwiki/jobs";
import type { CliOptions } from "../args.ts";
import { printJson } from "../output.ts";
import { cancelPostgresRun, listCurrentPostgresEvents, listCurrentPostgresRuns, readCurrentPostgresRun, readPostgresRuntimeQueueHealth, reapStalePostgresRunJobs } from "@openwiki/postgres-runtime";
import { listEvents, listRuns, loadRepository, readRun } from "@openwiki/repo";
import { filterRunsByStatuses, runStatusCounts } from "@openwiki/core";
import type { EventRecord, RunRecord } from "@openwiki/core";
import { resolveRoot } from "../utils.ts";
import { registerCliShutdownHook } from "../process-lifecycle.ts";

type RunStatus = RunRecord["status"];

export async function runsCommand(args: string[], options: CliOptions): Promise<void> {
  const root = await resolveRoot(options);
  if (args[0] === "monitor") {
    const result = await runMonitor(root, options);
    if (options.json) {
      printJson(result);
      return;
    }
    console.log(`Run monitor for ${result.workspace_id} (${result.source})`);
    console.log(`total=${result.counts.total} queued=${result.counts.queued} running=${result.counts.running} succeeded=${result.counts.succeeded} failed=${result.counts.failed}`);
    if (result.queue) {
      console.log(`postgres_queue queued=${result.queue.jobs.queued} running=${result.queue.jobs.running} failed=${result.queue.jobs.failed} stale_running=${result.queue.stale_running_jobs}`);
    }
    for (const run of result.recent) {
      console.log(`${run.created_at}  ${run.status}  ${run.run_type}  ${run.id}`);
    }
    return;
  }
  if (args[0] === "reap-stale") {
    const result = await reapStalePostgresRunJobs(root, {
      ...(options.maxRuntimeMs === undefined ? {} : { maxRuntimeMs: options.maxRuntimeMs }),
      ...(options.actor === undefined ? {} : { workerId: options.actor }),
      dryRun: options.dryRun === true,
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
    if (options.json) {
      printJson(result);
      return;
    }
    const mode = result.dry_run ? "would recover" : "recovered";
    console.log(`Postgres queue reaper ${mode} ${result.scanned} stale running jobs`);
    console.log(`retried=${result.retried.length} failed=${result.failed.length} max_runtime_ms=${result.max_runtime_ms}`);
    return;
  }
  if (args[0] === "cancel") {
    const runId = args[1];
    if (!runId) {
      throw new Error("Usage: openwiki [--root <path>] runs cancel <run-id> [--actor actor:user:admin] [--reason text] [--json]");
    }
    const result = await cancelPostgresRun(root, runId, {
      ...(options.actor === undefined ? {} : { actorId: options.actor }),
      ...(options.reason === undefined ? {} : { reason: options.reason }),
    });
    if (options.json) {
      printJson(result);
      return;
    }
    console.log(`Cancelled ${result.run.id}; previous_status=${result.previous_status}`);
    return;
  }
  if (args[0] === "detail") {
    const runId = args[1];
    if (!runId) {
      throw new Error("Usage: openwiki [--root <path>] runs detail <run-id> [--json]");
    }
    const result = await runDetailForCli(root, runId);
    if (options.json) {
      printJson(result);
      return;
    }
    console.log(`${result.run.status} ${result.run.id} ${result.run.run_type}`);
    console.log(`actor=${result.run.actor_id} source=${result.source}`);
    if (result.job) {
      console.log(`job=${result.job.status} attempts=${result.job.attempts}/${result.job.max_attempts}`);
    }
    for (const attempt of result.attempts) {
      console.log(`attempt=${attempt.attempt} status=${attempt.status} worker=${attempt.worker_id ?? ""}`);
    }
    for (const event of result.events) {
      console.log(`${event.occurred_at}  ${event.type}  ${event.operation ?? ""}`);
    }
    return;
  }
  if (args.length > 0) {
    throw new Error("Usage: openwiki [--root <path>] runs [monitor|detail <run-id>|reap-stale|cancel <run-id>] [--status queued|running|succeeded|failed] [--limit N] [--max-runtime-ms N] [--dry-run] [--json]");
  }
  const result = await listRunsForCli(root, options.limit);
  const runs = filterRunsByStatuses(result.runs, runStatuses(options.statuses));
  if (options.json) {
    printJson({ ...result, runs });
    return;
  }
  for (const run of runs) {
    console.log(`${run.created_at}  ${run.status}  ${run.run_type}  ${run.id}`);
  }
}

async function runDetailForCli(root: string, runId: string): Promise<{
  source: "postgres-runtime" | "parser";
  run: RunRecord;
  job?: NonNullable<Awaited<ReturnType<typeof readCurrentPostgresRun>>>["job"];
  attempts: NonNullable<Awaited<ReturnType<typeof readCurrentPostgresRun>>>["attempts"];
  events: EventRecord[];
}> {
  const postgresDetail = await readCurrentPostgresRun(root, runId);
  const run = postgresDetail?.run ?? await readRun(root, runId);
  const events = ((await listCurrentPostgresEvents(root, 500)) ?? (await listEvents(root, 500))).events
    .filter((event) => event.record_id === run.id || (event.subject_ids ?? []).includes(run.id));
  return {
    source: postgresDetail?.source ?? "parser",
    run,
    ...(postgresDetail?.job === undefined ? {} : { job: postgresDetail.job }),
    attempts: postgresDetail?.attempts ?? [],
    events,
  };
}

export async function runMonitor(root: string, options: CliOptions): Promise<{
  generated_at: string;
  workspace_id: string;
  source: "postgres-runtime" | "parser";
  counts: Record<RunStatus, number> & { total: number };
  filters: { statuses: RunStatus[]; limit: number };
  recent: RunRecord[];
  queue?: Awaited<ReturnType<typeof readPostgresRuntimeQueueHealth>>;
}> {
  const repo = await loadRepository(root);
  const limit = Math.max(options.limit ?? 50, 1);
  const statuses = runStatuses(options.statuses);
  const result = await listRunsForCli(root, Math.max(limit, 500));
  const queue = await readPostgresRuntimeQueueHealth(root).catch(() => undefined);
  return {
    generated_at: new Date().toISOString(),
    workspace_id: repo.config.workspace_id,
    source: result.source,
    counts: runStatusCounts(result.runs),
    filters: { statuses, limit },
    recent: filterRunsByStatuses(result.runs, statuses.length === 0 ? undefined : statuses).slice(0, limit),
    ...(queue === undefined ? {} : { queue }),
  };
}

async function listRunsForCli(root: string, limit: number | undefined): Promise<{ source: "postgres-runtime" | "parser"; runs: RunRecord[] }> {
  const postgresRuns = await listCurrentPostgresRuns(root, limit);
  return postgresRuns === undefined ? { source: "parser", ...(await listRuns(root, limit)) } : { source: postgresRuns.source, runs: postgresRuns.runs };
}

function runStatuses(values: string[]): RunStatus[] {
  return values.map((value) => {
    if (value === "queued" || value === "running" || value === "succeeded" || value === "failed") {
      return value;
    }
    throw new Error(`Invalid run status '${value}'`);
  });
}

export async function runCommand(args: string[], options: CliOptions): Promise<void> {
  const [target, id] = args;
  if (target !== "index" && target !== "export" && target !== "lint" && target !== "inbox-process" && target !== "inbox-reconcile") {
    throw new Error(
      "Usage: openwiki [--root <path>] run index|export|lint|inbox-process|inbox-reconcile [<inbox-id>] [--actor actor:user:local] [--out-dir public] [--base-url URL] [--enqueue] [--json]",
    );
  }
  if (target === "inbox-process" && id === undefined) {
    throw new Error("Usage: openwiki [--root <path>] run inbox-process <inbox-id> [--actor actor:user:local] [--enqueue] [--json]");
  }

  const runType =
    target === "index"
      ? "index.rebuild"
      : target === "export"
        ? "static.export"
        : target === "inbox-process"
          ? "inbox.process"
          : target === "inbox-reconcile"
            ? "inbox.reconcile"
            : "lint";
  const input =
    target === "export"
      ? {
          ...(options.outDir === undefined ? {} : { out_dir: options.outDir }),
          ...(options.baseUrl === undefined ? {} : { base_url: options.baseUrl }),
        }
      : target === "inbox-process"
        ? { id }
      : {};
  if (options.enqueue) {
    const run = await createRun({
      root: await resolveRoot(options),
      runType,
      ...(options.actor === undefined ? {} : { actorId: options.actor }),
      ...(Object.keys(input).length === 0 ? {} : { input }),
    });
    if (options.json) {
      printJson({ run });
      return;
    }
    console.log(`queued ${run.id} ${run.run_type}`);
    return;
  }
  const result = await runLocalJob({
    root: await resolveRoot(options),
    runType,
    ...(options.actor === undefined ? {} : { actorId: options.actor }),
    ...(Object.keys(input).length === 0 ? {} : { input }),
  });
  if (options.json) {
    printJson(result);
    return;
  }
  console.log(`${result.run.status} ${result.run.id} ${result.run.run_type}`);
  if (result.run.error) {
    console.log(result.run.error);
  }
}

export async function workerCommand(options: CliOptions): Promise<void> {
  const abortController = new AbortController();
  let workerDone: Promise<void> = Promise.resolve();
  const unregisterShutdown = registerCliShutdownHook(async () => {
    abortController.abort();
    await workerDone;
  });
  const workerResult = runWorker({
    root: await resolveRoot(options),
    ...(options.actor === undefined ? {} : { workerId: options.actor }),
    ...(options.once ? { once: true } : {}),
    ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
    ...(options.maxJobs === undefined ? {} : { maxJobs: options.maxJobs }),
    signal: abortController.signal,
  });
  workerDone = workerResult.then(() => undefined, () => undefined);
  const result = await workerResult.finally(unregisterShutdown);
  if (options.json) {
    printJson(result);
    return;
  }
  if (result.processed.length === 0) {
    console.log("No queued OpenWiki runs");
    return;
  }
  for (const run of result.processed) {
    console.log(`${run.status} ${run.id} ${run.run_type}`);
  }
}
