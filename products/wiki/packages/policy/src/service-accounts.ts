import { createHash, timingSafeEqual } from "node:crypto";
import { uniqueStrings, type OpenWikiAuthServiceAccount, type OpenWikiAuthServiceAccountToken, type OpenWikiConfig, type OpenWikiRuntimeServiceAccountRecord, type OpenWikiScope } from "@openwiki/core";
import type { PolicyBounds, ResolvedServiceAccount } from "./types.ts";
import { scopesForRole, uniqueScopes } from "./operations.ts";
import { mergePolicyBounds, policyBoundsFromConfig } from "./bounds.ts";

export function hashOpenWikiToken(token: string): string {
  return `sha256:${createHash("sha256").update(token).digest("hex")}`;
}

export function resolveServiceAccountToken(
  config: Pick<OpenWikiConfig, "auth">,
  token: string | undefined,
): ResolvedServiceAccount | undefined {
  if (!token?.trim()) {
    return undefined;
  }
  const tokenHash = hashOpenWikiToken(token);
  const serviceAccount = config.auth?.service_accounts?.find((account) => serviceAccountMatchingActiveToken(account, tokenHash) !== undefined);
  if (!serviceAccount) {
    return undefined;
  }
  const accountToken = serviceAccountMatchingActiveToken(serviceAccount, tokenHash);
  return {
    serviceAccountId: serviceAccount.id,
    actorId: serviceAccount.actor_id,
    ...(serviceAccount.role === undefined ? {} : { role: serviceAccount.role }),
    scopes: serviceAccountEffectiveScopes(serviceAccount),
    ...(serviceAccount.principals === undefined ? {} : { principals: serviceAccount.principals }),
    ...optionalBounds(mergePolicyBounds(policyBoundsFromConfig(serviceAccount.bounds), policyBoundsFromConfig(accountToken?.bounds))),
  };
}

function serviceAccountEffectiveScopes(account: Pick<OpenWikiAuthServiceAccount, "role" | "scopes">): OpenWikiScope[] {
  const roleScopes = account.role === undefined ? [] : scopesForRole(account.role);
  return uniqueScopes([...roleScopes, ...(account.scopes ?? [])]);
}

function serviceAccountTokenHashCount(account: Pick<OpenWikiAuthServiceAccount, "tokens" | "token_hashes">): number {
  return (account.tokens?.length ?? 0) + (account.token_hashes?.length ?? 0);
}

export function sanitizeServiceAccount(account: OpenWikiAuthServiceAccount): OpenWikiRuntimeServiceAccountRecord {
  const tokens = serviceAccountTokenSummaries(account);
  return {
    id: account.id,
    actor_id: account.actor_id,
    ...(account.description === undefined ? {} : { description: account.description }),
    ...(account.role === undefined ? {} : { role: account.role }),
    scopes: serviceAccountEffectiveScopes(account),
    principals: uniqueStrings(account.principals ?? []),
    token_hash_count: serviceAccountTokenHashCount(account),
    active_token_count: tokens.filter((entry) => entry.status === "active").length,
    revoked_token_count: tokens.filter((entry) => entry.status === "revoked").length,
    expired_token_count: tokens.filter((entry) => entry.status === "expired").length,
    ...(tokens.length === 0 ? {} : { tokens }),
    ...(account.created_at === undefined ? {} : { created_at: account.created_at }),
    ...(account.updated_at === undefined ? {} : { updated_at: account.updated_at }),
    ...(account.expires_at === undefined ? {} : { expires_at: account.expires_at }),
  };
}

function serviceAccountMatchingActiveToken(account: OpenWikiAuthServiceAccount, tokenHash: string): OpenWikiAuthServiceAccountToken | null | undefined {
  if (account.expires_at !== undefined && isPastIsoTimestamp(account.expires_at)) {
    return undefined;
  }
  for (const accountToken of account.tokens ?? []) {
    if (accountToken.revoked_at !== undefined || (accountToken.expires_at !== undefined && isPastIsoTimestamp(accountToken.expires_at))) {
      continue;
    }
    if (timingSafeTokenHashEquals(accountToken.token_hash, tokenHash)) {
      return accountToken;
    }
  }
  return (account.token_hashes ?? []).some((storedHash) => timingSafeTokenHashEquals(storedHash, tokenHash)) ? null : undefined;
}

function serviceAccountTokenSummaries(account: Pick<OpenWikiAuthServiceAccount, "tokens">): NonNullable<OpenWikiRuntimeServiceAccountRecord["tokens"]> {
  return (account.tokens ?? []).map((accountToken) => ({
    id: accountToken.id,
    ...(accountToken.description === undefined ? {} : { description: accountToken.description }),
    created_at: accountToken.created_at,
    ...(accountToken.expires_at === undefined ? {} : { expires_at: accountToken.expires_at }),
    ...(accountToken.revoked_at === undefined ? {} : { revoked_at: accountToken.revoked_at }),
    status: serviceAccountTokenStatus(accountToken),
  }));
}

function serviceAccountTokenStatus(accountToken: OpenWikiAuthServiceAccountToken): "active" | "expired" | "revoked" {
  if (accountToken.revoked_at !== undefined) {
    return "revoked";
  }
  if (accountToken.expires_at !== undefined && isPastIsoTimestamp(accountToken.expires_at)) {
    return "expired";
  }
  return "active";
}

function isPastIsoTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= Date.now();
}

function timingSafeTokenHashEquals(storedHash: string, candidateHash: string): boolean {
  const stored = Buffer.from(storedHash);
  const candidate = Buffer.from(candidateHash);
  return stored.byteLength === candidate.byteLength && timingSafeEqual(stored, candidate);
}

function optionalBounds(bounds: PolicyBounds | undefined): { bounds?: PolicyBounds } {
  return bounds === undefined ? {} : { bounds };
}
