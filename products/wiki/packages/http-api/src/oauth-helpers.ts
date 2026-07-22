import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { OpenWikiOAuthClientConfig, OpenWikiRole, OpenWikiScope } from "@openwiki/core";
import { hashOpenWikiToken, parseScopes, policyBoundsFromConfig, scopesForRole, uniqueScopes, type PolicyBounds } from "@openwiki/policy";
import { readConfig } from "@openwiki/repo";
import { firstHeader } from "./http-headers.ts";
import { readOAuthStateForRuntime } from "./oauth-runtime.ts";
import type { OAuthAuthorizationCodeRecord, OAuthClientRecord, OAuthTokenRecord } from "./oauth-state.ts";
import type { HttpRequestContext, HttpRouteResult } from "./types.ts";

export interface OAuthTokenIssueInput {
  client: OAuthClientRecord;
  actorId: string;
  scopes: OpenWikiScope[];
  role?: OpenWikiRole;
  principals?: string[];
  bounds?: PolicyBounds;
  includeRefreshToken: boolean;
}

export function issueOAuthTokens(input: OAuthTokenIssueInput): {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  accessRecord: OAuthTokenRecord;
  refreshRecord?: OAuthTokenRecord;
} {
  const now = Date.now();
  const accessTtlSeconds = boundedTtl(input.client.access_token_ttl_seconds, 3600, 60, 24 * 60 * 60);
  const refreshTtlSeconds = boundedTtl(input.client.refresh_token_ttl_seconds, 30 * 24 * 60 * 60, 3600, 90 * 24 * 60 * 60);
  const accessToken = randomToken("owat");
  const refreshToken = input.includeRefreshToken ? randomToken("owrt") : undefined;
  const common = {
    client_id: input.client.client_id,
    actor_id: input.actorId,
    scopes: input.scopes,
    ...(input.role === undefined ? {} : { role: input.role }),
    ...(input.principals === undefined ? {} : { principals: input.principals }),
    ...(input.bounds === undefined ? {} : { bounds: input.bounds }),
    created_at: new Date(now).toISOString(),
  };
  return {
    accessToken,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    expiresIn: accessTtlSeconds,
    accessRecord: {
      id: `oauth-access:${randomBytes(8).toString("hex")}`,
      token_hash: hashOpenWikiToken(accessToken),
      ...common,
      expires_at: new Date(now + accessTtlSeconds * 1000).toISOString(),
    },
    ...(refreshToken === undefined
      ? {}
      : {
          refreshRecord: {
            id: `oauth-refresh:${randomBytes(8).toString("hex")}`,
            token_hash: hashOpenWikiToken(refreshToken),
            ...common,
            expires_at: new Date(now + refreshTtlSeconds * 1000).toISOString(),
          },
        }),
  };
}

export function tokenResponse(input: ReturnType<typeof issueOAuthTokens>): HttpRouteResult {
  return {
    status: 200,
    body: {
      access_token: input.accessToken,
      token_type: "Bearer",
      expires_in: input.expiresIn,
      ...(input.refreshToken === undefined ? {} : { refresh_token: input.refreshToken }),
      scope: input.accessRecord.scopes.join(" "),
    },
  };
}

export async function findOAuthClient(root: string, clientId: string | undefined): Promise<OAuthClientRecord | undefined> {
  if (clientId === undefined || clientId.length === 0) {
    return undefined;
  }
  const config = await readConfig(root);
  const configured = (config.auth?.oauth?.clients ?? []).map(oauthClientFromConfig);
  const state = await readOAuthStateForRuntime(root);
  return [...configured, ...state.dynamic_clients].find((client) => client.client_id === clientId);
}

export function oauthClientFromConfig(client: OpenWikiOAuthClientConfig): OAuthClientRecord {
  const bounds = policyBoundsFromConfig(client.bounds);
  return {
    client_id: client.client_id,
    ...(client.client_name === undefined ? {} : { client_name: client.client_name }),
    redirect_uris: client.redirect_uris,
    ...(client.public === undefined ? {} : { public: client.public }),
    ...(client.client_secret_hashes === undefined ? {} : { client_secret_hashes: client.client_secret_hashes }),
    actor_id: client.actor_id,
    ...(client.role === undefined ? {} : { role: client.role }),
    ...(client.scopes === undefined ? {} : { scopes: client.scopes }),
    ...(client.principals === undefined ? {} : { principals: client.principals }),
    ...(client.grant_types === undefined ? {} : { grant_types: client.grant_types }),
    ...(bounds === undefined ? {} : { bounds }),
    ...(client.access_token_ttl_seconds === undefined ? {} : { access_token_ttl_seconds: client.access_token_ttl_seconds }),
    ...(client.refresh_token_ttl_seconds === undefined ? {} : { refresh_token_ttl_seconds: client.refresh_token_ttl_seconds }),
    ...(client.created_at === undefined ? {} : { created_at: client.created_at }),
    ...(client.updated_at === undefined ? {} : { updated_at: client.updated_at }),
    ...(client.expires_at === undefined ? {} : { expires_at: client.expires_at }),
    approved_at: client.created_at ?? "configured",
  };
}

export function requestedOAuthScopes(client: OAuthClientRecord, requested: string | undefined): OpenWikiScope[] | undefined {
  const allowed = new Set(clientEffectiveScopes(client));
  const scopes = requested === undefined || requested.trim().length === 0 ? [...allowed] : parseScopes(requested);
  if (scopes.length === 0 || scopes.some((scope) => !allowed.has(scope))) {
    return undefined;
  }
  return uniqueScopes(scopes);
}

export function clientEffectiveScopes(client: Pick<OAuthClientRecord, "role" | "scopes">): OpenWikiScope[] {
  return uniqueScopes([...(client.role === undefined ? scopesForRole("viewer") : scopesForRole(client.role)), ...(client.scopes ?? [])]);
}

export function clientCredentialsFromRequest(params: Record<string, unknown>, context: HttpRequestContext): { clientId?: string; secret?: string } {
  const basic = firstHeader(context.headers?.authorization);
  if (basic?.toLowerCase().startsWith("basic ") === true) {
    const decoded = Buffer.from(basic.slice(6), "base64").toString("utf8");
    const index = decoded.indexOf(":");
    if (index >= 0) {
      return { clientId: decoded.slice(0, index), secret: decoded.slice(index + 1) };
    }
  }
  return {
    ...optionalStringProperty(params.client_id, "clientId"),
    ...optionalStringProperty(params.client_secret, "secret"),
  };
}

export function clientSecretMatches(client: OAuthClientRecord, secret: string | undefined): boolean {
  if (secret === undefined || secret.length === 0) {
    return false;
  }
  const secretHash = hashOpenWikiToken(secret);
  return (client.client_secret_hashes ?? []).some((hash) => tokenMatches(hash, secretHash));
}

export function grantAllowed(client: OAuthClientRecord, grant: "authorization_code" | "client_credentials" | "refresh_token"): boolean {
  const grants = client.grant_types ?? ["authorization_code", "refresh_token"];
  return grants.includes(grant);
}

export function activeAuthorizationCodeMatches(record: OAuthAuthorizationCodeRecord, codeHash: string): boolean {
  return record.consumed_at === undefined && !isPastIsoTimestamp(record.expires_at) && tokenMatches(record.code_hash, codeHash);
}

export function activeTokenMatches(record: OAuthTokenRecord, tokenHash: string): boolean {
  return record.revoked_at === undefined && (record.expires_at === undefined || !isPastIsoTimestamp(record.expires_at)) && tokenMatches(record.token_hash, tokenHash);
}

export function tokenMatches(storedHash: string, candidateHash: string): boolean {
  const stored = Buffer.from(storedHash);
  const candidate = Buffer.from(candidateHash);
  return stored.byteLength === candidate.byteLength && timingSafeEqual(stored, candidate);
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function randomToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function boundedTtl(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(Math.trunc(value), min), max);
}

export function clientExpired(client: OAuthClientRecord): boolean {
  return client.expires_at !== undefined && isPastIsoTimestamp(client.expires_at);
}

export function isPastIsoTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= Date.now();
}

export function validRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1"));
  } catch {
    return false;
  }
}

export function objectBody(value: unknown): Record<string, unknown> {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function optionalStringProperty<Key extends string>(value: unknown, key: Key): Partial<Record<Key, string>> {
  const string = optionalString(value);
  return string === undefined ? {} : ({ [key]: string } as Partial<Record<Key, string>>);
}

export function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim());
  }
  return [];
}

export function optionalPrincipals(principals: string[]): { principals?: string[] } {
  const unique = principals.filter((principal, index, values) => principal.trim().length > 0 && values.indexOf(principal) === index);
  return unique.length === 0 ? {} : { principals: unique };
}

export function optionalBounds(bounds: PolicyBounds | undefined): { bounds?: PolicyBounds } {
  return bounds === undefined ? {} : { bounds };
}

export function oauthError(status: number, code: string, message: string): HttpRouteResult {
  return { status, body: { error: code, error_description: message } };
}
