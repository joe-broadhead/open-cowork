import type { RunRecord, RunStatus } from "./records.ts";

export function isGraphSyntheticNode(id: string): boolean {
  return id.startsWith("topic:") || id.startsWith("section:");
}

export function synthesisTargetPath(title: string, pageType = "concept"): string {
  const safePageType = safePageTypePathPart(pageType);
  return ["wiki", pluralizePathPart(safePageType), slugPath(title) + ".md"].join("/");
}

function safePageTypePathPart(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized)) {
    throw new Error("Expected page_type to be a safe path segment");
  }
  return normalized;
}

function pluralizePathPart(value: string): string {
  if (value === "entity") {
    return "entities";
  }
  if (value === "person") {
    return "people";
  }
  return value.endsWith("s") ? value : value + "s";
}

function slugPath(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "page";
}

export function humanLabel(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

export function runStatusCounts(runs: RunRecord[]): Record<RunStatus, number> & { total: number } {
  return {
    total: runs.length,
    queued: runs.filter((run) => run.status === "queued").length,
    running: runs.filter((run) => run.status === "running").length,
    succeeded: runs.filter((run) => run.status === "succeeded").length,
    failed: runs.filter((run) => run.status === "failed").length,
  };
}

export function filterRunsByStatuses(runs: RunRecord[], statuses: RunStatus[] | undefined): RunRecord[] {
  if (statuses === undefined || statuses.length === 0) {
    return runs;
  }
  const allowed = new Set(statuses);
  return runs.filter((run) => allowed.has(run.status));
}
