import type { WorkflowTrigger } from '@open-cowork/shared'
import type { SecretStorageMode } from '../secure-storage-policy.js'
import { isWorkflowTriggerType } from './workflow-normalization.js'

const ENCRYPTED_WEBHOOK_SECRET_RECORD_VERSION = 2

export type WorkflowSecretStorageAdapter = {
  mode: SecretStorageMode
  encryptString?: (value: string) => Buffer
  decryptString?: (value: Buffer) => string
}

type EncryptedWebhookSecretRecord = {
  __openCoworkEncryptedWebhookSecret: typeof ENCRYPTED_WEBHOOK_SECRET_RECORD_VERSION
  value: string
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function isEncryptedWebhookSecretRecord(value: unknown): value is EncryptedWebhookSecretRecord {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as Partial<EncryptedWebhookSecretRecord>).__openCoworkEncryptedWebhookSecret === ENCRYPTED_WEBHOOK_SECRET_RECORD_VERSION
    && typeof (value as Partial<EncryptedWebhookSecretRecord>).value === 'string',
  )
}

function encryptWebhookSecretValue(storage: WorkflowSecretStorageAdapter, secret: string): EncryptedWebhookSecretRecord {
  if (!storage.encryptString) throw new Error('Electron safeStorage is unavailable')
  return {
    __openCoworkEncryptedWebhookSecret: ENCRYPTED_WEBHOOK_SECRET_RECORD_VERSION,
    value: Buffer.from(storage.encryptString(secret)).toString('base64'),
  }
}

function tryDecryptWebhookSecretPayload(storage: WorkflowSecretStorageAdapter, payload: string) {
  if (!storage.decryptString) return null
  try {
    return storage.decryptString(Buffer.from(payload, 'base64'))
  } catch {
    return null
  }
}

function encodeWebhookSecretForStorage(
  secret: unknown,
  storage: WorkflowSecretStorageAdapter,
): string | EncryptedWebhookSecretRecord | null {
  if (isEncryptedWebhookSecretRecord(secret)) return secret
  if (typeof secret !== 'string' || !secret) return null
  if (storage.mode === 'encrypted') {
    return encryptWebhookSecretValue(storage, secret)
  }
  if (storage.mode === 'plaintext') return secret
  throw new Error('Secure storage unavailable on this system. Open Cowork cannot persist workflow webhook secrets in production without OS-backed secret storage.')
}

function decodeWebhookSecretFromStorage(secret: unknown, storage: WorkflowSecretStorageAdapter) {
  if (isEncryptedWebhookSecretRecord(secret)) {
    return tryDecryptWebhookSecretPayload(storage, secret.value) ?? secret
  }

  if (typeof secret !== 'string' || !secret.trim()) return null
  return secret
}

export function serializeWorkflowTriggersForStorageWithAdapter(
  triggers: WorkflowTrigger[],
  storage: WorkflowSecretStorageAdapter,
) {
  return JSON.stringify(triggers.map((trigger) => trigger.type === 'webhook'
    ? { ...trigger, webhookSecret: encodeWebhookSecretForStorage(trigger.webhookSecret, storage) }
    : trigger))
}

export function parseWorkflowTriggersFromStorageWithAdapter(
  value: unknown,
  storage: WorkflowSecretStorageAdapter,
) {
  const parsed = parseJson<unknown>(value, [])
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap((raw): WorkflowTrigger[] => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
    const trigger = raw as Partial<WorkflowTrigger>
    if (!isWorkflowTriggerType(trigger.type)) return []
    return [trigger.type === 'webhook'
      ? { ...trigger, webhookSecret: decodeWebhookSecretFromStorage(trigger.webhookSecret, storage) } as WorkflowTrigger
      : trigger as WorkflowTrigger]
  })
}
