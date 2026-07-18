import path from "node:path";
import { assertOpenWikiId, boundedOpenWikiListLimit, idToUri, isoNow, openWikiEventSubjectPaths, openWikiRunSubjectPaths, uniqueStrings, type EventRecord, type RunRecord } from "@openwiki/core";
import { loadEvents, loadRuns, readConfig } from "./loaders.ts";
import { loadRepository } from "./workspace.ts";
import { normalizeRun } from "./normalizers.ts";
import { appendRepoTextFile, dateSequenceId, nextDailySequence, withWorkspaceFileLock, writeRepoTextFile } from "./io.ts";
import type { AppendEventInput, AppendRunInput } from "./types.ts";

export async function listEvents(root: string, limit = 50): Promise<{ events: EventRecord[] }> {
  const events = await loadEvents(path.resolve(root));
  return {
    events: events.slice(0, boundedOpenWikiListLimit(limit, 50, 1000)),
  };
}

export async function appendEvent(root: string, input: AppendEventInput): Promise<EventRecord> {
  const resolved = path.resolve(root);
  return withWorkspaceFileLock(resolved, "events", async () => {
    const config = await readConfig(resolved);
    const events = await loadEvents(resolved);
    const occurredAt = input.occurred_at ?? isoNow();
    const sequence = nextDailySequence(events.map((event) => event.id), "event", occurredAt);
    const eventId = dateSequenceId("event", occurredAt, sequence);
    const event: EventRecord = {
      id: eventId,
      uri: idToUri(eventId),
      type: input.type,
      workspace_id: config.workspace_id,
      occurred_at: occurredAt,
      path: "events/events.jsonl",
    };
    if (input.actor_id !== undefined) {
      assertOpenWikiId(input.actor_id, "actor");
      event.actor_id = input.actor_id;
    }
    if (input.operation !== undefined) {
      event.operation = input.operation;
    }
    if (input.record_id !== undefined) {
      event.record_id = input.record_id;
    }
    if (input.record_type !== undefined) {
      event.record_type = input.record_type;
    }
    if (input.data !== undefined) {
      event.data = input.data;
    }
    const subjectIds = uniqueStrings([
      ...(input.record_id === undefined ? [] : [input.record_id]),
      ...(input.subject_ids ?? []),
    ], { omitEmpty: true });
    if (subjectIds.length > 0) {
      event.subject_ids = subjectIds;
    }
    const subjectPaths = openWikiEventSubjectPaths({ explicitPaths: input.subject_paths, data: input.data });
    if (subjectPaths.length > 0) {
      event.subject_paths = subjectPaths;
    }
    if (input.sensitivity !== undefined) {
      event.sensitivity = input.sensitivity;
    }

    await appendRepoTextFile(resolved, event.path, `${JSON.stringify(event)}\n`);
    return event;
  });
}

export async function listRuns(root: string, limit = 50): Promise<{ runs: RunRecord[] }> {
  const runs = await loadRuns(path.resolve(root));
  return {
    runs: runs.slice(0, boundedOpenWikiListLimit(limit, 50, 1000)),
  };
}

export async function appendRun(root: string, input: AppendRunInput): Promise<RunRecord> {
  const resolved = path.resolve(root);
  return withWorkspaceFileLock(resolved, "runs", async () => {
    const config = await readConfig(resolved);
    const runs = await loadRuns(resolved);
    const createdAt = input.created_at ?? isoNow();
    const sequence = nextDailySequence(runs.map((run) => run.id), "run", createdAt);
    const runId = dateSequenceId("run", createdAt, sequence);
    const run: RunRecord = {
      id: runId,
      uri: idToUri(runId),
      type: "run",
      run_type: input.run_type,
      status: input.status ?? "queued",
      actor_id: input.actor_id ?? "actor:system:openwiki",
      workspace_id: config.workspace_id,
      created_at: createdAt,
      path: "runs/runs.jsonl",
    };
    assertOpenWikiId(run.actor_id, "actor");
    if (input.started_at !== undefined) {
      run.started_at = input.started_at;
    }
    if (input.completed_at !== undefined) {
      run.completed_at = input.completed_at;
    }
    if (input.input !== undefined) {
      run.input = input.input;
    }
    if (input.output !== undefined) {
      run.output = input.output;
    }
    if (input.error !== undefined) {
      run.error = input.error;
    }
    const subjectIds = uniqueStrings(input.subject_ids ?? [], { omitEmpty: true });
    if (subjectIds.length > 0) {
      run.subject_ids = subjectIds;
    }
    const subjectPaths = openWikiRunSubjectPaths({ explicitPaths: input.subject_paths, input: input.input, output: input.output });
    if (subjectPaths.length > 0) {
      run.subject_paths = subjectPaths;
    }
    if (input.sensitivity !== undefined) {
      run.sensitivity = input.sensitivity;
    }

    await appendRepoTextFile(resolved, run.path, `${JSON.stringify(run)}\n`);
    return run;
  });
}

export async function updateRun(root: string, run: RunRecord): Promise<RunRecord> {
  const resolved = path.resolve(root);
  return withWorkspaceFileLock(resolved, "runs", async () => {
    const normalized = normalizeRun({ ...run, path: "runs/runs.jsonl" });
    const runs = await loadRuns(resolved);
    if (!runs.some((candidate) => candidate.id === normalized.id)) {
      throw new Error(`Run not found: ${normalized.id}`);
    }
    const nextRuns = runs
      .map((candidate) => (candidate.id === normalized.id ? normalized : candidate))
      .sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id));
    await writeRepoTextFile(resolved, normalized.path, nextRuns.map((record) => JSON.stringify(record)).join("\n").concat("\n"));
    return normalized;
  });
}

export async function updateRunIfStatus(root: string, run: RunRecord, expectedStatus: RunRecord["status"]): Promise<RunRecord> {
  const resolved = path.resolve(root);
  return withWorkspaceFileLock(resolved, "runs", async () => {
    const normalized = normalizeRun({ ...run, path: "runs/runs.jsonl" });
    const runs = await loadRuns(resolved);
    const current = runs.find((candidate) => candidate.id === normalized.id);
    if (!current) {
      throw new Error(`Run not found: ${normalized.id}`);
    }
    if (current.status !== expectedStatus) {
      throw new Error(`Run ${normalized.id} is ${current.status}, expected ${expectedStatus}`);
    }
    const nextRuns = runs
      .map((candidate) => (candidate.id === normalized.id ? normalized : candidate))
      .sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id));
    await writeRepoTextFile(resolved, normalized.path, nextRuns.map((record) => JSON.stringify(record)).join("\n").concat("\n"));
    return normalized;
  });
}

export async function claimQueuedRun(root: string, runId: string, startedAt = isoNow()): Promise<RunRecord> {
  const resolved = path.resolve(root);
  return withWorkspaceFileLock(resolved, "runs", async () => {
    const runs = await loadRuns(resolved);
    const current = runs.find((candidate) => candidate.id === runId || candidate.uri === runId);
    if (!current) {
      throw new Error(`Run not found: ${runId}`);
    }
    if (current.status !== "queued") {
      throw new Error(`Run ${current.id} is ${current.status}, expected queued`);
    }
    const claimed = normalizeRun({
      ...current,
      status: "running",
      started_at: startedAt,
      path: "runs/runs.jsonl",
    });
    const nextRuns = runs
      .map((candidate) => (candidate.id === claimed.id ? claimed : candidate))
      .sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id));
    await writeRepoTextFile(resolved, claimed.path, nextRuns.map((record) => JSON.stringify(record)).join("\n").concat("\n"));
    return claimed;
  });
}

export async function readRun(root: string, id: string): Promise<RunRecord> {
  const repo = await loadRepository(root);
  const match = repo.runs.find((run) => run.id === id || run.uri === id);
  if (!match) {
    throw new Error(`Run not found: ${id}`);
  }
  return match;
}
