import type { EventRecord, RunRecord } from "@openwiki/core";
import { readCurrentPostgresRun, readPostgresRuntimeQueueHealth } from "@openwiki/postgres-runtime";

export type RunStatus = RunRecord["status"];

export interface RunMonitorResponse {
  generated_at: string;
  workspace_id: string;
  source: "postgres-runtime" | "parser";
  counts: Record<RunStatus, number> & { total: number };
  filters: {
    statuses: RunStatus[];
    limit: number;
  };
  recent: RunRecord[];
  queue?: Awaited<ReturnType<typeof readPostgresRuntimeQueueHealth>>;
}

export interface RunDetailResponse {
  source: "postgres-runtime" | "parser";
  run: RunRecord;
  job?: NonNullable<Awaited<ReturnType<typeof readCurrentPostgresRun>>>["job"];
  attempts: NonNullable<Awaited<ReturnType<typeof readCurrentPostgresRun>>>["attempts"];
  events: EventRecord[];
}
