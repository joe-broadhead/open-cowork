import { promises as fs } from "node:fs";
import path from "node:path";
import { atomicWriteFile, isoNow } from "@openwiki/core";
import { OpenWikiWriteInProgressError } from "@openwiki/workflows";

export type AutomationKind = "sync" | "backup" | "inbox";
export type AutomationRunStatus = "success" | "failed" | "skipped_busy" | "skipped_backoff";

export interface AutomationStateEntry {
  status: AutomationRunStatus;
  started_at: string;
  finished_at: string;
  message: string;
}

export interface AutomationState {
  schema_version: "openwiki.automation_state.v0";
  kind: AutomationKind;
  updated_at: string;
  consecutive_failures: number;
  last_run?: AutomationStateEntry;
  last_success?: AutomationStateEntry;
  last_failure?: AutomationStateEntry;
  next_run_at?: string;
}

interface AutomationRunResult {
  status: "success";
  message: string;
  details?: Record<string, unknown>;
}

interface ForegroundWatcherInput {
  root: string;
  kind: AutomationKind;
  everySeconds: number;
  once?: boolean;
  maxRuns?: number;
  jitterRatio?: number;
  initialJitterSeconds?: number;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  log?: (message: string) => void;
  runOnce(): Promise<AutomationRunResult>;
}

interface ForegroundWatcherResult {
  root: string;
  kind: AutomationKind;
  runs: AutomationStateEntry[];
  state: AutomationState;
}

export async function runForegroundWatcher(input: ForegroundWatcherInput): Promise<ForegroundWatcherResult> {
  const root = path.resolve(input.root);
  const runs: AutomationStateEntry[] = [];
  const maxRuns = input.maxRuns ?? (input.once === true ? 1 : Number.POSITIVE_INFINITY);
  const sleep = input.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let state = await readAutomationState(root, input.kind);
  if ((input.initialJitterSeconds ?? 0) > 0) {
    await sleep(Math.floor(Math.random() * Math.max(1, input.initialJitterSeconds ?? 0)) * 1000);
  }

  while (runs.length < maxRuns) {
    const now = input.now?.() ?? new Date();
    const backoffUntil = state.next_run_at === undefined ? Number.NaN : Date.parse(state.next_run_at);
    if (Number.isFinite(backoffUntil) && backoffUntil > now.getTime()) {
      const entry = automationEntry("skipped_backoff", now, input.now?.() ?? new Date(), `Backoff active until ${state.next_run_at}.`);
      state = await writeAutomationState(root, stateAfterRun(state, entry, input.everySeconds, input.now));
      runs.push(entry);
      input.log?.(`[${entry.finished_at}] ${input.kind} ${entry.status}: ${entry.message}`);
      if (input.once === true) {
        break;
      }
      await sleep(Math.max(0, backoffUntil - now.getTime()));
      continue;
    }

    const started = input.now?.() ?? new Date();
    let entry: AutomationStateEntry;
    try {
      const result = await input.runOnce();
      entry = automationEntry("success", started, input.now?.() ?? new Date(), result.message);
    } catch (error) {
      const finished = input.now?.() ?? new Date();
      if (error instanceof OpenWikiWriteInProgressError) {
        entry = automationEntry("skipped_busy", started, finished, error.message);
      } else {
        entry = automationEntry("failed", started, finished, error instanceof Error ? error.message : String(error));
      }
    }
    state = await writeAutomationState(root, stateAfterRun(state, entry, input.everySeconds, input.now));
    runs.push(entry);
    input.log?.(`[${entry.finished_at}] ${input.kind} ${entry.status}: ${entry.message}`);
    if (input.once === true) {
      break;
    }
    await sleep(delayWithJitter(input.everySeconds, input.jitterRatio ?? 0.1) * 1000);
  }

  return { root, kind: input.kind, runs, state };
}

export async function readAutomationState(root: string, kind: AutomationKind): Promise<AutomationState> {
  try {
    const parsed = JSON.parse(await fs.readFile(automationStatePath(root, kind), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return emptyAutomationState(kind);
    }
    const record = parsed as Record<string, unknown>;
    if (record.schema_version !== "openwiki.automation_state.v0" || record.kind !== kind || typeof record.updated_at !== "string") {
      return emptyAutomationState(kind);
    }
    const lastRun = automationEntryFromUnknown(record.last_run);
    const lastSuccess = automationEntryFromUnknown(record.last_success);
    const lastFailure = automationEntryFromUnknown(record.last_failure);
    return {
      schema_version: "openwiki.automation_state.v0",
      kind,
      updated_at: record.updated_at,
      consecutive_failures: typeof record.consecutive_failures === "number" ? Math.max(0, Math.floor(record.consecutive_failures)) : 0,
      ...(lastRun === undefined ? {} : { last_run: lastRun }),
      ...(lastSuccess === undefined ? {} : { last_success: lastSuccess }),
      ...(lastFailure === undefined ? {} : { last_failure: lastFailure }),
      ...(typeof record.next_run_at === "string" ? { next_run_at: record.next_run_at } : {}),
    };
  } catch {
    return emptyAutomationState(kind);
  }
}

function automationStatePath(root: string, kind: AutomationKind): string {
  return path.join(path.resolve(root), ".openwiki", "sync", "automation", `${kind}.json`);
}

export function parseAutomationIntervalSeconds(value: string): number {
  const match = /^([1-9][0-9]*)([smhd]?)$/.exec(value.trim());
  if (match === null) {
    throw new Error("--every must be a duration such as 15m, 1h, or 86400s");
  }
  const amount = Number(match[1]);
  const unit = match[2] || "s";
  const multiplier = unit === "d" ? 86400 : unit === "h" ? 3600 : unit === "m" ? 60 : 1;
  const seconds = amount * multiplier;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 604800) {
    throw new Error("--every must be between 1s and 7d");
  }
  return seconds;
}

async function writeAutomationState(root: string, state: AutomationState): Promise<AutomationState> {
  const statePath = automationStatePath(root, state.kind);
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await atomicWriteFile(statePath, JSON.stringify(state, null, 2) + "\n");
  return state;
}

function stateAfterRun(
  previous: AutomationState,
  entry: AutomationStateEntry,
  everySeconds: number,
  now: (() => Date) | undefined,
): AutomationState {
  const failures = entry.status === "failed" ? previous.consecutive_failures + 1 : entry.status === "skipped_busy" || entry.status === "skipped_backoff" ? previous.consecutive_failures : 0;
  const nextRunAt = entry.status === "failed" && failures >= 3
    ? new Date((now?.() ?? new Date()).getTime() + backoffSeconds(everySeconds, failures) * 1000).toISOString()
    : entry.status === "skipped_backoff"
      ? previous.next_run_at
    : undefined;
  return {
    schema_version: "openwiki.automation_state.v0",
    kind: previous.kind,
    updated_at: (now?.() ?? new Date()).toISOString(),
    consecutive_failures: failures,
    last_run: entry,
    ...(entry.status === "success" ? { last_success: entry } : previous.last_success === undefined ? {} : { last_success: previous.last_success }),
    ...(entry.status === "failed" ? { last_failure: entry } : previous.last_failure === undefined ? {} : { last_failure: previous.last_failure }),
    ...(nextRunAt === undefined ? {} : { next_run_at: nextRunAt }),
  };
}

function automationEntry(status: AutomationRunStatus, started: Date, finished: Date, message: string): AutomationStateEntry {
  return {
    status,
    started_at: started.toISOString(),
    finished_at: finished.toISOString(),
    message,
  };
}

function automationEntryFromUnknown(value: unknown): AutomationStateEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.status !== "string" ||
    !["success", "failed", "skipped_busy", "skipped_backoff"].includes(record.status) ||
    typeof record.started_at !== "string" ||
    typeof record.finished_at !== "string" ||
    typeof record.message !== "string"
  ) {
    return undefined;
  }
  return {
    status: record.status as AutomationRunStatus,
    started_at: record.started_at,
    finished_at: record.finished_at,
    message: record.message,
  };
}

function emptyAutomationState(kind: AutomationKind): AutomationState {
  return {
    schema_version: "openwiki.automation_state.v0",
    kind,
    updated_at: isoNow(),
    consecutive_failures: 0,
  };
}

function backoffSeconds(everySeconds: number, failures: number): number {
  return everySeconds * Math.min(8, 2 ** Math.max(0, failures - 2));
}

function delayWithJitter(everySeconds: number, jitterRatio: number): number {
  if (jitterRatio <= 0) {
    return everySeconds;
  }
  const jitterWindow = Math.max(1, Math.floor(everySeconds * Math.min(jitterRatio, 0.5)));
  return Math.max(60, everySeconds + Math.floor((Math.random() * 2 - 1) * jitterWindow));
}
