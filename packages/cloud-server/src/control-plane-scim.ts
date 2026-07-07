import type { AuditActorInput } from './control-plane-account-inputs.ts'

// The durable SCIM provisioning sync-event queue (issue #895). SCIM writes never
// mutate membership best-effort-and-forget: every provisioning action also lands a
// row in this queue so a periodic reconciler can retry a transient failure with
// exponential backoff and converge directory state ↔ membership state. The queue is
// store-backed (both the in-memory and Postgres control planes, parity-tested) so it
// survives a restart, exactly like the channel-delivery queue. Pure types + the pure
// backoff schedule only — the store implementations own the claim/complete/fail
// transitions and the reconciler owns the convergence policy.

export type ScimSyncOperation =
  | 'user.provision'
  | 'user.update'
  | 'user.deprovision'
  | 'group.sync'
  | 'reconcile'

export type ScimSyncEventStatus = 'pending' | 'processing' | 'succeeded' | 'failed'

export type ScimSyncEventRecord = {
  eventId: string
  orgId: string
  operation: ScimSyncOperation
  // The IdP-side stable id this event targets (SCIM externalId / user id / group id),
  // or null for a whole-org reconcile sweep.
  externalId: string | null
  payload: Record<string, unknown>
  status: ScimSyncEventStatus
  attempts: number
  maxAttempts: number
  nextAttemptAt: string
  lastError: string | null
  createdAt: string
  updatedAt: string
}

export type EnqueueScimSyncEventInput = {
  orgId: string
  operation: ScimSyncOperation
  externalId?: string | null
  payload?: Record<string, unknown> | null
  eventId?: string
  maxAttempts?: number
  availableAt?: Date
  createdAt?: Date
  actor?: AuditActorInput
}

export type ClaimScimSyncEventsInput = {
  orgId?: string | null
  limit?: number
  now?: Date
}

export type CompleteScimSyncEventInput = {
  orgId: string
  eventId: string
  now?: Date
}

export type FailScimSyncEventInput = {
  orgId: string
  eventId: string
  error: string
  now?: Date
}

export type ListScimSyncEventsInput = {
  orgId: string
  status?: ScimSyncEventStatus | null
  limit?: number | null
}

const SCIM_RETRY_BASE_MS = 1_000
const SCIM_RETRY_MAX_MS = 5 * 60 * 1_000
export const SCIM_SYNC_DEFAULT_MAX_ATTEMPTS = 8

// Exponential backoff with a hard ceiling: attempt 1 waits 1s, attempt 2 2s, … capped
// at 5 minutes. `attempt` is the number of attempts ALREADY made (1-based) so the first
// retry (after one failed attempt) waits SCIM_RETRY_BASE_MS.
export function scimRetryDelayMs(attempt: number): number {
  const exponent = Math.max(0, Math.floor(attempt) - 1)
  // Cap the exponent before shifting so 2 ** exponent can't overflow into Infinity.
  const cappedExponent = Math.min(exponent, 20)
  return Math.min(SCIM_RETRY_BASE_MS * 2 ** cappedExponent, SCIM_RETRY_MAX_MS)
}

export function isScimSyncOperation(value: unknown): value is ScimSyncOperation {
  return value === 'user.provision'
    || value === 'user.update'
    || value === 'user.deprovision'
    || value === 'group.sync'
    || value === 'reconcile'
}

export function normalizeScimSyncOperation(value: unknown): ScimSyncOperation {
  if (!isScimSyncOperation(value)) throw new Error(`Unsupported SCIM sync operation: ${String(value)}.`)
  return value
}
