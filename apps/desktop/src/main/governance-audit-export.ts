import {
  COWORK_GOVERNANCE_AUDIT_EXPORT_SCHEMA_VERSION,
  serializeGovernanceAuditExportRecord,
  serializeGovernanceAuditOtelExport,
  toExportableCoworkTraceEvent,
  toExportableGovernanceAuditEvent,
  type AutomationDeliveryRecord,
  type ChannelDeliveryRecord,
  type CoworkRunKind,
  type CoworkTraceEvent,
  type CrewApproval,
  type GovernanceAuditExportFormat,
  type GovernanceAuditExportPayload,
  type GovernanceAuditExportRecord,
  type GovernanceSubjectKind,
  type OutcomeEvaluation,
  type PolicyDecision,
} from '@open-cowork/shared'
import { listAutomationDeliveryRecordsForAudit } from './automation-store.ts'
import { listChannelDeliveryRecords } from './channel-store.ts'
import {
  listCoworkTraceEventsForAudit,
  listCrewApprovalsForAudit,
  listCrewRunsForAudit,
  listOutcomeEvaluationsForAudit,
  listPolicyDecisionsForAudit,
} from './crew-store.ts'
import { listGovernanceAuditEventsForExport } from './governance-audit-store.ts'

const GOVERNANCE_AUDIT_EXPORT_BASENAME = 'open-cowork-governance-audit'

export type GovernanceAuditExportOptions = {
  subjectKind?: GovernanceSubjectKind
  subjectId?: string
  limit?: number
  format?: GovernanceAuditExportFormat
}

function auditExportTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-')
}

function normalizeExportLimit(value: number | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : null
}

function crewIdFromSubject(options: Pick<GovernanceAuditExportOptions, 'subjectKind' | 'subjectId'>): string | null | undefined {
  if (!options.subjectKind) return undefined
  if (options.subjectKind !== 'crew') return null
  if (!options.subjectId?.startsWith('crew:')) return null
  try {
    const crewId = decodeURIComponent(options.subjectId.slice('crew:'.length))
    return crewId.trim().length > 0 ? crewId : null
  } catch {
    return null
  }
}

function crewSubjectId(crewId: string | null | undefined) {
  return crewId ? `crew:${encodeURIComponent(crewId)}` : null
}

function sortAuditRecords(records: GovernanceAuditExportRecord[]) {
  return records.slice().sort((left, right) => (
    left.occurredAt.localeCompare(right.occurredAt)
    || left.recordType.localeCompare(right.recordType)
    || left.id.localeCompare(right.id)
  ))
}

function incidentRecords(options: Pick<GovernanceAuditExportOptions, 'subjectKind' | 'subjectId'>): GovernanceAuditExportRecord[] {
  return listGovernanceAuditEventsForExport(options).map((event) => ({
    schemaVersion: COWORK_GOVERNANCE_AUDIT_EXPORT_SCHEMA_VERSION,
    recordType: 'governance_incident',
    id: event.id,
    occurredAt: event.createdAt,
    subjectKind: event.subjectKind,
    subjectId: event.subjectId,
    runKind: null,
    runId: null,
    payload: toExportableGovernanceAuditEvent(event),
  }))
}

function traceRecord(event: CoworkTraceEvent, subjectId: string | null): GovernanceAuditExportRecord {
  return {
    schemaVersion: COWORK_GOVERNANCE_AUDIT_EXPORT_SCHEMA_VERSION,
    recordType: 'crew_trace',
    id: event.id,
    occurredAt: event.createdAt,
    subjectKind: subjectId ? 'crew' : null,
    subjectId,
    runKind: event.runKind,
    runId: event.runId,
    payload: toExportableCoworkTraceEvent(event),
  }
}

function approvalRecord(approval: CrewApproval, subjectId: string | null): GovernanceAuditExportRecord {
  return {
    schemaVersion: COWORK_GOVERNANCE_AUDIT_EXPORT_SCHEMA_VERSION,
    recordType: 'crew_approval',
    id: approval.id,
    occurredAt: approval.requestedAt,
    subjectKind: subjectId ? 'crew' : null,
    subjectId,
    runKind: 'crew',
    runId: approval.crewRunId,
    payload: approval,
  }
}

function policyDecisionRecord(decision: PolicyDecision, subjectId: string | null): GovernanceAuditExportRecord {
  return {
    schemaVersion: COWORK_GOVERNANCE_AUDIT_EXPORT_SCHEMA_VERSION,
    recordType: 'policy_decision',
    id: decision.id,
    occurredAt: decision.createdAt,
    subjectKind: subjectId ? 'crew' : null,
    subjectId,
    runKind: decision.runKind,
    runId: decision.runId,
    payload: decision,
  }
}

function outcomeEvaluationRecord(evaluation: OutcomeEvaluation, subjectId: string | null): GovernanceAuditExportRecord {
  return {
    schemaVersion: COWORK_GOVERNANCE_AUDIT_EXPORT_SCHEMA_VERSION,
    recordType: 'outcome_evaluation',
    id: evaluation.id,
    occurredAt: evaluation.createdAt,
    subjectKind: subjectId ? 'crew' : null,
    subjectId,
    runKind: 'crew',
    runId: evaluation.crewRunId,
    payload: evaluation,
  }
}

function automationDeliveryRecord(delivery: AutomationDeliveryRecord): GovernanceAuditExportRecord {
  return {
    schemaVersion: COWORK_GOVERNANCE_AUDIT_EXPORT_SCHEMA_VERSION,
    recordType: 'automation_delivery',
    id: delivery.id,
    occurredAt: delivery.createdAt,
    subjectKind: null,
    subjectId: null,
    runKind: 'automation',
    runId: delivery.runId,
    payload: delivery,
  }
}

function channelDeliveryRecord(delivery: ChannelDeliveryRecord, crewRunSubjects: Map<string, string | null>): GovernanceAuditExportRecord {
  const subjectId = delivery.runKind === 'crew' && delivery.runId ? crewRunSubjects.get(delivery.runId) || null : null
  return {
    schemaVersion: COWORK_GOVERNANCE_AUDIT_EXPORT_SCHEMA_VERSION,
    recordType: 'channel_delivery',
    id: delivery.id,
    occurredAt: delivery.createdAt,
    subjectKind: subjectId ? 'crew' : null,
    subjectId,
    runKind: delivery.runKind as CoworkRunKind | 'channel' | null,
    runId: delivery.runId,
    payload: delivery,
  }
}

function collectProductAuditRecords(crewId: string | null | undefined): GovernanceAuditExportRecord[] {
  if (crewId === null) return []
  const crewRuns = listCrewRunsForAudit({ crewId })
  const runSubjects = new Map(crewRuns.map((run) => [run.id, crewSubjectId(run.crewId)]))
  const records: GovernanceAuditExportRecord[] = [
    ...listCoworkTraceEventsForAudit({ crewId }).map((event) => traceRecord(event, runSubjects.get(event.runId) || null)),
    ...listCrewApprovalsForAudit({ crewId }).map((approval) => approvalRecord(approval, runSubjects.get(approval.crewRunId) || null)),
    ...listPolicyDecisionsForAudit({ crewId }).map((decision) => policyDecisionRecord(decision, decision.runKind === 'crew' ? runSubjects.get(decision.runId) || null : null)),
    ...listOutcomeEvaluationsForAudit({ crewId }).map((evaluation) => outcomeEvaluationRecord(evaluation, runSubjects.get(evaluation.crewRunId) || null)),
  ]
  if (crewId !== undefined) {
    const allowedRunIds = new Set(crewRuns.map((run) => run.id))
    records.push(...listChannelDeliveryRecords()
      .filter((delivery) => delivery.runKind === 'crew' && delivery.runId && allowedRunIds.has(delivery.runId))
      .map((delivery) => channelDeliveryRecord(delivery, runSubjects)))
    return records
  }
  records.push(
    ...listAutomationDeliveryRecordsForAudit().map(automationDeliveryRecord),
    ...listChannelDeliveryRecords().map((delivery) => channelDeliveryRecord(delivery, runSubjects)),
  )
  return records
}

export function collectGovernanceAuditExportRecords(options: GovernanceAuditExportOptions = {}): GovernanceAuditExportRecord[] {
  const crewId = crewIdFromSubject(options)
  const limit = normalizeExportLimit(options.limit)
  const records = sortAuditRecords([
    ...incidentRecords({ subjectKind: options.subjectKind, subjectId: options.subjectId }),
    ...collectProductAuditRecords(crewId),
  ])
  return limit === null ? records : records.slice(0, limit)
}

export function exportGovernanceAuditEvents(options: GovernanceAuditExportOptions = {}): GovernanceAuditExportPayload {
  const format = options.format || 'ndjson'
  const records = collectGovernanceAuditExportRecords(options)
  const exportedAt = new Date().toISOString()
  if (format === 'ndjson') {
    return {
      schemaVersion: COWORK_GOVERNANCE_AUDIT_EXPORT_SCHEMA_VERSION,
      format,
      contentType: 'application/x-ndjson',
      filename: `${GOVERNANCE_AUDIT_EXPORT_BASENAME}-${auditExportTimestamp(new Date(exportedAt))}.ndjson`,
      exportedAt,
      eventCount: records.length,
      body: records.map(serializeGovernanceAuditExportRecord).join('\n'),
    }
  }
  if (format === 'otel-json') {
    return {
      schemaVersion: COWORK_GOVERNANCE_AUDIT_EXPORT_SCHEMA_VERSION,
      format,
      contentType: 'application/json',
      filename: `${GOVERNANCE_AUDIT_EXPORT_BASENAME}-${auditExportTimestamp(new Date(exportedAt))}.otel.json`,
      exportedAt,
      eventCount: records.length,
      body: serializeGovernanceAuditOtelExport(records),
    }
  }
  throw new Error('Governance audit export format is invalid.')
}
