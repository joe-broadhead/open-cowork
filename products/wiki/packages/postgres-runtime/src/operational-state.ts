import { loadRepository } from "@openwiki/repo";
import { openPostgresSql } from "./connection.ts";
import { numberField, stringField, timestampMsField } from "./rows.ts";
import type { DeletePostgresMcpHttpSessionInput, ExpirePostgresMcpHttpSessionsInput, IncrementPostgresRateLimitWindowInput, PostgresOperationalMcpSession, PostgresOperationalMcpToolMode, PostgresQuery, PostgresRateLimitWindow, ReadPostgresMcpHttpSessionInput, TouchPostgresMcpHttpSessionInput, UpsertPostgresMcpHttpSessionInput } from "./types.ts";

export async function upsertPostgresMcpHttpSession(input: UpsertPostgresMcpHttpSessionInput): Promise<void> {
  const repo = await loadRepository(input.root);
  const workspaceId = repo.config.workspace_id;
  const openedSql = openPostgresSql({ ...input, pooled: input.pooled ?? true });
  const { sql } = openedSql;
  try {
    const createdAt = new Date(input.session.createdAt).toISOString();
    const updatedAt = new Date(input.session.updatedAt).toISOString();
    const expiresAt = new Date(input.session.updatedAt + input.ttlMs).toISOString();
    await sql`
      INSERT INTO operational_mcp_sessions (
        workspace_id, session_id, root_path, tool_mode, protocol_version, created_at, updated_at, expires_at
      )
      VALUES (
        ${workspaceId}, ${input.session.id}, ${input.session.root}, ${input.session.toolMode}, ${input.session.protocolVersion}, ${createdAt}, ${updatedAt}, ${expiresAt}
      )
      ON CONFLICT (workspace_id, session_id) DO UPDATE SET
        root_path = EXCLUDED.root_path,
        tool_mode = EXCLUDED.tool_mode,
        protocol_version = EXCLUDED.protocol_version,
        updated_at = EXCLUDED.updated_at,
        expires_at = EXCLUDED.expires_at
    `;
  } finally {
    await openedSql.close();
  }
}

export async function readPostgresMcpHttpSession(input: ReadPostgresMcpHttpSessionInput): Promise<PostgresOperationalMcpSession | undefined> {
  const repo = await loadRepository(input.root);
  const workspaceId = repo.config.workspace_id;
  const now = Date.now();
  const openedSql = openPostgresSql({ ...input, pooled: input.pooled ?? true });
  const { sql } = openedSql;
  try {
    const rows = await sql<Array<Record<string, unknown>>>`
      SELECT session_id, root_path, tool_mode, protocol_version, created_at, updated_at, expires_at
      FROM operational_mcp_sessions
      WHERE workspace_id = ${workspaceId} AND session_id = ${input.sessionId}
      LIMIT 1
    `;
    const row = rows[0];
    if (row === undefined) {
      return undefined;
    }
    const expiresAt = timestampMsField(row, "expires_at");
    if (expiresAt !== undefined && expiresAt <= now) {
      await sql`
        DELETE FROM operational_mcp_sessions
        WHERE workspace_id = ${workspaceId} AND session_id = ${input.sessionId}
      `;
      return undefined;
    }
    return postgresMcpHttpSessionFromRow(row);
  } finally {
    await openedSql.close();
  }
}

export async function touchPostgresMcpHttpSession(input: TouchPostgresMcpHttpSessionInput): Promise<void> {
  const repo = await loadRepository(input.root);
  const workspaceId = repo.config.workspace_id;
  const updatedAt = new Date(input.updatedAt).toISOString();
  const expiresAt = new Date(input.updatedAt + input.ttlMs).toISOString();
  const openedSql = openPostgresSql({ ...input, pooled: input.pooled ?? true });
  const { sql } = openedSql;
  try {
    await sql`
      UPDATE operational_mcp_sessions
      SET updated_at = ${updatedAt}, expires_at = ${expiresAt}
      WHERE workspace_id = ${workspaceId} AND session_id = ${input.sessionId}
    `;
  } finally {
    await openedSql.close();
  }
}

export async function deletePostgresMcpHttpSession(input: DeletePostgresMcpHttpSessionInput): Promise<void> {
  const repo = await loadRepository(input.root);
  const workspaceId = repo.config.workspace_id;
  const openedSql = openPostgresSql({ ...input, pooled: input.pooled ?? true });
  const { sql } = openedSql;
  try {
    await sql`
      DELETE FROM operational_mcp_sessions
      WHERE workspace_id = ${workspaceId} AND session_id = ${input.sessionId}
    `;
  } finally {
    await openedSql.close();
  }
}

export async function expirePostgresMcpHttpSessions(input: ExpirePostgresMcpHttpSessionsInput): Promise<void> {
  const repo = await loadRepository(input.root);
  const workspaceId = repo.config.workspace_id;
  const now = new Date(input.now ?? Date.now()).toISOString();
  const openedSql = openPostgresSql({ ...input, pooled: input.pooled ?? true });
  const { sql } = openedSql;
  try {
    await sql`
      DELETE FROM operational_mcp_sessions
      WHERE workspace_id = ${workspaceId} AND expires_at <= ${now}
    `;
  } finally {
    await openedSql.close();
  }
}

export async function incrementPostgresRateLimitWindow(input: IncrementPostgresRateLimitWindowInput): Promise<PostgresRateLimitWindow> {
  const repo = await loadRepository(input.root);
  const workspaceId = repo.config.workspace_id;
  const now = new Date(input.now).toISOString();
  const expiresAt = new Date(input.now + input.windowMs).toISOString();
  const openedSql = openPostgresSql({ ...input, pooled: input.pooled ?? true });
  const { sql } = openedSql;
  try {
    return await sql.begin(async (tx) => {
      const query = tx as unknown as PostgresQuery;
      await query`
        DELETE FROM operational_rate_limits
        WHERE workspace_id = ${workspaceId} AND expires_at <= ${now}
      `;
      const rows = await query<Array<Record<string, unknown>>>`
        INSERT INTO operational_rate_limits (workspace_id, rate_key, started_at, count, expires_at)
        VALUES (${workspaceId}, ${input.key}, ${now}, 1, ${expiresAt})
        ON CONFLICT (workspace_id, rate_key) DO UPDATE SET
          started_at = CASE
            WHEN operational_rate_limits.expires_at <= ${now} THEN EXCLUDED.started_at
            ELSE operational_rate_limits.started_at
          END,
          count = CASE
            WHEN operational_rate_limits.expires_at <= ${now} THEN 1
            ELSE operational_rate_limits.count + 1
          END,
          expires_at = CASE
            WHEN operational_rate_limits.expires_at <= ${now} THEN EXCLUDED.expires_at
            ELSE operational_rate_limits.expires_at
          END
        RETURNING started_at, count
      `;
      await prunePostgresOperationalRateLimits(query, workspaceId, input.maxKeys, input.key);
      return postgresRateLimitWindowFromRow(rows[0]);
    });
  } finally {
    await openedSql.close();
  }
}

function postgresMcpHttpSessionFromRow(row: Record<string, unknown>): PostgresOperationalMcpSession | undefined {
  const id = stringField(row, "session_id");
  const root = stringField(row, "root_path");
  const toolMode = postgresOperationalMcpToolMode(stringField(row, "tool_mode"));
  const protocolVersion = stringField(row, "protocol_version");
  const createdAt = timestampMsField(row, "created_at");
  const updatedAt = timestampMsField(row, "updated_at");
  if (id === undefined || root === undefined || toolMode === undefined || protocolVersion === undefined || createdAt === undefined || updatedAt === undefined) {
    return undefined;
  }
  return {
    id,
    root,
    toolMode,
    protocolVersion,
    createdAt,
    updatedAt,
  };
}

function postgresOperationalMcpToolMode(value: string | undefined): PostgresOperationalMcpToolMode | undefined {
  return value === "read" || value === "proposal" || value === "write" ? value : undefined;
}

function postgresRateLimitWindowFromRow(row: Record<string, unknown> | undefined): PostgresRateLimitWindow {
  if (row === undefined) {
    throw new Error("Postgres rate limit window did not return a row");
  }
  const startedAt = timestampMsField(row, "started_at");
  if (startedAt === undefined) {
    throw new Error("Postgres rate limit window returned an invalid start time");
  }
  return {
    startedAt,
    count: numberField(row, "count"),
  };
}

async function prunePostgresOperationalRateLimits(sql: PostgresQuery, workspaceId: string, maxKeys: number, preserveKey: string): Promise<void> {
  const maxRows = Math.max(1, Math.trunc(maxKeys));
  const maxOtherRows = maxRows - 1;
  await sql`
    DELETE FROM operational_rate_limits
    WHERE workspace_id = ${workspaceId}
      AND rate_key <> ${preserveKey}
      AND rate_key IN (
        SELECT rate_key
        FROM (
          SELECT
            rate_key,
            row_number() OVER (ORDER BY started_at DESC, rate_key ASC) AS row_number
          FROM operational_rate_limits
          WHERE workspace_id = ${workspaceId}
            AND rate_key <> ${preserveKey}
        ) stale_rate_limits
        WHERE row_number > ${maxOtherRows}
      )
  `;
}
