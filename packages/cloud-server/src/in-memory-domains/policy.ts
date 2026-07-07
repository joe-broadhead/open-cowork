import { clone, nowIso } from './store-helpers.ts'
import {
  DEFAULT_MANAGED_POLICY,
  applyManagedPolicyInput,
  effectiveManagedPolicy,
  type ManagedPolicyRecord,
  type SetManagedPolicyInput,
} from '../control-plane-policy.ts'
import type { RecordAuditEventInput, AuditEventRecord } from '../control-plane-store.ts'

// Managed-policy domain: the single org-scoped workspace & desktop policy record
// (#898). Owns the orgId → ManagedPolicyRecord table and its get/set (upsert)
// lifecycle. A set MERGES a partial input onto the current record (or the unrestricted
// defaults when none exists) and emits an audit event. Behaviour-preserving with the
// Postgres peer; covered by the cloud-control-plane-store contract suite.

type InMemoryManagedPolicyHost = {
  orgExists(orgId: string): boolean
  recordAuditEvent(input: RecordAuditEventInput): AuditEventRecord
}

export class InMemoryManagedPolicyDomain {
  private readonly policies = new Map<string, ManagedPolicyRecord>()
  private readonly host: InMemoryManagedPolicyHost

  constructor(host: InMemoryManagedPolicyHost) {
    this.host = host
  }

  getManagedPolicy(orgId: string): ManagedPolicyRecord | null {
    const record = this.policies.get(orgId)
    return record ? clone(record) : null
  }

  setManagedPolicy(input: SetManagedPolicyInput): ManagedPolicyRecord {
    if (!this.host.orgExists(input.orgId)) throw new Error(`Unknown org ${input.orgId}.`)
    const existing = this.policies.get(input.orgId)
    const base = existing ? effectiveManagedPolicy(existing) : DEFAULT_MANAGED_POLICY
    const fields = applyManagedPolicyInput(base, input)
    const now = nowIso(input.updatedAt)
    const record: ManagedPolicyRecord = {
      orgId: input.orgId,
      ...fields,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    }
    this.policies.set(input.orgId, record)
    this.host.recordAuditEvent({
      orgId: input.orgId,
      accountId: input.actor?.accountId || null,
      actorType: input.actor?.actorType || 'system',
      actorId: input.actor?.actorId || null,
      eventType: 'managed_policy.updated',
      targetType: 'managed_policy',
      targetId: input.orgId,
      metadata: {
        keyManagement: record.keyManagement,
        permissionCeilings: record.permissionCeilings,
        extensions: record.extensions,
        allowedProviders: record.allowedProviders,
        deniedProviders: record.deniedProviders,
        allowedModels: record.allowedModels,
        deniedModels: record.deniedModels,
        features: record.features,
        updateChannel: record.updateChannel,
      },
      createdAt: input.updatedAt,
    })
    return clone(record)
  }
}
