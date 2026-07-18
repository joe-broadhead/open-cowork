import { type OpenWikiRole, type OpenWikiScope } from "@openwiki/core";
import { loadRepository } from "@openwiki/repo";
import type { PolicyBounds } from "@openwiki/policy";
import { openPostgresSql } from "./connection.ts";
import type { PostgresQuery, PostgresRuntimeOptions } from "./types.ts";

export interface PostgresOAuthClientRecord {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  public?: boolean;
  client_secret_hashes?: string[];
  actor_id: string;
  role?: OpenWikiRole;
  scopes?: OpenWikiScope[];
  principals?: string[];
  grant_types?: Array<"authorization_code" | "client_credentials" | "refresh_token">;
  bounds?: PolicyBounds;
  access_token_ttl_seconds?: number;
  refresh_token_ttl_seconds?: number;
  created_at?: string;
  updated_at?: string;
  expires_at?: string;
  approved_at?: string;
}

export interface PostgresOAuthAuthorizationCodeRecord {
  id: string;
  code_hash: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scopes: OpenWikiScope[];
  actor_id: string;
  role?: OpenWikiRole;
  principals?: string[];
  bounds?: PolicyBounds;
  created_at: string;
  expires_at: string;
  consumed_at?: string;
}

export interface PostgresOAuthTokenRecord {
  id: string;
  token_hash: string;
  client_id: string;
  actor_id: string;
  scopes: OpenWikiScope[];
  role?: OpenWikiRole;
  principals?: string[];
  bounds?: PolicyBounds;
  created_at: string;
  expires_at?: string;
  revoked_at?: string;
}

export interface PostgresOAuthState {
  dynamic_clients: PostgresOAuthClientRecord[];
  authorization_codes: PostgresOAuthAuthorizationCodeRecord[];
  access_tokens: PostgresOAuthTokenRecord[];
  refresh_tokens: PostgresOAuthTokenRecord[];
}

interface PostgresOAuthStateInput extends PostgresRuntimeOptions {
  root: string;
}

export async function readPostgresOAuthState(input: PostgresOAuthStateInput): Promise<PostgresOAuthState> {
  const repo = await loadRepository(input.root);
  const openedSql = openPostgresSql({ ...input, pooled: input.pooled ?? true });
  try {
    return await readPostgresOAuthStateForWorkspace(openedSql.sql, repo.config.workspace_id);
  } finally {
    await openedSql.close();
  }
}

export async function updatePostgresOAuthState<T>(
  input: PostgresOAuthStateInput,
  update: (state: PostgresOAuthState) => T | Promise<T>,
): Promise<T> {
  const repo = await loadRepository(input.root);
  const workspaceId = repo.config.workspace_id;
  const openedSql = openPostgresSql({ ...input, pooled: input.pooled ?? true });
  try {
    const result = await openedSql.sql.begin(async (tx) => {
      const query = tx as unknown as PostgresQuery;
      await query`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}), hashtext('openwiki-oauth-state'))`;
      const state = await readPostgresOAuthStateForWorkspace(query, workspaceId);
      const result = await update(state);
      await replacePostgresOAuthStateForWorkspace(query, workspaceId, prunePostgresOAuthState(state));
      return result;
    });
    return result as T;
  } finally {
    await openedSql.close();
  }
}

async function readPostgresOAuthStateForWorkspace(sql: PostgresQuery, workspaceId: string): Promise<PostgresOAuthState> {
  const [clients, authorizationCodes, accessTokens, refreshTokens] = await Promise.all([
    sql<Array<Record<string, unknown>>>`
      SELECT json
      FROM oauth_clients
      WHERE workspace_id = ${workspaceId} AND revoked_at IS NULL
      ORDER BY client_id
    `,
    sql<Array<Record<string, unknown>>>`
      SELECT metadata
      FROM oauth_authorization_codes
      WHERE workspace_id = ${workspaceId}
      ORDER BY code_id
    `,
    sql<Array<Record<string, unknown>>>`
      SELECT metadata
      FROM oauth_access_tokens
      WHERE workspace_id = ${workspaceId}
      ORDER BY token_id
    `,
    sql<Array<Record<string, unknown>>>`
      SELECT metadata
      FROM oauth_refresh_tokens
      WHERE workspace_id = ${workspaceId}
      ORDER BY token_id
    `,
  ]);
  return {
    dynamic_clients: clients.map((row) => row.json).filter(isPostgresOAuthClientRecord),
    authorization_codes: authorizationCodes.map((row) => row.metadata).filter(isPostgresOAuthAuthorizationCodeRecord),
    access_tokens: accessTokens.map((row) => row.metadata).filter(isPostgresOAuthTokenRecord),
    refresh_tokens: refreshTokens.map((row) => row.metadata).filter(isPostgresOAuthTokenRecord),
  };
}

async function replacePostgresOAuthStateForWorkspace(sql: PostgresQuery, workspaceId: string, state: PostgresOAuthState): Promise<void> {
  await sql`DELETE FROM oauth_clients WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM oauth_authorization_codes WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM oauth_access_tokens WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM oauth_refresh_tokens WHERE workspace_id = ${workspaceId}`;
  for (const client of state.dynamic_clients) {
    await sql`
      INSERT INTO oauth_clients (
        workspace_id, client_id, client_name, actor_id, role, scopes_json,
        principals_json, redirect_uris_json, grant_types_json, bounds_json,
        client_secret_hash_count, created_at, updated_at, expires_at,
        revoked_at, source_commit, json
      ) VALUES (
        ${workspaceId}, ${client.client_id}, ${client.client_name ?? null}, ${client.actor_id}, ${client.role ?? null},
        ${JSON.stringify(client.scopes ?? [])}::jsonb, ${JSON.stringify(client.principals ?? [])}::jsonb,
        ${JSON.stringify(client.redirect_uris)}::jsonb, ${JSON.stringify(client.grant_types ?? [])}::jsonb,
        ${JSON.stringify(client.bounds ?? {})}::jsonb, ${client.client_secret_hashes?.length ?? 0},
        ${client.created_at ?? new Date().toISOString()}, ${client.updated_at ?? client.created_at ?? new Date().toISOString()},
        ${client.expires_at ?? null}, NULL, 'operational-state', ${JSON.stringify(client)}::jsonb
      )
    `;
  }
  for (const code of state.authorization_codes) {
    await sql`
      INSERT INTO oauth_authorization_codes (
        workspace_id, code_id, code_hash, client_id, actor_id, redirect_uri,
        scopes_json, principals_json, bounds_json, code_challenge,
        created_at, expires_at, consumed_at, revoked_at, metadata
      ) VALUES (
        ${workspaceId}, ${code.id}, ${code.code_hash}, ${code.client_id}, ${code.actor_id}, ${code.redirect_uri},
        ${JSON.stringify(code.scopes)}::jsonb, ${JSON.stringify(code.principals ?? [])}::jsonb,
        ${JSON.stringify(code.bounds ?? {})}::jsonb, ${code.code_challenge},
        ${code.created_at}, ${code.expires_at}, ${code.consumed_at ?? null}, NULL, ${JSON.stringify(code)}::jsonb
      )
    `;
  }
  for (const token of state.access_tokens) {
    await insertPostgresOAuthToken(sql, "oauth_access_tokens", workspaceId, token);
  }
  for (const token of state.refresh_tokens) {
    await insertPostgresOAuthToken(sql, "oauth_refresh_tokens", workspaceId, token);
  }
}

async function insertPostgresOAuthToken(
  sql: PostgresQuery,
  table: "oauth_access_tokens" | "oauth_refresh_tokens",
  workspaceId: string,
  token: PostgresOAuthTokenRecord,
): Promise<void> {
  await sql`
    INSERT INTO ${sql(table)} (
      workspace_id, token_id, token_hash, client_id, actor_id, scopes_json,
      principals_json, bounds_json, created_at, expires_at, revoked_at, metadata
    ) VALUES (
      ${workspaceId}, ${token.id}, ${token.token_hash}, ${token.client_id}, ${token.actor_id},
      ${JSON.stringify(token.scopes)}::jsonb, ${JSON.stringify(token.principals ?? [])}::jsonb,
      ${JSON.stringify(token.bounds ?? {})}::jsonb, ${token.created_at}, ${token.expires_at ?? new Date(Date.now() + 60_000).toISOString()},
      ${token.revoked_at ?? null}, ${JSON.stringify(token)}::jsonb
    )
  `;
}

function prunePostgresOAuthState(state: PostgresOAuthState): PostgresOAuthState {
  return {
    dynamic_clients: state.dynamic_clients,
    authorization_codes: state.authorization_codes.filter((code) => code.consumed_at === undefined && !olderThanDays(code.expires_at, 0)),
    access_tokens: state.access_tokens.filter((token) => token.revoked_at === undefined || !olderThanDays(token.revoked_at, 7)),
    refresh_tokens: state.refresh_tokens.filter((token) => token.revoked_at === undefined || !olderThanDays(token.revoked_at, 7)),
  };
}

function isPostgresOAuthClientRecord(value: unknown): value is PostgresOAuthClientRecord {
  return isRecord(value) && typeof value.client_id === "string" && Array.isArray(value.redirect_uris) && typeof value.actor_id === "string";
}

function isPostgresOAuthAuthorizationCodeRecord(value: unknown): value is PostgresOAuthAuthorizationCodeRecord {
  return isRecord(value) && typeof value.id === "string" && typeof value.code_hash === "string" && typeof value.client_id === "string";
}

function isPostgresOAuthTokenRecord(value: unknown): value is PostgresOAuthTokenRecord {
  return isRecord(value) && typeof value.id === "string" && typeof value.token_hash === "string" && typeof value.client_id === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function olderThanDays(value: string, days: number): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp < Date.now() - days * 24 * 60 * 60 * 1000;
}
