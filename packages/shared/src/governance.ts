import type { AutomationDeliveryRecord } from './automation.js'
import type { ChannelDeliveryRecord } from './channels.js'
import type { CoworkRunKind, CoworkTraceEvent, CrewApproval, OutcomeEvaluation, PolicyDecision } from './crews.js'

export const COWORK_GOVERNANCE_SCHEMA_VERSION = 1
export const COWORK_GOVERNANCE_AUDIT_SCHEMA_VERSION = 1
export const COWORK_GOVERNANCE_AUDIT_EXPORT_SCHEMA_VERSION = 2

export type GovernanceSubjectKind = 'agent' | 'crew' | 'memory' | 'tool'
export type GovernanceLifecycleState = 'draft' | 'review' | 'approved' | 'active' | 'paused' | 'retired' | 'quarantined' | 'revoked'
export type GovernanceScopeKind = 'system' | 'machine' | 'project' | 'workspace_profile'
export type GovernanceDependencyKind =
  | 'agent'
  | 'tool'
  | 'skill'
  | 'memory'
  | 'credential'
  | 'channel'
  | 'sop'
  | 'eval_suite'
  | 'workspace_profile'
export type GovernanceDependencySource = 'direct' | 'transitive'
export type GovernanceOwnerKind = 'user' | 'group' | 'system'
export type GovernanceRole = 'admin' | 'owner' | 'approver' | 'viewer'
export type GovernanceOrganizationMode = 'local' | 'managed'
export type GovernanceMemoryBoundaryKind = 'none' | 'session' | 'agent' | 'crew' | 'workspace'
export type GovernanceExecutionNodeKind = 'desktop' | 'managed_worker'
export type GovernanceExecutionNodeStatus = 'active' | 'planned' | 'unavailable'
export type GovernanceExecutionCapabilityKind =
  | 'background_execution'
  | 'cost_governance'
  | 'queue_recovery'
  | 'scheduling'
  | 'trigger_execution'
export type GovernanceIncidentControlKind =
  | 'pause_agent'
  | 'retire_agent'
  | 'pause_crew'
  | 'retire_crew'
  | 'quarantine_memory'
  | 'revoke_tool'
  | 'export_audit'
export type GovernanceAuditEventKind = 'incident_control'
export type GovernanceAuditOutcome = 'succeeded' | 'failed'
export type GovernanceAuditExportFormat = 'ndjson' | 'otel-json'
export type GovernanceAuditExportRecordType =
  | 'governance_incident'
  | 'crew_trace'
  | 'crew_approval'
  | 'policy_decision'
  | 'outcome_evaluation'
  | 'automation_delivery'
  | 'channel_delivery'

export interface GovernanceOwner {
  kind: GovernanceOwnerKind
  id: string
  displayName: string
}

export interface GovernancePrincipal extends GovernanceOwner {
  roles: GovernanceRole[]
  groupIds: string[]
}

export interface GovernanceGroup extends GovernanceOwner {
  kind: 'group'
  roles: GovernanceRole[]
}

export interface GovernanceOrganization {
  schemaVersion: number
  id: string
  tenantId: string
  displayName: string
  mode: GovernanceOrganizationMode
}

export interface GovernanceScope {
  kind: GovernanceScopeKind
  id: string
  label: string
  directory?: string | null
}

export interface GovernanceDependency {
  kind: GovernanceDependencyKind
  id: string
  label: string
  source: GovernanceDependencySource
  required: boolean
  lifecycle?: GovernanceLifecycleState | null
}

export interface GovernanceMemoryBoundary {
  kind: GovernanceMemoryBoundaryKind
  id: string | null
  label: string
}

export interface GovernanceExecutionCapability {
  kind: GovernanceExecutionCapabilityKind
  label: string
  available: boolean
  reason?: string | null
}

export interface GovernanceExecutionNode {
  schemaVersion: number
  id: string
  kind: GovernanceExecutionNodeKind
  label: string
  status: GovernanceExecutionNodeStatus
  scope: GovernanceScope
  capabilities: GovernanceExecutionCapability[]
  limitations: string[]
  lastSeenAt: string | null
}

export interface GovernanceIncidentControl {
  kind: GovernanceIncidentControlKind
  label: string
  available: boolean
  requiresConfirmation: boolean
  requiredRoles?: GovernanceRole[]
  reason?: string | null
}

export interface GovernanceRegistrySubject {
  schemaVersion: number
  subjectKind: GovernanceSubjectKind
  subjectId: string
  name: string
  displayName: string
  description: string
  owner: GovernanceOwner
  approvers: GovernanceOwner[]
  lifecycle: GovernanceLifecycleState
  scope: GovernanceScope
  memoryBoundary: GovernanceMemoryBoundary
  evalSuiteId: string | null
  offboardingPath: string
  dependencies: GovernanceDependency[]
  incidentControls: GovernanceIncidentControl[]
}

export interface GovernanceDependencyIndexEntry {
  dependency: GovernanceDependency
  subjectIds: string[]
}

export interface GovernanceRegistryPayload {
  schemaVersion: number
  generatedAt: string
  organization: GovernanceOrganization
  principals: GovernancePrincipal[]
  groups: GovernanceGroup[]
  executionNodes: GovernanceExecutionNode[]
  subjects: GovernanceRegistrySubject[]
  dependencyIndex: GovernanceDependencyIndexEntry[]
}

export interface GovernanceAuditActor {
  kind: GovernanceOwnerKind
  id: string
  displayName: string
}

export interface GovernanceAuditEvent {
  schemaVersion: number
  id: string
  kind: GovernanceAuditEventKind
  subjectKind: GovernanceSubjectKind
  subjectId: string
  action: GovernanceIncidentControlKind
  outcome: GovernanceAuditOutcome
  actor: GovernanceAuditActor
  reason: string | null
  beforeLifecycle: GovernanceLifecycleState | null
  afterLifecycle: GovernanceLifecycleState | null
  metadata: Record<string, unknown>
  createdAt: string
}

export interface GovernanceAuditEventDraft {
  subjectKind: GovernanceSubjectKind
  subjectId: string
  action: GovernanceIncidentControlKind
  outcome?: GovernanceAuditOutcome
  actor?: Partial<GovernanceAuditActor> | null
  reason?: string | null
  beforeLifecycle?: GovernanceLifecycleState | null
  afterLifecycle?: GovernanceLifecycleState | null
  metadata?: Record<string, unknown> | null
}

export interface GovernanceAuditExportPayload {
  schemaVersion: number
  format: GovernanceAuditExportFormat
  contentType: string
  filename: string
  exportedAt: string
  eventCount: number
  body: string
}

export interface GovernanceAgentIncidentControlRequest {
  subjectId: string
  reason?: string | null
  context?: {
    directory?: string | null
  }
}

export interface GovernanceCrewIncidentControlRequest {
  crewId: string
  reason?: string | null
}

export interface GovernanceMemoryIncidentControlRequest {
  memoryId: string
  reason?: string | null
}

export interface GovernanceToolIncidentControlRequest {
  toolId: string
  reason?: string | null
  context?: {
    directory?: string | null
  }
}

export interface GovernanceRevokedTool {
  schemaVersion: number
  toolId: string
  label: string
  patterns: string[]
  source: 'configured' | 'custom-mcp' | 'native'
  scope: GovernanceScopeKind
  directory: string | null
  revokedAt: string
  revokedBy: string
  reason: string | null
}

export type GovernanceAuditExportRecordPayload =
  | GovernanceAuditEvent
  | CoworkTraceEvent
  | CrewApproval
  | PolicyDecision
  | OutcomeEvaluation
  | AutomationDeliveryRecord
  | ChannelDeliveryRecord

export interface GovernanceAuditExportRecord {
  schemaVersion: number
  recordType: GovernanceAuditExportRecordType
  id: string
  occurredAt: string
  subjectKind: GovernanceSubjectKind | null
  subjectId: string | null
  runKind: CoworkRunKind | 'channel' | null
  runId: string | null
  payload: GovernanceAuditExportRecordPayload
}

export type GovernanceAuditOtelValue =
  | { stringValue: string }
  | { intValue: number }
  | { boolValue: boolean }

export interface GovernanceAuditOtelAttribute {
  key: string
  value: GovernanceAuditOtelValue
}

export interface GovernanceAuditOtelLogRecord {
  timeUnixNano: string
  observedTimeUnixNano: string
  severityText: 'INFO' | 'ERROR'
  body: { stringValue: string }
  attributes: GovernanceAuditOtelAttribute[]
}

export interface GovernanceAuditOtelExport {
  schemaVersion: number
  resourceLogs: Array<{
    resource: {
      attributes: GovernanceAuditOtelAttribute[]
    }
    scopeLogs: Array<{
      scope: {
        name: string
        version: string
      }
      logRecords: GovernanceAuditOtelLogRecord[]
    }>
  }>
}

export function toExportableGovernanceAuditEvent(event: GovernanceAuditEvent): GovernanceAuditEvent {
  return {
    ...event,
    actor: { ...event.actor },
    metadata: { ...event.metadata },
  }
}

export function serializeGovernanceAuditEvent(event: GovernanceAuditEvent): string {
  const exportable = toExportableGovernanceAuditEvent(event)
  return JSON.stringify({
    schemaVersion: exportable.schemaVersion,
    id: exportable.id,
    kind: exportable.kind,
    subjectKind: exportable.subjectKind,
    subjectId: exportable.subjectId,
    action: exportable.action,
    outcome: exportable.outcome,
    actor: exportable.actor,
    reason: exportable.reason,
    beforeLifecycle: exportable.beforeLifecycle,
    afterLifecycle: exportable.afterLifecycle,
    metadata: exportable.metadata,
    createdAt: exportable.createdAt,
  })
}

export function serializeGovernanceAuditExportRecord(record: GovernanceAuditExportRecord): string {
  return JSON.stringify({
    schemaVersion: record.schemaVersion,
    recordType: record.recordType,
    id: record.id,
    occurredAt: record.occurredAt,
    subjectKind: record.subjectKind,
    subjectId: record.subjectId,
    runKind: record.runKind,
    runId: record.runId,
    payload: record.payload,
  })
}

function auditTimeUnixNano(isoTimestamp: string) {
  const millis = Date.parse(isoTimestamp)
  const normalized = Number.isFinite(millis) ? Math.max(0, Math.trunc(millis)) : 0
  return `${normalized}000000`
}

function otelStringAttribute(key: string, value: string): GovernanceAuditOtelAttribute {
  return { key, value: { stringValue: value } }
}

function otelIntAttribute(key: string, value: number): GovernanceAuditOtelAttribute {
  return { key, value: { intValue: value } }
}

function otelOptionalStringAttribute(key: string, value: string | null): GovernanceAuditOtelAttribute[] {
  return value ? [otelStringAttribute(key, value)] : []
}

function auditRecordStatus(record: GovernanceAuditExportRecord) {
  if ('outcome' in record.payload) return record.payload.outcome
  if ('status' in record.payload && typeof record.payload.status === 'string') return record.payload.status
  return null
}

export function toGovernanceAuditOtelLogRecord(record: GovernanceAuditExportRecord): GovernanceAuditOtelLogRecord {
  const timeUnixNano = auditTimeUnixNano(record.occurredAt)
  const status = auditRecordStatus(record)
  const payloadJson = JSON.stringify(record.payload)
  return {
    timeUnixNano,
    observedTimeUnixNano: timeUnixNano,
    severityText: status === 'failed' || status === 'denied' ? 'ERROR' : 'INFO',
    body: { stringValue: `open_cowork.audit.${record.recordType}${status ? `.${status}` : ''}` },
    attributes: [
      otelIntAttribute('open_cowork.audit.export_schema_version', record.schemaVersion),
      otelStringAttribute('open_cowork.audit.record_type', record.recordType),
      otelStringAttribute('open_cowork.audit.id', record.id),
      ...otelOptionalStringAttribute('open_cowork.audit.status', status),
      ...otelOptionalStringAttribute('open_cowork.governance.subject.kind', record.subjectKind),
      ...otelOptionalStringAttribute('open_cowork.governance.subject.id', record.subjectId),
      ...otelOptionalStringAttribute('open_cowork.audit.run.kind', record.runKind),
      ...otelOptionalStringAttribute('open_cowork.audit.run.id', record.runId),
      otelStringAttribute('open_cowork.audit.payload_json', payloadJson),
    ],
  }
}

export function toGovernanceAuditOtelExport(records: GovernanceAuditExportRecord[]): GovernanceAuditOtelExport {
  return {
    schemaVersion: COWORK_GOVERNANCE_AUDIT_EXPORT_SCHEMA_VERSION,
    resourceLogs: [{
      resource: {
        attributes: [
          otelStringAttribute('service.name', 'open-cowork'),
          otelStringAttribute('service.namespace', 'open-cowork'),
          otelStringAttribute('telemetry.sdk.language', 'javascript'),
        ],
      },
      scopeLogs: [{
        scope: {
          name: 'open-cowork.governance.audit',
          version: String(COWORK_GOVERNANCE_AUDIT_SCHEMA_VERSION),
        },
        logRecords: records.map(toGovernanceAuditOtelLogRecord),
      }],
    }],
  }
}

export function serializeGovernanceAuditOtelExport(records: GovernanceAuditExportRecord[]): string {
  return JSON.stringify(toGovernanceAuditOtelExport(records))
}
