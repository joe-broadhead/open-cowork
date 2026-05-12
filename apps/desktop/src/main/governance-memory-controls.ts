import type { GovernanceMemoryIncidentControlRequest } from '@open-cowork/shared'
import { recordGovernanceAuditEvent } from './governance-audit-store.ts'
import {
  getAgentMemoryEntry,
  quarantineAgentMemoryEntry,
} from './improvement-store.ts'

const MAX_INCIDENT_REASON_BYTES = 16 * 1024

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

export function quarantineGovernanceMemory(request: GovernanceMemoryIncidentControlRequest) {
  const memoryId = boundedMemoryId(request.memoryId)
  const entry = getAgentMemoryEntry(memoryId)
  if (!entry) throw new Error(`No memory entry found for governance incident ${memoryId}.`)
  if (entry.status === 'quarantined') throw new Error(`Memory ${memoryId} is already quarantined.`)
  if (entry.status === 'archived') throw new Error(`Archived memory ${memoryId} cannot be quarantined.`)
  if (entry.status !== 'approved') throw new Error(`Memory ${memoryId} cannot be quarantined from ${entry.status} state.`)

  const reason = boundedReason(request.reason, 'Memory quarantined through governance incident control.')
  const updated = quarantineAgentMemoryEntry(memoryId, 'local-user', reason)
  recordGovernanceAuditEvent({
    subjectKind: 'memory',
    subjectId: memorySubjectId(memoryId),
    action: 'quarantine_memory',
    beforeLifecycle: 'approved',
    afterLifecycle: 'quarantined',
    reason,
    metadata: {
      memoryId,
      scopeKind: entry.scopeKind,
      scopeId: entry.scopeId,
      privacy: entry.privacy,
      sourceProposalId: entry.sourceProposalId,
    },
  })
  return updated
}
