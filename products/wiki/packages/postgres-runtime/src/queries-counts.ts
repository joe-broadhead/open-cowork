import type { CountRow, PostgresQuery, PostgresRuntimeCountTable, SourceCommitRow } from "./types.ts";

export async function recordTypeCount(sql: PostgresQuery, workspaceId: string, type: string): Promise<number> {
  const rows = await sql<CountRow[]>`SELECT COUNT(*) AS count FROM records WHERE workspace_id = ${workspaceId} AND record_type = ${type}`;
  return Number(rows[0]?.count ?? 0);
}

export function metadataCount(metadata: Map<string, string>, key: string): number | undefined {
  const value = metadata.get(key);
  if (value === undefined) {
    return undefined;
  }
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? count : undefined;
}

export async function tableCount(sql: PostgresQuery, table: PostgresRuntimeCountTable, workspaceId: string): Promise<number> {
  let rows: CountRow[];
  switch (table) {
    case "records":
      rows = await sql<CountRow[]>`SELECT COUNT(*) AS count FROM records WHERE workspace_id = ${workspaceId}`;
      break;
    case "edges":
      rows = await sql<CountRow[]>`SELECT COUNT(*) AS count FROM edges WHERE workspace_id = ${workspaceId}`;
      break;
    case "search_documents":
      rows = await sql<CountRow[]>`SELECT COUNT(*) AS count FROM search_documents WHERE workspace_id = ${workspaceId}`;
      break;
    case "effective_permissions":
      rows = await sql<CountRow[]>`SELECT COUNT(*) AS count FROM effective_permissions WHERE workspace_id = ${workspaceId}`;
      break;
    case "source_objects":
      rows = await sql<CountRow[]>`SELECT COUNT(*) AS count FROM source_objects WHERE workspace_id = ${workspaceId}`;
      break;
  }
  return Number(rows[0]?.count ?? 0);
}

export async function runStatusCount(sql: PostgresQuery, workspaceId: string, status: "queued" | "running" | "succeeded" | "failed"): Promise<number> {
  const rows = await sql<CountRow[]>`SELECT COUNT(*) AS count FROM runs WHERE workspace_id = ${workspaceId} AND status = ${status}`;
  return Number(rows[0]?.count ?? 0);
}

export async function jobStatusCount(sql: PostgresQuery, workspaceId: string, status: "queued" | "running" | "succeeded" | "failed"): Promise<number> {
  const rows = await sql<CountRow[]>`SELECT COUNT(*) AS count FROM jobs WHERE workspace_id = ${workspaceId} AND status = ${status}`;
  return Number(rows[0]?.count ?? 0);
}

export async function workspaceSourceCommit(sql: PostgresQuery, workspaceId: string): Promise<{ source_commit?: string }> {
  const rows = await sql<SourceCommitRow[]>`SELECT source_commit FROM workspaces WHERE workspace_id = ${workspaceId} LIMIT 1`;
  return rows[0]?.source_commit === undefined ? {} : { source_commit: rows[0].source_commit };
}
