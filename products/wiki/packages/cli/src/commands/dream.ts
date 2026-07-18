import { createRun, runLocalJob } from "@openwiki/jobs";
import { dreamRunReportForRun, dreamRunStatus, parseDreamPhaseNames } from "@openwiki/workflows";
import type { CliOptions } from "../args.ts";
import { printJson } from "../output.ts";
import { resolveRoot } from "../utils.ts";

export async function dreamCommand(args: string[], options: CliOptions): Promise<void> {
  const action = args[0] ?? "run";
  if (action === "run") {
    await dreamRunCommand(args.slice(1), options);
    return;
  }
  if (action === "status") {
    await dreamStatusCommand(args.slice(1), options);
    return;
  }
  if (action === "report") {
    await dreamReportCommand(args.slice(1), options);
    return;
  }
  throw new Error("Usage: openwiki [--root <path>] dream run|status|report ... [--json]");
}

async function dreamRunCommand(args: string[], options: CliOptions): Promise<void> {
  const root = await resolveRoot(options);
  const phases = parseDreamPhaseNames([...options.dreamPhases, ...args]);
  const input = dreamRunInput(options, phases);
  if (options.enqueue) {
    const run = await createRun({
      root,
      runType: "dream.run",
      ...(options.actor === undefined ? {} : { actorId: options.actor }),
      input,
    });
    if (options.json) {
      printJson({ run });
      return;
    }
    console.log(`queued ${run.id} ${run.run_type}`);
    return;
  }

  const result = await runLocalJob({
    root,
    runType: "dream.run",
    ...(options.actor === undefined ? {} : { actorId: options.actor }),
    input,
  });
  if (options.json) {
    printJson(result);
    return;
  }
  const output = result.run.output as { report?: { status?: string; item_count?: number; proposal_count?: number } } | undefined;
  console.log(`${result.run.status} ${result.run.id} ${result.run.run_type}`);
  console.log(`dream_status=${output?.report?.status ?? "unknown"} items=${output?.report?.item_count ?? 0} proposals=${output?.report?.proposal_count ?? 0}`);
  if (result.run.error) {
    console.log(result.run.error);
  }
}

async function dreamStatusCommand(args: string[], options: CliOptions): Promise<void> {
  const root = await resolveRoot(options);
  const requestedRunId = args[0];
  const result = await dreamRunStatus(root, {
    ...(requestedRunId === undefined ? {} : { runId: requestedRunId }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });
  if (requestedRunId !== undefined && result.run === undefined) {
    throw new Error(`Dream run not found: ${requestedRunId}`);
  }
  if (options.json) {
    printJson(result);
    return;
  }
  const runs = result.run === undefined ? result.runs : [result.run];
  for (const run of runs) {
    const report = run.output && typeof run.output === "object" ? (run.output as { report?: { status?: string; proposal_count?: number } }).report : undefined;
    console.log(`${run.created_at}  ${run.status}  ${run.id}  dream=${report?.status ?? "unknown"} proposals=${report?.proposal_count ?? 0}`);
  }
}

async function dreamReportCommand(args: string[], options: CliOptions): Promise<void> {
  const root = await resolveRoot(options);
  const result = await dreamRunReportForRun(root, args[0]);
  if (options.json) {
    printJson(result);
    return;
  }
  console.log(`${result.run.status} ${result.run.id} dream.run`);
  console.log(JSON.stringify(result.report, null, 2));
}

function dreamRunInput(options: CliOptions, phases: string[]): Record<string, unknown> {
  const createProposals = options.createProposals === true;
  return {
    phases,
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(options.timeoutMs === undefined ? {} : { timeout_ms: options.timeoutMs }),
    dry_run: options.dryRun === true ? true : !createProposals,
    ...(createProposals ? { create_proposals: true } : {}),
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.schemaPack === undefined ? {} : { schema_pack: options.schemaPack }),
  };
}
