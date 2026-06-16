import {
  clone,
  normalizeNullableText,
  normalizeText,
  nowIso,
} from './store-helpers.ts'
import type {
  AuditEventRecord,
  ByokSecretRecord,
  CreateByokSecretInput,
  DisableByokSecretInput,
  RecordAuditEventInput,
  RecordByokSecretValidationInput,
} from '../control-plane-store.ts'

// BYOK secret domain extracted from in-memory-control-plane-store.ts. Owns the
// byok-secret records and the create/read/disable/validate lifecycle (rotation +
// audit). Cross-domain needs (org/account existence, audit recording) come via the
// injected host, matching the other in-memory domain modules. Behaviour-preserving
// move — the security-sensitive logic is unchanged; the cloud-http-server BYOK
// suite (50+ assertions) exercises it through the store delegates.

const CHANNEL_TEXT_MAX_LENGTH = 256
const BYOK_PROVIDER_ID_MAX_LENGTH = 64
const BYOK_SECRET_TEXT_MAX_LENGTH = 4096

type InMemoryByokSecretsHost = {
  orgExists(orgId: string): boolean
  accountExists(accountId: string): boolean
  recordAuditEvent(input: RecordAuditEventInput): AuditEventRecord
}

export class InMemoryByokSecretsDomain {
  private readonly byokSecrets = new Map<string, ByokSecretRecord>()
  private readonly host: InMemoryByokSecretsHost

  constructor(host: InMemoryByokSecretsHost) {
    this.host = host
  }

  createByokSecret(input: CreateByokSecretInput): ByokSecretRecord {
    if (!this.host.orgExists(input.orgId)) throw new Error(`Unknown org ${input.orgId}.`)
    if (input.createdByAccountId && !this.host.accountExists(input.createdByAccountId)) {
      throw new Error(`Unknown account ${input.createdByAccountId}.`)
    }
    const providerId = normalizeByokProviderId(input.providerId)
    const ciphertext = normalizeNullableText(input.ciphertext, BYOK_SECRET_TEXT_MAX_LENGTH, 'BYOK ciphertext')
    const kmsRef = normalizeNullableText(input.kmsRef, BYOK_SECRET_TEXT_MAX_LENGTH, 'BYOK KMS ref')
    if ((ciphertext && kmsRef) || (!ciphertext && !kmsRef)) {
      throw new Error('BYOK secret requires exactly one of ciphertext or kmsRef.')
    }
    const now = nowIso(input.createdAt)
    const status = input.status || 'pending_validation'
    const priorActive = this.getActiveByokSecret(input.orgId, providerId)
    if (priorActive && status === 'active') {
      const previous = this.byokSecrets.get(priorActive.secretId)
      if (previous) {
        previous.status = 'disabled'
        previous.updatedAt = now
      }
    }
    const record: ByokSecretRecord = {
      secretId: normalizeText(input.secretId, CHANNEL_TEXT_MAX_LENGTH, 'BYOK secret id'),
      orgId: input.orgId,
      providerId,
      status,
      ciphertext,
      kmsRef,
      last4: normalizeText(input.last4, 32, 'BYOK secret last4'),
      keyFingerprint: normalizeText(input.keyFingerprint, 128, 'BYOK key fingerprint'),
      createdByAccountId: input.createdByAccountId || null,
      rotatedFromSecretId: input.rotatedFromSecretId || priorActive?.secretId || null,
      lastValidatedAt: null,
      validationError: null,
      createdAt: now,
      updatedAt: now,
    }
    if (this.byokSecrets.has(record.secretId)) throw new Error(`BYOK secret ${record.secretId} already exists.`)
    this.byokSecrets.set(record.secretId, record)
    this.host.recordAuditEvent({
      orgId: record.orgId,
      accountId: record.createdByAccountId,
      actorType: input.actor?.actorType || 'system',
      actorId: input.actor?.actorId || null,
      eventType: priorActive
        ? status === 'active'
          ? 'byok_secret.rotated'
          : 'byok_secret.rotation_started'
        : 'byok_secret.created',
      targetType: 'byok_secret',
      targetId: record.secretId,
      metadata: {
        providerId: record.providerId,
        status: record.status,
        last4: record.last4,
        keyFingerprint: record.keyFingerprint,
        rotatedFromSecretId: record.rotatedFromSecretId,
      },
      createdAt: input.createdAt,
    })
    return clone(record)
  }

  getByokSecret(orgId: string, providerId: string): ByokSecretRecord | null {
    const normalizedProviderId = normalizeByokProviderId(providerId)
    return Array.from(this.byokSecrets.values())
      .filter((secret) => secret.orgId === orgId && secret.providerId === normalizedProviderId)
      .sort((left, right) => (
        right.updatedAt.localeCompare(left.updatedAt)
        || right.createdAt.localeCompare(left.createdAt)
        || right.secretId.localeCompare(left.secretId)
      ))
      .map((secret) => clone(secret))[0] || null
  }

  getActiveByokSecret(orgId: string, providerId: string): ByokSecretRecord | null {
    const normalizedProviderId = normalizeByokProviderId(providerId)
    const secret = Array.from(this.byokSecrets.values())
      .filter((candidate) => (
        candidate.orgId === orgId
        && candidate.providerId === normalizedProviderId
        && candidate.status === 'active'
      ))
      .sort((left, right) => (
        right.updatedAt.localeCompare(left.updatedAt)
        || right.createdAt.localeCompare(left.createdAt)
        || right.secretId.localeCompare(left.secretId)
      ))[0]
    return secret ? clone(secret) : null
  }

  listByokSecrets(orgId: string): ByokSecretRecord[] {
    if (!this.host.orgExists(orgId)) throw new Error(`Unknown org ${orgId}.`)
    return Array.from(this.byokSecrets.values())
      .filter((secret) => secret.orgId === orgId)
      .sort((left, right) => (
        right.updatedAt.localeCompare(left.updatedAt)
        || right.createdAt.localeCompare(left.createdAt)
        || left.providerId.localeCompare(right.providerId)
        || right.secretId.localeCompare(left.secretId)
      ))
      .map((secret) => clone(secret))
  }

  disableByokSecret(input: DisableByokSecretInput): ByokSecretRecord | null {
    const providerId = normalizeByokProviderId(input.providerId)
    const selected = input.secretId
      ? [this.byokSecrets.get(input.secretId)].filter((secret): secret is ByokSecretRecord => Boolean(secret))
      : Array.from(this.byokSecrets.values())
        .filter((secret) => (
          secret.orgId === input.orgId
          && secret.providerId === providerId
          && secret.status !== 'disabled'
        ))
        .sort((left, right) => (
          right.updatedAt.localeCompare(left.updatedAt)
          || right.createdAt.localeCompare(left.createdAt)
          || right.secretId.localeCompare(left.secretId)
        ))
    const matching = selected.filter((secret) => secret.orgId === input.orgId && secret.providerId === providerId && secret.status !== 'disabled')
    if (matching.length === 0) return null
    const disabledAt = nowIso(input.disabledAt)
    for (const secret of matching) {
      secret.status = 'disabled'
      secret.updatedAt = disabledAt
      this.host.recordAuditEvent({
        orgId: secret.orgId,
        accountId: input.actor?.accountId || secret.createdByAccountId,
        actorType: input.actor?.actorType || 'system',
        actorId: input.actor?.actorId || null,
        eventType: 'byok_secret.disabled',
        targetType: 'byok_secret',
        targetId: secret.secretId,
        metadata: { providerId: secret.providerId, status: secret.status, last4: secret.last4, keyFingerprint: secret.keyFingerprint },
        createdAt: input.disabledAt,
      })
    }
    return clone(matching[0])
  }

  recordByokSecretValidation(input: RecordByokSecretValidationInput): ByokSecretRecord | null {
    const providerId = normalizeByokProviderId(input.providerId)
    const existing = input.secretId
      ? this.byokSecrets.get(input.secretId)
      : Array.from(this.byokSecrets.values()).find((secret) => (
        secret.orgId === input.orgId
        && secret.providerId === providerId
        && secret.status === 'active'
      ))
    if (!existing || existing.orgId !== input.orgId || existing.providerId !== providerId) return null
    existing.lastValidatedAt = nowIso(input.validatedAt)
    existing.validationError = input.validationError || null
    const priorActive = input.status === 'active'
      ? Array.from(this.byokSecrets.values()).find((candidate) => (
        candidate.secretId !== existing.secretId
        && candidate.orgId === existing.orgId
        && candidate.providerId === existing.providerId
        && candidate.status === 'active'
      )) || null
      : null
    if (input.status === 'active') {
      if (!existing.rotatedFromSecretId && priorActive) {
        existing.rotatedFromSecretId = priorActive.secretId
      }
      for (const candidate of this.byokSecrets.values()) {
        if (
          candidate.secretId !== existing.secretId
          && candidate.orgId === existing.orgId
          && candidate.providerId === existing.providerId
          && candidate.status === 'active'
        ) {
          candidate.status = 'disabled'
          candidate.updatedAt = existing.lastValidatedAt
        }
      }
    }
    if (input.status) existing.status = input.status
    existing.updatedAt = existing.lastValidatedAt
    this.host.recordAuditEvent({
      orgId: existing.orgId,
      accountId: input.actor?.accountId || existing.createdByAccountId,
      actorType: input.actor?.actorType || 'system',
      actorId: input.actor?.actorId || null,
      eventType: 'byok_secret.validated',
      targetType: 'byok_secret',
      targetId: existing.secretId,
      metadata: {
        providerId: existing.providerId,
        status: existing.status,
        last4: existing.last4,
        keyFingerprint: existing.keyFingerprint,
        validationError: existing.validationError,
      },
      createdAt: input.validatedAt,
    })
    if (input.status === 'active' && (priorActive || existing.rotatedFromSecretId)) {
      this.host.recordAuditEvent({
        orgId: existing.orgId,
        accountId: input.actor?.accountId || existing.createdByAccountId,
        actorType: input.actor?.actorType || 'system',
        actorId: input.actor?.actorId || null,
        eventType: 'byok_secret.rotated',
        targetType: 'byok_secret',
        targetId: existing.secretId,
        metadata: {
          providerId: existing.providerId,
          status: existing.status,
          last4: existing.last4,
          keyFingerprint: existing.keyFingerprint,
          rotatedFromSecretId: existing.rotatedFromSecretId || priorActive?.secretId || null,
        },
        createdAt: input.validatedAt,
      })
    }
    return clone(existing)
  }
}

function normalizeByokProviderId(value: unknown) {
  const providerId = normalizeText(value, BYOK_PROVIDER_ID_MAX_LENGTH, 'BYOK provider id').toLowerCase()
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(providerId)) throw new Error(`Unsupported BYOK provider id ${providerId}.`)
  return providerId
}
