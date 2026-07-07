import {
  clone,
  key,
  normalizeText,
  nowIso,
} from './store-helpers.ts'
import {
  generateCloudApiToken,
  hashCloudApiToken,
  plaintextMatchesCloudApiTokenId,
  verifyCloudApiTokenHash,
} from '../control-plane-tokens.ts'
import type {
  ApiTokenChannelBindingGrantRecord,
  ApiTokenRecord,
  AuditEventRecord,
  ChannelBindingRecord,
  GrantApiTokenChannelBindingInput,
  IssueApiTokenInput,
  IssuedApiTokenRecord,
  ListApiTokenChannelBindingGrantsInput,
  RecordAuditEventInput,
  RevokeApiTokenInput,
  RevokeApiTokensForAccountInput,
} from '../control-plane-store.ts'

// API-token domain extracted from in-memory-control-plane-store.ts. Owns the token
// records + the token↔channel-binding grant index, and the issue (generate + hash)
// / list / find-by-plaintext (constant-time verify) / revoke / grant-channel-binding
// lifecycle. Cross-domain needs (org/account existence, channel-binding lookup,
// audit) arrive via the injected host. Behaviour-preserving — the token hashing and
// verification stay exactly as before; the cloud-http-server api-token suite covers it.

type InMemoryApiTokensHost = {
  orgExists(orgId: string): boolean
  accountExists(accountId: string): boolean
  getChannelBinding(orgId: string, bindingId: string): ChannelBindingRecord | null
  recordAuditEvent(input: RecordAuditEventInput): AuditEventRecord
}

export class InMemoryApiTokensDomain {
  private readonly apiTokens = new Map<string, ApiTokenRecord>()
  private readonly apiTokenChannelBindingGrants = new Map<string, ApiTokenChannelBindingGrantRecord>()
  private readonly host: InMemoryApiTokensHost

  constructor(host: InMemoryApiTokensHost) {
    this.host = host
  }

  issueApiToken(input: IssueApiTokenInput): IssuedApiTokenRecord {
    if (!this.host.orgExists(input.orgId)) throw new Error(`Unknown org ${input.orgId}.`)
    if (input.accountId && !this.host.accountExists(input.accountId)) throw new Error(`Unknown account ${input.accountId}.`)
    const generated = generateCloudApiToken(input)
    const now = nowIso(input.createdAt)
    const record: ApiTokenRecord = {
      tokenId: generated.tokenId,
      orgId: input.orgId,
      accountId: input.accountId || null,
      name: normalizeText(input.name, 96, 'API token name'),
      tokenHash: hashCloudApiToken(generated.plaintext),
      scopes: [...new Set(input.scopes)],
      last4: generated.plaintext.slice(-4),
      expiresAt: input.expiresAt ? input.expiresAt.toISOString() : null,
      revokedAt: null,
      lastUsedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    this.apiTokens.set(record.tokenId, record)
    this.host.recordAuditEvent({
      orgId: input.orgId,
      accountId: input.accountId || null,
      actorType: input.actor?.actorType || 'system',
      actorId: input.actor?.actorId || null,
      eventType: 'api_token.created',
      targetType: 'api_token',
      targetId: record.tokenId,
      metadata: { name: record.name, scopes: record.scopes, last4: record.last4 },
      createdAt: input.createdAt,
    })
    return { token: clone(record), plaintext: generated.plaintext }
  }

  listApiTokens(orgId: string): ApiTokenRecord[] {
    return [...this.apiTokens.values()]
      .filter((token) => token.orgId === orgId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((token) => clone(token))
  }

  findApiTokenByPlaintext(plaintext: string, now = new Date()): ApiTokenRecord | null {
    for (const token of this.apiTokens.values()) {
      if (!plaintextMatchesCloudApiTokenId(plaintext, token.tokenId)) continue
      if (!verifyCloudApiTokenHash(plaintext, token.tokenHash)) continue
      if (token.revokedAt) return null
      if (token.expiresAt && new Date(token.expiresAt).getTime() <= now.getTime()) return null
      token.lastUsedAt = now.toISOString()
      token.updatedAt = token.lastUsedAt
      return clone(token)
    }
    return null
  }

  revokeApiToken(input: RevokeApiTokenInput): ApiTokenRecord | null {
    const existing = this.apiTokens.get(input.tokenId)
    if (!existing) return null
    if (input.orgId && existing.orgId !== input.orgId) return null
    const revokedAt = nowIso(input.revokedAt)
    existing.revokedAt = existing.revokedAt || revokedAt
    existing.updatedAt = revokedAt
    this.host.recordAuditEvent({
      orgId: existing.orgId,
      accountId: existing.accountId,
      actorType: input.actor?.actorType || 'system',
      actorId: input.actor?.actorId || null,
      eventType: 'api_token.revoked',
      targetType: 'api_token',
      targetId: existing.tokenId,
      metadata: { name: existing.name, scopes: existing.scopes, last4: existing.last4 },
      createdAt: input.revokedAt,
    })
    return clone(existing)
  }

  // Revoke every live token issued to one member — the credential-invalidation
  // primitive behind permission-downgrade and deprovision. Returns the count revoked.
  revokeApiTokensForAccount(input: RevokeApiTokensForAccountInput): number {
    const revokedAt = nowIso(input.revokedAt)
    let revoked = 0
    for (const token of this.apiTokens.values()) {
      if (token.orgId !== input.orgId || token.accountId !== input.accountId) continue
      if (token.revokedAt) continue
      token.revokedAt = revokedAt
      token.updatedAt = revokedAt
      revoked += 1
      this.host.recordAuditEvent({
        orgId: token.orgId,
        accountId: token.accountId,
        actorType: input.actor?.actorType || 'system',
        actorId: input.actor?.actorId || null,
        eventType: 'api_token.revoked',
        targetType: 'api_token',
        targetId: token.tokenId,
        metadata: { name: token.name, scopes: token.scopes, last4: token.last4, reason: input.reason || 'account_revocation' },
        createdAt: input.revokedAt,
      })
    }
    return revoked
  }

  grantApiTokenChannelBinding(input: GrantApiTokenChannelBindingInput): ApiTokenChannelBindingGrantRecord {
    const token = this.apiTokens.get(input.tokenId)
    if (!token || token.orgId !== input.orgId) throw new Error(`Unknown API token ${input.tokenId}.`)
    const binding = this.host.getChannelBinding(input.orgId, input.channelBindingId)
    if (!binding) throw new Error(`Unknown channel binding ${input.channelBindingId}.`)
    const grantKey = key(input.orgId, input.tokenId, input.channelBindingId)
    const existing = this.apiTokenChannelBindingGrants.get(grantKey)
    if (existing) return clone(existing)
    const record: ApiTokenChannelBindingGrantRecord = {
      orgId: input.orgId,
      tokenId: input.tokenId,
      channelBindingId: input.channelBindingId,
      createdAt: nowIso(input.createdAt),
    }
    this.apiTokenChannelBindingGrants.set(grantKey, record)
    this.host.recordAuditEvent({
      orgId: input.orgId,
      accountId: input.actor?.accountId || token.accountId,
      actorType: input.actor?.actorType || 'system',
      actorId: input.actor?.actorId || null,
      eventType: 'api_token.channel_binding_granted',
      targetType: 'api_token',
      targetId: input.tokenId,
      metadata: { channelBindingId: input.channelBindingId },
      createdAt: input.createdAt,
    })
    return clone(record)
  }

  listApiTokenChannelBindingGrants(input: ListApiTokenChannelBindingGrantsInput): ApiTokenChannelBindingGrantRecord[] {
    return [...this.apiTokenChannelBindingGrants.values()]
      .filter((grant) => grant.orgId === input.orgId && grant.tokenId === input.tokenId)
      .sort((left, right) => left.channelBindingId.localeCompare(right.channelBindingId))
      .map((grant) => clone(grant))
  }
}
