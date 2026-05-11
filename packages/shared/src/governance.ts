export const COWORK_GOVERNANCE_SCHEMA_VERSION = 1
export const COWORK_GOVERNANCE_AUDIT_SCHEMA_VERSION = 1
export const COWORK_GOVERNANCE_AUDIT_EXPORT_SCHEMA_VERSION = 1

export type GovernanceSubjectKind = 'agent' | 'crew'
export type GovernanceLifecycleState = 'draft' | 'review' | 'approved' | 'active' | 'paused' | 'retired'
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
export type GovernanceMemoryBoundaryKind = 'none' | 'session' | 'agent' | 'crew' | 'workspace'
export type GovernanceIncidentControlKind =
  | 'pause_agent'
  | 'retire_agent'
  | 'pause_crew'
  | 'retire_crew'
  | 'export_audit'
export type GovernanceAuditEventKind = 'incident_control'
export type GovernanceAuditOutcome = 'succeeded' | 'failed'
export type GovernanceAuditExportFormat = 'ndjson' | 'otel-json'

export interface GovernanceOwner {
  kind: GovernanceOwnerKind
  id: string
  displayName: string
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
}

export interface GovernanceMemoryBoundary {
  kind: GovernanceMemoryBoundaryKind
  id: string | null
  label: string
}

export interface GovernanceIncidentControl {
  kind: GovernanceIncidentControlKind
  label: string
  available: boolean
  requiresConfirmation: boolean
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

function auditEventTimeUnixNano(event: GovernanceAuditEvent) {
  const millis = Date.parse(event.createdAt)
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

export function toGovernanceAuditOtelLogRecord(event: GovernanceAuditEvent): GovernanceAuditOtelLogRecord {
  const exportable = toExportableGovernanceAuditEvent(event)
  const timeUnixNano = auditEventTimeUnixNano(exportable)
  const metadataJson = JSON.stringify(exportable.metadata)
  return {
    timeUnixNano,
    observedTimeUnixNano: timeUnixNano,
    severityText: exportable.outcome === 'failed' ? 'ERROR' : 'INFO',
    body: { stringValue: `open_cowork.governance.${exportable.action}.${exportable.outcome}` },
    attributes: [
      otelIntAttribute('open_cowork.audit.schema_version', exportable.schemaVersion),
      otelStringAttribute('open_cowork.audit.id', exportable.id),
      otelStringAttribute('open_cowork.audit.kind', exportable.kind),
      otelStringAttribute('open_cowork.audit.action', exportable.action),
      otelStringAttribute('open_cowork.audit.outcome', exportable.outcome),
      otelStringAttribute('open_cowork.governance.subject.kind', exportable.subjectKind),
      otelStringAttribute('open_cowork.governance.subject.id', exportable.subjectId),
      otelStringAttribute('open_cowork.governance.actor.kind', exportable.actor.kind),
      otelStringAttribute('open_cowork.governance.actor.id', exportable.actor.id),
      otelStringAttribute('open_cowork.governance.actor.display_name', exportable.actor.displayName),
      ...otelOptionalStringAttribute('open_cowork.governance.lifecycle.before', exportable.beforeLifecycle),
      ...otelOptionalStringAttribute('open_cowork.governance.lifecycle.after', exportable.afterLifecycle),
      ...otelOptionalStringAttribute('open_cowork.audit.reason', exportable.reason),
      otelStringAttribute('open_cowork.audit.metadata_json', metadataJson),
    ],
  }
}

export function toGovernanceAuditOtelExport(events: GovernanceAuditEvent[]): GovernanceAuditOtelExport {
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
        logRecords: events.map(toGovernanceAuditOtelLogRecord),
      }],
    }],
  }
}

export function serializeGovernanceAuditOtelExport(events: GovernanceAuditEvent[]): string {
  return JSON.stringify(toGovernanceAuditOtelExport(events))
}
