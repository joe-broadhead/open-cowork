import { createHash, randomUUID } from 'node:crypto'
import type {
  AuditActorInput,
  ByokSecretRecord,
  ByokSecretStatus,
  ControlPlaneStore,
} from './control-plane-store.ts'
import type { SecretAdapter } from './secret-adapter.ts'

export type ByokSecretMetadata = {
  secretId: string
  providerId: string
  status: ByokSecretStatus
  last4: string
  keyFingerprint: string
  lastValidatedAt: string | null
  validationError: string | null
  createdAt: string
  updatedAt: string
}

export type SetByokSecretInput = {
  orgId: string
  providerId: string
  plaintext?: string | null
  kmsRef?: string | null
  createdByAccountId?: string | null
  actor?: AuditActorInput
}

export type RecordByokValidationInput = {
  orgId: string
  providerId: string
  secretId?: string | null
  status?: ByokSecretStatus
  validationError?: string | null
  actor?: AuditActorInput
}

export type RevealByokSecretInput = {
  orgId: string
  providerId: string
  allowKmsRef?: boolean
}

export type ValidateByokSecretInput = {
  orgId: string
  providerId: string
  actor?: AuditActorInput
  allowKmsRef?: boolean
}

export type ByokSecretRefResolverInput = {
  orgId: string
  providerId: string
  secretId: string
  kmsRef: string
}

export type ByokSecretRefResolver = (input: ByokSecretRefResolverInput) => Promise<string> | string

export type ByokProviderValidationInput = {
  orgId: string
  providerId: string
  secretId: string
  plaintext: string
  metadata: ByokSecretMetadata
}

export type ByokProviderValidationResult =
  | boolean
  | {
      ok?: boolean
      valid?: boolean
      status?: Extract<ByokSecretStatus, 'active' | 'invalid'>
      error?: string | null
      reason?: string | null
    }
  | void

export type ByokProviderValidator = (
  input: ByokProviderValidationInput,
) => Promise<ByokProviderValidationResult> | ByokProviderValidationResult

export type ByokSecretStore = {
  listMetadata(orgId: string): Promise<ByokSecretMetadata[]>
  getMetadata(orgId: string, providerId: string): Promise<ByokSecretMetadata | null>
  setSecret(input: SetByokSecretInput): Promise<ByokSecretMetadata>
  disableSecret(input: { orgId: string, providerId: string, actor?: AuditActorInput }): Promise<ByokSecretMetadata | null>
  recordValidation(input: RecordByokValidationInput): Promise<ByokSecretMetadata | null>
  validateActiveSecret(input: ValidateByokSecretInput): Promise<ByokSecretMetadata | null>
  revealActiveSecret(input: RevealByokSecretInput): Promise<string>
}

export type ByokSecretStoreOptions = {
  ids?: { randomUUID: () => string }
  kmsRefResolver?: ByokSecretRefResolver | null
  validators?: Record<string, ByokProviderValidator | undefined> | null
}

const PROVIDER_ID_MAX_LENGTH = 64
const VALIDATION_ERROR_MAX_LENGTH = 512

function normalizeProviderId(value: string) {
  const providerId = value.trim().toLowerCase()
  if (!providerId || providerId.length > PROVIDER_ID_MAX_LENGTH || !/^[a-z0-9][a-z0-9._-]*$/.test(providerId)) {
    throw new Error(`Unsupported BYOK provider id ${providerId || '<empty>'}.`)
  }
  return providerId
}

function nonEmptyText(value: string | null | undefined, label: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`)
  return value.trim()
}

function fingerprintSecret(value: string) {
  return createHash('sha256')
    .update('open-cowork-byok-provider-secret-v1\0', 'utf8')
    .update(value, 'utf8')
    .digest('hex')
    .slice(0, 24)
}

function byokAad(orgId: string, providerId: string, secretId: string) {
  return `byok:${orgId}:${providerId}:${secretId}`
}

function redactSecretLikeText(value: string) {
  return value
    .replace(/\b(sk-[A-Za-z0-9._-]{6,})\b/g, '[redacted]')
    .replace(/\b(occ_[A-Za-z0-9._-]{8,})\b/g, '[redacted]')
    .replace(/\b([A-Za-z0-9_-]{32,})\b/g, '[redacted]')
}

function sanitizeValidationError(value: string | null | undefined) {
  if (!value) return null
  const sanitized = redactSecretLikeText(value.trim())
  return sanitized.length > VALIDATION_ERROR_MAX_LENGTH
    ? `${sanitized.slice(0, VALIDATION_ERROR_MAX_LENGTH - 3)}...`
    : sanitized
}

function normalizeValidationOutcome(result: ByokProviderValidationResult): {
  status: Extract<ByokSecretStatus, 'active' | 'invalid'>
  validationError: string | null
} {
  if (typeof result === 'boolean') {
    return result
      ? { status: 'active', validationError: null }
      : { status: 'invalid', validationError: 'Provider credential validation failed.' }
  }
  if (!result) {
    return { status: 'active', validationError: null }
  }
  const valid = result.status ? result.status === 'active' : (result.valid ?? result.ok ?? true)
  return {
    status: valid ? 'active' : 'invalid',
    validationError: valid ? null : (result.error ?? result.reason ?? 'Provider credential validation failed.'),
  }
}

export function byokSecretMetadata(record: ByokSecretRecord): ByokSecretMetadata {
  return {
    secretId: record.secretId,
    providerId: record.providerId,
    status: record.status,
    last4: record.last4,
    keyFingerprint: record.keyFingerprint,
    lastValidatedAt: record.lastValidatedAt,
    validationError: record.validationError,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function latestByProvider(records: ByokSecretRecord[]) {
  const byProvider = new Map<string, ByokSecretRecord>()
  for (const record of records) {
    const existing = byProvider.get(record.providerId)
    const order = existing
      ? record.updatedAt.localeCompare(existing.updatedAt)
        || record.createdAt.localeCompare(existing.createdAt)
        || record.secretId.localeCompare(existing.secretId)
      : 1
    if (order > 0) {
      byProvider.set(record.providerId, record)
    }
  }
  return Array.from(byProvider.values())
    .sort((left, right) => left.providerId.localeCompare(right.providerId))
}

export function createByokSecretStore(
  store: ControlPlaneStore,
  secretAdapter: SecretAdapter,
  options: ByokSecretStoreOptions = {},
): ByokSecretStore {
  const ids = options.ids || { randomUUID }
  const validators = options.validators || {}

  async function revealSecretRecord(secret: ByokSecretRecord, input: RevealByokSecretInput) {
    if (secret.ciphertext) {
      return secretAdapter.reveal(secret.ciphertext, byokAad(secret.orgId, secret.providerId, secret.secretId))
    }
    if (!secret.kmsRef) {
      throw new Error(`BYOK secret ${secret.secretId} has no encrypted material.`)
    }
    if (!input.allowKmsRef) {
      throw new Error('KMS-backed BYOK secrets require a worker-authorized reveal path.')
    }
    if (!options.kmsRefResolver) {
      throw new Error('KMS-backed BYOK secret resolver is not configured.')
    }
    const resolved = await options.kmsRefResolver({
      orgId: secret.orgId,
      providerId: secret.providerId,
      secretId: secret.secretId,
      kmsRef: secret.kmsRef,
    })
    if (!resolved) {
      throw new Error('KMS-backed BYOK secret resolver returned an empty credential.')
    }
    return resolved
  }

  return {
    async listMetadata(orgId) {
      const secrets = await store.listByokSecrets(orgId)
      return latestByProvider(secrets).map(byokSecretMetadata)
    },

    async getMetadata(orgId, providerId) {
      const secret = await store.getByokSecret(orgId, normalizeProviderId(providerId))
      return secret ? byokSecretMetadata(secret) : null
    },

    async setSecret(input) {
      const providerId = normalizeProviderId(input.providerId)
      const plaintext = input.plaintext === undefined ? null : input.plaintext
      const kmsRef = input.kmsRef === undefined ? null : input.kmsRef
      if (plaintext && kmsRef) throw new Error('BYOK secret accepts either plaintext or kmsRef, not both.')
      if (!plaintext && !kmsRef) throw new Error('BYOK secret requires plaintext or kmsRef.')

      const secretId = `byok_${ids.randomUUID()}`
      if (plaintext) {
        const normalizedPlaintext = nonEmptyText(plaintext, 'BYOK plaintext')
        const ciphertext = secretAdapter.protect(normalizedPlaintext, byokAad(input.orgId, providerId, secretId))
        const record = await store.createByokSecret({
          secretId,
          orgId: input.orgId,
          providerId,
          ciphertext,
          last4: normalizedPlaintext.slice(-4),
          keyFingerprint: fingerprintSecret(normalizedPlaintext),
          createdByAccountId: input.createdByAccountId,
          actor: input.actor,
        })
        return byokSecretMetadata(record)
      }

      const normalizedKmsRef = nonEmptyText(kmsRef, 'BYOK KMS ref')
      const record = await store.createByokSecret({
        secretId,
        orgId: input.orgId,
        providerId,
        kmsRef: normalizedKmsRef,
        last4: normalizedKmsRef.slice(-4),
        keyFingerprint: fingerprintSecret(`kms:${normalizedKmsRef}`),
        createdByAccountId: input.createdByAccountId,
        actor: input.actor,
      })
      return byokSecretMetadata(record)
    },

    async disableSecret(input) {
      const record = await store.disableByokSecret({
        orgId: input.orgId,
        providerId: normalizeProviderId(input.providerId),
        actor: input.actor,
      })
      return record ? byokSecretMetadata(record) : null
    },

    async recordValidation(input) {
      const record = await store.recordByokSecretValidation({
        orgId: input.orgId,
        providerId: normalizeProviderId(input.providerId),
        secretId: input.secretId,
        status: input.status,
        validationError: sanitizeValidationError(input.validationError),
        actor: input.actor,
      })
      return record ? byokSecretMetadata(record) : null
    },

    async validateActiveSecret(input) {
      const providerId = normalizeProviderId(input.providerId)
      const secret = await store.getActiveByokSecret(input.orgId, providerId)
      if (!secret) return null
      if (secret.kmsRef && !input.allowKmsRef) {
        return byokSecretMetadata(secret)
      }

      const validator = validators[providerId]
      if (!validator) {
        const record = await store.recordByokSecretValidation({
          orgId: input.orgId,
          providerId,
          secretId: secret.secretId,
          status: 'active',
          validationError: null,
          actor: input.actor,
        })
        return record ? byokSecretMetadata(record) : null
      }

      try {
        const plaintext = await revealSecretRecord(secret, { ...input, providerId })
        const outcome = normalizeValidationOutcome(
          await validator({
            orgId: input.orgId,
            providerId,
            secretId: secret.secretId,
            plaintext,
            metadata: byokSecretMetadata(secret),
          }),
        )
        const record = await store.recordByokSecretValidation({
          orgId: input.orgId,
          providerId,
          secretId: secret.secretId,
          status: outcome.status,
          validationError: sanitizeValidationError(outcome.validationError),
          actor: input.actor,
        })
        return record ? byokSecretMetadata(record) : null
      } catch (error) {
        const record = await store.recordByokSecretValidation({
          orgId: input.orgId,
          providerId,
          secretId: secret.secretId,
          status: 'invalid',
          validationError: sanitizeValidationError(error instanceof Error ? error.message : String(error)),
          actor: input.actor,
        })
        return record ? byokSecretMetadata(record) : null
      }
    },

    async revealActiveSecret(input) {
      const providerId = normalizeProviderId(input.providerId)
      const secret = await store.getActiveByokSecret(input.orgId, providerId)
      if (!secret) throw new Error(`No active BYOK secret configured for provider ${providerId}.`)
      return revealSecretRecord(secret, { ...input, providerId })
    },
  }
}
