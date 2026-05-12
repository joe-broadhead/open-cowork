import type { GovernanceMemoryIncidentControlRequest, GovernancePrincipal } from '@open-cowork/shared'
import { recordGovernanceAuditEvent } from './governance-audit-store.ts'
import {
  LOCAL_GOVERNANCE_APPROVERS,
  LOCAL_GOVERNANCE_OWNER,
  assertGovernanceIncidentControlAllowed,
  decideGovernanceIncidentControl,
} from './governance-policy.ts'
import {
  getAgentMemoryEntry,
  quarantineAgentMemoryEntry,
} from './improvement-store.ts'

const MAX_INCIDENT_REASON_BYTES = 16 * 1024

export type GovernanceMemoryIncidentControlDependencies = {
  actor?: GovernancePrincipal | null
}

function boundedMemoryId(value: unknown) {
  if (typeof value !== 'string') throw new Error('Memory incident id must be a string.')
  const memoryId = value.trim()
  if (!memoryId) throw new Error('Memory incident id is required.')
  if (Buffer.byteLength(memoryId, 'utf8') > 512) throw new Error('Memory incident id is too large.')
  return memoryId
}

function boundedReason(value: unknown, fallback: string) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') throw new Error('Memory incident reason must be a string.')
  const reason = value.trim()
  if (!reason) return fallback
  if (Buffer.byteLength(reason, 'utf8') > MAX_INCIDENT_REASON_BYTES) {
    throw new Error('Memory incident reason is too large.')
  }
  return reason
}

function memorySubjectId(memoryId: string) {
  return `memory:${encodeURIComponent(memoryId)}`
}

export function quarantineGovernanceMemory(
  request: GovernanceMemoryIncidentControlRequest,
  dependencies: GovernanceMemoryIncidentControlDependencies = {},
) {
  const memoryId = boundedMemoryId(request.memoryId)
  const entry = getAgentMemoryEntry(memoryId)
  if (!entry) throw new Error(`No memory entry found for governance incident ${memoryId}.`)
  if (entry.status === 'quarantined') throw new Error(`Memory ${memoryId} is already quarantined.`)
  if (entry.status === 'archived') throw new Error(`Archived memory ${memoryId} cannot be quarantined.`)
  if (entry.status !== 'approved') throw new Error(`Memory ${memoryId} cannot be quarantined from ${entry.status} state.`)

  const reason = boundedReason(request.reason, 'Memory quarantined through governance incident control.')
  const subjectId = memorySubjectId(memoryId)
  const policyDecision = decideGovernanceIncidentControl({
    actor: dependencies.actor,
    action: 'quarantine_memory',
    subjectKind: 'memory',
    subjectId,
    owner: LOCAL_GOVERNANCE_OWNER,
    approvers: LOCAL_GOVERNANCE_APPROVERS,
  })
  if (policyDecision.outcome === 'denied') {
    recordGovernanceAuditEvent({
      subjectKind: 'memory',
      subjectId,
      action: 'quarantine_memory',
      outcome: 'failed',
      actor: policyDecision.actor,
      beforeLifecycle: 'approved',
      afterLifecycle: null,
      reason: policyDecision.reason,
      metadata: {
        memoryId,
        scopeKind: entry.scopeKind,
        scopeId: entry.scopeId,
        privacy: entry.privacy,
        sourceProposalId: entry.sourceProposalId,
        policyDecision,
      },
    })
    assertGovernanceIncidentControlAllowed(policyDecision)
  }

  const updated = quarantineAgentMemoryEntry(memoryId, policyDecision.actor.id, reason)
  recordGovernanceAuditEvent({
    subjectKind: 'memory',
    subjectId,
    action: 'quarantine_memory',
    actor: policyDecision.actor,
    beforeLifecycle: 'approved',
    afterLifecycle: 'quarantined',
    reason,
    metadata: {
      memoryId,
      scopeKind: entry.scopeKind,
      scopeId: entry.scopeId,
      privacy: entry.privacy,
      sourceProposalId: entry.sourceProposalId,
      policyDecision,
    },
  })
  return updated
}
