import { promises as fs } from "node:fs";
import path from "node:path";
import { atomicWriteFile, type OpenWikiRole, type OpenWikiScope } from "@openwiki/core";
import type { PolicyBounds } from "@openwiki/policy";

export interface OAuthClientRecord {
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

export interface OAuthAuthorizationCodeRecord {
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

export interface OAuthTokenRecord {
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

export interface OAuthState {
  dynamic_clients: OAuthClientRecord[];
  authorization_codes: OAuthAuthorizationCodeRecord[];
  access_tokens: OAuthTokenRecord[];
  refresh_tokens: OAuthTokenRecord[];
}

const oauthStateLocks = new Map<string, Promise<void>>();

export async function readOAuthState(root: string): Promise<OAuthState> {
  try {
    const parsed = JSON.parse(await fs.readFile(oauthStatePath(root), "utf8")) as Partial<OAuthState>;
    return {
      dynamic_clients: Array.isArray(parsed.dynamic_clients) ? parsed.dynamic_clients : [],
      authorization_codes: Array.isArray(parsed.authorization_codes) ? parsed.authorization_codes : [],
      access_tokens: Array.isArray(parsed.access_tokens) ? parsed.access_tokens : [],
      refresh_tokens: Array.isArray(parsed.refresh_tokens) ? parsed.refresh_tokens : [],
    };
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return emptyOAuthState();
    }
    throw error;
  }
}

export async function updateOAuthState<T>(root: string, update: (state: OAuthState) => T | Promise<T>): Promise<T> {
  const lockKey = oauthStatePath(root);
  const previous = oauthStateLocks.get(lockKey) ?? Promise.resolve();
  let release!: () => void;
  const current = previous.then(() => new Promise<void>((resolve) => {
    release = resolve;
  }));
  oauthStateLocks.set(lockKey, current);
  await previous;
  try {
    const state = await readOAuthState(root);
    const result = await update(state);
    await writeOAuthState(root, pruneOAuthState(state));
    return result;
  } finally {
    release();
    if (oauthStateLocks.get(lockKey) === current) {
      oauthStateLocks.delete(lockKey);
    }
  }
}

async function writeOAuthState(root: string, state: OAuthState): Promise<void> {
  const filePath = oauthStatePath(root);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await atomicWriteFile(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

function oauthStatePath(root: string): string {
  return path.join(root, ".openwiki", "runtime", "oauth-state.json");
}

function emptyOAuthState(): OAuthState {
  return { dynamic_clients: [], authorization_codes: [], access_tokens: [], refresh_tokens: [] };
}

function pruneOAuthState(state: OAuthState): OAuthState {
  return {
    dynamic_clients: state.dynamic_clients,
    authorization_codes: state.authorization_codes.filter((code) => code.consumed_at === undefined && !olderThanDays(code.expires_at, 0)),
    access_tokens: state.access_tokens.filter((token) => token.revoked_at === undefined || !olderThanDays(token.revoked_at, 7)),
    refresh_tokens: state.refresh_tokens.filter((token) => token.revoked_at === undefined || !olderThanDays(token.revoked_at, 7)),
  };
}

function olderThanDays(value: string, days: number): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp < Date.now() - days * 24 * 60 * 60 * 1000;
}
