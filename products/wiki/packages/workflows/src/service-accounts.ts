import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  type EventRecord,
  type OpenWikiAuthServiceAccount,
  type OpenWikiAuthServiceAccountToken,
  type OpenWikiConfig,
  type OpenWikiRole,
  type OpenWikiScope,
  assertOpenWikiId,
  atomicWriteFile,
  isoNow,
  slugify,
  uniqueStrings,
} from "@openwiki/core";
import { appendEvent, loadRepository } from "@openwiki/repo";
import { hashOpenWikiToken, sanitizeServiceAccount, scopesForRole } from "@openwiki/policy";
import { withWriteCoordination } from "./write-coordinator.ts";
import { rebuildDerivedIndexes } from "./derived-indexes.ts";
import type {
  SanitizedServiceAccount,
  ServiceAccountTokenCreateInput,
  ServiceAccountTokenListInput,
  ServiceAccountTokenListResult,
  ServiceAccountTokenProfile,
  ServiceAccountTokenResult,
  ServiceAccountTokenRevokeInput,
  ServiceAccountTokenRevokeResult,
  ServiceAccountTokenRotateInput,
} from "./types.ts";

export async function createServiceAccountToken(input: ServiceAccountTokenCreateInput): Promise<ServiceAccountTokenResult> {
  return withWriteCoordination(
    {
      root: input.root,
      operation: "wiki.admin",
      ...(input.auditActorId === undefined ? input.actorId === undefined ? {} : { actorId: input.actorId } : { actorId: input.auditActorId }),
      metadata: {
        service_account_id: input.id ?? defaultServiceAccountId(input.profile ?? "proposal-agent"),
        action: "token.create",
      },
    },
    () => createServiceAccountTokenUnlocked(input),
  );
}

async function createServiceAccountTokenUnlocked(input: ServiceAccountTokenCreateInput): Promise<ServiceAccountTokenResult> {
  const repo = await loadRepository(input.root);
  const now = isoNow();
  const profile = input.profile ?? "proposal-agent";
  const defaults = serviceAccountProfileDefaults(profile);
  const accountId = input.id ?? defaultServiceAccountId(profile);
  const token = generateServiceAccountToken(profile);
  const expiresAt = serviceAccountTokenExpiresAt(input, now);
  const tokenRecord = serviceAccountTokenRecord({
    accountId,
    token,
    now,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    description: input.tokenDescription ?? input.description ?? defaults.tokenDescription,
  });
  const nextConfig = updateServiceAccounts(repo.config, (accounts) => {
    const existing = accounts.find((account) => account.id === accountId);
    const base = existing ?? emptyServiceAccount(accountId, input.actorId ?? defaultServiceAccountActorId(accountId), now);
    const nextScopes = input.scopes ?? existing?.scopes ?? defaults.scopes;
    const nextRole = input.role ?? existing?.role ?? defaults.role;
    const next = mergeServiceAccount(base, {
      actor_id: input.actorId ?? existing?.actor_id ?? defaultServiceAccountActorId(accountId),
      ...(nextRole === undefined ? {} : { role: nextRole }),
      ...(nextScopes === undefined ? {} : { scopes: nextScopes }),
      principals: serviceAccountPrincipals(input, existing, defaults),
      description: input.description ?? existing?.description ?? defaults.description,
      updated_at: now,
      ...(existing?.created_at === undefined ? { created_at: now } : { created_at: existing.created_at }),
      ...(existing?.expires_at === undefined ? {} : { expires_at: existing.expires_at }),
      tokens: [...(existing?.tokens ?? []), tokenRecord],
      ...(existing?.token_hashes === undefined ? {} : { token_hashes: existing.token_hashes }),
    });
    return upsertServiceAccount(accounts, next);
  });
  await writeConfig(repo.root, nextConfig);
  const serviceAccount = serviceAccountById(nextConfig, accountId);
  const event = await appendServiceAccountTokenEvent(repo.root, {
    type: "auth.token.created",
    operation: "wiki.admin",
    ...(input.auditActorId === undefined ? {} : { actorId: input.auditActorId }),
    account: serviceAccount,
    tokenIds: [tokenRecord.id],
    occurredAt: now,
    data: {
      profile,
      token_id: tokenRecord.id,
      ...(tokenRecord.expires_at === undefined ? {} : { expires_at: tokenRecord.expires_at }),
    },
  });
  await rebuildDerivedIndexes(repo.root);
  return {
    service_account: redactServiceAccount(serviceAccount),
    token: {
      id: tokenRecord.id,
      value: token,
      created_at: tokenRecord.created_at,
      ...(tokenRecord.expires_at === undefined ? {} : { expires_at: tokenRecord.expires_at }),
    },
    event,
  };
}

export async function listServiceAccountTokens(input: ServiceAccountTokenListInput): Promise<ServiceAccountTokenListResult> {
  const repo = await loadRepository(input.root);
  const accounts = repo.config.auth?.service_accounts ?? [];
  return {
    service_accounts: accounts
      .filter((account) => input.id === undefined || account.id === input.id)
      .map((account) => redactServiceAccount(account))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export async function inspectServiceAccountToken(input: ServiceAccountTokenListInput & { id: string }): Promise<{ service_account: SanitizedServiceAccount }> {
  const result = await listServiceAccountTokens(input);
  const serviceAccount = result.service_accounts.find((account) => account.id === input.id);
  if (serviceAccount === undefined) {
    throw new Error(`Service account not found: ${input.id}`);
  }
  return { service_account: serviceAccount };
}

export async function revokeServiceAccountToken(input: ServiceAccountTokenRevokeInput): Promise<ServiceAccountTokenRevokeResult> {
  return withWriteCoordination(
    {
      root: input.root,
      operation: "wiki.admin",
      ...(input.auditActorId === undefined ? {} : { actorId: input.auditActorId }),
      metadata: {
        service_account_id: input.id,
        action: "token.revoke",
        ...(input.tokenId === undefined ? {} : { token_id: input.tokenId }),
      },
    },
    () => revokeServiceAccountTokenUnlocked(input),
  );
}

async function revokeServiceAccountTokenUnlocked(input: ServiceAccountTokenRevokeInput): Promise<ServiceAccountTokenRevokeResult> {
  const repo = await loadRepository(input.root);
  const now = isoNow();
  let revokedTokenIds: string[] = [];
  let legacyHashCount = 0;
  const nextConfig = updateServiceAccounts(repo.config, (accounts) =>
    accounts.map((account) => {
      if (account.id !== input.id) {
        return account;
      }
      const nextTokens = (account.tokens ?? []).map((token) => {
        if (token.revoked_at !== undefined || (input.tokenId !== undefined && token.id !== input.tokenId)) {
          return token;
        }
        revokedTokenIds = [...revokedTokenIds, token.id];
        return { ...token, revoked_at: now };
      });
      const shouldRemoveLegacyHashes = input.tokenId === undefined && (account.token_hashes?.length ?? 0) > 0;
      if (shouldRemoveLegacyHashes) {
        legacyHashCount = account.token_hashes?.length ?? 0;
      }
      const { token_hashes: legacyTokenHashes, ...accountWithoutLegacyHashes } = account;
      return {
        ...accountWithoutLegacyHashes,
        updated_at: now,
        tokens: nextTokens,
        ...(shouldRemoveLegacyHashes ? {} : legacyTokenHashes === undefined ? {} : { token_hashes: legacyTokenHashes }),
      };
    }),
  );
  const serviceAccount = serviceAccountById(nextConfig, input.id);
  if (revokedTokenIds.length === 0 && legacyHashCount === 0) {
    throw new Error(input.tokenId === undefined ? `Service account ${input.id} has no active tokens to revoke` : `Active token not found: ${input.tokenId}`);
  }
  await writeConfig(repo.root, nextConfig);
  const event = await appendServiceAccountTokenEvent(repo.root, {
    type: "auth.token.revoked",
    operation: "wiki.admin",
    ...(input.auditActorId === undefined ? {} : { actorId: input.auditActorId }),
    account: serviceAccount,
    tokenIds: revokedTokenIds,
    occurredAt: now,
    data: {
      revoked_token_ids: revokedTokenIds,
      legacy_token_hashes_revoked: legacyHashCount,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    },
  });
  await rebuildDerivedIndexes(repo.root);
  return { service_account: redactServiceAccount(serviceAccount), revoked_token_ids: revokedTokenIds, event };
}

export async function rotateServiceAccountToken(input: ServiceAccountTokenRotateInput): Promise<ServiceAccountTokenResult> {
  return withWriteCoordination(
    {
      root: input.root,
      operation: "wiki.admin",
      ...(input.auditActorId === undefined ? input.actorId === undefined ? {} : { actorId: input.actorId } : { actorId: input.auditActorId }),
      metadata: {
        service_account_id: input.id,
        action: "token.rotate",
        ...(input.tokenId === undefined ? {} : { token_id: input.tokenId }),
      },
    },
    () => rotateServiceAccountTokenUnlocked(input),
  );
}

async function rotateServiceAccountTokenUnlocked(input: ServiceAccountTokenRotateInput): Promise<ServiceAccountTokenResult> {
  const repo = await loadRepository(input.root);
  const now = isoNow();
  const token = generateServiceAccountToken(input.profile ?? "proposal-agent");
  const expiresAt = serviceAccountTokenExpiresAt(input, now);
  const tokenDescription = input.tokenDescription ?? input.description;
  const newToken = serviceAccountTokenRecord({
    accountId: input.id,
    token,
    now,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(tokenDescription === undefined ? {} : { description: tokenDescription }),
  });
  let revokedTokenIds: string[] = [];
  let legacyHashCount = 0;
  const nextConfig = updateServiceAccounts(repo.config, (accounts) =>
    accounts.map((account) => {
      if (account.id !== input.id) {
        return account;
      }
      const nextTokens = (account.tokens ?? []).map((existingToken) => {
        if (existingToken.revoked_at !== undefined || (input.tokenId !== undefined && existingToken.id !== input.tokenId)) {
          return existingToken;
        }
        revokedTokenIds = [...revokedTokenIds, existingToken.id];
        return { ...existingToken, revoked_at: now };
      });
      const shouldRemoveLegacyHashes = input.tokenId === undefined && (account.token_hashes?.length ?? 0) > 0;
      if (shouldRemoveLegacyHashes) {
        legacyHashCount = account.token_hashes?.length ?? 0;
      }
      const { token_hashes: legacyTokenHashes, ...accountWithoutLegacyHashes } = account;
      return mergeServiceAccount(accountWithoutLegacyHashes, {
        ...(input.actorId === undefined ? {} : { actor_id: input.actorId }),
        ...(input.role === undefined ? {} : { role: input.role }),
        ...(input.scopes === undefined ? {} : { scopes: input.scopes }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.principals === undefined && input.groups === undefined
          ? {}
          : { principals: serviceAccountPrincipals(input, account, serviceAccountProfileDefaults(input.profile ?? "proposal-agent")) }),
        updated_at: now,
        tokens: [...nextTokens, newToken],
        ...(shouldRemoveLegacyHashes ? {} : legacyTokenHashes === undefined ? {} : { token_hashes: legacyTokenHashes }),
      });
    }),
  );
  const serviceAccount = serviceAccountById(nextConfig, input.id);
  if (revokedTokenIds.length === 0 && legacyHashCount === 0 && input.tokenId !== undefined) {
    throw new Error(`Active token not found: ${input.tokenId}`);
  }
  await writeConfig(repo.root, nextConfig);
  const event = await appendServiceAccountTokenEvent(repo.root, {
    type: "auth.token.rotated",
    operation: "wiki.admin",
    ...(input.auditActorId === undefined ? {} : { actorId: input.auditActorId }),
    account: serviceAccount,
    tokenIds: [newToken.id, ...revokedTokenIds],
    occurredAt: now,
    data: {
      new_token_id: newToken.id,
      revoked_token_ids: revokedTokenIds,
      legacy_token_hashes_revoked: legacyHashCount,
      ...(newToken.expires_at === undefined ? {} : { expires_at: newToken.expires_at }),
    },
  });
  await rebuildDerivedIndexes(repo.root);
  return {
    service_account: redactServiceAccount(serviceAccount),
    token: {
      id: newToken.id,
      value: token,
      created_at: newToken.created_at,
      ...(newToken.expires_at === undefined ? {} : { expires_at: newToken.expires_at }),
    },
    event,
  };
}

interface ServiceAccountProfileDefaults {
  role?: OpenWikiRole;
  scopes?: OpenWikiScope[];
  principals: string[];
  description: string;
  tokenDescription: string;
}

function serviceAccountProfileDefaults(profile: ServiceAccountTokenProfile): ServiceAccountProfileDefaults {
  if (profile === "hosted-readonly-agent") {
    return {
      role: "viewer",
      principals: ["group:all-users"],
      description: "Hosted read-only agent service account.",
      tokenDescription: "Hosted read-only agent token.",
    };
  }
  if (profile === "ci-bot") {
    return {
      role: "maintainer",
      principals: ["group:knowledge-maintainers"],
      description: "CI automation service account.",
      tokenDescription: "CI automation token.",
    };
  }
  if (profile === "inbox-submitter") {
    return {
      scopes: ["wiki:inbox:read", "wiki:inbox:submit"],
      principals: ["group:all-users"],
      description: "Hosted inbox submitter service account.",
      tokenDescription: "Inbox submitter token.",
    };
  }
  if (profile === "inbox-curator") {
    return {
      scopes: ["wiki:read", "wiki:search", "wiki:ask", "wiki:inbox:read", "wiki:inbox:submit", "wiki:inbox:process", "wiki:propose", "wiki:ingest:draft"],
      principals: ["group:knowledge-maintainers"],
      description: "Hosted inbox curator service account.",
      tokenDescription: "Inbox curator token.",
    };
  }
  if (profile === "maintainer-automation") {
    return {
      role: "maintainer",
      principals: ["group:knowledge-maintainers"],
      description: "Trusted maintainer automation service account.",
      tokenDescription: "Maintainer automation token.",
    };
  }
  if (profile === "local-agent") {
    return {
      role: "contributor",
      principals: ["group:knowledge-contributors"],
      description: "Local proposal-mode agent service account.",
      tokenDescription: "Local agent proposal token.",
    };
  }
  return {
    role: "contributor",
    principals: ["group:knowledge-contributors"],
    description: "Proposal-mode agent service account.",
    tokenDescription: "Proposal agent token.",
  };
}

function defaultServiceAccountId(profile: ServiceAccountTokenProfile): string {
  return `service:${profile}`;
}

function defaultServiceAccountActorId(accountId: string): string {
  return `actor:agent:${slugify(accountId.replace(/^service:/, ""))}`;
}

function generateServiceAccountToken(profile: ServiceAccountTokenProfile): string {
  const prefix =
    profile === "hosted-readonly-agent"
      ? "read"
      : profile === "inbox-submitter"
        ? "submit"
        : profile === "inbox-curator"
          ? "curate"
          : profile === "maintainer-automation"
            ? "maint"
            : profile === "ci-bot"
              ? "ci"
              : "agent";
  return `owk_${prefix}_${randomBytes(32).toString("base64url")}`;
}

function serviceAccountTokenRecord(input: {
  accountId: string;
  token: string;
  now: string;
  expiresAt?: string;
  description?: string;
}): OpenWikiAuthServiceAccountToken {
  return {
    id: `token:${slugify(input.accountId.replace(/^service:/, ""))}-${input.now.slice(0, 10)}-${randomBytes(6).toString("hex")}`,
    token_hash: hashOpenWikiToken(input.token),
    created_at: input.now,
    ...(input.expiresAt === undefined ? {} : { expires_at: input.expiresAt }),
    ...(input.description === undefined ? {} : { description: input.description }),
  };
}

function serviceAccountTokenExpiresAt(input: { expiresAt?: string; expiresInDays?: number }, now: string): string | undefined {
  if (input.expiresAt !== undefined) {
    assertIsoTimestamp(input.expiresAt, "--expires-at");
    return input.expiresAt;
  }
  if (input.expiresInDays === undefined) {
    return undefined;
  }
  if (!Number.isFinite(input.expiresInDays) || input.expiresInDays <= 0) {
    throw new Error("--expires-in-days must be a positive number");
  }
  return new Date(Date.parse(now) + input.expiresInDays * 24 * 60 * 60 * 1000).toISOString();
}

function assertIsoTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
}

function updateServiceAccounts(config: OpenWikiConfig, updater: (accounts: OpenWikiAuthServiceAccount[]) => OpenWikiAuthServiceAccount[]): OpenWikiConfig {
  const accounts = updater([...(config.auth?.service_accounts ?? [])]);
  return {
    ...config,
    auth: {
      ...(config.auth ?? {}),
      service_accounts: accounts.sort((left, right) => left.id.localeCompare(right.id)),
    },
  };
}

function emptyServiceAccount(id: string, actorId: string, now: string): OpenWikiAuthServiceAccount {
  assertOpenWikiId(actorId, "actor");
  return { id, actor_id: actorId, created_at: now, updated_at: now, tokens: [] };
}

function mergeServiceAccount(base: OpenWikiAuthServiceAccount, patch: Partial<OpenWikiAuthServiceAccount>): OpenWikiAuthServiceAccount {
  const actorId = patch.actor_id ?? base.actor_id;
  assertOpenWikiId(actorId, "actor");
  return {
    ...base,
    ...patch,
    actor_id: actorId,
    ...(patch.scopes === undefined && base.scopes === undefined ? {} : { scopes: uniqueStrings([...(patch.scopes ?? base.scopes ?? [])], { trim: true, omitEmpty: true }) as OpenWikiScope[] }),
    ...(patch.principals === undefined && base.principals === undefined ? {} : { principals: uniqueStrings([...(patch.principals ?? base.principals ?? [])], { trim: true, omitEmpty: true }) }),
  };
}

function serviceAccountPrincipals(
  input: Pick<ServiceAccountTokenCreateInput, "principals" | "groups">,
  existing: OpenWikiAuthServiceAccount | undefined,
  defaults: ServiceAccountProfileDefaults,
): string[] {
  const explicit = [...(input.principals ?? []), ...(input.groups ?? []).map((group) => (group.startsWith("group:") ? group : `group:${group}`))];
  return uniqueStrings(explicit.length === 0 ? existing?.principals ?? defaults.principals : explicit, { trim: true, omitEmpty: true });
}

function upsertServiceAccount(accounts: OpenWikiAuthServiceAccount[], next: OpenWikiAuthServiceAccount): OpenWikiAuthServiceAccount[] {
  const updated = accounts.map((account) => (account.id === next.id ? next : account));
  return updated.some((account) => account.id === next.id) ? updated : [...updated, next];
}

function serviceAccountById(config: OpenWikiConfig, id: string): OpenWikiAuthServiceAccount {
  const account = config.auth?.service_accounts?.find((candidate) => candidate.id === id);
  if (account === undefined) {
    throw new Error(`Service account not found: ${id}`);
  }
  return account;
}

function redactServiceAccount(account: OpenWikiAuthServiceAccount): SanitizedServiceAccount {
  const sanitized = sanitizeServiceAccount(account);
  return {
    ...sanitized,
    active_token_count: sanitized.active_token_count ?? 0,
    revoked_token_count: sanitized.revoked_token_count ?? 0,
    expired_token_count: sanitized.expired_token_count ?? 0,
    tokens: sanitized.tokens ?? [],
  };
}

async function appendServiceAccountTokenEvent(root: string, input: {
  type: string;
  operation: string;
  actorId?: string;
  account: OpenWikiAuthServiceAccount;
  tokenIds: string[];
  occurredAt: string;
  data: Record<string, unknown>;
}): Promise<EventRecord> {
  return appendEvent(root, {
    type: input.type,
    actor_id: input.actorId ?? "actor:user:local",
    operation: input.operation,
    record_id: input.account.id,
    record_type: "service_account",
    occurred_at: input.occurredAt,
    data: {
      account_id: input.account.id,
      actor_id: input.account.actor_id,
      role: input.account.role,
      scopes: input.account.role === undefined ? input.account.scopes ?? [] : uniqueStrings([...scopesForRole(input.account.role), ...(input.account.scopes ?? [])], { trim: true, omitEmpty: true }),
      principals: input.account.principals ?? [],
      token_ids: input.tokenIds,
      token_hash_count: (input.account.tokens?.length ?? 0) + (input.account.token_hashes?.length ?? 0),
      ...input.data,
    },
    subject_ids: [input.account.actor_id],
    sensitivity: "private",
  });
}

async function writeConfig(root: string, config: OpenWikiConfig): Promise<void> {
  await atomicWriteFile(path.join(root, "openwiki.json"), `${JSON.stringify(config, null, 2)}\n`);
}
