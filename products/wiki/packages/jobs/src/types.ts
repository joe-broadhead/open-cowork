import type { OpenWikiQueueBackend, RunRecord, RunType } from "@openwiki/core";
import type { PolicyContext } from "@openwiki/policy";

export interface RunJobInput {
  root: string;
  runType: RunType | string;
  actorId?: string;
  input?: Record<string, unknown>;
  subjectIds?: string[];
  subjectPaths?: string[];
  policyContext?: PolicyContext;
}

export interface ExecuteRunInput {
  root: string;
  runId: string;
  workerId?: string;
  signal?: AbortSignal;
  policyContext?: PolicyContext;
}

export interface RunNextQueuedJobInput {
  root: string;
  workerId?: string;
  signal?: AbortSignal;
}

export interface RunWorkerInput {
  root: string;
  workerId?: string;
  once?: boolean;
  maxJobs?: number;
  pollMs?: number;
  signal?: AbortSignal;
}

export interface RunJobResult {
  run: RunRecord;
}

export interface RunNextQueuedJobResult {
  run?: RunRecord;
}

export interface RunWorkerResult {
  processed: RunRecord[];
}

export interface RunQueueAdapter {
  backend: OpenWikiQueueBackend;
  enqueue(input: RunJobInput): Promise<RunRecord>;
  get(runId: string): Promise<RunRecord | undefined>;
  claim(runId: string, workerId?: string): Promise<RunRecord>;
  claimNext(workerId?: string): Promise<RunRecord | undefined>;
  heartbeat?(run: RunRecord, workerId?: string): Promise<void>;
  complete(run: RunRecord, output: Record<string, unknown>, workerId?: string): Promise<RunRecord>;
  fail(run: RunRecord, message: string, workerId?: string): Promise<RunRecord>;
}
